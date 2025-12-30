import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { 
  LayoutDashboard, Zap, User, Paperclip, AlertTriangle, Shield, 
  Calendar, Hash, BarChart3, Menu, X, PieChart, Mail, Clock, ArrowLeft, 
  Copy, FileText, Download, Users, LogOut
} from 'lucide-react';
import './App.css';

const API_BASE = "http://localhost:8000/api";

function Dashboard() {
  const navigate = useNavigate();
  const [emails, setEmails] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ALL');
  const [mainView, setMainView] = useState('INSIGHTS');
  const [apiUrl, setApiUrl] = useState("http://172.22.6.145/api/Values/inbox/Jim@hfmg.net");
  const [status, setStatus] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [parsedThread, setParsedThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [fileModalData, setFileModalData] = useState(null); 

  // CHECK AUTH ON MOUNT
  useEffect(() => {
    const auth = localStorage.getItem("jimAuthSession");
    if (auth !== "true") {
      navigate("/login"); 
    }
  }, [navigate]);

  useEffect(() => {
    const savedData = localStorage.getItem("emailDashboardData");
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData);
        if (parsed.emails && Array.isArray(parsed.emails)) {
          setEmails(parsed.emails);
          setReport(parsed.report);
          setStatus("Loaded data from cache.");
        }
      } catch (e) { console.error(e); }
    }
  }, []);

  useEffect(() => {
    if (Array.isArray(emails) && emails.length > 0) {
      localStorage.setItem("emailDashboardData", JSON.stringify({ emails, report }));
    }
  }, [emails, report]);

  useEffect(() => {
    const fetchParsedThread = async () => {
      if (!selectedEmail) return;
      setThreadLoading(true);
      setParsedThread([]); 
      try {
        const res = await axios.post(`${API_BASE}/parse-thread`, { body: selectedEmail.body || "" });
        setParsedThread(res.data.segments);
      } catch (err) {
        setParsedThread([{ type: 'latest', content: selectedEmail.body }]);
      }
      setThreadLoading(false);
    };
    fetchParsedThread();
  }, [selectedEmail]);

  const fetchFromApi = async () => {
    setStatus("Syncing Inbox...");
    try {
      const res = await axios.get(`${API_BASE}/fetch-inbox`, { params: { url: apiUrl } });
      if (Array.isArray(res.data)) {
        setEmails(res.data);
        setStatus(`Fetched ${res.data.length} emails.`);
        setReport(null); 
        setMainView('THREADS'); 
      } else { setStatus("Error: API returned unexpected format."); }
    } catch (err) { setStatus(`Error: ${err.message}`); }
  };

  const runAnalysis = async () => {
    setLoading(true);
    setStatus("Analyzing...");
    try {
      const res = await axios.post(`${API_BASE}/analyze`, { emails: emails });
      if (res.data.emails && Array.isArray(res.data.emails)) setEmails(res.data.emails);
      setReport(res.data.report);
      setStatus("Analysis Complete!");
      setMainView('INSIGHTS'); 
    } catch (err) {
      console.error(err);
      setStatus("Analysis Failed.");
    }
    setLoading(false);
  };

  const generateAiReply = async () => {
    if (!selectedEmail) return;
    setReplyLoading(true);
    setReplyDraft(""); 
    try {
      const res = await axios.post(`${API_BASE}/reply`, {
        email_body: selectedEmail.body || "",
        sender: selectedEmail.from || "Unknown",
        subject: selectedEmail.subject || ""
      });
      setReplyDraft(res.data.reply);
    } catch (err) { setStatus("Failed to generate reply."); }
    setReplyLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("jimAuthSession");
    window.location.href = "/login"; // Force refresh to login page
  };

  const filteredEmails = emails.filter(e => {
    if (activeTab === 'ALL') return true;
    return (e.category || '').toUpperCase() === activeTab;
  });

  const openFiles = (title, fileList) => {
    const safeList = Array.isArray(fileList) ? fileList : [];
    setFileModalData({ title, files: safeList });
  };

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown Date";
    try {
      const date = new Date(dateString);
      return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return dateString; }
  };

  return (
    <div className="app-container">
      {/* SIDEBAR */}
      <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="brand-row">
          <div className="brand"><LayoutDashboard size={22} color="white" /><h2>Email Dashboard</h2></div>
          <button className="btn-icon-only" onClick={() => setIsSidebarOpen(false)}><X size={24} color="white" /></button>
        </div>
        <div className="sidebar-content">
          <div className="control-section">
            <label className="sidebar-label">DATA SOURCE</label>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className="input-text" />
            <div style={{marginTop:'10px'}}>
              <button onClick={fetchFromApi} className="btn-glass"><Zap size={16} /> Sync</button>
            </div>
          </div>
          <div className="control-section">
             <label className="sidebar-label">ACTIONS</label>
            <button onClick={runAnalysis} disabled={loading || emails.length === 0} className="btn-gradient">
              {loading ? 'Processing...' : '✨ Run Analysis'}
            </button>
            <p className="status-text">{status}</p>
          </div>
          <div style={{marginTop: 'auto'}}>
            <button onClick={handleLogout} className="btn-glass btn-logout"><LogOut size={16}/> Sign Out</button>
          </div>
        </div>
      </aside>

      {isSidebarOpen && <div className="overlay-backdrop" onClick={() => setIsSidebarOpen(false)}></div>}

      {/* MODALS */}
      {fileModalData && (
        <div className="modal-overlay" onClick={() => setFileModalData(null)}>
          <div className="modal-content file-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3><Paperclip size={18}/> {fileModalData.title}</h3>
              <button className="btn-close" onClick={() => setFileModalData(null)}><X size={20}/></button>
            </div>
            <div className="file-list-container">
              {fileModalData.files.length === 0 ? <div style={{textAlign:'center', padding:'40px'}}>No files found.</div> : 
                fileModalData.files.map((f, i) => (
                  <div key={i} className="file-row">
                    <div className="file-icon">{f.file_name && f.file_name.endsWith('pdf') ? <FileText size={20} color="#ea580c"/> : <Paperclip size={20} color="#3b82f6"/>}</div>
                    <div className="file-info"><div className="file-name">{f.file_name || "Unnamed"}</div><div className="file-sender">From: {f.sender || "Unknown"}</div></div>
                    <button className="btn-glass small-btn download-btn"><Download size={14}/> Download</button>
                  </div>
                ))
              }
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
                <div className="meta-item"><User size={16} /> <strong>From:</strong> {selectedEmail.from || selectedEmail.sender}</div>
                <div className="meta-item"><Clock size={16} /> <strong>Received:</strong> {formatDate(selectedEmail.received_at || selectedEmail.date)}</div>
                {(selectedEmail.cc || selectedEmail.CC) && <div className="meta-item" style={{gridColumn: '1 / -1'}}><Users size={16} /> <strong>CC:</strong> {selectedEmail.cc || selectedEmail.CC}</div>}
              </div>
              <div className="modal-summary-box"><strong>💡 AI Summary:</strong> {selectedEmail.summary}</div>
              <div className="reply-section">
                <div className="reply-header"><strong>Draft Reply</strong><button onClick={generateAiReply} disabled={replyLoading} className="btn-gradient small-btn">{replyLoading ? 'Drafting...' : '✨ Auto-Draft'}</button></div>
                {(replyDraft || replyLoading) && <div className="reply-box">{replyLoading ? <div className="ai-thinking">Thinking...</div> : <textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} className="reply-textarea"/>}</div>}
              </div>
              <hr className="divider"/>
              <div className="email-thread-container">
                 {threadLoading ? <div className="loading-text">Loading full email body...</div> : parsedThread.map((msg, idx) => (<div key={idx} className={`thread-message ${msg.type}`}>{msg.header && <div className="thread-header">{msg.header}</div>}<div className="thread-content">{msg.content.split('\n').map((l,i)=><p key={i}>{l}</p>)}</div></div>))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <main className="main-content">
        <header className="top-bar">
          <div className="top-left">
            <button className="menu-btn" onClick={() => setIsSidebarOpen(true)}><Menu size={24} color="#374151" /></button>
            <div className="view-switcher">
              <button className={`view-btn ${mainView === 'INSIGHTS' ? 'active' : ''}`} onClick={() => setMainView('INSIGHTS')}><PieChart size={18} /> Insights</button>
              <button className={`view-btn ${mainView === 'THREADS' ? 'active' : ''}`} onClick={() => setMainView('THREADS')}><Mail size={18} /> Inbox</button>
            </div>
          </div>
          <div className="user-profile"><span className="welcome-text">Jim Olver-Goshen</span><div className="avatar">JO</div></div>
        </header>

        {mainView === 'INSIGHTS' && (
          <div className="dashboard-grid">
            <div className="col-left">
              <div className="section-title"><BarChart3 size={20} /> Sender Analysis</div>
              {!report ? <div className="empty-placeholder">Run analysis to see stats.</div> : (
                <div className="sender-list-grid">
                  {report.sender_analysis.map((s, i) => (
                    <div key={i} className="sender-card-large">
                      <div className="sender-top"><div className="avatar-small">{s.name.charAt(0)}</div><div><strong>{s.name}</strong><div className="role-pill">{s.role_guess}</div></div></div>
                      <p className="sender-desc">{s.summary}</p>
                      <div className="sender-stats-row">
                        <div className="stat-box"><span className="stat-num">{s.email_count}</span><span className="stat-label">Emails</span></div>
                        <div className={`stat-box ${s.attachment_count > 0 ? 'clickable-stat' : ''}`} onClick={() => openFiles(`${s.name}'s Files`, s.file_list)} style={{cursor: 'pointer'}}>
                          <span className="stat-num">{s.attachment_count || 0}</span><span className="stat-label">Files {s.attachment_count > 0 && <Paperclip size={10}/>}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="col-right">
              <div className="section-title"><Hash size={20} /> Thread Summary</div>
              {!report ? <div className="empty-placeholder">Run analysis first.</div> : (
                <div className="thread-summary-large">
                  <div className="ts-hero"><h1>{report.thread_title || "Executive Summary"}</h1>{report.all_thread_files && report.all_thread_files.length > 0 && <button className="btn-glass mt-2" onClick={() => openFiles("All Project Files", report.all_thread_files)}><Paperclip size={16}/> View All {report.all_thread_files.length} Files</button>}</div>
                  <div className="ts-content"><p>{report.thread_summary}</p></div>
                </div>
              )}
            </div>
          </div>
        )}

        {mainView === 'THREADS' && (
          <div className="feed-container">
            <div className="tabs-container">
              {['ALL', 'URGENT', 'CONFIDENTIAL', 'MEETING'].map(tab => (
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
                    <div className="ec-meta"><span><User size={14}/> {email.from || email.sender}</span><span><Clock size={14}/> {formatDate(email.received_at || email.date)}</span>{(email.cc || email.CC) && <span className="cc-badge"><Users size={12}/> CC</span>}</div>
                    <div className="ec-body">{email.summary || "Pending analysis..."}</div>
                    {(email.attachments && email.attachments.length > 0) && <div className="ec-atts"><Paperclip size={14} />{email.attachments.map((a, k) => <span key={k} className="att-file">{a.file_name}</span>)}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default Dashboard;