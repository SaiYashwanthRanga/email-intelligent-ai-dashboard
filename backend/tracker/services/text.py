"""Small text helpers shared by ingest, the AI analyser and the reminder mail."""

import html
import re

_BLOCK_TAGS = re.compile(r"<\s*(br|/p|/div|/li|/tr|/h[1-6])\b[^>]*>", re.I)
_TAGS = re.compile(r"<[^>]+>")
_STYLE_SCRIPT = re.compile(r"<(style|script)\b.*?</\1>", re.I | re.S)
_SPACES = re.compile(r"[ \t ]+")
_BLANK_LINES = re.compile(r"\n{3,}")

# Generous cap: enough for the AI and the quote, without storing megabytes.
BODY_MAX_CHARS = 20_000


def to_plain_text(body: str | None, max_chars: int = BODY_MAX_CHARS) -> str | None:
    """HTML or plain text in, readable plain text out (None if empty)."""
    if not body:
        return None
    text = body.replace("\r\n", "\n")
    if "<" in text and ">" in text:
        text = _STYLE_SCRIPT.sub(" ", text)
        text = _BLOCK_TAGS.sub("\n", text)
        text = _TAGS.sub(" ", text)
    text = html.unescape(text)
    text = _SPACES.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    text = _BLANK_LINES.sub("\n\n", text).strip()
    if not text:
        return None
    return text if len(text) <= max_chars else text[:max_chars].rstrip() + "…"


def first_name_from_address(address: str) -> str:
    """"ranga.saiyashwanth@hfmg.net" -> "Ranga"."""
    local = (address or "").split("@")[0]
    part = re.split(r"[._\-+]", local)[0] if local else ""
    return part[:1].upper() + part[1:].lower() if part else "there"


# Where a reply's quoted history starts ("____", "-----Original Message-----",
# "From: …", "On … wrote:"). Anything below it is an older message.
QUOTE_START = re.compile(
    r"_{8,}|-{3,}\s*original message\s*-{3,}|^\s*from:\s.+$|^\s*on .+wrote:\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def new_message_text(body: str | None, max_chars: int = 4_000) -> str:
    """Plain text of just what this message adds — the quoted history cut off."""
    text = to_plain_text(body, max_chars=max_chars * 4) or ""
    m = QUOTE_START.search(text)
    return (text[: m.start()] if m else text).strip()[:max_chars]
