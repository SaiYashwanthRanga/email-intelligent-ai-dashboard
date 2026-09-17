import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Laptop, RefreshCw, Users } from 'lucide-react';
import AppHeader from './AppHeader';
import './App.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// ── Sequential ramp (one hue, light→dark) for "how much activity this hour" —
// magnitude, not identity, so one hue is the correct encoding (see the
// dataviz skill's color-formula: sequential = one hue for magnitude).
const SEQUENTIAL_RAMP = [
  '#0d366b', // unused top anchor kept for reference; cells interpolate 150→650
  '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281',
];
const ZERO_CELL = 'rgba(255,255,255,0.05)'; // "no activity" reads as near-empty, not as the ramp's palest blue
const STATUS_GOOD = '#0ca30c';

function rampColor(count, max) {
  if (!count || max <= 0) return ZERO_CELL;
  const steps = SEQUENTIAL_RAMP.length - 1;
  const idx = Math.max(1, Math.min(steps, Math.round((count / max) * steps)));
  return SEQUENTIAL_RAMP[idx];
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatHourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${period}`;
}

// Collapse absolute "YYYY-MM-DDTHH" bucket keys into a 24-slot hour-of-day
// histogram — this directly answers "what hours is this person active",
// rather than a full calendar of every individual day in the window.
function hourOfDayHistogram(hourBuckets) {
  const hist = new Array(24).fill(0);
  for (const [key, count] of Object.entries(hourBuckets || {})) {
    const hourStr = key.split('T')[1];
    const h = parseInt(hourStr, 10);
    if (!Number.isNaN(h) && h >= 0 && h < 24) hist[h] += count;
  }
  return hist;
}

function HourStrip({ hourBuckets }) {
  const [hoverHour, setHoverHour] = useState(null);
  const hist = useMemo(() => hourOfDayHistogram(hourBuckets), [hourBuckets]);
  const max = Math.max(...hist, 0);
  const total = hist.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '6px 0' }}>No recorded activity yet in this window.</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        {hist.map((count, h) => (
          <div
            key={h}
            onMouseEnter={() => setHoverHour(h)}
            onMouseLeave={() => setHoverHour(prev => (prev === h ? null : prev))}
            role="img"
            aria-label={`${formatHourLabel(h)}: ${count} ping${count === 1 ? '' : 's'}`}
            style={{
              flex: 1,
              height: '22px',
              borderRadius: '3px',
              background: rampColor(count, max),
              cursor: 'default',
              transition: 'transform 0.1s, outline 0.1s',
              transform: hoverHour === h ? 'scaleY(1.15)' : 'none',
              outline: hoverHour === h ? '1px solid rgba(255,255,255,0.6)' : 'none',
            }}
          />
        ))}
      </div>
      {/* Sparse hour ticks — every 6 hours, never one label per cell */}
      <div style={{ display: 'flex', marginTop: '4px', fontSize: '0.62rem', color: 'var(--text-secondary)' }}>
        {[0, 6, 12, 18].map(h => (
          <div key={h} style={{ flex: 6, textAlign: 'left' }}>{formatHourLabel(h)}</div>
        ))}
      </div>
      {hoverHour !== null && (
        <div style={{
          position: 'absolute', bottom: '32px',
          left: `calc(${(hoverHour / 24) * 100}% )`,
          transform: 'translateX(-50%)',
          background: 'rgba(10,14,26,0.95)', border: '1px solid var(--border-color)',
          borderRadius: '6px', padding: '5px 9px', fontSize: '0.72rem',
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5,
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>{hist[hoverHour]} ping{hist[hoverHour] === 1 ? '' : 's'}</strong>
          <span style={{ color: 'var(--text-secondary)' }}> · {formatHourLabel(hoverHour)}–{formatHourLabel((hoverHour + 1) % 24)}</span>
        </div>
      )}
    </div>
  );
}

function UserCard({ user }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(15, 23, 41, 0.92) 0%, rgba(26, 35, 66, 0.85) 100%)',
      border: 'var(--glass-border)', borderRadius: '12px', padding: '18px 20px', marginBottom: '14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: '700', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{user.userEmail}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {user.isActiveNow ? (
              <>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: STATUS_GOOD, boxShadow: `0 0 6px ${STATUS_GOOD}`, flexShrink: 0 }} />
                <span style={{ color: STATUS_GOOD, fontWeight: '700' }}>Active now</span>
              </>
            ) : (
              <span>Last active {relativeTime(user.lastSeen)}</span>
            )}
          </div>
        </div>
      </div>

      <HourStrip hourBuckets={user.hourBuckets} />

      {user.devices?.length > 0 && (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-color)', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {user.devices.map(d => (
            <div key={d.deviceId} title={`Last seen ${relativeTime(d.lastSeen)}`} style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)',
              borderRadius: '999px', padding: '4px 10px', fontSize: '0.72rem', color: 'var(--text-secondary)',
            }}>
              <Laptop size={12} />
              {d.label}
              <span style={{ opacity: 0.7 }}>· {relativeTime(d.lastSeen)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ActivityView() {
  const userEmail = localStorage.getItem('userEmail') || '';

  const [authorized, setAuthorized] = useState(null); // null = checking
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(14);

  const load = useCallback(() => {
    if (!userEmail) return;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/activity/summary?requester_email=${encodeURIComponent(userEmail)}&days=${days}`)
      .then(async r => {
        if (r.status === 403) { setAuthorized(false); throw new Error('not authorized'); }
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json();
      })
      .then(data => {
        setAuthorized(true);
        setUsers(Array.isArray(data.users) ? data.users : []);
      })
      .catch(err => {
        if (err.message !== 'not authorized') setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [userEmail, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="app-container">
      <main className="main-content">
        <AppHeader
          active="ACTIVITY"
          canUseActivity
          titleIcon={<Users size={17} style={{ color: '#00d9ff' }} />}
          title="Team Activity"
          subtitle={
            <>
              Active hours are approximate (based on periodic pings while a tab is open, not idle) and
              “device” is a best-effort browser label — see hover on each chip for detail.
            </>
          }
          actions={
            <button onClick={load} disabled={loading} className="btn-gradient" style={{ width: 'auto', padding: '9px 18px', marginRight: '15px', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '0.84rem', fontWeight: '700', opacity: loading ? 0.65 : 1 }}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          }
        />

        {/* Filter row — one row, above the content, per dataviz interaction spec */}
        <div style={{ display: 'flex', gap: '8px', margin: '4px 0 16px' }}>
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)} className={`tab-btn ${days === d ? 'active' : ''}`}>
              Last {d} days
            </button>
          ))}
        </div>

        {authorized === false && (
          <div className="loading-text" style={{ padding: '60px 0' }}>
            You don't have access to view team activity. Ask whoever manages this dashboard
            to add your email to <code>activity_access.json</code> on the backend.
          </div>
        )}

        {authorized === null && loading && (
          <div className="loading-text" style={{ padding: '60px 0' }}>Checking access…</div>
        )}

        {authorized && error && (
          <div className="loading-text" style={{ padding: '60px 0' }}>Couldn't load activity data: {error}</div>
        )}

        {authorized && !error && !loading && users.length === 0 && (
          <div className="loading-text" style={{ padding: '60px 0' }}>No activity recorded yet — it fills in as people use the dashboard.</div>
        )}

        {authorized && users.length > 0 && (
          <div>
            {users.map(u => <UserCard key={u.userEmail} user={u} />)}
          </div>
        )}
      </main>
    </div>
  );
}
