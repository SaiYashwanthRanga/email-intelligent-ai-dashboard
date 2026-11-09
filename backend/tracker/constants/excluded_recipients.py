"""
Recipients the tracker must never track.

An email is not tracked for a recipient who is:
  1. on the VIP list (vip_list.json), or
  2. in ALWAYS_EXCLUDED below — senior staff and shared inboxes, excluded
     regardless of VIP status.

The VIP list is NOT copied here: it lives in vip_list.json and changes over
time, so the tracker reads it from that file rather than from a snapshot.

All addresses here are lowercase. Compare against a lowercased, stripped
address — vip_list.json itself uses mixed case (e.g. "Alan.Goldfischer@...").
"""

from pathlib import Path

# Senior staff / shared inboxes — never tracked, even if not on the VIP list.
ALWAYS_EXCLUDED: frozenset[str] = frozenset({
    "rinku.singh@hfmg.net",
    "ramon.romero@hfmg.net",
    "hira.ahmed@hfmg.net",
    "sally.kelly@hfmg.net",
    "global.office@hfmg.net",
    "jim@hfmg.net",
    "donna.shaughnessy@hfmg.net",
})

# Source of the VIP list (backend/vip_list.json), resolved from this file's
# location so it works whatever directory the API or Celery worker starts in.
VIP_LIST_FILE: Path = Path(__file__).resolve().parents[2] / "vip_list.json"
