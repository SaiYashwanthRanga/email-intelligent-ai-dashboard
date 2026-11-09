import React from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import Avatar from './Avatar';
import StatusBadge from './StatusBadge';
import { Button } from './Controls';
import { displayName, fmtDate } from '../utils/format';

// One overdue recipient, with the emails they still owe a reply on.
// person: { recipient, rows: [...], maxWait, status }
export default function NoReplyCard({ person, onOpen, onOpenReminder, sendingIds }) {
  const name = displayName(person.recipient);
  const latest = person.rows[0];
  const extra = person.rows.length - 1;
  const ready = person.rows.filter((r) => r.pendingReminder);
  const sending = person.rows.some((r) => sendingIds.has(r.id));
  const sentCount = person.rows.reduce((n, r) => n + (r.remindersSent || 0), 0);

  // Nudge opens the reminder modal for the email with a waiting draft, else the latest.
  const target = ready[0] || latest;
  let label = 'Nudge';
  let icon = BellRing;
  const hint = `Send a reminder to ${person.recipient.email}${sentCount ? ` (${sentCount} sent so far)` : ''}`;
  if (sending) { label = 'Sending'; icon = Loader2; }
  else if (sentCount) { icon = Check; label = `Nudge · ${sentCount} sent`; }

  return (
    <article
      className="trk-noreply trk-tone-danger is-clickable"
      onClick={() => onOpen(latest)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(latest); }}
      role="button"
      tabIndex={0}
      title="Open the conversation"
    >
      <Avatar name={name} seed={person.recipient.email} size={36} />
      <div className="trk-noreply__body">
        <div className="trk-noreply__row">
          <span className="trk-noreply__name">{name}</span>
          <StatusBadge status={person.status} />
        </div>
        <div className="trk-noreply__subject" title={latest.subject || ''}>
          {latest.subject || '(no subject)'}
        </div>
        <div className="trk-noreply__meta">
          <span>Sent {fmtDate(latest.sentAt)}</span>
          <span className="trk-dot-sep" />
          <span className="trk-noreply__wait">Day {person.maxWait}</span>
          {extra > 0 && (<><span className="trk-dot-sep" /><span>+{extra} more</span></>)}
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        icon={icon}
        onClick={(e) => { e.stopPropagation(); onOpenReminder(target); }}
        disabled={sending}
        title={hint}
        aria-label={`${label} — ${name}`}
      >
        {label}
      </Button>
    </article>
  );
}
