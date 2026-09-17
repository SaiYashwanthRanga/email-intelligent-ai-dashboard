import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Settings, ArrowLeft, Plus, Pencil, Trash2, X } from 'lucide-react';
import AppHeader from './AppHeader';
import RichTextToolbar from './RichTextToolbar';
import './App.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Landing-page shell only, for now — each card links to a placeholder page.
// Real functionality behind each section (folder rules, the tags system,
// signature management, send controls) comes in later phases.
const ADMIN_SECTIONS = [
  {
    key: 'organize',
    title: 'Organize & filing',
    description: 'Folder-layout proposals, standing filing rules (tags and senders), and Inbox cleanup sweeps.',
  },
  {
    key: 'tags',
    title: 'Tags',
    description: 'Author semantic tags with preview-before-approve, edit criteria and behavior, scan history for completeness, tune triage weights.',
  },
  {
    key: 'signatures',
    title: 'Signatures',
    description: 'Your compose signatures — the default auto-inserts, the rest sit behind the ✍ picker in the composer.',
  },
  {
    key: 'sending',
    title: 'Sending',
    description: 'The undo-send window — and the future home of nudge auto-send and voice settings.',
  },
];

export default function AdminView() {
  const navigate = useNavigate();

  return (
    <div className="app-container">
      <main className="main-content">
        <AppHeader
          active="ADMIN"
          titleIcon={<Settings size={17} style={{ color: '#00d9ff' }} />}
          title="Admin"
          subtitle="Back-office for your mailbox — the knobs, rules, and structures behind the brief."
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '900px', margin: '20px auto 0' }}>
          {ADMIN_SECTIONS.map(section => (
            <div
              key={section.key}
              onClick={() => navigate(`/admin/${section.key}`)}
              className="email-card"
              style={{
                display: 'block', cursor: 'pointer', padding: '20px 24px',
                background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                borderRadius: '14px',
              }}
            >
              <div style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                {section.title}
              </div>
              <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: '1.55' }}>
                {section.description}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

// ── Sending: undo-send window ────────────────────────────────────────────
// The one section that's real functionality rather than a placeholder —
// controls how long Send waits (with an Undo option) before an email or
// reply actually goes out. Wired to ComposeMailModal.jsx and DashboardView's
// reply/forward send path via GET/POST /api/send-settings.
function SendingSettings() {
  const [seconds, setSeconds] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const userEmail = localStorage.getItem('userEmail') || '';
    if (!userEmail) { setLoaded(true); return; }
    fetch(`${API_BASE}/send-settings?user_email=${encodeURIComponent(userEmail)}`)
      .then(r => r.json())
      .then(data => setSeconds(data.undoWindowSeconds ?? 0))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const userEmail = localStorage.getItem('userEmail') || '';
    if (!userEmail) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`${API_BASE}/send-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, undoWindowSeconds: seconds }),
      });
      const data = await res.json();
      setSeconds(data.undoWindowSeconds ?? seconds);
      setSaved(true);
    } catch (e) {
      console.error('save send settings error:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="email-card"
      style={{ display: 'block', padding: '20px 24px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px' }}
    >
      <div style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
        Undo window
      </div>
      <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: '1.55', marginBottom: '16px' }}>
        After you hit Send, the email waits this many seconds with an Undo button before actually leaving. 0 sends immediately.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <input
          type="number"
          min={0}
          max={30}
          value={seconds}
          onChange={e => { setSeconds(Math.max(0, Math.min(30, Number(e.target.value) || 0))); setSaved(false); }}
          disabled={!loaded}
          style={{ width: '70px', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.86rem' }}
        />
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>seconds (max 30)</span>
        <button onClick={save} disabled={saving || !loaded} className="btn-copy">
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span style={{ fontSize: '0.78rem', color: '#10b981', fontWeight: '600' }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// ── Signatures (Outlook-style) ──────────────────────────────────────────────
// A named signature is just {id, name, body}. Two independent default
// slots — new messages vs. replies/forwards — mirror Outlook's own
// Signatures dialog rather than a single "the" default. List view shows
// names only (edit/delete); editing opens a separate view with the full
// rich-text body and its own pair of "set as default" checkboxes.
// ComposeMailModal.jsx and DashboardView.jsx read this same data.
const sigBadgeStyle = {
  fontSize: '0.56rem', fontWeight: '800', color: '#00d9ff',
  background: 'rgba(0,217,255,0.1)', border: '1px solid rgba(0,217,255,0.25)',
  borderRadius: '4px', padding: '1px 5px', flexShrink: 0,
};

function SignaturesSettings() {
  const [signatures, setSignatures] = useState([]);
  const [defaultNewId, setDefaultNewId] = useState(null);
  const [defaultReplyId, setDefaultReplyId] = useState(null);
  const [loaded, setLoaded] = useState(false);

  // null = list view; 'new' = creating; an id = editing that signature.
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDefaultNew, setEditDefaultNew] = useState(false);
  const [editDefaultReply, setEditDefaultReply] = useState(false);
  const [saving, setSaving] = useState(false);
  const editBodyRef = useRef(null);

  const userEmail = () => localStorage.getItem('userEmail') || '';

  const load = () => {
    const email = userEmail();
    if (!email) { setLoaded(true); return; }
    fetch(`${API_BASE}/signatures?user_email=${encodeURIComponent(email)}`)
      .then(r => r.json())
      .then(data => {
        setSignatures(data.signatures || []);
        setDefaultNewId(data.defaultNewId || null);
        setDefaultReplyId(data.defaultReplyId || null);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  };

  useEffect(() => { load(); }, []);

  // Fill the edit view's contentEditable once it actually mounts — setting
  // innerHTML before the div exists (i.e. before this effect's render
  // commits) would silently do nothing.
  useEffect(() => {
    if (editingId === null || !editBodyRef.current) return;
    const sig = editingId === 'new' ? null : signatures.find(s => s.id === editingId);
    editBodyRef.current.innerHTML = sig?.body || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const openNew = () => {
    setEditingId('new');
    setEditName('');
    setEditDefaultNew(signatures.length === 0);
    setEditDefaultReply(signatures.length === 0);
  };

  const openEdit = (sig) => {
    setEditingId(sig.id);
    setEditName(sig.name);
    setEditDefaultNew(defaultNewId === sig.id);
    setEditDefaultReply(defaultReplyId === sig.id);
  };

  const saveEdit = async () => {
    const email = userEmail();
    if (!email || !editName.trim()) return;
    setSaving(true);
    try {
      const body = editBodyRef.current?.innerHTML || '';
      let sigId = editingId;
      if (editingId === 'new') {
        const res = await fetch(`${API_BASE}/signatures`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: email, name: editName.trim() }),
        });
        const data = await res.json();
        sigId = data.signature?.id;
        if (sigId) {
          await fetch(`${API_BASE}/signatures/${sigId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_email: email, body }),
          });
        }
      } else {
        await fetch(`${API_BASE}/signatures/${sigId}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: email, name: editName.trim(), body }),
        });
      }
      if (sigId) {
        // A checked box sets that slot to this signature; an unchecked box
        // only clears the slot if THIS signature currently held it —
        // otherwise some other signature's default is left untouched
        // (an omitted key here means "don't touch", per the backend).
        await fetch(`${API_BASE}/signature-defaults`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_email: email,
            defaultNewId: editDefaultNew ? sigId : (defaultNewId === sigId ? null : undefined),
            defaultReplyId: editDefaultReply ? sigId : (defaultReplyId === sigId ? null : undefined),
          }),
        });
      }
      load();
      setEditingId(null);
    } catch (e) {
      console.error('save signature error:', e);
    } finally {
      setSaving(false);
    }
  };

  const removeSignature = async (id) => {
    const email = userEmail();
    if (!email || !window.confirm('Delete this signature?')) return;
    const res = await fetch(`${API_BASE}/signatures/${id}?user_email=${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (res.ok) load();
  };

  const setDefaultDirect = async (which, sigId) => {
    const email = userEmail();
    if (!email) return;
    const key = which === 'new' ? 'defaultNewId' : 'defaultReplyId';
    const res = await fetch(`${API_BASE}/signature-defaults`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_email: email, [key]: sigId || null }),
    });
    if (res.ok) {
      if (which === 'new') setDefaultNewId(sigId || null); else setDefaultReplyId(sigId || null);
    }
  };

  if (editingId !== null) {
    return (
      <div className="email-card" style={{ display: 'block', padding: '22px 26px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)' }}>
            {editingId === 'new' ? 'New signature' : 'Edit signature'}
          </span>
          <button onClick={() => setEditingId(null)} className="btn-copy" title="Cancel"><X size={14} /></button>
        </div>

        <input
          type="text"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          placeholder="Signature name"
          style={{ width: '100%', padding: '9px 12px', marginBottom: '14px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600', boxSizing: 'border-box' }}
        />

        <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
          <RichTextToolbar targetRef={editBodyRef} />
          <div
            ref={editBodyRef}
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Write this signature..."
            className="reply-textarea"
            style={{ minHeight: '140px', border: 'none', borderRadius: 0 }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.84rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={editDefaultNew} onChange={e => setEditDefaultNew(e.target.checked)} />
            Set as default for new messages
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.84rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={editDefaultReply} onChange={e => setEditDefaultReply(e.target.checked)} />
            Set as default for replies and forwards
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={() => setEditingId(null)} className="btn-copy">Cancel</button>
          <button onClick={saveEdit} disabled={saving || !editName.trim()} className="btn-gradient" style={{ width: 'auto', padding: '9px 20px' }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', marginBottom: '16px' }}>
        <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: '1.55' }}>
          Add and edit the signatures available for your emails, and choose which one is used by default for new messages versus replies and forwards.
        </div>
        <button onClick={openNew} className="btn-gradient" style={{ width: 'auto', padding: '9px 18px', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <Plus size={15} /> Add signature
        </button>
      </div>

      <div className="email-card" style={{ display: 'block', padding: '18px 22px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}>Default for new messages</span>
          <select
            value={defaultNewId || ''}
            onChange={e => setDefaultDirect('new', e.target.value)}
            style={{ minWidth: '200px', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.86rem' }}
          >
            <option value="">None</option>
            {signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}>Default for replies and forwards</span>
          <select
            value={defaultReplyId || ''}
            onChange={e => setDefaultDirect('reply', e.target.value)}
            style={{ minWidth: '200px', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.86rem' }}
          >
            <option value="">None</option>
            {signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {loaded && signatures.length === 0 && (
        <div className="empty-placeholder" style={{ padding: '30px', textAlign: 'center', fontSize: '0.84rem' }}>
          No signatures yet — add one above.
        </div>
      )}

      {signatures.map(sig => (
        <div key={sig.id} className="email-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '10px', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span style={{ fontSize: '0.88rem', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.name}</span>
            {defaultNewId === sig.id && <span style={sigBadgeStyle}>NEW</span>}
            {defaultReplyId === sig.id && <span style={sigBadgeStyle}>REPLY</span>}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button onClick={() => openEdit(sig)} className="btn-copy" title="Edit"><Pencil size={14} /></button>
            <button onClick={() => removeSignature(sig.id)} className="btn-copy" style={{ color: '#ef4444' }} title="Delete"><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

// One shared placeholder for the three sections that aren't built yet —
// avoids three near-identical "coming soon" files.
export function AdminSectionView() {
  const navigate = useNavigate();
  const { section } = useParams();
  const meta = ADMIN_SECTIONS.find(s => s.key === section);

  return (
    <div className="app-container">
      <main className="main-content">
        <AppHeader
          active="ADMIN"
          titleIcon={<Settings size={17} style={{ color: '#00d9ff' }} />}
          title={meta ? meta.title : 'Admin'}
          subtitle="Back-office for your mailbox — the knobs, rules, and structures behind the brief."
        />

        <div style={{ maxWidth: '900px', margin: '20px auto 0' }}>
          <button
            onClick={() => navigate('/admin')}
            className="btn-copy"
            style={{ marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <ArrowLeft size={14} /> Back to Admin
          </button>

          {section === 'sending' ? (
            <SendingSettings />
          ) : section === 'signatures' ? (
            <SignaturesSettings />
          ) : (
            <div className="empty-placeholder" style={{ padding: '60px 40px', textAlign: 'center' }}>
              <div style={{ fontSize: '2.2rem', marginBottom: '14px' }}>🚧</div>
              <div style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '6px' }}>
                {meta ? meta.title : 'This section'} is coming soon
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: '1.7', maxWidth: '480px', margin: '0 auto' }}>
                {meta ? meta.description : ''}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
