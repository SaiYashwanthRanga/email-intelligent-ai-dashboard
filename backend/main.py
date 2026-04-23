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

import logging

# ── App logger ──
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("hfmg")

# ── Silence uvicorn access log (kills the per-request flood) ──
logging.getLogger("uvicorn.access").setLevel(logging.ERROR)
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
from services import (
    group_emails_by_subject,
    split_reply_chain,
    analyze_single_thread,
    analyze_single_email,
    analyze_emails_batch,
    generate_executive_brief,
    generate_daily_digest,
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

# ─── BACKGROUND ANALYSIS JOB STORE ───
# Keyed by user_email → { "status": "running"|"done", "results": [...] }
_analysis_jobs: dict = {}

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
    """Mark a message as read in ALL per-user cache layers."""
    if not user_email:
        return
    try:
        from services import load_cache, save_cache, _cache_file_for
        data = load_cache(user_email)
        updates = {}

        # ── Layer 1: meta_last_enriched_emails (email list cache) ──
        emails = data.get("meta_last_enriched_emails", [])
        list_updated = False
        for e in emails:
            if e.get("id") == message_id or e.get("messageId") == message_id:
                e["isRead"] = True
                list_updated = True
                break
        if list_updated:
            updates["meta_last_enriched_emails"] = emails

        # BUG FIX #3: Also update meta_emails_by_id (the ID cache that /api/analyze
        # reads on every refresh).  Without this fix the ID cache kept returning
        # isRead=False for a message even after /api/mark-read succeeded, causing
        # the email to flicker back to "unread" on the next sync.
        id_cache = data.get("meta_emails_by_id", {})
        if message_id in id_cache:
            id_cache[message_id]["isRead"] = True
            updates["meta_emails_by_id"] = id_cache

        if updates:
            save_cache(updates, user_email)

    except Exception as e:
        log.error(f"Failed to update read cache: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# EWS ATTACHMENT DOWNLOAD HELPER
# GET /api/Values/attachments/download
#   ?messageId=...&attachmentId=...&targetUserEmail=...
# ─────────────────────────────────────────────────────────────────────────────
async def fetch_attachment_bytes(message_id: str, attachment_id: str, user_email: str) -> bytes:
    url    = f"{ORG_BASE}/api/Values/attachments/download"
    params = {"messageId": message_id, "attachmentId": attachment_id, "targetUserEmail": user_email}
    log.debug(f"Attachment download: user={user_email} msg={message_id[:20]}...")
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.get(url, params=params)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code,
                            detail=f"Attachment server error {resp.status_code}: {resp.text[:200]}")
    return resp.content


# --- ENDPOINTS ---

@app.post("/api/login")
async def login(credentials: LoginRequest):
    try:
        org_login_url = f"{ORG_BASE}/login"
        log.debug(f"Login attempt: {credentials.email}")

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                org_login_url,
                json={"email": credentials.email, "password": credentials.password}
            )

        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid email or password")

        user_data = response.json()
        log.info(f"Login OK: {credentials.email}")
        return user_data

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Login server timeout.")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot connect to login server.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Login error: {e}")
        raise HTTPException(status_code=500, detail="Login failed.")


@app.get("/api/email-details")
async def get_email_details(messageId: str, userEmail: str):
    """
    Full email details: TO, CC, body, attachments with attachmentId.
    Called on every email click to populate the detail panel.
    .NET: GET /api/Values/inbox/onemail?messageId=...&targetUserEmail=...

    NOTE: The .NET DTO returns hasAttachments:false even when files exist.
    We compute it from attachments.length.
    """
    if not messageId or not userEmail:
        raise HTTPException(status_code=400, detail="Missing messageId or userEmail")

    org_url = f"{ORG_BASE}/api/Values/inbox/onemail"
    params  = {"messageId": messageId, "targetUserEmail": userEmail}
    log.debug(f"email-details: {messageId[:20]}... user={userEmail}")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(org_url, params=params)

        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code,
                                detail=f"Mail server error: {resp.text[:300]}")

        data     = resp.json()
        raw_atts = data.get("attachments") or []

        data["attachments"] = [
            {
                "name":         att.get("name", ""),
                "type":         att.get("type", "application/octet-stream"),
                "size":         att.get("size", 0),
                "attachmentId": att.get("attachmentId") or att.get("AttachmentId", ""),
                "storage":      "api",
                "messageId":    messageId,
            }
            for att in raw_atts if isinstance(att, dict)
        ]
        data["hasAttachments"] = len(data["attachments"]) > 0

        log.debug(f"email-details OK: {len(data['attachments'])} attachments")
        return data

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Mail server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")
    except Exception as e:
        log.error(f"get_email_details error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fetch-inbox")
def fetch_inbox(email: str):
    try:
        # Build the org server inbox URL from the email address.
        # Route template: GET /api/Values/inbox/{mail}/count{num}
        # "count" and the number share the same path segment — no slash between them.
        clean_email = unquote(email).strip()
        clean_url = f"{ORG_BASE}/api/Values/inbox/{clean_email}/count700"

        log.debug(f"Fetching org inbox: {clean_url}")

        resp = requests.get(clean_url, timeout=120)

        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text}"
            )

        raw = resp.json()

        # ─── FIX: Unwrap PagedMailResponse if .NET returns the paged shape ───
        # Old shape: [ {...}, {...} ]          (flat list)
        # New shape: { "mails": [...], "currentPage": 1, "pageSize": 700, "hasMore": false }
        # We support both so a .NET rollback never breaks this endpoint.
        if isinstance(raw, dict):
            data = raw.get("mails", [])
            log.debug(
                f"PagedMailResponse received — page={raw.get('currentPage')} "
                f"size={raw.get('pageSize')} hasMore={raw.get('hasMore')} "
                f"count={len(data)}"
            )
        else:
            # Legacy flat-list response — still works as before
            data = raw if isinstance(raw, list) else []
            log.debug(f"Flat list response received — count={len(data)}")

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
                    att["messageId"] = parent_id       # stamp parent ID so download can find it

                    log.debug(f"Stripped attachment: {att.get('name')}")

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
                                att["messageId"] = parent_id   # stamp parent ID
                            combined.append(att)

            mail["attachments"] = combined

        log.debug(f"Processed {len(data)} emails from inbox fetch")

        def _sort_key(x):
            raw = x.get("received") or x.get("received_at") or ""
            try:
                return datetime.fromisoformat(raw).timestamp()
            except Exception:
                return 0.0

        data.sort(key=_sort_key, reverse=True)

        return data

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"fetch_inbox error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/analyze")
async def analyze_emails(payload: AnalysisRequest):
    user_email = payload.user_email if hasattr(payload, "user_email") and payload.user_email else "default"
    emails = [normalize_email(e) for e in payload.emails]

    if not emails:
        save_cached_emails([], user_email)
        set_last_email_count(0, user_email)
        return {"emails": [], "report": None, "analyzing": False}

    # ─── STEP 1: Split cached vs new (instant) ───
    cached_by_id = get_cached_emails_by_id(user_email)
    cached_results = []
    new_emails = []
    # Track which primary thread IDs have already been added so secondary
    # message IDs (which are _threadRef pointers) don't produce duplicate
    # copies of the same thread in the response.
    seen_primary_ids = set()

    for email in emails:
        eid = email.get("id") or email.get("messageId")
        if eid and eid in cached_by_id:
            cached_entry = cached_by_id[eid]

            # ── Resolve _threadRef pointer ──
            # Secondary IDs store only {id, messageId, _threadRef: primary_id}.
            # Resolve to the primary thread result so we return the full object.
            # If the primary is already in cached_results, skip — don't duplicate.
            ref_id = cached_entry.get("_threadRef")
            if ref_id:
                if ref_id in seen_primary_ids:
                    # Primary already included — skip this secondary ref entirely
                    continue
                primary = cached_by_id.get(ref_id)
                if primary and not primary.get("_threadRef"):
                    # Use the primary thread result
                    cached_email = primary.copy()
                    cached_email["isRead"] = email.get("isRead", cached_email.get("isRead", False))
                    cached_results.append(cached_email)
                    seen_primary_ids.add(ref_id)
                else:
                    # Primary not found — treat as new so it gets re-analysed
                    new_emails.append(email)
                continue

            # ── Normal cache hit (no pointer) ──
            primary_id = cached_entry.get("id") or cached_entry.get("messageId") or eid
            if primary_id in seen_primary_ids:
                continue
            cached_email = cached_entry.copy()
            cached_email["isRead"] = email.get("isRead", cached_email.get("isRead", False))
            cached_results.append(cached_email)
            seen_primary_ids.add(primary_id)
        else:
            new_emails.append(email)

    log.debug(f"Cache hit: {len(cached_results)} | New: {len(new_emails)}")

    # ─── STEP 2: Return cached emails IMMEDIATELY, fire AI in background ───
    # Mark new emails as "analyzing" with placeholder values so UI renders instantly
    placeholder_emails = []
    for e in new_emails:
        placeholder = e.copy()
        placeholder["category"] = "NORMAL"
        placeholder["priority"] = 1
        placeholder["summary"] = "Analyzing..."
        placeholder["action"] = "REVIEW"
        placeholder["analyzing"] = True
        placeholder_emails.append(placeholder)

    # Merge cached + placeholders for instant response
    all_immediate = cached_results + placeholder_emails
    seen = {}
    no_id_emails = []
    for e in all_immediate:
        eid = e.get("id") or e.get("messageId")
        if eid:
            seen[eid] = e
        else:
            no_id_emails.append(e)   # keep no-ID emails — never deduplicate them
    all_immediate = list(seen.values()) + no_id_emails

    def safe_datetime(val):
        try:
            dt = datetime.fromisoformat(val)
            if dt.tzinfo:
                dt = dt.astimezone(tz=None).replace(tzinfo=None)
            return dt
        except:
            return datetime(1970, 1, 1)

    all_immediate.sort(
        key=lambda x: safe_datetime(x.get("received_at", "1970-01-01T00:00:00")),
        reverse=True
    )

    cached_report = get_cached_report(user_email)
    set_last_email_count(len(emails), user_email)

    # If no new emails, return instantly — no background job needed
    if not new_emails:
        log.debug("All cached — instant return")
        return {"emails": all_immediate, "report": cached_report, "analyzing": False}

    # ─── STEP 3: Fire background AI analysis ───
    _analysis_jobs[user_email] = {"status": "running", "results": [], "report": None}

    async def run_background_analysis():
        def sanitize_batch(email_list):
            for e in email_list:
                atts = e.get("attachments")
                if atts:
                    e["attachments"] = [
                        {
                            "name":         a.get("name"),
                            "type":         a.get("type"),
                            "size":         a.get("size"),
                            "storage":      a.get("storage"),
                            "messageId":    a.get("messageId"),
                            "attachmentId": a.get("attachmentId"),  # required for download
                            "full_hash":    None,
                        }
                        for a in atts if isinstance(a, dict) and a.get("name") and a.get("attachmentId")
                    ]
                e["cc"] = e.get("cc") if isinstance(e.get("cc"), list) else []
                e["to"] = e.get("to") if isinstance(e.get("to"), list) else []
                e["category"] = (e.get("category") or "NORMAL").upper()
                e["analyzing"] = False
            return email_list

        def push_results(batch):
            """Sanitize, cache under all message IDs, and expose to poll endpoint."""
            sanitize_batch(batch)
            # For thread results, index the full result under the PRIMARY id,
            # and store a lightweight pointer under every secondary message ID.
            # This prevents the next sync from returning N identical copies of
            # the same thread (one per constituent message ID) which caused the
            # Insights page to show the same briefing card N times.
            to_cache = []
            for e in batch:
                to_cache.append(e)
                parent_id = e.get("id") or e.get("messageId")
                for mid in (e.get("allMessageIds") or []):
                    if mid and mid != parent_id:
                        # Store only a pointer — resolved to the primary on load
                        to_cache.append({
                            "id": mid,
                            "messageId": mid,
                            "_threadRef": parent_id   # ← marks this as a secondary ref
                        })
            save_emails_to_id_cache(to_cache, user_email)
            _analysis_jobs[user_email]["results"].extend(batch)
            log.debug(f"Pushed {len(batch)} emails to job store")

        try:
            # ── Sort new emails newest-first so top-of-inbox gets analyzed first ──
            def safe_dt(e):
                for key in ("received_at", "received", "date"):
                    val = e.get(key)
                    if val:
                        try:
                            from datetime import datetime as _dt
                            dt = _dt.fromisoformat(str(val))
                            if dt.tzinfo:
                                dt = dt.astimezone(tz=None).replace(tzinfo=None)
                            return dt
                        except:
                            pass
                return datetime(1970, 1, 1)

            new_emails_sorted = sorted(new_emails, key=safe_dt, reverse=True)

            # ── Group by conversationId — Exchange's authoritative thread key ──
            # All emails sharing a conversationId are analysed together in one
            # analyze_single_thread call so the AI sees the full conversation
            # and produces one coherent summary.
            from collections import defaultdict as _dd
            conv_groups = _dd(list)
            for e in new_emails_sorted:
                key = e.get("conversationId") or e.get("id") or e.get("messageId")
                conv_groups[key].append(e)

            thread_groups = []   # (conv_id, [emails]) — true multi-email threads
            #                       OR single emails with an embedded reply chain
            single_emails = []   # true single-message emails

            for conv_id, group in conv_groups.items():
                if len(group) > 1:
                    # Multiple emails share this conversationId → definite thread
                    group.sort(key=safe_dt, reverse=True)   # newest first
                    thread_groups.append((conv_id, group))
                else:
                    e = group[0]
                    # Single email — check if its body contains an embedded
                    # reply chain (e.g. a forwarded thread in one message)
                    raw_body  = str(e.get("body") or "")
                    sender    = e.get("from") or "Unknown"
                    date      = e.get("received_at") or e.get("date") or "Unknown"
                    split_msgs = split_reply_chain(raw_body, sender, date, e.get("attachments", []))
                    if len(split_msgs) > 1:
                        thread_groups.append((conv_id, group))
                    else:
                        single_emails.append(e)

            # ── 1. Threads: fire all concurrently, push EACH as it finishes ──
            if thread_groups:
                thread_coros = [
                    analyze_single_thread(
                        group[0].get("subject", "No Subject"),
                        group,          # ALL emails in the conversation
                        user_email,
                        conv_id
                    )
                    for conv_id, group in thread_groups
                ]
                for coro in asyncio.as_completed(thread_coros):
                    result = await coro
                    push_results([result])

            # ── 2. Singles: process one chunk at a time, push per chunk ──
            CHUNK_SIZE = 20
            for chunk_start in range(0, len(single_emails), CHUNK_SIZE):
                chunk = single_emails[chunk_start:chunk_start + CHUNK_SIZE]
                chunk_results = await analyze_emails_batch(chunk)
                push_results(chunk_results)

            # ── 3. Generate report from all completed results ──
            all_done = _analysis_jobs[user_email]["results"]
            all_results = cached_results + all_done
            deduped = {}
            no_id_list = []
            for e in all_results:
                eid = e.get("id") or e.get("messageId")
                if eid:
                    deduped[eid] = e
                else:
                    no_id_list.append(e)
            all_results = list(deduped.values()) + no_id_list

            threads_only = [t for t in all_results if t.get("thread_count", 1) > 1]
            brief_task   = generate_executive_brief(threads_only)
            sender_task  = generate_sender_report(emails)
            digest_task  = generate_daily_digest(all_results)
            brief, sender_summaries, daily_digest = await asyncio.gather(
                brief_task, sender_task, digest_task
            )

            triage_data = calculate_triage_stats(emails, all_results, user_identifier=user_email, demo_mode=False)
            brief["thread_email_count"]   = len(emails)
            brief["thread_attachment_count"] = triage_data["att_total"]
            brief["sender_summaries"]     = sender_summaries
            brief["triage_stats"]         = triage_data
            brief["daily_digest"]         = daily_digest
            save_cached_report(brief, user_email)
            save_cached_emails(all_results, user_email)

            _analysis_jobs[user_email]["status"] = "done"
            _analysis_jobs[user_email]["report"] = brief
            log.info(f"Analysis done for {user_email}: {len(all_done)} emails")

        except Exception as ex:
            log.error(f"Background analysis failed: {ex}")
            _analysis_jobs[user_email]["status"] = "error"

    asyncio.create_task(run_background_analysis())

    return {
        "emails": all_immediate,
        "report": cached_report,
        "analyzing": True
    }


@app.get("/api/analysis-updates")
async def get_analysis_updates(user_email: str = "default", since: int = 0):
    """
    Poll this endpoint after /api/analyze returns analyzing:true.
    Pass `since` = number of results already received to get only NEW ones.
    Returns incrementally as each email/chunk finishes.
    """
    job = _analysis_jobs.get(user_email)
    if not job:
        return {"status": "none", "new_results": [], "total": 0, "report": None}

    all_results = job["results"]
    new_results = all_results[since:]   # only send what frontend hasn't seen yet

    return {
        "status": job["status"],
        "new_results": new_results,
        "total": len(all_results),
        "report": job["report"] if job["status"] == "done" else None
    }


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
    targetUserEmail: str = Form(None),
    isReplyAll: str = Form("false")
):
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/reply"

        # Use files= for ALL parts — httpx handles duplicate keys (multiple To/Cc) reliably this way
        parts = []
        parts.append(("MessageItemId", (None, messageItemId, "text/plain")))
        parts.append(("ReplyBodyHtml", (None, replyBodyHtml, "text/plain")))
        parts.append(("IsReplyAll", (None, isReplyAll, "text/plain")))
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


@app.post("/api/forward-email")
async def forward_email(request: Request):
    try:
        form = await request.form()

        # ── Pull fields manually so we can log exactly what arrived ──
        messageItemId   = form.get("messageItemId") or form.get("MessageItemId")
        forwardBodyHtml = form.get("forwardBodyHtml") or form.get("body") or ""
        targetUserEmail = form.get("targetUserEmail") or ""

        to_list = form.getlist("to") or form.getlist("To")
        cc_list = form.getlist("cc") or form.getlist("Cc")

        log.warning(f"[forward] messageItemId={messageItemId!r} to={to_list} cc={cc_list} targetUser={targetUserEmail!r}")

        if not messageItemId:
            raise HTTPException(status_code=400, detail="Missing messageItemId")
        if not to_list:
            raise HTTPException(status_code=400, detail="Missing 'to' recipients")

        org_api_url = f"{ORG_BASE}/api/Values/forwardmail"
        # targetUserEmail is now [FromForm] — must go in parts, not query param

        parts = []
        parts.append(("MessageItemId", (None, messageItemId, "text/plain")))
        parts.append(("Body",          (None, forwardBodyHtml, "text/plain")))
        parts.append(("Subject",       (None, "", "text/plain")))  # DTO has Subject field, send empty
        parts.append(("targetUserEmail", (None, targetUserEmail, "text/plain")))
        for t in to_list:
            if t.strip():
                parts.append(("ToList", (None, t.strip(), "text/plain")))
        for c in cc_list:
            if c.strip():
                parts.append(("CcList", (None, c.strip(), "text/plain")))

        # Handle file attachments from the form
        attachments = form.getlist("attachments")
        has_file = False
        for file in attachments:
            if hasattr(file, "read"):
                file_bytes = await file.read()
                if file_bytes:
                    parts.append(("Attachments", (file.filename, file_bytes, file.content_type)))
                    has_file = True

        if not has_file:
            parts.append(("Attachments", ("", b"", "application/octet-stream")))

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(org_api_url, files=parts)

        log.warning(f"[forward] .NET response: {response.status_code} — {response.text[:200]}")

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        return {"success": True, "message": "Email forwarded"}

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[forward] exception: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/download-attachment")
async def download_attachment(data: dict):
    """
    Download via EWS.
    Body: { messageId, attachmentId, name, type, userEmail }
    Proxies to: GET /api/Values/attachments/download
                  ?messageId=...&attachmentId=...&targetUserEmail=...
    """
    message_id    = data.get("messageId")
    attachment_id = data.get("attachmentId")
    name          = data.get("name")
    user_email    = data.get("userEmail", "")
    content_type  = data.get("type") or "application/octet-stream"

    if not message_id:
        raise HTTPException(status_code=400, detail="Missing 'messageId'")
    if not attachment_id:
        raise HTTPException(status_code=400, detail="Missing 'attachmentId'")
    if not name:
        raise HTTPException(status_code=400, detail="Missing 'name'")
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing 'userEmail'")

    log.debug(f"Download: {name} | msg={message_id[:20]}... | att={attachment_id[:20]}...")

    try:
        file_bytes = await asyncio.wait_for(
            fetch_attachment_bytes(message_id, attachment_id, user_email),
            timeout=110
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504,
            detail=f"Download timed out for '{name}'. Large files may take longer — please retry.")

    log.debug(f"Streaming: {name} ({len(file_bytes):,} bytes)")

    def iter_file(raw: bytes, chunk_size: int = 256 * 1024):
        for i in range(0, len(raw), chunk_size):
            yield raw[i:i + chunk_size]

    return StreamingResponse(
        iter_file(file_bytes),
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length":      str(len(file_bytes)),
            "Cache-Control":       "no-store",
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


@app.get("/api/mail-stats")
async def get_mail_stats(userEmail: str, count: int = 700):
    """
    Proxy: GET /api/Values/mail/unread/count?targetUserEmail=...&count=...
    Returns exact triage stats from EWS:
      unreadCount, totalAttachments, totalToRecipients,
      totalCcRecipients, fileTypeCounts
    """
    org_url = f"{ORG_BASE}/api/Values/mail/unread/count"
    params  = {"targetUserEmail": userEmail, "count": count}
    log.debug(f"mail-stats: user={userEmail} count={count}")
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(org_url, params=params)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code,
                                detail=f"Mail stats error: {resp.text[:200]}")
        return resp.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Mail stats timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")
    except Exception as e:
        log.error(f"get_mail_stats error: {e}")
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
        log.debug(f"Searching contacts: {contacts_url}")

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
        log.error(f"search_contacts error: {e}")
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
        log.debug(f"Meetings cache HIT: {cache_key}")
        return cached["data"]

    org_url = f"{ORG_BASE}/api/Values/meetings"
    params  = {"email": email, "startDate": startDate, "endDate": endDate}

    log.debug(f"Meetings cache MISS: {org_url}")

    try:
        # Use async httpx so we don't block the FastAPI event loop
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(org_url, params=params)

        log.debug(f"Response status: {resp.status_code}")

        if resp.status_code != 200:
            log.error(f"Error body: {resp.text[:300]}")
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
        log.debug(f"Returning {len(meetings)} meetings")
        return meetings

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Calendar server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach calendar server")
    except Exception as e:
        log.error(f"get_meetings error: {e}")
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

    # Warn early if the ID looks like an email message ID rather than a calendar item ID
    if "@" in meetingId or meetingId.count(":") >= 2:
        log.warning(f"[rsvp] meetingId looks like an email message ID, not a calendar item ID: {meetingId!r}")

    org_url = f"{ORG_BASE}/api/Values/meetings/Action"
    rsvp_params = {"meetingId": meetingId, "action": action}
    if targetUserEmail:
        rsvp_params["targetUserEmail"] = targetUserEmail

    log.info(f"Meeting RSVP: {meetingId} action={action}")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(org_url, params=rsvp_params)

        log.debug(f"Response status: {resp.status_code}")

        if resp.status_code not in (200, 201, 204):
            error_body = resp.text[:500]
            log.error(f"[rsvp] Org server error {resp.status_code}: {error_body}")

            # Exchange returns this when we pass a MeetingRequest ID to an Appointment endpoint
            if "MeetingRequest" in error_body and "Appointment" in error_body:
                raise HTTPException(
                    status_code=409,
                    detail="MEETING_REQUEST_TYPE_MISMATCH"
                )

            raise HTTPException(
                status_code=422,
                detail=f"Calendar server rejected the request (HTTP {resp.status_code}). "
                       f"Org server said: {error_body}"
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
        log.error(f"respond_to_meeting error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/meetings/cache")
def clear_meetings_cache():
    """Manually bust the meetings cache (call after RSVP respond if needed)."""
    _meetings_cache.clear()
    return {"cleared": True}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        access_log=False,          # silence per-request noise
        log_level="warning"        # uvicorn internal logs: warnings+ only
    )