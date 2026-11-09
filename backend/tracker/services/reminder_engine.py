"""
The reminder flow, run by Celery after every fetch:

  1. overdue   — awaiting recipients with no reply TRACKER_OVERDUE_AFTER_DAYS
                 after sending become overdue (no more reminders)
  2. clean up  — open reminders for people who have since replied (or who are
                 now on the VIP/exclusion list) are cancelled
  3. analyse   — for each awaiting recipient whose current stage (day 1 or
                 3) has no reminder yet, the AI reads the email and decides
                   • a reply is still needed     -> pending, with the fixed
                                                    Day-1 / Day-3 template text
                   • none is needed              -> skipped, recipient no_followup
  4. send      — automatic mode only: pending reminders go out now.
                 Manual mode: they wait for send_reminder() via the API.
  5. explain   — emails not analysed yet get the AI's "why is this tracked"
                 explanation (services/tracking_explainer.py), capped per run.

Only the CURRENT stage is ever prepared. An email first seen on day 4 gets
its day-3 reminder, not day 1 and day 3 together, and a newer stage
replaces an older unsent draft — so nobody gets a burst of reminders.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, joinedload

from tracker.config import settings
from tracker.db.session import SessionLocal
from tracker.models import (
    OPEN_STATUSES,
    RESUMABLE_STATUSES,
    SENDABLE_STATUSES,
    RecipientStatus,
    Reminder,
    ReminderStatus,
    SentEmail,
    SentEmailRecipient,
)
from tracker.services.ai_analyzer import AIAnalysisError, FollowUpDecision, analyze_followup
from tracker.services.exclusions import build_exclusions
from tracker.services.reminder_sender import build_reminder_html, send_reminder_email
from tracker.services.reminder_templates import render_reminder
from tracker.services.tracking_explainer import explain_pending

log = logging.getLogger("tracker.reminders")


# ── Errors the API turns into HTTP responses ─────────────────────────────────

class ReminderNotFound(Exception):
    pass


class ReminderConflict(Exception):
    """The reminder exists but can't be sent/dismissed in its current state."""


@dataclass
class CycleResult:
    marked_overdue: int = 0
    cancelled: int = 0
    analysed: int = 0
    drafted: int = 0
    skipped_by_ai: int = 0
    ai_errors: int = 0
    auto_sent: int = 0
    auto_failed: int = 0
    explained: int = 0
    explain_failed: int = 0
    errors: list[str] = field(default_factory=list)


def current_stage(days_since_sent: float, stage_days: tuple[int, ...]) -> int | None:
    """The latest reminder stage that has come due, or None if none yet."""
    due = [d for d in stage_days if days_since_sent >= d]
    return due[-1] if due else None


def _days_since(sent_at: datetime, now: datetime) -> float:
    return (now - sent_at).total_seconds() / 86_400


# ── Steps 1 + 2 ──────────────────────────────────────────────────────────────

def _mark_overdue(session: Session, mailbox: str, now: datetime) -> int:
    cutoff = now - timedelta(days=settings.overdue_after_days)
    emails = select(SentEmail.id).where(SentEmail.mailbox == mailbox, SentEmail.sent_at <= cutoff)
    return session.execute(
        update(SentEmailRecipient)
        .where(
            SentEmailRecipient.sent_email_id.in_(emails),
            SentEmailRecipient.status == RecipientStatus.AWAITING.value,
        )
        .values(status=RecipientStatus.OVERDUE.value, status_changed_at=now)
    ).rowcount


def _cancel_unneeded(session: Session, mailbox: str, exclusions: frozenset[str]) -> int:
    """Cancel unsent reminders whose recipient replied/closed or is now excluded."""
    rows = session.execute(
        select(Reminder, SentEmailRecipient)
        .join(SentEmailRecipient, Reminder.recipient_id == SentEmailRecipient.id)
        .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
        .where(SentEmail.mailbox == mailbox, Reminder.status.in_(SENDABLE_STATUSES))
    ).all()
    cancelled = 0
    for reminder, recipient in rows:
        if recipient.email in exclusions:
            reminder.status, reminder.note = ReminderStatus.CANCELLED.value, "recipient is now on the VIP/exclusion list"
        elif recipient.status not in OPEN_STATUSES:
            reminder.status, reminder.note = ReminderStatus.CANCELLED.value, f"recipient is {recipient.status}"
        else:
            continue
        cancelled += 1
    return cancelled


# ── Step 3 ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Candidate:
    recipient_id: int
    recipient_email: str
    recipient_kind: str
    stage_day: int
    days_since_sent: float
    subject: str | None
    body: str | None


def _find_candidates(session: Session, mailbox: str, now: datetime, exclusions: frozenset[str]) -> list[_Candidate]:
    window_start = now - timedelta(days=settings.overdue_after_days)
    rows = session.execute(
        select(SentEmailRecipient, SentEmail)
        .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
        .options(joinedload(SentEmailRecipient.reminders))
        .where(
            SentEmail.mailbox == mailbox,
            SentEmail.sent_at > window_start,
            SentEmailRecipient.status == RecipientStatus.AWAITING.value,
        )
        .order_by(SentEmail.sent_at)
    ).unique().all()

    out = []
    for recipient, email in rows:
        if recipient.email in exclusions:
            continue
        age = _days_since(email.sent_at, now)
        stage = current_stage(age, settings.reminder_days)
        if stage is None or any(r.stage_day >= stage for r in recipient.reminders):
            continue
        out.append(_Candidate(recipient.id, recipient.email, recipient.kind, stage, age, email.subject, email.body))
    return out


def _record_decision(session: Session, c: _Candidate, decision: FollowUpDecision, mailbox: str) -> bool:
    """Store the AI's decision for this stage. Returns False if it no longer applies."""
    # Lock the recipient so a concurrent fetch can't mark them replied mid-way.
    recipient = session.get(SentEmailRecipient, c.recipient_id, with_for_update=True)
    if recipient is None or recipient.status != RecipientStatus.AWAITING.value:
        return False

    if decision.needs_followup:
        status = ReminderStatus.PENDING.value
        subject, body = render_reminder(
            day=c.stage_day, original_subject=c.subject,
            recipient_email=c.recipient_email, mailbox=mailbox,
        )
    else:
        status, subject, body = ReminderStatus.SKIPPED.value, None, None

    new_id = session.execute(
        insert(Reminder)
        .values(
            recipient_id=c.recipient_id,
            stage_day=c.stage_day,
            status=status,
            needs_followup=decision.needs_followup,
            ai_reason=decision.reason,
            subject=subject,
            body=body,
        )
        .on_conflict_do_nothing(
            index_elements=[Reminder.recipient_id, Reminder.stage_day],
            # Must be literal SQL: PostgreSQL only matches a partial unique
            # index when the predicate is identical, and a bound parameter
            # ("origin = $1") never is.
            index_where=text("origin = 'scheduled'"),
        )
        .returning(Reminder.id)
    ).scalar_one_or_none()
    if new_id is None:
        return False   # another run already handled this stage

    # An older unsent draft is replaced by this stage's one.
    session.execute(
        update(Reminder)
        .where(
            Reminder.recipient_id == c.recipient_id,
            Reminder.stage_day < c.stage_day,
            Reminder.status.in_(SENDABLE_STATUSES),
        )
        .values(status=ReminderStatus.CANCELLED.value, note=f"superseded by day {c.stage_day}")
    )
    if not decision.needs_followup:
        recipient.status = RecipientStatus.NO_FOLLOWUP.value
        recipient.status_changed_at = datetime.now(timezone.utc)
    return True


# ── Sending (step 4, and the manual API) ─────────────────────────────────────

def send_reminder(
    reminder_id: int,
    *,
    mailbox: str,
    sent_by: str,
    subject: str | None = None,
    body: str | None = None,
    send: Callable[..., None] | None = None,
) -> Reminder:
    """
    Send one reminder now. Used for every send, automatic or manual.

    Checks, in one locked transaction, that it belongs to `mailbox`, can be
    sent, the person still hasn't replied and isn't on the VIP/exclusion
    list; then claims it as "sending" before calling the mail server.
    """
    mailbox = mailbox.lower().strip()
    send = send or send_reminder_email
    with SessionLocal.begin() as session:
        reminder = session.get(Reminder, reminder_id, with_for_update=True)
        if reminder is None:
            raise ReminderNotFound(reminder_id)
        recipient = reminder.recipient
        email = recipient.sent_email
        if email.mailbox != mailbox:
            raise ReminderNotFound(reminder_id)   # don't reveal other mailboxes' reminders
        if reminder.status not in SENDABLE_STATUSES:
            raise ReminderConflict(f"reminder is {reminder.status}")
        if recipient.status not in OPEN_STATUSES:
            raise ReminderConflict(f"recipient is {recipient.status} — no reminder needed")
        if recipient.email in build_exclusions():
            raise ReminderConflict("recipient is on the VIP/exclusion list")
        if subject is not None:
            reminder.subject = subject.strip()
        if body is not None:
            reminder.body = body.strip()
        if not reminder.subject or not reminder.body:
            raise ReminderConflict("reminder needs a subject and a body")
        reminder.status = ReminderStatus.SENDING.value
        to, final_subject = recipient.email, reminder.subject
        body_html = build_reminder_html(
            reminder_body=reminder.body,
            original_subject=email.subject,
            original_body=email.body,
            original_sent_at=email.sent_at,
            sender_mailbox=email.mailbox,
            recipient=recipient.email,
        )

    # Outside the transaction: the claim above is committed, so a crash here
    # leaves it "sending" for a person to check — never sent twice.
    try:
        send(to=to, subject=final_subject, body_html=body_html)
    except Exception as e:
        with SessionLocal.begin() as session:
            session.execute(
                update(Reminder).where(Reminder.id == reminder_id)
                .values(status=ReminderStatus.FAILED.value, note=f"send failed: {str(e)[:300]}")
            )
        raise

    with SessionLocal.begin() as session:
        session.execute(
            update(Reminder).where(Reminder.id == reminder_id)
            .values(status=ReminderStatus.SENT.value, sent_at=datetime.now(timezone.utc),
                    sent_by=sent_by, note=None)
        )
        reminder = session.get(Reminder, reminder_id)
        session.expunge(reminder)
    log.info("[%s] day-%d reminder #%d sent to %s (%s)", mailbox, reminder.stage_day, reminder_id, to, sent_by)
    return reminder


def dismiss_reminder(reminder_id: int, *, mailbox: str) -> Reminder:
    mailbox = mailbox.lower().strip()
    with SessionLocal.begin() as session:
        reminder = session.get(Reminder, reminder_id, with_for_update=True)
        if reminder is None or reminder.recipient.sent_email.mailbox != mailbox:
            raise ReminderNotFound(reminder_id)
        if reminder.status not in SENDABLE_STATUSES:
            raise ReminderConflict(f"reminder is {reminder.status}")
        reminder.status, reminder.note = ReminderStatus.DISMISSED.value, "dismissed by user"
        session.flush()
        session.expunge(reminder)
    return reminder


# ── Per-recipient actions from the dashboard ─────────────────────────────────

def _load_recipient(session: Session, recipient_id: int, mailbox: str) -> SentEmailRecipient:
    recipient = session.get(SentEmailRecipient, recipient_id, with_for_update=True)
    if recipient is None or recipient.sent_email.mailbox != mailbox:
        raise ReminderNotFound(recipient_id)   # don't reveal other mailboxes' data
    return recipient


def stop_tracking(recipient_id: int, *, mailbox: str) -> SentEmailRecipient:
    """User removes this person from tracking: no more reminders, never overdue."""
    mailbox = mailbox.lower().strip()
    with SessionLocal.begin() as session:
        recipient = _load_recipient(session, recipient_id, mailbox)
        if recipient.status == RecipientStatus.REPLIED.value:
            raise ReminderConflict("they already replied — nothing to stop")
        if recipient.status != RecipientStatus.STOPPED.value:
            recipient.status = RecipientStatus.STOPPED.value
            recipient.status_changed_at = datetime.now(timezone.utc)
            session.execute(
                update(Reminder)
                .where(Reminder.recipient_id == recipient_id, Reminder.status.in_(SENDABLE_STATUSES))
                .values(status=ReminderStatus.CANCELLED.value, note="tracking stopped by user")
            )
        session.flush()
        session.refresh(recipient)
        session.expunge(recipient)
    log.info("[%s] tracking stopped for %s (recipient %d)", mailbox, recipient.email, recipient_id)
    return recipient


def resume_tracking(recipient_id: int, *, mailbox: str, now: datetime | None = None) -> SentEmailRecipient:
    """
    Switch tracking back on for someone stopped by the user or judged
    "no follow-up needed" by the AI. They return to awaiting — or straight to
    overdue if the overdue day has already passed. The next Celery run
    prepares the current stage's reminder as usual.
    """
    mailbox = mailbox.lower().strip()
    now = now or datetime.now(timezone.utc)
    with SessionLocal.begin() as session:
        recipient = _load_recipient(session, recipient_id, mailbox)
        if recipient.status in OPEN_STATUSES:
            pass   # already tracked
        elif recipient.status not in RESUMABLE_STATUSES:
            raise ReminderConflict(f"recipient is {recipient.status} — can't resume tracking")
        else:
            if recipient.email in build_exclusions():
                raise ReminderConflict("recipient is on the VIP/exclusion list")
            age = _days_since(recipient.sent_email.sent_at, now)
            overdue = age >= settings.overdue_after_days
            recipient.status = (RecipientStatus.OVERDUE if overdue else RecipientStatus.AWAITING).value
            recipient.status_changed_at = now
        session.flush()
        session.refresh(recipient)
        session.expunge(recipient)
    log.info("[%s] tracking resumed for %s -> %s", mailbox, recipient.email, recipient.status)
    return recipient


def preview_reminder(recipient_id: int, *, mailbox: str, now: datetime | None = None) -> dict:
    """
    What a reminder to this person would say if sent now — the Day-1 template
    before day 3, Day-3 from day 3. Stores nothing (the modal shows it before
    anything is created).
    """
    mailbox = mailbox.lower().strip()
    now = now or datetime.now(timezone.utc)
    with SessionLocal() as session:
        recipient = _load_recipient(session, recipient_id, mailbox)
        if recipient.status not in OPEN_STATUSES:
            raise ReminderConflict(f"recipient is {recipient.status} — resume tracking first")
        email = recipient.sent_email
        day = int(_days_since(email.sent_at, now))
        subject, body = render_reminder(
            day=day, original_subject=email.subject,
            recipient_email=recipient.email, mailbox=mailbox,
        )
    return {"stage_day": day, "template_day": 3 if day >= 3 else 1, "subject": subject, "body": body}


def create_manual_reminder(
    recipient_id: int,
    *,
    mailbox: str,
    subject: str | None = None,
    body: str | None = None,
    now: datetime | None = None,
) -> Reminder:
    """
    A reminder the user asked for from the dashboard, outside the day 1/3
    schedule. With `body` it uses the user's text; without, the Day-1 template
    (before day 3) or the Day-3 template (day 3 onwards). It is created as
    pending — sending is a separate, explicit step.

    If a sendable reminder already exists for this person, that one is
    returned instead, so one person never has two drafts waiting.
    """
    mailbox = mailbox.lower().strip()
    now = now or datetime.now(timezone.utc)

    with SessionLocal() as session:
        recipient = _load_recipient(session, recipient_id, mailbox)
        if recipient.status not in OPEN_STATUSES:
            raise ReminderConflict(f"recipient is {recipient.status} — resume tracking first")
        if recipient.email in build_exclusions():
            raise ReminderConflict("recipient is on the VIP/exclusion list")
        existing = session.scalars(
            select(Reminder)
            .where(Reminder.recipient_id == recipient_id, Reminder.status.in_(SENDABLE_STATUSES))
            .order_by(Reminder.stage_day.desc())
        ).first()
        if existing is not None:
            session.expunge(existing)
            return existing
        email = recipient.sent_email
        age = _days_since(email.sent_at, now)
        ctx = dict(recipient_email=recipient.email, email_subject=email.subject)

    day = int(age)
    template_subject, template_body = render_reminder(
        day=day, original_subject=ctx["email_subject"],
        recipient_email=ctx["recipient_email"], mailbox=mailbox,
    )
    if body and body.strip():
        reason, draft = "Written by the user.", body.strip()
    else:
        reason = f"Day-{3 if day >= 3 else 1} template, requested from the dashboard."
        draft = template_body

    with SessionLocal.begin() as session:
        recipient = _load_recipient(session, recipient_id, mailbox)
        if recipient.status not in OPEN_STATUSES:
            raise ReminderConflict(f"recipient is {recipient.status} — no reminder needed")
        reminder = Reminder(
            recipient_id=recipient_id,
            stage_day=day,
            origin="manual",
            status=ReminderStatus.PENDING.value,
            needs_followup=True,
            ai_reason=reason,
            subject=(subject or "").strip() or template_subject,
            body=draft,
        )
        session.add(reminder)
        session.flush()
        session.refresh(reminder)
        session.expunge(reminder)
    log.info("[%s] manual reminder #%d drafted for %s", mailbox, reminder.id, ctx["recipient_email"])
    return reminder


# ── The whole cycle ──────────────────────────────────────────────────────────

def run_reminder_cycle(
    mailbox: str,
    *,
    now: datetime | None = None,
    analyze: Callable[..., FollowUpDecision] | None = None,
    send: Callable[..., None] | None = None,
) -> CycleResult:
    mailbox = mailbox.lower().strip()
    analyze = analyze or analyze_followup
    now = now or datetime.now(timezone.utc)
    result = CycleResult()
    exclusions = build_exclusions()   # fails closed if vip_list.json is unreadable

    with SessionLocal.begin() as session:
        result.marked_overdue = _mark_overdue(session, mailbox, now)
        result.cancelled = _cancel_unneeded(session, mailbox, exclusions)
        candidates = _find_candidates(session, mailbox, now, exclusions)

    if len(candidates) > settings.max_reminders_per_run:
        log.warning("[%s] %d reminders due; handling %d this run (TRACKER_MAX_REMINDERS_PER_RUN)",
                    mailbox, len(candidates), settings.max_reminders_per_run)
        candidates = candidates[: settings.max_reminders_per_run]

    for c in candidates:
        result.analysed += 1
        try:
            # The AI call is slow, so it runs outside any transaction.
            decision = analyze(
                subject=c.subject,
                body=c.body,
                recipient_email=c.recipient_email,
                recipient_kind=c.recipient_kind,
                stage_day=c.stage_day,
                days_since_sent=c.days_since_sent,
            )
        except AIAnalysisError as e:
            # Nothing stored, so the next run retries this stage.
            result.ai_errors += 1
            result.errors.append(f"AI, recipient {c.recipient_id}: {e}")
            log.warning("[%s] AI analysis failed for %s (day %d): %s", mailbox, c.recipient_email, c.stage_day, e)
            continue
        with SessionLocal.begin() as session:
            if _record_decision(session, c, decision, mailbox):
                if decision.needs_followup:
                    result.drafted += 1
                else:
                    result.skipped_by_ai += 1

    if settings.automate_mail:
        with SessionLocal() as session:
            pending_ids = session.scalars(
                select(Reminder.id)
                .join(SentEmailRecipient, Reminder.recipient_id == SentEmailRecipient.id)
                .join(SentEmail, SentEmailRecipient.sent_email_id == SentEmail.id)
                .where(SentEmail.mailbox == mailbox, Reminder.status == ReminderStatus.PENDING.value)
                .order_by(Reminder.created_at)
                .limit(settings.max_reminders_per_run)
            ).all()
        for rid in pending_ids:
            try:
                send_reminder(rid, mailbox=mailbox, sent_by="auto", send=send)
                result.auto_sent += 1
            except ReminderConflict:
                continue
            except Exception as e:
                # Recorded as failed; automatic mode never re-sends a failed
                # reminder (the mail may have gone) — a person retries it.
                result.auto_failed += 1
                result.errors.append(f"send, reminder {rid}: {e}")

    # Last, so reminders are never held up behind explanations.
    result.explained, result.explain_failed = explain_pending(mailbox, settings.max_reminders_per_run)
    return result
