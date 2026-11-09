"""
Reads a whole conversation from the .NET mail server.

GET /api/Values/inbox/onemail?messageId=&targetUserEmail= returns every
message in the conversation the given message belongs to — sent items and
the replies to them — so the dashboard can show where the thread stands.
"""

from datetime import datetime

import httpx

from tracker.config import settings

# A forwarded chain can be hundreds of KB; the reading pane doesn't need more.
_MAX_BODY_CHARS = 300_000


class ThreadFetchError(Exception):
    """The conversation could not be loaded from the mail server."""


def _get(msg: dict, key: str, default=None):
    return msg.get(key, msg.get(key[0].upper() + key[1:], default))


def _sort_key(m: dict):
    try:
        return (0, datetime.fromisoformat(str(m["received"]).replace("Z", "+00:00")))
    except (KeyError, ValueError, TypeError):
        return (1, datetime.max)


def fetch_thread(mailbox: str, message_id: str) -> list[dict]:
    """Messages oldest → newest. Raises ThreadFetchError on failure."""
    try:
        resp = httpx.get(
            f"{settings.org_base}/api/Values/inbox/onemail",
            params={"messageId": message_id, "targetUserEmail": mailbox},
            timeout=settings.http_timeout_seconds,
        )
    except httpx.HTTPError as e:
        raise ThreadFetchError(f"mail server unreachable: {type(e).__name__}") from e
    if resp.status_code != 200:
        raise ThreadFetchError(f"mail server returned HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as e:
        raise ThreadFetchError("mail server returned non-JSON") from e

    if isinstance(data, dict):
        data = data.get("messages") or data.get("Messages") or [data]
    if not isinstance(data, list):
        raise ThreadFetchError(f"unexpected response type {type(data).__name__}")

    messages = []
    for m in data:
        if not isinstance(m, dict):
            continue
        body = _get(m, "body") or ""
        truncated = len(body) > _MAX_BODY_CHARS
        messages.append({
            "message_id": _get(m, "messageId") or "",
            "from": _get(m, "from") or "",
            "to": list(_get(m, "to") or []),
            "cc": list(_get(m, "cc") or []),
            "subject": _get(m, "subject") or "",
            "received": _get(m, "received") or _get(m, "sent"),
            "body": body[:_MAX_BODY_CHARS],
            "body_truncated": truncated,
            "has_attachments": bool(_get(m, "hasAttachments")),
        })
    messages.sort(key=_sort_key)
    return messages
