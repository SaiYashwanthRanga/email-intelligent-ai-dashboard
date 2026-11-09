import React, { useState, useEffect, useRef } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import EmailAutocomplete from "./EmailAutocomplete";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
const SIGNATURE_MARKER = "signature-block";

// Replaces the previous <div data-signature-block> in html with a new one (or
// appends one if there wasn't one yet) — so switching signatures never
// disturbs whatever the person actually typed above it.
function mergeSignatureIntoBody(html, signatureHtml) {
  const block = signatureHtml
    ? `<div data-${SIGNATURE_MARKER}="true">${signatureHtml}</div>`
    : "";
  const markerRegex = new RegExp(`<div data-${SIGNATURE_MARKER}="true">[\\s\\S]*?</div>\\s*$`, "i");
  const withoutOldSignature = (html || "").replace(markerRegex, "").trim();
  if (!block) return withoutOldSignature;
  return withoutOldSignature ? `${withoutOldSignature}<br/>${block}` : block;
}

const ComposeMailModal = ({ isOpen, onClose, prefillTo = "", prefillSubject = "", prefillQuotedBody = "", onSent }) => {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [quotedBody, setQuotedBody] = useState("");

  // ── Signatures ───────────────────────────────────────────────────────
  const [signatures, setSignatures] = useState([]);
  const [defaultNewId, setDefaultNewId] = useState(null);
  const [defaultReplyId, setDefaultReplyId] = useState(null);
  const [selectedSignatureId, setSelectedSignatureId] = useState(null);
  const [showSignaturePicker, setShowSignaturePicker] = useState(false);

  // ── Undo-send ────────────────────────────────────────────────────────
  const [undoWindowSeconds, setUndoWindowSeconds] = useState(0);
  const [countdown, setCountdown] = useState(null); // null = not pending, otherwise seconds remaining
  const pendingSendRef = useRef(null); // { formData, endpoint }
  const countdownIntervalRef = useRef(null);

  const resetCompose = () => {
    setTo(prefillTo || ""); setCc(""); setSubject(prefillSubject || ""); setBody("");
    setQuotedBody(prefillQuotedBody || "");
    setError(null); setAttachments([]); setShowCc(false);
    setSelectedSignatureId(null); setShowSignaturePicker(false);
    cancelPendingSend();
  };

  // Open/close — full reset
  useEffect(() => { if (isOpen) resetCompose(); }, [isOpen, prefillTo, prefillSubject]);

  // Quoted body updates independently (fetched async after modal opens)
  // Only update quotedBody state — never wipe the user's typed message
  useEffect(() => {
    if (isOpen) setQuotedBody(prefillQuotedBody || "");
  }, [prefillQuotedBody]);

  // Load send-settings (undo window) and signatures whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    const email = localStorage.getItem("userEmail") || "";
    if (!email) return;

    fetch(`${API_BASE}/send-settings?user_email=${encodeURIComponent(email)}`)
      .then(res => res.json())
      .then(data => setUndoWindowSeconds(data.undoWindowSeconds || 0))
      .catch(() => {});

    fetch(`${API_BASE}/signatures?user_email=${encodeURIComponent(email)}`)
      .then(res => res.json())
      .then(data => {
        setSignatures(data.signatures || []);
        setDefaultNewId(data.defaultNewId || null);
        setDefaultReplyId(data.defaultReplyId || null);
        // Replying (there's a quoted original) uses the reply default; a
        // fresh message uses the new-message default.
        setSelectedSignatureId((prefillQuotedBody ? data.defaultReplyId : data.defaultNewId) || null);
      })
      .catch(() => {});
  }, [isOpen]);

  // Insert/replace the signature block whenever the selection changes.
  useEffect(() => {
    const sigHtml = signatures.find(s => s.id === selectedSignatureId)?.body || "";
    setBody(prev => mergeSignatureIntoBody(prev, sigHtml));
  }, [selectedSignatureId, signatures]);

  const cancelPendingSend = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    pendingSendRef.current = null;
    setCountdown(null);
  };

  useEffect(() => () => cancelPendingSend(), []); // cleanup on unmount

  const handleAttachmentSelect = (e) => {
    setAttachments(prev => [...prev, ...Array.from(e.target.files)]);
  };

  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  if (!isOpen) return null;

  const dispatchSend = async ({ formData, endpoint }) => {
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(data));
      resetCompose();
      onClose();
      if (typeof onSent === "function") onSent({ ok: true, subject });
    } catch (err) {
      const message = err.message || "Failed to send email";
      setError(message);
      if (typeof onSent === "function") onSent({ ok: false, error: message });
    } finally {
      setSending(false);
    }
  };

  const sendEmail = async () => {
    const formData = new FormData();
    to.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("to", em); });
    cc.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("cc", em); });
    formData.append("subject", subject);
    // Combine user's reply body (already HTML from the rich text editor) + quoted original below
    const resolvedQuote = (quotedBody && quotedBody !== "loading") ? quotedBody : "";
    const quotedSection = resolvedQuote
      ? `<br/><br/><hr style="border:none;border-top:1px solid #ccc;margin:16px 0"/>` +
        `<p style="color:#555;font-size:0.85em;margin:0 0 8px 0"><strong>--- Original Message ---</strong></p>` +
        `<div style="color:#333;font-size:0.9em">${resolvedQuote}</div>`
      : "";
    formData.append("bodyHtml", body + quotedSection);
    formData.append("fromEmail", localStorage.getItem("userEmail") || "");
    attachments.forEach(file => formData.append("attachments", file));

    const endpoint = "send-email";

    if (!undoWindowSeconds) {
      await dispatchSend({ formData, endpoint });
      return;
    }

    // Undo window: hold the request and count down before actually firing it.
    pendingSendRef.current = { formData, endpoint };
    setCountdown(undoWindowSeconds);
    countdownIntervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
          const pending = pendingSendRef.current;
          pendingSendRef.current = null;
          if (pending) dispatchSend(pending);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>

        {/* HEADER */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.headerIcon}>✉️</div>
            <div>
              <div style={s.headerTitle}>New Message</div>
              <div style={s.headerSub}>Compose &amp; Send</div>
            </div>
          </div>
          <button onClick={() => { resetCompose(); onClose(); }} style={s.closeBtn}>✕</button>
        </div>

        {/* FIELDS */}
        <div style={s.fields}>

          {/* TO row */}
          <div style={s.fieldRow}>
            <span style={{ ...s.fieldLabel, color: '#3b82f6' }}>TO</span>
            <div style={s.fieldInput}>
              <EmailAutocomplete value={to} onChange={setTo} placeholder="Recipients..." />
            </div>
            <button
              style={{ ...s.ccToggle, color: showCc ? '#3b82f6' : 'var(--text-secondary)', background: showCc ? 'rgba(59,130,246,0.1)' : 'transparent' }}
              onClick={() => setShowCc(p => !p)}
            >CC</button>
          </div>

          {/* CC row — toggled */}
          {showCc && (
            <div style={{ ...s.fieldRow, borderTop: '1px solid var(--border-color)' }}>
              <span style={{ ...s.fieldLabel, color: '#f59e0b' }}>CC</span>
              <div style={s.fieldInput}>
                <EmailAutocomplete value={cc} onChange={setCc} placeholder="CC recipients..." />
              </div>
            </div>
          )}

          {/* SUBJECT row */}
          <div style={{ ...s.fieldRow, borderTop: '1px solid var(--border-color)' }}>
            <span style={{ ...s.fieldLabel, color: '#8b5cf6' }}>SUB</span>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Subject line..."
              style={s.subjectInput}
            />
          </div>
        </div>

        {/* BODY */}
        <div style={s.bodyWrapper}>
          <ReactQuill
            theme="snow"
            value={body}
            onChange={setBody}
            placeholder="Write your message here..."
            style={s.quillWrapper}
          />
        </div>

        {/* QUOTED ORIGINAL EMAIL */}
        {quotedBody && (
          <div style={s.quotedWrapper}>
            <div style={s.quotedHeader}>
              <span style={s.quotedLabel}>--- Original Message ---</span>
              {quotedBody !== "loading" && (
                <button
                  onClick={() => setQuotedBody("")}
                  style={s.quotedRemoveBtn}
                  title="Remove quoted email"
                >✕ Remove</button>
              )}
            </div>
            {quotedBody === "loading" ? (
              <div style={{ padding: "16px 24px", fontSize: "0.8rem", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ display: "inline-block", animation: "spin 0.75s linear infinite", fontSize: "0.9rem" }}>⏳</span>
                Loading original email...
              </div>
            ) : (
              <>
                <style>{`
                  .quoted-body-inner * {
                    color: var(--text-primary) !important;
                    background: transparent !important;
                    background-color: transparent !important;
                  }
                  .quoted-body-inner a { color: #60a5fa !important; }
                `}</style>
                <div
                  className="quoted-body-inner"
                  style={s.quotedBody}
                  dangerouslySetInnerHTML={{ __html: quotedBody }}
                />
              </>
            )}
          </div>
        )}

        {/* ATTACHMENT PILLS */}
        {attachments.length > 0 && (
          <div style={s.attachList}>
            {attachments.map((file, idx) => (
              <div key={idx} style={s.attachItem}>
                <span>📄</span>
                <span style={s.attachName}>{file.name}</span>
                <span style={s.attachSize}>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                <button onClick={() => removeAttachment(idx)} style={s.removeBtn}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ERROR */}
        {error && <div style={s.errorBox}>⚠️ {error}</div>}

        {/* FOOTER */}
        <div style={s.footer}>
          {countdown !== null ? (
            <div style={s.undoBar}>
              <span>Sending in {countdown}s…</span>
              <button onClick={cancelPendingSend} style={s.undoBtn}>Undo</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <input type="file" multiple onChange={handleAttachmentSelect} style={{ display: "none" }} id="attach-input" />
                <label htmlFor="attach-input" style={s.attachBtn}>
                  📎 Attach
                  {attachments.length > 0 && <span style={s.attachBadge}>{attachments.length}</span>}
                </label>
                {signatures.length > 0 && (
                  <div style={{ position: 'relative' }}>
                    <button onClick={() => setShowSignaturePicker(p => !p)} style={s.attachBtn} title="Insert signature">
                      ✍️ Signature
                    </button>
                    {showSignaturePicker && (
                      <div style={s.sigDropdown}>
                        <div
                          style={s.sigDropdownItem}
                          onClick={() => { setSelectedSignatureId(null); setShowSignaturePicker(false); }}
                        >
                          None
                        </div>
                        {signatures.map(sig => (
                          <div
                            key={sig.id}
                            style={{ ...s.sigDropdownItem, fontWeight: selectedSignatureId === sig.id ? '700' : '400' }}
                            onClick={() => { setSelectedSignatureId(sig.id); setShowSignaturePicker(false); }}
                          >
                            {sig.name}
                            {sig.id === defaultNewId && <span style={s.sigBadge}>NEW</span>}
                            {sig.id === defaultReplyId && <span style={s.sigBadge}>REPLY</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { resetCompose(); onClose(); }} disabled={sending} style={s.cancelBtn}>
                  Discard
                </button>
                <button
                  onClick={sendEmail}
                  disabled={sending || !to || !subject}
                  style={{ ...s.sendBtn, opacity: (sending || !to || !subject) ? 0.5 : 1, cursor: (sending || !to || !subject) ? 'not-allowed' : 'pointer' }}
                >
                  {sending ? '⏳ Sending...' : '➤ Send'}
                </button>
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
};

export default ComposeMailModal;

const s = {
  overlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(6px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 2000
  },
  modal: {
    background: "var(--bg-card)", color: "var(--text-primary)",
    borderRadius: "16px", border: "1px solid var(--border-color)",
    boxShadow: "0 30px 80px rgba(0,0,0,0.4)",
    width: "72vw", maxWidth: "900px",
    height: "80vh", maxHeight: "860px",
    display: "flex", flexDirection: "column", overflow: "hidden"
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "18px 24px",
    borderBottom: "2px solid var(--border-color)",
    background: "var(--bg-main)", flexShrink: 0
  },
  headerLeft: { display: "flex", alignItems: "center", gap: "12px" },
  headerIcon: { fontSize: "1.4rem" },
  headerTitle: { fontSize: "1.05rem", fontWeight: "700", letterSpacing: "-0.3px" },
  headerSub: { fontSize: "0.7rem", color: "var(--text-secondary)", fontWeight: "500", textTransform: "uppercase", letterSpacing: "0.8px", marginTop: "2px" },
  closeBtn: {
    background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
    color: "#ef4444", width: "30px", height: "30px", borderRadius: "8px",
    cursor: "pointer", fontSize: "0.8rem", fontWeight: "700",
    display: "flex", alignItems: "center", justifyContent: "center"
  },
  fields: {
    borderBottom: "2px solid var(--border-color)",
    flexShrink: 0, background: "var(--bg-card)"
  },
  fieldRow: {
    display: "flex", alignItems: "center",
    padding: "0 24px", minHeight: "52px"
  },
  fieldLabel: {
    fontSize: "0.66rem", fontWeight: "800",
    letterSpacing: "1.2px", textTransform: "uppercase",
    width: "40px", flexShrink: 0, userSelect: "none"
  },
  fieldInput: { flex: 1, padding: "6px 0" },
  ccToggle: {
    fontSize: "0.66rem", fontWeight: "800", letterSpacing: "1px",
    border: "1px solid var(--border-color)", cursor: "pointer",
    padding: "4px 9px", borderRadius: "6px",
    textTransform: "uppercase", transition: "all 0.15s",
    flexShrink: 0
  },
  subjectInput: {
    flex: 1, border: "none", outline: "none",
    background: "transparent", color: "var(--text-primary)",
    fontSize: "0.95rem", fontWeight: "500", width: "100%",
    padding: "8px 0"
  },
  bodyWrapper: {
    flex: 1, display: "flex", flexDirection: "column",
    position: "relative", overflow: "hidden"
  },
  quillWrapper: {
    flex: 1, display: "flex", flexDirection: "column",
    background: "var(--bg-main)", color: "var(--text-primary)"
  },
  attachList: {
    padding: "10px 24px",
    borderTop: "1px solid var(--border-color)",
    display: "flex", flexWrap: "wrap", gap: "8px",
    background: "var(--bg-card)", flexShrink: 0
  },
  attachItem: {
    display: "flex", alignItems: "center", gap: "6px",
    background: "rgba(59,130,246,0.08)",
    border: "1px solid rgba(59,130,246,0.2)",
    borderRadius: "8px", padding: "5px 10px", fontSize: "0.8rem"
  },
  attachName: {
    color: "var(--text-primary)", fontWeight: "500",
    maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
  },
  attachSize: { color: "var(--text-secondary)", fontSize: "0.72rem" },
  removeBtn: {
    background: "none", border: "none", cursor: "pointer",
    color: "#ef4444", fontSize: "0.72rem", fontWeight: "700",
    padding: "0 2px", lineHeight: 1
  },
  errorBox: {
    margin: "0 24px 8px",
    padding: "10px 14px",
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.25)",
    borderRadius: "8px", fontSize: "0.82rem", color: "#ef4444", flexShrink: 0
  },
  footer: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 24px",
    borderTop: "2px solid var(--border-color)",
    background: "var(--bg-main)", flexShrink: 0
  },
  attachBtn: {
    display: "inline-flex", alignItems: "center", gap: "6px",
    background: "var(--bg-card)", border: "1px solid var(--border-color)",
    padding: "8px 14px", borderRadius: "8px", cursor: "pointer",
    fontSize: "0.82rem", fontWeight: "600", color: "var(--text-primary)"
  },
  attachBadge: {
    background: "#2563eb", color: "white",
    fontSize: "0.65rem", fontWeight: "800",
    borderRadius: "999px", padding: "1px 6px", lineHeight: "1.4"
  },
  sigDropdown: {
    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
    background: "var(--bg-card)", border: "1px solid var(--border-color)",
    borderRadius: "8px", boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
    minWidth: "180px", zIndex: 10, overflow: "hidden"
  },
  sigDropdownItem: {
    padding: "9px 14px", fontSize: "0.82rem", cursor: "pointer",
    color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "6px",
    whiteSpace: "nowrap"
  },
  sigBadge: {
    fontSize: "0.58rem", fontWeight: "800", color: "#00d9ff",
    background: "rgba(0,217,255,0.1)", border: "1px solid rgba(0,217,255,0.25)",
    borderRadius: "4px", padding: "1px 5px"
  },
  cancelBtn: {
    padding: "8px 16px", borderRadius: "8px",
    border: "1px solid var(--border-color)",
    background: "transparent", color: "var(--text-secondary)",
    cursor: "pointer", fontWeight: "600", fontSize: "0.85rem"
  },
  sendBtn: {
    padding: "9px 22px", borderRadius: "8px", border: "none",
    background: "linear-gradient(135deg, #2563eb, #4f46e5)",
    color: "white", fontWeight: "700", fontSize: "0.9rem",
    boxShadow: "0 6px 20px rgba(37,99,235,0.35)",
    transition: "opacity 0.15s"
  },
  undoBar: {
    display: "flex", alignItems: "center", gap: "14px",
    fontSize: "0.88rem", color: "var(--text-primary)", fontWeight: "600",
    width: "100%", justifyContent: "flex-end"
  },
  undoBtn: {
    padding: "7px 16px", borderRadius: "8px", border: "none",
    background: "linear-gradient(135deg, #f59e0b, #d97706)",
    color: "white", fontWeight: "700", fontSize: "0.85rem", cursor: "pointer"
  },
  quotedWrapper: {
    borderTop: "2px solid var(--border-color)",
    background: "var(--bg-main)",
    flexShrink: 0,
    maxHeight: "260px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  quotedHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 24px",
    borderBottom: "1px solid var(--border-color)",
    flexShrink: 0,
  },
  quotedLabel: {
    fontSize: "0.68rem", fontWeight: "800", letterSpacing: "0.8px",
    color: "var(--text-secondary)", textTransform: "uppercase",
  },
  quotedRemoveBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: "0.68rem", fontWeight: "700",
    color: "var(--text-secondary)",
    padding: "2px 6px", borderRadius: "4px",
    opacity: 0.6,
  },
  quotedBody: {
    flex: 1,
    overflowY: "auto",
    padding: "14px 24px",
    fontSize: "0.82rem",
    color: "var(--text-primary)",
    lineHeight: "1.65",
    borderLeft: "3px solid rgba(0,217,255,0.25)",
    marginLeft: "24px",
    marginBottom: "12px",
  },
};
