import os
import json
import requests
import traceback
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI

# 1. LOAD CONFIG
load_dotenv()
app = FastAPI()

# 2. SETUP SECURITY
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 3. SETUP AI CLIENT
api_key = os.getenv("OPENAI_API_KEY")
ACTIVE_MODEL = "gpt-4o"

if not api_key:
    print("❌ CRITICAL ERROR: OPENAI_API_KEY is missing from .env file!")

client = OpenAI(api_key=api_key)

class AnalysisRequest(BaseModel):
    emails: List[dict]

class ReplyRequest(BaseModel):
    email_body: str
    sender: str
    subject: str

class ThreadParseRequest(BaseModel):
    body: str

# --- LOGIC ---

def generate_thread_summary(emails):
    """Generates a high-level summary AND groups attachments"""
    print(f"🔹 Generating Thread Summary for {len(emails)} emails...")
    
    # 1. Python Logic: Collect all attachments accurately
    all_thread_files = []
    sender_files_map = {}

    email_text = ""
    for e in emails:
        sender = e.get('from') or e.get('sender') or "Unknown"
        # Collect Text for AI
        email_text += f"From: {sender} | Sub: {e.get('subject')}\nBody: {str(e.get('body'))[:300]}\n---\n"
        
        # Collect Files for Python Report
        if e.get('attachments'):
            for att in e['attachments']:
                file_info = {"file_name": att.get('file_name'), "type": att.get('content_type', 'file'), "sender": sender}
                all_thread_files.append(file_info)
                
                # Group by sender (Simple string matching)
                if sender not in sender_files_map:
                    sender_files_map[sender] = []
                sender_files_map[sender].append(file_info)

    # 2. AI Logic: Generate the insights
    prompt = f"""
    You are an Executive Analyst. Analyze this entire email thread.
    
    OUTPUT JSON ONLY:
    {{
      "thread_title": "Create a professional, short Title (max 8 words).",
      "thread_summary": "Write a detailed paragraph (4-5 sentences) explaining the project status, key players, and decisions.",
      "sender_analysis": [
        {{
          "name": "Sender Name (Exact as appears in From)",
          "role_guess": "Role",
          "summary": "What are they asking for?",
          "email_count": 0
        }}
      ]
    }}

    EMAILS:
    {email_text}
    """
    
    try:
        response = client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "You are a helpful assistant that outputs JSON."}, 
                      {"role": "user", "content": prompt}],
            response_format={ "type": "json_object" },
            temperature=0.0
        )
        report = json.loads(response.choices[0].message.content)

        # 3. Merge Phase: Inject Python File Lists into AI Report
        report["all_thread_files"] = all_thread_files
        
        # Try to match sender files to the AI's sender list
        for sender_obj in report.get("sender_analysis", []):
            name = sender_obj.get("name")
            # Fuzzy match: if the AI name is in the Python sender map key
            attached_files = []
            for key in sender_files_map:
                if name in key or key in name:
                    attached_files.extend(sender_files_map[key])
            
            sender_obj["file_list"] = attached_files
            sender_obj["attachment_count"] = len(attached_files)

        return report

    except Exception as e:
        print(f"⚠️ THREAD SUMMARY FAILED: {e}")
        return {
            "thread_title": "Thread Analysis Failed",
            "thread_summary": "Could not generate summary.",
            "sender_analysis": [],
            "all_thread_files": []
        }

def analyze_individual_emails(emails_batch):
    print(f"🔹 Analyzing Batch of {len(emails_batch)} emails...")
    email_block = ""
    for idx, email in enumerate(emails_batch, start=1):
        email_block += f"ID: {idx} | Body: {str(email.get('body'))[:500]}\n"

    prompt = f"""
    Analyze these emails. Return JSON.
    CRITICAL: Detailed 3-sentence summaries.
    OUTPUT SCHEMA:
    {{
      "analysis": [
          {{
            "category": "URGENT" or "CONFIDENTIAL" or "MEETING" or "NORMAL",
            "priority": 1 to 5,
            "summary": "Detailed explanation.",
            "action": "REPLY" or "REVIEW" or "ARCHIVE"
          }}
      ]
    }}
    DATA:
    {email_block}
    """
    try:
        response = client.chat.completions.create(
            model=ACTIVE_MODEL, 
            messages=[{"role": "system", "content": "You are a helpful assistant that outputs JSON."},
                      {"role": "user", "content": prompt}],
            response_format={ "type": "json_object" },
            temperature=0.0
        )
        result = json.loads(response.choices[0].message.content)
        return result.get("analysis", [])
    except Exception as e:
        return [{"category": "NORMAL", "priority": 1, "summary": "Error analyzing.", "action": "REVIEW"}] * len(emails_batch)

# --- ENDPOINTS ---

@app.get("/api/fetch-inbox")
def fetch_inbox(url: str = "http://172.22.6.145/api/Values/inbox"):
    try:
        clean_url = url.replace("[", "").replace("]", "").split("(")[0]
        if not clean_url.startswith("http"): clean_url = f"http://{clean_url}"
        print(f"Fetching: {clean_url}")
        resp = requests.get(clean_url, timeout=10)
        return resp.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/analyze")
def analyze_emails(payload: AnalysisRequest):
    emails = payload.emails
    if not emails: return {"emails": [], "report": None}
    
    final_emails = []
    chunk_size = 15
    for i in range(0, len(emails), chunk_size):
        chunk = emails[i:i + chunk_size]
        results = analyze_individual_emails(chunk)
        for j, orig in enumerate(chunk):
            if j < len(results):
                final_emails.append({**orig, **results[j]})
            else:
                final_emails.append({**orig, "category": "NORMAL", "summary": "Pending...", "action": "REVIEW"})

    # Send top 30 for Thread Summary to get better context
    thread_report = generate_thread_summary(emails[:30])
            
    return {"emails": final_emails, "report": thread_report}

@app.post("/api/reply")
def generate_reply(payload: ReplyRequest):
    print(f"🔹 Drafting reply...")
    prompt = f"""
    You are Jim Olver-Goshen. Draft a reply.
    CONTEXT: Busy executive. Keep it short, encouraging, and direct.
    INCOMING: From: {payload.sender} | Sub: {payload.subject} | Body: {payload.email_body}
    OUTPUT: Just the body text.
    """
    try:
        response = client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7, max_tokens=1000
        )
        return {"reply": response.choices[0].message.content.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to generate reply")

@app.post("/api/parse-thread")
def parse_email_thread(payload: ThreadParseRequest):
    print("🔹 AI Parsing Email Thread...")
    prompt = f"""
    You are an expert Email Thread Cleaner. 
    Transform RAW email text into a JSON list.
    OUTPUT JSON ONLY: {{ "segments": [ {{ "type": "latest" or "history", "header": "Sender/Date or null", "content": "Clean message body." }} ] }}
    RAW TEXT: {payload.body}
    """
    try:
        response = client.chat.completions.create(
            model=ACTIVE_MODEL,
            messages=[{"role": "system", "content": "You are a helpful assistant that outputs JSON."},
                      {"role": "user", "content": prompt}],
            response_format={ "type": "json_object" }, temperature=0.0
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        return {"segments": [{"type": "latest", "header": None, "content": payload.body}]}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)