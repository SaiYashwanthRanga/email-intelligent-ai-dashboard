import os
import asyncio
import requests
import httpx
import uvicorn
import io
import base64
import json
import time
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Body, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from dotenv import load_dotenv
from typing import List
from urllib.parse import unquote

from models import AnalysisRequest, ReplyRequest, ThreadParseRequest, LoginRequest
from services import (
    group_emails_by_subject,
    detect_real_threads,
    analyze_single_thread,
    analyze_single_email,
    analyze_emails_batch,
    generate_executive_brief,
    generate_sender_report,
    draft_email_reply,
    calculate_triage_stats,
    get_last_processed_timestamp,
    set_last_processed_timestamp,
    get_cached_report,
    save_cached_report,
    get_cached_emails,
    save_cached_emails,
    normalize_email,
    get_last_email_count,
    set_last_email_count,
    get_cached_emails_by_id,
    save_emails_to_id_cache
)

# 1. LOAD CONFIGURATION
load_dotenv()
origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
origins = [origin.strip() for origin in origins_str.split(",")]

# Cache file path
CACHE_FILE = Path("db_cache.json")

# ─── MEETINGS IN-MEMORY CACHE ───
# Keyed by "email|startDate|endDate" → { data, fetched_at }
# TTL: 5 minutes — fresh enough, avoids repeated org server calls
_meetings_cache: dict = {}
MEETINGS_CACHE_TTL = 300  # seconds

# ─── ORG SERVER CONFIG ───
ORG_BASE = "http://172.22.6.145"

# =====================================================
# 🔧 CONFIGURE THIS: Your org server's endpoint to
# fetch a single email (with full attachment base64)
# by messageId.
#
# OPTION A — Single-message endpoint (preferred):
#   GET /api/Values/inbox/{email}/message/{messageId}
#
# OPTION B — Dedicated attachment endpoint:
#   GET /api/Values/mail/attachment?email={email}&messageId={messageId}&fileName={name}
#
# Update the function `fetch_attachment_from_api()`
# below to match whichever your .NET server supports.
# =====================================================


app = FastAPI()

# 2. SECURITY (CORS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://172.22.6.145:8080",   # IIS React
        "http://localhost:3000",      # dev
        "*"                           # optional temporary
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- HELPER FUNCTIONS ---

def update_cache_mark_read(message_id: str, user_email: str = ""):
    """Mark a message as read in the per-user cache."""
    if not user_email:
        return
    try:
        from services import load_cache, save_cache, _cache_file_for
        data = load_cache(user_email)
        updated = False

        emails = data.get("meta_last_enriched_emails", [])
        for e in emails:
            if e.get("id") == message_id or e.get("messageId") == message_id:
                e["isRead"] = True
                updated = True
                break

        if updated:
            save_cache({"meta_last_enriched_emails": emails}, user_email)

    except Exception as e:
        print(f"❌ Failed to update read cache: {e}")


def fetch_attachment_from_api(user_email: str, message_id: str, file_name: str) -> bytes:
    """
    🔑 Fetch a specific attachment directly from the org mail API.
    
    Strategy:
      1. Try single-message endpoint first (fast, if your .NET server supports it)
      2. Fallback: fetch recent inbox and search for the matching messageId
    
    The mail API returns attachments with full base64 in the "hash" field.
    """

    # ── ATTEMPT 1: Try single-message endpoint (FAST PATH) ──
    # 🔧 If your .NET server supports this, it's the best option.
    #    If it returns 404, we fall through to the inbox search.
    single_msg_url = f"{ORG_BASE}/api/Values/inbox/{user_email}/message/{message_id}"

    print(f"📥 Attempting single-message fetch: {single_msg_url}")
    print(f"   Looking for file: {file_name}")

    try:
        resp = requests.get(single_msg_url, timeout=30)

        if resp.status_code == 200:
            mail_data = resp.json()
            if isinstance(mail_data, list):
                mail_data = mail_data[0] if mail_data else None

            if mail_data:
                result = _extract_attachment(mail_data, file_name)
                if result:
                    return result

            print("⚠️ Single-message endpoint returned data but attachment not found, trying inbox search...")

        else:
            print(f"⚠️ Single-message endpoint returned {resp.status_code}, falling back to inbox search...")

    except requests.exceptions.ConnectionError:
        print("⚠️ Single-message endpoint not available, falling back to inbox search...")
    except Exception as e:
        print(f"⚠️ Single-message attempt failed ({e}), falling back to inbox search...")

    # ── ATTEMPT 2: Fetch inbox and search for the messageId (FALLBACK) ──
    inbox_url = f"{ORG_BASE}/api/Values/inbox/{user_email}/count200"
    print(f"📥 Fetching inbox to find attachment: {inbox_url}")

    try:
        resp = requests.get(inbox_url, timeout=60)

        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text}"
            )

        inbox_data = resp.json()

        if not isinstance(inbox_data, list):
            raise HTTPException(status_code=500, detail="Unexpected inbox format")

        # Search through all emails for matching messageId or id
        for mail in inbox_data:
            if mail.get("messageId") == message_id or mail.get("id") == message_id:
                print(f"✅ Found email with id: {message_id}")

                result = _extract_attachment(mail, file_name)
                if result:
                    return result

                raise HTTPException(
                    status_code=404,
                    detail=f"Email found but attachment '{file_name}' not in it"
                )

        raise HTTPException(
            status_code=404,
            detail=f"Email with messageId '{message_id}' not found in inbox"
        )

    except HTTPException:
        raise
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Mail server timeout")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")
    except Exception as e:
        print(f"❌ fetch_attachment_from_api error: {e}")
        raise HTTPException(status_code=500, detail=f"Download failed: {str(e)}")


def _extract_attachment(mail_data: dict, file_name: str) -> bytes | None:
    """
    Search for a named attachment in an email object and return decoded bytes.
    Searches both root-level attachments and thread message attachments.
    Returns None if not found.
    """
    all_attachments = []

    # Root-level attachments
    if isinstance(mail_data.get("attachments"), list):
        all_attachments.extend(mail_data["attachments"])

    # Thread message attachments
    if isinstance(mail_data.get("messages"), list):
        for msg in mail_data["messages"]:
            if isinstance(msg.get("attachments"), list):
                all_attachments.extend(msg["attachments"])

    # Find by filename
    for att in all_attachments:
        if att.get("name") == file_name:
            raw_hash = att.get("hash")
            if not raw_hash or len(raw_hash) < 20:
                print(f"⚠️ Attachment '{file_name}' found but hash is empty/truncated")
                return None

            print(f"✅ Extracted attachment: {file_name} ({len(raw_hash)} chars base64)")
            return base64.b64decode(raw_hash)

    return None


# --- ENDPOINTS ---

@app.post("/api/login")
async def login(credentials: LoginRequest):
    try:
        org_login_url = f"{ORG_BASE}/login"
        print(f"🔐 Login attempt for: {credentials.email}")

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                org_login_url,
                json={"email": credentials.email, "password": credentials.password}
            )

        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid email or password")

        user_data = response.json()
        print(f"✅ Login successful for: {credentials.email}")
        return user_data

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Login server timeout.")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot connect to login server.")
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Login error: {e}")
        raise HTTPException(status_code=500, detail="Login failed.")


@app.get("/api/fetch-inbox")
def fetch_inbox(email: str):
    try:
        # Build the org server inbox URL from the email address
        clean_email = unquote(email).strip()
        clean_url = f"{ORG_BASE}/api/Values/inbox/{clean_email}/count200"

        print(f"📡 Requesting org inbox: {clean_url}")

        resp = requests.get(clean_url, timeout=60)

        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text}"
            )

        data = resp.json()

        # ─── STEP 1: Stamp parent messageId + strip base64 from root attachments ───
        for mail in data:
            # Identify the parent email's ID — try both common field names
            parent_id = mail.get("messageId") or mail.get("id") or ""

            for att in mail.get("attachments", []):
                if "hash" in att:
                    raw_hash = att["hash"]
                    att["size"] = len(raw_hash)
                    att["hash"] = raw_hash[:16]        # preview only for UI
                    att["full_hash"] = None
                    att["storage"] = "api"
                    att["messageId"] = parent_id       # ✅ FIX: stamp parent ID so download can find it

                    print(f"📎 Stripped attachment: {att.get('name')} (was {len(raw_hash)} chars)")

        # ─── STEP 2: Merge thread message attachments to root level ───
        for mail in data:
            parent_id = mail.get("messageId") or mail.get("id") or ""
            combined = []

            if "attachments" in mail and isinstance(mail["attachments"], list):
                combined.extend(mail["attachments"])

            if "messages" in mail and isinstance(mail["messages"], list):
                for msg in mail["messages"]:
                    if "attachments" in msg and isinstance(msg["attachments"], list):
                        for att in msg["attachments"]:
                            if "hash" in att:
                                raw_hash = att["hash"]
                                att["size"] = len(raw_hash)
                                att["hash"] = raw_hash[:16]
                                att["full_hash"] = None
                                att["storage"] = "api"
                                att["messageId"] = parent_id   # ✅ FIX: stamp parent ID
                            combined.append(att)

            mail["attachments"] = combined

        print(f"✅ Processed {len(data)} emails (attachments stripped, will fetch from API on download)")

        # Sort by received time
        data.sort(
            key=lambda x: datetime.fromisoformat(x.get("received", "1970-01-01T00:00:00")),
            reverse=True
        )

        return data

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/analyze")
async def analyze_emails(payload: AnalysisRequest):
    user_email = payload.user_email if hasattr(payload, "user_email") and payload.user_email else "default"
    emails = [normalize_email(e) for e in payload.emails]

    if not emails:
        save_cached_emails([], user_email)
        set_last_email_count(0, user_email)
        return {"emails": [], "report": None}

    # ─── STEP 1: Split emails into cached vs new ───
    cached_by_id = get_cached_emails_by_id(user_email)

    cached_results = []
    new_emails = []

    for email in emails:
        eid = email.get("id") or email.get("messageId")
        if eid and eid in cached_by_id:
            # Use cached analysis but keep fresh isRead status from live inbox
            cached_email = cached_by_id[eid].copy()
            cached_email["isRead"] = email.get("isRead", cached_email.get("isRead", False))
            cached_results.append(cached_email)
        else:
            new_emails.append(email)

    print(f"⚡ Cache hit: {len(cached_results)} | New to analyze: {len(new_emails)}")

    # ─── STEP 2: Only analyze NEW emails ───
    new_analyzed = []
    if new_emails:
        real_threads, single_emails = detect_real_threads(new_emails)

        # Threads: one AI call each (they need thread-aware analysis)
        thread_tasks = [
            analyze_single_thread(e.get("subject", "No Subject"), [e], user_email)
            for e in real_threads
        ]

        # Singles: batch into ONE or a few AI calls instead of N calls
        batch_task = analyze_emails_batch(single_emails)

        thread_results, batch_results = await asyncio.gather(
            asyncio.gather(*thread_tasks) if thread_tasks else asyncio.sleep(0),
            batch_task
        )

        if thread_tasks:
            new_analyzed.extend(thread_results)
        new_analyzed.extend(batch_results)

        # Sanitize and save new results to per-ID cache
        for e in new_analyzed:
            atts = e.get("attachments")
            if atts:
                e["attachments"] = [
                    {
                        "name": a.get("name"), "type": a.get("type"),
                        "size": a.get("size"), "hash": a.get("hash"),
                        "storage": a.get("storage"), "full_hash": None,
                        "messageId": a.get("messageId")
                    }
                    for a in atts if isinstance(a, dict)
                ]
            e["cc"] = e.get("cc") if isinstance(e.get("cc"), list) else []
            e["to"] = e.get("to") if isinstance(e.get("to"), list) else []
            e["category"] = (e.get("category") or "NORMAL").upper()

        save_emails_to_id_cache(new_analyzed, user_email)

    # ─── STEP 3: Merge cached + new ───
    all_results = cached_results + new_analyzed

    # Deduplicate by ID
    seen = {}
    for e in all_results:
        eid = e.get("id") or e.get("messageId")
        if eid:
            seen[eid] = e
    all_results = list(seen.values())

    # ─── STEP 4: Regenerate report only when there are new emails ───
    cached_report = get_cached_report(user_email)
    if new_emails or not cached_report:
        threads_only = [t for t in all_results if t.get("thread_count", 1) > 1]
        brief_task = generate_executive_brief(threads_only)
        sender_task = generate_sender_report(emails)
        brief, sender_summaries = await asyncio.gather(brief_task, sender_task)

        triage_data = calculate_triage_stats(emails, all_results, user_identifier=user_email, demo_mode=False)
        brief["thread_email_count"] = len(emails)
        brief["thread_attachment_count"] = triage_data["att_total"]
        brief["sender_summaries"] = sender_summaries
        brief["triage_stats"] = triage_data

        save_cached_report(brief, user_email)
    else:
        print("⚡ No new emails — reusing cached report")
        brief = cached_report

    set_last_email_count(len(emails), user_email)

    # Save legacy cache for backward compat
    save_cached_emails(all_results, user_email)

    # ─── STEP 5: Sort and return ───
    def safe_datetime(val):
        try:
            dt = datetime.fromisoformat(val)
            if dt.tzinfo:
                dt = dt.astimezone(tz=None).replace(tzinfo=None)
            return dt
        except:
            return datetime(1970, 1, 1)

    all_results.sort(
        key=lambda x: safe_datetime(x.get("received_at", "1970-01-01T00:00:00")),
        reverse=True
    )

    return {"emails": all_results, "report": brief}


@app.post("/api/reply")
async def generate_reply(payload: ReplyRequest):
    reply_text = await draft_email_reply(payload.sender, payload.email_body, payload.user_name)
    return {"reply": reply_text}


@app.post("/api/parse-thread")
async def parse_email_thread(payload: ThreadParseRequest):
    return {"segments": [{"type": "latest", "header": "Log", "content": payload.body}]}


@app.post("/api/send-email")
async def send_email(
    to: List[str] = Form(...),
    cc: List[str] = Form([]),
    subject: str = Form(...),
    bodyHtml: str = Form(...),
    attachments: List[UploadFile] = File([]),
    fromEmail: str = Form(None)
):
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/send"

        # Use files= for ALL parts — httpx handles duplicate keys (multiple To/Cc) reliably this way
        parts = []
        for t in to:
            parts.append(("To", (None, t, "text/plain")))
        for c in cc:
            parts.append(("Cc", (None, c, "text/plain")))
        parts.append(("Subject", (None, subject, "text/plain")))
        parts.append(("BodyHtml", (None, bodyHtml, "text/plain")))
        if fromEmail:
            parts.append(("FromEmail", (None, fromEmail, "text/plain")))

        for file in attachments:
            file_bytes = await file.read()
            if file_bytes:
                parts.append(("Attachments", (file.filename, file_bytes, file.content_type)))

        if not any(k == "Attachments" for k, _ in parts):
            parts.append(("Attachments", ("", b"", "application/octet-stream")))

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(org_api_url, files=parts)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        return {"success": True, "message": "Mail sent"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/reply-email")
async def reply_email(
    messageItemId: str = Form(...),
    replyBodyHtml: str = Form(...),
    to: List[str] = Form(...),
    cc: List[str] = Form([]),
    attachments: List[UploadFile] = File([]),
    targetUserEmail: str = Form(None)
):
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/reply"

        # Use files= for ALL parts — httpx handles duplicate keys (multiple To/Cc) reliably this way
        parts = []
        parts.append(("MessageItemId", (None, messageItemId, "text/plain")))
        parts.append(("ReplyBodyHtml", (None, replyBodyHtml, "text/plain")))
        for t in to:
            parts.append(("To", (None, t, "text/plain")))
        for c in cc:
            parts.append(("Cc", (None, c, "text/plain")))
        if targetUserEmail:
            parts.append(("TargetUserEmail", (None, targetUserEmail, "text/plain")))

        for file in attachments:
            file_bytes = await file.read()
            if file_bytes:
                parts.append(("Attachments", (file.filename, file_bytes, file.content_type)))

        if not any(k == "Attachments" for k, _ in parts):
            parts.append(("Attachments", ("", b"", "application/octet-stream")))

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(org_api_url, files=parts)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        return {"success": True, "message": "Reply sent"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────
# 🆕 UPDATED: Download attachment via org mail API
# No more disk storage — fetches directly from source
# ─────────────────────────────────────────────────────
@app.post("/api/download-attachment")
def download_attachment(data: dict):
    name = data.get("name")
    message_id = data.get("messageId")
    user_email = data.get("userEmail", "")

    if not name or not message_id:
        raise HTTPException(status_code=400, detail="Missing 'name' or 'messageId'")
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing 'userEmail'")

    print(f"📥 Download request: '{name}' from message {message_id}")

    # Get the attachment content type from cache (for proper Content-Type header)
    content_type = "application/octet-stream"
    cached_emails = get_cached_emails(user_email) or []

    for mail in cached_emails:
        if mail.get("id") == message_id or mail.get("messageId") == message_id:
            for att in mail.get("attachments", []):
                if att.get("name") == name:
                    content_type = att.get("type", "application/octet-stream")
                    break
            break

    # 🔑 Fetch attachment bytes directly from org mail API
    file_bytes = fetch_attachment_from_api(user_email, message_id, name)

    print(f"✅ Streaming {name} ({len(file_bytes)} bytes) to client")

    return StreamingResponse(
        io.BytesIO(file_bytes),
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(len(file_bytes)),
            "Cache-Control": "no-store"
        }
    )


# --- MARK AS READ ENDPOINT ---
@app.post("/api/mark-read")
def mark_mail_as_read(payload: dict = Body(...)):
    try:
        email = payload.get("email")
        message_id = payload.get("messageId")

        if not email or not message_id:
            raise HTTPException(status_code=400, detail="Missing email or messageId")

        org_api_url = f"{ORG_BASE}/api/Values/mail/read-status"
        params = {"email": email, "messageId": message_id, "isRead": True}

        resp = requests.post(org_api_url, params=params, timeout=20)

        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Org API error: {resp.text}")

        update_cache_mark_read(message_id, email)

        return {"success": True, "message": "Email marked as read"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/search-contacts")
async def search_contacts(q: str = ""):
    """
    Search contacts from the organization mail server.
    Returns a list of contacts matching the query string.
    """
    try:
        if not q or len(q) < 2:
            return []

        # Fetch all contacts from the org server
        contacts_url = f"{ORG_BASE}/get"
        print(f"🔍 Searching contacts: {contacts_url}")
        
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(contacts_url)

        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Failed to fetch contacts: {response.text}"
            )

        all_contacts = response.json()
        
        if not isinstance(all_contacts, list):
            return []
        
        # Filter contacts based on search query (case-insensitive)
        query_lower = q.lower()
        filtered = []
        
        for contact in all_contacts:
            mail_id = contact.get("mailId", "")
            
            # Skip system mailboxes
            if "SystemMailbox" in mail_id:
                continue
            
            # Check if query matches the email
            if query_lower in mail_id.lower():
                # Extract name from email (part before @)
                name_part = mail_id.split("@")[0] if "@" in mail_id else mail_id
                # Convert "First.Last" to "First Last"
                display_name = name_part.replace(".", " ").title()
                
                filtered.append({
                    "email": mail_id,
                    "name": display_name,
                    "group": contact.get("groupName", "user")
                })
        
        # Limit results to 10 for performance
        return filtered[:10]
    
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Contact server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach contact server")
    except Exception as e:
        print(f"❌ search_contacts error: {e}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")



@app.get("/api/meetings")
async def get_meetings(email: str, startDate: str = None, endDate: str = None):
    """
    Proxy: GET http://172.22.6.145/api/Values/meetings
    Results are cached in memory for 5 minutes per email+date range
    so navigating months doesn't hammer the org server every time.
    """
    import httpx
    from datetime import date as date_

    # Default to current month if dates not provided
    today = date_.today()
    if not startDate:
        startDate = today.replace(day=1).isoformat()
    if not endDate:
        import calendar as cal_
        last_day = cal_.monthrange(today.year, today.month)[1]
        endDate = today.replace(day=last_day).isoformat()

    # ── Check in-memory cache first ──
    cache_key = f"{email}|{startDate}|{endDate}"
    cached = _meetings_cache.get(cache_key)
    if cached and (time.time() - cached["fetched_at"]) < MEETINGS_CACHE_TTL:
        print(f"📅 Meetings cache HIT for {cache_key} ({len(cached['data'])} meetings)")
        return cached["data"]

    org_url = f"{ORG_BASE}/api/Values/meetings"
    params  = {"email": email, "startDate": startDate, "endDate": endDate}

    print(f"📅 Fetching meetings (cache MISS): {org_url} | params={params}")

    try:
        # Use async httpx so we don't block the FastAPI event loop
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(org_url, params=params)

        print(f"   → Status: {resp.status_code}")

        if resp.status_code != 200:
            print(f"   ❌ Error body: {resp.text[:300]}")
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Calendar server error: {resp.text}"
            )

        data = resp.json()
        meetings = data if isinstance(data, list) else (
            data.get("value") or data.get("meetings") or
            data.get("data") or []
        )

        # ── Store in cache ──
        _meetings_cache[cache_key] = {"data": meetings, "fetched_at": time.time()}
        print(f"   ✅ Returning {len(meetings)} meetings (cached)")
        return meetings

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Calendar server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach calendar server")
    except Exception as e:
        print(f"❌ get_meetings error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/meetings/respond")
async def respond_to_meeting(meetingId: str, action: str, targetUserEmail: str = None):
    """
    Proxy: POST http://172.22.6.145/api/Values/meetings/Action
    action must be one of: Accept, Tentative, Decline
    """
    import httpx

    valid_actions = {"Accept", "Tentative", "Decline"}
    if action not in valid_actions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action '{action}'. Must be one of: {', '.join(valid_actions)}"
        )

    org_url = f"{ORG_BASE}/api/Values/meetings/Action"
    rsvp_params = {"meetingId": meetingId, "action": action}
    if targetUserEmail:
        rsvp_params["targetUserEmail"] = targetUserEmail

    icon = {"Accept": "✅", "Tentative": "🔔", "Decline": "❌"}.get(action, "📅")
    print(f"{icon} Meeting RSVP: meetingId={meetingId} action={action} targetUserEmail={targetUserEmail}")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(org_url, params=rsvp_params)

        print(f"   → Status: {resp.status_code}")

        if resp.status_code not in (200, 201, 204):
            print(f"   ❌ Error body: {resp.text[:300]}")
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Calendar server error: {resp.text}"
            )

        # Bust the meetings cache so next load reflects the updated RSVP status
        _meetings_cache.clear()

        return {"success": True, "meetingId": meetingId, "action": action}

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Calendar server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach calendar server")
    except Exception as e:
        print(f"❌ respond_to_meeting error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/meetings/cache")
def clear_meetings_cache():
    """Manually bust the meetings cache (call after RSVP respond if needed)."""
    _meetings_cache.clear()
    return {"cleared": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)