from pydantic import BaseModel
from typing import List, Optional

class AnalysisRequest(BaseModel):
    emails: List[dict]
    user_email: str = "default"  # identifies which user's cache to use

class ReplyRequest(BaseModel):
    email_body: str
    sender: str
    subject: str
    user_name: str = "User"  # logged-in user's display name
    category: str = ""       # email category (VIP, URGENT, NORMAL etc.) — used for tone context

class ThreadParseRequest(BaseModel):
    body: str

# Login: matches the org server payload { email, password }
class LoginRequest(BaseModel):
    email: str
    password: str

class SendEmailRequest(BaseModel):
    to: List[str]
    cc: List[str] = []
    subject: str
    bodyHtml: str

# Activity tracking — heartbeat from an active browser tab (see services.py
# record_activity_ping for the storage shape and retention policy).
class ActivityPingRequest(BaseModel):
    user_email: str
    device_id: str      # persistent per-browser id, generated client-side
    device_label: str = ""  # best-effort "OS • Browser" — see deviceIdentity.js;
                             # browsers don't expose a real device/computer name

# Iris — Inbox Assistant (Phase 3: grounded snapshot + tool-calling)
class IrisChatRequest(BaseModel):
    message: str
    history: List[dict] = []           # [{role: "user"|"iris", text: str}, ...]
    user_name: str = "User"            # display name — used for tone/sign-off
    user_email: str = "default"        # identifies which user's cache/tracking data tools should read
    inbox_context: Optional[dict] = None   # {stats, threads, recent_emails} — see iris_service.py
    # Set when the chat was opened from a specific email ("Ask Iris about
    # this"), so Iris starts already looking at it instead of having to
    # search for something the person is staring at.
    focus_message_id: Optional[str] = None