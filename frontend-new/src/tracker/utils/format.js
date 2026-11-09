export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "jane.doe@x.com" → "Jane Doe" when no display name is known.
export function displayName(recipient) {
  if (recipient?.name) return recipient.name;
  const local = (recipient?.email || '').split('@')[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ') || recipient?.email || 'Unknown';
}

export function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Stable hue per string so the same person always gets the same avatar color.
export function hueFor(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
