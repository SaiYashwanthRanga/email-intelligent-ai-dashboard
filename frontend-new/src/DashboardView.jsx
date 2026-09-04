import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  Paperclip, BarChart3, X, PieChart, Mail, ArrowLeft, Calendar,
  FileText, Download, Hash, Copy, Check, Sun, Moon, ArrowRight, Zap, Loader, LogOut,
  Radar, Users, SquarePen, Bot
} from 'lucide-react';
import TriageSummary from './TriageSummary';
import ToastContainer from './Toast';
import ComposeMailModal from "./ComposeMailModal";
import EmailAutocomplete from "./EmailAutocomplete";
import AILoadingScreen from "./Ailoadingscreen";
import Iris from "./Iris";
import InboxView, {
  API_BASE, getActiveUserEmail,
  replyToMail, forwardMail, markReadBackend, extractEmail,
  CATEGORY_META, HtmlEmailRenderer, FlagDropdown
} from './InboxView';

// ─── SKELETON SHIMMER ─────────────────────────────────────────────────────
const skeletonStyle = {
  background: "linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)",
  backgroundSize: "400px 100%",
  animation: "analyzingShimmer 1.6s ease-in-out infinite",
};

// ─── TOP SENDERS PANEL ────────────────────────────────────────────────────
function InsightsInstantPanel({ emails, onViewSender }) {
  const senderMap = {};
  emails.forEach(e => {
    const from = e.from || e.sender || "";
    const nameMatch  = from.match(/^([^<]+)</);
    const emailMatch = from.match(/[\w.+-]+@[\w.-]+/);
    const label = nameMatch ? nameMatch[1].trim() : (emailMatch ? emailMatch[0] : from);
    const key   = emailMatch ? emailMatch[0].toLowerCase() : from.toLowerCase();
    if (!key) return;
    if (!senderMap[key]) senderMap[key] = { label, count: 0, unread: 0, key };
    senderMap[key].count++;
    if (!e.isRead) senderMap[key].unread++;
  });
  const topSenders = Object.values(senderMap).sort((a, b) => b.count - a.count).slice(0, 6);
  if (!topSenders.length) return null;
  return (
    <div className="insta-glass-card" style={{ padding: "18px", marginBottom: "16px", animation: "fadeSlideUp 0.4s ease 0.1s both" }}>
      <div style={{ fontSize: "0.72rem", fontWeight: "700", letterSpacing: "1px", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: "14px" }}>👥 Top Senders by Volume</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {topSenders.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: `hsl(${(i * 47 + 210) % 360}, 60%, 45%)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: "800", color: "white", flexShrink: 0 }}>{s.label.charAt(0).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" }}>{s.label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{s.count} mail{s.count !== 1 ? "s" : ""}</span>
                  <button onClick={() => onViewSender && onViewSender(s.key, s.label)} style={{ background: "linear-gradient(135deg, #00d9ff, #8b5cf6)", color: "white", border: "none", borderRadius: "5px", padding: "2px 9px", fontSize: "0.68rem", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap", boxShadow: "0 2px 8px rgba(0,217,255,0.35)" }}>View</button>
                </div>
              </div>
              <div style={{ height: "4px", background: "var(--border-color)", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(s.count / topSenders[0].count) * 100}%`, background: `hsl(${(i * 47 + 210) % 360}, 60%, 45%)`, borderRadius: "4px", transition: "width 0.8s ease" }} />
              </div>
            </div>
            {s.unread > 0 && (<span style={{ background: "#f59e0b", color: "#000", fontSize: "0.6rem", fontWeight: "800", borderRadius: "999px", padding: "1px 6px", flexShrink: 0 }}>{s.unread} new</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SKELETON CARD ────────────────────────────────────────────────────────
function SkeletonCard({ lines = 2, style = {} }) {
  return (
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div style={{ width: "28px", height: "28px", borderRadius: "50%", ...skeletonStyle }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ height: "12px", width: "60%", borderRadius: "6px", ...skeletonStyle }} />
          <div style={{ height: "9px", width: "35%", borderRadius: "6px", ...skeletonStyle }} />
        </div>
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} style={{ height: "9px", width: i === lines - 1 ? "70%" : "100%", borderRadius: "6px", ...skeletonStyle }} />
      ))}
    </div>
  );
}

// ─── AI LOADING LABEL ─────────────────────────────────────────────────────
function AiLoadingLabel({ text = "AI is generating..." }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", marginBottom: "12px", background: "rgba(0,217,255,0.05)", border: "1px solid rgba(0,217,255,0.15)", borderRadius: "8px", fontSize: "0.78rem", color: "#00d9ff" }}>
      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#00d9ff", boxShadow: "0 0 6px #00d9ff", animation: "pulse 1.4s ease-in-out infinite", flexShrink: 0 }} />
      {text}
    </div>
  );
}

// ─── THREAD MESSAGES RENDERER ─────────────────────────────────────────────
function ThreadMessages({ parsedThread, inlineQuoteExpanded, setInlineQuoteExpanded }) {
  const [expandedIdx, setExpandedIdx] = useState({});
  useEffect(() => { setExpandedIdx({}); }, [parsedThread]);
  if (!parsedThread || parsedThread.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {parsedThread.map((msg, idx) => {
        const isLatest   = idx === 0;
        const isExpanded = isLatest || !!expandedIdx[idx];
        return (
          <div key={idx} style={{ border: isLatest ? '1px solid rgba(59,130,246,0.35)' : '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden', background: isLatest ? 'rgba(59,130,246,0.04)' : 'var(--bg-card)' }}>
            <div onClick={() => !isLatest && setExpandedIdx(p => ({ ...p, [idx]: !p[idx] }))}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', cursor: isLatest ? 'default' : 'pointer', background: isLatest ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)', borderBottom: isExpanded ? '1px solid var(--border-color)' : 'none', userSelect: 'none' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0, background: isLatest ? 'linear-gradient(135deg, #00d9ff, #8b5cf6)' : 'linear-gradient(135deg, #475569, #334155)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: '800', color: 'white' }}>
                {(msg.header || '?').replace('From:', '').trim().charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: '600', color: isLatest ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.header || 'Unknown'}</div>
                {!isExpanded && (<div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>{(msg.content || '').replace(/<[^>]+>/g, '').slice(0, 80) || '(no content)'}</div>)}
              </div>
              {isLatest
                ? <span style={{ fontSize: '0.6rem', fontWeight: '800', letterSpacing: '0.8px', background: 'rgba(59,130,246,0.15)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '999px', padding: '2px 8px', flexShrink: 0 }}>LATEST</span>
                : <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', flexShrink: 0 }}>{isExpanded ? '▲' : '▼'}</span>}
            </div>
            {isExpanded && (
              <div style={{ padding: '14px' }}>
                <div className="message-body"><HtmlEmailRenderer body={msg.content} /></div>
                {msg.quotedContent && (
                  <div style={{ marginTop: '10px' }}>
                    <button onClick={() => setInlineQuoteExpanded(p => ({ ...p, [idx]: !p[idx] }))}
                      style={{ background: 'rgba(100,116,139,0.1)', border: '1px solid rgba(100,116,139,0.25)', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: '700', color: 'var(--text-secondary)', letterSpacing: '1px', transition: 'all 0.15s' }}>
                      {inlineQuoteExpanded[idx] ? '▲ Hide quoted' : '··· Show quoted'}
                    </button>
                    {inlineQuoteExpanded[idx] && (<div style={{ marginTop: '8px' }}><HtmlEmailRenderer body={msg.quotedContent} /></div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PRIVATE HELPERS ──────────────────────────────────────────────────────
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

const validAtts = (atts) => (atts || []).filter(a => a && a.name && a.name.trim());

const collectThreadAtts = (email, parsed) => {
  const seen = new Set();
  const all  = [];
  validAtts(email?.attachments).forEach(a => { const key = a.attachmentId; if (!seen.has(key)) { seen.add(key); all.push(a); } });
  (parsed || []).forEach(msg => validAtts(msg?.attachments).forEach(a => { const key = a.attachmentId; if (!seen.has(key)) { seen.add(key); all.push(a); } }));
  return all;
};

// ─── DASHBOARD VIEW ───────────────────────────────────────────────────────
const DashboardView = ({
  emails, report, loading, mainView, setMainView, activeTab, setActiveTab,
  username, greetingInfo, theme, toggleTheme, toasts, removeToast,
  isProfileOpen, setIsProfileOpen,
  lastSyncTime, inboxReady, inboxError, isSoftSyncing, autoSyncEnabled, setAutoSyncEnabled,
  isFetchingFullInbox = false,
  selectedEmail, setSelectedEmail, fileModalData, setFileModalData,
  parsedThread, threadLoading, replyDraft, setReplyDraft, replyLoading, copySuccess,
  realThreads, filteredEmails, groupedEmails,
  fetchAndAnalyze, handleLogout, handleCopy, generateAiReply, openFiles,
  getAllAttachments, getSenderDetails, markAsRead,
  getParticipantDisplay, formatDate, getSafeDate, getEmailBody, getEmailAttachments,
  getEffectiveReceivedAt, markAsReplied, markAsReadById,
  isAnalyzingBackground,
  senderFilter, setSenderFilter,
  triageStats,
  canUseTracking = false,
  canUseActivity = false,
  autoDigest = null,
  digestLoading = false,
  // Flag / correction props
  flagOpen, setFlagOpen,
  flagSubmitting = {}, flagSuccess = {},
  submitCorrection,
}) => {
  const navigate = useNavigate();

  // ── Download state (shared: file modal + insights sender cards + inbox cards) ──
  const [downloadingFiles, setDownloadingFiles] = useState({});
  const getFileKey        = (file, messageId) => `${messageId || file.messageId || ""}__${file.name}`;
  const isFileDownloading = (file, messageId) => !!(downloadingFiles[getFileKey(file, messageId)]);
  const getFileProgress   = (file, messageId) => downloadingFiles[getFileKey(file, messageId)]?.progress || 0;

  // ── Scroll the detail pane back to top whenever the selected email changes ──
  // Uses the email's stable ID as the dependency so AI-field patches (summary,
  // category) don't retrigger the scroll — only a genuinely different email does.
  const detailPaneRef = useRef(null);
  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
  }, [selectedEmail?.id ?? selectedEmail?.messageId]);

  const handleFileDownload = useCallback(async (file, messageId) => {
    const key             = getFileKey(file, messageId);
    const targetMessageId = messageId || file.messageId;
    if (!targetMessageId) { alert("Missing messageId for this file"); return; }
    if (!file.attachmentId) { alert("Missing attachmentId for this file"); return; }
    if (downloadingFiles[key]) return;
    setDownloadingFiles(prev => ({ ...prev, [key]: { progress: 0 } }));
    try {
      const response = await axios.post(
        `${API_BASE}/download-attachment`,
        { name: file.name, messageId: targetMessageId, attachmentId: file.attachmentId, userEmail: getActiveUserEmail() },
        { responseType: "blob", onDownloadProgress: (e) => { if (e.total) { const pct = Math.round((e.loaded * 100) / e.total); setDownloadingFiles(prev => ({ ...prev, [key]: { progress: pct } })); } } }
      );
      const blob = new Blob([response.data]);
      const url  = window.URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert(`Download failed: ${file.name}`);
    } finally {
      setTimeout(() => { setDownloadingFiles(prev => { const next = { ...prev }; delete next[key]; return next; }); }, 800);
    }
  }, [downloadingFiles]);

  // ── Compose modal ────────────────────────────────────────────────────────
  const [showCompose, setShowCompose] = useState(false);

  // ── Active folder + category (lifted from InboxView so triage blocks can navigate) ──
  const [activeFolder,   setActiveFolder]   = useState('ALL_EMAILS');
  const [activeCategory, setActiveCategory] = useState('ALL');

  // ── Modal reply state (used in both Insights overlay and THREADS right pane) ──
  const [modalReplyTo,          setModalReplyTo]          = useState("");
  const [modalReplyCc,          setModalReplyCc]          = useState("");
  const [modalReplyAttachments, setModalReplyAttachments] = useState([]);
  const [modalReplySending,     setModalReplySending]     = useState(false);
  const [modalReplyMode,        setModalReplyMode]        = useState('reply');
  const [insightsDetailCollapsed, setInsightsDetailCollapsed] = useState(false);
  const [threadsDetailCollapsed,  setThreadsDetailCollapsed]  = useState(false);
  const [showInsightsCompose,   setShowInsightsCompose]   = useState(false);
  const [digestExpanded,        setDigestExpanded]        = useState(false);
  const [threadExpanded,        setThreadExpanded]        = useState(false);
  const [inlineQuoteExpanded,   setInlineQuoteExpanded]   = useState({});

  // Pre-fill To/CC whenever a new email is opened in the modal
  useEffect(() => {
    if (!selectedEmail) return;
    const senderEmail = extractEmail(selectedEmail.from || selectedEmail.sender || "");
    const ccList = Array.isArray(selectedEmail.cc) ? selectedEmail.cc.map(extractEmail).filter(Boolean).join(", ") : "";
    setModalReplyTo(senderEmail);
    setModalReplyCc(ccList);
    setModalReplyAttachments([]);
    setModalReplySending(false);
    setModalReplyMode("reply");
    setReplyDraft("");
    setInsightsDetailCollapsed(false);
    setThreadsDetailCollapsed(false);
    setShowInsightsCompose(false);
  }, [selectedEmail?.id || selectedEmail?.messageId, setReplyDraft]);

  useEffect(() => { setThreadExpanded(false); setInlineQuoteExpanded({}); }, [parsedThread]);

  const sendModalReply = useCallback(async () => {
    if (!selectedEmail) return;
    const isForward = modalReplyMode === "forward";
    // Forward only needs a recipient — no note required. Reply/Reply All still need drafted text.
    if (isForward ? !modalReplyTo.trim() : !replyDraft.trim()) return;

    setModalReplySending(true);
    const emailId = selectedEmail.id || selectedEmail.messageId;
    try {
      const messageItemId = selectedEmail.messageId || selectedEmail.id;
      if (!messageItemId) throw new Error("Missing messageItemId");
      const to = modalReplyTo.split(",").map(e => e.trim()).filter(Boolean);
      const cc = modalReplyCc.split(",").map(e => e.trim()).filter(Boolean);
      const bodyHtml = replyDraft.trim() ? `<p>${replyDraft.replace(/\n/g, "<br/>")}</p>` : "";

      if (isForward) {
        await forwardMail({ messageItemId, forwardBodyHtml: bodyHtml, to, cc, attachments: modalReplyAttachments });
      } else {
        await replyToMail({
          messageItemId,
          replyBodyHtml: bodyHtml,
          to, cc,
          attachments: modalReplyAttachments,
          isReplyAll: modalReplyMode === "replyAll"
        });
      }
      await markReadBackend(selectedEmail);
      markAsReplied(emailId, true);
      markAsReadById(emailId);
      setReplyDraft("");
      setModalReplyAttachments([]);
      setSelectedEmail(null);
    } catch (err) {
      console.error("Modal reply failed:", err);
      alert(isForward ? "Failed to forward email. Please try again." : "Failed to send reply. Please try again.");
    } finally {
      setModalReplySending(false);
    }
  }, [selectedEmail, replyDraft, modalReplyMode, modalReplyTo, modalReplyCc, modalReplyAttachments, markAsReplied, markAsReadById, setReplyDraft, setSelectedEmail]);

  const handleViewSender = useCallback((senderEmail, senderName) => {
    setSenderFilter({ email: senderEmail, name: senderName });
    setMainView('THREADS');
    setActiveTab('ALL');
  }, [setSenderFilter, setMainView, setActiveTab]);

  // ── ATTACHMENT LIST RENDERER (used in both detail panels) ──────────────
  const renderAttList = (atts) => (
    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: '800', letterSpacing: '1px', color: '#3b82f6', display: 'flex', alignItems: 'center', gap: '6px' }}><Paperclip size={13} /> ATTACHMENTS ({atts.length})</div>
      {atts.map((att, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: '500' }}>{att.name}<span style={{ fontSize: '0.78em', color: 'var(--text-secondary)', marginLeft: '6px' }}>{formatFileSize(att.size)}</span></span>
          <button onClick={(e) => { e.stopPropagation(); handleFileDownload(att, att.messageId); }} disabled={isFileDownloading(att, att.messageId)}
            style={{ backgroundColor: isFileDownloading(att, att.messageId) ? '#9ca3af' : '#0ea5e9', cursor: isFileDownloading(att, att.messageId) ? 'not-allowed' : 'pointer', color: 'white', padding: '5px 12px', borderRadius: '6px', border: 'none', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem', fontWeight: '600' }}>
            {isFileDownloading(att, att.messageId) ? <><Loader size={13} className="animate-spin" /> {getFileProgress(att, att.messageId)}%</> : <><Download size={14} /> Download</>}
          </button>
        </div>
      ))}
    </div>
  );

  // ═══════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════
  return (
    <div className="app-container">
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {/* ─── FILE MODAL ─── */}
      {fileModalData && (
        <div className="modal-overlay" onClick={() => setFileModalData(null)}>
          <div className="modal-content file-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3><Paperclip size={18} /> {fileModalData.title}</h3>
              <button className="btn-close" onClick={() => setFileModalData(null)}><X size={20} /></button>
            </div>
            <div className="file-list-container">
              {fileModalData.files.length === 0
                ? <div style={{ textAlign: 'center', padding: '40px' }}>No files found.</div>
                : fileModalData.files.map((f, i) => (
                  <div key={i} className="file-row">
                    <div className="file-icon">
                      {f.name && f.name.toLowerCase().endsWith('.pdf') ? <FileText size={20} color="#ea580c" /> : <Paperclip size={20} color="#3b82f6" />}
                    </div>
                    <div className="file-info">
                      <div className="file-name">{f.name || "Unnamed"}<span style={{ fontSize: "0.85em", color: "var(--text-secondary)", fontWeight: "normal", marginLeft: "8px" }}>{formatFileSize(f.size)}</span></div>
                      <div className="file-sender">From: {Array.isArray(f.senders) ? f.senders.join(", ") : "Unknown"}<br />Type: {f.type || "Unknown"}</div>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button onClick={(e) => { e.stopPropagation(); handleFileDownload(f, f.messageId); }} disabled={isFileDownloading(f, f.messageId)}
                        style={{ backgroundColor: isFileDownloading(f, f.messageId) ? "#9ca3af" : "#0ea5e9", cursor: isFileDownloading(f, f.messageId) ? "not-allowed" : "pointer", color: "white", padding: "6px 12px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", gap: "6px" }}>
                        {isFileDownloading(f, f.messageId) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(f, f.messageId)}%</> : <><Download size={16} /> Download</>}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── INSIGHTS EMAIL DETAIL OVERLAY ─── */}
      {selectedEmail && mainView === 'INSIGHTS' && (
        <div style={{ position: 'fixed', right: 0, top: '72px', width: '58%', minWidth: '520px', height: 'calc(100vh - 72px)', background: 'var(--bg-main)', borderLeft: '2px solid var(--border-color)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 500, boxShadow: '-8px 0 48px rgba(0,0,0,0.45)', animation: 'slideInRight 0.28s cubic-bezier(0.4,0,0.2,1)' }}>
          <div ref={detailPaneRef} style={{ flex: 1, overflowY: 'auto' }}>

            {/* SUBJECT BAR */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)', lineHeight: '1.4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedEmail.subject || 'No Subject'}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '5px', flexWrap: 'wrap' }}>
                  {(() => { const cat = (selectedEmail.category || 'NORMAL').toUpperCase(); const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL; return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>; })()}
                </div>
              </div>
              <button onClick={() => { setSelectedEmail(null); setReplyDraft(''); setModalReplyAttachments([]); }}
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <X size={16} />
              </button>
            </div>

            {/* METADATA GRID */}
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '12px 20px 8px', background: 'var(--bg-main)' }}>
                <div style={{ background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#3b82f6', marginBottom: '4px' }}>🔵 FROM</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{getParticipantDisplay(selectedEmail)}</div>
                </div>
                <div style={{ background: 'rgba(168,85,247,0.07)', border: '1px solid rgba(168,85,247,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#a855f7', marginBottom: '4px' }}>🟣 RECEIVED</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500' }}>{formatDate(getEffectiveReceivedAt(selectedEmail))}</div>
                </div>
                <div style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#22c55e', marginBottom: '4px' }}>🟢 TO</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{Array.isArray(selectedEmail.to) ? selectedEmail.to.join(', ') : (selectedEmail.to || '—')}</div>
                </div>
                <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#f59e0b', marginBottom: '4px' }}>🟡 CC</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{Array.isArray(selectedEmail.cc) && selectedEmail.cc.length > 0 ? selectedEmail.cc.join(', ') : '—'}</div>
                </div>
              </div>
              {selectedEmail.summary && (<div style={{ padding: '4px 20px 12px' }}><div className="modal-summary-box"><strong>💡 AI Summary:</strong> {selectedEmail.summary}</div></div>)}
            </div>

            {/* ACTION BUTTONS */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px 20px', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)' }}>
              {[{ mode: 'reply', label: '↩ Reply' }, { mode: 'replyAll', label: '↩↩ Reply All' }, { mode: 'forward', label: '➤ Forward' }].map(({ mode, label }) => (
                <button key={mode}
                  onClick={() => { if (showInsightsCompose && modalReplyMode === mode) { setShowInsightsCompose(false); } else { setModalReplyMode(mode); setShowInsightsCompose(true); } }}
                  style={{ padding: '7px 16px', borderRadius: '7px', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer', background: showInsightsCompose && modalReplyMode === mode ? 'linear-gradient(135deg, #00d9ff, #8b5cf6)' : 'var(--bg-main)', color: showInsightsCompose && modalReplyMode === mode ? 'white' : 'var(--text-secondary)', border: showInsightsCompose && modalReplyMode === mode ? 'none' : '1px solid var(--border-color)', boxShadow: showInsightsCompose && modalReplyMode === mode ? '0 4px 12px rgba(0,217,255,0.35)' : 'none', transition: 'all 0.15s ease' }}>
                  {label}
                </button>
              ))}
              {!selectedEmail.isRead && (
                <button onClick={() => markAsRead(selectedEmail)} style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: '7px', fontSize: '0.78rem', fontWeight: '600', cursor: 'pointer', background: '#0ea5e9', color: 'white', border: 'none', display: 'flex', alignItems: 'center', gap: '5px' }}>✉ Mark Read</button>
              )}
              {/* Flag wrong classification */}
              {submitCorrection && (() => {
                const eid = selectedEmail.id || selectedEmail.messageId;
                const isOpen = flagOpen === eid;
                return (
                  <button
                    onClick={() => setFlagOpen(isOpen ? null : eid)}
                    title="Wrong classification? Flag it"
                    style={{ marginLeft: selectedEmail.isRead ? 'auto' : '0', padding: '7px 12px', borderRadius: '7px', fontSize: '0.78rem', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', background: isOpen ? 'rgba(239,68,68,0.1)' : 'var(--bg-main)', color: isOpen ? '#f87171' : 'var(--text-muted)', border: `1px solid ${isOpen ? 'rgba(239,68,68,0.3)' : 'var(--border-color)'}`, transition: 'all 0.15s' }}
                  >
                    🚩 {isOpen ? 'Cancel' : 'Flag'}
                  </button>
                );
              })()}
            </div>

            {/* FLAG DROPDOWN — detail panel */}
            {submitCorrection && flagOpen === (selectedEmail.id || selectedEmail.messageId) && (
              <div style={{ padding: '0 20px 4px', background: 'var(--bg-card)', borderBottom: '1px solid var(--border-color)' }}>
                <FlagDropdown
                  email={selectedEmail}
                  onSubmit={submitCorrection}
                  onClose={() => setFlagOpen(null)}
                  submitting={!!flagSubmitting[selectedEmail.id || selectedEmail.messageId]}
                  success={!!flagSuccess[selectedEmail.id || selectedEmail.messageId]}
                />
              </div>
            )}

            {/* COMPOSE DRAWER */}
            <div style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)' }}>
              <div style={{ padding: '10px 20px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '0.66rem', fontWeight: '800', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#3b82f6', width: '36px', flexShrink: 0 }}>TO</span>
                  <div style={{ flex: 1 }}><EmailAutocomplete value={modalReplyTo} onChange={setModalReplyTo} placeholder="Recipients..." /></div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '0.66rem', fontWeight: '800', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#f59e0b', width: '36px', flexShrink: 0 }}>CC</span>
                  <div style={{ flex: 1 }}><EmailAutocomplete value={modalReplyCc} onChange={setModalReplyCc} placeholder="CC recipients..." /></div>
                </div>
              </div>
              <div style={{ padding: '10px 20px 0' }}>
                {replyLoading ? <div className="ai-thinking">Thinking...</div>
                  : <textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} className="reply-textarea" placeholder="Write your reply here, or click ✨ AI Draft below..." style={{ minHeight: '90px' }} />}
              </div>
              <div style={{ padding: '8px 20px 0', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <input type="file" multiple id="insights-reply-attach" style={{ display: 'none' }} onChange={(e) => { if (e.target.files) setModalReplyAttachments(prev => [...prev, ...Array.from(e.target.files)]); }} />
                <label htmlFor="insights-reply-attach" style={{ background: 'var(--bg-main)', border: '1px solid var(--border-color)', padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <Paperclip size={14} /> Attach Files {modalReplyAttachments.length > 0 && (<span style={{ background: '#0ea5e9', color: 'white', fontSize: '0.62rem', fontWeight: '800', borderRadius: '999px', padding: '1px 6px' }}>{modalReplyAttachments.length}</span>)}
                </label>
              </div>
              {modalReplyAttachments.length > 0 && (
                <div style={{ padding: '6px 20px 0', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {modalReplyAttachments.map((f, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '8px', padding: '4px 10px', fontSize: '0.78rem' }}>
                      <Paperclip size={12} color="#3b82f6" />
                      <span style={{ color: 'var(--text-primary)', fontWeight: '500', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>({(f.size / 1024 / 1024).toFixed(2)} MB)</span>
                      <button onClick={() => setModalReplyAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0 2px', lineHeight: 1 }}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ padding: '10px 20px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <button onClick={generateAiReply} disabled={replyLoading} style={{ background: replyLoading ? '#9ca3af' : 'linear-gradient(135deg, #00d9ff, #8b5cf6)', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '0.85rem', fontWeight: '700', cursor: replyLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: replyLoading ? 'none' : '0 4px 12px rgba(0,217,255,0.35)' }}>
                  {replyLoading ? <><Loader size={14} className="animate-spin" /> Drafting...</> : <>✨ AI Draft</>}
                </button>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => { setShowInsightsCompose(false); setReplyDraft(''); setModalReplyAttachments([]); }} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontWeight: '600', fontSize: '0.85rem' }}>Cancel</button>
                  {(() => {
                    const sendBlocked = modalReplySending || (modalReplyMode === "forward" ? !modalReplyTo.trim() : !replyDraft.trim());
                    return (
                      <button onClick={sendModalReply} disabled={sendBlocked} style={{ padding: '9px 22px', borderRadius: '8px', border: 'none', background: 'linear-gradient(135deg, #16a34a, #15803d)', color: 'white', fontWeight: '700', fontSize: '0.9rem', cursor: sendBlocked ? 'not-allowed' : 'pointer', opacity: sendBlocked ? 0.5 : 1, boxShadow: '0 6px 20px rgba(22,163,74,0.35)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {modalReplySending ? <><Loader size={14} className="animate-spin" /> Sending...</> : <>➤ Send</>}
                      </button>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* EMAIL CONVERSATION */}
            <div style={{ padding: '16px 20px' }}>
              {threadLoading ? (
                <div className="loading-text">Loading content...</div>
              ) : selectedEmail.messages && selectedEmail.messages.length > 1 ? (
                <div className="email-thread-container">
                  <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)' }}><Hash size={16} style={{ display: 'inline', marginRight: '5px' }} /> Conversation History ({selectedEmail.messages.length})</div>
                  {(() => { const atts = collectThreadAtts(selectedEmail, parsedThread); return atts.length > 0 && renderAttList(atts); })()}
                  <ThreadMessages parsedThread={parsedThread} inlineQuoteExpanded={inlineQuoteExpanded} setInlineQuoteExpanded={setInlineQuoteExpanded} />
                </div>
              ) : (
                <div className="email-thread-container">
                  <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: 'var(--text-primary)' }}><Mail size={16} style={{ display: 'inline', marginRight: '5px' }} /> Email Content</div>
                  {(() => { const atts = validAtts(selectedEmail?.attachments); return atts.length > 0 && renderAttList(atts); })()}
                  <div className="thread-conversation">
                    <div className="message-item message-thread">
                      <div className="message-from">From: {getParticipantDisplay(selectedEmail)} | {formatDate(getEffectiveReceivedAt(selectedEmail))}</div>
                      <div className="message-body"><HtmlEmailRenderer body={selectedEmail.body || ''} /></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── MAIN CONTENT ─── */}
      <main className="main-content">
        <header className="top-bar">
          <div className="top-left">
            <div className="brand" style={{ marginRight: '20px' }}>
              <img src="https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp" alt="Horizon Family Medical Group" style={{ height: '36px', width: 'auto', objectFit: 'contain', filter: 'brightness(1.05)', display: 'block' }} />
            </div>
            <div className="view-switcher">
              <button className={`view-btn ${mainView === 'INSIGHTS' ? 'active' : ''}`} onClick={() => { setSelectedEmail(null); setMainView('INSIGHTS'); }}><PieChart size={18} /> Insights</button>
              <button className={`view-btn ${mainView === 'THREADS' ? 'active' : ''}`}  onClick={() => { setSelectedEmail(null); setMainView('THREADS'); }}><Mail size={18} /> Inbox</button>
              <button className="view-btn" onClick={() => navigate('/calendar')} title="Open Calendar"><Calendar size={18} /> Calendar</button>
              {canUseTracking && (
                <button className="view-btn" onClick={() => navigate('/tracking')} title="Follow-Up Tracking" style={{ position: 'relative' }}><Radar size={18} /> Tracking</button>
              )}
              {canUseActivity && (
                <button className="view-btn" onClick={() => navigate('/activity')} title="Team Activity"><Users size={18} /> Activity</button>
              )}
              <Iris
                emails={emails}
                report={report}
                triageStats={triageStats}
                getParticipantDisplay={getParticipantDisplay}
                getEffectiveReceivedAt={getEffectiveReceivedAt}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "20px" }}>
              <button className="menu-btn" onClick={fetchAndAnalyze} title="Refresh Inbox"><Zap size={20} /></button>
              <button className={`bubble-btn bubble-sync ${autoSyncEnabled ? 'bubble-sync-on' : 'bubble-sync-off'}`} onClick={() => setAutoSyncEnabled(prev => !prev)} title="Toggle Auto Sync">
                <span className="sync-dot" aria-hidden="true" />
                Auto Sync {autoSyncEnabled ? "ON" : "OFF"}
              </button>
              {lastSyncTime && (
                <span className="sync-time-label" style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                  Last synced: {new Date(lastSyncTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {isSoftSyncing && <span className="ai-working" style={{ marginLeft: "8px" }}><Bot size={13} style={{ verticalAlign: '-2px' }} /> AI Updating…</span>}
                </span>
              )}
            </div>
            <button className="menu-btn" style={{ marginLeft: '15px' }} onClick={toggleTheme} title="Toggle Theme">
              {theme === 'dark' ? <Sun size={20} color="#fbbf24" /> : <Moon size={20} color="#64748b" />}
            </button>
          </div>
          <button className="bubble-btn bubble-compose" onClick={() => setShowCompose(true)} style={{ marginRight: '15px' }} title="Compose new email">
            <SquarePen size={16} /> <span className="compose-btn-text">Compose</span>
          </button>
          <div className="user-profile" onClick={() => setIsProfileOpen(!isProfileOpen)}>
            <div className="user-info welcome-text" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginRight: '10px' }}>
              <span style={{ fontSize: '1.3rem', fontWeight: '700', letterSpacing: '-0.5px' }}>{greetingInfo.greeting}, {username.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')}</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '500' }}>{greetingInfo.date}</span>
            </div>
            <div className="avatar">{(username.trim().split(/\s+/)[0] || "U").charAt(0).toUpperCase()}</div>
            {isProfileOpen && (
              <div className="profile-dropdown">
                <button onClick={(e) => { e.stopPropagation(); handleLogout(); }} className="dropdown-item text-red"><LogOut size={16} /> Sign Out</button>
              </div>
            )}
          </div>
        </header>

        {loading ? (
          <div className="ai-loading-container"><AILoadingScreen emailCount={emails?.length || 0} /></div>
        ) : (
          <>
            {/* ─── INSIGHTS VIEW ─── */}
            {mainView === 'INSIGHTS' && (
              <div className="dashboard-grid">
                <div className="col-left">
                  <TriageSummary stats={triageStats} realThreads={realThreads} emails={emails} report={report}
                    onAttachmentClick={() => { const allFiles = getAllAttachments(); setFileModalData({ title: `All Attachments (${allFiles.length})`, files: allFiles }); }}
                    onEmailsClick={() => { setSelectedEmail(null); setMainView('THREADS'); setActiveFolder('ALL_EMAILS'); setActiveCategory('ALL'); }}
                    onThreadsClick={() => { setSelectedEmail(null); setMainView('THREADS'); setActiveFolder('THREADS'); setActiveCategory('ALL'); }}
                    onInvitesClick={() => { setSelectedEmail(null); setMainView('THREADS'); setActiveFolder('ALL_EMAILS'); setActiveCategory('ZOOM'); }} />

                  {emails.length > 0 && (<div style={{ marginBottom: "4px" }}><InsightsInstantPanel emails={emails} onViewSender={handleViewSender} /></div>)}

                  {/* DAILY DIGEST */}
                  <div className="section-title"><FileText size={20} /> 📋 Daily Digest</div>
                  {(() => {
                    // autoDigest = complete EWS data (no gaps, all 7 days, read + unread)
                    // report.daily_digest = partial cache fallback (used until autoDigest loads)
                    const digestData = autoDigest?.digest?.length > 0
                      ? autoDigest.digest
                      : report?.daily_digest;

                    if (digestLoading && !digestData) {
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                          <AiLoadingLabel text="Loading your 7-day digest..." />
                          {[3, 2, 2].map((lines, i) => <SkeletonCard key={i} lines={lines} />)}
                        </div>
                      );
                    }
                    if (!digestData || digestData.length === 0) {
                      return <div className="empty-placeholder">No digest available yet.</div>;
                    }
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {autoDigest && (
                          <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px", opacity: 0.7 }}>
                            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block", flexShrink: 0 }} />
                            Complete inbox · {autoDigest.email_count} emails · read &amp; unread included
                          </div>
                        )}
                        {(digestExpanded ? digestData : digestData.slice(0, 2)).map((item, i) => {
                          const dateLabel = (() => {
                            try {
                              const d = new Date(item.date + "T12:00:00");
                              const today = new Date();
                              const yesterday = new Date(today);
                              yesterday.setDate(yesterday.getDate() - 1);
                              if (d.toDateString() === today.toDateString()) return "Today";
                              if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
                              return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
                            } catch { return item.date; }
                          })();
                          return (
                            <div key={i} className="insta-glass-card" style={{ borderLeft: `4px solid ${i === 0 ? "#00d9ff" : "#3b82f6"}`, padding: "18px 20px", animation: `fadeSlideUp 0.35s ease ${i * 0.08}s both` }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                  <span style={{ fontSize: "1rem", fontWeight: "800", color: i === 0 ? "#00d9ff" : "#3b82f6", letterSpacing: "0.3px" }}>{dateLabel}</span>
                                  {i === 0 && (<span style={{ background: "rgba(0,217,255,0.15)", border: "1px solid rgba(0,217,255,0.3)", color: "#00d9ff", fontSize: "0.62rem", fontWeight: "800", padding: "2px 8px", borderRadius: "999px", letterSpacing: "0.5px" }}>LATEST</span>)}
                                </div>
                                <span style={{ fontSize: "0.75rem", fontWeight: "600", color: "var(--text-secondary)", background: "rgba(255,255,255,0.05)", border: "1px solid var(--border-color)", borderRadius: "20px", padding: "3px 10px" }}>{item.email_count} email{item.email_count !== 1 ? "s" : ""}</span>
                              </div>
                              {item.paragraph
                                ? <p style={{ margin: 0, fontSize: "0.92rem", lineHeight: "1.75", color: "var(--text-secondary)" }}>{item.paragraph}</p>
                                : <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-muted)", fontStyle: "italic" }}>Summary not available for this day.</p>
                              }
                            </div>
                          );
                        })}
                        {digestData.length > 2 && (
                          <button onClick={() => setDigestExpanded(x => !x)}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "10px 20px", background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-color)", borderRadius: "10px", cursor: "pointer", fontSize: "0.82rem", fontWeight: "700", color: "var(--text-secondary)", transition: "all 0.2s ease", width: "100%" }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.color = "#3b82f6"; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.color = "var(--text-secondary)"; }}>
                            {digestExpanded
                              ? <><span>▲</span> Show less</>
                              : <><span>▼</span> Show {digestData.length - 2} more day{digestData.length - 2 > 1 ? "s" : ""}</>
                            }
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {/* AI THREAD SUMMARIES */}
                  <div className="section-title"><Hash size={20} /> 🧵 AI Thread Summaries</div>
                  {!report ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      <AiLoadingLabel text="AI is analysing your threads, summaries coming shortly..." />
                      {[2, 3, 2, 2].map((lines, i) => <SkeletonCard key={i} lines={lines} />)}
                    </div>
                  ) : (
                    <div className="thread-summary-large">
                      <div className="ts-hero">
                        <h1>Executive Summary</h1>
                        {report.all_thread_files && report.all_thread_files.length > 0 && (
                          <button className="btn-glass mt-2" onClick={() => openFiles("All Project Files", report.all_thread_files)}>
                            <Paperclip size={16} /> View All {report.all_thread_files.length} Files
                          </button>
                        )}
                      </div>
                      <div className="ts-content">
                        {(report.briefing_cards || []).length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                            {(() => {
                              const seenSubjects = new Set();
                              return report.briefing_cards.filter(card => {
                                const key = (card.subject || card.topic || card.id || "").trim().toLowerCase();
                                if (!key || seenSubjects.has(key)) return false;
                                seenSubjects.add(key);
                                return true;
                              });
                            })().map((card) => {
                              const searchPool  = groupedEmails || emails;
                              const threadEmail =
                                searchPool.find(e => String(e.id).trim() === String(card.id).trim() || String(e.messageId).trim() === String(card.id).trim()) ||
                                (card.subject && searchPool.find(e => e.subject?.trim().toLowerCase() === card.subject.trim().toLowerCase()));
                              const isRead         = threadEmail?.isRead ?? false;
                              const displaySubject = card.subject || threadEmail?.subject || card.topic;
                              const msgCount       = card.thread_count || threadEmail?.threadCount || threadEmail?.thread_count || threadEmail?.messages?.length || 0;
                              return (
                                <div key={card.id} className="briefing-card-row" onClick={() => { if (threadEmail) setSelectedEmail(threadEmail); }} style={{ cursor: "pointer", opacity: isRead ? 0.7 : 1 }} title="Click to view full conversation">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                      {!isRead && (<span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#3b82f6', flexShrink: 0, display: 'inline-block' }} title="Unread" />)}
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div className="briefing-topic" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displaySubject}</div>
                                        {msgCount > 1 && (<span style={{ display: 'inline-block', marginTop: '4px', background: 'linear-gradient(135deg, #00d9ff, #8b5cf6)', color: 'white', fontSize: '0.62rem', fontWeight: '700', padding: '2px 8px', borderRadius: '999px', letterSpacing: '0.3px' }}>🧵 {msgCount} messages</span>)}
                                      </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                      {(() => { const cat = ((card.category || threadEmail?.category || 'NORMAL')).toUpperCase(); const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL; return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>; })()}
                                      {threadEmail && !isRead && (<button onClick={(e) => { e.stopPropagation(); markAsRead(threadEmail); }} title="Mark as read" style={{ background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '5px', padding: '3px 9px', fontSize: '0.7rem', fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px' }}>✉ Mark Read</button>)}
                                      <ArrowRight size={16} color="var(--accent-blue)" />
                                    </div>
                                  </div>
                                  <div className="briefing-status">{card.summary || threadEmail?.summary || card.status}</div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (<p className="no-summary-text">{report.thread_summary || "No executive summary available."}</p>)}
                      </div>
                    </div>
                  )}
                </div>

                {/* SENDER INSIGHTS */}
                <div className="col-right">
                  <div className="section-title"><BarChart3 size={20} /> 👥 Sender Insights</div>
                  {!report ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      <AiLoadingLabel text="Building sender intelligence..." />
                      {[2, 2, 3, 2].map((lines, i) => <SkeletonCard key={i} lines={lines} />)}
                    </div>
                  ) : (
                    <div className="sender-list-grid">
                      {(report.sender_summaries || []).map((s, i) => {
                        const { mails, attachments } = getSenderDetails(s.name);
                        return (
                          <div key={i} className="sender-card-large">
                            <div className="sender-top">
                              <div className="avatar-small">{s.name.charAt(0).toUpperCase()}</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <strong>{s.name}</strong>
                                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{mails.length} Emails • {attachments.length} Attachments</div>
                              </div>
                              <button onClick={() => handleViewSender(s.name, s.name)} style={{ background: "linear-gradient(135deg, #00d9ff, #8b5cf6)", color: "white", border: "none", borderRadius: "6px", padding: "4px 12px", fontSize: "0.72rem", fontWeight: "700", cursor: "pointer", flexShrink: 0, boxShadow: "0 2px 8px rgba(0,217,255,0.35)", whiteSpace: "nowrap" }}>View Emails</button>
                            </div>
                            <div className="sender-desc">{s.summary || "No summary available"}</div>
                            {mails.length > 0 && (
                              <div style={{ marginTop: "10px" }}>
                                <strong style={{ fontSize: "0.9rem" }}>Emails Sent:</strong>
                                <ul style={{ fontSize: "0.8rem", paddingLeft: "18px", marginTop: "5px" }}>{mails.map((m, idx) => <li key={idx}>{m.subject || "No Subject"}</li>)}</ul>
                              </div>
                            )}
                            {attachments.length > 0 && (
                              <div style={{ marginTop: "10px" }}>
                                <strong style={{ fontSize: "0.9rem" }}>Attachments:</strong>
                                <div className="ec-atts" style={{ marginTop: "5px" }}>
                                  {attachments.map((a, idx) => (
                                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                      <span style={{ flex: 1 }}>{a.name || "File"}<span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>{formatFileSize(a.size)}</span></span>
                                      <button onClick={(e) => { e.stopPropagation(); handleFileDownload(a, a.messageId); }} disabled={isFileDownloading(a, a.messageId)}
                                        style={{ backgroundColor: isFileDownloading(a, a.messageId) ? "#9ca3af" : "#0ea5e9", cursor: isFileDownloading(a, a.messageId) ? "not-allowed" : "pointer", color: "white", padding: "6px 12px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", gap: "6px" }}>
                                        {isFileDownloading(a, a.messageId) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(a, a.messageId)}%</> : <><Download size={16} /> Download</>}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ─── INBOX VIEW ─── */}
            {mainView === 'THREADS' && (
              <div style={{ display: 'flex', height: 'calc(100vh - 72px)', overflow: 'hidden' }}>

                {/* LEFT PANE */}
                <div style={{ width: selectedEmail ? '42%' : '100%', minWidth: selectedEmail ? '360px' : 'unset', transition: 'width 0.3s cubic-bezier(0.4,0,0.2,1)', overflowY: 'auto', overflowX: 'hidden', flexShrink: 0, borderRight: selectedEmail ? '1px solid var(--border-color)' : 'none' }}>
                  <InboxView
                    emails={emails}
                    filteredEmails={filteredEmails}
                    groupedEmails={groupedEmails}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    activeFolder={activeFolder}
                    setActiveFolder={setActiveFolder}
                    activeCategory={activeCategory}
                    setActiveCategory={setActiveCategory}
                    selectedEmail={selectedEmail}
                    setSelectedEmail={setSelectedEmail}
                    senderFilter={senderFilter}
                    setSenderFilter={setSenderFilter}
                    inboxReady={inboxReady}
                    inboxError={inboxError}
                    fetchAndAnalyze={fetchAndAnalyze}
                    isAnalyzingBackground={isAnalyzingBackground}
                    isFetchingFullInbox={isFetchingFullInbox}
                    markAsRead={markAsRead}
                    markAsReplied={markAsReplied}
                    markAsReadById={markAsReadById}
                    formatDate={formatDate}
                    getEffectiveReceivedAt={getEffectiveReceivedAt}
                    getEmailBody={getEmailBody}
                    handleFileDownload={handleFileDownload}
                    isFileDownloading={isFileDownloading}
                    getFileProgress={getFileProgress}
                    totalEmailCount={triageStats?.vol_emails}
                    canUseTracking={canUseTracking}
                    flagOpen={flagOpen}
                    setFlagOpen={setFlagOpen}
                    flagSubmitting={flagSubmitting}
                    flagSuccess={flagSuccess}
                    submitCorrection={submitCorrection}
                  />
                </div>

                {/* RIGHT PANE — Email Detail */}
                {selectedEmail && (
                  <div className="visionos-aurora-panel" style={{ flex: 1, borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', animation: 'fadeSlideIn 0.25s cubic-bezier(0.2,0,0,1) both', minWidth: 0 }}>
                  {/* Scrolls independently of the animated aurora background above —
                      keeping them decoupled avoids recompositing the blur every scroll frame. */}
                  <div ref={detailPaneRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                    <div className="modal-header">
                      <button className="btn-close" onClick={() => setSelectedEmail(null)}><ArrowLeft size={18} /> Back</button>
                      <div className="modal-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {(() => { const cat = (selectedEmail.category || "NORMAL").toUpperCase(); const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL; return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>; })()}
                        <button onClick={() => markAsRead(selectedEmail)} disabled={selectedEmail.isRead}
                          style={{ background: selectedEmail.isRead ? '#16a34a' : '#0ea5e9', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 12px', fontSize: '0.78rem', fontWeight: '700', cursor: selectedEmail.isRead ? 'not-allowed' : 'pointer', opacity: selectedEmail.isRead ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap', transition: 'background 0.2s ease' }}>
                          {selectedEmail.isRead ? '✓ Read' : '✉ Mark Read'}
                        </button>
                      </div>
                    </div>

                    <div className="modal-body-scroll">
                      <h2 className="modal-subject">{selectedEmail.subject}</h2>
                      <div>
                        <div className="visionos-meta-grid">
                          <div className="visionos-meta-card" style={{ borderLeft: '3px solid #3b82f6' }}>
                            <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#3b82f6', marginBottom: '4px' }}>🔵 FROM</div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{getEmailSender(selectedEmail)}</div>
                          </div>
                          <div className="visionos-meta-card" style={{ borderLeft: '3px solid #a855f7' }}>
                            <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#a855f7', marginBottom: '4px' }}>🟣 RECEIVED</div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500' }}>{formatDate(getEffectiveReceivedAt(selectedEmail))}</div>
                          </div>
                          <div className="visionos-meta-card" style={{ borderLeft: '3px solid #22c55e' }}>
                            <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#22c55e', marginBottom: '4px' }}>🟢 TO</div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{Array.isArray(selectedEmail.to) ? selectedEmail.to.join(', ') : selectedEmail.to || '—'}</div>
                          </div>
                          <div className="visionos-meta-card" style={{ borderLeft: '3px solid #f59e0b' }}>
                            <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#f59e0b', marginBottom: '4px' }}>🟡 CC</div>
                            <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{Array.isArray(selectedEmail.cc) && selectedEmail.cc.length > 0 ? selectedEmail.cc.join(', ') : '—'}</div>
                          </div>
                        </div>
                        <div className="modal-summary-box"><strong>💡 AI Summary:</strong> {selectedEmail.summary}</div>
                      </div>

                      {/* REPLY SECTION */}
                      <div className="reply-section">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <strong style={{ color: "var(--text-primary)", fontWeight: "700", whiteSpace: "nowrap" }}>Draft Reply</strong>
                            {replyDraft && (<button onClick={handleCopy} className="btn-copy" title="Copy">{copySuccess ? <Check size={14} color="#10b981" /> : <Copy size={14} />} {copySuccess ? "Copied!" : "Copy"}</button>)}
                            {/* Forward doesn't require a note — only Reply/Reply All need drafted text before Send appears */}
                            {(modalReplyMode === "forward" || replyDraft) && (() => {
                              const sendBlocked = modalReplySending || (modalReplyMode === "forward" ? !modalReplyTo.trim() : !replyDraft.trim());
                              return (
                                <button onClick={sendModalReply} disabled={sendBlocked}
                                  style={{ background: modalReplySending ? "#9ca3af" : "linear-gradient(135deg, #16a34a, #15803d)", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem", fontWeight: "700", cursor: sendBlocked ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px", boxShadow: "0 4px 12px rgba(22,163,74,0.3)" }}>
                                  {modalReplySending ? <><Loader size={13} className="animate-spin" /> Sending...</> : <>➤ Send</>}
                                </button>
                              );
                            })()}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                            {[
                              { key: "reply",    label: "↩ Reply",      activeColor: "linear-gradient(135deg, #00d9ff, #8b5cf6)", inactiveBg: "rgba(0,217,255,0.12)",   inactiveColor: "#93c5fd",  inactiveBorder: "rgba(0,217,255,0.35)",  onClick: () => { setModalReplyTo(extractEmail(selectedEmail?.from || selectedEmail?.sender || "")); setModalReplyCc(""); setModalReplyMode("reply"); } },
                              { key: "replyAll", label: "↩↩ Reply All", activeColor: "linear-gradient(135deg, #00d9ff, #8b5cf6)", inactiveBg: "rgba(0,217,255,0.12)",   inactiveColor: "#93c5fd",  inactiveBorder: "rgba(0,217,255,0.35)",  onClick: () => { const myEmail = getActiveUserEmail().toLowerCase(); const senderEmail = extractEmail(selectedEmail?.from || selectedEmail?.sender || ""); const toSet = new Set(); if (senderEmail) toSet.add(senderEmail); if (Array.isArray(selectedEmail?.to)) { selectedEmail.to.forEach(t => { const addr = extractEmail(t); if (addr && addr.toLowerCase() !== myEmail) toSet.add(addr); }); } const ccList = Array.isArray(selectedEmail?.cc) ? selectedEmail.cc.map(extractEmail).filter(a => a && a.toLowerCase() !== myEmail) : []; setModalReplyTo([...toSet].join(", ")); setModalReplyCc(ccList.join(", ")); setModalReplyMode("replyAll"); } },
                              { key: "forward",  label: "→ Forward",    activeColor: "linear-gradient(135deg, #f59e0b, #d97706)", inactiveBg: "rgba(245,158,11,0.1)", inactiveColor: "#fbbf24", inactiveBorder: "rgba(245,158,11,0.3)", onClick: () => { setModalReplyTo(""); setModalReplyCc(""); setModalReplyMode("forward"); } },
                            ].map(btn => {
                              const active = modalReplyMode === btn.key;
                              return (
                                <button key={btn.key} onClick={btn.onClick}
                                  style={{ height: "32px", padding: "0 14px", background: active ? btn.activeColor : btn.inactiveBg, color: active ? "white" : btn.inactiveColor, border: `1px solid ${active ? "transparent" : btn.inactiveBorder}`, borderRadius: "6px", fontSize: "0.78rem", fontWeight: "700", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", whiteSpace: "nowrap", transition: "all 0.15s" }}>
                                  {btn.label}
                                </button>
                              );
                            })}
                            <div style={{ width: "1px", height: "22px", background: "var(--border-color)", flexShrink: 0 }} />
                            <button onClick={generateAiReply} disabled={replyLoading}
                              style={{ height: "32px", padding: "0 16px", background: replyLoading ? "#9ca3af" : "linear-gradient(135deg, #06b6d4, #3b82f6)", color: "white", border: "none", borderRadius: "6px", fontSize: "0.78rem", fontWeight: "700", cursor: replyLoading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap", boxShadow: replyLoading ? "none" : "0 0 14px rgba(6,182,212,0.4)" }}>
                              {replyLoading ? <><Loader size={13} className="animate-spin" /> Drafting...</> : <>✨ Auto-Draft</>}
                            </button>
                          </div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <span style={{ fontSize: "0.68rem", fontWeight: "800", letterSpacing: "1.2px", color: "#3b82f6", width: "28px", flexShrink: 0 }}>TO</span>
                            <div style={{ flex: 1 }}><EmailAutocomplete value={modalReplyTo} onChange={setModalReplyTo} placeholder="Search contacts or enter email..." /></div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <span style={{ fontSize: "0.68rem", fontWeight: "800", letterSpacing: "1.2px", color: "#f59e0b", width: "28px", flexShrink: 0 }}>CC</span>
                            <div style={{ flex: 1 }}><EmailAutocomplete value={modalReplyCc} onChange={setModalReplyCc} placeholder="Optional CC..." /></div>
                          </div>
                        </div>

                        <div className="reply-box">
                          {replyLoading ? <div className="ai-thinking">Thinking...</div>
                            : <textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} className="reply-textarea" placeholder="Type your reply here, or click Auto-Draft to generate one with AI..." />}
                        </div>

                        <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                          <input type="file" multiple id="modal-reply-attach" style={{ display: "none" }} onChange={(e) => { if (e.target.files) setModalReplyAttachments(prev => [...prev, ...Array.from(e.target.files)]); }} />
                          <label htmlFor="modal-reply-attach" style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", padding: "5px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600", color: "var(--text-primary)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                            <Paperclip size={14} /> Attach Files {modalReplyAttachments.length > 0 && (<span style={{ background: "#0ea5e9", color: "white", fontSize: "0.62rem", fontWeight: "800", borderRadius: "999px", padding: "1px 6px" }}>{modalReplyAttachments.length}</span>)}
                          </label>
                        </div>
                        {modalReplyAttachments.length > 0 && (
                          <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {modalReplyAttachments.map((f, idx) => (
                              <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: "8px", padding: "4px 10px", fontSize: "0.78rem" }}>
                                <Paperclip size={12} color="#3b82f6" />
                                <span style={{ color: "var(--text-primary)", fontWeight: "500", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                                <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>({(f.size / 1024 / 1024).toFixed(2)} MB)</span>
                                <button onClick={() => setModalReplyAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "0 2px", lineHeight: 1 }}><X size={12} /></button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <hr className="divider" />

                      {/* THREAD / SINGLE CONTENT */}
                      {threadLoading ? (
                        <div className="loading-text">Loading content...</div>
                      ) : selectedEmail.messages && selectedEmail.messages.length > 1 ? (
                        <div className="email-thread-container">
                          <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b' }}><Hash size={16} style={{ display: 'inline', marginRight: '5px' }} /> Conversation History ({selectedEmail.messages.length})</div>
                          {(() => { const atts = collectThreadAtts(selectedEmail, parsedThread); return atts.length > 0 && renderAttList(atts); })()}
                          <ThreadMessages parsedThread={parsedThread} inlineQuoteExpanded={inlineQuoteExpanded} setInlineQuoteExpanded={setInlineQuoteExpanded} />
                        </div>
                      ) : (
                        <div className="email-thread-container">
                          <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b' }}><Mail size={16} style={{ display: 'inline', marginRight: '5px' }} /> Email Content</div>
                          {(() => { const atts = validAtts(selectedEmail?.attachments); return atts.length > 0 && renderAttList(atts); })()}
                          <div className="thread-conversation">
                            <div className="message-item message-thread">
                              <div className="message-from">From: {getParticipantDisplay(selectedEmail)} | {formatDate(getEffectiveReceivedAt(selectedEmail))}</div>
                              <div className="message-body"><HtmlEmailRenderer body={selectedEmail.body || ""} /></div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      <ComposeMailModal isOpen={showCompose} onClose={() => setShowCompose(false)} />
    </div>
  );
};

export default DashboardView;