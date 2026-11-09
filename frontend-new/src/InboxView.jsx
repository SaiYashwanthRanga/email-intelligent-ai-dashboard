import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  User, Paperclip, X, Clock, Download, Users, Loader, Flag, FolderPlus, UserMinus, Plus
} from 'lucide-react';
import EmailAutocomplete from './EmailAutocomplete';
import ToastContainer from './Toast';

// ─── SHARED EXPORTS (also used by DashboardView) ──────────────────────────
export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
export const getActiveUserEmail = () => localStorage.getItem("userEmail") || "";

export const replyToMail = async ({ messageItemId, replyBodyHtml, to, cc, attachments = [], isReplyAll = false }) => {
  const formData = new FormData();
  formData.append("messageItemId", messageItemId);
  formData.append("replyBodyHtml", replyBodyHtml);
  formData.append("targetUserEmail", getActiveUserEmail());
  formData.append("isReplyAll", isReplyAll ? "true" : "false");
  to.forEach(e => formData.append("to", e));
  cc.forEach(e => formData.append("cc", e));
  attachments.forEach(file => formData.append("attachments", file));
  return axios.post(`${API_BASE}/reply-email`, formData);
};

export const forwardMail = async ({ messageItemId, forwardBodyHtml, to, cc, attachments = [] }) => {
  const formData = new FormData();
  formData.append("messageItemId", messageItemId);
  formData.append("forwardBodyHtml", forwardBodyHtml);
  formData.append("targetUserEmail", getActiveUserEmail());
  to.forEach(e => formData.append("to", e));
  cc.forEach(e => formData.append("cc", e));
  attachments.forEach(file => formData.append("attachments", file));
  return axios.post(`${API_BASE}/forward-email`, formData);
};

export const markReadBackend = async (email) => {
  const messageId = email.id || email.messageId;
  if (!messageId) return;
  await axios.post(`${API_BASE}/mark-read`, { email: getActiveUserEmail(), messageId });
};

export const extractEmail = (value) => {
  if (!value) return "";
  const match = value.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : value;
};

export const CATEGORY_META = {
  VIP:          { emoji: "⭐", label: "VIP"          },
  LEGAL:        { emoji: "⚖️", label: "LEGAL"        },
  PRIORITY:     { emoji: "🔥", label: "PRIORITY"     },
  URGENT:       { emoji: "⚠️", label: "URGENT"       },
  CONFIDENTIAL: { emoji: "🔒", label: "CONFIDENTIAL" },
  MEETING:      { emoji: "📅", label: "Emails About Meetings" },
  ZOOM:         { emoji: "📹", label: "ZOOM"         },
  NEWSLETTER:   { emoji: "📰", label: "NEWSLETTER"   },
  NORMAL:       { emoji: "📬", label: "NORMAL"       },
  PROVIDERS:    { emoji: "🏥", label: "OM/PROVIDERS"    },
  PENDING:      { emoji: "⏳", label: "PENDING"      }
};

// ─── FLAG / CORRECTION DROPDOWN ───────────────────────────────────────────
const FLAGGABLE_CATS = ['URGENT', 'PRIORITY', 'MEETING', 'NORMAL', 'NEWSLETTER'];

export function FlagDropdown({ email, onSubmit, onClose, submitting, success }) {
  const currentCat = (email?.category || 'NORMAL').toUpperCase();
  const options    = FLAGGABLE_CATS.filter(c => c !== currentCat);
  const [picked,  setPicked]  = useState(null);
  const [reason,  setReason]  = useState('');

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        marginTop: '10px', borderRadius: '10px', overflow: 'hidden',
        border: '1px solid rgba(239,68,68,0.25)',
        background: 'var(--bg-card)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        animation: 'fadeSlideUp 0.22s cubic-bezier(0.2,0,0,1) both',
      }}
    >
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', background:'rgba(239,68,68,0.06)', borderBottom:'1px solid rgba(239,68,68,0.15)' }}>
        <span style={{ fontSize:'0.8rem', fontWeight:'800', color:'#f87171', display:'flex', alignItems:'center', gap:'6px' }}>
          <Flag size={13} /> Wrong classification?
        </span>
        <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', padding:'2px 6px', fontSize:'0.85rem' }}>✕</button>
      </div>

      {success ? (
        <div style={{ padding:'18px 14px', textAlign:'center', fontSize:'0.85rem', fontWeight:'700', color:'#4ade80' }}>
          ✅ Correction submitted — AI will learn from this!
        </div>
      ) : (
        <>
          {/* Category picker */}
          <div style={{ padding:'12px 14px 6px' }}>
            <div style={{ fontSize:'0.68rem', fontWeight:'800', color:'var(--text-muted)', letterSpacing:'0.8px', marginBottom:'8px' }}>SHOULD BE CLASSIFIED AS</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
              {options.map(cat => {
                const meta = CATEGORY_META[cat] || {};
                const sel  = picked === cat;
                return (
                  <button key={cat} onClick={() => setPicked(cat)} style={{
                    fontSize:'0.75rem', fontWeight:'700', padding:'5px 12px', borderRadius:'6px', cursor:'pointer', border:'1px solid',
                    borderColor: sel ? 'rgba(99,102,241,0.6)' : 'var(--border-color)',
                    background:  sel ? 'rgba(99,102,241,0.15)' : 'transparent',
                    color:       sel ? '#a5b4fc' : 'var(--text-secondary)',
                    transition:  'all 0.15s',
                  }}>
                    {meta.emoji} {meta.label || cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reason textarea */}
          <div style={{ padding:'8px 14px' }}>
            <div style={{ fontSize:'0.68rem', fontWeight:'800', color:'var(--text-muted)', letterSpacing:'0.8px', marginBottom:'6px' }}>WHY IS THIS WRONG? <span style={{ fontWeight:'400', textTransform:'none' }}>(helps AI learn faster)</span></div>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. This is a status update, not urgent — no deadline or consequence mentioned"
              rows={2}
              style={{ width:'100%', padding:'8px 10px', borderRadius:'7px', border:'1px solid var(--border-color)', background:'var(--bg-main)', color:'var(--text-primary)', fontSize:'0.8rem', resize:'vertical', boxSizing:'border-box' }}
            />
          </div>

          {/* Footer */}
          <div style={{ display:'flex', justifyContent:'flex-end', gap:'8px', padding:'8px 14px 12px' }}>
            <button onClick={onClose} style={{ padding:'6px 14px', borderRadius:'7px', border:'1px solid var(--border-color)', background:'transparent', color:'var(--text-secondary)', fontSize:'0.78rem', fontWeight:'600', cursor:'pointer' }}>
              Cancel
            </button>
            <button
              onClick={() => picked && onSubmit(email, picked, reason)}
              disabled={!picked || submitting}
              style={{
                padding:'6px 16px', borderRadius:'7px', border:'none', fontSize:'0.78rem', fontWeight:'700', cursor: (!picked || submitting) ? 'not-allowed' : 'pointer',
                background: (!picked || submitting) ? 'rgba(99,102,241,0.3)' : 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
                color: 'white', opacity: (!picked || submitting) ? 0.6 : 1,
                display:'flex', alignItems:'center', gap:'6px',
              }}
            >
              {submitting ? <><Loader size={12} className="animate-spin" /> Submitting...</> : '🚩 Submit Correction'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function FolderPickerDropdown({ senderEmail, onPick, onClose }) {
  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        marginTop: '10px', borderRadius: '10px', overflow: 'hidden',
        border: '1px solid rgba(59,130,246,0.25)',
        background: 'var(--bg-card)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        animation: 'fadeSlideUp 0.22s cubic-bezier(0.2,0,0,1) both',
      }}
    >
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', background:'rgba(59,130,246,0.06)', borderBottom:'1px solid rgba(59,130,246,0.15)' }}>
        <span style={{ fontSize:'0.8rem', fontWeight:'800', color:'#60a5fa', display:'flex', alignItems:'center', gap:'6px' }}>
          <FolderPlus size={13} /> Add {senderEmail} to...
        </span>
        <button onClick={onClose} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', padding:'2px 6px', fontSize:'0.85rem' }}>✕</button>
      </div>

      {/* Folder picker */}
      <div style={{ padding:'12px 14px' }}>
        <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
          {ADDABLE_FOLDERS.map(({ name, label, emoji }) => (
            <button key={name} onClick={() => onPick(name)} style={{
              fontSize:'0.75rem', fontWeight:'700', padding:'5px 12px', borderRadius:'6px', cursor:'pointer',
              border:'1px solid var(--border-color)', background:'transparent', color:'var(--text-secondary)', transition:'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)'; e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; e.currentTarget.style.color = '#93c5fd'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              {emoji} {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HtmlEmailRenderer({ body, darkMode = false }) {
  const iframeRef = React.useRef(null);
  const [iframeHeight, setIframeHeight] = useState(200);

  const srcDoc = React.useMemo(() => {
    if (!body) return "";
    const isHtml = /<[a-zA-Z][^>]*>/i.test(body);
    // Strip cid: inline-image references before injecting into the iframe.
    // Browsers cannot resolve Content-ID URLs (MIME/email standard, not HTTP),
    // so every cid: src fires ERR_UNKNOWN_URL_SCHEME. Replace with a transparent
    // 1x1 GIF — no network request made, no console noise, no broken-image icons.
    const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const sanitized = isHtml
      ? body.replace(/src=["'`]cid:[^"'`]*["'`]/gi, `src="${TRANSPARENT_PIXEL}"`)
      : body;
    const content = isHtml ? sanitized : sanitized.split("\n").join("<br/>");
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base target="_blank" rel="noopener noreferrer">
<style>
  html, body { margin: 0; padding: 0; background: ${darkMode ? '#0f1117' : '#ffffff'}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Calibri, Arial, sans-serif; font-size: 14px; line-height: 1.5; }
  img { max-width: 100%; height: auto; }
  img[src^="cid:"] { display: none !important; }
  body { overflow-x: auto; }
  a { cursor: pointer !important; }
  ${darkMode ? `
  body, html { background: #0f1117 !important; }
  p, span, div, td, th, li, h1, h2, h3, h4, h5, h6, font { color: #e2e8f0 !important; }
  table, td, th { background-color: transparent !important; }
  a { color: #60a5fa !important; }
  ` : ''}
</style>
<script>
  document.addEventListener('click', function(e) {
    var el = e.target.closest('a[href]');
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  });
<\/script>
</head>
<body>${content}</body>
</html>`;
  }, [body, darkMode]);

  const handleLoad = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument || iframeRef.current?.contentWindow?.document;
      if (!doc?.body) return;
      const resize = () => {
        const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
        if (h > 0) setIframeHeight(h + 20);
      };
      resize();
      setTimeout(resize, 600);
    } catch (_) {}
  }, []);

  if (!body) return (
    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", padding: "12px 0" }}>
      No content available
    </div>
  );

  return (
    <div style={{ width: "100%", overflowX: "auto", background: darkMode ? "#0f1117" : "#ffffff", borderRadius: "6px" }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        onLoad={handleLoad}
        style={{ width: "100%", minWidth: "320px", height: `${iframeHeight}px`, border: "none", display: "block" }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        title="Email Content"
      />
    </div>
  );
}

// ─── PRIVATE ──────────────────────────────────────────────────────────────
const DEFAULT_REPLY_STATE = {
  showReply: false, replyBody: "", replyTo: "", replyCc: "",
  drafting: false, attachments: [], isReplyAll: false
};
const DEFAULT_FORWARD_STATE = {
  showForward: false, forwardBody: "", forwardTo: "", forwardCc: "",
  sending: false, attachments: []
};

const formatFileSize = (bytes) => {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return " (<0.1 MB)";
  return ` (${mb.toFixed(2)} MB)`;
};

const getEmailSender = (email) => {
  if (!email) return "Unknown Sender";
  if (typeof email.from === "string") return email.from;
  if (Array.isArray(email.from) && email.from.length > 0) return email.from[0];
  return "Unknown Sender";
};

const RoundCheckbox = ({ checked, onChange, onClick }) => (
  <div
    onClick={onClick}
    onChange={onChange}
    style={{
      width: '13px', height: '13px', borderRadius: '4px', flexShrink: 0,
      border: checked ? '2px solid #3b82f6' : '2px solid rgba(148,163,184,0.4)',
      background: checked ? 'linear-gradient(135deg, #00d9ff, #8b5cf6)' : 'rgba(255,255,255,0.05)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'all 0.15s ease',
      boxShadow: checked ? '0 0 0 2px rgba(59,130,246,0.2)' : 'none'
    }}
  >
    {checked && (
      <svg width="7" height="6" viewBox="0 0 10 8" fill="none">
        <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )}
  </div>
);

const RoundCheckboxIndeterminate = ({ checked, indeterminate, onChange }) => (
  <div
    onClick={onChange}
    style={{
      width: '13px', height: '13px', borderRadius: '4px', flexShrink: 0,
      border: (checked || indeterminate) ? '2px solid #3b82f6' : '2px solid rgba(148,163,184,0.4)',
      background: (checked || indeterminate) ? 'linear-gradient(135deg, #00d9ff, #8b5cf6)' : 'rgba(255,255,255,0.05)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'all 0.15s ease',
      boxShadow: (checked || indeterminate) ? '0 0 0 2px rgba(59,130,246,0.2)' : 'none'
    }}
  >
    {indeterminate && !checked && (
      <div style={{ width: '6px', height: '2px', background: 'white', borderRadius: '1px' }} />
    )}
    {checked && (
      <svg width="7" height="6" viewBox="0 0 10 8" fill="none">
        <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )}
  </div>
);

// ─── FOLDER SENDER SETS ──────────────────────────────────────────────────
// PHASE 5: no longer the source of truth for GLOBAL/RCM_MGRS/IT/ACCOUNTING/
// PROVIDERS — that's /api/group-members now (see LIVE_* sets + the mount
// effect above). These 5 stay here only as the fallback value used before
// that fetch resolves, or if it ever fails, so folder tabs degrade to
// "slightly stale" instead of "empty" rather than deleting the safety net
// outright. RINKU_SENDERS_SET and SALLY_SENDERS_SET are still the real,
// only source for those two (single-person, backend-unmanaged) folders.
const GLOBAL_SENDERS_SET = new Set(["thagarapu.rajashekar@hfmg.net","sam.sundar@hfmg.net","shahana.parveen@hfmg.net","ranjitha.d@hfmg.net","nivetha.r@hfmg.net","swetha.s@hfmg.net","deva.v@hfmg.net","sachin.m@hfmg.net","adhityanarayanan@hfmg.net","prakash.nagaraj@hfmg.net","amreesh.karthikeyan@hfmg.net","muniappan.v@hfmg.net","srinivasan.v@hfmg.net","irfan.k@hfmg.net","suresh.tm@hfmg.net","ramji.vijayakumar@hfmg.net","santhosh.r@hfmg.net","jassar.mohammed@hfmg.net","abdul.raffi@hfmg.net","dasarathana@hfmg.net","gopinath.a@hfmg.net","global.office@hfmg.net","vidhya.nainan@hfmg.net","c.deepa@hfmg.net","ranga.saiyashwanth@hfmg.net","pradeep.kumars@hfmg.net","udai.saikarumuri@hfmg.net","chandu.natakarani@hfmg.net","jai.kumar@hfmg.net","logesh.r@hfmg.net","arogkia.vijayakumar@hfmg.net","k.k.vinesh@hfmg.net"]);
const RCM_SENDERS_SET      = new Set(["mary.norris@hfmg.net","alyssa.ellison@hfmg.net","dana.labarbera@hfmg.net","sonya.conklin@hfmg.net","kathy.villanueva@hfmg.net"]);
const RINKU_SENDERS_SET    = new Set(["rinku.singh@hfmg.net"]);
const IT_SENDERS_SET       = new Set(["cesar.huaman@hfmg.net","hira.ahmed@hfmg.net","philip.abin@hfmg.net","colin.berardinelli@hfmg.net","ramon.romero@hfmg.net"]);
const SALLY_SENDERS_SET    = new Set(["sally.kelly@hfmg.net"]);
const ACCOUNTING_SENDERS_SET = new Set(["mary.loekle@hfmg.net","kathleen.exley@hfmg.net","kathleen.mazza@hfmg.net","karen.knapp@hfmg.net","laura.biggio@hfmg.net"]);
const PROVIDERS_SENDERS_SET = new Set(["daniel.ahn@hfmg.net","julianna.manno@hfmg.net","kattreed@lycos.com","victoria.avidano@hfmg.net","kristina.barnhart@hfmg.net","melissa.beck@hfmg.net","erin.botti@hfmg.net","maureen.brady@hfmg.net","lyndsay.brischoux@hfmg.net","james.carroll@hfmg.net","dncassimatis@hvc.rr.com","myrelle.castro@hfmg.net","jessica.cohn@hfmg.net","paula.coleman@hfmg.net","rachelcolivn@gmail.com","gina.cuneo-ramos@hfmg.net","mariya.d'agnese@hfmg.net","alexandra.depastene@hfmg.net","shannon.diehl@hfmg.net","erin.duffell@hfmg.net","cortney.duval@hfmg.net","stephanie.feely@hfmg.net","rebecca.fried@hfmg.net","aviva.frommer@hfmg.net","alisha.fuller@hfmg.net","sharon.garcia@hfmg.net","joel.gish@hfmg.net","kerry.gomulka@hfmg.net","gary.gorodokin@hfmg.net","matthew.higgins@hfmg.net","nathalie.hirsch@hfmg.net","delphine.hyppolite@hfmg.net","elizabeth.jahn@hfmg.net","sjensen@hfmg.net","caroline.kanecivitano@hfmg.net","megan.kauffold@hfmg.net","nicole.kelly@hfmg.net","farhana.kharodia@hfmg.net","christina.klein@hfmg.net","connor.kortright@hfmg.net","jason.lee@hfmg.net","jenifer.lucia@hfmg.net","krystle.mabee@hfmg.net","harry.mathura@hfmg.net","alomie.mccallum@hfmg.net","allison.mcgrath@hfmg.net","bonnie.muller@hfmg.net","kevin.myers@hfmg.net","kausar.nazir@hfmg.net","christina.notaro-barton@hfmg.net","sobligado@gmail.com","julie.ormiston@hfmg.net","eric.paolilli@hfmg.net","nakisha.pierce@hfmg.net","profeta.george@hfmg.net","steven.ramm@hfmg.net","adrienne.rascoe@hfmg.net","jenna.reinhardt@hfmg.net","nicole.riello@hfmg.net","samantha.rue@hfmg.net","barbara.rys@hfmg.net","karen.schaffer@hfmg.net","malisung@aol.com","arianne.sonnenschein@hfmg.net","barbara.spreitzer@hfmg.net","kristina.stipak@hfmg.net","laura.stough@hfmg.net","carol.taylor@hfmg.net","andreia.tremper@hfmg.net","kristen.trentacosta@hfmg.net","laura.woods@hfmg.net","lauren.yunker@hfmg.net","madeleine.ziegler@hfmg.net","shasky.charles@hfmg.net","jennifer.wilken@hfmg.net","lon.merin@hfmg.net","andrea.corey@hfmg.net","maryannrandone@hfmg.net","katey.knapp@hfmg.net","mary.heil@hfmg.net","allison.mancuso@hfmg.net","brenda.deangelo@hfmg.net","carol.forde@hfmg.net","candy.shurter@hfmg.net","patti.deyo@hfmg.net","amanda.bonilla@hfmg.net","renee.capone-kalter@hfmg.net","michele.muller@hfmg.net","chelsea.lafurge@hfmg.net","lisa.salvato@hfmg.net","lauren.walls@hfmg.net","theresa.zapanta@hfmg.net","michelle.figueroa@hfmg.net","ruqaiya.choudhury@hfmg.net","brenda.solis@hfmg.net","melissa.palazzolo@hfmg.net","sandra.johnson@hfmg.net","cheryl.soto@hfmg.net","tracey.muller@hfmg.net","peggy.mccann@hfmg.net","caitlyn.johnson@hfmg.net","heather.decker@hfmg.net","mary.berenson@hfmg.net","keri.romero@hfmg.net","megan.yorke@hfmg.net"]);

// ─── "VIEW MEMBERS" LOOKUPS (folder icon → who's in this group) ────────────
// Team folders: membership is already known client-side (the sets above),
// so these render straight from JS with no API call.
const FOLDER_GROUPS = {
  GLOBAL:     { label: 'GLOBAL',       emoji: '🌍', set: GLOBAL_SENDERS_SET },
  RCM_MGRS:   { label: 'RCM_MGRS',     emoji: '💼', set: RCM_SENDERS_SET },
  RINKU:      { label: 'RINKU',        emoji: '👤', set: RINKU_SENDERS_SET },
  IT:         { label: 'IT',           emoji: '💻', set: IT_SENDERS_SET },
  SALLY:      { label: 'SALLY',        emoji: '👤', set: SALLY_SENDERS_SET },
  ACCOUNTING: { label: 'ACCOUNTING',   emoji: '🧾', set: ACCOUNTING_SENDERS_SET },
  PROVIDERS:  { label: 'OM/PROVIDERS', emoji: '🏥', set: PROVIDERS_SENDERS_SET },
};

// Category tabs: membership lives server-side only (vip_list.json / legal_list.json /
// priority_list.json) — fetched on demand from /api/group-members and cached in state.
const CATEGORY_GROUPS = {
  VIP:      { label: 'VIP',      emoji: '⭐' },
  LEGAL:    { label: 'LEGAL',    emoji: '⚖️' },
  PRIORITY: { label: 'PRIORITY', emoji: '🔥' },
};

// ─── FOLDER MEMBERSHIP MANAGEMENT (add/remove) ─────────────────────────────
// The 8 folders services.py's GROUP_FOLDER_FILES exposes via /api/group-members.
// Their "View Members" modal now always fetches live (below) instead of
// reading the hardcoded *_SENDERS_SET constants above — but the actual inbox
// folder-tab FILTERING still reads those constants directly and is untouched
// by anything in this section. RINKU/SALLY (single-person display folders)
// aren't part of this — they keep the old instant-from-JS "view only" path.
const MANAGEABLE_META = {
  VIP:        { label: 'VIP',          emoji: '⭐' },
  LEGAL:      { label: 'LEGAL',        emoji: '⚖️' },
  PRIORITY:   { label: 'PRIORITY',     emoji: '🔥' },
  PROVIDERS:  { label: 'OM/PROVIDERS', emoji: '🏥' },
  GLOBAL:     { label: 'GLOBAL',       emoji: '🌍' },
  RCM_MGRS:   { label: 'RCM_MGRS',     emoji: '💼' },
  IT:         { label: 'IT',           emoji: '💻' },
  ACCOUNTING: { label: 'ACCOUNTING',   emoji: '🧾' },
};
const MANAGEABLE_FOLDERS = Object.keys(MANAGEABLE_META);

// The 7-folder picker shown when adding someone directly from an inbox row —
// matches the 7 folders Jim asked for. PRIORITY isn't offered here (it wasn't
// one of the 7), though the API and the modal-based add/remove above both
// still support it if that changes later.
const ADDABLE_FOLDERS = [
  { name: 'VIP',        label: 'VIP',          emoji: '⭐' },
  { name: 'LEGAL',      label: 'LEGAL',        emoji: '⚖️' },
  { name: 'GLOBAL',     label: 'GLOBAL',       emoji: '🌍' },
  { name: 'RCM_MGRS',   label: 'RCM_MGRS',     emoji: '💼' },
  { name: 'IT',         label: 'IT',           emoji: '💻' },
  { name: 'ACCOUNTING', label: 'ACCOUNTING',   emoji: '🧾' },
  { name: 'PROVIDERS',  label: 'OM/PROVIDERS', emoji: '🏥' },
];

// "first.last@hfmg.net" → "First Last" — mirrors the display-name logic
// /api/search-contacts already uses, so names look consistent app-wide.
const emailToDisplayName = (email) => {
  const local = (email || '').split('@')[0] || email || '';
  return local
    .split('.')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || email;
};

// ─── INBOX VIEW ───────────────────────────────────────────────────────────

function InboxView({
  emails,
  filteredEmails,
  groupedEmails,
  activeTab,
  setActiveTab,
  activeFolder,
  setActiveFolder,
  activeCategory,
  setActiveCategory,
  selectedEmail,
  setSelectedEmail,
  senderFilter,
  setSenderFilter,
  inboxReady,
  isAnalyzingBackground,
  markAsRead,
  markAsReplied,
  markAsReadById,
  formatDate,
  getEffectiveReceivedAt,
  getEmailBody,
  handleFileDownload,
  isFileDownloading,
  getFileProgress,
  totalEmailCount,
  // Flag / correction props
  flagOpen,
  setFlagOpen,
  flagSubmitting = {},
  flagSuccess    = {},
  submitCorrection,
}) {
  const navigate = useNavigate();

  const [inlineReplyState,   setInlineReplyState]   = useState({});
  const [inlineForwardState, setInlineForwardState] = useState({});
  const [selectedCards,      setSelectedCards]      = useState(new Set());
  const [searchQuery,        setSearchQuery]        = useState("");
  // "View members" modal — shared by team folders (GLOBAL, IT, etc.) and
  // the VIP/LEGAL/PRIORITY category tabs.
  const [membersModal,       setMembersModal]       = useState(null); // { folderName?, title, emoji, members: [{name,email}] } | null
  const [groupMembersData,   setGroupMembersData]   = useState(null); // cached /api/group-members response
  // ── Folder membership management (add/remove) ──────────────────────────
  const [folderPickerFor,       setFolderPickerFor]       = useState(null); // emailId with the "add to folder" picker open, or null
  const membersModalEmailRef = useRef(null); // lets the modal's Add button read pending (uncommitted) typed text — see EmailAutocomplete's getAllEmails()
  const [newMemberInput,        setNewMemberInput]        = useState("");   // EmailAutocomplete value inside the members modal's add row
  const [memberActionPending,   setMemberActionPending]   = useState(null); // { type:'add'|'remove', folderName, folderLabel, emails:[] } | null — awaiting Y/N
  const [memberActionSubmitting, setMemberActionSubmitting] = useState(false);
  // Local toast queue — InboxView didn't have one before; same self-contained
  // pattern as Calendarview.jsx rather than a new prop-threading path.
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  // ── PHASE 4 CUTOVER ──────────────────────────────────────────────────────
  // Proactively load live folder membership on mount, rather than waiting for
  // someone to open a "View Members" modal first — folder-tab FILTERING below
  // needs this available as soon as possible, not just the modal display.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/group-members`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setGroupMembersData(data);
      } catch (err) {
        console.error("Failed to preload group members — folder tabs will use the fallback lists until this succeeds:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live membership for the 5 backend-managed team folders, with graceful
  // fallback to the original hardcoded *_SENDERS_SET constants (declared near
  // the top of this file) until the fetch above resolves, or if it ever fails.
  // This is now what folder-tab filtering actually uses — the constants are
  // seed/fallback data only, no longer the source of truth. RINKU/SALLY are
  // NOT part of this — they're single-person display folders outside this
  // feature's scope and keep reading their hardcoded sets directly, always.
  const liveOrFallback = (folderName, fallbackSet) =>
    (groupMembersData && Array.isArray(groupMembersData[folderName]))
      ? new Set(groupMembersData[folderName].map(e => e.toLowerCase()))
      : fallbackSet;

  const LIVE_GLOBAL_SET     = useMemo(() => liveOrFallback('GLOBAL', GLOBAL_SENDERS_SET),         [groupMembersData]);
  const LIVE_RCM_SET        = useMemo(() => liveOrFallback('RCM_MGRS', RCM_SENDERS_SET),           [groupMembersData]);
  const LIVE_IT_SET         = useMemo(() => liveOrFallback('IT', IT_SENDERS_SET),                  [groupMembersData]);
  const LIVE_ACCOUNTING_SET = useMemo(() => liveOrFallback('ACCOUNTING', ACCOUNTING_SENDERS_SET),  [groupMembersData]);
  const LIVE_PROVIDERS_SET  = useMemo(() => liveOrFallback('PROVIDERS', PROVIDERS_SENDERS_SET),    [groupMembersData]);
  const [inlineRsvpState,   setInlineRsvpState]    = useState({});
  const [showScrollTop,     setShowScrollTop]      = useState(false);
  const [replyAllLoading,   setReplyAllLoading]    = useState({});
  const feedRef = useRef(null);

  // Find nearest scrollable ancestor (the left pane in DashboardView scrolls, not feed-container)
  const getScrollParent = () => {
    let el = feedRef.current?.parentElement;
    while (el) {
      const overflow = window.getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  };

  // Show back-to-top button after scrolling 300px
  useEffect(() => {
    const parent = getScrollParent();
    if (!parent) return;
    const onScroll = () => setShowScrollTop(parent.scrollTop > 300);
    parent.addEventListener('scroll', onScroll);
    return () => parent.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const parent = getScrollParent();
    if (!parent) return;
    const onScroll = () => setShowScrollTop(parent.scrollTop > 300);
    parent.addEventListener('scroll', onScroll);
    return () => parent.removeEventListener('scroll', onScroll);
  }, []);

  const toggleCardSelection = (emailId) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      next.has(emailId) ? next.delete(emailId) : next.add(emailId);
      return next;
    });
  };
  const selectAll    = (emailList) => setSelectedCards(new Set(emailList.map(e => e.id || e.messageId)));
  const clearSelection = ()         => setSelectedCards(new Set());

  const getEmailReplyState = useCallback((emailId) => inlineReplyState[emailId] || DEFAULT_REPLY_STATE, [inlineReplyState]);
  const setEmailReplyState = useCallback((emailId, updates) => {
    setInlineReplyState(prev => ({ ...prev, [emailId]: { ...(prev[emailId] || DEFAULT_REPLY_STATE), ...updates } }));
  }, []);

  const getEmailForwardState = useCallback((emailId) => inlineForwardState[emailId] || DEFAULT_FORWARD_STATE, [inlineForwardState]);
  const setEmailForwardState = useCallback((emailId, updates) => {
    setInlineForwardState(prev => ({ ...prev, [emailId]: { ...(prev[emailId] || DEFAULT_FORWARD_STATE), ...updates } }));
  }, []);

  const handleReplyAttachmentSelect = (emailId, files) => {
    if (!files || !files.length) return;
    setEmailReplyState(emailId, { attachments: [...getEmailReplyState(emailId).attachments, ...Array.from(files)] });
  };
  const removeReplyAttachment = (emailId, index) => {
    setEmailReplyState(emailId, { attachments: getEmailReplyState(emailId).attachments.filter((_, i) => i !== index) });
  };

  const getRsvpState = (emailId) => inlineRsvpState[emailId] || { status: null, loading: false };

  const handleRsvp = useCallback(async (email, action) => {
    const emailId = email.id || email.messageId;
    setInlineRsvpState(prev => ({ ...prev, [emailId]: { ...prev[emailId], loading: true } }));
    try {
      const userEmail = localStorage.getItem("userEmail") || "";
      const emailDate = new Date(email.received_at || email.received || email.date || Date.now());
      const startDate = new Date(emailDate); startDate.setDate(startDate.getDate() - 7);
      const endDate   = new Date(emailDate); endDate.setDate(endDate.getDate() + 30);
      const meetsRes = await fetch(
        `${API_BASE}/meetings?email=${encodeURIComponent(userEmail)}&startDate=${startDate.toISOString().slice(0,10)}&endDate=${endDate.toISOString().slice(0,10)}`
      );
      if (!meetsRes.ok) throw new Error("Could not fetch calendar meetings");
      const meetings = await meetsRes.json();
      const stripPrefix = s => (s || "").replace(/^(re|fwd|fw|aw)\s*:\s*/gi, "").trim().toLowerCase();
      const emailSubject = stripPrefix(email.subject);
      const match = meetings.find(m => stripPrefix(m.subject) === emailSubject);
      if (!match) {
        setInlineRsvpState(prev => ({ ...prev, [emailId]: { status: null, loading: false, useCalendar: true } }));
        return;
      }
      const meetingId = match.meetingId || match.id;
      const res = await fetch(
        `${API_BASE}/meetings/respond?meetingId=${encodeURIComponent(meetingId)}&action=${action}&targetUserEmail=${encodeURIComponent(userEmail)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.detail === "MEETING_REQUEST_TYPE_MISMATCH") {
          setInlineRsvpState(prev => ({ ...prev, [emailId]: { status: null, loading: false, useCalendar: true } }));
          return;
        }
        throw new Error(err.detail || `Server error ${res.status}`);
      }
      const statusMap = { Accept: "accepted", Decline: "declined", Tentative: "tentative" };
      setInlineRsvpState(prev => ({ ...prev, [emailId]: { status: statusMap[action], loading: false } }));
    } catch (err) {
      console.error("RSVP failed:", err);
      setInlineRsvpState(prev => ({ ...prev, [emailId]: { status: null, loading: false, error: err.message } }));
    }
  }, []);

  const sendInlineReply = useCallback(async (email) => {
    const emailId = email.id || email.messageId;
    const state   = getEmailReplyState(emailId);
    markAsReplied(emailId, true);
    markAsReadById(emailId);
    setEmailReplyState(emailId, { drafting: true });
    try {
      const messageItemId = email.messageId || email.id;
      if (!messageItemId) throw new Error("Missing messageItemId");
      await replyToMail({
        messageItemId,
        replyBodyHtml: `<p>${state.replyBody.replace(/\n/g, "<br/>")}</p>`,
        to: Array.isArray(state.replyTo) ? state.replyTo : state.replyTo.split(",").map(e => e.trim()).filter(Boolean),
        cc: Array.isArray(state.replyCc) ? state.replyCc : state.replyCc.split(",").map(e => e.trim()).filter(Boolean),
        attachments: state.attachments,
        isReplyAll: state.isReplyAll || false
      });
      await markReadBackend(email);
      setEmailReplyState(emailId, { showReply: false, replyBody: "", replyTo: "", replyCc: "", drafting: false, attachments: [] });
    } catch (err) {
      console.error("❌ Reply failed:", err);
      markAsReplied(emailId, false);
      markAsReadById(emailId, false);
      alert("Failed to send reply");
      setEmailReplyState(emailId, { drafting: false });
    }
  }, [getEmailReplyState, setEmailReplyState, markAsReplied, markAsReadById]);

  const sendInlineForward = useCallback(async (email) => {
    const emailId = email.id || email.messageId;
    const state   = getEmailForwardState(emailId);
    if (!state.forwardTo.trim()) return;
    setEmailForwardState(emailId, { sending: true });
    try {
      const messageItemId = email.messageId || email.id;
      if (!messageItemId) throw new Error("Missing messageItemId");
      await forwardMail({
        messageItemId,
        forwardBodyHtml: `<p>${state.forwardBody.replace(/\n/g, "<br/>")}</p>`,
        to: state.forwardTo.split(",").map(e => e.trim()).filter(Boolean),
        cc: state.forwardCc.split(",").map(e => e.trim()).filter(Boolean),
        attachments: state.attachments
      });
      setEmailForwardState(emailId, { showForward: false, forwardBody: "", forwardTo: "", forwardCc: "", sending: false, attachments: [] });
    } catch (err) {
      console.error("❌ Forward failed:", err);
      alert("Failed to forward email");
      setEmailForwardState(emailId, { sending: false });
    }
  }, [getEmailForwardState, setEmailForwardState]);

  const generateAiReplyForEmail = useCallback(async (email) => {
    const emailId = email.id || email.messageId;
    setEmailReplyState(emailId, { drafting: true });
    try {
      const userName = localStorage.getItem("loggedInUser") || "User";
      const res = await fetch(`${API_BASE}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender:     email.from || email.sender,
          subject:    email.subject || "",
          email_body: email.body || email.summary,
          user_name:  userName,
          category:   email.category || "NORMAL",
        })
      });
      if (!res.ok) throw new Error("AI draft failed");
      const data = await res.json();
      setEmailReplyState(emailId, { replyBody: data.reply || "", drafting: false });
    } catch (err) {
      alert("Failed to generate AI reply");
      console.error(err);
      setEmailReplyState(emailId, { drafting: false });
    }
  }, [setEmailReplyState]);

  // ── REPLY ALL — fetch full recipients before opening compose ─────────────
  const handleReplyAll = useCallback(async (email) => {
    const emailId  = email.id || email.messageId;
    const myEmail  = getActiveUserEmail().toLowerCase();

    // Helper: build To + CC sets from a detail object (full or card-level)
    const buildRecipients = (detail) => {
      const senderEmail = extractEmail(detail.from || detail.sender || "");
      const toSet = new Set();
      if (senderEmail && senderEmail.toLowerCase() !== myEmail) toSet.add(senderEmail);

      const toList = Array.isArray(detail.to) ? detail.to : [];
      toList.forEach(t => {
        const addr = extractEmail(t);
        if (addr && addr.toLowerCase() !== myEmail) toSet.add(addr);
      });

      const participantList = Array.isArray(detail.participants) ? detail.participants : [];
      participantList.forEach(p => {
        const addr = extractEmail(p);
        if (addr && addr.toLowerCase() !== myEmail) toSet.add(addr);
      });

      const ccList = (Array.isArray(detail.cc) ? detail.cc : [])
        .map(extractEmail)
        .filter(addr => addr && addr.toLowerCase() !== myEmail);

      return { toStr: [...toSet].join(", "), ccStr: ccList.join(", ") };
    };

    // If the card already has populated To recipients, use them immediately
    const hasRecipients = Array.isArray(email.to) && email.to.length > 0;
    if (hasRecipients) {
      const { toStr, ccStr } = buildRecipients(email);
      setEmailReplyState(emailId, {
        showReply: true, replyBody: "", replyTo: toStr,
        replyCc: ccStr, attachments: [], isReplyAll: true
      });
      return;
    }

    // Otherwise fetch full detail first so we get the real recipient list
    setReplyAllLoading(prev => ({ ...prev, [emailId]: true }));
    try {
      const userEmail = getActiveUserEmail();
      const messageId = email.messageId || email.id;
      const res = await fetch(
        `${API_BASE}/email-details?messageId=${encodeURIComponent(messageId)}&userEmail=${encodeURIComponent(userEmail)}`
      );
      if (!res.ok) throw new Error(`Detail fetch failed: ${res.status}`);
      const detail = await res.json();
      const { toStr, ccStr } = buildRecipients(detail);
      setEmailReplyState(emailId, {
        showReply: true, replyBody: "", replyTo: toStr,
        replyCc: ccStr, attachments: [], isReplyAll: true
      });
    } catch (err) {
      console.error("Reply All detail fetch failed:", err);
      // Fallback: open with just the sender so the user isn't blocked
      const fallbackTo = extractEmail(email.from || email.sender || "");
      setEmailReplyState(emailId, {
        showReply: true, replyBody: "", replyTo: fallbackTo,
        replyCc: "", attachments: [], isReplyAll: true
      });
    } finally {
      setReplyAllLoading(prev => ({ ...prev, [emailId]: false }));
    }
  }, [setEmailReplyState]);

  // ── "VIEW MEMBERS" MODAL ─────────────────────────────────────────────────
  // Unified loader for all 8 backend-managed folders (VIP/LEGAL/PRIORITY/
  // PROVIDERS/GLOBAL/RCM_MGRS/IT/ACCOUNTING) — always fetches live from
  // /api/group-members so it reflects the latest add/remove, and is cached
  // in groupMembersData for the rest of the session (refreshed after any
  // add/remove below). NOTE: this only changes what this MODAL shows — the
  // inbox folder tabs' own filtering still reads GLOBAL_SENDERS_SET etc.
  // directly and is completely unaffected by this function.
  const openManageableMembersModal = async (folderName, { forceRefresh = false } = {}) => {
    const meta = MANAGEABLE_META[folderName];
    if (!meta) return;

    if (groupMembersData && !forceRefresh) {
      const emails = groupMembersData[folderName] || [];
      setMembersModal({ folderName, title: meta.label, emoji: meta.emoji, members: emails.map(email => ({ email, name: emailToDisplayName(email) })) });
      return;
    }

    setMembersModal({ folderName, title: meta.label, emoji: meta.emoji, members: [], loading: true });
    try {
      const res = await fetch(`${API_BASE}/group-members`);
      if (!res.ok) throw new Error(`group-members fetch failed: ${res.status}`);
      const data = await res.json();
      setGroupMembersData(data);
      const emails = data[folderName] || [];
      setMembersModal({ folderName, title: meta.label, emoji: meta.emoji, members: emails.map(email => ({ email, name: emailToDisplayName(email) })) });
    } catch (err) {
      console.error("Failed to load group members:", err);
      setMembersModal({ folderName, title: meta.label, emoji: meta.emoji, members: [], loading: false, error: true });
    }
  };

  // Team folders row: RINKU/SALLY (single-person, not backend-managed) keep
  // the old instant-from-JS path; the other 5 (GLOBAL/RCM_MGRS/IT/ACCOUNTING/
  // PROVIDERS) now delegate to the live loader above.
  const openFolderMembersModal = (folderName) => {
    if (MANAGEABLE_FOLDERS.includes(folderName)) {
      openManageableMembersModal(folderName);
      return;
    }
    const group = FOLDER_GROUPS[folderName];
    if (!group) return;
    const members = [...group.set]
      .sort()
      .map(email => ({ email, name: emailToDisplayName(email) }));
    setMembersModal({ title: group.label, emoji: group.emoji, members }); // no folderName → view-only, no add/remove UI
  };

  // Category tabs (VIP/LEGAL/PRIORITY) — same live loader as above.
  const openCategoryMembersModal = (catName) => openManageableMembersModal(catName);

  // ── ADD / REMOVE MEMBER — shared confirm-then-commit flow ───────────────
  // Used by both entry points: the members modal's "add" row / member "×"
  // buttons, and the inbox row's folder-picker. Always asks for Y/N before
  // calling the API, per the confirm-before-commit flow that was asked for.
  const requestAddMembers = (folderName, folderLabel, emails) => {
    const cleaned = emails.map(e => e.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    setMemberActionPending({ type: 'add', folderName, folderLabel, emails: cleaned });
  };

  const requestRemoveMember = (folderName, folderLabel, email) => {
    setMemberActionPending({ type: 'remove', folderName, folderLabel, emails: [email] });
  };

  const cancelMemberAction = () => setMemberActionPending(null);

  const confirmMemberAction = async () => {
    if (!memberActionPending) return;
    const { type, folderName, folderLabel, emails } = memberActionPending;
    setMemberActionSubmitting(true);
    try {
      const endpoint = type === 'add' ? 'add' : 'remove';
      let latestMembers = null;
      for (const email of emails) {
        const res = await fetch(`${API_BASE}/group-members/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderName, email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || `Failed to ${type} ${email}`);
        latestMembers = data.members;
      }
      if (latestMembers) {
        setGroupMembersData(latestMembers);
        const updatedEmails = latestMembers[folderName] || [];
        setMembersModal(prev => (prev && prev.folderName === folderName)
          ? { ...prev, members: updatedEmails.map(email => ({ email, name: emailToDisplayName(email) })) }
          : prev);
      }
      addToast(
        type === 'add'
          ? `${emails.length > 1 ? `${emails.length} people` : emailToDisplayName(emails[0])} added to ${folderLabel}`
          : `${emailToDisplayName(emails[0])} removed from ${folderLabel}`,
        'success'
      );
      if (type === 'add') { setNewMemberInput(""); membersModalEmailRef.current?.clear(); }
    } catch (err) {
      console.error(`${type} member failed:`, err);
      addToast(err.message || `Failed to ${type} member. Please try again.`, 'error');
    } finally {
      setMemberActionSubmitting(false);
      setMemberActionPending(null);
    }
  };



  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="feed-container" ref={feedRef} style={{ position: 'relative' }}>

      {/* SENDER FILTER BANNER */}
      {senderFilter && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", marginBottom: "10px", background: "linear-gradient(135deg, rgba(0,217,255,0.14), rgba(79,70,229,0.12))", border: "1px solid rgba(0,217,255,0.35)", borderRadius: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#3b82f6", boxShadow: "0 0 6px #3b82f6", flexShrink: 0 }} />
            <span style={{ fontSize: "0.82rem", fontWeight: "700", color: "#93c5fd" }}>Filtering emails from:</span>
            <span style={{ fontSize: "0.82rem", color: "var(--text-primary)", fontWeight: "600", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", borderRadius: "6px", padding: "2px 10px" }}>{senderFilter.name}</span>
          </div>
          <button onClick={() => setSenderFilter(null)} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#ef4444", borderRadius: "6px", padding: "4px 12px", fontSize: "0.75rem", fontWeight: "700", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
            <X size={13} /> Clear Filter
          </button>
        </div>
      )}

      {/* TABS + FOLDERS */}
      {(() => {
        const getSenderEmail = (e) => (e.from || e.sender || "").toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] || "";

        // Apply senderFilter on top of all emails for count purposes
        const base = senderFilter
          ? groupedEmails.filter(e => (e.from || e.sender || "").toLowerCase().includes(senderFilter.email.toLowerCase()))
          : groupedEmails;

        // Compute folder pool for counts (same logic as feed)
        const getFolderPool = (folder) => {
          switch (folder) {
            case 'ALL_EMAILS': return base;
            case 'THREADS':    return base.filter(e => (e.threadCount || e.thread_count || e.messages?.length || 0) > 1);
            case 'GLOBAL':     return base.filter(e => LIVE_GLOBAL_SET.has(getSenderEmail(e)));
            case 'RCM_MGRS':   return base.filter(e => LIVE_RCM_SET.has(getSenderEmail(e)));
            case 'RINKU':      return base.filter(e => RINKU_SENDERS_SET.has(getSenderEmail(e)));
            case 'IT':         return base.filter(e => LIVE_IT_SET.has(getSenderEmail(e)));
            case 'SALLY':      return base.filter(e => SALLY_SENDERS_SET.has(getSenderEmail(e)));
            case 'ACCOUNTING': return base.filter(e => LIVE_ACCOUNTING_SET.has(getSenderEmail(e)));
            case 'PROVIDERS':  return base.filter(e => LIVE_PROVIDERS_SET.has(getSenderEmail(e)));
            default:           return base;
          }
        };

        const msgCount = (e) =>
          e.threadCount ||
          e.thread_count ||
          (Array.isArray(e.messages) && e.messages.length > 0 ? e.messages.length : 0) ||
          1;

        // Counts for folder buttons. These folders count conversations/cards;
        // other folders keep the existing total-message count.
        const folderPool = getFolderPool(activeFolder);
        const folderMsgCount = (folder) => {
          const pool = getFolderPool(folder);
          if (folder === 'ALL_EMAILS') return totalEmailCount ?? pool.length;
          return ['THREADS', 'RINKU', 'SALLY'].includes(folder)
            ? pool.length
            : pool.reduce((s, e) => s + msgCount(e), 0);
        };

        // Category counts reflect within the CURRENT active folder pool
        const catCount = (cat) => {
          if (cat === 'ALL') return folderMsgCount(activeFolder);
          return folderPool.filter(e => e.category === cat).length;
        };

        const folders = [
          { name: 'ALL_EMAILS', label: 'ALL EMAILS', emoji: '📬' },
          { name: 'THREADS',    label: 'THREADS',    emoji: '🧵' },
          { name: 'GLOBAL',     label: 'GLOBAL',     emoji: '🌍' },
          { name: 'RCM_MGRS',   label: 'RCM_MGRS',   emoji: '💼' },
          { name: 'RINKU',      label: 'RINKU',      emoji: '👤' },
          { name: 'IT',         label: 'IT',         emoji: '💻' },
          { name: 'SALLY',      label: 'SALLY',      emoji: '👤' },
          { name: 'ACCOUNTING', label: 'ACCOUNTING', emoji: '🧾' },
          { name: 'PROVIDERS',  label: 'OM/PROVIDERS',  emoji: '🏥' },

        ];

        return (
          <>
            {/* STICKY WRAPPER — keeps folders + category tabs visible while scrolling */}
            <div className="sticky-folders-header" style={{ position: 'sticky', top: 0, zIndex: 50, paddingBottom: '8px', marginBottom: '4px' }}>
            {/* ROW 1: FOLDERS */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.6rem', fontWeight: '800', letterSpacing: '1.5px', color: 'var(--text-muted)', textTransform: 'uppercase', flexShrink: 0 }}>📁 FOLDERS</span>
              {folders.map(({ name, label, emoji }) => {
                const isActive = activeFolder === name;
                const hasMembers = !!FOLDER_GROUPS[name];
                return (
                  <button key={name}
                    className={`tab-btn ${isActive ? 'active' : ''}`}
                    onClick={() => { setSelectedEmail(null); setActiveFolder(name); setActiveCategory('ALL'); setSelectedCards(new Set()); }}>
                    {emoji} {label}
                    <span className={`count-badge ${isActive ? 'active' : ''}`}>{folderMsgCount(name)}</span>
                    {hasMembers && (
                      <Users
                        size={12}
                        style={{ opacity: 0.75, marginLeft: '-2px' }}
                        title={`View ${label} members`}
                        onClick={(e) => { e.stopPropagation(); openFolderMembersModal(name); }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* ROW 2: CATEGORY TABS — counts reflect within active folder */}
            <div className="tabs-container">
              {[
                { name: 'ALL',          emoji: '📬' },
                { name: 'NORMAL',       emoji: '📬' },
                { name: 'VIP',          emoji: '⭐' },
                { name: 'LEGAL',        emoji: '⚖️' },
                { name: 'PRIORITY',     emoji: '🔥' },
                { name: 'URGENT',       emoji: '⚠️' },
                { name: 'CONFIDENTIAL', emoji: '🔒' },
                { name: 'MEETING',      emoji: '📅' },
                { name: 'ZOOM',         emoji: '📹' },
                { name: 'NEWSLETTER',   emoji: '📰' },
              ].map(tab => {
                const hasMembers = !!CATEGORY_GROUPS[tab.name];
                return (
                  <button key={tab.name} className={`tab-btn ${activeCategory === tab.name ? 'active' : ''} ${tab.name.toLowerCase()}`}
                    onClick={() => { setSelectedEmail(null); setActiveCategory(tab.name); setSelectedCards(new Set()); }}>
                    {tab.emoji} {tab.name}
                    <span className={`count-badge badge-${tab.name.toLowerCase()}`}>{catCount(tab.name)}</span>
                    {hasMembers && (
                      <Users
                        size={12}
                        style={{ opacity: 0.75, marginLeft: '-2px' }}
                        title={`View ${tab.name} members`}
                        onClick={(e) => { e.stopPropagation(); openCategoryMembersModal(tab.name); }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            </div>{/* end sticky wrapper */}
          </>
        );
      })()}

      {/* SEARCH BAR */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 14px", marginBottom: "10px", background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "10px" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by subject, sender, or summary..."
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--text-primary)", fontSize: "0.88rem", fontWeight: "500" }} />
        {searchQuery && (
          <button onClick={() => setSearchQuery("")} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", borderRadius: "5px", padding: "2px 9px", fontSize: "0.72rem", fontWeight: "700", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* EMAIL FEED */}
      {(() => {
        const q = searchQuery.trim().toLowerCase();
        const getSenderEmail = (e) => (e.from || e.sender || "").toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0] || "";

        // Step 1: get folder pool
        let folderPool;
        switch (activeFolder) {
          case 'THREADS':    folderPool = groupedEmails.filter(e => (e.threadCount || e.thread_count || e.messages?.length || 0) > 1); break;
          case 'GLOBAL':     folderPool = groupedEmails.filter(e => LIVE_GLOBAL_SET.has(getSenderEmail(e))); break;
          case 'RCM_MGRS':   folderPool = groupedEmails.filter(e => LIVE_RCM_SET.has(getSenderEmail(e))); break;
          case 'RINKU':      folderPool = groupedEmails.filter(e => RINKU_SENDERS_SET.has(getSenderEmail(e))); break;
          case 'IT':         folderPool = groupedEmails.filter(e => LIVE_IT_SET.has(getSenderEmail(e))); break;
          case 'SALLY':      folderPool = groupedEmails.filter(e => SALLY_SENDERS_SET.has(getSenderEmail(e))); break;
          case 'ACCOUNTING': folderPool = groupedEmails.filter(e => LIVE_ACCOUNTING_SET.has(getSenderEmail(e))); break;
          case 'PROVIDERS':  folderPool = groupedEmails.filter(e => LIVE_PROVIDERS_SET.has(getSenderEmail(e))); break;
          default:           folderPool = groupedEmails; // ALL_EMAILS
        }

        // Step 2: apply senderFilter (from Insights "View Sender")
        if (senderFilter) {
          folderPool = folderPool.filter(e => (e.from || e.sender || "").toLowerCase().includes(senderFilter.email.toLowerCase()));
        }

        // Step 3: apply category filter
        let categoryPool = activeCategory === 'ALL'
          ? folderPool
          : folderPool.filter(e => e.category === activeCategory);

        // Step 4: apply search
        const displayEmails = q
          ? categoryPool.filter(e =>
              (e.subject || "").toLowerCase().includes(q) ||
              (e.from || e.sender || "").toLowerCase().includes(q) ||
              (e.summary || "").toLowerCase().includes(q)
            )
          : categoryPool;

        const folderLabel = {
          ALL_EMAILS: 'inbox', THREADS: 'threads', GLOBAL: 'Global team',
          RCM_MGRS: 'RCM Managers', RINKU: 'Rinku', IT: 'IT',
          SALLY: 'Sally', ACCOUNTING: 'Accounting', PROVIDERS: 'OM/Providers'
        }[activeFolder] || 'inbox';

        const emptyMsg = q
          ? `No emails match "${searchQuery}"`
          : activeCategory !== 'ALL'
            ? `No ${activeCategory} emails in ${folderLabel}`
            : `No emails in ${folderLabel}`;

        return (
          <div className="email-feed">
            {!inboxReady ? (
              <div className="loading-text">Syncing inbox...</div>
            ) : displayEmails.length === 0 ? (
              <div className="loading-text">{emptyMsg}</div>
            ) : (
              <>
                {/* BULK ACTION BAR */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 16px', marginBottom: '8px', background: 'var(--bg-card)', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
                  <div style={{ width: '4px', flexShrink: 0 }} />
                  <RoundCheckboxIndeterminate
                    checked={selectedCards.size === displayEmails.length && displayEmails.length > 0}
                    indeterminate={selectedCards.size > 0 && selectedCards.size < displayEmails.length}
                    onChange={() => selectedCards.size === displayEmails.length ? clearSelection() : selectAll(displayEmails)}
                  />
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: '600' }}>
                    {selectedCards.size > 0 ? `${selectedCards.size} selected` : 'Select all'}
                  </span>
                  {selectedCards.size > 0 && (
                    <>
                      <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />
                      <button onClick={async () => { const toMark = displayEmails.filter(e => selectedCards.has(e.id || e.messageId) && !e.isRead); await Promise.all(toMark.map(e => markAsRead(e))); clearSelection(); }}
                        style={{ background: 'linear-gradient(135deg, #00d9ff, #8b5cf6)', color: 'white', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '0.82rem', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(0,217,255,0.35)' }}>
                        ✉ Mark {selectedCards.size} as Read
                      </button>
                      <button onClick={clearSelection} style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '7px', padding: '6px 12px', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer', color: 'var(--text-secondary)' }}>Clear</button>
                    </>
                  )}
                </div>

                {/* BACKGROUND ANALYSIS BANNER */}
                {isAnalyzingBackground && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", margin: "0 0 8px 0", background: "rgba(0,217,255,0.05)", border: "1px solid rgba(0,217,255,0.15)", borderRadius: "8px", fontSize: "0.78rem", color: "#00d9ff" }}>
                    <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#00d9ff", boxShadow: "0 0 6px #00d9ff", animation: "pulse 1.4s ease-in-out infinite", flexShrink: 0 }} />
                    AI is analysing new emails in the background — summaries will update shortly.
                  </div>
                )}

                {/* EMAIL CARDS */}
                {displayEmails.map((email) => {
                  const atts         = email.attachments || [];
                  const emailId      = email.id || email.messageId;
                  const replyState   = getEmailReplyState(emailId);
                  const forwardState = getEmailForwardState(emailId);
                  const isChecked    = selectedCards.has(emailId);

                  return (
                    <div key={emailId}
                      className={`email-card ${!email.isRead ? "unread-mail" : ""} ${(selectedEmail?.id === email.id || selectedEmail?.messageId === email.messageId) ? "active" : ""} border-${(email.category || 'normal').toLowerCase()}`}
                      style={{ display: 'flex', alignItems: 'stretch', padding: 0, overflow: 'hidden', contain: 'content' }}
                      onClick={() => setSelectedEmail(email)}>

                      <div className="ec-left-border" style={{ flexShrink: 0 }}></div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', flexShrink: 0, alignSelf: 'center' }}
                        onClick={e => { e.stopPropagation(); toggleCardSelection(emailId); }}>
                        <RoundCheckbox checked={isChecked} onClick={e => { e.stopPropagation(); toggleCardSelection(emailId); }} />
                      </div>

                      <div className="ec-content" style={{ flex: 1, minWidth: 0, padding: '14px 16px 14px 0' }}>

                        {/* TOP ROW */}
                        <div className="ec-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                          <h4 style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flex: 1, minWidth: 0, margin: 0 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{email.subject || "No Subject"}</span>
                            {(() => { const tc = email.threadCount || email.thread_count || email.messages?.length || 0; return tc > 1 ? (<span style={{ background: "linear-gradient(135deg, #00d9ff, #8b5cf6)", color: "white", fontSize: "0.65rem", fontWeight: "700", padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap", flexShrink: 0, letterSpacing: "0.3px" }}>🧵 {tc} messages</span>) : null; })()}
                          </h4>
                          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                            <button onClick={(e) => { e.stopPropagation(); markAsRead(email); }} disabled={email.isRead}
                              style={{ background: email.isRead ? "#22c55e" : "#0ea5e9", color: "white", border: "none", borderRadius: "5px", padding: "3px 8px", fontSize: "0.7rem", cursor: email.isRead ? "not-allowed" : "pointer", fontWeight: "600", whiteSpace: "nowrap", opacity: email.isRead ? 0.6 : 1, flexShrink: 0 }}>
                              {email.isRead ? "✓ Read" : "Mark Read"}
                            </button>
                            <div className="ec-badges" style={{ flexShrink: 0 }}>
                              {email.hasReplied && (<span style={{ background: "#16a34a", color: "white", padding: "2px 8px", borderRadius: "999px", fontSize: "0.65rem", fontWeight: "700", marginLeft: "6px", whiteSpace: "nowrap" }}>↩️ Replied</span>)}
                              {(() => { const cat = (email.category || "PENDING").toUpperCase(); const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL; return <span className={`cat-tag ${cat.toLowerCase()}`} style={{ whiteSpace: "nowrap" }}>{meta.emoji} {meta.label}</span>; })()}
                            </div>
                            {/* Flag button */}
                            <button
                              onClick={e => { e.stopPropagation(); setFlagOpen(flagOpen === emailId ? null : emailId); }}
                              title="Wrong classification? Flag it"
                              style={{ background: flagOpen === emailId ? 'rgba(239,68,68,0.12)' : 'transparent', border: `1px solid ${flagOpen === emailId ? 'rgba(239,68,68,0.3)' : 'transparent'}`, color: flagOpen === emailId ? '#f87171' : 'var(--text-muted)', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: '0.72rem', fontWeight: '600', transition: 'all 0.15s' }}
                              onMouseEnter={e => { if (flagOpen !== emailId) { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.2)'; e.currentTarget.style.color = '#f87171'; }}}
                              onMouseLeave={e => { if (flagOpen !== emailId) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}}
                            >
                              <Flag size={12} /> Flag
                            </button>
                            {/* Add-to-folder button */}
                            <button
                              onClick={e => { e.stopPropagation(); setFolderPickerFor(folderPickerFor === emailId ? null : emailId); }}
                              title="Add sender to a folder"
                              style={{ background: folderPickerFor === emailId ? 'rgba(59,130,246,0.12)' : 'transparent', border: `1px solid ${folderPickerFor === emailId ? 'rgba(59,130,246,0.3)' : 'transparent'}`, color: folderPickerFor === emailId ? '#60a5fa' : 'var(--text-muted)', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: '0.72rem', fontWeight: '600', transition: 'all 0.15s' }}
                              onMouseEnter={e => { if (folderPickerFor !== emailId) { e.currentTarget.style.background = 'rgba(59,130,246,0.08)'; e.currentTarget.style.borderColor = 'rgba(59,130,246,0.2)'; e.currentTarget.style.color = '#60a5fa'; }}}
                              onMouseLeave={e => { if (folderPickerFor !== emailId) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}}
                            >
                              <FolderPlus size={12} /> Add to Folder
                            </button>
                          </div>
                        </div>

                        {/* META */}
                        <div className="ec-meta">
                          <span title={getEmailSender(email)} style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><User size={14} /> {getEmailSender(email)}</span>
                          <span><Clock size={14} /> {formatDate(getEffectiveReceivedAt(email))}</span>
                          {Array.isArray(email.cc) && email.cc.length > 0 && (<span className="cc-badge" title={email.cc.join(", ")}><Users size={12} /> CC</span>)}
                        </div>

                        {/* SUMMARY */}
                        {email.analyzing
                          ? <div className="ec-body ec-analyzing-text"><span className="analyzing-dot" />AI is writing the summary, please wait...</div>
                          : <div className="ec-body">{email.summary || ""}</div>}

                        {/* FLAG DROPDOWN */}
                        {flagOpen === emailId && (
                          <FlagDropdown
                            email={email}
                            onSubmit={submitCorrection}
                            onClose={() => setFlagOpen(null)}
                            submitting={!!flagSubmitting[emailId]}
                            success={!!flagSuccess[emailId]}
                          />
                        )}

                        {/* ADD-TO-FOLDER DROPDOWN */}
                        {folderPickerFor === emailId && (() => {
                          const senderEmail = extractEmail(getEmailSender(email));
                          return (
                            <FolderPickerDropdown
                              senderEmail={senderEmail}
                              onClose={() => setFolderPickerFor(null)}
                              onPick={(folderName) => {
                                setFolderPickerFor(null);
                                requestAddMembers(folderName, MANAGEABLE_META[folderName]?.label || folderName, [senderEmail]);
                              }}
                            />
                          );
                        })()}


                        {/* ATTACHMENTS */}
                        {atts.length > 0 && (
                          <div className="ec-atts">
                            <Paperclip size={14} />
                            {atts.map((a, k) => (
                              <div key={k} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                <span style={{ flex: 1 }}>{a.name || a.file_name || "File"}<span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>{formatFileSize(a.size)}</span></span>
                                <button onClick={(e) => { e.stopPropagation(); handleFileDownload({ ...a, attachmentId: a.attachmentId }, email.messageId || email.id); }}
                                  disabled={isFileDownloading(a, email.messageId || email.id)}
                                  style={{ backgroundColor: isFileDownloading(a, email.messageId || email.id) ? "#9ca3af" : "#0ea5e9", cursor: isFileDownloading(a, email.messageId || email.id) ? "not-allowed" : "pointer", color: "white", padding: "6px 12px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", gap: "6px" }}>
                                  {isFileDownloading(a, email.messageId || email.id) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(a, email.messageId || email.id)}%</> : <><Download size={16} /> Download</>}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* RSVP — MEETING & ZOOM INVITES */}
                        {(email.category === "MEETING" || email.category === "ZOOM") && (() => {
                          const _subj = (email.subject || "").trim();
                          if (/^(accepted|declined|tentative|re|fw|fwd|aw|tr)\s*:/i.test(_subj)) return null;
                          const _body = (email.body || "").toLowerCase();
                          const _hasSignal = _body.includes("you're invited") || _body.includes("you are invited") || _body.includes("meeting request") || _body.includes("has invited you") || _body.includes("join the meeting") || _body.includes("join meeting") || _body.includes("zoom.us") || _body.includes("teams.microsoft.com") || _body.includes("meet.google.com") || _body.includes("webex.com") || (email.attachments || []).some(a => (a.name || "").toLowerCase().endsWith(".ics"));
                          if (!_hasSignal) return null;
                          const rsvp = getRsvpState(emailId);
                          const statusColors = {
                            accepted:  { bg: "rgba(22,163,74,0.12)",  border: "rgba(22,163,74,0.35)",  color: "#4ade80", label: "✓ Accepted" },
                            declined:  { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.35)",  color: "#f87171", label: "✗ Declined" },
                            tentative: { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)", color: "#fbbf24", label: "? Maybe"    },
                          };
                          const done = statusColors[rsvp.status];
                          return (
                            <div onClick={e => e.stopPropagation()} style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "10px 12px", background: done ? done.bg : "rgba(255,255,255,0.03)", border: `1px solid ${done ? done.border : "var(--border-color)"}`, borderRadius: "8px" }}>
                              {rsvp.error && !done && (<div style={{ width: "100%", marginBottom: "6px", fontSize: "0.75rem", color: "#f87171", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "6px", padding: "5px 10px" }}>⚠️ RSVP failed — this invite may need to be accepted from the Calendar view. <span style={{ opacity: 0.6 }}>({rsvp.error})</span></div>)}
                              {rsvp.useCalendar && !done && (
                                <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                  <span style={{ fontSize: "0.78rem", color: "#93c5fd" }}>📅 This invite can only be accepted from the Calendar</span>
                                  <button onClick={e => { e.stopPropagation(); navigate('/calendar'); }} style={{ background: "linear-gradient(135deg, #00d9ff, #8b5cf6)", color: "white", border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", boxShadow: "0 3px 10px rgba(0,217,255,0.35)" }}>📅 Open Calendar →</button>
                                </div>
                              )}
                              {done ? (
                                <>
                                  <span style={{ fontSize: "0.82rem", fontWeight: "700", color: done.color }}>{done.label}</span>
                                  <button onClick={() => setInlineRsvpState(prev => ({ ...prev, [emailId]: { status: null, loading: false } }))} style={{ background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-secondary)", borderRadius: "5px", padding: "2px 9px", fontSize: "0.72rem", fontWeight: "600", cursor: "pointer" }}>Change</button>
                                </>
                              ) : (
                                <>
                                  <span style={{ fontSize: "0.72rem", fontWeight: "700", letterSpacing: "0.8px", color: "var(--text-secondary)", textTransform: "uppercase", marginRight: "4px" }}>{email.category === "ZOOM" ? "📹 Zoom Invite" : "📅 Meeting Invite"}</span>
                                  <button onClick={e => { e.stopPropagation(); handleRsvp(email, "Accept"); }} disabled={rsvp.loading} style={{ background: "linear-gradient(135deg, #16a34a, #15803d)", color: "white", border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", boxShadow: "0 3px 10px rgba(22,163,74,0.3)", opacity: rsvp.loading ? 0.6 : 1 }}>
                                    {rsvp.loading ? <Loader size={13} className="animate-spin" /> : "✓"} Accept
                                  </button>
                                  <button onClick={e => { e.stopPropagation(); handleRsvp(email, "Tentative"); }} disabled={rsvp.loading} style={{ background: "rgba(245,158,11,0.12)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.35)", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", opacity: rsvp.loading ? 0.6 : 1 }}>? Maybe</button>
                                  <button onClick={e => { e.stopPropagation(); handleRsvp(email, "Decline"); }} disabled={rsvp.loading} style={{ background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", opacity: rsvp.loading ? 0.6 : 1 }}>✗ Decline</button>
                                </>
                              )}
                            </div>
                          );
                        })()}

                        {/* INLINE REPLY */}
                        {replyState.showReply && !forwardState.showForward && (
                          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: "16px", padding: "16px", borderTop: "1px solid var(--border-color)", background: "var(--bg-card)", borderRadius: "8px" }}>
                            {replyState.isReplyAll && (<div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: "6px", padding: "4px 10px", fontSize: "0.75rem", fontWeight: "700", color: "#3b82f6", marginBottom: "12px" }}>↩️↩️ Reply All — replying to all recipients</div>)}
                            <div style={{ marginBottom: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
                              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="To" value={replyState.replyTo} onChange={(newValue) => setEmailReplyState(emailId, { replyTo: newValue })} placeholder="Search contacts or enter email..." /></div>
                              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="CC" value={replyState.replyCc} onChange={(newValue) => setEmailReplyState(emailId, { replyCc: newValue })} placeholder="Optional - Search contacts or enter email..." /></div>
                            </div>
                            <textarea placeholder="Type your reply..." value={replyState.replyBody} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onChange={(e) => setEmailReplyState(emailId, { replyBody: e.target.value })} style={{ width: "100%", minHeight: "90px", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--bg-main)", color: "var(--text-primary)", resize: "vertical" }} />
                            <div style={{ marginTop: "10px", marginBottom: "10px" }}>
                              <input type="file" multiple id={`reply-attach-${emailId}`} style={{ display: "none" }} onChange={(e) => handleReplyAttachmentSelect(emailId, e.target.files)} />
                              <label htmlFor={`reply-attach-${emailId}`} onClick={(e) => e.stopPropagation()} style={{ background: "#f3f4f6", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600", color: "#374151", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                <Paperclip size={14} /> Attach Files
                              </label>
                            </div>
                            {replyState.attachments.length > 0 && (
                              <div style={{ marginBottom: "10px", padding: "8px", background: "var(--bg-main)", borderRadius: "6px" }}>
                                {replyState.attachments.map((f, idx) => (
                                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "4px 0", borderBottom: idx < replyState.attachments.length - 1 ? "1px solid var(--border-color)" : "none" }}>
                                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><Paperclip size={12} color="#6b7280" /> {f.name}</span>
                                    <button onClick={(e) => { e.stopPropagation(); removeReplyAttachment(emailId, idx); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px 6px" }} title="Remove attachment"><X size={14} /></button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div style={{ marginBottom: "12px" }}>
                              <button onClick={(e) => { e.stopPropagation(); generateAiReplyForEmail(email); }} disabled={replyState.drafting} style={{ background: replyState.drafting ? "#9ca3af" : "#0ea5e9", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "0.85rem", cursor: replyState.drafting ? "not-allowed" : "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px" }}>
                                {replyState.drafting ? <><Loader size={14} className="animate-spin" /> Drafting...</> : <>✨ Auto-Draft</>}
                              </button>
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "16px" }}>
                              <button onClick={(e) => { e.stopPropagation(); setEmailReplyState(emailId, { showReply: false, replyBody: "", replyTo: "", replyCc: "", drafting: false, attachments: [] }); }} style={{ background: "transparent", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer" }}>Cancel</button>
                              <button onClick={(e) => { e.stopPropagation(); sendInlineReply(email); }} disabled={replyState.drafting || !replyState.replyBody.trim()} style={{ background: "#16a34a", color: "white", border: "none", padding: "6px 14px", borderRadius: "6px", fontWeight: "600", cursor: replyState.drafting || !replyState.replyBody.trim() ? "not-allowed" : "pointer" }}>
                                {replyState.drafting ? "Sending..." : "Send"}
                              </button>
                            </div>
                            <div style={{ marginTop: "4px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                              <hr /><HtmlEmailRenderer body={getEmailBody(email)} />
                            </div>
                          </div>
                        )}

                        {/* REPLY / REPLY ALL / FORWARD BUTTONS */}
                        {!replyState.showReply && !forwardState.showForward && (
                          <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                            <button onClick={(e) => { e.stopPropagation(); const toEmail = extractEmail(email.from || email.sender || ""); const ccEmails = Array.isArray(email.cc) ? email.cc.map(extractEmail).filter(Boolean).join(", ") : ""; setEmailReplyState(emailId, { showReply: true, replyBody: "", replyTo: toEmail, replyCc: ccEmails, attachments: [], isReplyAll: false }); }} style={{ background: "#0ea5e9", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", cursor: "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "5px" }}>↩️ Reply</button>
                            <button onClick={(e) => { e.stopPropagation(); handleReplyAll(email); }}
                              disabled={replyAllLoading[emailId]}
                              style={{ background: "transparent", color: replyAllLoading[emailId] ? "var(--text-secondary)" : "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", cursor: replyAllLoading[emailId] ? "not-allowed" : "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "5px", transition: "border-color 0.15s, background 0.15s", opacity: replyAllLoading[emailId] ? 0.6 : 1 }}
                              onMouseEnter={e => { if (!replyAllLoading[emailId]) { e.currentTarget.style.borderColor = "#0ea5e9"; e.currentTarget.style.color = "#0ea5e9"; } }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-primary)"; }}>
                              {replyAllLoading[emailId] ? <><Loader size={13} className="animate-spin" /> Loading...</> : <>↩️↩️ Reply All</>}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setEmailForwardState(emailId, { showForward: true, forwardBody: "", forwardTo: "", forwardCc: "", attachments: [] }); }}
                              style={{ background: "transparent", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", cursor: "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "5px", transition: "border-color 0.15s, color 0.15s" }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = "#f59e0b"; e.currentTarget.style.color = "#f59e0b"; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-primary)"; }}>➡️ Forward</button>
                          </div>
                        )}

                        {/* INLINE FORWARD */}
                        {forwardState.showForward && (
                          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: "16px", padding: "16px", borderTop: "1px solid var(--border-color)", background: "var(--bg-card)", borderRadius: "8px" }}>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: "6px", padding: "4px 10px", fontSize: "0.75rem", fontWeight: "700", color: "#f59e0b", marginBottom: "12px" }}>➡️ Forwarding — original email + attachments included automatically</div>
                            <div style={{ marginBottom: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
                              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="To" value={forwardState.forwardTo} onChange={(val) => setEmailForwardState(emailId, { forwardTo: val })} placeholder="Search contacts or enter email..." /></div>
                              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="CC" value={forwardState.forwardCc} onChange={(val) => setEmailForwardState(emailId, { forwardCc: val })} placeholder="Optional CC..." /></div>
                            </div>
                            <textarea placeholder="Add a note before the forwarded message... (optional)" value={forwardState.forwardBody} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onChange={(e) => setEmailForwardState(emailId, { forwardBody: e.target.value })} style={{ width: "100%", minHeight: "80px", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--bg-main)", color: "var(--text-primary)", resize: "vertical", boxSizing: "border-box" }} />
                            <div style={{ marginTop: "10px", marginBottom: "10px" }}>
                              <input type="file" multiple id={`fwd-attach-${emailId}`} style={{ display: "none" }} onChange={(e) => { if (!e.target.files) return; setEmailForwardState(emailId, { attachments: [...forwardState.attachments, ...Array.from(e.target.files)] }); }} />
                              <label htmlFor={`fwd-attach-${emailId}`} onClick={(e) => e.stopPropagation()} style={{ background: "#f3f4f6", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600", color: "#374151", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                <Paperclip size={14} /> Add Extra Attachment
                              </label>
                            </div>
                            {forwardState.attachments.length > 0 && (
                              <div style={{ marginBottom: "10px", padding: "8px", background: "var(--bg-main)", borderRadius: "6px" }}>
                                {forwardState.attachments.map((f, idx) => (
                                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "4px 0", borderBottom: idx < forwardState.attachments.length - 1 ? "1px solid var(--border-color)" : "none" }}>
                                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><Paperclip size={12} color="#6b7280" /> {f.name}</span>
                                    <button onClick={(e) => { e.stopPropagation(); setEmailForwardState(emailId, { attachments: forwardState.attachments.filter((_, i) => i !== idx) }); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px 6px" }}><X size={14} /></button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div style={{ marginTop: "12px", padding: "10px", background: "var(--bg-main)", borderRadius: "6px", fontSize: "0.8rem", color: "var(--text-secondary)", borderLeft: "3px solid var(--border-color)" }}>
                              <div style={{ fontWeight: "700", marginBottom: "4px" }}>📧 Original message will be forwarded:</div>
                              <div><strong>From:</strong> {email.from || "Unknown"}</div>
                              <div><strong>Subject:</strong> {email.subject || "No Subject"}</div>
                              {(email.attachments || []).length > 0 && (<div style={{ marginTop: "4px" }}><strong>Attachments:</strong> {email.attachments.map(a => a.name).join(", ")}</div>)}
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
                              <button onClick={(e) => { e.stopPropagation(); setEmailForwardState(emailId, { showForward: false, forwardBody: "", forwardTo: "", forwardCc: "", sending: false, attachments: [] }); }} style={{ background: "transparent", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", color: "var(--text-secondary)", fontWeight: "600" }}>Cancel</button>
                              <button onClick={(e) => { e.stopPropagation(); sendInlineForward(email); }} disabled={forwardState.sending || !forwardState.forwardTo.trim()} style={{ background: forwardState.sending || !forwardState.forwardTo.trim() ? "#9ca3af" : "#f59e0b", color: "white", border: "none", padding: "6px 16px", borderRadius: "6px", fontWeight: "700", cursor: forwardState.sending || !forwardState.forwardTo.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
                                {forwardState.sending ? <><Loader size={14} className="animate-spin" /> Forwarding...</> : <>➡️ Forward</>}
                              </button>
                            </div>
                          </div>
                        )}

                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })()}
      {/* BACK TO TOP BUTTON */}
      {showScrollTop && (
        <button
          onClick={() => getScrollParent()?.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{
            position: 'fixed',
            bottom: '32px',
            right: '32px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'linear-gradient(135deg, #00d9ff, #8b5cf6)',
            color: 'white',
            border: 'none',
            borderRadius: '999px',
            padding: '10px 18px',
            fontSize: '0.78rem',
            fontWeight: '700',
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(0,217,255,0.5)',
            zIndex: 1000,
            transition: 'opacity 0.2s ease',
            whiteSpace: 'nowrap',
          }}
          title="Back to top"
        >
          ↑ Top
        </button>
      )}

      {/* "VIEW MEMBERS" MODAL — team folders + VIP/LEGAL/PRIORITY category tabs */}
      {membersModal && (
        <div className="modal-overlay" onClick={() => setMembersModal(null)}>
          <div
            className="modal-content members-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '480px', maxWidth: '90%', height: 'auto', maxHeight: '70vh' }}
          >
            <div className="modal-header">
              <h3><Users size={18} /> {membersModal.emoji} {membersModal.title} ({membersModal.members.length})</h3>
              <button className="btn-close" onClick={() => setMembersModal(null)}><X size={20} /></button>
            </div>

            {/* ADD MEMBER — only for the 8 backend-managed folders */}
            {membersModal.folderName && (
              <div style={{ padding: '14px 16px 4px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <EmailAutocomplete
                      ref={membersModalEmailRef}
                      value={newMemberInput}
                      onChange={setNewMemberInput}
                      placeholder="Search contacts or enter email..."
                    />
                  </div>
                  <button
                    onClick={() => {
                      const emails = membersModalEmailRef.current?.getAllEmails()
                        ?? newMemberInput.split(',').map(e => e.trim()).filter(Boolean);
                      requestAddMembers(membersModal.folderName, membersModal.title, emails);
                    }}
                    style={{
                      background: 'linear-gradient(135deg,#3b82f6,#2563eb)',
                      color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px',
                      fontSize: '0.8rem', fontWeight: '700', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, height: '38px',
                    }}
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              </div>
            )}

            <div className="file-list-container" style={{ overflowY: 'auto', padding: '16px' }}>
              {membersModal.loading ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  <Loader size={20} className="animate-spin" /> Loading members...
                </div>
              ) : membersModal.error ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#ef4444' }}>
                  Couldn't load members. Please try again.
                </div>
              ) : membersModal.members.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  No members found.
                </div>
              ) : (
                membersModal.members.map((m, i) => (
                  <div key={i} className="file-row">
                    <div className="file-icon"><User size={18} color="#00d9ff" /></div>
                    <div className="file-info">
                      <div className="file-name">{m.name}</div>
                      <div className="file-sender">{m.email}</div>
                    </div>
                    {membersModal.folderName && (
                      <button
                        onClick={() => requestRemoveMember(membersModal.folderName, membersModal.title, m.email)}
                        title={`Remove from ${membersModal.title}`}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 6px', borderRadius: '6px', flexShrink: 0, display: 'flex', alignItems: 'center' }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                      >
                        <UserMinus size={15} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ADD/REMOVE CONFIRMATION — Y/N before any group-members API call commits */}
      {memberActionPending && (
        <div className="modal-overlay" style={{ zIndex: 4000 }} onClick={() => !memberActionSubmitting && cancelMemberAction()}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '380px', maxWidth: '90%', padding: '20px' }}
          >
            <div style={{ fontSize: '0.95rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>
              {memberActionPending.type === 'add' ? 'Add to folder?' : 'Remove from folder?'}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
              {memberActionPending.type === 'add' ? (
                <>
                  {memberActionPending.emails.length === 1 ? (
                    <>Add <strong style={{ color: 'var(--text-primary)' }}>{memberActionPending.emails[0]}</strong></>
                  ) : (
                    <>Add <strong style={{ color: 'var(--text-primary)' }}>{memberActionPending.emails.length} people</strong></>
                  )} to <strong style={{ color: 'var(--text-primary)' }}>{memberActionPending.folderLabel}</strong>?
                </>
              ) : (
                <>Remove <strong style={{ color: 'var(--text-primary)' }}>{memberActionPending.emails[0]}</strong> from <strong style={{ color: 'var(--text-primary)' }}>{memberActionPending.folderLabel}</strong>?</>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={cancelMemberAction}
                disabled={memberActionSubmitting}
                style={{ padding: '7px 16px', borderRadius: '7px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: '600', cursor: memberActionSubmitting ? 'not-allowed' : 'pointer' }}
              >
                No
              </button>
              <button
                onClick={confirmMemberAction}
                disabled={memberActionSubmitting}
                style={{
                  padding: '7px 18px', borderRadius: '7px', border: 'none', fontSize: '0.82rem', fontWeight: '700',
                  cursor: memberActionSubmitting ? 'not-allowed' : 'pointer',
                  background: memberActionPending.type === 'add' ? 'linear-gradient(135deg,#3b82f6,#2563eb)' : 'linear-gradient(135deg,#ef4444,#dc2626)',
                  color: 'white', opacity: memberActionSubmitting ? 0.7 : 1,
                  display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                {memberActionSubmitting ? <><Loader size={12} className="animate-spin" /> Working...</> : 'Yes'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

export default InboxView;