import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BellRing, Reply, X, Paperclip, UserMinus, UserPlus, AlertCircle, Loader2, Sparkles, RefreshCw, Quote,
} from 'lucide-react';
import Avatar from './Avatar';
import StatusBadge, { DayPill } from './StatusBadge';
import SafeEmailBody from './SafeEmailBody';
import ReminderComposer from './ReminderComposer';
import ReplyComposer from './ReplyComposer';
import { Button } from './Controls';
import { STATUS, canResume, isOpen, stageInfo } from '../utils/status';
import { displayName, fmtDateTime } from '../utils/format';

// Side drawer for one tracked email:
//   • top: Send reminder / Reply
//   • Tracking: each recipient with status + stop / resume tracking
//   • Conversation: every message in the thread, oldest first
export default function EmailDrawer({
  detail, loading, error, config, mailbox, focusRecipientId,
  explaining, explainError, onExplain,
  onClose, onStop, onResume, onPreview, onDraft, onSendReminder, onReply,
}) {
  const [composer, setComposer] = useState(null);   // 'reminder' | 'reply' | null
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState(null);

  useEffect(() => { setComposer(null); setRowError(null); }, [detail?.id]);

  // Not analysed yet → ask the AI once, as soon as the email is open.
  const [askedFor, setAskedFor] = useState(null);
  useEffect(() => {
    if (detail && !detail.ai_analyzed_at && askedFor !== detail.id) {
      setAskedFor(detail.id);
      onExplain(false);
    }
  }, [detail, askedFor, onExplain]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const recipients = useMemo(() => detail?.recipients || [], [detail]);
  const openRecipients = recipients.filter(isOpen);
  const thread = detail?.thread || [];
  const latest = thread[thread.length - 1];
  const day = Math.floor(detail?.days_since_sent || 0);
  const lastReminderDay = config.reminder_days[config.reminder_days.length - 1];

  // Rows for stageInfo(): same shape as the table rows.
  const asRow = (r) => ({
    status: r.status,
    nextStageDay: detail?.next_stage_day,
    pendingReminder: [...(r.reminders || [])]
      .filter((m) => m.status === 'pending' || m.status === 'failed')
      .sort((a, b) => b.stage_day - a.stage_day)[0] || null,
  });

  const toggle = async (r) => {
    setBusyId(r.id);
    setRowError(null);
    try {
      if (isOpen(r)) await onStop(r);
      else await onResume(r);
    } catch (err) {
      setRowError(`${r.email}: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div className="trk-portal trk-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="trk-drawer" role="dialog" aria-modal="true" aria-label={detail?.subject || 'Email'}>
        <header className="trk-drawer__head">
          <div className="trk-drawer__title">
            <h2>{detail?.subject || (loading ? 'Loading…' : '(no subject)')}</h2>
            {detail && (
              <div className="trk-drawer__meta">
                <span>Sent {fmtDateTime(detail.sent_at)}</span>
                <DayPill days={day} open={openRecipients.length > 0} warnAt={lastReminderDay} overdueAt={config.overdue_after_days} />
              </div>
            )}
          </div>
          <div className="trk-drawer__actions">
            <Button
              icon={BellRing}
              variant={composer === 'reminder' ? 'primary' : 'secondary'}
              onClick={() => setComposer((c) => (c === 'reminder' ? null : 'reminder'))}
              disabled={!detail}
            >
              Send reminder
            </Button>
            <Button
              icon={Reply}
              variant={composer === 'reply' ? 'primary' : 'secondary'}
              onClick={() => setComposer((c) => (c === 'reply' ? null : 'reply'))}
              disabled={!detail}
            >
              Reply
            </Button>
            <button type="button" className="btn-icon-only" onClick={onClose} aria-label="Close"><X size={17} /></button>
          </div>
        </header>

        <div className="trk-drawer__body">
          {error && <div className="trk-error">Couldn't load this email: {error.message}</div>}
          {loading && !detail && <div className="trk-drawer__loading"><Loader2 size={18} className="animate-spin" /> Loading conversation…</div>}

          {detail && composer === 'reminder' && (
            <ReminderComposer
              recipients={openRecipients}
              initialRecipientId={openRecipients.some((r) => r.id === focusRecipientId) ? focusRecipientId : undefined}
              onPreview={onPreview}
              onDraft={onDraft}
              onSend={async (reminder, edits) => { await onSendReminder(reminder, edits); setComposer(null); }}
              onClose={() => setComposer(null)}
            />
          )}
          {detail && composer === 'reply' && (
            <ReplyComposer
              defaultTo={openRecipients.map((r) => r.email)}
              replyingTo={latest?.from}
              onSend={async (msg) => {
                await onReply({ ...msg, messageId: latest?.message_id || detail.message_id });
                setComposer(null);
              }}
              onClose={() => setComposer(null)}
            />
          )}

          {detail && (
            <section className="trk-why">
              <header className="trk-why__head">
                <h3><Sparkles size={15} /> Why this is tracked</h3>
                {detail.ai_analyzed_at && !explaining && (
                  <button type="button" className="btn-icon-only" onClick={() => onExplain(true)} title="Ask the AI again" aria-label="Analyse again">
                    <RefreshCw size={14} />
                  </button>
                )}
              </header>
              {explaining && <p className="trk-why__text trk-muted"><Loader2 size={13} className="animate-spin" /> Reading the email…</p>}
              {!explaining && explainError && (
                <p className="trk-compose__error">
                  {explainError.message}{' '}
                  <button type="button" className="trk-link" onClick={() => onExplain(false)}>Try again</button>
                </p>
              )}
              {!explaining && detail.ai_summary && <p className="trk-why__text">{detail.ai_summary}</p>}
              {!explaining && detail.ai_analyzed_at && !detail.ai_summary && (
                <p className="trk-why__text trk-muted">The AI didn't find a specific request in this email.</p>
              )}
              {!explaining && detail.ai_analyzed_at && (
                <p className="trk-why__hint">Per-person reasons and the exact question are under each name below. Quotes are copied word for word from your email.</p>
              )}
            </section>
          )}

          {detail && (
            <section className="trk-drawer__section">
              <h3>Tracking <span className="trk-muted">· who you're waiting on</span></h3>
              {rowError && <div className="trk-compose__error">{rowError}</div>}
              <ul className="trk-recipients">
                {recipients.map((r) => {
                  const stage = stageInfo(asRow(r));
                  const sent = (r.reminders || []).filter((m) => m.status === 'sent').length;
                  const busy = busyId === r.id;
                  return (
                    <li key={r.id} className={`trk-recipient ${r.id === focusRecipientId ? 'is-focus' : ''}`}>
                      <Avatar name={displayName(r)} seed={r.email} size={30} />
                      <div className="trk-recipient__text">
                        <div className="trk-recipient__name">
                          {displayName(r)} {r.kind === 'cc' && <span className="trk-tag">CC</span>}
                        </div>
                        <div className="trk-recipient__detail">
                          {r.email} · {sent} reminder{sent === 1 ? '' : 's'} sent
                        </div>
                      </div>
                      <StatusBadge tone={stage.tone} label={stage.label} />
                      <StatusBadge status={r.status} />
                      {r.status !== STATUS.REPLIED && (isOpen(r) || canResume(r)) && (
                        <Button
                          size="sm"
                          icon={busy ? Loader2 : isOpen(r) ? UserMinus : UserPlus}
                          onClick={() => toggle(r)}
                          disabled={busy}
                          title={isOpen(r)
                            ? 'Stop tracking this person — no more reminders, never overdue'
                            : 'Track this person again'}
                        >
                          {isOpen(r) ? 'Stop tracking' : 'Track again'}
                        </Button>
                      )}
                      {(r.ai_reason || r.ai_ask) && (
                        <div className="trk-recipient__why">
                          {r.ai_reason && (
                            <div className="trk-recipient__reason">
                              <span className="trk-recipient__label">Why tracked</span> {r.ai_reason}
                              {r.ai_needs_reply === false && isOpen(r) && (
                                <span className="trk-tag trk-tag--warn" title="The AI thinks no reply is needed. It checks again on the reminder day; you can also stop tracking.">AI: probably no reply needed</span>
                              )}
                            </div>
                          )}
                          {r.ai_ask && (
                            <blockquote className="trk-recipient__ask">
                              <Quote size={12} />
                              <span>{r.ai_ask}</span>
                            </blockquote>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {detail && (
            <section className="trk-drawer__section">
              <h3>Conversation <span className="trk-muted">· {thread.length || 1} message{thread.length === 1 ? '' : 's'}</span></h3>
              {detail.thread_error && (
                <div className="trk-compose__note">
                  <AlertCircle size={14} /> Couldn't load the live conversation ({detail.thread_error}). Showing the email you sent.
                </div>
              )}
              {thread.length > 0 ? thread.map((m) => {
                const mine = (m.from || '').toLowerCase() === mailbox;
                return (
                  <article key={m.message_id || m.received} className={`trk-mail ${mine ? 'is-mine' : ''}`}>
                    <header className="trk-mail__head">
                      <Avatar name={displayName({ email: m.from })} seed={(m.from || '').toLowerCase()} size={28} />
                      <div className="trk-mail__who">
                        <div className="trk-mail__from">{mine ? 'You' : displayName({ email: m.from })} <span className="trk-muted">{m.from}</span></div>
                        <div className="trk-mail__to">
                          to {(m.to || []).join(', ') || '—'}{m.cc?.length ? ` · cc ${m.cc.join(', ')}` : ''}
                        </div>
                      </div>
                      <div className="trk-mail__date">
                        {m.has_attachments && <Paperclip size={13} />} {fmtDateTime(m.received)}
                      </div>
                    </header>
                    <SafeEmailBody body={m.body} />
                    {m.body_truncated && <div className="trk-muted trk-mail__empty">Message shortened — open it in Outlook for the full text.</div>}
                  </article>
                );
              }) : (
                <article className="trk-mail is-mine">
                  <header className="trk-mail__head">
                    <div className="trk-mail__who"><div className="trk-mail__from">You</div></div>
                    <div className="trk-mail__date">{fmtDateTime(detail.sent_at)}</div>
                  </header>
                  <SafeEmailBody body={detail.body} />
                </article>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
