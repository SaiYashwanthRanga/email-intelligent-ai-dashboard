"""Fill in the fixed reminder templates (tracker/constants/reminder_templates.py)."""

import re

from tracker.constants.reminder_templates import (
    DAY1_SUBJECT,
    DAY1_TEMPLATE,
    DAY3_FROM_DAY,
    DAY3_SUBJECT,
    DAY3_TEMPLATE,
)
from tracker.services.text import first_name_from_address

_PREFIX = re.compile(r"^(Re|Fwd?|FW|AW)\s*:\s*", re.IGNORECASE)
_SPACES = re.compile(r"\s+")


def _tidy(subject: str | None) -> str:
    """Runs of whitespace from Outlook -> single spaces. (The regex whitespace
    class also matches the non-breaking spaces Outlook puts in subjects.)"""
    return _SPACES.sub(" ", subject or "").strip()


def clean_topic(subject: str | None) -> str:
    """
    The topic straight from the subject line — no AI.
    "Re: FW: Provider Contract Review" -> "Provider Contract Review", "TCM;" -> "TCM".
    """
    s = _tidy(subject)
    while _PREFIX.match(s):
        s = _PREFIX.sub("", s).strip()
    s = s.strip(" ;:,.-–—")
    return s or _tidy(subject) or "my earlier email"


def render_reminder(
    *, day: int, original_subject: str | None, recipient_email: str, mailbox: str
) -> tuple[str, str]:
    """(subject, body) for a reminder `day` days after the email was sent."""
    day3 = day >= DAY3_FROM_DAY
    subject_line = _tidy(original_subject) or "my earlier email"
    body = (DAY3_TEMPLATE if day3 else DAY1_TEMPLATE).format(
        rec_first=first_name_from_address(recipient_email),
        sender_first=first_name_from_address(mailbox),
        topic=clean_topic(original_subject),
    )
    subject = (DAY3_SUBJECT if day3 else DAY1_SUBJECT).format(subject=subject_line)
    return subject, body
