"""
One reminder for one recipient at one stage (day 1 or day 3).

Created by Celery when a stage comes due: the AI reads the email, decides
whether the person still owes a reply, and if so the reminder gets the fixed
Day-1 / Day-3 template text (tracker/constants/reminder_templates.py).

    pending ──(send: auto, or manual via API)──▶ sending ──▶ sent
       │                                            └──────▶ failed ──(retry via API)──▶ sending
       ├──(person dismisses it)──────────────────▶ dismissed
       └──(they replied / a later stage arrived)─▶ cancelled
    skipped   AI decided no follow-up is needed (no draft to send)

origin = "scheduled" (Celery, on a reminder day) or "manual" (the user asked
for one from the dashboard; stage_day is then the day it was made). A unique
index on (recipient_id, stage_day) for scheduled reminders means each stage
happens at most once per person, however many times Celery runs. "sending" is claimed
before the mail server is called, so a crash mid-send leaves the row stuck
in "sending" for a human to check — never silently sent twice.
"""

from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tracker.db.base import Base
from tracker.models.sent_email import SentEmailRecipient


class ReminderStatus(StrEnum):
    PENDING = "pending"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    SKIPPED = "skipped"
    DISMISSED = "dismissed"
    CANCELLED = "cancelled"


# A reminder in one of these states can still go out.
SENDABLE_STATUSES = (ReminderStatus.PENDING.value, ReminderStatus.FAILED.value)


class Reminder(Base):
    __tablename__ = "tracker_reminders"
    __table_args__ = (
        Index(
            "uq_tracker_reminders_scheduled_stage",
            "recipient_id", "stage_day",
            unique=True,
            postgresql_where=text("origin = 'scheduled'"),
        ),
        Index("ix_tracker_reminders_status", "status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    recipient_id: Mapped[int] = mapped_column(
        ForeignKey("tracker_sent_email_recipients.id", ondelete="CASCADE"), index=True
    )
    # Which stage: 1 or 3 (days after the email was sent). For a manual
    # reminder, the day it was created.
    stage_day: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    origin: Mapped[str] = mapped_column(String(16), default="scheduled", server_default="scheduled")

    # The AI's analysis at this stage.
    needs_followup: Mapped[bool] = mapped_column(Boolean)
    ai_reason: Mapped[str | None] = mapped_column(Text)
    # The draft (editable before a manual send). Plain text body.
    subject: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # "auto" (Celery) or "manual" (API).
    sent_by: Mapped[str | None] = mapped_column(String(16))
    # Last send failure, or why it was cancelled.
    note: Mapped[str | None] = mapped_column(Text)

    recipient: Mapped[SentEmailRecipient] = relationship(back_populates="reminders")

    def __repr__(self) -> str:
        return f"<Reminder id={self.id} day={self.stage_day} status={self.status}>"
