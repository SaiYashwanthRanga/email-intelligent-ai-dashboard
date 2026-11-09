"""
AI step of the reminder flow: on each reminder day (1 and 3) read the sent
email and decide whether this recipient still owes a reply.

The AI only DECIDES. The reminder text itself is always the fixed Day-1 /
Day-3 template (tracker/constants/reminder_templates.py), so what goes out is
predictable and never invented.

Raises AIAnalysisError when the AI can't be reached or answers badly. The
caller then creates nothing and the next run tries again, so an AI outage
delays reminders rather than sending ones nobody checked.
"""

import json
import re
from dataclasses import dataclass

from openai import OpenAI, OpenAIError

from tracker.config import settings

# How much of the email the AI reads. The ask is almost always near the top.
_AI_BODY_CHARS = 4_000

_client: OpenAI | None = None


class AIAnalysisError(Exception):
    """The AI could not produce a usable decision for this reminder."""


@dataclass(frozen=True)
class FollowUpDecision:
    needs_followup: bool
    reason: str


_SYSTEM_PROMPT = """\
You help a busy professional follow up on emails they sent that have not \
been answered. You get one email they sent, one recipient who has NOT \
replied yet, and how many days have passed.

Decide: is the sender genuinely waiting on THIS recipient for a reply or an \
action? Say no (needs_followup=false) when the email needs nothing back from \
them — e.g. it's FYI, an announcement, a thank-you, a "done" confirmation, \
the recipient is only CC'd for visibility, or it's automated/notification \
content. When unsure whether a reply is expected, say yes.

Answer ONLY with JSON:
{"needs_followup": true|false,
 "reason": "<one short sentence explaining the decision>"}"""


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        if not settings.openai_api_key:
            raise AIAnalysisError("OPENAI_API_KEY is not set")
        _client = OpenAI(api_key=settings.openai_api_key, timeout=60, max_retries=1)
    return _client


def analyze_followup(
    *,
    subject: str | None,
    body: str | None,
    recipient_email: str,
    recipient_kind: str,
    stage_day: int,
    days_since_sent: float,
) -> FollowUpDecision:
    user_msg = (
        f"Recipient: <{recipient_email}> ({'To' if recipient_kind == 'to' else 'CC'})\n"
        f"Day {stage_day} check ({days_since_sent:.1f} days since sent, no reply yet)\n"
        f"Subject: {subject or '(no subject)'}\n"
        f"--- Email body ---\n{(body or '(empty)')[:_AI_BODY_CHARS]}"
    )
    try:
        resp = _get_client().chat.completions.create(
            model=settings.ai_model,
            response_format={"type": "json_object"},
            temperature=0,
            max_completion_tokens=120,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
    except OpenAIError as e:
        raise AIAnalysisError(f"{type(e).__name__}: {str(e)[:200]}") from e

    try:
        data = json.loads(resp.choices[0].message.content or "")
        needs = data["needs_followup"]
        if not isinstance(needs, bool):
            raise TypeError("needs_followup is not a boolean")
        reason = str(data.get("reason") or "").strip() or "(no reason given)"
    except (ValueError, KeyError, TypeError, IndexError) as e:
        raise AIAnalysisError(f"unusable AI answer: {e}") from e
    return FollowUpDecision(needs_followup=needs, reason=reason)


# ── Why-tracked explanation (shown when an email is opened) ──────────────────

@dataclass(frozen=True)
class RecipientExplanation:
    email: str
    needs_reply: bool
    reason: str
    ask: str | None          # verbatim sentence(s) from the email, or None


@dataclass(frozen=True)
class EmailExplanation:
    summary: str
    recipients: list[RecipientExplanation]


_EXPLAIN_PROMPT = """\
You explain to a busy professional why an email they SENT is being tracked \
for replies. You get the email and its recipients.

1. "summary": one sentence — what this email asks for or is about, written \
for the sender ("You asked … to …").
2. For EACH recipient: is the sender waiting on a reply or action from THIS \
person ("needs_reply")? Why ("reason", one sentence, specific to this \
person — what they are expected to do)? And "ask": copy, word for word, the \
sentence(s) from the email that ask this person something. Copy them exactly \
as written, do not rephrase or fix typos. If nothing in the email asks this \
person anything directly, use null.

needs_reply is false for FYI / announcements / thank-yous / "done" \
confirmations / people only CC'd for visibility. When unsure, true.

Answer ONLY with JSON:
{"summary": "...",
 "recipients": [{"email": "...", "needs_reply": true, "reason": "...", "ask": "..." or null}]}"""

_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    return _WS.sub(" ", s).strip().lower()


def _verbatim(ask, body: str) -> str | None:
    """Keep the quoted ask only if it really appears in the email."""
    if not isinstance(ask, str) or not ask.strip():
        return None
    ask = ask.strip().strip('"“”')
    return ask if _norm(ask) in _norm(body) else None


def explain_email(*, subject: str | None, body: str, recipients: list[tuple[str, str]]) -> EmailExplanation:
    """
    recipients: [(address, "to"|"cc")]. `body` should be the new text of the
    message only (quoted history removed). Raises AIAnalysisError.
    """
    listing = "\n".join(f"- {addr} ({'To' if kind == 'to' else 'CC'})" for addr, kind in recipients)
    user_msg = (
        f"Subject: {subject or '(no subject)'}\n"
        f"Recipients:\n{listing}\n"
        f"--- Email body ---\n{(body or '(empty)')[:_AI_BODY_CHARS]}"
    )
    try:
        resp = _get_client().chat.completions.create(
            model=settings.ai_model,
            response_format={"type": "json_object"},
            temperature=0,
            max_completion_tokens=900,
            messages=[
                {"role": "system", "content": _EXPLAIN_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
    except OpenAIError as e:
        raise AIAnalysisError(f"{type(e).__name__}: {str(e)[:200]}") from e

    try:
        data = json.loads(resp.choices[0].message.content or "")
        summary = str(data.get("summary") or "").strip()
        by_email = {}
        for r in data.get("recipients") or []:
            addr = str(r.get("email") or "").strip().lower()
            if addr:
                by_email[addr] = r
    except (ValueError, TypeError, AttributeError) as e:
        raise AIAnalysisError(f"unusable AI answer: {e}") from e

    out = []
    for addr, _kind in recipients:
        r = by_email.get(addr)
        if r is None:
            continue   # the AI skipped someone: leave them unexplained
        needs = r.get("needs_reply")
        out.append(RecipientExplanation(
            email=addr,
            needs_reply=needs if isinstance(needs, bool) else True,
            reason=str(r.get("reason") or "").strip() or "(no reason given)",
            ask=_verbatim(r.get("ask"), body),
        ))
    if not summary and not out:
        raise AIAnalysisError("AI returned no explanation")
    return EmailExplanation(summary=summary, recipients=out)
