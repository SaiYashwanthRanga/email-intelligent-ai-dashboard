"""
The fixed reminder emails. Used for every reminder — the ones the scheduler
prepares on day 1 and day 3, and the ones sent from the dashboard's
"Send reminder" button (which can still be edited before sending).

Placeholders:
    {rec_first}     recipient's first name, from their address
    {sender_first}  the mailbox owner's first name
    {topic}         the original subject with Re:/Fwd:/FW: prefixes removed

Day 5 and later have no template of their own: from day 5 the person is
shown as overdue for manual follow-up, and a reminder sent from the
dashboard then uses the Day-3 text.

The original email is quoted underneath when the reminder is sent
(see services/reminder_sender.build_reminder_html).
"""

FOOTER = (
    "──────────────────────────\n"
    "🤖 AI Assisted Reply | Horizon Family Medical Group"
)

DAY1_TEMPLATE = (
    "Hi {rec_first},\n\n"
    "Hope your week's going well! Just following up on my email about {topic} — "
    "haven't heard back yet and want to make sure it didn't slip through the cracks.\n\n"
    "Please send over an update when you can, ideally today. And if you need anything "
    "from me to move this forward, just say the word.\n\n"
    "Thanks!\n\n"
    "{sender_first}\n\n"
    + FOOTER
)

DAY3_TEMPLATE = (
    "Hi {rec_first},\n\n"
    "I've followed up on {topic} a couple of times now and still haven't heard back — "
    "I do need a response on this one.\n\n"
    "It's been three days, so please make this a priority and get back to me today. "
    "If something's come up or there's a blocker on your end, just reach out and we'll "
    "work through it together.\n\n"
    "Thanks for getting on this.\n\n"
    "{sender_first}\n\n"
    + FOOTER
)

DAY1_SUBJECT = "Quick Follow-Up – {subject}"
DAY3_SUBJECT = "Following Up Again – Response Needed | {subject}"

# Before day 3 the Day-1 template is used; from day 3 on, the Day-3 one.
DAY3_FROM_DAY = 3
