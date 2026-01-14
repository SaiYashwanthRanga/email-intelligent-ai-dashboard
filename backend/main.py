import os
import asyncio
import requests
import uvicorn
import io
import base64
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

# Updated imports
from models import AnalysisRequest, ReplyRequest, ThreadParseRequest, LoginRequest
from services import (
    group_emails_by_subject, 
    detect_real_threads, 
    analyze_single_thread, 
    analyze_single_email, # <--- NEW IMPORT ADDED
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
    normalize_email
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
def fetch_inbox(url: str = "http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count20"):
    try:
        clean_url = url.replace("[", "").replace("]", "").split("(")[0]
        if not clean_url.startswith("http"): clean_url = f"http://{clean_url}"
        print(f"Fetching: {clean_url}")
        resp = requests.get(clean_url, timeout=60)
        return resp.json()
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
        tasks.append(analyze_single_email(e)) # <--- UPDATED LOOP

    analyzed_results = await asyncio.gather(*tasks) # <--- UPDATED VARIABLE NAME
    
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

    return {"emails": analyzed_results, "report": brief} # <--- UPDATED RETURN

@app.post("/api/reply")
async def generate_reply(payload: ReplyRequest):
    reply_text = await draft_email_reply(payload.sender, payload.email_body)
    return {"reply": reply_text}

@app.post("/api/parse-thread")
async def parse_email_thread(payload: ThreadParseRequest):
    return {"segments": [{"type": "latest", "header": "Log", "content": payload.body}]}

# --- NEW DOWNLOAD ENDPOINT ---
@app.post("/api/download")
def download_file(payload: dict):
    try:
        file_name = payload.get("name")
        file_hash = payload.get("hash")
        file_type = payload.get("type", "application/octet-stream")

        if not file_hash:
            raise HTTPException(status_code=400, detail="File data missing")

        file_bytes = base64.b64decode(file_hash)
        file_stream = io.BytesIO(file_bytes)

        return StreamingResponse(
            file_stream,
            media_type=file_type,
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"'
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)