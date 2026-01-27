import os
import asyncio
import requests
import uvicorn
import io
import base64
import json
import uuid  # Added for unique file naming
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

# Updated imports
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
    get_attachment_bytes
)

# 1. LOAD CONFIGURATION
load_dotenv()
origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
origins = [origin.strip() for origin in origins_str.split(",")]

# Create temporary directory for heavy attachments
TEMP_DIR = "temp_attachments"
os.makedirs(TEMP_DIR, exist_ok=True)

# Cache file path
CACHE_FILE = Path("db_cache.json")

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
    """
    Update the backend cache to mark an email as read.
    This ensures the email doesn't reappear on next refresh.
    """
    if not CACHE_FILE.exists():
        print(f"⚠️  Cache file not found: {CACHE_FILE}")
        return

    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Update in enriched emails
        emails = data.get("meta_last_enriched_emails", [])
        updated = False
        
        for e in emails:
            if e.get("id") == message_id or e.get("messageId") == message_id:
                e["isRead"] = True
                updated = True
                print(f"✅ Cache: Marked email {message_id} as read in enriched emails")
                break

        # Update in threads if present
        threads = data.get("threads", [])
        for t in threads:
            if t.get("id") == message_id or t.get("messageId") == message_id:
                t["isRead"] = True
                updated = True
                print(f"✅ Cache: Marked email {message_id} as read in threads")
                break

        # Save updated cache only if we made changes
        if updated:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            print(f"💾 Cache file updated successfully")
        else:
            print(f"⚠️  Email {message_id} not found in cache")

    except Exception as e:
        print(f"❌ Failed to update cache: {e}")


# --- ENDPOINTS ---

@app.get("/api/fetch-inbox")
def fetch_inbox(url: str = "http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count10"):
    try:
        clean_url = url.replace("[", "").replace("]", "").split("(")[0]
        if not clean_url.startswith("http"):
            clean_url = f"http://{clean_url}"

        print(f"Fetching inbox from: {clean_url}")

        resp = requests.get(clean_url, timeout=60)
        data = resp.json()

        # STEP 1.1 → Strip heavy Base64 immediately
        for mail in data:
            for att in mail.get("attachments", []):
                if "hash" in att:
                    raw_hash = att["hash"]  # Store ORIGINAL complete hash
                    att["size"] = len(raw_hash)

                    file_name = (att.get("name") or "").lower()

                    # Detect video files
                    is_video = any(file_name.endswith(ext) for ext in [
                        ".mp4", ".mov", ".avi", ".mkv", ".webm"
                    ])

                    # --- STEP 1: CHANGE STORAGE LOGIC TO DISK ---
                    if is_video:
                        # Save large file to disk instead of RAM
                        file_id = f"{uuid.uuid4()}.b64"
                        file_path = os.path.join(TEMP_DIR, file_id)

                        with open(file_path, "w") as f:
                            f.write(raw_hash)

                        att["hash"] = raw_hash[:16]
                        att["full_hash"] = None
                        att["storage"] = "disk"
                        att["file_path"] = file_path

                        print(f"💾 Video saved to disk: {att.get('name')} -> {file_path}")
                    else:
                        # Safe for PDFs, DOCs, images - KEEP THE FULL ORIGINAL HASH
                        att["hash"] = raw_hash[:16]  # Keep preview for UI
                        att["full_hash"] = raw_hash  # Keep COMPLETE data for download
                        att["storage"] = "inline"
                        print(f"✅ File processed: {att.get('name')} | preview hash: {att['hash']} | full_hash len: {len(att['full_hash'])}")
        
        # STEP 1.2 → Debug confirmation
        if data and data[0].get("attachments"):
            print("\n🔍 FIRST EMAIL ATTACHMENTS AFTER PROCESSING:")
            for att in data[0].get("attachments", [])[:2]:
                print(f"  Name: {att.get('name')}")
                print(f"    hash length: {len(att.get('hash', ''))}")
                print(f"    full_hash length: {len(att.get('full_hash', '') or '')}")
                print(f"    storage: {att.get('storage')}")
                print(f"    Keys in att: {list(att.keys())}")
                print()

        # 🔁 STEP 1.3 → FORCE ATTACHMENTS TO EXIST AT EMAIL ROOT LEVEL
        for mail in data:
            combined_attachments = []

            # 1. Normal single email attachments
            if "attachments" in mail and isinstance(mail["attachments"], list):
                combined_attachments.extend(mail["attachments"])

            # 2. If this mail is a thread, pull attachments from messages
            if "messages" in mail and isinstance(mail["messages"], list):
                for msg in mail["messages"]:
                    if "attachments" in msg and isinstance(msg["attachments"], list):
                        combined_attachments.extend(msg["attachments"])

            # 3. Overwrite root attachments with unified list
            mail["attachments"] = combined_attachments

        print(f"\n✅ UNIFICATION COMPLETE: All {len(data)} emails now have attachments at root level")

        # Sort mails by received time (newest first)
        data.sort(
            key=lambda x: datetime.fromisoformat(x.get("received", "1970-01-01T00:00:00")),
            reverse=True
        )

        return data

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/login")
def login(credentials: LoginRequest):
    if credentials.username == "Ramon" and credentials.password == "hfmg@2026":
        return{"success": True, "token": "ramon-secure-token-v1"}
    else:
        raise HTTPException(status_code=401, detail="Invalid Credentials")

@app.post("/api/analyze")
async def analyze_emails(payload: AnalysisRequest):
    # 1. IMMEDIATE NORMALIZATION (Fixes inconsistent keys like messageId vs id)
    emails = [normalize_email(e) for e in payload.emails]
    if not emails: return {"emails": [], "report": None}
    
    # --- DEBUG: CONFIRM ATTACHMENTS ---
    for e in emails:
        if e.get("attachments"):
            print("MAIL WITH ATTACHMENTS:", e.get("subject"), e.get("attachments"))
    # ----------------------------------
    
    # --- LEVEL 3: GLOBAL GATEKEEPER ---
    
    # ✅ CHANGE 1: Helper to parse dates for comparison (with timezone handling)
    def get_date_obj(e):
        try:
            dt = datetime.fromisoformat(e["received_at"])
            if dt.tzinfo:
                dt = dt.astimezone(tz=None).replace(tzinfo=None)
            return dt
        except:
            return datetime(1970, 1, 1)

    # Calculate latest timestamp using Objects, not Strings
    latest_email_ts = max((get_date_obj(e) for e in emails), default=datetime(1970, 1, 1))
    
    last_run_str = get_last_processed_timestamp()
    last_run_ts = None
    
    if last_run_str:
        try:
            last_run_ts = datetime.fromisoformat(last_run_str)
        except:
            last_run_ts = None
    
    # Try to load cached enriched emails
    cached_emails = get_cached_emails()

    # 2. Compare: If newest email is NOT newer than last run, AND we have valid cached data
    if last_run_ts and latest_email_ts <= last_run_ts and cached_emails:
        print("⏳ No new emails detected. Returning cached enriched data.")
        cached_report = get_cached_report()
        return {"emails": cached_emails, "report": cached_report}

    print(f"🚀 New Data (or missing cache) Detected. Running Analysis...")

    # --- STANDARD ANALYSIS LOGIC ---
    
    # 3. REAL THREAD DETECTION (Replaces Subject Grouping)
    real_threads, single_emails = detect_real_threads(emails)

    tasks = []

    # Process Real Threads ONLY (for AI analysis)
    for e in real_threads:
        subject = e.get("subject", "No Subject")
        tasks.append(analyze_single_thread(subject, [e]))

    # Analyze single emails normally (no thread structure)
    for e in single_emails:
        tasks.append(analyze_single_email(e)) 

    analyzed_results = await asyncio.gather(*tasks)
    
    # Briefing only for Real Threads
    threads_only = [t for t in analyzed_results if t.get("thread_count", 1) > 1]
    
    brief_task = generate_executive_brief(threads_only)  
    sender_task = generate_sender_report(emails)
    
    brief, sender_summaries = await asyncio.gather(brief_task, sender_task)
    
    # Stats calculated on ALL results
    triage_data = calculate_triage_stats(emails, analyzed_results, demo_mode=False)
    
    brief["thread_email_count"] = len(emails)
    brief["thread_attachment_count"] = triage_data["att_total"]
    brief["sender_summaries"] = sender_summaries
    brief["triage_stats"] = triage_data 

    # --- LEVEL 3: SAVE STATE ---
    set_last_processed_timestamp(latest_email_ts.isoformat())
    save_cached_report(brief)
    save_cached_emails(analyzed_results)

    # ✅ CHANGE 2: Safe datetime helper for sorting (with timezone handling)
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

# --- OPTIMIZED DOWNLOAD ENDPOINT (Generic) ---
@app.post("/api/download")
def download_file(payload: dict):
    try:
        file_name = payload.get("name")
        storage = payload.get("storage", "inline")
        file_type = payload.get("type", "application/octet-stream")
        file_hash = payload.get("full_hash")

        # Block remote/video files
        if storage == "remote":
            raise HTTPException(
                status_code=403,
                detail="Video files cannot be downloaded. Please use the original email."
            )

        if not file_hash:
            raise HTTPException(
                status_code=400,
                detail=f"File data missing for {file_name}"
            )

        # Decode base64 safely
        try:
            file_bytes = base64.b64decode(file_hash)
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Invalid file data"
            )

        file_stream = io.BytesIO(file_bytes)

        return StreamingResponse(
            file_stream,
            media_type=file_type,
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
                "Cache-Control": "no-store"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail="Download failed")

# --- REMOTE FILE DOWNLOAD ENDPOINT ---
@app.post("/api/download-remote-file")
def download_remote_file(payload: dict):
    print("📦 Remote download payload:", payload)

    raise HTTPException(
        status_code=400,
        detail="Mailbox attachment download endpoint not configured yet. Need attachment download URL."
    )

# --- STEP 2: UPDATE DOWNLOAD API (DISK SUPPORT) ---
@app.post("/api/download-attachment")
def download_attachment(data: dict):
    name = data.get("name")
    message_id = data.get("messageId")

    cached_emails = get_cached_emails()

    for mail in cached_emails:
        # Check both id fields for robustness
        if mail.get("id") == message_id or mail.get("messageId") == message_id:
            for att in mail.get("attachments", []):

                if att["name"] == name:

                    # Small files (Inline in Memory)
                    if att.get("storage") == "inline":
                        file_bytes = base64.b64decode(att["full_hash"])
                        return StreamingResponse(
                            io.BytesIO(file_bytes),
                            media_type=att.get("type"),
                            headers={"Content-Disposition": f'attachment; filename="{name}"'}
                        )

                    # Large files (Saved on Disk)
                    if att.get("storage") == "disk":
                        file_path = att.get("file_path")

                        if not file_path or not os.path.exists(file_path):
                            raise HTTPException(status_code=404, detail="File not found on disk")

                        print(f"💾 Loading large file from disk: {file_path}")

                        with open(file_path, "r") as f:
                            base64_data = f.read()

                        file_bytes = base64.b64decode(base64_data)

                        return StreamingResponse(
                            io.BytesIO(file_bytes),
                            media_type=att.get("type"),
                            headers={"Content-Disposition": f'attachment; filename="{name}"'}
                        )

    raise HTTPException(status_code=404, detail="Attachment not found")

# --- MARK AS READ ENDPOINT (CORS-SAFE PROXY) ---
@app.post("/api/mark-read")
def mark_mail_as_read(payload: dict = Body(...)):
    """
    Mark an email as read in the organization mailbox.
    Updates:
    1. Organization mailbox (source of truth)
    2. Backend cache (so it doesn't reappear on refresh)
    3. Returns success to frontend (which already updated its state)
    """
    try:
        email = payload.get("email")
        message_id = payload.get("messageId")

        if not email or not message_id:
            raise HTTPException(status_code=400, detail="Missing email or messageId")

        org_api_url = "http://172.22.6.145/api/Values/mail/read-status"

        params = {
            "email": email,
            "messageId": message_id,
            "isRead": True
        }

        print(f"📩 Calling org mailbox API with params: {params}")

        # Call organization mailbox API
        resp = requests.post(org_api_url, params=params, timeout=20)

        print(f"📬 Org API response: {resp.status_code} | {resp.text}")

        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Organization API error: {resp.text}"
            )

        # 🔥 STEP 2: Update backend cache to match organization mailbox
        print(f"🔄 Updating backend cache for message {message_id}...")
        update_cache_mark_read(message_id)

        return {
            "success": True,
            "message": "Email marked as read in organization inbox and cache updated"
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error in mark-read endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- FILE STREAMING ENDPOINT ---
@app.post("/api/file-stream")
async def file_stream(request: Request, mode: str = "preview"):
    payload = None
    content_type = request.headers.get("content-type", "")
    print("📥 file-stream Content-Type:", content_type)

    # Try FORM first (Preview)
    try:
        form = await request.form()
        if form:
            print("📄 Form keys:", list(form.keys()))
            raw = form.get("payload")
            print("📄 Raw payload from form:", raw)

            if raw and raw.strip():
                payload = json.loads(raw)
    except Exception as e:
        print("⚠️ Form parse failed:", e)

    # If no payload yet, try JSON (Download)
    if payload is None:
        try:
            payload = await request.json()
            print("📦 Payload from JSON:", payload)
        except Exception as e:
            print("⚠️ JSON parse failed:", e)

    # Final guard
    if not payload:
        raise HTTPException(status_code=400, detail="No payload received in request")

    filename = payload.get("name", "file")
    filetype = payload.get("type", "application/octet-stream")

    # Determine disposition
    is_video_or_audio = filetype.startswith("video/") or filetype.startswith("audio/")
    disposition = "attachment" if is_video_or_audio or mode == "download" else "inline" if mode == "preview" else "attachment"

    headers = {
        "Content-Type": filetype,
        "Content-Disposition": f'{disposition}; filename="{filename}"'
    }

    # Get file data
    file_hash = payload.get("hash") or payload.get("full_hash")

    if not file_hash:
        raise HTTPException(status_code=400, detail="File hash missing")

    try:
        binary = base64.b64decode(file_hash)
        print(f"✅ Decoded {filename} ({len(binary)} bytes)")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Base64 decode failed: {e}")

    return StreamingResponse(
        io.BytesIO(binary),
        headers=headers,
        media_type=filetype
    )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)