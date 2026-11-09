"""
/api/tracker — read the follow-up flow and act on reminders (manual mode).

    GET  /api/tracker/summary?mailbox=            counts + current config
    GET  /api/tracker/emails?mailbox=&status=     tracked emails, recipients, reminders
    GET  /api/tracker/emails/{id}?mailbox=        one email + its live conversation thread
    POST /api/tracker/emails/{id}/explain         AI: why is this email tracked (per recipient)
    GET  /api/tracker/reminders?mailbox=&status=  reminder queue (default: pending)
    POST /api/tracker/reminders/{id}/send         send one (optionally edited)
    POST /api/tracker/reminders/{id}/dismiss      don't send it
    POST /api/tracker/recipients/{id}/stop        remove this person from tracking
    POST /api/tracker/recipients/{id}/resume      track this person again
    GET  /api/tracker/recipients/{id}/reminder-preview  the template as it would be sent now
    POST /api/tracker/recipients/{id}/reminders   draft a reminder now (template or own text)

Replies go through the app's existing POST /api/reply-email.

Every call is scoped to one mailbox, matching how the rest of this API
identifies the user (an email parameter). Endpoints are plain `def`, so
FastAPI runs them in its threadpool and the sync DB calls don't block the
event loop.
"""

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Iterator, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from tracker.config import settings
from tracker.db.session import SessionLocal
from tracker.models import Reminder, SentEmail, SentEmailRecipient
from tracker.schemas.api import (
    DismissReminderRequest,
    MailboxRequest,
    ManualReminderRequest,
    RecipientOut,
    ReminderOut,
    ReminderPreview,
    ReminderQueueItem,
    SendReminderRequest,
    TrackedEmailDetail,
    TrackedEmailOut,
    TrackerSummary,
)
from tracker.services.exclusions import normalize_address
from tracker.services.reminder_engine import (
    ReminderConflict,
    ReminderNotFound,
    create_manual_reminder,
    dismiss_reminder,
    preview_reminder,
    resume_tracking,
    send_reminder,
    stop_tracking,
)
from tracker.services.reminder_sender import ReminderSendError
from tracker.services.ai_analyzer import AIAnalysisError
from tracker.services.thread_client import ThreadFetchError, fetch_thread
from tracker.services.tracking_explainer import ExplainNotFound, explain_tracked_email

router = APIRouter(prefix="/api/tracker", tags=["tracker"])

RecipientStatusParam = Literal["awaiting", "replied", "overdue", "no_followup", "stopped"]
ReminderStatusParam = Literal["pending", "sending", "sent", "failed", "skipped", "dismissed", "cancelled"]


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


def _mailbox(raw: str) -> str:
    addr = normalize_address(raw)
    if not addr:
        raise HTTPException(status_code=400, detail="mailbox must be an email address")
    return addr


@router.get("/summary", response_model=TrackerSummary)
def tracker_summary(mailbox: str = Query(...), session: Session = Depends(get_session)):
    mb = _mailbox(mailbox)
    since = datetime.now(timezone.utc) - timedelta(days=settings.lookback_days)
    emails_tracked = session.scalar(
        select(func.count()).select_from(SentEmail)
        .where(SentEmail.mailbox == mb, SentEmail.sent_at >= since)
    )
    recipients = dict(session.execute(
        select(SentEmailRecipient.status, func.count())
        .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
        .where(SentEmail.mailbox == mb, SentEmail.sent_at >= since)
        .group_by(SentEmailRecipient.status)
    ).all())
    reminders = dict(session.execute(
        select(Reminder.status, func.count())
        .join(SentEmailRecipient, Reminder.recipient_id == SentEmailRecipient.id)
        .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
        .where(SentEmail.mailbox == mb, SentEmail.sent_at >= since)
        .group_by(Reminder.status)
    ).all())
    return TrackerSummary(
        mailbox=mb,
        reminder_mode=settings.reminder_mode,
        reminder_days=list(settings.reminder_days),
        overdue_after_days=settings.overdue_after_days,
        lookback_days=settings.lookback_days,
        emails_tracked=emails_tracked or 0,
        recipients={s: recipients.get(s, 0) for s in ("awaiting", "replied", "overdue", "no_followup", "stopped")},
        reminders=dict(Counter(reminders)),
    )


@router.get("/emails", response_model=list[TrackedEmailOut])
def tracked_emails(
    mailbox: str = Query(...),
    status: RecipientStatusParam | None = Query(None, description="only emails with a recipient in this status"),
    days: int = Query(settings.lookback_days, ge=1, le=90, description="how far back to list"),
    limit: int = Query(200, ge=1, le=500),
    session: Session = Depends(get_session),
):
    mb = _mailbox(mailbox)
    now = datetime.now(timezone.utc)
    q = (
        select(SentEmail)
        .where(SentEmail.mailbox == mb, SentEmail.sent_at >= now - timedelta(days=days))
        .options(selectinload(SentEmail.recipients).selectinload(SentEmailRecipient.reminders))
        .order_by(SentEmail.sent_at.desc())
        .limit(limit)
    )
    if status:
        q = q.where(SentEmail.recipients.any(SentEmailRecipient.status == status))
    return [_email_out(e, now) for e in session.scalars(q).all()]


def _email_fields(e: SentEmail, now: datetime) -> dict:
    age = (now - e.sent_at).total_seconds() / 86_400
    return dict(
        id=e.id, message_id=e.message_id, thread_id=e.thread_id, subject=e.subject,
        sent_at=e.sent_at, days_since_sent=round(age, 2),
        ai_summary=e.ai_summary, ai_analyzed_at=e.ai_analyzed_at,
        next_stage_day=next((d for d in settings.reminder_days if age < d), None),
        recipients=e.recipients,
    )


def _email_out(e: SentEmail, now: datetime) -> TrackedEmailOut:
    return TrackedEmailOut(**_email_fields(e, now))


@router.get("/emails/{email_id}", response_model=TrackedEmailDetail)
def tracked_email_detail(email_id: int, mailbox: str = Query(...), session: Session = Depends(get_session)):
    """One tracked email, its recipients/reminders, and the live conversation."""
    mb = _mailbox(mailbox)
    e = session.scalars(
        select(SentEmail)
        .where(SentEmail.id == email_id, SentEmail.mailbox == mb)
        .options(selectinload(SentEmail.recipients).selectinload(SentEmailRecipient.reminders))
    ).one_or_none()
    if e is None:
        raise HTTPException(status_code=404, detail="Email not found")
    try:
        thread, thread_error = fetch_thread(mb, e.message_id), None
    except ThreadFetchError as err:
        thread, thread_error = [], str(err)
    return TrackedEmailDetail(
        **_email_fields(e, datetime.now(timezone.utc)),
        mailbox=e.mailbox, body=e.body, thread=thread, thread_error=thread_error,
    )


@router.get("/reminders", response_model=list[ReminderQueueItem])
def reminder_queue(
    mailbox: str = Query(...),
    status: ReminderStatusParam = Query("pending"),
    limit: int = Query(200, ge=1, le=500),
    session: Session = Depends(get_session),
):
    mb = _mailbox(mailbox)
    rows = session.execute(
        select(Reminder, SentEmailRecipient, SentEmail)
        .join(SentEmailRecipient, Reminder.recipient_id == SentEmailRecipient.id)
        .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
        .where(SentEmail.mailbox == mb, Reminder.status == status)
        .order_by(Reminder.created_at.desc())
        .limit(limit)
    ).all()
    return [
        ReminderQueueItem(
            **ReminderOut.model_validate(r).model_dump(),
            recipient_id=rec.id, recipient_email=rec.email, recipient_status=rec.status,
            email_id=e.id, email_subject=e.subject, email_sent_at=e.sent_at,
        )
        for r, rec, e in rows
    ]


@router.post("/reminders/{reminder_id}/send", response_model=ReminderOut)
def send_reminder_now(reminder_id: int, payload: SendReminderRequest):
    """Manual send. Edit the subject/body in the request to change the draft."""
    try:
        return send_reminder(
            reminder_id,
            mailbox=_mailbox(payload.mailbox),
            sent_by="manual",
            subject=payload.subject,
            body=payload.body,
        )
    except ReminderNotFound:
        raise HTTPException(status_code=404, detail="Reminder not found")
    except ReminderConflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (ReminderSendError, httpx.HTTPError) as e:
        # Recorded as failed; it can be retried with this same endpoint.
        raise HTTPException(status_code=502, detail=f"Mail server did not send it: {e}")


@router.post("/reminders/{reminder_id}/dismiss", response_model=ReminderOut)
def dismiss_reminder_now(reminder_id: int, payload: DismissReminderRequest):
    try:
        return dismiss_reminder(reminder_id, mailbox=_mailbox(payload.mailbox))
    except ReminderNotFound:
        raise HTTPException(status_code=404, detail="Reminder not found")
    except ReminderConflict as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/emails/{email_id}/explain", response_model=TrackedEmailDetail)
def explain_email_now(email_id: int, payload: MailboxRequest, force: bool = Query(False)):
    """
    Run the "why is this tracked" AI analysis for this email now (the drawer
    calls it when an email hasn't been analysed yet; force=true re-runs it).
    Returns the email detail with the explanation filled in.
    """
    mb = _mailbox(payload.mailbox)
    try:
        explain_tracked_email(email_id, mailbox=mb, force=force)
    except ExplainNotFound:
        raise HTTPException(status_code=404, detail="Email not found")
    except AIAnalysisError as e:
        raise HTTPException(status_code=503, detail=f"The AI couldn't analyse this email right now: {e}")
    with SessionLocal() as session:
        return tracked_email_detail(email_id, mailbox=mb, session=session)


# ── Per-recipient actions ────────────────────────────────────────────────────

def _recipient_action(fn, recipient_id: int, mailbox: str, **kw):
    try:
        return fn(recipient_id, mailbox=_mailbox(mailbox), **kw)
    except ReminderNotFound:
        raise HTTPException(status_code=404, detail="Recipient not found")
    except ReminderConflict as e:
        raise HTTPException(status_code=409, detail=str(e))


def _recipient_out(recipient_id: int) -> RecipientOut:
    with SessionLocal() as session:
        r = session.scalars(
            select(SentEmailRecipient)
            .where(SentEmailRecipient.id == recipient_id)
            .options(selectinload(SentEmailRecipient.reminders))
        ).one()
        return RecipientOut.model_validate(r)


@router.post("/recipients/{recipient_id}/stop", response_model=RecipientOut)
def stop_recipient(recipient_id: int, payload: MailboxRequest):
    """Remove this person from tracking on this email (pending reminders are cancelled)."""
    _recipient_action(stop_tracking, recipient_id, payload.mailbox)
    return _recipient_out(recipient_id)


@router.post("/recipients/{recipient_id}/resume", response_model=RecipientOut)
def resume_recipient(recipient_id: int, payload: MailboxRequest):
    """Track this person again (after a stop, or after the AI said no reply was needed)."""
    _recipient_action(resume_tracking, recipient_id, payload.mailbox)
    return _recipient_out(recipient_id)


@router.get("/recipients/{recipient_id}/reminder-preview", response_model=ReminderPreview)
def reminder_preview(recipient_id: int, mailbox: str = Query(...)):
    """The Day-1 / Day-3 template filled in for this person, without saving anything."""
    return _recipient_action(preview_reminder, recipient_id, mailbox)


@router.post("/recipients/{recipient_id}/reminders", response_model=ReminderOut)
def draft_recipient_reminder(recipient_id: int, payload: ManualReminderRequest):
    """
    Create a reminder now, outside the day 1 / day 3 schedule: the Day-1 / Day-3
    template for today, or send `body` to use your own text. It is created as
    pending — send it with
    POST /reminders/{id}/send. Returns the existing draft if one is waiting.
    """
    return _recipient_action(
        create_manual_reminder, recipient_id, payload.mailbox,
        subject=payload.subject, body=payload.body,
    )
