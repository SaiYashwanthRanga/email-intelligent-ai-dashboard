"""Request and response models for the /api/tracker endpoints."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class _Orm(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ReminderOut(_Orm):
    id: int
    stage_day: int
    status: str
    origin: str                   # "scheduled" (day 1 / day 3) | "manual" (from the dashboard)
    needs_followup: bool
    ai_reason: str | None
    subject: str | None
    body: str | None
    created_at: datetime
    sent_at: datetime | None
    sent_by: str | None
    note: str | None


class RecipientOut(_Orm):
    id: int
    email: str
    kind: str
    status: str
    replied_detected_at: datetime | None
    status_changed_at: datetime
    # Why this person is tracked (AI). NULL until the email is analysed.
    ai_needs_reply: bool | None = None
    ai_reason: str | None = None
    ai_ask: str | None = None     # verbatim sentence(s) they were asked
    reminders: list[ReminderOut]


class TrackedEmailOut(_Orm):
    id: int
    message_id: str
    thread_id: str | None
    subject: str | None
    sent_at: datetime
    days_since_sent: float
    # AI one-line summary of what the email asks; NULL until analysed.
    ai_summary: str | None = None
    ai_analyzed_at: datetime | None = None
    # The next reminder stage still ahead for this email (None once past the last reminder day).
    next_stage_day: int | None
    recipients: list[RecipientOut]


class ThreadMessage(BaseModel):
    message_id: str
    sender: str = Field(alias="from")
    to: list[str]
    cc: list[str]
    subject: str
    received: datetime | None
    body: str                     # HTML or plain text, as the mail server has it
    body_truncated: bool
    has_attachments: bool

    model_config = ConfigDict(populate_by_name=True)


class TrackedEmailDetail(TrackedEmailOut):
    mailbox: str
    body: str | None              # stored plain-text copy of what was sent
    # The live conversation from the mail server (oldest first). Empty with
    # thread_error set when it couldn't be loaded — body still shows.
    thread: list[ThreadMessage]
    thread_error: str | None


class ReminderPreview(BaseModel):
    stage_day: int                # days since the email was sent
    template_day: int             # 1 or 3 — which template this is
    subject: str
    body: str


class ReminderQueueItem(ReminderOut):
    """A reminder plus the context needed to review it before sending."""
    recipient_id: int
    recipient_email: str
    recipient_status: str
    email_id: int
    email_subject: str | None
    email_sent_at: datetime


class TrackerSummary(BaseModel):
    mailbox: str
    reminder_mode: str            # "manual" | "automatic"
    reminder_days: list[int]
    overdue_after_days: int
    lookback_days: int
    emails_tracked: int
    recipients: dict[str, int]    # awaiting / replied / overdue / no_followup
    reminders: dict[str, int]     # pending / sent / failed / skipped / ...


class SendReminderRequest(BaseModel):
    mailbox: str = Field(min_length=3, max_length=320)
    # Optional edits to the draft before sending.
    subject: str | None = Field(default=None, max_length=500)
    body: str | None = Field(default=None, max_length=20_000)


class DismissReminderRequest(BaseModel):
    mailbox: str = Field(min_length=3, max_length=320)


class MailboxRequest(BaseModel):
    mailbox: str = Field(min_length=3, max_length=320)


class ManualReminderRequest(BaseModel):
    mailbox: str = Field(min_length=3, max_length=320)
    # Leave both out for the Day-1 / Day-3 template; give a body to use your own text.
    subject: str | None = Field(default=None, max_length=500)
    body: str | None = Field(default=None, max_length=20_000)
