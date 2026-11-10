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
import sys
from logging.handlers import RotatingFileHandler

from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger

from tracker.config import BACKEND_DIR, settings

log = logging.getLogger("tracker.worker")

# ── Log files ─────────────────────────────────────────────────────────────
# The worker and beat each keep a rotating log in backend/logs, alongside the
# console output: logs/celery-worker.log and logs/celery-beat.log, 5 MB x 5
# backups (same policy as the API's dashboard.log). Nothing to pass on the
# command line — start-all.bat and a manual start both get it.
_LOG_DIR = BACKEND_DIR / "logs"
_ROLE = "beat" if "beat" in sys.argv else "worker"
_file_handler = None


def _celery_file_handler() -> RotatingFileHandler:
    global _file_handler
    if _file_handler is None:
        _LOG_DIR.mkdir(exist_ok=True)
        _file_handler = RotatingFileHandler(
            _LOG_DIR / f"celery-{_ROLE}.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        _file_handler.setLevel(logging.INFO)
        _file_handler.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
        ))
    return _file_handler


@after_setup_logger.connect
@after_setup_task_logger.connect
def _add_file_log(logger, *args, **kwargs):
    if _celery_file_handler() not in logger.handlers:
        logger.addHandler(_celery_file_handler())

celery_app = Celery(
    "tracker",
    broker=settings.broker_url,
    backend=settings.result_backend,
    include=["tracker.tasks.fetch_sent_emails", "tracker.tasks.reminders", "tracker.tasks.inbox_sync"],
)


def _beat_schedule() -> dict:
    schedule = {}
    if settings.enabled:
        schedule["tracker-fetch-sent-emails"] = {
            "task": "tracker.fetch_sent_emails",
            "schedule": float(settings.fetch_interval_seconds),
            # If workers fall behind, drop a run that's older than one
            # interval rather than letting stale runs pile up — the next
            # run fetches the same mail anyway.
            "options": {"expires": float(settings.fetch_interval_seconds)},
        }
    if settings.inbox_sync_enabled:
        schedule["inbox-sync"] = {
            "task": "tracker.sync_inboxes",
            "schedule": float(settings.inbox_sync_interval_seconds),
            "options": {"expires": float(settings.inbox_sync_interval_seconds)},
        }
    return schedule


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
