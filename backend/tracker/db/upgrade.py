"""
Bring an existing tracker database up to the current schema, keeping its data.

    cd backend
    python -m tracker.db.upgrade

Every step is idempotent (IF EXISTS / IF NOT EXISTS), so running it twice, or
on a fresh database created by init_db, is harmless. init_db runs it too.

When schema changes get more frequent, replace this with Alembic.
"""

import logging

from sqlalchemy import text

from tracker.db.session import engine

log = logging.getLogger("tracker.db")

STEPS = [
    # 1. Manual reminders (sent from the dashboard): an origin column, and the
    #    one-reminder-per-stage rule limited to scheduled reminders.
    "ALTER TABLE tracker_reminders ADD COLUMN IF NOT EXISTS origin VARCHAR(16) NOT NULL DEFAULT 'scheduled'",
    "ALTER TABLE tracker_reminders DROP CONSTRAINT IF EXISTS uq_tracker_reminders_recipient_stage",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_tracker_reminders_scheduled_stage "
    "ON tracker_reminders (recipient_id, stage_day) WHERE origin = 'scheduled'",
    # 2. Why-tracked explanation (AI), shown when an email is opened.
    "ALTER TABLE tracker_sent_emails ADD COLUMN IF NOT EXISTS ai_summary TEXT",
    "ALTER TABLE tracker_sent_emails ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ",
    "ALTER TABLE tracker_sent_email_recipients ADD COLUMN IF NOT EXISTS ai_needs_reply BOOLEAN",
    "ALTER TABLE tracker_sent_email_recipients ADD COLUMN IF NOT EXISTS ai_reason TEXT",
    "ALTER TABLE tracker_sent_email_recipients ADD COLUMN IF NOT EXISTS ai_ask TEXT",
]


def _rewrite_drafts_to_templates() -> int:
    """
    Data step: unsent drafts written before the fixed templates existed get
    the Day-1 / Day-3 template text. Skips drafts that already carry the
    template footer and anything the user wrote themselves, so re-running is
    a no-op.
    """
    from sqlalchemy import select

    from tracker.constants.reminder_templates import FOOTER
    from tracker.db.session import SessionLocal
    from tracker.models import SENDABLE_STATUSES, Reminder
    from tracker.services.reminder_templates import render_reminder

    changed = 0
    with SessionLocal.begin() as session:
        drafts = session.scalars(
            select(Reminder).where(Reminder.status.in_(SENDABLE_STATUSES))
        ).all()
        for r in drafts:
            if (r.body and FOOTER in r.body) or r.ai_reason == "Written by the user.":
                continue
            email = r.recipient.sent_email
            r.subject, r.body = render_reminder(
                day=r.stage_day, original_subject=email.subject,
                recipient_email=r.recipient.email, mailbox=email.mailbox,
            )
            changed += 1
    return changed


def _untrack_not_trackable_emails() -> dict:
    """
    Data step: emails stored before the not-tracked rules existed (calendar
    responses/invites, leave requests, automatic replies) are removed. If a
    reminder was already sent for one, it is kept for the record and its
    open recipients are stopped instead. Re-running finds nothing new.
    """
    from sqlalchemy import select, update

    from tracker.db.session import SessionLocal
    from tracker.models import (
        OPEN_STATUSES, SENDABLE_STATUSES, RecipientStatus, Reminder, ReminderStatus,
        SentEmail, SentEmailRecipient,
    )
    from tracker.services.email_filters import not_trackable_reason

    deleted = stopped = 0
    with SessionLocal.begin() as session:
        for email in session.scalars(select(SentEmail)).all():
            reason = not_trackable_reason(email.subject, email.body)
            if not reason:
                continue
            ids = [r.id for r in email.recipients]
            any_sent = bool(ids) and session.scalar(
                select(Reminder.id).where(
                    Reminder.recipient_id.in_(ids), Reminder.status == ReminderStatus.SENT.value
                ).limit(1)
            )
            if not any_sent:
                session.delete(email)           # recipients + reminders cascade
                deleted += 1
                continue
            session.execute(
                update(Reminder)
                .where(Reminder.recipient_id.in_(ids), Reminder.status.in_(SENDABLE_STATUSES))
                .values(status=ReminderStatus.CANCELLED.value, note=f"not tracked: {reason}")
            )
            stopped += session.execute(
                update(SentEmailRecipient)
                .where(SentEmailRecipient.id.in_(ids), SentEmailRecipient.status.in_(OPEN_STATUSES))
                .values(status=RecipientStatus.STOPPED.value)
            ).rowcount
    return {"deleted": deleted, "stopped_recipients": stopped}


def upgrade() -> None:
    with engine.begin() as conn:
        exists = conn.execute(text("SELECT to_regclass('tracker_reminders')")).scalar()
        if exists is None:
            log.info("No tracker tables yet — run init_db; nothing to upgrade.")
            return
        for sql in STEPS:
            conn.execute(text(sql))
    rewritten = _rewrite_drafts_to_templates()
    untracked = _untrack_not_trackable_emails()
    log.info(
        "Tracker schema is up to date (%d steps checked); %d draft(s) moved to the templates; "
        "not-tracked emails removed: %s.",
        len(STEPS), rewritten, untracked,
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    upgrade()
