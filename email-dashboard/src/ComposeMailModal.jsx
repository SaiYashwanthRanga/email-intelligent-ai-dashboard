import React, { useState, useEffect } from "react";
import EmailAutocomplete from "./EmailAutocomplete";

const API_BASE = process.env.REACT_APP_API_URL || "http://172.22.6.145:8080/api";

const ComposeMailModal = ({ isOpen, onClose }) => {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showCc, setShowCc] = useState(false);

  const resetCompose = () => {
    setTo(""); setCc(""); setSubject(""); setBody("");
    setError(null); setAttachments([]); setShowCc(false);
  };

  useEffect(() => { if (isOpen) resetCompose(); }, [isOpen]);

  const handleAttachmentSelect = (e) => {
    setAttachments(prev => [...prev, ...Array.from(e.target.files)]);
  };

  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  if (!isOpen) return null;

  const sendEmail = async () => {
    setSending(true);
    setError(null);
    try {
      const formData = new FormData();
      to.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("to", em); });
      cc.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("cc", em); });
      formData.append("subject", subject);
      formData.append("bodyHtml", body.replace(/\n/g, "<br/>"));
      formData.append("fromEmail", localStorage.getItem("userEmail") || "");
      attachments.forEach(file => formData.append("attachments", file));

      const response = await fetch(`${API_BASE}/send-email`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(data));
      resetCompose();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to send email");
    } finally {
      setSending(false);
    }
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
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your message here..."
            style={s.textarea}
          />
          <span style={s.charCount}>{body.length} chars</span>
        </div>

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
          <div style={{ display: 'flex', gap: '10px' }}>
            <input type="file" multiple onChange={handleAttachmentSelect} style={{ display: "none" }} id="attach-input" />
            <label htmlFor="attach-input" style={s.attachBtn}>
              📎 Attach
              {attachments.length > 0 && <span style={s.attachBadge}>{attachments.length}</span>}
            </label>
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
  textarea: {
    flex: 1, border: "none", outline: "none", resize: "none",
    background: "var(--bg-main)", color: "var(--text-primary)",
    fontSize: "0.95rem", lineHeight: "1.75",
    padding: "20px 24px", fontFamily: "inherit", height: "100%",
    boxSizing: "border-box"
  },
  charCount: {
    position: "absolute", bottom: "8px", right: "14px",
    fontSize: "0.68rem", color: "var(--text-secondary)",
    fontVariantNumeric: "tabular-nums", opacity: 0.45, pointerEvents: "none"
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
  }
};