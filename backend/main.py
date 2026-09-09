import os
import uuid
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import requests
import httpx
import uvicorn
import io
import base64
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Body, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from dotenv import load_dotenv
from typing import List
from urllib.parse import unquote

from models import AnalysisRequest, ReplyRequest, ThreadParseRequest, LoginRequest, IrisChatRequest, ActivityPingRequest
from iris_service import get_iris_reply

import logging

# ── App logger ──
logging.basicConfig(
    level=logging.ERROR,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("hfmg")

# ── Silence uvicorn access log (kills the per-request flood) ──
logging.getLogger("uvicorn.access").setLevel(logging.ERROR)
logging.getLogger("uvicorn.error").setLevel(logging.ERROR)
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
    save_emails_to_id_cache,
    get_last_known_inbox,
    get_last_fetch_ok_at,
    set_last_fetch_ok_at,
    get_cached_detail,
    save_cached_detail,
    has_cached_detail,
    cached_detail_age_seconds,
    detail_is_complete,
    generate_day_brief_summary,
    extract_sender_email,
    # ── Tracking system ──
    run_tracking_scheduler,
    get_tracking_summary,
    get_tracking_digest,
    dismiss_tracking_recipient,
    is_tracking_allowed,
    load_tracking,
    sync_replies_from_ews,
    analyze_sent_thread_reply,
    get_group_members_dict,
    add_group_member,
    remove_group_member,
    # ── Activity tracking ──
    is_activity_allowed,
    record_activity_ping,
    get_activity_summary,
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
# Overridable via env (same pattern as ALLOWED_ORIGINS) so the mail-server
# outage path can be exercised — point it at a dead port and every call
# fails the way a firewall block does — without editing this file.
ORG_BASE = os.getenv("ORG_BASE", "http://172.22.6.188:177")

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


# ─── TRACKING SCHEDULER ───
# Runs every 2 hours for each user who has used the portal.
_active_tracking_users: set = set()

async def _tracking_scheduler_loop():
    """Background loop: runs tracking scheduler every 5 minutes for all active users."""
    await asyncio.sleep(30)
    while True:
        for user_email in list(_active_tracking_users):
            try:
                await run_tracking_scheduler(user_email)
            except Exception as e:
                log.error(f"[tracking loop] error for {user_email}: {e}")
        await asyncio.sleep(5 * 60)

@asynccontextmanager
async def lifespan(app):
    asyncio.create_task(_tracking_scheduler_loop())
    log.info("[tracking] Scheduler background task started")
    yield

app = FastAPI(lifespan=lifespan)

# 2. SECURITY (CORS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://172.22.6.145:8080",   # IIS React
        "http://localhost:3000", 
        "http://172.22.6.188:8080", 
        "http://localhost:8080",    # dev
        "*"                           # optional temporary
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers are NOT readable by browser JS cross-origin
    # unless listed here — without this, the frontend's
    # res.headers["x-data-source"] check on /api/fetch-inbox silently reads
    # undefined and treats every stale-cache fallback as a fresh live sync.
    expose_headers=["X-Data-Source", "X-Cache-As-Of"],
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

        # ── HARDCODE: open Jim's inbox for this specific account only ──
        # Scoped to the login identifier, not the returned mail, so it only
        # fires for this one account. Display name is left untouched.
        if credentials.email.strip().lower() == "karthikeyana":
            log.info(f"Login override: {credentials.email} -> Jim@hfmg.net inbox")
            user_data["mail"] = "Jim@hfmg.net"

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


def _normalize_onemail(data, messageId: str) -> dict:
    """
    Normalise a .NET GetOneMail response into the detail shape the frontend
    expects. Shared by /api/email-details and the background prefetcher so
    a prefetched copy is byte-for-byte what a live open would have produced.

    The updated .NET GetOneMail returns List<MailDto> — the full EWS
    conversation thread (Inbox + SentItems), ordered oldest→newest. A legacy
    / single-message response may still come back as a plain dict.

    Strategy:
      1. Find the specific email that was asked for (matched by messageId).
      2. Use that as the primary data object (FROM / TO / CC / BODY / ATTS).
      3. Attach the full list as data["messages"] so the frontend can render
         the complete conversation thread without a separate call.
    """
    if isinstance(data, list):
        if not data:
            raise HTTPException(status_code=404, detail="Email not found")

        # Find the requested email by its EWS messageId. Fall back to the
        # most-recent message if not found (edge case where EWS regenerates
        # IDs after a move).
        thread_messages = data
        primary = next(
            (m for m in thread_messages
             if isinstance(m, dict) and
                (m.get("messageId") or m.get("MessageId") or "").strip() == (messageId or "").strip()),
            thread_messages[-1]
        )
        # Normalise PascalCase .NET fields on the primary so downstream code
        # always sees camelCase regardless of serializer config.
        def _lc(d, *keys):
            for k in keys:
                v = d.get(k) or d.get(k[0].upper() + k[1:])
                if v is not None:
                    d[k] = v
        _lc(primary, "from", "to", "cc", "body", "subject",
            "received", "messageId", "conversationId", "attachments")
        data = dict(primary)                 # shallow copy so we can mutate safely
        data["messages"] = thread_messages   # full thread for conversation view

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Unexpected response shape from mail server")

    def _norm_atts(raw, owner_id):
        return [
            {
                "name":         a.get("name", ""),
                "type":         a.get("type", "application/octet-stream"),
                "size":         a.get("size", 0),
                "attachmentId": a.get("attachmentId") or a.get("AttachmentId", ""),
                "storage":      "api",
                "messageId":    owner_id,
            }
            for a in (raw or []) if isinstance(a, dict)
        ]

    data["attachments"] = _norm_atts(data.get("attachments"), messageId)
    data["hasAttachments"] = len(data["attachments"]) > 0

    for msg in data.get("messages", []):
        if not isinstance(msg, dict):
            continue
        msg["attachments"] = _norm_atts(
            msg.get("attachments"),
            msg.get("messageId") or msg.get("MessageId") or messageId,
        )

    return data


# ─── BACKGROUND DETAIL PREFETCH ──────────────────────────────────────────────
# After an inbox fetch we already know every messageId, so the bodies can be
# pulled in the background instead of waiting for the user to click. Two wins:
# opening an email becomes a local disk read rather than a round trip to the
# org server, and the whole inbox — not just what happens to have been opened
# — is readable when that server is unreachable.
#
# Deliberately conservative about the org server: only ever fetches what
# isn't already cached, caps how much it pulls per sync, runs a small number
# of workers, and never lets one run stack on top of another for the same
# user. In steady state this is a handful of requests for genuinely new mail.
PREFETCH_WORKERS = 3
PREFETCH_BUDGET_PER_SYNC = 120     # spread the initial backfill over syncs

# How long a cached detail is served without re-checking the mail server.
# The body itself is immutable; this bounds how stale the surrounding
# conversation thread can be. Comfortably longer than the inbox sync
# interval, so prefetched mail opens instantly, but short enough that a
# thread gaining a reply corrects itself quickly.
DETAIL_CACHE_FRESH_SECONDS = 600   # 10 minutes
_prefetch_active: set = set()
_prefetch_lock = threading.Lock()

def _prefetch_one_detail(message_id: str, user_email: str) -> bool:
    try:
        resp = requests.get(
            f"{ORG_BASE}/api/Values/inbox/onemail",
            params={"messageId": message_id, "targetUserEmail": user_email},
            timeout=45,
        )
        if resp.status_code != 200:
            return False
        detail = _normalize_onemail(resp.json(), message_id)
        save_cached_detail(user_email, message_id, detail)
        return True
    except Exception:
        # Best effort by design — a prefetch failure is a non-event, the
        # email simply gets fetched live when someone opens it.
        return False

def _run_prefetch(message_ids: list, user_email: str):
    done = 0
    try:
        with ThreadPoolExecutor(max_workers=PREFETCH_WORKERS) as pool:
            for ok in pool.map(lambda mid: _prefetch_one_detail(mid, user_email), message_ids):
                if ok:
                    done += 1
        log.info(f"[prefetch] cached {done}/{len(message_ids)} email bodies for {user_email}")
    except Exception as e:
        log.warning(f"[prefetch] run failed for {user_email}: {e}")
    finally:
        with _prefetch_lock:
            _prefetch_active.discard(user_email)

def schedule_detail_prefetch(emails: list, user_email: str):
    """Queue background body-fetching for emails we don't have cached yet."""
    try:
        with _prefetch_lock:
            if user_email in _prefetch_active:
                return           # a run is already in flight for this user
            pending = []
            for e in emails or []:
                if not isinstance(e, dict):
                    continue
                mid = e.get("messageId") or e.get("id")
                if mid and not has_cached_detail(user_email, mid):
                    pending.append(mid)
                if len(pending) >= PREFETCH_BUDGET_PER_SYNC:
                    break
            if not pending:
                return
            _prefetch_active.add(user_email)

        log.info(f"[prefetch] fetching {len(pending)} email bodies in background for {user_email}")
        threading.Thread(
            target=_run_prefetch, args=(pending, user_email), daemon=True
        ).start()
    except Exception as e:
        log.warning(f"[prefetch] could not schedule for {user_email}: {e}")


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

    # ── Cache-first for recently prefetched mail ──────────────────────────────
    # The background prefetcher pulls bodies right after each inbox sync, so
    # most opens can be answered from local disk in milliseconds instead of a
    # round trip to the org server. A message's own body never changes once
    # received, but the thread around it can gain replies — so a cached copy
    # is only trusted inside a short window, after which we go live again.
    age = cached_detail_age_seconds(userEmail, messageId)
    if age is not None and age < DETAIL_CACHE_FRESH_SECONDS:
        cached = get_cached_detail(userEmail, messageId)
        # Only a complete copy may short-circuit the live call. A partial one
        # would render a conversation of empty messages; treating it as a miss
        # means we refetch and overwrite it with a real copy instead.
        if cached and detail_is_complete(cached):
            log.debug(f"email-details: serving fresh cache ({int(age)}s old) for {messageId[:20]}...")
            return JSONResponse(content=cached, headers={"X-Data-Source": "cache"})

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(org_url, params=params)

        if resp.status_code != 200:
            # ── Fallback: tracking cache ──────────────────────────────────────
            # Sent emails (tracking page) live in Sent Items, not inbox.
            # When .NET inbox/onemail can't find them, serve the body we stored
            # at tracking-add time (up to 5 000 chars) so the modal isn't blank.
            try:
                from services import load_tracking
                tracking = load_tracking(userEmail)
                # Search both active tracking AND pending AI suggestions —
                # the "View Email" button on a pending approval card hits this
                # same endpoint before the item has ever been approved.
                cached_item = next(
                    (item for item in (
                        tracking.get("tracked", [])
                        + tracking.get("pending_tracking_approvals", [])
                    ) if item.get("messageId") == messageId),
                    None
                )
                if cached_item:
                    log.info(
                        f"[email-details] .NET {resp.status_code} — "
                        f"serving tracking-cache body for {messageId[:20]}..."
                    )
                    return {
                        "messageId":          messageId,
                        "subject":            cached_item.get("subject", ""),
                        "body":               cached_item.get("body", ""),
                        "from":               userEmail,
                        "to":                 [],
                        "cc":                 [],
                        "attachments":        [],
                        "hasAttachments":     False,
                        "messages":           [],
                        "_fromTrackingCache": True,
                    }
            except Exception as fallback_err:
                log.warning(f"[email-details] Tracking cache fallback failed: {fallback_err}")

            # ── Fallback: offline detail cache ────────────────────────────────
            # An error status is just as unusable as an unreachable server, so
            # serve the copy saved while it was healthy rather than a dead panel.
            cached = get_cached_detail(userEmail, messageId)
            if cached:
                log.warning(
                    f"[email-details] .NET {resp.status_code} — "
                    f"serving cached copy for {messageId[:20]}..."
                )
                return JSONResponse(content=cached, headers={"X-Data-Source": "cache"})

            # No cache hit — propagate the original error
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text[:300]}"
            )

        data = _normalize_onemail(resp.json(), messageId)

        thread_count = len(data.get("messages", []))
        log.debug(f"email-details OK: {len(data['attachments'])} attachments, {thread_count} thread messages")

        # Keep this exact payload so the same email still opens during an
        # outage. Best-effort — never fail a good response over a cache write.
        try:
            save_cached_detail(userEmail, messageId, data)
        except Exception as e:
            log.warning(f"email-details: detail cache write failed: {e}")

        return JSONResponse(content=data, headers={"X-Data-Source": "live"})

    except HTTPException:
        raise
    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        # Mail server unreachable/slow — serve the copy we saved when it was
        # last reachable, so reading mail keeps working while it's down.
        cached = get_cached_detail(userEmail, messageId)
        if cached:
            log.warning(f"email-details: org server unreachable ({type(e).__name__}) — serving cached copy for {messageId[:20]}...")
            return JSONResponse(content=cached, headers={"X-Data-Source": "cache"})
        status = 504 if isinstance(e, httpx.TimeoutException) else 503
        raise HTTPException(status_code=status, detail="Cannot reach mail server, and this email isn't saved offline.")
    except Exception as e:
        log.error(f"get_email_details error: {e}")
        cached = get_cached_detail(userEmail, messageId)
        if cached:
            log.warning(f"email-details: falling back to cached copy for {messageId[:20]}...")
            return JSONResponse(content=cached, headers={"X-Data-Source": "cache"})
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fetch-inbox")
def fetch_inbox(email: str, count: int = 500):
    # Build the org server inbox URL from the email address.
    # Route template: GET /api/Values/inbox/{mail}/count{num}
    # "count" and the number share the same path segment — no slash between them.
    # `count` is caller-controlled so the frontend can request a small fast
    # batch first (near-instant paint) and the full inbox afterward, instead
    # of blocking on all 500 emails before showing anything.
    clean_email = unquote(email).strip()
    clean_url = f"{ORG_BASE}/api/Values/inbox/{clean_email}/count{count}"

    def _serve_stale(reason: str, hard_status: int, hard_detail: str):
        """
        The org mail server is unreachable or erroring (firewall down,
        timeout, 5xx, ...). Fall back to the last inbox we successfully
        fetched+analyzed for this user (from the /api/analyze id-cache) so
        the UI keeps showing real data instead of going blank — flagged via
        response headers so the frontend can show a "reconnecting" banner
        instead of treating this as a normal live sync. Only raise the hard
        error if there's truly nothing cached yet to fall back to.
        """
        fallback = get_last_known_inbox(clean_email, limit=count)
        if fallback:
            as_of = get_last_fetch_ok_at(clean_email)
            log.warning(f"fetch_inbox: {reason} — serving {len(fallback)} cached emails for {clean_email}")
            resp_obj = JSONResponse(content=fallback)
            resp_obj.headers["X-Data-Source"] = "cache"
            if as_of:
                resp_obj.headers["X-Cache-As-Of"] = as_of
            return resp_obj
        log.error(f"fetch_inbox: {reason} — no cache to fall back to for {clean_email}")
        raise HTTPException(status_code=hard_status, detail=hard_detail)

    try:
        log.debug(f"Fetching org inbox: {clean_url}")
        resp = requests.get(clean_url, timeout=120)
    except requests.exceptions.RequestException as e:
        return _serve_stale(f"org server unreachable ({e})", 502, f"Mail server unreachable: {e}")

    if resp.status_code != 200:
        return _serve_stale(
            f"org server returned {resp.status_code}",
            resp.status_code,
            f"Mail server error: {resp.text[:300]}"
        )

    try:
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

        set_last_fetch_ok_at(datetime.now(timezone.utc).isoformat(), clean_email)

        # Pull bodies in the background so opening an email is a local read
        # rather than a round trip, and so the whole inbox — not just what's
        # been opened — survives the mail server going away.
        #
        # This is deliberately the ONLY writer of the detail cache. An earlier
        # version also warmed it straight from this inbox payload, which was a
        # mistake twice over: the inbox list carries no per-message bodies, so
        # those entries rendered a thread of empty messages, and their mere
        # existence made the prefetcher skip the emails that needed it most.
        schedule_detail_prefetch(data, clean_email)

        resp_final = JSONResponse(content=data)
        resp_final.headers["X-Data-Source"] = "live"
        return resp_final

    except Exception as e:
        # Org server answered 200 but the body was unusable (malformed JSON,
        # an HTML error page served with a 200 status, or a bug in the
        # processing above) — treat it the same as "unreachable" rather than
        # showing the user a hard error when we have real cached data to
        # fall back to instead. log.error keeps this visible operationally.
        log.error(f"fetch_inbox: processing error on 200 response: {e}")
        return _serve_stale(f"org response unusable ({e})", 500, f"Mail server response error: {e}")


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

            # Build the daily digest from raw fetched emails so the day counts
            # reflect true incoming volume, but reuse analyzed category/summary
            # metadata when we have it so the paragraph stays high quality.
            digest_meta_by_id = {}
            for analyzed in all_results:
                meta = {
                    "category": analyzed.get("category"),
                    "summary": analyzed.get("summary"),
                }
                primary_id = analyzed.get("id") or analyzed.get("messageId")
                if primary_id:
                    digest_meta_by_id[primary_id] = meta
                for mid in (analyzed.get("allMessageIds") or []):
                    if mid:
                        digest_meta_by_id[mid] = meta

            digest_source = []
            for raw_email in emails:
                enriched = raw_email.copy()
                raw_id = raw_email.get("id") or raw_email.get("messageId")
                meta = digest_meta_by_id.get(raw_id, {})
                if meta.get("category"):
                    enriched["category"] = meta["category"]
                if meta.get("summary"):
                    enriched["summary"] = meta["summary"]
                digest_source.append(enriched)

            threads_only = [t for t in all_results if t.get("thread_count", 1) > 1]
            brief_task   = generate_executive_brief(threads_only)
            sender_task  = generate_sender_report(emails)
            digest_task  = generate_daily_digest(digest_source)
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


@app.post("/api/iris/chat")
async def iris_chat(payload: IrisChatRequest):
    """
    Iris — Inbox Assistant, Phase 3.
    Grounded in the inbox snapshot (payload.inbox_context) plus tool
    calls (draft_reply / check_tracking_status / search_emails), which
    need payload.user_email to look up the right user's cache/tracking
    data. See iris_service.py for the tool implementations and the
    tool-calling loop itself.
    """
    try:
        result = await get_iris_reply(
            payload.message,
            payload.history,
            payload.user_name,
            payload.inbox_context,
            payload.user_email,
            payload.focus_message_id,
        )
        # steps  = what Iris actually did, so the UI isn't a silent pause
        # proposals = actions waiting on the person's confirmation. Iris
        # never performs them; /api/iris/confirm does, after they press it.
        return {
            "reply": result.get("reply", ""),
            "steps": result.get("steps", []),
            "proposals": result.get("proposals", []),
        }
    except Exception as e:
        log.error(f"iris_chat error: {e}")
        raise HTTPException(status_code=500, detail="Iris couldn't respond right now.")


# Action ids already carried out, so a double-click or a retry after a
# timeout can't run the same thing twice. In memory by design: the worst a
# restart can do is allow a repeat the person has to press for again.
_iris_done_actions: dict = {}
IRIS_ACTION_TTL = 3600


@app.post("/api/iris/confirm")
async def iris_confirm(payload: dict = Body(...)):
    """
    Carry out an action Iris proposed, after the person pressed confirm.

    Iris itself can only ever propose — this is the single place any of it
    actually happens, and it only runs on an explicit click. Sends are
    deliberately NOT retried: if the mail server times out we cannot know
    whether it went, and silently retrying could send the same email twice.
    """
    action_id = (payload.get("actionId") or "").strip()
    action = (payload.get("action") or "").strip()
    user_email = (payload.get("userEmail") or "").strip()
    message_id = (payload.get("messageId") or "").strip()

    if not action_id or not action:
        raise HTTPException(status_code=400, detail="Missing actionId or action.")

    now = time.time()
    for k, ts in list(_iris_done_actions.items()):
        if now - ts > IRIS_ACTION_TTL:
            _iris_done_actions.pop(k, None)
    if action_id in _iris_done_actions:
        return {"ok": True, "duplicate": True, "message": "Already done — not repeating it."}

    try:
        if action == "mark_read":
            if not message_id:
                raise HTTPException(status_code=400, detail="mark_read needs a messageId.")
            resp = requests.post(
                f"{ORG_BASE}/api/Values/mail/read-status",
                params={"messageId": message_id, "targetUserEmail": user_email, "isRead": "true"},
                timeout=30,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Mail server refused: {resp.text[:200]}")
            update_cache_mark_read(message_id, user_email)
            result = {"ok": True, "message": "Marked as read."}

        elif action in ("send_reply", "forward"):
            body = payload.get("body") or ""
            to = [x for x in (payload.get("to") or []) if x]
            if not body or not to:
                raise HTTPException(status_code=400, detail="A recipient and a message body are required.")
            html_body = body if "<" in body else "<p>" + body.replace("\n", "<br>") + "</p>"
            endpoint = "reply" if action == "send_reply" else "forwardmail"
            parts = [
                ("MessageItemId", (None, message_id, "text/plain")),
                ("ReplyBodyHtml", (None, html_body, "text/plain")),
                ("IsReplyAll", (None, "false", "text/plain")),
            ]
            for t in to:
                parts.append(("To", (None, t, "text/plain")))
            for c in (payload.get("cc") or []):
                parts.append(("Cc", (None, c, "text/plain")))
            if user_email:
                parts.append(("TargetUserEmail", (None, user_email, "text/plain")))
            # No retry here, on purpose — see the docstring above.
            async with httpx.AsyncClient(timeout=120) as client_:
                resp = await client_.post(f"{ORG_BASE}/api/Values/mail/{endpoint}", files=parts)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Send failed: {resp.text[:200]}")
            result = {"ok": True, "message": "Sent."}

        elif action == "rsvp":
            answer = (payload.get("response") or "accept").lower()
            resp = requests.post(
                f"{ORG_BASE}/api/Values/meetings/Action",
                params={"meetingId": message_id, "action": answer, "targetUserEmail": user_email},
                timeout=30,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Calendar refused: {resp.text[:200]}")
            result = {"ok": True, "message": f"RSVP sent ({answer})."}

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported action: {action}")

        _iris_done_actions[action_id] = now
        log.info(f"[iris-action] {action} confirmed by {user_email} ({action_id})")
        return result

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"iris_confirm '{action}' failed: {e}")
        raise HTTPException(status_code=500, detail=f"Couldn't complete that: {e}")


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


@app.post("/api/send-reminder")
async def send_reminder(
    to: List[str] = Form(...),
    cc: List[str] = Form([]),
    subject: str = Form(...),
    bodyHtml: str = Form(...),
    attachments: List[UploadFile] = File([]),
):
    """
    Send a follow-up / reminder email from reminders@hfmg.net via EWS impersonation.
    Routes to /api/Values/mail/SentAsRemainder — no FromEmail field needed,
    the .NET endpoint handles the sender via impersonation.
    Used by the tracking page Follow Up compose and any user-initiated reminders.
    """
    try:
        org_api_url = f"{ORG_BASE}/api/Values/mail/SentAsRemainder"

        parts = []
        for t in to:
            parts.append(("To", (None, t, "text/plain")))
        for c in cc:
            parts.append(("Cc", (None, c, "text/plain")))
        parts.append(("Subject",   (None, subject, "text/plain")))
        parts.append(("BodyHtml",  (None, bodyHtml, "text/plain")))
        # .NET SendMailRequest requires FromEmail even for SentAsRemainder —
        # the EWS impersonation overrides the actual sender to reminders@hfmg.net
        parts.append(("FromEmail", (None, "reminders@hfmg.net", "text/plain")))

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

        log.info(f"Reminder sent via reminders@hfmg.net to {to}")
        return {"success": True, "message": "Reminder sent"}

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"send_reminder error: {e}")
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
async def search_contacts(q: str = "", user_email: str = ""):
    """
    Recipient autocomplete for reply / forward / new-mail composition.

    Merges two sources so external correspondents (outside counsel, vendors,
    etc.) show up alongside internal staff — not just people in the org GAL:

      1. DIRECTORY — the internal org server (ORG_BASE/get). Canonical
         @hfmg.net staff, verified names.
      2. CACHE — this user's analyzed-email cache (meta_emails_by_id). Every
         from/to/cc/participants address this mailbox has actually
         corresponded with. This is the ONLY place external addresses like
         outside counsel exist, since they're not in the internal directory.

    Directory results are returned first (canonical), with external cached
    contacts filling any remaining slots up to the 10-result cap. A directory
    outage no longer blocks external results — the two sources are independent.
    """
    if not q or len(q) < 2:
        return []

    query_lower = q.lower()

    # ─── SOURCE 1: Internal org directory ───
    directory_results = []
    try:
        contacts_url = f"{ORG_BASE}/get"
        log.debug(f"Searching contacts: {contacts_url}")

        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(contacts_url)

        if response.status_code == 200:
            all_contacts = response.json()
            if isinstance(all_contacts, list):
                for contact in all_contacts:
                    mail_id = contact.get("mailId", "")

                    # Skip system mailboxes
                    if "SystemMailbox" in mail_id:
                        continue

                    if query_lower in mail_id.lower():
                        name_part = mail_id.split("@")[0] if "@" in mail_id else mail_id
                        display_name = name_part.replace(".", " ").title()

                        directory_results.append({
                            "email": mail_id,
                            "name": display_name,
                            "group": contact.get("groupName", "user"),
                        })
        else:
            log.warning(f"Org directory returned {response.status_code} — falling back to cache-only results")
    except (httpx.TimeoutException, httpx.ConnectError) as e:
        # Directory being unreachable shouldn't take down external contact
        # search too — degrade gracefully instead of failing the whole request.
        log.warning(f"Org directory unreachable during contact search: {e}")
    except Exception as e:
        log.error(f"Org directory search failed: {e}")

    # ─── SOURCE 2: External contacts mined from this user's email cache ───
    external_results = []
    if user_email:
        try:
            seen_external = set()
            directory_emails = {c["email"].lower() for c in directory_results}
            cached_by_id = get_cached_emails_by_id(user_email)

            for entry in cached_by_id.values():
                if not isinstance(entry, dict):
                    continue
                # Skip lightweight secondary-ID pointers (_threadRef) — the
                # primary thread entry elsewhere in this same dict already
                # carries the real from/to/cc/participants data.
                if entry.get("_threadRef"):
                    continue

                candidates = []
                if entry.get("from"):
                    candidates.append(entry["from"])
                candidates.extend(entry.get("to") or [])
                candidates.extend(entry.get("cc") or [])
                candidates.extend(entry.get("participants") or [])

                for raw in candidates:
                    addr = extract_sender_email(raw)
                    if not addr or "@" not in addr:
                        continue
                    if "hfmg.net" in addr:
                        continue
                    if addr in seen_external or addr in directory_emails:
                        continue
                    if query_lower not in addr:
                        continue

                    seen_external.add(addr)
                    local_part = addr.split("@")[0]
                    display_name = local_part.replace(".", " ").replace("_", " ").title()

                    external_results.append({
                        "email": addr,
                        "name": display_name,
                        "group": "external",
                    })
        except Exception as e:
            log.warning(f"External contact cache scan failed for {user_email}: {e}")

    # Directory first (canonical, verified), external cached contacts fill
    # the remaining slots. Limit results to 10 for performance, same as before.
    return (directory_results + external_results)[:10]


@app.get("/api/group-members")
async def get_group_members():
    """
    Returns the effective sender lists behind all 8 folders (VIP, LEGAL,
    PRIORITY, PROVIDERS, GLOBAL, RCM_MGRS, IT, ACCOUNTING), so the frontend
    can show "who's in this group" without hardcoding a second copy of these
    lists in JS.

    Reads live via get_group_members_dict() — always reflects the latest
    add/remove from the endpoints below, not just what was loaded at startup.
    """
    try:
        return get_group_members_dict()
    except Exception as e:
        log.error(f"get_group_members error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/group-members/add")
async def add_group_member_endpoint(payload: dict = Body(...)):
    """
    Add a person to a folder. Persists to that folder's JSON file AND updates
    the live in-memory list immediately — no backend restart needed.

    Body: { folder, email }
    folder is one of: VIP, LEGAL, PRIORITY, PROVIDERS, GLOBAL, RCM_MGRS, IT, ACCOUNTING
    (case-insensitive). Idempotent — adding an existing member is a no-op.
    """
    folder = payload.get("folder", "")
    email  = payload.get("email", "")
    try:
        members = add_group_member(folder, email)
        return {"success": True, "folder": folder.strip().upper(), "email": email.strip().lower(), "members": members}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"add_group_member_endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/group-members/remove")
async def remove_group_member_endpoint(payload: dict = Body(...)):
    """
    Remove a person from a folder. Persists to that folder's JSON file AND
    updates the live in-memory list immediately — no backend restart needed.

    Body: { folder, email }
    folder is one of: VIP, LEGAL, PRIORITY, PROVIDERS, GLOBAL, RCM_MGRS, IT, ACCOUNTING
    (case-insensitive). Idempotent — removing a non-member is a no-op.
    """
    folder = payload.get("folder", "")
    email  = payload.get("email", "")
    try:
        members = remove_group_member(folder, email)
        return {"success": True, "folder": folder.strip().upper(), "email": email.strip().lower(), "members": members}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"remove_group_member_endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
    # Past its TTL, but still real data from the last successful call — kept
    # as a fallback for the handlers below if the server can't be reached.
    stale = cached

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

    except HTTPException as e:
        # Serve the expired cache rather than an error: a stale calendar beats
        # a blank one, and this entry was real data when it was fetched.
        if stale and stale.get("data") is not None:
            log.warning(f"get_meetings: calendar server error {e.status_code} — serving stale cache for {cache_key}")
            return stale["data"]
        raise
    except Exception as e:
        log.error(f"get_meetings error: {e}")
        if stale and stale.get("data") is not None:
            log.warning(f"get_meetings: {type(e).__name__} — serving stale cache for {cache_key}")
            return stale["data"]
        if isinstance(e, httpx.TimeoutException):
            raise HTTPException(status_code=504, detail="Calendar server timeout")
        if isinstance(e, httpx.ConnectError):
            raise HTTPException(status_code=503, detail="Cannot reach calendar server")
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


@app.post("/api/meetings/day-brief")
async def get_day_brief(payload: dict = Body(...)):
    """
    Generate an AI paragraph summarising a day's meetings.
    Body: { "meetings": [...], "dateLabel": "Today — Monday, April 24" }
    """
    meetings   = payload.get("meetings", [])
    date_label = payload.get("dateLabel", "today")

    if not meetings:
        return {"summary": ""}

    summary = await generate_day_brief_summary(meetings, date_label)
    return {"summary": summary}


# ── AUTO DIGEST ENDPOINT ─────────────────────────────────────────────────────

@app.get("/api/auto-digest")
async def get_auto_digest(user_email: str):
    """
    Fetch a complete 7-day daily digest guaranteed to include every inbox email.

    Unlike the cached digest (which only sees 700 emails and drops all read mail),
    this calls the .NET onedaymails endpoint which paginates EWS until
    MoreAvailable=false — so nothing is missed regardless of read/unread state.

    Extra signals from the DTO (isReply, hasQuestionMark) are passed through
    to generate_daily_digest for richer AI paragraphs.

    Result is cached per-user per calendar day — the first call generates it,
    every subsequent call within the same day returns instantly from cache.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")

    # ── Cache check: return today's digest instantly if already built ──────────
    from services import load_cache, save_cache
    cached = load_cache(user_email)
    cached_digest = cached.get("meta_auto_digest")
    if cached_digest:
        try:
            gen_date = datetime.fromisoformat(cached_digest.get("generated_at", "")).date()
            if gen_date == datetime.now(timezone.utc).date():
                log.debug(f"[auto-digest] Cache hit for {user_email}")
                return cached_digest
        except Exception:
            pass  # stale or bad timestamp — regenerate below

    # ── Fetch complete 7-day inbox from .NET EWS (paginated, no cap) ─────────
    org_url = f"{ORG_BASE}/api/Values/onedaymails/{user_email}"
    log.info(f"[auto-digest] Fetching from EWS for {user_email}")

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.get(org_url)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text[:200]}"
            )
        raw_emails = resp.json()
        if not isinstance(raw_emails, list):
            raw_emails = []
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Mail server timeout — try again shortly")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")

    log.info(f"[auto-digest] Received {len(raw_emails)} emails from EWS for {user_email}")

    # ── Normalize SentMailTrackDto → format generate_daily_digest expects ─────
    # .NET Core JSON serializes PascalCase → camelCase by default.
    # We handle both to be safe.
    def _get(obj, *keys):
        for k in keys:
            v = obj.get(k)
            if v is not None:
                return v
        return None

    normalized = []
    for m in raw_emails:
        # sentAt = DateTimeReceived in .NET code (despite the field name)
        received = _get(m, "sentAt", "SentAt", "receivedAt", "ReceivedAt") or ""
        normalized.append({
            "id":               _get(m, "messageId", "MessageId") or "",
            "subject":          _get(m, "subject",   "Subject")   or "No Subject",
            "from":             _get(m, "from",      "From")      or "Unknown",
            "body":             _get(m, "body",      "Body")      or "",
            "received_at":      received,
            "isRead":           bool(_get(m, "isRead",           "IsRead")           or False),
            "isReply":          bool(_get(m, "isReply",          "IsReply")          or False),
            "hasQuestionMark":  bool(_get(m, "hasQuestionMark",  "HasQuestionMark")  or False),
            "conversationId":   _get(m, "conversationId", "ConversationId") or "",
            # Pass through to/cc so category counts work correctly
            "to":               _get(m, "to", "To") or [],
            "cc":               _get(m, "cc", "Cc") or [],
            # Category will be NORMAL for all since this data bypasses the AI analysis —
            # that's fine; the digest prompt uses sender/subject/topic not category.
            "category":         "NORMAL",
            "attachments":      [],
        })

    # ── Generate AI paragraphs for all 7 days ────────────────────────────────
    digest_days = await generate_daily_digest(normalized)

    result = {
        "digest":       digest_days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "email_count":  len(normalized),
    }

    # ── Cache for the rest of today ───────────────────────────────────────────
    save_cache({"meta_auto_digest": result}, user_email)
    log.info(f"[auto-digest] Done — {len(digest_days)} days generated for {user_email}")

    return result


# ── TRACKING ENDPOINTS ────────────────────────────────────────────────────────

@app.get("/api/tracking/access")
async def check_tracking_access(user_email: str):
    """
    Returns whether the given user is allowed to use the tracking feature.
    The frontend calls this once on mount to decide whether to show the
    Tracking tab/button. The real enforcement is in every /api/tracking* endpoint.
    Reads from tracking_access.json — no server restart needed after editing.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    return {"allowed": is_tracking_allowed(user_email)}


# ── ACTIVITY TRACKING ENDPOINTS ───────────────────────────────────────────────
# Shows when each person using the dashboard is active and from which
# (best-effort) device. This is data ABOUT other people, not just the caller,
# so /api/activity/summary is gated by activity_access.json the same way
# tracking is gated by tracking_access.json — edit that file to add/remove
# who can see the summary; no server restart needed.

@app.post("/api/activity/ping")
async def activity_ping(payload: ActivityPingRequest):
    """
    Heartbeat from an active browser tab — the frontend calls this roughly
    every 60s while the user is NOT idle (reuses the existing idle-detection
    state, see Dashboard.jsx). No access check here: every logged-in user can
    report their own activity, same as they can already see their own inbox.
    """
    record_activity_ping(payload.user_email, payload.device_id, payload.device_label)
    return {"ok": True}


@app.get("/api/activity/access")
async def check_activity_access(user_email: str):
    """
    Returns whether the given user may view the (everyone's) activity
    summary. The frontend calls this once on mount to decide whether to show
    the Activity tab. Real enforcement is in /api/activity/summary itself.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    return {"allowed": is_activity_allowed(user_email)}


@app.get("/api/activity/summary")
async def activity_summary(requester_email: str, days: int = 14):
    """
    Per-user active-hours + device summary for everyone who has ever pinged.
    requester_email must be listed in activity_access.json.
    """
    if not requester_email:
        raise HTTPException(status_code=400, detail="Missing requester_email")
    if not is_activity_allowed(requester_email):
        raise HTTPException(status_code=403, detail="Not authorized to view activity data.")
    return {"users": get_activity_summary(days=days)}


@app.get("/api/tracking")
async def get_tracking(user_email: str):
    """
    Returns the full tracking store for the Tracking tab UI.
    Splits into: awaiting, reminders_sent, resolved.
    Also registers the user for the background scheduler.

    On every load, cross-references live EWS reply data from the .NET
    sent7days endpoint so Active Tracking stays in sync with real reply
    status without waiting for the 2-hour background scheduler.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking feature is not enabled for this account.")
    _active_tracking_users.add(user_email)

    # ── Live EWS reply sync ───────────────────────────────────────────────────
    # Pull the same sent7days data the Sent Items tab uses and patch the
    # tracking JSON so reply statuses are always current on every load.
    # Wrapped in a broad try/except — an EWS failure must never block
    # the tracking load; the user still gets their data, just un-synced.
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            ews_resp = await client.get(
                f"{ORG_BASE}/api/Values/sent7days",
                params={"email": user_email}
            )
        if ews_resp.status_code == 200:
            ews_data = ews_resp.json()
            if isinstance(ews_data, list) and ews_data:
                updated = sync_replies_from_ews(user_email, ews_data)
                if updated:
                    log.info(f"[tracking/ews-sync] {updated} recipient(s) patched for {user_email}")
    except Exception as sync_err:
        log.warning(f"[tracking/ews-sync] Non-fatal EWS sync error: {sync_err}")
    # ─────────────────────────────────────────────────────────────────────────

    try:
        return get_tracking_summary(user_email)
    except Exception as e:
        log.error(f"get_tracking error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/tracking/dismiss")
async def dismiss_tracking(payload: dict = Body(...)):
    """
    Dismiss a specific recipient from a tracked email.
    Body: { user_email, message_id, recipient_email }
    Dismissed items never appear in the digest again.
    """
    user_email      = payload.get("user_email")
    message_id      = payload.get("message_id")
    recipient_email = payload.get("recipient_email")

    if not all([user_email, message_id, recipient_email]):
        raise HTTPException(status_code=400, detail="Missing user_email, message_id, or recipient_email")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking feature is not enabled for this account.")

    ok = dismiss_tracking_recipient(user_email, message_id, recipient_email)
    if not ok:
        raise HTTPException(status_code=404, detail="Tracked email or recipient not found")
    return {"success": True}


@app.get("/api/tracking/pending")
async def get_pending_reminders(user_email: str):
    """Returns all pending reminders awaiting review for this user."""
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    tracking = load_tracking(user_email)
    pending  = tracking.get("pending_reminders", [])
    return {"pending": pending, "total": len(pending)}


@app.post("/api/tracking/pending/approve")
async def approve_reminder(
    user_email:  str  = Form(...),
    reminder_id: str  = Form(...),
    body:        str  = Form(""),   # empty = use the AI draft body stored in the reminder
):
    """
    Approve and send a pending reminder (body may have been edited by user).
    Per-user — each user only approves reminders from their own queue.
    """
    if not user_email or not reminder_id:
        raise HTTPException(status_code=400, detail="Missing fields")
    try:
        from services import approve_pending_reminder
        result = await approve_pending_reminder(user_email, reminder_id, body)
        if not result.get("ok"):
            raise HTTPException(status_code=500, detail=result.get("error", "Send failed"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        log.error(f"[approve_reminder] CRASH: {e}\n{tb}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")


@app.post("/api/tracking/pending/dismiss")
async def dismiss_reminder(
    user_email:  str = Form(...),
    reminder_id: str = Form(...),
):
    """
    Dismiss a pending reminder without sending it.
    Per-user — only affects the requesting user's queue.
    """
    if not user_email or not reminder_id:
        raise HTTPException(status_code=400, detail="Missing fields")
    from services import dismiss_pending_reminder
    result = dismiss_pending_reminder(user_email, reminder_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error", "Not found"))
    return result


@app.get("/api/sent-emails")
async def get_sent_emails(user_email: str):
    """
    Proxy: GET /api/Values/sent7days?email=...
    Returns ALL sent emails for the last 7 days for the Tracking page Sent Emails tab.
    The .NET endpoint already limits to a 7-day window so no further capping is needed.

    The .NET endpoint returns SentMailTrackDto[] with EWS-computed reply status:
      - isReply            true when In-Reply-To header is set
      - notRepliedAddresses recipients who haven't replied yet
      - hasPendingReplies  any recipient still outstanding
      - hasQuestionMark    subject/body contains a question mark
    Body is null (not loaded for performance) — display-only fields are sufficient.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")

    org_url = f"{ORG_BASE}/api/Values/sent7days"
    log.debug(f"sent-emails: user={user_email}")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(org_url, params={"email": user_email})

        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text[:200]}"
            )

        data = resp.json()
        if not isinstance(data, list):
            return []

        # Return all emails — .NET already limits to 7 days
        log.debug(f"sent-emails: returning {len(data)} items for {user_email}")
        return data

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Mail server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")
    except Exception as e:
        log.error(f"get_sent_emails error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/tracking/pending-tracking")
async def get_pending_tracking_approvals(user_email: str):
    """
    Returns all AI-suggested tracking decisions awaiting user approval.
    These are emails the AI wants to track but the user must approve first.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking not enabled for this account.")
    tracking  = load_tracking(user_email)
    approvals = tracking.get("pending_tracking_approvals", [])
    return {"approvals": approvals, "total": len(approvals)}


@app.post("/api/tracking/pending-tracking/approve")
async def approve_tracking_approval(
    user_email:  str = Form(...),
    approval_id: str = Form(...),
):
    """
    User approves a pending tracking decision.
    Moves the entry from pending_tracking_approvals → tracked.
    """
    if not user_email or not approval_id:
        raise HTTPException(status_code=400, detail="Missing fields")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking not enabled for this account.")
    from services import approve_tracking_decision
    result = await approve_tracking_decision(user_email, approval_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error", "Not found"))
    return result


@app.post("/api/tracking/pending-tracking/dismiss")
async def dismiss_tracking_approval(
    user_email:  str = Form(...),
    approval_id: str = Form(...),
):
    """
    User dismisses a pending tracking decision without tracking.
    Moves the entry to the AI Skipped log.
    """
    if not user_email or not approval_id:
        raise HTTPException(status_code=400, detail="Missing fields")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking not enabled for this account.")
    from services import dismiss_tracking_decision
    result = dismiss_tracking_decision(user_email, approval_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error", "Not found"))
    return result


@app.get("/api/tracking/skipped")
async def get_tracking_skipped(user_email: str):
    """
    Returns the AI-skipped (not-tracked) log for this user.
    Shown in the 'AI Skipped' tab of the tracking page.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    from services import load_not_tracked_log
    entries = load_not_tracked_log(user_email)
    return {"skipped": entries, "total": len(entries)}


@app.get("/api/tracking/digest")
async def get_digest(user_email: str):
    """
    Returns all Day-5+ outstanding items for the digest panel.
    Both internal and external non-repliers included.
    Auto-excludes anyone who has already replied or been dismissed.
    """
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking feature is not enabled for this account.")
    try:
        return {"digest": get_tracking_digest(user_email)}
    except Exception as e:
        log.error(f"get_digest error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/tracking/restore")
async def restore_skipped(
    user_email: str = Form(...),
    message_id: str = Form(...),
):
    """
    Move an AI-skipped email from the skipped log back into active tracking.
    Also fires an immediate Day-1 reminder if the email is already >= 1 business day old.
    """
    if not user_email or not message_id:
        raise HTTPException(status_code=400, detail="Missing fields")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking not enabled for this account.")
    try:
        from services import restore_skipped_to_tracking, approve_tracking_decision
        result = restore_skipped_to_tracking(user_email, message_id)
        if not result.get("ok"):
            raise HTTPException(status_code=404, detail=result.get("error", "Not found"))

        # Fire immediate reminder if already overdue — reuse approve_tracking_decision
        # logic by running the scheduler check directly on the restored entry
        try:
            from services import load_tracking, get_business_days_since, generate_reminder_body, save_tracking
            import httpx as _httpx
            from datetime import datetime

            ORG =ORG_BASE
            tracking = load_tracking(user_email)
            tracked  = next((t for t in tracking.get("tracked", []) if t["messageId"] == message_id), None)

            if tracked:
                sent_at = tracked.get("sentAt", "")
                bdays   = get_business_days_since(sent_at)
                subject = tracked.get("subject", "")
                sender_first = user_email.split("@")[0].split(".")[0].title()

                if bdays >= 1:
                    for addr, info in tracked.get("recipients", {}).items():
                        if info.get("replied") or info.get("dismissed") or info.get("type") == "external":
                            continue
                        if info.get("reminder1_sent") or info.get("reminder1_pending"):
                            continue

                        rec_first = addr.split("@")[0].split(".")[0].title()
                        orig_body = tracked.get("body", "")
                        draft_body = await generate_reminder_body(subject, rec_first, 1, sender_first, is_external=False)

                        import html as _html, re as _re
                        plain = _re.sub(r"<[^>]+>", " ", orig_body)
                        plain = _html.unescape(plain)
                        plain = _re.sub(r"[ \t]+", " ", plain).strip()
                        if len(plain) > 600:
                            plain = plain[:600].rstrip() + "…"
                        try:
                            sent_fmt = datetime.fromisoformat(sent_at.rstrip("Z")).strftime("%B %d, %Y")
                        except Exception:
                            sent_fmt = sent_at

                        context_html = (
                            f"<br/><br/><hr style='border:none;border-top:1px solid #ccc;margin:16px 0'/>"
                            f"<p style='color:#555;font-size:0.85em;margin:0 0 8px 0'>"
                            f"<strong>--- Original Message ---</strong><br/>"
                            f"<strong>Subject:</strong> {subject}<br/>"
                            f"<strong>Sent:</strong> {sent_fmt}<br/>"
                            f"<strong>To:</strong> {info.get('originalAddress', addr)}</p>"
                            f"<p style='color:#333;font-size:0.9em;white-space:pre-wrap;margin:0'>{plain}</p>"
                        )
                        full_html = draft_body.replace("\n", "<br/>") + context_html

                        parts = [
                            ("To",          (None, info.get("originalAddress", addr), "text/plain")),
                            ("Subject",     (None, f"Quick Follow-Up – {subject}", "text/plain")),
                            ("BodyHtml",    (None, full_html, "text/plain")),
                            ("FromEmail",   (None, "reminders@hfmg.net", "text/plain")),
                            ("Attachments", ("", b"", "application/octet-stream")),
                        ]
                        async with _httpx.AsyncClient(timeout=30) as hc:
                            r = await hc.post(f"{ORG}/api/Values/mail/SentAsRemainder", files=parts)

                        if r.status_code == 200:
                            info["reminder1_sent"]    = True
                            info["reminder1_sentAt"]  = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
                            info["reminder1_pending"] = False
                            log.info(f"[tracking] Immediate Day-1 reminder sent after restore → {addr} | '{subject}'")
                        else:
                            log.error(f"[tracking] Restore reminder failed for {addr}: {r.status_code} {r.text}")

                    # ── Safe merge-save: reload fresh then patch ONLY the reminder
                    # flags we just set.  A full recipients overwrite here would clobber
                    # any reply-status or reminder-flag changes the background scheduler
                    # wrote between our first load and now (race condition fix).
                    _REMINDER_FLAGS = (
                        "reminder1_sent", "reminder1_sentAt", "reminder1_pending",
                        "reminder2_sent", "reminder2_sentAt", "reminder2_pending",
                    )
                    tracking_fresh = load_tracking(user_email)
                    for t in tracking_fresh.get("tracked", []):
                        if t["messageId"] == message_id:
                            for _addr, _our in tracked["recipients"].items():
                                if _addr in t["recipients"]:
                                    _tgt = t["recipients"][_addr]
                                    for _flag in _REMINDER_FLAGS:
                                        # Only write the flag if we set it AND the fresh
                                        # record doesn't already have it (scheduler may
                                        # have beaten us to it — don't clobber).
                                        if _our.get(_flag) and not _tgt.get(_flag):
                                            _tgt[_flag] = _our[_flag]
                            break
                    save_tracking(tracking_fresh, user_email)

        except Exception as re:
            log.error(f"[tracking/restore] Immediate reminder error: {re}")
            # Don't fail the restore — email is tracked even if reminder fails

        return result

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        log.error(f"[tracking/restore] CRASH: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")



@app.post("/api/tracking/add-manual")
async def add_manual_tracking(payload: dict = Body(...)):
    """
    Manually add a sent email to active tracking from the Sent Items tab.
    Bypasses the AI / Needs Review gate — user has explicitly chosen to track this.

    Body: {
      user_email, messageId, conversationId, subject, sentAt,
      to, cc, body, notRepliedAddresses
    }

    On success:
      • Adds the email to tracking["tracked"] with manuallyAdded=true
      • Immediately fires Day-1 reminder if already >= 1 business day old
    """
    user_email = payload.get("user_email", "").strip()
    message_id = payload.get("messageId", "").strip()

    if not user_email or not message_id:
        raise HTTPException(status_code=400, detail="Missing user_email or messageId")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking not enabled for this account.")

    try:
        from services import (
            load_tracking, save_tracking, TRACKING_EXCLUDED,
            get_business_days_since, _send_reminder,
        )
        import httpx as _httpx
        ORG = ORG_BASE

        tracking      = load_tracking(user_email)
        tracked_by_id = {t["messageId"]: t for t in tracking.get("tracked", [])}

        if message_id in tracked_by_id:
            return {"ok": False, "detail": "Already being tracked"}

        sent_at   = payload.get("sentAt", "")
        subject   = payload.get("subject", "(no subject)")
        body      = payload.get("body", "")
        to_list   = payload.get("to") or []
        cc_list   = payload.get("cc") or []

        # ── EWS-computed reply status (from .NET GetSentMailsOfSevenDays) ──
        # notRepliedAddresses: explicit list of who has NOT replied yet.
        # repliedByAddresses:  explicit list of who HAS replied.
        # has_ews_data: True when the client sent notRepliedAddresses (even if []),
        #   meaning the .NET endpoint ran its In-Reply-To matching. Without this
        #   flag, an empty list would be indistinguishable from "field not provided".
        # OLD BUG: `replied = bool(not_rep) and (a not in not_rep)` → if not_rep
        #   was [] (everyone replied), bool([]) = False → replied = False for all.
        #   This caused reminders to fire even when every recipient had replied.
        has_ews_data   = payload.get("notRepliedAddresses") is not None
        not_rep_set    = {a.lower() for a in (payload.get("notRepliedAddresses") or [])}
        replied_set    = {a.lower() for a in (payload.get("repliedByAddresses")  or [])}

        # Build recipients from To + CC, excluding system addresses
        all_addresses = list(dict.fromkeys(to_list + cc_list))
        recipients = {}
        for addr in all_addresses:
            a = addr.lower()
            if a in TRACKING_EXCLUDED:
                continue

            if has_ews_data:
                # Trust EWS: anyone in not_rep_set hasn't replied → track them.
                # Anyone NOT in not_rep_set (i.e. in replied_set or simply absent)
                # has already replied → mark replied=True so no reminder is sent.
                has_replied = a not in not_rep_set
            else:
                # No EWS data provided → assume everyone still needs follow-up.
                has_replied = False

            recipients[a] = {
                "originalAddress": addr,
                "type":            "internal" if "hfmg.net" in a else "external",
                "replied":         has_replied,
                "reminder1_sent":  False,
                "reminder1_sentAt": None,
                "reminder2_sent":  False,
                "reminder2_sentAt": None,
                "dismissed":       False,
                "dismissedAt":     None,
                "manuallyAdded":   True,
            }

        if not recipients:
            raise HTTPException(status_code=400, detail="No trackable recipients found (all are excluded or empty)")

        # If EWS tells us everyone has already replied, nothing to track.
        pending_recipients = {a: r for a, r in recipients.items() if not r["replied"]}
        if has_ews_data and not pending_recipients:
            log.info(f"[tracking/add-manual] All recipients replied for '{subject}' — skipping")
            return {
                "ok": False,
                "detail": "All recipients have already replied — nothing to track.",
            }

        log.info(
            f"[tracking/add-manual] '{subject}' → "
            f"{len(pending_recipients)} pending / {len(recipients) - len(pending_recipients)} replied "
            f"for {user_email}"
        )

        new_record = {
            "messageId":      message_id,
            "conversationId": payload.get("conversationId", ""),
            "subject":        subject,
            "sentAt":         sent_at,
            "body":           body[:5000],
            "recipients":     recipients,
            "resolved":       False,
            "resolvedAt":     None,
            "ai_reason":      "Manually added from Sent Items",
            "manuallyAdded":  True,
        }
        tracked_by_id[message_id] = new_record
        tracking["tracked"]     = list(tracked_by_id.values())
        tracking["lastUpdated"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
        save_tracking(tracking, user_email)

        log.info(f"[tracking/add-manual] '{subject}' → {len(pending_recipients)} pending / {len(recipients) - len(pending_recipients)} replied for {user_email}")

        # Immediately fire reminders if already overdue
        bdays        = get_business_days_since(sent_at)
        sender_first = user_email.split("@")[0].split(".")[0].title()
        reminders_sent = []

        if bdays >= 1:
            async with _httpx.AsyncClient(timeout=30) as hc:
                for addr, info in recipients.items():
                    if info.get("replied") or info.get("dismissed"):
                        continue
                    if info.get("type") == "external":
                        continue

                    # Day-1
                    if not info.get("reminder1_sent"):
                        ok = await _send_reminder(
                            hc, addr, info, 1,
                            subject, sent_at, body, sender_first, ORG
                        )
                        if ok:
                            reminders_sent.append(f"{addr} (Day-1)")
                            log.info(f"[tracking/add-manual] Immediate Day-1 → {addr}")

                    # Day-3 (separate if)
                    if bdays >= 3 and info.get("reminder1_sent") and not info.get("reminder2_sent"):
                        ok = await _send_reminder(
                            hc, addr, info, 3,
                            subject, sent_at, body, sender_first, ORG
                        )
                        if ok:
                            reminders_sent.append(f"{addr} (Day-3)")
                            log.info(f"[tracking/add-manual] Immediate Day-3 → {addr}")

            if reminders_sent:
                # ── Safe merge-save: reload fresh then patch ONLY the reminder
                # flags we just set.  A full recipients overwrite here would clobber
                # any reply-status or reminder-flag changes the background scheduler
                # wrote between save #1 (above) and now (race condition fix).
                _REMINDER_FLAGS = (
                    "reminder1_sent", "reminder1_sentAt", "reminder1_pending",
                    "reminder2_sent", "reminder2_sentAt", "reminder2_pending",
                )
                tracking_fresh = load_tracking(user_email)
                for t in tracking_fresh.get("tracked", []):
                    if t["messageId"] == message_id:
                        for _addr, _our in new_record["recipients"].items():
                            if _addr in t["recipients"]:
                                _tgt = t["recipients"][_addr]
                                for _flag in _REMINDER_FLAGS:
                                    # Only write the flag if we set it AND the fresh
                                    # record doesn't already have it (scheduler may
                                    # have beaten us to it — don't clobber).
                                    if _our.get(_flag) and not _tgt.get(_flag):
                                        _tgt[_flag] = _our[_flag]
                        break
                save_tracking(tracking_fresh, user_email)

        return {
            "ok": True,
            "subject":        subject,
            "recipients":     len(recipients),
            "pending_count":  len(pending_recipients),   # how many still need follow-up
            "replied_count":  len(recipients) - len(pending_recipients),
            "reminders_sent": reminders_sent,
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        log.error(f"[tracking/add-manual] CRASH: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")

@app.post("/api/analyze-sent-thread")
async def analyze_sent_thread(payload: dict = Body(...)):
    """
    AI analysis of a sent email thread from the Sent Items tab.
    Works for both single emails and full threads.

    Flow:
      1. Call .NET onemail (conversationId-based search, inbox + sent).
      2. If list comes back empty (edge case), fallback to direct primary-email fetch.
      3. Normalize PascalCase .NET fields → camelCase before AI analysis.

    Body: { user_email, messageId, subject, notRepliedAddresses? }
    Returns: { needs_reply, verdict, pending, analysis, confidence }
    """
    user_email  = payload.get("user_email", "").strip()
    message_id  = payload.get("messageId", "").strip()
    subject     = payload.get("subject", "")
    not_replied = payload.get("notRepliedAddresses") or []

    if not user_email or not message_id:
        raise HTTPException(status_code=400, detail="Missing user_email or messageId")

    org_url = f"{ORG_BASE}/api/Values/inbox/onemail"
    params  = {"messageId": message_id, "targetUserEmail": user_email}

    def _norm(msg: dict) -> dict:
        """
        Normalize a .NET MailDto from PascalCase to camelCase.
        Handles both C# default serialization (PascalCase) and
        previously-normalized (camelCase) objects transparently.
        """
        if not isinstance(msg, dict):
            return {}
        return {
            "from":          msg.get("from")        or msg.get("From")        or "",
            "to":            msg.get("to")          or msg.get("To")          or [],
            "cc":            msg.get("cc")          or msg.get("Cc")          or [],
            "subject":       msg.get("subject")     or msg.get("Subject")     or "",
            "body":          msg.get("body")        or msg.get("Body")        or "",
            "received":      msg.get("received")    or msg.get("Received")    or
                             msg.get("received_at") or msg.get("date")        or "",
            "messageId":     msg.get("messageId")   or msg.get("MessageId")   or "",
            "conversationId":msg.get("conversationId") or msg.get("ConversationId") or "",
            "attachments":   msg.get("attachments") or msg.get("Attachments") or [],
        }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(org_url, params=params)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Mail server error: {resp.text[:200]}"
            )
        data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Mail server timeout")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Cannot reach mail server")

    # ── Extract + normalise all thread messages ───────────────────────────────
    if isinstance(data, list):
        raw_messages = data
    elif isinstance(data, dict):
        # Legacy shape: dict with optional messages[] inside
        raw_messages = data.get("messages") or data.get("Messages") or [data]
    else:
        raw_messages = []

    thread_messages = [_norm(m) for m in raw_messages if isinstance(m, dict)]

    # ── Fallback: empty list means EWS conversationId search returned nothing ─
    # Re-fetch via email-details (which also hits onemail but already has its
    # own normalisation + primary-email fallback logic).
    if not thread_messages:
        log.warning(
            f"[analyze-sent-thread] onemail returned empty list for "
            f"messageId={message_id[:20]}… — falling back to email-details"
        )
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                fb = await client.get(
                    "http://localhost:8000/api/email-details",
                    params={"messageId": message_id, "userEmail": user_email}
                )
            if fb.status_code == 200:
                fb_data = fb.json()
                # email-details always returns a normalized dict with optional messages[]
                if isinstance(fb_data.get("messages"), list) and fb_data["messages"]:
                    thread_messages = [_norm(m) for m in fb_data["messages"]]
                else:
                    thread_messages = [_norm(fb_data)]
        except Exception as fb_err:
            log.error(f"[analyze-sent-thread] fallback fetch failed: {fb_err}")

    log.info(
        f"[analyze-sent-thread] {len(thread_messages)} message(s) for "
        f"'{subject[:40]}' — user={user_email}"
    )

    result = await analyze_sent_thread_reply(
        thread_messages=thread_messages,
        user_email=user_email,
        subject=subject,
        not_replied_addresses=not_replied,
    )
    return result


# ── Corrections — shared human-feedback store ─────────────────────────────────
# Stores user flags when an email is wrongly classified.
# Deduplication rules:
#   1. Same messageId + same correctedCategory   → increment count
#   2. Same original + corrected + fromDomain    → increment count (same pattern)
#   3. Otherwise                                 → new entry, count = 1
# AI prompt injection activates once count >= 2.

CORRECTIONS_FILE = Path("data/corrections.json")

def _load_corrections() -> list:
    try:
        if CORRECTIONS_FILE.exists():
            return json.loads(CORRECTIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []

def _save_corrections(data: list):
    CORRECTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CORRECTIONS_FILE.write_text(
        json.dumps(data, indent=2, default=str),
        encoding="utf-8"
    )

@app.post("/api/corrections")
async def add_correction(payload: dict = Body(...)):
    corrections = _load_corrections()
    message_id  = payload.get("messageId",         "").strip()
    original    = payload.get("originalCategory",  "").upper().strip()
    corrected   = payload.get("correctedCategory", "").upper().strip()
    from_domain = payload.get("fromDomain",        "").lower().strip()
    reason      = payload.get("reason",            "").strip()

    if not corrected:
        raise HTTPException(status_code=400, detail="correctedCategory is required")

    # Rule 1 — same message re-flagged
    for c in corrections:
        if c.get("messageId") == message_id and c.get("correctedCategory") == corrected and message_id:
            c["count"] = c.get("count", 1) + 1
            if reason:
                c["reason"] = reason
            _save_corrections(corrections)
            log.info(f"[corrections] updated (msg match) count={c['count']} {original}→{corrected}")
            return {"ok": True, "count": c["count"], "new": False}

    # Rule 2 — same pattern (domain + direction)
    if from_domain:
        for c in corrections:
            if (c.get("originalCategory") == original
                    and c.get("correctedCategory") == corrected
                    and c.get("fromDomain") == from_domain):
                c["count"] = c.get("count", 1) + 1
                _save_corrections(corrections)
                log.info(f"[corrections] updated (pattern) count={c['count']} @{from_domain} {original}→{corrected}")
                return {"ok": True, "count": c["count"], "new": False}

    # Rule 3 — new correction
    corrections.append({
        "id":                str(uuid.uuid4()),
        "messageId":         message_id,
        "subject":           payload.get("subject", "")[:100],
        "fromDomain":        from_domain,
        "bodySnippet":       payload.get("bodySnippet", "")[:300],
        "originalCategory":  original,
        "correctedCategory": corrected,
        "reason":            reason,
        "flaggedAt":         datetime.now().isoformat(),
        "count":             1,
    })
    _save_corrections(corrections)
    log.info(f"[corrections] new {original}→{corrected} @{from_domain} count=1")
    return {"ok": True, "count": 1, "new": True}


@app.get("/api/corrections")
async def list_corrections():
    """Return all stored corrections (admin visibility)."""
    return _load_corrections()


@app.post("/api/tracking/sync")
async def sync_tracking(payload: dict = Body(...)):
    """
    Manually trigger the tracking scheduler for a user.
    Body: { user_email }
    Used by the frontend Tracking tab refresh button.
    """
    user_email = payload.get("user_email")
    if not user_email:
        raise HTTPException(status_code=400, detail="Missing user_email")
    if not is_tracking_allowed(user_email):
        raise HTTPException(status_code=403, detail="Tracking feature is not enabled for this account.")
    _active_tracking_users.add(user_email)
    asyncio.create_task(run_tracking_scheduler(user_email))
    return {"success": True, "message": "Tracking sync started"}

# ─────────────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        access_log=False,          # silence per-request noise
        log_level="error"          # uvicorn internal logs: errors only
    )