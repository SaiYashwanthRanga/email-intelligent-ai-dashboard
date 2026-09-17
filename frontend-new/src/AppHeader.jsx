import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Mail, Calendar, Radar, Users, Sun, Moon, LogOut, Settings } from 'lucide-react';
import Iris from './Iris';
import useTheme from './useTheme';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const LOGO_SRC =
  'https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp';

// One header for every page.
//
// Tracking, Calendar and Activity each grew their own ad-hoc top bar: a logo, a
// "← Dashboard" button and a title. That meant the nav, the theme toggle, the
// profile menu and Iris existed on the dashboard and nowhere else, so leaving
// the inbox cost you the whole application shell and a round trip home to get
// anywhere else. Every page renders this instead, passing only what is really
// page-specific through `title`, `subtitle`, `leftExtras` and `actions`.

function useGreeting() {
  const [info, setInfo] = useState({ greeting: 'Hello', date: '' });
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const hour = now.getHours();
      const greeting =
        hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
      setInfo({
        greeting,
        date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
      });
    };
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, []);
  return info;
}

// Which nav items this account may see. Every page needs the answer now that
// the switcher is everywhere, so it is asked for here rather than threaded down
// from whichever page happens to be mounted.
function useFeatureAccess() {
  const [access, setAccess] = useState({ tracking: false, activity: false });
  useEffect(() => {
    let cancelled = false;
    let email = '';
    try { email = localStorage.getItem('userEmail') || ''; } catch { /* blocked storage */ }
    if (!email) return undefined;
    const ask = (path) =>
      fetch(`${API_BASE}/${path}/access?user_email=${encodeURIComponent(email)}`)
        .then(r => (r.ok ? r.json() : { allowed: false }))
        .then(d => !!d.allowed)
        .catch(() => false);
    Promise.all([ask('tracking'), ask('activity')]).then(([tracking, activity]) => {
      if (!cancelled) setAccess({ tracking, activity });
    });
    return () => { cancelled = true; };
  }, []);
  return access;
}

function handleLogout() {
  ['jimAuthSession', 'emailDashboardMeta', 'loggedInUser', 'sessionUser', 'userEmail']
    .forEach(k => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
  window.location.href = '/login';
}

export default function AppHeader({
  // 'INSIGHTS' | 'THREADS' | 'CALENDAR' | 'TRACKING' | 'ACTIVITY'
  active,
  // Dashboard switches Insights/Inbox in local state; other pages route home.
  onSelectView,
  title,
  subtitle,
  titleIcon,
  // Page-specific status: sits between the switcher and the theme toggle.
  leftExtras,
  // Primary page action (Sync Now, Compose, Refresh…), right of the header.
  actions,
  showIris = true,
  irisProps = {},
  // Pages that already know their own access can skip the extra fetch.
  canUseTracking,
  canUseActivity,
}) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const greeting = useGreeting();
  const fetched = useFeatureAccess();

  const trackingAllowed = canUseTracking ?? fetched.tracking;
  const activityAllowed = canUseActivity ?? fetched.activity;

  const [username, setUsername] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('loggedInUser');
      if (saved) setUsername(saved.charAt(0).toUpperCase() + saved.slice(1).toLowerCase());
    } catch { /* ignore */ }
  }, []);

  // Insights and Inbox are two states of the dashboard route. From another page
  // the target view is parked here and Dashboard picks it up on mount, so
  // "Insights" from Tracking lands on Insights instead of the default Inbox.
  const goDashboard = (view) => {
    if (onSelectView) { onSelectView(view); return; }
    try { sessionStorage.setItem('pendingMainView', view); } catch { /* ignore */ }
    navigate('/');
  };

  const navBtn = (key, label, Icon, onClick) => (
    <button
      key={key}
      className={`view-btn ${active === key ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      aria-current={active === key ? 'page' : undefined}
    >
      <Icon size={18} /> {label}
    </button>
  );

  const displayName = username
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  return (
    <header className="top-bar">
      <div className="top-left">
        <div
          className="brand"
          style={{ marginRight: '20px', cursor: 'pointer' }}
          onClick={() => goDashboard('THREADS')}
          title="Back to dashboard"
        >
          <img
            src={LOGO_SRC}
            alt="Horizon Family Medical Group"
            style={{ height: '36px', width: 'auto', objectFit: 'contain', filter: 'brightness(1.05)', display: 'block' }}
          />
        </div>

        <div className="view-switcher">
          {navBtn('INSIGHTS', 'Insights', PieChart, () => goDashboard('INSIGHTS'))}
          {navBtn('THREADS', 'Inbox', Mail, () => goDashboard('THREADS'))}
          {navBtn('CALENDAR', 'Calendar', Calendar, () => navigate('/calendar'))}
          {trackingAllowed && navBtn('TRACKING', 'Tracking', Radar, () => navigate('/tracking'))}
          {activityAllowed && navBtn('ACTIVITY', 'Activity', Users, () => navigate('/activity'))}
          {navBtn('ADMIN', 'Admin', Settings, () => navigate('/admin'))}
          {showIris && <Iris canUseTracking={trackingAllowed} {...irisProps} />}
        </div>

        {title && (
          <div style={{ marginLeft: '18px', minWidth: 0 }}>
            <div style={{
              fontSize: '1rem', fontWeight: '800', letterSpacing: '-0.3px',
              display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              {titleIcon}
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {subtitle}
              </div>
            )}
          </div>
        )}

        {leftExtras}

        <button className="menu-btn" style={{ marginLeft: '15px' }} onClick={toggleTheme} title="Toggle Theme">
          {theme === 'dark' ? <Sun size={20} color="#fbbf24" /> : <Moon size={20} color="#64748b" />}
        </button>
      </div>

      {actions}

      <div className="user-profile" onClick={() => setProfileOpen(o => !o)}>
        <div
          className="user-info welcome-text"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginRight: '10px' }}
        >
          <span style={{ fontSize: '1.3rem', fontWeight: '700', letterSpacing: '-0.5px' }}>
            {greeting.greeting}{displayName ? `, ${displayName}` : ''}
          </span>
          <span style={{
            fontSize: '0.85rem', color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '500',
          }}>
            {greeting.date}
          </span>
        </div>
        <div className="avatar">{(username.trim().split(/\s+/)[0] || 'U').charAt(0).toUpperCase()}</div>
        {profileOpen && (
          <div className="profile-dropdown">
            <button onClick={(e) => { e.stopPropagation(); handleLogout(); }} className="dropdown-item text-red">
              <LogOut size={16} /> Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
