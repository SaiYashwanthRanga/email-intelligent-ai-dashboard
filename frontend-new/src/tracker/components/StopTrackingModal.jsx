import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, UserMinus, X } from 'lucide-react';
import { Button } from './Controls';
import { displayName, fmtDateTime } from '../utils/format';

// Confirmation modal for "stop tracking this person on this email", opened
// from the table's stop icon. `row` is the table row (one recipient).
// onConfirm(row) does the stop; errors are shown here instead of closing.
export default function StopTrackingModal({ row, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const waiting = (row.reminders || []).filter((m) => m.status === 'pending' || m.status === 'failed').length;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(row);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="trk-portal trk-modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="trk-modal trk-modal--narrow" role="alertdialog" aria-modal="true" aria-labelledby="trk-stop-title">
        <section className="trk-compose">
          <header className="trk-compose__head">
            <h4 id="trk-stop-title"><UserMinus size={15} /> Stop tracking?</h4>
            <button type="button" className="btn-icon-only" onClick={onClose} disabled={busy} aria-label="Close"><X size={15} /></button>
          </header>

          <div className="trk-stop__who">
            <div className="trk-stop__name">{displayName(row.recipient)}</div>
            <div className="trk-muted">{row.recipient.email}</div>
          </div>
          <div className="trk-stop__email">
            <span className="trk-muted">Email:</span> {row.subject || '(no subject)'}
            <span className="trk-muted"> · sent {fmtDateTime(row.sentAt)}</span>
          </div>

          <ul className="trk-stop__effects">
            <li>No more reminders go to them for this email{waiting ? ` — the ${waiting} waiting draft${waiting === 1 ? ' is' : 's are'} cancelled` : ''}.</li>
            <li>They won't be marked overdue.</li>
            <li>Other people on this email are still tracked.</li>
            <li>You can switch it back on from the email ("Track again").</li>
          </ul>

          {error && <div className="trk-compose__error">{error}</div>}

          <div className="trk-compose__actions">
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" icon={busy ? Loader2 : UserMinus} onClick={confirm} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop tracking'}
            </Button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
