import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReminderComposer from './ReminderComposer';

// Centered modal around the reminder composer, opened from the table's bell
// and the overdue cards' Nudge button. `row` is the table row (one recipient).
// Portaled to <body> so .main-content's backdrop-filter can't trap it.
export default function ReminderModal({ row, onPreview, onDraft, onSend, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The composer works on recipients shaped like the API's RecipientOut.
  const recipient = {
    id: row.id,
    email: row.recipient.email,
    kind: row.kind,
    reminders: row.reminders || [],
  };

  return createPortal(
    <div
      className="trk-portal trk-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="trk-modal" role="dialog" aria-modal="true" aria-label={`Send reminder to ${recipient.email}`}>
        <div className="trk-modal__context">
          <span className="trk-muted">Re:</span> {row.subject || '(no subject)'}
        </div>
        <ReminderComposer
          recipients={[recipient]}
          initialRecipientId={recipient.id}
          onPreview={onPreview}
          onDraft={onDraft}
          onSend={async (reminder, edits) => { await onSend(reminder, edits); onClose(); }}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}
