// Status rules for tracked sent emails.
//
// The backend decides every status (see backend/tracker/models/sent_email.py):
//   awaiting    — no reply yet; Day-1 / Day-3 template reminders on those days
//   overdue     — still no reply on the overdue day (5 by default): manual follow-up
//   replied     — Exchange saw their reply
//   no_followup — the AI judged this email needs nothing back from them
//   stopped     — the user removed this person from tracking
// The UI only displays these; it never recomputes them.

export const STATUS = {
  REPLIED: 'replied',
  AWAITING: 'awaiting',
  OVERDUE: 'overdue',
  NO_FOLLOWUP: 'no_followup',
  STOPPED: 'stopped',
};

export const STATUS_META = {
  [STATUS.REPLIED]:     { label: 'Replied',         tone: 'success' },
  [STATUS.AWAITING]:    { label: 'Awaiting',        tone: 'info' },
  [STATUS.OVERDUE]:     { label: 'Overdue',         tone: 'danger' },
  [STATUS.NO_FOLLOWUP]: { label: 'No reply needed', tone: 'neutral' },
  [STATUS.STOPPED]:     { label: 'Not tracking',    tone: 'neutral' },
};

// Used until /tracker/summary has loaded; it always returns the real values.
export const DEFAULT_CONFIG = {
  reminder_mode: 'manual',
  reminder_days: [1, 3],
  overdue_after_days: 5,
  lookback_days: 7,
};

const OPEN = new Set([STATUS.AWAITING, STATUS.OVERDUE]);
export const isOpen = (row) => OPEN.has(row.status);
// Closed statuses the user can switch tracking back on from.
export const canResume = (row) => row.status === STATUS.NO_FOLLOWUP || row.status === STATUS.STOPPED;

// Adds computed fields the UI needs to every row.
export function enrichRows(rows) {
  return rows.map((row) => ({
    ...row,
    // Whole calendar days since sending — the same clock the reminder days use.
    dayNumber: Math.floor(row.daysSinceSent || 0),
    waitingDays: isOpen(row) ? Math.floor(row.daysSinceSent || 0) : 0,
  }));
}

export function summarize(rows) {
  const counts = { total: rows.length, replied: 0, awaiting: 0, overdue: 0, no_followup: 0, stopped: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status] += 1;
  // Reply rate over people who were actually expected to reply.
  const expected = counts.total - counts.no_followup - counts.stopped;
  counts.replyRate = expected ? Math.round((counts.replied / expected) * 100) : 0;
  counts.remindersSent = rows.reduce((n, r) => n + (r.remindersSent || 0), 0);
  counts.remindersReady = rows.filter((r) => isOpen(r) && r.pendingReminder).length;
  return counts;
}

// Groups overdue rows by recipient so one person = one card, longest wait first.
export function groupOverdue(rows) {
  const byEmail = new Map();
  for (const r of rows) {
    if (r.status !== STATUS.OVERDUE) continue;
    const key = r.recipient.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, { recipient: r.recipient, rows: [] });
    byEmail.get(key).rows.push(r);
  }
  return [...byEmail.values()]
    .map((p) => {
      const sorted = [...p.rows].sort((a, b) => b.waitingDays - a.waitingDays);
      return { ...p, rows: sorted, maxWait: sorted[0].waitingDays, status: STATUS.OVERDUE };
    })
    .sort((a, b) => b.maxWait - a.maxWait);
}

// Short description of where a row is in the day 1 / day 3 reminder flow.
export function stageInfo(row) {
  if (row.status === STATUS.REPLIED) return { label: 'Done', tone: 'success' };
  if (row.status === STATUS.NO_FOLLOWUP) return { label: 'Not needed', tone: 'neutral' };
  if (row.status === STATUS.STOPPED) return { label: 'Stopped', tone: 'neutral' };
  if (row.pendingReminder) {
    const failed = row.pendingReminder.status === 'failed';
    return {
      label: `Day ${row.pendingReminder.stage_day} ${failed ? 'send failed' : 'ready'}`,
      tone: failed ? 'danger' : 'warning',
    };
  }
  if (row.status === STATUS.OVERDUE) return { label: 'Follow up manually', tone: 'danger' };
  if (row.nextStageDay) return { label: `Next: day ${row.nextStageDay}`, tone: 'info' };
  return { label: '—', tone: 'neutral' };
}
