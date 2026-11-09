"""
Kinds of sent email the tracker never tracks: they don't need a reply, so
reminding anyone about them would be noise.

  calendar   meeting responses ("Accepted: …", "Canceled: …") and meeting
             invites (Zoom / Teams / Meet / Webex invitation bodies)
  leave      leave and absence requests or notices
  auto       automatic replies

The mail server doesn't say whether a sent item is a meeting request, so
these rules work on the subject and the start of the body. All patterns are
case-insensitive regular expressions — add to the lists to widen a rule.
They were checked against real sent mail so that ordinary work emails (e.g.
"You've been invited to comment on an artifact", "Timely filing") stay tracked.
"""

# Subject starts with one of these + ":"  (Outlook's calendar response/notice prefixes)
CALENDAR_SUBJECT_PREFIXES = [
    r"accepted",
    r"declined",
    r"tentative",
    r"tentatively accepted",
    r"canceled",
    r"cancelled",
    r"new time proposed",
    r"meeting forward notification",
    r"updated invitation",
    r"invitation",
]

# Text in the body that only meeting invitations contain.
CALENDAR_BODY_PATTERNS = [
    r"is inviting you to a scheduled zoom meeting",
    r"join zoom meeting",
    r"zoom\.us/j/",
    r"microsoft teams meeting",
    r"teams\.microsoft\.com/l/meetup-join",
    r"join the meeting now",
    r"meet\.google\.com/",
    r"webex\.com/meet",
]

# Leave / absence, matched in the subject.
LEAVE_SUBJECT_PATTERNS = [
    r"\bleave\s*[-–:]?\s*(request|application|approval|applied)\b",
    r"\brequest(ing)?\s+(for\s+)?(a\s+)?leave\b",
    r"\b(sick|casual|annual|medical|maternity|paternity|earned|emergency|privilege|comp|compensatory)\s+leave\b",
    r"\b(one|two|three|1|2|3|half)[- ]?days?\s+leave\b",
    r"\bon\s+leave\b",
    r"\bday\s+off\b",
    r"\btime[- ]off\b",
    r"\bpto\b",
    r"\bout\s+of\s+(the\s+)?office\b",
    r"\booo\b",
    r"\bvacation\b",
]

# Leave, matched near the top of the body — only unambiguous phrases, so a
# normal email that merely mentions being out isn't skipped.
LEAVE_BODY_PATTERNS = [
    r"\bleave\s+request\b",
    r"\brequest(ing)?\s+(for\s+)?(a\s+)?leave\b",
    r"\bappl(y|ying)\s+for\s+(a\s+)?leave\b",
]

# Subject starts with one of these + ":"
AUTO_REPLY_SUBJECT_PREFIXES = [
    r"automatic reply",
    r"auto[- ]?reply",
    r"autoreply",
]

# How much of the body the body rules look at.
BODY_SCAN_CHARS = 1_500
