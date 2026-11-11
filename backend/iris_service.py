"""
iris_service.py — Iris, the Inbox Assistant (Phase 3)
─────────────────────────────────────────────────────────────────────────
Kept separate from services.py on purpose so this feature stays easy to
find, iterate on, and (if needed) rip out, without touching the existing
analysis/reply logic.

Iris can call these tools mid-conversation:
  - draft_reply            -> reuses services.draft_email_reply() as-is
  - search_emails           -> keyword search over
                                services.get_cached_emails_by_id(), which
                                accumulates every email the analysis
                                pipeline has ever seen for this user
                                (NOT the person's entire mailbox — see
                                search_cached_emails() below for the exact
                                scope/caveats), fused with meaning-based
                                search over full email text (iris_index.py).
                                Paged, so nothing is silently cut off
  - summarize_emails        -> works through a large set of emails in
                                batches (map) and hands back per-batch
                                digests for the final answer (reduce), with
                                an honest count of how many were covered
  - list_emails             -> the same scope browsed by facet instead of
                                keyword (category / sender / last N days),
                                for questions with no word to search on
  - read_email              -> full body + reply chain from the offline
                                detail cache. Without this Iris only ever
                                saw one-line summaries and had never
                                actually read an email
  - get_calendar            -> upcoming meetings, via main.get_meetings so
                                its caching and stale-fallback are reused

  - propose_action          -> puts an action (mark read / reply / forward /
                                RSVP / compose) in front of the person as a
                                confirmation button

Iris still performs NOTHING itself. propose_action only records a
proposal; /api/iris/confirm in main.py is the single place anything is
actually carried out, and only after an explicit press. That split is the
safety property — "the assistant sent mail on its own" is impossible by
construction here, not by the model following instructions. Sends are
also never auto-retried, since a timeout leaves it genuinely unknown
whether the mail went, and each proposal carries an actionId the confirm
route de-duplicates on.

Reuses the same OpenAI client + model already configured in services.py
rather than standing up a second client, and reuses draft_email_reply
exactly as it already exists.
"""

import json
import re
import uuid
import time
import asyncio
import httpx
import html as _html
from datetime import datetime, timedelta
from typing import Optional

from services import (
    client,
    ACTIVE_MODEL,
    log,
    draft_email_reply,
    get_cached_emails_by_id,
    get_cached_detail,
    has_cached_detail,
    get_thread_note,
    load_thread_notes,
    clean_for_ai,
)
import iris_index

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
longer (a drafted email, or a briefing across many emails — those can run
as long as they need to, organised so they scan easily).

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

- Everything else (questions, casual chat): plain, direct prose sized to
  the question — a one-line question gets a short answer, not an
  artificially padded one.

FORMATTING: **bold** and "- " bullet lists render properly here, so use
them where they genuinely aid scanning — a label before a value, or a
list of separate items. Don't decorate: prose should stay prose, and a
short answer needs no formatting at all. Avoid heading marks (###) and
tables; blank lines between sections do that job better in a chat panel.

Inside a drafted email, write it as the person would actually send it —
no bold, no bullets, just greeting, body paragraphs and sign-off.

WHAT YOU CAN SEE: some messages include an INBOX SNAPSHOT below — a
lightweight view of the person's current inbox: counts, a handful of
thread-level summaries, and a short list of recent emails (sender,
subject, category, and a one-line AI-generated summary). This is a
snapshot, not the full inbox — it does not include every email, and it
never includes full email body text, only short summaries.

Use the snapshot to answer questions grounded in what's actually there.
If a question needs something the snapshot doesn't cover, try a tool
before saying you can't help:

1. draft_reply — drafts reply text to a specific sender. This ONLY
   produces text for the person to review; it does NOT send anything.
   Always present what it returns as a draft ("Here's a draft you can
   send:") — never say or imply you sent or will send an email.

2. search_emails — searches emails the dashboard has already analyzed
   for this person, by exact words AND by meaning over the full text, so
   describe what you are looking for in natural words ("staff leaving",
   "the lease renewal") — it finds emails on that topic even when they
   use different wording. This is NOT their entire mailbox history —
   only what's been processed so far. If a search comes back empty, say
   it wasn't found in what's been analyzed rather than concluding it
   doesn't exist.

   PAGING — search_emails and list_emails return one page at a time and
   tell you total_matching, has_more and next_offset. If the question
   needs the rest ("all", "every", "how many are about…"), call again
   with offset=next_offset. If you answer from only part of the matches,
   say so plainly: "this covers the 30 most recent of 112".

3. list_emails — browse by filter instead of by keyword: category
   (URGENT, PRIORITY, NEWSLETTER, ...), sender, or "last N days". Reach
   for this whenever the question has no specific word to search on —
   "what's urgent", "what came in today", "anything from Deepa this
   week". search_emails finds a known topic; list_emails surveys. Both
   cover only what has been analysed so far.

   list_emails marks rows already_replied when that conversation has
   already been answered. NEVER present those as needing a reply —
   leaving them out is the difference between a useful "what needs me"
   answer and one full of things handled days ago.

4. search_sent — what the person THEMSELVES has sent recently, with the
   real text of their messages. Every other tool covers mail they
   received; this is the other half of the conversation. Use it for
   "what did I tell X", "did I already answer this", "what did I
   promise", and before saying anything about whether they have replied
   to someone.

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

THE RULE THAT MATTERS MOST — never conclude something is not there
without looking. The snapshot is a small preview of a much larger inbox,
so an email missing from it means nothing at all. Before you say "I
can't find", "there isn't", "there's no", "it doesn't appear", or
anything of that shape, you MUST have called search_emails or
list_emails for it in this turn. Not finding it in the snapshot is not
evidence. If a search comes back empty, try once more with fewer or
different words (a surname alone, one distinctive noun) before saying it
wasn't found — and then say it wasn't found in what has been analysed,
not that it doesn't exist.

Likewise, when someone names a specific email or thread ("the weekly
report thread", "Deepa's email", "that fax"), go and find it with
search_emails and read it with read_email rather than answering from
whatever happens to be visible. Working from a summary when the real
text was one call away is the most common way to be wrong.

If a tool returns an error or empty result, say so plainly. Never invent
specific senders, subjects, dates, drafts, or statuses that
didn't come from the snapshot, a tool result, or the conversation itself.

8. summarize_emails — for questions that span MANY emails: "summarise
   everything from legal this month", "go through all my unread mail",
   "what are the main themes this week", "brief me on everything about
   the audit". It reads up to 300 matching emails in batches (full text
   where available) and returns condensed digests for you to turn into
   the answer. Use it instead of paging through list_emails yourself
   whenever more than about 30 emails are involved. Pass a clear `focus`
   saying what to pull out. It reports total_matching and covered —
   ALWAYS tell the person how many emails the briefing covers out of how
   many matched, and say so if some could not be included.

7. propose_action — puts a confirmation button in front of the person
   for something they asked you to DO rather than tell them: mark an
   email read, send a reply, forward, write a new email, RSVP to a
   meeting. You never carry it out. Pressing the button
   is what performs it, and they can edit the recipients, subject and
   wording on the card before it goes. So: prepare the action, then say
   what you've queued and that it needs their confirmation. Never say
   "I've sent it" or "done" — it is not done until they press.

WRITING EMAIL THAT WILL ACTUALLY BE SENT — for send_reply, forward and
compose, put the complete final message in the body. Not a sketch, not
"[insert details]", not a description of what you'd write: the exact
words that would go out over their name. The person sees precisely this
text on the card, so anything left unfinished is something they have to
fix by hand.

- Replying to an email that exists → send_reply with its messageId.
  Read the email first so you are answering what was actually asked.
- Passing an email on to someone else → forward with its messageId.
- A new email that isn't part of any thread ("email Deepa and ask for
  the Q3 numbers", "send Jim a note about Friday") → compose. It needs
  a real recipient address and a subject you write yourself.

Recipient addresses must be ones you have actually seen — in the inbox
snapshot, a tool result, or the conversation. Never assemble an address
from someone's name and a guess at the domain. If you don't have it,
look for it with search_emails or search_sent; if it still isn't there,
ask the person for it rather than proposing a send to an invented
address. Sign off as the person you're speaking with, never as Iris.

If someone asks you to do something you have no action for (deleting
mail, moving folders, booking a new meeting), say plainly that you can't
do that yet rather than proposing something adjacent.

CURRENT CAPABILITIES (be honest if asked): you can chat, answer
questions grounded in the snapshot, browse and search analysed email by
keyword and by meaning, work through hundreds of emails at once for a
briefing, read the full text of emails, search what the
person has sent, look at their upcoming calendar, draft replies, check
and prepare actions (mark read, reply, forward, compose a new email,
RSVP) for them to confirm. You can
write an email on their behalf and it will really be sent — but only
after they press the button on the card, which they can edit first. You
never send or change anything on your own, you can't create calendar
entries, and you can't reach beyond the mail already analysed.
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
# Summaries dominated the snapshot at ~341 chars each. A gist is enough to
# recognise an email; the full text is one read_email away.
SNAPSHOT_SUMMARY_CHARS = 140


def _trim_snapshot(inbox_context: dict) -> tuple:
    """
    Shrink the snapshot so it fits whole, and so it covers more of the inbox.

    Summaries were 71% of the payload at ~341 chars each, which meant only 25
    emails fit and the JSON was being cut mid-object. A one-line gist is
    enough to decide whether an email is the one being asked about — the full
    summary and body are one read_email away.

    Returns (trimmed_context, shown, total).
    """
    ctx = dict(inbox_context or {})
    emails = list(ctx.get("recent_emails") or [])
    total = len(emails)

    slim = []
    for e in emails:
        if not isinstance(e, dict):
            continue
        summary = str(e.get("summary") or "")
        if len(summary) > SNAPSHOT_SUMMARY_CHARS:
            summary = summary[:SNAPSHOT_SUMMARY_CHARS].rsplit(" ", 1)[0] + "…"
        slim.append({
            "from": e.get("from"),
            "subject": e.get("subject"),
            "category": e.get("category"),
            "summary": summary,
            "unread": e.get("unread"),
            "received_at": e.get("received_at"),
        })

    # Drop whole emails until it fits. Never slice the JSON string itself —
    # handing the model a half-finished object is worse than showing it
    # fewer emails, because it can't tell the difference.
    while slim:
        ctx["recent_emails"] = slim
        if len(json.dumps(ctx, separators=(",", ":"), default=str)) <= MAX_SNAPSHOT_CHARS:
            break
        slim = slim[:-5] if len(slim) > 5 else slim[:-1]

    ctx["recent_emails"] = slim
    return ctx, len(slim), total


def _build_context_block(inbox_context: Optional[dict]) -> str:
    """
    Turns the frontend's inbox snapshot ({stats, threads, recent_emails})
    into a text block for the model. Fails safe: any problem here returns
    an honest "not available" note instead of raising, so a malformed or
    missing snapshot never breaks the whole chat request.
    """
    if not inbox_context:
        # Deliberately pushes TOWARD the tools. This used to say "answer only
        # from the conversation itself", which the model read as an
        # instruction not to look anything up — so a perfectly answerable
        # question got "I can't access your inbox right now" while
        # list_emails and search_emails sat there unused.
        return (
            "INBOX SNAPSHOT: not attached to this message. That does NOT "
            "mean you are cut off from the inbox — use list_emails, "
            "search_emails and read_email to look things up directly. Only "
            "say you can't help if a tool actually comes back empty."
        )

    try:
        trimmed, shown, total = _trim_snapshot(inbox_context)
        # Compact, not pretty-printed: indentation was ~35% of the payload
        # and bought nothing — it just meant fewer emails fitting.
        snapshot_json = json.dumps(trimmed, separators=(",", ":"), default=str)
    except Exception:
        return (
            "INBOX SNAPSHOT: unavailable (could not be read). Use "
            "list_emails and search_emails to look things up instead."
        )

    stats = (inbox_context or {}).get("stats") or {}
    analysed = stats.get("total_emails")

    # State the coverage plainly. Without this the model treats the snapshot
    # as the whole inbox and answers "what's urgent" from a fraction of it,
    # instead of calling list_emails and getting the real answer.
    coverage = (
        f"COVERAGE: this snapshot lists {shown} recent email(s)"
        + (f" out of about {analysed} analysed" if analysed else "")
        + ". Summaries here are shortened. It is a preview, NOT the whole "
        "inbox — for anything that needs completeness (counts, 'what is "
        "urgent', 'everything from X', 'what came in today') call "
        "list_emails, and use read_email for what an email actually says. "
        "Never answer a 'how many' question from this list alone."
    )
    NEWLINE = chr(10)
    return coverage + NEWLINE + NEWLINE + "INBOX SNAPSHOT (JSON):" + NEWLINE + snapshot_json


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

MAX_SEARCH_RESULTS = 30  # rows per page of search/list results; more are one offset away
MAX_TOOL_ROUNDS = 10     # hard cap on model<->tool round-trips per message, prevents runaway loops
MAX_HISTORY_MESSAGES = 12  # recent turns kept; older ones dropped to bound cost
MAX_REPLY_TOKENS = 1500  # room for a real briefing; short questions still get short answers

# summarize_emails (bulk map/reduce)
BULK_MAX_EMAILS = 300     # most emails one bulk pass will read
BULK_DEFAULT_EMAILS = 150
BULK_BATCH_SIZE = 15      # emails condensed per model call
BULK_CONCURRENCY = 4      # batches in flight at once
BULK_TEXT_CHARS = 1800    # per email fed to a batch
BULK_DIGEST_TOKENS = 700  # per-batch digest length

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
            "name": "search_emails",
            "description": (
                "Search emails the dashboard has already analyzed for this "
                "person — by exact words in sender/subject/summary AND by "
                "meaning over the full email text, so a topic is found even "
                "when the email words it differently. NOT the person's "
                "entire mailbox history — only what's been processed so "
                "far. An empty result means 'not found in what's been "
                "analyzed', not 'doesn't exist'. Returns one page plus "
                "total_matching / has_more / next_offset."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "What to look for — a sender name/email, a subject, "
                            "or a topic described in natural words."
                        ),
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Skip this many results — pass next_offset from the previous page to get more.",
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
                "newest first, one page at a time, with total_matching / "
                "has_more / next_offset. Combine filters freely; omit them "
                "all for a plain recent list."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["VIP", "PRIORITY", "URGENT", "CONFIDENTIAL", "LEGAL",
                                 "PROVIDERS", "MEETING", "ZOOM", "NEWSLETTER", "NORMAL"],
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
                    "offset": {
                        "type": "integer",
                        "description": "Skip this many rows — pass next_offset from the previous page to get more.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "summarize_emails",
            "description": (
                "Work through a LARGE set of emails in one go and get back "
                "condensed digests to answer from. Use for anything spanning "
                "more than about 30 emails: 'summarise everything from X', "
                "'go through all my mail this week', 'what are the themes', "
                "'what needs a decision across my inbox'. Reads full text "
                "where available. Select the set with the same filters as "
                "list_emails and/or a topic query; omit them all for the "
                "whole analysed inbox. Returns total_matching and covered — "
                "always tell the person how many emails the answer covers."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "focus": {
                        "type": "string",
                        "description": (
                            "What to pull out of the emails, in a sentence — e.g. "
                            "'what needs a decision or reply from me, with deadlines', "
                            "'main themes and anything unusual', 'every figure and date "
                            "mentioned about the audit'."
                        ),
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional topic — restrict to emails about this (matched by words and meaning).",
                    },
                    "category": {
                        "type": "string",
                        "enum": ["VIP", "PRIORITY", "URGENT", "CONFIDENTIAL", "LEGAL",
                                 "PROVIDERS", "MEETING", "ZOOM", "NEWSLETTER", "NORMAL"],
                        "description": "Optional — restrict to one category.",
                    },
                    "sender": {
                        "type": "string",
                        "description": "Optional — full or partial sender name/address.",
                    },
                    "days": {
                        "type": "integer",
                        "description": "Optional — only emails from the last N days (1 = today).",
                    },
                    "max_emails": {
                        "type": "integer",
                        "description": "Most emails to read, newest first (default 150, up to 300).",
                    },
                },
                "required": ["focus"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_sent",
            "description": (
                "Search what the PERSON THEMSELVES has sent in the last 7 "
                "days, with the actual text of their messages. Use it for "
                "anything about their own side of a conversation — what did "
                "I tell X, did I already answer this, what did I promise, "
                "what have I asked for and not heard back on. The inbox "
                "tools only cover mail received; this is the other half."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Words to look for — a recipient, a topic. Leave empty for everything recent.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_action",
            "description": (
                "Propose an action for the person to confirm. You NEVER carry "
                "actions out yourself — this only puts a confirmation button "
                "in front of them, and nothing happens unless they press it. "
                "Use it when they ask you to do something rather than tell "
                "them something: mark mail as read, reply to an email, forward "
                "one, write a brand-new email to someone, or RSVP to a meeting. "
                "After calling this, tell "
                "them plainly what you've queued up and that it needs their "
                "confirmation. Never claim it is done."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["mark_read", "send_reply", "forward", "compose", "rsvp"],
                        "description": (
                            "Which action to put up for confirmation. Use "
                            "'send_reply' to answer an email that exists, "
                            "'forward' to pass one on, and 'compose' to start a "
                            "brand-new email that is not part of any thread."
                        ),
                    },
                    "message_id": {
                        "type": "string",
                        "description": (
                            "The email or meeting this applies to (from "
                            "search_emails/list_emails). Required for "
                            "send_reply, forward, mark_read and rsvp. Leave it "
                            "out for compose — a new email has no thread."
                        ),
                    },
                    "summary": {
                        "type": "string",
                        "description": "One short line describing the action, shown on the confirm button.",
                    },
                    "to": {
                        "type": "array", "items": {"type": "string"},
                        "description": (
                            "send_reply/forward/compose: recipient addresses. "
                            "Must be real addresses you have seen in the inbox, "
                            "a tool result or the conversation — never guessed "
                            "or constructed from a name."
                        ),
                    },
                    "cc": {
                        "type": "array", "items": {"type": "string"},
                        "description": "send_reply/forward/compose: cc addresses.",
                    },
                    "subject": {
                        "type": "string",
                        "description": (
                            "send_reply/forward: subject line. For compose this "
                            "is required — write a clear, specific one."
                        ),
                    },
                    "body": {
                        "type": "string",
                        "description": (
                            "send_reply/forward/compose: the full message text, "
                            "ready to send — greeting, body and sign-off, "
                            "written as the person would send it themselves."
                        ),
                    },
                    "response": {
                        "type": "string",
                        "enum": ["accept", "decline", "tentative"],
                        "description": "rsvp: which answer to give.",
                    },
                },
                "required": ["action", "summary"],
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

    # The person's own note about this thread, if they left one — keyed the
    # same way the reading pane keys a thread
    # (conversationId, falling back to messageId for singletons). Surfaced
    # here so both the read_email tool and the "person is looking at this
    # email right now" injection in get_iris_reply pick it up for free.
    note = get_thread_note(user_email, detail.get("conversationId") or message_id)
    if note:
        payload["note_from_user"] = note
        payload["note_from_user_meaning"] = (
            "The person's own past note about this thread, written for "
            "exactly this situation — treat it as accurate first-hand context."
        )

    return payload


def search_cached_emails(user_email: str, query: str, limit: int = MAX_SEARCH_RESULTS,
                         allow_partial: bool = True) -> list:
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

    notes = load_thread_notes(user_email)
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
        thread_key = entry.get("conversationId") or eid

        scored.append((len(matched), score, str(received), {
            "messageId": eid,
            "from": sender or "Unknown Sender",
            "subject": subject or "No Subject",
            "category": entry.get("category") or "NORMAL",
            "summary": summary,
            "received_at": received,
            "unread": entry.get("isRead") is False,
            "has_full_text": has_cached_detail(user_email, eid) if eid else False,
            "has_note": bool(thread_key and thread_key in notes),
        }))

    # Prefer emails matching every word; if none do, fall back to the best
    # partial matches rather than returning nothing. A conversational query
    # like "what did Shahana send about productivity" rarely has all its
    # words in one subject line, and an empty answer reads as "Iris can't
    # find anything" when the email is sitting right there.
    full_matches = [t for t in scored if t[0] == len(words)]
    # allow_partial=False is for the hybrid search, where meaning-based
    # matching covers the "different wording" case far better than emails
    # that merely share one common word with the question.
    pool = full_matches if (full_matches or not allow_partial) else scored

    # Most words matched first, then relevance weighting, then most recent.
    pool.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    return [item for _, _, _, item in (pool if limit is None else pool[:limit])]


def _row_for_entry(user_email: str, entry: dict, notes: dict) -> dict:
    """Same row shape search_cached_emails produces, for one cache entry."""
    eid = entry.get("id") or entry.get("messageId")
    thread_key = entry.get("conversationId") or eid
    return {
        "messageId": eid,
        "from": entry.get("from") or entry.get("sender") or "Unknown Sender",
        "subject": entry.get("subject") or "No Subject",
        "category": entry.get("category") or "NORMAL",
        "summary": entry.get("summary") or "",
        "received_at": entry.get("received_at") or entry.get("received") or "",
        "unread": entry.get("isRead") is False,
        "has_full_text": has_cached_detail(user_email, eid) if eid else False,
        "has_note": bool(thread_key and thread_key in notes),
    }


_RRF_K = 60   # reciprocal-rank-fusion constant; the usual default


async def search_emails_hybrid(user_email: str, query: str) -> tuple:
    """
    Every email matching the query, best first, as (rows, mode).

    Fuses two rankings: the keyword search above (exact words in subject,
    sender, summary) and the meaning-based index over full text
    (iris_index). An email found by both rises to the top; one found by
    either still appears. If the embeddings service can't be reached this
    degrades to the keyword ranking alone and `mode` says so.
    """
    semantic = await iris_index.semantic_search(user_email, query, _html_to_text)
    # Exact-word matches only while meaning search is carrying the loose
    # cases; if it found nothing (or is unreachable), fall back to the old
    # partial-word matching rather than returning nothing.
    keyword_rows = search_cached_emails(user_email, query, limit=None, allow_partial=False)
    if not keyword_rows and not semantic:
        keyword_rows = search_cached_emails(user_email, query, limit=None)

    fused: dict = {}
    rows_by_id = {}
    for rank, row in enumerate(keyword_rows):
        mid = row.get("messageId")
        if not mid:
            continue
        rows_by_id[mid] = dict(row, matched_by="words")
        fused[mid] = fused.get(mid, 0.0) + 1.0 / (_RRF_K + rank + 1)

    if semantic:
        cached = get_cached_emails_by_id(user_email) or {}
        notes = load_thread_notes(user_email)
        for rank, (mid, _score) in enumerate(semantic):
            if mid in rows_by_id:
                rows_by_id[mid]["matched_by"] = "words and meaning"
            else:
                entry = cached.get(mid)
                if not isinstance(entry, dict) or entry.get("_threadRef"):
                    continue
                rows_by_id[mid] = dict(_row_for_entry(user_email, entry, notes), matched_by="meaning")
            fused[mid] = fused.get(mid, 0.0) + 1.0 / (_RRF_K + rank + 1)

    ordered = sorted(fused, key=lambda m: fused[m], reverse=True)
    mode = "words and meaning" if semantic else "words only"
    return [rows_by_id[m] for m in ordered], mode


def _page(rows: list, offset, size: int = MAX_SEARCH_RESULTS) -> dict:
    """One page of rows plus the paging facts the model needs to go on."""
    try:
        offset = max(0, int(offset or 0))
    except (TypeError, ValueError):
        offset = 0
    total = len(rows)
    page = rows[offset:offset + size]
    has_more = offset + len(page) < total
    return {
        "rows": page,
        "returned": len(page),
        "total_matching": total,
        "offset": offset,
        "has_more": has_more,
        "next_offset": offset + len(page) if has_more else None,
    }


# ── SENT MAIL ───────────────────────────────────────────────────────────────
# Iris only ever saw received mail, so it had no idea what the person had
# already said. That made "what needs my reply first?" quietly wrong — it
# would list conversations they had answered days ago. Jim had 22 such
# threads in his cache.
#
# Cached briefly because it is a live call to the org server and several
# tools want it within the same question.
SENT_CACHE_TTL = 300          # seconds
_sent_cache: dict = {}        # user -> {"at": ts, "items": [...]}


async def get_sent_emails(user_email: str) -> list:
    """Recent sent mail from the org server, or [] if it can't be reached."""
    now = time.time()
    hit = _sent_cache.get(user_email)
    if hit and now - hit["at"] < SENT_CACHE_TTL:
        return hit["items"]

    try:
        from main import ORG_BASE, org_is_down, org_mark_failure, org_mark_success
        if org_is_down():
            return hit["items"] if hit else []      # stale beats nothing
        async with httpx.AsyncClient(timeout=30) as http:
            resp = await http.get(f"{ORG_BASE}/api/Values/sent7days", params={"email": user_email})
        if resp.status_code != 200:
            return hit["items"] if hit else []
        org_mark_success()
        items = resp.json()
        items = items if isinstance(items, list) else []
        _sent_cache[user_email] = {"at": now, "items": items}
        return items
    except Exception as e:
        log.warning(f"[sent] couldn't load sent mail for {user_email}: {e}")
        return hit["items"] if hit else []


async def get_replied_conversations(user_email: str) -> set:
    """conversationIds the person has already sent into — i.e. answered."""
    return {
        s.get("conversationId")
        for s in await get_sent_emails(user_email)
        if isinstance(s, dict) and s.get("conversationId")
    }


async def preview_tag_matches(user_email: str, tag_name: str, tag_prompt: str, scan_limit: int = 150) -> list:
    """
    Admin > Tags' "Scan Now" — the whole reason custom tags are additive
    rather than a fork of analyze_emails_batch(): this reads cached emails
    and asks the model a completely separate, tag-specific yes/no question,
    never touching an email's actual `category` field. Nothing is persisted
    here; the caller (POST /api/tags/{id}/preview) hands the returned list
    back to the person, and only an explicit approve writes anything.

    Runs in batches of 20 (same chunk size analyze_emails_batch uses) so a
    150-email scan is ~8 model calls, not 150.
    """
    try:
        cached = get_cached_emails_by_id(user_email) or {}
    except Exception as e:
        log.error(f"preview_tag_matches: cache read failed: {e}")
        return []

    entries = [e for e in cached.values() if isinstance(e, dict) and not e.get("_threadRef")]
    entries.sort(key=lambda e: str(e.get("received_at") or e.get("received") or ""), reverse=True)
    entries = entries[:scan_limit]
    if not entries:
        return []

    CHUNK = 20
    results = []
    for start in range(0, len(entries), CHUNK):
        chunk = entries[start:start + CHUNK]
        emails_input = [
            {
                "index": i,
                "subject": e.get("subject", "No Subject"),
                "from": e.get("from", "Unknown"),
                "body_preview": clean_for_ai(e.get("body") or e.get("summary") or "", 500),
            }
            for i, e in enumerate(chunk)
        ]
        prompt = f"""
You are checking emails against ONE custom tag a user defined for their own
inbox. Decide, per email, whether it matches this tag's meaning.

Tag name: {tag_name}
Tag meaning (the user's own words — this is the whole rule, apply it as
written, don't invent extra criteria): {tag_prompt}

Emails (JSON):
{json.dumps(emails_input, indent=2)}

Return JSON: {{"results": [{{"index": 0, "matched": true, "reason": "one short phrase"}}, ...]}}
One entry per email, in the same order.
"""
        try:
            response = await _chat_with_retry(
                model=ACTIVE_MODEL,
                messages=[
                    {"role": "system", "content": "Output JSON only."},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
            )
            parsed = json.loads(response.choices[0].message.content)
            by_index = {r.get("index"): r for r in parsed.get("results", [])}
        except Exception as e:
            log.error(f"preview_tag_matches: chunk failed: {e}")
            by_index = {}

        for i, e in enumerate(chunk):
            ai = by_index.get(i, {})
            results.append({
                "messageId": e.get("id") or e.get("messageId"),
                "from": e.get("from") or e.get("sender") or "Unknown Sender",
                "subject": e.get("subject") or "No Subject",
                "received_at": e.get("received_at") or e.get("received"),
                "matched": bool(ai.get("matched")),
                "reason": ai.get("reason") or "",
            })

    return results


def search_sent(sent_items: list, query: str, limit: int = 8) -> list:
    """Word-wise search over sent mail, same matching rules as the inbox."""
    words = [w for w in re.split(r"\W+", (query or "").lower()) if len(w) > 1]
    words = [w for w in words if w not in _SEARCH_STOPWORDS]
    scored = []
    for s in sent_items or []:
        if not isinstance(s, dict):
            continue
        subject = str(s.get("subject") or "")
        body = _html_to_text(str(s.get("body") or ""))
        to = ", ".join(s.get("to") or [])
        hay = f"{subject} {body} {to}".lower()
        matched = [w for w in words if w in hay] if words else []
        if words and not matched:
            continue
        scored.append((len(matched), str(s.get("sentAt") or ""), {
            "subject": subject or "No Subject",
            "to": s.get("to") or [],
            "cc": s.get("cc") or [],
            "sentAt": s.get("sentAt"),
            "text": body[:1500],
            "awaiting_reply_from": s.get("notRepliedAddresses") or [],
            "replied_by": s.get("repliedByAddresses") or [],
        }))
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [x for _, _, x in scored[:limit]]


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
    offset: int = 0,
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

    notes = load_thread_notes(user_email)
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
        thread_key = entry.get("conversationId") or eid
        rows.append({
            "messageId": eid,
            # Needed to tell whether this conversation has been answered.
            "conversationId": entry.get("conversationId"),
            "from": frm or "Unknown Sender",
            "subject": entry.get("subject") or "No Subject",
            "category": entry.get("category") or "NORMAL",
            "summary": entry.get("summary") or "",
            "received_at": entry.get("received_at") or entry.get("received"),
            "unread": entry.get("isRead") is False,
            "has_attachments": bool(entry.get("hasAttachments")),
            "has_full_text": has_cached_detail(user_email, eid) if eid else False,
            "has_note": bool(thread_key and thread_key in notes),
            "_sort": when or datetime.min,
        })

    rows.sort(key=lambda r: r["_sort"], reverse=True)
    for r in rows:
        r.pop("_sort", None)

    if limit is None:        # the bulk tool wants every row, unpaged
        return {"emails": rows, "returned": len(rows), "total_matching": len(rows),
                "filters": {"category": cat, "sender": who, "days": days}}

    page = _page(rows, offset, limit)
    return {
        "emails": page["rows"],
        "returned": page["returned"],
        "total_matching": page["total_matching"],
        "offset": page["offset"],
        "has_more": page["has_more"],
        "next_offset": page["next_offset"],
        "filters": {"category": cat, "sender": who, "days": days},
        "note": (
            ("More rows exist — call again with offset=next_offset to see "
             "them, or use summarize_emails to cover them all at once. If "
             "you answer from this page alone, say how many of the total "
             "it covers. " if page["has_more"] else "")
            + "Scope is the emails analysed so far for this person, newest "
            "first — not their entire mailbox history. Rows with has_note "
            "carry a note the person previously wrote about that thread — "
            "read_email surfaces it; read those before answering about them."
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


# Human-readable labels for the activity trail shown while Iris works, so
# a 15-second pause reads as "it's searching and reading" rather than a
# frozen panel.
TOOL_LABELS = {
    "search_emails":         "Searching your inbox",
    "list_emails":           "Looking through your mail",
    "summarize_emails":      "Working through your emails in batches",
    "search_sent":           "Checking what you've sent",
    "read_email":            "Reading the email",
    "get_calendar":          "Checking your calendar",
    "draft_reply":           "Drafting a reply",
    "propose_action":        "Preparing an action",
}


# Deliberately loose — this is a sanity check on a model-supplied address,
# not RFC 5322 validation. It exists to catch "Deepa" or "deepa@" being
# passed where an address belongs, since a composed email has no thread to
# fall back on if the recipient is wrong.
_LOOKS_LIKE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def build_action_proposal(arguments: dict, user_email: str) -> dict:
    """
    Turn the model's proposed action into a structured payload the UI can
    render as a confirmation card.

    Nothing is executed here, deliberately. Iris can only ever put a button
    in front of the person; the frontend calls the real endpoint after they
    press it. That keeps "an AI sent mail on my behalf" impossible by
    construction rather than by the model following instructions.
    """
    a = arguments or {}
    action = (a.get("action") or "").strip()
    proposal = {
        # Identifies this specific proposal end-to-end, so confirming twice
        # (double click, retry after a timeout) can't perform it twice.
        "actionId": f"{action}-{uuid.uuid4().hex[:16]}",
        "action": action,
        "summary": (a.get("summary") or "").strip() or action.replace("_", " "),
        "messageId": a.get("message_id") or "",
        "userEmail": user_email,
    }
    if action in ("send_reply", "forward", "compose"):
        proposal.update({
            "to": [x for x in (a.get("to") or []) if x],
            "cc": [x for x in (a.get("cc") or []) if x],
            "subject": a.get("subject") or "",
            "body": a.get("body") or "",
        })
    if action == "rsvp":
        proposal["response"] = a.get("response") or "accept"
    return proposal


async def _read_email_live(user_email: str, message_id: str) -> bool:
    """
    Fetch one email's full text from the mail server into the detail cache.
    Used when read_email is asked for an email that hasn't been prefetched
    yet, so "not cached" stops being a reason Iris can't read something.
    Imported lazily from main for the same reason as get_calendar_window.
    """
    try:
        from main import _prefetch_one_detail   # local import: avoids a cycle at load
        return bool(await asyncio.to_thread(_prefetch_one_detail, message_id, user_email))
    except Exception as e:
        log.warning(f"read_email live fetch failed: {e}")
        return False


def _bulk_item(user_email: str, row: dict) -> tuple:
    """One email as fed to a batch — (item, read_in_full): full text when cached, else its summary."""
    mid = row.get("messageId")
    text, full = "", False
    detail = get_cached_detail(user_email, mid) if mid else None
    if detail and detail.get("body"):
        text = _html_to_text(detail.get("body") or "")[:BULK_TEXT_CHARS]
        full = bool(text)
    if not text:
        text = row.get("summary") or ""
    item = {
        "from": row.get("from"),
        "subject": row.get("subject"),
        "received": row.get("received_at"),
        "category": row.get("category"),
        "unread": row.get("unread"),
        "text": text,
    }
    if row.get("already_replied"):
        item["already_replied_by_the_person"] = True
    return item, full


_BULK_SYSTEM = (
    "You are condensing one batch of a person's emails so an assistant can "
    "brief them. You will get the batch as JSON and a FOCUS describing what "
    "the person wants out of it.\n"
    "Write a compact digest of THIS batch for that focus:\n"
    "- One line per email that matters to the focus: sender — subject — the "
    "point, including any concrete ask, deadline, date, figure or decision "
    "needed. Keep names and numbers exact.\n"
    "- Emails marked already_replied_by_the_person need nothing further from "
    "them; say so if you mention them.\n"
    "- Close with a single line counting what you left out as not relevant "
    "to the focus (e.g. '6 routine notifications/newsletters omitted').\n"
    "Use only what is in the batch. Never invent senders, dates or details."
)


async def summarize_emails_bulk(
    user_email: str,
    focus: str,
    query: str = None,
    category: str = None,
    sender: str = None,
    days: int = None,
    max_emails: int = None,
) -> dict:
    """
    Map/reduce over a large set of emails.

    Map: the matching emails are split into batches and each batch is
    condensed by its own model call (run a few at a time). Reduce: the
    digests go back to the main Iris model, which writes the answer.

    The result always states how many emails matched and how many were
    actually covered, so the answer can be honest about its coverage —
    the failure this replaces was a "summary of everything" silently built
    from the first dozen rows.
    """
    try:
        cap = int(max_emails or BULK_DEFAULT_EMAILS)
    except (TypeError, ValueError):
        cap = BULK_DEFAULT_EMAILS
    cap = max(1, min(cap, BULK_MAX_EMAILS))

    listing = list_cached_emails(user_email, category=category, sender=sender, days=days, limit=None)
    if listing.get("error"):
        return listing
    rows = listing.get("emails", [])

    if (query or "").strip():
        # Topic restriction: keep the filtered set, in relevance order.
        matched, _mode = await search_emails_hybrid(user_email, query)
        allowed = {r.get("messageId"): r for r in rows}
        rows = [allowed[m.get("messageId")] for m in matched if m.get("messageId") in allowed]

    total = len(rows)
    if total == 0:
        return {"total_matching": 0, "covered": 0, "batch_digests": [],
                "note": "No analysed emails match those filters. Say so; don't summarise anything."}

    try:
        replied = await get_replied_conversations(user_email)
    except Exception:
        replied = set()
    chosen = rows[:cap]
    for r in chosen:
        if replied and r.get("conversationId") in replied:
            r["already_replied"] = True

    built = await asyncio.to_thread(lambda: [_bulk_item(user_email, r) for r in chosen])
    items = [b[0] for b in built]
    read_in_full = sum(1 for b in built if b[1])

    batches = [items[i:i + BULK_BATCH_SIZE] for i in range(0, len(items), BULK_BATCH_SIZE)]
    sem = asyncio.Semaphore(BULK_CONCURRENCY)

    async def condense(index: int, batch: list):
        async with sem:
            try:
                resp = await _chat_with_retry(
                    model=ACTIVE_MODEL,
                    messages=[
                        {"role": "system", "content": _BULK_SYSTEM},
                        {"role": "user", "content": (
                            f"FOCUS: {focus or 'the main points and anything needing attention'}\n\n"
                            f"BATCH {index + 1} of {len(batches)} ({len(batch)} emails):\n"
                            + json.dumps(batch, default=str)
                        )},
                    ],
                    temperature=0.2,
                    max_tokens=BULK_DIGEST_TOKENS,
                )
                return len(batch), (resp.choices[0].message.content or "").strip()
            except Exception as e:
                log.error(f"summarize_emails batch {index + 1} failed ({type(e).__name__}): {e}")
                return 0, None

    results = await asyncio.gather(*(condense(i, b) for i, b in enumerate(batches)))
    covered = sum(n for n, _ in results)
    digests = [d for _, d in results if d]
    failed_batches = sum(1 for _, d in results if d is None)

    if covered == 0:
        return {"error": "Couldn't work through the emails just now — the AI service didn't respond.",
                "total_matching": total, "covered": 0}

    return {
        "total_matching": total,
        "covered": covered,
        "not_covered": total - covered,
        "read_in_full_text": read_in_full,
        "from_summary_only": len(chosen) - read_in_full,
        "order": "most relevant first" if (query or "").strip() else "newest first",
        "batch_digests": digests,
        "note": (
            f"These digests cover {covered} of {total} matching emails"
            + (f" ({failed_batches} batch(es) failed and are missing)" if failed_batches else "")
            + ". Write the answer from them, organised by what matters for the "
            "focus rather than batch by batch, and merge duplicates. State the "
            "coverage to the person in one plain sentence ('this covers X of Y "
            "emails')" + (", and that the rest were not read" if total > covered else "") + "."
        ),
    }


async def _execute_tool_call(name: str, arguments: dict, user_email: str, user_name: str,
                             sink: list = None) -> str:
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

        elif name == "search_emails":
            query = (arguments or {}).get("query", "")
            rows, mode = await search_emails_hybrid(user_email, query)
            page = _page(rows, (arguments or {}).get("offset"))
            return json.dumps({
                "results": page["rows"],
                "count": page["returned"],
                "total_matching": page["total_matching"],
                "offset": page["offset"],
                "has_more": page["has_more"],
                "next_offset": page["next_offset"],
                "searched_by": mode,
                "hint": (
                    ("More matches exist — call again with offset=next_offset, "
                     "or say how many of the total this page covers. "
                     if page["has_more"] else "")
                    +
                    "Entries with has_full_text can be opened with read_email "
                    "using their messageId — do that before answering anything "
                    "that needs the actual wording. Entries with has_note also "
                    "carry a note the person previously wrote about that "
                    "thread — read_email surfaces it, so open those too "
                    "before answering about them."
                ),
            })

        elif name == "read_email":
            message_id = (arguments or {}).get("message_id", "")
            result = read_cached_email(user_email, message_id)
            # Not prefetched yet: fetch it from the mail server now rather
            # than answering from a one-line summary.
            if result.get("error") and message_id and await _read_email_live(user_email, message_id):
                result = read_cached_email(user_email, message_id)
            return json.dumps(result, default=str)

        elif name == "summarize_emails":
            a = arguments or {}
            result = await summarize_emails_bulk(
                user_email,
                focus=(a.get("focus") or "").strip(),
                query=a.get("query"),
                category=a.get("category"),
                sender=a.get("sender"),
                days=a.get("days"),
                max_emails=a.get("max_emails"),
            )
            return json.dumps(result, default=str)

        elif name == "list_emails":
            a = arguments or {}
            result = list_cached_emails(
                user_email,
                category=a.get("category"),
                sender=a.get("sender"),
                days=a.get("days"),
                offset=a.get("offset") or 0,
            )
            # Mark what has already been answered. Without this, "what needs
            # my reply" lists conversations the person replied to days ago.
            try:
                replied = await get_replied_conversations(user_email)
                if replied:
                    for row in result.get("emails", []):
                        row["already_replied"] = row.get("conversationId") in replied
                    result["note"] = (result.get("note", "") +
                        " Rows marked already_replied have been answered — exclude them "
                        "from anything about what still needs a reply.")
            except Exception:
                pass    # sent mail is an enhancement, never a hard dependency
            return json.dumps(result, default=str)

        elif name == "search_sent":
            query = (arguments or {}).get("query", "")
            items = await get_sent_emails(user_email)
            if not items:
                return json.dumps({"error": "Couldn't read your sent mail just now.", "results": []})
            results = search_sent(items, query)
            return json.dumps({
                "results": results,
                "count": len(results),
                "scope": "the last 7 days of sent mail",
            }, default=str)

        elif name == "get_calendar":
            days_ahead = (arguments or {}).get("days_ahead") or 7
            result = await get_calendar_window(user_email, int(days_ahead))
            return json.dumps(result, default=str)

        elif name == "propose_action":
            proposal = build_action_proposal(arguments, user_email)
            if not proposal["action"]:
                return json.dumps({"error": "propose_action needs an action."})
            if proposal["action"] in ("send_reply", "forward", "compose") and not proposal.get("body"):
                return json.dumps({"error": "Write the full message body before proposing to send it."})
            if proposal["action"] == "compose":
                # A reply inherits its recipient and subject from the thread it
                # answers; a new email has neither, so both have to be right
                # here or the person is confirming a message with nowhere to go.
                if not proposal.get("to"):
                    return json.dumps({"error": (
                        "compose needs at least one recipient address. If you "
                        "don't know it, look it up with search_emails or "
                        "search_sent, or ask the person — never guess one."
                    )})
                bad = [t for t in proposal["to"] + proposal.get("cc", [])
                       if not _LOOKS_LIKE_EMAIL.match(t)]
                if bad:
                    return json.dumps({"error": (
                        f"These aren't valid email addresses: {', '.join(bad)}. "
                        "Use a real address from the inbox or ask for it — "
                        "don't build one out of someone's name."
                    )})
                if not proposal.get("subject"):
                    return json.dumps({"error": "compose needs a subject line."})
            if sink is not None:
                sink.append(proposal)
            return json.dumps({
                "queued": True,
                "action": proposal["action"],
                "note": (
                    "A confirmation button is now in front of the person. "
                    "Nothing has happened yet. Tell them what you've prepared "
                    "and that it will only run once they confirm — never say "
                    "it is done."
                ),
            })

        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

    except Exception as e:
        log.error(f"Iris tool '{name}' failed: {e}")
        return json.dumps({"error": f"'{name}' failed to run — try rephrasing or ask something else."})


# Strong references to fire-and-forget tasks, so they aren't garbage
# collected mid-run.
_background_tasks: set = set()


async def get_iris_reply(
    message: str,
    history: list = None,
    user_name: str = "User",
    inbox_context: Optional[dict] = None,
    user_email: str = "default",
    focus_message_id: Optional[str] = None,
    on_step=None,
) -> dict:
    """
    Returns {"reply", "steps", "proposals"}. Raises on API failure — the
    route handler in main.py turns that into an HTTP error.

    `steps` is the trail of tools that ran, so the UI can show what Iris
    actually did rather than leaving a silent pause. `proposals` are actions
    awaiting the person's confirmation — Iris never performs them itself.

    Runs a standard tool-calling loop: ask the model, and if it wants to
    call one or more tools, run them and feed the results back, up to
    MAX_TOOL_ROUNDS times. If the model still hasn't given a final answer
    by then (shouldn't normally happen), one last no-tools call forces a
    direct answer so the person always gets a reply rather than a timeout.
    """
    proposals = []
    steps = []

    # Bring the meaning-search index up to date in the background, so it is
    # ready (or nearly) by the time a search needs it. Best-effort.
    try:
        _bg = asyncio.create_task(iris_index.ensure_index(user_email, _html_to_text))
        _background_tasks.add(_bg)
        _bg.add_done_callback(_background_tasks.discard)
    except Exception:
        pass

    messages = [
        {"role": "system", "content": IRIS_SYSTEM_PROMPT},
        {"role": "system", "content": _build_session_block(user_name, user_email)},
        {"role": "system", "content": _build_context_block(inbox_context)},
    ]

    # Opened from a specific email ("Ask Iris about this") — put it straight
    # in front of the model so it doesn't have to search for the thing the
    # person is already looking at.
    if focus_message_id:
        focused = read_cached_email(user_email, focus_message_id)
        if not focused.get("error"):
            messages.append({
                "role": "system",
                "content": (
                    "THE PERSON IS LOOKING AT THIS EMAIL RIGHT NOW. Assume "
                    "any question without another subject refers to it, and "
                    "use this messageId for any action you propose.\n"
                    f"messageId: {focus_message_id}\n"
                    + json.dumps(focused, default=str)[:MAX_SNAPSHOT_CHARS]
                ),
            })
            steps.append("Opened the email you're viewing")
            if on_step:
                await on_step("Opened the email you're viewing")
    # Only the recent turns. The frontend sends the whole conversation, so a
    # long chat previously grew the request without bound — cost climbing
    # every message until it eventually hit the context limit.
    messages.extend(_to_openai_messages(history)[-MAX_HISTORY_MESSAGES:])
    messages.append({"role": "user", "content": message})

    if on_step:
        await on_step("Thinking")

    for _ in range(MAX_TOOL_ROUNDS):
        response = await _chat_with_retry(
            model=ACTIVE_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.6,
            max_tokens=MAX_REPLY_TOKENS,
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            return {
                "reply": (msg.content or "").strip(),
                "steps": steps,
                "proposals": proposals,
            }

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

            label = TOOL_LABELS.get(tc.function.name, tc.function.name)
            if label not in steps:
                steps.append(label)
            # Emit before running it, so the panel shows what Iris is doing
            # while it happens rather than listing it once the wait is over.
            if on_step:
                await on_step(label)
            result_str = await _execute_tool_call(tc.function.name, args, user_email, user_name, proposals)

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
        max_tokens=MAX_REPLY_TOKENS,
    )
    return {
        "reply": (final.choices[0].message.content or "").strip(),
        "steps": steps,
        "proposals": proposals,
    }