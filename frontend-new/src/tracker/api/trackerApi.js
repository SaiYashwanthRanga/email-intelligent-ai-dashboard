// Client for the backend follow-up tracker (backend/tracker/api/routes.py).
//
//   GET  /api/tracker/summary?mailbox=           counts + config (mode, reminder days)
//   GET  /api/tracker/emails?mailbox=&days=      tracked emails → recipients → reminders
//   POST /api/tracker/reminders/{id}/send        send one template reminder (manual mode)

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

async function request(path, { signal, method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    } catch { /* non-JSON error body */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const q = (params) => new URLSearchParams(params).toString();

export function fetchTrackerSummary(mailbox, { signal } = {}) {
  return request(`/tracker/summary?${q({ mailbox })}`, { signal });
}

// The latest reminder that can still be sent for this recipient (pending, or a
// failed send that can be retried) — what the Remind buttons send.
function sendableReminder(reminders) {
  return [...reminders]
    .filter((r) => r.status === 'pending' || r.status === 'failed')
    .sort((a, b) => b.stage_day - a.stage_day)[0] || null;
}

// Backend shape (one email, many recipients) → one UI row per recipient.
export function toRows(emails) {
  const rows = [];
  for (const e of emails) {
    for (const r of e.recipients) {
      const reminders = r.reminders || [];
      rows.push({
        id: r.id,                         // recipient id — unique per row
        emailId: e.id,
        messageId: e.message_id,
        threadId: e.thread_id,
        subject: e.subject,
        sentAt: e.sent_at,
        daysSinceSent: e.days_since_sent, // calendar days, fractional
        nextStageDay: e.next_stage_day,   // next reminder stage still ahead, or null
        kind: r.kind,                     // 'to' | 'cc'
        recipient: { email: r.email },
        status: r.status,                 // awaiting | replied | overdue | no_followup
        repliedAt: r.replied_detected_at,
        reminders,
        remindersSent: reminders.filter((m) => m.status === 'sent').length,
        pendingReminder: sendableReminder(reminders),
        // Why the AI decided no reminder is needed, when it did.
        aiNote: reminders.find((m) => m.status === 'skipped')?.ai_reason || null,
        // Why this person is tracked (AI) — null until the email is analysed.
        aiSummary: e.ai_summary || null,
        aiReason: r.ai_reason || null,
        aiAsk: r.ai_ask || null,
      });
    }
  }
  return rows;
}

export async function fetchTrackedEmails(mailbox, { signal, days } = {}) {
  const params = { mailbox, limit: 500 };
  if (days) params.days = days;
  const emails = await request(`/tracker/emails?${q(params)}`, { signal });
  return toRows(Array.isArray(emails) ? emails : []);
}

// Sends one reminder. `edits` may override the AI draft's subject/body.
export function sendReminder(mailbox, reminderId, edits = {}) {
  return request(`/tracker/reminders/${encodeURIComponent(reminderId)}/send`, {
    method: 'POST',
    body: { mailbox, ...edits },
  });
}

// ── Email detail + per-recipient actions ────────────────────────────────────

// One email with recipients, reminders and the live conversation thread.
export function fetchEmailDetail(mailbox, emailId, { signal } = {}) {
  return request(`/tracker/emails/${encodeURIComponent(emailId)}?${q({ mailbox })}`, { signal });
}

export function stopTracking(mailbox, recipientId) {
  return request(`/tracker/recipients/${encodeURIComponent(recipientId)}/stop`, { method: 'POST', body: { mailbox } });
}

export function resumeTracking(mailbox, recipientId) {
  return request(`/tracker/recipients/${encodeURIComponent(recipientId)}/resume`, { method: 'POST', body: { mailbox } });
}

// Draft a reminder now. No `body` → the AI writes it; with `body` → your text.
// Returns the waiting draft instead if one already exists. Does NOT send.
export function createReminderDraft(mailbox, recipientId, { subject, body } = {}) {
  return request(`/tracker/recipients/${encodeURIComponent(recipientId)}/reminders`, {
    method: 'POST',
    body: { mailbox, subject: subject || null, body: body || null },
  });
}

// Reply in the thread from the user's own mailbox, via the app's existing
// POST /api/reply-email (multipart, like the inbox reply).
export async function sendReply(mailbox, { messageId, to, cc = [], bodyText }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div>${esc(bodyText).replace(/\n/g, '<br/>')}</div>`;
  const form = new FormData();
  form.append('messageItemId', messageId);
  form.append('replyBodyHtml', html);
  to.forEach((t) => form.append('to', t));
  cc.forEach((c) => form.append('cc', c));
  form.append('targetUserEmail', mailbox);
  form.append('isReplyAll', 'false');
  const res = await fetch(`${API_BASE}/reply-email`, { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const d = await res.json(); if (d?.detail) detail = String(d.detail).slice(0, 300); } catch { /* ignore */ }
    const err = new Error(detail); err.status = res.status; throw err;
  }
  return res.json();
}

// The Day-1 / Day-3 template as it would be sent to this person now. Saves nothing.
export function fetchReminderPreview(mailbox, recipientId) {
  return request(`/tracker/recipients/${encodeURIComponent(recipientId)}/reminder-preview?${q({ mailbox })}`);
}

// Run the "why is this tracked" AI analysis now. Returns the email detail
// with ai_summary and per-recipient ai_reason / ai_ask filled in.
export function explainEmail(mailbox, emailId, { force = false } = {}) {
  return request(`/tracker/emails/${encodeURIComponent(emailId)}/explain?${q({ force })}`, {
    method: 'POST',
    body: { mailbox },
  });
}
