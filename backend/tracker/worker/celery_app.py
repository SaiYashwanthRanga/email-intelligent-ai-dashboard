"""
The tracker's Celery app and its periodic schedule. Every setting comes from
tracker/config.py.

Run from the backend folder, as two processes:

    celery -A tracker.worker.celery_app worker --pool=solo --loglevel=info
    celery -A tracker.worker.celery_app beat --loglevel=info

--pool=solo is needed on Windows (Celery's default prefork pool doesn't run
there); on Linux it can be dropped. Run exactly ONE beat process — two beats
schedule every job twice.
"""

import logging

from celery import Celery

from tracker.config import settings

log = logging.getLogger("tracker.worker")

celery_app = Celery(
    "tracker",
    broker=settings.broker_url,
    backend=settings.result_backend,
    include=["tracker.tasks.fetch_sent_emails", "tracker.tasks.reminders"],
)


def _beat_schedule() -> dict:
    if not settings.enabled:
        return {}
    return {
        "tracker-fetch-sent-emails": {
            "task": "tracker.fetch_sent_emails",
            "schedule": float(settings.fetch_interval_seconds),
            # If workers fall behind, drop a run that's older than one
            # interval rather than letting stale runs pile up — the next
            # run fetches the same mail anyway.
            "options": {"expires": float(settings.fetch_interval_seconds)},
        },
    }


celery_app.conf.update(
    timezone="UTC",
    enable_utc=True,
    task_ignore_result=settings.result_backend is None,
    # A task is only removed from the queue once it finishes, so a worker
    # crash mid-run re-delivers it instead of losing it. Safe here because
    # every tracker write is idempotent.
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    beat_schedule=_beat_schedule(),
)

log.info(
    "Tracker Celery: %s, every %d min, %d-day window, reminder mail %s",
    "enabled" if settings.enabled else "DISABLED (TRACKER_ENABLED=false)",
    settings.fetch_interval_minutes,
    settings.lookback_days,
    settings.reminder_mode,
)
