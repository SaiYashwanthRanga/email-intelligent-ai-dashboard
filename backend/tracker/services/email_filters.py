"""
Decides whether a sent email is a kind the tracker never tracks (calendar
responses and invites, leave requests, automatic replies). The rules live
in tracker/constants/not_tracked_emails.py.
"""

import re

from tracker.constants import not_tracked_emails as rules
from tracker.services.text import new_message_text

_FLAGS = re.IGNORECASE


def _prefix_re(prefixes: list[str]) -> re.Pattern:
    # Optional "RE:/FW:" in front, then the prefix and a colon.
    return re.compile(r"^\s*((re|fwd?|fw)\s*:\s*)*(" + "|".join(prefixes) + r")\s*:", _FLAGS)


def _any_re(patterns: list[str]) -> re.Pattern:
    return re.compile("|".join(f"(?:{p})" for p in patterns), _FLAGS)


_CALENDAR_SUBJECT = _prefix_re(rules.CALENDAR_SUBJECT_PREFIXES)
_CALENDAR_BODY = _any_re(rules.CALENDAR_BODY_PATTERNS)
_LEAVE_SUBJECT = _any_re(rules.LEAVE_SUBJECT_PATTERNS)
_LEAVE_BODY = _any_re(rules.LEAVE_BODY_PATTERNS)
_AUTO_SUBJECT = _prefix_re(rules.AUTO_REPLY_SUBJECT_PREFIXES)

# Body rules only look at the new text of a reply (quoted history cut off),
# so a reply that quotes an earlier Zoom invite or leave request is still tracked.
def _new_text(body: str | None) -> str:
    return new_message_text(body, max_chars=rules.BODY_SCAN_CHARS)


def not_trackable_reason(subject: str | None, body: str | None) -> str | None:
    """
    "calendar" | "leave" | "auto_reply" when this email must not be tracked,
    otherwise None. `body` may be HTML or plain text.
    """
    subj = subject or ""
    head = _new_text(body)

    if _AUTO_SUBJECT.search(subj):
        return "auto_reply"
    if _CALENDAR_SUBJECT.search(subj) or _CALENDAR_BODY.search(head):
        return "calendar"
    if _LEAVE_SUBJECT.search(subj) or _LEAVE_BODY.search(head):
        return "leave"
    return None
