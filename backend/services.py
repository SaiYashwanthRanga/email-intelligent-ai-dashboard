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

# --- STEP 1: Create a strict classification prompt ---
CLASSIFICATION_PROMPT = """
You are an enterprise email triage assistant.

Your job is to strictly classify an email into ONE of the following categories:

1. PRIORITY  
   - Emails from executives, leadership, or VIP senders  
   - Financial, legal, compliance, production-impacting topics  

2. URGENT  
   - Time-sensitive  
   - Deadlines today or tomorrow  
   - Outages, incidents, escalations  

3. CONFIDENTIAL  
   - Sensitive, legal, HR, patient, or contract information  
   - Financial approvals, payment authorizations, invoices, budget approvals, purchase approvals  
   - Any email that contains financial decision making or approval requests 

4. MEETING  
   - Meeting invites, schedules, minutes, follow-ups  

5. ZOOM CALLS
    -  Any email that contains a Zoom meeting link
    -  URLs like https://zoom.us or https://*.zoom.us

5. NEWSLETTER  
   - Marketing, announcements, automated updates  

6. NORMAL  
   - Everything else  

Rules:
- Always choose exactly ONE category.
- Do NOT invent categories.
- Do NOT explain.
- Output ONLY valid JSON.
- Give a priority score (1 to 5).
- Give a one-sentence professional summary.

JSON format:

{
  "category": "PRIORITY | URGENT | CONFIDENTIAL | MEETING | ZOOM | NEWSLETTER | NORMAL"
  "priority": 1,
  "summary": "short professional summary"
}
"""

# 1. SETUP AI CLIENT
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
ACTIVE_MODEL = "gpt-4o-mini"

if not api_key:
    print("❌ CRITICAL ERROR: OPENAI_API_KEY is missing from .env file!")

client = AsyncOpenAI(api_key=api_key)
VIP_FILE = "vip_list.json"

# --- CONFIGURATION: PRIORITY SENDERS ---
def load_vip_list():
    if os.path.exists(VIP_FILE):
        try:
            with open(VIP_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Error loading VIP list: {e}")
            return []
    return []

VIP_SENDERS = [v.lower() for v in load_vip_list()]
print(f"✅ Loaded {len(VIP_SENDERS)} VIP senders: {VIP_SENDERS}")


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
    Normalize raw email dict into a consistent structure.
    🆕 UPDATED: No more file_path — attachments use storage='api'
    """
    email_id = e.get("id") or e.get("_id") or e.get("messageId")

    clean_attachments = []
    for att in e.get("attachments", []):
        clean_attachments.append({
            "name": att.get("name"),
            "type": att.get("type", "application/octet-stream"),
            "size": att.get("size", 0),
            "hash": att.get("hash"),             # 16-char preview only
            "storage": att.get("storage", "api"),  # 🆕 always 'api' now
            "messageId": email_id                  # links attachment to its email
        })

    return {
        "id": email_id or "mail",
        "subject": e.get("subject", "No Subject"),
        "from": e.get("from") or e.get("sender") or e.get("email") or "Unknown",
        "to": normalize_list(e.get("to")),
        "cc": normalize_list(e.get("cc")),
        "body": str(e.get("body") or e.get("content") or e.get("text") or ""),
        "received_at": (
            e.get("receivedDateTime") or
            e.get("received_at") or
            e.get("received") or
            e.get("date") or
            "1970-01-01T00:00:00"
        ),
        "attachments": clean_attachments
    }


# --- CACHE SYSTEM ---
# Each user gets their own cache file: cache_<sanitized_email>.json
# This ensures simultaneous users never read/write each other's data.

import re as _re

def _cache_file_for(user_email: str) -> str:
    """Return a safe, user-specific cache filename."""
    safe = _re.sub(r"[^\w@.-]", "_", user_email.lower().strip())
    return f"cache_{safe}.json"

def load_cache(user_email: str = "default"):
    path = _cache_file_for(user_email)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
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
    GENERIC_SUBJECTS = ["no subject", "hi", "hello", "update", "meeting", "question", "info", "query", "status"]

    for e in emails:
        if 'thread_count' in e:
            continue
        subject = e.get('subject', 'No Subject').strip()
        body = e.get("body", "")
        clean_subj = re.sub(r'^(re|fwd|fw|aw):\s*', '', subject, flags=re.IGNORECASE).strip()
        key = f"{clean_subj}::{body_hash(body)}"
        groups[key].append(e)

    return groups


def split_reply_chain(body, main_sender, main_date, attachments=None):
    if not body:
        return []

    body = html.unescape(body)
    body = re.sub(r"\s*&nbsp;\s*", "\n", body)
    body = re.sub(r"\n{2,}", "\n\n", body).strip()

    pattern = re.compile(
        r"(From:\s.*?\nSent:\s.*?\nTo:\s.*?\n(?:Cc:\s.*?\n)?Subject:\s.*?\n)",
        re.IGNORECASE | re.DOTALL
    )

    parts = pattern.split(body)
    messages = []

    latest_body = parts[0].strip()
    if latest_body:
        messages.append({
            "from": main_sender,
            "date": main_date,
            "body": latest_body,
            "attachments": attachments or []
        })

    for i in range(1, len(parts), 2):
        header = parts[i]
        content = parts[i + 1] if i + 1 < len(parts) else ""

        from_match = re.search(r"From:\s*(.*)", header, re.IGNORECASE)
        sent_match = re.search(r"Sent:\s*(.*)", header, re.IGNORECASE)

        sender = from_match.group(1).strip() if from_match else "Unknown"
        date = sent_match.group(1).strip() if sent_match else "Unknown"

        messages.append({
            "from": sender,
            "date": date,
            "body": content.strip(),
            "attachments": []
        })

    return messages


def detect_real_threads(emails):
    threads = []
    singles = []

    for e in emails:
        body = str(e.get("body") or "")
        sender = e.get("from") or "Unknown"
        date = e.get("received_at") or e.get("date") or "Unknown"
        attachments = e.get("attachments", [])

        split_messages = split_reply_chain(body, sender, date, attachments)

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
    subject = email.get("subject", "No Subject")

    prompt = f"""
Subject: {subject}
From: {email.get('from')}
Body:{body}{CLASSIFICATION_PROMPT}
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

        if has_zoom:
            email["category"] = "ZOOM"
            email["priority"] = 4
        elif sender in VIP_SENDERS:
            email["category"] = "PRIORITY"
            email["priority"] = 5
        else:
            email["category"] = result.get("category", "NORMAL")
            email["priority"] = result.get("priority", 1)

        email["summary"] = result.get("summary", "No summary")
        email["action"] = result.get("action", "REVIEW")
        return email

    except Exception as e:
        print("Single mail analysis failed:", e)
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

        if has_zoom:
            email["category"] = "ZOOM"
            email["priority"] = 4
            email["summary"] = email.get("summary") or "Zoom meeting invitation."
            email["action"] = "REVIEW"
            pre_classified.append(email)
        elif sender in VIP_SENDERS:
            email["category"] = "PRIORITY"
            email["priority"] = 5
            email["summary"] = email.get("summary") or "Message from a VIP sender."
            email["action"] = "REVIEW"
            pre_classified.append(email)
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
            "body_preview": (e.get("body") or "")[:400]
        })

    batch_prompt = f"""
You are an enterprise email triage assistant. Classify each email below.

Categories: PRIORITY | URGENT | CONFIDENTIAL | MEETING | ZOOM | NEWSLETTER | NORMAL

Rules:
- ZOOM: contains zoom.us link
- PRIORITY: from executives/leadership/VIP, financial/legal topics
- URGENT: time-sensitive, deadlines today/tomorrow, outages
- CONFIDENTIAL: sensitive HR/legal/financial approvals
- MEETING: meeting invites, schedules, minutes
- NEWSLETTER: marketing, automated updates
- NORMAL: everything else

For each email return one object with: index, category, priority (1-5), summary (one professional sentence).

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
                "subject": e.get("subject", "No Subject"),
                "from": e.get("from", "Unknown"),
                "body_preview": (e.get("body") or "")[:400]
            }
            for i, e in enumerate(chunk_emails)
        ]

        chunk_prompt = f"""
You are an enterprise email triage assistant. Classify each email below.

Categories: PRIORITY | URGENT | CONFIDENTIAL | MEETING | ZOOM | NEWSLETTER | NORMAL

Rules:
- ZOOM: contains zoom.us link
- PRIORITY: from executives/leadership/VIP, financial/legal topics  
- URGENT: time-sensitive, deadlines today/tomorrow, outages
- CONFIDENTIAL: sensitive HR/legal/financial approvals
- MEETING: meeting invites, schedules, minutes
- NEWSLETTER: marketing, automated updates
- NORMAL: everything else

For each email return one object with: index, category, priority (1-5), summary (one professional sentence).

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
                email["category"] = ai.get("category", "NORMAL")
                email["priority"] = ai.get("priority", 1)
                email["summary"] = ai.get("summary", "No summary")
                email["action"] = "REVIEW"
                all_ai_results.append(email)

        except Exception as ex:
            print(f"⚠️ Batch chunk failed: {ex}")
            for email in chunk_emails:
                email["category"] = "NORMAL"
                email["summary"] = "Pending analysis"
                all_ai_results.append(email)

    return pre_classified + all_ai_results


async def generate_sender_report(emails):
    print("🔹 Generating Sender Summaries...")
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
        details = " | ".join([f"Subject: {m.get('subject')} (Body: {str(m.get('body'))[:100]}...)" for m in msgs[:3]])
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
        print(f"Error in sender report: {e}")
        return []


async def analyze_single_thread(subject, messages, user_email: str = "default"):
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
            final_messages.append({
                "from": m.get('from') or "Unknown",
                "date": m.get('received_at') or m.get('date') or "Unknown",
                "body": str(m.get('body')),
                "attachments": m.get('attachments', [])
            })

    thread_id = f"thread__{subject}_{len(final_messages)}"
    cache = load_cache(user_email)
    if thread_id in cache:
        return cache[thread_id]

    display_subject = subject.split("::")[0] if "::" in subject else subject
    participants = set()
    latest_date = None
    clean_messages = []
    history_text = ""
    is_priority_sender = False

    for i, msg in enumerate(final_messages):
        sender = msg['from']
        participants.add(sender)

        sender_lower = sender.lower()
        if sender_lower in VIP_SENDERS:
            is_priority_sender = True

        date = msg['date']
        if latest_date is None or date != "Unknown":
            latest_date = date

        history_text += f"[{i+1}] FROM: {sender}\nDATE: {date}\nCONTENT: {msg['body'][:300]}\n----------------\n"
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

    prompt = f"""
    Analyze this thread.
    THREAD: {display_subject}
    RAW_DATE: {latest_date}
    LOG: {history_text}
    TASK: Categorize (URGENT/MEETING/NEWSLETTER/NORMAL), Summarize status, Normalize date to ISO 8601.
    OUTPUT JSON: {{ "category": "...", "priority": 1-5, "summary": "...", "action": "...", "normalized_date": "ISO_DATE" }}
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
        elif is_priority_sender:
            final_category = "PRIORITY"
            final_priority = 5
        else:
            final_category = result.get("category", "NORMAL")
            final_priority = result.get("priority", 1)

        final_date = result.get("normalized_date") or latest_date
        latest_message = clean_messages[0]

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
            "action": result.get("action", "REVIEW")
        }
        save_cache({thread_id: final_result}, user_email)
        return final_result
    except:
        return {"subject": display_subject, "category": "NORMAL", "summary": "Error.", "thread_count": len(final_messages)}


async def generate_executive_brief(threads):
    active_threads = [t for t in threads if t.get('category') != 'NEWSLETTER' and (t.get('thread_count', 1) > 1 or t.get('category') == 'URGENT')]
    if not active_threads:
        return {"briefing_cards": []}

    thread_data = [
        {
            "id": t.get("id"),
            "subject": t.get("subject"),
            "summary": t.get("summary"),
            "category": t.get("category")
        }
        for t in active_threads[:10]
    ]

    prompt = f"""
Create Executive Briefing Cards.

INPUT JSON:
{json.dumps(thread_data)}

For every input item, create one briefing card.
You MUST copy the same "id" field into the output.

OUTPUT JSON FORMAT:
{{
  "briefing_cards": [
    {{
      "id": "original id",
      "topic": "Short title",
      "status": "Current status",
      "category": "URGENT | PRIORITY | MEETING | NORMAL"
    }}
  ]
}}
"""

    try:
        response = await client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "Output JSON only."}, {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}, temperature=0.0
        )
        return json.loads(response.choices[0].message.content)
    except:
        return {"briefing_cards": []}


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
    - Sign off: "Thanks, {first_name}" or "Best, {first_name}".
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
    vol_emails = len(emails)

    if threads and isinstance(threads, list):
        meaningful_threads = []
        for t in threads:
            category = (t.get("category") or "").upper()
            thread_count = t.get("thread_count", 1)
            if category != "NEWSLETTER" or thread_count > 1 or category in ["URGENT", "PRIORITY", "MEETING"]:
                meaningful_threads.append(t)
        vol_threads = len(meaningful_threads)
    else:
        vol_threads = 0

    vol_meetings = 0
    if threads and isinstance(threads, list):
        vol_meetings = sum(1 for t in threads if (t.get("category") or "").upper() == "MEETING")

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