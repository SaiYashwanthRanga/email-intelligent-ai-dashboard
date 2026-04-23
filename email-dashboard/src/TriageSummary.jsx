import React, { useState, useEffect } from 'react';

// --- HELPER COMPONENT: ANIMATED COUNTER ---
const CountUp = ({ end, duration = 1500 }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let startTime = null;
    let animationFrame;

    const animate = (currentTime) => {
      if (!startTime) startTime = currentTime;
      const progress = currentTime - startTime;
      
      const percentage = Math.min(progress / duration, 1);
      const easeOut = percentage === 1 ? 1 : 1 - Math.pow(2, -10 * percentage);
      
      const currentCount = Math.floor(easeOut * end);
      setCount(currentCount);

      if (progress < duration) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        setCount(end); 
      }
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [end, duration]);

  return <span>{count}</span>;
};

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

const TriageSummary = ({ stats, realThreads, emails, report, onAttachmentClick }) => {
  if (!stats) return null;

  const { 
    vol_emails, 
    vol_meetings, 
    att_total, 
    att_breakdown,
    to = 0,
    cc = 0 
  } = stats;

  // THREADS = number of cards currently shown in the Executive Summary.
  const trueThreadCount = (report?.briefing_cards || []).length;

  // INVITES = emails that contain an actual zoom.us link in the body.
  const zoomInviteCount = (emails || []).filter(e =>
    (e.body || '').toLowerCase().includes('zoom.us')
  ).length;

  return (
    <div className="triage-glass-panel triage-premium">
      
      {/* TOP ROW */}
      <div className="triage-main-row">
        
        {/* BLOCK 1: EMAILS */}
        <div className="triage-metric-block">
          <span className="triage-label">
            <span style={emojiStyleMain}>📧</span> EMAILS
          </span>
          <span className="triage-number">
            <CountUp end={vol_emails} />
          </span>
        </div>

        <div className="triage-divider-vertical" />

        {/* BLOCK 2: THREADS */}
        <div className="triage-metric-block">
          <span className="triage-label">
            <span style={emojiStyleMain}>🧵</span> THREADS
          </span>
          <span className="triage-number">
            <CountUp end={trueThreadCount} />
          </span>
        </div>

        <div className="triage-divider-vertical" />

        {/* BLOCK 3: INVITES */}
        <div className="triage-metric-block">
          <span className="triage-label">
            <span style={emojiStyleMain}>📅</span> INVITES
          </span>
          <span className="triage-number">
            <CountUp end={zoomInviteCount} />
          </span>
        </div>

      </div>

      {/* SECOND ROW */}
      <div className="triage-sub-row">
        <div className="triage-sub-left">
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