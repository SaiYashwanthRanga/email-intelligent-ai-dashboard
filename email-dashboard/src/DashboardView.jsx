import React, { useState } from 'react'; 
import axios from 'axios';
import {
  LayoutDashboard, User, Paperclip, BarChart3, X, PieChart, Mail, Clock, ArrowLeft,
  FileText, Download, Users, LogOut, Hash, Copy, Check, Sun, Moon, Bot, ArrowRight, Zap, Loader
} from 'lucide-react';
import TriageSummary from './TriageSummary';
import ToastContainer from './Toast';

// --- CATEGORY META CONFIGURATION ---
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

const DashboardView = ({
  // State
  emails,
  report,
  loading,
  mainView,
  setMainView,
  activeTab,
  setActiveTab,
  username,
  greetingInfo,
  theme,
  toggleTheme,
  toasts,
  removeToast,
  isProfileOpen,
  setIsProfileOpen,
  
  // --- NEW PROPS ---
  lastSyncTime,
  inboxReady,
  isSoftSyncing,
  autoSyncEnabled,
  setAutoSyncEnabled,
    
  // Selection & Modals
  selectedEmail,
  setSelectedEmail,
  fileModalData,
  setFileModalData,
    
  // Thread & Reply
  parsedThread,
  threadLoading,
  replyDraft,
  setReplyDraft,
  replyLoading,
  copySuccess,
    
  // Computed Data
  realThreads,
  filteredEmails,
    
  // Functions / Handlers
  fetchAndAnalyze,
  handleLogout,
  handleCopy,
  generateAiReply,
  openFiles,
  getAllAttachments,
  getSenderDetails,
  markAsRead, // <--- ✅ ACCEPTED PROP

  // Helpers
  getParticipantDisplay,
  formatDate,
  getSafeDate,
  getEmailBody,
  getEmailAttachments
}) => {
  // --- 1. NEW STATE FOR DOWNLOADING ---
  const [isDownloading, setIsDownloading] = useState(false);
  // --- ADDED: Progress States ---
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [currentFileName, setCurrentFileName] = useState("");

  // --- HELPER: FORMAT FILE SIZE ---
  const formatFileSize = (bytes) => {
    if (!bytes) return "";
    const mb = bytes / (1024 * 1024);
    if (mb < 0.1) return " (<0.1 MB)";
    return ` (${mb.toFixed(2)} MB)`;
  };

  // --- UPDATED DOWNLOAD FUNCTION (AXIOS + PROGRESS) ---
  const handleFileDownload = async (file, messageId) => {
    // STEP 2: Debug log added
    console.log("📤 Frontend download request:", {
      fileName: file.name,
      messageIdSent: messageId,
      attachmentMessageId: file.messageId
    });

    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setCurrentFileName(file.name);
  
      const targetMessageId = messageId || file.messageId;
      if (!targetMessageId) {
        alert("Missing messageId for this file");
        return;
      }
  
      const response = await axios.post(
        `${process.env.REACT_APP_API_URL || 'http://localhost:8000/api'}/download-attachment`,
        {
          name: file.name,
          messageId: targetMessageId
        },
        {
          responseType: "blob",
          onDownloadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percent = Math.round(
                (progressEvent.loaded * 100) / progressEvent.total
              );
              setDownloadProgress(percent);
            }
          }
        }
      );
  
      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
  
    } catch (error) {
      console.error(error);
      alert("Download failed");
    } finally {
      setTimeout(() => {
        setIsDownloading(false);
        setDownloadProgress(0);
        setCurrentFileName("");
      }, 800); // small delay so 100% is visible
    }
  };

  return (
    <div className="app-container">
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {fileModalData && (
        <div className="modal-overlay" onClick={() => setFileModalData(null)}>
          <div className="modal-content file-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3><Paperclip size={18} /> {fileModalData.title}</h3>
              <button className="btn-close" onClick={() => setFileModalData(null)}><X size={20} /></button>
            </div>
            
            <div className="file-list-container">
              {/* --- ADDED: Progress UI inside Modal --- */}
              {isDownloading && (
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ fontSize: "0.85rem", marginBottom: "4px" }}>
                    Downloading: <strong>{currentFileName}</strong>
                  </div>

                  <div
                    style={{
                      width: "100%",
                      height: "8px",
                      background: "#e5e7eb",
                      borderRadius: "5px",
                      overflow: "hidden"
                    }}
                  >
                    <div
                      style={{
                        width: `${downloadProgress}%`,
                        height: "100%",
                        background: "#2563eb",
                        transition: "width 0.2s ease"
                      }}
                    />
                  </div>

                  <div
                    style={{
                      fontSize: "0.8rem",
                      marginTop: "4px",
                      textAlign: "right",
                      fontWeight: "600"
                    }}
                  >
                    {downloadProgress}%
                  </div>
                </div>
              )}

              {fileModalData.files.length === 0 ? <div style={{ textAlign: 'center', padding: '40px' }}>No files found.</div> : fileModalData.files.map((f, i) => (
                <div key={i} className="file-row">
                  <div className="file-icon">
                    {f.name && f.name.toLowerCase().endsWith('.pdf') ? (
                      <FileText size={20} color="#ea580c" />
                    ) : (
                      <Paperclip size={20} color="#3b82f6" />
                    )}
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
                      <br />
                      Type: {f.type || "Unknown"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    
                    {/* --- CHANGED: Download Button (Modal) --- */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // STEP 1: Correct ID usage
                        handleFileDownload(f, f.messageId);
                      }}
                      disabled={isDownloading}
                      style={{
                        backgroundColor: isDownloading ? "#9ca3af" : "#2563eb",
                        cursor: isDownloading ? "not-allowed" : "pointer",
                        color: "white",
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "none",
                        display: "flex", alignItems: "center", gap: "6px"
                      }}
                    >
                      {isDownloading ? (
                        <>
                          <Loader size={14} className="animate-spin" /> {downloadProgress}%
                        </>
                      ) : (
                        <>
                          <Download size={16} /> Download
                        </>
                      )}
                    </button>

                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedEmail && (
        <div className="modal-overlay" onClick={() => setSelectedEmail(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <button className="btn-close" onClick={() => setSelectedEmail(null)}><ArrowLeft size={18} /> Back</button>
              <div className="modal-actions">
                {(() => {
                  const cat = (selectedEmail.category || "NORMAL").toUpperCase();
                  const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL;
                  return (
                    <span className={`cat-tag ${cat.toLowerCase()}`}>
                      {meta.emoji} {meta.label}
                    </span>
                  );
                })()}
              </div>
            </div>
            <div className="modal-body-scroll">
              <h2 className="modal-subject">{selectedEmail.subject}</h2>
              <div className="modal-meta-grid">
                <div className="meta-item"><User size={16} /> <strong>From:</strong> {getParticipantDisplay(selectedEmail)}</div>
                <div className="meta-item"><Clock size={16} /> <strong>Received:</strong> {formatDate(getSafeDate(selectedEmail))}</div>
                {(selectedEmail.cc || selectedEmail.CC) && <div className="meta-item" style={{ gridColumn: '1 / -1' }}><Users size={16} /> <strong>CC:</strong> {selectedEmail.cc || selectedEmail.CC}</div>}
              </div>
              <div className="modal-summary-box"><strong>💡 AI Summary:</strong> {selectedEmail.summary}</div>
              
              <div className="reply-section">
                <div className="reply-header">
                  <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}><strong>Draft Reply</strong>{replyDraft && (<button onClick={handleCopy} className="btn-copy" title="Copy">{copySuccess ? <Check size={14} color="#10b981"/> : <Copy size={14}/>} {copySuccess ? "Copied!" : "Copy"}</button>)}</div>
                  <button onClick={generateAiReply} disabled={replyLoading} className="btn-gradient small-btn">{replyLoading ? 'Drafting...' : '✨ Auto-Draft'}</button>
                </div>
                {(replyDraft || replyLoading) && (<div className="reply-box">{replyLoading ? (<div className="ai-thinking">Thinking...</div>) : (<textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} className="reply-textarea" placeholder="AI will draft a reply here..." />)}</div>)}
              </div>
              <hr className="divider" />
              {threadLoading ? (
                <div className="loading-text">Loading content...</div>
              ) : selectedEmail.messages && selectedEmail.messages.length > 1 ? (
                /* 🧵 THREAD EMAIL */
                <div className="email-thread-container">
                  <div style={{marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b'}}>
                    <Hash size={16} style={{display:'inline', marginRight:'5px'}}/> Conversation History ({selectedEmail.messages.length})
                  </div>
                  <div className="thread-conversation">
                    {parsedThread.map((msg, idx) => (
                      <div key={idx} className="message-item message-thread">
                        {msg.header && <div className="message-from">{msg.header}</div>}
                        <div className="message-body">
                          {msg.content.split('\n').map((l, i) => (
                            <p key={i}>{l}</p>
                          ))}
                        </div>
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="ec-atts mt-2">
                            <Paperclip size={14} />
                            {msg.attachments.map((att, aidx) => (
                              <div key={aidx} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                <span style={{ flex: 1 }}>
                                  {att.name || "Unnamed file"}
                                  <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>
                                    {formatFileSize(att.size)}
                                  </span>
                                </span>
                                
                                {/* --- Download Button (Thread View) --- */}
                                <button
                                  onClick={(e) => { 
                                    e.stopPropagation();
                                    handleFileDownload(att, att.messageId); 
                                  }} 
                                  disabled={isDownloading}
                                  style={{
                                    backgroundColor: isDownloading ? "#9ca3af" : "#2563eb",
                                    cursor: isDownloading ? "not-allowed" : "pointer",
                                    color: "white",
                                    padding: "6px 12px",
                                    borderRadius: "6px",
                                    border: "none",
                                    display: "flex", alignItems: "center", gap: "6px"
                                  }}
                                >
                                  {isDownloading ? (
                                    <>
                                      <Loader size={14} className="animate-spin" /> {downloadProgress}%
                                    </>
                                  ) : (
                                    <>
                                      <Download size={16} /> Download
                                    </>
                                  )}
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
                /* 📩 SINGLE EMAIL – Styled like Thread */
                <div className="email-thread-container">
                    <div style={{marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b'}}>
                    <Mail size={16} style={{display:'inline', marginRight:'5px'}} />
                    Email Content
                    </div>

                    <div className="thread-conversation">
                    <div className="message-item message-thread">
                        <div className="message-from">
                        From: {getParticipantDisplay(selectedEmail)} | {formatDate(getSafeDate(selectedEmail))}
                        </div>

                        <div className="message-body">
                        {(selectedEmail.body || "No content available")
                            .split('\n')
                            .map((line, i) => (
                            <p key={i}>{line}</p>
                            ))}
                        </div>

                        {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                        <div className="ec-atts mt-2">
                            <Paperclip size={14} />
                            {selectedEmail.attachments.map((att, aidx) => (
                            <div key={aidx} className="att-file" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{ flex: 1 }}>
                                {att.name || "Unnamed file"}
                                </span>

                                <button
                                onClick={(e) => { 
                                    e.stopPropagation();
                                    handleFileDownload(att, att.messageId);
                                }}
                                disabled={isDownloading}
                                style={{
                                    backgroundColor: isDownloading ? "#9ca3af" : "#2563eb",
                                    cursor: isDownloading ? "not-allowed" : "pointer",
                                    color: "white",
                                    padding: "6px 12px",
                                    borderRadius: "6px",
                                    border: "none",
                                    display: "flex", alignItems: "center", gap: "6px"
                                }}
                                >
                                {isDownloading ? (
                                    <>
                                    <Loader size={14} className="animate-spin" /> {downloadProgress}%
                                    </>
                                ) : (
                                    <>
                                    <Download size={16} /> Download
                                    </>
                                )}
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

      <main className="main-content">
        <header className="top-bar">
          <div className="top-left">
            <div className="brand" style={{marginRight: '20px'}}>
              <div className="logo-box"><LayoutDashboard size={20} color="white" /></div>
              <div className="brand-info"><h2>Email Intelligent</h2><span className="brand-tag">AI HUB</span></div>
            </div>

            <div className="view-switcher">
              <button className={`view-btn ${mainView === 'INSIGHTS' ? 'active' : ''}`} onClick={() => setMainView('INSIGHTS')}><PieChart size={18} /> Insights</button>
              <button className={`view-btn ${mainView === 'THREADS' ? 'active' : ''}`} onClick={() => setMainView('THREADS')}><Mail size={18} /> Inbox</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "20px" }}>
              <button className="menu-btn" onClick={fetchAndAnalyze} title="Refresh Inbox">
                <Zap size={20} color="#374151" />
              </button>

              {/* ✅ AUTO SYNC TOGGLE BUTTON */}
              <button
                className="menu-btn"
                onClick={() => setAutoSyncEnabled(prev => !prev)}
                title="Toggle Auto Sync"
                style={{
                  backgroundColor: autoSyncEnabled ? "#16a34a" : "#dc2626",
                  color: "white",
                  fontSize: "0.75rem",
                  padding: "4px 10px",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: "600",
                  transition: "background-color 0.2s ease"
                }}
              >
                {autoSyncEnabled ? "🟢 Auto Sync ON" : "⛔ Auto Sync OFF"}
              </button>

              {lastSyncTime && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)"
                  }}
                >
                  Last synced:{" "}
                  {new Date(lastSyncTime).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                  
                  {/* --- CHANGED: Soft AI Indicator --- */}
                  {isSoftSyncing && (
                    <span className="ai-working" style={{ marginLeft: "8px" }}>🤖 AI Updating…</span>
                  )}
                </span>
              )}
            </div>

            <button className="menu-btn" style={{marginLeft: '15px', border: '1px solid var(--border-color)', background: 'var(--bg-card)'}} onClick={toggleTheme} title="Toggle Theme">
              {theme === 'dark' ? <Sun size={20} color="#fbbf24" /> : <Moon size={20} color="#64748b" />}
            </button>
          </div>
          
          <div className="user-profile" onClick={() => setIsProfileOpen(!isProfileOpen)}>
            <div className="user-info" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginRight: '10px' }}>
              <span className="welcome-text" style={{ fontSize: '1.3rem', fontWeight: '700', letterSpacing: '-0.5px' }}>{greetingInfo.greeting}, {username}</span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: '500' }}>{greetingInfo.date}</span>
            </div>
            {/* ✅ AVATAR CHANGE: Only 1st letter of username */}
            <div className="avatar">{username.charAt(0).toUpperCase()}</div>
            {isProfileOpen && (
              <div className="profile-dropdown">
                <button 
                  onClick={(e) => {
                    e.stopPropagation(); // ✅ Stops event bubbling
                    handleLogout();
                  }} 
                  className="dropdown-item text-red"
                >
                  <LogOut size={16} /> Sign Out
                </button>
              </div>
            )}
          </div>
        </header>

        {loading ? (
          <div className="ai-loading-container">
            <div className="ai-loading-content">
              <Bot size={80} className="loading-spinner" color="#00f3ff" />
              <h2 className="loading-title">AI is getting your inbox ready...</h2>
              <p className="loading-subtitle">Analyzing conversations, detecting priority, and drafting briefs.</p>
            </div>
          </div>
        ) : (
          <>
            {mainView === 'INSIGHTS' && (
              <div className="dashboard-grid">
                <div className="col-left">
                  <TriageSummary 
                    stats={report?.triage_stats} 
                    realThreads={realThreads} 
                    emails={emails} 
                    onAttachmentClick={() => {
                      const allFiles = getAllAttachments();
                      setFileModalData({
                        title: `All Attachments (${allFiles.length})`,
                        files: allFiles
                      });
                    }}
                  />

                  <div className="section-title"><Hash size={20} /> 🧵 AI Thread Summaries</div>
                  {!report ? <div className="empty-placeholder">Run analysis first.</div> : (
                    <div className="thread-summary-large">
                      <div className="ts-hero"><h1>Executive Summary</h1>{report.all_thread_files && report.all_thread_files.length > 0 && <button className="btn-glass mt-2" onClick={() => openFiles("All Project Files", report.all_thread_files)}><Paperclip size={16} /> View All {report.all_thread_files.length} Files</button>}</div>
                      <div className="ts-content">
                        {(report.briefing_cards || []).length > 0 ? (
                          <div style={{display: 'flex', flexDirection: 'column', gap: '15px'}}>
                            {report.briefing_cards.map((card) => {
                                const threadEmail = emails.find(
                                  e =>
                                    String(e.id).trim() === String(card.id).trim() ||
                                    String(e.messageId).trim() === String(card.id).trim()
                                );

                                if (!threadEmail) {
                                  console.warn("No matching email for briefing card:", card);
                                }

                                return (
                                  <div 
                                    key={card.id}
                                    className="briefing-card-row"
                                    onClick={() => threadEmail && setSelectedEmail(threadEmail)}
                                    style={{ cursor: "pointer" }}
                                    title="Click to view full conversation"
                                  >
                                    <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                                      <div className="briefing-topic">{card.topic}</div>
                                      <ArrowRight size={16} color="var(--accent-blue)" />
                                    </div>
                                    <div className="briefing-status">{card.status}</div>
                                  </div>
                                );
                            })}
                          </div>
                        ) : (<p className="no-summary-text">{report.thread_summary || "No executive summary available."}</p>)}
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
                              <div className="avatar-small">
                                {s.name.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <strong>{s.name}</strong>
                                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                                  {mails.length} Emails • {attachments.length} Attachments
                                </div>
                              </div>
                            </div>
                            <div className="sender-desc">
                              {s.summary || "No summary available"}
                            </div>
                            {mails.length > 0 && (
                              <div style={{ marginTop: "10px" }}>
                                <strong style={{ fontSize: "0.9rem" }}>Emails Sent:</strong>
                                <ul style={{ fontSize: "0.8rem", paddingLeft: "18px", marginTop: "5px" }}>
                                  {mails.map((m, idx) => (
                                    <li key={idx}>{m.subject || "No Subject"}</li>
                                  ))}
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
                                        <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>
                                          {formatFileSize(a.size)}
                                        </span>
                                      </span>
                                      
                                      {/* --- CHANGED: Download Button (Sender Insights) --- */}
                                      <button 
                                        onClick={(e) => { 
                                          e.stopPropagation(); 
                                          // STEP 4: Use a.messageId directly
                                          handleFileDownload(a, a.messageId); 
                                        }} 
                                        disabled={isDownloading}
                                        style={{
                                          backgroundColor: isDownloading ? "#9ca3af" : "#2563eb",
                                          cursor: isDownloading ? "not-allowed" : "pointer",
                                          color: "white",
                                          padding: "6px 12px",
                                          borderRadius: "6px",
                                          border: "none",
                                          display: "flex", alignItems: "center", gap: "6px"
                                        }}
                                      >
                                        {isDownloading ? (
                                          <>
                                              <Loader size={14} className="animate-spin" /> {downloadProgress}%
                                          </>
                                        ) : (
                                          <>
                                            <Download size={16} /> Download
                                          </>
                                        )}
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
                  ].map(tab => (
                    <button key={tab.name} className={`tab-btn ${activeTab === tab.name ? 'active' : ''} ${tab.name.toLowerCase()}`} onClick={() => setActiveTab(tab.name)}>
                      {tab.emoji} {tab.name} <span className={`count-badge badge-${tab.name.toLowerCase()}`}>{emails.filter(e => (e.category || 'NORMAL').toUpperCase() === tab.name || tab.name === 'ALL').length}</span>
                    </button>
                  ))}
                </div>
                <div className="email-feed">
                  {!inboxReady ? (
                    <div className="loading-text">Syncing inbox...</div>
                  ) : filteredEmails.length === 0 ? (
                    <div className="loading-text">No emails found</div>
                  ) : (
                    filteredEmails.map((email) => {
                      const atts = email.attachments || [];
                      return (
                        <div
                          key={email.id || email.messageId}
                          // --- CHANGED: Highlight Unread & Active Email ---
                          className={`
                            email-card
                            ${!email.isRead ? "unread-mail" : ""}
                            ${(selectedEmail?.id === email.id || selectedEmail?.messageId === email.messageId) ? "active" : ""}
                            border-${(email.category || 'normal').toLowerCase()}
                          `}
                          onClick={() => setSelectedEmail(email)}
                        >
                          <div className="ec-left-border"></div>
                          <div className="ec-content">
                            <div className="ec-top" style={{ display: "flex", justifyContent: "space-between" }}>
                              <h4>{email.subject || "No Subject"}</h4>

                              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                {/* ✅ MARK AS READ BUTTON */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();   // Do not open email
                                    markAsRead(email);     // Call your organization API
                                  }}
                                  style={{
                                    background: email.isRead ? "#22c55e" : "#2563eb",
                                    color: "white",
                                    border: "none",
                                    borderRadius: "5px",
                                    padding: "3px 8px",
                                    fontSize: "0.7rem",
                                    cursor: "pointer",
                                    fontWeight: "600",
                                    whiteSpace: "nowrap"
                                  }}
                                >
                                  {email.isRead ? "✓ Read" : "Mark Read"}
                                </button>

                                <div className="ec-badges">
                                  {(() => {
                                    const cat = (email.category || "PENDING").toUpperCase();
                                    const meta = CATEGORY_META[cat] || CATEGORY_META.NORMAL;
                                    return <span className={`cat-tag ${cat.toLowerCase()}`}>{meta.emoji} {meta.label}</span>;
                                  })()}
                                </div>
                              </div>
                            </div>
                            <div className="ec-meta">
                              <span title={getParticipantDisplay(email)} style={{maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                <User size={14} /> {getParticipantDisplay(email)}
                              </span>
                              <span><Clock size={14} /> {formatDate(getSafeDate(email))}</span>
                              {(email.cc || email.CC) && <span className="cc-badge"><Users size={12} /> CC</span>}
                            </div>
                            <div className="ec-body">{email.summary || "Pending analysis..."}</div>
                            {atts.length > 0 && (
                              <div className="ec-atts">
                                <Paperclip size={14} />
                                {atts.map((a, k) => (
                                  <div key={k} style={{ display: "flex", alignItems: "center", gap: "6px" }} className="att-file">
                                    <span style={{ flex: 1 }}>
                                      {a.name || a.file_name || "File"}
                                      <span style={{ fontSize: "0.85em", color: "#6b7280", marginLeft: "6px" }}>
                                        {formatFileSize(a.size)}
                                      </span>
                                    </span>
                                    
                                    {/* --- CHANGED: Download Button (Feed View) --- */}
                                    <button
                                      onClick={(e) => { 
                                        e.stopPropagation();
                                        // STEP 4: Use a.messageId directly
                                        handleFileDownload(a, a.messageId); 
                                      }} 
                                      disabled={isDownloading}
                                      style={{
                                        backgroundColor: isDownloading ? "#9ca3af" : "#2563eb",
                                        cursor: isDownloading ? "not-allowed" : "pointer",
                                        color: "white",
                                        padding: "6px 12px",
                                        borderRadius: "6px",
                                        border: "none",
                                        display: "flex", alignItems: "center", gap: "6px"
                                      }}
                                    >
                                      {isDownloading ? (
                                        <>
                                          <Loader size={14} className="animate-spin" /> {downloadProgress}%
                                        </>
                                      ) : (
                                        <>
                                          <Download size={16} /> Download
                                        </>
                                      )}
                                    </button>

                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default DashboardView;