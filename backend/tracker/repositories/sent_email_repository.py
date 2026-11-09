"""
PostgreSQL reads/writes for tracked sent emails.

Writes are idempotent: the email upsert keys on (mailbox, message_id) and
status changes only ever move forward (awaiting -> replied / overdue). So
running the same fetch twice, or two runs for one mailbox overlapping, can't
duplicate or regress anything — PostgreSQL resolves the race.
"""

from datetime import datetime

from sqlalchemy import func, literal_column, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from tracker.models import OPEN_STATUSES, RecipientStatus, SentEmail, SentEmailRecipient


def upsert_sent_email(
    session: Session,
    *,
    mailbox: str,
    message_id: str,
    thread_id: str | None,
    subject: str | None,
    body: str | None,
    sent_at: datetime,
    is_reply: bool,
) -> tuple[int, bool]:
    """
    Insert the email, or just bump last_seen_at if it's already stored.

    Returns (sent_email_id, was_new).
    """
    stmt = insert(SentEmail).values(
        mailbox=mailbox,
        message_id=message_id,
        thread_id=thread_id,
        subject=subject,
        body=body,
        sent_at=sent_at,
        is_reply=is_reply,
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_tracker_sent_emails_mailbox_message",
        set_={"last_seen_at": func.now()},
    ).returning(
        SentEmail.id,
        # PostgreSQL idiom: xmax is 0 only on a freshly inserted row.
        literal_column("(xmax = 0)").label("was_new"),
    )
    row = session.execute(stmt).one()
    return row.id, bool(row.was_new)


def add_recipients(
    session: Session,
    sent_email_id: int,
    recipients: list[tuple[str, str]],
) -> None:
    """Store [(address, "to"|"cc")] for a newly stored email, all awaiting."""
    if not recipients:
        return
    session.execute(
        insert(SentEmailRecipient).on_conflict_do_nothing(
            constraint="uq_tracker_recipients_email_per_message"
        ),
        [{"sent_email_id": sent_email_id, "email": addr, "kind": kind} for addr, kind in recipients],
    )


def mark_replied(session: Session, sent_email_id: int, addresses: set[str]) -> int:
    """
    awaiting/overdue -> replied for these addresses on this email. Returns how
    many changed. Recipients already closed (replied, no_followup) are left alone.
    """
    if not addresses:
        return 0
    result = session.execute(
        update(SentEmailRecipient)
        .where(
            SentEmailRecipient.sent_email_id == sent_email_id,
            SentEmailRecipient.email.in_(addresses),
            SentEmailRecipient.status.in_(OPEN_STATUSES),
        )
        .values(
            status=RecipientStatus.REPLIED.value,
            replied_detected_at=func.now(),
            status_changed_at=func.now(),
        )
    )
    return result.rowcount

