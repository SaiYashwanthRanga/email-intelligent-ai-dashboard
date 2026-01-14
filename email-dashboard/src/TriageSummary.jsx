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

const TriageSummary = ({ stats, realThreads, emails }) => {
  if (!stats) return null;

  const { 
    vol_emails, 
    vol_threads, 
    vol_meetings, 
    total_unread, 
    att_total, 
    att_breakdown,
    // New props from Dashboard.js logic
    to = 0,
    cc = 0 
  } = stats;

  return (
  <div className="triage-glass-panel triage-premium">
    
    {/* TOP ROW */}
    <div className="triage-main-row">
      <div className="triage-metric-block">
        <span className="triage-label">EMAILS</span>
        <span className="triage-number">
          <CountUp end={vol_emails} />
        </span>
      </div>

      <div className="triage-divider-vertical" />

      <div className="triage-metric-block">
        <span className="triage-label">THREADS</span>
        <span className="triage-number">
          <CountUp end={realThreads?.length || 0} />
        </span>
      </div>

      <div className="triage-divider-vertical" />

      <div className="triage-metric-block">
        <span className="triage-label">MEETINGS</span>
        <span className="triage-number">
          <CountUp end={vol_meetings} />
        </span>
      </div>

      <div className="triage-divider-vertical thick" />

      <div className="triage-total-block">
        <span className="triage-total-number">
          <CountUp end={total_unread} />
        </span>
        <span className="triage-total-text">NEW UNREAD</span>
      </div>
    </div>

    {/* SECOND ROW */}
    <div className="triage-sub-row">
      <div className="triage-sub-left">
        <span className="triage-sub-label">ATTACHMENTS</span>
        <span className="triage-sub-value">
          <CountUp end={att_total} />
        </span>

        {att_total > 0 && (
          <div className="triage-file-breakdown">
            {Object.entries(att_breakdown).map(([type, count]) => (
              <span key={type}>
                {type} <strong>{count}</strong>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="triage-sub-right">
        <span>
          TO <strong><CountUp end={to} /></strong>
        </span>
        <span className="triage-sub-sep">|</span>
        <span>
          CC <strong><CountUp end={cc} /></strong>
        </span>
      </div>
    </div>
  </div>
);
};

export default TriageSummary;