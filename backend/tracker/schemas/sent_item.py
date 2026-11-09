"""
The shape of one sent item as the .NET mail server returns it from
GET /api/Values/sent7days?email={mailbox}.

Validating here means a malformed item is rejected with a clear reason
instead of reaching the database half-filled. .NET usually serialises
camelCase, but PascalCase is accepted too.
"""

from datetime import datetime, timezone

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


def _alias(name: str) -> AliasChoices:
    return AliasChoices(name, name[0].upper() + name[1:])


class SentItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    message_id: str = Field(min_length=1, validation_alias=_alias("messageId"))
    thread_id: str | None = Field(default=None, validation_alias=_alias("conversationId"))
    subject: str | None = Field(default=None, validation_alias=_alias("subject"))
    body: str | None = Field(default=None, validation_alias=_alias("body"))
    sent_at: datetime = Field(validation_alias=_alias("sentAt"))
    is_reply: bool = Field(default=False, validation_alias=_alias("isReply"))
    to: list[str] = Field(default_factory=list, validation_alias=_alias("to"))
    cc: list[str] = Field(default_factory=list, validation_alias=_alias("cc"))
    # Who Exchange says has replied. None means the server did not report on
    # this item at all — which is NOT the same as "nobody replied" ([]), so
    # the difference is kept: None leaves reply status untouched.
    replied_by: list[str] | None = Field(default=None, validation_alias=_alias("repliedByAddresses"))

    @field_validator("to", "cc", mode="before")
    @classmethod
    def _none_is_empty(cls, v):
        return [] if v is None else v

    @field_validator("is_reply", mode="before")
    @classmethod
    def _none_is_false(cls, v):
        return False if v is None else v

    @field_validator("thread_id", "subject", mode="before")
    @classmethod
    def _blank_is_none(cls, v):
        return v if v is None or str(v).strip() else None

    @field_validator("sent_at")
    @classmethod
    def _assume_utc(cls, v: datetime) -> datetime:
        # The server sends UTC ("...Z"). A timestamp without an offset is
        # treated as UTC rather than as this machine's local time.
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
