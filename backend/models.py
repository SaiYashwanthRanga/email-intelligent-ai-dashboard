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

# NEW: Added for secure login
class LoginRequest(BaseModel):
    username: str
    password: str