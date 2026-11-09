import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, PartyPopper } from 'lucide-react';
import Card from './Card';
import NoReplyCard from './NoReplyCard';
import { groupOverdue } from '../utils/status';

const INITIAL_VISIBLE = 5;

// Right-hand panel: one card per person who is overdue (no reply after the
// last reminder day), longest wait first.
export default function NoReplyPanel({ rows, config, onOpen, onOpenReminder, sendingIds, onExpand }) {
  const [showAll, setShowAll] = useState(false);
  const people = useMemo(() => groupOverdue(rows), [rows]);
  const shown = showAll ? people : people.slice(0, INITIAL_VISIBLE);
  const hidden = people.length - shown.length;

  return (
    <Card
      title="Overdue"
      subtitle={`${people.length} ${people.length === 1 ? 'person hasn\'t' : 'people haven\'t'} replied by day ${config.overdue_after_days} · follow up manually`}
      onExpand={onExpand}
      className="trk-side-card"
    >
      {people.length === 0 ? (
        <div className="trk-empty">
          <PartyPopper size={22} />
          <p>Nothing overdue. Everyone has replied within {config.overdue_after_days} days.</p>
        </div>
      ) : (
        <div className="trk-noreply-list">
          {shown.map((p) => (
            <NoReplyCard key={p.recipient.email} person={p} onOpen={onOpen} onOpenReminder={onOpenReminder} sendingIds={sendingIds} />
          ))}
        </div>
      )}

      {(hidden > 0 || showAll) && people.length > INITIAL_VISIBLE && (
        <button type="button" className="trk-more" onClick={() => setShowAll((v) => !v)}>
          <span>{showAll ? 'Show fewer' : `${hidden} more overdue`}</span>
          {showAll ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
    </Card>
  );
}
