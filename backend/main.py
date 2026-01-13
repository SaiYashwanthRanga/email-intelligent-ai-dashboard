import os
import asyncio
import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Updated imports
from models import AnalysisRequest, ReplyRequest, ThreadParseRequest, LoginRequest
from services import (
    group_emails_by_subject, 
    analyze_single_thread, 
    generate_executive_brief, 
    generate_sender_report,
    draft_email_reply,
    calculate_triage_stats,
    # NEW IMPORTS FOR LEVEL 3
    get_last_processed_timestamp,
    set_last_processed_timestamp,
    get_cached_report,
    save_cached_report,
    get_cached_emails,   # <--- Added
    save_cached_emails   # <--- Added
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
def fetch_inbox(url: str = "http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net"):
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
    if credentials.username == "Jim" and credentials.password == "admin123":
        return {"success": True, "token": "jim-secure-token-v1"}
    else:
        raise HTTPException(status_code=401, detail="Invalid Credentials")

@app.post("/api/analyze")
async def analyze_emails(payload: AnalysisRequest):
    emails = payload.emails
    if not emails: return {"emails": [], "report": None}
    
    # --- LEVEL 3: GLOBAL GATEKEEPER ---
    def get_date_str(e):
        return e.get("receivedDateTime") or e.get("received_at") or e.get("date") or "1970-01-01"
    
    latest_email_ts = max((get_date_str(e) for e in emails), default="1970-01-01")
    last_run_ts = get_last_processed_timestamp()
    
    # Try to load cached enriched emails
    cached_emails = get_cached_emails()

    # 2. Compare: If newest email is NOT newer than last run, AND we have valid cached data
    if last_run_ts and latest_email_ts <= last_run_ts and cached_emails:
        print("⏳ No new emails detected. Returning cached enriched data.")
        cached_report = get_cached_report()
        # SUCCESS: We return the cached *enriched* emails, not the raw payload!
        return {"emails": cached_emails, "report": cached_report}

    print(f"🚀 New Data (or missing cache) Detected. Running Analysis...")

    # --- STANDARD ANALYSIS LOGIC ---
    grouped_data = group_emails_by_subject(emails)
    
    tasks = [analyze_single_thread(subj, msgs) for subj, msgs in grouped_data.items()]
    final_threads = await asyncio.gather(*tasks)
    
    brief_task = generate_executive_brief(final_threads)
    sender_task = generate_sender_report(emails)
    
    brief, sender_summaries = await asyncio.gather(brief_task, sender_task)
    
    triage_data = calculate_triage_stats(emails, final_threads, demo_mode=False)
    
    brief["thread_email_count"] = len(emails)
    brief["thread_attachment_count"] = triage_data["att_total"]
    brief["sender_summaries"] = sender_summaries
    brief["triage_stats"] = triage_data 

    # --- LEVEL 3: SAVE STATE ---
    set_last_processed_timestamp(latest_email_ts)
    save_cached_report(brief)
    save_cached_emails(final_threads) # <--- Save the enriched emails!

    return {"emails": final_threads, "report": brief}

@app.post("/api/reply")
async def generate_reply(payload: ReplyRequest):
    reply_text = await draft_email_reply(payload.sender, payload.email_body)
    return {"reply": reply_text}

@app.post("/api/parse-thread")
async def parse_email_thread(payload: ThreadParseRequest):
    return {"segments": [{"type": "latest", "header": "Log", "content": payload.body}]}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)