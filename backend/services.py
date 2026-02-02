import os
import json
import re
import asyncio
import hashlib
import html
import base64  # <--- Added Import
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
CACHE_FILE = "db_cache.json"
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

# Load VIP list once at startup
VIP_SENDERS = [v.lower() for v in load_vip_list()]
print(f"✅ Loaded {len(VIP_SENDERS)} VIP senders: {VIP_SENDERS}")

# --- DATA NORMALIZATION ---
def normalize_email(e: dict):
    clean_attachments = []
    
    email_id = e.get("id") or e.get("_id") or e.get("messageId")

    for att in e.get("attachments", []):
        clean_attachments.append({
            "name": att.get("name"),
            "type": att.get("type", "application/octet-stream"),
            "size": att.get("size", 0),
            "hash": att.get("hash"),           # already trimmed in main.py
            "full_hash": att.get("full_hash"), # used only for download
            "storage": att.get("storage", "inline"), # Ensure storage type is preserved
            "file_path": att.get("file_path"),   # 👈 ADD THIS to preserve disk path
            "messageId": email_id   # 👈 THIS IS THE KEY LINE
        })

    return {
        "id": e.get("id") or e.get("_id") or e.get("messageId") or "mail",
        "subject": e.get("subject", "No Subject"),
        "from": e.get("from") or e.get("sender") or e.get("email") or "Unknown",
        "to": e.get("to", []),
        "cc": e.get("cc", []),
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
def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                return json.load(f)
        except:
            return {}
    return {}

def save_cache(new_data):
    current_cache = load_cache()
    current_cache.update(new_data)
    with open(CACHE_FILE, "w") as f:
        json.dump(current_cache, f, indent=2)

# --- LEVEL 3: TIMESTAMP & REPORT CACHING ---
TIMESTAMP_KEY = "meta_last_processed_timestamp"
REPORT_KEY = "meta_last_full_report"
EMAILS_KEY = "meta_last_enriched_emails"

def get_last_processed_timestamp():
    cache = load_cache()
    return cache.get(TIMESTAMP_KEY)

def set_last_processed_timestamp(ts):
    save_cache({TIMESTAMP_KEY: ts})

def get_cached_report():
    cache = load_cache()
    return cache.get(REPORT_KEY)

def save_cached_report(report):
    save_cache({REPORT_KEY: report})

def get_cached_emails():
    cache = load_cache()
    return cache.get(EMAILS_KEY)

# --- UPDATED FUNCTION HERE ---
def save_cached_emails(emails):
    """
    Cache enriched emails safely.
    Ensures 'file_path' is preserved for disk-based files.
    Removes 'full_hash' only for remote files.
    """
    cleaned = []
    for e in emails:
        # Create a shallow copy of the email first
        email_copy = e.copy()
        
        # 1. Process Top-Level Attachments
        new_atts = []
        for att in e.get("attachments", []):
            att_copy = att.copy()
            # If storage is remote, we don't need full_hash
            if att_copy.get("storage") == "remote":
                att_copy.pop("full_hash", None)
            
            # Note: We do NOT pop 'file_path'. It stays in att_copy.
            new_atts.append(att_copy)
        email_copy["attachments"] = new_atts

        # 2. Process Thread Message Attachments
        new_messages = []
        for msg in e.get("messages", []):
            msg_copy = msg.copy()
            new_msg_atts = []
            for matt in msg.get("attachments", []):
                matt_copy = matt.copy()
                if matt_copy.get("storage") == "remote":
                    matt_copy.pop("full_hash", None)
                new_msg_atts.append(matt_copy)
            msg_copy["attachments"] = new_msg_atts
            new_messages.append(msg_copy)
        email_copy["messages"] = new_messages

        cleaned.append(email_copy)

    save_cache({EMAILS_KEY: cleaned})
# -----------------------------

# --- HELPER FUNCTIONS ---

def body_hash(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]

def group_emails_by_subject(emails):
    groups = defaultdict(list)
    GENERIC_SUBJECTS = ["no subject", "hi", "hello", "update", "meeting", "question", "info", "query", "status"]

    for e in emails:
        if 'thread_count' in e: continue

        subject = e.get('subject', 'No Subject').strip()
        sender = e.get('from') or "Unknown"
        body = e.get("body", "")

        clean_subj = re.sub(r'^(re|fwd|fw|aw):\s*', '', subject, flags=re.IGNORECASE).strip()
        is_generic = clean_subj.lower() in GENERIC_SUBJECTS or len(clean_subj) < 3

        key = f"{clean_subj}::{body_hash(body)}"
        groups[key].append(e)

    return groups

# --- ROBUST THREAD SPLITTER LOGIC ---
def split_reply_chain(body, main_sender, main_date, attachments=None):
    if not body:
        return []

    # 1. Decode HTML entities
    body = html.unescape(body)

    # 2. Clean Outlook junk
    body = re.sub(r"\s*&nbsp;\s*", "\n", body)
    body = re.sub(r"\n{2,}", "\n\n", body).strip()

    # 3. Regex pattern
    pattern = re.compile(
        r"(From:\s.*?\nSent:\s.*?\nTo:\s.*?\n(?:Cc:\s.*?\n)?Subject:\s.*?\n)",
        re.IGNORECASE | re.DOTALL
    )

    parts = pattern.split(body)
    messages = []

    # First block = latest reply
    latest_body = parts[0].strip()
    if latest_body:
        messages.append({
            "from": main_sender,
            "date": main_date,
            "body": latest_body,
            "attachments": attachments or []
        })

    # Other blocks = history (no attachments)
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

# --- NEW: DETECT REAL THREADS ---
def detect_real_threads(emails):
    threads = []
    singles = []

    for e in emails:
        body = str(e.get("body") or "")
        sender = e.get("from") or "Unknown"
        date = e.get("received_at") or e.get("date") or "Unknown"
        attachments = e.get("attachments", [])

        # Try splitting the body
        split_messages = split_reply_chain(body, sender, date, attachments)

        # If more than 1 message found → this is a real thread
        if len(split_messages) > 1:
            e["__is_thread__"] = True
            threads.append(e)
        else:
            e["__is_thread__"] = False
            singles.append(e)

    return threads, singles

# --- AI CORE FUNCTIONS ---

async def analyze_single_email(email):
    body = email.get("body", "")
    email_body = body  # Ensure variable matches the requested snippet
    subject = email.get("subject", "No Subject")
    sender = email.get("from", "Unknown")
    received = email.get("received_at", "Unknown")

    # --- STEP 2: Update AI call prompt ---
    prompt = f"""
Subject: {email.get('subject')}
From: {email.get('from')}
Body:{email_body}{CLASSIFICATION_PROMPT}
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

        # --- STEP 3: Enforce VIP rule after AI response ---
        sender = (email.get("from") or "").lower()
        
        # --- MODIFIED: Enforce ZOOM Logic ---
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
        # ------------------------------------

        email["summary"] = result.get("summary", "No summary")
        email["action"] = result.get("action", "REVIEW")

        return email

    except Exception as e:
        print("Single mail analysis failed:", e)
        email["category"] = "NORMAL"
        email["summary"] = "Pending analysis"
        return email

async def generate_sender_report(emails):
    print("🔹 Jarvis Generating Sender Summaries...")
    sender_groups = defaultdict(list)
    for e in emails:
        if 'thread_count' in e: continue
        sender = e.get('from') or e.get('sender') or "Unknown"
        if "<" in sender:
            simple_name = sender.split("<")[1].strip(">").lower()
        else:
            simple_name = sender.strip().lower()
        sender_groups[simple_name].append(e)
    
    top_senders = sorted(sender_groups.items(), key=lambda x: len(x[1]), reverse=True)[:7]
    if not top_senders: return []

    senders_input = []
    for name, msgs in top_senders:
        details = " | ".join([f"Subject: {m.get('subject')} (Body: {str(m.get('body'))[:100]}...)" for m in msgs[:3]])
        senders_input.append({ "id": name, "content": details })
        
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
            response_format={ "type": "json_object" }, temperature=0.0
        )
        ai_response = json.loads(response.choices[0].message.content)
        ai_summaries = { item['id'].lower(): item['text'] for item in ai_response.get("summaries", []) }
        
        final_list = []
        for name, msgs in top_senders:
            fallback_text = f"Discussing: {msgs[0].get('subject')}"
            summary_text = ai_summaries.get(name, fallback_text)
            att_count = sum(len(m.get('attachments', [])) for m in msgs)
            display_name = msgs[0].get('from').split('<')[0].strip()
            if not display_name: display_name = name
            final_list.append({ "name": display_name, "count": len(msgs), "attachments": att_count, "summary": summary_text })
        return final_list
    except Exception as e:
        print(f"Error in sender report: {e}")
        return []

async def analyze_single_thread(subject, messages):
    # Auto-Split Logic
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
        final_messages = []
        for m in messages:
            final_messages.append({
                "from": m.get('from') or "Unknown",
                "date": m.get('received_at') or m.get('date') or "Unknown",
                "body": str(m.get('body')),
                "attachments": m.get('attachments', [])
            })

    # CACHE CHECK
    thread_id = f"{subject}_{len(final_messages)}"
    cache = load_cache()
    if thread_id in cache: return cache[thread_id]

    display_subject = subject.split("::")[0] if "::" in subject else subject
    participants = set()
    latest_date = None
    clean_messages = []
    history_text = ""
    is_priority_sender = False

    for i, msg in enumerate(final_messages):
        sender = msg['from']
        participants.add(sender)
        
        # Check if sender is in VIP list
        sender_lower = sender.lower()
        if sender_lower in VIP_SENDERS:
            is_priority_sender = True
        
        date = msg['date']
        if latest_date is None or date != "Unknown": latest_date = date
        
        history_text += f"[{i+1}] FROM: {sender}\nDATE: {date}\nCONTENT: {msg['body'][:300]}\n----------------\n"
        clean_messages.append(msg)

    # Aggregate attachments at thread level
    thread_attachments = []
    for m in clean_messages:
        thread_attachments.extend(m.get("attachments", []))

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
            response_format={ "type": "json_object" }, temperature=0.0
        )
        result = json.loads(response.choices[0].message.content)
        
        # --- MODIFIED: Enforce ZOOM Logic in Threads ---
        # Detect Zoom inside thread messages
        has_zoom = False
        for m in clean_messages:
            text = (m.get("body") or "").lower()
            if "zoom.us" in text:
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
        # ----------------------------------------------
        
        final_date = result.get("normalized_date") or latest_date

        final_result = {
            "id": messages[0].get("messageId") or messages[0].get("id"),
            "subject": display_subject,
            "from": list(participants)[0] if len(participants) == 1 else f"{len(participants)} Participants",
            "participants": list(participants),
            "cc": "", 
            "connection_type": "DIRECT",
            "received_at": final_date, 
            "messages": clean_messages, 
            "thread_count": len(clean_messages), 
            "attachments": thread_attachments, 
            "category": final_category, 
            "priority": final_priority,
            "summary": result.get("summary", "Analysis failed."),
            "action": result.get("action", "REVIEW")
        }
        save_cache({thread_id: final_result})
        return final_result
    except:
        return {"subject": display_subject, "category": "NORMAL", "summary": "Error.", "thread_count": len(final_messages)}

# --- ✅ UPDATED: generate_executive_brief WITH ID MAPPING ---
async def generate_executive_brief(threads):
    active_threads = [t for t in threads if t.get('category') != 'NEWSLETTER' and (t.get('thread_count', 1) > 1 or t.get('category') == 'URGENT')]
    if not active_threads: return {"briefing_cards": []}

    # ✅ CHANGED: Include id, subject, summary, category in thread_data
    thread_data = [
        {
            "id": t.get("id"),
            "subject": t.get("subject"),
            "summary": t.get("summary"),
            "category": t.get("category")
        }
        for t in active_threads[:10]
    ]

    # ✅ CHANGED: Updated prompt with clear ID mapping instruction
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
            response_format={ "type": "json_object" }, temperature=0.0
        )
        return json.loads(response.choices[0].message.content)
    except:
        return {"briefing_cards": []}

async def draft_email_reply(sender, context):
    is_internal = "hfmg.net" in sender.lower()
    tone_desc = "Brief, direct, and internal" if is_internal else "Professional, partnership-focused, and polite"
    
    system_prompt = f"""
    You are Jim Olver-Goshen, the CEO. You are writing a reply to {sender}.
    YOUR STYLE GUIDE:
    - Tone: {tone_desc}.
    - Be decisive. No fluff.
    - Sign off: "Thanks, Jim" or "Best, Jim".
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

def calculate_triage_stats(emails, threads=None, user_identifier="Jim@hfmg.net", demo_mode=False):
    target = user_identifier.strip().lower()
    vol_emails = len(emails)

    if threads and isinstance(threads, list):
        meaningful_threads = []
        for t in threads:
            category = (t.get("category") or "").upper()
            thread_count = t.get("thread_count", 1)
            if (category != "NEWSLETTER" or thread_count > 1 or category in ["URGENT", "PRIORITY", "MEETING"]):
                meaningful_threads.append(t)
        vol_threads = len(meaningful_threads)
    else:
        vol_threads = 0

    if threads and isinstance(threads, list):
        vol_meetings = sum(1 for t in threads if (t.get("category") or "").upper() == "MEETING")
    else:
        vol_meetings = 0

    att_total = 0
    att_breakdown = {"PDF": 0, "DOC": 0, "XLS": 0, "IMG": 0}

    for e in emails:
        attachments = e.get("attachments", []) or []
        att_total += len(attachments)
        for att in attachments:
            name = str(att.get("name", "")).lower()
            if name.endswith(".pdf"): att_breakdown["PDF"] += 1
            elif "doc" in name: att_breakdown["DOC"] += 1
            elif "xls" in name or "csv" in name: att_breakdown["XLS"] += 1
            elif any(ext in name for ext in ["png", "jpg", "jpeg"]): att_breakdown["IMG"] += 1

    to_count = 0
    cc_count = 0

    def extract_addresses(field):
        addresses = []
        if isinstance(field, str):
            addresses.extend([x.strip().lower() for x in field.replace(";", ",").split(",")])
        elif isinstance(field, list):
            for item in field:
                if isinstance(item, str): addresses.append(item.strip().lower())
                elif isinstance(item, dict):
                    addr = (item.get("emailAddress", {}).get("address") or item.get("address") or item.get("email"))
                    if addr: addresses.append(str(addr).strip().lower())
        return addresses

    for e in emails:
        to_list = extract_addresses(e.get("to"))
        cc_list = extract_addresses(e.get("cc"))
        if target in to_list: to_count += 1
        elif target in cc_list: cc_count += 1

    return {
        "vol_emails": vol_emails,
        "vol_threads": vol_threads,
        "vol_meetings": vol_meetings,
        "total_unread": vol_emails,
        "att_total": att_total,
        "att_breakdown": att_breakdown,
        "to": to_count,
        "cc": cc_count
    }

# --- ATTACHMENT DECODER HELPER ---
def get_attachment_bytes(attachment):
    file_name = attachment["name"]
    file_hash = attachment["hash"]

    file_bytes = base64.b64decode(file_hash)
    print("📦 Decoded file size:", len(file_bytes))

    return file_name, file_bytes