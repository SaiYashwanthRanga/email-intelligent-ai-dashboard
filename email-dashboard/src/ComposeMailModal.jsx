import React, { useState, useEffect } from "react";

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
        <h3 style={{ marginBottom: "20px", fontSize: "1.2rem" }}>Compose Email</h3>

        {/* To Field */}
        <div style={styles.fieldContainer}>
          <label style={styles.label}>To</label>
          <input
            type="text"
            placeholder="email@domain.com, email2@domain.com"
            value={to}
            onChange={e => setTo(e.target.value)}
            style={styles.input}
          />
        </div>

        {/* CC Field */}
        <div style={styles.fieldContainer}>
          <label style={styles.label}>CC</label>
          <input
            type="text"
            placeholder="optional"
            value={cc}
            onChange={e => setCc(e.target.value)}
            style={styles.input}
          />
        </div>

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
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(2px)"
  },
  modal: {
    background: "#fff",
    padding: "24px",
    borderRadius: "12px",
    boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
    width: "70vw",
    maxWidth: "900px",
    height: "75vh",
    maxHeight: "800px",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto"
  },
  fieldContainer: {
    marginBottom: "14px"
  },
  label: {
    display: "block",
    marginBottom: "6px",
    fontWeight: "600",
    fontSize: "0.85rem",
    color: "#374151"
  },
  input: {
    width: "100%",
    padding: "10px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    fontSize: "0.95rem",
    outline: "none",
    transition: "border-color 0.2s"
  },
  textarea: {
    width: "100%",
    minHeight: "300px",
    padding: "12px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    fontSize: "0.95rem",
    lineHeight: "1.6",
    outline: "none",
    resize: "vertical",
    fontFamily: "inherit"
  },
  attachBtn: {
    display: "inline-block",
    padding: "8px 12px",
    background: "#f3f4f6",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "500",
    fontSize: "0.9rem",
    color: "#374151",
    transition: "background-color 0.2s",
    userSelect: "none"
  },
  attachmentsList: {
    marginTop: "10px",
    padding: "10px",
    background: "#f9fafb",
    borderRadius: "6px",
    border: "1px solid #e5e7eb"
  },
  attachmentItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 0",
    fontSize: "0.9rem",
    color: "#374151",
    borderBottom: "1px solid #e5e7eb"
  },
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: "1rem",
    transition: "opacity 0.2s"
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    marginTop: "auto",
    paddingTop: "20px"
  },
  cancelBtn: {
    padding: "8px 16px",
    border: "1px solid #d1d5db",
    background: "white",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "500",
    color: "#374151"
  },
  sendBtn: {
    padding: "8px 20px",
    border: "none",
    background: "#2563eb",
    color: "white",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "600",
    boxShadow: "0 2px 4px rgba(37, 99, 235, 0.2)"
  },
  error: {
    color: "#dc2626",
    fontSize: "14px",
    marginTop: "10px",
    textAlign: "center"
  }
};