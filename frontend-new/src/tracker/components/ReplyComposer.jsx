import React, { useState } from 'react';
import { Reply, X } from 'lucide-react';
import { Button } from './Controls';

const splitAddresses = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Reply in the conversation from the user's own mailbox (not reminders@),
// sent through the app's existing reply endpoint.
// onSend({ to: [], cc: [], bodyText })
export default function ReplyComposer({ defaultTo, replyingTo, onSend, onClose }) {
  const [to, setTo] = useState(defaultTo.join(', '));
  const [cc, setCc] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const send = async () => {
    const toList = splitAddresses(to);
    const ccList = splitAddresses(cc);
    const bad = [...toList, ...ccList].filter((a) => !looksLikeEmail(a));
    if (!toList.length) { setError('Add at least one recipient.'); return; }
    if (bad.length) { setError(`Not an email address: ${bad.join(', ')}`); return; }
    if (!body.trim()) { setError('Write a message first.'); return; }
    if (!window.confirm(`Send this reply to ${toList.join(', ')}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await onSend({ to: toList, cc: ccList, bodyText: body.trim() });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="trk-compose">
      <header className="trk-compose__head">
        <h4><Reply size={15} /> Reply</h4>
        <button type="button" className="btn-icon-only" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </header>
      {replyingTo && <div className="trk-compose__note">Replying to the latest message from {replyingTo}, from your own mailbox.</div>}
      <label className="trk-compose__field">
        <span>To</span>
        <input className="input-text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@hfmg.net, …" />
      </label>
      <label className="trk-compose__field">
        <span>Cc</span>
        <input className="input-text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" />
      </label>
      <label className="trk-compose__field">
        <span>Message</span>
        <textarea className="input-text" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {error && <div className="trk-compose__error">{error}</div>}
      <div className="trk-compose__actions">
        <Button variant="primary" icon={Reply} onClick={send} disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : 'Send reply'}
        </Button>
      </div>
    </section>
  );
}
