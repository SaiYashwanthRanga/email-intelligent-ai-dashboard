"""
Periodic tracking of the last 7 days of sent mail.

Every TRACKER_FETCH_INTERVAL_MINUTES beat fires fetch_sent_emails, which
queues one fetch_mailbox_sent_emails per mailbox. Splitting it per mailbox
means one slow or failing mailbox can't hold up or fail the others, and each
retries on its own. Each successful fetch then queues that mailbox's
reminder cycle (tasks/reminders.py), so reminders use fresh reply status.
"""

import logging
from dataclasses import asdict

import httpx
from sqlalchemy.exc import OperationalError

from tracker.config import settings
from tracker.db.session import SessionLocal
from tracker.services.exclusions import build_exclusions
from tracker.services.mailbox_client import MailboxFetchError, fetch_sent_items
from tracker.services.mailboxes import get_tracked_mailboxes
from tracker.services.sent_email_ingest import ingest_sent_items
from tracker.tasks.reminders import process_mailbox_reminders
from tracker.worker.celery_app import celery_app

log = logging.getLogger("tracker.tasks")


@celery_app.task(name="tracker.fetch_sent_emails")
def fetch_sent_emails() -> dict:
    """Fan out: one fetch task per tracked mailbox."""
    if not settings.enabled:
        # Beat schedules nothing when disabled; this covers a manual trigger.
        return {"skipped": "TRACKER_ENABLED=false"}
    mailboxes = get_tracked_mailboxes()
    for mailbox in mailboxes:
        fetch_mailbox_sent_emails.delay(mailbox)
    log.info("Queued sent-mail fetch for %d mailbox(es)", len(mailboxes))
    return {"queued": len(mailboxes)}


@celery_app.task(
    name="tracker.fetch_mailbox_sent_emails",
    # Mail server or database briefly unreachable: retry with backoff. Kept
    # short — the next scheduled run covers anything missed.
    autoretry_for=(MailboxFetchError, httpx.TransportError, OperationalError),
    retry_backoff=settings.task_retry_backoff_seconds,
    retry_backoff_max=max(settings.task_retry_backoff_seconds, settings.fetch_interval_seconds // 2),
    max_retries=settings.task_max_retries,
)
def fetch_mailbox_sent_emails(mailbox: str) -> dict:
    """Fetch one mailbox's last-7-days sent mail and update its tracking."""
    exclusions = build_exclusions()   # fails closed if vip_list.json is unreadable
    raw_items = fetch_sent_items(mailbox)

    # One transaction per mailbox: all of this run's changes, or none.
    with SessionLocal.begin() as session:
        result = ingest_sent_items(session, mailbox, raw_items, exclusions, settings.lookback_days)

    log.info("[%s] tracking update: %s", mailbox, result)
    process_mailbox_reminders.delay(mailbox)
    return asdict(result)
