import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  LayoutDashboard, User, Paperclip, BarChart3, X, PieChart, Mail, Clock, ArrowLeft,
  FileText, Download, Users, LogOut, Hash, Copy, Check, Sun, Moon, Bot, ArrowRight, Zap
} from 'lucide-react';
import './App.css';
import TriageSummary from './TriageSummary';
import ToastContainer from './Toast';

const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

function Dashboard() {
  const navigate = useNavigate();
  
  // --- STATE ---
  const [emails, setEmails] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ALL');
  const [mainView, setMainView] = useState('INSIGHTS');
  const [username, setUsername] = useState("User"); 
  
  // Kept API URL in state
  const [apiUrl, setApiUrl] = useState("http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count20");
  
  const [toasts, setToasts] = useState([]);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [parsedThread, setParsedThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selectedBriefing, setSelectedBriefing] = useState(null); 
  const [replyDraft, setReplyDraft] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [fileModalData, setFileModalData] = useState(null);

  // Separate real threads and single emails
  const realThreads = (emails || []).filter(e => 
    Array.isArray(e.messages) && e.messages.length > 1
  );
  const singleEmails = (emails || []).filter(e => 
    !Array.isArray(e.messages) || e.messages.length === 1
  );

  // --- GREETING & DATE ---
  const [greetingInfo, setGreetingInfo] = useState({ greeting: 'Hello', date: '' });

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hour = now.getHours();
      let greet = 'Good Evening';
      if (hour < 12) greet = 'Good Morning';
      else if (hour < 18) greet = 'Good Afternoon';

      const dateStr = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'short', 
        day: 'numeric' 
      }); 

      setGreetingInfo({ greeting: greet, date: dateStr });
    };

    updateTime();
    const interval = setInterval(updateTime, 60000); 
    return () => clearInterval(interval);
  }, []);

  // --- HELPERS ---
  const addToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const getSafeDate = (emailObj) => {
    if (!emailObj) return "Unknown Date";
    const candidates = [emailObj.received, emailObj.received_at, emailObj.date, emailObj.createdDateTime, emailObj.receivedDateTime, emailObj.internalDate];
    for (const d of candidates) { if (d && d !== "Unknown Date") return d; }
    return "Unknown Date";
  };

  const formatDate = (dateString) => {
    if (!dateString || dateString === "Unknown Date") return "Unknown Date";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString; 
      return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return dateString; }
  };

  const getParticipantDisplay = (email) => {
    if (email.participants && Array.isArray(email.participants) && email.participants.length > 0) {
      return email.participants.join(', ');
    }
    return email.from || email.sender || "Unknown Sender";
  };

  // --- PERSISTENCE & AUTH ---
  useEffect(() => {
    const auth = localStorage.getItem("jimAuthSession");
    if (auth !== "true") { navigate("/login"); }

    const cached = localStorage.getItem("emailDashboardData");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.emails && parsed.emails.length > 0) setEmails(parsed.emails);
        if (parsed.report) setReport(parsed.report);
      } catch (e) { console.error("Cache load error", e); }
    }
  }, [navigate]);

  // --- LOAD USERNAME LOGIC ---
  useEffect(() => {
    const savedUser = localStorage.getItem("loggedInUser");
    if (savedUser) {
      const formatted = savedUser.charAt(0).toUpperCase() + savedUser.slice(1).toLowerCase();
      setUsername(formatted);
    }
  }, []);

  useEffect(() => {
    if (theme === 'light') { document.body.classList.add('light-mode'); } 
    else { document.body.classList.remove('light-mode'); }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // --- AUTO FETCH & ANALYZE ---
  useEffect(() => {
    fetchAndAnalyze();
  }, []);

  const toggleTheme = () => { setTheme(prev => prev === 'dark' ? 'light' : 'dark'); };

  // --- CORE LOGIC ---
  const fetchAndAnalyze = async () => {
    addToast("Syncing Inbox...", "loading");
    setLoading(true);
    
    try {
      const res = await axios.get(`${API_BASE}/fetch-inbox`, { params: { url: apiUrl } });
      
      if (Array.isArray(res.data)) {
        addToast(`Fetched ${res.data.length} emails. Analyzing...`, "success");
        setEmails(res.data); 
        await runAnalysis(res.data); 
      } else { 
        addToast("Error: API returned unexpected format.", "error"); 
        setLoading(false);
      }
    } catch (err) { 
      addToast(`Sync Error: ${err.message}`, "error"); 
      setLoading(false);
    }
  };

  const runAnalysis = async (emailsToAnalyze) => {
    const payload = emailsToAnalyze || emails;
    
    if (!payload || payload.length === 0) {
        setLoading(false);
        return;
    }

    try {
      const res = await axios.post(`${API_BASE}/analyze`, { emails: payload });
      
      if (res.data.emails && Array.isArray(res.data.emails)) {
        setEmails(res.data.emails);
      }
      
      setReport(res.data.report);
      
      localStorage.setItem(
        "emailDashboardData",
        JSON.stringify({
          emails: res.data.emails,
          report: res.data.report
        })
      );

      addToast("Insights Updated!", "success");
      setMainView('INSIGHTS'); 
    } catch (err) { 
      console.error(err); 
      addToast("Analysis Failed. Check console.", "error"); 
    }
    setLoading(false);
  };

  // --- THREAD PARSING ---
  useEffect(() => {
    const fetchParsedThread = async () => {
      if (!selectedEmail) return;
      setThreadLoading(true);
      setParsedThread([]);
      if (selectedEmail.messages && Array.isArray(selectedEmail.messages)) {
        const segments = selectedEmail.messages.map((msg, idx) => ({
          type: idx === 0 ? 'latest' : 'history',
          header: `From: ${msg.from} | ${formatDate(getSafeDate(msg))}`,
          content: msg.body || "" 
        }));
        setParsedThread(segments);
        setThreadLoading(false);
        return; 
      }
      try {
        const res = await axios.post(`${API_BASE}/parse-thread`, { body: selectedEmail.body || "" });
        setParsedThread(res.data.segments || []);
      } catch (err) {
        setParsedThread([{ type: 'latest', content: selectedEmail.body || "No content." }]);
      }
      setThreadLoading(false);
    };
    fetchParsedThread();
  }, [selectedEmail]);

  const generateAiReply = async () => {
    if (!selectedEmail) return;
    setReplyLoading(true);
    setReplyDraft("");
    try {
      const res = await axios.post(`${API_BASE}/reply`, {
        email_body: selectedEmail.body || (selectedEmail.messages ? selectedEmail.messages[0].body : ""),
        sender: selectedEmail.from || "Unknown",
        subject: selectedEmail.subject || ""
      });
      setReplyDraft(res.data.reply);
      addToast("Draft Generated!", "success");
    } catch (err) { addToast("Failed to generate reply.", "error"); }
    setReplyLoading(false);
  };

  const handleCopy = async () => {
    if (!replyDraft) return;
    try { 
      await navigator.clipboard.writeText(replyDraft); 
      setCopySuccess(true); 
      addToast("Copied to clipboard!", "success");
      setTimeout(() => setCopySuccess(false), 2000); 
    } catch (err) {}
  };

  const handleLogout = () => {
    localStorage.removeItem("jimAuthSession"); 
    localStorage.removeItem("emailDashboardData");
    localStorage.removeItem("loggedInUser");
    window.location.href = "/login";
  };

  const filteredEmails = (emails || []).filter(e => {
    if (activeTab === 'ALL') return true;
    return (e.category || '').toUpperCase() === activeTab;
  });

  const openFiles = (title, fileList) => {
    const safeList = Array.isArray(fileList) ? fileList : [];
    setFileModalData({ title, files: safeList });
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
                    <div className="file-name">{f.name || "Unnamed"}</div>
                    <div className="file-sender">Type: {f.type || "Unknown"}</div>
                  </div>
                  <button
                    className="btn-glass small-btn download-btn"
                    onClick={async () => {
                      try {
                        const res = await axios.post(
                          `${API_BASE}/download`,
                          { name: f.name, hash: f.hash, type: f.type },
                          { responseType: "blob" }
                        );
                        const url = window.URL.createObjectURL(new Blob([res.data]));
                        const link = document.createElement("a");
                        link.href = url;
                        link.setAttribute("download", f.name);
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                      } catch (err) {
                        addToast("Download failed", "error");
                      }
                    }}
                  >
                    <Download size={14} /> Download
                  </button>
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
              <div className="modal-actions"><span className={`cat-tag ${selectedEmail.category?.toLowerCase() || 'normal'}`}>{selectedEmail.category || 'NORMAL'}</span></div>
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
              {threadLoading ? <div className="loading-text">Loading content...</div> : (
                <div className="email-thread-container">
                  {parsedThread.length > 1 ? (
                    <>
                      <div style={{marginBottom: '10px', fontSize: '1rem', fontWeight: '700', color: '#1e1b4b'}}>
                        <Hash size={16} style={{display:'inline', marginRight:'5px'}}/> Conversation History ({parsedThread.length})
                      </div>
                      {parsedThread.map((msg, idx) => (
                        <div key={idx} className={`thread-message ${msg.type}`}>
                          {msg.header && <div className="thread-header">{msg.header}</div>}
                          <div className="thread-content">{msg.content.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="single-email-body">
                      {parsedThread.map((msg, idx) => (
                        <div key={idx} className="email-body-text">
                            {msg.content.split('\n').map((l, i) => <p key={i}>{l}</p>)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="main-content">
        <header className="top-bar">
          <div className="top-left">
            <button className="menu-btn" onClick={fetchAndAnalyze} title="Refresh Inbox"><Zap size={20} color="#374151" /></button>
            <div className="brand" style={{marginLeft: '15px'}}>
              <div className="logo-box"><LayoutDashboard size={20} color="white" /></div>
              <div className="brand-info"><h2>Email Intelligent</h2><span className="brand-tag">AI HUB</span></div>
            </div>
            <div className="view-switcher" style={{marginLeft: '30px'}}>
              <button className={`view-btn ${mainView === 'INSIGHTS' ? 'active' : ''}`} onClick={() => setMainView('INSIGHTS')}><PieChart size={18} /> Insights</button>
              <button className={`view-btn ${mainView === 'THREADS' ? 'active' : ''}`} onClick={() => setMainView('THREADS')}><Mail size={18} /> Inbox</button>
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
            <div className="avatar">JO</div>
            {isProfileOpen && (<div className="profile-dropdown"><button onClick={handleLogout} className="dropdown-item text-red"><LogOut size={16} /> Sign Out</button></div>)}
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
                
                {/* --- LEFT COLUMN --- */}
                <div className="col-left">
                  <TriageSummary stats={report?.triage_stats} realThreads={realThreads} emails={emails} />

                  <div className="section-title"><Hash size={20} /> 🧵 Ai thread summaries</div>
                  {!report ? <div className="empty-placeholder">Run analysis first.</div> : (
                    <div className="thread-summary-large">
                      <div className="ts-hero"><h1>Executive Summary</h1>{report.all_thread_files && report.all_thread_files.length > 0 && <button className="btn-glass mt-2" onClick={() => openFiles("All Project Files", report.all_thread_files)}><Paperclip size={16} /> View All {report.all_thread_files.length} Files</button>}</div>
                      <div className="ts-content">
                        {(report.briefing_cards || []).length > 0 ? (
                          <div style={{display: 'flex', flexDirection: 'column', gap: '15px'}}>
                            
                            {/* STEP 2: Make thread cards open the Standard Email Modal */}
                            {report.briefing_cards.map((card, idx) => {
                                // Since we know emails[] corresponds 1:1 with tasks (and thus cards),
                                // we can grab the email object directly by index.
                                const threadEmail = emails[idx];

                                return (
                                  <div 
                                    key={idx} 
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

                {/* --- RIGHT COLUMN --- */}
                <div className="col-right">
                  <div className="section-title"><BarChart3 size={20} /> 📧 Individual Emails Summaries</div>
                  {!report ? <div className="empty-placeholder">Run analysis to see stats.</div> : (
                    <div className="sender-list-grid">
                      {(report.sender_summaries || []).map((s, i) => {
                        const senderFiles = [];
                        emails.forEach(e => {
                          (e.messages || []).forEach(m => {
                            if (Array.isArray(m.attachments)) {
                              senderFiles.push(...m.attachments);
                            }
                          });
                        });
                        
                        return (
                          <div key={i} className="sender-card-large">
                            <div className="sender-top">
                              <div className="avatar-small">{s.name.charAt(0)}</div>
                              <div><strong>{s.name}</strong></div>
                            </div>
                            <p className="sender-desc">{s.summary}</p>
                            <div className="sender-stats-row">
                              <div className="stat-box">
                                <span className="stat-num">{s.count || 0}</span>
                                <span className="stat-label">Emails</span>
                              </div>
                              <div 
                                className="stat-box clickable-stat" 
                                onClick={() => {
                                  openFiles(`${s.name}'s Files`, senderFiles);
                                }}
                                style={{ cursor: 'pointer' }}
                              >
                                <span className="stat-num">{senderFiles.length}</span>
                                <span className="stat-label">Files <Paperclip size={10} /></span>
                              </div>
                            </div>
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
                  {['ALL', 'PRIORITY', 'URGENT', 'CONFIDENTIAL', 'MEETING', 'NEWSLETTER'].map(tab => (
                    <button key={tab} className={`tab-btn ${activeTab === tab ? 'active' : ''} ${tab.toLowerCase()}`} onClick={() => setActiveTab(tab)}>
                      {tab} <span className={`count-badge badge-${tab.toLowerCase()}`}>{emails.filter(e => (e.category || 'NORMAL').toUpperCase() === tab || tab === 'ALL').length}</span>
                    </button>
                  ))}
                </div>
                <div className="email-feed">
                  {filteredEmails.map((email, idx) => (
                    <div key={idx} className={`email-card border-${(email.category || 'normal').toLowerCase()}`} onClick={() => setSelectedEmail(email)}>
                      <div className="ec-left-border"></div>
                      <div className="ec-content">
                        <div className="ec-top"><h4>{email.subject || "No Subject"}</h4><div className="ec-badges"><span className={`cat-tag ${(email.category || 'NORMAL').toLowerCase()}`}>{email.category || 'PENDING'}</span></div></div>
                        <div className="ec-meta">
                          <span title={getParticipantDisplay(email)} style={{maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                            <User size={14} /> {getParticipantDisplay(email)}
                          </span>
                          <span><Clock size={14} /> {formatDate(getSafeDate(email))}</span>
                          {(email.cc || email.CC) && <span className="cc-badge"><Users size={12} /> CC</span>}
                        </div>
                        <div className="ec-body">{email.summary || "Pending analysis..."}</div>
                        {(email.attachments && email.attachments.length > 0) && <div className="ec-atts"><Paperclip size={14} />{email.attachments.map((a, k) => <span key={k} className="att-file">{a.file_name}</span>)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default Dashboard;