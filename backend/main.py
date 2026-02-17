import os
import asyncio
import requests
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

from models import AnalysisRequest, ReplyRequest, ThreadParseRequest, LoginRequest
from services import (
    group_emails_by_subject,
    detect_real_threads,
    analyze_single_thread,
    analyze_single_email,
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
    set_last_email_count
)

# 1. LOAD CONFIGURATION
load_dotenv()
origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
origins = [origin.strip() for origin in origins_str.split(",")]

# Cache file path
CACHE_FILE = Path("db_cache.json")

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
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- HELPER FUNCTIONS ---

def update_cache_mark_read(message_id: str):
    if not CACHE_FILE.exists():
        return

    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        updated = False
        for e in data.get("meta_last_enriched_emails", []):
            if e.get("id") == message_id or e.get("messageId") == message_id:
                e["isRead"] = True
                updated = True
                break

        for t in data.get("threads", []):
            if t.get("id") == message_id or t.get("messageId") == message_id:
                t["isRead"] = True
                updated = True
                break

        if updated:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

    except Exception as e:
        print(f"❌ Failed to update cache: {e}")


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

        # Search through all emails for matching messageId
        for mail in inbox_data:
            if mail.get("messageId") == message_id:
                print(f"✅ Found email with messageId: {message_id}")

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

        response = requests.post(
            org_login_url,
            json={"email": credentials.email, "password": credentials.password},
            timeout=10
        )

        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid email or password")

        user_data = response.json()
        print(f"✅ Login successful for: {credentials.email}")
        return user_data

    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Login server timeout.")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot connect to login server.")
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Login error: {e}")
        raise HTTPException(status_code=500, detail="Login failed.")


@app.get("/api/fetch-inbox")
def fetch_inbox(url: str = f"{ORG_BASE}/api/Values/inbox/ramon.romero@hfmg.net/count10"):
    try:
        clean_url = url.replace("[", "").replace("]", "").split("(")[0]
        if not clean_url.startswith("http"):
            clean_url = f"http://{clean_url}"

        print(f"Fetching inbox from: {clean_url}")

        resp = requests.get(clean_url, timeout=60)
        data = resp.json()

        # ─── STEP 1: Strip heavy base64 from attachments (NO DISK SAVE) ───
        for mail in data:
            for att in mail.get("attachments", []):
                if "hash" in att:
                    raw_hash = att["hash"]
                    att["size"] = len(raw_hash)       # preserve size info
                    att["hash"] = raw_hash[:16]        # preview only for UI
                    att["full_hash"] = None             # stripped — will fetch from API on download
                    att["storage"] = "api"              # 🆕 indicates "fetch from mail API"

                    print(f"📎 Stripped attachment: {att.get('name')} (was {len(raw_hash)} chars)")

        # ─── STEP 2: Merge thread message attachments to root level ───
        for mail in data:
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
    emails = [normalize_email(e) for e in payload.emails]

    current_count = len(emails)
    last_count = get_last_email_count()
    cached_emails = get_cached_emails() or []

    if last_count == current_count and cached_emails:
        print(f"⚡ No change in email count ({current_count}). Using cache.")
        cached_report = get_cached_report()
        return {"emails": cached_emails, "report": cached_report}

    if not emails:
        save_cached_emails([])
        set_last_email_count(0)
        return {"emails": [], "report": None}

    print(f"🆕 Email count changed ({last_count} → {current_count}). Running AI analysis...")

    real_threads, single_emails = detect_real_threads(emails)

    tasks = []
    for e in real_threads:
        subject = e.get("subject", "No Subject")
        tasks.append(analyze_single_thread(subject, [e]))

    for e in single_emails:
        tasks.append(analyze_single_email(e))

    analyzed_results = await asyncio.gather(*tasks)

    threads_only = [t for t in analyzed_results if t.get("thread_count", 1) > 1]

    brief_task = generate_executive_brief(threads_only)
    sender_task = generate_sender_report(emails)
    brief, sender_summaries = await asyncio.gather(brief_task, sender_task)

    triage_data = calculate_triage_stats(emails, analyzed_results, demo_mode=False)

    brief["thread_email_count"] = len(emails)
    brief["thread_attachment_count"] = triage_data["att_total"]
    brief["sender_summaries"] = sender_summaries
    brief["triage_stats"] = triage_data

    save_cached_report(brief)
    save_cached_emails(analyzed_results)
    set_last_email_count(current_count)

    def safe_datetime(val):
        try:
            dt = datetime.fromisoformat(val)
            if dt.tzinfo:
                dt = dt.astimezone(tz=None).replace(tzinfo=None)
            return dt
        except:
            return datetime(1970, 1, 1)

    analyzed_results.sort(
        key=lambda x: safe_datetime(x.get("received_at", "1970-01-01T00:00:00")),
        reverse=True
    )

    return {"emails": analyzed_results, "report": brief}


@app.post("/api/reply")
async def generate_reply(payload: ReplyRequest):
    reply_text = await draft_email_reply(payload.sender, payload.email_body)
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
    attachments: List[UploadFile] = File([])
):
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/send"

        data = []
        for t in to:
            data.append(("To", t))
        for c in cc:
            data.append(("Cc", c))
        data.append(("Subject", subject))
        data.append(("BodyHtml", bodyHtml))

        files = []
        for file in attachments:
            file_bytes = await file.read()
            if file_bytes:
                files.append(("Attachments", (file.filename, file_bytes, file.content_type)))

        if not files:
            files.append(("Attachments", ("", b"", "application/octet-stream")))

        response = requests.post(org_api_url, data=data, files=files, timeout=30)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        return {"success": True, "message": "Mail sent"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/reply-email")
async def reply_email(
    messageItemId: str = Form(...),
    replyBodyHtml: str = Form(...),
    to: List[str] = Form(...),
    cc: List[str] = Form([]),
    attachments: List[UploadFile] = File([])
):
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/reply"

        data = []
        data.append(("MessageItemId", messageItemId))
        data.append(("ReplyBodyHtml", replyBodyHtml))
        for t in to:
            data.append(("To", t))
        for c in cc:
            data.append(("Cc", c))

        files = []
        for file in attachments:
            file_bytes = await file.read()
            if file_bytes:
                files.append(("Attachments", (file.filename, file_bytes, file.content_type)))

        if not files:
            files.append(("Attachments", ("", b"", "application/octet-stream")))

        response = requests.post(org_api_url, data=data, files=files, timeout=30)

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        return {"success": True, "message": "Reply sent"}

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
    # 🔧 TESTING: Hardcoded email — replace with dynamic user later
    user_email = data.get("userEmail", "ramon.romero@hfmg.net")

    if not name or not message_id:
        raise HTTPException(status_code=400, detail="Missing 'name' or 'messageId'")

    print(f"📥 Download request: '{name}' from message {message_id}")

    # Get the attachment content type from cache (for proper Content-Type header)
    content_type = "application/octet-stream"
    cached_emails = get_cached_emails() or []

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

        update_cache_mark_read(message_id)

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
        
        response = requests.get(contacts_url, timeout=10)
        
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
    
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Contact server timeout")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot reach contact server")
    except Exception as e:
        print(f"❌ search_contacts error: {e}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)