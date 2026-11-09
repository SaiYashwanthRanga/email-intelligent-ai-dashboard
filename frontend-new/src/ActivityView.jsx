import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Laptop } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const HEAT_COLORS = [
  '#0d366b', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281',
];
const EMPTY_HEAT = 'rgba(255,255,255,0.05)';
const ACTIVE_COLOR = '#0ca30c';

function heatColor(count, max) {
  if (!count || max <= 0) return EMPTY_HEAT;
  const n = HEAT_COLORS.length - 1;
  return HEAT_COLORS[Math.max(1, Math.min(n, Math.round((count / max) * n)))];
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const minsAgo = Math.round((Date.now() - t) / 60000);
  if (minsAgo < 1) return 'just now';
  if (minsAgo < 60) return `${minsAgo} min ago`;
  const hrsAgo = Math.round(minsAgo / 60);
  if (hrsAgo < 24) return `${hrsAgo} hr${hrsAgo === 1 ? '' : 's'} ago`;
  const daysAgo = Math.round(hrsAgo / 24);
  if (daysAgo < 7) return `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${period}`;
}

// Collapses { "YYYY-MM-DDTHH": count, ... } into a 24-slot array by hour-of-day.
function bucketsByHourOfDay(hourBuckets) {
  const hours = Array(24).fill(0);
  for (const [key, count] of Object.entries(hourBuckets || {})) {
    const hourStr = key.split('T')[1];
    const hour = parseInt(hourStr, 10);
    if (!Number.isNaN(hour) && hour >= 0 && hour < 24) hours[hour] += count;
  }
  return hours;
}

function ActivityHeatmap({ hourBuckets }) {
  const [hovered, setHovered] = useState(null);
  const hours = useMemo(() => bucketsByHourOfDay(hourBuckets), [hourBuckets]);
  const max = Math.max(...hours, 0);

  if (hours.reduce((a, b) => a + b, 0) === 0) {
    return (
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '6px 0' }}>
        No recorded activity yet in this window.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        {hours.map((count, h) => (
          <div
            key={h}
            onMouseEnter={() => setHovered(h)}
            onMouseLeave={() => setHovered(prev => (prev === h ? null : prev))}
            role="img"
            aria-label={`${hourLabel(h)}: ${count} ping${count === 1 ? '' : 's'}`}
            style={{
              flex: 1,
              height: '22px',
              borderRadius: '3px',
              background: heatColor(count, max),
              cursor: 'default',
              transition: 'transform 0.1s, outline 0.1s',
              transform: hovered === h ? 'scaleY(1.15)' : 'none',
              outline: hovered === h ? '1px solid rgba(255,255,255,0.6)' : 'none',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', marginTop: '4px', fontSize: '0.62rem', color: 'var(--text-secondary)' }}>
        {[0, 6, 12, 18].map(h => (
          <div key={h} style={{ flex: 6, textAlign: 'left' }}>{hourLabel(h)}</div>
        ))}
      </div>
      {hovered !== null && (
        <div style={{
          position: 'absolute', bottom: '32px', left: `calc(${(hovered / 24) * 100}% )`,
          transform: 'translateX(-50%)', background: 'rgba(10,14,26,0.95)',
          border: '1px solid var(--border-color)', borderRadius: '6px', padding: '5px 9px',
          fontSize: '0.72rem', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5,
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>
            {hours[hovered]} ping{hours[hovered] === 1 ? '' : 's'}
          </strong>
          <span style={{ color: 'var(--text-secondary)' }}>
            {` · ${hourLabel(hovered)}–${hourLabel((hovered + 1) % 24)}`}
          </span>
        </div>
      )}
    </div>
  );
}

function UserActivityCard({ user }) {
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
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: ACTIVE_COLOR, boxShadow: `0 0 6px ${ACTIVE_COLOR}`, flexShrink: 0 }} />
                <span style={{ color: ACTIVE_COLOR, fontWeight: '700' }}>Active now</span>
              </>
            ) : (
              <span>Last active {timeAgo(user.lastSeen)}</span>
            )}
          </div>
        </div>
      </div>

      <ActivityHeatmap hourBuckets={user.hourBuckets} />

      {user.devices?.length > 0 && (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-color)', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {user.devices.map(device => (
            <div
              key={device.deviceId}
              title={`Last seen ${timeAgo(device.lastSeen)}`}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-color)', borderRadius: '999px', padding: '4px 10px',
                fontSize: '0.72rem', color: 'var(--text-secondary)',
              }}
            >
              <Laptop size={12} />
              {device.label}
              <span style={{ opacity: 0.7 }}>{` · ${timeAgo(device.lastSeen)}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityView() {
  const navigate = useNavigate();
  const userEmail = localStorage.getItem('userEmail') || '';
  const [allowed, setAllowed] = useState(null); // null = checking, true/false = known
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(14);

  const refresh = useCallback(() => {
    if (!userEmail) return;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/activity/summary?requester_email=${encodeURIComponent(userEmail)}&days=${days}`)
      .then(async res => {
        if (res.status === 403) { setAllowed(false); throw new Error('not authorized'); }
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json();
      })
      .then(data => {
        setAllowed(true);
        setUsers(Array.isArray(data.users) ? data.users : []);
      })
      .catch(err => {
        if (err.message !== 'not authorized') setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [userEmail, days]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="app-container">
      <main className="main-content">
        <header className="top-bar">
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
              <div style={{ fontSize: '1rem', fontWeight: '800', letterSpacing: '-0.3px' }}>👥 Team Activity</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px', maxWidth: '520px' }}>
                Active hours are approximate (periodic pings while a tab is open, not idle) and "device" is a best-effort browser label.
              </div>
            </div>
          </div>

          <button
            onClick={refresh}
            disabled={loading}
            className="btn-gradient"
            style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: '6px', opacity: loading ? 0.65 : 1 }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </header>

        <div style={{ padding: '20px 24px 0' }}>
          <div style={{ display: 'flex', gap: '8px', margin: '4px 0 16px' }}>
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => setDays(d)} className={`tab-btn ${days === d ? 'active' : ''}`}>
                Last {d} days
              </button>
            ))}
          </div>

          {allowed === false && (
            <div className="loading-text" style={{ padding: '60px 0' }}>
              You don't have access to view team activity. Ask whoever manages this dashboard to add your email to <code>activity_access.json</code> on the backend.
            </div>
          )}
          {allowed === null && loading && (
            <div className="loading-text" style={{ padding: '60px 0' }}>Checking access…</div>
          )}
          {allowed && error && (
            <div className="loading-text" style={{ padding: '60px 0' }}>Couldn't load activity data: {error}</div>
          )}
          {allowed && !error && !loading && users.length === 0 && (
            <div className="loading-text" style={{ padding: '60px 0' }}>No activity recorded yet — it fills in as people use the dashboard.</div>
          )}
          {allowed && users.length > 0 && (
            <div>
              {users.map(user => <UserActivityCard key={user.userEmail} user={user} />)}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default ActivityView;
