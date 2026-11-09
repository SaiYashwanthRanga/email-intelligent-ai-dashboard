"""
Turn a mailbox's last-7-days sent mail into tracked emails and keep each
recipient's reply status current.

Every run, for each sent item:
  1. validate it (SentItem) — malformed items are counted and skipped
  2. skip it if it's older than the tracking window (TRACKER_LOOKBACK_DAYS),
     or a kind that is never tracked — calendar responses/invites, leave
     requests, automatic replies (tracker/constants/not_tracked_emails.py)
  3. keep only trackable recipients: drop excluded addresses (VIPs +
     ALWAYS_EXCLUDED) and the mailbox owner; skip the email if none are left
  4. store it if new (recipients start as awaiting)
  5. mark recipients the mail server reports as having replied

Reminders and overdue are handled afterwards by the reminder engine.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError
from sqlalchemy.orm import Session

from tracker.repositories import sent_email_repository as repo
from tracker.schemas.sent_item import SentItem
from tracker.services.email_filters import not_trackable_reason
from tracker.services.exclusions import normalize_address
from tracker.services.text import to_plain_text

log = logging.getLogger("tracker.ingest")


@dataclass
class IngestResult:
    fetched: int = 0
    new_emails: int = 0
    already_tracked: int = 0
    newly_replied: int = 0
    skipped_outside_window: int = 0
    skipped_calendar: int = 0
    skipped_leave: int = 0
    skipped_auto_reply: int = 0
    skipped_no_trackable_recipient: int = 0
    skipped_invalid: int = 0


def trackable_recipients(item: SentItem, never_track: frozenset[str]) -> list[tuple[str, str]]:
    """
    [(address, "to"|"cc")] with exclusions removed and duplicates collapsed.
    Someone on both To and Cc is kept once, as "to".
    """
    seen: dict[str, str] = {}
    for kind, addresses in (("to", item.to), ("cc", item.cc)):
        for raw in addresses:
            addr = normalize_address(raw)
            if addr and addr not in never_track and addr not in seen:
                seen[addr] = kind
    return list(seen.items())


def ingest_sent_items(
    session: Session,
    mailbox: str,
    raw_items: list[dict],
    exclusions: frozenset[str],
    lookback_days: int,
    now: datetime | None = None,
) -> IngestResult:
    owner = normalize_address(mailbox) or mailbox.lower().strip()
    never_track = exclusions | {owner}
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=lookback_days)
    result = IngestResult(fetched=len(raw_items))

    for raw in raw_items:
        try:
            item = SentItem.model_validate(raw)
        except ValidationError as e:
            result.skipped_invalid += 1
            log.warning("[%s] skipped malformed sent item: %s", owner, e.errors()[:2])
            continue

        if item.sent_at < cutoff:
            result.skipped_outside_window += 1
            continue

        reason = not_trackable_reason(item.subject, item.body)
        if reason:
            setattr(result, f"skipped_{reason}", getattr(result, f"skipped_{reason}") + 1)
            continue

        recipients = trackable_recipients(item, never_track)
        if not recipients:
            result.skipped_no_trackable_recipient += 1
            continue

        email_id, was_new = repo.upsert_sent_email(
            session,
            mailbox=owner,
            message_id=item.message_id,
            thread_id=item.thread_id,
            subject=item.subject,
            body=to_plain_text(item.body),
            sent_at=item.sent_at,
            is_reply=item.is_reply,
        )
        if was_new:
            repo.add_recipients(session, email_id, recipients)
            result.new_emails += 1
        else:
            result.already_tracked += 1

        # None = the server didn't report on this item; leave status alone.
        if item.replied_by is not None:
            replied = {a for a in (normalize_address(x) for x in item.replied_by) if a}
            result.newly_replied += repo.mark_replied(session, email_id, replied)

    return result
