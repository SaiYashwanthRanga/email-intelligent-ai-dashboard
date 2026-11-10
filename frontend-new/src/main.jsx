import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import './visionos-theme.css';

// Sessions saved before emails were lowercased at login (see Login.jsx)
// still hold e.g. "Ranga.SaiYashwanth@…" — normalize once at startup.
try {
  const stored = localStorage.getItem('userEmail');
  if (stored && stored !== stored.trim().toLowerCase()) {
    localStorage.setItem('userEmail', stored.trim().toLowerCase());
  }
} catch (_) {}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);