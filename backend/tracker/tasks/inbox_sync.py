"""
Background inbox sync for the app's users (APP_USERS_FILE).

Every INBOX_SYNC_INTERVAL_MINUTES beat fires sync_inboxes, which queues one
sync_user_inbox per user. Each one asks the email API to fetch the inbox
live and then classify it, exactly as the UI does — so the AI analysis,
thread grouping and every cache write stay in one place (the API process)
instead of being duplicated here. When the user opens the app,
/api/fetch-inbox answers from that warm cache instead of waiting on the
mail server.

The task doesn't wait for classification to finish: /api/analyze runs it in
the API's background. A sync is skipped while a classification for that user
is still running, so runs never pile up.
"""

import logging

import httpx

from tracker.config import settings
from tracker.services.mailboxes import get_app_users
from tracker.worker.celery_app import celery_app

log = logging.getLogger("tracker.tasks.inbox_sync")


class InboxSyncError(Exception):
    """The API answered, but the sync could not be completed."""


@celery_app.task(name="tracker.sync_inboxes")
def sync_inboxes() -> dict:
    """Fan out: one sync task per app user."""
    if not settings.inbox_sync_enabled:
        return {"skipped": "INBOX_SYNC_ENABLED=false"}
    users = get_app_users()
    for user in users:
        sync_user_inbox.delay(user)
    log.info("Queued inbox sync for %d user(s)", len(users))
    return {"queued": len(users)}


@celery_app.task(
    name="tracker.sync_user_inbox",
    # API briefly unreachable (e.g. restarting under --reload): retry a few
    # times; the next scheduled run covers anything missed.
    autoretry_for=(httpx.TransportError,),
    retry_backoff=settings.task_retry_backoff_seconds,
    retry_backoff_max=max(settings.task_retry_backoff_seconds, settings.inbox_sync_interval_seconds // 2),
    max_retries=settings.task_max_retries,
)
def sync_user_inbox(user: str) -> dict:
    api = settings.inbox_sync_api_url
    # Long enough for the API's own 120s mail-server timeout plus processing.
    with httpx.Client(timeout=180) as client:
        status = client.get(f"{api}/analysis-updates", params={"user_email": user, "since": 10**9})
        if status.status_code == 200 and status.json().get("status") == "running":
            log.info("[%s] classification still running — skipping this sync", user)
            return {"skipped": "analysis running"}

        resp = client.get(
            f"{api}/fetch-inbox",
            params={"email": user, "count": settings.inbox_sync_count, "live": "true"},
        )
        if resp.status_code != 200:
            raise InboxSyncError(f"fetch-inbox for {user} -> HTTP {resp.status_code}: {resp.text[:200]}")
        source = resp.headers.get("X-Data-Source", "live")
        if source != "live":
            # Mail server unreachable; the API fell back to the cache. Nothing
            # new to classify — leave the last good snapshot in place.
            log.warning("[%s] mail server unreachable — inbox not refreshed", user)
            return {"synced": False, "source": source}

        emails = resp.json()
        analyze = client.post(f"{api}/analyze", json={"emails": emails, "user_email": user})
        if analyze.status_code != 200:
            raise InboxSyncError(f"analyze for {user} -> HTTP {analyze.status_code}: {analyze.text[:200]}")
        classifying = bool(analyze.json().get("analyzing"))

    log.info("[%s] inbox synced: %d emails%s", user, len(emails), ", classifying new ones" if classifying else "")
    return {"synced": True, "emails": len(emails), "classifying": classifying}
