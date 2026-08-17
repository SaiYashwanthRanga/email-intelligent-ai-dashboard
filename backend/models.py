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

# Iris — Inbox Assistant (Phase 3: grounded snapshot + tool-calling)
class IrisChatRequest(BaseModel):
    message: str
    history: List[dict] = []           # [{role: "user"|"iris", text: str}, ...]
    user_name: str = "User"            # display name — used for tone/sign-off
    user_email: str = "default"        # identifies which user's cache/tracking data tools should read
    inbox_context: Optional[dict] = None   # {stats, threads, recent_emails} — see iris_service.py