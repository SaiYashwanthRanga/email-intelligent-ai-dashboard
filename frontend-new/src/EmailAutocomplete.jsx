import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { X, Loader } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

/**
 * EmailAutocomplete — Reusable email input with contact search dropdown.
 *
 * Props:
 *   value       - comma-separated string of selected emails
 *   onChange    - callback(newValue: string)
 *   placeholder - input placeholder text
 *   label       - optional label (e.g. "To", "CC")
 *
 * Optional ref handle (added for callers with a single explicit "confirm"
 * action, e.g. an Add button — existing callers that don't pass a ref are
 * completely unaffected):
 *   getAllEmails() - committed chips PLUS whatever's currently typed but not
 *                    yet confirmed (no dropdown pick, no Enter pressed).
 *   clear()        - clears both committed chips and any pending typed text.
 */
const EmailAutocomplete = forwardRef(({ value, onChange, placeholder = "Search contacts...", label }, ref) => {
  const [inputText, setInputText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  const debounceRef = useRef(null);

  // Parse value into array of selected emails
  const selectedEmails = useMemo(() =>
    value ? value.split(",").map(e => e.trim()).filter(Boolean) : [],
    [value]
  );

  // ─── SEARCH CONTACTS ───
  const searchContacts = useCallback(async (query) => {
    if (!query || query.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    setIsSearching(true);
    try {
      const userEmail = localStorage.getItem("userEmail") || "";
      const res = await fetch(
        `${API_BASE}/search-contacts?q=${encodeURIComponent(query)}&user_email=${encodeURIComponent(userEmail)}`
      );
      const data = await res.json();

      // Filter out already-selected emails
      const filtered = (data || []).filter(
        contact => !selectedEmails.includes(contact.email?.toLowerCase()) &&
                   !selectedEmails.includes(contact.email)
      );

      setSuggestions(filtered);
      setShowDropdown(filtered.length > 0);
      setHighlightIndex(-1);
    } catch (err) {
      console.error("Contact search failed:", err);
      setSuggestions([]);
    } finally {
      setIsSearching(false);
    }
  }, [selectedEmails]);

  // ─── DEBOUNCED INPUT HANDLER ───
  const handleInputChange = (e) => {
    const text = e.target.value;
    setInputText(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      searchContacts(text);
    }, 300);
  };

  // ─── SELECT A CONTACT ───
  const selectContact = (contact) => {
    const email = contact.email;
    const newEmails = [...selectedEmails, email];
    onChange(newEmails.join(", "));
    setInputText("");
    setSuggestions([]);
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  // ─── REMOVE A CHIP ───
  const removeEmail = (emailToRemove) => {
    const newEmails = selectedEmails.filter(e => e !== emailToRemove);
    onChange(newEmails.join(", "));
  };

  // ─── IMPERATIVE HANDLE (opt-in — see doc comment above) ───
  useImperativeHandle(ref, () => ({
    getAllEmails: () => {
      const pending = inputText.trim();
      const all = [...selectedEmails];
      if (pending && pending.includes("@") && !all.includes(pending)) {
        all.push(pending);
      }
      return all;
    },
    clear: () => {
      setInputText("");
      onChange("");
    },
  }), [inputText, selectedEmails, onChange]);

  // ─── KEYBOARD NAVIGATION ───
  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && suggestions[highlightIndex]) {
        selectContact(suggestions[highlightIndex]);
      } else if (inputText.includes("@")) {
        // Allow manual email entry with Enter
        const newEmails = [...selectedEmails, inputText.trim()];
        onChange(newEmails.join(", "));
        setInputText("");
        setShowDropdown(false);
      }
    } else if (e.key === "Backspace" && !inputText && selectedEmails.length > 0) {
      // Remove last chip on backspace when input is empty
      removeEmail(selectedEmails[selectedEmails.length - 1]);
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  // ─── CLOSE DROPDOWN ON OUTSIDE CLICK ───
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        inputRef.current && !inputRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ─── CLEANUP DEBOUNCE ───
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {/* LABEL */}
      {label && (
        <div style={{
          fontSize: "0.75rem", fontWeight: "700", color: "var(--text-secondary)",
          marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.6px"
        }}>
          {label}
        </div>
      )}

      {/* INPUT CONTAINER WITH CHIPS */}
      <div
        style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px",
          padding: "6px 10px", borderRadius: "8px",
          border: "1px solid var(--border-color)",
          background: "var(--bg-main)",
          minHeight: "38px", cursor: "text"
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {/* EMAIL CHIPS */}
        {selectedEmails.map((email, idx) => (
          <div
            key={idx}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              background: "rgba(59, 130, 246, 0.15)",
              border: "1px solid rgba(59, 130, 246, 0.3)",
              borderRadius: "6px", padding: "3px 8px",
              fontSize: "0.8rem", color: "var(--text-primary)",
              fontWeight: "500", maxWidth: "250px"
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {email}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); removeEmail(email); }}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#ef4444", padding: "0 2px", display: "flex",
                alignItems: "center", flexShrink: 0
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}

        {/* TEXT INPUT */}
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
          onClick={(e) => e.stopPropagation()}
          placeholder={selectedEmails.length === 0 ? placeholder : "Add more..."}
          style={{
            flex: 1, minWidth: "120px", border: "none", outline: "none",
            background: "transparent", color: "var(--text-primary)",
            fontSize: "0.85rem", padding: "4px 0"
          }}
        />

        {/* SEARCH INDICATOR */}
        {isSearching && (
          <Loader size={14} className="animate-spin" style={{ color: "#3b82f6", flexShrink: 0 }} />
        )}
      </div>

      {/* DROPDOWN */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          style={{
            position: "absolute", top: "100%", left: 0, right: 0,
            marginTop: "4px", zIndex: 3000,
            // Dedicated opaque background — NOT var(--bg-card) (5.5% opacity).
            // That variable is meant for in-flow page cards resting on the
            // aurora background; on a floating dropdown it let whatever sits
            // underneath (e.g. the reply textarea's placeholder text) bleed
            // through the suggestion rows. Same fix already applied to the
            // Iris popup and the profile dropdown elsewhere in the app.
            background: "rgba(16, 18, 24, 0.96)",
            backdropFilter: "blur(40px) saturate(160%)",
            WebkitBackdropFilter: "blur(40px) saturate(160%)",
            transform: "translateZ(0)",   // GPU compositing so backdrop-filter renders correctly
            border: "1px solid var(--border-color)",
            borderRadius: "10px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
            maxHeight: "220px", overflowY: "auto"
          }}
        >
          {suggestions.map((contact, idx) => (
            <div
              key={idx}
              onClick={(e) => { e.stopPropagation(); selectContact(contact); }}
              onMouseEnter={() => setHighlightIndex(idx)}
              style={{
                display: "flex", alignItems: "center", gap: "10px",
                padding: "10px 14px", cursor: "pointer",
                background: highlightIndex === idx ? "rgba(59, 130, 246, 0.15)" : "transparent",
                borderBottom: idx < suggestions.length - 1 ? "1px solid var(--border-color)" : "none",
                transition: "background 0.15s"
              }}
            >
              {/* AVATAR */}
              <div style={{
                width: "32px", height: "32px", borderRadius: "50%",
                background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "white", fontSize: "0.75rem", fontWeight: "700", flexShrink: 0
              }}>
                {(contact.name || contact.email || "?").charAt(0).toUpperCase()}
              </div>

              {/* NAME + EMAIL */}
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div style={{
                  fontSize: "0.85rem", fontWeight: "600",
                  color: "var(--text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                }}>
                  {contact.name || contact.email}
                </div>
                {contact.name && (
                  <div style={{
                    fontSize: "0.75rem", color: "var(--text-secondary)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                  }}>
                    {contact.email}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

EmailAutocomplete.displayName = "EmailAutocomplete";

export default EmailAutocomplete;