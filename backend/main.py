import os
import asyncio
import requests
import uvicorn
import io
import base64
import json
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

# Updated imports - Added get_attachment_bytes
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
    get_attachment_bytes  # <--- NEW IMPORT
)

# 1. LOAD CONFIGURATION
load_dotenv()
origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
origins = [origin.strip() for origin in origins_str.split(",")]

app = FastAPI()

# 2. SECURITY (CORS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins, 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- ENDPOINTS ---

@app.get("/api/fetch-inbox")
def fetch_inbox(url: str = "http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count30"):
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

                    if is_video:
                        # 🚫 Do NOT keep full video in memory
                        att["hash"] = raw_hash[:16]  # Preview only
                        att["full_hash"] = None  # Explicitly don't store full data
                        att["storage"] = "remote"
                        print(f"🎥 Large video detected, skipping Base64 load: {att.get('name')}")
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

        # STEP 1.2 → Debug confirmation
        if data and data[0].get("attachments"):
            print("Hash length after strip:", len(data[0]["attachments"][0]["hash"]))
            print("Original size:", data[0]["attachments"][0]["size"])

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
    
    # Helper to parse dates for comparison. 
    # Handles ISO format including timezone (e.g. 2026-01-12T18:43:01-05:00)
    def get_date_obj(e):
        try:
            return datetime.fromisoformat(e["received_at"])
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
    # This separates emails with reply history (threads) from standalone emails
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
    
    # Briefing only for Real Threads (filter results that are threads for brief)
    # (Since analyzed_results has everything mixed, we filter for threads to generate brief)
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
    # Save as ISO string for consistent future comparisons
    set_last_processed_timestamp(latest_email_ts.isoformat())
    save_cached_report(brief)
    save_cached_emails(analyzed_results)

    return {"emails": analyzed_results, "report": brief} 

@app.post("/api/reply")
async def generate_reply(payload: ReplyRequest):
    reply_text = await draft_email_reply(payload.sender, payload.email_body)
    return {"reply": reply_text}

@app.post("/api/parse-thread")
async def parse_email_thread(payload: ThreadParseRequest):
    return {"segments": [{"type": "latest", "header": "Log", "content": payload.body}]}

# --- OPTIMIZED DOWNLOAD ENDPOINT ---
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

# --- REMOTE FILE DOWNLOAD ENDPOINT (MP3/MP4 and large files from mailbox) ---
@app.post("/api/download-remote-file")
def download_remote_file(payload: dict):
    print("📦 Remote download payload:", payload)

    raise HTTPException(
        status_code=400,
        detail="Mailbox attachment download endpoint not configured yet. Need attachment download URL."
    )

# --- NEW DIRECT ATTACHMENT DOWNLOAD ENDPOINT WITH STREAMING ---
@app.post("/api/download-attachment")
def download_attachment(payload: dict):
    # 1. DEBUG LOGGING: Start
    print("📥 Incoming download request:", payload)
    
    message_id = payload.get("messageId")
    filename = payload.get("name")

    if not message_id or not filename:
        raise HTTPException(status_code=400, detail="messageId and name required")

    # Call mailbox API directly
    inbox_api = "http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count20"
    
    # 2. DEBUG LOGGING: API call
    resp = requests.get(inbox_api, timeout=60)
    print("📨 Mailbox API status:", resp.status_code)
    try:
        print("📨 Mailbox API size:", len(resp.text))
    except:
        pass

    if resp.status_code != 200:
        raise HTTPException(status_code=500, detail="Mailbox API failed")

    mails = resp.json()
    
    # 3. DEBUG LOGGING: Mail count
    print("📧 Total mails received:", len(mails))

    for mail in mails:
        # 4. DEBUG LOGGING: Message ID check
        print("🔍 Checking mail:", mail.get("messageId"))
        
        if mail.get("messageId") == message_id:
            print(f"✅ FOUND Matching Message ID: {message_id}")
            for att in mail.get("attachments", []):
                # 5. DEBUG LOGGING: Attachment Name check
                print("📎 Found attachment:", att.get("name"))
                
                if att.get("name") == filename:
                    print(f"🎯 DOWNLOAD STARTING: {filename}")
                    
                    # --- CRITICAL CHANGE: USE SERVICE HELPER FOR RAW BYTES ---
                    final_name, file_bytes = get_attachment_bytes(att)

                    file_stream = io.BytesIO(file_bytes)

                    headers = {
                        "Content-Disposition": f'attachment; filename="{final_name}"',
                        "Content-Type": "application/octet-stream"
                    }

                    return StreamingResponse(
                        file_stream, 
                        headers=headers
                    )

    print("❌ ERROR: Attachment not found after scanning all emails.")
    raise HTTPException(status_code=404, detail="Attachment not found")

# --- NEW OPTIMIZED FILE STREAMING ENDPOINT (PDF, DOC, Images, MP3, MP4) ---
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

    # Determine disposition: inline for docs/images in preview mode, attachment for videos/audio or download mode
    is_video_or_audio = filetype.startswith("video/") or filetype.startswith("audio/")
    disposition = "attachment" if is_video_or_audio or mode == "download" else "inline" if mode == "preview" else "attachment"

    headers = {
        "Content-Type": filetype,
        "Content-Disposition": f'{disposition}; filename="{filename}"'
    }

    # Get file data - check both "hash" (for video/audio) and "full_hash" (for docs/images)
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