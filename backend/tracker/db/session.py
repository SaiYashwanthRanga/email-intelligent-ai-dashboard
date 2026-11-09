"""
Database engine and session factory.

The engine connects lazily — importing this module opens no connection — so
the Celery worker and the API can both import it at startup even before
PostgreSQL is reachable.

Usage (one transaction, committed on success, rolled back on error):

    with SessionLocal.begin() as session:
        ...
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tracker.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,   # drop dead connections instead of failing a task on them
)

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
