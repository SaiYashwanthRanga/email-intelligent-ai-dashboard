"""
Client for the .NET mail server's sent-mail endpoint.

Synchronous on purpose: Celery tasks are plain functions, so a blocking
httpx call is the simple, correct fit here.
"""

import httpx

from tracker.config import settings


class MailboxFetchError(Exception):
    """The mail server answered, but not with a usable list of sent items."""


def fetch_sent_items(mailbox: str) -> list[dict]:
    """
    Every email `mailbox` sent in the last 7 days, with Exchange's reply
    status per recipient (GET /api/Values/sent7days).

    Raises on any failure instead of returning []. An empty list must mean
    "nothing sent", never "the server was down" — otherwise an outage looks
    like a quiet mailbox and nobody notices the tracker has stopped.
    """
    url = f"{settings.org_base}/api/Values/sent7days"
    resp = httpx.get(url, params={"email": mailbox}, timeout=settings.http_timeout_seconds)
    if resp.status_code != 200:
        raise MailboxFetchError(
            f"GET sent7days for {mailbox} -> HTTP {resp.status_code}: {resp.text[:200]}"
        )
    try:
        data = resp.json()
    except ValueError as e:
        raise MailboxFetchError(f"sent7days for {mailbox} returned non-JSON") from e
    if not isinstance(data, list):
        raise MailboxFetchError(
            f"sent7days for {mailbox} returned {type(data).__name__}, expected a list"
        )
    return data
