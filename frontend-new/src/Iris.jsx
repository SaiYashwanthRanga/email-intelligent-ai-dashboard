import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X, Send, Copy, Check, RotateCcw, ShieldCheck, CornerDownLeft, Inbox } from "lucide-react";

/**
 * Iris — Inbox Assistant (frontend shell)
 * ─────────────────────────────────────────────────────────────────────────
 * Floating chat-widget pattern (Intercom/Drift/Zendesk style): a circular
 * button pinned to the bottom-right corner of the page, and a compact
 * popup window that grows up from that corner when clicked.
 *
 * IMPORTANT: rendered via a React Portal straight into document.body.
 * `position: fixed` is only "fixed to the viewport" if no ancestor has a
 * transform/filter/will-change style — but DashboardView.jsx's .top-bar
 * has `animation: fadeSlideUp ... both`, and the `both` fill-mode keeps
 * the animation's final transform applied forever, which creates a new
 * containing block and breaks fixed positioning for anything nested
 * inside it. Portaling to document.body sidesteps that entirely, so it
 * doesn't matter which ancestor <Iris /> is mounted under.
 *
 * STATUS: Phase 3 — tool-calling on the backend. <Iris /> itself barely
 * changed for this phase: it now also sends user_email (see sendToIris
 * below) so the backend's tools can look up the right person's tracking
 * data / analyzed-email cache. Everything else — the tool-calling loop,
 * draft_reply / check_tracking_status / search_emails — runs entirely
 * server-side inside the single /api/iris/chat request, so from this
 * component's point of view it's still just "POST a message, get back
 * a reply string." See iris_service.py for the actual tool logic.
 *
 * Small addition on top of Phase 3: every Iris (not user) message now
 * has a Copy button, matching the same clipboard pattern Dashboard.js
 * already uses for its own AI-reply box (write to clipboard, brief
 * inline "Copied" feedback, fail silently if clipboard access isn't
 * available). This is deliberately simple — it copies whatever text is
 * in that message bubble, with no attempt to detect "is this actually
 * a draft" separately from the rest of Iris's reply.
 *
 * Uses only existing CSS custom properties (--bg-card, --border-color,
 * --neon-cyan, --glow-gradient, etc.) so it automatically matches both
 * the dark and light themes already defined in App.css, and reuses the
 * `fadeSlideUp` keyframe already defined in animations.css for the
 * "pops up from the bottom" entrance.
 */

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

const GREETING =
  "Hi, I'm Iris. Ask me to summarize a thread, draft a reply, or catch you up on what you missed.";

// Local fallbacks in case the caller doesn't pass the helper props —
// mirrors the logic in Dashboard.js so behavior stays consistent even
// if this component is ever used somewhere those props aren't wired up.
const fallbackGetParticipantDisplay = (email) =>
  email?.from || email?.sender || "Unknown Sender";

const fallbackGetEffectiveReceivedAt = (email) => {
  const raw = email?.received_at || email?.received;
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(0);   // sentinel: "no valid date"
};

// Caps keep the payload small/fast/cheap regardless of mailbox size —
// a 700-email inbox should send the same small snapshot as a 20-email one.
const MAX_THREADS = 25;
// Send more than the snapshot can hold; the backend trims to whatever fits
// its character budget and reports the real coverage to the model. Sending
// only 25 meant it could never fill the budget even when the inbox was big.
const MAX_RECENT_EMAILS = 60;

// Drag/position constants for the floating button and its panel.
const FAB_POS_KEY = "irisFabY";
const FAB_SIZE = 56;        // matches .iris-fab width/height
const PANEL_HEIGHT = 620;   // matches .iris-popup height
const EDGE_GAP = 16;        // keep clear of the viewport edges
const DRAG_THRESHOLD = 4;   // px of travel before a click counts as a drag

// Starter prompts for an empty conversation. Chosen to show what Iris is
// actually good at now that it can open and read full email text, rather
// than leaving people to guess at a blank input box.
// The system prompt asks for plain text, but the model still emits markdown
// often enough that "**Normal Updates:**" was showing up literally on screen.
// Rather than trusting it to comply, render the common markers properly:
// **bold** becomes bold, ### headings lose their hashes, and "- " list items
// become real bullets. Built as React nodes, never raw HTML, so model output
// can't inject markup.
function renderRichText(text) {
  const lines = String(text ?? "").split("\n");
  return lines.map((line, li) => {
    let clean = line.replace(/^\s{0,3}#{1,6}\s+/, "");           // ### Heading
    clean = clean.replace(/^(\s*)[-*]\s+/, "$1• ");              // - item
    const parts = clean.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return (
      <span key={li} className="iris-line">
        {parts.map((p, pi) =>
          /^\*\*[^*]+\*\*$/.test(p)
            ? <strong key={pi}>{p.slice(2, -2)}</strong>
            : <span key={pi}>{p}</span>
        )}
        {li < lines.length - 1 ? "\n" : null}
      </span>
    );
  });
}

const SUGGESTIONS = [
  "Catch me up on what I missed today",
  "What needs my reply first?",
  "Who hasn't replied to me yet?",
  "Summarise the latest thread from Deepa",
];

// Shown instead of the inbox-wide prompts when the chat was opened from a
// specific email. Opening Iris on an email and being offered "catch me up
// on today" was the wrong menu entirely — these lead with replying, which
// is what you actually want from the email you're looking at.
const FOCUS_SUGGESTIONS = [
  "Draft a reply to this",
  "Suggest 3 different ways I could reply",
  "What are they actually asking me for?",
  "Summarise this thread",
];

// ─── SINGLE INTEGRATION SEAM ───────────────────────────────────────────────
// Calls the real backend. Phase 3: also sends user_email (not just the
// display name) since the backend's tools — tracking status, email
// search — look data up by email, not by display name.
// Fired by "Ask Iris" buttons elsewhere in the app. A window event rather
// than prop drilling: Iris is mounted once, deep inside the dashboard, and
// the buttons live on cards several layers away.
export const IRIS_ASK_EVENT = "iris:ask";
export const IRIS_USE_DRAFT_EVENT = "iris:use-draft";

// Iris wraps a draft in conversational packaging — "Here's a draft you can
// send:", --- rules, "Feel free to modify it!". Pasting all that into the
// reply box would mean deleting it by hand every time, so strip the wrapper
// and keep the letter. Falls back to the whole message if nothing is left,
// since a bad guess must never lose the text.
export function extractDraftBody(text) {
  let lines = String(text ?? "").split("\n");

  const isRule = (l) => /^\s*([-—_*]\s*){3,}\s*$/.test(l);
  const isPreamble = (l) => /^\s*(here'?s|here is|sure|of course)\b.*:\s*$/i.test(l)
                         || /^\s*(draft|suggested reply|reply)\s*:\s*$/i.test(l);
  const isTrailer = (l) => /^\s*(feel free|let me know|hope this helps|you can (edit|modify|adjust))\b/i.test(l);

  while (lines.length && (isPreamble(lines[0]) || isRule(lines[0]) || !lines[0].trim())) lines.shift();
  while (lines.length && (isTrailer(lines[lines.length - 1]) || isRule(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();

  // Drop a leading "Subject: ..." line — the reply already has its subject.
  if (lines.length && /^\s*subject\s*:/i.test(lines[0])) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }

  const body = lines.join("\n").trim();
  return body || String(text ?? "").trim();
}

// Push a draft into the reply composer. Same window-event approach as
// askIrisAbout: the composer lives several layers away from this panel.
export function useDraftInComposer(text) {
  window.dispatchEvent(new CustomEvent(IRIS_USE_DRAFT_EVENT, {
    detail: { text: extractDraftBody(text) },
  }));
}
export function askIrisAbout(email) {
  const messageId = email?.id || email?.messageId;
  if (!messageId) return;
  window.dispatchEvent(new CustomEvent(IRIS_ASK_EVENT, {
    detail: { messageId, subject: email?.subject || "this email" },
  }));
}

export async function fetchOutbox(userEmail) {
  const res = await fetch(`${API_BASE}/outbox?user_email=${encodeURIComponent(userEmail)}`);
  if (!res.ok) throw new Error("Couldn't read the outbox");
  return res.json();
}

export async function sendOutboxItem(userEmail, id) {
  const res = await fetch(`${API_BASE}/outbox/send`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_email: userEmail, id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "Still couldn't send.");
  return data;
}

export async function discardOutboxItem(userEmail, id) {
  await fetch(`${API_BASE}/outbox/${encodeURIComponent(id)}?user_email=${encodeURIComponent(userEmail)}`,
    { method: "DELETE" });
}

async function confirmIrisAction(proposal) {
  const res = await fetch(`${API_BASE}/iris/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposal),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || "That didn't go through.");
  return data;
}

async function sendToIris(message, history, inboxContext, focusMessageId) {
  const userName = localStorage.getItem("loggedInUser") || "User";
  const userEmail = localStorage.getItem("userEmail") || "default";

  const res = await fetch(`${API_BASE}/iris/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      user_name: userName,
      user_email: userEmail,
      inbox_context: inboxContext || null,
      focus_message_id: focusMessageId || null,
    }),
  });

  if (!res.ok) {
    // Surface what the server actually said — it distinguishes "the AI
    // service is unreachable" from "the dashboard is broken", which are
    // very different things to go and check.
    let detail = "";
    try { detail = (await res.json())?.detail || ""; } catch (_) { /* no body */ }
    throw new Error(detail || `Iris chat request failed (${res.status})`);
  }

  const data = await res.json();
  // steps = what Iris did; proposals = actions awaiting confirmation
  return { text: data.reply, steps: data.steps || [], proposals: data.proposals || [] };
}

const Iris = ({
  emails = [],
  report = null,
  triageStats = null,
  getParticipantDisplay,
  getEffectiveReceivedAt,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([{ role: "iris", text: GREETING }]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [usedIndex, setUsedIndex] = useState(null);   // "Added" feedback on Use-as-reply   // index of message showing "Copied" feedback

  const containerRef = useRef(null);
  const listRef = useRef(null);
  const textareaRef = useRef(null);

  // ── Draggable vertical position ────────────────────────────────────────
  // The button used to be pinned to the middle of the right edge, where it
  // sat on top of whatever you were reading. Drag it up or down to park it
  // somewhere out of the way; the panel follows and the spot is remembered.
  const [fabY, setFabY] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem(FAB_POS_KEY));
      if (Number.isFinite(saved)) return saved;
    } catch (_) { /* storage blocked — fall through to the default */ }
    return window.innerHeight / 2;
  });
  const dragRef = useRef({ active: false, moved: false, offset: 0 });

  // The email the chat was opened from, if any. A ref rather than state so
  // handleSend always reads the current value without being re-created.
  const focusRef = useRef(null);
  const [focusSubject, setFocusSubject] = useState(null);
  const [actionState, setActionState] = useState({});   // actionId -> "running" | "done" | error text
  const [outbox, setOutbox] = useState(null);           // { pending_auto, awaiting_send, items }
  const [showOutbox, setShowOutbox] = useState(false);
  const [sendingId, setSendingId] = useState(null);

  // Poll the outbox so held messages surface without a reload. Cheap: a
  // small JSON read, and only while the panel is open.
  useEffect(() => {
    const userEmail = localStorage.getItem("userEmail") || "default";
    let alive = true;
    const load = () => fetchOutbox(userEmail).then((d) => { if (alive) setOutbox(d); }).catch(() => {});
    load();
    const t = setInterval(load, isOpen ? 15000 : 60000);
    return () => { alive = false; clearInterval(t); };
  }, [isOpen]);

  const refreshOutbox = () => {
    const userEmail = localStorage.getItem("userEmail") || "default";
    fetchOutbox(userEmail).then(setOutbox).catch(() => {});
  };

  const handleSendQueued = async (item) => {
    const userEmail = localStorage.getItem("userEmail") || "default";
    setSendingId(item.id);
    try {
      await sendOutboxItem(userEmail, item.id);
      refreshOutbox();
    } catch (err) {
      setActionState((s2) => ({ ...s2, [item.id]: err.message }));
    } finally {
      setSendingId(null);
    }
  };

  const handleDiscardQueued = async (item) => {
    const userEmail = localStorage.getItem("userEmail") || "default";
    await discardOutboxItem(userEmail, item.id);
    refreshOutbox();
  };

  // "Ask Iris about this email" from anywhere in the app.
  useEffect(() => {
    const onAsk = (e) => {
      const { messageId, subject } = e.detail || {};
      if (!messageId) return;
      focusRef.current = messageId;
      setFocusSubject(subject || "this email");
      setMessages([{ role: "iris", text: `Looking at "${subject}". What would you like to know or do with it?` }]);
      setIsOpen(true);
      setTimeout(() => textareaRef.current?.focus(), 80);
    };
    window.addEventListener(IRIS_ASK_EVENT, onAsk);
    return () => window.removeEventListener(IRIS_ASK_EVENT, onAsk);
  }, []);

  const handleConfirm = async (proposal) => {
    setActionState((s) => ({ ...s, [proposal.actionId]: "running" }));
    try {
      const res = await confirmIrisAction(proposal);
      setActionState((s) => ({ ...s, [proposal.actionId]: "done" }));
      setMessages((prev) => [...prev, { role: "iris", text: res.message || "Done." }]);
    } catch (err) {
      setActionState((s) => ({ ...s, [proposal.actionId]: err.message || "Failed" }));
    }
  };

  const clampFabY = useCallback((y) => {
    const half = FAB_SIZE / 2;
    return Math.min(Math.max(y, half + EDGE_GAP), window.innerHeight - half - EDGE_GAP);
  }, []);

  // Keep it on screen when the window is resized or the sidebar reflows.
  useEffect(() => {
    const onResize = () => setFabY((y) => clampFabY(y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampFabY]);

  const startDrag = useCallback((clientY) => {
    dragRef.current = { active: true, moved: false, offset: clientY - fabY };

    const move = (cy) => {
      if (!dragRef.current.active) return;
      const next = clampFabY(cy - dragRef.current.offset);
      // A few pixels of travel separates "dragging it somewhere" from the
      // small wobble of an ordinary click, which must still open the panel.
      if (Math.abs(cy - dragRef.current.offset - fabY) > DRAG_THRESHOLD) {
        dragRef.current.moved = true;
      }
      setFabY(next);
    };
    const end = () => {
      dragRef.current.active = false;
      setFabY((y) => {
        try { localStorage.setItem(FAB_POS_KEY, String(y)); } catch (_) { /* non-critical */ }
        return y;
      });
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", end);
    };
    const onMouseMove = (e) => move(e.clientY);
    const onTouchMove = (e) => { if (e.touches[0]) move(e.touches[0].clientY); };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", end);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", end);
  }, [fabY, clampFabY]);

  // Panel sits centred on the button, but never hangs off either edge.
  const panelTop = useMemo(() => {
    const panelH = Math.min(PANEL_HEIGHT, window.innerHeight - EDGE_GAP * 2);
    const ideal = fabY - panelH / 2;
    return Math.min(Math.max(ideal, EDGE_GAP), window.innerHeight - panelH - EDGE_GAP);
  }, [fabY]);

  const getSender = getParticipantDisplay || fallbackGetParticipantDisplay;
  const getReceived = getEffectiveReceivedAt || fallbackGetEffectiveReceivedAt;

  // Standing brief, derived from the inbox the dashboard already loaded.
  // No API call, so it's on screen the instant the panel opens; each line
  // is a shortcut into the question it raises.
  //
  // Must stay BELOW getReceived: this memo names it in its dependency
  // array, which is evaluated during render, so declaring it any earlier
  // hits the temporal dead zone and takes the whole app down with a blank
  // page. A bundler won't catch that — it builds clean and fails at runtime.
  const brief = useMemo(() => {
    const list = Array.isArray(emails) ? emails : [];
    if (!list.length) return null;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const urgent = list.filter((e) => ["URGENT", "PRIORITY"].includes((e?.category || "").toUpperCase())).length;
    const today = list.filter((e) => { try { return getReceived(e).getTime() >= since; } catch { return false; } }).length;
    const unread = list.filter((e) => e?.isRead === false).length;

    const rows = [];
    if (urgent) rows.push({ color: "#f87171", text: `${urgent} urgent or priority`, ask: "What is urgent right now?" });
    if (today) rows.push({ color: "#00d9ff", text: `${today} arrived in the last 24 hours`, ask: "Catch me up on what I missed today" });
    if (unread) rows.push({ color: "#fbbf24", text: `${unread} unread`, ask: "What needs my reply first?" });
    return rows.length ? rows : null;
  }, [emails, getReceived]);

  // ── Build the compact "inbox snapshot" sent alongside each message ──
  // Recomputed only when the underlying inbox data actually changes, not
  // on every keystroke/render. Deliberately excludes full email bodies —
  // only short AI-generated summaries that already exist on each email.
  const inboxContext = useMemo(() => {
    const safeEmails = Array.isArray(emails) ? emails : [];

    const stats = {
      total_emails: triageStats?.vol_emails ?? safeEmails.length,
      unread: triageStats?.total_unread ?? safeEmails.filter((e) => e?.isRead === false).length,
      attachments: triageStats?.att_total ?? 0,
    };

    const threads = (report?.briefing_cards || [])
      .slice(0, MAX_THREADS)
      .map((c) => ({
        subject: c?.subject || c?.topic || "No Subject",
        category: c?.category || "NORMAL",
        summary: c?.summary || "",
        message_count: c?.thread_count || 1,
      }));

    const recentEmails = [...safeEmails]
      .sort((a, b) => getReceived(b) - getReceived(a))
      .slice(0, MAX_RECENT_EMAILS)
      .map((e) => {
        let receivedIso = null;
        try {
          const d = getReceived(e);
          if (d && d.getTime() > 0) receivedIso = d.toISOString();
        } catch (_) {
          // leave receivedIso as null — better than a misleading date
        }
        return {
          from: getSender(e),
          subject: e?.subject || "No Subject",
          category: e?.category || "NORMAL",
          summary: e?.summary || "",
          unread: e?.isRead === false,
          received_at: receivedIso,
        };
      });

    return { stats, threads, recent_emails: recentEmails };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emails, report, triageStats]);

  // Auto-scroll to newest message
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, thinking]);

  // Focus the input when the popup opens
  useEffect(() => {
    if (isOpen) setTimeout(() => textareaRef.current?.focus(), 50);
  }, [isOpen]);

  // Click-outside-to-close (same pattern as EmailAutocomplete's dropdown)
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (e) => { if (e.key === "Escape") setIsOpen(false); };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Same pattern as the existing "copy reply" button in Dashboard.js:
  // write to clipboard, show brief inline feedback, fail silently if
  // clipboard access is unavailable (permissions, non-HTTPS, etc.).
  const handleCopyMessage = async (text, index) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => {
        setCopiedIndex((prev) => (prev === index ? null : prev));
      }, 2000);
    } catch (err) {
      // silent fail, consistent with the existing copy button elsewhere
    }
  };

  const handleNewChat = () => {
    setMessages([{ role: "iris", text: GREETING }]);
    setInput("");
    // Drop the focused email too, otherwise a "new" chat silently keeps
    // answering about whatever was open when it started.
    focusRef.current = null;
    setFocusSubject(null);
    setActionState({});
    textareaRef.current?.focus();
  };

  // `preset` lets a suggestion chip send directly without going via the box.
  const handleSend = async (preset) => {
    const text = (typeof preset === "string" ? preset : input).trim();
    if (!text || thinking) return;

    const priorMessages = messages;   // history BEFORE this new message
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setThinking(true);

    try {
      const reply = await sendToIris(text, priorMessages, inboxContext, focusRef.current);
      setMessages((prev) => [...prev, {
        role: "iris",
        text: reply.text,
        steps: reply.steps,
        proposals: reply.proposals,
      }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "iris", text: err?.message || "Something went wrong reaching Iris. Try again in a moment." },
      ]);
    } finally {
      setThinking(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return createPortal(
    <div ref={containerRef}>
      <style>{IRIS_CSS}</style>

      {/* ─── POPUP (renders above the FAB, only when open) ─── */}
      {isOpen && (
        <div className="iris-popup" style={{ top: `${panelTop}px` }}>
          <div className="iris-header">
            <div className="iris-header-left">
              <div className="iris-header-icon"><Sparkles size={17} /></div>
              <div>
                <div className="iris-header-title">Iris</div>
                <div className="iris-header-sub">
                  <span className="iris-status-dot" /> Reads your inbox
                </div>
              </div>
            </div>
            <div className="iris-header-actions">
              {outbox?.awaiting_send > 0 && (
                <button
                  className="iris-outbox-pill"
                  onClick={() => setShowOutbox((v) => !v)}
                  title="Messages saved while Outlook was unreachable"
                >
                  <Inbox size={12} /> {outbox.awaiting_send}
                </button>
              )}
              {messages.length > 1 && (
                <button className="iris-icon-btn" onClick={handleNewChat} title="Start a new chat">
                  <RotateCcw size={14} />
                </button>
              )}
              <button className="iris-icon-btn" onClick={() => setIsOpen(false)} title="Close">
                <X size={15} />
              </button>
            </div>
          </div>

          {showOutbox && outbox?.items?.length > 0 && (
            <div className="iris-outbox">
              <div className="iris-outbox-head">
                Saved while Outlook was unreachable
              </div>
              {outbox.items.filter((i) => i.needsConfirm).map((item) => (
                <div key={item.id} className="iris-outbox-item">
                  <div className="iris-outbox-to">
                    To {(item.payload?.to || []).join(", ") || "—"}
                  </div>
                  <div className="iris-outbox-body">{item.payload?.body}</div>
                  {item.lastError && <div className="iris-outbox-err">{item.lastError}</div>}
                  {actionState[item.id] && <div className="iris-outbox-err">{actionState[item.id]}</div>}
                  <div className="iris-outbox-actions">
                    <button
                      className="iris-action-go"
                      disabled={sendingId === item.id}
                      onClick={() => handleSendQueued(item)}
                    >
                      {sendingId === item.id ? "Sending…" : "Send now"}
                    </button>
                    <button className="iris-outbox-discard" onClick={() => handleDiscardQueued(item)}>
                      Discard
                    </button>
                  </div>
                </div>
              ))}
              {outbox.pending_auto > 0 && (
                <div className="iris-outbox-auto">
                  {outbox.pending_auto} other change{outbox.pending_auto === 1 ? "" : "s"} will sync by itself
                </div>
              )}
            </div>
          )}

          <div className="iris-messages" ref={listRef}>
            {messages.map((m, i) => (
              <div
                key={i}
                className={`iris-bubble-row ${m.role === "user" ? "iris-row-user" : "iris-row-iris"}`}
              >
                {m.role === "user" ? (
                  <div className="iris-bubble-user">{m.text}</div>
                ) : (
                  <div className="iris-bubble-iris-wrap">
                    <div className="iris-msg-head">
                      <span className="iris-avatar"><Sparkles size={11} /></span>
                      <span className="iris-msg-name">Iris</span>
                    </div>
                    {/* What Iris actually did to answer — turns a silent
                        pause into visible work, and shows its receipts. */}
                    {m.steps?.length > 0 && (
                      <div className="iris-steps">
                        {m.steps.map((s, si) => (
                          <span key={si} className="iris-step"><Check size={9} /> {s}</span>
                        ))}
                      </div>
                    )}
                    <div className="iris-bubble-iris">{renderRichText(m.text)}</div>

                    {/* Actions wait here for an explicit press. Iris never
                        performs them itself — this button is the only path. */}
                    {m.proposals?.map((p) => {
                      const state = actionState[p.actionId];
                      const isSend = p.action === "send_reply" || p.action === "forward";
                      return (
                        <div key={p.actionId} className={`iris-action-card ${isSend ? "iris-action-send" : ""}`}>
                          <div className="iris-action-title">
                            <ShieldCheck size={13} /> Needs your confirmation
                          </div>
                          <div className="iris-action-summary">{p.summary}</div>
                          {isSend && (
                            <div className="iris-action-detail">
                              <div><span className="iris-action-label">To</span> {(p.to || []).join(", ") || "—"}</div>
                              {p.cc?.length > 0 && <div><span className="iris-action-label">Cc</span> {p.cc.join(", ")}</div>}
                              {p.subject && <div><span className="iris-action-label">Subject</span> {p.subject}</div>}
                              <div className="iris-action-body">{p.body}</div>
                            </div>
                          )}
                          {state === "done" ? (
                            <div className="iris-action-done"><Check size={12} /> Done</div>
                          ) : (
                            <div className="iris-action-buttons">
                              <button
                                className="iris-action-go"
                                disabled={state === "running"}
                                onClick={() => handleConfirm(p)}
                              >
                                {state === "running" ? "Working…" : (isSend ? "Send it" : "Confirm")}
                              </button>
                              {state && state !== "running" && (
                                <span className="iris-action-error">{state}</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="iris-msg-actions">
                      <button
                        className="iris-copy-btn"
                        onClick={() => handleCopyMessage(m.text, i)}
                        title="Copy this message"
                      >
                        {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                        {copiedIndex === i ? "Copied" : "Copy"}
                      </button>
                      {/* Drops the drafted letter straight into the reply box,
                          minus Iris's "here's a draft…" packaging. */}
                      <button
                        className="iris-use-btn"
                        onClick={() => { useDraftInComposer(m.text); setUsedIndex(i); setTimeout(() => setUsedIndex(null), 1800); }}
                        title="Put this into the reply box"
                      >
                        {usedIndex === i ? <Check size={12} /> : <CornerDownLeft size={12} />}
                        {usedIndex === i ? "Added" : "Use as reply"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {thinking && (
              <div className="iris-bubble-row iris-row-iris">
                <div className="iris-bubble-iris-wrap">
                  <div className="iris-msg-head">
                    <span className="iris-avatar"><Sparkles size={11} /></span>
                    <span className="iris-msg-name">Iris</span>
                  </div>
                  <div className="iris-bubble-iris iris-thinking-line">
                    <span className="iris-typing"><span /><span /><span /></span>
                    <span className="iris-thinking-text">Reading your inbox…</span>
                  </div>
                </div>
              </div>
            )}

            {/* Proactive brief. Computed from data the dashboard already has,
                so it's instant and costs no API call — Iris opens by telling
                you where you stand rather than waiting to be asked. */}
            {messages.length === 1 && !thinking && !focusRef.current && brief && (
              <div className="iris-brief">
                <div className="iris-brief-label">Where you stand</div>
                {brief.map((b) => (
                  <button key={b.text} className="iris-brief-row" onClick={() => handleSend(b.ask)}>
                    <span className="iris-brief-dot" style={{ background: b.color }} />
                    {b.text}
                  </button>
                ))}
              </div>
            )}

            {/* Starter prompts — shown only on a fresh conversation. Iris can
                now read full email text, so these lead with what it's newly
                good at rather than leaving people guessing at a blank box. */}
            {messages.length === 1 && !thinking && (
              <div className="iris-suggestions">
                <div className="iris-suggestions-label">
                  {focusSubject ? "About this email" : "Try asking"}
                </div>
                {(focusSubject ? FOCUS_SUGGESTIONS : SUGGESTIONS).map((s) => (
                  <button key={s} className="iris-chip" onClick={() => handleSend(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="iris-input-row">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Iris about your inbox..."
              rows={1}
              className="iris-textarea"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || thinking}
              className="iris-send-btn"
              title="Send"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ─── FLOATING TOGGLE BUTTON (drag vertically to reposition) ─── */}
      <button
        className="iris-fab"
        style={{ top: `${fabY}px` }}
        onMouseDown={(e) => { if (e.button === 0) startDrag(e.clientY); }}
        onTouchStart={(e) => { if (e.touches[0]) startDrag(e.touches[0].clientY); }}
        onClick={() => {
          // Suppress the click that ends a drag, so parking the button
          // doesn't also toggle the panel open or shut.
          if (dragRef.current.moved) { dragRef.current.moved = false; return; }
          setIsOpen((prev) => !prev);
        }}
        title={isOpen ? "Close Iris" : "Ask Iris — drag to move"}
      >
        {isOpen ? <X size={22} /> : <Sparkles size={22} />}
      </button>
    </div>,
    document.body
  );
};

export default Iris;

// ─── SCOPED STYLES ──────────────────────────────────────────────────────
// Kept in this file (not App.css) so this feature stays self-contained and
// easy to remove/iterate on without touching existing stylesheets.
const IRIS_CSS = `
.iris-fab {
  position: fixed;
  /* top is set inline from the dragged position; the -50% keeps that value
     meaning "centre of the button" rather than its top edge. */
  top: 50%;
  right: 24px;
  transform: translateY(-50%);
  touch-action: none;          /* let a touch drag move it, not scroll the page */
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--glow-gradient);
  color: #04121c;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 8px 28px rgba(0, 217, 255, 0.35), 0 2px 8px rgba(0,0,0,0.3);
  z-index: 2600;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.iris-fab:hover {
  transform: translateY(-50%) translateY(-2px) scale(1.04);
  box-shadow: 0 10px 32px rgba(0, 217, 255, 0.45), 0 2px 8px rgba(0,0,0,0.3);
}
.iris-fab:active { transform: translateY(-50%) scale(0.95); }

.iris-popup {
  position: fixed;
  /* top comes in inline, already clamped to the viewport and centred on the
     button. No translateY here: the entrance animation's final frame sets
     transform: translateY(0), which would silently cancel it — that's what
     left the panel hanging off the bottom of the screen. */
  top: 16px;
  right: 92px;
  width: 430px;
  max-width: calc(100vw - 32px);
  /* Never taller than the viewport allows. dvh accounts for mobile browser
     chrome; the vh line is the fallback for browsers without dvh. */
  height: min(620px, calc(100vh - 48px));
  height: min(620px, calc(100dvh - 48px));
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  background: rgba(16, 18, 24, 0.92);
  backdrop-filter: blur(40px) saturate(160%);
  -webkit-backdrop-filter: blur(40px) saturate(160%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,217,255,0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2600;
  animation: fadeSlideUp 0.28s cubic-bezier(0.2, 0, 0, 1) both;
}

.iris-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 2px solid var(--border-color);
  background: var(--bg-main);
  flex-shrink: 0;
}
.iris-header-left { display: flex; align-items: center; gap: 11px; }
.iris-header-actions { display: flex; align-items: center; gap: 4px; }
.iris-icon-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.iris-icon-btn:hover {
  background: rgba(255,255,255,0.07);
  border-color: rgba(255,255,255,0.12);
  color: var(--text-primary);
}
.iris-status-dot {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34,197,94,0.8);
  margin-right: 5px;
  vertical-align: middle;
}

/* Sender line above each Iris reply — makes a long answer read as a message
   from someone, rather than an unattributed wall of text. */
.iris-msg-head {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 5px;
  padding-left: 2px;
}
.iris-avatar {
  width: 18px; height: 18px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--glow-gradient);
  color: #04121c;
  flex-shrink: 0;
}
.iris-msg-name {
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-secondary);
}

/* Standing brief shown when the panel opens on a fresh conversation. */
.iris-brief {
  display: flex; flex-direction: column; gap: 5px;
  margin: 4px 0 12px; padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.035);
  border-radius: 12px;
}
.iris-brief-label {
  font-size: 0.62rem; font-weight: 800; letter-spacing: 1px;
  text-transform: uppercase; color: var(--text-secondary);
  opacity: 0.75; margin-bottom: 3px;
}
.iris-brief-row {
  display: flex; align-items: center; gap: 8px;
  background: transparent; border: none; padding: 3px 0;
  color: var(--text-primary); font-size: 0.81rem; font-weight: 600;
  cursor: pointer; text-align: left;
}
.iris-brief-row:hover { color: #00d9ff; }
.iris-brief-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}

.iris-outbox-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border-radius: 999px; cursor: pointer;
  font-size: 0.68rem; font-weight: 800;
  color: #fbbf24; background: rgba(251,191,36,0.14);
  border: 1px solid rgba(251,191,36,0.45);
}
.iris-outbox {
  border-bottom: 1px solid var(--border-color);
  background: rgba(251,191,36,0.05);
  padding: 10px 14px; max-height: 240px; overflow-y: auto; flex-shrink: 0;
}
.iris-outbox-head {
  font-size: 0.62rem; font-weight: 800; letter-spacing: 0.8px;
  text-transform: uppercase; color: #fbbf24; margin-bottom: 7px;
}
.iris-outbox-item {
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.22);
  border-radius: 10px; padding: 9px 11px; margin-bottom: 7px;
}
.iris-outbox-to { font-size: 0.7rem; font-weight: 700; color: var(--text-secondary); }
.iris-outbox-body {
  font-size: 0.76rem; color: var(--text-primary); margin-top: 4px;
  white-space: pre-wrap; max-height: 74px; overflow-y: auto;
}
.iris-outbox-err { font-size: 0.68rem; color: #f87171; margin-top: 5px; }
.iris-outbox-actions { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
.iris-outbox-discard {
  background: transparent; border: 1px solid var(--border-color);
  color: var(--text-secondary); border-radius: 8px;
  padding: 6px 12px; font-size: 0.74rem; font-weight: 700; cursor: pointer;
}
.iris-outbox-auto {
  font-size: 0.68rem; color: var(--text-secondary); opacity: 0.85; margin-top: 2px;
}

.iris-msg-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.iris-use-btn {
  display: inline-flex; align-items: center; gap: 4px;
  margin-top: 4px; padding: 3px 9px;
  border-radius: 6px; cursor: pointer;
  font-size: 0.68rem; font-weight: 700;
  color: #04121c; border: none;
  background: var(--glow-gradient);
}
.iris-use-btn:hover { filter: brightness(1.08); }

.iris-steps {
  display: flex; flex-wrap: wrap; gap: 5px;
  margin-bottom: 6px; padding-left: 2px;
}
.iris-step {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.66rem; font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 999px; padding: 2px 8px;
}

/* Confirmation card. Nothing Iris proposes happens until this is pressed,
   so it deliberately looks like a decision point rather than a message. */
.iris-action-card {
  margin-top: 8px;
  border: 1px solid rgba(0, 217, 255, 0.35);
  background: rgba(0, 217, 255, 0.06);
  border-radius: 12px;
  padding: 11px 13px;
  max-width: 84%;
}
.iris-action-send {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(251, 191, 36, 0.07);
}
.iris-action-title {
  display: flex; align-items: center; gap: 5px;
  font-size: 0.62rem; font-weight: 800; letter-spacing: 0.8px;
  text-transform: uppercase; color: var(--text-secondary); margin-bottom: 6px;
}
.iris-action-summary { font-size: 0.84rem; font-weight: 700; color: var(--text-primary); }
.iris-action-detail {
  margin-top: 8px; font-size: 0.76rem; color: var(--text-secondary);
  display: flex; flex-direction: column; gap: 3px;
}
.iris-action-label {
  display: inline-block; min-width: 52px;
  font-weight: 800; font-size: 0.62rem; letter-spacing: 0.6px;
  text-transform: uppercase; opacity: 0.75;
}
.iris-action-body {
  margin-top: 6px; padding: 8px 10px;
  background: rgba(0,0,0,0.28); border-radius: 8px;
  white-space: pre-wrap; color: var(--text-primary);
  max-height: 190px; overflow-y: auto;
}
.iris-action-buttons { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.iris-action-go {
  border: none; border-radius: 8px; padding: 7px 15px;
  font-size: 0.78rem; font-weight: 800; cursor: pointer;
  background: var(--glow-gradient); color: #04121c;
}
.iris-action-go:disabled { opacity: 0.6; cursor: default; }
.iris-action-error { font-size: 0.72rem; color: #f87171; }
.iris-action-done {
  display: flex; align-items: center; gap: 5px; margin-top: 8px;
  font-size: 0.76rem; font-weight: 700; color: #22c55e;
}

.iris-thinking-line { display: flex; align-items: center; gap: 9px; }
.iris-thinking-text { font-size: 0.8rem; color: var(--text-secondary); }

/* Starter prompts on an empty conversation — a blank box gives no hint of
   what Iris can now do, so lead with the things it's actually good at. */
.iris-suggestions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  margin-top: 6px;
  padding-left: 2px;
}
.iris-suggestions-label {
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--text-secondary);
  opacity: 0.75;
  margin-bottom: 1px;
}
.iris-chip {
  text-align: left;
  padding: 8px 13px;
  border-radius: 999px;
  border: 1px solid rgba(0, 217, 255, 0.28);
  background: rgba(0, 217, 255, 0.07);
  color: var(--text-primary);
  font-size: 0.79rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.iris-chip:hover {
  background: rgba(0, 217, 255, 0.15);
  border-color: rgba(0, 217, 255, 0.5);
}

.iris-header-icon {
  width: 32px; height: 32px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  background: var(--glow-gradient); color: #04121c;
  flex-shrink: 0;
}
.iris-header-title { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.2px; }
.iris-header-sub {
  font-size: 0.66rem; color: var(--text-secondary); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.7px; margin-top: 1px;
}

.iris-messages {
  flex: 1; overflow-y: auto; padding: 16px 14px;
  display: flex; flex-direction: column; gap: 9px;
  /* Without min-height:0 a flex item won't shrink below its content height,
     so a long conversation grew the column past the panel and pushed the
     input row off the bottom of the screen. This is what keeps the message
     list scrolling inside the panel instead of stretching it. */
  min-height: 0;
}
.iris-bubble-row { display: flex; width: 100%; }
.iris-row-user { justify-content: flex-end; }
.iris-row-iris { justify-content: flex-start; }

.iris-bubble-iris, .iris-bubble-user {
  max-width: 84%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 0.85rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.iris-bubble-iris {
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}
.iris-bubble-user {
  background: var(--glow-gradient);
  color: #04121c;
  font-weight: 500;
  border-bottom-right-radius: 4px;
}

.iris-bubble-iris-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 84%;
  gap: 4px;
}
.iris-bubble-iris-wrap .iris-bubble-iris { max-width: 100%; }

.iris-copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 4px;
  margin-left: 2px;
  cursor: pointer;
  border-radius: 5px;
  transition: background 0.15s ease, color 0.15s ease;
}
.iris-copy-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.iris-typing { display: flex; gap: 4px; align-items: center; padding: 11px 13px; }
.iris-typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-secondary);
  animation: irisTypingPulse 1.1s ease infinite;
}
.iris-typing span:nth-child(2) { animation-delay: 0.15s; }
.iris-typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes irisTypingPulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}

.iris-input-row {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 12px 14px; border-top: 2px solid var(--border-color);
  background: var(--bg-main); flex-shrink: 0;
}
.iris-textarea {
  flex: 1; resize: none; border: 1px solid var(--border-color);
  outline: none; background: rgba(255, 255, 255, 0.06); color: var(--text-primary);
  font-size: 0.85rem; font-family: inherit; line-height: 1.4;
  padding: 8px 11px; border-radius: 10px; max-height: 100px;
}
.iris-textarea:focus { border-color: var(--neon-cyan); }
.iris-send-btn {
  background: var(--glow-gradient); border: none; color: #04121c;
  width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.iris-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.iris-send-btn:not(:disabled):hover { transform: translateY(-1px); }

@media (max-width: 480px) {
  .iris-popup {
    width: calc(100vw - 24px);
    right: 12px;
    height: calc(100vh - 120px);
  }
  .iris-fab { right: 16px; }
}
`;