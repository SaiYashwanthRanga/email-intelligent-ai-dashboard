import streamlit as st
import json
import os
import time
import pandas as pd
import requests  # Added for API calls
from datetime import datetime
from typing import List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed

import anthropic
from dotenv import load_dotenv

# ============================================================
# ENV SETUP
# ============================================================

load_dotenv()
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
BATCH_SIZE = 10          
MAX_WORKERS = 5         

# ============================================================
# STREAMLIT CONFIG
# ============================================================

st.set_page_config(
    page_title="Enterprise Email Intelligence",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ============================================================
# CLAUDE CLIENT
# ============================================================

@st.cache_resource
def get_claude_client():
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        st.error("⚠️ ANTHROPIC_API_KEY not found in .env file")
        st.stop()
    return anthropic.Anthropic(api_key=api_key)

# ============================================================
# UTILS
# ============================================================

def format_date(iso_str):
    """Converts ISO string to friendly format"""
    if not iso_str: return "Unknown Date"
    try:
        clean_iso = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_iso)
        return dt.strftime("%b %d, %I:%M %p")
    except:
        return str(iso_str)

def fetch_data_from_api(url):
    """Fetches email data from the provided API endpoint"""
    try:
        # Ensure URL has schema
        if not url.startswith("http"):
            url = f"http://{url}"
            
        with st.spinner(f"Connecting to {url}..."):
            response = requests.get(url, timeout=10)
            response.raise_for_status() # Raise error for bad status codes
            data = response.json()
            
            if isinstance(data, list):
                return data
            else:
                st.error("API returned data, but it wasn't a list of emails.")
                return None
    except requests.exceptions.RequestException as e:
        st.error(f"API Connection Error: {e}")
        return None
    except json.JSONDecodeError:
        st.error("API returned invalid JSON.")
        return None

# ============================================================
# AI LOGIC
# ============================================================

def analyze_email_batch(client, emails: List[Dict]) -> List[Dict]:
    email_block = ""
    for idx, email in enumerate(emails, start=1):
        # Safety checks for missing keys
        body_preview = email.get('body', '') or ''
        body_preview = body_preview[:800].replace("\n", " ")
        
        atts = email.get('attachments', [])
        att_str = ", ".join([a.get('file_name', '') for a in atts]) if atts else "None"

        email_block += (
            f"ID: {idx} | Date: {email.get('received_at', 'Unknown')} | "
            f"From: {email.get('from', 'Unknown')} | Attachments: {att_str} | "
            f"Subject: {email.get('subject', 'No Subject')} | Body: {body_preview}\n"
        )

    prompt = f"""
You are an Executive Assistant. Analyze these {len(emails)} emails.

INPUT DATA:
{email_block}

TASK:
Return a JSON ARRAY of {len(emails)} objects.
No markdown, no conversation, just JSON.

SCHEMA:
{{
  "category": "URGENT", "CONFIDENTIAL", "MEETING", "FYI", or "NORMAL",
  "priority": Integer 1 (Low) to 5 (Critical),
  "summary": "Clear, direct executive summary (max 20 words)",
  "action": "APPROVE", "REPLY", "REVIEW", or "ARCHIVE",
  "deadline": "Extract date/time if present, else null"
}}

RULES:
- Money/Legal/Press = Priority 4 or 5.
- Action needed today = URGENT.
"""

    try:
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2000,
            temperature=0.0,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        
        if "```" in text:
            text = text.split("```")[-2] if "```json" in text else text.split("```")[1]
            if text.startswith("json"): text = text[4:]
            
        return json.loads(text.strip())

    except Exception as e:
        print(f"AI Error: {e}")
        return []

def process_emails(client, emails: List[Dict], progress_callback=None):
    results = []
    batches = [emails[i:i+BATCH_SIZE] for i in range(0, len(emails), BATCH_SIZE)]
    completed = 0
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(analyze_email_batch, client, b): b for b in batches}

        for future in as_completed(futures):
            batch = futures[future]
            try:
                analysis = future.result()
                # Fallback if analysis fails or length mismatch
                if not analysis or len(analysis) != len(batch):
                    analysis = [{"category": "NORMAL", "priority": 1, "summary": "Analysis failed", "action": "REVIEW"}] * len(batch)
                
                for orig, res in zip(batch, analysis):
                    results.append({**orig, **res})
            except:
                for orig in batch:
                    results.append({**orig, "category": "NORMAL", "priority": 1, "summary": "Error", "action": "REVIEW"})
            
            completed += len(batch)
            if progress_callback: progress_callback(completed, len(emails))

    return results

# ============================================================
# UI RENDERER (NATIVE STREAMLIT)
# ============================================================

def render_email_card(email):
    # Determine colors for Native Markdown
    cat_color = {
        "URGENT": "red",
        "CONFIDENTIAL": "orange",
        "MEETING": "blue",
        "NORMAL": "green",
        "FYI": "gray"
    }.get(email.get('category', 'NORMAL'), "gray")
    
    with st.container(border=True):
        c1, c2 = st.columns([0.85, 0.15])
        with c1:
            st.markdown(f"#### {email.get('subject', 'No Subject')}")
        with c2:
            st.markdown(f":{cat_color}-background[**{email.get('category', 'NORMAL')}**]")

        st.caption(f"👤 **From:** {email.get('from', 'Unknown')}  |  🕒 {format_date(email.get('received_at'))}")
        
        st.info(email.get('summary', 'No summary available'), icon="📝")
        
        f1, f2, f3 = st.columns([2, 2, 2])
        
        with f1:
            st.markdown(f"**Action:** `{email.get('action', 'REVIEW')}`")
        
        with f2:
            priority = email.get('priority', 1)
            stars = "⭐" * priority
            st.markdown(f"**Priority:** {stars}")
            
        with f3:
            if email.get('deadline'):
                st.error(f"📅 **Due:** {email['deadline']}")

        attachments = email.get('attachments', [])
        if attachments:
            with st.expander(f"📎 Attachments ({len(attachments)})"):
                for att in attachments:
                    fname = att.get('file_name', 'Unknown')
                    ftype = att.get('file_type', 'file').upper()
                    st.markdown(f"- **[{ftype}]** {fname}")

# ============================================================
# MAIN APP
# ============================================================

def main():
    st.title("🎯 Enterprise Email Intelligence")
    
    if "data" not in st.session_state: st.session_state.data = None
    client = get_claude_client()

    with st.sidebar:
        st.header("1. Data Source")
        
        # SOURCE SELECTION TAB
        source_mode = st.radio("Choose Source:", ["Upload JSON", "Live API"], index=1)
        
        raw_data = None
        
        if source_mode == "Upload JSON":
            uploaded_file = st.file_uploader("Upload JSON", type="json")
            if uploaded_file:
                raw_data = json.load(uploaded_file)
                st.success(f"Loaded {len(raw_data)} emails")
                
        elif source_mode == "Live API":
            api_url = st.text_input("API URL", "http://172.22.6.145/api/Values/inbox")
            if st.button("🔌 Fetch Data"):
                raw_data = fetch_data_from_api(api_url)
                if raw_data:
                    st.success(f"Fetched {len(raw_data)} emails")
                    # Store temporarily in session state so it doesn't vanish on rerun
                    st.session_state.fetched_data = raw_data

        # If we fetched data previously, use it
        if source_mode == "Live API" and "fetched_data" in st.session_state and raw_data is None:
            raw_data = st.session_state.fetched_data

        if raw_data:
            st.divider()
            limit = st.slider("Analyze First N Emails", 5, 200, 20)
            
            if st.button("🚀 Start Analysis", type="primary"):
                progress = st.progress(0)
                status = st.empty()
                
                # Slicing the data based on slider
                subset = raw_data[:limit]
                
                results = process_emails(client, subset, 
                                      lambda d, t: (progress.progress(d/t), status.text(f"Processing {d}/{t}...")))
                
                st.session_state.data = pd.DataFrame(results)
                status.success("Complete!")
                time.sleep(0.5)
                st.rerun()

    # DASHBOARD DISPLAY
    if st.session_state.data is not None:
        df = st.session_state.data
        
        # METRICS ROW
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Total Emails", len(df))
        m2.metric("High Priority", len(df[df['priority'] >= 4]))
        m3.metric("Urgent", len(df[df['category'] == 'URGENT']))
        m4.metric("Deadlines", df['deadline'].notna().sum() if 'deadline' in df.columns else 0)
        
        st.divider()
        
        # TABS
        t1, t2 = st.tabs(["📝 Email Feed", "📊 Analytics"])
        
        with t1:
            c1, c2, c3 = st.columns([1,1,2])
            cat_filter = c1.multiselect("Filter Category", df['category'].unique())
            prio_filter = c2.slider("Min Priority", 1, 5, 1)
            search_txt = c3.text_input("Search")
            
            view = df.copy()
            if cat_filter: view = view[view['category'].isin(cat_filter)]
            view = view[view['priority'] >= prio_filter]
            if search_txt: 
                view = view[view['subject'].str.contains(search_txt, case=False) | view['summary'].str.contains(search_txt, case=False)]
            
            st.caption(f"Showing {len(view)} emails")
            
            for _, row in view.iterrows():
                render_email_card(row)
                
        with t2:
            st.subheader("Analysis")
            st.bar_chart(df['category'].value_counts())
            
    else:
        st.info("👈 Please select a data source (JSON or API) in the sidebar to begin.")

if __name__ == "__main__":
    main()