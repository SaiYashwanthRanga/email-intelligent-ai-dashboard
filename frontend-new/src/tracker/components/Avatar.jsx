import React from 'react';
import { hueFor, initials } from '../utils/format';

export default function Avatar({ name, seed, size = 32 }) {
  const hue = hueFor(seed || name);
  return (
    <span
      className="trk-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue} 55% 42%)`,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

// Avatar + two lines of text, used in the table and side panel.
export function PersonCell({ name, detail, seed, size }) {
  return (
    <span className="trk-person">
      <Avatar name={name} seed={seed} size={size} />
      <span className="trk-person__text">
        <span className="trk-person__name">{name}</span>
        {detail && <span className="trk-person__detail">{detail}</span>}
      </span>
    </span>
  );
}
