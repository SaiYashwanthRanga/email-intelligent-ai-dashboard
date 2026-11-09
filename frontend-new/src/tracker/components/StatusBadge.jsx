import React from 'react';
import { STATUS_META } from '../utils/status';

// Pill with a leading dot. Pass a known `status`, or a raw `tone` + `label`.
export default function StatusBadge({ status, tone, label }) {
  const meta = STATUS_META[status] || {};
  const t = tone || meta.tone || 'neutral';
  return (
    <span className={`trk-badge trk-tone-${t}`}>
      <span className="trk-badge__dot" />
      {label || meta.label || status}
    </span>
  );
}

// "Day N" pill — whole calendar days since the email was sent. Colour follows
// the reminder flow: info before the last reminder day, warning from it, danger
// once overdue. Rows that are closed (replied / not needed) stay neutral.
export function DayPill({ days, open = true, warnAt = 5, overdueAt = 6 }) {
  const n = Math.max(0, days || 0);
  const tone = !open ? 'neutral' : n >= overdueAt ? 'danger' : n >= warnAt ? 'warning' : 'info';
  return <span className={`trk-pill trk-tone-${tone}`}>{n === 0 ? 'Today' : `Day ${n}`}</span>;
}
