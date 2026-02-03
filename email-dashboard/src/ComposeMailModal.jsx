import React, { useState, useEffect } from "react";

const ComposeMailModal = ({ isOpen, onClose }) => {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  // --- HELPER: Reset Form ---
  const resetCompose = () => {
    setTo("");
    setCc("");
    setSubject("");
    setBody("");
    setError(null);
  };

  // --- EFFECT: Reset when modal opens ---
  useEffect(() => {
    if (isOpen) {
      resetCompose();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const sendEmail = async () => {
    setSending(true);
    setError(null);

    const payload = {
      to: to.split(",").map(e => e.trim()).filter(Boolean),
      cc: cc.split(",").map(e => e.trim()).filter(Boolean),
      subject,
      bodyHtml: body.replace(/\n/g, "<br/>") // Ensure line breaks are preserved
    };

    try {
      const response = await fetch("http://localhost:8000/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to send email");
      }

      // ✅ SUCCESS: Reset form and close
      resetCompose();
      onClose(); 
    } catch (err) {
      setError(err.message);
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
    background: "rgba(0,0,0,0.5)", // slightly darker overlay
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
    // ✅ INCREASED SIZE
    width: "70vw",
    maxWidth: "900px",
    height: "75vh",
    maxHeight: "800px",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto" // Allow scrolling if content overflows
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
    // ✅ INCREASED HEIGHT
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
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    marginTop: "auto", // Pushes actions to bottom
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