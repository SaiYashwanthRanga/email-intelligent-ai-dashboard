// Single source of truth for "is this email a meeting invite".
//
// This lived in three places that had drifted apart: the RSVP bar in
// InboxView scanned the body for six providers, the Insights INVITES tile
// looked only for "zoom.us", and the backend computed its own flag. The
// tile was the broken one — see the body note below.
//
// IMPORTANT: `email.body` is only present on emails fetched fresh this
// session. Cache-hit rows from a previous sync have had their body dropped
// to keep syncs light (see save_emails_to_id_cache in services.py), and
// carry the server-computed `isMeetingInvite` flag instead. Any check that
// reads the body alone silently reports false for every cached email, so
// its count decays toward zero the longer a session runs.

const BODY_SIGNALS = [
  "you're invited",
  "you are invited",
  "meeting request",
  "has invited you",
  "join the meeting",
  "join meeting",
  "zoom.us",
  "teams.microsoft.com",
  "meet.google.com",
  "webex.com",
];

// Replies to an invite ("Accepted: …", "Re: …") are not themselves invites.
const REPLY_PREFIX = /^(accepted|declined|tentative|re|fw|fwd|aw|tr)\s*:/i;

export function isInviteReply(email) {
  return REPLY_PREFIX.test((email?.subject || "").trim());
}

/**
 * True when this email looks like a meeting invite.
 * Prefers a live body scan when the body is available, and falls back to
 * the server-computed flag for cache-hit rows that no longer carry one.
 */
export function hasInviteSignal(email) {
  if (!email) return false;

  if (email.body) {
    const body = email.body.toLowerCase();
    if (BODY_SIGNALS.some(sig => body.includes(sig))) return true;
    return (email.attachments || []).some(a =>
      (a?.name || "").toLowerCase().endsWith(".ics")
    );
  }

  return email.isMeetingInvite === true;
}

/**
 * What the Insights "INVITES" tile counts and what the inbox INVITES
 * filter shows — deliberately the same function, so the number you click
 * and the list you land on can never disagree.
 */
export function isMeetingInvite(email) {
  const cat = (email?.category || "").toUpperCase();
  if (cat !== "MEETING" && cat !== "ZOOM") return false;
  if (isInviteReply(email)) return false;
  return hasInviteSignal(email);
}
