import os
import json
import re
import asyncio
import hashlib
import html
import base64
import threading
from collections import defaultdict, Counter
from datetime import datetime
from openai import AsyncOpenAI
from dotenv import load_dotenv


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


def is_newsletter_body(body: str, sender: str = "") -> bool:
    """Detect newsletter/marketing emails by body signals.
    Requires 2+ signals for internal senders, 1+ for external.
    This prevents productivity/ops emails with a single footer
    signal from being wrongly classified as NEWSLETTER.
    """
    if not body:
        return False
    body_lower = body.lower()
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
    is_internal = sender and "hfmg.net" in sender.lower()
    # Internal senders need 2+ signals (real internal newsletters have multiple)
    # External senders need only 1 signal
    return matched >= 2 if is_internal else matched >= 1


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
   - Has a concrete deadline of TODAY or TOMORROW
   - Outages, system-down incidents, patient safety issues, escalations requiring same-day action
   - URGENT RULE: A deadline alone makes something URGENT. "Internal review only" or "confidential" language does NOT override a hard deadline.
   - NOT URGENT: routine operational counts or reports (e.g. inactive insurance counts, weekly denial reports) even if numbers are high

4. CONFIDENTIAL
   - ONLY: emails requiring a DECISION or APPROVAL — financial approvals, payment authorizations, budget approvals, signed contracts awaiting countersignature, HR disciplinary or termination actions involving suspicious activity or misconduct
   - NOT CONFIDENTIAL: routine employment contracts, offer letters, standard onboarding paperwork, contract status updates, weekly analytics reports, denial reports, vendor analytics, inactive patient/insurance counts
   - NOT CONFIDENTIAL: termination forms unless the sender explicitly states suspicious activity, concerns, or misconduct
   - NOT CONFIDENTIAL: emails that merely mention a contract by name without requesting a decision or approval

5. MEETING
   - Meeting invites, schedules, minutes, follow-ups

6. ZOOM CALLS
   - Any email that contains a Zoom meeting link (zoom.us URL)

7. NEWSLETTER
   - Marketing, announcements, automated updates, weekly/daily digests
   - Any email containing: unsubscribe, view online, view in browser, copyright notice, 'our address is', 'you are receiving this', opt-out, email preferences, manage preferences
   - These signals ALWAYS mean NEWSLETTER regardless of content topic
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
- Write a summary of 2-4 sentences that is so complete the reader never needs to open the email:
  Sentence 1: Core topic and context.
  Sentence 2: Specific details — names, numbers, dates, deadlines, locations, systems mentioned.
  Sentence 3: What the recipient needs to do or decide.
  Sentence 4 (if applicable): Attachments, links, or follow-up items.
  Never be vague. Include every concrete detail present in the body.
- NEWSLETTER RULE — exactly 2 sentences: Sentence 1: name the publication/source and its specific headline or subject. Sentence 2: list the 2-3 most concrete highlights or facts so the reader can decide if it's worth opening. NEVER say "this email", "a range of topics", "important topics", or anything vague. Name the specific tools, people, numbers, or policies in the body.

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

VIP_SENDERS       = [v.lower() for v in load_sender_list(VIP_FILE)]
PRIORITY_SENDERS  = [v.lower() for v in load_sender_list(PRIORITY_FILE)]
LEGAL_SENDERS     = [v.lower() for v in load_sender_list("legal_list.json")]
PROVIDERS_SENDERS = [v.lower() for v in load_sender_list("providers_om_list.json")]
# Domain-based matching for legal firms (catches any address at these firms)
LEGAL_DOMAINS     = ["ropesgray.com", "garfunkelwild.com", "jclancylaw.com", "ambpclaw.com"]

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

# LEGAL: remove anything already in VIP
_legal_overlap_vip = [e for e in LEGAL_SENDERS if e in _vip_set]
LEGAL_SENDERS = [e for e in LEGAL_SENDERS if e not in _vip_set]
_legal_set    = set(LEGAL_SENDERS)
_log_overlaps(_legal_overlap_vip, "legal_list", "vip_list")

# PRIORITY: remove anything already in VIP or LEGAL
_priority_overlap = [e for e in PRIORITY_SENDERS if e in _vip_set or e in _legal_set]
PRIORITY_SENDERS  = [e for e in PRIORITY_SENDERS if e not in _vip_set and e not in _legal_set]
_priority_set     = set(PRIORITY_SENDERS)
_log_overlaps(_priority_overlap, "priority_list", "vip_list or legal_list")

# PROVIDERS: remove anything already in VIP, LEGAL, or PRIORITY
_providers_overlap = [e for e in PROVIDERS_SENDERS if e in _vip_set or e in _legal_set or e in _priority_set]
PROVIDERS_SENDERS  = [e for e in PROVIDERS_SENDERS if e not in _vip_set and e not in _legal_set and e not in _priority_set]
_log_overlaps(_providers_overlap, "providers_om_list", "vip_list, legal_list, or priority_list")
# ───────────────────────────────────────────────────────────────────────────

log.debug(f"Loaded {len(VIP_SENDERS)} VIP senders from {VIP_FILE}")
log.debug(f"Loaded {len(PRIORITY_SENDERS)} PRIORITY senders from {PRIORITY_FILE}")
log.debug(f"Loaded {len(LEGAL_SENDERS)} LEGAL senders + {len(LEGAL_DOMAINS)} LEGAL domains")
log.debug(f"Loaded {len(PROVIDERS_SENDERS)} PROVIDERS/OM senders")


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
CACHE_VERSION = "v6"   # bumped: newsletter detection + priority sender AI categorization
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

def save_emails_to_id_cache(emails: list, user_email: str):
    existing = get_cached_emails_by_id(user_email)
    for e in emails:
        eid = e.get("id") or e.get("messageId")
        if eid:
            entry = e.copy()
            entry.pop("full_hash", None)
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

    # 1. <hr> separator
    hr_match = re.search(r'<hr\b[^>]*>', html_body, re.IGNORECASE)
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

    newsletter_hint = "\nNOTE: This email contains newsletter/marketing signals. Classify as NEWSLETTER.\n" if is_newsletter_body(body, email.get("from", "")) else ""

    prompt = f"""
Subject: {subject}
From: {email.get('from')}
Body:{body}{newsletter_hint}{CLASSIFICATION_PROMPT}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[
                {"role": "system", "content": "Output JSON only."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.0
        )

        result = json.loads(response.choices[0].message.content)

        sender = (email.get("from") or "").lower()
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
        sender = (email.get("from") or "").lower()
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
- URGENT: hard deadline today/tomorrow, outage, patient safety. Routine counts/reports are NEVER urgent.
- CONFIDENTIAL: ONLY emails requiring a DECISION or APPROVAL. NOT: routine contracts, offer letters, denial reports, analytics, inactive counts, or termination forms without explicit misconduct.
- URGENT beats CONFIDENTIAL when a hard deadline is present.
- MEETING: meeting invites, schedules, minutes
- NEWSLETTER: marketing, automated updates, weekly/daily reports
- NORMAL: routine contracts, employment paperwork, operational counts, vendor analytics, FYIs

For each email return one object with: index, category, priority (1-5), and a summary of 2-4 sentences.
Summary must be thorough enough that the reader never needs to open the email:
- Sentence 1: Core topic and context
- Sentence 2: Specific details (names, numbers, dates, deadlines, locations, systems)
- Sentence 3: What action or decision is needed
- Sentence 4 (if applicable): Attachments or follow-up items
Never be vague. Include every concrete detail from the body.

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
                "newsletter_hint": is_newsletter_body(e.get("body") or "", e.get("from", ""))
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
- URGENT: has a hard deadline of TODAY or TOMORROW, or is an outage/patient safety/escalation. "Internal review only" language does NOT make something urgent — only a concrete deadline does. Routine operational counts and weekly reports are NEVER urgent.
- CONFIDENTIAL: ONLY emails requiring an actual DECISION or APPROVAL — financial approvals, payment authorizations, budget approvals, HR disciplinary/termination actions involving suspicious activity or misconduct. NOT confidential: routine employment contracts, offer letters, onboarding paperwork, contract status updates, weekly denial reports, vendor analytics reports, inactive insurance/patient counts, or termination forms unless suspicious activity is explicitly stated.
- URGENT beats CONFIDENTIAL: if an email has a hard deadline AND sensitive content, always choose URGENT.
- MEETING: meeting invites, agendas, minutes, scheduling requests
- NEWSLETTER: marketing, automated digests, bulk updates, weekly/daily operational reports
- NORMAL: routine contract updates, employment paperwork, operational counts, vendor analytics, FYIs

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
                response_format={"type": "json_object"},
                temperature=0.0
            )
            parsed = json.loads(response.choices[0].message.content)
            results_map = {r["index"]: r for r in parsed.get("results", [])}

            for i, email in enumerate(chunk_emails):
                ai = results_map.get(i, {})
                sender = (email.get("from") or "").lower()
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
            response_format={"type": "json_object"}, temperature=0.0
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
            final_list.append({"name": display_name, "count": len(msgs), "attachments": att_count, "summary": summary_text})
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

    # ── Option D: only the NEWEST email's sender drives the category ──
    # We check only the most recent message so that a VIP/PRIORITY participant
    # in an older reply cannot elevate a thread started or last touched by
    # a non-listed sender (e.g. Amreesh replying to a VIP thread).
    newest_sender = clean_messages[0].get("from", "").lower() if clean_messages else ""
    is_vip_sender       = newest_sender in VIP_SENDERS
    is_legal_sender     = newest_sender in LEGAL_SENDERS or any(newest_sender.endswith("@" + d) for d in LEGAL_DOMAINS)
    is_priority_sender  = newest_sender in PRIORITY_SENDERS
    is_providers_sender = newest_sender in PROVIDERS_SENDERS

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
            response_format={"type": "json_object"}, temperature=0.0
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
            response_format={"type": "json_object"}, temperature=0.0
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
            temperature=0.3,
            max_tokens=1500
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
    """
    user_prompt = f"CONTEXT: {context}. TASK: Draft reply body only."

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            temperature=0.7, max_tokens=300
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


def get_attachment_bytes(attachment):
    """Legacy helper — kept for compatibility but not used in API flow."""
    file_name = attachment["name"]
    file_hash = attachment["hash"]
    file_bytes = base64.b64decode(file_hash)
    return file_name, file_bytes