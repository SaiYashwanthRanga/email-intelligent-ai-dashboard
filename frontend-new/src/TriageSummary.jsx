import React from 'react';
import { isMeetingInvite } from './meetingInvite';

// Stats render as plain numbers. This used to be a requestAnimationFrame
// counter that tweened 0 → value, but its effect re-ran on every value
// change — so a background auto-sync made every figure on the page spin up
// from zero again, which read as the dashboard reloading itself.
const CountUp = ({ end }) => <span>{Number.isFinite(end) ? end : 0}</span>;

// --- FILE TYPE ICONS MAP ---
const FILE_ICONS = {
  pdf: "📕",
  xlsx: "📊",
  xls: "📊",
  docx: "📄",
  doc: "📄",
  ppt: "PY",
  pptx: "PY",
  png: "🖼",
  jpg: "🖼",
  jpeg: "🖼",
  csv: "📑",
  zip: "🗜",
  txt: "📝",
  rar: "🗜"
};

// --- STYLES FOR BIGGER EMOJIS ---
const emojiStyleMain = { fontSize: "1.4rem", marginRight: "6px", verticalAlign: "middle" };
const emojiStyleSub = { fontSize: "1.2rem", marginRight: "5px", verticalAlign: "middle" };

const TriageSummary = ({ stats, emails, report, threadCount, onAttachmentClick, onThreadsClick, onEmailsClick, onInvitesClick }) => {
  if (!stats) return null;

  const {
    vol_emails,
    att_total,
    att_breakdown,
    to = 0,
    cc = 0
  } = stats;

  // THREADS = real multi-message threads, which is exactly what the THREADS
  // folder shows when you click this tile. It used to count
  // report.briefing_cards instead — AI summary cards, a different set from
  // both the label and the click destination, and one the list below
  // deduped further before rendering.
  const trueThreadCount = threadCount ?? (report?.briefing_cards || []).length;

  // INVITES = real meeting invites, via the shared predicate the inbox
  // filter and the RSVP bar also use (see meetingInvite.js). The old check
  // scanned e.body for "zoom.us" only: it missed Teams/Meet/Webex/.ics
  // entirely, and — because cached emails have no body — undercounted more
  // and more the longer a session ran.
  const inviteCount = (emails || []).filter(isMeetingInvite).length;

  return (
    <div className="triage-glass-panel triage-premium">
      
      {/* TOP ROW */}
      <div className="triage-main-row">
        
        {/* BLOCK 1: EMAILS */}
        <div
          className="triage-metric-block"
          onClick={onEmailsClick}
          title="View all emails in Inbox"
          style={onEmailsClick ? { cursor: 'pointer' } : {}}
        >
          <span className="triage-label">
            <span style={emojiStyleMain}>📧</span> EMAILS
          </span>
          <span className="triage-number" style={{}}>
            <CountUp end={vol_emails} />
          </span>
        </div>

        <div className="triage-divider-vertical" />

        {/* BLOCK 2: THREADS */}
        <div
          className="triage-metric-block"
          onClick={onThreadsClick}
          title="View all threads in Inbox"
          style={onThreadsClick ? { cursor: 'pointer' } : {}}
        >
          <span className="triage-label">
            <span style={emojiStyleMain}>🧵</span> THREADS
          </span>
          <span className="triage-number" style={{}}>
            <CountUp end={trueThreadCount} />
          </span>
        </div>

        <div className="triage-divider-vertical" />

        {/* BLOCK 3: INVITES */}
        <div
          className="triage-metric-block"
          onClick={onInvitesClick}
          title="View meeting invites in Inbox"
          style={onInvitesClick ? { cursor: 'pointer' } : {}}
        >
          <span className="triage-label">
            <span style={emojiStyleMain}>📅</span> INVITES
          </span>
          <span className="triage-number" style={{}}>
            <CountUp end={inviteCount} />
          </span>
        </div>

      </div>

      {/* SECOND ROW */}
      <div className="triage-sub-row">
        {/* onAttachmentClick was being passed in but never wired to anything,
            so this stat looked clickable-adjacent yet did nothing while every
            tile above it opened a view. It opens the all-attachments modal. */}
        <div
          className="triage-sub-left"
          onClick={onAttachmentClick}
          title={onAttachmentClick ? "View all attachments" : undefined}
          style={onAttachmentClick ? { cursor: 'pointer' } : {}}
        >
          <span className="triage-sub-label">
            <span style={emojiStyleSub}>📎</span> ATTACHMENTS
          </span>

          <span className="triage-sub-value">
            <CountUp end={att_total} />
          </span>

          {att_total > 0 && (
            <div className="triage-file-breakdown">
              {Object.entries(att_breakdown).map(([type, count]) => {
                const icon = FILE_ICONS[type.toLowerCase()] || "🗂";
                return (
                  <span key={type}>
                    <span style={{ fontSize: "1.1rem", marginRight: "3px" }}>{icon}</span> {type} <strong>{count}</strong>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="triage-sub-right">
          <span>
            <span style={emojiStyleSub}>📤</span> TO <strong><CountUp end={to} /></strong>
          </span>
          <span className="triage-sub-sep">|</span>
          <span>
            <span style={emojiStyleSub}>👥</span> CC <strong><CountUp end={cc} /></strong>
          </span>
        </div>
      </div>
    </div>
  );
};

export default TriageSummary;