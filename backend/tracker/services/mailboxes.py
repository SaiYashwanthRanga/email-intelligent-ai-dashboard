"""
Which mailboxes the tracker fetches sent mail for.

Read from TRACKER_MAILBOXES_FILE (default: backend/tracking_access.json, a
JSON list of addresses) on every run, so adding or removing someone takes
effect on the next 5-minute cycle without restarting anything.
"""

import json
import logging

from tracker.config import settings
from tracker.services.exclusions import normalize_address

log = logging.getLogger("tracker.mailboxes")


def get_tracked_mailboxes() -> list[str]:
    path = settings.mailboxes_file
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        log.warning("Mailbox list %s not found — nothing to fetch", path)
        return []
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON list of mailbox addresses")
    return sorted({a for a in (normalize_address(x) for x in data) if a})
