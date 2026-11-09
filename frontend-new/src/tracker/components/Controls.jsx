import React from 'react';
import { Search } from 'lucide-react';

// These wrap the app's shared theme classes (tab-btn, count-badge, input-text,
// btn-gradient, btn-copy from App.css / visionos-theme.css) so the tracker
// looks and themes exactly like the other pages, including light mode.

// Segmented tab bar. tabs: [{ key, label, count? }]
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="trk-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={`tab-btn trk-tab ${value === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined && <span className="count-badge">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <label className="input-text trk-field trk-search">
      <Search size={14} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  );
}

// options: [{ value, label }]
export function SelectMenu({ value, onChange, options, label }) {
  return (
    <label className="input-text trk-field trk-select">
      {label && <span className="trk-select__label">{label}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// variant: 'primary' (btn-gradient) | 'secondary' (btn-copy) | 'done'
export function Button({ variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest }) {
  const base = variant === 'primary' ? 'btn-gradient' : variant === 'done' ? 'trk-btn--done' : 'btn-copy';
  return (
    <button type="button" className={`${base} trk-btn trk-btn--${size} ${className}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 13 : 14} />}
      {children}
    </button>
  );
}
