import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './App.css';
import DashboardView from './DashboardView';

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

  // --- NEW STATE: Last Sync Time ---
  const [lastSyncTime, setLastSyncTime] = useState(
    localStorage.getItem("lastSyncTime")
  );
  
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

  // --- NEW FUNCTION: Collect all attachments (LIGHTWEIGHT) ---
  const getAllAttachments = () => {
    const files = [];

    (emails || []).forEach(e => {
      // Thread emails
      if (Array.isArray(e.messages)) {
        e.messages.forEach(m => {
          if (Array.isArray(m.attachments)) {
            m.attachments.forEach(att => {
              files.push({
                name: att.name,
                type: att.type,
                size: att.size,
                hash: att.hash,           // short preview only
                storage: att.storage,     // "inline" or "remote"
                full_hash: att.full_hash || null,
                senders: [m.from || e.from || "Unknown"]
              });
            });
          }
        });
      }

      // Single emails
      if (Array.isArray(e.attachments)) {
        e.attachments.forEach(att => {
          files.push({
            name: att.name,
            type: att.type,
            size: att.size,
            hash: att.hash,
            storage: att.storage,
            full_hash: att.full_hash || null,
            senders: [e.from || "Unknown"]
          });
        });
      }
    });

    return files;
  };

  // Separate real threads and single emails
  const realThreads = (emails || []).filter(e => 
    Array.isArray(e.messages) && e.messages.length > 1
  );
  
  // Derived state for filtered emails in Inbox view
  const filteredEmails = (emails || []).filter(e => {
    if (activeTab === 'ALL') return true;
    return (e.category || '').toUpperCase() === activeTab;
  });

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

  // --- HELPERS: Safe email content readers ---
  const getEmailBody = (email) => {
    if (email.messages && Array.isArray(email.messages) && email.messages.length > 0) {
      return email.messages[0].body || "";
    }
    return email.body || "";
  };

  const getEmailAttachments = (email) => {
    if (email.messages && Array.isArray(email.messages)) {
      return email.messages.flatMap(m => m.attachments || []);
    }
    return email.attachments || [];
  };

  // --- NEW HELPER: Get sender details (emails + attachments from a specific sender) ---
  const getSenderDetails = (senderEmail) => {
    const senderMails = emails.filter(e => {
      const from = (e.from || "").toLowerCase();
      return from.includes(senderEmail.toLowerCase());
    });

    const attachments = [];

    senderMails.forEach(e => {
      // For thread emails
      if (Array.isArray(e.messages)) {
        e.messages.forEach(m => {
          if (Array.isArray(m.attachments)) {
            attachments.push(...m.attachments);
          }
        });
      }

      // For single emails
      if (Array.isArray(e.attachments)) {
        attachments.push(...e.attachments);
      }
    });

    return {
      mails: senderMails,
      attachments
    };
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

        // --- NEW: Update Last Sync Time ---
        const now = new Date().toISOString();
        localStorage.setItem("lastSyncTime", now);
        setLastSyncTime(now);
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
        const sanitized = res.data.emails.map(e => {
          if (Array.isArray(e.attachments)) {
            e.attachments = e.attachments.map(a => ({
              name: a.name,
              type: a.type,
              size: a.size,
              hash: a.hash,
              storage: a.storage,
              full_hash: a.full_hash || null
            }));
          }

          if (Array.isArray(e.messages)) {
            e.messages.forEach(m => {
              if (Array.isArray(m.attachments)) {
                m.attachments = m.attachments.map(a => ({
                  name: a.name,
                  type: a.type,
                  size: a.size,
                  hash: a.hash,
                  storage: a.storage,
                  full_hash: a.full_hash || null
                }));
              }
            });
          }
          return e;
        });

        setEmails(sanitized);
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

  // --- THREAD PARSING (STEP 2: ATTACHMENTS FIX) ---
  useEffect(() => {
    const fetchParsedThread = async () => {
      if (!selectedEmail) return;
      setThreadLoading(true);
      setParsedThread([]);
      
      // STEP 2: Updated to include attachments at message level
      if (selectedEmail.messages && Array.isArray(selectedEmail.messages)) {
        const segments = selectedEmail.messages.map((msg, idx) => ({
          type: idx === 0 ? 'latest' : 'history',
          header: `From: ${msg.from} | ${formatDate(msg.date || msg.received_at)}`,
          content: msg.body || "",
          attachments: Array.isArray(msg.attachments) ? msg.attachments : []
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

  const openFiles = (title, fileList) => {
    const safeList = Array.isArray(fileList) ? fileList : [];
    setFileModalData({ title, files: safeList });
  };

  // --- SAFE DOWNLOAD HANDLER ---
  const handleFileDownload = async (file) => {
    try {
      if (file.storage === "remote") {
        addToast("Video files must be downloaded from the original email.", "error");
        return;
      }

      addToast(`Downloading ${file.name}...`, "loading");

      const res = await axios.post(
        `${API_BASE}/download`,
        {
          name: file.name,
          type: file.type,
          storage: file.storage,
          full_hash: file.full_hash
        },
        { responseType: "blob" }
      );

      const blob = new Blob([res.data], { type: file.type });
      const link = document.createElement("a");
      link.href = window.URL.createObjectURL(blob);
      link.download = file.name;
      link.click();

      addToast(`Downloaded: ${file.name}`, "success");

    } catch (err) {
      console.error(err);
      addToast(`Download failed for ${file.name}`, "error");
    }
  };

  return (
    <DashboardView
      // State
      emails={emails}
      report={report}
      loading={loading}
      mainView={mainView}
      setMainView={setMainView}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      username={username}
      greetingInfo={greetingInfo}
      theme={theme}
      toggleTheme={toggleTheme}
      toasts={toasts}
      removeToast={removeToast}
      isProfileOpen={isProfileOpen}
      setIsProfileOpen={setIsProfileOpen}
      
      // --- NEW PROP PASSED DOWN ---
      lastSyncTime={lastSyncTime}

      // Selection & Modals
      selectedEmail={selectedEmail}
      setSelectedEmail={setSelectedEmail}
      fileModalData={fileModalData}
      setFileModalData={setFileModalData}
      
      // Thread & Reply
      parsedThread={parsedThread}
      threadLoading={threadLoading}
      replyDraft={replyDraft}
      setReplyDraft={setReplyDraft}
      replyLoading={replyLoading}
      copySuccess={copySuccess}
      
      // Computed Data
      realThreads={realThreads}
      filteredEmails={filteredEmails}
      
      // Functions / Handlers
      fetchAndAnalyze={fetchAndAnalyze}
      handleLogout={handleLogout}
      handleCopy={handleCopy}
      generateAiReply={generateAiReply}
      openFiles={openFiles}
      getAllAttachments={getAllAttachments}
      handleFileDownload={handleFileDownload}
      getSenderDetails={getSenderDetails}
      
      // Helpers
      getParticipantDisplay={getParticipantDisplay}
      formatDate={formatDate}
      getSafeDate={getSafeDate}
      getEmailBody={getEmailBody}
      getEmailAttachments={getEmailAttachments}
    />
  );
}

export default Dashboard;