import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X, Send, Copy, Check } from "lucide-react";

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
const MAX_RECENT_EMAILS = 25;

// ─── SINGLE INTEGRATION SEAM ───────────────────────────────────────────────
// Calls the real backend. Phase 3: also sends user_email (not just the
// display name) since the backend's tools — tracking status, email
// search — look data up by email, not by display name.
async function sendToIris(message, history, inboxContext) {
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
    }),
  });

  if (!res.ok) {
    throw new Error(`Iris chat request failed (${res.status})`);
  }

  const data = await res.json();
  return data.reply;
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
  const [copiedIndex, setCopiedIndex] = useState(null);   // index of message showing "Copied" feedback

  const containerRef = useRef(null);
  const listRef = useRef(null);
  const textareaRef = useRef(null);

  const getSender = getParticipantDisplay || fallbackGetParticipantDisplay;
  const getReceived = getEffectiveReceivedAt || fallbackGetEffectiveReceivedAt;

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

  const handleSend = async () => {
    const text = input.trim();
    if (!text || thinking) return;

    const priorMessages = messages;   // history BEFORE this new message
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setThinking(true);

    try {
      const reply = await sendToIris(text, priorMessages, inboxContext);
      setMessages((prev) => [...prev, { role: "iris", text: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "iris", text: "Something went wrong reaching Iris. Try again in a moment." },
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
        <div className="iris-popup">
          <div className="iris-header">
            <div className="iris-header-left">
              <div className="iris-header-icon"><Sparkles size={17} /></div>
              <div>
                <div className="iris-header-title">Iris</div>
                <div className="iris-header-sub">Inbox Assistant · Preview</div>
              </div>
            </div>
          </div>

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
                    <div className="iris-bubble-iris">{m.text}</div>
                    <button
                      className="iris-copy-btn"
                      onClick={() => handleCopyMessage(m.text, i)}
                      title="Copy this message"
                    >
                      {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                      {copiedIndex === i ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {thinking && (
              <div className="iris-bubble-row iris-row-iris">
                <div className="iris-bubble-iris iris-typing">
                  <span /><span /><span />
                </div>
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

      {/* ─── FLOATING TOGGLE BUTTON ─── */}
      <button
        className="iris-fab"
        onClick={() => setIsOpen((prev) => !prev)}
        title={isOpen ? "Close Iris" : "Ask Iris — Inbox Assistant"}
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
  top: 50%;
  right: 24px;
  transform: translateY(-50%);
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
  top: 50%;
  right: 92px;
  transform: translateY(-50%);
  width: 380px;
  max-width: calc(100vw - 32px);
  height: 540px;
  max-height: calc(100vh - 48px);
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