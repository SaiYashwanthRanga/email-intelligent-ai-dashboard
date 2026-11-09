import os
import json
import re
import time
import uuid
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

import email_classifier as ec


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
    # Stored bodies are capped at 5000 chars, which can sever a tag and leave a
    # dangling "<div style=..." with no closing bracket for the rule above to
    # match. Requires a letter or slash after the "<" so ordinary prose like
    # "value < 5" at the end of a message survives. Must stay BEFORE unescape:
    # afterwards, quoted addresses such as &lt;a@b.net&gt; become <a@b.net> and
    # would be eaten as if they were markup.
    text = re.sub(r"<[a-zA-Z/][^>]*$", " ", text)
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
   - Defined below under "NEWSLETTER RULES". Apply it exactly; it is the only definition.

8. NORMAL
   - Everything else including: routine contract updates, employment paperwork status, weekly reports, operational counts, vendor analytics

CONFIDENTIAL vs URGENT — if an email has a hard deadline AND contains sensitive content, choose URGENT. Deadline beats confidentiality.

GOLDEN RULE — READ FIRST:
Any email that is ONLY sharing information, counts, or reports (e.g. inactive insurance counts,
denial reports, productivity summaries, patient lists, weekly stats) must be classified as NORMAL.
These are NEVER URGENT and NEVER CONFIDENTIAL, no matter how large the numbers are.
URGENT and CONFIDENTIAL require an explicit action, decision, or same-day deadline.

{NEWSLETTER_RULES}

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
CLASSIFICATION_PROMPT = CLASSIFICATION_PROMPT.replace("{NEWSLETTER_RULES}", ec.NEWSLETTER_RULES)

# 1. SETUP AI CLIENT
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
ACTIVE_MODEL = "gpt-4o-mini"

if not api_key:
    log.critical("OPENAI_API_KEY is missing from .env file!")

client = AsyncOpenAI(api_key=api_key)

# --- CONFIGURATION: ORG MAIL SERVER ------------------------------------------
# One source of truth for the .NET mail server, overridable via env (main.py
# reads the same ORG_BASE variable) so both modules talk to the same server.
ORG_BASE = os.getenv("ORG_BASE", "http://172.22.6.188:177").rstrip("/")

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

# NEWSLETTER_NEVER_DOMAINS / TRANSACTIONAL_SIGNALS and all newsletter detection
# live in email_classifier.py (single source of truth, unit-tested).

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

        # RFC 5322 headers (List-Unsubscribe, List-Id, Precedence, ...), if the
        # mail server exposes them. Not every deployment does; email_classifier
        # works without them and gets much more certain when they are present.
        "headers": (e.get("headers") or e.get("internetMessageHeaders")
                    or e.get("InternetMessageHeaders") or None),
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

# Categories the AI assigns purely from content — no sender list/folder
# backs these (unlike VIP/LEGAL/PRIORITY/PROVIDERS), so Admin > Tags can
# surface them read-only as "AI tags" by just counting the category field
# already on each cached email. Read-only: this never writes a category.
AI_ONLY_CATEGORIES = ["URGENT", "CONFIDENTIAL", "MEETING", "ZOOM", "NEWSLETTER", "NORMAL"]

def get_ai_category_summary(user_email: str) -> dict:
    """{ CATEGORY: count } for each of AI_ONLY_CATEGORIES, from cached emails."""
    cached = get_cached_emails_by_id(user_email) or {}
    counts = {cat: 0 for cat in AI_ONLY_CATEGORIES}
    for entry in cached.values():
        if not isinstance(entry, dict) or entry.get("_threadRef"):
            continue
        cat = (entry.get("category") or "").upper()
        if cat in counts:
            counts[cat] += 1
    return counts

def _cached_entry_to_row(entry: dict) -> dict:
    return {
        "messageId": entry.get("id") or entry.get("messageId"),
        "conversationId": entry.get("conversationId"),
        "from": entry.get("from") or entry.get("sender") or "Unknown Sender",
        "subject": entry.get("subject") or "No Subject",
        "category": entry.get("category") or "NORMAL",
        "summary": entry.get("summary") or "",
        "received_at": entry.get("received_at") or entry.get("received"),
    }

def get_emails_by_category(user_email: str, category: str, limit: int = 50) -> list:
    """Read-only lookup for the Admin > Tags 'AI tags' drill-down."""
    cached = get_cached_emails_by_id(user_email) or {}
    category = (category or "").upper()
    rows = [
        _cached_entry_to_row(e) for e in cached.values()
        if isinstance(e, dict) and not e.get("_threadRef") and (e.get("category") or "").upper() == category
    ]
    rows.sort(key=lambda r: str(r.get("received_at") or ""), reverse=True)
    return rows[:limit]

def get_emails_by_ids(user_email: str, message_ids: list) -> list:
    """Read-only lookup for a custom tag's matched-emails drill-down."""
    cached = get_cached_emails_by_id(user_email) or {}
    wanted = set(message_ids or [])
    rows = [
        _cached_entry_to_row(e) for e in cached.values()
        if isinstance(e, dict) and (e.get("id") or e.get("messageId")) in wanted
    ]
    rows.sort(key=lambda r: str(r.get("received_at") or ""), reverse=True)
    return rows

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
    skipped = 0
    for e in emails:
        eid = e.get("id") or e.get("messageId")
        # Never persist a failed analysis. This cache is consulted before the
        # AI runs, so caching a failure makes it permanent: the email becomes
        # a cache hit and shows "Pending analysis" forever, even though the
        # next sync could have summarised it fine. Leaving it out costs one
        # re-analysis and fixes itself.
        if e.get("_analysisFailed"):
            skipped += 1
            continue
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
            entry.pop("headers", None)   # classification input only; can be large
            if entry.get("messages"):
                entry["messages"] = [
                    {k: v for k, v in m.items() if k != "body"}
                    for m in entry["messages"]
                ]

            existing[eid] = entry
    if skipped:
        log.error(f"[cache] not caching {skipped} failed analyses for {user_email} — they will be retried next sync")
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


# Categories the model may return. ZOOM/LEGAL/VIP are assigned from sender and
# link evidence, never trusted from the model; anything outside the set (a typo,
# an invented label, "Promotional") becomes NORMAL instead of a phantom category.
SINGLE_AI_CATEGORIES = ("VIP", "PRIORITY", "URGENT", "CONFIDENTIAL", "MEETING",
                        "ZOOM", "NEWSLETTER", "NORMAL")
BATCH_AI_CATEGORIES = SINGLE_AI_CATEGORIES
THREAD_AI_CATEGORIES = ("URGENT", "MEETING", "CONFIDENTIAL", "NEWSLETTER", "NORMAL", "ZOOM")


def _is_listed_sender(email: dict) -> bool:
    """VIP/LEGAL/PRIORITY/PROVIDERS senders are never auto-filed as newsletters."""
    sender = extract_sender_email(email.get("from") or "")
    return (sender in VIP_SENDERS or sender in PRIORITY_SENDERS
            or sender in PROVIDERS_SENDERS or sender in LEGAL_SENDERS
            or any(sender.endswith("@" + d) for d in LEGAL_DOMAINS))


# --- AI CORE FUNCTIONS ---

async def analyze_single_email(email):
    if email.get("category") and email.get("summary"):
        return email

    body = email.get("body", "")
    subject = clean_subject(email.get("subject", "No Subject"))

    # Evidence is computed from the FULL body (footers included) and handed to
    # the model below, which only ever sees a truncated copy.
    decision = ec.decide(email)

    # ── Newsletter fast-path: skip AI entirely ──────────────────────────────
    # Only when the evidence is conclusive (mailing-list/marketing-platform
    # proof plus no counter-evidence). Anything weaker goes to the model WITH
    # the evidence, so a newsletter with an odd footer is still found and a
    # transactional mail with an unsubscribe link is not.
    if decision.certain == "NEWSLETTER" and not _is_listed_sender(email):
        email["category"] = "NEWSLETTER"
        email["priority"] = 1
        email["action"]   = "READ"
        email["summary"]  = ec.newsletter_stub_summary(email.get("from"), subject)
        return email
    # ────────────────────────────────────────────────────────────────────────

    evidence = json.dumps(ec.prompt_fields(decision))
    prompt = f"""
Subject: {subject}
From: {email.get('from')}
Classifier evidence (facts computed from the full message): {evidence}
Body:{body}{CLASSIFICATION_PROMPT}{_get_correction_block()}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            temperature=0,   # same email must get the same category every time
            messages=[
                {"role": "system", "content": "Output JSON only."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )

        result = json.loads(response.choices[0].message.content)
        result["category"] = ec.guard(
            ec.normalise_category(result.get("category"), SINGLE_AI_CATEGORIES), decision)

        sender = extract_sender_email(email.get("from") or "")
        body_text = (email.get("body") or "").lower()
        subject_text = (email.get("subject") or "").lower()
        # A conclusive newsletter that merely links a Zoom webinar is still a
        # newsletter; the prompt has always said so, the code now agrees.
        has_zoom = ("zoom.us" in body_text or "zoom.us" in subject_text)             and decision.certain != "NEWSLETTER"

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
        email["_analysisFailed"] = True   # not a result — never cache it
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

    # One evidence assessment per email, reused for the fast-path, the prompt
    # and the post-AI guard. Keyed by object identity: emails have no
    # guaranteed-unique id here (thread results, id-less mail).
    decisions = {}

    for email in emails:
        sender = extract_sender_email(email.get("from") or "")
        body_text = (email.get("body") or "").lower()
        subject_text = (email.get("subject") or "").lower()
        decision = decisions[id(email)] = ec.decide(email)
        # A conclusive newsletter that merely links a Zoom webinar stays a
        # newsletter (the prompt always said so; the code used to disagree).
        has_zoom = ("zoom.us" in body_text or "zoom.us" in subject_text)             and decision.certain != "NEWSLETTER"

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
        elif decision.certain == "NEWSLETTER":
            # Newsletter fast-path: conclusive evidence only (see email_classifier)
            email["category"] = "NEWSLETTER"
            email["priority"] = 1
            email["action"]   = "READ"
            email["summary"]  = ec.newsletter_stub_summary(
                email.get("from"), clean_subject(email.get("subject", "No Subject")))
            pre_classified.append(email)
        else:
            needs_ai.append(email)

    if not needs_ai:
        return pre_classified

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
                # Facts computed from the FULL body (the preview is only the
                # first 800 characters, so footers never reach the model).
                **ec.prompt_fields(decisions[id(e)]),
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
- NEWSLETTER: see NEWSLETTER RULES below.
- NORMAL: routine contract updates, employment paperwork, operational counts, vendor analytics, FYIs

{ec.NEWSLETTER_RULES}
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
            # Retry transient failures (rate limits, timeouts, blips) before
            # giving up on the whole chunk. One hiccup used to mark 20 emails
            # "Pending analysis", and because that result was cached they were
            # never looked at again.
            last_err = None
            response = None
            for attempt in range(3):
                try:
                    response = await client.chat.completions.create(
                        model=ACTIVE_MODEL,
                        temperature=0,   # same email must get the same category every time
                        messages=[
                            {"role": "system", "content": "Output JSON only."},
                            {"role": "user", "content": chunk_prompt}
                        ],
                        response_format={"type": "json_object"}
                    )
                    break
                except Exception as api_err:
                    last_err = api_err
                    if attempt < 2:
                        wait = 2 ** attempt          # 1s, then 2s
                        log.warning(f"Batch chunk attempt {attempt + 1} failed ({type(api_err).__name__}), retrying in {wait}s")
                        await asyncio.sleep(wait)
            if response is None:
                raise last_err

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
                    ai_category = ec.guard(
                        ec.normalise_category(ai.get("category"), BATCH_AI_CATEGORIES),
                        decisions.get(id(email)))
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
            # log.error, not warning: this leaves a whole chunk of mail without
            # a summary, and the app runs at errors-only log level.
            log.error(f"Batch chunk failed after retries ({len(chunk_emails)} emails): {ex}")
            for email in chunk_emails:
                email["category"] = "NORMAL"
                email["summary"] = "Pending analysis"
                # Marks this as a failure, not a result. save_emails_to_id_cache
                # refuses to persist it, so the email is retried on the next
                # sync instead of being a permanent cache hit showing
                # "Pending analysis" forever.
                email["_analysisFailed"] = True
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
       {ec.NEWSLETTER_RULES}
       A thread with replies between people is a conversation, not a NEWSLETTER.
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
            temperature=0,   # same thread must get the same category every time
            messages=[{"role": "system", "content": "Output JSON only."}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        result = json.loads(response.choices[0].message.content)
        result["category"] = ec.normalise_category(result.get("category"), THREAD_AI_CATEGORIES)

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


def _meeting_brief_items(meetings: list) -> list:
    """Shared item-shaping for both the paragraph brief and the bullet list."""
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
    return items


async def generate_calendar_bullets(meetings: list, date_label: str) -> list:
    """
    Short AI bullet points summarising a day's meetings — for a compact
    display (the header's today's-meetings dropdown) where a full paragraph
    (generate_day_brief_summary, used by the Calendar page) is too much.
    """
    if not meetings:
        return []

    items = _meeting_brief_items(meetings)

    prompt = (
        f"You are an executive assistant preparing a quick-glance briefing for {date_label}.\n\n"
        f"Meetings:\n{json.dumps(items, indent=2)}\n\n"
        "Write at most 4 short bullet points (each under 12 words) covering what "
        "actually matters about today's schedule — notable meetings, back-to-back "
        "blocks, cancellations, or how light/heavy the day is overall. Skip "
        "routine, unremarkable meetings rather than listing every single one.\n"
        'Respond with JSON only: {"bullets": ["...", "..."]}'
    )

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_completion_tokens=220,
        )
        result = json.loads(response.choices[0].message.content or "{}")
        bullets = result.get("bullets") or []
        return [str(b).strip() for b in bullets if str(b).strip()][:5]
    except Exception as ex:
        log.error(f"generate_calendar_bullets failed: {ex}")
        return []


# ── Calendar bullets cache ──────────────────────────────────────────────────
# Persisted per user so reopening the dropdown doesn't re-call the model
# every time — only when the day changes or the schedule itself does
# (a meeting added, moved, or cancelled).

def _calendar_bullets_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"calendar_bullets_{safe}.json"

def _meetings_signature(meetings: list) -> str:
    """Cheap, deterministic fingerprint of a meeting list (no hash() — its
    salt varies per process, which would invalidate the cache on every
    server restart even when the schedule hasn't changed)."""
    parts = sorted(f"{m.get('start','')}|{m.get('subject','')}|{bool(m.get('isCancelled'))}" for m in meetings)
    joined = "||".join(parts)
    return f"{len(meetings)}:{len(joined)}:{joined[:200]}"

def load_calendar_bullets(user_email: str, date_key: str, signature: str):
    path = _calendar_bullets_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
            if data.get("date") == date_key and data.get("signature") == signature:
                return data.get("bullets")
        except Exception as e:
            log.error(f"load_calendar_bullets error: {e}")
    return None

def save_calendar_bullets(user_email: str, date_key: str, signature: str, bullets: list):
    with open(_calendar_bullets_file_for(user_email), "w") as f:
        json.dump({"date": date_key, "signature": signature, "bullets": bullets}, f, indent=2)

async def get_or_generate_calendar_bullets(user_email: str, date_key: str, meetings: list, date_label: str) -> list:
    """Public entry point: cache-check, generate on miss, save, return. Keeps
    the signature scheme and file format as services.py's own concern —
    main.py just calls this one function."""
    signature = _meetings_signature(meetings)
    cached = load_calendar_bullets(user_email, date_key, signature)
    if cached is not None:
        return cached
    bullets = await generate_calendar_bullets(meetings, date_label)
    save_calendar_bullets(user_email, date_key, signature, bullets)
    return bullets


# ── Per-thread context notes ────────────────────────────────────────────────
# A free-text note the person writes on a specific thread ("what happened"),
# read back later both in the reading pane and by Iris. Keyed by
# conversationId when available, falling back to messageId for singletons,
# so a note
# written from any message in a thread surfaces no matter which message of
# that thread is opened next time.

def _thread_notes_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"thread_notes_{safe}.json"

_thread_notes_locks: dict = {}
_thread_notes_locks_mutex = threading.Lock()

def _get_thread_notes_lock(user_email: str) -> threading.Lock:
    with _thread_notes_locks_mutex:
        if user_email not in _thread_notes_locks:
            _thread_notes_locks[user_email] = threading.Lock()
        return _thread_notes_locks[user_email]

def load_thread_notes(user_email: str) -> dict:
    """Load this user's {threadKey: {note, updatedAt}} store from disk."""
    path = _thread_notes_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception as e:
            log.error(f"load_thread_notes error: {e}")
    return {}

def get_thread_note(user_email: str, thread_key: str):
    """The saved note text for one thread, or None if it has none."""
    if not thread_key:
        return None
    entry = load_thread_notes(user_email).get(thread_key)
    return entry.get("note") if entry else None

def save_thread_note(user_email: str, thread_key: str, note: str):
    """
    Upsert (or, on a blank note, clear) one thread's note. Returns the
    stored updatedAt timestamp, or None when the note was cleared.
    """
    if not thread_key:
        return None
    note = (note or "").strip()
    with _get_thread_notes_lock(user_email):
        notes = load_thread_notes(user_email)
        updated_at = None
        if note:
            updated_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
            notes[thread_key] = {"note": note, "updatedAt": updated_at}
        else:
            notes.pop(thread_key, None)
        path = _thread_notes_file_for(user_email)
        with open(path, "w") as f:
            json.dump(notes, f, indent=2, default=str)
    return updated_at


# ── Send settings ────────────────────────────────────────────────────────
# Per-user compose/send preferences. Starts with just the undo-send window
# (Admin > Sending); nudge auto-send and voice settings land here later.

def _send_settings_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"send_settings_{safe}.json"

def load_send_settings(user_email: str) -> dict:
    path = _send_settings_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception as e:
            log.error(f"load_send_settings error: {e}")
    return {"undoWindowSeconds": 0}

def save_send_settings(user_email: str, undo_window_seconds) -> int:
    """Clamped to [0, 30] to match the Admin UI's stated max. Returns the stored value."""
    try:
        seconds = int(undo_window_seconds)
    except (TypeError, ValueError):
        seconds = 0
    seconds = max(0, min(30, seconds))
    with open(_send_settings_file_for(user_email), "w") as f:
        json.dump({"undoWindowSeconds": seconds}, f, indent=2)
    return seconds


# ── Signatures ───────────────────────────────────────────────────────────
# Per-user compose signatures (Admin > Signatures), Outlook-style: a named
# signature is just {id, name, body} (body is rich HTML from the same
# contentEditable editor the composer itself uses), and there are two
# independent default slots — one for new messages, one for replies and
# forwards — rather than a single "the" default. Both slots may point at
# the same signature, different ones, or nothing.

def _signatures_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"signatures_{safe}.json"

def load_signature_settings(user_email: str) -> dict:
    """{ signatures: [{id, name, body}], defaultNewId, defaultReplyId }"""
    path = _signatures_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                data = json.load(f)
            if isinstance(data, list):
                # Migrate the earlier single-isDefault-flag shape.
                default_id = next((s.get("id") for s in data if s.get("isDefault")), None)
                return {
                    "signatures": [{"id": s.get("id"), "name": s.get("name", ""), "body": s.get("body", "")} for s in data],
                    "defaultNewId": default_id,
                    "defaultReplyId": default_id,
                }
            return {
                "signatures": data.get("signatures", []),
                "defaultNewId": data.get("defaultNewId"),
                "defaultReplyId": data.get("defaultReplyId"),
            }
        except Exception as e:
            log.error(f"load_signature_settings error: {e}")
    return {"signatures": [], "defaultNewId": None, "defaultReplyId": None}

def _save_signature_settings(user_email: str, settings: dict):
    with open(_signatures_file_for(user_email), "w") as f:
        json.dump(settings, f, indent=2, default=str)

def create_signature(user_email: str, name: str) -> dict:
    settings = load_signature_settings(user_email)
    new_sig = {"id": uuid.uuid4().hex[:12], "name": (name or "").strip() or "Untitled", "body": ""}
    settings["signatures"].append(new_sig)
    # The very first signature ever created becomes the default for both
    # slots — otherwise a brand-new account's composer would insert nothing.
    if len(settings["signatures"]) == 1:
        settings["defaultNewId"] = new_sig["id"]
        settings["defaultReplyId"] = new_sig["id"]
    _save_signature_settings(user_email, settings)
    return new_sig

def update_signature(user_email: str, sig_id: str, updates: dict):
    settings = load_signature_settings(user_email)
    target = next((s for s in settings["signatures"] if s.get("id") == sig_id), None)
    if not target:
        return None
    if "name" in updates:
        target["name"] = (updates["name"] or "").strip() or target["name"]
    if "body" in updates:
        target["body"] = updates["body"] or ""
    _save_signature_settings(user_email, settings)
    return target

def delete_signature(user_email: str, sig_id: str) -> bool:
    settings = load_signature_settings(user_email)
    remaining = [s for s in settings["signatures"] if s.get("id") != sig_id]
    if len(remaining) == len(settings["signatures"]):
        return False
    settings["signatures"] = remaining
    # Clear (or promote a replacement into) any default slot that pointed
    # at the signature just deleted, so the composer never references a
    # signature that no longer exists.
    fallback = remaining[0]["id"] if remaining else None
    if settings.get("defaultNewId") == sig_id:
        settings["defaultNewId"] = fallback
    if settings.get("defaultReplyId") == sig_id:
        settings["defaultReplyId"] = fallback
    _save_signature_settings(user_email, settings)
    return True

_UNSET = object()

def set_default_signatures(user_email: str, default_new_id=_UNSET, default_reply_id=_UNSET) -> dict:
    """Pass None for a slot to clear it; omit a param entirely to leave that slot untouched."""
    settings = load_signature_settings(user_email)
    valid_ids = {s["id"] for s in settings["signatures"]}
    if default_new_id is not _UNSET and (default_new_id is None or default_new_id in valid_ids):
        settings["defaultNewId"] = default_new_id
    if default_reply_id is not _UNSET and (default_reply_id is None or default_reply_id in valid_ids):
        settings["defaultReplyId"] = default_reply_id
    _save_signature_settings(user_email, settings)
    return settings

# ── Custom tags ──────────────────────────────────────────────────────────
# Admin > Tags. A tag is a user-authored semantic label with a plain-
# language prompt ("what does this tag mean") that the AI matches emails
# against on demand — deliberately separate from CATEGORY_META and the
# analyze_emails_batch() classification pipeline above, which this never
# reads or writes. A tag only ever gains matched emails through an explicit
# scan-then-approve flow (iris_service.preview_tag_matches), never
# automatically, so there is no ongoing per-email AI cost and nothing here
# changes what category an email is stamped with.

def _tags_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"tags_{safe}.json"

def load_tags(user_email: str) -> list:
    """[{id, name, prompt, status: 'draft'|'active', matchedIds: [], createdAt, updatedAt}]"""
    path = _tags_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception as e:
            log.error(f"load_tags error: {e}")
    return []

def _save_tags(user_email: str, tags: list):
    with open(_tags_file_for(user_email), "w") as f:
        json.dump(tags, f, indent=2, default=str)

def create_tag(user_email: str, name: str, prompt: str) -> dict:
    tags = load_tags(user_email)
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    new_tag = {
        "id": uuid.uuid4().hex[:12],
        "name": (name or "").strip() or "Untitled tag",
        "prompt": (prompt or "").strip(),
        "status": "draft",
        "matchedIds": [],
        "createdAt": now,
        "updatedAt": now,
    }
    tags.append(new_tag)
    _save_tags(user_email, tags)
    return new_tag

def update_tag(user_email: str, tag_id: str, updates: dict):
    tags = load_tags(user_email)
    target = next((t for t in tags if t.get("id") == tag_id), None)
    if not target:
        return None
    if "name" in updates:
        target["name"] = (updates["name"] or "").strip() or target["name"]
    if "prompt" in updates:
        target["prompt"] = (updates["prompt"] or "").strip()
        # The prompt changed — any previously-approved matches were scanned
        # against the OLD meaning, so they'd misrepresent what this tag
        # means now. Back to draft until it's rescanned and reapproved.
        target["status"] = "draft"
        target["matchedIds"] = []
    target["updatedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    _save_tags(user_email, tags)
    return target

def delete_tag(user_email: str, tag_id: str) -> bool:
    tags = load_tags(user_email)
    remaining = [t for t in tags if t.get("id") != tag_id]
    if len(remaining) == len(tags):
        return False
    _save_tags(user_email, remaining)
    return True

def approve_tag_matches(user_email: str, tag_id: str, matched_ids: list) -> dict:
    """Commits a previewed scan's results — the only way a tag's matchedIds ever changes."""
    tags = load_tags(user_email)
    target = next((t for t in tags if t.get("id") == tag_id), None)
    if not target:
        return None
    target["status"] = "active"
    target["matchedIds"] = list(dict.fromkeys(matched_ids or []))  # de-dup, preserve order
    target["updatedAt"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    _save_tags(user_email, tags)
    return target


def get_attachment_bytes(attachment):
    """Legacy helper — kept for compatibility but not used in API flow."""
    file_name = attachment["name"]
    file_hash = attachment["hash"]
    file_bytes = base64.b64decode(file_hash)
    return file_name, file_bytes

# ── OUTBOX — actions taken while the mail server was unreachable ────────────
# Persisted to disk, not memory: the whole point is surviving the window
# where things are broken, and a backend restart during an outage is exactly
# when that happens.
#
# Two classes of action, deliberately treated differently:
#   auto  — mark read, RSVP. Replaying these twice is harmless (read twice is
#           read), so they replay by themselves the moment the server returns.
#   held  — reply, forward, send. NOT safe to fire unattended: the content
#           ages, the person may have already answered another way, and a
#           timeout leaves it genuinely unknown whether it went. These wait
#           for an explicit press.
OUTBOX_AUTO_ACTIONS = {"mark_read", "rsvp"}
OUTBOX_HELD_ACTIONS = {"send_reply", "forward", "send_email", "compose"}
OUTBOX_MAX_ATTEMPTS = 5


def _outbox_file_for(user_email: str) -> str:
    safe = _re.sub(r"[^\w@.-]", "_", (user_email or "default").lower().strip())
    return f"outbox_{safe}.json"


def load_outbox(user_email: str) -> list:
    path = _outbox_file_for(user_email)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        log.error(f"[outbox] unreadable for {user_email}: {e}")
        return []


def _save_outbox(user_email: str, items: list):
    path = _outbox_file_for(user_email)
    tmp = f"{path}.tmp"
    with _get_lock(f"outbox:{user_email}"):
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2)
        os.replace(tmp, path)   # write-then-rename: never leave it half-written


def queue_action(user_email: str, action: str, payload: dict) -> dict:
    """
    Put an action in the outbox. Returns the stored item.

    The id is what makes replay safe: the server refuses to carry out the
    same id twice, so a retry after an ambiguous timeout can't repeat it.
    """
    items = load_outbox(user_email)
    item = {
        "id": f"{action}-{uuid.uuid4().hex[:16]}",
        "action": action,
        "payload": payload or {},
        "queuedAt": datetime.now(timezone.utc).isoformat(),
        "attempts": 0,
        "lastError": None,
        # Held items are surfaced to the person; auto items just replay.
        "needsConfirm": action in OUTBOX_HELD_ACTIONS,
    }
    items.append(item)
    _save_outbox(user_email, items)
    log.info(f"[outbox] queued {action} for {user_email} ({item['id']})")
    return item


def remove_from_outbox(user_email: str, item_id: str) -> bool:
    items = load_outbox(user_email)
    kept = [i for i in items if i.get("id") != item_id]
    if len(kept) == len(items):
        return False
    _save_outbox(user_email, kept)
    return True


def update_outbox_item(user_email: str, item_id: str, **fields):
    items = load_outbox(user_email)
    for i in items:
        if i.get("id") == item_id:
            i.update(fields)
            break
    _save_outbox(user_email, items)


def outbox_summary(user_email: str) -> dict:
    items = load_outbox(user_email)
    return {
        "pending_auto": len([i for i in items if not i.get("needsConfirm")]),
        "awaiting_send": len([i for i in items if i.get("needsConfirm")]),
        "items": items,
    }
