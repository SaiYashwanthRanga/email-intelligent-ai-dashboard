import { useState, useEffect, useCallback } from 'react';

// Theme used to live in Dashboard.jsx, which only mounts on "/". A hard refresh
// on /tracking, /calendar or /activity therefore never ran the effect that adds
// the body class: a light-mode user landed on a dark page and could not fix it,
// because the toggle only existed on the dashboard either. Both halves now live
// here so every route agrees.

const STORAGE_KEY = 'theme';

export function readStoredTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';   // private mode / blocked storage
  }
}

export function applyTheme(theme) {
  if (theme === 'light') document.body.classList.add('light-mode');
  else document.body.classList.remove('light-mode');
}

// Call once at app startup so the correct theme is painted on ANY route,
// including a direct load of a sub-page.
export function initTheme() {
  applyTheme(readStoredTheme());
}

export default function useTheme() {
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* non-fatal */ }
  }, [theme]);

  // Another tab toggled the theme — follow it rather than drifting apart.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) setTheme(readStoredTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(prev => (prev === 'dark' ? 'light' : 'dark')),
    []
  );

  return { theme, toggleTheme };
}
