import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, MailCheck, Clock, AlertTriangle, CheckCircle2, RefreshCw, Hand, Bot } from 'lucide-react';
import ToastContainer from '../../Toast';
import useTrackedEmails from '../hooks/useTrackedEmails';
import useEmailDetail from '../hooks/useEmailDetail';
import {
  createReminderDraft, fetchReminderPreview, resumeTracking, sendReminder, sendReply, stopTracking,
} from '../api/trackerApi';
import { STATUS } from '../utils/status';
import { displayName, fmtDateTime } from '../utils/format';
import {
  KpiCard, KpiGrid, TrackerTable, NoReplyPanel, FollowUpSummary, EmailDrawer, ReminderModal, StopTrackingModal,
} from '../components';
import '../../App.css';
import '../styles/tracker.css';

const PREVIEW_CHARS = 400;

// Asks before anything is emailed. Shows the AI draft for a single reminder,
// or a list of recipients when sending several at once.
function confirmSend(targets) {
  if (targets.length === 1) {
    const { row, reminder } = targets[0];
    const body = (reminder.body || '').trim();
    return window.confirm(
      `Send this day-${reminder.stage_day} reminder to ${row.recipient.email}?\n\n`
      + `Subject: ${reminder.subject}\n\n`
      + `${body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body}`,
    );
  }
  const names = targets.slice(0, 8).map(({ row, reminder }) => `• ${displayName(row.recipient)} — day ${reminder.stage_day}: ${row.subject || '(no subject)'}`);
  if (targets.length > 8) names.push(`…and ${targets.length - 8} more`);
  return window.confirm(`Send ${targets.length} template reminders?\n\n${names.join('\n')}`);
}

export default function TrackerPage() {
  const navigate = useNavigate();
  const mailbox = (localStorage.getItem('userEmail') || '').trim().toLowerCase();
  const { rows, stats, config, loading, refreshing, error, lastLoaded, reload, patchRow } = useTrackedEmails(mailbox);

  const [tab, setTab] = useState('all');
  const [sendingIds, setSendingIds] = useState(() => new Set());
  const [toasts, setToasts] = useState([]);
  const [isScrolled, setIsScrolled] = useState(false);
  // The email open in the drawer: { emailId, recipientId } (recipient = the row clicked).
  const [opened, setOpened] = useState(null);
  const emailDetail = useEmailDetail(mailbox, opened?.emailId);
  // The row whose reminder modal is open (bell in the table, Nudge on a card).
  const [reminderFor, setReminderFor] = useState(null);
  // The row whose stop-tracking confirmation is open (stop icon in the table).
  const [stopFor, setStopFor] = useState(null);

  const addToast = useCallback((message, type = 'info') => {
    setToasts((prev) => [...prev.slice(-2), { id: Date.now() + Math.random(), message, type }]);
  }, []);
  const removeToast = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  // rowIds: recipient rows to remind. Each sends its ready AI draft.
  const handleRemind = useCallback(async (rowIds) => {
    const targets = rowIds
      .map((id) => rows.find((r) => r.id === id))
      .filter((r) => r && r.pendingReminder && !sendingIds.has(r.id))
      .map((row) => ({ row, reminder: row.pendingReminder }));
    if (!targets.length) {
      addToast('No reminder is ready to send for that yet.', 'info');
      return;
    }
    if (!confirmSend(targets)) return;

    setSendingIds((prev) => new Set([...prev, ...targets.map((t) => t.row.id)]));
    let sent = 0;
    const failures = [];
    // One at a time: these are real emails, and a mail-server problem should
    // stop being repeated against the rest of the batch.
    for (const { row, reminder } of targets) {
      try {
        const updated = await sendReminder(mailbox, reminder.id);
        sent += 1;
        patchRow(row.id, {
          remindersSent: (row.remindersSent || 0) + 1,
          pendingReminder: null,
          reminders: row.reminders.map((m) => (m.id === updated.id ? updated : m)),
        });
      } catch (err) {
        failures.push(`${row.recipient.email}: ${err.message}`);
        if (err.status === 502) break;   // mail server down — don't hammer it
      }
    }
    setSendingIds((prev) => {
      const next = new Set(prev);
      targets.forEach((t) => next.delete(t.row.id));
      return next;
    });

    if (sent) addToast(`${sent} reminder${sent === 1 ? '' : 's'} sent`, 'success');
    if (failures.length) addToast(`Couldn't send ${failures.length}: ${failures[0]}`, 'error');
    reload();
  }, [rows, sendingIds, mailbox, patchRow, addToast, reload]);

  // ── Drawer actions — each refreshes the drawer and the table afterwards ──
  const openRow = useCallback((row) => setOpened({ emailId: row.emailId, recipientId: row.id }), []);
  const closeDrawer = useCallback(() => setOpened(null), []);
  const refreshAll = useCallback(() => { emailDetail.reload(); reload(); }, [emailDetail, reload]);

  const onStop = useCallback(async (r) => {
    if (!window.confirm(`Stop tracking ${r.email} on this email? Their waiting reminders are cancelled and they won't become overdue.`)) return;
    await stopTracking(mailbox, r.id);
    addToast(`Stopped tracking ${r.email}`, 'success');
    refreshAll();
  }, [mailbox, addToast, refreshAll]);

  const onResume = useCallback(async (r) => {
    const updated = await resumeTracking(mailbox, r.id);
    addToast(`Tracking ${r.email} again (${updated.status})`, 'success');
    refreshAll();
  }, [mailbox, addToast, refreshAll]);

  const onDraft = useCallback((recipientId, text) => createReminderDraft(mailbox, recipientId, text), [mailbox]);
  const onPreview = useCallback((recipientId) => fetchReminderPreview(mailbox, recipientId), [mailbox]);
  const closeReminder = useCallback(() => setReminderFor(null), []);
  const closeStop = useCallback(() => setStopFor(null), []);
  // Confirmed in StopTrackingModal, so no window.confirm here.
  const confirmStop = useCallback(async (row) => {
    await stopTracking(mailbox, row.id);
    patchRow(row.id, { status: 'stopped', pendingReminder: null });
    addToast(`Stopped tracking ${row.recipient.email}`, 'success');
    refreshAll();
  }, [mailbox, patchRow, addToast, refreshAll]);

  const onSendReminder = useCallback(async (reminder, edits) => {
    await sendReminder(mailbox, reminder.id, edits);
    addToast('Reminder sent', 'success');
    refreshAll();
  }, [mailbox, addToast, refreshAll]);

  const onReply = useCallback(async (msg) => {
    await sendReply(mailbox, msg);
    addToast(`Reply sent to ${msg.to.join(', ')}`, 'success');
    refreshAll();
  }, [mailbox, addToast, refreshAll]);

  const kpiTab = (key) => () => setTab((cur) => (cur === key ? 'all' : key));
  const manual = config.reminder_mode === 'manual';

  return (
    <div className="app-container">
      <ToastContainer toasts={toasts} removeToast={removeToast} />
      <main
        className="main-content trk-page"
        onScroll={(e) => {
          const next = e.currentTarget.scrollTop > 8;
          if (next !== isScrolled) setIsScrolled(next);
        }}
      >
        <header className={`top-bar trk-topbar ${isScrolled ? 'is-scrolled' : ''}`}>
          <div className="top-left">
            <div className="brand" style={{ marginRight: '8px' }}>
              <img
                src="https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp"
                alt="Horizon Family Medical Group"
                style={{ height: '36px', width: 'auto', objectFit: 'contain', filter: 'brightness(1.05)', display: 'block' }}
              />
            </div>
            <button
              onClick={() => navigate('/')}
              className="menu-btn"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '600' }}
            >
              <ArrowLeft size={15} /> Dashboard
            </button>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <MailCheck size={17} style={{ color: '#00d9ff' }} />
                <span style={{ fontSize: '1rem', fontWeight: '800', letterSpacing: '-0.3px' }}>Reply Tracker</span>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Who you're still waiting to hear back from{mailbox ? ` · ${mailbox}` : ''}
                {lastLoaded && ` · updated ${fmtDateTime(lastLoaded.toISOString())}`}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              className="trk-sample"
              title={manual
                ? 'Reminders are drafted by the AI but only sent when you press send.'
                : 'Reminders are sent automatically on each reminder day.'}
            >
              {manual ? <Hand size={13} /> : <Bot size={13} />} {manual ? 'Manual reminders' : 'Automatic reminders'}
            </span>
            <button
              onClick={reload}
              disabled={refreshing}
              className="btn-gradient"
              style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: '6px', opacity: refreshing ? 0.65 : 1 }}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="trk-error">
            Couldn't load tracked emails: {error.message}
            {rows.length > 0 && ' — showing the last data loaded.'}
          </div>
        )}

        <div className="trk-layout">
          <div className="trk-main">
            <KpiGrid>
              <KpiCard
                icon={Mail}
                tone="info"
                label="Tracked"
                value={stats.total}
                caption={`Recipients · last ${config.lookback_days} days`}
                active={tab === 'all'}
                onClick={() => setTab('all')}
              />
              <KpiCard
                icon={Clock}
                tone="warning"
                label="Awaiting reply"
                value={stats.awaiting}
                caption={`Reminders on days ${config.reminder_days.join(', ')}`}
                active={tab === STATUS.AWAITING}
                onClick={kpiTab(STATUS.AWAITING)}
              />
              <KpiCard
                icon={AlertTriangle}
                tone="danger"
                label="Overdue"
                value={stats.overdue}
                caption={`No reply after ${config.overdue_after_days} days`}
                active={tab === STATUS.OVERDUE}
                onClick={kpiTab(STATUS.OVERDUE)}
              />
              <KpiCard
                icon={CheckCircle2}
                tone="success"
                label="Replied"
                value={stats.replied}
                caption={`${stats.replyRate}% reply rate`}
                active={tab === STATUS.REPLIED}
                onClick={kpiTab(STATUS.REPLIED)}
              />
            </KpiGrid>

            <TrackerTable
              rows={rows}
              stats={stats}
              config={config}
              loading={loading}
              tab={tab}
              onTabChange={setTab}
              onRemind={handleRemind}
              onOpen={openRow}
              onOpenReminder={setReminderFor}
              onStopTracking={setStopFor}
              sendingIds={sendingIds}
            />
          </div>

          <aside className="trk-side">
            <FollowUpSummary stats={stats} config={config} />
            <NoReplyPanel
              rows={rows}
              config={config}
              onOpen={openRow}
              onOpenReminder={setReminderFor}
              sendingIds={sendingIds}
              onExpand={() => setTab(STATUS.OVERDUE)}
            />
          
          </aside>
        </div>

        {opened && (
          <EmailDrawer
            detail={emailDetail.detail}
            loading={emailDetail.loading}
            error={emailDetail.error}
            config={config}
            mailbox={mailbox}
            focusRecipientId={opened.recipientId}
            explaining={emailDetail.explaining}
            explainError={emailDetail.explainError}
            onExplain={emailDetail.explain}
            onClose={closeDrawer}
            onStop={onStop}
            onResume={onResume}
            onPreview={onPreview}
            onDraft={onDraft}
            onSendReminder={onSendReminder}
            onReply={onReply}
          />
        )}

        {reminderFor && (
          <ReminderModal
            row={reminderFor}
            onPreview={onPreview}
            onDraft={onDraft}
            onSend={onSendReminder}
            onClose={closeReminder}
          />
        )}

        {stopFor && (
          <StopTrackingModal row={stopFor} onConfirm={confirmStop} onClose={closeStop} />
        )}
      </main>
    </div>
  );
}
