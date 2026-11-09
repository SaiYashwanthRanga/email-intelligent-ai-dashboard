"""
"Why is this email tracked?" — the AI's reading of each tracked email:
a one-line summary, and per recipient whether a reply is expected, why, and
the exact sentence they are asked (verbatim from the email).

Filled in two ways:
  • by Celery, for emails not analysed yet (capped per run), and
  • on demand when someone opens an email that hasn't been analysed.

It explains; it doesn't change tracking. Whether a reminder goes out is
still decided on the reminder days (services/reminder_engine.py).
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select

from tracker.db.session import SessionLocal
from tracker.models import SentEmail
from tracker.services.ai_analyzer import AIAnalysisError, explain_email
from tracker.services.text import new_message_text

log = logging.getLogger("tracker.explain")


class ExplainNotFound(Exception):
    pass


def explain_tracked_email(email_id: int, *, mailbox: str | None = None, force: bool = False) -> bool:
    """
    Analyse one email and store the explanation. Returns False if it was
    already analysed (and not forced). Raises ExplainNotFound, AIAnalysisError.
    `mailbox` (when given) must own the email.
    """
    with SessionLocal() as session:
        email = session.get(SentEmail, email_id)
        if email is None or (mailbox and email.mailbox != mailbox.lower().strip()):
            raise ExplainNotFound(email_id)
        if email.ai_analyzed_at is not None and not force:
            return False
        subject = email.subject
        body = new_message_text(email.body) or (email.body or "")
        recipients = [(r.email, r.kind) for r in email.recipients]

    # Slow AI call: outside any transaction.
    result = explain_email(subject=subject, body=body, recipients=recipients)

    with SessionLocal.begin() as session:
        email = session.get(SentEmail, email_id)
        if email is None:
            return False   # deleted meanwhile
        email.ai_summary = result.summary or None
        email.ai_analyzed_at = datetime.now(timezone.utc)
        by_addr = {x.email: x for x in result.recipients}
        for r in email.recipients:
            x = by_addr.get(r.email)
            if x is not None:
                r.ai_needs_reply, r.ai_reason, r.ai_ask = x.needs_reply, x.reason, x.ask
    return True


def explain_pending(mailbox: str, limit: int) -> tuple[int, int]:
    """
    Analyse up to `limit` not-yet-analysed emails of this mailbox, newest
    first. Returns (explained, failed). Failures are retried next run.
    """
    if limit <= 0:
        return 0, 0
    with SessionLocal() as session:
        ids = session.scalars(
            select(SentEmail.id)
            .where(SentEmail.mailbox == mailbox.lower().strip(), SentEmail.ai_analyzed_at.is_(None))
            .order_by(SentEmail.sent_at.desc())
            .limit(limit)
        ).all()
    done = failed = 0
    for email_id in ids:
        try:
            if explain_tracked_email(email_id):
                done += 1
        except AIAnalysisError as e:
            failed += 1
            log.warning("[%s] couldn't explain email %d: %s", mailbox, email_id, e)
            if failed >= 3:
                break   # AI looks down — stop for this run
    return done, failed
