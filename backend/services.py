import os
import json
import re
import time
import asyncio
import hashlib
import html
import base64
import threading
from collections import defaultdict, Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from openai import AsyncOpenAI
from dotenv import load_dotenv


# ── Human-correction feedback injection ──────────────────────────────────────
# Reads flagged corrections from the shared store and injects confirmed ones
# (count >= 2) into classification prompts as few-shot examples.

_CORRECTIONS_FILE = Path("data/corrections.json")

def _get_correction_block(min_count: int = 2) -> str:
    """
    Returns a prompt block of human-verified corrections to inject into the
    classification prompt. Empty string if no qualifying corrections exist.
    Only activates at count >= 2 so a single accidental flag never skews the AI.
    """
    try:
        if not _CORRECTIONS_FILE.exists():
            return ""
        raw    = json.loads(_CORRECTIONS_FILE.read_text(encoding="utf-8"))
        active = [c for c in raw if isinstance(c, dict) and c.get("count", 1) >= min_count]
        if not active:
            return ""
        lines = [
            "\n\nHUMAN-VERIFIED CORRECTIONS — these patterns were flagged by real users. "
            "Apply them when you see similar emails:"
        ]
        for c in active[:8]:          # cap at 8 to keep prompt size controlled
            subj   = (c.get("subject") or "")[:60]
            domain = c.get("fromDomain") or ""
            orig   = c.get("originalCategory") or ""
            corr   = c.get("correctedCategory") or ""
            reason = (c.get("reason") or "").strip()
            line   = f"- '{subj}'"
            if domain:
                line += f" from @{domain}"
            line += f": wrongly classified as {orig} → correct is {corr}"
            if reason:
                line += f". Reason: {reason}"
            lines.append(line)
        return "\n".join(lines)
    except Exception:
        return ""


def clean_for_ai(text: str, max_chars: int = 800) -> str:
    """Strip HTML, collapse whitespace, truncate — reduces tokens by 60-70%."""
    if not text:
        return ""
    # Remove HTML tags
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    # Decode HTML entities
    text = html.unescape(text)
    # Collapse whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Remove quoted reply junk (From: ... On ... wrote:)
    text = re.sub(r"(From:.*?\n.*?Sent:.*?\n.*?To:.*?\n.*?Subject:.*?\n)", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"On .{10,80} wrote:", "", text, flags=re.IGNORECASE)
    # Strip control characters that survive HTML cleaning and break JSON serialization.
    # Outlook/Exchange bodies often contain VML, Office XML and binary-ish fragments
    # with chars in the \x00-\x1f range. JSON only allows \t \n \r in that range —
    # everything else causes OpenAI to reject the request with a 400 invalid JSON error.
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    return text.strip()[:max_chars]

import logging
log = logging.getLogger("hfmg")


def clean_subject(subject: str) -> str:
    """Strip spam/junk tags from subject before sending to AI."""
    if not subject:
        return ""
    cleaned = re.sub(r'\[\s*(spam|junk|bulk|virus|caution)\s*\]', '', subject, flags=re.IGNORECASE)
    cleaned = re.sub(r'\*+\s*(spam|junk)\s*\*+', '', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def extract_sender_email(from_field: str) -> str:
    """
    Extract just the email address from a 'Name <email@domain.com>' string,
    or return the lowercased value as-is if no angle brackets are found.
    This ensures sender list lookups are never broken by display name prefixes
    or inconsistent casing from Exchange/EWS.
    """
    if not from_field:
        return ""
    match = re.search(r'[\w.+-]+@[\w.-]+', from_field)
    return match.group(0).lower() if match else from_field.lower()


def is_newsletter_body(body: str, sender: str = "", attachment_count: int = 0) -> bool:
    """Detect newsletter/marketing emails by body signals.

    Hard vetoes (always return False):
      - Sender domain is in NEWSLETTER_NEVER_DOMAINS
      - Body contains any TRANSACTIONAL_SIGNALS keyword
      - Email has 2+ attachments (real newsletters never have multiple attachments)

    Signal thresholds:
      - Internal senders (hfmg.net): 3+ signals required
      - External with 1 attachment:  3+ signals required
      - External with 0 attachments: 1+ signal required (original behaviour)
    """
    if not body:
        return False

    sender_lower = (sender or "").lower()

    # ── Hard veto 1: protected partner / signing-service domains ──
    if any(domain in sender_lower for domain in NEWSLETTER_NEVER_DOMAINS):
        return False

    body_lower = body.lower()

    # ── Hard veto 2: transactional signals in body ──
    if any(sig in body_lower for sig in TRANSACTIONAL_SIGNALS):
        return False

    # ── Hard veto 3: multiple attachments ──
    if attachment_count >= 2:
        return False

    signals = [
        "unsubscribe",
        "view online",
        "view in browser",
        "view this email",
        "you are receiving this",
        "you're receiving this",
        "copyright ©",
        "copyright &copy",
        "our address is",
        "opt out",
        "opt-out",
        "email preferences",
        "manage preferences",
        "forward for signup",
        "sign up for our",
        "mailchimp",
        "hubspot",
        "sendgrid",
        "constantcontact",
    ]
    matched = sum(1 for s in signals if s in body_lower)
    is_internal = "hfmg.net" in sender_lower

    # Internal or has 1 attachment → require 3+ signals to reduce false positives
    if is_internal or attachment_count >= 1:
        return matched >= 3

    # External with no attachments → 1 signal is sufficient (original behaviour)
    return matched >= 1


# --- STEP 1: Create a strict classification prompt ---
CLASSIFICATION_PROMPT = """
You are an enterprise email triage assistant for a medical group (HFMG).

Your job is to strictly classify an email into ONE of the following categories:

1. VIP
   - Emails from the highest-tier executive senders (pre-identified VIP list)
   - Always surfaces at the very top regardless of content

2. PRIORITY
   - Emails from senior staff / priority senders (second-tier list)
   - Financial, legal, compliance, production-impacting topics

3. URGENT
   - The recipient must take a specific, concrete action TODAY or TOMORROW and there is a real consequence (patient safety risk, financial cutoff, compliance breach, system outage) if they do not
   - Outages, system-down incidents, escalations that block operations right now
   - NOT URGENT: any email that uses urgency language ("ASAP", "please review urgently", "as soon as possible", "at your earliest convenience") WITHOUT a hard named deadline and a concrete consequence
   - NOT URGENT: routine operational counts, reports, or summaries — even if numbers are high or the word "urgent" appears in the subject
   - NOT URGENT: meeting requests or scheduling emails, even if described as time-sensitive
   - ASK YOURSELF: "If no one acts on this today, what specifically breaks?" — if the answer is nothing concrete, it is NOT URGENT

4. CONFIDENTIAL
   - ONLY: emails requiring a DECISION or APPROVAL — financial approvals, payment authorizations, budget approvals, signed contracts awaiting countersignature, HR disciplinary or termination actions involving suspicious activity or misconduct
   - NOT CONFIDENTIAL: routine employment contracts, offer letters, standard onboarding paperwork, contract status updates, weekly analytics reports, denial reports, vendor analytics, inactive patient/insurance counts
   - NOT CONFIDENTIAL: termination forms unless the sender explicitly states suspicious activity, concerns, or misconduct
   - NOT CONFIDENTIAL: emails that merely mention a contract by name without requesting a decision or approval

5. MEETING
   - The sender is explicitly requesting to COORDINATE A SPECIFIC TIME to meet — they need a date/time confirmed, availability checked, or a calendar event accepted/declined
   - A calendar invite attachment (.ics file) or a formal meeting request from a calendar system
   - Back-and-forth scheduling: "Can you do Thursday at 2pm?" / "Let me know your availability for a call this week"
   - NOT MEETING: an email that merely mentions a past or future date in passing ("we met last Tuesday", "the deadline is Friday")
   - NOT MEETING: meeting minutes or notes being shared as FYI with no scheduling action needed — that is NORMAL
   - NOT MEETING: "let's catch up sometime" or vague future intent without a specific time being coordinated
   - NOT MEETING: an email about a topic that happens to reference a scheduled event without asking the recipient to confirm attendance or availability
   - ASK YOURSELF: "Is the sender asking me to commit to a specific time, or just mentioning that time exists?" — only the former is MEETING

6. ZOOM CALLS
   - Any email that contains a Zoom meeting link (zoom.us URL)

7. NEWSLETTER
   - Marketing, announcements, automated updates, weekly/daily digests from publications or bulk senders
   - Strong signals: unsubscribe link + no attachments + no direct action request + no payment/contract language
   - NEVER classify as NEWSLETTER if: the email has attachments, contains a signature/DocuSign request,
     references payments, HEDIS, ACO, chart chase, vendor agreements, office hours (partner programs),
     or directly names the recipient with a specific action item.
   - An unsubscribe footer alone is NOT sufficient — many legitimate partner and vendor platforms
     (healthcare payers, ACO partners, e-signature services) append unsubscribe links to all their emails.
   - A newsletter mentioning Zoom or any company as a news item is still NEWSLETTER
   - [SPAM] or [JUNK] in subject does NOT change category — classify based on body content only

8. NORMAL
   - Everything else including: routine contract updates, employment paperwork status, weekly reports, operational counts, vendor analytics

CONFIDENTIAL vs URGENT — if an email has a hard deadline AND contains sensitive content, choose URGENT. Deadline beats confidentiality.

GOLDEN RULE — READ FIRST:
Any email that is ONLY sharing information, counts, or reports (e.g. inactive insurance counts,
denial reports, productivity summaries, patient lists, weekly stats) must be classified as NORMAL.
These are NEVER URGENT and NEVER CONFIDENTIAL, no matter how large the numbers are.
URGENT and CONFIDENTIAL require an explicit action, decision, or same-day deadline.

Rules:
- Always choose exactly ONE category.
- Do NOT invent categories.
- Do NOT explain.
- Output ONLY valid JSON.
- Give a priority score (1 to 5).
- Write a summary of 4-6 sentences thorough enough that the reader never needs to open the email:
  Sentence 1: Core topic, context, and who is involved (full names and roles if present).
  Sentence 2: All specific details — exact numbers, dollar amounts, dates, deadlines, locations, system names, patient counts, account names.
  Sentence 3: Any background or history relevant to understanding the request or issue.
  Sentence 4: What the recipient needs to do, decide, or respond to — and by when if stated.
  Sentence 5 (if applicable): Dependencies, blockers, escalation path, or related open items.
  Sentence 6 (if applicable): Attachments, links, or follow-up items with their actual names.
  Never be vague or generic. Every sentence must contain at least one concrete fact from the email body. Never say "this email" or "the sender".
- NEWSLETTER RULE — exactly 3 sentences: Sentence 1: name the publication/source and its specific headline or subject. Sentence 2: list the 3-4 most concrete highlights, figures, named tools, or topics from the body. Sentence 3: state the single most actionable or relevant item for an HFMG executive. NEVER say "this email", "a range of topics", "important topics", or anything vague.

JSON format:

{
  "category": "VIP | PRIORITY | URGENT | CONFIDENTIAL | MEETING | ZOOM | NEWSLETTER | NORMAL",
  "priority": 1,
  "summary": "Detailed 2-4 sentence summary with all key facts."
}
"""

# 1. SETUP AI CLIENT
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
ACTIVE_MODEL = "gpt-4o-mini"

if not api_key:
    log.critical("OPENAI_API_KEY is missing from .env file!")

client = AsyncOpenAI(api_key=api_key)

# --- CONFIGURATION: VIP + PRIORITY SENDERS ---
VIP_FILE      = "vip_list.json"
PRIORITY_FILE = "priority_list.json"

def load_sender_list(filepath: str) -> list:
    """Load a flat JSON list of email addresses from a file."""
    if os.path.exists(filepath):
        try:
            with open(filepath, "r") as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
            log.warning(f"{filepath} is not a flat list — expected format: [\"email@domain.com\", ...]")
        except Exception as e:
            log.error(f"Error loading {filepath}: {e}")
    return []

LEGAL_FILE      = "Legal list.json"
PROVIDERS_FILE  = "Providers om list.json"
# ── New folder files (Phase 2 — group membership management) ──
GLOBAL_FILE     = "Global list.json"
RCM_MGRS_FILE   = "rcm_mgrs_list.json"
IT_FILE         = "it_list.json"
ACCOUNTING_FILE = "accounting_list.json"

VIP_SENDERS       = [v.lower() for v in load_sender_list(VIP_FILE)]
PRIORITY_SENDERS  = [v.lower() for v in load_sender_list(PRIORITY_FILE)]
LEGAL_SENDERS     = [v.lower() for v in load_sender_list(LEGAL_FILE)]
PROVIDERS_SENDERS = [v.lower() for v in load_sender_list(PROVIDERS_FILE)]
# These 4 are folder-only groupings — NOT used in AI classification (same as
# their hardcoded JS equivalents were before this change), so loading them
# here does not alter any triage/categorization behavior.
GLOBAL_SENDERS     = [v.lower() for v in load_sender_list(GLOBAL_FILE)]
RCM_MGRS_SENDERS   = [v.lower() for v in load_sender_list(RCM_MGRS_FILE)]
IT_SENDERS         = [v.lower() for v in load_sender_list(IT_FILE)]
ACCOUNTING_SENDERS = [v.lower() for v in load_sender_list(ACCOUNTING_FILE)]

# ── TRACKING ACCESS CONTROL ──────────────────────────────────────────────────
# Only users listed in tracking_access.json can use the follow-up tracking
# feature. Edit this file to add/remove users — no code change required.
TRACKING_ACCESS_FILE = "tracking_access.json"
_TRACKING_ALLOWED_USERS: set = set()

def _load_tracking_allowed():
    """Load (or reload) the tracking access list from disk."""
    global _TRACKING_ALLOWED_USERS
    users = load_sender_list(TRACKING_ACCESS_FILE)
    _TRACKING_ALLOWED_USERS = {u.lower().strip() for u in users}
    log.debug(f"[tracking-access] {len(_TRACKING_ALLOWED_USERS)} allowed users: {_TRACKING_ALLOWED_USERS}")

_load_tracking_allowed()   # run once at startup

def is_tracking_allowed(user_email: str) -> bool:
    """
    Return True if user_email is permitted to use the tracking feature.
    Re-reads tracking_access.json on every call so changes take effect
    immediately without restarting the server.
    """
    _load_tracking_allowed()   # reload from disk each time — file is tiny
    return user_email.lower().strip() in _TRACKING_ALLOWED_USERS
# ────────────────────────────────────────────────────────────────────────────

# ── ACTIVITY ACCESS CONTROL ──────────────────────────────────────────────────
# The activity view shows every user's active hours and devices — that's
# other people's data, not just the viewer's own, so it's gated the same way
# tracking access is: only emails listed in activity_access.json can see it.
# Edit that file to add/remove viewers — no code change or restart required.
ACTIVITY_ACCESS_FILE = "activity_access.json"
_ACTIVITY_ALLOWED_USERS: set = set()

def _load_activity_allowed():
    global _ACTIVITY_ALLOWED_USERS
    users = load_sender_list(ACTIVITY_ACCESS_FILE)
    _ACTIVITY_ALLOWED_USERS = {u.lower().strip() for u in users}

_load_activity_allowed()   # run once at startup

def is_activity_allowed(user_email: str) -> bool:
    """Return True if user_email may view the (everyone's) activity summary."""
    _load_activity_allowed()
    return (user_email or "").lower().strip() in _ACTIVITY_ALLOWED_USERS
# ────────────────────────────────────────────────────────────────────────────

# ── ACTIVITY TRACKING — active hours + device, per user ─────────────────────
# Storage is bucketed by hour rather than one row per heartbeat, so a user
# active every day for a year stays at ~24 counters/day instead of one row
# every ~60s forever. "Device" is best-effort: browsers don't expose a real
# OS-level device/computer name to a web page, so this is a persistent
# per-browser id (generated client-side, see deviceIdentity.js) paired with
# an OS+browser label sniffed from the user agent — the same physical laptop
# shows up as a "different device" if the person switches browsers or clears
# site data.
ACTIVITY_LOG_FILE = "activity_log.json"
_activity_lock = threading.Lock()
ACTIVITY_RETENTION_DAYS = 60   # drop hour-buckets older than this on write

def _load_activity_log() -> dict:
    if os.path.exists(ACTIVITY_LOG_FILE):
        try:
            with open(ACTIVITY_LOG_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def _save_activity_log(data: dict):
    with open(ACTIVITY_LOG_FILE, "w") as f:
        json.dump(data, f, indent=2)

def _parse_hour_key(key: str):
    try:
        return datetime.strptime(key, "%Y-%m-%dT%H")
    except Exception:
        return datetime.min

def record_activity_ping(user_email: str, device_id: str, device_label: str = "") -> None:
    """Record one heartbeat from an active (non-idle) browser tab."""
    user_email = (user_email or "").lower().strip()
    device_id  = (device_id or "").strip()
    if not user_email or not device_id:
        return

    now      = datetime.now()
    hour_key = now.strftime("%Y-%m-%dT%H")
    now_iso  = now.isoformat()

    with _activity_lock:
        data = _load_activity_log()
        user_entry = data.setdefault(user_email, {"devices": {}, "hourBuckets": {}, "lastSeen": now_iso})
        user_entry["lastSeen"] = now_iso

        device_entry = user_entry["devices"].setdefault(device_id, {"firstSeen": now_iso})
        device_entry["label"]    = device_label or device_entry.get("label", "Unknown device")
        device_entry["lastSeen"] = now_iso

        buckets = user_entry.setdefault("hourBuckets", {})
        buckets[hour_key] = buckets.get(hour_key, 0) + 1

        cutoff = now - timedelta(days=ACTIVITY_RETENTION_DAYS)
        user_entry["hourBuckets"] = {k: v for k, v in buckets.items() if _parse_hour_key(k) >= cutoff}

        _save_activity_log(data)

def get_activity_summary(days: int = 14) -> list:
    """
    Per-user summary for the activity dashboard: last-seen time, whether
    they're active right now (pinged in the last 3 minutes — 3x the
    frontend's 60s heartbeat interval, to absorb one missed beat), the
    devices seen, and hour-bucketed activity counts for the requested window.
    """
    with _activity_lock:
        data = _load_activity_log()

    now    = datetime.now()
    cutoff = now - timedelta(days=days)
    result = []

    for user_email, entry in data.items():
        buckets = {
            k: v for k, v in entry.get("hourBuckets", {}).items()
            if _parse_hour_key(k) >= cutoff
        }

        last_seen_raw = entry.get("lastSeen")
        try:
            last_seen_dt = datetime.fromisoformat(last_seen_raw) if last_seen_raw else None
        except Exception:
            last_seen_dt = None
        is_active_now = bool(last_seen_dt and (now - last_seen_dt) <= timedelta(minutes=3))

        devices = [
            {"deviceId": did, "label": d.get("label", "Unknown device"), "lastSeen": d.get("lastSeen")}
            for did, d in entry.get("devices", {}).items()
        ]
        devices.sort(key=lambda d: d.get("lastSeen") or "", reverse=True)

        result.append({
            "userEmail":    user_email,
            "lastSeen":     last_seen_raw,
            "isActiveNow":  is_active_now,
            "devices":      devices,
            "hourBuckets":  buckets,   # { "2026-09-02T14": <ping count>, ... }
        })

    result.sort(key=lambda u: u.get("lastSeen") or "", reverse=True)
    return result
# ────────────────────────────────────────────────────────────────────────────
# Domain-based matching for legal firms (catches any address at these firms)
LEGAL_DOMAINS     = ["ropesgray.com", "garfunkelwild.com", "jclancylaw.com", "ambpclaw.com"]

# ── NEWSLETTER PROTECTION ────────────────────────────────────────────────────
# Domains that must NEVER be classified as NEWSLETTER regardless of body signals.
# Covers ACO/healthcare partners, payment platforms, and e-signature services
# whose system emails legitimately contain unsubscribe footers.
NEWSLETTER_NEVER_DOMAINS = [
    # ACO / healthcare partners
    "stellarhealth.com", "stellar.com", "guideprogram.com",
    "molinahealthcare.com", "molina.com",
    "xenterdiagnostics.com", "xenter.com",
    # E-signature platforms — all contain unsubscribe by design
    "docusign.com", "docusign.net",
    "hellosign.com", "signnow.com",
    "esignlive.com", "adobesign.com", "echosign.com",
    "dropboxsign.com",
]

# Body keywords that prove an email is transactional/operational — never newsletter.
# If ANY of these are present the newsletter classifier short-circuits to False.
TRANSACTIONAL_SIGNALS = [
    "please sign",
    "signature required",
    "sign the document",
    "review and sign",
    "docusign",
    "completed document",          # DocuSign completion notice
    "hedis",
    "chart chase",
    "chart retrieval",
    "aco partner",
    "guide program",
    "office hours program",        # partner/vendor program cadence calls
    "office hours call",           # partner/vendor program cadence calls
    "join our office hours",       # partner/vendor program cadence calls
    "annual payment",
    "invoice attached",
    "payment attached",
    "agreement attached",
    "contract attached",
    "see attached",
    "please find attached",
    "attached for your review",
]
# ────────────────────────────────────────────────────────────────────────────

# ── DEDUPLICATION: VIP > LEGAL > PRIORITY > PROVIDERS ──────────────────────
# If the same email appears in multiple lists, the highest-priority list wins.
# We strip duplicates from lower lists at startup so each email has exactly
# one category — no ambiguity at classification time.
_vip_set      = set(VIP_SENDERS)
_legal_set    = set(LEGAL_SENDERS)
_priority_set = set(PRIORITY_SENDERS)

def _log_overlaps(removed: list, from_list: str, kept_in: str):
    for e in removed:
        log.warning(f"[dedup] {e!r} removed from {from_list} — already in {kept_in}")

# LEGAL: no longer strips VIP overlap — someone can be both VIP and LEGAL
# (e.g. craig@ramblaw.com). Classification still checks VIP first, so this
# only affects the LEGAL roster/folder membership, not category assignment.
_legal_set    = set(LEGAL_SENDERS)

# PRIORITY / PROVIDERS: same as LEGAL above — log overlaps for visibility,
# but no longer strip them from memory. Stripping here was silently dangerous
# once add/remove exists: add_group_member/remove_group_member persist
# whatever's in memory back to the file, so a stripped-from-memory entry
# would get permanently deleted from priority_list.json / the providers file
# the very first time someone used add/remove on that folder — even though
# classification is unaffected either way (VIP/LEGAL are checked first).
_priority_overlap = [e for e in PRIORITY_SENDERS if e in _vip_set or e in _legal_set]
_log_overlaps(_priority_overlap, "priority_list", "vip_list or legal_list")

_providers_overlap = [e for e in PROVIDERS_SENDERS if e in _vip_set or e in _legal_set or e in _priority_set]
_log_overlaps(_providers_overlap, "providers_om_list", "vip_list, legal_list, or priority_list")
# ───────────────────────────────────────────────────────────────────────────

log.debug(f"Loaded {len(VIP_SENDERS)} VIP senders from {VIP_FILE}")
log.debug(f"Loaded {len(PRIORITY_SENDERS)} PRIORITY senders from {PRIORITY_FILE}")
log.debug(f"Loaded {len(LEGAL_SENDERS)} LEGAL senders + {len(LEGAL_DOMAINS)} LEGAL domains")
log.debug(f"Loaded {len(PROVIDERS_SENDERS)} PROVIDERS/OM senders")
log.debug(f"Loaded {len(GLOBAL_SENDERS)} GLOBAL senders from {GLOBAL_FILE}")
log.debug(f"Loaded {len(RCM_MGRS_SENDERS)} RCM_MGRS senders from {RCM_MGRS_FILE}")
log.debug(f"Loaded {len(IT_SENDERS)} IT senders from {IT_FILE}")
log.debug(f"Loaded {len(ACCOUNTING_SENDERS)} ACCOUNTING senders from {ACCOUNTING_FILE}")


# ───────────────────────────────────────────────────────────────────────────
# GROUP / FOLDER MEMBERSHIP — add/remove people from VIP, LEGAL, PRIORITY,
# PROVIDERS, GLOBAL, RCM_MGRS, IT, ACCOUNTING at runtime.
#
# Every add/remove persists to that folder's JSON file on disk AND updates
# the live in-memory list immediately — no backend restart required (unlike
# hand-editing these files, which still needs a restart to take effect).
#
# IMPORTANT: main.py must NOT do `from services import VIP_SENDERS` (or any
# of the other 7 list names) — that binds a snapshot at import time and will
# go stale the moment an add/remove happens here. Always call
# get_group_members_dict() / add_group_member() / remove_group_member()
# below instead, which read the live module-level list at call time.
# ───────────────────────────────────────────────────────────────────────────

_group_lists_lock = threading.Lock()

# folder name (as used by the API) -> (module-level variable name, JSON file on disk)
GROUP_FOLDER_FILES = {
    "VIP":        ("VIP_SENDERS",        VIP_FILE),
    "LEGAL":      ("LEGAL_SENDERS",      LEGAL_FILE),
    "PRIORITY":   ("PRIORITY_SENDERS",   PRIORITY_FILE),
    "PROVIDERS":  ("PROVIDERS_SENDERS",  PROVIDERS_FILE),
    "GLOBAL":     ("GLOBAL_SENDERS",     GLOBAL_FILE),
    "RCM_MGRS":   ("RCM_MGRS_SENDERS",   RCM_MGRS_FILE),
    "IT":         ("IT_SENDERS",         IT_FILE),
    "ACCOUNTING": ("ACCOUNTING_SENDERS", ACCOUNTING_FILE),
}


def _save_group_list_file(filepath: str, emails: list):
    """Persist a folder's member list to its JSON file (sorted, 4-space indent)."""
    with open(filepath, "w") as f:
        json.dump(sorted(emails), f, indent=4)


def get_group_members_dict() -> dict:
    """
    Live membership for all 8 folders — always reflects the latest add/remove,
    since it reads each list via globals() rather than a cached reference.
    """
    return {folder: sorted(globals()[varname]) for folder, (varname, _) in GROUP_FOLDER_FILES.items()}


def add_group_member(folder: str, email: str) -> dict:
    """
    Add `email` to `folder`. Persists to disk AND updates the live in-memory
    list immediately. Idempotent — adding an existing member is a no-op.

    Raises ValueError on an unknown folder or invalid email — callers (main.py)
    should catch this and turn it into an HTTP 400.
    """
    folder = (folder or "").strip().upper()
    email  = (email or "").strip().lower()

    if folder not in GROUP_FOLDER_FILES:
        raise ValueError(f"Unknown folder '{folder}'. Valid folders: {sorted(GROUP_FOLDER_FILES)}")
    if not email or "@" not in email:
        raise ValueError(f"Invalid email address: '{email}'")

    varname, filepath = GROUP_FOLDER_FILES[folder]
    with _group_lists_lock:
        current = globals()[varname]
        if email in current:
            log.debug(f"[group-members] {email} already in {folder} — no-op")
        else:
            updated = current + [email]
            _save_group_list_file(filepath, updated)
            globals()[varname] = updated
            log.info(f"[group-members] added {email} to {folder}")
    return get_group_members_dict()


def remove_group_member(folder: str, email: str) -> dict:
    """
    Remove `email` from `folder`. Persists to disk AND updates the live
    in-memory list immediately. Idempotent — removing a non-member is a no-op.

    Raises ValueError on an unknown folder — callers (main.py) should catch
    this and turn it into an HTTP 400.
    """
    folder = (folder or "").strip().upper()
    email  = (email or "").strip().lower()

    if folder not in GROUP_FOLDER_FILES:
        raise ValueError(f"Unknown folder '{folder}'. Valid folders: {sorted(GROUP_FOLDER_FILES)}")

    varname, filepath = GROUP_FOLDER_FILES[folder]
    with _group_lists_lock:
        current = globals()[varname]
        if email not in current:
            log.debug(f"[group-members] {email} not in {folder} — no-op")
        else:
            updated = [e for e in current if e != email]
            _save_group_list_file(filepath, updated)
            globals()[varname] = updated
            log.info(f"[group-members] removed {email} from {folder}")
    return get_group_members_dict()


# --- DATA NORMALIZATION ---

def normalize_list(val):
    """Convert any email field to a list of emails."""
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        return [v.strip() for v in val.split(",") if v.strip()]
    return []


def normalize_email(e: dict):
    """
    Normalize raw email dict from EWS into a consistent structure.
    New EWS fields handled:
      - body         → HTML content (field name confirmed)
      - received     → ISO-8601 with timezone offset
      - from         → plain email address
      - hasAttachments → boolean (NOTE: EWS onemail DTO bug returns false even
                         when attachments exist — always recompute from array)
      - attachmentId  → EWS file attachment identifier for download
      - sent          → sent timestamp
    """
    email_id = e.get("id") or e.get("_id") or e.get("messageId")

    clean_attachments = []
    for att in e.get("attachments", []):
        clean_attachments.append({
            "name":         att.get("name"),
            "type":         att.get("type", "application/octet-stream"),
            "size":         att.get("size", 0),
            "attachmentId": att.get("attachmentId") or att.get("AttachmentId"),
            "hash":         att.get("hash"),
            "storage":      "api",
            "messageId":    email_id
        })

    return {
        "id": email_id or "mail",
        "subject": e.get("subject", "No Subject"),
        "from": e.get("from") or e.get("sender") or e.get("email") or "Unknown",
        "to":  normalize_list(e.get("to")),
        "cc":  normalize_list(e.get("cc")),

        # Body resolution — "body" is the confirmed EWS HTML field name.
        # Guard with HTML tag check so plain-text bodies fall through to fallback.
        "body": (lambda _e: (
            (lambda v: v if v and "<" in v else None)(_e.get("body")) or
            _e.get("bodyHtml") or _e.get("htmlBody") or
            _e.get("body_html") or _e.get("htmlContent") or
            _e.get("bodyContent") or _e.get("mailBody") or
            next(
                (str(v) for k, v in _e.items()
                 if isinstance(v, str)
                 and k not in ("id", "messageId", "subject", "from", "sender",
                               "to", "cc", "bcc", "received", "receivedDateTime",
                               "received_at", "date", "isRead", "storage", "hash",
                               "sent", "body")
                 and "<" in v and ">" in v and len(v) > 50),
                None
            ) or
            str(_e.get("body") or _e.get("content") or _e.get("text") or "")
        ))(e),

        # Timestamps — "received" is the primary EWS field (with tz offset)
        "received_at": (
            e.get("received") or
            e.get("receivedDateTime") or
            e.get("received_at") or
            e.get("date") or
            "1970-01-01T00:00:00"
        ),
        "sent_at": e.get("sent") or "",

        "isRead": bool(e.get("isRead", False)),

        # hasAttachments: use array length as ground truth.
        # EWS onemail DTO has a bug where it returns false even when files exist.
        "hasAttachments": len(clean_attachments) > 0 or bool(e.get("hasAttachments", False)),

        "attachments": clean_attachments,

        # Exchange-authoritative thread identifier — groups all replies/forwards
        # in the same conversation regardless of subject line changes.
        "conversationId": e.get("conversationId") or e.get("ConversationId") or "",
    }


# --- CACHE SYSTEM ---
# Each user gets their own cache file: cache_<sanitized_email>.json
# This ensures simultaneous users never read/write each other's data.

import re as _re

def _cache_file_for(user_email: str) -> str:
    """Return a safe, user-specific cache filename."""
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"cache_{safe}.json"

# Bump this string any time the cache schema or AI logic changes.
# Any cache file written with a different version will be discarded
# automatically on next load, forcing a clean re-analysis.
CACHE_VERSION = "v11"  # bumped: id-cache entries drop the full body (see save_emails_to_id_cache) and gain isMeetingInvite
CACHE_VERSION_KEY = "meta_cache_version"

def load_cache(user_email: str = "default"):
    path = _cache_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
            # If the version doesn't match, discard the entire cache.
            if data.get(CACHE_VERSION_KEY) != CACHE_VERSION:
                log.warning(f"Cache version mismatch for {user_email} — discarding stale cache")
                try:
                    os.remove(path)
                except Exception:
                    pass
                return {}
            return data
        except:
            return {}
    return {}

# Per-user file locks — prevents two concurrent requests corrupting
# the same cache file when requests arrive simultaneously.
_cache_locks: dict = {}
_cache_locks_mutex = threading.Lock()

def _get_lock(user_email: str) -> threading.Lock:
    """Return (creating if needed) a per-user write lock."""
    with _cache_locks_mutex:
        if user_email not in _cache_locks:
            _cache_locks[user_email] = threading.Lock()
        return _cache_locks[user_email]

def save_cache(new_data: dict, user_email: str = "default"):
    path = _cache_file_for(user_email)
    with _get_lock(user_email):           # ← serialises writes per user
        current = load_cache(user_email)
        current.update(new_data)
        # Always stamp the current version so stale caches are detected on next load
        current[CACHE_VERSION_KEY] = CACHE_VERSION
        with open(path, "w") as f:
            json.dump(current, f, indent=2)

TIMESTAMP_KEY     = "meta_last_processed_timestamp"
REPORT_KEY        = "meta_last_full_report"
EMAILS_KEY        = "meta_last_enriched_emails"
COUNT_KEY         = "meta_last_email_count"
EMAIL_ID_CACHE_KEY = "meta_emails_by_id"

def get_last_processed_timestamp(user_email: str):
    return load_cache(user_email).get(TIMESTAMP_KEY)

def set_last_processed_timestamp(ts, user_email: str):
    save_cache({TIMESTAMP_KEY: ts}, user_email)

def get_cached_report(user_email: str):
    return load_cache(user_email).get(REPORT_KEY)

def save_cached_report(report, user_email: str):
    save_cache({REPORT_KEY: report}, user_email)

def get_cached_emails(user_email: str):
    return load_cache(user_email).get(EMAILS_KEY)

def get_last_email_count(user_email: str):
    return load_cache(user_email).get(COUNT_KEY)

def set_last_email_count(count, user_email: str):
    save_cache({COUNT_KEY: count}, user_email)

def get_cached_emails_by_id(user_email: str) -> dict:
    return load_cache(user_email).get(EMAIL_ID_CACHE_KEY, {})

# ── Live-fetch fallback — when the org mail server can't be reached ────────
# Stamped every time /api/fetch-inbox gets a real 200 back, so the UI can
# show "last synced <time>" even while it's currently serving stale data.
LAST_FETCH_OK_KEY = "meta_last_fetch_ok_at"

def get_last_fetch_ok_at(user_email: str):
    return load_cache(user_email).get(LAST_FETCH_OK_KEY)

def set_last_fetch_ok_at(ts, user_email: str):
    save_cache({LAST_FETCH_OK_KEY: ts}, user_email)

# ── Email body/detail cache — makes mail readable during an outage ────────
# The id-cache above deliberately drops bodies to keep syncs light, so
# without this the inbox list would render during an outage but every email
# would open blank. Stored one file per message rather than one big blob:
# the access pattern is "read one, write one", and a single JSON file of a
# few hundred HTML bodies would mean rewriting megabytes on every open.
DETAIL_CACHE_DIR = "detail_cache"
DETAIL_CACHE_MAX = 300          # per user; oldest pruned first
DETAIL_BODY_MAX_CHARS = 400_000  # skip absurd bodies rather than bloat the disk

def _detail_dir_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", (user_email or "default").lower().strip())
    return os.path.join(DETAIL_CACHE_DIR, safe)

def _detail_path_for(user_email: str, message_id: str) -> str:
    # messageIds are long base64-ish EWS strings with characters that are not
    # filename-safe, so key by hash.
    digest = hashlib.sha1((message_id or "").encode("utf-8")).hexdigest()
    return os.path.join(_detail_dir_for(user_email), f"{digest}.json")

def detail_is_complete(detail) -> bool:
    """
    True when a cached detail carries everything the reader actually needs:
    a body, and — for a conversation — a body on every message in the thread.

    This is the guard against serving a half-populated copy. Only the
    /api/Values/inbox/onemail response carries per-message bodies; anything
    derived from the inbox listing has the thread's shape but none of its
    content, and rendering that produces a conversation of blank messages.
    Entries failing this check are treated as a cache miss, so they get
    refetched and overwritten with a real copy on first use.
    """
    if not isinstance(detail, dict):
        return False
    if not detail.get("body"):
        return False
    messages = detail.get("messages") or []
    if messages:
        return all(isinstance(m, dict) and m.get("body") for m in messages)
    return True

def cached_detail_age_seconds(user_email: str, message_id: str):
    """
    Age of the cached copy in seconds, or None if there isn't one. Used to
    decide whether a cached detail is fresh enough to serve without going to
    the mail server: an individual message's body never changes, but the
    conversation thread around it can gain replies, so a copy is only trusted
    for a short window.
    """
    if not message_id:
        return None
    path = _detail_path_for(user_email, message_id)
    try:
        if os.path.exists(path):
            return max(0.0, time.time() - os.path.getmtime(path))
    except Exception:
        pass
    return None

def has_cached_detail(user_email: str, message_id: str) -> bool:
    """
    Cheap existence check — the prefetcher asks this for every email in the
    inbox on every sync, so it must not pay to parse hundreds of JSON bodies
    just to find out they're already there.
    """
    if not message_id:
        return False
    return os.path.exists(_detail_path_for(user_email, message_id))

def get_cached_detail(user_email: str, message_id: str):
    """Return a previously cached email-details payload, or None."""
    if not message_id:
        return None
    path = _detail_path_for(user_email, message_id)
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning(f"[detail-cache] read failed for {message_id[:20]}...: {e}")
    return None

def _prune_detail_cache(directory: str):
    """Keep the newest DETAIL_CACHE_MAX files; drop the rest."""
    try:
        entries = [os.path.join(directory, n) for n in os.listdir(directory) if n.endswith(".json")]
        if len(entries) <= DETAIL_CACHE_MAX:
            return
        entries.sort(key=lambda p: os.path.getmtime(p))   # oldest first
        for stale in entries[:len(entries) - DETAIL_CACHE_MAX]:
            try:
                os.remove(stale)
            except Exception:
                pass
    except Exception as e:
        log.warning(f"[detail-cache] prune failed: {e}")

def save_cached_detail(user_email: str, message_id: str, detail: dict):
    """
    Persist one email-details payload for offline reading. Best-effort: a
    cache write must never break the live request that triggered it.
    """
    if not message_id or not isinstance(detail, dict):
        return
    # Refuse to store a half-populated copy. Caching one is worse than
    # caching nothing: it would later be served in place of a live fetch and
    # render a thread of empty messages, and it would mask the email from the
    # prefetcher that could have fetched it properly.
    if not detail_is_complete(detail):
        log.debug(f"[detail-cache] skipping incomplete payload for {message_id[:20]}...")
        return
    body = detail.get("body")
    if isinstance(body, str) and len(body) > DETAIL_BODY_MAX_CHARS:
        return
    try:
        directory = _detail_dir_for(user_email)
        os.makedirs(directory, exist_ok=True)
        path = _detail_path_for(user_email, message_id)
        tmp = f"{path}.tmp"
        # Write-then-rename so a crash mid-write can't leave a truncated file
        # that later reads would choke on.
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(detail, f)
        os.replace(tmp, path)
        _prune_detail_cache(directory)
    except Exception as e:
        log.warning(f"[detail-cache] write failed for {message_id[:20]}...: {e}")

def get_last_known_inbox(user_email: str, limit: int = None) -> list:
    """
    Best-effort reconstruction of "the inbox as we last knew it" from the
    per-id analysis cache (meta_emails_by_id) — used as a fallback when the
    live Outlook fetch fails (firewall/timeout/org server down) so the UI
    can keep showing real data instead of going blank. Pointer stubs left
    behind by thread dedup (see save_emails_to_id_cache's _threadRef) carry
    no displayable fields, so only primary entries are returned.

    `limit` mirrors the caller's requested `count` on /api/fetch-inbox so a
    fallback for the "fast batch" phase doesn't hand back the entire
    (possibly much larger, accumulated-over-time) cache — the id-cache is
    an upsert-only dict that keeps every email ever analyzed for this user,
    not just the most recent fetch.
    """
    by_id = get_cached_emails_by_id(user_email)
    primaries = [e for e in by_id.values() if not e.get("_threadRef")]

    def _sort_key(e):
        raw = e.get("received_at") or e.get("received") or ""
        try:
            return datetime.fromisoformat(raw).timestamp()
        except Exception:
            return 0.0

    primaries.sort(key=_sort_key, reverse=True)
    return primaries[:limit] if limit else primaries

# Phrases/domains that mean "this is a meeting/call invite" — the server-side
# mirror of BODY_SIGNALS in frontend-new/src/meetingInvite.js, which is where
# the UI's RSVP bar, the Insights INVITES tile, and the INVITES filter all
# get their definition. Keep the two lists in sync. We compute this once
# here, while the body is still around, then drop the body from what gets
# cached (see save_emails_to_id_cache) so the flag substitutes for the body
# on every future cache hit instead of re-shipping the full HTML forever.
_MEETING_INVITE_SIGNALS = (
    "you're invited", "you are invited", "meeting request", "has invited you",
    "join the meeting", "join meeting", "zoom.us", "teams.microsoft.com",
    "meet.google.com", "webex.com",
)

def _detect_meeting_invite(entry: dict) -> bool:
    bodies = [entry.get("body") or ""]
    bodies += [m.get("body") or "" for m in (entry.get("messages") or [])]
    combined = " ".join(bodies).lower()
    if any(sig in combined for sig in _MEETING_INVITE_SIGNALS):
        return True
    return any(
        (a.get("name") or "").lower().endswith(".ics")
        for a in (entry.get("attachments") or [])
    )

def save_emails_to_id_cache(emails: list, user_email: str):
    existing = get_cached_emails_by_id(user_email)
    for e in emails:
        eid = e.get("id") or e.get("messageId")
        if eid:
            entry = e.copy()
            entry.pop("full_hash", None)

            # The full HTML body is only needed once: to feed the AI during
            # analysis and to detect a meeting-invite signal. Every sync
            # after that (this session's Phase 2, and every future session)
            # was re-shipping it for emails whose analysis never changes.
            # Capture the one signal derived from it, then drop it — the
            # detail view (fetchEmailDetails) re-fetches the real body on
            # open, so nothing else reads it from the cached copy.
            entry["isMeetingInvite"] = _detect_meeting_invite(entry)
            entry.pop("body", None)
            if entry.get("messages"):
                entry["messages"] = [
                    {k: v for k, v in m.items() if k != "body"}
                    for m in entry["messages"]
                ]

            existing[eid] = entry
    save_cache({EMAIL_ID_CACHE_KEY: existing}, user_email)


def save_cached_emails(emails, user_email: str):
    """Cache enriched emails for a specific user."""
    emails = [e for e in emails if not e.get("isRead")]

    cleaned = []
    for e in emails:
        email_copy = e.copy()

        new_atts = []
        for att in e.get("attachments", []):
            att_copy = att.copy()
            att_copy.pop("full_hash", None)
            new_atts.append(att_copy)
        email_copy["attachments"] = new_atts

        new_messages = []
        for msg in e.get("messages", []):
            msg_copy = msg.copy()
            new_msg_atts = []
            for matt in msg.get("attachments", []):
                matt_copy = matt.copy()
                matt_copy.pop("full_hash", None)
                new_msg_atts.append(matt_copy)
            msg_copy["attachments"] = new_msg_atts
            new_messages.append(msg_copy)
        email_copy["messages"] = new_messages

        cleaned.append(email_copy)

    save_cache({EMAILS_KEY: cleaned}, user_email)


# --- HELPER FUNCTIONS ---

def body_hash(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]

def group_emails_by_subject(emails):
    groups = defaultdict(list)

    for e in emails:
        if 'thread_count' in e:
            continue
        # Use Exchange's conversationId as the authoritative thread key.
        # Every reply/forward in the same thread shares the same conversationId.
        # Fall back to messageId so emails with no conversationId stay as singletons.
        key = e.get("conversationId") or e.get("id") or e.get("messageId") or str(id(e))
        groups[key].append(e)

    return groups


def _strip_html_for_split(text: str) -> str:
    """
    Convert HTML email body to plain text for reply-chain detection.
    Block-level tags become newlines so From:/Sent:/To:/Subject: headers
    end up on separate lines where the regex can match them.
    EWS returns full HTML — the old plain-text regex never matched.
    """
    text = html.unescape(text)
    text = re.sub(r"\s*&nbsp;\s*", " ", text)
    text = re.sub(r"<(?:br|BR)\s*/?>", "\n", text)
    text = re.sub(r"<(?:div|DIV|p|P|tr|TR|hr|HR)[^>]*>", "\n", text)
    text = re.sub(r"</(?:div|DIV|p|P|td|TD|th|TH|tr|TR)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_latest_html(html_body: str) -> str:
    """
    Extract only the new reply text from a full Outlook HTML body.
    Outlook consistently separates the new reply from the quoted chain using
    one of these markers — we cut the HTML at the first one we find:
      1. <hr>          — most common in desktop Outlook replies
      2. divRplyFwdMsg — Outlook Web App / OWA
      3. <b>From:</b>  — quoted header block in inline HTML
    Falls back to the full body if none are found (single message, no chain).
    """
    if not html_body:
        return html_body

    # 1. <hr> separator — Outlook reply separator only.
    # Must carry tabIndex or an inline-block display style — the exact attributes
    # Outlook injects on its reply divider <hr>. Bare <hr> tags and signature
    # dividers are intentionally ignored so they don't truncate the visible body.
    hr_match = re.search(
        r'<hr\b[^>]*(tabIndex|tabindex|style=["\'][^"\']*display\s*:\s*inline)[^>]*>',
        html_body, re.IGNORECASE
    )
    if hr_match:
        return html_body[:hr_match.start()].strip() or html_body

    # 2. divRplyFwdMsg div (OWA)
    div_match = re.search(r'<div[^>]+id=["\']?divRplyFwdMsg["\']?', html_body, re.IGNORECASE)
    if div_match:
        return html_body[:div_match.start()].strip() or html_body

    # 3. Bolded From: header inside quoted block
    from_match = re.search(r'<(?:b|strong)[^>]*>\s*From:\s*</(?:b|strong)>', html_body, re.IGNORECASE)
    if from_match:
        return html_body[:from_match.start()].strip() or html_body

    return html_body


def split_reply_chain(body, main_sender, main_date, attachments=None):
    if not body:
        return []

    original_body = body  # keep HTML for the latest message rendering

    # Strip HTML before pattern matching — EWS bodies are HTML,
    # reply headers are wrapped in <div>/<b> tags the old regex couldn't see
    text_body = _strip_html_for_split(body)

    pattern = re.compile(
        r"(From:\s[^\n]*\nSent:\s[^\n]*\nTo:\s[^\n]*\n(?:Cc:\s[^\n]*\n)?Subject:\s[^\n]*\n)",
        re.IGNORECASE
    )

    parts = pattern.split(text_body)
    messages = []

    latest_text = parts[0].strip()
    if latest_text:
        # When a reply chain is detected, extract only the new reply HTML
        # (everything above Outlook's <hr> / divRplyFwdMsg separator).
        # Without this, parsedThread[0] contained the full quoted chain
        # causing the previous messages to show inside the latest message card.
        latest_html = _extract_latest_html(original_body) if len(parts) > 1 else original_body
        messages.append({
            "from":        main_sender,
            "date":        main_date,
            "body":        latest_html,
            "attachments": attachments or []
        })

    for i in range(1, len(parts), 2):
        header  = parts[i]
        content = parts[i + 1].strip() if i + 1 < len(parts) else ""
        from_match = re.search(r"From:\s*(.*)", header, re.IGNORECASE)
        sent_match = re.search(r"Sent:\s*(.*)", header, re.IGNORECASE)
        messages.append({
            "from":        from_match.group(1).strip() if from_match else "Unknown",
            "date":        sent_match.group(1).strip() if sent_match else "Unknown",
            "body":        content,
            "attachments": []
        })

    return messages


def detect_real_threads(emails):
    threads = []
    singles = []

    for e in emails:
        raw_body    = str(e.get("body") or "")
        sender      = e.get("from") or "Unknown"
        date        = e.get("received_at") or e.get("date") or "Unknown"
        attachments = e.get("attachments", [])

        split_messages = split_reply_chain(raw_body, sender, date, attachments)

        if len(split_messages) > 1:
            e["__is_thread__"] = True
            threads.append(e)
        else:
            e["__is_thread__"] = False
            singles.append(e)

    return threads, singles


# --- AI CORE FUNCTIONS ---

async def analyze_single_email(email):
    if email.get("category") and email.get("summary"):
        return email

    body = email.get("body", "")
    subject = clean_subject(email.get("subject", "No Subject"))

    # ── Newsletter fast-path: skip AI entirely ──────────────────────────────
    # If is_newsletter_body() fires, we have hard signal evidence this is a
    # newsletter. Don't send to AI — healthcare publication content looks too
    # "operational" and the AI overrides the hint. Force NEWSLETTER directly.
    if is_newsletter_body(body, email.get("from", ""), len(email.get("attachments") or [])):
        email["category"] = "NEWSLETTER"
        email["priority"] = 1
        email["action"]   = "READ"
        sender_label = email.get("from") or "unknown sender"
        email["summary"] = (
            f"Newsletter from {sender_label}. "
            f"Subject: {subject}. "
            f"Automated digest — no action required."
        )
        return email
    # ────────────────────────────────────────────────────────────────────────

    prompt = f"""
Subject: {subject}
From: {email.get('from')}
Body:{body}{CLASSIFICATION_PROMPT}{_get_correction_block()}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[
                {"role": "system", "content": "Output JSON only."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )

        result = json.loads(response.choices[0].message.content)

        sender = extract_sender_email(email.get("from") or "")
        body_text = (email.get("body") or "").lower()
        subject_text = (email.get("subject") or "").lower()
        has_zoom = "zoom.us" in body_text or "zoom.us" in subject_text

        is_legal = sender in LEGAL_SENDERS or any(sender.endswith("@" + d) for d in LEGAL_DOMAINS)
        if has_zoom:
            email["category"] = "ZOOM"
            email["priority"] = 4
        elif sender in VIP_SENDERS:
            email["category"] = "VIP"
            email["priority"] = 5
        elif is_legal:
            email["category"] = "LEGAL"
            email["priority"] = 4
        elif sender in PRIORITY_SENDERS:
            # Priority senders: AI categorizes freely, fallback to PRIORITY if NORMAL
            ai_category = result.get("category", "NORMAL")
            email["category"] = ai_category if ai_category != "NORMAL" else "PRIORITY"
            email["priority"] = result.get("priority", 4)
        else:
            # All others including folder members: pure AI categorization
            email["category"] = result.get("category", "NORMAL")
            email["priority"] = result.get("priority", 1)

        email["summary"] = result.get("summary", "No summary")
        email["action"] = result.get("action", "REVIEW")
        return email

    except Exception as e:
        log.error(f"Single mail analysis failed: {e}")
        email["category"] = "NORMAL"
        email["summary"] = "Pending analysis"
        return email


# 🆕 BATCH: Analyze up to 20 single emails in ONE OpenAI call
async def analyze_emails_batch(emails: list) -> list:
    """
    Sends multiple emails to OpenAI in one request instead of one-per-email.
    Dramatically reduces API round trips and total wait time.
    """
    if not emails:
        return []

    # Pre-classify without AI: VIP senders and Zoom links
    pre_classified = []
    needs_ai = []

    for email in emails:
        sender = extract_sender_email(email.get("from") or "")
        body_text = (email.get("body") or "").lower()
        subject_text = (email.get("subject") or "").lower()
        has_zoom = "zoom.us" in body_text or "zoom.us" in subject_text

        is_legal = sender in LEGAL_SENDERS or any(sender.endswith("@" + d) for d in LEGAL_DOMAINS)
        if has_zoom:
            email["category"] = "ZOOM"
            email["priority"] = 4
            email["summary"] = email.get("summary") or "Zoom meeting invitation."
            email["action"] = "REVIEW"
            pre_classified.append(email)
        elif sender in VIP_SENDERS:
            email["category"] = "VIP"
            email["priority"] = 5
            email["action"] = "REVIEW"
            needs_ai.append(email)
        elif is_legal:
            # Pre-set category/priority but still send to AI for a real summary
            email["category"] = "LEGAL"
            email["priority"] = 4
            email["action"] = "REVIEW"
            needs_ai.append(email)
        elif sender in PRIORITY_SENDERS:
            # Do NOT pre-lock category — AI will decide, fallback applied after
            email["action"] = "REVIEW"
            needs_ai.append(email)
        elif sender in PROVIDERS_SENDERS:
            # Pure AI categorization — no sender lock
            email["action"] = "REVIEW"
            needs_ai.append(email)
        elif email.get("category") and email.get("summary"):
            # Already analyzed — skip
            pre_classified.append(email)
        elif is_newsletter_body(email.get("body", ""), email.get("from", ""), len(email.get("attachments") or [])):
            # Newsletter fast-path — skip AI, force NEWSLETTER directly
            email["category"] = "NEWSLETTER"
            email["priority"] = 1
            email["action"]   = "READ"
            sender_label = email.get("from") or "unknown sender"
            subj_label   = clean_subject(email.get("subject", "No Subject"))
            email["summary"] = (
                f"Newsletter from {sender_label}. "
                f"Subject: {subj_label}. "
                f"Automated digest — no action required."
            )
            pre_classified.append(email)
        else:
            needs_ai.append(email)

    if not needs_ai:
        return pre_classified

    # Build a single prompt with all emails
    emails_input = []
    for i, e in enumerate(needs_ai):
        emails_input.append({
            "index": i,
            "subject": e.get("subject", "No Subject"),
            "from": e.get("from", "Unknown"),
            "body_preview": clean_for_ai(e.get("body") or "", 800)
        })

    batch_prompt = f"""
You are an enterprise email triage assistant. Classify each email below.

Categories: VIP | PRIORITY | URGENT | CONFIDENTIAL | MEETING | NEWSLETTER | NORMAL

Rules:
- ZOOM links are detected automatically before AI runs — never return ZOOM as a category
- VIP: sender is a top-tier executive (detected automatically — AI should not set this)
- PRIORITY: from senior staff/leadership, financial/legal topics
- URGENT: the recipient must take a specific action TODAY or TOMORROW with a real named consequence (patient safety, financial cutoff, system outage). "ASAP" or urgency language alone without a hard deadline and concrete consequence is NOT URGENT. Routine counts and reports are NEVER urgent.
- CONFIDENTIAL: ONLY emails requiring a DECISION or APPROVAL. NOT: routine contracts, offer letters, denial reports, analytics, inactive counts, or termination forms without explicit misconduct.
- URGENT beats CONFIDENTIAL when a hard deadline is present.
- MEETING: sender is explicitly asking the recipient to commit to a specific time — availability requests, calendar invites (.ics), back-and-forth scheduling. NOT MEETING: emails that merely mention a date in passing, meeting minutes shared as FYI, or vague "let's catch up" with no time being coordinated.
- NEWSLETTER: marketing, automated updates, weekly/daily digests — ONLY when no attachments, no action request, no payment/vendor/ACO/HEDIS/DocuSign language. An unsubscribe footer alone is not enough.
- NORMAL: routine contracts, employment paperwork, operational counts, vendor analytics, FYIs
{_get_correction_block()}
For each email return one object with: index, category, priority (1-5), and a summary of 4-6 sentences.
Summary must be thorough enough that the reader never needs to open the email:
- Sentence 1: Core topic, context, and who is involved (full names and roles if present)
- Sentence 2: All specific details — exact numbers, dollar amounts, dates, deadlines, locations, system names, patient counts
- Sentence 3: Any background or history relevant to understanding the request or issue
- Sentence 4: What action or decision is needed from the recipient — and by when if stated
- Sentence 5 (if applicable): Dependencies, blockers, escalation path, or related open items
- Sentence 6 (if applicable): Attachments or follow-up items with their actual names
Never be vague. Every sentence must contain at least one concrete fact. Never say "this email" or "the sender".

INPUT:
{json.dumps(emails_input)}

OUTPUT JSON FORMAT:
{{"results": [{{"index": 0, "category": "...", "priority": 1, "summary": "..."}}]}}
"""

    # Split into chunks of 20 to avoid token limits
    BATCH_SIZE = 20
    all_ai_results = []

    for chunk_start in range(0, len(needs_ai), BATCH_SIZE):
        chunk_emails = needs_ai[chunk_start:chunk_start + BATCH_SIZE]
        chunk_input = [
            {
                "index": i,
                "subject": clean_subject(e.get("subject", "No Subject")),
                "from": e.get("from", "Unknown"),
                "body_preview": clean_for_ai(e.get("body") or "", 800),
                "newsletter_hint": is_newsletter_body(e.get("body") or "", e.get("from", ""), len(e.get("attachments") or []))
            }
            for i, e in enumerate(chunk_emails)
        ]

        chunk_prompt = f"""
You are an executive email intelligence assistant for a medical group portal. 
Your job is to produce summaries so thorough that the reader NEVER needs to open the email itself.

Categories: VIP | PRIORITY | URGENT | CONFIDENTIAL | MEETING | NEWSLETTER | NORMAL

Classification Rules:
- ZOOM links are detected automatically before AI runs — never return ZOOM as a category
- VIP: top-tier executive sender (detected automatically — AI should not set this)
- PRIORITY: from senior staff/leadership, financial or legal topics
- GOLDEN RULE: Emails that only share information, counts, or reports (inactive insurance counts, denial reports, productivity summaries, patient lists, weekly stats) are ALWAYS NORMAL — never URGENT or CONFIDENTIAL regardless of the numbers involved.
- URGENT: the recipient must take a specific concrete action TODAY or TOMORROW and there is a real named consequence (patient safety, financial cutoff, compliance breach, system outage) if they do not. "ASAP", "please review urgently", or "at your earliest convenience" without a hard deadline and named consequence is NOT URGENT. Routine operational counts and weekly reports are NEVER urgent.
- CONFIDENTIAL: ONLY emails requiring an actual DECISION or APPROVAL — financial approvals, payment authorizations, budget approvals, HR disciplinary/termination actions involving suspicious activity or misconduct. NOT confidential: routine employment contracts, offer letters, onboarding paperwork, contract status updates, weekly denial reports, vendor analytics reports, inactive insurance/patient counts, or termination forms unless suspicious activity is explicitly stated.
- URGENT beats CONFIDENTIAL: if an email has a hard deadline AND sensitive content, always choose URGENT.
- MEETING: the sender is explicitly asking the recipient to commit to a specific time — availability requests, formal calendar invites (.ics attachment), or back-and-forth scheduling ("Can you do Thursday at 2pm?", "Let me know your availability"). NOT MEETING: an email that merely mentions a date or past event in passing, meeting minutes shared as FYI with no scheduling action, or vague future intent ("let's catch up sometime") without a specific time being coordinated. ASK: "Is the sender asking me to confirm a time?" — only yes is MEETING.
- NEWSLETTER: marketing, automated digests, bulk updates — ONLY when no attachments, no direct action request, no payment/ACO/HEDIS/DocuSign/vendor agreement language. An unsubscribe footer alone is NOT sufficient — many healthcare partners and e-signature platforms append one to every email.
- NORMAL: routine contract updates, employment paperwork, operational counts, vendor analytics, FYIs
{_get_correction_block()}
Summary Rules — this is the most important part:
- Write 2-4 sentences minimum. Never one sentence.
- Sentence 1: What is this email about? (core topic, context)
- Sentence 2: What specific action, request, or information does it contain? (names, numbers, dates, deadlines if present)
- Sentence 3: What does the recipient need to do, decide, or know? (next step or key takeaway)
- Sentence 4 (if relevant): Any attachments, links, or follow-up items mentioned?
- Include specific details: patient names/counts, dollar amounts, dates, locations, system names — whatever is in the body
- Write in third person, professional tone
- Never say "this email" — just state the facts directly
- Never be vague. "Patients due for AWV tomorrow" is bad. "14 patients are due for Annual Wellness Visits on March 14; the attached CSV lists names, DOBs, and assigned providers for scheduling follow-up." is good.
- NEWSLETTER RULE — exactly 2 sentences: Sentence 1: name the publication/source and its specific headline or subject. Sentence 2: list the 2-3 most concrete highlights or facts from the content so the reader can decide if it's worth opening. NEVER say "this email", "a range of topics", "important topics", "various topics", or anything vague. Name specific tools, companies, people, numbers, policies, or data points actually in the body.

INPUT:
{json.dumps(chunk_input)}

OUTPUT JSON:
{{"results": [{{"index": 0, "category": "...", "priority": 1, "summary": "..."}}]}}
"""
        try:
            response = await client.chat.completions.create(
                model=ACTIVE_MODEL,
                messages=[
                    {"role": "system", "content": "Output JSON only."},
                    {"role": "user", "content": chunk_prompt}
                ],
                response_format={"type": "json_object"}
            )
            parsed = json.loads(response.choices[0].message.content)
            results_map = {r["index"]: r for r in parsed.get("results", [])}

            for i, email in enumerate(chunk_emails):
                ai = results_map.get(i, {})
                sender = extract_sender_email(email.get("from") or "")
                is_legal = sender in LEGAL_SENDERS or any(sender.endswith("@" + d) for d in LEGAL_DOMAINS)
                # VIP/LEGAL/PRIORITY/PROVIDERS: keep pre-set category/priority, only take AI summary
                body_lower = (email.get("body") or "").lower()
                subject_lower = (email.get("subject") or "").lower()
                if sender in VIP_SENDERS or is_legal:
                    # VIP/LEGAL: keep pre-set category, only take AI summary
                    email["summary"] = ai.get("summary", "No summary")
                else:
                    ai_category = ai.get("category", "NORMAL")
                    # Hard guard: AI must never set ZOOM via content alone
                    if ai_category == "ZOOM" and "zoom.us" not in body_lower and "zoom.us" not in subject_lower:
                        ai_category = "MEETING"
                    # PRIORITY senders: fallback to PRIORITY if AI returns NORMAL
                    if sender in PRIORITY_SENDERS and ai_category == "NORMAL":
                        ai_category = "PRIORITY"
                    email["category"] = ai_category
                    email["priority"] = ai.get("priority", 1)
                    email["summary"] = ai.get("summary", "No summary")
                email["action"] = "REVIEW"
                all_ai_results.append(email)

        except Exception as ex:
            log.warning(f"Batch chunk failed: {ex}")
            for email in chunk_emails:
                email["category"] = "NORMAL"
                email["summary"] = "Pending analysis"
                all_ai_results.append(email)

    return pre_classified + all_ai_results


async def generate_sender_report(emails):
    log.debug("Generating sender summaries")
    sender_groups = defaultdict(list)
    for e in emails:
        if 'thread_count' in e:
            continue
        sender = e.get('from') or e.get('sender') or "Unknown"
        if "<" in sender:
            simple_name = sender.split("<")[1].strip(">").lower()
        else:
            simple_name = sender.strip().lower()
        sender_groups[simple_name].append(e)

    top_senders = sorted(sender_groups.items(), key=lambda x: len(x[1]), reverse=True)[:7]
    if not top_senders:
        return []

    senders_input = []
    for name, msgs in top_senders:
        details = " | ".join([f"Subject: {m.get('subject')} (Body: {clean_for_ai(str(m.get('body') or ''), 120)})" for m in msgs[:3]])
        senders_input.append({"id": name, "content": details})

    prompt = f"""
    Analyze these email senders and their content.
    INPUT JSON: {json.dumps(senders_input)}
    TASK: Return a JSON object with a "summaries" list.
    OUTPUT FORMAT: {{ "summaries": [ {{ "id": "email@address.com", "text": "Asking for a demo..." }} ] }}
    """

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "Output JSON only."}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        ai_response = json.loads(response.choices[0].message.content)
        ai_summaries = {item['id'].lower(): item['text'] for item in ai_response.get("summaries", [])}

        final_list = []
        for name, msgs in top_senders:
            fallback_text = f"Discussing: {msgs[0].get('subject')}"
            summary_text = ai_summaries.get(name, fallback_text)
            att_count = sum(len(m.get('attachments', [])) for m in msgs)
            display_name = msgs[0].get('from').split('<')[0].strip()
            if not display_name:
                display_name = name
            # `email` is the address these messages were actually grouped by.
            # The UI needs it to match this sender back to their mail exactly —
            # matching on display_name meant a substring test, where a sender
            # shown as "IT" also matched "Smith <smith@…>" and "Whitney <…>".
            final_list.append({
                "name": display_name,
                "email": name,
                "count": len(msgs),
                "attachments": att_count,
                "summary": summary_text,
            })
        return final_list
    except Exception as e:
        log.error(f"Sender report error: {e}")
        return []


async def analyze_single_thread(subject, messages, user_email: str = "default", conversation_id: str = ""):
    final_messages = []

    if len(messages) == 1:
        raw_body = str(messages[0].get('body') or "")
        main_sender = messages[0].get('from') or "Unknown"
        main_date = messages[0].get('received') or messages[0].get('received_at') or messages[0].get('date') or "Unknown"
        raw_attachments = messages[0].get("attachments", [])
        split_result = split_reply_chain(raw_body, main_sender, main_date, raw_attachments)

        if len(split_result) > 1:
            final_messages = split_result
        else:
            final_messages = [{
                "from": main_sender,
                "date": main_date,
                "body": raw_body,
                "attachments": raw_attachments
            }]
    else:
        for m in messages:
            raw_body = m.get('body') or ""
            # Strip the Outlook quoted chain from each individual reply so each
            # message card shows only its new content — not the full quoted chain.
            # Without this, every reply card contained all previous messages,
            # making the thread look broken/duplicated.
            # Also fixes: str(m.get('body')) was producing literal "None" strings.
            visible_body = _extract_latest_html(raw_body) if raw_body else ""
            final_messages.append({
                "from":        m.get('from') or "Unknown",
                "date":        m.get('received_at') or m.get('received') or m.get('date') or "Unknown",
                "body":        visible_body,
                "attachments": m.get('attachments', []),
                "messageId":   m.get('messageId') or m.get('id') or "",
            })

    # Use conversationId as the cache key — it's stable across all replies in a thread.
    # Fall back to subject+count for safety (should not be needed after cache clear).
    thread_id = f"thread__{conversation_id}" if conversation_id else f"thread__{subject}_{len(final_messages)}"
    cache = load_cache(user_email)
    if thread_id in cache:
        return cache[thread_id]

    display_subject = clean_subject(subject.split("::")[0] if "::" in subject else subject)
    participants = set()
    latest_date = None
    clean_messages = []
    history_text = ""

    for i, msg in enumerate(final_messages):
        sender = msg['from']
        participants.add(sender)
        for addr in normalize_list(msg.get("to")):
            participants.add(addr)
        for addr in normalize_list(msg.get("cc")):
            participants.add(addr)

        date = msg['date']
        if latest_date is None or date != "Unknown":
            latest_date = date

        history_text += f"[{i+1}] FROM: {sender}\nDATE: {date}\nCONTENT: {clean_for_ai(msg['body'], 600)}\n----------------\n"
        clean_messages.append(msg)

    thread_attachments = []
    for m in clean_messages:
        thread_attachments.extend(m.get("attachments", []))

    def safe_dt(val):
        try:
            dt = datetime.fromisoformat(val)
            if dt.tzinfo:
                dt = dt.astimezone(tz=None).replace(tzinfo=None)
            return dt
        except:
            return datetime(1970, 1, 1)

    clean_messages.sort(key=lambda m: safe_dt(m.get("date")), reverse=True)

    # ── Option D: only the NEWEST email's sender drives VIP/PRIORITY/PROVIDERS ──
    # We check only the most recent message so that a VIP/PRIORITY participant
    # in an older reply cannot elevate a thread started or last touched by
    # a non-listed sender (e.g. Amreesh replying to a VIP thread).
    newest_sender = extract_sender_email(clean_messages[0].get("from") or "") if clean_messages else ""
    is_vip_sender       = newest_sender in VIP_SENDERS
    is_priority_sender  = newest_sender in PRIORITY_SENDERS
    is_providers_sender = newest_sender in PROVIDERS_SENDERS

    # ── LEGAL is the one exception: it's "sticky" across the whole thread. ──
    # If a legal contact touches ANY message in the thread — not just the
    # newest one — the thread stays tagged LEGAL, even if someone internal
    # replies afterward. Legal correspondence shouldn't disappear from the
    # Legal folder just because the newest reply came from Horizon staff.
    all_thread_senders = {extract_sender_email(m.get("from") or "") for m in clean_messages}
    is_legal_sender = any(
        s in LEGAL_SENDERS or any(s.endswith("@" + d) for d in LEGAL_DOMAINS)
        for s in all_thread_senders
    )

    prompt = f"""
    Analyze this email thread and produce a thorough summary.
    THREAD SUBJECT: {display_subject}
    RAW_DATE: {latest_date}
    MESSAGES: {history_text}

    TASK:
    1. Categorize: URGENT | MEETING | CONFIDENTIAL | NEWSLETTER | NORMAL
       (ZOOM is detected automatically — never return ZOOM as a category)
    2. Priority: 1-5
    3. Summary: Write 2-4 sentences thorough enough that the reader never needs to open the thread.
       - Sentence 1: What is this thread about? (topic, context, who is involved)
       - Sentence 2: What specific details, numbers, dates, names, or decisions are discussed?
       - Sentence 3: What action or response is needed from the recipient?
       - Sentence 4 (if applicable): Any attachments, links, or outstanding follow-ups?
       Never be vague. Include every concrete fact from the messages.
       - NEWSLETTER RULE — exactly 2 sentences: Sentence 1: name the publication/source and its specific headline or subject. Sentence 2: list the 2-3 most concrete highlights or facts so the reader can decide if it's worth opening. NEVER say "this email", "a range of topics", "important topics", or anything vague.
    4. Action: what the recipient should do (REPLY/REVIEW/SCHEDULE/APPROVE/FYI)

    OUTPUT JSON: {{ "category": "...", "priority": 1-5, "summary": "...", "action": "..." }}
    """
    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "Output JSON only."}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        result = json.loads(response.choices[0].message.content)

        has_zoom = False
        for m in clean_messages:
            if "zoom.us" in (m.get("body") or "").lower():
                has_zoom = True
                break

        if has_zoom:
            final_category = "ZOOM"
            final_priority = 4
        elif is_vip_sender:
            final_category = "VIP"
            final_priority = 5
        elif is_legal_sender:
            final_category = "LEGAL"
            final_priority = 4
        elif is_priority_sender:
            # Priority senders: AI categorizes freely, fallback to PRIORITY if NORMAL
            ai_category = result.get("category", "NORMAL")
            final_category = ai_category if ai_category != "NORMAL" else "PRIORITY"
            final_priority = result.get("priority", 4)
        else:
            # All others including folder members: pure AI categorization
            final_category = result.get("category", "NORMAL")
            final_priority = result.get("priority", 1)

        # Use the real Exchange received timestamp from the source email.
        # messages[0].received_at is set by normalize_email from the API's "received" field
        # (e.g. "2026-03-31T02:09:39-04:00") and is always the most recent delivery time.
        # We avoid latest_date because the loop overwrites it with each parsed message,
        # ending up with the OLDEST reply's date instead of the newest.
        final_date = (
            messages[0].get('received_at') or
            messages[0].get('received') or
            latest_date or
            "1970-01-01T00:00:00"
        )
        latest_message = clean_messages[0]

        # Collect all constituent message IDs so the cache can be indexed
        # under every reply's ID — not just the thread parent's ID.
        all_message_ids = [
            m.get("messageId") or m.get("id")
            for m in messages
            if m.get("messageId") or m.get("id")
        ]

        final_result = {
            "id": messages[0].get("messageId") or messages[0].get("id"),
            "subject": display_subject,
            "from": latest_message.get("from", "Unknown"),
            "to": normalize_list(messages[0].get("to")),
            "cc": normalize_list(messages[0].get("cc")),
            "participants": list(participants),
            "received_at": final_date,
            "messages": clean_messages,
            "thread_count": len(clean_messages),
            "attachments": thread_attachments,
            "category": final_category,
            "priority": final_priority,
            "summary": result.get("summary", "Analysis failed."),
            "action": result.get("action", "REVIEW"),
            "conversationId": conversation_id or "",
            "allMessageIds": all_message_ids,
        }
        save_cache({thread_id: final_result}, user_email)
        return final_result
    except:
        return {"subject": display_subject, "category": "NORMAL", "summary": "Error.", "thread_count": len(final_messages)}


async def generate_executive_brief(threads):
    active_threads = [t for t in threads if t.get('category') != 'NEWSLETTER' and (t.get('thread_count', 1) > 1 or t.get('category') == 'URGENT')]
    if not active_threads:
        return {"briefing_cards": []}

    # ── Deduplicate by subject (normalised) then by conversationId ──
    # Without this, a thread with N messages produces N identical entries
    # (one per cached message ID) causing N duplicate briefing cards.
    seen_subjects = set()
    seen_conv_ids = set()
    deduped_threads = []
    for t in active_threads:
        conv_id = t.get("conversationId", "")
        subj = (t.get("subject") or "").strip().lower()
        # Skip if we've already seen this conversationId or subject
        if conv_id and conv_id in seen_conv_ids:
            continue
        if subj and subj in seen_subjects:
            continue
        if conv_id:
            seen_conv_ids.add(conv_id)
        if subj:
            seen_subjects.add(subj)
        deduped_threads.append(t)

    capped = deduped_threads[:10]

    # Ask GPT only for a one-line status per thread.
    # We never ask GPT for id, subject, topic, or category — we own those
    # fields and inject them ourselves so they always match the real email.
    # Using array index as the key avoids all ID truncation/rewrite issues.
    status_input = [
        {"index": i, "summary": t.get("summary", "")}
        for i, t in enumerate(capped)
    ]

    prompt = f"""
For each email thread below write ONE short sentence (max 8 words) describing
the current status or next action needed.

INPUT JSON:
{json.dumps(status_input)}

OUTPUT JSON FORMAT — one object per input, same order, index preserved:
{{
  "statuses": [
    {{"index": 0, "status": "One-line current status here."}}
  ]
}}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "Output JSON only."}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        gpt_result = json.loads(response.choices[0].message.content)
        status_map = {item["index"]: item["status"] for item in gpt_result.get("statuses", [])}
    except Exception as ex:
        log.warning(f"generate_executive_brief GPT call failed: {ex}")
        status_map = {}

    # Build briefing cards entirely from our own data — no GPT fields for id/subject/category
    briefing_cards = []
    for i, t in enumerate(capped):
        briefing_cards.append({
            "id":       t.get("id"),
            "subject":  t.get("subject", "No Subject"),
            "topic":    t.get("subject", "No Subject"),
            "status":   status_map.get(i, t.get("summary", "")[:80]),
            "category": t.get("category", "NORMAL"),
            "thread_count": t.get("thread_count", 1),
        })

    return {"briefing_cards": briefing_cards}


async def generate_daily_digest(emails: list) -> list:
    """
    Groups emails by received date and generates one natural-language paragraph
    per day. Pre-aggregates before sending to GPT so quality is consistent
    whether there are 5 emails or 500 — no token limits, no vague summaries.
    Returns a list of { date, email_count, paragraph } dicts, newest day first.
    """
    if not emails:
        return []

    from collections import defaultdict as _dd, Counter

    # ── Group by date ──
    day_groups = _dd(list)
    for e in emails:
        raw = e.get("received_at") or e.get("received") or ""
        try:
            dt = datetime.fromisoformat(raw)
            day_key = dt.strftime("%Y-%m-%d")
        except Exception:
            day_key = "Unknown"
        if day_key != "Unknown":
            day_groups[day_key].append(e)

    if not day_groups:
        return []

    sorted_days = sorted(day_groups.keys(), reverse=True)[:7]

    # ── Pre-aggregate each day into a compact structure ──
    # GPT receives this instead of raw email objects — works for any volume
    days_input = []
    for day in sorted_days:
        group = day_groups[day]

        # Count by category
        category_counts = Counter(
            (e.get("category") or "NORMAL").upper()
            for e in group
        )

        # Top senders by volume (max 5) with their dominant topic
        sender_map = _dd(list)
        for e in group:
            sender = (e.get("from") or "Unknown").strip()
            sender_map[sender].append(e)

        top_senders = []
        for sender, s_emails in sorted(sender_map.items(), key=lambda x: -len(x[1]))[:5]:
            # Pick the most representative summary from this sender
            best = next((e.get("summary") for e in s_emails if e.get("summary")), "")
            top_senders.append({
                "from":  sender,
                "count": len(s_emails),
                "topic": clean_for_ai(best, 120) if best else s_emails[0].get("subject", "")
            })

        # Urgent subjects (max 4)
        urgent_items = [
            e.get("subject", "")
            for e in group
            if (e.get("category") or "").upper() in ("URGENT", "CONFIDENTIAL")
        ][:4]

        # VIP/PRIORITY subjects (max 4)
        priority_items = [
            e.get("subject", "")
            for e in group
            if (e.get("category") or "").upper() in ("VIP", "LEGAL", "PRIORITY")
        ][:4]

        days_input.append({
            "date":           day,
            "total":          len(group),
            "by_category":    dict(category_counts),
            "top_senders":    top_senders,
            "urgent_items":   urgent_items,
            "priority_items": priority_items,
            "meetings":       sum(1 for e in group if (e.get("category") or "").upper() in ("MEETING", "ZOOM")),
            "attachments":    sum(len(e.get("attachments") or []) for e in group),
        })

    prompt = f"""
You are an executive assistant writing a concise daily email digest for a busy medical group executive.

For each day below write ONE focused paragraph (4-6 sentences) that:
- Opens with the date and total email count naturally in the flow
- Calls out the top senders and what they were writing about
- Highlights urgent or confidential items by name if present
- Mentions meetings/Zoom calls if any
- Ends with one clear "action focus" — the single most important thing to act on
- Never says "this email", "various topics", or anything vague
- Uses direct, professional language — no filler

INPUT (pre-aggregated, may cover high email volumes):
{json.dumps(days_input, indent=2)}

OUTPUT JSON:
{{
  "digest": [
    {{
      "date": "2026-04-16",
      "email_count": 56,
      "paragraph": "On Wednesday April 16, 56 emails arrived..."
    }}
  ]
}}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[
                {"role": "system", "content": "Output JSON only."},
                {"role": "user",   "content": prompt}
            ],
            response_format={"type": "json_object"},
            # Was 1500 — too tight for a full 7-day digest (each day's paragraph
            # alone can run 150+ tokens, before any JSON overhead or model
            # reasoning), and was cutting the response off mid-string on busier
            # weeks (seen as a "json.JSONDecodeError: Unterminated string" from
            # the json.loads() below). Raised with margin rather than tuned to
            # the exact minimum, since a cut-off response fails the whole
            # digest for that request.
            max_completion_tokens=4000
        )
        result = json.loads(response.choices[0].message.content)
        digest = result.get("digest", [])

        # Always use our own email_count — never trust GPT's
        count_map = {d["date"]: d["total"] for d in days_input}
        for item in digest:
            item["email_count"] = count_map.get(item["date"], item.get("email_count", 0))

        return digest

    except Exception as ex:
        log.warning(f"generate_daily_digest failed: {ex}")
        return [
            {"date": d, "email_count": len(day_groups[d]), "paragraph": ""}
            for d in sorted_days
        ]


async def draft_email_reply(sender, context, user_name: str = "User"):
    is_internal = "hfmg.net" in sender.lower()
    tone_desc = "Brief, direct, and internal" if is_internal else "Professional, partnership-focused, and polite"

    # Extract first name for the sign-off (e.g. "Ramon Romero" → "Ramon")
    first_name = user_name.strip().split()[0] if user_name.strip() else "User"

    system_prompt = f"""
    You are {user_name}. You are writing a reply to {sender}.
    YOUR STYLE GUIDE:
    - Tone: {tone_desc}.
    - Be decisive. No fluff.
    - Sign off: "Thanks, {user_name}" or "Best, {user_name}".
    -After the sign-off, always end with exactly:⚡ AI Assisted Reply
    """
    user_prompt = f"CONTEXT: {context}. TASK: Draft reply body only."

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            max_completion_tokens=300
        )
        return response.choices[0].message.content.strip()
    except Exception:
        return "Drafting failed."


def calculate_triage_stats(emails, threads=None, user_identifier="", demo_mode=False):
    target = user_identifier.strip().lower()
    vol_emails = sum(
        e.get("thread_count") or
        len(e.get("messages") or []) or
        1
        for e in emails
    )

    if threads and isinstance(threads, list):
        meaningful_threads = []
        for t in threads:
            category = (t.get("category") or "").upper()
            thread_count = t.get("thread_count", 1)
            if category != "NEWSLETTER" or thread_count > 1 or category in ["URGENT", "PRIORITY", "VIP", "MEETING"]:
                meaningful_threads.append(t)
        vol_threads = len(meaningful_threads)
    else:
        vol_threads = 0

    vol_meetings = 0
    if threads and isinstance(threads, list):
        vol_meetings = sum(1 for t in threads if (t.get("category") or "").upper() in ("MEETING", "ZOOM"))

    att_total = 0
    att_breakdown = {"PDF": 0, "DOC": 0, "XLS": 0, "IMG": 0}

    for e in emails:
        attachments = e.get("attachments", []) or []
        att_total += len(attachments)
        for att in attachments:
            name = str(att.get("name", "")).lower()
            if name.endswith(".pdf"):
                att_breakdown["PDF"] += 1
            elif "doc" in name:
                att_breakdown["DOC"] += 1
            elif "xls" in name or "csv" in name:
                att_breakdown["XLS"] += 1
            elif any(ext in name for ext in ["png", "jpg", "jpeg"]):
                att_breakdown["IMG"] += 1

    to_count = 0
    cc_count = 0

    def extract_addresses(field):
        addresses = []
        if isinstance(field, str):
            addresses.extend([x.strip().lower() for x in field.replace(";", ",").split(",")])
        elif isinstance(field, list):
            for item in field:
                if isinstance(item, str):
                    addresses.append(item.strip().lower())
                elif isinstance(item, dict):
                    addr = (item.get("emailAddress", {}).get("address") or item.get("address") or item.get("email"))
                    if addr:
                        addresses.append(str(addr).strip().lower())
        return addresses

    for e in emails:
        to_list = extract_addresses(e.get("to"))
        cc_list = extract_addresses(e.get("cc"))
        if target in to_list:
            to_count += 1
        elif target in cc_list:
            cc_count += 1

    return {
        "vol_emails": vol_emails,
        "vol_threads": vol_threads,
        "vol_meetings": vol_meetings,
        "total_unread": sum(1 for e in emails if not e.get("isRead", False)),
        "att_total": att_total,
        "att_breakdown": att_breakdown,
        "to": to_count,
        "cc": cc_count
    }


async def generate_day_brief_summary(meetings: list, date_label: str) -> str:
    """Generate a natural language paragraph summarising the day's meetings."""
    if not meetings:
        return ""

    items = []
    for m in meetings:
        subject   = m.get("subject") or "Untitled"
        start     = m.get("start", "")
        end       = m.get("end", "")
        location  = m.get("location", "")
        organizer = m.get("organizer", "")
        required  = m.get("requiredAttendees") or []
        optional  = m.get("optionalAttendees") or []
        all_day   = m.get("isAllDay", False)
        cancelled = m.get("isCancelled", False)

        try:
            time_str = "All day" if all_day else (
                f"{datetime.fromisoformat(start).strftime('%I:%M %p').lstrip('0')} – "
                f"{datetime.fromisoformat(end).strftime('%I:%M %p').lstrip('0')}"
            )
        except Exception:
            time_str = start

        items.append({
            "title": subject,
            "time": time_str,
            "location": location or None,
            "organizer": organizer or None,
            "attendees": len(required) + len(optional),
            "cancelled": cancelled,
        })

    prompt = (
        f"You are an executive assistant writing a daily meeting brief for {date_label}.\n\n"
        f"Meetings:\n{json.dumps(items, indent=2)}\n\n"
        "Write exactly 2-3 sentences in plain, professional English that:\n"
        "- Narrate the day's schedule in chronological order\n"
        "- Mention notable meetings, organizers, or attendee counts where meaningful\n"
        "- Flag any cancelled meetings naturally\n"
        "- Give an overall sense of how busy or light the day is\n"
        "Output only the paragraph — no bullet points, no headers, no extra text."
    )

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_completion_tokens=180,
        )
        return response.choices[0].message.content.strip()
    except Exception as ex:
        log.error(f"generate_day_brief_summary failed: {ex}")
        return ""


# ══════════════════════════════════════════════════════════════════════════════

async def analyze_sent_thread_reply(
    thread_messages: list,
    user_email: str,
    subject: str,
    not_replied_addresses: list = None,
) -> dict:
    """
    AI analysis of a sent email thread.
    Reads every message in the thread and returns:
      - needs_reply   : bool   — does anyone still owe a response?
      - verdict       : str    — one-line verdict ("Concluded", "Waiting on X", etc.)
      - pending       : list   — addresses who haven't replied (names only)
      - analysis      : str    — 3-4 sentence explanation of the conversation state
      - confidence    : str    — high / medium / low
    """
    if not thread_messages:
        return {
            "needs_reply": False,
            "verdict": "No thread content available",
            "pending": [],
            "analysis": "No messages were found in this thread.",
            "confidence": "low",
        }

    sender_name = user_email.split("@")[0].replace(".", " ").title()

    # Build a readable transcript for the AI
    transcript_lines = []
    for i, msg in enumerate(thread_messages):
        from_addr = msg.get("from") or msg.get("From") or "Unknown"
        date_raw  = msg.get("received") or msg.get("received_at") or msg.get("date") or msg.get("Received") or ""
        body_raw  = msg.get("body") or msg.get("Body") or ""
        to_list   = msg.get("to") or msg.get("To") or []
        if isinstance(to_list, list):
            to_str = ", ".join(to_list)
        else:
            to_str = str(to_list)

        try:
            from datetime import datetime as _dt
            dt = _dt.fromisoformat(str(date_raw).rstrip("Z"))
            date_fmt = dt.strftime("%b %d %Y %I:%M %p")
        except Exception:
            date_fmt = date_raw

        body_clean = clean_for_ai(body_raw, 600)
        transcript_lines.append(
            f"[Message {i+1}]\n"
            f"From: {from_addr}\n"
            f"To: {to_str}\n"
            f"Date: {date_fmt}\n"
            f"Body: {body_clean}\n"
        )

    transcript = "\n---\n".join(transcript_lines)

    # Include EWS hint if available
    ews_hint = ""
    if not_replied_addresses:
        ews_hint = (
            f"\n\nEWS reply-tracking data (use as a strong signal but verify against the thread):\n"
            f"Still awaiting reply from: {', '.join(not_replied_addresses)}"
        )

    prompt = f"""You are an email reply-status analyst for a medical group executive portal.

The logged-in user is: {sender_name} ({user_email})
Email subject: {subject}

Full thread transcript (ordered oldest → newest):
{transcript}{ews_hint}

TASK: Analyze this email thread and determine:
1. Is the conversation concluded, or does {sender_name} need a reply from someone?
2. If waiting: WHO specifically still needs to respond (first name or email)?
3. What is the overall state of this conversation?

OUTPUT — respond ONLY with valid JSON, no markdown:
{{
  "needs_reply": true or false,
  "verdict": "Short one-line verdict (max 10 words)",
  "pending": ["First Name or email of person who hasn't replied"],
  "analysis": "3-4 sentences explaining the conversation. What was asked, who responded, what is outstanding or why it is concluded.",
  "confidence": "high | medium | low"
}}

Rules:
- needs_reply = true only if {sender_name} is still waiting for a response to a question or request
- needs_reply = false if: everyone replied, or this is an FYI/announcement, or the conversation is clearly done
- pending list should be first names only if inferable, otherwise the email address
- verdict examples: "Waiting on John and Sarah", "Conversation concluded", "FYI — no reply expected", "Reply received from all"
- confidence = low if the thread is ambiguous or very short"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[
                {"role": "system", "content": "Output only valid JSON. No markdown, no preamble."},
                {"role": "user",   "content": prompt},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=400,
        )
        result = json.loads(response.choices[0].message.content)
        # Normalise types
        result["needs_reply"] = bool(result.get("needs_reply", False))
        result["pending"]     = result.get("pending") or []
        result["confidence"]  = result.get("confidence", "medium").lower()
        return result
    except Exception as e:
        log.error(f"analyze_sent_thread_reply error: {e}")
        return {
            "needs_reply": False,
            "verdict": "Analysis failed — please try again",
            "pending": [],
            "analysis": str(e),
            "confidence": "low",
        }


# ══════════════════════════════════════════════════════════════════════════════

# =============================================================================
# TRACKING SYSTEM — clean rewrite
#
# Logic:
#   • New sent emails  → AI filter → Needs Review tab (pending_tracking_approvals)
#   • User approves    → moves to active tracking; Day-1 fires immediately if overdue
#   • Scheduler runs   → Day-1 auto-sent when bdays >= 1 and no reply
#                      → Day-3 auto-sent when bdays >= 3, Day-1 sent, and no reply
#                      → Day-5+: digest only; user follows up manually
#   • External recipients: digest tab only, never auto-reminded
#   • Recipients in TRACKING_EXCLUDED are never tracked
# State stored per-user in tracking_{email}.json
# =============================================================================

# Addresses that are NEVER tracked as recipients.
# VIPs + a short hardcoded list of senior staff / shared inboxes.
_TRACKING_EXTRA_EXCLUSIONS = {
    "rinku.singh@hfmg.net",
    "ramon.romero@hfmg.net",
    "hira.ahmed@hfmg.net",
    "sally.kelly@hfmg.net",
    "global.office@hfmg.net",
    "jim@hfmg.net",
    "donna.shaughnessy@hfmg.net",
}

def _build_tracking_exclusions() -> set:
    vip_lower = {v.lower() for v in load_sender_list(VIP_FILE)}
    return vip_lower | _TRACKING_EXTRA_EXCLUSIONS

TRACKING_EXCLUDED = _build_tracking_exclusions()
log.debug(f"[tracking] {len(TRACKING_EXCLUDED)} addresses excluded from reply tracking")


# ---------------------------------------------------------------------------
# File / lock helpers
# ---------------------------------------------------------------------------

def _tracking_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"tracking_{safe}.json"

_tracking_locks: dict = {}
_tracking_locks_mutex_t = threading.Lock()

def _get_tracking_lock(user_email: str) -> threading.Lock:
    with _tracking_locks_mutex_t:
        if user_email not in _tracking_locks:
            _tracking_locks[user_email] = threading.Lock()
        return _tracking_locks[user_email]

def load_tracking(user_email: str) -> dict:
    """Load per-user tracking store from disk."""
    path = _tracking_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception as e:
            log.error(f"load_tracking error: {e}")
    return {
        "tracked": [],
        "pending_tracking_approvals": [],
        "reminder_message_ids": [],
        "lastUpdated": None,
    }

def save_tracking(data: dict, user_email: str):
    """Persist tracking store to disk with per-user lock."""
    path = _tracking_file_for(user_email)
    with _get_tracking_lock(user_email):
        with open(path, "w") as f:
            json.dump(data, f, indent=2, default=str)

# ---------------------------------------------------------------------------
# Business-day counter
# ---------------------------------------------------------------------------

def get_business_days_since(sent_at_str: str) -> int:
    """
    Count business days (Mon-Fri) elapsed since sent_at_str.
    Returns 0 on any parsing failure so callers don't fire reminders on bad data.
    """
    if not sent_at_str or not str(sent_at_str).strip():
        return 0
    try:
        sent_dt = datetime.fromisoformat(str(sent_at_str).rstrip("Z"))
        # Strip timezone info so comparison is always naive UTC
        if sent_dt.tzinfo is not None:
            sent_dt = sent_dt.astimezone(timezone.utc).replace(tzinfo=None)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        count = 0
        current = sent_dt
        while current.date() < now.date():
            current += timedelta(days=1)
            if current.weekday() < 5:   # Mon=0 … Fri=4
                count += 1
        return count
    except Exception as e:
        log.error(f"get_business_days_since error for value={sent_at_str!r}: {e}")
        return 0

# ---------------------------------------------------------------------------
# .NET API helpers
# ---------------------------------------------------------------------------

async def fetch_sent_items_for_tracking(user_email: str, count: int = 100) -> list:
    """Call GET /api/Values/sentitems/{email}/count{n} on the .NET server."""
    import httpx as _httpx
    url = f"http://172.22.6.188:177/api/Values/sentitems/{user_email}/count{count}"
    try:
        async with _httpx.AsyncClient(timeout=60) as hc:
            resp = await hc.get(url)
        if resp.status_code == 200:
            return resp.json()
        log.error(f"fetch_sent_items HTTP {resp.status_code}: {resp.text[:200]}")
        return []
    except Exception as e:
        log.error(f"fetch_sent_items exception: {e}")
        return []

# ---------------------------------------------------------------------------
# AI reminder body generator
# ---------------------------------------------------------------------------

# ── Fixed reminder templates ──────────────────────────────────────────────────
_DAY1_TEMPLATE = (
    "Hi {rec_first},\n\n"
    "Hope your week's going well! Just following up on my email about {topic} — "
    "haven't heard back yet and want to make sure it didn't slip through the cracks.\n\n"
    "Please send over an update when you can, ideally today. And if you need anything "
    "from me to move this forward, just say the word.\n\n"
    "Thanks!\n\n"
    "{sender_first}\n\n"
    "──────────────────────────\n"
    "🤖 AI Assisted Reply | Horizon Family Medical Group"
)

_DAY3_TEMPLATE = (
    "Hi {rec_first},\n\n"
    "I've followed up on {topic} a couple of times now and still haven't heard back — "
    "I do need a response on this one.\n\n"
    "It's been three days, so please make this a priority and get back to me today. "
    "If something's come up or there's a blocker on your end, just reach out and we'll "
    "work through it together.\n\n"
    "Thanks for getting on this.\n\n"
    "{sender_first}\n\n"
    "──────────────────────────\n"
    "🤖 AI Assisted Reply | Horizon Family Medical Group"
)

def _clean_subject_topic(subject: str) -> str:
    """
    Derive a clean topic directly from the subject line — no AI, no hallucination.
    Strips Re:/Fwd:/FW: prefixes and trailing punctuation noise.
    e.g. "TCM;" → "TCM",  "Re: Provider Contract Review" → "Provider Contract Review"
    """
    import re as _r
    s = subject.strip()
    prefix = _r.compile(r'^(Re|Fwd?|FW|AW)\s*:\s*', _r.IGNORECASE)
    while prefix.match(s):
        s = prefix.sub('', s).strip()
    s = s.strip(' ;:,.-–—')
    return s if s else subject.strip()


async def generate_reminder_body(
    subject: str,
    recipient_first: str,
    day: int,
    sender_first: str,
    is_external: bool,
) -> str:
    """
    Build a reminder body from a fixed template.
    Topic is derived by _clean_subject_topic() — no GPT call, no hallucination.
    """
    topic    = _clean_subject_topic(subject)
    template = _DAY1_TEMPLATE if day == 1 else _DAY3_TEMPLATE
    return template.format(
        rec_first=recipient_first,
        topic=topic,
        sender_first=sender_first,
    )

# ---------------------------------------------------------------------------
# Shared reminder send helper
# ---------------------------------------------------------------------------

def _build_context_html(subject: str, sent_at: str, display_addr: str, orig_body: str) -> str:
    """Build the quoted original-email HTML block appended to every reminder."""
    import html as _html
    plain = _re.sub(r"<[^>]+>", " ", orig_body)
    plain = _html.unescape(plain)
    plain = _re.sub(r"[ \t]+", " ", plain).strip()
    if len(plain) > 600:
        plain = plain[:600].rstrip() + "…"
    try:
        sent_fmt = datetime.fromisoformat(sent_at.rstrip("Z")).strftime("%B %d, %Y")
    except Exception:
        sent_fmt = sent_at
    return (
        f"<br/><br/>"
        f"<hr style='border:none;border-top:1px solid #ccc;margin:16px 0'/>"
        f"<p style='color:#555;font-size:0.85em;margin:0 0 8px 0'>"
        f"<strong>--- Original Message ---</strong><br/>"
        f"<strong>Subject:</strong> {subject}<br/>"
        f"<strong>Sent:</strong> {sent_fmt}<br/>"
        f"<strong>To:</strong> {display_addr}</p>"
        f"<p style='color:#333;font-size:0.9em;white-space:pre-wrap;margin:0'>{plain}</p>"
    )

async def _send_reminder(
    hc,                  # httpx.AsyncClient
    addr: str,
    info: dict,
    day: int,
    subject: str,
    sent_at: str,
    orig_body: str,
    sender_first: str,
    org: str = "http://172.22.6.188:177",
) -> bool:
    """
    Generate AI body and send one reminder immediately.
    Updates info flags in-place on success.
    Returns True if sent successfully.
    """
    rec_first    = addr.split("@")[0].split(".")[0].title()
    display_addr = info.get("originalAddress", addr)
    is_external  = info.get("type") == "external"

    draft_body   = await generate_reminder_body(subject, rec_first, day, sender_first, is_external)
    context_html = _build_context_html(subject, sent_at, display_addr, orig_body)
    full_html    = draft_body.replace("\n", "<br/>") + context_html

    subject_line = (
        f"Quick Follow-Up – {subject}"
        if day == 1
        else f"Following Up Again – Response Needed | {subject}"
    )
    parts = [
        ("To",          (None, display_addr,   "text/plain")),
        ("Subject",     (None, subject_line,   "text/plain")),
        ("BodyHtml",    (None, full_html,                     "text/plain")),
        ("FromEmail",   (None, "reminders@hfmg.net",          "text/plain")),
        ("Attachments", ("",   b"",  "application/octet-stream")),
    ]
    try:
        r = await hc.post(f"{org}/api/Values/mail/SentAsRemainder", files=parts)
        if r.status_code == 200:
            now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
            if day == 1:
                info["reminder1_sent"]    = True
                info["reminder1_sentAt"]  = now
                info["reminder1_pending"] = False
            else:
                info["reminder2_sent"]    = True
                info["reminder2_sentAt"]  = now
                info["reminder2_pending"] = False
            return True
        log.error(f"[tracking] reminder send non-200 ({r.status_code}) → {addr} day={day}")
        return False
    except Exception as e:
        log.error(f"[tracking] reminder send exception → {addr} day={day}: {e}")
        return False

# ---------------------------------------------------------------------------
# Not-tracked log
# ---------------------------------------------------------------------------

_NOT_TRACKED_LOG_LIMIT = 500

def _not_tracked_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"not_tracked_{safe}.json"

def load_not_tracked_log(user_email: str) -> list:
    path = _not_tracked_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception as e:
            log.error(f"load_not_tracked_log error: {e}")
    return []

def _save_not_tracked_log(entries: list, user_email: str):
    path = _not_tracked_file_for(user_email)
    with open(path, "w") as f:
        json.dump(entries, f, indent=2, default=str)

def append_not_tracked(user_email: str, entry: dict):
    """Append one skipped email to the not-tracked log (newest 500 kept)."""
    entries = load_not_tracked_log(user_email)
    entries = [e for e in entries if e.get("messageId") != entry.get("messageId")]
    entries.insert(0, entry)
    _save_not_tracked_log(entries[:_NOT_TRACKED_LOG_LIMIT], user_email)

# ---------------------------------------------------------------------------
# AI batch tracking decision
# ---------------------------------------------------------------------------

_AI_TRACKING_CHUNK_SIZE = 5

def _fallback_decision(item: dict, reason: str = "AI unavailable") -> dict:
    return {
        "should_track":        True,
        "reason":              reason,
        "recipients_to_track": item.get("to", []),
        "dropped_recipients":  {},
    }

def _extract_json_array(raw: str, chunk_size: int) -> list:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = _re.sub(r"^```[a-z]*\n?", "", raw, flags=_re.IGNORECASE)
        raw = _re.sub(r"\n?```$", "", raw).strip()
    if raw.startswith("{"):
        raw = f"[{raw}]"
    try:
        result = json.loads(raw)
        return result if isinstance(result, list) else [result]
    except json.JSONDecodeError as e:
        if "Extra data" in str(e):
            try:
                result = json.loads(raw[:e.pos])
                return result if isinstance(result, list) else [result]
            except Exception:
                pass
        try:
            depth, last_close = 0, -1
            for i, ch in enumerate(raw):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        last_close = i
            if last_close > 0:
                trimmed = raw[: last_close + 1].rstrip().rstrip(",")
                if not trimmed.endswith("]"):
                    trimmed += "]"
                if not trimmed.startswith("["):
                    trimmed = "[" + trimmed
                result = json.loads(trimmed)
                return result if isinstance(result, list) else [result]
        except Exception:
            pass
    log.error("[ai_tracking] Could not parse JSON from GPT response")
    return []

async def _ai_tracking_batch(chunk: list, sender_name: str, sender_email: str) -> list:
    batch_lines = []
    for i, item in enumerate(chunk):
        is_reply     = bool(item.get("isReply", False))
        snippet_len  = 500 if is_reply else 300
        body_snippet = (item.get("body") or "")[:snippet_len].strip()
        to_list      = ", ".join(item.get("to") or [])
        cc_list      = ", ".join(item.get("cc") or [])
        all_rec      = ", ".join(list(dict.fromkeys(
            (item.get("to") or []) + (item.get("cc") or [])
        )))
        type_label = "REPLY (thread)" if is_reply else "NEW EMAIL"
        batch_lines.append(
            f"#{i+1} [{type_label}]\n"
            f"Subject: {item.get('subject','(no subject)')}\n"
            f"To: {to_list or '-'}\nCC: {cc_list or '-'}\n"
            f"All recipients: {all_rec or '-'}\n"
            f"Body: {body_snippet or '(empty)'}"
        )

    prompt = f"""You are a follow-up tracking filter for a medical group executive portal.

The logged-in user is: {sender_name} ({sender_email})

For each email decide whether {sender_name} needs to track it for a reply.

NEW EMAIL: TRACK if {sender_name} asked a direct question, approval, or action item. SKIP if FYI/thank-you/confirmation with no ask.
REPLY (thread): TRACK only if {sender_name}'s OWN new text (top of body) contains a direct question or request to a SPECIFIC person. SKIP if just acknowledging/thanking.
recipients_to_track: only people directly asked. Empty [] if should_track=false.

Return EXACTLY {len(chunk)} JSON objects in order (raw array, no markdown):
{{"should_track":true/false,"reason":"one sentence","recipients_to_track":["email@example.com"]}}

EMAILS:
{chr(10).join(batch_lines)}"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[
                {"role": "system", "content": "Output only a raw JSON array."},
                {"role": "user",   "content": prompt},
            ],
            max_completion_tokens=600,
        )
        raw = response.choices[0].message.content or ""
        parsed = _extract_json_array(raw, len(chunk))
        if len(parsed) == len(chunk):
            return parsed
        log.warning(f"[ai_tracking] Got {len(parsed)} results for {len(chunk)} items — using fallbacks")
        results = list(parsed) + [None] * (len(chunk) - len(parsed))
        return [r if r is not None else _fallback_decision(chunk[i]) for i, r in enumerate(results)]
    except Exception as e:
        log.error(f"[ai_tracking] batch error: {e}")
        return [_fallback_decision(item) for item in chunk]

async def ai_tracking_decision(
    items: list, sender_name: str = "the sender", sender_email: str = ""
) -> list:
    """Run AI tracking decisions in chunks of 5. Returns one decision per item."""
    all_decisions = []
    for i in range(0, len(items), _AI_TRACKING_CHUNK_SIZE):
        chunk = items[i: i + _AI_TRACKING_CHUNK_SIZE]
        try:
            decisions = await _ai_tracking_batch(chunk, sender_name, sender_email)
        except Exception as e:
            log.error(f"[ai_tracking] chunk error: {e}")
            decisions = [_fallback_decision(item) for item in chunk]
        all_decisions.extend(decisions)
    track_count = sum(1 for d in all_decisions if d.get("should_track"))
    log.info(f"[ai_tracking] Result — {track_count} to track, {len(all_decisions)-track_count} skipped")
    return all_decisions

# ---------------------------------------------------------------------------
# Main scheduler
# ---------------------------------------------------------------------------

async def run_tracking_scheduler(user_email: str):
    """
    Main tracking scheduler — called every 2 hours and on manual sync.

    Pass 1 — filter sent items (skip reminders, invites, already pending)
    Pass 2 — AI decision on new emails → pending_tracking_approvals
    Pass 3 — update reply status for existing tracked emails
              SAFE: only marks replied=True if the address is EXPLICITLY
              absent from notRepliedAddresses AND the list is non-empty.
              Empty list = "no reply data" not "everyone replied".
    Pass 4 — auto-send Day-1 and Day-3 reminders for active tracked emails
              Uses two separate if-blocks (not if/elif) so Day-3 can fire
              on the same run that Day-1 fires when already >= 3 bdays.
    """
    import httpx as _httpx
    ORG = "http://172.22.6.188:177"
    log.info(f"[tracking] Scheduler start — user={user_email}")

    try:
        sent_items = await fetch_sent_items_for_tracking(user_email)
        if not sent_items:
            log.info(f"[tracking] No sent items returned for {user_email}")
            return

        tracking         = load_tracking(user_email)
        tracked_by_id    = {t["messageId"]: t for t in tracking.get("tracked", [])}
        # Maps conversationId → primary messageId so that follow-up replies sent
        # within an already-tracked thread are routed to existing_items (Pass 1)
        # and resolved back to the correct tracking entry (Pass 3).
        conv_to_tracked  = {
            t["conversationId"]: t["messageId"]
            for t in tracking.get("tracked", [])
            if t.get("conversationId")
        }
        sender_first     = user_email.split("@")[0].split(".")[0].title()
        reminder_ids     = set(tracking.get("reminder_message_ids", []))
        pending_appr_ids = {
            p["messageId"] for p in tracking.get("pending_tracking_approvals", [])
        }

        # ── Pass 1: filter sent items ──────────────────────────────────────
        new_candidates = []
        existing_items = []

        for item in sent_items:
            msg_id  = item.get("messageId", "")
            subject = item.get("subject", "(no subject)")
            if not msg_id:
                continue
            if msg_id in reminder_ids:
                continue
            if _re.search(
                r'^(quick follow-up\s*[–\-]|following up again\s*[\|–\-]|following up:)',
                subject, _re.IGNORECASE
            ):
                continue
            if _re.match(r"^(accepted|declined|tentative|cancelled|canceled):\s", subject, _re.IGNORECASE):
                continue
            body_lower    = (item.get("body") or "").lower()
            is_invite_sub = bool(_re.match(r"^(invitation|invite|meeting request|meeting):\s", subject, _re.IGNORECASE))
            is_invite_cls = item.get("isMeetingRequest") or item.get("itemClass", "").startswith("IPM.Schedule")
            is_invite_bod = any(p in body_lower for p in [
                "you have been invited to", "has invited you to", "join zoom meeting",
                "join the meeting", "microsoft teams meeting", "google meet",
                "webex meeting", "when:", "organizer:", "required attendees:",
                "optional attendees:", "location: zoom", "location: microsoft teams",
            ])
            if is_invite_sub or is_invite_cls or is_invite_bod:
                continue
            if msg_id in pending_appr_ids:
                continue
            if msg_id in tracked_by_id:
                existing_items.append(item)
            elif item.get("conversationId") and item.get("conversationId") in conv_to_tracked:
                # This is a newer reply sent within an already-tracked thread.
                # Route to existing_items so Pass 3 can update reply status
                # on the original tracking entry instead of treating it as a
                # brand-new email and creating a duplicate tracking entry.
                existing_items.append(item)
            else:
                new_candidates.append(item)

        # ── Pass 2: decide which new emails to track ──────────────────────
        if new_candidates:
            sender_display = " ".join(
                p.title() for p in user_email.split("@")[0].split(".")
            )

            # ── Split into three buckets ───────────────────────────────────
            #
            # REPLY  → isReply=True AND subject starts with "Re:"
            #   The AI was skipping these because reply bodies rarely contain
            #   an explicit "direct question to a specific person". We bypass
            #   AI and route straight to Needs Review.
            #
            # FORWARD → isReply=True BUT subject starts with "Fw:/Fwd:"
            #   Exchange sets In-Reply-To for forwards too, so isReply=True
            #   alone can't distinguish a reply from a forward. Forwards go
            #   to AI — the user may or may not expect a response back.
            #
            # FRESH  → isReply=False
            #   Brand-new original email. AI decides as normal.
            #
            def _is_thread_reply(item: dict) -> bool:
                if not item.get("isReply"):
                    return False
                subj = item.get("subject", "")
                # Forward prefix → NOT a reply for our purposes
                if _re.match(r'^(Fw|Fwd)\s*:', subj, _re.IGNORECASE):
                    return False
                return True

            reply_items = [i for i in new_candidates if _is_thread_reply(i)]
            fresh_items = [i for i in new_candidates if not _is_thread_reply(i)]

            log.info(
                f"[tracking] Pass 2 — {len(reply_items)} thread replies "
                f"(bypass AI), {len(fresh_items)} fresh/forward emails (AI)"
            )

            # ── Helper: build recipients dict for one item ─────────────────
            def _build_recipients(item: dict) -> dict:
                result = {}
                all_addresses = list(dict.fromkeys(
                    (item.get("to") or []) + (item.get("cc") or [])
                ))
                for addr in all_addresses:
                    a = addr.lower()
                    if a in TRACKING_EXCLUDED:
                        continue
                    result[a] = {
                        "originalAddress":  addr,
                        "type":             "internal" if "hfmg.net" in a else "external",
                        "replied":          False,
                        "reminder1_sent":   False,
                        "reminder1_sentAt": None,
                        "reminder2_sent":   False,
                        "reminder2_sentAt": None,
                        "dismissed":        False,
                        "dismissedAt":      None,
                    }
                return result

            # ── Helper: append approval entry and save ─────────────────────
            def _queue_approval(item: dict, recipients: dict, ai_reason: str) -> None:
                msg_id  = item.get("messageId", "")
                subject = item.get("subject", "(no subject)")
                sent_at = item.get("sentAt", "")
                approval_id = (
                    f"{msg_id}__approval__"
                    f"{int(datetime.now(timezone.utc).replace(tzinfo=None).timestamp())}"
                )
                approval_entry = {
                    "id":             approval_id,
                    "messageId":      msg_id,
                    "conversationId": item.get("conversationId", ""),
                    "subject":        subject,
                    "sentAt":         sent_at,
                    "recipients":     recipients,
                    "ai_reason":      ai_reason,
                    "body":           (item.get("body") or "")[:5000],
                    "to":             item.get("to", []),
                    "createdAt":      datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
                }
                pending = tracking.get("pending_tracking_approvals", [])
                pending = [p for p in pending if p["messageId"] != msg_id]
                pending.append(approval_entry)
                tracking["pending_tracking_approvals"] = pending
                tracking["lastUpdated"] = (
                    datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                )
                save_tracking(tracking, user_email)
                log.info(
                    f"[tracking] Needs Review: '{subject}' "
                    f"→ {len(recipients)} recipient(s) [{ai_reason}]"
                )

            # ── Path A: thread replies — bypass AI ────────────────────────
            for item in reply_items:
                recipients = _build_recipients(item)
                if not recipients:
                    append_not_tracked(user_email, {
                        "messageId": item.get("messageId", ""),
                        "subject":   item.get("subject", "(no subject)"),
                        "sentAt":    item.get("sentAt", ""),
                        "to":        item.get("to", []), "cc": item.get("cc", []),
                        "reason":    "No trackable recipients (all excluded from tracking)",
                        "skippedAt": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
                        "body":      (item.get("body") or "")[:5000],
                    })
                    continue
                _queue_approval(item, recipients, "thread reply — bypass AI")

            # ── Path B: fresh + forward emails — AI decides ────────────────
            if fresh_items:
                log.info(f"[tracking] AI evaluating {len(fresh_items)} email(s)")
                decisions = await ai_tracking_decision(
                    fresh_items, sender_name=sender_display, sender_email=user_email
                )
                for item, decision in zip(fresh_items, decisions):
                    msg_id  = item.get("messageId", "")
                    subject = item.get("subject", "(no subject)")
                    sent_at = item.get("sentAt", "")

                    if not decision.get("should_track", True):
                        append_not_tracked(user_email, {
                            "messageId": msg_id, "subject": subject, "sentAt": sent_at,
                            "to":        item.get("to", []), "cc": item.get("cc", []),
                            "reason":    decision.get("reason", "Not tracked by AI"),
                            "skippedAt": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
                            "body":      (item.get("body") or "")[:5000],
                        })
                        log.info(f"[tracking] AI skipped '{subject}'")
                        tracking["tracked"]     = list(tracked_by_id.values())
                        tracking["lastUpdated"] = (
                            datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                        )
                        save_tracking(tracking, user_email)
                        continue

                    ai_track_set = {a.lower() for a in decision.get("recipients_to_track", [])}
                    recipients   = {}
                    all_addresses = list(dict.fromkeys(
                        (item.get("to") or []) + (item.get("cc") or [])
                    ))
                    for addr in all_addresses:
                        a = addr.lower()
                        if a in TRACKING_EXCLUDED:
                            continue
                        if ai_track_set and a not in ai_track_set:
                            continue
                        recipients[a] = {
                            "originalAddress":  addr,
                            "type":             "internal" if "hfmg.net" in a else "external",
                            "replied":          False,
                            "reminder1_sent":   False,
                            "reminder1_sentAt": None,
                            "reminder2_sent":   False,
                            "reminder2_sentAt": None,
                            "dismissed":        False,
                            "dismissedAt":      None,
                        }

                    if not recipients:
                        append_not_tracked(user_email, {
                            "messageId": msg_id, "subject": subject, "sentAt": sent_at,
                            "to":        item.get("to", []), "cc": item.get("cc", []),
                            "reason":    "AI chose to track, but no trackable recipients remained after exclusions",
                            "skippedAt": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
                            "body":      (item.get("body") or "")[:5000],
                        })
                        continue

                    _queue_approval(item, recipients, decision.get("reason", ""))

        # ── Pass 3: update reply status (safe — only when notRepliedAddresses is populated) ─
        for item in existing_items:
            msg_id  = item.get("messageId", "")
            not_rep = [a.lower() for a in (item.get("notRepliedAddresses") or [])]
            # Direct messageId match first (individual emails and exact thread parent).
            # Fall back to conversationId for follow-up replies sent within a tracked
            # thread — those have a different messageId but the same conversationId.
            existing = tracked_by_id.get(msg_id)
            if not existing:
                conv_id = item.get("conversationId", "")
                primary_msg_id = conv_to_tracked.get(conv_id)
                if primary_msg_id:
                    existing = tracked_by_id.get(primary_msg_id)
            if not existing:
                continue

            # SAFE rule: only update if the API returned at least one address in
            # notRepliedAddresses. An empty list means "no reply data available"
            # (e.g. forwarded emails, old emails outside the tracking window) —
            # treat as unknown, leave existing replied flags untouched.
            if not_rep:
                for addr, info in existing.get("recipients", {}).items():
                    if addr in not_rep:
                        info["replied"] = False
                    elif not info.get("replied"):
                        # Explicitly not in the not-replied list → has replied
                        info["replied"] = True

            # Auto-resolve if everyone replied or was dismissed
            recips = existing.get("recipients", {})
            if recips and all(i.get("replied") or i.get("dismissed") for i in recips.values()):
                existing["resolved"]   = True
                existing["resolvedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"

        # ── Pass 4: auto-send Day-1 and Day-3 reminders ─────────────────
        # Uses two separate if-blocks (NOT if/elif) so that when bdays >= 3
        # and Day-1 fires for the first time in this run, Day-3 can also fire
        # in the same run without waiting for the next scheduler cycle.
        async with _httpx.AsyncClient(timeout=30) as hc:
            for msg_id, tracked in tracked_by_id.items():
                if tracked.get("resolved"):
                    continue

                sent_at   = tracked.get("sentAt", "")
                subject   = tracked.get("subject", "(no subject)")
                orig_body = tracked.get("body", "")
                bdays     = get_business_days_since(sent_at)

                log.debug(
                    f"[tracking] Pass4: '{subject[:40]}' "
                    f"bdays={bdays} sentAt={sent_at!r}"
                )

                for addr, info in tracked.get("recipients", {}).items():
                    if info.get("replied") or info.get("dismissed"):
                        continue
                    if info.get("type") == "external":
                        continue  # externals: digest tab only

                    # ── Day-1: bdays >= 1 and Day-1 not yet sent ────────
                    if bdays >= 1 and not info.get("reminder1_sent"):
                        ok = await _send_reminder(
                            hc, addr, info, 1,
                            subject, sent_at, orig_body, sender_first, ORG
                        )
                        if ok:
                            log.info(f"[tracking] Day-1 sent → {addr} | '{subject}'")
                        else:
                            log.error(f"[tracking] Day-1 FAILED → {addr} | '{subject}'")

                    # ── Day-3: bdays >= 3, Day-1 confirmed sent, Day-3 not yet sent ─
                    # Separate if (not elif) so Day-3 can fire in the same run
                    # as Day-1 when the email is already >= 3 business days old.
                    if (bdays >= 3
                            and info.get("reminder1_sent")
                            and not info.get("reminder2_sent")):
                        ok = await _send_reminder(
                            hc, addr, info, 3,
                            subject, sent_at, orig_body, sender_first, ORG
                        )
                        if ok:
                            log.info(f"[tracking] Day-3 sent → {addr} | '{subject}'")
                        else:
                            log.error(f"[tracking] Day-3 FAILED → {addr} | '{subject}'")

        # ── Persist final state ───────────────────────────────────────────
        tracking["tracked"]              = list(tracked_by_id.values())
        tracking["lastUpdated"]          = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        tracking["reminder_message_ids"] = list(reminder_ids)
        save_tracking(tracking, user_email)

        pending_count = len(tracking.get("pending_tracking_approvals", []))
        log.info(
            f"[tracking] Scheduler done — {len(tracked_by_id)} tracked, "
            f"{pending_count} pending approval for {user_email}"
        )

    except Exception as e:
        import traceback
        log.error(f"[tracking] Scheduler exception: {e}\n{traceback.format_exc()}")


# ---------------------------------------------------------------------------
# Approval / dismiss actions
# ---------------------------------------------------------------------------

async def approve_tracking_decision(user_email: str, approval_id: str) -> dict:
    """
    Move a pending tracking decision to active tracking.
    Immediately fires Day-1 (and Day-3 if already overdue) without waiting
    for the next scheduler cycle.
    """
    import httpx as _httpx
    ORG = "http://172.22.6.188:177"

    tracking  = load_tracking(user_email)
    approvals = tracking.get("pending_tracking_approvals", [])
    entry     = next((a for a in approvals if a["id"] == approval_id), None)
    if not entry:
        return {"ok": False, "error": "Approval entry not found"}

    # Ensure sentAt is populated
    sent_at = entry.get("sentAt") or ""
    if not sent_at.strip():
        sent_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        log.warning(f"[tracking] approve: sentAt missing for '{entry.get('subject')}' — using now")

    tracked_list  = tracking.get("tracked", [])
    tracked_by_id = {t["messageId"]: t for t in tracked_list}
    msg_id        = entry["messageId"]

    new_record = {
        "messageId":      msg_id,
        "conversationId": entry.get("conversationId", ""),
        "subject":        entry["subject"],
        "sentAt":         sent_at,
        "recipients":     entry["recipients"],
        "body":           entry.get("body", ""),
        "ai_reason":      entry.get("ai_reason", ""),
        "resolved":       False,
        "resolvedAt":     None,
    }
    tracked_by_id[msg_id] = new_record
    tracking["tracked"]                    = list(tracked_by_id.values())
    tracking["pending_tracking_approvals"] = [a for a in approvals if a["id"] != approval_id]
    tracking["lastUpdated"]                = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    save_tracking(tracking, user_email)
    log.info(f"[tracking] Approved → now tracking '{entry['subject']}'")

    # Immediately fire reminders if already overdue
    bdays         = get_business_days_since(sent_at)
    subject       = entry["subject"]
    sender_first  = user_email.split("@")[0].split(".")[0].title()
    reminders_sent = []

    async with _httpx.AsyncClient(timeout=30) as hc:
        for addr, info in new_record.get("recipients", {}).items():
            if info.get("replied") or info.get("dismissed"):
                continue
            if info.get("type") == "external":
                continue

            # Day-1
            if bdays >= 1 and not info.get("reminder1_sent"):
                ok = await _send_reminder(
                    hc, addr, info, 1,
                    subject, sent_at, entry.get("body", ""), sender_first, ORG
                )
                if ok:
                    reminders_sent.append(f"{addr} (Day-1)")
                    log.info(f"[tracking] Immediate Day-1 → {addr}")

            # Day-3 (separate if — may fire same call as Day-1)
            if (bdays >= 3
                    and info.get("reminder1_sent")
                    and not info.get("reminder2_sent")):
                ok = await _send_reminder(
                    hc, addr, info, 3,
                    subject, sent_at, entry.get("body", ""), sender_first, ORG
                )
                if ok:
                    reminders_sent.append(f"{addr} (Day-3)")
                    log.info(f"[tracking] Immediate Day-3 → {addr}")

    if reminders_sent:
        tracking2 = load_tracking(user_email)
        for t in tracking2.get("tracked", []):
            if t["messageId"] == msg_id:
                t["recipients"] = new_record["recipients"]
                break
        save_tracking(tracking2, user_email)

    return {"ok": True, "subject": subject, "reminders_sent": reminders_sent}


def dismiss_tracking_decision(user_email: str, approval_id: str) -> dict:
    """Dismiss a pending tracking decision — moves it to the AI Skipped log."""
    tracking  = load_tracking(user_email)
    approvals = tracking.get("pending_tracking_approvals", [])
    entry     = next((a for a in approvals if a["id"] == approval_id), None)
    if not entry:
        return {"ok": False, "error": "Approval entry not found"}

    append_not_tracked(user_email, {
        "messageId": entry["messageId"],
        "subject":   entry["subject"],
        "sentAt":    entry["sentAt"],
        "to":        entry.get("to", []),
        "cc":        [],
        "reason":    f"Dismissed by user (AI: {entry.get('ai_reason','')})",
        "skippedAt": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
        "body":      entry.get("body", ""),
    })
    tracking["pending_tracking_approvals"] = [a for a in approvals if a["id"] != approval_id]
    tracking["lastUpdated"]               = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    save_tracking(tracking, user_email)
    log.info(f"[tracking] Dismissed tracking for '{entry['subject']}'")
    return {"ok": True}


def restore_skipped_to_tracking(user_email: str, message_id: str) -> dict:
    """Move an AI-skipped email from the skipped log back into active tracking."""
    skipped = load_not_tracked_log(user_email)
    entry   = next((e for e in skipped if e.get("messageId") == message_id), None)
    if not entry:
        return {"ok": False, "error": "Entry not found in skipped log"}

    recipients = {}
    for addr in (entry.get("to") or []):
        a = addr.lower()
        if a in TRACKING_EXCLUDED:
            continue
        recipients[a] = {
            "originalAddress": addr,
            "type":            "internal" if "hfmg.net" in a else "external",
            "replied":         False,
            "reminder1_sent":  False,
            "reminder1_sentAt": None,
            "reminder2_sent":  False,
            "reminder2_sentAt": None,
            "dismissed":       False,
            "dismissedAt":     None,
            "manuallyAdded":   True,
        }

    if not recipients:
        return {"ok": False, "error": "No trackable recipients (all excluded)"}

    tracking      = load_tracking(user_email)
    tracked_by_id = {t["messageId"]: t for t in tracking.get("tracked", [])}
    if message_id in tracked_by_id:
        return {"ok": False, "error": "Already being tracked"}

    tracked_by_id[message_id] = {
        "messageId":      message_id,
        "conversationId": entry.get("conversationId", ""),
        "subject":        entry.get("subject", "(no subject)"),
        "sentAt":         entry.get("sentAt", ""),
        "body":           entry.get("body", ""),
        "recipients":     recipients,
        "resolved":       False,
        "resolvedAt":     None,
        "ai_reason":      entry.get("reason", ""),
        "manuallyAdded":  True,
    }
    tracking["tracked"]     = list(tracked_by_id.values())
    tracking["lastUpdated"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    save_tracking(tracking, user_email)
    _save_not_tracked_log(
        [e for e in skipped if e.get("messageId") != message_id], user_email
    )
    log.info(f"[tracking] Restored '{entry.get('subject','')}' to tracking")
    return {"ok": True, "subject": entry.get("subject", "")}


# ---------------------------------------------------------------------------
# Kept for API compatibility — pending_reminders queue is retired.
# Day-1 and Day-3 now fire automatically from the scheduler.
# These stubs return ok=True so existing frontend calls don't break.
# ---------------------------------------------------------------------------

async def approve_pending_reminder(user_email: str, reminder_id: str, body: str) -> dict:
    log.info(f"[tracking] approve_pending_reminder called (retired) reminder_id={reminder_id}")
    return {"ok": True, "note": "Reminders are now sent automatically by the scheduler."}

def dismiss_pending_reminder(user_email: str, reminder_id: str) -> dict:
    log.info(f"[tracking] dismiss_pending_reminder called (retired) reminder_id={reminder_id}")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Recipient dismiss
# ---------------------------------------------------------------------------

def dismiss_tracking_recipient(user_email: str, message_id: str, recipient_email: str) -> bool:
    """Mark a specific recipient as handled offline."""
    tracking = load_tracking(user_email)
    for item in tracking.get("tracked", []):
        if item["messageId"] == message_id:
            addr = recipient_email.lower()
            recips = item.get("recipients", {})
            if addr in recips:
                recips[addr]["dismissed"]   = True
                recips[addr]["dismissedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                # Auto-resolve when everyone is done
                if all(i.get("replied") or i.get("dismissed") for i in recips.values()):
                    item["resolved"]   = True
                    item["resolvedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                save_tracking(tracking, user_email)
                return True
    return False


# ---------------------------------------------------------------------------
# EWS reply sync — called on every GET /api/tracking load
# ---------------------------------------------------------------------------

def sync_replies_from_ews(user_email: str, ews_sent_items: list) -> int:
    """
    Cross-reference the tracking JSON with live EWS sent-item reply data.

    Called on every GET /api/tracking load so Active Tracking is always
    current without waiting for the 2-hour background scheduler.

    Logic:
      - Build a lookup: messageId → set of notRepliedAddresses (lowercased)
      - For each tracked (unresolved) item that appears in the EWS window:
          if a recipient's address is NOT in notRepliedAddresses → they replied
      - Auto-resolves items where every recipient has replied or been dismissed

    Only touches emails within the 7-day EWS window; older tracked emails
    are left untouched (the scheduler handles those via its own EWS call).

    Returns the count of recipients newly marked as replied.
    """
    if not ews_sent_items:
        return 0

    # Build lookup: messageId → set of addresses still awaiting reply
    # .NET DTO uses camelCase (messageId) by default; handle PascalCase too.
    ews_lookup: dict = {}
    for item in ews_sent_items:
        mid = item.get("messageId") or item.get("id") or item.get("MessageId")
        if not mid:
            continue
        not_replied = {a.lower() for a in (item.get("notRepliedAddresses") or [])}
        ews_lookup[mid] = not_replied

    if not ews_lookup:
        return 0

    tracking = load_tracking(user_email)
    updated  = 0
    changed  = False

    for item in tracking.get("tracked", []):
        if item.get("resolved"):
            continue
        mid = item.get("messageId")
        if mid not in ews_lookup:
            # Email not in EWS 7-day window — skip, scheduler handles it
            continue

        not_replied_set = ews_lookup[mid]
        recipients      = item.get("recipients", {})

        for addr, info in recipients.items():
            if info.get("replied") or info.get("dismissed"):
                continue
            # Address absent from notRepliedAddresses → EWS confirmed they replied
            if addr not in not_replied_set:
                info["replied"]   = True
                info["repliedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                updated += 1
                changed  = True
                log.info(
                    f"[tracking/ews-sync] {addr} → replied (EWS) | '{item.get('subject', '')}'"
                )

        # Auto-resolve when every recipient is done
        if recipients and all(
            i.get("replied") or i.get("dismissed") for i in recipients.values()
        ):
            if not item.get("resolved"):
                item["resolved"]   = True
                item["resolvedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                changed = True
                log.info(
                    f"[tracking/ews-sync] Auto-resolved '{item.get('subject', '')}'"
                )

    if changed:
        tracking["lastUpdated"] = (
            datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        )
        save_tracking(tracking, user_email)

    return updated


# ---------------------------------------------------------------------------
# Summary / digest queries
# ---------------------------------------------------------------------------

def get_tracking_summary(user_email: str) -> dict:
    """
    Returns tracked emails split into awaiting / reminders_sent / resolved
    for the Tracking tab main view.
    """
    tracking       = load_tracking(user_email)
    awaiting       = []
    reminders_sent = []
    resolved       = []

    for item in tracking.get("tracked", []):
        bdays = get_business_days_since(item.get("sentAt", ""))
        base  = {
            "messageId":    item["messageId"],
            "subject":      item["subject"],
            "sentAt":       item["sentAt"],
            "businessDays": bdays,
            "recipients":   item.get("recipients", {}),
            "body":         item.get("body", ""),  # stored at track-add time; used as fallback in email modal
        }
        if item.get("resolved"):
            resolved.append(base)
        elif any(
            i.get("reminder1_sent") or i.get("reminder2_sent")
            for i in item.get("recipients", {}).values()
        ):
            reminders_sent.append(base)
        else:
            awaiting.append(base)

    return {
        "awaiting":       sorted(awaiting,       key=lambda x: x["businessDays"], reverse=True),
        "reminders_sent": sorted(reminders_sent, key=lambda x: x["businessDays"], reverse=True),
        "resolved":       sorted(resolved,       key=lambda x: x["businessDays"], reverse=True)[:20],
        "lastUpdated":    tracking.get("lastUpdated"),
    }


def get_tracking_digest(user_email: str) -> list:
    """
    Returns Day-5+ outstanding items for the digest panel.
    Both internal and external non-repliers appear here.
    """
    tracking = load_tracking(user_email)
    digest   = []
    for item in tracking.get("tracked", []):
        if item.get("resolved"):
            continue
        bdays = get_business_days_since(item.get("sentAt", ""))
        if bdays < 5:
            continue
        pending = [
            {
                "email":           addr,
                "originalAddress": info.get("originalAddress", addr),
                "type":            info.get("type", "internal"),
                "reminder1_sent":  info.get("reminder1_sent", False),
                "reminder2_sent":  info.get("reminder2_sent", False),
                "businessDays":    bdays,
            }
            for addr, info in item.get("recipients", {}).items()
            if not info.get("replied") and not info.get("dismissed")
        ]
        if pending:
            digest.append({
                "messageId":         item["messageId"],
                "subject":           item["subject"],
                "sentAt":            item["sentAt"],
                "businessDays":      bdays,
                "pendingRecipients": pending,
            })
    return sorted(digest, key=lambda x: x["businessDays"], reverse=True)


# ══════════════════════════════════════════════════════════════════════════════


def get_attachment_bytes(attachment):
    """Legacy helper — kept for compatibility but not used in API flow."""
    file_name = attachment["name"]
    file_hash = attachment["hash"]
    file_bytes = base64.b64decode(file_hash)
    return file_name, file_bytes