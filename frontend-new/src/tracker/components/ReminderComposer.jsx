import React, { useEffect, useState } from 'react';
import { BellRing, Loader2, RotateCcw, X } from 'lucide-react';
import { Button } from './Controls';
import { displayName } from '../utils/format';

// Compose-and-send for a reminder from reminders@hfmg.net to ONE recipient.
//
// The fields always open filled in: with the recipient's waiting draft (the
// Day-1 / Day-3 template the scheduler prepared) when there is one, otherwise
// with a preview of the right template for today. A preview stores nothing —
// the reminder is only created when Send is pressed and confirmed.
//
// recipients: open recipients (each { id, email, kind, reminders })
// onPreview(recipientId)            -> { subject, body, template_day }
// onDraft(recipientId, {})          -> reminder   (creates the pending template reminder)
// onSend(reminder, {subject, body})               (sends it, with any edits)
export default function ReminderComposer({ recipients, initialRecipientId, onPreview, onDraft, onSend, onClose }) {
  const [recipientId, setRecipientId] = useState(initialRecipientId || recipients[0]?.id);
  const [draft, setDraft] = useState(null);       // existing reminder row, if any
  const [template, setTemplate] = useState(null); // { subject, body, template_day } from preview
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const recipient = recipients.find((r) => r.id === Number(recipientId));

  // Fill the fields: waiting draft first, else the template preview.
  useEffect(() => {
    if (!recipient) return undefined;
    let cancelled = false;
    const waiting = (recipient.reminders || [])
      .filter((m) => m.status === 'pending' || m.status === 'failed')
      .sort((a, b) => b.stage_day - a.stage_day)[0] || null;
    setDraft(waiting);
    setTemplate(null);
    setError(null);
    if (waiting) {
      setSubject(waiting.subject || '');
      setBody(waiting.body || '');
      return undefined;
    }
    setSubject('');
    setBody('');
    setLoading(true);
    onPreview(recipient.id)
      .then((p) => { if (!cancelled) { setTemplate(p); setSubject(p.subject); setBody(p.body); } })
      .catch((err) => { if (!cancelled) setError(`Couldn't load the template: ${err.message}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Keyed on the id only, so a background reload never wipes text being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient?.id]);

  if (!recipients.length) {
    return (
      <section className="trk-compose">
        <header className="trk-compose__head">
          <h4><BellRing size={15} /> Send reminder</h4>
          <button type="button" className="btn-icon-only" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </header>
        <p className="trk-muted">Nobody on this email is being tracked. Use "Track again" on someone first.</p>
      </section>
    );
  }

  const original = draft
    ? { subject: draft.subject || '', body: draft.body || '' }
    : template && { subject: template.subject, body: template.body };
  const edited = original && (subject !== original.subject || body !== original.body);

  const send = async () => {
    setError(null);
    if (!subject.trim() || !body.trim()) { setError('Add a subject and a message first.'); return; }
    if (!window.confirm(`Send this reminder to ${recipient.email} from reminders@hfmg.net?`)) return;
    setSending(true);
    try {
      // No reminder row yet: create the template one, then send it with the
      // text exactly as it is in the fields (including any edits).
      const target = draft || await onDraft(recipient.id, {});
      await onSend(target, { subject: subject.trim(), body: body.trim() });
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const templateDay = draft ? (draft.stage_day >= 3 ? 3 : 1) : template?.template_day;
  let note = 'Loading the template…';
  if (draft) {
    note = draft.ai_reason === 'Written by the user.'
      ? 'Your saved draft.'
      : `Day-${templateDay} template${draft.origin === 'scheduled' && draft.ai_reason ? ` · AI: ${draft.ai_reason}` : ''}.`;
  } else if (template) {
    note = `Day-${templateDay} template for today (day ${template.stage_day} since you sent it).`;
  }

  return (
    <section className="trk-compose">
      <header className="trk-compose__head">
        <h4><BellRing size={15} /> Send reminder</h4>
        <button type="button" className="btn-icon-only" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </header>

      {recipients.length > 1 ? (
        <label className="trk-compose__field">
          <span>To</span>
          <select className="input-text" value={recipientId} onChange={(e) => setRecipientId(Number(e.target.value))}>
            {recipients.map((r) => (
              <option key={r.id} value={r.id}>{displayName(r)} — {r.email}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="trk-compose__field">
          <span>To</span>
          <div className="trk-compose__to">{displayName(recipient)} — {recipient.email}</div>
        </div>
      )}

      <div className="trk-compose__note">
        {loading && <Loader2 size={13} className="animate-spin" />}
        {note} Edit it before sending if you like.
      </div>

      <label className="trk-compose__field">
        <span>Subject</span>
        <input className="input-text" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={loading} />
      </label>
      <label className="trk-compose__field">
        <span>Message</span>
        <textarea className="input-text" rows={12} value={body} onChange={(e) => setBody(e.target.value)} disabled={loading} />
      </label>
      <p className="trk-compose__hint">Sent from reminders@hfmg.net with your original email quoted underneath.</p>

      {error && <div className="trk-compose__error">{error}</div>}

      <div className="trk-compose__actions">
        {edited && (
          <Button icon={RotateCcw} onClick={() => { setSubject(original.subject); setBody(original.body); }} disabled={sending}>
            Reset
          </Button>
        )}
        <Button variant="primary" icon={sending ? Loader2 : BellRing} onClick={send} disabled={sending || loading || !body.trim()}>
          {sending ? 'Sending…' : 'Send reminder'}
        </Button>
      </div>
    </section>
  );
}
