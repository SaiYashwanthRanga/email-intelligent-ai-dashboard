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