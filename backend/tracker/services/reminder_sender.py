"""
Sends one reminder email through the .NET mail server.

Goes out from TRACKER_REMINDER_SENDER (reminders@hfmg.net) via the
SentAsRemainder endpoint, which sends as that mailbox using EWS
impersonation — the same route the previous tracker used. The original
email is quoted underneath so the recipient has the context.
"""

import html
from datetime import datetime

import httpx

from tracker.config import settings

_QUOTE_CHARS = 1_500


class ReminderSendError(Exception):
    """The mail server did not accept the reminder."""


def build_reminder_html(
    *,
    reminder_body: str,
    original_subject: str | None,
    original_body: str | None,
    original_sent_at: datetime,
    sender_mailbox: str,
    recipient: str,
) -> str:
    def esc(text: str) -> str:
        return html.escape(text).replace("\n", "<br/>")

    quoted = (original_body or "").strip()
    if len(quoted) > _QUOTE_CHARS:
        quoted = quoted[:_QUOTE_CHARS].rstrip() + "…"
    sent = original_sent_at.strftime("%B %d, %Y %H:%M UTC")
    return (
        f"<div>{esc(reminder_body)}</div>"
        "<br/><hr style='border:none;border-top:1px solid #ccc;margin:16px 0'/>"
        "<p style='color:#555;font-size:0.85em;margin:0 0 8px 0'>"
        "<strong>--- Original message ---</strong><br/>"
        f"<strong>From:</strong> {esc(sender_mailbox)}<br/>"
        f"<strong>To:</strong> {esc(recipient)}<br/>"
        f"<strong>Sent:</strong> {esc(sent)}<br/>"
        f"<strong>Subject:</strong> {esc(original_subject or '(no subject)')}</p>"
        f"<p style='color:#333;font-size:0.9em;margin:0'>{esc(quoted)}</p>"
    )


def send_reminder_email(*, to: str, subject: str, body_html: str) -> None:
    """Send it. Raises ReminderSendError / httpx errors on failure; never retries."""
    parts = [
        ("To", (None, to, "text/plain")),
        ("Subject", (None, subject, "text/plain")),
        ("BodyHtml", (None, body_html, "text/plain")),
        # The .NET endpoint requires FromEmail even though impersonation
        # decides the actual sender.
        ("FromEmail", (None, settings.reminder_sender, "text/plain")),
        # ...and an Attachments part even when there is nothing attached.
        ("Attachments", ("", b"", "application/octet-stream")),
    ]
    resp = httpx.post(
        f"{settings.org_base}/api/Values/mail/SentAsRemainder",
        files=parts,
        timeout=settings.http_timeout_seconds,
    )
    if resp.status_code != 200:
        raise ReminderSendError(f"HTTP {resp.status_code}: {resp.text[:200]}")
