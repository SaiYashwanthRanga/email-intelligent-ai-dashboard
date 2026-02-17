import React, { useState, useEffect } from "react";
import EmailAutocomplete from "./EmailAutocomplete";

const ComposeMailModal = ({ isOpen, onClose }) => {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);

  // --- HELPER: Reset Form ---
  const resetCompose = () => {
    setTo("");
    setCc("");
    setSubject("");
    setBody("");
    setError(null);
    setAttachments([]);
  };

  // --- EFFECT: Reset when modal opens ---
  useEffect(() => {
    if (isOpen) {
      resetCompose();
    }
  }, [isOpen]);

  // --- HANDLER: File attachment selection ---
  const handleAttachmentSelect = (e) => {
    // ⚠️ IMPORTANT: Convert FileList to Array, don't store FileList directly
    const files = Array.from(e.target.files);
    setAttachments(prev => [...prev, ...files]);
  };

  // --- HANDLER: Remove attachment ---
  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  if (!isOpen) return null;

  const sendEmail = async () => {
    setSending(true);
    setError(null);

    try {
      const formData = new FormData();

      // Required fields - lowercase to match backend Form parameters
      to.split(",").forEach(e => {
        const email = e.trim();
        if (email) formData.append("to", email);
      });
      
      cc.split(",").forEach(e => {
        const email = e.trim();
        if (email) formData.append("cc", email);
      });
      
      formData.append("subject", subject);
      formData.append("bodyHtml", body.replace(/\n/g, "<br/>"));

      // Attachments
      if (attachments && attachments.length > 0) {
        attachments.forEach(file => {
          formData.append("attachments", file);
        });
      }

      // 🔍 DEBUG: Log FormData contents
      console.log("🔍 FormData contents:");
      for (let pair of formData.entries()) {
        console.log(pair[0], "→", pair[1]);
      }

      const response = await fetch("http://localhost:8000/api/send-email", {
        method: "POST",
        body: formData  // ✅ NO headers - browser sets multipart/form-data automatically
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(JSON.stringify(data));
      }

      console.log("✅ Email sent successfully:", data);
      resetCompose();
      onClose();
    } catch (err) {
      console.error("❌ Send email failed:", err);
      setError(err.message || "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div 
        style={styles.modal} 
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
      >
        <h3 style={{
          marginBottom: "18px",
          fontSize: "1.2rem",
          fontWeight: "700",
          letterSpacing: "-0.3px"
        }}>
          ✉️ Compose Email
        </h3>

        {/* To Field */}
        <EmailAutocomplete
          label="To"
          value={to}
          onChange={(newValue) => setTo(newValue)}
          placeholder="Search contacts or enter email addresses..."
        />

        {/* CC Field */}
        <EmailAutocomplete
          label="CC"
          value={cc}
          onChange={(newValue) => setCc(newValue)}
          placeholder="Optional - Search contacts or enter email addresses..."
        />

        {/* Subject Field */}
        <div style={styles.fieldContainer}>
          <label style={styles.label}>Subject</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            style={styles.input}
          />
        </div>

        {/* Body Field */}
        <div style={styles.fieldContainer}>
          <label style={styles.label}>Message</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            style={styles.textarea}
          />
        </div>

        {/* Attachments Section */}
        <div style={styles.fieldContainer}>
          <label style={styles.label}>Attachments</label>
          <input
            type="file"
            multiple
            onChange={handleAttachmentSelect}
            style={{ display: "none" }}
            id="attach-input"
          />
          <label 
            htmlFor="attach-input" 
            style={styles.attachBtn}
          >
            📎 Attach Files
          </label>

          {/* Display selected attachments */}
          {attachments.length > 0 && (
            <div style={styles.attachmentsList}>
              {attachments.map((file, idx) => (
                <div key={idx} style={styles.attachmentItem}>
                  <span>
                    📄 {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                  </span>
                  <button
                    onClick={() => removeAttachment(idx)}
                    style={styles.removeBtn}
                    type="button"
                  >
                    ❌
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <div style={styles.actions}>
          <button 
            onClick={() => {
              resetCompose();
              onClose();
            }}
            disabled={sending}
            style={styles.cancelBtn}
          >
            Cancel
          </button>
          <button 
            onClick={sendEmail} 
            disabled={sending || !to || !subject}
            style={styles.sendBtn}
          >
            {sending ? "Sending..." : "Send Email"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ComposeMailModal;

const styles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2000
  },

  modal: {
    background: "var(--bg-card)",
    color: "var(--text-primary)",
    borderRadius: "14px",
    border: "1px solid var(--border-color)",
    boxShadow: "0 25px 60px rgba(0,0,0,0.35)",
    width: "75vw",
    maxWidth: "950px",
    height: "78vh",
    maxHeight: "850px",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto"
  },

  fieldContainer: {
    marginBottom: "16px"
  },

  label: {
    fontSize: "0.75rem",
    fontWeight: "700",
    color: "var(--text-secondary)",
    marginBottom: "6px",
    display: "block",
    textTransform: "uppercase",
    letterSpacing: "0.6px"
  },

  input: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid var(--border-color)",
    background: "var(--bg-main)",
    color: "var(--text-primary)",
    fontSize: "0.9rem",
    outline: "none"
  },

  textarea: {
    width: "100%",
    minHeight: "260px",
    padding: "12px",
    borderRadius: "10px",
    border: "1px solid var(--border-color)",
    background: "var(--bg-main)",
    color: "var(--text-primary)",
    fontSize: "0.95rem",
    resize: "vertical",
    fontFamily: "inherit",
    lineHeight: "1.6"
  },

  attachBtn: {
    background: "var(--bg-main)",
    border: "1px solid var(--border-color)",
    padding: "7px 12px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "600",
    fontSize: "0.85rem",
    color: "var(--text-primary)",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px"
  },

  attachmentsList: {
    marginTop: "10px",
    padding: "10px",
    borderRadius: "8px",
    background: "var(--bg-main)",
    border: "1px solid var(--border-color)"
  },

  attachmentItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 0",
    fontSize: "0.85rem",
    borderBottom: "1px solid var(--border-color)"
  },

  removeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#ef4444",
    fontSize: "0.9rem"
  },

  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "10px",
    marginTop: "auto",
    paddingTop: "16px",
    borderTop: "1px solid var(--border-color)"
  },

  cancelBtn: {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid var(--border-color)",
    background: "transparent",
    color: "var(--text-primary)",
    cursor: "pointer",
    fontWeight: "600"
  },

  sendBtn: {
    padding: "8px 18px",
    borderRadius: "8px",
    border: "none",
    background: "linear-gradient(135deg,#2563eb,#4f46e5)",
    color: "white",
    fontWeight: "700",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(37,99,235,0.35)"
  },

  error: {
    color: "#ef4444",
    fontSize: "0.85rem",
    marginTop: "8px"
  }
};