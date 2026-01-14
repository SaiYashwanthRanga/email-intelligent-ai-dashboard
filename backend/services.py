import os
import json
import re
import asyncio
import hashlib
import html
from collections import defaultdict, Counter
from datetime import datetime
from openai import AsyncOpenAI
from dotenv import load_dotenv

# 1. SETUP AI CLIENT
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
ACTIVE_MODEL = "gpt-4o-mini"

if not api_key:
    print("❌ CRITICAL ERROR: OPENAI_API_KEY is missing from .env file!")

client = AsyncOpenAI(api_key=api_key)
CACHE_FILE = "db_cache.json"
VIP_FILE = "vip_list.json"

# --- NEW: DATA NORMALIZATION ---
def normalize_email(e: dict):
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
        "attachments": e.get("attachments", [])
    }

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

def save_cached_emails(emails):
    save_cache({EMAILS_KEY: emails})

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
# STEP 3: Updated signature
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
        # STEP 4: Attachments go ONLY to the latest message
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
    subject = email.get("subject", "No Subject")
    sender = email.get("from", "Unknown")
    received = email.get("received_at", "Unknown")

    prompt = f"""
    Analyze this email:
    SUBJECT: {subject}
    FROM: {sender}
    BODY: {body}

    TASK:
    - Categorize (URGENT / MEETING / NEWSLETTER / NORMAL / PRIORITY)
    - Give a short executive summary (1 line)
    - Give an action (REVIEW / RESPOND / IGNORE / SCHEDULE)

    OUTPUT JSON:
    {{
      "category": "...",
      "priority": 1-5,
      "summary": "...",
      "action": "..."
    }}
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

        # Merge AI result into original email (without making it a thread)
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
        
        # STEP 2: Capture attachments
        raw_attachments = messages[0].get("attachments", [])
        
        # STEP 2: Pass attachments to splitter
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
    priority_senders_list = load_vip_list() 

    for i, msg in enumerate(final_messages):
        sender = msg['from']
        participants.add(sender)
        for vip in priority_senders_list:
            if vip.lower() in sender.lower(): is_priority_sender = True
        
        date = msg['date']
        if latest_date is None or date != "Unknown": latest_date = date
        
        history_text += f"[{i+1}] FROM: {sender}\nDATE: {date}\nCONTENT: {msg['body'][:300]}\n----------------\n"
        clean_messages.append(msg)

    # STEP 5: Aggregate attachments at thread level
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
        final_category = "PRIORITY" if is_priority_sender else result.get("category", "NORMAL")
        final_date = result.get("normalized_date") or latest_date

        final_result = {
            "id": messages[0].get('id', 'thread'),
            "subject": display_subject,
            "from": list(participants)[0] if len(participants) == 1 else f"{len(participants)} Participants",
            "participants": list(participants),
            "cc": "", 
            "connection_type": "DIRECT",
            "received_at": final_date, 
            "messages": clean_messages, 
            "thread_count": len(clean_messages), 
            # STEP 5: Replaced empty list with aggregated list
            "attachments": thread_attachments, 
            "category": final_category, 
            "priority": result.get("priority", 1),
            "summary": result.get("summary", "Analysis failed."),
            "action": result.get("action", "REVIEW")
        }
        save_cache({thread_id: final_result})
        return final_result
    except:
        return {"subject": display_subject, "category": "NORMAL", "summary": "Error.", "thread_count": len(final_messages)}

async def generate_executive_brief(threads):
    active_threads = [t for t in threads if t.get('category') != 'NEWSLETTER' and (t.get('thread_count', 1) > 1 or t.get('category') == 'URGENT')]
    if not active_threads: return {"briefing_cards": []}

    thread_data = [f"Subject: {t.get('subject')} | Status: {t.get('summary')}" for t in active_threads[:10]]
    prompt = f"""
    Create Executive Briefing Cards.
    INPUT: {json.dumps(thread_data)}
    OUTPUT JSON: {{ "briefing_cards": [ {{ "topic": "Title", "status": "Update", "category": "URGENT" }} ] }}
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