from pydantic import BaseModel
from typing import List, Optional

class AnalysisRequest(BaseModel):
    emails: List[dict]

class ReplyRequest(BaseModel):
    email_body: str
    sender: str
    subject: str

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