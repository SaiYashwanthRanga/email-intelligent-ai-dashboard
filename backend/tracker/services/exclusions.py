"""
Who must never be tracked, and address normalisation.

The exclusion set is the VIP list (re-read from vip_list.json on every
call, so edits apply on the next run) plus ALWAYS_EXCLUDED.
"""

import json
import re

from tracker.constants.excluded_recipients import ALWAYS_EXCLUDED, VIP_LIST_FILE

_ANGLE_ADDR = re.compile(r"<([^<>]+)>")


def normalize_address(raw: str | None) -> str | None:
    """
    "Jim Smith <Jim@HFMG.net>" -> "jim@hfmg.net". None if it isn't an address.
    """
    if not raw:
        return None
    text = str(raw)
    m = _ANGLE_ADDR.search(text)
    addr = (m.group(1) if m else text).strip().strip('"').strip().lower()
    if "@" not in addr or " " in addr:
        return None
    return addr


def load_vip_addresses() -> frozenset[str]:
    """
    Read the VIP list. Raises if the file is missing or unreadable.

    Deliberately fails closed: carrying on without the VIP list would track
    the very people it exists to protect, so a broken file stops the run
    (and the next run retries) rather than silently tracking VIPs.
    """
    with open(VIP_LIST_FILE, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{VIP_LIST_FILE} must contain a JSON list of addresses")
    return frozenset(a for a in (normalize_address(x) for x in data) if a)


def build_exclusions() -> frozenset[str]:
    """Every address that must never be tracked."""
    return load_vip_addresses() | ALWAYS_EXCLUDED
