"""
A sent email and the recipients it is being tracked for.

One row in tracker_sent_emails per email the person sent, and one row in
tracker_sent_email_recipients per trackable recipient of it (excluded
addresses are never stored — see tracker/constants/excluded_recipients.py).

Each recipient moves through:

    awaiting ──(they reply)───────────────────────────────▶ replied
        │  ▲ template reminders on TRACKER_REMINDER_DAYS (1, 3)
        ├──(AI: this email needs no reply from them)───────▶ no_followup
        ├──(user removes them from tracking)───────────────▶ stopped
        └──(TRACKER_OVERDUE_AFTER_DAYS pass, no reply)─────▶ overdue ──▶ replied

stopped / no_followup can be resumed by the user (back to awaiting/overdue).

Only the mail server can say someone replied (repliedByAddresses), and a
recipient never goes back from replied to awaiting.
"""

from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tracker.db.base import Base

if TYPE_CHECKING:   # avoids a circular import; SQLAlchemy resolves it at runtime
    from tracker.models.reminder import Reminder

# RFC 5321 caps a mailbox address at 320 characters.
EMAIL_MAX_LEN = 320


class RecipientStatus(StrEnum):
    AWAITING = "awaiting"
    REPLIED = "replied"
    OVERDUE = "overdue"
    NO_FOLLOWUP = "no_followup"
    STOPPED = "stopped"


# Statuses where we are still waiting on the person.
OPEN_STATUSES = (RecipientStatus.AWAITING.value, RecipientStatus.OVERDUE.value)
# Closed statuses the user can switch tracking back on from.
RESUMABLE_STATUSES = (RecipientStatus.NO_FOLLOWUP.value, RecipientStatus.STOPPED.value)


class SentEmail(Base):
    __tablename__ = "tracker_sent_emails"
    __table_args__ = (
        # The same message is fetched again on every run; this is what makes
        # re-fetching it an update instead of a duplicate.
        UniqueConstraint("mailbox", "message_id", name="uq_tracker_sent_emails_mailbox_message"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Whose Sent Items this came from. No separate index: the unique
    # constraint above leads with mailbox, so it already serves lookups by it.
    mailbox: Mapped[str] = mapped_column(String(EMAIL_MAX_LEN))
    # Exchange message ID (messageId from the mail server).
    message_id: Mapped[str] = mapped_column(Text)
    # Exchange conversation ID (conversationId) — groups the thread.
    thread_id: Mapped[str | None] = mapped_column(Text, index=True)
    subject: Mapped[str | None] = mapped_column(Text)
    # Plain-text body (HTML stripped, capped) — what the AI reads, and what
    # each reminder quotes back to the recipient.
    body: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # True when this email was itself a reply in an existing thread.
    is_reply: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # AI explanation of the email, shown when it is opened: what it asks, in
    # one line. NULL until analysed (see services/tracking_explainer.py).
    ai_summary: Mapped[str | None] = mapped_column(Text)
    ai_analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When the tracker first stored it, and the last run that still saw it.
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    recipients: Mapped[list["SentEmailRecipient"]] = relationship(
        back_populates="sent_email",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"<SentEmail id={self.id} mailbox={self.mailbox!r} sent_at={self.sent_at}>"


class SentEmailRecipient(Base):
    __tablename__ = "tracker_sent_email_recipients"
    __table_args__ = (
        UniqueConstraint("sent_email_id", "email", name="uq_tracker_recipients_email_per_message"),
        # "Who is still awaiting a reply" is the tracker's main question.
        Index("ix_tracker_recipients_status", "status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    sent_email_id: Mapped[int] = mapped_column(
        ForeignKey("tracker_sent_emails.id", ondelete="CASCADE"), index=True
    )
    # Always stored lowercased.
    email: Mapped[str] = mapped_column(String(EMAIL_MAX_LEN), index=True)
    # "to" or "cc".
    kind: Mapped[str] = mapped_column(String(2))
    status: Mapped[str] = mapped_column(
        String(16),
        default=RecipientStatus.AWAITING.value,
        server_default=RecipientStatus.AWAITING.value,
    )
    # When the tracker first saw the reply (the mail server doesn't say when
    # it arrived, only that it did) — accurate to one fetch interval.
    replied_detected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # Why this person is tracked, per the AI: does the email expect a reply
    # from them, why, and the exact sentence(s) they are asked (verbatim from
    # the email — never paraphrased; NULL when there is no direct question).
    ai_needs_reply: Mapped[bool | None] = mapped_column(Boolean)
    ai_reason: Mapped[str | None] = mapped_column(Text)
    ai_ask: Mapped[str | None] = mapped_column(Text)

    sent_email: Mapped[SentEmail] = relationship(back_populates="recipients")
    reminders: Mapped[list["Reminder"]] = relationship(
        back_populates="recipient",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Reminder.stage_day",
    )

    def __repr__(self) -> str:
        return (
            f"<SentEmailRecipient {self.kind}={self.email!r} status={self.status} "
            f"sent_email_id={self.sent_email_id}>"
        )
