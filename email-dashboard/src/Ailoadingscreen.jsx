import React, { useState, useEffect, useRef } from 'react';

// ── Phases that play out in sequence while the AI works ──
const PHASES = [
  {
    icon: '📥',
    label: 'Fetching inbox',
    steps: [
      'Connecting to mail server...',
      'Downloading email headers...',
      'Retrieving message bodies...',
      'Collecting attachments metadata...',
    ],
  },
  {
    icon: '🧠',
    label: 'AI analysis',
    steps: [
      'Reading subject lines & senders...',
      'Detecting priority & urgency signals...',
      'Identifying VIP senders...',
      'Scanning for Zoom links & meeting requests...',
      'Classifying confidential content...',
      'Grouping related threads...',
    ],
  },
  {
    icon: '📊',
    label: 'Building your brief',
    steps: [
      'Summarising email threads...',
      'Drafting executive briefing cards...',
      'Compiling sender intelligence...',
      'Calculating triage statistics...',
      'Sorting by priority & recency...',
    ],
  },
  {
    icon: '✅',
    label: 'Almost ready',
    steps: [
      'Finalising your dashboard...',
      'Your inbox is ready.',
    ],
  },
];

// Fun facts shown at the bottom while waiting
const FACTS = [
  'Executives receive an average of 120 emails per day.',
  'AI triage can reduce inbox review time by up to 60%.',
  'Priority detection checks sender history, keywords & timing.',
  'Thread analysis reconstructs full conversation context.',
  'VIP senders are always surfaced at the top of your inbox.',
  'Attachments are catalogued and searchable across all emails.',
  'Executive briefs are regenerated only when new mail arrives.',
];

export default function AILoadingScreen({ emailCount = 0 }) {
  const [phaseIdx, setPhaseIdx]   = useState(0);
  const [stepIdx, setStepIdx]     = useState(0);
  const [progress, setProgress]   = useState(0);
  const [factIdx, setFactIdx]     = useState(0);
  const [counted, setCounted]     = useState(0);
  const [dots, setDots]           = useState('');
  const [fadingFact, setFadingFact] = useState(false);

  const stepTimerRef  = useRef(null);
  const factTimerRef  = useRef(null);
  const dotsTimerRef  = useRef(null);
  const countTimerRef = useRef(null);

  // ── Animate email counter ──
  useEffect(() => {
    if (!emailCount) return;
    let current = 0;
    const step = Math.max(1, Math.floor(emailCount / 40));
    countTimerRef.current = setInterval(() => {
      current = Math.min(current + step, emailCount);
      setCounted(current);
      if (current >= emailCount) clearInterval(countTimerRef.current);
    }, 40);
    return () => clearInterval(countTimerRef.current);
  }, [emailCount]);

  // ── Animate the cursor dots ──
  useEffect(() => {
    dotsTimerRef.current = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 400);
    return () => clearInterval(dotsTimerRef.current);
  }, []);

  // ── Step through phases & steps, drive progress bar ──
  useEffect(() => {
    const totalSteps = PHASES.reduce((s, p) => s + p.steps.length, 0);
    let globalStep = 0;

    // Count steps before current phase
    for (let i = 0; i < phaseIdx; i++) globalStep += PHASES[i].steps.length;
    globalStep += stepIdx;

    const targetProgress = Math.round((globalStep / totalSteps) * 100);

    // Smoothly increment progress
    const progressTimer = setInterval(() => {
      setProgress(p => {
        if (p >= targetProgress) { clearInterval(progressTimer); return p; }
        return p + 1;
      });
    }, 18);

    // Advance to next step after a delay
    const currentPhase = PHASES[phaseIdx];
    const delay = phaseIdx === PHASES.length - 1 ? 1800 : 900 + Math.random() * 600;

    stepTimerRef.current = setTimeout(() => {
      if (stepIdx < currentPhase.steps.length - 1) {
        setStepIdx(s => s + 1);
      } else if (phaseIdx < PHASES.length - 1) {
        setPhaseIdx(p => p + 1);
        setStepIdx(0);
      }
      // If on the last step of last phase — stay there (real loading will finish)
    }, delay);

    return () => {
      clearTimeout(stepTimerRef.current);
      clearInterval(progressTimer);
    };
  }, [phaseIdx, stepIdx]);

  // ── Rotate fun facts every 4 seconds ──
  useEffect(() => {
    factTimerRef.current = setInterval(() => {
      setFadingFact(true);
      setTimeout(() => {
        setFactIdx(i => (i + 1) % FACTS.length);
        setFadingFact(false);
      }, 400);
    }, 4000);
    return () => clearInterval(factTimerRef.current);
  }, []);

  const currentPhase = PHASES[phaseIdx];
  const currentStep  = currentPhase.steps[stepIdx];

  return (
    <div style={s.container}>

      {/* ── Header ── */}
      <div style={s.header}>
        <div style={s.headerDot} />
        <span style={s.headerLabel}>AI ENGINE ACTIVE</span>
      </div>

      {/* ── Main card ── */}
      <div style={s.card}>

        {/* Phase tabs */}
        <div style={s.phaseTabs}>
          {PHASES.map((p, i) => (
            <div key={i} style={{
              ...s.phaseTab,
              ...(i < phaseIdx  ? s.phaseTabDone    : {}),
              ...(i === phaseIdx ? s.phaseTabActive  : {}),
              ...(i > phaseIdx  ? s.phaseTabPending : {}),
            }}>
              <span style={s.phaseTabIcon}>
                {i < phaseIdx ? '✓' : p.icon}
              </span>
              <span style={s.phaseTabLabel}>{p.label}</span>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div style={s.progressTrack}>
          <div style={{ ...s.progressFill, width: `${progress}%` }}>
            <div style={s.progressGlow} />
          </div>
        </div>
        <div style={s.progressMeta}>
          <span style={s.progressPct}>{progress}%</span>
          {emailCount > 0 && (
            <span style={s.emailCount}>
              {counted.toLocaleString()} email{counted !== 1 ? 's' : ''} loaded
            </span>
          )}
        </div>

        {/* Current step */}
        <div style={s.stepRow}>
          <div style={s.stepIcon}>{currentPhase.icon}</div>
          <div style={s.stepText}>
            {currentStep}{dots}
          </div>
        </div>

        {/* Step history (last 3 completed) */}
        <StepHistory phaseIdx={phaseIdx} stepIdx={stepIdx} />

      </div>

      {/* ── Fun fact strip ── */}
      <div style={s.factBox}>
        <span style={s.factLabel}>DID YOU KNOW</span>
        <p style={{
          ...s.factText,
          opacity: fadingFact ? 0 : 1,
          transform: fadingFact ? 'translateY(4px)' : 'translateY(0)',
          transition: 'opacity 0.3s ease, transform 0.3s ease',
        }}>
          {FACTS[factIdx]}
        </p>
      </div>

    </div>
  );
}

// ── Keeps a rolling log of the last few completed steps ──
function StepHistory({ phaseIdx, stepIdx }) {
  const [log, setLog] = useState([]);

  useEffect(() => {
    const phase = PHASES[phaseIdx];
    if (!phase) return;
    const text = phase.steps[stepIdx];
    if (!text) return;

    setLog(prev => {
      const entry = `${phase.icon} ${text}`;
      if (prev[0] === entry) return prev;
      return [entry, ...prev].slice(0, 4);
    });
  }, [phaseIdx, stepIdx]);

  if (log.length <= 1) return null;

  return (
    <div style={s.historyList}>
      {log.slice(1).map((entry, i) => (
        <div key={i} style={{ ...s.historyItem, opacity: 0.4 - i * 0.1 }}>
          ✓ {entry}
        </div>
      ))}
    </div>
  );
}

// ── Styles ──
const s = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '20px',
    height: '100%',
    padding: '40px 20px',
    boxSizing: 'border-box',
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#00d9ff',
    boxShadow: '0 0 8px #00d9ff',
    animation: 'pulse 1.4s ease-in-out infinite',
  },
  headerLabel: {
    fontSize: '0.65rem',
    fontWeight: '700',
    letterSpacing: '2px',
    color: '#00d9ff',
  },

  card: {
    width: '100%',
    maxWidth: '580px',
    background: 'rgba(13, 20, 40, 0.8)',
    border: '1px solid rgba(0, 217, 255, 0.12)',
    borderRadius: '16px',
    padding: '28px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    backdropFilter: 'blur(10px)',
  },

  phaseTabs: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  phaseTab: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    borderRadius: '20px',
    fontSize: '0.75rem',
    fontWeight: '600',
    border: '1px solid transparent',
    transition: 'all 0.3s ease',
  },
  phaseTabActive: {
    background: 'rgba(0, 217, 255, 0.1)',
    border: '1px solid rgba(0, 217, 255, 0.35)',
    color: '#00d9ff',
  },
  phaseTabDone: {
    background: 'rgba(45, 212, 191, 0.08)',
    border: '1px solid rgba(45, 212, 191, 0.2)',
    color: '#2dd4bf',
  },
  phaseTabPending: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.06)',
    color: '#2a3f55',
  },
  phaseTabIcon: { fontSize: '0.85rem' },
  phaseTabLabel: {},

  progressTrack: {
    height: '4px',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '4px',
    overflow: 'hidden',
    position: 'relative',
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #0ea5e9, #00d9ff)',
    borderRadius: '4px',
    transition: 'width 0.3s ease',
    position: 'relative',
    overflow: 'hidden',
  },
  progressGlow: {
    position: 'absolute',
    top: 0, right: 0,
    width: '40px', height: '100%',
    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6))',
    animation: 'shimmer 1.5s ease-in-out infinite',
  },
  progressMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '-8px',
  },
  progressPct: {
    fontSize: '0.72rem',
    fontWeight: '700',
    color: '#00d9ff',
    fontVariantNumeric: 'tabular-nums',
  },
  emailCount: {
    fontSize: '0.72rem',
    color: '#2a4a60',
    fontVariantNumeric: 'tabular-nums',
  },

  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 16px',
    background: 'rgba(0, 217, 255, 0.04)',
    border: '1px solid rgba(0, 217, 255, 0.1)',
    borderRadius: '10px',
    minHeight: '50px',
  },
  stepIcon: {
    fontSize: '1.3rem',
    flexShrink: 0,
  },
  stepText: {
    fontSize: '0.92rem',
    color: '#a8c5e0',
    fontWeight: '500',
    fontFamily: 'monospace',
    letterSpacing: '0.2px',
  },

  historyList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingTop: '4px',
  },
  historyItem: {
    fontSize: '0.75rem',
    color: '#2dd4bf',
    fontFamily: 'monospace',
    paddingLeft: '4px',
    transition: 'opacity 0.4s ease',
  },

  factBox: {
    width: '100%',
    maxWidth: '580px',
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.05)',
    borderRadius: '10px',
    padding: '14px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  factLabel: {
    fontSize: '0.6rem',
    fontWeight: '800',
    letterSpacing: '1.5px',
    color: '#1e3a50',
    textTransform: 'uppercase',
  },
  factText: {
    margin: 0,
    fontSize: '0.82rem',
    color: '#3a5a72',
    lineHeight: '1.5',
    fontStyle: 'italic',
  },
};