import React, { useState, useEffect } from "react";
import "./App.css";
import DashboardView from "./DashboardView";
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useMemo, useRef } from "react";

const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:8000/api";

// --- ✅ HELPER: Extract email from "Name <email@domain.com>" format ---
const extractEmail = (value) => {
  if (!value) return "";
  const match = value.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : value;
};

function Dashboard() {
  const navigate = useNavigate();
  
  // ✅ IDLE TIMER CONFIG + REF
  const IDLE_TIMEOUT = 20 * 1000; // use 20 sec for testing
  const idleTimerRef = useRef(null);
  
  // --- STATE ---
  const [emails, setEmails] = useState([]);
  const [lastUserActivityTime, setLastUserActivityTime] = useState(Date.now());
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [isIdle, setIsIdle] = useState(false);
  const [inboxReady, setInboxReady] = useState(false);
  const [isSoftSyncing, setIsSoftSyncing] = useState(false);

  // --- CHANGED: Stable sorted emails list ---
  const sortedEmails = useMemo(() => {
    if (!emails || emails.length === 0) return [];
    return [...emails].sort(
      (a, b) =>
        new Date(b.received || b.received_at) -
        new Date(a.received || a.received_at)
    );
  }, [emails]);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('ALL');
  const [mainView, setMainView] = useState('INSIGHTS');
  const [username, setUsername] = useState("User"); 
  
  // Kept API URL in state
  const [apiUrl, setApiUrl] = useState("http://172.22.6.145/api/Values/inbox/ramon.romero@hfmg.net/count10");
  
  const [toasts, setToasts] = useState([]);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [selectedEmailId, setSelectedEmailId] = useState(null);
  const [parsedThread, setParsedThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [selectedBriefing, setSelectedBriefing] = useState(null); 
  const [replyDraft, setReplyDraft] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [fileModalData, setFileModalData] = useState(null);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);

  // ✅ REMOVED: expandedReplyId and related state
  // DashboardView now manages inline reply state internally per-card

  // --- HELPER: Get Safe Date (Moved up for use in Sorting) ---
  const getSafeDate = (emailObj) => {
    if (!emailObj) return "Unknown Date";
    const candidates = [emailObj.received, emailObj.received_at, emailObj.date, emailObj.createdDateTime, emailObj.receivedDateTime, emailObj.internalDate];
    for (const d of candidates) { if (d && d !== "Unknown Date") return d; }
    return "Unknown Date";
  };

  // ✅ REPLACED: markUserActive with idle timer
  const markUserActive = () => {

    setLastUserActivityTime(Date.now());

    if (isIdle) {
    }

    setIsIdle(false);

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }

    idleTimerRef.current = setTimeout(() => {
      console.log("🟡 User is now IDLE → auto sync should start");
      setIsIdle(true);
    }, IDLE_TIMEOUT);
  };

  // --- NEW FUNCTION: Collect all attachments (LIGHTWEIGHT) ---
  const getAllAttachments = () => {
    const files = [];

    (emails || []).forEach(e => {
      // Attachments are now merged into email.attachments
      if (e.attachments && Array.isArray(e.attachments)) {
        e.attachments.forEach(att => {
          files.push({
            name: att.name,
            type: att.type,
            size: att.size,
            hash: att.hash,
            storage: att.storage,
            full_hash: att.full_hash || null,
            messageId: att.messageId,
            senders: [e.from || "Unknown"]
          });
        });
      }
    });

    return files;
  };

  // --- DERIVED STATE: Filter & Safe Sort ---

  // Separate real threads and single emails (Sorted)
  const realThreads = (emails || [])
    .filter(e => Array.isArray(e.messages) && e.messages.length > 1)
    .sort((a, b) => new Date(getSafeDate(b)) - new Date(getSafeDate(a))); // ✅ Safe Sort
  
  // --- CHANGED: Replace filteredEmails logic ---
  const filteredAndSortedEmails = useMemo(() => {
    if (!sortedEmails.length) return [];
    if (activeTab === "ALL") return sortedEmails;
  
    return sortedEmails.filter(
      (e) => (e.category || "").toUpperCase() === activeTab
    );
  }, [sortedEmails, activeTab]);

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
  
  // 1. Unified Attachment Check (SIMPLIFIED)
  const emailHasAttachments = (email) => {
    return (email.attachments || []).length > 0;
  };

  const getEmailBody = (email) => {
    if (email.messages && Array.isArray(email.messages) && email.messages.length > 0) {
      return email.messages[0].body || "";
    }
    return email.body || "";
  };

  // STEP 2: SIMPLIFIED - Backend already merged everything
  const getEmailAttachments = (email) => {
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
      // Attachments are now in email.attachments
      if (e.attachments && Array.isArray(e.attachments)) {
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

    // ✅ FIXED: Only restore metadata, not full email data
    const meta = JSON.parse(localStorage.getItem("emailDashboardMeta") || "{}");
    if (meta.lastSync) {
      setLastSyncTime(meta.lastSync);
      console.log(`📋 Cached metadata loaded: ${meta.emailCount} emails, synced at ${meta.lastSync}`);
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

  const toggleTheme = () => { setTheme(prev => prev === 'dark' ? 'light' : 'dark'); };

  // ✅ FIXED: Activity listeners with logging
  useEffect(() => {
    const handleActivity = () => {
      markUserActive();
    };

    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("mousedown", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("scroll", handleActivity);

    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("mousedown", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("scroll", handleActivity);
    };
  }, []);

  // --- INITIAL LOAD (First time dashboard opens) ---
  useEffect(() => {
    console.log("🚀 Initial dashboard load");
    fetchAndAnalyze(false);

    // After first successful load, set sync time
    setLastSyncTime(Date.now());
  }, []);

  // ✅ START IDLE TIMER WHEN DASHBOARD MOUNTS
  useEffect(() => {
    console.log("🚀 Dashboard mounted, starting idle timer");
    markUserActive();
  }, []);

  // ✅ VERIFIED: Auto-refresh effect with logging
  useEffect(() => {
    console.log("🔥 isIdle:", isIdle, "AutoSync:", autoSyncEnabled);

    // If user turned Auto Sync OFF
    if (!autoSyncEnabled) {
      console.log("⛔ Auto Sync is OFF");
      return;
    }

    // If user is active, pause auto refresh
    if (!isIdle) {
      console.log("⏸ Auto refresh paused (user active)");
      return;
    }

    console.log("▶ Auto refresh started (user idle)");

    const interval = setInterval(() => {
      console.log("🔄 Soft refresh running now...");
      fetchAndAnalyze(true);
    }, 2 * 60 * 1000);   // 2 minutes

    return () => {
      console.log("⏹ Auto refresh stopped");
      clearInterval(interval);
    };
  }, [isIdle, autoSyncEnabled]);

  // ✅ REMOVED: Auto-collapse reply when selection changes
  // DashboardView manages this internally now

  // --- STEP 4: UPDATED FETCH FUNCTION TO RESTORE SELECTION ---
  const fetchAndAnalyze = async (arg) => {
    const silent = arg === true;
    const currentSelectedId = selectedEmailId; // Capture current ID

    console.log(
      silent ? "🤫 Soft refresh triggered" : "🔁 Manual refresh triggered"
    );

    if (silent) {
      setIsSoftSyncing(true);
    }

    if (!silent) setInboxReady(false);   // only block UI on manual refresh

    if (!silent) {
      addToast("Syncing Inbox...", "loading");
      setLoading(true);
    }
    
    try {
      const res = await axios.get(`${API_BASE}/fetch-inbox`, { params: { url: apiUrl } });
      
      if (Array.isArray(res.data)) {
        if (!silent) {
            addToast(`Fetched ${res.data.length} emails. Analyzing...`, "success");
        }
        setEmails(res.data);
        setInboxReady(true); // ✅ Inbox is now safe to render
        
        // ⬇️ MODIFIED: Pass silent flag to runAnalysis
        await runAnalysis(res.data, silent); 

        // Restore selected email after refresh
        if (currentSelectedId) {
            const updatedEmail = res.data.find(
              e => (e.id || e.messageId) === currentSelectedId
            );
            if (updatedEmail) {
              setSelectedEmail(updatedEmail);
            }
        }

        const now = new Date().toISOString();
        localStorage.setItem("lastSyncTime", now);
        setLastSyncTime(now);
      } else { 
        if (!silent) addToast("Error: API returned unexpected format.", "error"); 
      }
    } catch (err) { 
      if (!silent) addToast(`Sync Error: ${err.message}`, "error"); 
    } finally {
        if (silent) {
          setIsSoftSyncing(false);
        } else {
          setLoading(false);
        }
    }
  };

  // ⬇️ MODIFIED: Accept silent param and check before UI switch
  const runAnalysis = async (emailsToAnalyze, silent = false) => {
    const payload = emailsToAnalyze || emails;
    
    // Even if payload is empty, we must ensure loading is turned off
    if (!payload || payload.length === 0) {
        setLoading(false);
        return;
    }

    try {
      const res = await axios.post(`${API_BASE}/analyze`, { emails: payload });
      
      if (res.data.emails && Array.isArray(res.data.emails)) {
        // Sanitize attachments structure for UI
        const sanitized = res.data.emails.map(e => {
          if (Array.isArray(e.attachments)) {
            e.attachments = e.attachments.map(a => ({
              name: a.name,
              type: a.type,
              size: a.size,
              hash: a.hash,
              storage: a.storage,
              full_hash: a.full_hash || null,
              messageId: a.messageId
            }));
          }

          // No need to process e.messages attachments separately
          // Backend should have merged them into e.attachments
          return e;
        });

        setEmails(sanitized);
        
        // Update report
        setReport(res.data.report);
      
        // ✅ FIXED: Save only metadata to LocalStorage (not full data)
        const metaCache = {
          lastSync: new Date().toISOString(),
          emailCount: res.data.emails?.length || 0,
          briefingCount: res.data.report?.briefing_cards?.length || 0
        };
        localStorage.setItem("emailDashboardMeta", JSON.stringify(metaCache));
      }
      
      // ⬇️ MODIFIED: Only switch view & toast if NOT silent
      if (!silent) {
        addToast("Insights Updated!", "success");
        setMainView('INSIGHTS'); 
      }

    } catch (err) { 
      console.error(err); 
      addToast("Analysis Failed. Check console.", "error"); 
    } finally {
        // 🔴 FIX: Always turn off loading, even if error or 0 zoom mails
        setLoading(false);
    }
  };

  // --- THREAD PARSING (SIMPLIFIED) ---
  useEffect(() => {
    const fetchParsedThread = async () => {
      if (!selectedEmail) return;
      setThreadLoading(true);
      setParsedThread([]);
      
      // If email has messages array, use it; otherwise treat as single message
      if (selectedEmail.messages && Array.isArray(selectedEmail.messages)) {
        const segments = selectedEmail.messages.map((msg, idx) => ({
          type: idx === 0 ? 'latest' : 'history',
          header: `From: ${msg.from} | ${formatDate(msg.date || msg.received_at)}`,
          content: msg.body || "",
          attachments: msg.attachments || []
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
    localStorage.removeItem("emailDashboardMeta");
    localStorage.removeItem("loggedInUser");
    window.location.href = "/login";
  };

  // ✅ REMOVED: handleInlineReplyToggle 
  // DashboardView manages inline reply state internally per-card

  // ✅ UPDATED FUNCTION: Mark email as read + update backend cache
  const markAsRead = async (emailObj) => {
    try {
      const userEmail = apiUrl.split("/inbox/")[1].split("/")[0];
      
      // 🔥 DEFINE messageId HERE (BEFORE using it in setEmails)
      const messageId = emailObj.id || emailObj.messageId;

      // STEP 1: Update frontend state IMMEDIATELY (optimistic update)
      setEmails(prev =>
        prev.map(e =>
          (e.id === messageId || e.messageId === messageId)
            ? { ...e, isRead: true }
            : e
        )
      );

      console.log("✅ Frontend updated: marked as read:", messageId);

      // STEP 2: Call backend to mark as read in the actual inbox
      await axios.post(
        `${process.env.REACT_APP_API_URL || "http://localhost:8000/api"}/mark-read`,
        {
          email: userEmail,
          messageId: messageId
        }
      );

      console.log("✅ Backend inbox updated:", messageId);

      addToast("Email marked as read", "success");

    } catch (err) {
      console.error("❌ Failed to mark as read:", err);
      addToast("Failed to mark email as read", "error");
      
      // 🔥 Revert frontend state if backend call failed
      // messageId is still in scope here from the try block
      const messageId = emailObj.id || emailObj.messageId;
      
      setEmails(prev =>
        prev.map(e =>
          (e.id === messageId || e.messageId === messageId)
            ? { ...e, isRead: false }
            : e
        )
      );
    }
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
      
      // --- NEW PROPS PASSED DOWN ---
      lastSyncTime={lastSyncTime}
      inboxReady={inboxReady}
      isSoftSyncing={isSoftSyncing}
      autoSyncEnabled={autoSyncEnabled}
      setAutoSyncEnabled={setAutoSyncEnabled}

      // Selection & Modals
      selectedEmail={selectedEmail}
      
      // --- STEP 3: WRAPPED SETTER TO STORE ID ---
      setSelectedEmail={(email) => {
        setSelectedEmail(email);
        setSelectedEmailId(email ? (email.id || email.messageId) : null);
      }}
      
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
      filteredEmails={filteredAndSortedEmails}
      
      // Functions / Handlers
      fetchAndAnalyze={fetchAndAnalyze}
      handleLogout={handleLogout}
      handleCopy={handleCopy}
      generateAiReply={generateAiReply}
      openFiles={openFiles}
      getAllAttachments={getAllAttachments}
      handleFileDownload={handleFileDownload}
      getSenderDetails={getSenderDetails}
      markAsRead={markAsRead}
      
      // Helpers
      getParticipantDisplay={getParticipantDisplay}
      formatDate={formatDate}
      getSafeDate={getSafeDate}
      getEmailBody={getEmailBody}
      getEmailAttachments={getEmailAttachments}
      emailHasAttachments={emailHasAttachments}
    />
  );
}

export default Dashboard;