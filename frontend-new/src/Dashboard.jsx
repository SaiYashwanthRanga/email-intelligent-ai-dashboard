import React, { useState, useEffect, useCallback } from "react";
import "./App.css";
import DashboardView from "./DashboardView";
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useMemo, useRef } from "react";
import InboxView from './InboxView.jsx';
import { getDeviceId, getDeviceLabel } from './deviceIdentity';

const API_BASE = import.meta.env.VITE_API_URL;

// Progressive inbox fetch: grab a small, fast batch first so the user sees
// mail almost immediately, then fill in the rest in the background instead
// of blocking the whole UI until all emails arrive.
const FAST_FETCH_COUNT = 40;
const FULL_FETCH_COUNT = 500;

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
  
  // ✅ FIX: Prevent double fetch on mount
  const hasInitiallyFetched = useRef(false);
  
  // --- STATE ---
  const [emails, setEmails] = useState([]);
  const [lastUserActivityTime, setLastUserActivityTime] = useState(Date.now());
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [isIdle, setIsIdle] = useState(false);
  const [inboxReady, setInboxReady] = useState(false);
  const [inboxError, setInboxError] = useState(false);
  const [isSoftSyncing, setIsSoftSyncing] = useState(false);
  // True while phase 2 (the full-inbox background fetch) is still running,
  // so the inbox list can show a "still fetching" indicator once the user
  // scrolls past the fast first batch instead of the list just ending.
  const [isFetchingFullInbox, setIsFetchingFullInbox] = useState(false);

  // ✅ FIXED: Only use the real Exchange delivery timestamp for card display.
  // Previously this included m.date from thread messages, which are parsed from
  // body text (e.g. "Thursday 4/2 at 10am is available") — causing cards to show
  // meeting dates mentioned inside emails instead of when the email was received.
  // The API returns "received" with timezone offset (e.g. "2026-03-31T02:09:39-04:00"),
  // which normalize_email maps to "received_at". We trust only those two fields.
  const getEffectiveReceivedAt = (email) => {
    const raw = email?.received_at || email?.received;
    if (raw && raw !== "Unknown" && raw !== "1970-01-01T00:00:00") {
      const dt = new Date(raw);
      if (!isNaN(dt.getTime())) return dt;
    }
    return new Date(0);
  };

  // --- HELPER: Normalize subject by stripping reply/forward prefixes ---
  const normalizeSubject = (subject) => {
    if (!subject) return "";
    // Strip Re:, RE:, Fwd:, FW:, AW: etc. repeatedly (handles "Re: Re: ..." chains)
    let s = subject.trim();
    const prefixPattern = /^(re|fwd|fw|aw|tr)\s*:\s*/i;
    while (prefixPattern.test(s)) {
      s = s.replace(prefixPattern, "").trim();
    }
    return s.toLowerCase();
  };

  // --- GROUP EMAILS BY THREAD: merge Re:/RE: replies under one thread card ---
  // Outlook rule: ONLY group emails that carry a Re:/Fwd: prefix.
  // Emails without a reply prefix are always standalone — even if many
  // arrive with the same subject (e.g. automated notifications like
  // "Iguana: Lab Results" or "AWV regarding;"). Grouping those would
  // falsely collapse unrelated automated emails into fake threads.
  const REPLY_PREFIX = /^(re|fwd|fw|aw|tr)\s*:\s*/i;

  const groupedEmails = useMemo(() => {
    if (!emails || emails.length === 0) return [];

    // ── STEP 1: Separate emails the backend already threaded (have messages array
    //   with >1 entries, or threadCount>1) from plain single emails.
    //   Backend threads are grouped by conversationId — trust that completely.
    const backendThreaded = new Set(); // conversationIds already handled
    const result = [];

    emails.forEach(email => {
      // Backend already produced a thread card for this email
      const hasBackendThread = (
        (Array.isArray(email.messages) && email.messages.length > 1) ||
        (email.threadCount && email.threadCount > 1)
      );

      if (hasBackendThread) {
        const convId = email.conversationId || email.id || email.messageId;
        if (convId && backendThreaded.has(convId)) return; // skip duplicate
        if (convId) backendThreaded.add(convId);
        result.push(email); // use exactly as-is from backend
      }
    });

    // ── STEP 2: For remaining single emails, apply subject-based grouping
    //   ONLY if they share a conversationId that wasn't already handled above.
    //   This catches cases where the backend returned individual reply emails
    //   (each with 1 message) that belong to the same conversation.
    const singles = emails.filter(email => {
      const hasBackendThread = (
        (Array.isArray(email.messages) && email.messages.length > 1) ||
        (email.threadCount && email.threadCount > 1)
      );
      if (hasBackendThread) return false;
      // Also skip if this email's conversationId was already handled by a backend thread
      const convId = email.conversationId;
      if (convId && backendThreaded.has(convId)) return false;
      return true;
    });

    // Group singles by conversationId first, then fall back to subject prefix
    const convGroups = {};
    const subjectGroups = {};

    singles.forEach(email => {
      const convId = email.conversationId;
      if (convId) {
        if (!convGroups[convId]) convGroups[convId] = [];
        convGroups[convId].push(email);
        return;
      }

      // No conversationId — use subject prefix grouping (Re:/Fwd: only)
      const subject = email.subject || '';
      if (!REPLY_PREFIX.test(subject.trim())) {
        const uniqueKey = email.id || email.messageId || subject + '_' + Math.random();
        subjectGroups[uniqueKey] = [email];
        return;
      }
      const baseSubject = normalizeSubject(subject);
      if (!subjectGroups[baseSubject]) subjectGroups[baseSubject] = [];
      subjectGroups[baseSubject].push(email);
    });

    // Merge all groups
    const allGroups = [
      ...Object.values(convGroups),
      ...Object.values(subjectGroups),
    ];

    allGroups.forEach(group => {
      if (group.length === 1) {
        result.push(group[0]);
        return;
      }

      // Sort group newest-first
      const sorted = [...group].sort(
        (a, b) => getEffectiveReceivedAt(b) - getEffectiveReceivedAt(a)
      );

      // Newest email becomes the thread parent
      const threadParent = { ...sorted[0] };

      // Build unified messages array from all emails in the group
      const allMessages = [];
      sorted.forEach(email => {
        if (Array.isArray(email.messages) && email.messages.length > 0) {
          allMessages.push(...email.messages);
        } else {
          allMessages.push({
            from:        email.from || email.sender || "Unknown",
            date:        email.received || email.received_at || email.date,
            body:        email.body || "",
            attachments: email.attachments || [],
            messageId:   email.id || email.messageId || "",
          });
        }
      });

      // Deduplicate messages by messageId first, then from+date
      const seenMsgIds = new Set();
      const seenKeys   = new Set();
      threadParent.messages = allMessages.filter(msg => {
        const mid = msg.messageId;
        if (mid) {
          if (seenMsgIds.has(mid)) return false;
          seenMsgIds.add(mid);
          return true;
        }
        const key = `${msg.from}|${msg.date}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      // Merge all attachments
      const allAtts = [];
      sorted.forEach(e => {
        if (Array.isArray(e.attachments)) allAtts.push(...e.attachments);
      });
      threadParent.attachments = allAtts;

      threadParent.isRead       = sorted.every(e => e.isRead);
      threadParent.threadCount  = threadParent.messages.length;
      threadParent.allMessageIds = sorted.map(e => e.id || e.messageId).filter(Boolean);
      threadParent.summary      = sorted.find(e => e.summary)?.summary || "";

      result.push(threadParent);
    });

    return result;
  }, [emails]);

  // --- CHANGED: Stable sorted emails list (now uses grouped data) ---
  const sortedEmails = useMemo(() => {
    if (!groupedEmails || groupedEmails.length === 0) return [];
    return [...groupedEmails].sort(
      (a, b) => getEffectiveReceivedAt(b) - getEffectiveReceivedAt(a)
    );
  }, [groupedEmails]);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isAnalyzingBackground, setIsAnalyzingBackground] = useState(false);
  const pollIntervalRef = useRef(null);
  const [activeTab, setActiveTab] = useState('ALL');
  const [mainView, setMainView] = useState('THREADS');
  const [username, setUsername] = useState("User");
  const [mailStats, setMailStats] = useState(null);
  
  // Use the logged-in user's email (set during login)
  const userEmail = localStorage.getItem("userEmail") || "";
  
  const [toasts, setToasts] = useState([]);

  // ── Flag / correction state ───────────────────────────────────────────────
  const [flagOpen,       setFlagOpen]       = useState(null); // emailId with dropdown open
  const [flagSubmitting, setFlagSubmitting] = useState({});   // emailId → bool
  const [flagSuccess,    setFlagSuccess]    = useState({});   // emailId → bool
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [selectedEmailId, setSelectedEmailId] = useState(null);
  const [parsedThread, setParsedThread] = useState([]);
  const [threadKey,    setThreadKey]    = useState(0);   // bumped after enrichment to force re-parse
  const [threadLoading, setThreadLoading] = useState(false);
  const [selectedBriefing, setSelectedBriefing] = useState(null); 
  const [replyDraft, setReplyDraft] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [fileModalData, setFileModalData] = useState(null);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [senderFilter, setSenderFilter] = useState(null); // { email, name } | null
  const [canUseTracking, setCanUseTracking] = useState(false);
  const [canUseActivity, setCanUseActivity] = useState(false); // gates the Activity tab — see activity_access.json
  const [autoDigest, setAutoDigest] = useState(null);       // complete 7-day digest from EWS
  const [digestLoading, setDigestLoading] = useState(true); // shows skeleton until first load

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

  const realThreads = (groupedEmails || [])
    .filter(e =>
      (Array.isArray(e.messages) && e.messages.length > 1) ||
      (e.threadCount && e.threadCount > 1)
    )
    .sort((a, b) => getEffectiveReceivedAt(b) - getEffectiveReceivedAt(a));
  
  // --- CHANGED: Replace filteredEmails logic ---
  const filteredAndSortedEmails = useMemo(() => {
    if (!sortedEmails.length) return [];

    let result = sortedEmails;

    // Sender filter (from Insights "View" click)
    if (senderFilter) {
      result = result.filter(e => {
        const from = (e.from || e.sender || "").toLowerCase();
        return from.includes(senderFilter.email.toLowerCase());
      });
    }

    if (activeTab === "ALL") return result;
    return result.filter(e => e.category === activeTab);
  }, [sortedEmails, activeTab, senderFilter]);

  const augmentedReport = useMemo(() => {
    if (!report) return null;
    const existingIds = new Set((report.briefing_cards || []).map(c => c.id).filter(Boolean));

    // Deduplicate sortedEmails by conversationId before scanning for missing threads.
    // Without this, a thread with N messages produces N entries in sortedEmails
    // (one per cached message ID), causing N duplicate briefing cards.
    const seenConvIds = new Set();
    const dedupedEmails = sortedEmails.filter(e => {
      const convKey = e.conversationId || e.id || e.messageId;
      if (seenConvIds.has(convKey)) return false;
      seenConvIds.add(convKey);
      return true;
    });

    const missing = dedupedEmails
      .filter(e => {
        const count = e.threadCount || e.thread_count || 0;
        const id    = e.id || e.messageId;
        return count > 1 && id && !existingIds.has(id);
      })
      .map(e => ({
        id:           e.id || e.messageId,
        subject:      e.subject || "No Subject",
        topic:        e.subject || "No Subject",
        status:       e.summary || `${e.threadCount || e.thread_count} message thread`,
        summary:      e.summary || "",
        category:     e.category || "NORMAL",
        thread_count: e.threadCount || e.thread_count || 2,
      }));
    if (missing.length === 0) return report;
    return { ...report, briefing_cards: [...(report.briefing_cards || []), ...missing] };
  }, [report, sortedEmails]);

  const triageStats = useMemo(() => {
    const base = report?.triage_stats || null;
    if (!mailStats) return base;

    const fc = mailStats.fileTypeCounts || {};

    // ── Group raw API file types into display categories ──
    const att_breakdown = {
      PDF:   (fc[".pdf"]  || 0),
      DOC:   (fc[".docx"] || 0) + (fc[".doc"]  || 0),
      XLS:   (fc[".xlsx"] || 0) + (fc[".xls"]  || 0) + (fc[".xlsb"] || 0) + (fc[".csv"] || 0),
      PPT:   (fc[".pptx"] || 0) + (fc[".ppt"]  || 0),
      IMG:   (fc[".png"]  || 0) + (fc[".jpg"]  || 0) + (fc[".jpeg"] || 0) + (fc[".gif"]  || 0) + (fc[".tiff"] || 0),
      VIDEO: (fc[".mp4"]  || 0) + (fc[".wmv"]  || 0) + (fc[".avi"]  || 0) + (fc[".mov"]  || 0),
      AUDIO: (fc[".mp3"]  || 0) + (fc[".wav"]  || 0) + (fc[".m4a"]  || 0),
      TXT:   (fc[".txt"]  || 0) + (fc[".vtt"]  || 0),
    };

    // Strip categories with 0 count so the UI doesn't show empty entries
    const filteredBreakdown = Object.fromEntries(
      Object.entries(att_breakdown).filter(([, v]) => v > 0)
    );

    return {
      ...(base || {}),
      vol_emails: mailStats?.unreadCount ?? emails.length,
      total_unread:  mailStats.unreadCount      ?? base?.total_unread  ?? 0,
      att_total:     mailStats.totalAttachments ?? base?.att_total     ?? 0,
      att_breakdown: filteredBreakdown,
      to:            mailStats.totalToRecipients  ?? base?.to          ?? 0,
      cc:            mailStats.totalCcRecipients  ?? base?.cc          ?? 0,
    };
  }, [report, mailStats, emails]);

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
  // Smart toast: deduplicates identical messages, aggregates counts,
  // and caps the visible stack at 3 so notifications never block the UI.
  const addToast = (message, type = 'info') => {
    setToasts(prev => {
      // 1. If an identical message+type is already visible, just bump its
      //    count and refresh its ID (resets the auto-dismiss timer).
      const existing = prev.find(t => t.message === message && t.type === type);
      if (existing) {
        return prev.map(t =>
          t.id === existing.id
            ? { ...t, id: Date.now(), count: (t.count || 1) + 1 }
            : t
        );
      }

      const newToast = { id: Date.now(), message, type, count: 1 };

      // 2. Hard cap: keep only the 2 most recent + the new one (max 3 visible).
      const trimmed = prev.length >= 3 ? prev.slice(-2) : prev;
      return [...trimmed, newToast];
    });
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const formatDate = (dateString) => {
    if (!dateString || dateString === "Unknown Date") return "Unknown Date";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return "Unknown Date"; 
      return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return "Unknown Date"; }
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

    // ── Check tracking access for this user ──
    const email = localStorage.getItem("userEmail") || "";
    if (email) {
      fetch(`${API_BASE}/tracking/access?user_email=${encodeURIComponent(email)}`)
        .then(r => r.json())
        .then(data => setCanUseTracking(!!data.allowed))
        .catch(() => setCanUseTracking(false));

      // ── Check activity-view access for this user (see activity_access.json) ──
      fetch(`${API_BASE}/activity/access?user_email=${encodeURIComponent(email)}`)
        .then(r => r.json())
        .then(data => setCanUseActivity(!!data.allowed))
        .catch(() => setCanUseActivity(false));
    }
  }, [navigate]);

  // --- AUTO DIGEST: Fetch on mount, covers all 7 days with no email gaps ---
  // Calls the .NET onedaymails endpoint (paginated EWS — no 700-email cap,
  // includes read emails). Backend caches result per-user per day so repeat
  // loads within the same calendar day are instant.
  useEffect(() => {
    const email = localStorage.getItem("userEmail");
    if (!email) return;
    setDigestLoading(true);
    fetch(`${API_BASE}/auto-digest?user_email=${encodeURIComponent(email)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data?.digest?.length > 0) {
          setAutoDigest(data);
        }
      })
      .catch(err => {
        console.warn("Auto-digest fetch failed:", err.message);
      })
      .finally(() => {
        setDigestLoading(false);
      });
  }, []);

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
    // ✅ FIX: Guard against double execution (React.StrictMode + multiple useEffects)
    if (hasInitiallyFetched.current) {
      console.log("⏭️ Skipping duplicate initial fetch");
      return;
    }
    
    hasInitiallyFetched.current = true;
    console.log("🚀 Initial dashboard load");
    fetchAndAnalyze(false);

    // After first successful load, set sync time
    setLastSyncTime(Date.now());
  }, []);

  // ✅ START IDLE TIMER WHEN DASHBOARD MOUNTS
  useEffect(() => {
    console.log("⏱️ Starting idle timer");
    markUserActive();
  }, []);

  // ── ACTIVITY HEARTBEAT — reuses the idle-detection state above so "active
  // hours" means exactly what it says: only pings while the user is actually
  // interacting, not just sitting logged in overnight. Every logged-in user
  // reports their own activity (no access check on the ping itself — that
  // matches them already being able to see their own inbox); who can VIEW
  // everyone's summary is gated separately, server-side, via
  // activity_access.json.
  useEffect(() => {
    const userEmail = localStorage.getItem("userEmail") || "";
    if (!userEmail) return;

    const sendPing = () => {
      axios.post(`${API_BASE}/activity/ping`, {
        user_email: userEmail,
        device_id: getDeviceId(),
        device_label: getDeviceLabel(),
      }).catch(() => {}); // best-effort — a missed heartbeat just means one fewer sample
    };

    if (isIdle) return; // paused while idle — no interval, no immediate ping

    sendPing(); // one right away so "active now" doesn't wait a full interval
    const interval = setInterval(sendPing, 60 * 1000);
    return () => clearInterval(interval);
  }, [isIdle]);

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
  // Restore selected email after a refresh — but only update AI fields
  // (category, summary, priority) so the user's reply draft and parsed
  // thread state are preserved. Replacing the entire object would trigger
  // useEffect([selectedEmail]) which resets parsedThread and clears replyDraft.
  const restoreSelectionFields = (data, currentSelectedId) => {
    if (!currentSelectedId) return;
    const updatedEmail = data.find(e => (e.id || e.messageId) === currentSelectedId);
    if (!updatedEmail) return;
    setSelectedEmail(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        category:  updatedEmail.category  || prev.category,
        summary:   updatedEmail.summary   || prev.summary,
        priority:  updatedEmail.priority  || prev.priority,
        isRead:    updatedEmail.isRead     ?? prev.isRead,
      };
    });
  };

  const fetchAndAnalyze = async (arg) => {
    const silent = arg === true;
    const currentSelectedId = selectedEmailId; // Capture current ID

    console.log(
      silent ? "🤫 Soft refresh triggered" : "🔁 Manual refresh triggered"
    );

    if (silent) {
      setIsSoftSyncing(true);
    }

    if (!silent) {
      setInboxReady(false);   // only block UI on manual refresh
      setInboxError(false);
      addToast("Syncing Inbox...", "loading");
      setLoading(true);
    }

    const userEmail = localStorage.getItem("userEmail");

    const fetchStats = () => {
      // Fetch exact triage stats from EWS — non-blocking background call
      axios.get(`${API_BASE}/mail-stats`, {
        params: { userEmail, count: 700 }
      }).then(statsRes => setMailStats(statsRes.data))
        .catch(err => console.warn("mail-stats fetch failed:", err.message));
    };

    const markSynced = () => {
      const now = new Date().toISOString();
      localStorage.setItem("lastSyncTime", now);
      setLastSyncTime(now);
    };

    try {
      if (silent) {
        // 🟢 SILENT AUTO-SYNC — the user is idle and not watching, so there's
        // no perceived wait to shave off. Fetch the full inbox in one shot
        // (as before) rather than risking a visible list-size flicker from
        // a two-phase merge while nobody asked for a faster paint.
        const res = await axios.get(`${API_BASE}/fetch-inbox`, {
          params: { email: userEmail, count: FULL_FETCH_COUNT },
          timeout: 130000
        });

        if (Array.isArray(res.data)) {
          await runAnalysis(res.data, true);
          fetchStats();
          restoreSelectionFields(res.data, currentSelectedId);
          markSynced();
        }
        return;
      }

      // 🔵 MANUAL / INITIAL REFRESH — the user is watching this one.
      // PHASE 1: small fast batch first, so the inbox paints almost instantly
      // instead of waiting on all 500 emails from the org server.
      const fastRes = await axios.get(`${API_BASE}/fetch-inbox`, {
        params: { email: userEmail, count: FAST_FETCH_COUNT },
        timeout: 30000
      });

      if (!Array.isArray(fastRes.data)) {
        addToast("Error: API returned unexpected format.", "error");
        setInboxError(true);
        setInboxReady(true);
        return;
      }

      addToast(`Loaded your latest ${fastRes.data.length} emails — analyzing…`, "success");
      setEmails(fastRes.data);
      setInboxReady(true);
      await runAnalysis(fastRes.data, false);
      restoreSelectionFields(fastRes.data, currentSelectedId);
      fetchStats();
      markSynced();
      setLoading(false);   // unblock the UI now — phase 2 continues quietly below

      // PHASE 2: fetch the full inbox in the background and merge it in.
      // Emails already shown (and already analyzed) win over the raw
      // re-fetched copy for the same id — dedupeById keeps the *last*
      // entry per id, and `prev` (already-analyzed) is placed last below.
      setIsFetchingFullInbox(true);
      try {
        const fullRes = await axios.get(`${API_BASE}/fetch-inbox`, {
          params: { email: userEmail, count: FULL_FETCH_COUNT },
          timeout: 130000
        });

        if (Array.isArray(fullRes.data)) {
          setEmails(prev => dedupeById([...fullRes.data, ...prev]));
          await runAnalysis(fullRes.data, true);   // silent=true → no second "Inbox loaded!" toast
          restoreSelectionFields(fullRes.data, currentSelectedId);
          markSynced();
        }
      } catch (err) {
        console.warn("Background full-inbox sync failed; fast batch remains shown:", err.message);
      } finally {
        setIsFetchingFullInbox(false);
      }
    } catch (err) {
      if (!silent) {
        addToast(`Sync Error: ${err.message}`, "error");
        setInboxError(true);
        setInboxReady(true);   // stop the infinite "Syncing inbox..." spinner
      }
    } finally {
      if (silent) setIsSoftSyncing(false);
      setLoading(false);
    }
  };

  // ── Sanitize helper ──
  const sanitizeEmails = (emailList) =>
    emailList.map(e => {
      if (Array.isArray(e.attachments)) {
        e.attachments = e.attachments.map(a => ({
          name: a.name, type: a.type, size: a.size,
          hash: a.hash, storage: a.storage,
          full_hash: a.full_hash || null, messageId: a.messageId,
          attachmentId: a.attachmentId || null
        }));
      }
      e.cc = Array.isArray(e.cc) ? e.cc : [];
      e.to = Array.isArray(e.to) ? e.to : [];
      e.category = (e.category || "NORMAL").toUpperCase();
      if (e.hasAttachments === undefined || e.hasAttachments === null) {
        e.hasAttachments = (e.attachments || []).length > 0;
      }
      return e;
    });

  const dedupeById = (list) =>
    Object.values(list.reduce((acc, e) => {
      const id = e.id || e.messageId;
      if (id) acc[id] = e;
      return acc;
    }, {}));

  // ── Stop any running poll ──
  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  // ── Poll /api/analysis-updates until done ──
  const startPolling = (userEmail) => {
    stopPolling();
    setIsAnalyzingBackground(true);

    let seenCount = 0;  // tracks how many results we've already merged

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE}/analysis-updates`, {
          params: { user_email: userEmail, since: seenCount }
        });
        const { status, new_results, total, report: updatedReport } = res.data;

        // ── Merge whatever arrived since last tick (even if still running) ──
        if (new_results && new_results.length > 0) {
          seenCount += new_results.length;

          setEmails(prev => {
            const merged = [...prev];
            new_results.forEach(newEmail => {
              const id = newEmail.id || newEmail.messageId;
              const idx = merged.findIndex(e => (e.id || e.messageId) === id);
              const sanitized = sanitizeEmails([newEmail])[0];
              if ((sanitized.hasAttachments === undefined || sanitized.hasAttachments === null)
                  && idx !== -1 && merged[idx].hasAttachments !== undefined) {
                sanitized.hasAttachments = merged[idx].hasAttachments;
              }
              if (idx !== -1) merged[idx] = sanitized;
              else merged.push(sanitized);
            });
            return dedupeById(merged);
          });

          // Silently update selectedEmail AI fields if it's among the new results.
          // Use functional update so we never replace the object — only patch fields —
          // which avoids triggering useEffect([selectedEmail]) and clearing the draft.
          setSelectedEmail(prev => {
            if (!prev) return prev;
            const prevId = prev.id || prev.messageId;
            const match = new_results.find(e => (e.id || e.messageId) === prevId);
            if (!match) return prev;
            return {
              ...prev,
              category: match.category || prev.category,
              summary:  match.summary  || prev.summary,
              priority: match.priority || prev.priority,
              isRead:   match.isRead   ?? prev.isRead,
            };
          });
        }

        // ── Stop polling only when fully done ──
        if (status === "done") {
          stopPolling();
          setIsAnalyzingBackground(false);
          if (updatedReport) {
            setReport(updatedReport);
            const metaCache = {
              lastSync: new Date().toISOString(),
              emailCount: total,
              briefingCount: updatedReport?.briefing_cards?.length || 0
            };
            localStorage.setItem("emailDashboardMeta", JSON.stringify(metaCache));
          }
        } else if (status === "error" || status === "none") {
          stopPolling();
          setIsAnalyzingBackground(false);
        }
      } catch (err) {
        console.error("Poll error:", err);
        stopPolling();
        setIsAnalyzingBackground(false);
      }
    }, 2000);  // poll every 2s for snappier updates
  };

  const runAnalysis = async (emailsToAnalyze, silent = false) => {
    const payload = emailsToAnalyze || emails;
    if (!payload || payload.length === 0) { setLoading(false); return; }

    const rawHasAttachments = {};
    (payload || []).forEach(e => {
      const id = e.id || e.messageId;
      if (id && e.hasAttachments !== undefined) rawHasAttachments[id] = e.hasAttachments;
    });

    try {
      const userEmail = localStorage.getItem("userEmail") || "default";
      const res = await axios.post(`${API_BASE}/analyze`, { emails: payload, user_email: userEmail });

      if (res.data.emails && Array.isArray(res.data.emails)) {
        const sanitized = sanitizeEmails(res.data.emails).map(e => {
          const id = e.id || e.messageId;
          if (id && (e.hasAttachments === undefined || e.hasAttachments === null)
              && rawHasAttachments[id] !== undefined) {
            e.hasAttachments = rawHasAttachments[id];
          }
          return e;
        });
        setEmails(dedupeById(sanitized));
        if (res.data.report) setReport(res.data.report);
      }

      if (res.data.analyzing) {
        const userEmail = localStorage.getItem("userEmail") || "default";
        startPolling(userEmail);
      }
      if (!silent) addToast("Recent emails ready — syncing the rest of your inbox…", "success");

    } catch (err) {
      console.error(err);
      addToast("Analysis Failed. Check console.", "error");
    } finally {
      setLoading(false);
    }
  };

  // --- THREAD PARSING (SIMPLIFIED) ---

  // Strip the Outlook quoted-reply chain from an HTML email body so only
  // the new reply text is shown. Mirrors the Python _extract_latest_html logic.
  // Split an Outlook HTML body into { visible, quoted }.
  // "visible" = the new reply content (above the separator).
  // "quoted"  = the <hr> + everything below it (the inline quoted chain).
  // If no separator is found the whole body is visible and quoted is "".
  const splitAtQuote = (html) => {
    if (!html) return { visible: html, quoted: '' };

    // 1. <hr> separator — desktop Outlook reply separator only.
    // Must have tabIndex or inline-block display style — this is how Outlook marks
    // its reply divider. Bare <hr> or signature <hr> tags are intentionally ignored
    // so they don't cut the visible body at a signature or footer line.
    const hrMatch = html.search(/<hr\b[^>]*(tabIndex|tabindex|style=["'][^"']*display\s*:\s*inline)[^>]*>/i);
    if (hrMatch > 0) return {
      visible: html.slice(0, hrMatch).trim(),
      quoted:  html.slice(hrMatch).trim()
    };

    // 2. divRplyFwdMsg — OWA
    const divMatch = html.search(/<div[^>]+id=["']?divRplyFwdMsg["']?/i);
    if (divMatch > 0) return {
      visible: html.slice(0, divMatch).trim(),
      quoted:  html.slice(divMatch).trim()
    };

    // 3. Bolded From: header
    const fromMatch = html.search(/<(?:b|strong)[^>]*>\s*From:\s*<\/(?:b|strong)>/i);
    if (fromMatch > 0) return {
      visible: html.slice(0, fromMatch).trim(),
      quoted:  html.slice(fromMatch).trim()
    };

    return { visible: html, quoted: '' };
  };

  useEffect(() => {
    const fetchParsedThread = async () => {
      if (!selectedEmail) return;
      setThreadLoading(true);
      setParsedThread([]);
      
      // If email has messages array, use it; otherwise treat as single message
      if (selectedEmail.messages && Array.isArray(selectedEmail.messages)) {
        // .NET returns oldest→newest — reverse so newest is idx 0 (LATEST), matching Outlook order
        const sorted = [...selectedEmail.messages].sort((a, b) => {
          try {
            return new Date(b.received || b.Received || b.date || b.received_at || 0)
                 - new Date(a.received || a.Received || a.date || a.received_at || 0);
          } catch { return 0; }
        });
        const segments = sorted.map((msg, idx) => {
          const { visible, quoted } = splitAtQuote(msg.body || msg.Body || "");
          const msgFrom = msg.from || msg.From || "Unknown";
          const msgDate = msg.received || msg.received_at || msg.date || msg.Received || "";
          return {
            type: idx === 0 ? 'latest' : 'history',
            header: `From: ${msgFrom} | ${formatDate(msgDate)}`,
            content: visible,
            quotedContent: quoted,
            attachments: msg.attachments || msg.Attachments || []
          };
        });
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
  }, [selectedEmailId, threadKey]);  // threadKey bumped after enrichment so full messages[] are used
                           //   re-trigger this and wipe the user's draft

  const generateAiReply = async () => {
    if (!selectedEmail) return;
    setReplyLoading(true);
    setReplyDraft("");
    try {
      const userName = localStorage.getItem("loggedInUser") || "User";
      const res = await axios.post(`${API_BASE}/reply`, {
        email_body: selectedEmail.body || (selectedEmail.messages ? selectedEmail.messages[0].body : ""),
        sender: selectedEmail.from || "Unknown",
        subject: selectedEmail.subject || "",
        user_name: userName
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

  // ── Flag / correction submission ─────────────────────────────────────────
  // Shared across all users. Kicks into the AI prompt once ≥2 similar flags exist.
  const submitCorrection = useCallback(async (email, newCategory, reason) => {
    const emailId = email.id || email.messageId;
    setFlagSubmitting(s => ({ ...s, [emailId]: true }));
    try {
      const fromRaw = email.from || email.sender || '';
      const fromDomain = fromRaw.includes('@')
        ? fromRaw.split('@')[1]?.replace(/[>]/g, '').trim()
        : '';
      const bodyText = (email.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

      const res = await fetch(`${API_BASE}/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId:         email.messageId || email.id || '',
          subject:           email.subject   || '',
          fromDomain,
          bodySnippet:       bodyText.slice(0, 300),
          originalCategory:  (email.category || 'NORMAL').toUpperCase(),
          correctedCategory: newCategory,
          reason:            reason || '',
        }),
      });
      if (res.ok) {
        setFlagSuccess(s => ({ ...s, [emailId]: true }));
        // Close dropdown after a short success moment, then clear success state
        setTimeout(() => {
          setFlagOpen(null);
          setFlagSuccess(s => ({ ...s, [emailId]: false }));
        }, 2200);
      }
    } catch (e) {
      console.error('submitCorrection error:', e);
    } finally {
      setFlagSubmitting(s => ({ ...s, [emailId]: false }));
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("jimAuthSession");
    localStorage.removeItem("emailDashboardMeta");
    localStorage.removeItem("loggedInUser");
    localStorage.removeItem("sessionUser");
    localStorage.removeItem("userEmail");
    window.location.href = "/login";
  };

  // ✅ REMOVED: handleInlineReplyToggle 
  // DashboardView manages inline reply state internally per-card

  // ✅ Optimistically mark email as replied
  const markAsReplied = (messageId, value = true) => {
    setEmails(prev =>
      prev.map(e =>
        (e.id === messageId || e.messageId === messageId)
          ? { ...e, hasReplied: value }
          : e
      )
    );
  };

  // ✅ Helper: Mark email as read by ID (for optimistic reply flow)
  const markAsReadById = (messageId, value = true) => {
    setEmails(prev =>
      prev.map(e =>
        (e.id === messageId || e.messageId === messageId)
          ? { ...e, isRead: value }
          : e
      )
    );
    // Keep the open detail view's own snapshot in sync too (same gap as markAsRead).
    setSelectedEmail(prev => {
      if (!prev) return prev;
      const prevId = prev.id || prev.messageId;
      return prevId === messageId ? { ...prev, isRead: value } : prev;
    });
  };

  // ✅ UPDATED FUNCTION: Mark email as read + update backend cache
  const markAsRead = async (emailObj) => {
    try {
      const userEmail = localStorage.getItem("userEmail") || "";

      // For threaded emails, get ALL message IDs; for singles, just the one
      const messageIds = Array.isArray(emailObj.allMessageIds) && emailObj.allMessageIds.length > 0
        ? emailObj.allMessageIds
        : [emailObj.id || emailObj.messageId].filter(Boolean);

      if (messageIds.length === 0) {
        console.warn("⚠️ markAsRead: no messageIds found");
        return;
      }

      // STEP 1: Optimistically update frontend for ALL IDs immediately
      setEmails(prev =>
        prev.map(e => {
          const eId = e.id || e.messageId;
          return messageIds.includes(eId) ? { ...e, isRead: true } : e;
        })
      );
      console.log(`✅ Frontend updated: marked as read (${messageIds.length} messages):`, messageIds);

      // STEP 1b: The detail-view "Mark Read" button reads selectedEmail.isRead,
      // which is a separate snapshot from the `emails` list updated above — without
      // this it stays stale until the next refresh cycle, so the button never
      // flips to green/disabled right after the click.
      setSelectedEmail(prev => {
        if (!prev) return prev;
        const prevId = prev.id || prev.messageId;
        return messageIds.includes(prevId) ? { ...prev, isRead: true } : prev;
      });

      // STEP 2: Fire backend call for every message ID (in parallel)
      const results = await Promise.allSettled(
        messageIds.map(messageId =>
          axios.post(
            `${import.meta.env.VITE_API_URL || "http://localhost:8000/api"}/mark-read`,
            { email: userEmail, messageId }
          )
        )
      );

      const failed = results.filter(r => r.status === "rejected");
      const succeeded = results.length - failed.length;

      if (failed.length === 0) {
        console.log(`✅ Backend updated: all ${succeeded} messages marked as read`);
        addToast(
          messageIds.length > 1
            ? `Thread marked as read (${succeeded} messages)`
            : "Email marked as read",
          "success"
        );
      } else {
        console.warn(`⚠️ ${failed.length} of ${results.length} mark-read calls failed`);
        addToast(`Marked ${succeeded} of ${results.length} messages as read`, "info");

        // Revert only the ones that failed
        const failedIds = failed.map((_, i) => messageIds[i]).filter(Boolean);
        setEmails(prev =>
          prev.map(e => {
            const eId = e.id || e.messageId;
            return failedIds.includes(eId) ? { ...e, isRead: false } : e;
          })
        );
      }

    } catch (err) {
      console.error("❌ Failed to mark as read:", err);
      addToast("Failed to mark email as read", "error");

      // Revert all
      const messageIds = Array.isArray(emailObj.allMessageIds) && emailObj.allMessageIds.length > 0
        ? emailObj.allMessageIds
        : [emailObj.id || emailObj.messageId].filter(Boolean);

      setEmails(prev =>
        prev.map(e => {
          const eId = e.id || e.messageId;
          return messageIds.includes(eId) ? { ...e, isRead: false } : e;
        })
      );
    }
  };

  const openFiles = (title, fileList) => {
    const safeList = Array.isArray(fileList) ? fileList : [];
    setFileModalData({ title, files: safeList });
  };

  // ── fetchEmailDetails ─────────────────────────────────────────────────────
  // Fetches full email on click: populates TO, CC, FROM and attachments
  // with attachmentId from /api/email-details → .NET onemail.
  // The inbox fetch omits TO/CC for speed — this restores them.
  const fetchEmailDetails = async (email) => {
    const messageId = email?.id || email?.messageId;
    const userEmail = localStorage.getItem("userEmail") || "";
    if (!messageId || !userEmail) return email;
    try {
      const res = await axios.get(`${API_BASE}/email-details`, {
        params: { messageId, userEmail }
      });
      const d    = res.data;
      const atts = Array.isArray(d.attachments) ? d.attachments : [];

      // Preserve full thread returned by the updated .NET GetOneMail.
      // Without this merge, messages[] was dropped and parsedThread fell back
      // to the single-body parse-thread path, showing only 1 card.
      const mergedMessages = Array.isArray(d.messages) && d.messages.length > 0
        ? d.messages
        : (Array.isArray(email.messages) && email.messages.length > 0 ? email.messages : undefined);

      return {
        ...email,
        from:           d.from  || email.from,
        to:             Array.isArray(d.to)  ? d.to  : (email.to  || []),
        cc:             Array.isArray(d.cc)  ? d.cc  : (email.cc  || []),
        body:           d.body  || email.body,
        attachments:    atts,
        hasAttachments: atts.length > 0,
        ...(mergedMessages ? { messages: mergedMessages } : {}),
      };
    } catch (err) {
      console.error("fetchEmailDetails failed:", err);
      return email;
    }
  };

  const handleFileDownload = async (file) => {
    const userEmail = localStorage.getItem("userEmail") || "";
    if (!file.attachmentId) {
      addToast("Attachment not ready — reopen the email and try again.", "error");
      return;
    }
    addToast(`Downloading ${file.name}...`, "loading");
    try {
      const res = await axios.post(
        `${API_BASE}/download-attachment`,
        { messageId: file.messageId, attachmentId: file.attachmentId, name: file.name, type: file.type, userEmail },
        { responseType: "blob" }
      );
      const blob = new Blob([res.data], { type: file.type || "application/octet-stream" });
      const link = document.createElement("a");
      link.href = window.URL.createObjectURL(blob);
      link.download = file.name;
      link.click();
      window.URL.revokeObjectURL(link.href);
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
      report={augmentedReport}
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
      addToast={addToast}
      isProfileOpen={isProfileOpen}
      setIsProfileOpen={setIsProfileOpen}
      
      // --- NEW PROPS PASSED DOWN ---
      lastSyncTime={lastSyncTime}
      inboxReady={inboxReady}
      inboxError={inboxError}
      isSoftSyncing={isSoftSyncing}
      autoSyncEnabled={autoSyncEnabled}
      setAutoSyncEnabled={setAutoSyncEnabled}
      isAnalyzingBackground={isAnalyzingBackground}
      isFetchingFullInbox={isFetchingFullInbox}

      // Digest — complete 7-day EWS-sourced digest (no email gaps)
      autoDigest={autoDigest}
      digestLoading={digestLoading}

      // Sender filter (Insights → Inbox navigation)
      senderFilter={senderFilter}
      setSenderFilter={setSenderFilter}
      canUseTracking={canUseTracking}
      canUseActivity={canUseActivity}

      // Flag / AI correction
      flagOpen={flagOpen}
      setFlagOpen={setFlagOpen}
      flagSubmitting={flagSubmitting}
      flagSuccess={flagSuccess}
      submitCorrection={submitCorrection}

      // Selection & Modals
      selectedEmail={selectedEmail}
      
      // On every click: show email immediately then enrich with full TO/CC/attachments
      setSelectedEmail={async (email) => {
        setSelectedEmail(email);
        setSelectedEmailId(email ? (email.id || email.messageId) : null);
        if (email) {
          const enriched = await fetchEmailDetails(email);
          setSelectedEmail(enriched);
          setSelectedEmailId(enriched ? (enriched.id || enriched.messageId) : null);
          // Bump threadKey so the parsedThread useEffect always re-fires after
          // enrichment — even when the emailId didn't change — ensuring the full
          // messages[] array (returned by the updated .NET GetOneMail) is used
          // to build the conversation thread instead of the single-body fallback.
          if (enriched?.messages?.length > 0) {
            setThreadKey(k => k + 1);
          }
        }
      }}
      
      triageStats={triageStats}
      
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
      groupedEmails={sortedEmails}
      
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
      getEffectiveReceivedAt={getEffectiveReceivedAt}
      markAsReplied={markAsReplied}
      markAsReadById={markAsReadById}
    />
  );
}

export default Dashboard;