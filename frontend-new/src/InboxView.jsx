import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import AnimatedModal from './AnimatedModal';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  User, Paperclip, X, Clock, Download, Users, Loader, Flag, FolderPlus, UserMinus, Plus, Sparkles
} from 'lucide-react';
import EmailAutocomplete from './EmailAutocomplete';
import ComposeMailModal from './ComposeMailModal';
import ToastContainer from './Toast';
import { isMeetingInvite } from './meetingInvite';
import { askIrisAbout } from './Iris';

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
  const resizeObserverRef = React.useRef(null);
  const [iframeHeight, setIframeHeight] = useState(200);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

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

      // Newsletter-style emails keep growing after load as images/fonts finish —
      // a one-shot timeout can lock the height in too short and clip content.
      // Keep watching for as long as this document is displayed.
      resizeObserverRef.current?.disconnect();
      const RO = iframeRef.current?.contentWindow?.ResizeObserver;
      if (RO) {
        resizeObserverRef.current = new RO(resize);
        resizeObserverRef.current.observe(doc.documentElement);
      } else {
        setTimeout(resize, 600); // fallback if ResizeObserver is ever unavailable
      }
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
// A stable reference (not a fresh {} literal per call) so EmailCard's
// React.memo comparison doesn't see a "changed" prop for every row that
// hasn't touched RSVP yet — see getRsvpState below.
const DEFAULT_RSVP_STATE = { status: null, loading: false };

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
// ── TRACKING SECTION COMPONENT ───────────────────────────────────────────────
function TrackingSection({ title, color, items, emptyMsg, onDismiss, onFollowUp, readOnly }) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <div style={{ marginBottom: '24px' }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: '0.78rem', fontWeight: '800', color, letterSpacing: '0.5px' }}>{title}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '999px', padding: '1px 8px' }}>{items.length}</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>{collapsed ? '▶' : '▼'}</span>
      </div>

      {!collapsed && (
        items.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '12px 16px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            {emptyMsg}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {items.map(item => (
              <TrackingCard
                key={item.messageId}
                item={item}
                onDismiss={onDismiss}
                onFollowUp={onFollowUp}
                readOnly={readOnly}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function TrackingCard({ item, onDismiss, onFollowUp, readOnly }) {
  const bdays = item.businessDays || 0;
  const daysColor = bdays >= 5 ? '#ef4444' : bdays >= 3 ? '#f59e0b' : '#10b981';

  const pendingRecipients = Object.entries(item.recipients || {}).filter(
    ([, info]) => !info.replied && !info.dismissed
  );

  const repliedRecipients = Object.entries(item.recipients || {}).filter(
    ([, info]) => info.replied
  );

  if (pendingRecipients.length === 0 && !readOnly) return null;

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '14px 16px', borderLeft: `3px solid ${daysColor}` }}>
      {/* Subject + days */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '10px', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '0.88rem', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '3px' }}>{item.subject || '(no subject)'}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            Sent {new Date(item.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
        <span style={{ background: `${daysColor}22`, color: daysColor, border: `1px solid ${daysColor}44`, borderRadius: '999px', padding: '3px 10px', fontSize: '0.72rem', fontWeight: '800', flexShrink: 0 }}>
          {bdays} day{bdays !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Pending recipients */}
      {pendingRecipients.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {pendingRecipients.map(([addr, info]) => (
            <div key={addr} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', background: 'var(--bg-main)', borderRadius: '7px', border: '1px solid var(--border-color)' }}>
              {/* Type badge */}
              <span style={{
                fontSize: '0.6rem', fontWeight: '800', letterSpacing: '0.5px',
                background: info.type === 'internal' ? 'rgba(59,130,246,0.15)' : 'rgba(245,158,11,0.15)',
                color: info.type === 'internal' ? '#60a5fa' : '#f59e0b',
                border: `1px solid ${info.type === 'internal' ? 'rgba(59,130,246,0.3)' : 'rgba(245,158,11,0.3)'}`,
                borderRadius: '4px', padding: '1px 5px',
              }}>
                {info.type === 'internal' ? 'INT' : 'EXT'}
              </span>

              {/* Address */}
              <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {info.originalAddress || addr}
              </span>

              {/* Reminder status */}
              {info.reminder2_sent && <span style={{ fontSize: '0.65rem', color: '#f59e0b', flexShrink: 0 }}>2nd reminder sent</span>}
              {info.reminder1_sent && !info.reminder2_sent && <span style={{ fontSize: '0.65rem', color: '#3b82f6', flexShrink: 0 }}>1st reminder sent</span>}

              {!readOnly && (
                <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                  <button
                    onClick={() => onFollowUp(item, addr, info)}
                    style={{ background: 'rgba(0,217,255,0.14)', border: '1px solid rgba(0,217,255,0.35)', color: '#60a5fa', borderRadius: '5px', padding: '3px 9px', fontSize: '0.7rem', fontWeight: '700', cursor: 'pointer' }}
                  >
                    Follow Up
                  </button>
                  <button
                    onClick={() => onDismiss(item.messageId, addr)}
                    style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '5px', padding: '3px 9px', fontSize: '0.7rem', cursor: 'pointer' }}
                    title="Dismiss — handled offline"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Replied recipients (collapsed summary) */}
      {repliedRecipients.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '0.7rem', color: '#10b981' }}>
          ✓ Replied: {repliedRecipients.map(([addr]) => addr.split('@')[0]).join(', ')}
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

// ── EmailCard ────────────────────────────────────────────────────────────────
// Split out from InboxView's list .map() and wrapped in React.memo so that
// editing a reply/forward box, checking a box, or opening a dropdown on ONE
// card no longer re-renders every other mounted card. For that memoization to
// actually take effect, every prop below must either be a plain value that's
// only different when the row's own state is (isChecked, isActive, replyState,
// etc. — computed fresh each InboxView render, but referentially stable for
// untouched rows) or a function whose identity doesn't change on every
// keystroke (see the useCallback/getter fixes next to their definitions in
// InboxView). This component MUST stay defined at module scope — defining it
// inside InboxView would make React treat every card as a brand-new component
// type on every render, which defeats memoization entirely (worse than before).
const EmailCard = React.memo(function EmailCard({
  email, isChecked, isActive, replyState, forwardState,
  isFlagOpen, isFolderPickerOpen, rsvpState, isReplyAllLoading,
  isFlagSubmitting, isFlagSuccess,
  onOpen, onToggleCheck, onMarkRead, onFlagToggle, onFolderPickerToggle,
  onSubmitCorrection, onRequestAddMembers, onDownloadFile,
  isFileDownloading, getFileProgress, onRsvp, setInlineRsvpState,
  onReplyChange, onForwardChange, onReplyAttach, onRemoveReplyAttachment,
  onGenerateAiReply, onSendReply, onReplyAll, onSendForward,
  getEmailBody, formatDate, getEffectiveReceivedAt,
}) {
  const navigate = useNavigate();
  const atts    = email.attachments || [];
  const emailId = email.id || email.messageId;

  return (
    <div key={emailId}
      className={`email-card ${!email.isRead ? "unread-mail" : ""} ${isActive ? "active" : ""} border-${(email.category || 'normal').toLowerCase()}`}
      // content-visibility:auto is the actual scroll fix: the list keeps growing
      // (visibleCount only ever goes up as you scroll — see loadMoreSentinelCallback
      // in InboxView) and every card carries its own box-shadow plus a
      // backdrop-filter-blurred category badge, so once a few hundred cards have
      // mounted the browser is doing full layout+paint on all of them on every
      // scroll frame, even the ones nowhere near the viewport. This tells the
      // browser to skip layout/paint entirely for off-screen cards without
      // unmounting them — no scroll-position math, no risk to click handlers or
      // open dropdowns. contain-intrinsic-size gives it a rough placeholder
      // height to reserve for cards it hasn't measured yet (below the fold on
      // first load); "auto" means it remembers the real height once a card has
      // actually been shown once, so the estimate only matters before that.
      style={{ display: 'flex', alignItems: 'stretch', padding: 0, overflow: 'hidden', contain: 'content', contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
      onClick={() => onOpen(email)}>

      <div className="ec-left-border" style={{ flexShrink: 0 }}></div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', flexShrink: 0, alignSelf: 'center' }}
        onClick={e => { e.stopPropagation(); onToggleCheck(emailId); }}>
        <RoundCheckbox checked={isChecked} onClick={e => { e.stopPropagation(); onToggleCheck(emailId); }} />
      </div>

      <div className="ec-content" style={{ flex: 1, minWidth: 0, padding: '14px 16px 14px 0' }}>

        {/* TOP ROW */}
        <div className="ec-top" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
          <h4 style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flex: 1, minWidth: 0, margin: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{email.subject || "No Subject"}</span>
            {(() => { const tc = email.threadCount || email.thread_count || email.messages?.length || 0; return tc > 1 ? (<span style={{ background: "linear-gradient(135deg, #00d9ff, #8b5cf6)", color: "white", fontSize: "0.65rem", fontWeight: "700", padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap", flexShrink: 0, letterSpacing: "0.3px" }}>🧵 {tc} messages</span>) : null; })()}
          </h4>
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
            <button onClick={(e) => { e.stopPropagation(); onMarkRead(email); }} disabled={email.isRead}
              style={{ background: email.isRead ? "#22c55e" : "#0ea5e9", color: "white", border: "none", borderRadius: "5px", padding: "3px 8px", fontSize: "0.7rem", cursor: email.isRead ? "not-allowed" : "pointer", fontWeight: "600", whiteSpace: "nowrap", opacity: email.isRead ? 0.6 : 1, flexShrink: 0 }}>
              {email.isRead ? "✓ Read" : "Mark Read"}
            </button>
            <div className="ec-badges" style={{ flexShrink: 0 }}>
              {email.hasReplied && (<span style={{ background: "#16a34a", color: "white", padding: "2px 8px", borderRadius: "999px", fontSize: "0.65rem", fontWeight: "700", marginLeft: "6px", whiteSpace: "nowrap" }}>↩️ Replied</span>)}
              {(() => { const cat = (email.category || "PENDING").toUpperCase(); const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL; return <span className={`cat-tag ${cat.toLowerCase()}`} style={{ whiteSpace: "nowrap" }}>{meta.emoji} {meta.label}</span>; })()}
            </div>
            {/* Flag button */}
            <button
              onClick={e => { e.stopPropagation(); onFlagToggle(isFlagOpen ? null : emailId); }}
              title="Wrong classification? Flag it"
              style={{ background: isFlagOpen ? 'rgba(239,68,68,0.12)' : 'transparent', border: `1px solid ${isFlagOpen ? 'rgba(239,68,68,0.3)' : 'transparent'}`, color: isFlagOpen ? '#f87171' : 'var(--text-muted)', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: '0.72rem', fontWeight: '600', transition: 'all 0.15s' }}
              onMouseEnter={e => { if (!isFlagOpen) { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.2)'; e.currentTarget.style.color = '#f87171'; }}}
              onMouseLeave={e => { if (!isFlagOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}}
            >
              <Flag size={12} /> Flag
            </button>
            {/* Add-to-folder button */}
            <button
              onClick={e => { e.stopPropagation(); onFolderPickerToggle(isFolderPickerOpen ? null : emailId); }}
              title="Add sender to a folder"
              style={{ background: isFolderPickerOpen ? 'rgba(59,130,246,0.12)' : 'transparent', border: `1px solid ${isFolderPickerOpen ? 'rgba(59,130,246,0.3)' : 'transparent'}`, color: isFolderPickerOpen ? '#60a5fa' : 'var(--text-muted)', borderRadius: '6px', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: '0.72rem', fontWeight: '600', transition: 'all 0.15s' }}
              onMouseEnter={e => { if (!isFolderPickerOpen) { e.currentTarget.style.background = 'rgba(59,130,246,0.08)'; e.currentTarget.style.borderColor = 'rgba(59,130,246,0.2)'; e.currentTarget.style.color = '#60a5fa'; }}}
              onMouseLeave={e => { if (!isFolderPickerOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}}
            >
              <FolderPlus size={12} /> Add to Folder
            </button>
            {/* Opens Iris already looking at this email, so you don't have to
                describe something you're staring at so it can go find it. */}
            {/* Styled to stand out rather than sit among the muted secondary
                actions — as a faint text button it read as decoration and
                went unnoticed. */}
            <button
              onClick={e => { e.stopPropagation(); askIrisAbout(email); }}
              title="Ask Iris about this email — draft a reply, summarise it, or see what they're asking for"
              style={{ background: 'linear-gradient(135deg, rgba(0,217,255,0.22), rgba(139,92,246,0.22))', border: '1px solid rgba(0,217,255,0.55)', color: '#8be9ff', borderRadius: '999px', padding: '4px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.2px', boxShadow: '0 0 10px rgba(0,217,255,0.20)', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,217,255,0.38), rgba(139,92,246,0.38))'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.boxShadow = '0 0 16px rgba(0,217,255,0.40)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,217,255,0.22), rgba(139,92,246,0.22))'; e.currentTarget.style.color = '#8be9ff'; e.currentTarget.style.boxShadow = '0 0 10px rgba(0,217,255,0.20)'; }}
            >
              <Sparkles size={13} /> Ask Iris
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
        {isFlagOpen && (
          <FlagDropdown
            email={email}
            onSubmit={onSubmitCorrection}
            onClose={() => onFlagToggle(null)}
            submitting={isFlagSubmitting}
            success={isFlagSuccess}
          />
        )}

        {/* ADD-TO-FOLDER DROPDOWN */}
        {isFolderPickerOpen && (() => {
          const senderEmail = extractEmail(getEmailSender(email));
          return (
            <FolderPickerDropdown
              senderEmail={senderEmail}
              onClose={() => onFolderPickerToggle(null)}
              onPick={(folderName) => {
                onFolderPickerToggle(null);
                onRequestAddMembers(folderName, MANAGEABLE_META[folderName]?.label || folderName, [senderEmail]);
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
                <button onClick={(e) => { e.stopPropagation(); onDownloadFile({ ...a, attachmentId: a.attachmentId }, email.messageId || email.id); }}
                  disabled={isFileDownloading(a, email.messageId || email.id)}
                  style={{ backgroundColor: isFileDownloading(a, email.messageId || email.id) ? "#9ca3af" : "#0ea5e9", cursor: isFileDownloading(a, email.messageId || email.id) ? "not-allowed" : "pointer", color: "white", padding: "6px 12px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", gap: "6px" }}>
                  {isFileDownloading(a, email.messageId || email.id) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(a, email.messageId || email.id)}%</> : <><Download size={16} /> Download</>}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* RSVP — MEETING & ZOOM INVITES */}
        {(() => {
          // Shared with the Insights INVITES tile and the INVITES filter —
          // see meetingInvite.js. Kept in one place so the RSVP bar, the
          // count, and the filtered list can't drift apart again.
          if (!isMeetingInvite(email)) return null;
          const rsvp = rsvpState;
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
                  <button onClick={e => { e.stopPropagation(); onRsvp(email, "Accept"); }} disabled={rsvp.loading} style={{ background: "linear-gradient(135deg, #16a34a, #15803d)", color: "white", border: "none", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", boxShadow: "0 3px 10px rgba(22,163,74,0.3)", opacity: rsvp.loading ? 0.6 : 1 }}>
                    {rsvp.loading ? <Loader size={13} className="animate-spin" /> : "✓"} Accept
                  </button>
                  <button onClick={e => { e.stopPropagation(); onRsvp(email, "Tentative"); }} disabled={rsvp.loading} style={{ background: "rgba(245,158,11,0.12)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.35)", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", opacity: rsvp.loading ? 0.6 : 1 }}>? Maybe</button>
                  <button onClick={e => { e.stopPropagation(); onRsvp(email, "Decline"); }} disabled={rsvp.loading} style={{ background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "6px", padding: "5px 14px", fontSize: "0.78rem", fontWeight: "700", cursor: rsvp.loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "5px", opacity: rsvp.loading ? 0.6 : 1 }}>✗ Decline</button>
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
              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="To" value={replyState.replyTo} onChange={(newValue) => onReplyChange(emailId, { replyTo: newValue })} placeholder="Search contacts or enter email..." /></div>
              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="CC" value={replyState.replyCc} onChange={(newValue) => onReplyChange(emailId, { replyCc: newValue })} placeholder="Optional - Search contacts or enter email..." /></div>
            </div>
            <textarea placeholder="Type your reply..." value={replyState.replyBody} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onChange={(e) => onReplyChange(emailId, { replyBody: e.target.value })} style={{ width: "100%", minHeight: "90px", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--bg-main)", color: "var(--text-primary)", resize: "vertical" }} />
            <div style={{ marginTop: "10px", marginBottom: "10px" }}>
              <input type="file" multiple id={`reply-attach-${emailId}`} style={{ display: "none" }} onChange={(e) => onReplyAttach(emailId, e.target.files)} />
              <label htmlFor={`reply-attach-${emailId}`} onClick={(e) => e.stopPropagation()} style={{ background: "#f3f4f6", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600", color: "#374151", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Paperclip size={14} /> Attach Files
              </label>
            </div>
            {replyState.attachments.length > 0 && (
              <div style={{ marginBottom: "10px", padding: "8px", background: "var(--bg-main)", borderRadius: "6px" }}>
                {replyState.attachments.map((f, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "4px 0", borderBottom: idx < replyState.attachments.length - 1 ? "1px solid var(--border-color)" : "none" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><Paperclip size={12} color="#6b7280" /> {f.name}</span>
                    <button onClick={(e) => { e.stopPropagation(); onRemoveReplyAttachment(emailId, idx); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px 6px" }} title="Remove attachment"><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginBottom: "12px" }}>
              <button onClick={(e) => { e.stopPropagation(); onGenerateAiReply(replyState.fullBody ? { ...email, body: replyState.fullBody } : email); }} disabled={replyState.drafting} style={{ background: replyState.drafting ? "#9ca3af" : "#0ea5e9", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "0.85rem", cursor: replyState.drafting ? "not-allowed" : "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px" }}>
                {replyState.drafting ? <><Loader size={14} className="animate-spin" /> Drafting...</> : <>✨ Auto-Draft</>}
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "16px" }}>
              <button onClick={(e) => { e.stopPropagation(); onReplyChange(emailId, { showReply: false, replyBody: "", replyTo: "", replyCc: "", drafting: false, attachments: [] }); }} style={{ background: "transparent", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer" }}>Cancel</button>
              <button onClick={(e) => { e.stopPropagation(); onSendReply(email, replyState); }} disabled={replyState.drafting || !replyState.replyBody.trim()} style={{ background: "#16a34a", color: "white", border: "none", padding: "6px 14px", borderRadius: "6px", fontWeight: "600", cursor: replyState.drafting || !replyState.replyBody.trim() ? "not-allowed" : "pointer" }}>
                {replyState.drafting ? "Sending..." : "Send"}
              </button>
            </div>
            <div style={{ marginTop: "4px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              <hr /><HtmlEmailRenderer body={replyState.fullBody || getEmailBody(email)} />
            </div>
          </div>
        )}

        {/* REPLY / REPLY ALL / FORWARD BUTTONS */}
        {!replyState.showReply && !forwardState.showForward && (
          <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
            <button onClick={(e) => { e.stopPropagation(); const toEmail = extractEmail(email.from || email.sender || ""); const ccEmails = Array.isArray(email.cc) ? email.cc.map(extractEmail).filter(Boolean).join(", ") : ""; onReplyChange(emailId, { showReply: true, replyBody: "", replyTo: toEmail, replyCc: ccEmails, attachments: [], isReplyAll: false }); }} style={{ background: "#0ea5e9", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", cursor: "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "5px" }}>↩️ Reply</button>
            <button onClick={(e) => { e.stopPropagation(); onReplyAll(email); }}
              disabled={isReplyAllLoading}
              style={{ background: "transparent", color: isReplyAllLoading ? "var(--text-secondary)" : "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", cursor: isReplyAllLoading ? "not-allowed" : "pointer", fontWeight: "600", display: "flex", alignItems: "center", gap: "5px", transition: "border-color 0.15s, background 0.15s", opacity: isReplyAllLoading ? 0.6 : 1 }}
              onMouseEnter={e => { if (!isReplyAllLoading) { e.currentTarget.style.borderColor = "#0ea5e9"; e.currentTarget.style.color = "#0ea5e9"; } }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-primary)"; }}>
              {isReplyAllLoading ? <><Loader size={13} className="animate-spin" /> Loading...</> : <>↩️↩️ Reply All</>}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onForwardChange(emailId, { showForward: true, forwardBody: "", forwardTo: "", forwardCc: "", attachments: [] }); }}
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
              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="To" value={forwardState.forwardTo} onChange={(val) => onForwardChange(emailId, { forwardTo: val })} placeholder="Search contacts or enter email..." /></div>
              <div onClick={(e) => e.stopPropagation()}><EmailAutocomplete label="CC" value={forwardState.forwardCc} onChange={(val) => onForwardChange(emailId, { forwardCc: val })} placeholder="Optional CC..." /></div>
            </div>
            <textarea placeholder="Add a note before the forwarded message... (optional)" value={forwardState.forwardBody} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onChange={(e) => onForwardChange(emailId, { forwardBody: e.target.value })} style={{ width: "100%", minHeight: "80px", padding: "10px", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--bg-main)", color: "var(--text-primary)", resize: "vertical", boxSizing: "border-box" }} />
            <div style={{ marginTop: "10px", marginBottom: "10px" }}>
              <input type="file" multiple id={`fwd-attach-${emailId}`} style={{ display: "none" }} onChange={(e) => { if (!e.target.files) return; onForwardChange(emailId, { attachments: [...forwardState.attachments, ...Array.from(e.target.files)] }); }} />
              <label htmlFor={`fwd-attach-${emailId}`} onClick={(e) => e.stopPropagation()} style={{ background: "#f3f4f6", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600", color: "#374151", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Paperclip size={14} /> Add Extra Attachment
              </label>
            </div>
            {forwardState.attachments.length > 0 && (
              <div style={{ marginBottom: "10px", padding: "8px", background: "var(--bg-main)", borderRadius: "6px" }}>
                {forwardState.attachments.map((f, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "4px 0", borderBottom: idx < forwardState.attachments.length - 1 ? "1px solid var(--border-color)" : "none" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><Paperclip size={12} color="#6b7280" /> {f.name}</span>
                    <button onClick={(e) => { e.stopPropagation(); onForwardChange(emailId, { attachments: forwardState.attachments.filter((_, i) => i !== idx) }); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px 6px" }}><X size={14} /></button>
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
              <button onClick={(e) => { e.stopPropagation(); onForwardChange(emailId, { showForward: false, forwardBody: "", forwardTo: "", forwardCc: "", sending: false, attachments: [] }); }} style={{ background: "transparent", border: "1px solid var(--border-color)", padding: "6px 12px", borderRadius: "6px", cursor: "pointer", color: "var(--text-secondary)", fontWeight: "600" }}>Cancel</button>
              <button onClick={(e) => { e.stopPropagation(); onSendForward(email, forwardState); }} disabled={forwardState.sending || !forwardState.forwardTo.trim()} style={{ background: forwardState.sending || !forwardState.forwardTo.trim() ? "#9ca3af" : "#f59e0b", color: "white", border: "none", padding: "6px 16px", borderRadius: "6px", fontWeight: "700", cursor: forwardState.sending || !forwardState.forwardTo.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
                {forwardState.sending ? <><Loader size={14} className="animate-spin" /> Forwarding...</> : <>➡️ Forward</>}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
});
// ─────────────────────────────────────────────────────────────────────────────

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
  inboxError,
  inboxErrorKind,
  fetchAndAnalyze,
  isAnalyzingBackground,
  isFetchingFullInbox = false,
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
  canUseTracking = false,
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
  // pattern as Calendarview.jsx/Trackingview.jsx rather than a new prop-threading path.
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
  // ── Tracking tab state ──────────────────────────────────────────────────
  const [trackingData,      setTrackingData]       = useState(null);
  const [trackingLoading,   setTrackingLoading]    = useState(false);
  const [trackingSyncing,   setTrackingSyncing]    = useState(false);
  const [followUpCompose,   setFollowUpCompose]    = useState(null); // { to, subject }
  const feedRef = useRef(null);

  // ── Incremental list rendering ──────────────────────────────────────────
  // Rendering hundreds of email cards at once (backend fetches up to 500)
  // tanks scroll performance. Only render a growing slice, and load more
  // as the user nears the bottom via IntersectionObserver.
  const [visibleCount, setVisibleCount] = useState(60);
  const loadMoreObserverRef = useRef(null);
  const loadMoreSentinelCallback = useCallback((node) => {
    if (loadMoreObserverRef.current) loadMoreObserverRef.current.disconnect();
    if (node) {
      loadMoreObserverRef.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) setVisibleCount(c => c + 60);
      }, { rootMargin: '600px' });
      loadMoreObserverRef.current.observe(node);
    }
  }, []);
  useEffect(() => {
    setVisibleCount(60);
  }, [activeFolder, activeCategory, searchQuery, senderFilter]);

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

  // Show back-to-top button after scrolling 300px.
  // `passive: true` lets the browser scroll without waiting to see whether
  // this handler calls preventDefault — it never does.
  // (This effect used to be duplicated verbatim below, attaching two
  // identical listeners that both ran on every scroll event.)
  useEffect(() => {
    const parent = getScrollParent();
    if (!parent) return;
    const onScroll = () => setShowScrollTop(parent.scrollTop > 300);
    parent.addEventListener('scroll', onScroll, { passive: true });
    return () => parent.removeEventListener('scroll', onScroll);
  }, []);

  // ── Fetch tracking data when Tracking tab is selected ──────────────────
  // Guard: only fetch on the FIRST visit (trackingData === null).
  // Subsequent tab switches reuse the already-loaded data.
  // The manual Refresh button calls fetchTrackingData() directly, bypassing this guard.
  useEffect(() => {
    if (activeFolder !== 'TRACKING') return;
    if (trackingData !== null) return;   // already loaded — don't re-fetch
    fetchTrackingData();
  }, [activeFolder, trackingData]);

  const fetchTrackingData = async () => {
    const userEmail = localStorage.getItem('userEmail') || '';
    if (!userEmail) return;
    setTrackingLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tracking?user_email=${encodeURIComponent(userEmail)}`);
      if (res.ok) {
        const data = await res.json();
        setTrackingData(data);
      }
    } catch (e) {
      console.error('fetchTrackingData error:', e);
    } finally {
      setTrackingLoading(false);
    }
  };

  const syncTracking = async () => {
    const userEmail = localStorage.getItem('userEmail') || '';
    if (!userEmail || trackingSyncing) return;
    setTrackingSyncing(true);
    try {
      await fetch(`${API_BASE}/tracking/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail }),
      });
      // Reload after short delay to let scheduler start
      setTimeout(fetchTrackingData, 3000);
    } catch (e) {
      console.error('syncTracking error:', e);
    } finally {
      setTimeout(() => setTrackingSyncing(false), 3500);
    }
  };

  const dismissTrackingRecipient = async (messageId, recipientEmail) => {
    const userEmail = localStorage.getItem('userEmail') || '';
    try {
      await fetch(`${API_BASE}/tracking/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_email: userEmail, message_id: messageId, recipient_email: recipientEmail }),
      });
      // Optimistic UI update
      setTrackingData(prev => {
        if (!prev) return prev;
        const update = (list) => list.map(item => {
          if (item.messageId !== messageId) return item;
          const newRec = { ...item.recipients };
          if (newRec[recipientEmail]) newRec[recipientEmail] = { ...newRec[recipientEmail], dismissed: true };
          return { ...item, recipients: newRec };
        });
        return {
          ...prev,
          awaiting:       update(prev.awaiting || []),
          reminders_sent: update(prev.reminders_sent || []),
        };
      });
    } catch (e) {
      console.error('dismissTrackingRecipient error:', e);
    }
  };
  // ────────────────────────────────────────────────────────────────────────

  // useCallback([]) — reads only the setter's functional-update `prev`, never
  // outer state directly, so an empty dep array is safe and keeps this
  // reference stable across renders (needed for EmailCard's React.memo below).
  const toggleCardSelection = useCallback((emailId) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      next.has(emailId) ? next.delete(emailId) : next.add(emailId);
      return next;
    });
  }, []);
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

  // Rewritten to go through setInlineReplyState's functional-update form
  // directly instead of reading getEmailReplyState(emailId) — that getter
  // depends on inlineReplyState, so calling it from inside a useCallback
  // would force a new reference (and re-render every EmailCard) on every
  // keystroke in every reply box. This version needs no deps.
  const handleReplyAttachmentSelect = useCallback((emailId, files) => {
    if (!files || !files.length) return;
    setInlineReplyState(prev => {
      const current = prev[emailId] || DEFAULT_REPLY_STATE;
      return { ...prev, [emailId]: { ...current, attachments: [...current.attachments, ...Array.from(files)] } };
    });
  }, []);
  const removeReplyAttachment = useCallback((emailId, index) => {
    setInlineReplyState(prev => {
      const current = prev[emailId] || DEFAULT_REPLY_STATE;
      return { ...prev, [emailId]: { ...current, attachments: current.attachments.filter((_, i) => i !== index) } };
    });
  }, []);

  const getRsvpState = (emailId) => inlineRsvpState[emailId] || DEFAULT_RSVP_STATE;

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

  // Takes replyState as a parameter (EmailCard already has it from its own
  // props) instead of calling getEmailReplyState(emailId) internally — that
  // getter depends on inlineReplyState, so referencing it here would make
  // this callback (and every card holding it as onSendReply) unstable on
  // every keystroke in every reply box across the whole list.
  const sendInlineReply = useCallback(async (email, state) => {
    const emailId = email.id || email.messageId;
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
  }, [setEmailReplyState, markAsReplied, markAsReadById]);

  // Same reasoning as sendInlineReply above — forwardState comes in as a
  // parameter so this stays stable across forward-box keystrokes.
  const sendInlineForward = useCallback(async (email, state) => {
    const emailId = email.id || email.messageId;
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
  }, [setEmailForwardState]);

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

    // If the card already has populated To recipients AND a body to quote,
    // use it immediately. Cache-hit rows (see save_emails_to_id_cache in
    // services.py) no longer carry the full body, so they fall through to
    // the detail fetch below — which was already happening for recipients
    // on most rows anyway, and returns body too.
    const hasRecipients = Array.isArray(email.to) && email.to.length > 0;
    if (hasRecipients && email.body) {
      const { toStr, ccStr } = buildRecipients(email);
      setEmailReplyState(emailId, {
        showReply: true, replyBody: "", replyTo: toStr,
        replyCc: ccStr, attachments: [], isReplyAll: true
      });
      return;
    }

    // Otherwise fetch full detail first so we get the real recipient list
    // (and, for cache-hit rows, the body to quote — stashed as fullBody).
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
        replyCc: ccStr, attachments: [], isReplyAll: true,
        fullBody: detail.body || email.body || ""
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
  const requestAddMembers = useCallback((folderName, folderLabel, emails) => {
    const cleaned = emails.map(e => e.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    setMemberActionPending({ type: 'add', folderName, folderLabel, emails: cleaned });
  }, []);

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
          if (cat === 'INVITES') return folderPool.filter(isMeetingInvite).length;
          return folderPool.filter(e => e.category === cat).length;
        };

        // Every count above except the ALL_EMAILS folder badge (which is backed
        // by the exact EWS total in totalEmailCount) is derived from whatever's
        // currently in `emails`. While the background full-inbox fetch is still
        // running, that's only the fast first batch — so these are a floor, not
        // the final number. Mark them with a "+" instead of quietly showing a
        // count that will jump once the rest of the inbox lands.
        const renderCount = (n, isExact = false) => (
          <>
            {n}
            {isFetchingFullInbox && !isExact && (
              <span style={{ opacity: 0.65 }} title="Still counting — more emails are loading">+</span>
            )}
          </>
        );

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
                    <span className={`count-badge ${isActive ? 'active' : ''}`}>{renderCount(folderMsgCount(name), name === 'ALL_EMAILS')}</span>
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
                    <span className={`count-badge badge-${tab.name.toLowerCase()}`}>{renderCount(catCount(tab.name), tab.name === 'ALL' && activeFolder === 'ALL_EMAILS')}</span>
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

        // Step 3: apply category filter.
        // INVITES is not an AI category — it's the same predicate the
        // Insights tile counts with, so clicking that number lands on
        // exactly the emails it counted (it used to filter on ZOOM, which
        // was a different set from the number shown).
        let categoryPool = activeCategory === 'ALL'
          ? folderPool
          : activeCategory === 'INVITES'
            ? folderPool.filter(isMeetingInvite)
            : folderPool.filter(e => e.category === activeCategory);

        // Step 4: apply search
        const displayEmails = q
          ? categoryPool.filter(e =>
              (e.subject || "").toLowerCase().includes(q) ||
              (e.from || e.sender || "").toLowerCase().includes(q) ||
              (e.summary || "").toLowerCase().includes(q)
            )
          : categoryPool;

        const visibleEmails = displayEmails.slice(0, visibleCount);
        const hasMoreEmails = displayEmails.length > visibleCount;

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


        // ── TRACKING TAB — render completely separate view ────────────────
        if (activeFolder === 'TRACKING') {
          return (
            <>
            <div style={{ padding: '16px' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)' }}>📡 Follow-Up Tracking</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '3px' }}>
                    Auto-reminders sent on Day 1 & Day 3 to internal recipients. Day 5+ items appear in digest.
                  </div>
                </div>
                <button
                  onClick={syncTracking}
                  disabled={trackingSyncing}
                  style={{ background: trackingSyncing ? 'rgba(0,217,255,0.55)' : 'rgba(0,217,255,0.18)', border: '1px solid rgba(0,217,255,0.45)', color: '#60a5fa', borderRadius: '8px', padding: '7px 14px', fontSize: '0.78rem', fontWeight: '700', cursor: trackingSyncing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {trackingSyncing ? '⏳ Syncing...' : '🔄 Sync Now'}
                </button>
              </div>

              {trackingLoading ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '40px', textAlign: 'center' }}>Loading tracking data...</div>
              ) : !trackingData ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '40px', textAlign: 'center' }}>No tracking data yet. Click Sync Now to check your sent items.</div>
              ) : (
                <>
                  {/* AWAITING REPLY */}
                  <TrackingSection
                    title="⏳ Awaiting Reply"
                    color="#f59e0b"
                    items={trackingData.awaiting || []}
                    emptyMsg="No emails awaiting reply."
                    onDismiss={dismissTrackingRecipient}
                    onFollowUp={(item, addr, info) => {
                      setFollowUpCompose({
                        to: info?.originalAddress || addr,
                        subject: `Following up: ${item.subject}`,
                      });
                    }}
                  />

                  {/* REMINDERS SENT */}
                  <TrackingSection
                    title="📨 Reminders Sent"
                    color="#3b82f6"
                    items={trackingData.reminders_sent || []}
                    emptyMsg="No reminders sent yet."
                    onDismiss={dismissTrackingRecipient}
                    onFollowUp={(item, addr, info) => {
                      setFollowUpCompose({
                        to: info?.originalAddress || addr,
                        subject: `Following up: ${item.subject}`,
                      });
                    }}
                  />

                  {/* RESOLVED */}
                  {(trackingData.resolved || []).length > 0 && (
                    <TrackingSection
                      title="✅ Resolved"
                      color="#10b981"
                      items={trackingData.resolved || []}
                      emptyMsg=""
                      onDismiss={() => {}}
                      onFollowUp={() => {}}
                      readOnly
                    />
                  )}

                  {trackingData.lastUpdated && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '20px', textAlign: 'center' }}>
                      Last synced: {new Date(trackingData.lastUpdated).toLocaleString()}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Follow-up compose modal — sibling of main div inside Fragment */}
            {followUpCompose && (
              <ComposeMailModal
                isOpen={!!followUpCompose}
                onClose={() => setFollowUpCompose(null)}
                prefillTo={followUpCompose.to}
                prefillSubject={followUpCompose.subject}
              />
            )}
            </>
          );
        }
        // ─────────────────────────────────────────────────────────────────

        return (
          <div className="email-feed">
            {!inboxReady ? (
              <div className="loading-text">Syncing inbox...</div>
            ) : inboxError ? (
              <div className="loading-text" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                {/* Name the hop that actually failed. This used to always blame
                    Outlook, including when the real problem was that the
                    backend wasn't running — which sends you debugging the
                    wrong machine. */}
                {inboxErrorKind === 'server' ? (
                  <>
                    <div>Can't reach the dashboard server.</div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.75, fontStyle: 'normal' }}>
                      Outlook may be perfectly fine — the backend API isn't responding. Check that it's running.
                    </div>
                  </>
                ) : inboxErrorKind === 'timeout' ? (
                  <>
                    <div>The mail server is taking too long to respond.</div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.75, fontStyle: 'normal' }}>
                      It may just be slow right now. Retrying usually works.
                    </div>
                  </>
                ) : (
                  <>
                    <div>Couldn't reach Outlook, and there's no saved copy to fall back on yet.</div>
                    <div style={{ fontSize: '0.78rem', opacity: 0.75, fontStyle: 'normal' }}>
                      Once one sync succeeds, outages like this will show your last synced inbox instead.
                    </div>
                  </>
                )}
                <button
                  onClick={() => fetchAndAnalyze(false)}
                  style={{ background: 'rgba(0,217,255,0.18)', border: '1px solid rgba(0,217,255,0.45)', color: '#60a5fa', borderRadius: '8px', padding: '7px 14px', fontSize: '0.78rem', fontWeight: '700', cursor: 'pointer' }}
                >
                  🔄 Retry
                </button>
              </div>
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
                  <AnimatePresence>
                  {selectedCards.size > 0 && (
                    <motion.div
                      style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.16 }}
                    >
                      <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />
                      <button onClick={async () => { const toMark = displayEmails.filter(e => selectedCards.has(e.id || e.messageId) && !e.isRead); await Promise.all(toMark.map(e => markAsRead(e))); clearSelection(); }}
                        style={{ background: 'linear-gradient(135deg, #00d9ff, #8b5cf6)', color: 'white', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '0.82rem', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 4px 12px rgba(0,217,255,0.35)' }}>
                        ✉ Mark {selectedCards.size} as Read
                      </button>
                      <button onClick={clearSelection} style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '7px', padding: '6px 12px', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer', color: 'var(--text-secondary)' }}>Clear</button>
                    </motion.div>
                  )}
                  </AnimatePresence>
                </div>

                {/* BACKGROUND ANALYSIS BANNER */}
                {isAnalyzingBackground && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", margin: "0 0 8px 0", background: "rgba(0,217,255,0.05)", border: "1px solid rgba(0,217,255,0.15)", borderRadius: "8px", fontSize: "0.78rem", color: "#00d9ff" }}>
                    <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#00d9ff", boxShadow: "0 0 6px #00d9ff", animation: "pulse 1.4s ease-in-out infinite", flexShrink: 0 }} />
                    AI is analysing new emails in the background — summaries will update shortly.
                  </div>
                )}

                {/* EMAIL CARDS — each row is EmailCard (React.memo'd, defined above
                    InboxView) so editing/checking/opening one card doesn't force
                    every other mounted card to re-render. All per-row state is
                    resolved to plain values here, at map-time, so unaffected
                    rows keep referentially-stable props across renders. */}
                {visibleEmails.map((email) => {
                  const emailId = email.id || email.messageId;
                  return (
                    <EmailCard
                      key={emailId}
                      email={email}
                      isChecked={selectedCards.has(emailId)}
                      isActive={selectedEmail?.id === email.id || selectedEmail?.messageId === email.messageId}
                      replyState={getEmailReplyState(emailId)}
                      forwardState={getEmailForwardState(emailId)}
                      isFlagOpen={flagOpen === emailId}
                      isFolderPickerOpen={folderPickerFor === emailId}
                      rsvpState={getRsvpState(emailId)}
                      isReplyAllLoading={!!replyAllLoading[emailId]}
                      isFlagSubmitting={!!flagSubmitting[emailId]}
                      isFlagSuccess={!!flagSuccess[emailId]}
                      onOpen={setSelectedEmail}
                      onToggleCheck={toggleCardSelection}
                      onMarkRead={markAsRead}
                      onFlagToggle={setFlagOpen}
                      onFolderPickerToggle={setFolderPickerFor}
                      onSubmitCorrection={submitCorrection}
                      onRequestAddMembers={requestAddMembers}
                      onDownloadFile={handleFileDownload}
                      isFileDownloading={isFileDownloading}
                      getFileProgress={getFileProgress}
                      onRsvp={handleRsvp}
                      setInlineRsvpState={setInlineRsvpState}
                      onReplyChange={setEmailReplyState}
                      onForwardChange={setEmailForwardState}
                      onReplyAttach={handleReplyAttachmentSelect}
                      onRemoveReplyAttachment={removeReplyAttachment}
                      onGenerateAiReply={generateAiReplyForEmail}
                      onSendReply={sendInlineReply}
                      onReplyAll={handleReplyAll}
                      onSendForward={sendInlineForward}
                      getEmailBody={getEmailBody}
                      formatDate={formatDate}
                      getEffectiveReceivedAt={getEffectiveReceivedAt}
                    />
                  );
                })}

                {/* LOAD MORE SENTINEL — grows visibleCount as it scrolls into view */}
                {hasMoreEmails && (
                  <div ref={loadMoreSentinelCallback} style={{ padding: '18px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                    Loading more emails…
                  </div>
                )}

                {/* STILL SYNCING — the fast first batch is fully shown, but the
                    background fetch for the rest of the inbox hasn't landed yet. */}
                {!hasMoreEmails && isFetchingFullInbox && (
                  <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <Loader size={13} className="animate-spin" />
                    Fetching the rest of your inbox…
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}
      {/* BACK TO TOP BUTTON */}
      {showScrollTop && (
        <button
          onClick={() => getScrollParent()?.scrollTo({ top: 0 })}
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
      <AnimatePresence>
      {membersModal && (
        <AnimatedModal
          onOverlayClick={() => setMembersModal(null)}
          contentClassName="modal-content members-modal"
          contentStyle={{ width: '480px', maxWidth: '90%', height: 'auto', maxHeight: '70vh' }}
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
        </AnimatedModal>
      )}
      </AnimatePresence>

      {/* ADD/REMOVE CONFIRMATION — Y/N before any group-members API call commits */}
      <AnimatePresence>
      {memberActionPending && (
        <AnimatedModal
          overlayStyle={{ zIndex: 4000 }}
          onOverlayClick={() => !memberActionSubmitting && cancelMemberAction()}
          contentStyle={{ width: '380px', maxWidth: '90%', padding: '20px' }}
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
        </AnimatedModal>
      )}
      </AnimatePresence>

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

export default InboxView;