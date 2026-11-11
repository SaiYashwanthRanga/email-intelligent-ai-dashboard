import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, X, Send, Copy, Check, RotateCcw, Maximize2, Minimize2,
  Loader2, CheckCircle2, AlertTriangle, Mail, Pencil, CornerDownLeft,
} from "lucide-react";

/**
 * Iris — Inbox Assistant
 * ─────────────────────────────────────────────────────────────────────────
 * An "Iris" button in the top bar's nav pill and the chat panel it opens
 * below the bar. The agent itself lives on the backend (iris_service.py): it
 * searches and reads mail, checks the calendar, drafts replies and
 * *proposes* actions. This component is what makes that visible:
 *
 *  • Live progress — the request goes to /api/iris/chat/stream and each
 *    step ("Searching your inbox", "Reading the email"…) shows as it runs.
 *    If the stream can't be opened it falls back to /api/iris/chat.
 *  • Confirmation cards — every action Iris proposes (reply, forward, new
 *    email, mark read, RSVP) renders as a card. Nothing is sent until the
 *    person presses the button; that click is the only thing that calls
 *    /api/iris/confirm. The card can be edited or cancelled first.
 *  • Focus — when an email is open in the Inbox its id goes along as
 *    focus_message_id, so "reply to this" needs no explaining.
 *  • Formatting — replies render lists/bold, and emails Iris names become
 *    chips that open the conversation.
 *  • The conversation survives a refresh (sessionStorage, per user).
 *
 * IMPORTANT: rendered via a React Portal straight into document.body.
 * `position: fixed` is only "fixed to the viewport" if no ancestor has a
 * transform/filter/will-change style — but DashboardView.jsx's .top-bar
 * has `animation: fadeSlideUp ... both`, which keeps a transform applied
 * and would break fixed positioning for anything nested inside it.
 */

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

const GREETING =
  "Hi, I'm Iris. I can search and read your mail, check your calendar, draft replies and prepare emails for you to send — nothing goes out until you confirm it.";

const GENERAL_PROMPTS = [
  "What needs my decision today?",
  "Who is waiting on a reply from me?",
  "Catch me up since yesterday",
  "What's on my calendar this week?",
];
const FOCUS_PROMPTS = [
  "Summarise this thread",
  "What do they need from me?",
  "Draft a reply",
];

// Local fallbacks in case the caller doesn't pass the helper props.
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

// Caps keep the payload small/fast/cheap regardless of mailbox size.
const MAX_THREADS = 25;
const MAX_RECENT_EMAILS = 25;
const MAX_SAVED_MESSAGES = 60;
const MAX_MENTIONS = 4;

const emailIdOf = (e) => e?.messageId || e?.id || "";
const getUserEmail = () => localStorage.getItem("userEmail") || "default";
const storageKey = () => `iris:chat:${getUserEmail()}`;

const ACTION_META = {
  send_reply: { title: "Reply",        confirm: "Send reply",   done: "Sent" },
  forward:    { title: "Forward",      confirm: "Send forward", done: "Sent" },
  compose:    { title: "New email",    confirm: "Send email",   done: "Sent" },
  mark_read:  { title: "Mark as read", confirm: "Mark as read", done: "Marked as read" },
  rsvp:       { title: "Meeting RSVP", confirm: "Send RSVP",    done: "RSVP sent" },
};
const isMailAction = (action) => action === "send_reply" || action === "forward" || action === "compose";

// ─── Conversation persistence ──────────────────────────────────────────────
function loadConversation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey()) || "null");
    if (Array.isArray(saved) && saved.length > 0) {
      // A send that was in flight when the page reloaded has an unknown
      // outcome — never show it as still running or silently re-arm it.
      return saved.map((m) => (m.proposals
        ? { ...m, proposals: m.proposals.map((p) => (p.status === "sending"
            ? { ...p, status: "error", ambiguous: true, resultMessage: "The page reloaded while this was being sent." }
            : { ...p, editing: false })) }
        : m));
    }
  } catch (_) { /* storage unavailable — start fresh */ }
  return [{ role: "iris", text: GREETING }];
}

function saveConversation(messages) {
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES)));
  } catch (_) { /* storage unavailable or full — the chat still works */ }
}

// What the model is told about earlier turns. Proposal outcomes are added
// as plain text so Iris knows whether something it prepared actually went.
function toHistory(messages) {
  return messages.map((m) => {
    let text = m.text || "";
    (m.proposals || []).forEach((p) => {
      const what = `${p.action}${p.to?.length ? ` to ${p.to.join(", ")}` : ""}`;
      const state =
        p.status === "done" ? "the person confirmed it and it was carried out"
        : p.status === "cancelled" ? "the person cancelled it — it was NOT carried out"
        : p.status === "error" ? "it failed when the person confirmed it"
        : "still waiting for the person to confirm — not carried out yet";
      text += `\n[Proposed action ${what}: ${state}]`;
    });
    return { role: m.role, text };
  }).filter((m) => m.text);
}

// ─── Backend calls ─────────────────────────────────────────────────────────
export class IrisError extends Error {}

async function readErrorDetail(res, fallback) {
  try {
    const data = await res.json();
    if (data?.detail) return String(data.detail);
  } catch (_) { /* not JSON */ }
  return fallback;
}

// Streams one reply. Calls onStep(label) as each step starts and resolves
// with { reply, steps, proposals }.
export async function askIris(body, onStep) {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

  let res = null;
  try {
    res = await fetch(`${API_BASE}/iris/chat/stream`, init);
  } catch (_) {
    res = null;   // could not even open the stream — try the plain route below
  }

  if (res && res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;   // ": keepalive" comments
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (evt.type === "step") onStep?.(evt.label);
          else if (evt.type === "done") final = evt;
          else if (evt.type === "error") throw new IrisError(evt.detail || "Iris couldn't respond right now.");
        }
      }
    }
    if (!final) throw new IrisError("The connection to Iris dropped before it finished. Try again.");
    return final;
  }

  // Fallback: no streaming available (older backend, proxy buffering…).
  const plain = await fetch(`${API_BASE}/iris/chat`, init);
  if (!plain.ok) throw new IrisError(await readErrorDetail(plain, `Iris couldn't respond right now (${plain.status}).`));
  return plain.json();
}

// ─── Lightweight formatting (no HTML injection — builds React nodes) ───────
function renderInline(text, keyBase) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${keyBase}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${keyBase}-${i}`}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export function RichText({ text }) {
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };

  String(text || "").split("\n").forEach((raw) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { flush(); list = { type, items: [] }; }
      list.items.push((bullet || numbered)[1]);
    } else {
      flush();
      if (heading) blocks.push({ type: "h", text: heading[1] });
      else if (line.trim() === "") blocks.push({ type: "gap" });
      else blocks.push({ type: "p", text: line });
    }
  });
  flush();

  return (
    <div className="iris-rich">
      {blocks.map((b, i) => {
        if (b.type === "ul" || b.type === "ol") {
          const Tag = b.type;
          return <Tag key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it, `${i}-${j}`)}</li>)}</Tag>;
        }
        if (b.type === "h") return <div key={i} className="iris-rich-h">{renderInline(b.text, i)}</div>;
        if (b.type === "gap") return <div key={i} className="iris-rich-gap" />;
        return <div key={i}>{renderInline(b.text, i)}</div>;
      })}
    </div>
  );
}

// Emails Iris named in its reply, matched by subject, so they can be opened.
const cleanSubject = (s) => String(s || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();

function findMentions(reply, emails) {
  const haystack = String(reply || "").toLowerCase();
  if (!haystack) return [];
  const seen = new Set();
  const found = [];
  for (const e of emails || []) {
    const subject = cleanSubject(e?.subject);
    const key = subject.toLowerCase();
    if (subject.length < 10 || seen.has(key) || !emailIdOf(e)) continue;
    if (haystack.includes(key)) {
      seen.add(key);
      found.push({ id: emailIdOf(e), subject });
      if (found.length >= MAX_MENTIONS) break;
    }
  }
  return found;
}

// The reply text inside an Iris message, without the chat around it
// ("Here's a draft you can send:" … "Feel free to edit it!"). Iris fences a
// draft between --- lines; when it doesn't, an intro line ending in ":" is
// dropped and the rest is taken as the draft.
const DRAFT_STEP = "Drafting a reply";

function extractDraft(text, steps) {
  const lines = String(text || "").split("\n");
  const fences = lines.map((l, i) => (/^\s*([-*_])\1{2,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  let body = null;
  if (fences.length >= 2) body = lines.slice(fences[0] + 1, fences[fences.length - 1]);
  else if (fences.length === 1) body = lines.slice(fences[0] + 1);
  else if ((steps || []).includes(DRAFT_STEP)) {
    body = lines.slice();
    if (body.length > 1 && /:\s*$/.test(body[0])) body.shift();
  }
  if (!body) return "";
  return body.join("\n").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
}

// Messages saved before drafts were tracked have no `draft` field — work it out.
const draftOf = (m) => (m.draft !== undefined
  ? m.draft
  : (m.role === "iris" && !(m.proposals || []).length ? extractDraft(m.text, m.steps) : ""));

// ─── Confirmation card ─────────────────────────────────────────────────────
const splitAddresses = (value) => String(value || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function ProposalCard({ proposal: p, onPatch, onConfirm, onCancel, onInsert }) {
  const meta = ACTION_META[p.action] || { title: p.action, confirm: "Confirm", done: "Done" };
  const mail = isMailAction(p.action);
  const status = p.status || "pending";
  const open = status === "pending" || status === "error";
  const missing = mail && (!(p.to || []).length || !(p.body || "").trim() || (p.action === "compose" && !(p.subject || "").trim()));

  return (
    <div className={`iris-card iris-card-${status}`}>
      <div className="iris-card-head">
        <span className="iris-card-kind"><Mail size={13} /> {meta.title}</span>
        {status === "pending" && <span className="iris-card-state">Needs your confirmation</span>}
        {status === "sending" && <span className="iris-card-state"><Loader2 size={12} className="iris-spin" /> Working…</span>}
        {status === "done" && <span className="iris-card-state iris-ok"><CheckCircle2 size={13} /> {p.resultMessage || meta.done}</span>}
        {status === "cancelled" && <span className="iris-card-state">Cancelled</span>}
        {status === "error" && <span className="iris-card-state iris-err"><AlertTriangle size={13} /> Not completed</span>}
      </div>

      <div className="iris-card-summary">{p.summary}</div>

      {mail && !p.editing && (
        <div className="iris-card-fields">
          <div><span>To</span>{(p.to || []).join(", ") || "—"}</div>
          {(p.cc || []).length > 0 && <div><span>Cc</span>{p.cc.join(", ")}</div>}
          {p.subject && <div><span>Subject</span>{p.subject}</div>}
          <div className="iris-card-body">{p.body}</div>
        </div>
      )}

      {mail && p.editing && (
        <div className="iris-card-edit">
          <label>To
            <input value={p.toText ?? (p.to || []).join(", ")} onChange={(e) => onPatch({ toText: e.target.value, to: splitAddresses(e.target.value) })} />
          </label>
          <label>Cc
            <input value={p.ccText ?? (p.cc || []).join(", ")} onChange={(e) => onPatch({ ccText: e.target.value, cc: splitAddresses(e.target.value) })} />
          </label>
          {p.action === "compose" && (
            <label>Subject
              <input value={p.subject || ""} onChange={(e) => onPatch({ subject: e.target.value })} />
            </label>
          )}
          <label>Message
            <textarea rows={10} value={p.body || ""} onChange={(e) => onPatch({ body: e.target.value })} />
          </label>
        </div>
      )}

      {p.action === "rsvp" && <div className="iris-card-fields"><div><span>Answer</span>{p.response || "accept"}</div></div>}

      {status === "error" && (
        <div className="iris-card-errtext">
          {p.resultMessage}
          {p.ambiguous && " It may or may not have gone through — check your Sent items before trying again."}
        </div>
      )}

      {open && (
        <div className="iris-card-actions">
          <button className="iris-btn iris-btn-primary" disabled={missing} onClick={onConfirm}
            title={missing ? "A recipient and a message are required" : "Nothing is sent until you press this"}>
            <Check size={14} /> {status === "error" ? "Try again" : meta.confirm}
          </button>
          {mail && (
            <button className="iris-btn" onClick={() => onPatch({ editing: !p.editing })}>
              <Pencil size={13} /> {p.editing ? "Done editing" : "Edit"}
            </button>
          )}
          {onInsert && (
            <button className="iris-btn" onClick={onInsert} title="Put this text in the email's reply box instead, to finish it there">
              <CornerDownLeft size={13} /> Put in reply box
            </button>
          )}
          <button className="iris-btn iris-btn-quiet" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────
const Iris = ({
  emails = [],
  report = null,
  triageStats = null,
  getParticipantDisplay,
  getEffectiveReceivedAt,
  focusEmail = null,      // the email open in the Inbox, if any
  onOpenEmail,            // (email) => open that conversation
  onInsertDraft,          // (text) => put text in the open email's reply box
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState(loadConversation);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [liveSteps, setLiveSteps] = useState([]);
  const [copiedIndex, setCopiedIndex] = useState(null);   // index of message showing "Copied" feedback
  const [ignoredFocusId, setIgnoredFocusId] = useState(null);
  const [insertedKey, setInsertedKey] = useState(null);   // which draft shows "Inserted" feedback

  const listRef = useRef(null);
  const textareaRef = useRef(null);

  const getSender = getParticipantDisplay || fallbackGetParticipantDisplay;
  const getReceived = getEffectiveReceivedAt || fallbackGetEffectiveReceivedAt;

  const focusId = emailIdOf(focusEmail);
  const activeFocusId = focusId && focusId !== ignoredFocusId ? focusId : "";

  // ── Compact "inbox snapshot" sent alongside each message ──
  // Deliberately excludes full email bodies — only the short AI summaries
  // that already exist on each email. Iris reads full text through its tools.
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

  useEffect(() => { saveConversation(messages); }, [messages]);

  // Auto-scroll to newest message / step
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, thinking, liveSteps, isOpen]);

  // Other parts of the page (e.g. the Insights "Ask Iris anything" row) open
  // the panel with window.dispatchEvent(new CustomEvent("iris:open")).
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener("iris:open", open);
    return () => window.removeEventListener("iris:open", open);
  }, []);

  // …or hand Iris a task directly:
  //   window.dispatchEvent(new CustomEvent("iris:ask", { detail: { prompt, emailId } }))
  // opens the panel and sends `prompt`, about `emailId` when one is given.
  // The ref keeps the listener pointed at the latest handleSend.
  const askRef = useRef(null);
  askRef.current = (detail) => {
    setIsOpen(true);
    if (detail?.prompt) handleSend(String(detail.prompt), detail.emailId ? String(detail.emailId) : undefined);
  };
  useEffect(() => {
    const ask = (e) => askRef.current?.(e.detail);
    window.addEventListener("iris:ask", ask);
    return () => window.removeEventListener("iris:ask", ask);
  }, []);

  useEffect(() => {
    if (isOpen) setTimeout(() => textareaRef.current?.focus(), 50);
  }, [isOpen]);

  // Escape closes. Clicking elsewhere does NOT: the panel is meant to stay
  // open beside the inbox while the person reads the email it's about.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") setIsOpen(false); };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  const handleCopyMessage = async (text, index) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 2000);
    } catch (_) {
      // clipboard unavailable (permissions, non-HTTPS) — nothing to do
    }
  };

  // `focusOverride` is the email a request is about when it comes from
  // elsewhere on the page (iris:ask) before that email has finished opening.
  const handleSend = async (override, focusOverride) => {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text || thinking) return;
    const aboutId = (typeof focusOverride === "string" && focusOverride) || activeFocusId;

    const history = toHistory(messages);   // the conversation BEFORE this message
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setThinking(true);
    setLiveSteps([]);

    try {
      const result = await askIris({
        message: text,
        history,
        user_name: localStorage.getItem("loggedInUser") || "User",
        user_email: getUserEmail(),
        inbox_context: inboxContext || null,
        focus_message_id: aboutId || null,
      }, (label) => setLiveSteps((prev) => (prev[prev.length - 1] === label ? prev : [...prev, label])));

      const reply = result.reply || "";
      const proposals = (result.proposals || []).map((p) => ({ ...p, status: "pending" }));
      setMessages((prev) => [...prev, {
        role: "iris",
        text: reply || (proposals.length ? "I've prepared this for you to confirm." : "I don't have an answer for that."),
        steps: (result.steps || []).filter((s) => s !== "Thinking"),
        focusId: aboutId || "",
        draft: proposals.length ? "" : extractDraft(reply, result.steps),
        proposals,
        mentions: findMentions(reply, emails),
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "iris",
        failed: true,
        text: err instanceof IrisError ? err.message : "Couldn't reach Iris. Check that the app's server is running and try again.",
      }]);
    } finally {
      setThinking(false);
      setLiveSteps([]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Proposal state lives on the message that carried it ──
  const patchProposal = (messageIndex, actionId, patch) => {
    setMessages((prev) => prev.map((m, i) => (i !== messageIndex ? m : {
      ...m,
      proposals: (m.proposals || []).map((p) => (p.actionId === actionId ? { ...p, ...patch } : p)),
    })));
  };

  // The ONLY place an action is carried out — and only from a click.
  const confirmProposal = async (messageIndex, p) => {
    if (p.status === "sending" || p.status === "done") return;
    patchProposal(messageIndex, p.actionId, { status: "sending", editing: false, resultMessage: "", ambiguous: false });

    let res;
    try {
      res = await fetch(`${API_BASE}/iris/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: p.actionId,
          action: p.action,
          userEmail: p.userEmail || getUserEmail(),
          messageId: p.messageId || "",
          to: p.to || [],
          cc: p.cc || [],
          subject: p.subject || "",
          body: p.body || "",
          response: p.response || undefined,
        }),
      });
    } catch (_) {
      // No answer at all: we cannot know whether it went through.
      patchProposal(messageIndex, p.actionId, { status: "error", ambiguous: true, resultMessage: "Lost the connection while doing this." });
      return;
    }

    if (!res.ok) {
      patchProposal(messageIndex, p.actionId, {
        status: "error",
        resultMessage: await readErrorDetail(res, `That didn't go through (${res.status}).`),
      });
      return;
    }

    let data = {};
    try { data = await res.json(); } catch (_) { /* fall back to the default label */ }
    patchProposal(messageIndex, p.actionId, { status: "done", resultMessage: data.message || "" });
  };

  // Only ever on a click, and only into the email that is open right now.
  // A draft written about one email is never offered for a different one.
  const canInsertFor = (aboutId) => Boolean(onInsertDraft && focusId && (!aboutId || aboutId === focusId));

  const insertDraft = (text, key) => {
    if (!text || !onInsertDraft) return;
    onInsertDraft(text);
    setInsertedKey(key);
    setTimeout(() => setInsertedKey((prev) => (prev === key ? null : prev)), 2500);
  };

  const startNewChat = () => {
    if (thinking) return;
    setMessages([{ role: "iris", text: GREETING }]);
    setInput("");
  };

  const openMention = (mention) => {
    const email = (emails || []).find((e) => emailIdOf(e) === mention.id);
    if (email) onOpenEmail?.(email);
  };

  const isFreshChat = messages.length === 1;
  const prompts = activeFocusId ? FOCUS_PROMPTS : GENERAL_PROMPTS;

  // The trigger is an ordinary top-bar button, rendered where <Iris /> is
  // mounted (the nav pill). Only the panel is portaled to document.body.
  return (
    <>
    <button
      type="button"
      className={`view-btn iris-trigger ${isOpen ? "iris-trigger-open" : ""}`}
      onClick={() => setIsOpen((prev) => !prev)}
      title={isOpen ? "Close Iris" : "Ask Iris — Inbox Assistant"}
      aria-expanded={isOpen}
    >
      <Sparkles size={18} /> Iris
    </button>
    {createPortal(
    <div>
      <style>{IRIS_CSS}</style>

      {isOpen && (
        <div className={`iris-popup ${expanded ? "iris-popup-expanded" : ""}`} role="dialog" aria-label="Iris assistant">
          <div className="iris-header">
            <div className="iris-header-left">
              <div className="iris-header-icon"><Sparkles size={20} /></div>
              <div>
                <div className="iris-header-title">Iris</div>
                <div className="iris-header-sub">Inbox Assistant</div>
              </div>
            </div>
            <div className="iris-header-actions">
              <button onClick={startNewChat} disabled={thinking || isFreshChat} title="Start a new chat"><RotateCcw size={18} /></button>
              <button onClick={() => setExpanded((x) => !x)} title={expanded ? "Smaller panel" : "Larger panel"}>
                {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
              <button onClick={() => setIsOpen(false)} title="Close"><X size={19} /></button>
            </div>
          </div>

          <div className="iris-messages" ref={listRef}>
            {messages.map((m, i) => (
              <div key={i} className={`iris-bubble-row ${m.role === "user" ? "iris-row-user" : "iris-row-iris"}`}>
                {m.role === "user" ? (
                  <div className="iris-bubble-user">{m.text}</div>
                ) : (
                  <div className="iris-bubble-iris-wrap">
                    {m.steps?.length > 0 && (
                      <div className="iris-steps-done" title="What Iris did to answer this">
                        <Check size={11} /> {m.steps.join(" · ")}
                      </div>
                    )}
                    <div className={`iris-bubble-iris ${m.failed ? "iris-bubble-failed" : ""}`}>
                      <RichText text={m.text} />
                    </div>

                    {m.mentions?.length > 0 && (
                      <div className="iris-mentions">
                        {m.mentions.map((mention) => (
                          <button key={mention.id} className="iris-chip" onClick={() => openMention(mention)} title="Open this conversation">
                            <Mail size={11} /> <span>{mention.subject}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {(m.proposals || []).map((p) => (
                      <ProposalCard
                        key={p.actionId}
                        proposal={p}
                        onPatch={(patch) => patchProposal(i, p.actionId, patch)}
                        onConfirm={() => confirmProposal(i, p)}
                        onCancel={() => patchProposal(i, p.actionId, { status: "cancelled", editing: false })}
                        onInsert={p.action === "send_reply" && p.body && canInsertFor(p.messageId)
                          ? () => { insertDraft(p.body, p.actionId); patchProposal(i, p.actionId, { status: "cancelled", editing: false }); }
                          : undefined}
                      />
                    ))}

                    {draftOf(m) && canInsertFor(m.focusId) && (
                      <button className="iris-btn iris-btn-primary iris-insert-btn" onClick={() => insertDraft(draftOf(m), `m${i}`)}
                        title={`Put this draft in the reply box for: ${focusEmail?.subject || "the open email"}. Nothing is sent.`}>
                        {insertedKey === `m${i}` ? <Check size={14} /> : <CornerDownLeft size={14} />}
                        {insertedKey === `m${i}` ? "Inserted in reply box" : "Insert into reply"}
                      </button>
                    )}

                    {i > 0 && !m.failed && (
                      <button className="iris-copy-btn" onClick={() => handleCopyMessage(m.text, i)} title="Copy this message">
                        {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                        {copiedIndex === i ? "Copied" : "Copy"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {isFreshChat && !thinking && (
              <div className="iris-prompts">
                {prompts.map((prompt) => (
                  <button key={prompt} className="iris-chip iris-chip-prompt" onClick={() => handleSend(prompt)}>{prompt}</button>
                ))}
              </div>
            )}

            {thinking && (
              <div className="iris-bubble-row iris-row-iris">
                <div className="iris-bubble-iris iris-live">
                  {liveSteps.length === 0 ? (
                    <div className="iris-typing"><span /><span /><span /></div>
                  ) : liveSteps.map((step, idx) => (
                    <div key={`${step}-${idx}`} className={`iris-live-step ${idx === liveSteps.length - 1 ? "iris-live-current" : ""}`}>
                      {idx === liveSteps.length - 1 ? <Loader2 size={12} className="iris-spin" /> : <Check size={12} />}
                      {step}{idx === liveSteps.length - 1 ? "…" : ""}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {activeFocusId && (
            <div className="iris-focus" title="Iris will treat questions as being about this email">
              <Mail size={12} />
              <span>Viewing: {focusEmail?.subject || "this email"}</span>
              <button onClick={() => setIgnoredFocusId(focusId)} title="Don't use this email as context"><X size={12} /></button>
            </div>
          )}

          <div className="iris-input-row">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeFocusId ? "Ask about this email, or anything else…" : "Ask Iris about your inbox…"}
              rows={2}
              className="iris-textarea"
            />
            <button onClick={() => handleSend()} disabled={!input.trim() || thinking} className="iris-send-btn" title="Send">
              <Send size={20} />
            </button>
          </div>
        </div>
      )}

    </div>,
    document.body
    )}
    </>
  );
};

export default Iris;

// ─── SCOPED STYLES ──────────────────────────────────────────────────────
// Kept in this file (not App.css) so this feature stays self-contained and
// easy to remove/iterate on without touching existing stylesheets.
const IRIS_CSS = `
/* Top-bar trigger — a nav pill like Inbox/Calendar, tinted so it reads as the assistant. */
.view-btn.iris-trigger { color: var(--accent-blue); }
.view-btn.iris-trigger:hover { color: var(--text-primary); }
.view-btn.iris-trigger.iris-trigger-open { background: rgba(10, 132, 255, 0.28); color: #fff; }
body.light-mode .view-btn.iris-trigger.iris-trigger-open { background: #dbeafe; color: #1d4ed8; }

.iris-popup {
  --iris-surface: rgba(16, 18, 24, 0.94);
  --iris-line: rgba(255, 255, 255, 0.14);
  --iris-soft: rgba(255, 255, 255, 0.07);
  --iris-soft-2: rgba(255, 255, 255, 0.11);
  --iris-ok: #63e6a0;
  --iris-err: #ff6961;
  --iris-accent: #64d2ff;
  /* Drops down from the top bar (72px tall + its margin), against the right edge. */
  position: fixed;
  top: 100px;
  right: 20px;
  bottom: 20px;
  width: 600px;
  max-width: calc(100vw - 40px);
  background: var(--iris-surface);
  backdrop-filter: blur(40px) saturate(160%);
  -webkit-backdrop-filter: blur(40px) saturate(160%);
  border: 1px solid var(--iris-line);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2600;
  animation: irisPopIn 0.24s cubic-bezier(0.2, 0, 0, 1) both;
}
/* Larger panel: docked down the right side, full height. */
.iris-popup-expanded { width: min(960px, calc(100vw - 40px)); }
@keyframes irisPopIn { from { opacity: 0; } to { opacity: 1; } }

body.light-mode .iris-popup {
  --iris-surface: rgba(255, 255, 255, 0.98);
  --iris-line: #e2e8f0;
  --iris-soft: #f1f5f9;
  --iris-soft-2: #e2e8f0;
  --iris-ok: #15803d;
  --iris-err: #dc2626;
  --iris-accent: #2563eb;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
}

.iris-popup button { font-family: inherit; cursor: pointer; }
.iris-popup button:disabled { cursor: not-allowed; opacity: 0.45; }

.iris-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--iris-line); flex-shrink: 0;
}
.iris-header-left { display: flex; align-items: center; gap: 11px; }
.iris-header-icon {
  width: 38px; height: 38px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--glow-gradient); color: #04121c; flex-shrink: 0;
}
.iris-header-title { font-size: 1.15rem; font-weight: 800; letter-spacing: -0.2px; }
.iris-header-sub {
  font-size: 0.72rem; color: var(--text-secondary); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.7px; margin-top: 1px;
}
.iris-header-actions { display: flex; gap: 4px; }
.iris-header-actions button {
  width: 36px; height: 36px; border-radius: 10px; border: none; background: none;
  color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.iris-header-actions button:not(:disabled):hover { background: var(--iris-soft-2); color: var(--text-primary); }

.iris-messages {
  flex: 1; overflow-y: auto; padding: 20px;
  display: flex; flex-direction: column; gap: 14px;
}
.iris-bubble-row { display: flex; width: 100%; }
.iris-row-user { justify-content: flex-end; }
.iris-row-iris { justify-content: flex-start; }

.iris-bubble-iris, .iris-bubble-user {
  max-width: 86%;
  padding: 12px 16px;
  border-radius: 16px;
  font-size: 1rem;
  line-height: 1.6;
  word-break: break-word;
}
.iris-bubble-iris {
  background: var(--iris-soft);
  border: 1px solid var(--iris-line);
  border-bottom-left-radius: 4px;
}
.iris-bubble-failed { border-color: var(--iris-err); color: var(--iris-err); }
.iris-bubble-user {
  background: var(--glow-gradient);
  color: #04121c;
  font-weight: 500;
  white-space: pre-wrap;
  border-bottom-right-radius: 4px;
}

.iris-bubble-iris-wrap {
  display: flex; flex-direction: column; align-items: flex-start;
  width: 92%; gap: 6px; min-width: 0;
}
.iris-bubble-iris-wrap .iris-bubble-iris { max-width: 100%; }

.iris-rich ul, .iris-rich ol { margin: 4px 0; padding-left: 20px; }
.iris-rich li { margin: 2px 0; }
.iris-rich-h { font-weight: 700; margin-top: 4px; }
.iris-rich-gap { height: 8px; }
.iris-rich code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9rem;
  background: var(--iris-soft-2); padding: 1px 5px; border-radius: 5px;
}

.iris-steps-done {
  display: flex; align-items: center; gap: 5px;
  font-size: 0.78rem; font-weight: 600; color: var(--text-muted); padding-left: 2px;
}

/* Live progress while Iris works */
.iris-live { display: flex; flex-direction: column; gap: 5px; }
.iris-live-step { display: flex; align-items: center; gap: 8px; font-size: 0.92rem; color: var(--text-muted); }
.iris-live-current { color: var(--text-primary); font-weight: 600; }
.iris-spin { animation: irisSpin 0.9s linear infinite; }
@keyframes irisSpin { to { transform: rotate(360deg); } }

.iris-typing { display: flex; gap: 4px; align-items: center; padding: 3px 1px; }
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

/* Chips: emails Iris mentioned, and suggested prompts */
.iris-mentions, .iris-prompts { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; }
.iris-prompts { padding: 4px 0 0 2px; }
.iris-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 7px 14px; border-radius: 999px;
  border: 1px solid var(--iris-line); background: var(--iris-soft);
  color: var(--text-secondary); font-size: 0.84rem; font-weight: 600;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.iris-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-chip svg { flex-shrink: 0; }
.iris-chip:hover { background: var(--iris-soft-2); color: var(--text-primary); border-color: var(--iris-accent); }
.iris-chip-prompt { color: var(--iris-accent); padding: 9px 16px; font-size: 0.9rem; }

/* Confirmation card */
.iris-card {
  width: 100%; box-sizing: border-box;
  border: 1px solid var(--iris-accent); border-radius: 14px;
  background: var(--iris-soft); padding: 16px;
  display: flex; flex-direction: column; gap: 11px; font-size: 0.95rem;
}
.iris-card-done { border-color: var(--iris-ok); }
.iris-card-error { border-color: var(--iris-err); }
.iris-card-cancelled { border-color: var(--iris-line); opacity: 0.65; }
.iris-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.iris-card-kind {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.76rem; font-weight: 800; letter-spacing: 0.8px; text-transform: uppercase; color: var(--iris-accent);
}
.iris-card-state { display: inline-flex; align-items: center; gap: 5px; font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
.iris-ok { color: var(--iris-ok); }
.iris-err { color: var(--iris-err); }
.iris-card-summary { font-weight: 600; }
.iris-card-fields { display: flex; flex-direction: column; gap: 4px; color: var(--text-secondary); word-break: break-word; }
.iris-card-fields > div > span {
  display: inline-block; min-width: 68px; font-size: 0.74rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted);
}
.iris-card-body {
  margin-top: 6px; padding: 12px 14px; border-radius: 12px;
  background: var(--iris-soft); border: 1px solid var(--iris-line);
  color: var(--text-primary); white-space: pre-wrap; max-height: 320px; overflow-y: auto; line-height: 1.6;
}
.iris-card-edit { display: flex; flex-direction: column; gap: 7px; }
.iris-card-edit label {
  display: flex; flex-direction: column; gap: 3px;
  font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted);
}
.iris-card-edit input, .iris-card-edit textarea {
  font: inherit; font-size: 0.95rem; font-weight: 400; text-transform: none; letter-spacing: 0;
  color: var(--text-primary); background: var(--iris-soft); border: 1px solid var(--iris-line);
  border-radius: 10px; padding: 9px 12px; outline: none; resize: vertical; line-height: 1.5;
}
.iris-card-edit input:focus, .iris-card-edit textarea:focus { border-color: var(--iris-accent); }
.iris-card-errtext { color: var(--iris-err); font-size: 0.88rem; line-height: 1.45; }
.iris-card-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.iris-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 16px; border-radius: 10px; font-size: 0.9rem; font-weight: 700;
  border: 1px solid var(--iris-line); background: var(--iris-soft); color: var(--text-primary);
  transition: background 0.15s ease, transform 0.15s ease;
}
.iris-btn:not(:disabled):hover { background: var(--iris-soft-2); }
.iris-btn-primary { background: var(--glow-gradient); color: #04121c; border-color: transparent; }
.iris-btn-primary:not(:disabled):hover { background: var(--glow-gradient); transform: translateY(-1px); }
.iris-insert-btn { margin-top: 2px; }
.iris-btn-quiet { background: none; border-color: transparent; color: var(--text-secondary); }

.iris-copy-btn {
  display: flex; align-items: center; gap: 4px;
  background: none; border: none; color: var(--text-secondary);
  font-size: 0.78rem; font-weight: 600; padding: 3px 6px; margin-left: 2px;
  border-radius: 5px; transition: background 0.15s ease, color 0.15s ease;
}
.iris-copy-btn:hover { background: var(--iris-soft-2); color: var(--text-primary); }

/* "Viewing: <subject>" strip above the input */
.iris-focus {
  display: flex; align-items: center; gap: 7px; flex-shrink: 0;
  padding: 9px 20px; border-top: 1px solid var(--iris-line);
  font-size: 0.84rem; font-weight: 600; color: var(--iris-accent);
}
.iris-focus span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-focus button { background: none; border: none; color: var(--text-muted); display: flex; padding: 2px; border-radius: 5px; }
.iris-focus button:hover { background: var(--iris-soft-2); color: var(--text-primary); }

.iris-input-row {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 14px 20px 16px; border-top: 1px solid var(--iris-line); flex-shrink: 0;
}
.iris-textarea {
  flex: 1; resize: none; border: 1px solid var(--iris-line);
  outline: none; background: var(--iris-soft); color: var(--text-primary);
  font-size: 1rem; font-family: inherit; line-height: 1.5;
  padding: 12px 14px; border-radius: 13px; min-height: 48px; max-height: 180px; box-sizing: border-box;
}
.iris-textarea:focus { border-color: var(--iris-accent); }
.iris-send-btn {
  background: var(--glow-gradient); border: none; color: #04121c;
  width: 48px; height: 48px; border-radius: 13px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.iris-send-btn:not(:disabled):hover { transform: translateY(-1px); }

@media (prefers-reduced-motion: reduce) {
  .iris-popup, .iris-spin, .iris-typing span { animation: none; }
}

@media (max-width: 640px) {
  .iris-popup, .iris-popup-expanded {
    top: 84px; bottom: 12px; right: 12px;
    width: calc(100vw - 24px); max-width: none;
  }
}
`;
