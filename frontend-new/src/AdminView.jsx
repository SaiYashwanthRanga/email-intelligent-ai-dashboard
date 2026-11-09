import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Settings, FolderTree, Tag, Pencil, Send, Plus, Trash2, X,
  ChevronDown, ChevronRight, Sparkles, Users, Check,
} from 'lucide-react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
const MAX_WIDTH = '1160px';

const SECTIONS = [
  {
    key: 'organize',
    title: 'Organize & filing',
    description: 'Folder-layout proposals, standing filing rules (tags and senders), and Inbox cleanup sweeps.',
    Icon: FolderTree,
    color: '#3b82f6',
  },
  {
    key: 'tags',
    title: 'Tags',
    description: 'Author semantic tags with preview-before-approve, edit criteria and behavior, scan history for completeness, tune triage weights.',
    Icon: Tag,
    color: '#f59e0b',
  },
  {
    key: 'signatures',
    title: 'Signatures',
    description: 'Your compose signatures — the default auto-inserts, the rest sit behind the ✍ picker in the composer.',
    Icon: Pencil,
    color: '#00d9ff',
  },
  {
    key: 'sending',
    title: 'Sending',
    description: 'The undo-send window — and the future home of nudge auto-send and voice settings.',
    Icon: Send,
    color: '#10b981',
  },
];

const GROUP_META = {
  VIP:        { label: 'VIP', emoji: '⭐' },
  LEGAL:      { label: 'LEGAL', emoji: '⚖️' },
  PRIORITY:   { label: 'PRIORITY', emoji: '🔥' },
  PROVIDERS:  { label: 'OM/PROVIDERS', emoji: '🏥' },
  GLOBAL:     { label: 'GLOBAL', emoji: '🌍' },
  RCM_MGRS:   { label: 'RCM_MGRS', emoji: '💼' },
  IT:         { label: 'IT', emoji: '💻' },
  ACCOUNTING: { label: 'ACCOUNTING', emoji: '🧾' },
};

const AI_CATEGORY_META = {
  URGENT:       { emoji: '⚠️', label: 'URGENT' },
  CONFIDENTIAL: { emoji: '🔒', label: 'CONFIDENTIAL' },
  MEETING:      { emoji: '📅', label: 'Emails About Meetings' },
  ZOOM:         { emoji: '📹', label: 'ZOOM' },
  NEWSLETTER:   { emoji: '📰', label: 'NEWSLETTER' },
  NORMAL:       { emoji: '📬', label: 'NORMAL' },
};

function displayNameFromEmail(email) {
  return ((email || '').split('@')[0] || email)
    .split(/[.\-_]/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

const getUserEmail = () => localStorage.getItem('userEmail') || '';

// ─── ADMIN HOME ──────────────────────────────────────────────────────────
export function AdminHome() {
  const navigate = useNavigate();
  return (
    <div className="app-container">
      <main className="main-content">
        <AdminHeader title="Admin" />
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
          gap: '20px', maxWidth: MAX_WIDTH, margin: '28px auto 0',
        }}>
          {SECTIONS.map(section => (
            <div
              key={section.key}
              onClick={() => navigate(`/admin/${section.key}`)}
              className="email-card"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '18px', cursor: 'pointer',
                padding: '28px 30px', background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                borderRadius: '18px', transition: 'border-color 0.15s, transform 0.15s',
              }}
            >
              <div style={{
                width: '52px', height: '52px', borderRadius: '14px', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${section.color}18`, border: `1px solid ${section.color}30`,
              }}>
                <section.Icon size={24} color={section.color} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>
                  {section.title}
                </div>
                <div style={{ fontSize: '0.96rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  {section.description}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

// ─── SHARED HEADER ───────────────────────────────────────────────────────
function AdminHeader({ title }) {
  const navigate = useNavigate();
  return (
    <header className="top-bar">
      <div className="top-left">
        <div className="brand" style={{ marginRight: '8px' }}>
          <img
            src="https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp"
            alt="Horizon Family Medical Group"
            style={{ height: '36px', width: 'auto', objectFit: 'contain', filter: 'brightness(1.05)', display: 'block' }}
          />
        </div>
        <button
          onClick={() => navigate('/')}
          className="menu-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '600' }}
        >
          <ArrowLeft size={15} /> Dashboard
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Settings size={17} style={{ color: '#00d9ff' }} />
          <span style={{ fontSize: '1rem', fontWeight: '800', letterSpacing: '-0.3px' }}>{title}</span>
        </div>
      </div>
    </header>
  );
}

// ─── ADMIN SECTION ROUTER ────────────────────────────────────────────────
export function AdminSection() {
  const navigate = useNavigate();
  const { section } = useParams();
  const meta = SECTIONS.find(s => s.key === section);

  return (
    <div className="app-container">
      <main className="main-content">
        <AdminHeader title={meta ? meta.title : 'Admin'} />
        <div style={{ maxWidth: MAX_WIDTH, margin: '24px auto 0', padding: '0 24px' }}>
          <button
            onClick={() => navigate('/admin')}
            className="btn-copy"
            style={{ marginBottom: '22px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.9rem', padding: '8px 14px' }}
          >
            <ArrowLeft size={15} /> Back to Admin
          </button>

          {section === 'sending' ? <SendingSettings />
            : section === 'signatures' ? <SignaturesSettings />
            : section === 'organize' ? <OrganizeSettings />
            : section === 'tags' ? <TagsSettings />
            : (
              <div className="empty-placeholder" style={{ padding: '80px 40px', textAlign: 'center' }}>
                <div style={{ fontSize: '2.6rem', marginBottom: '18px' }}>🚧</div>
                <div style={{ fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '10px' }}>
                  {meta ? meta.title : 'This section'} is coming soon
                </div>
                <div style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: '1.75', maxWidth: '540px', margin: '0 auto' }}>
                  {meta ? meta.description : ''}
                </div>
              </div>
            )}
        </div>
      </main>
    </div>
  );
}

// ─── SENDING ─────────────────────────────────────────────────────────────
function SendingSettings() {
  const [seconds, setSeconds] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const userEmail = getUserEmail();
    if (!userEmail) { setLoaded(true); return; }
    fetch(`${API_BASE}/send-settings?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => setSeconds(data.undoWindowSeconds ?? 0))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const userEmail = getUserEmail();
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
    } catch (err) {
      console.error('save send settings error:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="email-card" style={{ display: 'block', padding: '32px 36px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '18px', maxWidth: '640px' }}>
      <div style={{ fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '10px' }}>Undo window</div>
      <div style={{ fontSize: '0.96rem', color: 'var(--text-secondary)', lineHeight: '1.65', marginBottom: '24px' }}>
        After you hit Send, the email waits this many seconds with an Undo button before actually leaving. 0 sends immediately.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <input
          type="number" min={0} max={30} value={seconds}
          onChange={e => { setSeconds(Math.max(0, Math.min(30, Number(e.target.value) || 0))); setSaved(false); }}
          disabled={!loaded}
          style={{ width: '90px', padding: '11px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.96rem' }}
        />
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>seconds (max 30)</span>
        <button onClick={save} disabled={saving || !loaded} className="btn-gradient" style={{ width: 'auto', padding: '10px 22px' }}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span style={{ fontSize: '0.86rem', color: '#10b981', fontWeight: '600' }}>✓ Saved</span>}
      </div>
    </div>
  );
}

// ─── SIGNATURES ──────────────────────────────────────────────────────────
const BADGE_STYLE = {
  fontSize: '0.62rem', fontWeight: '800', color: '#00d9ff', background: 'rgba(0,217,255,0.1)',
  border: '1px solid rgba(0,217,255,0.25)', borderRadius: '4px', padding: '2px 6px', flexShrink: 0,
};

function SignaturesSettings() {
  const [signatures, setSignatures] = useState([]);
  const [defaultNewId, setDefaultNewId] = useState(null);
  const [defaultReplyId, setDefaultReplyId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState(null); // null = list view, 'new' or an id = editor
  const [name, setName] = useState('');
  const [isDefaultNew, setIsDefaultNew] = useState(false);
  const [isDefaultReply, setIsDefaultReply] = useState(false);
  const [saving, setSaving] = useState(false);
  const [body, setBody] = useState('');

  const refresh = () => {
    const userEmail = getUserEmail();
    if (!userEmail) { setLoaded(true); return; }
    fetch(`${API_BASE}/signatures?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => {
        setSignatures(data.signatures || []);
        setDefaultNewId(data.defaultNewId || null);
        setDefaultReplyId(data.defaultReplyId || null);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (editingId === null) return;
    const sig = editingId === 'new' ? null : signatures.find(s => s.id === editingId);
    setBody(sig?.body || '');
  }, [editingId]);

  const startNew = () => {
    setEditingId('new');
    setName('');
    setIsDefaultNew(signatures.length === 0);
    setIsDefaultReply(signatures.length === 0);
  };

  const startEdit = (sig) => {
    setEditingId(sig.id);
    setName(sig.name);
    setIsDefaultNew(defaultNewId === sig.id);
    setIsDefaultReply(defaultReplyId === sig.id);
  };

  const save = async () => {
    const userEmail = getUserEmail();
    if (!userEmail || !name.trim()) return;
    setSaving(true);
    try {
      let savedId = editingId;
      if (editingId === 'new') {
        const created = await (await fetch(`${API_BASE}/signatures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: userEmail, name: name.trim() }),
        })).json();
        savedId = created.signature?.id;
        if (savedId) {
          await fetch(`${API_BASE}/signatures/${savedId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_email: userEmail, body }),
          });
        }
      } else {
        await fetch(`${API_BASE}/signatures/${savedId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_email: userEmail, name: name.trim(), body }),
        });
      }
      if (savedId) {
        await fetch(`${API_BASE}/signature-defaults`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_email: userEmail,
            defaultNewId: isDefaultNew ? savedId : (defaultNewId === savedId ? null : undefined),
            defaultReplyId: isDefaultReply ? savedId : (defaultReplyId === savedId ? null : undefined),
          }),
        });
      }
      refresh();
      setEditingId(null);
    } catch (err) {
      console.error('save signature error:', err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    const userEmail = getUserEmail();
    if (!userEmail || !window.confirm('Delete this signature?')) return;
    const res = await fetch(`${API_BASE}/signatures/${id}?user_email=${encodeURIComponent(userEmail)}`, { method: 'DELETE' });
    if (res.ok) refresh();
  };

  const setDefault = async (slot, id) => {
    const userEmail = getUserEmail();
    if (!userEmail) return;
    const res = await fetch(`${API_BASE}/signature-defaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_email: userEmail, [slot === 'new' ? 'defaultNewId' : 'defaultReplyId']: id || null }),
    });
    if (res.ok) {
      if (slot === 'new') setDefaultNewId(id || null);
      else setDefaultReplyId(id || null);
    }
  };

  if (editingId !== null) {
    return (
      <div className="email-card" style={{ display: 'block', padding: '30px 34px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '18px', maxWidth: '780px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '22px' }}>
          <span style={{ fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)' }}>
            {editingId === 'new' ? 'New signature' : 'Edit signature'}
          </span>
          <button onClick={() => setEditingId(null)} className="btn-copy" title="Cancel">
            <X size={15} />
          </button>
        </div>
        <input
          type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Signature name"
          style={{ width: '100%', padding: '12px 14px', marginBottom: '18px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: '600', boxSizing: 'border-box' }}
        />
        <div style={{ marginBottom: '22px' }}>
          <ReactQuill theme="snow" value={body} onChange={setBody} placeholder="Write this signature..." style={{ '--rte-min-h': '180px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '26px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.92rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isDefaultNew} onChange={e => setIsDefaultNew(e.target.checked)} />
            Set as default for new messages
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.92rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isDefaultReply} onChange={e => setIsDefaultReply(e.target.checked)} />
            Set as default for replies and forwards
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={() => setEditingId(null)} className="btn-copy">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="btn-gradient" style={{ width: 'auto', padding: '11px 24px' }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', marginBottom: '20px' }}>
        <div style={{ fontSize: '0.96rem', color: 'var(--text-secondary)', lineHeight: '1.65', maxWidth: '640px' }}>
          Add and edit the signatures available for your emails, and choose which one is used by default for new messages versus replies and forwards.
        </div>
        <button onClick={startNew} className="btn-gradient" style={{ width: 'auto', padding: '11px 22px', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <Plus size={16} /> Add signature
        </button>
      </div>

      <div className="email-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', padding: '24px 28px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', marginBottom: '18px' }}>
        <div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '10px' }}>Default for new messages</div>
          <select value={defaultNewId || ''} onChange={e => setDefault('new', e.target.value)} style={{ width: '100%', padding: '11px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.92rem', boxSizing: 'border-box' }}>
            <option value="">None</option>
            {signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '10px' }}>Default for replies and forwards</div>
          <select value={defaultReplyId || ''} onChange={e => setDefault('reply', e.target.value)} style={{ width: '100%', padding: '11px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.92rem', boxSizing: 'border-box' }}>
            <option value="">None</option>
            {signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {loaded && signatures.length === 0 && (
        <div className="empty-placeholder" style={{ padding: '40px', textAlign: 'center', fontSize: '0.92rem' }}>
          No signatures yet — add one above.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px' }}>
        {signatures.map(sig => (
          <div key={sig.id} className="email-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <span style={{ fontSize: '0.96rem', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.name}</span>
              {defaultNewId === sig.id && <span style={BADGE_STYLE}>NEW</span>}
              {defaultReplyId === sig.id && <span style={BADGE_STYLE}>REPLY</span>}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              <button onClick={() => startEdit(sig)} className="btn-copy" title="Edit"><Pencil size={15} /></button>
              <button onClick={() => remove(sig.id)} className="btn-copy" style={{ color: '#ef4444' }} title="Delete"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ORGANIZE & FILING ───────────────────────────────────────────────────
function OrganizeSettings() {
  const [members, setMembers] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [pendingAction, setPendingAction] = useState(null); // { type, folder, email }
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    fetch(`${API_BASE}/group-members`)
      .then(res => { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(setMembers)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  const commitAction = async () => {
    if (!pendingAction) return;
    setWorking(true);
    try {
      const res = await fetch(`${API_BASE}/group-members/${pendingAction.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: pendingAction.folder, email: pendingAction.email }),
      });
      if (res.ok) {
        const data = await res.json();
        setMembers(prev => ({ ...(prev || {}), [pendingAction.folder]: data.members || [] }));
        if (pendingAction.type === 'add') setNewEmail('');
      }
    } finally {
      setWorking(false);
      setPendingAction(null);
    }
  };

  return (
    <div>
      <div className="email-card" style={{ padding: '24px 28px', marginBottom: '22px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px' }}>
        <div style={{ fontSize: '1.05rem', fontWeight: '700', marginBottom: '8px' }}>Folder membership</div>
        <div style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: '1.65' }}>
          These 8 folders drive the inbox's team tabs. Add or remove people here — changes apply immediately, no restart needed.
        </div>
      </div>

      {failed ? (
        <div className="empty-placeholder" style={{ padding: '50px', textAlign: 'center', fontSize: '0.92rem' }}>
          Couldn't load folder membership. Try refreshing.
        </div>
      ) : members ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '14px', alignItems: 'start' }}>
          {Object.entries(GROUP_META).map(([folder, meta]) => {
            const folderMembers = members[folder] || [];
            const isOpen = expanded === folder;
            return (
              <div key={folder} className="email-card" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '16px', overflow: 'hidden' }}>
                <div
                  onClick={() => setExpanded(isOpen ? null : folder)}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '18px 20px', cursor: 'pointer' }}
                >
                  {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                  <span style={{ fontSize: '1.15rem' }}>{meta.emoji}</span>
                  <span style={{ fontWeight: '700', fontSize: '0.98rem', flex: 1 }}>{meta.label}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <Users size={14} /> {folderMembers.length}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 20px 18px', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', gap: '8px', margin: '16px 0 12px' }}>
                      <input
                        type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && newEmail.trim()) setPendingAction({ type: 'add', folder, email: newEmail.trim() }); }}
                        placeholder="name@hfmg.net"
                        style={{ flex: 1, padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.88rem' }}
                      />
                      <button
                        onClick={() => newEmail.trim() && setPendingAction({ type: 'add', folder, email: newEmail.trim() })}
                        disabled={!newEmail.trim()}
                        className="btn-copy"
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', opacity: newEmail.trim() ? 1 : 0.5 }}
                      >
                        <Plus size={14} /> Add
                      </button>
                    </div>
                    {folderMembers.length === 0 ? (
                      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', padding: '6px 2px' }}>No members yet.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {folderMembers.map(email => (
                          <div key={email} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px' }}>
                            <span style={{ fontSize: '0.88rem', fontWeight: '600' }}>{displayNameFromEmail(email)}</span>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
                            <button
                              onClick={() => setPendingAction({ type: 'remove', folder, email })}
                              title={`Remove from ${meta.label}`}
                              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-placeholder" style={{ padding: '50px', textAlign: 'center', fontSize: '0.92rem' }}>Loading…</div>
      )}

      {pendingAction && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => !working && setPendingAction(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px', padding: '24px 26px', maxWidth: '400px' }}>
            <div style={{ fontSize: '1rem', fontWeight: '700', marginBottom: '10px' }}>
              {pendingAction.type === 'add' ? 'Add to folder?' : 'Remove from folder?'}
            </div>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '18px' }}>
              {pendingAction.type === 'add' ? (
                <>Add <strong style={{ color: 'var(--text-primary)' }}>{pendingAction.email}</strong> to <strong style={{ color: 'var(--text-primary)' }}>{GROUP_META[pendingAction.folder].label}</strong>?</>
              ) : (
                <>Remove <strong style={{ color: 'var(--text-primary)' }}>{pendingAction.email}</strong> from <strong style={{ color: 'var(--text-primary)' }}>{GROUP_META[pendingAction.folder].label}</strong>?</>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setPendingAction(null)} disabled={working} className="btn-copy">Cancel</button>
              <button
                onClick={commitAction}
                disabled={working}
                style={{
                  padding: '7px 16px', borderRadius: '7px', border: 'none', fontSize: '0.8rem', fontWeight: '700',
                  cursor: working ? 'not-allowed' : 'pointer',
                  background: pendingAction.type === 'add' ? 'linear-gradient(135deg,#3b82f6,#2563eb)' : 'linear-gradient(135deg,#ef4444,#dc2626)',
                  color: 'white', opacity: working ? 0.6 : 1,
                }}
              >
                {working ? 'Working…' : pendingAction.type === 'add' ? 'Add' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TAGS ────────────────────────────────────────────────────────────────
function TagsSettings() {
  const userEmail = getUserEmail();
  const [aiCounts, setAiCounts] = useState(null);
  const [openCategory, setOpenCategory] = useState(null);
  const [categoryEmails, setCategoryEmails] = useState([]);
  const [categoryLoading, setCategoryLoading] = useState(false);

  const [tags, setTags] = useState([]);
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [savingTag, setSavingTag] = useState(false);

  const [previewByTag, setPreviewByTag] = useState({});   // tagId -> [{messageId, from, subject, received_at, matched, reason, selected}]
  const [previewingTag, setPreviewingTag] = useState(null);
  const [approvingTag, setApprovingTag] = useState(null);
  const [matchesOpenTag, setMatchesOpenTag] = useState(null);
  const [matchEmails, setMatchEmails] = useState([]);
  const [matchesLoading, setMatchesLoading] = useState(false);

  const loadSummary = () => {
    if (!userEmail) return;
    fetch(`${API_BASE}/tags/summary?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => setAiCounts(data.counts || {}))
      .catch(() => {});
  };

  const loadTags = () => {
    if (!userEmail) { setTagsLoaded(true); return; }
    fetch(`${API_BASE}/tags?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => setTags(data.tags || []))
      .catch(() => {})
      .finally(() => setTagsLoaded(true));
  };

  useEffect(() => { loadSummary(); loadTags(); }, []);

  const toggleCategory = (cat) => {
    if (openCategory === cat) { setOpenCategory(null); return; }
    setOpenCategory(cat);
    setCategoryLoading(true);
    fetch(`${API_BASE}/tags/ai-category/${encodeURIComponent(cat)}?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => setCategoryEmails(data.emails || []))
      .catch(() => setCategoryEmails([]))
      .finally(() => setCategoryLoading(false));
  };

  const createTag = async () => {
    if (!userEmail || !newName.trim() || !newPrompt.trim()) return;
    setSavingTag(true);
    try {
      await fetch(`${API_BASE}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, name: newName.trim(), prompt: newPrompt.trim() }),
      });
      setNewName('');
      setNewPrompt('');
      setCreating(false);
      loadTags();
    } finally {
      setSavingTag(false);
    }
  };

  const removeTag = async (tagId) => {
    if (!userEmail || !window.confirm('Delete this tag?')) return;
    const res = await fetch(`${API_BASE}/tags/${tagId}?user_email=${encodeURIComponent(userEmail)}`, { method: 'DELETE' });
    if (res.ok) {
      loadTags();
      setPreviewByTag(prev => { const next = { ...prev }; delete next[tagId]; return next; });
    }
  };

  const scanTag = async (tag) => {
    if (!userEmail) return;
    setPreviewingTag(tag.id);
    try {
      const results = (await (await fetch(`${API_BASE}/tags/${tag.id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail }),
      })).json()).results || [];
      setPreviewByTag(prev => ({ ...prev, [tag.id]: results.map(r => ({ ...r, selected: r.matched })) }));
    } finally {
      setPreviewingTag(null);
    }
  };

  const toggleResultSelected = (tagId, messageId) => {
    setPreviewByTag(prev => ({
      ...prev,
      [tagId]: prev[tagId].map(r => r.messageId === messageId ? { ...r, selected: !r.selected } : r),
    }));
  };

  const approveTag = async (tag) => {
    if (!userEmail) return;
    const matchedIds = (previewByTag[tag.id] || []).filter(r => r.selected).map(r => r.messageId);
    setApprovingTag(tag.id);
    try {
      await fetch(`${API_BASE}/tags/${tag.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, matchedIds }),
      });
      setPreviewByTag(prev => { const next = { ...prev }; delete next[tag.id]; return next; });
      loadTags();
    } finally {
      setApprovingTag(null);
    }
  };

  const toggleMatches = (tag) => {
    if (matchesOpenTag === tag.id) { setMatchesOpenTag(null); return; }
    setMatchesOpenTag(tag.id);
    setMatchesLoading(true);
    fetch(`${API_BASE}/tags/${tag.id}/matches?user_email=${encodeURIComponent(userEmail)}`)
      .then(res => res.json())
      .then(data => setMatchEmails(data.emails || []))
      .catch(() => setMatchEmails([]))
      .finally(() => setMatchesLoading(false));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
      {/* AI categories (read-only breakdown) */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <Sparkles size={17} color="#8b5cf6" />
          <span style={{ fontSize: '1.05rem', fontWeight: '700' }}>AI Tags</span>
          <span style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}>— categories the AI already decides, no folder involved</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px', alignItems: 'start' }}>
          {Object.entries(AI_CATEGORY_META).map(([cat, meta]) => {
            const isOpen = openCategory === cat;
            return (
              <div key={cat} className="email-card" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' }}>
                <div onClick={() => toggleCategory(cat)} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 18px', cursor: 'pointer' }}>
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span style={{ fontSize: '1.1rem' }}>{meta.emoji}</span>
                  <span style={{ fontWeight: '600', fontSize: '0.94rem', flex: 1 }}>{meta.label}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: '600' }}>{aiCounts ? (aiCounts[cat] ?? 0) : '…'}</span>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 18px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {categoryLoading ? (
                      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', padding: '6px 0' }}>Loading…</div>
                    ) : categoryEmails.length === 0 ? (
                      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', padding: '6px 0' }}>No emails in this category right now.</div>
                    ) : (
                      categoryEmails.map((e, i) => <EmailPreviewRow key={i} email={e} />)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom tags */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Tag size={17} color="#f59e0b" />
            <span style={{ fontSize: '1.05rem', fontWeight: '700' }}>Your tags</span>
          </div>
          <button onClick={() => setCreating(true)} className="btn-gradient" style={{ width: 'auto', padding: '9px 18px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plus size={15} /> New tag
          </button>
        </div>

        {creating && (
          <div className="email-card" style={{ padding: '20px 22px', marginBottom: '14px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px' }}>
            <input
              type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Tag name"
              style={{ width: '100%', padding: '10px 12px', marginBottom: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.92rem', fontWeight: '600', boxSizing: 'border-box' }}
            />
            <textarea
              value={newPrompt} onChange={e => setNewPrompt(e.target.value)}
              placeholder="Describe, in plain language, what should match this tag…"
              rows={3}
              style={{ width: '100%', padding: '10px 12px', marginBottom: '14px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-main)', color: 'var(--text-primary)', fontSize: '0.9rem', boxSizing: 'border-box', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setCreating(false)} className="btn-copy">Cancel</button>
              <button onClick={createTag} disabled={savingTag || !newName.trim() || !newPrompt.trim()} className="btn-gradient" style={{ width: 'auto', padding: '9px 18px' }}>
                {savingTag ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {tagsLoaded && tags.length === 0 && !creating && (
          <div className="empty-placeholder" style={{ padding: '40px', textAlign: 'center', fontSize: '0.92rem' }}>
            No custom tags yet — create one above.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {tags.map(tag => {
            const preview = previewByTag[tag.id];
            const matchesOpen = matchesOpenTag === tag.id;
            return (
              <div key={tag.id} className="email-card" style={{ padding: '18px 22px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: '700', fontSize: '0.98rem' }}>{tag.name}</span>
                      <span style={{
                        fontSize: '0.65rem', fontWeight: '800', padding: '2px 7px', borderRadius: '4px',
                        color: tag.status === 'active' ? '#10b981' : '#f59e0b',
                        background: tag.status === 'active' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
                      }}>
                        {tag.status === 'active' ? `ACTIVE · ${tag.matchedIds?.length || 0}` : 'DRAFT'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: '4px' }}>{tag.prompt}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    {tag.status === 'active' && (
                      <button onClick={() => toggleMatches(tag)} className="btn-copy" style={{ fontSize: '0.8rem' }}>
                        {matchesOpen ? 'Hide matches' : 'View matches'}
                      </button>
                    )}
                    <button onClick={() => scanTag(tag)} disabled={previewingTag === tag.id} className="btn-copy" style={{ fontSize: '0.8rem' }}>
                      {previewingTag === tag.id ? 'Scanning…' : 'Scan now'}
                    </button>
                    <button onClick={() => removeTag(tag.id)} className="btn-copy" style={{ color: '#ef4444' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {matchesOpen && (
                  <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {matchesLoading ? (
                      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>Loading…</div>
                    ) : matchEmails.length === 0 ? (
                      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>No matched emails.</div>
                    ) : (
                      matchEmails.map((e, i) => <EmailPreviewRow key={i} email={e} />)
                    )}
                  </div>
                )}

                {preview && (
                  <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border-color)' }}>
                    <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                      {preview.filter(r => r.selected).length} of {preview.length} selected — uncheck any you don't want, then approve.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '360px', overflowY: 'auto' }}>
                      {preview.map(r => (
                        <label key={r.messageId} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', opacity: r.matched ? 1 : 0.6 }}>
                          <input type="checkbox" checked={!!r.selected} onChange={() => toggleResultSelected(tag.id, r.messageId)} style={{ marginTop: '3px' }} />
                          <EmailPreviewRow email={r} />
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
                      <button onClick={() => setPreviewByTag(prev => { const next = { ...prev }; delete next[tag.id]; return next; })} className="btn-copy">
                        Discard
                      </button>
                      <button
                        onClick={() => approveTag(tag)}
                        disabled={approvingTag === tag.id}
                        className="btn-gradient"
                        style={{ width: 'auto', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '6px' }}
                      >
                        <Check size={15} /> {approvingTag === tag.id ? 'Approving…' : `Approve ${preview.filter(r => r.selected).length}`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmailPreviewRow({ email }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <span style={{ fontWeight: '700', fontSize: '0.88rem' }}>{email.from}</span>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {email.received_at ? new Date(email.received_at).toLocaleDateString() : ''}
        </span>
      </div>
      <div style={{ fontSize: '0.88rem' }}>{email.subject}</div>
      {email.reason && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{email.reason}</div>}
    </div>
  );
}
