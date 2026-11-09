import React from 'react';
import { ArrowUpRight } from 'lucide-react';

// One KPI tile: icon, label, big value, caption.
// tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'
export default function KpiCard({ icon: Icon, label, value, caption, tone = 'neutral', active = false, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`trk-card trk-kpi trk-tone-${tone} ${active ? 'is-active' : ''} ${onClick ? 'is-clickable' : ''}`}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
    >
      <div className="trk-kpi__top">
        <span className="trk-kpi__icon">{Icon && <Icon size={16} />}</span>
        {onClick && <ArrowUpRight size={15} className="trk-kpi__arrow" />}
      </div>
      <div className="trk-kpi__label">{label}</div>
      <div className="trk-kpi__value">{value}</div>
      {caption && <div className="trk-kpi__caption">{caption}</div>}
    </Tag>
  );
}

export function KpiGrid({ children }) {
  return <div className="trk-kpi-grid">{children}</div>;
}
