"""
Create the tracker tables in PostgreSQL.

    cd backend
    python -m tracker.db.init_db

Creates tables that don't exist yet, then runs tracker.db.upgrade to bring
existing ones up to date. It never drops anything.
"""

import logging

from tracker.db.base import Base
from tracker.db.session import engine
from tracker.db.upgrade import upgrade
import tracker.models  # noqa: F401 — registers every model on Base.metadata

log = logging.getLogger("tracker.db")


def init_db() -> None:
    Base.metadata.create_all(engine)
    upgrade()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    init_db()
    log.info("Tracker tables are in place: %s", ", ".join(sorted(Base.metadata.tables)))
