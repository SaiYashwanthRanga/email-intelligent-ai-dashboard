import React, { useMemo, useState } from 'react';
import {
  Mail, MessagesSquare, CalendarDays, Paperclip, AlertCircle, CheckCircle2,
  Sparkles, ArrowUpRight, ChevronDown,
} from 'lucide-react';
import './InsightsOverview.css';

// Categories that put an unread card into "Needs attention".
const ATTENTION_CATEGORIES = new Set(['URGENT', 'PRIORITY', 'VIP', 'LEGAL', 'CONFIDENTIAL']);
// AI-suggested actions worth surfacing (REVIEW/READ/FYI are the default "nothing to do").
const ACTION_LABELS = { REPLY: 'Reply', APPROVE: 'Approve', CONFIRM: 'Confirm', SCHEDULE: 'Schedule' };
const MAX_ROWS = 4;

const senderOf = (e) => {
  const from = e.from || e.sender || '';
  const name = from.match(/^([^<]+)</)?.[1]?.trim();
  const addr = from.match(/[\w.+-]+@[\w.-]+/)?.[0];
  return { key: (addr || from).toLowerCase(), label: name || addr || from || 'Unknown sender' };
};

const receivedTime = (e) => {
  const t = new Date(e.received_at || e.received || e.date || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const messageCount = (e) => Number(e.threadCount || e.thread_count || e.messages?.length || 1);

const dayLabel = (iso) => {
  try {
    const d = new Date(iso + 'T12:00:00');
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  } catch { return iso; }
};

function Row({ title, meta, text, onClick }) {
  return (
    <button type="button" className="io-row" onClick={onClick}>
      <span className="io-row-main">
        <span className="io-row-title">{title}</span>
        {text && <span className="io-row-text">{text}</span>}
      </span>
      {meta && <span className="io-row-meta">{meta}</span>}
    </button>
  );
}

/**
 * Insights overview: greeting, the four headline numbers, the AI priority
 * brief, the latest digest, top senders and a shortcut to Iris. Everything is
 * computed from the cards the Inbox shows (one per conversation), so the
 * numbers match the Inbox's folder counts.
 */
export default function InsightsOverview({
  cards = [], triageStats, username = '', greetingInfo = {}, digestData = [], digestLoading = false,
  briefingCards = [], senderSummaries = [], reportReady = true,
  lastSyncTime, isSyncing, analysisReady = true,
  onOpenEmail, onViewSender, onOpenFolder, onOpenAttachments, onAskIris,
}) {
  const [allDays, setAllDays] = useState(false);
  const [showBriefing, setShowBriefing] = useState(false);
  const firstName = (username.trim().split(/\s+/)[0] || '').replace(/^./, c => c.toUpperCase());

  const stats = useMemo(() => ({
    emails: cards.length,
    threads: cards.filter(e => messageCount(e) > 1).length,
    invites: cards.filter(e => e.isMeetingInvite || (e.body || '').toLowerCase().includes('zoom.us')).length,
    files: triageStats?.att_total ?? cards.reduce((n, e) => n + (e.attachments?.length || 0), 0),
  }), [cards, triageStats]);

  const needsAttention = useMemo(() => cards
    .filter(e => !e.isRead && !e.analyzing &&
      (ATTENTION_CATEGORIES.has((e.category || '').toUpperCase()) || Number(e.priority) >= 3))
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || receivedTime(b) - receivedTime(a))
    .slice(0, MAX_ROWS), [cards]);

  const suggested = useMemo(() => cards
    .filter(e => ACTION_LABELS[(e.action || '').toUpperCase()] && !e.analyzing)
    .sort((a, b) => receivedTime(b) - receivedTime(a))
    .slice(0, MAX_ROWS), [cards]);

  const topSenders = useMemo(() => {
    const map = {};
    cards.forEach(e => {
      const s = senderOf(e);
      if (!s.key) return;
      map[s.key] = map[s.key] || { ...s, count: 0, unread: 0 };
      map[s.key].count++;
      if (!e.isRead) map[s.key].unread++;
    });
    return Object.values(map).sort((a, b) => b.count - a.count).slice(0, 5);
  }, [cards]);

  // AI thread summaries (the report's briefing cards), one per subject, each
  // linked back to its inbox card so clicking opens the conversation.
  const briefing = useMemo(() => {
    const seen = new Set();
    return (briefingCards || []).filter(c => {
      const key = (c.subject || c.topic || c.id || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(c => {
      const subject = (c.subject || '').trim().toLowerCase();
      const email = cards.find(e => String(e.id) === String(c.id) || String(e.messageId) === String(c.id))
        || (subject && cards.find(e => (e.subject || '').trim().toLowerCase() === subject));
      return { card: c, email };
    });
  }, [briefingCards, cards]);

  // AI sender summaries, looked up by address or display name.
  const senderSummaryFor = (s) => {
    const hit = (senderSummaries || []).find(x => {
      const name = (x.name || '').trim().toLowerCase();
      return name && (name === s.key || name === s.label.toLowerCase());
    });
    return hit?.summary;
  };

  const syncLabel = isSyncing
    ? 'Syncing…'
    : lastSyncTime
      ? `Synced ${new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Connected';

  const tiles = [
    { key: 'emails',  icon: Mail,           value: stats.emails,  label: 'Emails',  onClick: () => onOpenFolder?.('ALL_EMAILS', 'ALL') },
    { key: 'threads', icon: MessagesSquare, value: stats.threads, label: 'Threads', onClick: () => onOpenFolder?.('THREADS', 'ALL') },
    { key: 'invites', icon: CalendarDays,   value: stats.invites, label: 'Invites', onClick: () => onOpenFolder?.('ALL_EMAILS', 'MEETING') },
    { key: 'files',   icon: Paperclip,      value: stats.files,   label: 'Files',   onClick: onOpenAttachments },
  ];

  const days = digestData || [];
  const shownDays = allDays ? days : days.slice(0, 1);

  return (
    <section className="io">
      <header className="io-head">
        <span className="io-brand">HFMG Intelligence</span>
        <span className={`io-pill ${isSyncing ? 'io-pill-info' : 'io-pill-ok'}`}>{syncLabel}</span>
      </header>

      <div className="io-greeting">
        <h1>{greetingInfo.greeting || 'Hello'}{firstName ? `, ${firstName}` : ''}</h1>
        <span className="io-date">{greetingInfo.date}</span>
      </div>
      <p className="io-sub">Here's your email activity and priorities for today.</p>

      <div className="io-stats">
        {tiles.map(({ key, icon: Icon, value, label, onClick }) => (
          <button type="button" key={key} className="io-stat" onClick={onClick} title={`Open ${label.toLowerCase()}`}>
            <Icon size={18} className="io-stat-icon" />
            <span className="io-stat-value">{value}</span>
            <span className="io-stat-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="io-layout">
        <div className="io-card io-brief">
          <div className="io-card-head">
            <h2>AI Priority Brief</h2>
            <span className="io-pill io-pill-info">AI generated</span>
          </div>

          <div className="io-brief-section">
            <h3><AlertCircle size={17} className="io-ic-alert" /> Needs attention</h3>
            {!analysisReady && needsAttention.length === 0
              ? <p className="io-muted">Classifying your inbox…</p>
              : needsAttention.length === 0
                ? <p className="io-muted">Nothing urgent unread right now.</p>
                : needsAttention.map(e => (
                    <Row key={e.id || e.messageId} title={e.subject || 'No subject'}
                      text={e.summary} meta={(e.category || '').toUpperCase()} onClick={() => onOpenEmail?.(e)} />
                  ))}
          </div>

          <div className="io-divider" />

          <div className="io-brief-section">
            <h3><CheckCircle2 size={17} className="io-ic-ok" /> Suggested actions</h3>
            {suggested.length === 0
              ? <p className="io-muted">No replies, approvals or meetings waiting on you.</p>
              : suggested.map(e => (
                  <Row key={e.id || e.messageId} title={`${ACTION_LABELS[e.action.toUpperCase()]}: ${e.subject || 'No subject'}`}
                    meta={senderOf(e).label} onClick={() => onOpenEmail?.(e)} />
                ))}
          </div>

          <div className="io-divider" />

          <div className="io-brief-section">
            <h3><MessagesSquare size={17} className="io-ic-info" /> AI briefing
              {briefing.length > 0 && <span className="io-row-meta">{briefing.length} conversations</span>}
            </h3>
            {!reportReady && briefing.length === 0
              ? <p className="io-muted">AI is summarizing your conversations…</p>
              : briefing.length === 0
                ? <p className="io-muted">No conversation summaries yet.</p>
                : (showBriefing ? briefing : briefing.slice(0, MAX_ROWS)).map(({ card, email }) => (
                    <Row key={card.id || card.subject}
                      title={`${email && !email.isRead ? '● ' : ''}${card.subject || email?.subject || card.topic || 'No subject'}`}
                      text={card.summary || email?.summary || card.status}
                      meta={(card.category || email?.category || '').toUpperCase()}
                      onClick={() => email && onOpenEmail?.(email)} />
                  ))}
            {briefing.length > MAX_ROWS && (
              <button type="button" className="io-link" onClick={() => setShowBriefing(x => !x)}>
                {showBriefing ? 'Show less' : `View full AI briefing (${briefing.length})`}
                <ChevronDown size={14} style={{ transform: showBriefing ? 'rotate(180deg)' : 'none' }} />
              </button>
            )}
          </div>
        </div>

        <div className="io-side">
          <div className="io-card">
            <div className="io-card-head">
              <h2>Daily Digest</h2>
              <span className="io-pill io-pill-ok">Latest</span>
            </div>
            {digestLoading && days.length === 0
              ? <p className="io-muted">Loading your 7-day digest…</p>
              : days.length === 0
                ? <p className="io-muted">No digest available yet.</p>
                : shownDays.map((d, i) => (
                    <div key={d.date || i} className="io-digest-day">
                      <div className="io-digest-head">
                        <span className="io-digest-date">{dayLabel(d.date)}</span>
                        <span className="io-muted">{d.email_count} email{d.email_count !== 1 ? 's' : ''}</span>
                      </div>
                      <p className={allDays ? '' : 'io-clamp'}>{d.paragraph || 'Summary not available for this day.'}</p>
                    </div>
                  ))}
            {days.length > 1 && (
              <button type="button" className="io-link" onClick={() => setAllDays(x => !x)}>
                {allDays ? 'Show less' : `Show all ${days.length} days`}
                <ChevronDown size={14} style={{ transform: allDays ? 'rotate(180deg)' : 'none' }} />
              </button>
            )}
          </div>

          <div className="io-card">
            <div className="io-card-head">
              <h2>Sender Insights</h2>
              <span className="io-pill">Top senders</span>
            </div>
            {topSenders.length === 0
              ? <p className="io-muted">No senders yet.</p>
              : topSenders.map(s => {
                  const summary = senderSummaryFor(s);
                  return (
                    <button type="button" key={s.key} className="io-sender" onClick={() => onViewSender?.(s.key, s.label)}
                      title={`View emails from ${s.label}`}>
                      <span className="io-avatar">{s.label.charAt(0).toUpperCase()}</span>
                      <span className="io-sender-main">
                        <span className="io-row-title">{s.label}</span>
                        {summary && <span className="io-row-text">{summary}</span>}
                        <span className="io-bar"><span style={{ width: `${(s.count / topSenders[0].count) * 100}%` }} /></span>
                      </span>
                      <span className="io-row-meta">{s.count}{s.unread > 0 ? ` · ${s.unread} new` : ''}</span>
                    </button>
                  );
                })}
          </div>
        </div>
      </div>

      <button type="button" className="io-iris" onClick={onAskIris}>
        <span className="io-iris-main">
          <span className="io-iris-title"><Sparkles size={17} /> Ask Iris anything</span>
          <span className="io-muted">Summarize emails, find conversations or draft replies.</span>
        </span>
        <ArrowUpRight size={18} />
      </button>
    </section>
  );
}
