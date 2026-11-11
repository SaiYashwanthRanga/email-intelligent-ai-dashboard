import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mail, CalendarDays, Paperclip, AlertCircle, CheckCircle2, Sparkles, ArrowUpRight,
  ChevronDown, RefreshCw, Loader2, Check, Inbox, Clock, Send, MessagesSquare, BarChart3,
} from 'lucide-react';
import { askIris, RichText } from './Iris';
import { fetchTrackerSummary } from './tracker/api/trackerApi';
import './InsightsOverview.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Categories that put an unread card into "Needs attention".
const ATTENTION_CATEGORIES = new Set(['URGENT', 'PRIORITY', 'VIP', 'LEGAL', 'CONFIDENTIAL']);
// AI-suggested actions worth surfacing (REVIEW/READ/FYI are the default "nothing to do"),
// with what Iris is asked to do when the button is pressed.
const ACTIONS = {
  REPLY:    { label: 'Reply',    button: 'Draft reply',    prompt: 'Draft a reply to this email.' },
  APPROVE:  { label: 'Approve',  button: 'Draft approval', prompt: 'Read this email and draft a reply approving what is being asked. Tell me first, in one line, what I would be approving.' },
  CONFIRM:  { label: 'Confirm',  button: 'Draft confirmation', prompt: 'Read this email and draft a short reply confirming it.' },
  SCHEDULE: { label: 'Schedule', button: 'Find a time',    prompt: 'Read this email, check my calendar for the next few days, and draft a reply proposing times that work for me.' },
};
const MAX_ROWS = 4;
const BRIEF_TTL_MS = 30 * 60 * 1000;   // the AI brief is reused for half an hour

// What the executive brief asks Iris for. Iris runs its bulk tool over the
// recent mail and reports how many emails the brief covers.
const BRIEF_PROMPT =
  'Prepare my executive brief for right now. Use summarize_emails over the last 7 days with the focus ' +
  '"what needs a decision, reply or approval from me, any deadlines, and anything risky or unusual". ' +
  'Then write it in exactly this shape:\n' +
  '1. One sentence: the bottom line for today.\n' +
  '2. **Decide today** — up to 5 bullets, each "Sender — what is needed — by when". Leave out anything I have already replied to.\n' +
  '3. **Keep an eye on** — up to 3 bullets.\n' +
  '4. **For information** — up to 3 bullets.\n' +
  'Be specific: real names, dates and figures. Skip a section that has nothing in it. ' +
  'Finish with one short line saying how many emails this covers.';

const IRIS_PROMPTS = [
  'What needs my decision today?',
  'Who is waiting on a reply from me?',
  'Catch me up since yesterday',
  "What's on my calendar this week?",
];

const idOf = (e) => e?.messageId || e?.id || '';
const getUserEmail = () => { try { return localStorage.getItem('userEmail') || ''; } catch { return ''; } };

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

// "12m", "3h", "2d" — how long an email has been sitting there.
const ageOf = (e) => {
  const t = receivedTime(e);
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
};

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

const localIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const timeLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

// Hand Iris a task. With an email, Iris treats the request as being about it.
const askIrisTo = (prompt, email) => {
  window.dispatchEvent(new CustomEvent('iris:ask', { detail: { prompt, emailId: idOf(email) || undefined } }));
};

// ── AI brief cache (per user, this browser tab) ────────────────────────────
const briefKey = () => `insights:brief:${getUserEmail()}`;
const loadBrief = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(briefKey()) || 'null');
    return saved?.text ? saved : null;
  } catch { return null; }
};
const saveBrief = (brief) => { try { sessionStorage.setItem(briefKey(), JSON.stringify(brief)); } catch { /* storage unavailable */ } };

// ── Small pieces ───────────────────────────────────────────────────────────
function EmailRow({ email, actionLabel, onOpen, primary }) {
  const sender = senderOf(email);
  const category = (email.category || '').toUpperCase();
  return (
    <div className="io-item">
      <button type="button" className="io-item-main" onClick={onOpen} title="Open this email">
        <span className="io-avatar">{sender.label.charAt(0).toUpperCase()}</span>
        <span className="io-item-text">
          <span className="io-item-title">
            {!email.isRead && <span className="io-dot" aria-label="Unread" />}
            {actionLabel ? `${actionLabel}: ` : ''}{email.subject || 'No subject'}
          </span>
          <span className="io-item-meta">{sender.label}{ageOf(email) ? ` · ${ageOf(email)}` : ''}</span>
          {email.summary && <span className="io-item-summary">{email.summary}</span>}
        </span>
      </button>
      <span className="io-item-side">
        {category && category !== 'NORMAL' && <span className={`cat-tag ${category.toLowerCase()}`}>{category}</span>}
        {primary && (
          <button type="button" className="io-btn io-btn-ai" onClick={primary.onClick} title="Iris prepares it; nothing is sent until you confirm">
            <Sparkles size={13} /> {primary.label}
          </button>
        )}
      </span>
    </div>
  );
}

// Seven-day volume. One series, one hue; today is the solid bar.
function WeekChart({ days }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((n, d) => n + d.count, 0);
  const shown = hover ?? days.length - 1;
  return (
    <div className="io-week" role="img" aria-label={`Emails per day over the last ${days.length} days, ${total} in total`}>
      <div className="io-week-readout">
        <span className="io-week-value">{days[shown]?.count ?? 0}</span>
        <span className="io-muted">{days[shown] ? `emails · ${dayLabel(days[shown].date)}` : ''}</span>
      </div>
      <div className="io-week-bars" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <button type="button" key={d.date} className={`io-week-col ${i === shown ? 'is-on' : ''}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
            aria-label={`${dayLabel(d.date)}: ${plural(d.count, 'email')}`}>
            <span className="io-week-track">
              <span className="io-week-bar" style={{ height: `${Math.max(d.count ? 6 : 0, (d.count / max) * 100)}%` }} />
            </span>
            <span className="io-week-day">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Insights overview — the executive's landing page.
 *
 *  • Hero: greeting, a one-line bottom line computed from the inbox, and
 *    one-click questions for Iris.
 *  • Decision tiles: needs attention / awaiting your action / unread /
 *    meetings today / waiting on replies (Reply Tracker).
 *  • AI executive brief: written by Iris over the last 7 days of mail
 *    (bulk summarise), cached for 30 minutes, refreshable.
 *  • Needs attention + suggested actions: each row can hand the email to
 *    Iris ("Draft reply") — Iris prepares, the person confirms.
 *  • This week (volume + category mix), today's schedule, waiting on
 *    replies, daily digest, top senders, conversation summaries.
 *
 * Counts are computed from the cards the Inbox shows (one per conversation),
 * so they match the Inbox's folder counts.
 */
export default function InsightsOverview({
  cards = [], triageStats, username = '', greetingInfo = {}, digestData = [], digestLoading = false,
  briefingCards = [], senderSummaries = [], reportReady = true,
  lastSyncTime, isSyncing, analysisReady = true,
  onOpenEmail, onViewSender, onOpenFolder, onOpenAttachments, onAskIris, onNavigate,
}) {
  const [allDays, setAllDays] = useState(false);
  const [showBriefing, setShowBriefing] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const firstName = (username.trim().split(/\s+/)[0] || '').replace(/^./, c => c.toUpperCase());

  // ── Inbox-derived lists ──
  const attention = useMemo(() => cards
    .filter(e => !e.isRead && !e.analyzing &&
      (ATTENTION_CATEGORIES.has((e.category || '').toUpperCase()) || Number(e.priority) >= 3))
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || receivedTime(b) - receivedTime(a)),
  [cards]);

  const suggested = useMemo(() => cards
    .filter(e => ACTIONS[(e.action || '').toUpperCase()] && !e.analyzing)
    .sort((a, b) => Number(!!a.isRead) - Number(!!b.isRead) || receivedTime(b) - receivedTime(a)),
  [cards]);

  const unread = triageStats?.total_unread ?? cards.filter(e => !e.isRead).length;
  const files = triageStats?.att_total ?? cards.reduce((n, e) => n + (e.attachments?.length || 0), 0);

  const categoryMix = useMemo(() => {
    const counts = {};
    cards.forEach(e => {
      const c = (e.category || 'NORMAL').toUpperCase();
      counts[c] = (counts[c] || 0) + 1;
    });
    return Object.entries(counts).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 6);
  }, [cards]);

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

  const senderSummaryFor = (s) => {
    const hit = (senderSummaries || []).find(x => {
      const name = (x.name || '').trim().toLowerCase();
      return name && (name === s.key || name === s.label.toLowerCase());
    });
    return hit?.summary;
  };

  // Oldest → newest, last 7 days that have a date.
  const week = useMemo(() => (digestData || [])
    .filter(d => d?.date)
    .map(d => ({ date: d.date, count: Number(d.email_count) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7), [digestData]);

  // ── Today's meetings (calendar) ──
  const [meetings, setMeetings] = useState(null);   // null = not loaded / unavailable
  useEffect(() => {
    const user = getUserEmail();
    if (!user) return undefined;
    const ctrl = new AbortController();
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    fetch(`${API_BASE}/meetings?email=${encodeURIComponent(user)}&startDate=${localIsoDate(today)}&endDate=${localIsoDate(tomorrow)}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(list => {
        const todayStr = today.toDateString();
        setMeetings((Array.isArray(list) ? list : [])
          .filter(m => m && !m.isCancelled && m.start && new Date(m.start).toDateString() === todayStr)
          .sort((a, b) => new Date(a.start) - new Date(b.start)));
      })
      .catch(() => { /* calendar unreachable — the tile and card simply don't show */ });
    return () => ctrl.abort();
  }, []);

  // ── Waiting on replies (Reply Tracker) ──
  const [tracker, setTracker] = useState(null);     // null = not available for this user
  useEffect(() => {
    const user = getUserEmail();
    if (!user) return undefined;
    const ctrl = new AbortController();
    fetchTrackerSummary(user, { signal: ctrl.signal })
      // A mailbox the tracker doesn't follow comes back with zero emails — hide the card.
      .then(s => setTracker(s?.recipients && s.emails_tracked > 0 ? s : null))
      .catch(() => { /* no tracker access or tracker down — card stays hidden */ });
    return () => ctrl.abort();
  }, []);
  const waiting = tracker ? (tracker.recipients.awaiting || 0) + (tracker.recipients.overdue || 0) : 0;
  const overdue = tracker?.recipients.overdue || 0;

  // ── AI executive brief ──
  const [brief, setBrief] = useState(loadBrief);
  const [briefState, setBriefState] = useState('idle');   // idle | loading | error
  const [briefSteps, setBriefSteps] = useState([]);
  const [briefError, setBriefError] = useState('');
  const briefStarted = useRef(false);

  const generateBrief = async () => {
    if (briefState === 'loading') return;
    setBriefState('loading');
    setBriefSteps([]);
    setBriefError('');
    try {
      const result = await askIris({
        message: BRIEF_PROMPT,
        history: [],
        user_name: username || 'User',
        user_email: getUserEmail() || 'default',
        inbox_context: null,
        focus_message_id: null,
      }, (label) => setBriefSteps(prev => (prev[prev.length - 1] === label ? prev : [...prev, label])));
      const text = (result.reply || '').trim();
      if (!text) throw new Error('Iris returned an empty brief.');
      const fresh = { text, at: Date.now() };
      setBrief(fresh);
      saveBrief(fresh);
      setBriefState('idle');
    } catch (err) {
      setBriefError(err?.message || "Couldn't prepare the brief just now.");
      setBriefState('error');
    }
  };

  // Write the brief once the inbox is classified, unless a recent one exists.
  useEffect(() => {
    if (briefStarted.current || !analysisReady || cards.length === 0) return;
    briefStarted.current = true;
    if (!brief || Date.now() - (brief.at || 0) > BRIEF_TTL_MS) generateBrief();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisReady, cards.length]);

  // ── Hero bottom line (computed, not generated — instant and exact) ──
  const bottomLine = (() => {
    if (!analysisReady && attention.length === 0) return 'Reading and classifying your inbox…';
    const parts = [];
    if (attention.length) parts.push(`${plural(attention.length, 'email')} need${attention.length === 1 ? 's' : ''} your attention`);
    if (suggested.length) parts.push(`${plural(suggested.length, 'action')} ${suggested.length === 1 ? 'is' : 'are'} waiting on you`);
    if (meetings?.length) parts.push(`${plural(meetings.length, 'meeting')} today`);
    if (overdue) parts.push(`${plural(overdue, 'person', 'people')} overdue replying to you`);
    if (parts.length === 0) return "You're clear — nothing urgent is waiting on you right now.";
    const last = parts.pop();
    return `${parts.length ? `${parts.join(', ')} and ` : ''}${last}.`.replace(/^./, c => c.toUpperCase());
  })();

  const syncLabel = isSyncing
    ? 'Syncing…'
    : lastSyncTime
      ? `Synced ${new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Connected';

  const tiles = [
    { key: 'attention', icon: AlertCircle, value: attention.length, label: 'Need attention', tone: attention.length ? 'alert' : '',
      hint: 'Unread urgent, priority, VIP, legal or confidential', onClick: () => onOpenFolder?.('ALL_EMAILS', 'ALL') },
    { key: 'actions', icon: CheckCircle2, value: suggested.length, label: 'Awaiting your action', tone: suggested.length ? 'warn' : '',
      hint: 'Replies, approvals, confirmations and scheduling', onClick: () => document.getElementById('io-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    { key: 'unread', icon: Inbox, value: unread, label: 'Unread', hint: 'Open the inbox', onClick: () => onOpenFolder?.('ALL_EMAILS', 'ALL') },
    meetings
      ? { key: 'meetings', icon: CalendarDays, value: meetings.length, label: 'Meetings today', hint: 'Open the calendar', onClick: () => onNavigate?.('/calendar') }
      : { key: 'files', icon: Paperclip, value: files, label: 'Attachments', hint: 'Browse attachments', onClick: onOpenAttachments },
    tracker
      ? { key: 'waiting', icon: Send, value: waiting, label: 'Waiting on replies', tone: overdue ? 'alert' : '',
          sub: overdue ? `${overdue} overdue` : '', hint: 'Open the Reply Tracker', onClick: () => onNavigate?.('/tracker') }
      : null,
  ].filter(Boolean);

  const days = digestData || [];
  const shownDays = allDays ? days : days.slice(0, 1);
  const attentionRows = showAllAttention ? attention : attention.slice(0, MAX_ROWS);
  const mixMax = Math.max(1, ...categoryMix.map(c => c.count));

  return (
    <section className="io">
      {/* ── Hero ── */}
      <div className="io-hero">
        <header className="io-head">
          <span className="io-brand">HFMG Intelligence</span>
          <span className={`io-pill ${isSyncing ? 'io-pill-info' : 'io-pill-ok'}`}>{syncLabel}</span>
        </header>
        <div className="io-greeting">
          <h1>{greetingInfo.greeting || 'Hello'}{firstName ? `, ${firstName}` : ''}</h1>
          <span className="io-date">{greetingInfo.date}</span>
        </div>
        <p className="io-bottomline">{bottomLine}</p>
        <div className="io-prompts">
          <button type="button" className="io-prompt io-prompt-main" onClick={onAskIris}><Sparkles size={14} /> Ask Iris</button>
          {IRIS_PROMPTS.map(p => (
            <button type="button" key={p} className="io-prompt" onClick={() => askIrisTo(p)}>{p}</button>
          ))}
        </div>
      </div>

      {/* ── Decision tiles ── */}
      <div className="io-stats" style={{ '--io-cols': tiles.length }}>
        {tiles.map(({ key, icon: Icon, value, label, tone, sub, hint, onClick }) => (
          <button type="button" key={key} className={`io-stat ${tone ? `io-stat-${tone}` : ''}`} onClick={onClick} title={hint}>
            <Icon size={18} className="io-stat-icon" />
            <span className="io-stat-value">{value}</span>
            <span className="io-stat-label">{label}{sub && <em> · {sub}</em>}</span>
          </button>
        ))}
      </div>

      <div className="io-layout">
        <div className="io-main">
          {/* ── AI executive brief ── */}
          <div className="io-card io-exec">
            <div className="io-card-head">
              <h2><Sparkles size={17} className="io-ic-info" /> AI Executive Brief</h2>
              <span className="io-head-actions">
                {brief && briefState !== 'loading' && (
                  <span className="io-muted">Written {new Date(brief.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                )}
                <button type="button" className="io-btn" onClick={generateBrief} disabled={briefState === 'loading'} title="Have Iris re-read your recent mail and rewrite the brief">
                  {briefState === 'loading' ? <Loader2 size={13} className="io-spin" /> : <RefreshCw size={13} />}
                  {briefState === 'loading' ? 'Writing…' : 'Refresh'}
                </button>
              </span>
            </div>

            {briefState === 'loading' && (
              <div className="io-exec-progress">
                {(briefSteps.length ? briefSteps : ['Starting']).map((step, i, arr) => (
                  <div key={`${step}-${i}`} className={i === arr.length - 1 ? 'is-current' : ''}>
                    {i === arr.length - 1 ? <Loader2 size={13} className="io-spin" /> : <Check size={13} />} {step}{i === arr.length - 1 ? '…' : ''}
                  </div>
                ))}
              </div>
            )}
            {briefState === 'error' && <p className="io-exec-error">{briefError}</p>}
            {brief && briefState !== 'loading' && (
              <>
                <div className="io-exec-body"><RichText text={brief.text} /></div>
                <button type="button" className="io-link" onClick={() => askIrisTo('Going by the executive brief you just wrote: which of these should I deal with first, and why? Then offer to draft the reply.')}>
                  Discuss this with Iris <ArrowUpRight size={14} />
                </button>
              </>
            )}
            {!brief && briefState === 'idle' && (
              <p className="io-muted">{analysisReady ? 'No brief yet — press Refresh to have Iris write one.' : 'Iris will write your brief as soon as the inbox is classified.'}</p>
            )}
          </div>

          {/* ── Needs attention ── */}
          <div className="io-card">
            <div className="io-card-head">
              <h2><AlertCircle size={17} className="io-ic-alert" /> Needs your attention</h2>
              {attention.length > 0 && <span className="io-pill">{attention.length}</span>}
            </div>
            {!analysisReady && attention.length === 0
              ? <p className="io-muted">Classifying your inbox…</p>
              : attention.length === 0
                ? <p className="io-muted">Nothing urgent is unread right now.</p>
                : attentionRows.map(e => (
                    <EmailRow key={idOf(e)} email={e} onOpen={() => onOpenEmail?.(e)}
                      primary={{ label: 'Draft reply', onClick: () => { onOpenEmail?.(e); askIrisTo('Read this email and draft a reply. Start with one line on what they need from me.', e); } }} />
                  ))}
            {attention.length > MAX_ROWS && (
              <button type="button" className="io-link" onClick={() => setShowAllAttention(x => !x)}>
                {showAllAttention ? 'Show less' : `Show all ${attention.length}`}
                <ChevronDown size={14} style={{ transform: showAllAttention ? 'rotate(180deg)' : 'none' }} />
              </button>
            )}
          </div>

          {/* ── Suggested actions ── */}
          <div className="io-card" id="io-actions">
            <div className="io-card-head">
              <h2><CheckCircle2 size={17} className="io-ic-ok" /> Suggested actions</h2>
              <span className="io-pill io-pill-info">AI suggested</span>
            </div>
            {suggested.length === 0
              ? <p className="io-muted">No replies, approvals or meetings waiting on you.</p>
              : suggested.slice(0, MAX_ROWS + 2).map(e => {
                  const action = ACTIONS[e.action.toUpperCase()];
                  return (
                    <EmailRow key={idOf(e)} email={e} actionLabel={action.label} onOpen={() => onOpenEmail?.(e)}
                      primary={{ label: action.button, onClick: () => { onOpenEmail?.(e); askIrisTo(action.prompt, e); } }} />
                  );
                })}
            {suggested.length > MAX_ROWS + 2 && (
              <p className="io-muted io-more">+ {suggested.length - (MAX_ROWS + 2)} more — ask Iris “what else is waiting on me?”</p>
            )}
          </div>

          {/* ── Conversation summaries ── */}
          <div className="io-card">
            <div className="io-card-head">
              <h2><MessagesSquare size={17} className="io-ic-info" /> Conversations</h2>
              {briefing.length > 0 && <span className="io-pill">{briefing.length}</span>}
            </div>
            {!reportReady && briefing.length === 0
              ? <p className="io-muted">AI is summarizing your conversations…</p>
              : briefing.length === 0
                ? <p className="io-muted">No conversation summaries yet.</p>
                : (showBriefing ? briefing : briefing.slice(0, MAX_ROWS)).map(({ card, email }) => {
                    const category = (card.category || email?.category || '').toUpperCase();
                    return (
                      <button type="button" key={card.id || card.subject} className="io-row" onClick={() => email && onOpenEmail?.(email)}>
                        <span className="io-row-main">
                          <span className="io-row-title">
                            {email && !email.isRead && <span className="io-dot" aria-label="Unread" />}
                            {card.subject || email?.subject || card.topic || 'No subject'}
                          </span>
                          <span className="io-row-text">{card.summary || email?.summary || card.status}</span>
                        </span>
                        {category && category !== 'NORMAL' && <span className={`cat-tag ${category.toLowerCase()}`}>{category}</span>}
                      </button>
                    );
                  })}
            {briefing.length > MAX_ROWS && (
              <button type="button" className="io-link" onClick={() => setShowBriefing(x => !x)}>
                {showBriefing ? 'Show less' : `View all ${briefing.length} conversations`}
                <ChevronDown size={14} style={{ transform: showBriefing ? 'rotate(180deg)' : 'none' }} />
              </button>
            )}
          </div>
        </div>

        <div className="io-side">
          {/* ── This week ── */}
          <div className="io-card">
            <div className="io-card-head">
              <h2><BarChart3 size={17} className="io-ic-info" /> This week</h2>
              <span className="io-pill">{plural(cards.length, 'conversation')}</span>
            </div>
            {week.length > 1 ? <WeekChart days={week} /> : <p className="io-muted">{digestLoading ? 'Loading the last 7 days…' : 'Daily volume appears once a few days of mail are in.'}</p>}

            {categoryMix.length > 0 && (
              <div className="io-mix">
                <div className="io-mix-title">By category</div>
                {categoryMix.map(c => (
                  <button type="button" key={c.name} className="io-mix-row" onClick={() => onOpenFolder?.('ALL_EMAILS', c.name)} title={`Open ${c.name.toLowerCase()} emails`}>
                    <span className="io-mix-name">{c.name.charAt(0) + c.name.slice(1).toLowerCase()}</span>
                    <span className="io-bar"><span style={{ width: `${(c.count / mixMax) * 100}%` }} /></span>
                    <span className="io-mix-count">{c.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Today's schedule ── */}
          {meetings && (
            <div className="io-card">
              <div className="io-card-head">
                <h2><CalendarDays size={17} className="io-ic-info" /> Today's schedule</h2>
                <button type="button" className="io-btn" onClick={() => onNavigate?.('/calendar')}>Calendar <ArrowUpRight size={13} /></button>
              </div>
              {meetings.length === 0
                ? <p className="io-muted">No meetings today.</p>
                : meetings.slice(0, 5).map((m, i) => {
                    const past = m.end && new Date(m.end) < new Date();
                    return (
                      <div key={m.id || m.meetingId || i} className={`io-meeting ${past ? 'is-past' : ''}`}>
                        <span className="io-meeting-time"><Clock size={12} /> {timeLabel(m.start)}</span>
                        <span className="io-row-main">
                          <span className="io-row-title">{m.subject || 'No title'}</span>
                          {m.organizer && <span className="io-row-text">{m.organizer}</span>}
                        </span>
                      </div>
                    );
                  })}
              {meetings.length > 0 && (
                <button type="button" className="io-link" onClick={() => askIrisTo("Look at today's meetings on my calendar and tell me what I should know or prepare for each, using related emails.")}>
                  Prep me for today <Sparkles size={13} />
                </button>
              )}
            </div>
          )}

          {/* ── Waiting on replies ── */}
          {tracker && (
            <div className="io-card">
              <div className="io-card-head">
                <h2><Send size={17} className="io-ic-info" /> Waiting on replies</h2>
                <button type="button" className="io-btn" onClick={() => onNavigate?.('/tracker')}>Tracker <ArrowUpRight size={13} /></button>
              </div>
              <div className="io-trio">
                <div><strong>{tracker.recipients.awaiting || 0}</strong><span>Awaiting</span></div>
                <div className={overdue ? 'is-alert' : ''}><strong>{overdue}</strong><span>Overdue</span></div>
                <div><strong>{tracker.recipients.replied || 0}</strong><span>Replied</span></div>
              </div>
              <p className="io-muted">Emails you sent in the last {tracker.lookback_days} days, by whether the recipient has answered.</p>
            </div>
          )}

          {/* ── Daily digest ── */}
          <div className="io-card">
            <div className="io-card-head">
              <h2><Mail size={17} className="io-ic-info" /> Daily Digest</h2>
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

          {/* ── Top senders ── */}
          <div className="io-card">
            <div className="io-card-head">
              <h2>Top senders</h2>
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
    </section>
  );
}
