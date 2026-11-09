import React, { useMemo, useState } from 'react';
import { BellRing, UserMinus } from 'lucide-react';
import Card from './Card';
import DataTable from './DataTable';
import StatusBadge, { DayPill } from './StatusBadge';
import { PersonCell } from './Avatar';
import { Tabs, SearchInput, SelectMenu, Button } from './Controls';
import { STATUS, isOpen, stageInfo } from '../utils/status';
import { displayName, fmtDateTime } from '../utils/format';

const SORTS = {
  newest:  { label: 'Newest sent',   fn: (a, b) => new Date(b.sentAt) - new Date(a.sentAt) },
  oldest:  { label: 'Oldest sent',   fn: (a, b) => new Date(a.sentAt) - new Date(b.sentAt) },
  waiting: { label: 'Longest wait',  fn: (a, b) => b.waitingDays - a.waitingDays },
  name:    { label: 'Recipient A–Z', fn: (a, b) => displayName(a.recipient).localeCompare(displayName(b.recipient)) },
};

// Tracked-email table: one row per recipient, with the day count since
// sending, where they are in the day 1 / day 3 reminder flow, and their status.
// `tab` / `onTabChange` are controlled so the KPI cards can drive the filter.
export default function TrackerTable({ rows, stats, config, loading, tab, onTabChange, onRemind, onOpen, onOpenReminder, onStopTracking, sendingIds }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState(() => new Set());

  const lastReminderDay = config.reminder_days[config.reminder_days.length - 1];

  const tabs = [
    { key: 'all', label: 'All', count: stats.total },
    { key: STATUS.AWAITING, label: 'Awaiting', count: stats.awaiting },
    { key: STATUS.OVERDUE, label: 'Overdue', count: stats.overdue },
    { key: STATUS.REPLIED, label: 'Replied', count: stats.replied },
    { key: STATUS.NO_FOLLOWUP, label: 'No reply needed', count: stats.no_followup },
    ...(stats.stopped ? [{ key: STATUS.STOPPED, label: 'Not tracking', count: stats.stopped }] : []),
  ];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => tab === 'all' || r.status === tab)
      .filter((r) => !q
        || (r.subject || '').toLowerCase().includes(q)
        || r.recipient.email.toLowerCase().includes(q)
        || displayName(r.recipient).toLowerCase().includes(q))
      .sort(SORTS[sort].fn);
  }, [rows, tab, query, sort]);

  // Only rows with a ready AI draft can be reminded.
  const remindable = [...selected].filter((id) => {
    const r = rows.find((x) => x.id === id);
    return r && isOpen(r) && r.pendingReminder;
  });

  const columns = [
    {
      key: 'recipient',
      header: 'Recipient',
      render: (r) => (
        <PersonCell name={displayName(r.recipient)} detail={r.recipient.email} seed={r.recipient.email} size={28} />
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      className: 'trk-col-subject',
      render: (r) => (
        <span
          className="trk-subject"
          title={[r.subject, r.aiReason && `Why tracked: ${r.aiReason}`, r.aiAsk && `Asked: “${r.aiAsk}”`, r.aiNote && `AI: ${r.aiNote}`]
            .filter(Boolean).join('\n')}
        >
          {r.subject || <em className="trk-muted">(no subject)</em>}
          {r.kind === 'cc' && <span className="trk-tag">CC</span>}
        </span>
      ),
    },
    { key: 'sentAt', header: 'Sent', width: 130, render: (r) => fmtDateTime(r.sentAt) },
    {
      key: 'days',
      header: 'Days',
      width: 80,
      render: (r) => (
        <DayPill
          days={r.dayNumber}
          open={isOpen(r)}
          warnAt={lastReminderDay}
          overdueAt={config.overdue_after_days}
        />
      ),
    },
    {
      key: 'stage',
      header: 'Reminder',
      width: 130,
      render: (r) => {
        const s = stageInfo(r);
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    {
      key: 'sent',
      header: 'Sent reminders',
      width: 110,
      align: 'center',
      render: (r) => (r.remindersSent ? r.remindersSent : <span className="trk-muted">0</span>),
    },
    { key: 'status', header: 'Status', width: 130, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      width: 84,
      align: 'right',
      render: (r) => isOpen(r) && (
        <span className="trk-row-actions">
        <button
          type="button"
          className="btn-icon-only trk-row-action"
          disabled={sendingIds.has(r.id)}
          title={`Send a reminder to ${r.recipient.email}`}
          aria-label={`Send reminder to ${displayName(r.recipient)}`}
          onClick={(e) => { e.stopPropagation(); onOpenReminder(r); }}
        >
          <BellRing size={14} />
        </button>
        <button
          type="button"
          className="btn-icon-only trk-row-action trk-row-action--stop"
          disabled={sendingIds.has(r.id)}
          title={`Stop tracking ${r.recipient.email} on this email`}
          aria-label={`Stop tracking ${displayName(r.recipient)}`}
          onClick={(e) => { e.stopPropagation(); onStopTracking(r); }}
        >
          <UserMinus size={14} />
        </button>
        </span>
      ),
    },
  ];

  return (
    <Card
      title={`Sent emails · last ${config.lookback_days} days`}
      subtitle="One row per recipient · click a row to open the conversation"
      className="trk-table-card"
    >
      <div className="trk-toolbar">
        <Tabs tabs={tabs} value={tab} onChange={(k) => { onTabChange(k); setSelected(new Set()); }} />
        <div className="trk-toolbar__right">
          {remindable.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              icon={BellRing}
              onClick={() => { onRemind(remindable); setSelected(new Set()); }}
            >
              Remind {remindable.length}
            </Button>
          )}
          <SearchInput value={query} onChange={setQuery} placeholder="Search recipient or subject" />
          <SelectMenu
            label="Sort"
            value={sort}
            onChange={setSort}
            options={Object.entries(SORTS).map(([value, s]) => ({ value, label: s.label }))}
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={visible}
        loading={loading}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        onRowClick={onOpen}
        emptyMessage={
          query ? 'No emails match your search.'
            : rows.length === 0 ? 'No sent emails tracked yet. Celery fetches them every few minutes.'
              : 'No emails in this view.'
        }
      />
    </Card>
  );
}
