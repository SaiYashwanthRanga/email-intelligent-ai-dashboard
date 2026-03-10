import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom'; 
import axios from 'axios';
import {
  User, Paperclip, BarChart3, X, PieChart, Mail, Clock, ArrowLeft, Calendar,
  FileText, Download, Users, LogOut, Hash, Copy, Check, Sun, Moon, ArrowRight, Zap, Loader
} from 'lucide-react';
import TriageSummary from './TriageSummary';
import ToastContainer from './Toast';
import ComposeMailModal from "./ComposeMailModal";
import EmailAutocomplete from "./EmailAutocomplete";
import AILoadingScreen from "./Ailoadingscreen";

// --- API BASE ---
const API_BASE = process.env.REACT_APP_API_URL || "http://172.22.6.145:8080/api";

// Always read the logged-in user's email at call-time
const getActiveUserEmail = () => localStorage.getItem("userEmail") || "";

// ✅ Reply API (multipart/form-data)
const replyToMail = async ({ messageItemId, replyBodyHtml, to, cc, attachments = [] }) => {
  const formData = new FormData();
  formData.append("messageItemId", messageItemId);
  formData.append("replyBodyHtml", replyBodyHtml);
  formData.append("targetUserEmail", getActiveUserEmail());
  to.forEach(e => formData.append("to", e));
  cc.forEach(e => formData.append("cc", e));
  attachments.forEach(file => formData.append("attachments", file));
  return axios.post(`${API_BASE}/reply-email`, formData);
};

// ✅ Persist read status after reply
const markReadBackend = async (email) => {
  const messageId = email.id || email.messageId;
  if (!messageId) return;
  await axios.post(`${API_BASE}/mark-read`, { email: getActiveUserEmail(), messageId });
};

// --- Helper: Extract email from "Name <email@domain.com>" ---
const extractEmail = (value) => {
  if (!value) return "";
  const match = value.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : value;
};

// --- CATEGORY META ---
const CATEGORY_META = {
  PRIORITY: { emoji: "🔥", label: "PRIORITY" },
  URGENT: { emoji: "⚠️", label: "URGENT" },
  CONFIDENTIAL: { emoji: "🔒", label: "CONFIDENTIAL" },
  MEETING: { emoji: "📅", label: "MEETING" },
  ZOOM: { emoji: "📹", label: "ZOOM" },
  NEWSLETTER: { emoji: "📰", label: "NEWSLETTER" },
  NORMAL: { emoji: "📬", label: "NORMAL" },
  PENDING: { emoji: "⏳", label: "PENDING" }
};

// --- CUSTOM ROUNDED CHECKBOX (theme-aware) ---
const RoundCheckbox = ({ checked, onChange, onClick }) => (
  <div
    onClick={onClick}
    onChange={onChange}
    style={{
      width: '13px', height: '13px', borderRadius: '4px', flexShrink: 0,
      border: checked ? '2px solid #3b82f6' : '2px solid rgba(148,163,184,0.4)',
      background: checked ? 'linear-gradient(135deg, #2563eb, #4f46e5)' : 'rgba(255,255,255,0.05)',
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

// --- INDETERMINATE ROUNDED CHECKBOX (select-all) ---
const RoundCheckboxIndeterminate = ({ checked, indeterminate, onChange }) => (
  <div
    onClick={onChange}
    style={{
      width: '13px', height: '13px', borderRadius: '4px', flexShrink: 0,
      border: (checked || indeterminate) ? '2px solid #3b82f6' : '2px solid rgba(148,163,184,0.4)',
      background: (checked || indeterminate) ? 'linear-gradient(135deg, #2563eb, #4f46e5)' : 'rgba(255,255,255,0.05)',
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

const DashboardView = ({
  emails, report, loading, mainView, setMainView, activeTab, setActiveTab,
  username, greetingInfo, theme, toggleTheme, toasts, removeToast,
  isProfileOpen, setIsProfileOpen,
  lastSyncTime, inboxReady, isSoftSyncing, autoSyncEnabled, setAutoSyncEnabled,
  selectedEmail, setSelectedEmail, fileModalData, setFileModalData,
  parsedThread, threadLoading, replyDraft, setReplyDraft, replyLoading, copySuccess,
  realThreads, filteredEmails, groupedEmails,
  fetchAndAnalyze, handleLogout, handleCopy, generateAiReply, openFiles,
  getAllAttachments, getSenderDetails, markAsRead,
  getParticipantDisplay, formatDate, getSafeDate, getEmailBody, getEmailAttachments,
  getEffectiveReceivedAt, markAsReplied, markAsReadById
}) => {
  const navigate = useNavigate();
  // --- DOWNLOAD STATE (per-file, parallel) ---
  const [downloadingFiles, setDownloadingFiles] = useState({});

  const getFileKey = (file, messageId) =>
    `${messageId || file.messageId || ""}__${file.name}`;

  const isFileDownloading = (file, messageId) =>
    !!(downloadingFiles[getFileKey(file, messageId)]);

  const getFileProgress = (file, messageId) =>
    downloadingFiles[getFileKey(file, messageId)]?.progress || 0;

  // --- COMPOSE MODAL STATE ---
  const [showCompose, setShowCompose] = useState(false);

  // --- PER-CARD INLINE REPLY STATE ---
  const [inlineReplyState, setInlineReplyState] = useState({});

  // --- CHECKBOX SELECTION STATE ---
  const [selectedCards, setSelectedCards] = useState(new Set());

  const toggleCardSelection = (emailId) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      next.has(emailId) ? next.delete(emailId) : next.add(emailId);
      return next;
    });
  };

  const selectAll = (emailList) => {
    setSelectedCards(new Set(emailList.map(e => e.id || e.messageId)));
  };

  const clearSelection = () => setSelectedCards(new Set());

  const getEmailReplyState = (emailId) => {
    return inlineReplyState[emailId] || {
      showReply: false,
      replyBody: "",
      replyTo: "",
      replyCc: "",
      drafting: false,
      attachments: []
    };
  };

  const setEmailReplyState = (emailId, updates) => {
    setInlineReplyState(prev => ({
      ...prev,
      [emailId]: { ...getEmailReplyState(emailId), ...updates }
    }));
  };

  // --- REPLY ATTACHMENT HANDLERS ---
  const handleReplyAttachmentSelect = (emailId, files) => {
    if (!files || !files.length) return;
    setEmailReplyState(emailId, {
      attachments: [...getEmailReplyState(emailId).attachments, ...Array.from(files)]
    });
  };

  const removeReplyAttachment = (emailId, index) => {
    const current = getEmailReplyState(emailId).attachments;
    setEmailReplyState(emailId, {
      attachments: current.filter((_, i) => i !== index)
    });
  };

  // --- HELPERS ---
  const getEmailSender = (email) => {
    if (!email) return "Unknown Sender";
    if (typeof email.from === "string") return email.from;
    if (Array.isArray(email.from) && email.from.length > 0) return email.from[0];
    return "Unknown Sender";
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return "";
    const mb = bytes / (1024 * 1024);
    if (mb < 0.1) return " (<0.1 MB)";
    return ` (${mb.toFixed(2)} MB)`;
  };

  // Render email body: HTML emails rendered as-is, plain text gets line breaks
  const renderEmailBody = (body) => {
    if (!body) return "";
    if (/<[a-zA-Z][^>]*>/i.test(body)) return body;
    return body.split("\n").join("<br/>");
  };

  // ─────────────────────────────────────────────────
  // 🆕 UPDATED: Download via org mail API (no disk)
  // ─────────────────────────────────────────────────
  const handleFileDownload = async (file, messageId) => {
    const key = getFileKey(file, messageId);
    const targetMessageId = messageId || file.messageId;

    if (!targetMessageId) { alert("Missing messageId for this file"); return; }
    if (downloadingFiles[key]) return; // already downloading this file

    // Mark this specific file as downloading
    setDownloadingFiles(prev => ({ ...prev, [key]: { progress: 0 } }));

    try {
      const response = await axios.post(
        `${API_BASE}/download-attachment`,
        { name: file.name, messageId: targetMessageId, userEmail: getActiveUserEmail() },
        {
          responseType: "blob",
          onDownloadProgress: (e) => {
            if (e.total) {
              const pct = Math.round((e.loaded * 100) / e.total);
              setDownloadingFiles(prev => ({ ...prev, [key]: { progress: pct } }));
            }
          }
        }
      );

      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);

    } catch (err) {
      console.error(err);
      alert(`Download failed: ${file.name}`);
    } finally {
      setTimeout(() => {
        setDownloadingFiles(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 800);
    }
  };

  // --- SEND INLINE REPLY (PER-CARD) ---
  const sendInlineReply = async (email) => {
    const emailId = email.id || email.messageId;
    const state = getEmailReplyState(emailId);

    markAsReplied(emailId, true);
    markAsReadById(emailId);
    setEmailReplyState(emailId, { drafting: true });

    try {
      const messageItemId = email.messageId || email.id;
      if (!messageItemId) throw new Error("Missing messageItemId");

      await replyToMail({
        messageItemId,
        replyBodyHtml: `<p>${state.replyBody.replace(/\n/g, "<br/>")}</p>`,
        to: Array.isArray(state.replyTo)
          ? state.replyTo
          : state.replyTo.split(",").map(e => e.trim()).filter(Boolean),
        cc: Array.isArray(state.replyCc)
          ? state.replyCc
          : state.replyCc.split(",").map(e => e.trim()).filter(Boolean),
        attachments: state.attachments
      });

      await markReadBackend(email);

      setEmailReplyState(emailId, {
        showReply: false, replyBody: "", replyTo: "", replyCc: "",
        drafting: false, attachments: []
      });

    } catch (err) {
      console.error("❌ Reply failed:", err);
      markAsReplied(emailId, false);
      markAsReadById(emailId, false);
      alert("Failed to send reply");
      setEmailReplyState(emailId, { drafting: false });
    }
  };

  // --- GENERATE AI REPLY (PER-CARD) ---
  const generateAiReplyForEmail = async (email) => {
    const emailId = email.id || email.messageId;
    setEmailReplyState(emailId, { drafting: true });

    try {
      const userName = localStorage.getItem("loggedInUser") || "User";
      const res = await fetch(`${API_BASE}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: email.from || email.sender,
          subject: email.subject,
          email_body: email.body || email.summary,
          user_name: userName
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
  };

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
{/* Per-file progress bars shown inline on each row */}

              {fileModalData.files.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px' }}>No files found.</div>
              ) : fileModalData.files.map((f, i) => (
                <div key={i} className="file-row">
                  <div className="file-icon">
                    {f.name && f.name.toLowerCase().endsWith('.pdf')
                      ? <FileText size={20} color="#ea580c" />
                      : <Paperclip size={20} color="#3b82f6" />}
                  </div>
                  <div className="file-info">
                    <div className="file-name">
                      {f.name || "Unnamed"}
                      <span style={{ fontSize: "0.85em", color: "var(--text-secondary)", fontWeight: "normal", marginLeft: "8px" }}>
                        {formatFileSize(f.size)}
                      </span>
                    </div>
                    <div className="file-sender">
                      From: {Array.isArray(f.senders) ? f.senders.join(", ") : "Unknown"}
                      <br />Type: {f.type || "Unknown"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleFileDownload(f, f.messageId); }}
                      disabled={isFileDownloading(f, f.messageId)}
                      style={{
                        backgroundColor: isFileDownloading(f, f.messageId) ? "#9ca3af" : "#2563eb",
                        cursor: isFileDownloading(f, f.messageId) ? "not-allowed" : "pointer",
                        color: "white", padding: "6px 12px", borderRadius: "6px", border: "none",
                        display: "flex", alignItems: "center", gap: "6px"
                      }}
                    >
                      {isFileDownloading(f, f.messageId)
                        ? <><Loader size={14} className="animate-spin" /> {getFileProgress(f, f.messageId)}%</>
                        : <><Download size={16} /> Download</>}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── EMAIL DETAIL MODAL ─── */}
      {selectedEmail && (
        <div className="modal-overlay" onClick={() => setSelectedEmail(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <button className="btn-close" onClick={() => setSelectedEmail(null)}><ArrowLeft size={18} /> Back</button>
              <div className="modal-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {(() => {
                  const cat = (selectedEmail.category || "NORMAL").toUpperCase();
                  const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL;
                  return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>;
                })()}
                {/* Mark as Read button inside modal */}
                <button
                  onClick={() => markAsRead(selectedEmail)}
                  disabled={selectedEmail.isRead}
                  style={{
                    background: selectedEmail.isRead ? '#16a34a' : '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '5px 12px',
                    fontSize: '0.78rem',
                    fontWeight: '700',
                    cursor: selectedEmail.isRead ? 'not-allowed' : 'pointer',
                    opacity: selectedEmail.isRead ? 0.65 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    whiteSpace: 'nowrap',
                    transition: 'background 0.2s ease'
                  }}
                >
                  {selectedEmail.isRead ? '✓ Read' : '✉ Mark Read'}
                </button>
              </div>
            </div>
            <div className="modal-body-scroll">
              <h2 className="modal-subject">{selectedEmail.subject}</h2>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr',
                gap: '10px', marginBottom: '16px'
              }}>
                {/* FROM */}
                <div style={{ background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#3b82f6', marginBottom: '4px' }}>🔵 FROM</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>{getEmailSender(selectedEmail)}</div>
                </div>
                {/* RECEIVED */}
                <div style={{ background: 'rgba(168,85,247,0.07)', border: '1px solid rgba(168,85,247,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#a855f7', marginBottom: '4px' }}>🟣 RECEIVED</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500' }}>{formatDate(getEffectiveReceivedAt(selectedEmail))}</div>
                </div>
                {/* TO */}
                <div style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#22c55e', marginBottom: '4px' }}>🟢 TO</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>
                    {Array.isArray(selectedEmail.to) ? selectedEmail.to.join(', ') : selectedEmail.to || '—'}
                  </div>
                </div>
                {/* CC */}
                <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: '800', letterSpacing: '1.2px', color: '#f59e0b', marginBottom: '4px' }}>🟡 CC</div>
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', fontWeight: '500', wordBreak: 'break-word' }}>
                    {Array.isArray(selectedEmail.cc) && selectedEmail.cc.length > 0 ? selectedEmail.cc.join(', ') : '—'}
                  </div>
                </div>
              </div>
              <div className="modal-summary-box"><strong>💡 AI Summary:</strong> {selectedEmail.summary}</div>

              {/* REPLY SECTION */}
              <div className="reply-section">
                <div className="reply-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <strong>Draft Reply</strong>
                    {replyDraft && (
                      <button onClick={handleCopy} className="btn-copy" title="Copy">
                        {copySuccess ? <Check size={14} color="#10b981" /> : <Copy size={14} />} {copySuccess ? "Copied!" : "Copy"}
                      </button>
                    )}
                  </div>
                  <button onClick={generateAiReply} disabled={replyLoading} className="btn-gradient small-btn">
                    {replyLoading ? 'Drafting...' : '✨ Auto-Draft'}
                  </button>
                </div>
                {(replyDraft || replyLoading) && (
                  <div className="reply-box">
                    {replyLoading
                      ? <div className="ai-thinking">Thinking...</div>
                      : <textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} className="reply-textarea" placeholder="AI will draft a reply here..." />}
                  </div>
                )}
              </div>
              <hr className="divider" />

              {/* THREAD / SINGLE EMAIL CONTENT */}
              {threadLoading ? (
                <div className="loading-text">Loading content...</div>
              ) : selectedEmail.messages && selectedEmail.messages.length > 1 ? (
                <div className="email-thread-container">
                  <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b' }}>
                    <Hash size={16} style={{ display: 'inline', marginRight: '5px' }} /> Conversation History ({selectedEmail.messages.length})
                  </div>
                  <div className="thread-conversation">
                    {parsedThread.map((msg, idx) => (
                      <div key={idx} className="message-item message-thread">
                        {msg.header && <div className="message-from">{msg.header}</div>}
                        <div className="message-body" dangerouslySetInnerHTML={{ __html: renderEmailBody(msg.content) }} />
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="ec-atts mt-2">
                            <Paperclip size={14} />
                            {msg.attachments.map((att, aidx) => (
                              <div key={aidx} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                <span style={{ flex: 1 }}>
                                  {att.name || "Unnamed file"}
                                  <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>{formatFileSize(att.size)}</span>
                                </span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleFileDownload(att, att.messageId); }}
                                  disabled={isFileDownloading(att, att.messageId)}
                                  style={{
                                    backgroundColor: isFileDownloading(att, att.messageId) ? "#9ca3af" : "#2563eb",
                                    cursor: isFileDownloading(att, att.messageId) ? "not-allowed" : "pointer",
                                    color: "white", padding: "6px 12px", borderRadius: "6px", border: "none",
                                    display: "flex", alignItems: "center", gap: "6px"
                                  }}
                                >
                                  {isFileDownloading(att, att.messageId) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(att, att.messageId)}%</> : <><Download size={16} /> Download</>}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="email-thread-container">
                  <div style={{ marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b' }}>
                    <Mail size={16} style={{ display: 'inline', marginRight: '5px' }} /> Email Content
                  </div>
                  <div className="thread-conversation">
                    <div className="message-item message-thread">
                      <div className="message-from">
                        From: {getParticipantDisplay(selectedEmail)} | {formatDate(getEffectiveReceivedAt(selectedEmail))}
                      </div>
                      <div className="message-body" dangerouslySetInnerHTML={{ __html: renderEmailBody(selectedEmail.body || "No content available") }} />
                      {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                        <div className="ec-atts mt-2">
                          <Paperclip size={14} />
                          {selectedEmail.attachments.map((att, aidx) => (
                            <div key={aidx} className="att-file" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style={{ flex: 1 }}>{att.name || "Unnamed file"}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleFileDownload(att, att.messageId); }}
                                disabled={isFileDownloading(att, att.messageId)}
                                style={{
                                  backgroundColor: isFileDownloading(att, att.messageId) ? "#9ca3af" : "#2563eb",
                                  cursor: isFileDownloading(att, att.messageId) ? "not-allowed" : "pointer",
                                  color: "white", padding: "6px 12px", borderRadius: "6px", border: "none",
                                  display: "flex", alignItems: "center", gap: "6px"
                                }}
                              >
                                {isFileDownloading(att, att.messageId) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(att, att.messageId)}%</> : <><Download size={16} /> Download</>}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
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
              <img
                src="https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp"
                alt="Horizon Family Medical Group"
                style={{
                  height: '36px',
                  width: 'auto',
                  objectFit: 'contain',
                  filter: 'brightness(1.05)',
                  display: 'block'
                }}
              />
            </div>

            <div className="view-switcher">
              <button className={`view-btn ${mainView === 'INSIGHTS' ? 'active' : ''}`} onClick={() => setMainView('INSIGHTS')}><PieChart size={18} /> Insights</button>
              <button className={`view-btn ${mainView === 'THREADS' ? 'active' : ''}`} onClick={() => setMainView('THREADS')}><Mail size={18} /> Inbox</button>
              <button className="view-btn" onClick={() => navigate('/calendar')} title="Open Calendar"><Calendar size={18} /> Calendar</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "20px" }}>
              <button className="menu-btn" onClick={fetchAndAnalyze} title="Refresh Inbox">
                <Zap size={20} color="#374151" />
              </button>

              <button
                className="menu-btn"
                onClick={() => setAutoSyncEnabled(prev => !prev)}
                title="Toggle Auto Sync"
                style={{
                  backgroundColor: autoSyncEnabled ? "#16a34a" : "#dc2626",
                  color: "white", fontSize: "0.75rem", padding: "4px 10px",
                  borderRadius: "6px", border: "none", cursor: "pointer",
                  fontWeight: "600", transition: "background-color 0.2s ease"
                }}
              >
                {autoSyncEnabled ? "🟢 Auto Sync ON" : "⛔ Auto Sync OFF"}
              </button>

              {lastSyncTime && (
                <span className="sync-time-label" style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                  Last synced: {new Date(lastSyncTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {isSoftSyncing && <span className="ai-working" style={{ marginLeft: "8px" }}>🤖 AI Updating…</span>}
                </span>
              )}
            </div>

            <button className="menu-btn" style={{ marginLeft: '15px', border: '1px solid var(--border-color)', background: 'var(--bg-card)' }} onClick={toggleTheme} title="Toggle Theme">
              {theme === 'dark' ? <Sun size={20} color="#fbbf24" /> : <Moon size={20} color="#64748b" />}
            </button>
          </div>

          <button
            onClick={() => setShowCompose(true)}
            style={{
              backgroundColor: "#2563eb", color: "white", border: "none",
              padding: "8px 16px", borderRadius: "6px", cursor: "pointer",
              fontWeight: "600", fontSize: "0.9rem", marginRight: "15px",
              display: "flex", alignItems: "center", gap: "5px"
            }}
            title="Compose new email"
          >
            ✉️ <span className="compose-btn-text">Compose</span>
          </button>

          <div className="user-profile" onClick={() => setIsProfileOpen(!isProfileOpen)}>
            <div className="user-info welcome-text" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginRight: '10px' }}>
              <span style={{ fontSize: '1.3rem', fontWeight: '700', letterSpacing: '-0.5px' }}>{greetingInfo.greeting}, {username}</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '500' }}>{greetingInfo.date}</span>
            </div>
            <div className="avatar">{username.charAt(0).toUpperCase()}</div>
            {isProfileOpen && (
              <div className="profile-dropdown">
                <button onClick={(e) => { e.stopPropagation(); handleLogout(); }} className="dropdown-item text-red">
                  <LogOut size={16} /> Sign Out
                </button>
              </div>
            )}
          </div>
        </header>

        {loading ? (
          <div className="ai-loading-container">
            <AILoadingScreen emailCount={emails?.length || 0} />
          </div>
        ) : (
          <>
            {/* ═══════════════════════════════════════ */}
            {/* INSIGHTS VIEW                          */}
            {/* ═══════════════════════════════════════ */}
            {mainView === 'INSIGHTS' && (
              <div className="dashboard-grid">
                <div className="col-left">
                  <TriageSummary
                    stats={report?.triage_stats}
                    realThreads={realThreads}
                    emails={emails}
                    onAttachmentClick={() => {
                      const allFiles = getAllAttachments();
                      setFileModalData({ title: `All Attachments (${allFiles.length})`, files: allFiles });
                    }}
                  />

                  <div className="section-title"><Hash size={20} /> 🧵 AI Thread Summaries</div>
                  {!report ? <div className="empty-placeholder">Run analysis first.</div> : (
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
                            {report.briefing_cards.map((card) => {
                              // Backend now injects card.subject (real email subject) and card.thread_count.
                              // Match by ID first, then by exact real subject — no more fuzzy topic matching.
                              const searchPool = groupedEmails || emails;

                              const threadEmail =
                                searchPool.find(
                                  e => String(e.id).trim() === String(card.id).trim() ||
                                       String(e.messageId).trim() === String(card.id).trim()
                                ) ||
                                (card.subject && searchPool.find(
                                  e => e.subject?.trim().toLowerCase() === card.subject.trim().toLowerCase()
                                ));

                              const isRead = threadEmail?.isRead ?? false;
                              // card.subject = real subject injected by backend; card.topic = GPT paraphrase (fallback only)
                              const displaySubject = card.subject || threadEmail?.subject || card.topic;
                              const msgCount = card.thread_count || threadEmail?.threadCount || threadEmail?.thread_count || threadEmail?.messages?.length || 0;
                              return (
                                <div
                                  key={card.id}
                                  className="briefing-card-row"
                                  onClick={() => threadEmail && setSelectedEmail(threadEmail)}
                                  style={{ cursor: "pointer", opacity: isRead ? 0.7 : 1 }}
                                  title="Click to view full conversation"
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                      {/* Unread dot */}
                                      {!isRead && (
                                        <span style={{
                                          width: '8px', height: '8px', borderRadius: '50%',
                                          background: '#3b82f6', flexShrink: 0, display: 'inline-block'
                                        }} title="Unread" />
                                      )}
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        {/* Real subject line */}
                                        <div className="briefing-topic" style={{
                                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                        }}>
                                          {displaySubject}
                                        </div>
                                        {/* Thread count badge — only when > 1 message */}
                                        {msgCount > 1 && (
                                          <span style={{
                                            display: 'inline-block',
                                            marginTop: '4px',
                                            background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
                                            color: 'white',
                                            fontSize: '0.62rem',
                                            fontWeight: '700',
                                            padding: '2px 8px',
                                            borderRadius: '999px',
                                            letterSpacing: '0.3px'
                                          }}>
                                            🧵 {msgCount} messages
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                      {/* Mark as Read — only show when unread */}
                                      {threadEmail && !isRead && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); markAsRead(threadEmail); }}
                                          title="Mark as read"
                                          style={{
                                            background: '#2563eb',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '5px',
                                            padding: '3px 9px',
                                            fontSize: '0.7rem',
                                            fontWeight: '700',
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            transition: 'background 0.2s ease'
                                          }}
                                        >
                                          ✉ Mark Read
                                        </button>
                                      )}
                                      <ArrowRight size={16} color="var(--accent-blue)" />
                                    </div>
                                  </div>
                                  <div className="briefing-status">{card.status}</div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="no-summary-text">{report.thread_summary || "No executive summary available."}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="col-right">
                  <div className="section-title"><BarChart3 size={20} /> 👥 Sender Insights</div>
                  {!report ? <div className="empty-placeholder">Run analysis to see stats.</div> : (
                    <div className="sender-list-grid">
                      {(report.sender_summaries || []).map((s, i) => {
                        const { mails, attachments } = getSenderDetails(s.name);
                        return (
                          <div key={i} className="sender-card-large">
                            <div className="sender-top">
                              <div className="avatar-small">{s.name.charAt(0).toUpperCase()}</div>
                              <div>
                                <strong>{s.name}</strong>
                                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                                  {mails.length} Emails • {attachments.length} Attachments
                                </div>
                              </div>
                            </div>
                            <div className="sender-desc">{s.summary || "No summary available"}</div>
                            {mails.length > 0 && (
                              <div style={{ marginTop: "10px" }}>
                                <strong style={{ fontSize: "0.9rem" }}>Emails Sent:</strong>
                                <ul style={{ fontSize: "0.8rem", paddingLeft: "18px", marginTop: "5px" }}>
                                  {mails.map((m, idx) => <li key={idx}>{m.subject || "No Subject"}</li>)}
                                </ul>
                              </div>
                            )}
                            {attachments.length > 0 && (
                              <div style={{ marginTop: "10px" }}>
                                <strong style={{ fontSize: "0.9rem" }}>Attachments:</strong>
                                <div className="ec-atts" style={{ marginTop: "5px" }}>
                                  {attachments.map((a, idx) => (
                                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                      <span style={{ flex: 1 }}>
                                        {a.name || "File"}
                                        <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>{formatFileSize(a.size)}</span>
                                      </span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleFileDownload(a, a.messageId); }}
                                        disabled={isFileDownloading(a, a.messageId)}
                                        style={{
                                          backgroundColor: isFileDownloading(a, a.messageId) ? "#9ca3af" : "#2563eb",
                                          cursor: isFileDownloading(a, a.messageId) ? "not-allowed" : "pointer",
                                          color: "white", padding: "6px 12px", borderRadius: "6px", border: "none",
                                          display: "flex", alignItems: "center", gap: "6px"
                                        }}
                                      >
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

            {/* ═══════════════════════════════════════ */}
            {/* INBOX VIEW                             */}
            {/* ═══════════════════════════════════════ */}
            {mainView === 'THREADS' && (
              <div className="feed-container">
                <div className="tabs-container">
                  {[
                    { name: 'ALL', emoji: '📬' },
                    { name: 'PRIORITY', emoji: '🔥' },
                    { name: 'URGENT', emoji: '⚠️' },
                    { name: 'CONFIDENTIAL', emoji: '🔒' },
                    { name: 'MEETING', emoji: '📅' },
                    { name: 'ZOOM', emoji: '📹' },
                    { name: 'NEWSLETTER', emoji: '📰' }
                  ].map(tab => {
                    const count = tab.name === "ALL"
                      ? emails.length
                      : emails.filter(e => e.category === tab.name).length;
                    return (
                      <button
                        key={tab.name}
                        className={`tab-btn ${activeTab === tab.name ? 'active' : ''} ${tab.name.toLowerCase()}`}
                        onClick={() => setActiveTab(tab.name)}
                      >
                        {tab.emoji} {tab.name}
                        <span className={`count-badge badge-${tab.name.toLowerCase()}`}>{count}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="email-feed">
                  {!inboxReady ? (
                    <div className="loading-text">Syncing inbox...</div>
                  ) : filteredEmails.length === 0 ? (
                    <div className="loading-text">No emails found</div>
                  ) : (
                    <>
                      {/* ── BULK ACTION BAR ── */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '8px 16px', marginBottom: '8px',
                        background: 'var(--bg-card)',
                        borderRadius: '10px',
                        border: '1px solid var(--border-color)'
                      }}>
                        {/* Spacer to align with card left-border stripe */}
                        <div style={{ width: '4px', flexShrink: 0 }} />
                        {/* Select All checkbox — aligned with card checkboxes */}
                        <RoundCheckboxIndeterminate
                          checked={selectedCards.size === filteredEmails.length && filteredEmails.length > 0}
                          indeterminate={selectedCards.size > 0 && selectedCards.size < filteredEmails.length}
                          onChange={() => selectedCards.size === filteredEmails.length ? clearSelection() : selectAll(filteredEmails)}
                        />
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: '600' }}>
                          {selectedCards.size > 0 ? `${selectedCards.size} selected` : 'Select all'}
                        </span>

                        {/* Bulk Mark as Read button — only visible when something is selected */}
                        {selectedCards.size > 0 && (
                          <>
                            <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />
                            <button
                              onClick={async () => {
                                const toMark = filteredEmails.filter(e =>
                                  selectedCards.has(e.id || e.messageId) && !e.isRead
                                );
                                await Promise.all(toMark.map(e => markAsRead(e)));
                                clearSelection();
                              }}
                              style={{
                                background: 'linear-gradient(135deg, #2563eb, #4f46e5)',
                                color: 'white', border: 'none', borderRadius: '7px',
                                padding: '6px 14px', fontSize: '0.82rem', fontWeight: '700',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                                boxShadow: '0 4px 12px rgba(37,99,235,0.3)'
                              }}
                            >
                              ✉ Mark {selectedCards.size} as Read
                            </button>
                            <button
                              onClick={clearSelection}
                              style={{
                                background: 'transparent', border: '1px solid var(--border-color)',
                                borderRadius: '7px', padding: '6px 12px', fontSize: '0.82rem',
                                fontWeight: '600', cursor: 'pointer', color: 'var(--text-secondary)'
                              }}
                            >
                              Clear
                            </button>
                          </>
                        )}
                      </div>

                      {/* ── EMAIL CARDS ── */}
                      {filteredEmails.map((email) => {
                        const atts = email.attachments || [];
                        const emailId = email.id || email.messageId;
                        const replyState = getEmailReplyState(emailId);
                        const isChecked = selectedCards.has(emailId);

                        return (
                          <div
                            key={emailId}
                            className={`email-card ${!email.isRead ? "unread-mail" : ""} ${(selectedEmail?.id === email.id || selectedEmail?.messageId === email.messageId) ? "active" : ""} border-${(email.category || 'normal').toLowerCase()}`}
                            style={{ display: 'flex', alignItems: 'stretch', padding: 0, overflow: 'hidden' }}
                            onClick={() => setSelectedEmail(email)}
                          >
                            {/* LEFT BORDER STRIPE */}
                            <div className="ec-left-border" style={{ flexShrink: 0 }}></div>

                            {/* CHECKBOX — vertically centered in its column */}
                            <div
                              style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: '0 10px', flexShrink: 0, alignSelf: 'center'
                              }}
                              onClick={e => { e.stopPropagation(); toggleCardSelection(emailId); }}
                            >
                              <RoundCheckbox
                                checked={isChecked}
                                onClick={e => { e.stopPropagation(); toggleCardSelection(emailId); }}
                              />
                            </div>

                          <div className="ec-content" style={{ flex: 1, minWidth: 0, padding: '14px 16px 14px 0' }}>
                            {/* TOP ROW */}
                            <div className="ec-top" style={{ display: "flex", justifyContent: "space-between" }}>
                              <h4 style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                {email.subject || "No Subject"}
                                {email.threadCount > 1 && (
                                  <span style={{
                                    background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                                    color: "white",
                                    fontSize: "0.65rem",
                                    fontWeight: "700",
                                    padding: "2px 8px",
                                    borderRadius: "999px",
                                    whiteSpace: "nowrap",
                                    letterSpacing: "0.3px"
                                  }}>
                                    🧵 {email.threadCount} messages
                                  </span>
                                )}
                              </h4>
                              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                <button
                                  onClick={(e) => { e.stopPropagation(); markAsRead(email); }}
                                  disabled={email.isRead}
                                  style={{
                                    background: email.isRead ? "#22c55e" : "#2563eb",
                                    color: "white", border: "none", borderRadius: "5px",
                                    padding: "3px 8px", fontSize: "0.7rem",
                                    cursor: email.isRead ? "not-allowed" : "pointer",
                                    fontWeight: "600", whiteSpace: "nowrap",
                                    opacity: email.isRead ? 0.6 : 1
                                  }}
                                >
                                  {email.isRead ? "✓ Read" : "Mark Read"}
                                </button>
                                <div className="ec-badges">
                                  {email.hasReplied && (
                                    <span style={{
                                      background: "#16a34a", color: "white", padding: "2px 8px",
                                      borderRadius: "999px", fontSize: "0.65rem", fontWeight: "700",
                                      marginLeft: "6px", whiteSpace: "nowrap"
                                    }}>
                                      ↩️ Replied
                                    </span>
                                  )}
                                  {(() => {
                                    const cat = (email.category || "PENDING").toUpperCase();
                                    const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL;
                                    return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>;
                                  })()}
                                </div>
                              </div>
                            </div>

                            {/* META */}
                            <div className="ec-meta">
                              <span title={getEmailSender(email)} style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <User size={14} /> {getEmailSender(email)}
                              </span>
                              <span><Clock size={14} /> {formatDate(getEffectiveReceivedAt(email))}</span>
                              {Array.isArray(email.cc) && email.cc.length > 0 && (
                                <span className="cc-badge" title={email.cc.join(", ")}><Users size={12} /> CC</span>
                              )}
                            </div>

                            {/* SUMMARY */}
                            <div className="ec-body">{email.summary || ""}</div>

                            {/* ATTACHMENTS */}
                            {atts.length > 0 && (
                              <div className="ec-atts">
                                <Paperclip size={14} />
                                {atts.map((a, k) => (
                                  <div key={k} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                    <span style={{ flex: 1 }}>
                                      {a.name || a.file_name || "File"}
                                      <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>{formatFileSize(a.size)}</span>
                                    </span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleFileDownload(a, a.messageId); }}
                                      disabled={isFileDownloading(a, a.messageId)}
                                      style={{
                                        backgroundColor: isFileDownloading(a, a.messageId) ? "#9ca3af" : "#2563eb",
                                        cursor: isFileDownloading(a, a.messageId) ? "not-allowed" : "pointer",
                                        color: "white", padding: "6px 12px", borderRadius: "6px", border: "none",
                                        display: "flex", alignItems: "center", gap: "6px"
                                      }}
                                    >
                                      {isFileDownloading(a, a.messageId) ? <><Loader size={14} className="animate-spin" /> {getFileProgress(a, a.messageId)}%</> : <><Download size={16} /> Download</>}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* ═══ PER-CARD INLINE REPLY ═══ */}
                            {replyState.showReply && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  marginTop: "16px", padding: "16px",
                                  borderTop: "1px solid var(--border-color)",
                                  background: "var(--bg-card)", borderRadius: "8px"
                                }}
                              >
                                {/* TO / CC FIELDS */}
                                <div style={{ marginBottom: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
                                  <div onClick={(e) => e.stopPropagation()}>
                                    <EmailAutocomplete
                                      label="To"
                                      value={replyState.replyTo}
                                      onChange={(newValue) => setEmailReplyState(emailId, { replyTo: newValue })}
                                      placeholder="Search contacts or enter email..."
                                    />
                                  </div>
                                  <div onClick={(e) => e.stopPropagation()}>
                                    <EmailAutocomplete
                                      label="CC"
                                      value={replyState.replyCc}
                                      onChange={(newValue) => setEmailReplyState(emailId, { replyCc: newValue })}
                                      placeholder="Optional - Search contacts or enter email..."
                                    />
                                  </div>
                                </div>

                                {/* REPLY BODY */}
                                <textarea
                                  placeholder="Type your reply..."
                                  value={replyState.replyBody}
                                  onClick={(e) => e.stopPropagation()}
                                  onFocus={(e) => e.stopPropagation()}
                                  onChange={(e) => setEmailReplyState(emailId, { replyBody: e.target.value })}
                                  style={{
                                    width: "100%", minHeight: "90px", padding: "10px", borderRadius: "6px",
                                    border: "1px solid var(--border-color)",
                                    background: "var(--bg-main)", color: "var(--text-primary)", resize: "vertical"
                                  }}
                                />

                                {/* ATTACH FILES */}
                                <div style={{ marginTop: "10px", marginBottom: "10px" }}>
                                  <input type="file" multiple id={`reply-attach-${emailId}`} style={{ display: "none" }}
                                    onChange={(e) => handleReplyAttachmentSelect(emailId, e.target.files)} />
                                  <label
                                    htmlFor={`reply-attach-${emailId}`}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      background: "#f3f4f6", border: "1px solid var(--border-color)",
                                      padding: "6px 12px", borderRadius: "6px", cursor: "pointer",
                                      fontSize: "0.8rem", fontWeight: "600", color: "#374151",
                                      display: "inline-flex", alignItems: "center", gap: "5px"
                                    }}
                                  >
                                    <Paperclip size={14} /> Attach Files
                                  </label>
                                </div>

                                {/* ATTACHMENT LIST */}
                                {replyState.attachments.length > 0 && (
                                  <div style={{ marginBottom: "10px", padding: "8px", background: "var(--bg-main)", borderRadius: "6px" }}>
                                    {replyState.attachments.map((f, idx) => (
                                      <div key={idx} style={{
                                        display: "flex", justifyContent: "space-between", alignItems: "center",
                                        fontSize: "0.8rem", padding: "4px 0",
                                        borderBottom: idx < replyState.attachments.length - 1 ? "1px solid var(--border-color)" : "none"
                                      }}>
                                        <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                          <Paperclip size={12} color="#6b7280" /> {f.name}
                                        </span>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); removeReplyAttachment(emailId, idx); }}
                                          style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px 6px" }}
                                          title="Remove attachment"
                                        >
                                          <X size={14} />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* AI DRAFT BUTTON */}
                                <div style={{ marginBottom: "12px" }}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); generateAiReplyForEmail(email); }}
                                    disabled={replyState.drafting}
                                    style={{
                                      background: replyState.drafting ? "#9ca3af" : "#2563eb",
                                      color: "white", border: "none", borderRadius: "6px",
                                      padding: "6px 14px", fontSize: "0.85rem",
                                      cursor: replyState.drafting ? "not-allowed" : "pointer",
                                      fontWeight: "600", display: "flex", alignItems: "center", gap: "6px"
                                    }}
                                  >
                                    {replyState.drafting
                                      ? <><Loader size={14} className="animate-spin" /> Drafting...</>
                                      : <>✨ Auto-Draft</>}
                                  </button>
                                </div>

                                {/* ORIGINAL MESSAGE */}
                                <div style={{ marginTop: "12px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                                  <hr />
                                  <div dangerouslySetInnerHTML={{ __html: getEmailBody(email) }} />
                                </div>

                                {/* ACTIONS */}
                                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "10px" }}>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEmailReplyState(emailId, {
                                        showReply: false, replyBody: "", replyTo: "", replyCc: "",
                                        drafting: false, attachments: []
                                      });
                                    }}
                                    style={{
                                      background: "transparent", border: "1px solid var(--border-color)",
                                      padding: "6px 12px", borderRadius: "6px", cursor: "pointer"
                                    }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); sendInlineReply(email); }}
                                    disabled={replyState.drafting || !replyState.replyBody.trim()}
                                    style={{
                                      background: "#16a34a", color: "white", border: "none",
                                      padding: "6px 14px", borderRadius: "6px", fontWeight: "600",
                                      cursor: replyState.drafting || !replyState.replyBody.trim() ? "not-allowed" : "pointer"
                                    }}
                                  >
                                    {replyState.drafting ? "Sending..." : "Send"}
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* REPLY BUTTON */}
                            {!replyState.showReply && (
                              <div style={{ marginTop: "12px" }}>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const toEmail = extractEmail(email.from || email.sender || "");
                                    const ccEmails = Array.isArray(email.cc) ? email.cc.map(extractEmail).join(", ") : "";
                                    setEmailReplyState(emailId, {
                                      showReply: true, replyBody: "", replyTo: toEmail,
                                      replyCc: ccEmails, attachments: []
                                    });
                                  }}
                                  style={{
                                    background: "#2563eb", color: "white", border: "none",
                                    borderRadius: "6px", padding: "6px 14px", fontSize: "0.8rem",
                                    cursor: "pointer", fontWeight: "600"
                                  }}
                                >
                                  ↩️ Reply
                                </button>
                              </div>
                            )}
                          </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
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