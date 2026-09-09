"""
iris_service.py — Iris, the Inbox Assistant (Phase 3)
─────────────────────────────────────────────────────────────────────────
Kept separate from services.py on purpose so this feature stays easy to
find, iterate on, and (if needed) rip out, without touching the existing
analysis/tracking/reply logic.

Iris can call these tools mid-conversation:
  - draft_reply            -> reuses services.draft_email_reply() as-is
  - check_tracking_status   -> reuses services.get_tracking_summary() /
                                get_tracking_digest() as-is (gated by
                                services.is_tracking_allowed())
  - search_emails           -> keyword search over
                                services.get_cached_emails_by_id(), which
                                accumulates every email the analysis
                                pipeline has ever seen for this user
                                (NOT the person's entire mailbox — see
                                search_cached_emails() below for the exact
                                scope/caveats)
  - list_emails             -> the same scope browsed by facet instead of
                                keyword (category / sender / last N days),
                                for questions with no word to search on
  - read_email              -> full body + reply chain from the offline
                                detail cache. Without this Iris only ever
                                saw one-line summaries and had never
                                actually read an email
  - get_calendar            -> upcoming meetings, via main.get_meetings so
                                its caching and stale-fallback are reused

Iris still cannot SEND anything or take any other action — draft_reply
only returns text for the person to review. That distinction is spelled
out in the system prompt below on purpose.

Reuses the same OpenAI client + model already configured in services.py
rather than standing up a second client, and reuses draft_email_reply /
get_tracking_summary / get_tracking_digest / is_tracking_allowed exactly
as they already exist — none of those were modified.
"""

import json
import re
import asyncio
import html as _html
from datetime import datetime, timedelta
from typing import Optional

from services import (
    client,
    ACTIVE_MODEL,
    log,
    draft_email_reply,
    is_tracking_allowed,
    get_tracking_summary,
    get_tracking_digest,
    get_cached_emails_by_id,
    get_cached_detail,
    has_cached_detail,
)

# Words carried by ordinary questions that would otherwise have to appear in
# the email itself for a match — "the report from Deepa" should search for
# "report" and "Deepa", not for "from" and "the".
_SEARCH_STOPWORDS = {
    "the", "a", "an", "of", "for", "from", "to", "in", "on", "at", "by",
    "with", "about", "and", "or", "is", "was", "are", "were", "be", "been",
    "my", "me", "i", "we", "our", "you", "your", "it", "this", "that",
    "any", "all", "get", "show", "find", "search", "look", "tell", "give",
    "what", "which", "who", "when", "where", "how", "did", "do", "does",
    "email", "emails", "mail", "mails", "message", "messages", "please",
    "latest", "recent", "last", "new",
}

IRIS_SYSTEM_PROMPT = """
You are Iris, the inbox assistant built into the HFMG (Horizon Family
Medical Group) AI Email Dashboard.

TONE: Warm but professional — approachable, never stiff, but this is a
healthcare organization's internal tool, so stay polished. Keep replies
concise; default to a few sentences unless the person asks for something
longer (like a drafted email).

RESPONSE STRUCTURE: shape your formatting to match what's actually being
asked — don't answer everything in the same loose paragraph.

- Drafting or rewriting an email (including presenting a draft_reply
  result): use real email structure on separate lines — greeting, a
  blank line, the body as short clear paragraphs, a blank line, then
  the sign-off. When presenting a draft_reply tool result specifically,
  keep its wording and structure intact — don't compress it into a
  single paragraph or paraphrase it into prose.

- Summarizing (an inbox, a thread, "catch me up", etc.): write organized,
  connected prose grouped by what actually matters (e.g. what's urgent
  vs. what's routine) — not a flat restatement of every field in the
  snapshot as a disconnected list.

- Status/tracking checks: brief, grouped by category (overdue vs.
  awaiting vs. resolved) since that data is naturally categorical — a
  short line per group beats one long paragraph here.

- Everything else (questions, casual chat): plain, direct prose sized to
  the question — a one-line question gets a short answer, not an
  artificially padded one.

Structure using plain text only — blank lines between sections, natural
paragraph breaks, line breaks where an email needs them. Do not use
markdown symbols like ** or ### or bullet dashes: they render as literal
stray characters here, not formatting.

WHAT YOU CAN SEE: some messages include an INBOX SNAPSHOT below — a
lightweight view of the person's current inbox: counts, a handful of
thread-level summaries, and a short list of recent emails (sender,
subject, category, and a one-line AI-generated summary). This is a
snapshot, not the full inbox — it does not include every email, and it
never includes full email body text, only short summaries.

Use the snapshot to answer questions grounded in what's actually there.
If a question needs something the snapshot doesn't cover, try a tool
before saying you can't help — you have three:

1. draft_reply — drafts reply text to a specific sender. This ONLY
   produces text for the person to review; it does NOT send anything.
   Always present what it returns as a draft ("Here's a draft you can
   send:") — never say or imply you sent or will send an email.

2. check_tracking_status — looks up the person's follow-up tracking:
   emails they sent that are awaiting a reply, already had a reminder
   sent, or are overdue (5+ business days). Use for anything about
   follow-ups or who hasn't replied yet.

3. search_emails — searches emails the dashboard has already analyzed
   for this person. This is NOT their entire mailbox history — only
   what's been processed so far. If a search comes back empty, say it
   wasn't found in what's been analyzed rather than concluding it
   doesn't exist anywhere.

4. list_emails — browse by filter instead of by keyword: category
   (URGENT, PRIORITY, NEWSLETTER, ...), sender, or "last N days". Reach
   for this whenever the question has no specific word to search on —
   "what's urgent", "what came in today", "anything from Deepa this
   week". search_emails finds a known topic; list_emails surveys. Both
   cover only what has been analysed so far.

5. get_calendar — the person's upcoming meetings. Use for schedule
   questions, whether they are free at a given time, or whether a time
   someone is proposing by email clashes with something already booked.

6. read_email — opens ONE email's full text and reply chain, by the
   messageId that search_emails or list_emails returns. Those results
   only carry one-line summaries, so reach for this whenever the answer
   depends on what was actually written: exact figures, dates, names,
   what someone specifically asked for, or before drafting a reply to a
   particular email. Prefer reading the email over hedging from a
   summary. Typical flow: search_emails to find it, then read_email to
   actually read it.

If a tool returns an error or empty result, say so plainly. Never invent
specific senders, subjects, dates, drafts, or tracking statuses that
didn't come from the snapshot, a tool result, or the conversation itself.

CURRENT CAPABILITIES (be honest if asked): you can chat, answer
questions grounded in the snapshot, browse and search analysed email,
read the full text of emails that have been cached, look at the person's
upcoming calendar, draft (but not send) email replies, and check
tracking/follow-up status. You cannot send email, change the calendar,
or reach beyond the mail that has already been analysed.
""".strip()


def _build_session_block(user_name: str, user_email: str) -> str:
    """
    Who is asking and what day it is. Without this the model has no idea
    what "today", "this week" or "overdue" mean, so anything time-relative
    was guesswork — and it couldn't address the person by name.
    """
    now = datetime.now()
    return (
        f"CURRENT SESSION\n"
        f"You are speaking with: {user_name} ({user_email})\n"
        f"Today is {now.strftime('%A, %d %B %Y')}, local time {now.strftime('%H:%M')}.\n"
        f"Resolve relative dates against this — 'today', 'yesterday', 'this week', "
        f"'overdue' — and prefer concrete dates over vague wording in your answers."
    )

# Defensive backstop — the frontend already caps list sizes before
# sending, but this protects against a runaway payload regardless.
MAX_SNAPSHOT_CHARS = 12000


def _build_context_block(inbox_context: Optional[dict]) -> str:
    """
    Turns the frontend's inbox snapshot ({stats, threads, recent_emails})
    into a text block for the model. Fails safe: any problem here returns
    an honest "not available" note instead of raising, so a malformed or
    missing snapshot never breaks the whole chat request.
    """
    if not inbox_context:
        return (
            "INBOX SNAPSHOT: not available for this message. Answer only "
            "from the conversation itself, and say so plainly if the "
            "question actually needs inbox data."
        )

    try:
        snapshot_json = json.dumps(inbox_context, indent=2, default=str)
    except Exception:
        return (
            "INBOX SNAPSHOT: unavailable (could not be read). Answer only "
            "from the conversation itself."
        )

    if len(snapshot_json) > MAX_SNAPSHOT_CHARS:
        snapshot_json = snapshot_json[:MAX_SNAPSHOT_CHARS] + "\n... (truncated)"

    return f"INBOX SNAPSHOT (JSON):\n{snapshot_json}"


async def _chat_with_retry(**kwargs):
    """
    One transient network blip should not turn into "Something went wrong
    reaching Iris". Retries connection/timeout style failures a couple of
    times before giving up, the same way the analysis pipeline does.
    """
    last_err = None
    for attempt in range(3):
        try:
            return await client.chat.completions.create(**kwargs)
        except Exception as e:
            last_err = e
            if attempt < 2:
                wait = 1.5 * (attempt + 1)
                log.warning(f"Iris model call attempt {attempt + 1} failed ({type(e).__name__}), retrying in {wait}s")
                await asyncio.sleep(wait)
    raise last_err


def _to_openai_messages(history: list) -> list:
    """
    Converts the frontend's message shape ({role: 'user'|'iris', text})
    into OpenAI's expected shape ({role: 'user'|'assistant', content}).
    Silently skips malformed entries instead of raising, since this is
    fed by client-side state we don't fully control.
    """
    role_map = {"user": "user", "iris": "assistant"}
    converted = []
    for item in history or []:
        role = role_map.get(item.get("role"))
        text = item.get("text")
        if role and text:
            converted.append({"role": role, "content": text})
    return converted


# ─── PHASE 3: TOOL DEFINITIONS ──────────────────────────────────────────────

MAX_SEARCH_RESULTS = 12  # keep tool results small — this is a chat reply, not a report
MAX_TOOL_ROUNDS = 5      # hard cap on model<->tool round-trips per message, prevents runaway loops
MAX_HISTORY_MESSAGES = 12  # recent turns kept; older ones dropped to bound cost

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "draft_reply",
            "description": (
                "Draft reply text to a specific sender. Returns ONLY drafted "
                "text for the person to review — this never sends anything. "
                "Always present the result as a draft, never as a sent email."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sender": {
                        "type": "string",
                        "description": "Email address (or name) of the person being replied to.",
                    },
                    "context": {
                        "type": "string",
                        "description": (
                            "What the reply needs to cover — summarize the original "
                            "email/situation and what the person wants to say back."
                        ),
                    },
                },
                "required": ["sender", "context"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_tracking_status",
            "description": (
                "Check the person's follow-up tracking status — sent emails "
                "awaiting a reply, reminders already sent, or overdue items "
                "(5+ business days with no reply). Use for anything about "
                "follow-ups or who hasn't responded yet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["awaiting", "overdue", "all"],
                        "description": (
                            "'awaiting' = general awaiting-reply list, 'overdue' = "
                            "only Day-5+ items needing attention, 'all' = full summary "
                            "(awaiting + reminders sent + resolved counts)."
                        ),
                    },
                },
                "required": ["scope"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_emails",
            "description": (
                "Search emails the dashboard has already analyzed for this "
                "person, matching sender, subject, or summary text. NOT the "
                "person's entire mailbox history — only what's been processed "
                "so far. An empty result means 'not found in what's been "
                "analyzed', not 'doesn't exist'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Keyword(s) — a sender name/email, subject topic, etc. "
                            "Words are matched individually, so a natural phrase is fine."
                        ),
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_email",
            "description": (
                "Read the FULL text of one email, including the whole reply "
                "chain. Use this whenever answering needs the actual wording "
                "rather than a one-line summary — what someone specifically "
                "asked for, exact figures, dates, names, commitments, or "
                "before drafting a reply to a particular email. Find the "
                "email with search_emails first, then pass its messageId."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {
                        "type": "string",
                        "description": "The messageId returned by search_emails.",
                    },
                },
                "required": ["message_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_emails",
            "description": (
                "Browse analysed emails by filter rather than by keyword — "
                "use this whenever there is no specific word to search for. "
                "Handles 'what's urgent', 'anything from Deepa this week', "
                "'what came in today', 'show me the newsletters'. Returns "
                "newest first. Combine filters freely; omit them all for a "
                "plain recent list."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["VIP", "PRIORITY", "URGENT", "CONFIDENTIAL",
                                 "MEETING", "ZOOM", "NEWSLETTER", "NORMAL"],
                        "description": "Restrict to one category.",
                    },
                    "sender": {
                        "type": "string",
                        "description": "Full or partial sender name/address.",
                    },
                    "days": {
                        "type": "integer",
                        "description": "Only emails from the last N days (1 = today).",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_calendar",
            "description": (
                "The person's upcoming meetings from the org calendar. Use "
                "for anything about their schedule — what's on today or "
                "tomorrow, whether they're free, or whether a proposed time "
                "clashes with something already booked."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {
                        "type": "integer",
                        "description": "How far forward to look. 1 = today only, 7 = the week ahead.",
                    },
                },
                "required": [],
            },
        },
    },
]


# Roughly how much of one email's text to hand the model. Generous enough for
# a long thread, bounded so a newsletter can't crowd out the conversation.
MAX_EMAIL_TEXT_CHARS = 6000
MAX_THREAD_MESSAGES = 6


def _html_to_text(raw: str) -> str:
    """
    Flatten an HTML email body to readable plain text. The model reasons far
    better over prose than over Outlook's nested tables and inline styles,
    and it keeps the token cost of a full body sane.
    """
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|li|h[1-6])>", "\n", text)
    text = re.sub(r"(?i)</t[dh]>", "\t", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = _html.unescape(text)
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def read_cached_email(user_email: str, message_id: str) -> dict:
    """
    Return the full readable text of one email plus its reply chain, from
    the offline detail cache that the background prefetcher fills.

    This is the capability Iris was missing entirely: the id-cache it
    searched has bodies stripped, so every answer was a paraphrase of a
    one-line summary. The bodies were already on disk — nothing could read
    them.
    """
    if not message_id:
        return {"error": "read_email needs a message_id from search_emails."}

    detail = get_cached_detail(user_email, message_id)
    if not detail:
        return {
            "error": (
                "That email's full text isn't cached yet. Answer from its "
                "summary and say the full text wasn't available."
            )
        }

    body_text = _html_to_text(detail.get("body") or "")
    payload = {
        "subject": detail.get("subject") or "No Subject",
        "from": detail.get("from") or "Unknown",
        "to": detail.get("to") or [],
        "cc": detail.get("cc") or [],
        "received": detail.get("received") or "",
        "body": body_text[:MAX_EMAIL_TEXT_CHARS],
        "attachments": [a.get("name") for a in (detail.get("attachments") or []) if a.get("name")],
    }
    if len(body_text) > MAX_EMAIL_TEXT_CHARS:
        payload["body_truncated"] = True

    # Newest-first, so a long chain spends its budget on what matters most.
    messages = detail.get("messages") or []
    if len(messages) > 1:
        trimmed = []
        for m in list(reversed(messages))[:MAX_THREAD_MESSAGES]:
            if not isinstance(m, dict):
                continue
            mt = _html_to_text(m.get("body") or m.get("Body") or "")
            trimmed.append({
                "from": m.get("from") or m.get("From") or "Unknown",
                "received": m.get("received") or m.get("Received") or "",
                "text": mt[:2000],
            })
        payload["thread"] = trimmed
        payload["thread_message_count"] = len(messages)

    return payload


def search_cached_emails(user_email: str, query: str, limit: int = MAX_SEARCH_RESULTS) -> list:
    """
    Searches services.get_cached_emails_by_id(user_email) — the
    accumulating, ID-keyed cache populated every time the analysis
    pipeline processes a batch of emails for this user. This is the
    closest thing to "email history" this app has; it is NOT a live
    search of the person's actual mailbox.

    That cache also contains lightweight thread-pointer stub entries
    (secondary message IDs in a thread, stored as just
    {id, messageId, _threadRef}) — those are filtered out here since
    they have no subject/summary and would just show up as noise.

    Matching is per-word, not whole-phrase. The previous version required
    the entire query to appear as one contiguous substring, so a natural
    question like "report from Deepa" scored zero even when both "report"
    and "Deepa" were present — which read as "Iris can't find anything".
    Every meaningful word must appear somewhere in the email (subject,
    summary or sender), in any order.

    Results are ranked rather than taken in whatever order the cache
    happens to iterate: subject hits beat summary hits, then newest first.
    Asking "the latest from X" used to be able to return the oldest match.
    """
    words = [w for w in re.split(r"\W+", (query or "").lower()) if len(w) > 1]
    words = [w for w in words if w not in _SEARCH_STOPWORDS]
    if not words:
        return []

    try:
        cached = get_cached_emails_by_id(user_email) or {}
    except Exception as e:
        log.error(f"search_cached_emails: get_cached_emails_by_id failed: {e}")
        return []

    scored = []
    seen_ids = set()

    for entry in cached.values():
        if not isinstance(entry, dict):
            continue
        if entry.get("_threadRef"):   # skip thread-pointer stubs — no real content
            continue

        subject = entry.get("subject") or ""
        summary = entry.get("summary") or ""
        sender = entry.get("from") or entry.get("sender") or ""
        subject_l, summary_l, sender_l = subject.lower(), summary.lower(), sender.lower()
        haystack = f"{subject_l} {summary_l} {sender_l}"

        matched = [w for w in words if w in haystack]
        if not matched:
            continue

        eid = entry.get("id") or entry.get("messageId")
        if eid and eid in seen_ids:
            continue
        if eid:
            seen_ids.add(eid)

        # Weight where the words landed — a subject or sender match is a
        # stronger signal of relevance than a passing mention in a summary.
        score = sum(
            (3 if w in subject_l else 0) + (2 if w in sender_l else 0) + (1 if w in summary_l else 0)
            for w in matched
        )
        received = entry.get("received_at") or entry.get("received") or ""

        scored.append((len(matched), score, str(received), {
            "messageId": eid,
            "from": sender or "Unknown Sender",
            "subject": subject or "No Subject",
            "category": entry.get("category") or "NORMAL",
            "summary": summary,
            "received_at": received,
            "unread": entry.get("isRead") is False,
            "has_full_text": has_cached_detail(user_email, eid) if eid else False,
        }))

    # Prefer emails matching every word; if none do, fall back to the best
    # partial matches rather than returning nothing. A conversational query
    # like "what did Shahana send about productivity" rarely has all its
    # words in one subject line, and an empty answer reads as "Iris can't
    # find anything" when the email is sitting right there.
    full_matches = [t for t in scored if t[0] == len(words)]
    pool = full_matches if full_matches else scored

    # Most words matched first, then relevance weighting, then most recent.
    pool.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    return [item for _, _, _, item in pool[:limit]]


def _parse_received(raw) -> Optional[datetime]:
    """
    Best-effort parse of the assorted date shapes the mail server returns.
    Returns None rather than raising — a row with an unreadable date should
    drop out of a date filter, not break the whole listing.
    """
    if not raw:
        return None
    text = str(raw).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except Exception:
        return None


def list_cached_emails(
    user_email: str,
    category: str = None,
    sender: str = None,
    days: int = None,
    limit: int = MAX_SEARCH_RESULTS,
) -> dict:
    """
    Browse the analysed cache by facet rather than by keyword.

    search_emails can only answer when there's a word to match on, so
    "what's urgent this week" had no route at all — this fills that gap.
    Scope is the emails already analysed for this user, same as search.
    """
    try:
        cached = get_cached_emails_by_id(user_email) or {}
    except Exception as e:
        log.error(f"list_cached_emails: cache read failed: {e}")
        return {"error": "Couldn't read the analysed inbox just now."}

    cat = (category or "").strip().upper() or None
    who = (sender or "").strip().lower() or None
    cutoff = datetime.now() - timedelta(days=days) if days else None

    rows = []
    for entry in cached.values():
        if not isinstance(entry, dict) or entry.get("_threadRef"):
            continue
        if cat and (entry.get("category") or "NORMAL").upper() != cat:
            continue
        frm = entry.get("from") or entry.get("sender") or ""
        if who and who not in frm.lower():
            continue

        when = _parse_received(entry.get("received_at") or entry.get("received"))
        if cutoff and (when is None or when < cutoff):
            continue

        eid = entry.get("id") or entry.get("messageId")
        rows.append({
            "messageId": eid,
            "from": frm or "Unknown Sender",
            "subject": entry.get("subject") or "No Subject",
            "category": entry.get("category") or "NORMAL",
            "summary": entry.get("summary") or "",
            "received_at": entry.get("received_at") or entry.get("received"),
            "unread": entry.get("isRead") is False,
            "has_attachments": bool(entry.get("hasAttachments")),
            "has_full_text": has_cached_detail(user_email, eid) if eid else False,
            "_sort": when or datetime.min,
        })

    rows.sort(key=lambda r: r["_sort"], reverse=True)
    total = len(rows)
    for r in rows:
        r.pop("_sort", None)

    return {
        "emails": rows[:limit],
        "returned": min(total, limit),
        "total_matching": total,
        "filters": {"category": cat, "sender": who, "days": days},
        "note": (
            "Scope is the emails analysed so far for this person, newest "
            "first — not their entire mailbox history."
        ),
    }


async def get_calendar_window(user_email: str, days_ahead: int = 7) -> dict:
    """
    Upcoming meetings from the org calendar.

    Imported lazily from main so this module keeps working standalone and
    doesn't create a circular import (main imports this module at startup).
    Reuses the endpoint's own caching and its stale-cache fallback, so a
    calendar question during an outage still gets the last known schedule.
    """
    try:
        from main import get_meetings   # local import: avoids a cycle at load
        today = datetime.now().date()
        end = today + timedelta(days=max(1, min(days_ahead, 60)))
        meetings = await get_meetings(
            email=user_email,
            startDate=today.isoformat(),
            endDate=end.isoformat(),
        )
    except Exception as e:
        log.error(f"get_calendar_window failed: {e}")
        return {"error": "Couldn't reach the calendar just now."}

    items = meetings if isinstance(meetings, list) else []
    slim = []
    for m in items[:25]:
        if not isinstance(m, dict):
            continue
        slim.append({
            "subject": m.get("subject") or m.get("Subject") or "No Subject",
            "start": m.get("start") or m.get("Start") or m.get("startTime"),
            "end": m.get("end") or m.get("End") or m.get("endTime"),
            "organizer": m.get("organizer") or m.get("Organizer") or "",
            "location": m.get("location") or m.get("Location") or "",
        })
    return {
        "from": datetime.now().date().isoformat(),
        "days_ahead": days_ahead,
        "count": len(slim),
        "meetings": slim,
    }


def _slim_tracking_item(item: dict) -> dict:
    """
    Strips a tracking item down to what's useful in a chat answer —
    drops the stored email `body` entirely and reduces the recipients
    dict to just email + reply status, instead of every internal flag.
    """
    recipients = item.get("recipients", {}) or {}
    return {
        "subject": item.get("subject", "No Subject"),
        "sentAt": item.get("sentAt"),
        "businessDays": item.get("businessDays"),
        "recipients": [
            {"email": addr, "replied": bool(info.get("replied"))}
            for addr, info in recipients.items()
        ],
    }


async def _execute_tool_call(name: str, arguments: dict, user_email: str, user_name: str) -> str:
    """
    Runs the named tool and returns a JSON string to feed back to the
    model as the tool result. Never raises — any failure becomes a
    plain {"error": ...} JSON string instead, so one bad tool call
    can't take down the whole chat request.
    """
    try:
        if name == "draft_reply":
            sender = (arguments or {}).get("sender", "").strip()
            context = (arguments or {}).get("context", "").strip()
            if not sender or not context:
                return json.dumps({"error": "draft_reply needs both a sender and context."})
            draft = await draft_email_reply(sender, context, user_name)
            return json.dumps({"draft": draft})

        elif name == "check_tracking_status":
            if not is_tracking_allowed(user_email):
                return json.dumps({"error": "Tracking isn't enabled for this account."})

            scope = (arguments or {}).get("scope", "all")

            if scope == "overdue":
                digest = get_tracking_digest(user_email)
                return json.dumps({"overdue": digest[:15]}, default=str)

            summary = get_tracking_summary(user_email)
            awaiting = summary.get("awaiting", [])
            reminders_sent = summary.get("reminders_sent", [])
            resolved = summary.get("resolved", [])

            payload = {
                "awaiting_count": len(awaiting),
                "reminders_sent_count": len(reminders_sent),
                "resolved_count": len(resolved),
            }
            if scope in ("awaiting", "all"):
                payload["awaiting"] = [_slim_tracking_item(i) for i in awaiting[:15]]
            if scope == "all":
                payload["reminders_sent"] = [_slim_tracking_item(i) for i in reminders_sent[:15]]

            return json.dumps(payload, default=str)

        elif name == "search_emails":
            query = (arguments or {}).get("query", "")
            results = search_cached_emails(user_email, query)
            return json.dumps({
                "results": results,
                "count": len(results),
                "hint": (
                    "Entries with has_full_text can be opened with read_email "
                    "using their messageId — do that before answering anything "
                    "that needs the actual wording."
                ),
            })

        elif name == "read_email":
            message_id = (arguments or {}).get("message_id", "")
            return json.dumps(read_cached_email(user_email, message_id), default=str)

        elif name == "list_emails":
            a = arguments or {}
            return json.dumps(
                list_cached_emails(
                    user_email,
                    category=a.get("category"),
                    sender=a.get("sender"),
                    days=a.get("days"),
                ),
                default=str,
            )

        elif name == "get_calendar":
            days_ahead = (arguments or {}).get("days_ahead") or 7
            result = await get_calendar_window(user_email, int(days_ahead))
            return json.dumps(result, default=str)

        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

    except Exception as e:
        log.error(f"Iris tool '{name}' failed: {e}")
        return json.dumps({"error": f"'{name}' failed to run — try rephrasing or ask something else."})


async def get_iris_reply(
    message: str,
    history: list = None,
    user_name: str = "User",
    inbox_context: Optional[dict] = None,
    user_email: str = "default",
) -> str:
    """
    Returns Iris's reply as plain text. Raises on API failure — the route
    handler in main.py is responsible for turning that into an HTTP error.

    Runs a standard tool-calling loop: ask the model, and if it wants to
    call one or more tools, run them and feed the results back, up to
    MAX_TOOL_ROUNDS times. If the model still hasn't given a final answer
    by then (shouldn't normally happen), one last no-tools call forces a
    direct answer so the person always gets a reply rather than a timeout.
    """
    messages = [
        {"role": "system", "content": IRIS_SYSTEM_PROMPT},
        {"role": "system", "content": _build_session_block(user_name, user_email)},
        {"role": "system", "content": _build_context_block(inbox_context)},
    ]
    # Only the recent turns. The frontend sends the whole conversation, so a
    # long chat previously grew the request without bound — cost climbing
    # every message until it eventually hit the context limit.
    messages.extend(_to_openai_messages(history)[-MAX_HISTORY_MESSAGES:])
    messages.append({"role": "user", "content": message})

    for _ in range(MAX_TOOL_ROUNDS):
        response = await _chat_with_retry(
            model=ACTIVE_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.6,
            max_tokens=500,
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            return (msg.content or "").strip()

        # Model wants to call one or more tools. Record its tool-call
        # message first (required by the API before any tool results),
        # then run each tool and append its result right after.
        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ],
        })

        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except (json.JSONDecodeError, TypeError):
                args = {}

            result_str = await _execute_tool_call(tc.function.name, args, user_email, user_name)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_str,
            })
        # Loop again — the model sees the tool result(s) and either
        # answers directly or calls another tool.

    # Safety net: hit the round cap without a final answer (e.g. the
    # model kept calling tools). Force one last plain answer so the
    # person always gets a reply instead of silently getting nothing.
    messages.append({
        "role": "system",
        "content": "Stop calling tools now and answer the person directly with whatever you have so far.",
    })
    final = await _chat_with_retry(
        model=ACTIVE_MODEL,
        messages=messages,
        temperature=0.6,
        max_tokens=500,
    )
    return (final.choices[0].message.content or "").strip()