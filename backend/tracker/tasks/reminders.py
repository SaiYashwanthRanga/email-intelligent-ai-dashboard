"""
Reminder flow task, chained after each mailbox's fetch (see
fetch_sent_emails.py) so it always works on fresh reply status.
"""

import logging
from dataclasses import asdict

from sqlalchemy.exc import OperationalError

from tracker.services.reminder_engine import run_reminder_cycle
from tracker.worker.celery_app import celery_app

log = logging.getLogger("tracker.tasks")


@celery_app.task(
    name="tracker.process_mailbox_reminders",
    # Only the database being briefly unreachable is retried. AI failures are
    # handled inside (the next run retries them) and sends are never retried.
    autoretry_for=(OperationalError,),
    retry_backoff=30,
    max_retries=2,
)
def process_mailbox_reminders(mailbox: str) -> dict:
    result = run_reminder_cycle(mailbox)
    log.info("[%s] reminder cycle: %s", mailbox, result)
    return asdict(result)
