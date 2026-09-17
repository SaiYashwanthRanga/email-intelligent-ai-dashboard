import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import AnimatedModal from './AnimatedModal';
import { Eye, X, Download, Paperclip, Loader, Zap, Radar, Inbox, ClipboardCheck, Bot,
         Filter, CheckCircle2, AlertTriangle } from 'lucide-react';
import AppHeader from './AppHeader';
import ToastContainer from './Toast';
import ComposeMailModal from './ComposeMailModal';
import { HtmlEmailRenderer } from './InboxView';
import './App.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// ── HELPERS ───────────────────────────────────────────────────────────────────

function fmtDate(str) {
  if (!str) return '';
  try { return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

function getMilestones(info, sentAt, businessDays) {
  const isExternal = info.type === 'external';

  // Sub-label logic for auto-send reminders:
  //   Sent      → show the actual sent date
  //   Scheduled → scheduler will fire this automatically on next run
  //   After Day 1 → Day-3 is waiting for Day-1 to be confirmed first
  //   N/A       → external recipients never get auto-reminders
  // Someone who already replied (or was handled offline) is never getting a
  // reminder, so "Scheduled" on their row was a standing promise to chase a
  // person who had answered days ago. Sent reminders still show their date —
  // that's history, and it happened.
  const settled = !!info.replied || !!info.dismissed;

  const r1Sub = () => {
    if (info.reminder1_sent) return fmtDate(info.reminder1_sentAt);
    if (settled)             return 'Not needed';
    if (isExternal)          return 'N/A';
    if (businessDays >= 1)   return 'Scheduled';
    return 'Waiting';
  };
  const r2Sub = () => {
    if (info.reminder2_sent)                      return fmtDate(info.reminder2_sentAt);
    if (settled)                                  return 'Not needed';
    if (isExternal)                               return 'N/A';
    if (info.reminder1_sent && businessDays >= 3) return 'Scheduled';
    if (!info.reminder1_sent)                     return 'After Day 1';
    return 'Waiting';
  };

  return [
    {
      key: 'sent', label: 'Sent', sub: fmtDate(sentAt),
      done: true, active: false, skip: false,
    },
    {
      key: 'reminder1', label: 'Day 1 Reminder',
      sub:    r1Sub(),
      done:   !!info.reminder1_sent,
      active: !info.reminder1_sent && !info.replied && !isExternal && businessDays >= 1,
      skip:   isExternal,
    },
    {
      key: 'reminder2', label: 'Day 3 Reminder',
      sub:    r2Sub(),
      done:   !!info.reminder2_sent,
      active: !info.reminder2_sent && info.reminder1_sent && !info.replied && !isExternal && businessDays >= 3,
      skip:   isExternal,
    },
    {
      key:     'replied',
      label:   info.replied ? 'Replied ✓' : businessDays >= 5 ? 'Overdue' : 'Awaiting',
      sub:     info.replied ? fmtDate(info.repliedAt) : businessDays >= 5 ? `${businessDays} days` : `Day ${businessDays}`,
      done:    !!info.replied,
      active:  !info.replied && businessDays >= 5,
      overdue: !info.replied && businessDays >= 5,
      skip: false,
    },
  ];
}

// ── RECIPIENT TRACK ───────────────────────────────────────────────────────────

function RecipientTrack({ addr, info, sentAt, businessDays, onFollowUp, onDismiss, messageId, readOnly }) {
  const isReplied   = !!info.replied;
  const isDismissed = !!info.dismissed;
  const milestones  = getMilestones(info, sentAt, businessDays);

  const trackColor = isReplied   ? '#10b981'
                   : isDismissed ? '#4b5563'
                   : businessDays >= 5 ? '#ef4444'
                   : businessDays >= 3 ? '#f59e0b'
                   : '#00d9ff';

  const displayName = (info.originalAddress || addr)
    .split('@')[0].replace(/[._]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div style={{
      padding: '14px 0 10px',
      borderTop: '1px solid var(--border-color)',
      opacity: isDismissed ? 0.38 : 1,
      transition: 'opacity 0.3s',
    }}>
      {/* Recipient row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <div style={{
          width: '34px', height: '34px', borderRadius: '50%', flexShrink: 0,
          background: `${trackColor}18`, border: `1.5px solid ${trackColor}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.62rem', fontWeight: '800', color: trackColor,
          boxShadow: `0 0 8px ${trackColor}33`,
        }}>
          {isReplied ? '✓' : displayName.charAt(0)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.85rem', fontWeight: '700', color: isReplied ? '#10b981' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName}
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            {info.originalAddress || addr}
          </div>
        </div>

        {/* INT / EXT badge — matches cat-tag style from App.css */}
        <span style={{
          fontSize: '0.6rem', fontWeight: '800', letterSpacing: '0.8px',
          background: info.type === 'internal' ? 'rgba(59,130,246,0.15)' : 'rgba(245,158,11,0.15)',
          color:      info.type === 'internal' ? '#60a5fa' : '#f59e0b',
          border:     `1px solid ${info.type === 'internal' ? 'rgba(59,130,246,0.3)' : 'rgba(245,158,11,0.3)'}`,
          borderRadius: '4px', padding: '2px 6px', flexShrink: 0,
        }}>
          {info.type === 'internal' ? 'INT' : 'EXT'}
        </span>

        {!readOnly && !isReplied && !isDismissed && (
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={() => onFollowUp(addr, info)}
              className="btn-copy"
              style={{ color: trackColor, borderColor: `${trackColor}55`, background: `${trackColor}12` }}
            >
              Follow Up
            </button>
            <button
              onClick={() => onDismiss(messageId, addr)}
              className="btn-copy"
              title="Handled offline"
            >
              Dismiss
            </button>
          </div>
        )}
        {isDismissed && (
          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Handled offline</span>
        )}
      </div>

      {/* ── HORIZONTAL TIMELINE ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', paddingLeft: '2px', paddingRight: '4px' }}>
        {milestones.map((m, i) => {
          const isLast = i === milestones.length - 1;
          const nextDone = !isLast && milestones[i + 1]?.done;

          const dotColor = m.skip    ? 'rgba(255,255,255,0.08)'
                         : m.done    ? (isLast ? '#10b981' : trackColor)
                         : m.overdue ? '#ef4444'
                         : m.active  ? trackColor
                         : 'rgba(255,255,255,0.12)';

          const lineColor = m.done && !isLast
            ? `linear-gradient(90deg, ${trackColor}, ${nextDone ? trackColor : 'rgba(255,255,255,0.08)'})`
            : 'rgba(255,255,255,0.07)';

          return (
            <div key={m.key} style={{ display: 'flex', alignItems: 'flex-start', flex: isLast ? '0 0 auto' : 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '90px', maxWidth: '130px' }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '9px', width: '26px', height: '26px' }}>
                  {(m.active || m.overdue) && !m.done && (
                    <div style={{
                      position: 'absolute', width: '26px', height: '26px', borderRadius: '50%',
                      border: `1.5px solid ${dotColor}`, opacity: 0.5,
                      animation: 'trackPulse 1.8s ease-in-out infinite',
                    }} />
                  )}
                  <div style={{
                    width: '14px', height: '14px', borderRadius: '50%', position: 'relative', zIndex: 1,
                    background: m.done || m.active || m.overdue ? dotColor : 'transparent',
                    border: `2px solid ${dotColor}`,
                    boxShadow: m.done || m.active || m.overdue ? `0 0 8px ${dotColor}66` : 'none',
                    transition: 'all 0.3s',
                  }} />
                </div>
                <div style={{
                  fontSize: '0.7rem', fontWeight: m.done || m.active || m.overdue ? '700' : '400',
                  color: m.skip ? 'rgba(255,255,255,0.12)'
                       : m.done ? (isLast ? '#10b981' : 'var(--text-primary)')
                       : m.active || m.overdue ? dotColor
                       : 'var(--text-secondary)',
                  textAlign: 'center', lineHeight: '1.3', whiteSpace: 'nowrap',
                }}>
                  {m.label}
                </div>
                <div style={{
                  fontSize: '0.65rem', color: m.skip ? 'rgba(255,255,255,0.08)' : 'var(--text-muted)',
                  textAlign: 'center', marginTop: '2px', lineHeight: '1.3',
                }}>
                  {m.sub}
                </div>
              </div>

              {!isLast && (
                <div style={{
                  flex: 1, height: '3px', marginTop: '11px',
                  background: lineColor, borderRadius: '1px', minWidth: '16px',
                  position: 'relative', overflow: 'hidden',
                }}>
                  {m.done && !nextDone && (
                    <div style={{
                      position: 'absolute', top: 0, left: '-100%',
                      width: '50%', height: '100%',
                      background: `linear-gradient(90deg, transparent, ${trackColor}88, transparent)`,
                      animation: 'connectorShimmer 2.2s ease-in-out infinite',
                    }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── EMAIL TRACKING CARD ───────────────────────────────────────────────────────

function TrackingCard({ item, onFollowUp, onDismiss, defaultCollapsed, onViewEmail }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed || false);

  const bdays      = item.businessDays || 0;
  const recipients = item.recipients   || {};
  const recList    = Object.entries(recipients);

  // every() on an empty list is true, so an item that somehow has no
  // recipients would otherwise claim "✓ All replied" over a 0/0 bar.
  const allDone = recList.length > 0 && recList.every(([, i]) => i.replied || i.dismissed);
  const pending = recList.filter(([, i]) => !i.replied && !i.dismissed).length;
  const overdue = !allDone && bdays >= 5;

  const badgeColor = allDone  ? '#10b981'
                   : overdue  ? '#ef4444'
                   : bdays >= 3 ? '#f59e0b'
                   : '#00d9ff';

  const statusLabel = allDone  ? '✓ All replied'
                    : pending === 1 ? '1 awaiting reply'
                    : `${pending} awaiting reply`;

  const completedFraction = recList.length > 0
    ? recList.filter(([, i]) => i.replied).length / recList.length
    : 0;

  return (
    <div
      className="email-card"
      style={{
        // Override email-card's flex-row defaults — tracking cards are full-width blocks
        display: 'block',
        padding: 0,
        marginBottom: '14px',
        borderLeft: `3px solid ${badgeColor}`,
        opacity: allDone ? 0.72 : 1,
        contain: 'none',
        animation: 'fadeSlideUp 0.35s cubic-bezier(0.2,0,0,1) both',
      }}
    >
      {/* Header */}
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '16px 20px', cursor: 'pointer',
          background: overdue ? 'rgba(239,68,68,0.04)' : 'transparent',
          borderRadius: '12px 12px 0 0',
        }}
      >
        {/* Status icon box */}
        <div style={{
          width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
          background: `${badgeColor}18`, border: `1px solid ${badgeColor}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem',
          boxShadow: `0 0 12px ${badgeColor}22`,
        }}>
          {allDone ? '✅' : overdue ? '🔴' : '📧'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.96rem', fontWeight: '700',
            color: allDone ? '#10b981' : 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '5px',
          }}>
            {item.subject || '(no subject)'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              Sent {fmtDate(item.sentAt)}
            </span>
            {/* Status badge — matches cat-tag style */}
            <span style={{
              fontSize: '0.65rem', fontWeight: '700', color: badgeColor,
              background: `${badgeColor}14`, border: `1px solid ${badgeColor}30`,
              borderRadius: '6px', padding: '2px 8px', letterSpacing: '0.3px',
            }}>
              {statusLabel}
            </span>
            {!allDone && (
              <span style={{ fontSize: '0.65rem', color: overdue ? '#f87171' : 'var(--text-muted)' }}>
                {bdays} business day{bdays !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Mini progress bar */}
        <div style={{ width: '88px', flexShrink: 0 }}>
          <div style={{ height: '4px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: '2px',
              width: `${Math.max(completedFraction * 100, allDone ? 100 : 0)}%`,
              background: allDone ? '#10b981' : `linear-gradient(90deg, ${badgeColor}, ${badgeColor}88)`,
              transition: 'width 0.5s ease',
              boxShadow: `0 0 6px ${badgeColor}66`,
            }} />
          </div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'right', marginTop: '4px' }}>
            {recList.filter(([, i]) => i.replied).length}/{recList.length} replied
          </div>
        </div>

        {/* View Email */}
        <button
          onClick={e => { e.stopPropagation(); onViewEmail && onViewEmail(item.messageId, item.subject); }}
          className="btn-copy"
          style={{ color: '#60a5fa', borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, whiteSpace: 'nowrap' }}
          title="View email body"
        >
          <Eye size={13} /> View
        </button>

        <div style={{
          fontSize: '0.65rem', color: 'var(--text-muted)',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s', flexShrink: 0, marginLeft: '2px',
        }}>▼</div>
      </div>

      {/* Recipient tracks */}
      {!collapsed && (
        <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--border-color)' }}>
          {recList.map(([addr, info]) => (
            <RecipientTrack
              key={addr}
              addr={addr}
              info={info}
              sentAt={item.sentAt}
              businessDays={bdays}
              messageId={item.messageId}
              onFollowUp={(a, i) => onFollowUp(item, a, i)}
              onDismiss={onDismiss}
              readOnly={allDone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function TrackingView() {
  const userEmail = localStorage.getItem('userEmail') || '';

  const [trackingData,    setTrackingData]    = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [syncing,         setSyncing]         = useState(false);
  // The scan's own progress record, straight from /tracking/sync-status.
  const [syncProgress,    setSyncProgress]    = useState(null);

  // Hoisted so both the Sent tab cards and the modal footer can access it
  const trackedIds = new Set((trackingData?.tracked || []).map(t => t.messageId));
  // These used to be five canned messages on a five-second timer, unconnected
  // to the scan — so a slow scan showed "Almost there..." for a minute while a
  // fast one flashed phases it had already finished. The backend now reports
  // where it actually is; this only maps that to an icon and a colour.
  const SYNC_PHASE_META = {
    queued:          { Icon: Loader,        color: '#00d9ff' },
    starting:        { Icon: Loader,        color: '#00d9ff' },
    fetching_sent:   { Icon: Inbox,         color: '#00d9ff' },
    sorting:         { Icon: Filter,        color: '#f59e0b' },
    reading_threads: { Icon: Bot,           color: '#a855f7' },
    done:            { Icon: CheckCircle2,  color: '#22c55e' },
    error:           { Icon: AlertTriangle, color: '#ef4444' },
  };
  // Ordered for the step dots; 'queued'/'starting' collapse into the first.
  const SYNC_PHASE_ORDER = ['fetching_sent', 'sorting', 'reading_threads', 'done'];

  const [followUpCompose, setFollowUpCompose] = useState(null);
  const [emailModal,      setEmailModal]      = useState(null);
  const [modalFetchErr,   setModalFetchErr]   = useState(null);
  const [activeTab,       setActiveTab]       = useState('sent');
  const [skippedData,     setSkippedData]     = useState([]);
  const [skippedLoading,  setSkippedLoading]  = useState(false);
  const [trackingApprovals,    setTrackingApprovals]    = useState([]);
  const [approvalsLoading,     setApprovalsLoading]     = useState(false);
  const [approvalActioning,    setApprovalActioning]    = useState({});
  const [restoring,       setRestoring]       = useState({});
  const [sentEmails,      setSentEmails]      = useState([]);
  const [sentLoading,     setSentLoading]     = useState(false);
  const [sentVisible,     setSentVisible]     = useState(60);   // how many rows to show at once
  const sentEmailsLoadedRef  = useRef(false);  // true after first successful fetch — prevents re-fetch on tab switch
  const mountedRef           = useRef(true);   // false after unmount — guards setState in async callbacks
  const syncIntervalsRef     = useRef([]);     // all setInterval IDs created by syncNow — cleared on unmount
  const [addingTrack,     setAddingTrack]     = useState({});
  const [threadAnalysis,  setThreadAnalysis]  = useState({});   // messageId → analysis result
  const [analyzingThread, setAnalyzingThread] = useState({});   // messageId → bool
  const [toasts,          setToasts]          = useState([]);

  // Smart toast — deduplicates, bumps count, caps at 3 visible.
  // Ids come from a counter, not Date.now(): two toasts raised in the same
  // millisecond got identical ids, which collides React keys and makes
  // removeToast dismiss both at once.
  const toastSeq = useRef(0);
  const nextToastId = () => (toastSeq.current += 1);

  const addToast = (message, type = 'info') => {
    setToasts(prev => {
      const existing = prev.find(t => t.message === message && t.type === type);
      if (existing) {
        return prev.map(t =>
          t.id === existing.id ? { ...t, id: nextToastId(), count: (t.count || 1) + 1 } : t
        );
      }
      const newToast = { id: nextToastId(), message, type, count: 1 };
      const trimmed = prev.length >= 3 ? prev.slice(-2) : prev;
      return [...trimmed, newToast];
    });
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  // ── Unmount guard — clears any running sync intervals so navigating away
  //    mid-sync doesn't leave orphaned timers calling setState on a dead component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      syncIntervalsRef.current.forEach(id => clearInterval(id));
      syncIntervalsRef.current = [];
    };
  }, []);

  const restoreToTracking = async (messageId) => {
    setRestoring(r => ({ ...r, [messageId]: true }));
    addToast('Moving to active tracking...', 'loading');
    try {
      const fd = new FormData();
      fd.append('user_email', userEmail);
      fd.append('message_id', messageId);
      const res = await fetch(`${API_BASE}/tracking/restore`, { method: 'POST', body: fd });
      if (res.ok) {
        setSkippedData(prev => prev.filter(e => e.messageId !== messageId));
        await fetchTrackingInner();
        await fetchPending();
        addToast('📡 Moved to active tracking!', 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        addToast(err.detail || 'Failed to move to tracking.', 'error');
      }
    } catch (e) {
      console.error('restoreToTracking error:', e);
      addToast('Network error — could not restore.', 'error');
    } finally {
      setRestoring(r => ({ ...r, [messageId]: false }));
    }
  };

  const openEmailModal = useCallback(async (messageId, subject) => {
    if (!messageId) return;
    setEmailModal({ loading: true, email: null, subject });
    setModalFetchErr(null);
    try {
      const res = await fetch(
        `${API_BASE}/email-details?messageId=${encodeURIComponent(messageId)}&userEmail=${encodeURIComponent(userEmail)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEmailModal({ loading: false, email: data, subject });
    } catch (err) {
      console.error('openEmailModal error:', err);
      setModalFetchErr('Could not load email. Please try again.');
      setEmailModal({ loading: false, email: null, subject });
    }
  }, [userEmail]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const syncNow = useCallback(async () => {
    if (syncing) return;

    // Helper — drops the call silently if the component unmounted mid-sync
    const safeSet = (fn) => { if (mountedRef.current) fn(); };

    safeSet(() => {
      setSyncing(true);
      setSyncProgress({
        state: 'running', phase: 'queued', label: 'Starting sync',
        detail: '', done: 0, total: 0, queued: 0, skipped: 0,
      });
    });

    const refreshLists = async () => {
      try {
        await fetchTrackingInner();
        await fetchPending();
        await fetchSkipped();
      } catch (_) { /* transient — the next poll retries */ }
    };

    try {
      // Backend returns immediately and runs the scan as a background task.
      await fetch(`${API_BASE}/tracking/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail }),
      });

      // Follow the scan's own progress record. Completion used to be guessed
      // by watching /tracking's lastUpdated go quiet for six seconds, which a
      // thread-reading scan trips over constantly — a single conversation can
      // take longer than that, so the page declared victory mid-scan.
      const finalState = await new Promise((resolve) => {
        const POLL_MS    = 1000;
        const STALL_MS   = 90000;   // no movement at all → assume it died
        let   lastStamp  = null;
        let   stalledFor = 0;
        let   tick       = 0;

        const poll = setInterval(async () => {
          if (!mountedRef.current) { clearInterval(poll); resolve(null); return; }
          try {
            const res = await fetch(
              `${API_BASE}/tracking/sync-status?user_email=${encodeURIComponent(userEmail)}`
            );
            if (res.ok) {
              const p = await res.json();
              safeSet(() => setSyncProgress(p));

              // Let cards land while the scan is still going.
              if (++tick % 3 === 0) await refreshLists();

              if (p.state === 'done' || p.state === 'error') {
                clearInterval(poll);
                resolve(p);
                return;
              }
              stalledFor = p.updatedAt === lastStamp ? stalledFor + POLL_MS : 0;
              lastStamp  = p.updatedAt;
            } else {
              stalledFor += POLL_MS;
            }
          } catch (_) {
            stalledFor += POLL_MS;
          }
          if (stalledFor >= STALL_MS) { clearInterval(poll); resolve(null); }
        }, POLL_MS);

        syncIntervalsRef.current = [...syncIntervalsRef.current, poll];
      });

      syncIntervalsRef.current = [];
      if (!mountedRef.current) return;

      await refreshLists();

      if (finalState && finalState.state === 'error') {
        addToast(`Sync failed: ${finalState.detail || 'unknown error'}`, 'error');
      } else if (finalState) {
        const found = finalState.queued || 0;
        addToast(
          found > 0
            ? `Sync complete — ${found} email${found === 1 ? '' : 's'} need review`
            : 'Sync complete — nothing new to follow up',
          'success'
        );
      } else {
        // Stalled or unmounted: say so rather than claiming success.
        addToast('Sync is taking longer than expected — still running in the background.', 'info');
      }

      setTimeout(() => { safeSet(() => { setSyncProgress(null); setSyncing(false); }); }, 1800);

    } catch (e) {
      syncIntervalsRef.current = [];
      if (!mountedRef.current) return;
      console.error('syncNow error:', e);
      safeSet(() => setSyncProgress({
        state: 'error', phase: 'error', label: 'Sync failed',
        detail: 'Could not reach the server.', done: 0, total: 0, queued: 0, skipped: 0,
      }));
      addToast('Sync failed. Please try again.', 'error');
      setTimeout(() => { safeSet(() => { setSyncProgress(null); setSyncing(false); }); }, 2500);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail, syncing, activeTab]);

  const fetchTrackingInner = useCallback(async () => {
    if (!userEmail) return;
    try {
      const res = await fetch(`${API_BASE}/tracking?user_email=${encodeURIComponent(userEmail)}`);
      if (res.ok) {
        const data = await res.json();
        setTrackingData(data);
        return data;
      }
    } catch (e) { console.error('fetchTracking error:', e); }
    return null;
  }, [userEmail]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchTracking = useCallback(async () => {
    setLoading(true);
    const data = await fetchTrackingInner();
    if (data && !data.lastUpdated) syncNow();
    setLoading(false);
  }, [userEmail]);

  useEffect(() => { fetchTracking(); }, [fetchTracking]);

  // ── Real-time staleness prevention ───────────────────────────────────────
  // 1. Background poll every 60s so scheduler-driven changes (reply detected,
  //    email resolved) surface without the user having to perform an action.
  // 2. Refetch immediately when the browser tab regains visibility — covers
  //    the case where the user was away for a while.
  // 3. Refetch on window focus — covers switching between apps.
  useEffect(() => {
    const poll = setInterval(() => {
      fetchTrackingInner();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchTrackingInner();
    };
    const onFocus = () => fetchTrackingInner();

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchTrackingInner]);

  const fetchSkipped = useCallback(async () => {
    if (!userEmail) return;
    setSkippedLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tracking/skipped?user_email=${encodeURIComponent(userEmail)}`);
      if (res.ok) { const data = await res.json(); setSkippedData(data.skipped || []); }
    } catch (e) { console.error('fetchSkipped error:', e); }
    finally { setSkippedLoading(false); }
  }, [userEmail]);

  // Only AI tracking decisions now. The reminder-draft queue this also used to
  // fetch was retired when Day-1/Day-3 reminders moved to auto-send — nothing
  // has written pending_reminders since, so it could only ever return [].
  const fetchPending = useCallback(async () => {
    if (!userEmail) return;
    setApprovalsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tracking/pending-tracking?user_email=${encodeURIComponent(userEmail)}`);
      if (res.ok) {
        const data = await res.json();
        setTrackingApprovals(data.approvals || []);
      }
    } catch (e) { console.error('fetchPending error:', e); }
    finally { setApprovalsLoading(false); }
  }, [userEmail]);

  useEffect(() => {
    if (activeTab === 'skipped') fetchSkipped();
    if (activeTab === 'pending') fetchPending();
    if (activeTab === 'sent' && !sentEmailsLoadedRef.current) {
      sentEmailsLoadedRef.current = true;   // mark as fetched so revisiting the tab reuses data
      setSentVisible(60);
      fetchSentEmails();
      fetchSkipped();   // needed to show AI Skipped badge on sent cards
      fetchPending();   // needed to show Needs Review badge on sent cards
    }
  }, [activeTab, fetchSkipped, fetchPending]);

  const fetchSentEmails = useCallback(async () => {
    if (!userEmail) return;
    setSentLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sent-emails?user_email=${encodeURIComponent(userEmail)}`);
      if (res.ok) {
        const data = await res.json();
        // Sort newest first — same as Outlook Sent Items view.
        // sentAt comes directly from Exchange (EWS DateTimeSent).
        data.sort((a, b) => {
          try { return new Date(b.sentAt || 0) - new Date(a.sentAt || 0); }
          catch { return 0; }
        });
        setSentEmails(data);
      }
    } catch (e) { console.error('fetchSentEmails error:', e); }
    finally { setSentLoading(false); }
  }, [userEmail]);

  const analyzeThread = async (email) => {
    const mid = email.messageId;
    setAnalyzingThread(a => ({ ...a, [mid]: true }));
    try {
      const res = await fetch(`${API_BASE}/analyze-sent-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_email:           userEmail,
          messageId:            mid,
          subject:              email.subject || '',
          notRepliedAddresses:  email.notRepliedAddresses || [],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setThreadAnalysis(prev => ({ ...prev, [mid]: data }));
    } catch (e) {
      console.error('analyzeThread error:', e);
      addToast('AI analysis failed — please try again.', 'error');
    } finally {
      setAnalyzingThread(a => ({ ...a, [mid]: false }));
    }
  };

  const addToTracking = async (email) => {
    const mid = email.messageId;

    // Derive who still needs follow-up from EWS-computed reply data.
    // notRepliedAddresses = people who have NOT replied yet (from .NET EWS matching).
    // If the list is empty and hasPendingReplies is false, everyone has replied —
    // no point starting tracking.
    const notReplied = email.notRepliedAddresses || [];
    const allReplied = (email.to || []).length > 0 && !email.hasPendingReplies;
    if (allReplied) {
      addToast('All recipients have already replied — nothing to track.', 'info');
      return;
    }

    setAddingTrack(a => ({ ...a, [mid]: true }));
    const pendingCount = notReplied.length;
    addToast(
      `Adding "${email.subject?.slice(0, 40) || 'email'}" to tracking` +
      (pendingCount > 0 ? ` (${pendingCount} awaiting reply)` : '') + '...',
      'loading'
    );

    try {
      const res = await fetch(`${API_BASE}/tracking/add-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_email:           userEmail,
          messageId:            email.messageId,
          conversationId:       email.conversationId,
          subject:              email.subject,
          sentAt:               email.sentAt,
          to:                   email.to,
          cc:                   email.cc,
          body:                 email.body,
          // EWS-computed reply status — backend uses these to set replied:true/false
          // correctly so reminders only go to people who genuinely haven't replied.
          notRepliedAddresses:  email.notRepliedAddresses  ?? null,
          repliedByAddresses:   Array.isArray(email.repliedByAddresses)
                                  ? email.repliedByAddresses
                                  : [],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.ok) {
          // Backend returned a soft error (e.g. already tracked, all replied)
          addToast(data.detail || 'Could not add to tracking.', 'info');
          return;
        }
        await fetchSentEmails();
        await fetchTrackingInner();
        const reminderNote = data.reminders_sent?.length
          ? ` · ${data.reminders_sent.length} reminder(s) sent`
          : '';
        const pendingNote  = data.pending_count > 0
          ? ` — ${data.pending_count} recipient${data.pending_count > 1 ? 's' : ''} awaiting reply`
          : '';
        addToast(`📡 Now tracking "${email.subject?.slice(0, 35) || 'email'}"${pendingNote}${reminderNote}`, 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        addToast(err.detail || 'Could not add to tracking.', 'error');
      }
    } catch (e) {
      console.error('addToTracking error:', e);
      addToast('Network error — could not add to tracking.', 'error');
    } finally { setAddingTrack(a => ({ ...a, [mid]: false })); }
  };

  // ── Tracking decision approval handlers ──────────────────────────────────
  const approveTrackingDecision = async (approvalId) => {
    setApprovalActioning(a => ({ ...a, [approvalId]: 'approving' }));
    addToast('Starting tracking...', 'loading');
    try {
      const fd = new FormData();
      fd.append('user_email',  userEmail);
      fd.append('approval_id', approvalId);
      const res = await fetch(`${API_BASE}/tracking/pending-tracking/approve`, { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setTrackingApprovals(p => p.filter(a => a.id !== approvalId));
        await fetchTrackingInner();
        const reminderNote = data.reminders_sent?.length
          ? ` · ${data.reminders_sent.length} reminder(s) sent immediately`
          : '';
        addToast(`📡 Now tracking: "${data.subject?.slice(0, 35) || 'email'}"${reminderNote}`, 'success');
      } else {
        addToast('Failed to approve. Please try again.', 'error');
      }
    } catch (e) {
      console.error('approveTrackingDecision error:', e);
      addToast('Network error — approval failed.', 'error');
    }
    finally { setApprovalActioning(a => ({ ...a, [approvalId]: null })); }
  };

  const dismissTrackingDecision = async (approvalId) => {
    setApprovalActioning(a => ({ ...a, [approvalId]: 'dismissing' }));
    try {
      const fd = new FormData();
      fd.append('user_email',  userEmail);
      fd.append('approval_id', approvalId);
      const res = await fetch(`${API_BASE}/tracking/pending-tracking/dismiss`, { method: 'POST', body: fd });
      if (res.ok) {
        setTrackingApprovals(p => p.filter(a => a.id !== approvalId));
        if (activeTab === 'skipped') await fetchSkipped();
        addToast('Dismissed — moved to AI Skipped.', 'info');
      } else {
        addToast('Failed to dismiss. Please try again.', 'error');
      }
    } catch (e) {
      console.error('dismissTrackingDecision error:', e);
      addToast('Network error — dismiss failed.', 'error');
    }
    finally { setApprovalActioning(a => ({ ...a, [approvalId]: null })); }
  };


  const dismissRecipient = async (messageId, recipientEmail) => {
    try {
      const res = await fetch(`${API_BASE}/tracking/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, message_id: messageId, recipient_email: recipientEmail }),
      });
      if (res.ok) {
        setTrackingData(prev => {
          if (!prev) return prev;
          const patch = list => list.map(item => {
            if (item.messageId !== messageId) return item;
            const r = { ...item.recipients };
            if (r[recipientEmail]) r[recipientEmail] = { ...r[recipientEmail], dismissed: true };
            return { ...item, recipients: r };
          });
          return { ...prev, awaiting: patch(prev.awaiting || []), reminders_sent: patch(prev.reminders_sent || []) };
        });
        addToast('Marked as handled offline.', 'info');
      } else {
        addToast('Failed to dismiss recipient.', 'error');
      }
    } catch (e) {
      console.error('dismiss error:', e);
      addToast('Network error — could not dismiss.', 'error');
    }
  };

  const isFollowUp = item => /^(quick follow-up\s*[–\-]|following up again\s*[\|–\-]|following up:)/i.test(item.subject || '');

  // Sort by sentAt descending — newest email on top, oldest at bottom (Outlook style).
  // sentAt is populated from Exchange (EWS) when the email is added to tracking.
  const sortByDateDesc = (a, b) => {
    try { return new Date(b.sentAt || 0) - new Date(a.sentAt || 0); }
    catch { return 0; }
  };

  const allItems = (() => {
    if (!trackingData) return [];

    // No "unbucketed" pass any more. It existed to catch tracked emails the
    // backend hadn't bucketed yet, but get_tracking_summary buckets every
    // tracked item on every call, so it never matched anything real — and
    // once `tracked` started arriving it would have matched the resolved
    // items trimmed off by the backend's 20-item cap and rendered them as
    // active, with no recipients, reading "✓ All replied · 0/0".
    const active = [...(trackingData.awaiting || []), ...(trackingData.reminders_sent || [])]
      .filter(i => !isFollowUp(i));
    const resolved = (trackingData.resolved || []).filter(i => !isFollowUp(i));
    return [
      ...active.sort(sortByDateDesc),
      ...resolved.sort(sortByDateDesc),
    ];
  })();

  // What the Needs Review tab actually holds: AI tracking decisions awaiting
  // your approval.
  const needsReviewTotal = trackingApprovals.length;

  const resolvedIds  = new Set((trackingData?.resolved || []).map(i => i.messageId));
  const pendingTotal = allItems.filter(i => !resolvedIds.has(i.messageId) &&
    Object.values(i.recipients || {}).some(r => !r.replied && !r.dismissed)
  ).length;

  // ── EMPTY STATE COMPONENT ──────────────────────────────────────────────────
  const EmptyState = ({ icon, title, subtitle }) => (
    <div className="empty-placeholder" style={{ marginTop: '20px', padding: '60px 40px' }}>
      <div style={{ fontSize: '2.4rem', marginBottom: '14px' }}>{icon}</div>
      <div style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>{title}</div>
      <div style={{ fontSize: '0.82rem', lineHeight: '1.7' }}>{subtitle}</div>
    </div>
  );

  // ── LOADING STATE ──────────────────────────────────────────────────────────
  const LoadingState = ({ icon }) => (
    <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-secondary)' }}>
      <div style={{ fontSize: '2.2rem', marginBottom: '12px', display: 'inline-block', animation: 'pulse 1.5s ease-in-out infinite' }}>{icon}</div>
      <div className="loading-text">Loading...</div>
    </div>
  );

  return (
    <div className="app-container">
      {/* ── Tracking-specific keyframes only (not in animations.css) ── */}
      <style>{`
        @keyframes trackPulse {
          0%,100% { transform: scale(1); opacity: 0.5; }
          50%      { transform: scale(1.7); opacity: 0.12; }
        }
        @keyframes connectorShimmer {
          0%   { left: -80%; }
          100% { left: 180%; }
        }
      `}</style>

      <ToastContainer toasts={toasts} removeToast={removeToast} />
      <main className="main-content">

        {/* ── TOP BAR — matches dashboard exactly ────────────────────── */}
        <AppHeader
          active="TRACKING"
          canUseTracking
          titleIcon={<Radar size={17} style={{ color: '#00d9ff' }} />}
          title={
            <>
              Follow-Up Tracker
              {pendingTotal > 0 && (
                <span style={{
                  background: 'rgba(239,68,68,0.15)', color: '#f87171',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: '999px', padding: '2px 8px',
                  fontSize: '0.65rem', fontWeight: '800',
                }}>
                  {pendingTotal} pending
                </span>
              )}
            </>
          }
          subtitle={
            <>
              {allItems.length} tracked email{allItems.length !== 1 ? 's' : ''}
              {trackingData?.lastUpdated && (
                <> · Updated {new Date(trackingData.lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</>
              )}
            </>
          }
          actions={
            <button
              onClick={syncNow}
              disabled={syncing}
              className="btn-gradient"
              style={{
                width: 'auto', padding: '9px 20px', marginRight: '15px',
                display: 'flex', alignItems: 'center', gap: '7px',
                fontSize: '0.84rem', fontWeight: '700',
                opacity: syncing ? 0.65 : 1,
                cursor: syncing ? 'not-allowed' : 'pointer',
              }}
            >
              {syncing
                ? <><Loader size={15} className="animate-spin" /> Syncing…</>
                : <><Zap size={15} /> Sync Now</>
              }
            </button>
          }
        />

        {/* ── TAB BAR — matches inbox tabs-container ──────────────────── */}
        <div className="tabs-container" style={{ marginBottom: '4px' }}>
          {[
            { id: 'sent',     Icon: Inbox,          label: 'Sent Items',      count: sentEmails.length > 0 ? sentEmails.length : null },
            // Both lists render inside this tab, so the badge has to count
            // both. Counting only the approvals meant a tab holding three
            // reminder drafts and no approvals showed no badge at all.
            { id: 'pending',  Icon: ClipboardCheck, label: 'Needs Review',    count: needsReviewTotal > 0 ? needsReviewTotal : null },
            { id: 'tracking', Icon: Radar,          label: 'Active Tracking', count: pendingTotal > 0 ? pendingTotal : null },
            { id: 'skipped',  Icon: Bot,            label: 'AI Skipped',      count: skippedData.length > 0 ? skippedData.length : null },
          ].map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.Icon size={15} style={{ verticalAlign: '-2px', marginRight: '6px' }} />{tab.label}
              {tab.count != null && (
                <span className={`count-badge ${activeTab === tab.id ? 'active' : ''}`}
                  style={tab.id === 'tracking' && pendingTotal > 0 ? { background: '#ef4444', color: 'white', border: 'none' } : {}}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── LEGEND — compact, matches the triage sub-row style ─────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '16px',
          padding: '10px 0 20px', fontSize: '0.68rem', color: 'var(--text-secondary)',
          flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)',
          marginBottom: '24px',
        }}>
          <span style={{ fontWeight: '800', color: 'var(--text-muted)', letterSpacing: '1px', textTransform: 'uppercase', fontSize: '0.62rem' }}>Legend</span>
          {[
            { color: '#00d9ff', label: 'Tracking active' },
            { color: '#f59e0b', label: 'Attention needed' },
            { color: '#ef4444', label: 'Overdue Day 5+' },
            { color: '#10b981', label: 'Replied' },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 5px ${color}88` }} />
              <span>{label}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '22px', height: '2px', background: 'linear-gradient(90deg, #00d9ff, rgba(255,255,255,0.08))', borderRadius: '1px' }} />
            <span>In progress</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '22px', height: '2px', background: '#00d9ff', borderRadius: '1px' }} />
            <span>Completed</span>
          </div>
        </div>

        {/* ── SYNC PROGRESS BANNER — compact strip, cards visible below ── */}
        {syncing && syncProgress && (() => {
          const meta  = SYNC_PHASE_META[syncProgress.phase] || SYNC_PHASE_META.starting;
          const Icon  = meta.Icon;
          const color = meta.color;
          const total = syncProgress.total || 0;
          const done  = syncProgress.done  || 0;

          // Real fraction once there are threads to count; before that the bar
          // reflects which phase we are in, so it never sits still lying.
          const phaseIdx = SYNC_PHASE_ORDER.indexOf(syncProgress.phase);
          const pct = syncProgress.state === 'done'
            ? 100
            : total > 0
              ? Math.round((done / total) * 100)
              : Math.max(6, ((phaseIdx < 0 ? 0 : phaseIdx) / SYNC_PHASE_ORDER.length) * 100);

          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '14px',
              padding: '14px 20px', marginBottom: '20px', borderRadius: '12px',
              background: `${color}0d`,
              border: `1px solid ${color}30`,
              animation: 'fadeSlideUp 0.3s cubic-bezier(0.2,0,0,1) both',
            }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
                background: `${color}15`, border: `1px solid ${color}30`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color,
                animation: syncProgress.state === 'running' ? 'trackPulse 1.2s ease-in-out infinite' : 'none',
              }}>
                <Icon size={19} className={syncProgress.phase === 'queued' ? 'animate-spin' : ''} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: '10px',
                  marginBottom: '7px', flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: '0.86rem', fontWeight: '700', color, transition: 'color 0.4s' }}>
                    {syncProgress.label || 'Working…'}
                  </span>
                  {total > 0 && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {done} / {total}
                    </span>
                  )}
                  {syncProgress.detail && (
                    <span style={{
                      fontSize: '0.72rem', color: 'var(--text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      minWidth: 0, flex: 1,
                    }}>
                      {syncProgress.detail}
                    </span>
                  )}
                </div>

                <div style={{ height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: '2px',
                    background: `linear-gradient(90deg, ${color}66, ${color})`,
                    width: `${Math.min(pct, 100)}%`,
                    transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1), background 0.4s',
                    boxShadow: `0 0 8px ${color}55`,
                  }} />
                </div>
              </div>

              {/* Running tally — what the scan has actually decided so far */}
              <div style={{ display: 'flex', gap: '14px', flexShrink: 0, alignItems: 'center' }}>
                {[
                  { n: syncProgress.queued  || 0, label: 'to review', c: '#f59e0b' },
                  { n: syncProgress.skipped || 0, label: 'skipped',   c: 'var(--text-muted)' },
                ].map(stat => (
                  <div key={stat.label} style={{ textAlign: 'center', minWidth: '52px' }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: '800', color: stat.c, fontVariantNumeric: 'tabular-nums' }}>
                      {stat.n}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px' }}>
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                {SYNC_PHASE_ORDER.map((ph, i) => (
                  <div key={ph} title={ph.replace(/_/g, ' ')} style={{
                    width: ph === syncProgress.phase ? '16px' : '6px',
                    height: '6px', borderRadius: '3px',
                    background: i <= phaseIdx ? color : 'rgba(255,255,255,0.12)',
                    transition: 'all 0.4s cubic-bezier(0.4,0,0.2,1)',
                    boxShadow: ph === syncProgress.phase ? `0 0 6px ${color}88` : 'none',
                  }} />
                ))}
              </div>
            </div>
          );
        })()}

        {/* ── TAB CONTENT — always visible, updates live during sync ─── */}
        {true && (
          <>

          {/* ── TRACKING TAB ─────────────────────────────────────────── */}
          {activeTab === 'tracking' && (
            loading ? <LoadingState icon="📡" /> :
            allItems.length === 0 ? (
              <EmptyState
                icon="📭"
                title="Nothing to track"
                subtitle={<>New outbound emails appear here automatically.<br />Click <strong>Sync Now</strong> to check your sent items.</>}
              />
            ) : (
              <div className="email-feed">
                {allItems.map(item => (
                  <TrackingCard
                    key={item.messageId}
                    item={item}
                    onDismiss={dismissRecipient}
                    onFollowUp={async (it, addr, info) => {
                      // Open compose immediately with what we have
                      setFollowUpCompose({
                        to: info?.originalAddress || addr,
                        subject: `Following up: ${it.subject}`,
                        quotedBody: "loading",   // sentinel — ComposeMailModal shows spinner
                      });
                      // Fetch full email body in background (sentitems API omits body for perf)
                      try {
                        const res = await fetch(
                          `${API_BASE}/email-details?messageId=${encodeURIComponent(it.messageId)}&userEmail=${encodeURIComponent(userEmail)}`
                        );
                        if (res.ok) {
                          const data = await res.json();
                          setFollowUpCompose(prev => prev ? {
                            ...prev,
                            quotedBody: data.body || "",
                          } : null);
                        } else {
                          setFollowUpCompose(prev => prev ? { ...prev, quotedBody: "" } : null);
                        }
                      } catch {
                        setFollowUpCompose(prev => prev ? { ...prev, quotedBody: "" } : null);
                      }
                    }}
                    onViewEmail={openEmailModal}
                    defaultCollapsed={resolvedIds.has(item.messageId)}
                  />
                ))}
                {(trackingData?.resolved || []).length > 0 && (
                  <div style={{
                    fontSize: '0.66rem', color: 'var(--text-muted)',
                    fontWeight: '700', letterSpacing: '0.8px', textTransform: 'uppercase',
                    textAlign: 'center', padding: '8px 0 4px',
                    borderTop: '1px dashed var(--border-color)', marginTop: '8px',
                  }}>
                    ✓ Resolved — shown for reference
                  </div>
                )}
              </div>
            )
          )}

          {/* ── PENDING REVIEW TAB ─────────────────────────────────────── */}
          {activeTab === 'pending' && (() => {
            // Newest-first (Outlook style), on the date the email was sent.
            const sortedApprovals = [...trackingApprovals].sort((a, b) => {
              try { return new Date(b.sentAt || b.createdAt || 0) - new Date(a.sentAt || a.createdAt || 0); }
              catch { return 0; }
            });
            const isLoading = approvalsLoading;

            if (isLoading) return <LoadingState icon="⏳" />;

            if (sortedApprovals.length === 0) return (
              <EmptyState
                icon="✅"
                title="All clear"
                subtitle={<>No items waiting for your review.<br />When AI detects a sent email that needs follow-up, it will appear here for your approval.</>}
              />
            );

            return (
              <div>
                {/* ══ AI TRACKING DECISIONS ═════════════════════════════════ */}
                {sortedApprovals.length > 0 && (
                  <div style={{ marginBottom: '32px' }}>
                    {/* Section header */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: '14px', flexWrap: 'wrap', gap: '10px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px',
                          color: '#00d9ff', textTransform: 'uppercase',
                        }}>
                          📡 AI Tracking Decisions
                        </div>
                        <span style={{
                          fontSize: '0.65rem', fontWeight: '800',
                          background: 'rgba(0,217,255,0.12)', color: '#00d9ff',
                          border: '1px solid rgba(0,217,255,0.25)',
                          borderRadius: '999px', padding: '2px 8px',
                        }}>
                          {sortedApprovals.length} awaiting approval
                        </span>
                      </div>
                      <div style={{
                        fontSize: '0.72rem', color: '#00d9ff',
                        background: 'rgba(0,217,255,0.06)', border: '1px solid rgba(0,217,255,0.18)',
                        borderRadius: '7px', padding: '5px 12px',
                      }}>
                        AI thinks these need follow-up — you decide
                      </div>
                    </div>

                    {sortedApprovals.map((approval, i) => {
                      const isAct      = !!approvalActioning[approval.id];
                      const isApproving  = approvalActioning[approval.id] === 'approving';
                      const isDismissing = approvalActioning[approval.id] === 'dismissing';
                      const dateStr    = (() => { try { return new Date(approval.sentAt || approval.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })();
                      const recipList  = Object.entries(approval.recipients || {});

                      return (
                        <div
                          key={approval.id}
                          className="email-card"
                          style={{
                            display: 'block', padding: 0, marginBottom: '14px',
                            borderLeft: '3px solid #00d9ff', contain: 'none',
                            animation: `fadeSlideUp 0.3s cubic-bezier(0.2,0,0,1) ${i * 0.06}s both`,
                            opacity: isAct ? 0.6 : 1, transition: 'opacity 0.2s',
                          }}
                        >
                          <div style={{ padding: '18px 22px' }}>
                            {/* Card header */}
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                  <span style={{
                                    fontSize: '0.66rem', fontWeight: '800', letterSpacing: '0.8px',
                                    color: '#00d9ff', background: 'rgba(0,217,255,0.1)',
                                    border: '1px solid rgba(0,217,255,0.25)', borderRadius: '5px', padding: '2px 8px',
                                  }}>
                                    📡 Track This?
                                  </span>
                                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{dateStr}</span>
                                </div>
                                <div style={{
                                  fontSize: '0.96rem', fontWeight: '700', color: 'var(--text-primary)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {approval.subject}
                                </div>
                              </div>
                              {/* View Email button */}
                              <button
                                onClick={() => openEmailModal(approval.messageId, approval.subject)}
                                className="btn-copy"
                                style={{ color: '#60a5fa', borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
                              >
                                <Eye size={13} /> View Email
                              </button>
                            </div>

                            {/* AI reason — plus what the thread pass actually read,
                                so approving is a check of the AI's work rather
                                than a guess about where it got its verdict. */}
                            <div style={{
                              padding: '10px 14px', marginBottom: '14px',
                              background: 'rgba(0,217,255,0.05)', border: '1px solid rgba(0,217,255,0.15)',
                              borderRadius: '10px',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                <span style={{ fontSize: '0.72rem', fontWeight: '800', color: '#00d9ff', flexShrink: 0, marginTop: '1px' }}>🤖 AI:</span>
                                <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: '1.55', fontStyle: 'italic' }}>
                                  {approval.ai_reason || 'No reason provided'}
                                </span>
                              </div>
                              {(approval.thread_state || approval.thread_size > 0) && (
                                <div style={{
                                  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
                                  marginTop: '8px', paddingTop: '8px',
                                  borderTop: '1px solid rgba(0,217,255,0.12)',
                                }}>
                                  {approval.thread_state && (
                                    <span style={{ fontSize: '0.78rem', fontWeight: '700', color: '#00d9ff' }}>
                                      {approval.thread_state}
                                    </span>
                                  )}
                                  {approval.thread_size > 0 && (
                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.75 }}>
                                      {approval.thread_size === 1
                                        ? 'judged on this message alone'
                                        : `read all ${approval.thread_size} messages in this thread`}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Recipients to track */}
                            {recipList.length > 0 && (
                              <div style={{ marginBottom: '14px' }}>
                                <div style={{
                                  fontSize: '0.66rem', fontWeight: '800', letterSpacing: '0.8px',
                                  color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px',
                                }}>
                                  Recipients to track
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {recipList.map(([addr, info]) => {
                                    const name = (info.originalAddress || addr).split('@')[0].replace(/[._]/g, ' ').replace(/\w/g, c => c.toUpperCase());
                                    return (
                                      <div key={addr} style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        padding: '5px 10px', borderRadius: '8px',
                                        background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
                                        fontSize: '0.8rem',
                                      }}>
                                        <div style={{
                                          width: '22px', height: '22px', borderRadius: '50%',
                                          background: 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
                                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                                          color: 'white', fontSize: '0.62rem', fontWeight: '800', flexShrink: 0,
                                        }}>
                                          {name.charAt(0)}
                                        </div>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>{name}</span>
                                        <span style={{
                                          fontSize: '0.58rem', fontWeight: '800',
                                          color: info.type === 'internal' ? '#60a5fa' : '#f59e0b',
                                          background: info.type === 'internal' ? 'rgba(59,130,246,0.15)' : 'rgba(245,158,11,0.15)',
                                          border: `1px solid ${info.type === 'internal' ? 'rgba(59,130,246,0.3)' : 'rgba(245,158,11,0.3)'}`,
                                          borderRadius: '4px', padding: '1px 5px',
                                        }}>
                                          {info.type === 'internal' ? 'INT' : 'EXT'}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Action buttons */}
                            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => dismissTrackingDecision(approval.id)}
                                disabled={isAct}
                                className="btn-close"
                                style={{
                                  width: 'auto', padding: '9px 18px', borderRadius: '8px',
                                  fontWeight: '700', fontSize: '0.84rem',
                                  opacity: isAct ? 0.5 : 1, cursor: isAct ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {isDismissing ? '⏳ Skipping...' : '✕ Skip'}
                              </button>
                              <button
                                onClick={() => approveTrackingDecision(approval.id)}
                                disabled={isAct}
                                className="btn-gradient"
                                style={{
                                  width: 'auto', padding: '9px 22px',
                                  display: 'flex', alignItems: 'center', gap: '6px',
                                  fontSize: '0.84rem', fontWeight: '700',
                                  opacity: isAct ? 0.5 : 1, cursor: isAct ? 'not-allowed' : 'pointer',
                                  background: 'linear-gradient(135deg, #0891b2, #0e7490)',
                                  boxShadow: '0 4px 14px rgba(8,145,178,0.35)',
                                }}
                              >
                                {isApproving ? <><Loader size={14} className="animate-spin" /> Adding...</> : <>📡 Start Tracking</>}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>
            );
          })()}

          {/* ── SENT EMAILS TAB ─────────────────────────────────────────── */}
          {activeTab === 'sent' && (() => {
            const skippedIds    = new Set(skippedData.map(s => s.messageId));
            const pendingIds    = new Set((trackingApprovals || []).map(a => a.messageId));

            const CatBadge = ({ color, bg, border, label }) => (
              <span style={{
                fontSize: '0.62rem', fontWeight: '800', letterSpacing: '0.4px',
                padding: '2px 8px', borderRadius: '6px',
                background: bg, border: `1px solid ${border}`, color,
                whiteSpace: 'nowrap',
              }}>{label}</span>
            );

            const fmt = (str) => { try { return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return str || ''; } };

            if (sentLoading) return <LoadingState icon="📤" />;

            if (sentEmails.length === 0) return (
              <EmptyState
                icon="📭"
                title="No sent emails found"
                subtitle="Last 7 days of sent emails will appear here."
              />
            );

            return (
              <div className="email-feed">
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginBottom: '16px', fontSize: '0.78rem', color: 'var(--text-secondary)',
                }}>
                  <span>
                    <strong style={{ color: 'var(--text-primary)' }}>{sentEmails.length}</strong> sent emails — last 7 days
                    {sentEmails.length > sentVisible && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
                        (showing {sentVisible})
                      </span>
                    )}
                  </span>
                  <button onClick={() => { sentEmailsLoadedRef.current = false; addToast('Refreshing sent emails...', 'loading'); fetchSentEmails(); sentEmailsLoadedRef.current = true; }} className="btn-copy">↺ Refresh</button>
                </div>

                {sentEmails.slice(0, sentVisible).map((email, i) => {
                  const mid          = email.messageId;
                  const isTracked    = trackedIds.has(mid);
                  const isAiSkipped  = skippedIds.has(mid);
                  const isNeedsReview = pendingIds.has(mid);
                  const isAdding     = addingTrack[mid];
                  const toStr        = (email.to || []).join(', ');
                  const repliedCount = (email.repliedByAddresses || []).length;
                  const totalTo      = (email.to || []).length;

                  // EWS-computed — who still needs a reply
                  const notReplied       = email.notRepliedAddresses || [];
                  const pendingCount     = notReplied.length;
                  const allReplied       = totalTo > 0 && !email.hasPendingReplies;
                  // Disable Track This if everyone has replied
                  const trackDisabled    = isAdding || allReplied;

                  return (
                    <div
                      key={mid || i}
                      className="email-card"
                      style={{
                        display: 'block', padding: '16px 20px',
                        marginBottom: '10px', contain: 'none',
                        animation: `fadeSlideUp 0.3s cubic-bezier(0.2,0,0,1) ${i * 0.03}s both`,
                        cursor: 'pointer',
                      }}
                      onClick={() => openEmailModal(email.messageId, email.subject)}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: '0.94rem', fontWeight: '700', color: 'var(--text-primary)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '7px',
                          }}>
                            {email.subject || '(no subject)'}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                            {email.isReply && <CatBadge color="#9ca3af" bg="rgba(107,114,128,0.1)" border="rgba(107,114,128,0.25)" label="↩️ Reply" />}
                            {email.hasPendingReplies && <CatBadge color="#f59e0b" bg="rgba(245,158,11,0.1)" border="rgba(245,158,11,0.3)" label="⏳ Awaiting Reply" />}
                            {!email.hasPendingReplies && totalTo > 0 && <CatBadge color="#22c55e" bg="rgba(34,197,94,0.1)" border="rgba(34,197,94,0.3)" label="✅ All Replied" />}
                            {email.hasQuestionMark && <CatBadge color="#60a5fa" bg="rgba(59,130,246,0.1)" border="rgba(59,130,246,0.3)" label="❓ Has Question" />}
                            {isTracked      && <CatBadge color="#00d9ff" bg="rgba(0,217,255,0.08)"    border="rgba(0,217,255,0.25)"    label="📡 Tracking"      />}
                            {isNeedsReview  && <CatBadge color="#f97316" bg="rgba(249,115,22,0.1)"   border="rgba(249,115,22,0.3)"   label="👁 Needs Review"  />}
                            {isAiSkipped    && <CatBadge color="#a78bfa" bg="rgba(167,139,250,0.1)"  border="rgba(167,139,250,0.3)"  label="🤖 AI Skipped"    />}
                          </div>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>{fmt(email.sentAt)}</div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <div className="ec-meta" style={{ margin: 0 }}>
                          <span style={{ fontWeight: '700', color: 'var(--text-secondary)', marginRight: '4px' }}>TO</span>{toStr}
                        </div>
                        {totalTo > 0 && (
                          <div style={{ fontSize: '0.7rem', flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {repliedCount > 0 && (
                              <span style={{ color: '#10b981', fontWeight: '700' }}>
                                ✓ {repliedCount} replied
                              </span>
                            )}
                            {pendingCount > 0 && (
                              <span style={{ color: '#f59e0b', fontWeight: '700' }}>
                                ⏳ {pendingCount} waiting
                              </span>
                            )}
                            {allReplied && (
                              <span style={{ color: '#10b981', fontWeight: '700' }}>
                                ✅ All replied
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Not-replied addresses — red pill list */}
                      {notReplied.length > 0 && (
                        <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                          <span style={{ fontSize: '0.68rem', fontWeight: '800', color: '#f59e0b', alignSelf: 'center', flexShrink: 0 }}>
                            ⏳ Waiting:
                          </span>
                          {notReplied.map((addr, idx) => (
                            <span key={idx} style={{
                              fontSize: '0.68rem', fontWeight: '600',
                              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                              color: '#fbbf24', borderRadius: '5px', padding: '2px 8px',
                            }}>
                              {addr.split('@')[0]}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Replied addresses — green pill list */}
                      {repliedCount > 0 && (
                        <div style={{ marginTop: '5px', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                          <span style={{ fontSize: '0.68rem', fontWeight: '800', color: '#10b981', alignSelf: 'center', flexShrink: 0 }}>
                            ✓ Replied:
                          </span>
                          {(email.repliedByAddresses || []).map((addr, idx) => (
                            <span key={idx} style={{
                              fontSize: '0.68rem', fontWeight: '600',
                              background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
                              color: '#6ee7b7', borderRadius: '5px', padding: '2px 8px',
                            }}>
                              {addr.split('@')[0]}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* ── AI Thread Analysis ───────────────────────────── */}
                      {(() => {
                        const analysis  = threadAnalysis[mid];
                        const isLoading = !!analyzingThread[mid];

                        const verdictColor = !analysis ? '#a855f7'
                          : analysis.needs_reply  ? '#f59e0b'
                          : '#10b981';

                        return (
                          <div style={{ marginTop: '10px' }} onClick={e => e.stopPropagation()}>
                            {/* Button row */}
                            {!analysis && (
                              <button
                                onClick={() => analyzeThread(email)}
                                disabled={isLoading}
                                className="btn-copy"
                                style={{
                                  color: '#a855f7', borderColor: 'rgba(168,85,247,0.3)',
                                  background: 'rgba(168,85,247,0.08)',
                                  display: 'flex', alignItems: 'center', gap: '6px',
                                  opacity: isLoading ? 0.7 : 1,
                                  cursor: isLoading ? 'not-allowed' : 'pointer',
                                  fontSize: '0.8rem', fontWeight: '700',
                                }}
                              >
                                {isLoading
                                  ? <><span style={{ animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block' }}>🤖</span> AI Reading Thread...</>
                                  : <>🤖 AI Analyze Thread</>
                                }
                              </button>
                            )}

                            {/* Result panel */}
                            {analysis && (
                              <div style={{
                                marginTop: '10px', borderRadius: '10px', overflow: 'hidden',
                                border: `1px solid ${verdictColor}30`,
                                background: `${verdictColor}06`,
                                animation: 'fadeSlideUp 0.3s cubic-bezier(0.2,0,0,1) both',
                              }}>
                                {/* Header */}
                                <div style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  gap: '10px', padding: '10px 14px',
                                  background: `${verdictColor}0d`,
                                  borderBottom: `1px solid ${verdictColor}20`,
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontSize: '0.9rem' }}>
                                      {analysis.needs_reply ? '⏳' : '✅'}
                                    </span>
                                    <span style={{
                                      fontSize: '0.84rem', fontWeight: '800',
                                      color: verdictColor,
                                    }}>
                                      {analysis.verdict}
                                    </span>
                                    <span style={{
                                      fontSize: '0.58rem', fontWeight: '800',
                                      color: analysis.confidence === 'high' ? '#10b981' : analysis.confidence === 'low' ? '#f87171' : '#f59e0b',
                                      background: analysis.confidence === 'high' ? 'rgba(16,185,129,0.1)' : analysis.confidence === 'low' ? 'rgba(248,113,113,0.1)' : 'rgba(245,158,11,0.1)',
                                      border: `1px solid ${analysis.confidence === 'high' ? 'rgba(16,185,129,0.3)' : analysis.confidence === 'low' ? 'rgba(248,113,113,0.3)' : 'rgba(245,158,11,0.3)'}`,
                                      borderRadius: '4px', padding: '1px 6px', textTransform: 'uppercase',
                                    }}>
                                      {analysis.confidence} confidence
                                    </span>
                                  </div>
                                  <button
                                    onClick={() => setThreadAnalysis(prev => { const n = { ...prev }; delete n[mid]; return n; })}
                                    className="btn-copy"
                                    style={{ padding: '2px 8px', fontSize: '0.7rem', color: 'var(--text-muted)' }}
                                  >
                                    ✕
                                  </button>
                                </div>

                                {/* Pending recipients */}
                                {analysis.needs_reply && analysis.pending?.length > 0 && (
                                  <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', borderBottom: `1px solid ${verdictColor}15` }}>
                                    <span style={{ fontSize: '0.68rem', fontWeight: '800', color: '#f59e0b', flexShrink: 0 }}>⏳ Waiting on:</span>
                                    {analysis.pending.map((name, i) => (
                                      <span key={i} style={{
                                        fontSize: '0.72rem', fontWeight: '700',
                                        background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                                        color: '#fbbf24', borderRadius: '5px', padding: '2px 8px',
                                      }}>
                                        {name}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {/* Analysis text */}
                                <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                                  {analysis.analysis}
                                </div>

                                {/* Re-analyze */}
                                <div style={{ padding: '6px 14px 10px', display: 'flex', justifyContent: 'flex-end' }}>
                                  <button
                                    onClick={() => analyzeThread(email)}
                                    disabled={!!analyzingThread[mid]}
                                    className="btn-copy"
                                    style={{ fontSize: '0.72rem', color: '#a855f7', borderColor: 'rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.08)' }}
                                  >
                                    {analyzingThread[mid] ? '🤖 Re-analysing...' : '↺ Re-analyze'}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                        {isTracked ? (
                          <span style={{ fontSize: '0.74rem', color: '#00d9ff', fontWeight: '700' }}>📡 Already tracking</span>
                        ) : allReplied ? (
                          <span style={{ fontSize: '0.74rem', color: '#10b981', fontWeight: '700' }}>✅ All replied — no tracking needed</span>
                        ) : (
                          <button
                            onClick={() => addToTracking(email)}
                            disabled={trackDisabled}
                            className="btn-copy"
                            style={{
                              color: trackDisabled ? 'var(--text-muted)' : '#60a5fa',
                              borderColor: trackDisabled ? 'var(--border-color)' : 'rgba(59,130,246,0.3)',
                              background: trackDisabled ? 'transparent' : 'rgba(59,130,246,0.08)',
                              opacity: trackDisabled ? 0.5 : 1,
                              cursor: trackDisabled ? 'not-allowed' : 'pointer',
                              display: 'flex', alignItems: 'center', gap: '5px',
                            }}
                          >
                            {isAdding
                              ? '⏳ Adding...'
                              : pendingCount > 0
                                ? `📡 Track ${pendingCount} non-repl${pendingCount > 1 ? 'iers' : 'ier'}`
                                : '📡 Track This'
                            }
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {sentEmails.length > sentVisible && (
                  <div style={{ textAlign: 'center', padding: '20px 0 8px' }}>
                    <button
                      onClick={() => setSentVisible(v => v + 60)}
                      className="btn-copy"
                      style={{ padding: '10px 28px', fontSize: '0.84rem', fontWeight: '700' }}
                    >
                      Load More ({sentEmails.length - sentVisible} remaining)
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── AI SKIPPED TAB ────────────────────────────────────────── */}
          {activeTab === 'skipped' && (
            skippedLoading ? <LoadingState icon="🤖" /> :
            skippedData.length === 0 ? (
              <EmptyState
                icon="✨"
                title="No skipped emails yet"
                subtitle={<>Emails the AI decides don't need tracking will appear here.<br />They're kept for reference so nothing goes unnoticed.</>}
              />
            ) : (
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: '20px', flexWrap: 'wrap', gap: '10px',
                }}>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>{skippedData.length}</strong> email{skippedData.length !== 1 ? 's' : ''} decided not worth tracking
                  </div>
                  <div style={{
                    fontSize: '0.7rem', color: 'var(--text-secondary)',
                    background: 'rgba(0,217,255,0.06)', border: '1px solid rgba(0,217,255,0.15)',
                    borderRadius: '7px', padding: '5px 12px',
                  }}>
                    🤖 All decisions made by AI
                  </div>
                </div>

                <div className="email-feed">
                  {/* Sort newest first (Outlook style) — skippedAt is when AI decided,
                      sentAt is the Exchange send date; prefer skippedAt for ordering. */}
                  {[...skippedData].sort((a, b) => {
                    try { return new Date(b.skippedAt || b.sentAt || 0) - new Date(a.skippedAt || a.sentAt || 0); }
                    catch { return 0; }
                  }).map((entry, i) => {
                    const toList = Array.isArray(entry.to) ? entry.to.join(', ') : (entry.to || '—');
                    const dateStr = (() => { try { return new Date(entry.skippedAt || entry.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } })();

                    return (
                      <div
                        key={entry.messageId || i}
                        className="email-card"
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: '16px',
                          padding: '16px 20px', marginBottom: '10px',
                          borderLeft: '3px solid rgba(107,114,128,0.5)',
                          contain: 'none',
                          animation: `fadeSlideUp 0.3s cubic-bezier(0.2,0,0,1) ${i * 0.04}s both`,
                        }}
                      >
                        {/* Icon */}
                        <div style={{
                          width: '38px', height: '38px', borderRadius: '10px', flexShrink: 0,
                          background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem',
                        }}>
                          📭
                        </div>

                        {/* Content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '6px' }}>
                            <div style={{
                              fontSize: '0.92rem', fontWeight: '700', color: 'var(--text-primary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {entry.subject || '(no subject)'}
                            </div>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{dateStr}</span>
                          </div>

                          {/* AI reason */}
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '8px' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: '800', color: '#a78bfa', flexShrink: 0, marginTop: '1px' }}>🤖 AI:</span>
                            <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.5', fontStyle: 'italic' }}>
                              {entry.reason || 'No reason provided'}
                            </span>
                          </div>

                          <div className="ec-meta" style={{ marginBottom: '10px' }}>
                            <span style={{ fontWeight: '700', color: 'var(--text-secondary)', marginRight: '4px' }}>TO</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '500px', verticalAlign: 'bottom' }}>{toList}</span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <button
                              onClick={() => restoreToTracking(entry.messageId)}
                              disabled={restoring[entry.messageId]}
                              className="btn-copy"
                              style={{
                                color: '#60a5fa', borderColor: 'rgba(59,130,246,0.3)',
                                background: 'rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: '5px',
                                opacity: restoring[entry.messageId] ? 0.6 : 1,
                                cursor: restoring[entry.messageId] ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {restoring[entry.messageId] ? '⏳ Moving...' : '📡 Move to Tracking'}
                            </button>

                            {entry.messageId && (
                              <button
                                onClick={() => openEmailModal(entry.messageId, entry.subject)}
                                className="btn-copy"
                                style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.08)' }}
                              >
                                <Eye size={13} /> View Email
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )}

          </>
        )}

      </main>

      {/* ── EMAIL DETAIL MODAL — rendered outside main-content so that
           position:fixed is relative to the viewport, not the scrollable
           overflow-y:auto container. Rendering inside main-content caused
           the modal to appear at the top of the page when scrolled down. ── */}
      <AnimatePresence>
      {emailModal && (
          <AnimatedModal
            onOverlayClick={() => { setEmailModal(null); setModalFetchErr(null); }}
            contentStyle={{ width: '960px', maxWidth: '94vw' }}
          >
              {/* Modal header */}
              <div className="modal-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: '800', letterSpacing: '1px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '5px' }}>
                    📧 Email Preview
                  </div>
                  <h3 className="modal-subject" style={{ margin: 0, fontSize: '1rem' }}>
                    {emailModal.subject || emailModal.email?.subject || 'No Subject'}
                  </h3>
                </div>
                <button
                  onClick={() => { setEmailModal(null); setModalFetchErr(null); }}
                  className="btn-close"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Modal body */}
              <div className="modal-body-scroll">

                {emailModal.loading && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '60px 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    <Loader size={18} className="animate-spin" style={{ color: '#00d9ff' }} />
                    Loading email...
                  </div>
                )}

                {!emailModal.loading && modalFetchErr && (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: '#f87171', fontSize: '0.9rem' }}>
                    ⚠️ {modalFetchErr}
                  </div>
                )}

                {!emailModal.loading && emailModal.email && (() => {
                  const em  = emailModal.email;
                  const atts = Array.isArray(em.attachments) ? em.attachments.filter(a => a?.name) : [];
                  const fmt  = (str) => { try { return new Date(str).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return str || '—'; } };

                  return (
                    <>
                      {/* FROM / DATE / TO / CC — same 2-col grid as inbox detail */}
                      <div className="modal-meta-grid">
                        {[
                          { label: '🔵 FROM', color: '#3b82f6', value: em.from || '—' },
                          { label: '🟣 DATE', color: '#a855f7', value: fmt(em.received_at || em.received || em.date) },
                          { label: '🟢 TO',   color: '#22c55e', value: Array.isArray(em.to) ? em.to.join(', ') : (em.to || '—') },
                          { label: '🟡 CC',   color: '#f59e0b', value: Array.isArray(em.cc) && em.cc.length > 0 ? em.cc.join(', ') : '—' },
                        ].map(({ label, color, value }) => (
                          <div key={label} className="meta-item" style={{ flexDirection: 'column', alignItems: 'flex-start', background: `${color}09`, border: `1px solid ${color}20`, borderRadius: '8px', padding: '10px 14px', gap: 0 }}>
                            <div style={{ fontSize: '0.66rem', fontWeight: '800', letterSpacing: '1.2px', color, marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word', lineHeight: '1.4' }}>{value}</div>
                          </div>
                        ))}
                      </div>

                      {/* AI Summary */}
                      {em.summary && (
                        <div className="modal-summary-box">
                          <strong>💡 AI Summary:</strong> {em.summary}
                        </div>
                      )}

                      {/* Attachments */}
                      {atts.length > 0 && (
                        <div style={{ marginBottom: '20px', padding: '12px 16px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: '10px' }}>
                          <div style={{ fontSize: '0.7rem', fontWeight: '800', letterSpacing: '1px', color: '#3b82f6', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <Paperclip size={13} /> ATTACHMENTS ({atts.length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {atts.map((att, idx) => {
                              const sizeMb = att.size ? ` (${(att.size / 1024 / 1024).toFixed(2)} MB)` : '';
                              return (
                                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span style={{ flex: 1, fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: '500' }}>
                                    {att.name}<span style={{ fontSize: '0.8em', color: 'var(--text-secondary)', marginLeft: '6px' }}>{sizeMb}</span>
                                  </span>
                                  {att.attachmentId ? (
                                    <button
                                      onClick={async () => {
                                        try {
                                          const res = await fetch(`${API_BASE}/download-attachment`, {
                                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ name: att.name, messageId: att.messageId || em.id, attachmentId: att.attachmentId, userEmail }),
                                          });
                                          const blob = await res.blob();
                                          const url = window.URL.createObjectURL(blob);
                                          const a = document.createElement('a');
                                          a.href = url; a.download = att.name; a.click();
                                          window.URL.revokeObjectURL(url);
                                        } catch (err) { console.error('download failed', err); }
                                      }}
                                      className="download-btn"
                                      style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem' }}
                                    >
                                      <Download size={14} /> Download
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Preview only</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* ── Thread conversation (multi-message) or single body ── */}
                      {(() => {
                        const thread = Array.isArray(em.messages) && em.messages.length > 1
                          ? [...em.messages].sort((a, b) => {
                              try { return new Date(b.received || b.Received || 0) - new Date(a.received || a.Received || 0); }
                              catch { return 0; }
                            })
                          : null;

                        if (!thread) {
                          return (
                            <div style={{ borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                              <HtmlEmailRenderer body={em.body || ''} darkMode={false} />
                            </div>
                          );
                        }

                        // Full thread view — newest first (Outlook style)
                        return (
                          <div>
                            {/* Thread count pill */}
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: '8px',
                              marginBottom: '14px',
                            }}>
                              <span style={{
                                fontSize: '0.66rem', fontWeight: '800', letterSpacing: '0.6px',
                                background: 'rgba(0,217,255,0.1)', color: '#00d9ff',
                                border: '1px solid rgba(0,217,255,0.25)',
                                borderRadius: '6px', padding: '3px 10px',
                              }}>
                                💬 {thread.length} messages in thread
                              </span>
                            </div>

                            {thread.map((msg, idx) => {
                              const msgFrom   = msg.from || msg.From || '—';
                              const msgDate   = msg.received || msg.Received || msg.date || msg.Date || '';
                              const msgBody   = msg.body || msg.Body || '';
                              const msgTo     = Array.isArray(msg.to || msg.To) ? (msg.to || msg.To).join(', ') : (msg.to || msg.To || '');
                              const isNewest  = idx === 0;
                              const isSentByUser = msgFrom.toLowerCase() === userEmail.toLowerCase();
                              const msgAtts   = Array.isArray(msg.attachments || msg.Attachments)
                                ? (msg.attachments || msg.Attachments).filter(a => a?.name || a?.Name)
                                : [];

                              return (
                                <div key={msg.messageId || msg.MessageId || idx} style={{
                                  marginBottom: idx < thread.length - 1 ? '12px' : 0,
                                  borderRadius: '10px',
                                  border: `1px solid ${isNewest ? 'rgba(0,217,255,0.25)' : 'var(--border-color)'}`,
                                  background: isNewest ? 'rgba(0,217,255,0.03)' : 'transparent',
                                  overflow: 'hidden',
                                }}>
                                  {/* Message header */}
                                  <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    gap: '10px', padding: '10px 14px',
                                    background: isNewest ? 'rgba(0,217,255,0.06)' : 'rgba(255,255,255,0.03)',
                                    borderBottom: '1px solid var(--border-color)',
                                    flexWrap: 'wrap',
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                      {/* Avatar */}
                                      <div style={{
                                        width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                                        background: isSentByUser
                                          ? 'linear-gradient(135deg,#0891b2,#0e7490)'
                                          : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '0.65rem', fontWeight: '800', color: 'white',
                                      }}>
                                        {msgFrom.charAt(0).toUpperCase()}
                                      </div>
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ fontSize: '0.82rem', fontWeight: '700', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {msgFrom}
                                          {isSentByUser && (
                                            <span style={{ marginLeft: '6px', fontSize: '0.58rem', fontWeight: '800', color: '#00d9ff', background: 'rgba(0,217,255,0.1)', border: '1px solid rgba(0,217,255,0.2)', borderRadius: '4px', padding: '1px 5px' }}>YOU</span>
                                          )}
                                        </div>
                                        {msgTo && (
                                          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            To: {msgTo}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                      {msgAtts.length > 0 && (
                                        <span style={{ fontSize: '0.65rem', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                          <Paperclip size={11} /> {msgAtts.length}
                                        </span>
                                      )}
                                      {isNewest && (
                                        <span style={{ fontSize: '0.6rem', fontWeight: '800', color: '#00d9ff', background: 'rgba(0,217,255,0.1)', border: '1px solid rgba(0,217,255,0.2)', borderRadius: '4px', padding: '2px 6px' }}>LATEST</span>
                                      )}
                                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                        {fmt(msgDate)}
                                      </span>
                                    </div>
                                  </div>

                                  {/* Message body */}
                                  <HtmlEmailRenderer body={msgBody} darkMode={false} />
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </>
                  );
                })()}
              </div>

              {/* ── Modal footer — Track This button ─────────────────────── */}
              {(() => {
                const em         = emailModal?.email;
                const mid        = emailModal?.messageId || em?.messageId || em?.id || '';
                if (!mid || emailModal?.loading) return null;

                const isTracked   = trackedIds.has(mid);
                const isAdding    = !!addingTrack[mid];
                const notReplied  = Array.isArray(em?.notRepliedAddresses) ? em.notRepliedAddresses : [];
                const totalTo     = (em?.to || []).length;
                const allReplied  = totalTo > 0 && !em?.hasPendingReplies;
                const pendingCount = notReplied.length;

                return (
                  <div style={{
                    borderTop: '1px solid var(--border-color)',
                    padding: '12px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    background: 'rgba(0,0,0,0.15)',
                    borderRadius: '0 0 14px 14px',
                    flexShrink: 0,
                  }}>

                    {/* Left — context hint */}
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {isTracked ? (
                        <span style={{ color: '#00d9ff' }}>📡 This email is in your tracking list</span>
                      ) : allReplied ? (
                        <span style={{ color: '#10b981' }}>✅ Everyone has replied to this email</span>
                      ) : pendingCount > 0 ? (
                        <span>⏳ {pendingCount} recipient{pendingCount > 1 ? 's have' : ' has'} not replied</span>
                      ) : (
                        <span>Add to tracking to monitor replies</span>
                      )}
                    </div>

                    {/* Right — action button */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>

                      {/* CASE 1 — Already tracking */}
                      {isTracked && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: '6px',
                          fontSize: '0.78rem', fontWeight: '800',
                          color: '#00d9ff',
                          background: 'rgba(0,217,255,0.08)',
                          border: '1px solid rgba(0,217,255,0.25)',
                          borderRadius: '8px', padding: '7px 14px',
                        }}>
                          <span>📡</span> Already Tracking
                        </div>
                      )}

                      {/* CASE 2 — All replied, not tracked → ghost "Track Anyway" */}
                      {!isTracked && allReplied && (
                        <button
                          onClick={() => addToTracking(em)}
                          disabled={isAdding}
                          className="btn-copy"
                          style={{
                            fontSize: '0.76rem', fontWeight: '700',
                            color: 'var(--text-muted)',
                            borderColor: 'var(--border-color)',
                            background: 'transparent',
                            opacity: 0.7,
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '5px',
                          }}
                        >
                          {isAdding ? '⏳ Adding...' : '📡 Track Anyway'}
                        </button>
                      )}

                      {/* CASE 3 — Normal: not tracked, not all replied */}
                      {!isTracked && !allReplied && (
                        <button
                          onClick={() => addToTracking(em)}
                          disabled={isAdding}
                          className="btn-copy"
                          style={{
                            fontSize: '0.8rem', fontWeight: '800',
                            color: isAdding ? 'var(--text-muted)' : '#60a5fa',
                            borderColor: isAdding ? 'var(--border-color)' : 'rgba(59,130,246,0.4)',
                            background: isAdding ? 'transparent' : 'rgba(59,130,246,0.1)',
                            cursor: isAdding ? 'not-allowed' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: '6px',
                            padding: '8px 16px',
                            transition: 'all 0.2s',
                          }}
                        >
                          {isAdding
                            ? <><span style={{ animation: 'pulse 1.2s ease-in-out infinite', display: 'inline-block' }}>⏳</span> Adding...</>
                            : pendingCount > 0
                              ? `📡 Track ${pendingCount} non-repl${pendingCount > 1 ? 'iers' : 'ier'}`
                              : '📡 Track This'
                          }
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
          </AnimatedModal>
        )}
      </AnimatePresence>

        {followUpCompose && (
          <ComposeMailModal
            isOpen={!!followUpCompose}
            onClose={() => setFollowUpCompose(null)}
            prefillTo={followUpCompose.to}
            prefillSubject={followUpCompose.subject}
            prefillQuotedBody={followUpCompose.quotedBody || ""}
            useReminderSender={true}
            onSent={(result) =>
              result?.ok
                ? addToast('✉️ Reminder sent!', 'success')
                : addToast(result?.error || 'Failed to send reminder.', 'error')
            }
          />
        )}

    </div>
  );
}