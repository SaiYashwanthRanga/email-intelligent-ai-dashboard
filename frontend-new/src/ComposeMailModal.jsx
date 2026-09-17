import React, { useState, useEffect, useRef } from "react";
import EmailAutocomplete from "./EmailAutocomplete";
import RichTextToolbar from "./RichTextToolbar";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

const ComposeMailModal = ({ isOpen, onClose, prefillTo = "", prefillSubject = "", prefillQuotedBody = "", useReminderSender = false, onSent }) => {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [quotedBody, setQuotedBody] = useState("");
  const [undoWindowSeconds, setUndoWindowSeconds] = useState(0);
  const [pendingSend, setPendingSend] = useState(null); // { secondsLeft, intervalId, snapshot }
  const [bodyTextLength, setBodyTextLength] = useState(0);
  const bodyRef = useRef(null);

  // ── Signatures (Admin > Signatures) ──────────────────────────────────────
  // Reminder sends go out via reminders@hfmg.net (EWS impersonation), not
  // the person's own name, so they never get a personal signature.
  const [signatures, setSignatures] = useState([]);
  const [defaultNewSignatureId, setDefaultNewSignatureId] = useState(null);
  const [selectedSignatureId, setSelectedSignatureId] = useState(null);
  const [signaturePickerOpen, setSignaturePickerOpen] = useState(false);

  useEffect(() => {
    const userEmail = localStorage.getItem("userEmail") || "";
    if (!userEmail) return;
    fetch(`${API_BASE}/send-settings?user_email=${encodeURIComponent(userEmail)}`)
      .then(r => r.json())
      .then(data => setUndoWindowSeconds(data.undoWindowSeconds || 0))
      .catch(() => {});

    if (useReminderSender) return;
    fetch(`${API_BASE}/signatures?user_email=${encodeURIComponent(userEmail)}`)
      .then(r => r.json())
      .then(data => {
        setSignatures(data.signatures || []);
        setDefaultNewSignatureId(data.defaultNewId || null);
        setSelectedSignatureId(data.defaultNewId || null);
      })
      .catch(() => {});
  }, [useReminderSender]);

  const resetCompose = () => {
    setTo(prefillTo || ""); setCc(""); setSubject(prefillSubject || ""); setBody("");
    setQuotedBody(prefillQuotedBody || "");
    setError(null); setAttachments([]); setShowCc(false); setBodyTextLength(0);
    // contentEditable doesn't re-render from React state — has to be cleared imperatively.
    if (bodyRef.current) bodyRef.current.innerHTML = "";
    // Each new message starts from the "new messages" default again — a
    // per-message switch from the picker never carries over to the next one.
    setSelectedSignatureId(defaultNewSignatureId);
    setSignaturePickerOpen(false);
  };

  // Open/close — full reset
  useEffect(() => { if (isOpen) resetCompose(); }, [isOpen, prefillTo, prefillSubject]);

  // Quoted body updates independently (fetched async after modal opens)
  // Only update quotedBody state — never wipe the user's typed message
  useEffect(() => {
    if (isOpen) setQuotedBody(prefillQuotedBody || "");
  }, [prefillQuotedBody]);

  const handleAttachmentSelect = (e) => {
    setAttachments(prev => [...prev, ...Array.from(e.target.files)]);
  };

  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  if (!isOpen) return null;

  // Takes a frozen snapshot of the compose fields rather than reading
  // component state directly — if the undo window is still counting down
  // when the modal gets closed and reopened for a different email, the
  // queued send must still go out with what was ACTUALLY on screen when
  // Send was clicked, never with whatever the modal now contains.
  const performSend = async (snap) => {
    setSending(true);
    setError(null);
    try {
      const formData = new FormData();
      snap.to.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("to", em); });
      snap.cc.split(",").forEach(e => { const em = e.trim(); if (em) formData.append("cc", em); });
      formData.append("subject", snap.subject);
      // Combine user's reply body + signature + quoted original below
      const signatureSection = snap.signatureBody ? `<br/><br/>${snap.signatureBody}` : "";
      const resolvedQuote = (snap.quotedBody && snap.quotedBody !== "loading") ? snap.quotedBody : "";
      const quotedSection = resolvedQuote
        ? `<br/><br/><hr style="border:none;border-top:1px solid #ccc;margin:16px 0"/>` +
          `<p style="color:#555;font-size:0.85em;margin:0 0 8px 0"><strong>--- Original Message ---</strong></p>` +
          `<div style="color:#333;font-size:0.9em">${resolvedQuote}</div>`
        : "";
      formData.append("bodyHtml", snap.body + signatureSection + quotedSection);
      // Only set fromEmail for regular sends — reminder endpoint uses
      // reminders@hfmg.net via EWS impersonation, no fromEmail needed
      if (!snap.useReminderSender) {
        formData.append("fromEmail", localStorage.getItem("userEmail") || "");
      }
      snap.attachments.forEach(file => formData.append("attachments", file));

      const endpoint = snap.useReminderSender ? "send-reminder" : "send-email";
      const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(data));
      resetCompose();
      onClose();
      if (typeof onSent === "function") onSent({ ok: true, subject: snap.subject });
    } catch (err) {
      const message = err.message || "Failed to send email";
      setError(message);
      if (typeof onSent === "function") onSent({ ok: false, error: message });
    } finally {
      setSending(false);
    }
  };

  const handleSendClick = () => {
    const signatureBody = signatures.find(s => s.id === selectedSignatureId)?.body || "";
    const snapshot = { to, cc, subject, body, quotedBody, attachments, useReminderSender, signatureBody };
    if (!undoWindowSeconds) { performSend(snapshot); return; }
    const intervalId = setInterval(() => {
      setPendingSend(prev => {
        if (!prev) { clearInterval(intervalId); return prev; }
        if (prev.secondsLeft <= 1) {
          clearInterval(intervalId);
          performSend(prev.snapshot);
          return null;
        }
        return { ...prev, secondsLeft: prev.secondsLeft - 1 };
      });
    }, 1000);
    setPendingSend({ secondsLeft: undoWindowSeconds, intervalId, snapshot });
  };

  const cancelPendingSend = () => {
    if (pendingSend?.intervalId) clearInterval(pendingSend.intervalId);
    setPendingSend(null);
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
          <button onClick={() => { if (pendingSend) return; resetCompose(); onClose(); }} style={s.closeBtn}>✕</button>
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
        <style>{`.compose-body-editable:empty:before { content: attr(data-placeholder); color: var(--text-secondary); opacity: 0.6; pointer-events: none; }`}</style>
        <div style={s.bodyWrapper}>
          <RichTextToolbar targetRef={bodyRef} />
          <div
            ref={bodyRef}
            className="compose-body-editable"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Write your message here..."
            onInput={e => { setBody(e.currentTarget.innerHTML); setBodyTextLength(e.currentTarget.innerText.length); }}
            style={s.textarea}
          />
          <span style={s.charCount}>{bodyTextLength} chars</span>
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
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', position: 'relative' }}>
            <input type="file" multiple onChange={handleAttachmentSelect} style={{ display: "none" }} id="attach-input" />
            <label htmlFor="attach-input" style={s.attachBtn}>
              📎 Attach
              {attachments.length > 0 && <span style={s.attachBadge}>{attachments.length}</span>}
            </label>

            {signatures.length > 0 && (
              <>
                <button type="button" onClick={() => setSignaturePickerOpen(o => !o)} style={s.attachBtn} title="Signature">
                  ✍ {signatures.find(sig => sig.id === selectedSignatureId)?.name || 'None'}
                </button>
                {signaturePickerOpen && (
                  <div style={s.signaturePicker}>
                    <button
                      type="button"
                      onClick={() => { setSelectedSignatureId(null); setSignaturePickerOpen(false); }}
                      style={s.signaturePickerItem}
                    >
                      None
                    </button>
                    {signatures.map(sig => (
                      <button
                        type="button"
                        key={sig.id}
                        onClick={() => { setSelectedSignatureId(sig.id); setSignaturePickerOpen(false); }}
                        style={s.signaturePickerItem}
                      >
                        {sig.name}{sig.isDefault ? ' (default)' : ''}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => { resetCompose(); onClose(); }} disabled={sending || !!pendingSend} style={s.cancelBtn}>
              Discard
            </button>
            {pendingSend ? (
              <button onClick={cancelPendingSend} style={{ ...s.sendBtn, background: '#9ca3af', boxShadow: 'none' }}>
                Sending in {pendingSend.secondsLeft}s · Undo
              </button>
            ) : (
              <button
                onClick={handleSendClick}
                disabled={sending || !to || !subject}
                style={{ ...s.sendBtn, opacity: (sending || !to || !subject) ? 0.5 : 1, cursor: (sending || !to || !subject) ? 'not-allowed' : 'pointer' }}
              >
                {sending ? '⏳ Sending...' : '➤ Send'}
              </button>
            )}
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
    boxSizing: "border-box", overflowY: "auto"
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
  signaturePicker: {
    position: "absolute", bottom: "calc(100% + 8px)", left: 0,
    background: "var(--bg-card)", border: "1px solid var(--border-color)",
    borderRadius: "8px", padding: "6px", minWidth: "170px",
    boxShadow: "0 12px 28px rgba(0,0,0,0.35)", zIndex: 10,
    display: "flex", flexDirection: "column", gap: "2px",
  },
  signaturePickerItem: {
    display: "block", width: "100%", textAlign: "left",
    padding: "7px 10px", borderRadius: "6px", border: "none",
    background: "transparent", color: "var(--text-primary)",
    fontSize: "0.82rem", cursor: "pointer",
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