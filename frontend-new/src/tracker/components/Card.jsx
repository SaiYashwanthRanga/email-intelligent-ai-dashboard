import React from 'react';
import { ArrowUpRight } from 'lucide-react';

// Generic surface used by every tracker panel.
// `title` + optional `actions` render a header row; `onExpand` adds the ↗ button.
export default function Card({ title, subtitle, actions, onExpand, className = '', children, ...rest }) {
  const hasHeader = title || actions || onExpand;
  return (
    <section className={`trk-card ${className}`} {...rest}>
      {hasHeader && (
        <header className="trk-card__header">
          <div>
            {title && <h3 className="trk-card__title">{title}</h3>}
            {subtitle && <p className="trk-card__subtitle">{subtitle}</p>}
          </div>
          <div className="trk-card__actions">
            {actions}
            {onExpand && <IconButton label="Expand" onClick={onExpand}><ArrowUpRight size={15} /></IconButton>}
          </div>
        </header>
      )}
      {children}
    </section>
  );
}

export function IconButton({ label, children, className = '', ...rest }) {
  return (
    <button type="button" className={`btn-copy trk-icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
