"""
Tracker configuration — the one place every tracker / Celery setting lives.

Each value has a default here and can be overridden in backend/.env (or the
process environment). The API, the Celery worker and Celery beat all read
this same module, so they always agree. Restart the worker and beat after
changing a value.

──────────────────────────────────────────────────────────────────────────
 Setting (env var)                     Default   What it does
──────────────────────────────────────────────────────────────────────────
 SCHEDULE
 TRACKER_ENABLED                       true      Master switch. false = beat
                                                 schedules nothing.
 TRACKER_FETCH_INTERVAL_MINUTES        5         Reschedule time: how often
                                                 Celery re-fetches sent mail.
 TRACKER_LOOKBACK_DAYS                 7         Tracking window: how far back
                                                 replies are checked. 1–7 (the
                                                 mail server serves 7 days).
 TRACKER_MAILBOXES_FILE                backend/tracking_access.json
                                                 JSON list of mailboxes to track.

 REMINDER FLOW
 TRACKER_AUTOMATE_MAIL                 false     true  = Celery sends reminders
                                                         automatically.
                                                 false = manual: Celery prepares
                                                         template drafts; a person sends
                                                         them via the API.
 TRACKER_REMINDER_DAYS                 1,3       Days after sending (calendar
                                                 days) when the AI checks the
                                                 email and the Day-1 / Day-3
                                                 template reminder is due.
 TRACKER_OVERDUE_AFTER_DAYS            5         No reply this many days after
                                                 sending -> overdue (no more
                                                 reminders). Must be later than
                                                 the last reminder day.
 TRACKER_MAX_REMINDERS_PER_RUN         25        Safety cap per run on AI checks
                                                 and on automatic sends, so bad
                                                 data can't mail everyone.
 TRACKER_REMINDER_SENDER               reminders@hfmg.net
                                                 Mailbox reminders are sent from.
 TRACKER_AI_MODEL                      gpt-4o-mini  Model that decides whether a
                                                 reply is still needed (uses
                                                 OPENAI_API_KEY). Reminder text
                                                 is the fixed template.

 CELERY / INFRASTRUCTURE
 TRACKER_DATABASE_URL                  (set in .env)  PostgreSQL connection.
 CELERY_BROKER_URL                     redis://localhost:6379/0
 CELERY_RESULT_BACKEND                 unset     Results ignored when unset.
 TRACKER_TASK_MAX_RETRIES              2         Retries when the mail server
                                                 or database is unreachable.
 TRACKER_TASK_RETRY_BACKOFF_SECONDS    30        First retry delay (doubles).
 TRACKER_HTTP_TIMEOUT_SECONDS          60        Mail server request timeout.
 ORG_BASE                              http://172.22.6.98:4200
                                                 The .NET mail server (same
                                                 variable main.py reads).

 INBOX SYNC (Celery keeps each app user's inbox cache warm)
 APP_USERS_FILE                        backend/app_users.json
                                                 JSON list of the people who use
                                                 the app; only these are synced.
 INBOX_SYNC_ENABLED                    true      false = beat doesn't sync inboxes.
 INBOX_SYNC_INTERVAL_MINUTES           5         How often each inbox is synced.
 INBOX_SYNC_COUNT                      500       Emails fetched per sync.
 INBOX_SYNC_API_URL                    http://localhost:8000/api
                                                 The email API the sync calls, so
                                                 classification and caching run in
                                                 the API exactly as for the UI.
──────────────────────────────────────────────────────────────────────────
"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

# The mail server's sent-items endpoint only returns the last 7 days.
MAX_LOOKBACK_DAYS = 7

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ValueError(f"{name} must be true or false, got {raw!r}")


def _int_list_env(name: str, default: str) -> tuple[int, ...]:
    raw = os.getenv(name) or default
    try:
        values = sorted({int(x) for x in raw.split(",") if x.strip()})
    except ValueError as e:
        raise ValueError(f"{name} must be comma-separated whole numbers, got {raw!r}") from e
    if not values or values[0] < 1:
        raise ValueError(f"{name} needs at least one day, all >= 1, got {raw!r}")
    return tuple(values)


def _int_env(name: str, default: int, *, minimum: int, maximum: int | None = None) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        value = default
    else:
        try:
            value = int(raw)
        except ValueError as e:
            raise ValueError(f"{name} must be a whole number, got {raw!r}") from e
    if value < minimum or (maximum is not None and value > maximum):
        bounds = f">= {minimum}" if maximum is None else f"between {minimum} and {maximum}"
        raise ValueError(f"{name} must be {bounds}, got {value}")
    return value


@dataclass(frozen=True)
class TrackerSettings:
    # Schedule
    enabled: bool
    fetch_interval_minutes: int
    lookback_days: int
    mailboxes_file: Path
    # Reminder flow
    automate_mail: bool
    reminder_days: tuple[int, ...]
    overdue_after_days: int
    max_reminders_per_run: int
    reminder_sender: str
    ai_model: str
    openai_api_key: str | None
    # Celery / infrastructure
    database_url: str
    broker_url: str
    result_backend: str | None
    task_max_retries: int
    task_retry_backoff_seconds: int
    http_timeout_seconds: int
    org_base: str
    # Inbox sync
    app_users_file: Path
    inbox_sync_enabled: bool
    inbox_sync_interval_minutes: int
    inbox_sync_count: int
    inbox_sync_api_url: str

    @property
    def inbox_sync_interval_seconds(self) -> int:
        return self.inbox_sync_interval_minutes * 60

    @property
    def fetch_interval_seconds(self) -> int:
        return self.fetch_interval_minutes * 60

    @property
    def reminder_mode(self) -> str:
        return "automatic" if self.automate_mail else "manual"


def load_settings() -> TrackerSettings:
    return TrackerSettings(
        # ── Schedule ──
        enabled=_bool_env("TRACKER_ENABLED", True),
        fetch_interval_minutes=_int_env("TRACKER_FETCH_INTERVAL_MINUTES", 5, minimum=1),
        lookback_days=_int_env("TRACKER_LOOKBACK_DAYS", 7, minimum=1, maximum=MAX_LOOKBACK_DAYS),
        mailboxes_file=Path(
            os.getenv("TRACKER_MAILBOXES_FILE", str(BACKEND_DIR / "tracking_access.json"))
        ),
        # ── Reminder flow ──
        # Off by default: automatic mode emails real people with nobody
        # reviewing first, so it has to be switched on deliberately.
        automate_mail=_bool_env("TRACKER_AUTOMATE_MAIL", False),
        reminder_days=_int_list_env("TRACKER_REMINDER_DAYS", "1,3"),
        overdue_after_days=_int_env("TRACKER_OVERDUE_AFTER_DAYS", 5, minimum=1),
        max_reminders_per_run=_int_env("TRACKER_MAX_REMINDERS_PER_RUN", 25, minimum=0),
        reminder_sender=os.getenv("TRACKER_REMINDER_SENDER", "reminders@hfmg.net").strip(),
        ai_model=os.getenv("TRACKER_AI_MODEL", "gpt-4o-mini").strip(),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        # ── Celery / infrastructure ──
        # No credentials baked in: set TRACKER_DATABASE_URL in .env, e.g.
        # postgresql+psycopg://user:password@localhost:5432/email_tracker
        database_url=os.getenv(
            "TRACKER_DATABASE_URL", "postgresql+psycopg://localhost:5432/email_tracker"
        ),
        broker_url=os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0"),
        result_backend=os.getenv("CELERY_RESULT_BACKEND") or None,
        task_max_retries=_int_env("TRACKER_TASK_MAX_RETRIES", 2, minimum=0),
        task_retry_backoff_seconds=_int_env("TRACKER_TASK_RETRY_BACKOFF_SECONDS", 30, minimum=1),
        http_timeout_seconds=_int_env("TRACKER_HTTP_TIMEOUT_SECONDS", 60, minimum=1),
        org_base=os.getenv("ORG_BASE", "http://172.22.6.98:4200").rstrip("/"),
        # ── Inbox sync ──
        app_users_file=Path(os.getenv("APP_USERS_FILE", str(BACKEND_DIR / "app_users.json"))),
        inbox_sync_enabled=_bool_env("INBOX_SYNC_ENABLED", True),
        inbox_sync_interval_minutes=_int_env("INBOX_SYNC_INTERVAL_MINUTES", 5, minimum=1),
        inbox_sync_count=_int_env("INBOX_SYNC_COUNT", 500, minimum=1),
        inbox_sync_api_url=os.getenv("INBOX_SYNC_API_URL", "http://localhost:8000/api").rstrip("/"),
    )


def _validate(s: TrackerSettings) -> TrackerSettings:
    if s.overdue_after_days <= s.reminder_days[-1]:
        raise ValueError(
            f"TRACKER_OVERDUE_AFTER_DAYS ({s.overdue_after_days}) must be later than the "
            f"last reminder day ({s.reminder_days[-1]}), or that reminder could never be sent"
        )
    if s.reminder_days[-1] > s.lookback_days:
        raise ValueError(
            f"TRACKER_REMINDER_DAYS goes up to day {s.reminder_days[-1]} but "
            f"TRACKER_LOOKBACK_DAYS is {s.lookback_days} — replies wouldn't be checked that late"
        )
    return s


settings = _validate(load_settings())
