import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import {
  ChevronLeft, ChevronRight, Calendar, Clock, MapPin, Users,
  X, ArrowLeft, AlertCircle, Loader, User, RefreshCw
} from "lucide-react";
import "./Calendar.css";
import ToastContainer from "./Toast";

// ─── Config ───────────────────────────────────────────────
const API_BASE    = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
const ORG_API     = `${API_BASE}/meetings`;
const getUserEmail = () => localStorage.getItem("userEmail") || "";

const DAYS_SHORT  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS      = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

// ─── Colour palette for event categories ──────────────────
const EVENT_COLORS = [
  { bg: "rgba(37,99,235,0.85)",   border: "#2563eb", label: "#93c5fd" },
  { bg: "rgba(124,58,237,0.85)",  border: "#7c3aed", label: "#c4b5fd" },
  { bg: "rgba(5,150,105,0.85)",   border: "#059669", label: "#6ee7b7" },
  { bg: "rgba(220,38,38,0.85)",   border: "#dc2626", label: "#fca5a5" },
  { bg: "rgba(234,88,12,0.85)",   border: "#ea580c", label: "#fdba74" },
  { bg: "rgba(8,145,178,0.85)",   border: "#0891b2", label: "#67e8f9" },
];

const getEventColor = (meetingId) => {
  if (!meetingId) return EVENT_COLORS[0];
  const code = meetingId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return EVENT_COLORS[code % EVENT_COLORS.length];
};

// ─── Helpers ──────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");

const toDateKey = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const formatTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatDuration = (start, end) => {
  if (!start || !end) return "";
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const startOfWeek = (d) => {
  const c = new Date(d);
  c.setDate(c.getDate() - c.getDay());
  return c;
};

// ─── Clean HTML body text ──────────────────────────────────
const cleanBody = (raw) => {
  if (!raw) return "";
  let text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const txt = document.createElement("textarea");
  txt.innerHTML = text;
  text = txt.value;
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
};

// ─── RSVP Action Buttons config ───────────────────────────
const RSVP_OPTIONS = [
  {
    action: "Accept",
    label: "Accept",
    emoji: "✅",
    activeStyle: { background: "rgba(5,150,105,0.85)", borderColor: "#059669", color: "#fff" },
    hoverClass: "cal-rsvp-accept"
  },
  {
    action: "Reject",
    label: "Decline",
    emoji: "❌",
    activeStyle: { background: "rgba(220,38,38,0.85)", borderColor: "#dc2626", color: "#fff" },
    hoverClass: "cal-rsvp-decline"
  }
];

// ─── Event Detail Panel ───────────────────────────────────
const EventPanel = ({ event, onClose, rsvpStatus, onRsvp }) => {
  if (!event) return null;
  const color = getEventColor(event.meetingId);

  const meetingId = event.meetingId || event.id;
  const rsvp = rsvpStatus?.[meetingId] || { status: null, loading: false, error: null };

  return (
    <div className="cal-event-panel" onClick={(e) => e.stopPropagation()}>
      <div className="cal-ep-header" style={{ borderBottom: `3px solid ${color.border}` }}>
        <div className="cal-ep-color-dot" style={{ background: color.border }} />
        <h3 className="cal-ep-subject">{event.subject || "No Title"}</h3>
        <button className="cal-ep-close" onClick={onClose}><X size={18} /></button>
      </div>

      <div className="cal-ep-body">
        {/* Time */}
        <div className="cal-ep-row">
          <Clock size={15} className="cal-ep-icon" />
          <div>
            {event.isAllDay ? (
              <span className="cal-ep-value">All Day</span>
            ) : (
              <span className="cal-ep-value">
                {formatTime(event.start)} – {formatTime(event.end)}
                <span className="cal-ep-meta"> · {formatDuration(event.start, event.end)}</span>
              </span>
            )}
            <div className="cal-ep-meta">
              {new Date(event.start).toLocaleDateString("en-US", {
                weekday: "long", month: "long", day: "numeric", year: "numeric"
              })}
            </div>
          </div>
        </div>

        {/* Location */}
        {event.location && (
          <div className="cal-ep-row">
            <MapPin size={15} className="cal-ep-icon" />
            <span className="cal-ep-value">{event.location}</span>
          </div>
        )}

        {/* Organizer */}
        {event.organizer && (
          <div className="cal-ep-row">
            <User size={15} className="cal-ep-icon" />
            <div>
              <div className="cal-ep-label">Organizer</div>
              <span className="cal-ep-value">{event.organizer}</span>
            </div>
          </div>
        )}

        {/* Required attendees */}
        {event.requiredAttendees?.length > 0 && (
          <div className="cal-ep-row">
            <Users size={15} className="cal-ep-icon" />
            <div>
              <div className="cal-ep-label">Required</div>
              {event.requiredAttendees.map((a, i) => (
                <div key={i} className="cal-ep-attendee">{a}</div>
              ))}
            </div>
          </div>
        )}

        {/* Optional attendees */}
        {event.optionalAttendees?.length > 0 && (
          <div className="cal-ep-row">
            <Users size={15} className="cal-ep-icon" style={{ opacity: 0.5 }} />
            <div>
              <div className="cal-ep-label">Optional</div>
              {event.optionalAttendees.map((a, i) => (
                <div key={i} className="cal-ep-attendee" style={{ opacity: 0.7 }}>{a}</div>
              ))}
            </div>
          </div>
        )}

        {/* ── RSVP SECTION ─── */}
        {!event.isCancelled && meetingId && (
          <div className="cal-rsvp-section">
            <div className="cal-ep-label" style={{ marginBottom: "10px" }}>
              Your Response
            </div>

            {rsvp.status && (
              <div className={`cal-rsvp-current-badge cal-rsvp-badge-${rsvp.status.toLowerCase()}`}>
                {rsvp.status === "Accept" && "✅ You accepted this meeting"}
                {rsvp.status === "Reject" && "❌ You declined this meeting"}
              </div>
            )}

            <div className="cal-rsvp-buttons">
              {RSVP_OPTIONS.map(({ action, label, emoji, activeStyle, hoverClass }) => {
                const isActive   = rsvp.status === action;
                const isLoading  = rsvp.loading === action;
                const isDisabled = !!rsvp.loading;

                return (
                  <button
                    key={action}
                    className={`cal-rsvp-btn ${hoverClass} ${isActive ? "cal-rsvp-btn-active" : ""}`}
                    style={isActive ? activeStyle : {}}
                    disabled={isDisabled}
                    onClick={() => onRsvp(meetingId, action)}
                    title={`${label} this meeting`}
                  >
                    {isLoading
                      ? <Loader size={13} className="cal-rsvp-spin" />
                      : <span style={{ fontSize: "0.85rem" }}>{emoji}</span>
                    }
                    <span>{isLoading ? (action === "Accept" ? "Accepting…" : "Declining…") : label}</span>
                  </button>
                );
              })}
            </div>

            {rsvp.error && (
              <div className="cal-rsvp-error">
                <AlertCircle size={13} /> {rsvp.error}
              </div>
            )}
          </div>
        )}

        {/* Body */}
        {event.body && (
          <div className="cal-ep-section">
            <div className="cal-ep-label" style={{ marginBottom: "8px" }}>Description</div>
            <div className="cal-ep-desc">
              {cleanBody(event.body).split("\n").map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} style={{ height: "8px" }} />;

                const zoomMatch = trimmed.match(/https?:\/\/[^\s]+zoom\.us[^\s]*/i);
                if (zoomMatch) {
                  return (
                    <div key={i} style={{ margin: "6px 0" }}>
                      <a href={zoomMatch[0]} target="_blank" rel="noopener noreferrer"
                        style={{ color: "#38bdf8", fontWeight: "700", fontSize: "0.82rem",
                          wordBreak: "break-all", display: "flex", alignItems: "center", gap: "5px" }}>
                        🎥 Join Zoom Meeting
                      </a>
                    </div>
                  );
                }

                if (/meeting id/i.test(trimmed)) {
                  return (
                    <div key={i} style={{ background: "rgba(0,217,255,0.08)",
                      border: "1px solid rgba(0,217,255,0.2)", borderRadius: "6px",
                      padding: "5px 10px", fontWeight: "700", fontSize: "0.8rem",
                      color: "#00d9ff", margin: "4px 0" }}>
                      🔑 {trimmed}
                    </div>
                  );
                }

                if (/^(agenda|dial|join|h\.323|sip):/i.test(trimmed)) {
                  return (
                    <div key={i} style={{ fontWeight: "700", fontSize: "0.78rem",
                      color: "#a8c5e0", textTransform: "uppercase", letterSpacing: "0.6px",
                      marginTop: "10px", marginBottom: "2px" }}>
                      {trimmed}
                    </div>
                  );
                }

                if (/^\+?1\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(trimmed) ||
                    /^\d{3}\s\d{3}\s\d{4}/.test(trimmed)) {
                  return (
                    <div key={i} style={{ fontSize: "0.74rem", color: "#6b7f99", paddingLeft: "8px" }}>
                      📞 {trimmed}
                    </div>
                  );
                }

                return (
                  <div key={i} style={{ fontSize: "0.82rem", lineHeight: "1.6", color: "#a8c5e0" }}>
                    {trimmed}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {event.isCancelled && (
          <div className="cal-ep-cancelled">
            <AlertCircle size={14} /> This event has been cancelled
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Month Cell Event Chip ────────────────────────────────
const EventChip = ({ event, onClick }) => {
  const color = getEventColor(event.meetingId);
  return (
    <div
      className={`cal-chip ${event.isCancelled ? "cal-chip-cancelled" : ""}`}
      style={{ background: color.bg, borderLeft: `3px solid ${color.border}` }}
      onClick={(e) => { e.stopPropagation(); onClick(event); }}
      title={event.subject}
    >
      {!event.isAllDay && (
        <span className="cal-chip-time">{formatTime(event.start)}</span>
      )}
      <span className="cal-chip-title">{event.subject}</span>
    </div>
  );
};

// ─── Day Brief Modal ──────────────────────────────────────
const DayBriefModal = ({ date, meetings, onClose, rsvpStatus }) => {
  const [aiSummary, setAiSummary] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const todayNow = new Date();
  const isToday_ = isSameDay(date, todayNow);
  const sorted   = [...meetings].sort((a, b) => new Date(a.start) - new Date(b.start));

  const nextMeeting  = isToday_ ? sorted.find(m => !m.isAllDay && new Date(m.end) > todayNow) : null;
  const isInProgress = nextMeeting && new Date(nextMeeting.start) <= todayNow;

  const countdown = (() => {
    if (!nextMeeting) return null;
    if (isInProgress) return "In progress now";
    const diff = Math.round((new Date(nextMeeting.start) - todayNow) / 60000);
    if (diff <= 0) return "Starting now";
    if (diff < 60) return `Next in ${diff}m`;
    const h = Math.floor(diff / 60), m = diff % 60;
    return `Next in ${h}h${m ? ` ${m}m` : ""}`;
  })();

  const totalMins = sorted.reduce((acc, m) => {
    if (m.isAllDay) return acc;
    return acc + Math.round((new Date(m.end) - new Date(m.start)) / 60000);
  }, 0);

  const formatTotal = (mins) => {
    if (!mins) return "";
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };

  const dateLabel = isToday_
    ? `Today — ${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`
    : date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Fetch AI summary on mount
  useEffect(() => {
    if (!date || !meetings || meetings.length === 0) return;
    let cancelled = false;
    setAiLoading(true);
    setAiSummary("");
    axios.post(`${API_BASE}/meetings/day-brief`, { meetings, dateLabel })
      .then(res => { if (!cancelled) setAiSummary(res.data.summary || ""); })
      .catch(() => { if (!cancelled) setAiSummary(""); })
      .finally(() => { if (!cancelled) setAiLoading(false); });
    return () => { cancelled = true; };
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!date || !meetings || meetings.length === 0) return null;

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-modal" onClick={e => e.stopPropagation()}>
        <div className="brief-header">
          <div className="brief-header-info">
            <div className="brief-date-label">{dateLabel}</div>
            <div className="brief-subtitle">
              {sorted.length} meeting{sorted.length !== 1 ? "s" : ""}
              {totalMins > 0 && ` · ${formatTotal(totalMins)} total`}
              {countdown && <span className="brief-countdown"> · {countdown}</span>}
            </div>
          </div>
          <button className="brief-close" onClick={onClose}><X size={18} /></button>
        </div>

        {/* AI Summary paragraph */}
        <div className="brief-ai-section">
          {aiLoading ? (
            <div className="brief-ai-loading">
              <Loader size={13} className="brief-ai-spin" />
              <span>Generating brief…</span>
            </div>
          ) : aiSummary ? (
            <p className="brief-ai-text">{aiSummary}</p>
          ) : null}
        </div>

        <div className="brief-list">
          {sorted.map((ev, i) => {
            const col        = getEventColor(ev.meetingId);
            const id         = ev.meetingId || ev.id;
            const rsvp       = rsvpStatus?.[id];
            const isNext     = nextMeeting && (nextMeeting.meetingId === ev.meetingId || nextMeeting.id === ev.id);
            const inProgress = isNext && isInProgress;

            return (
              <div
                key={i}
                className={`brief-item ${isNext ? "brief-item-next" : ""} ${ev.isCancelled ? "brief-item-cancelled" : ""}`}
                style={{ borderLeft: `3px solid ${col.border}` }}
              >
                <div className="brief-item-time">
                  <span className="brief-time-text">
                    {ev.isAllDay ? "All day" : formatTime(ev.start)}
                  </span>
                  {!ev.isAllDay && (
                    <span className="brief-duration">{formatDuration(ev.start, ev.end)}</span>
                  )}
                </div>
                <div className="brief-item-info">
                  <div className="brief-item-title">{ev.subject}</div>
                  {ev.location && (
                    <div className="brief-item-loc"><MapPin size={10} /> {ev.location}</div>
                  )}
                  <div className="brief-item-badges">
                    {inProgress  && <span className="brief-badge brief-badge-progress">In progress</span>}
                    {isNext && !inProgress && <span className="brief-badge brief-badge-next">Next up</span>}
                    {ev.isCancelled && <span className="brief-badge brief-badge-cancelled">Cancelled</span>}
                    {rsvp?.status === "Accept" && <span className="brief-badge brief-badge-accept">✅ Accepted</span>}
                    {rsvp?.status === "Reject"  && <span className="brief-badge brief-badge-decline">❌ Declined</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── Main Calendar Component ──────────────────────────────
const CalendarView = () => {
  const navigate = useNavigate();
  const today    = new Date();

  const [view,          setView]         = useState("month");
  const [cursor,        setCursor]       = useState(new Date());
  const [meetings,      setMeetings]     = useState([]);
  const [loading,       setLoading]      = useState(false);
  const [error,         setError]        = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [expandedCells, setExpandedCells] = useState({});

  const [rsvpStatus, setRsvpStatus] = useState({});
  const [briefDate,  setBriefDate]  = useState(null);
  const [showBrief,  setShowBrief]  = useState(false);

  // ─── Toast feedback ───
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
  };
  const removeToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  // ── Client-side meetings cache: key = "startDate|endDate" → meetings[] ──
  // Avoids re-fetching the same month every time the user navigates back.
  const meetingsCacheRef = useRef({});
  const hasAutoOpenedRef = useRef(false);
  const prevNavRef       = useRef({ month: new Date().getMonth(), year: new Date().getFullYear(), view: "month" });

  const toggleCellExpand = (e, key) => {
    e.stopPropagation();
    setExpandedCells(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const [username] = useState(
    localStorage.getItem("loggedInUser") || "User"
  );

  // ─── Date range to fetch ──────────────────────────────
  const fetchRange = useMemo(() => {
    let start, end;
    if (view === "month") {
      start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      end   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    } else if (view === "week") {
      start = startOfWeek(cursor);
      end   = new Date(start); end.setDate(end.getDate() + 6);
    } else {
      start = new Date(cursor); end = new Date(cursor);
    }
    return { startDate: toDateKey(start), endDate: toDateKey(end) };
  }, [cursor, view]);

  // ─── Fetch meetings (cache-aware) ────────────────────
  const fetchMeetings = useCallback(async (forceRefresh = false) => {
    const cacheKey = `${fetchRange.startDate}|${fetchRange.endDate}`;

    // Return cached data instantly if available and not a forced refresh
    if (!forceRefresh && meetingsCacheRef.current[cacheKey]) {
      setMeetings(meetingsCacheRef.current[cacheKey]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(ORG_API, {
        params: { email: getUserEmail(), startDate: fetchRange.startDate, endDate: fetchRange.endDate }
      });
      const data = Array.isArray(res.data) ? res.data : [];
      meetingsCacheRef.current[cacheKey] = data;   // store in cache
      setMeetings(data);
    } catch (err) {
      console.error("Calendar fetch error:", err);
      setError("Unable to load meetings. Check your connection.");
      addToast("Unable to load meetings. Check your connection.", "error");
      setMeetings([]);
    } finally {
      setLoading(false);
    }
  }, [fetchRange]);

  useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

  // ─── Meetings mapped by date key ─────────────────────
  const meetingsByDate = useMemo(() => {
    const map = {};
    meetings.forEach(m => {
      const key = toDateKey(new Date(m.start));
      if (!map[key]) map[key] = [];
      map[key].push(m);
    });
    return map;
  }, [meetings]);

  // ─── Brief modal helpers ──────────────────────────────
  const openBrief = useCallback((date) => {
    const key = toDateKey(date);
    if ((meetingsByDate[key] || []).length === 0) { setShowBrief(false); return; }
    setBriefDate(new Date(date));
    setShowBrief(true);
  }, [meetingsByDate]);

  // Auto-open for today on first successful load
  useEffect(() => {
    if (hasAutoOpenedRef.current) return;
    const todayKey = toDateKey(today);
    if ((meetingsByDate[todayKey] || []).length > 0) {
      hasAutoOpenedRef.current = true;
      setBriefDate(new Date(today));
      setShowBrief(true);
    }
  }, [meetingsByDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close brief when navigating to a different month or switching view
  useEffect(() => {
    const prev = prevNavRef.current;
    if (prev.month !== cursor.getMonth() || prev.year !== cursor.getFullYear() || prev.view !== view) {
      setShowBrief(false);
    }
    prevNavRef.current = { month: cursor.getMonth(), year: cursor.getFullYear(), view };
  }, [cursor, view]);

  // ─── Navigation ──────────────────────────────────────
  const navigate_ = (dir) => {
    setCursor(prev => {
      const d = new Date(prev);
      if (view === "month") d.setMonth(d.getMonth() + dir);
      else if (view === "week") d.setDate(d.getDate() + dir * 7);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  };

  const goToday = () => setCursor(new Date());

  // ─── RSVP respond ────────────────────────────────────
  const respondToMeeting = useCallback(async (meetingId, action) => {
    if (!meetingId) return;
    setRsvpStatus(prev => ({
      ...prev,
      [meetingId]: { ...prev[meetingId], loading: action, error: null }
    }));
    try {
      const res = await axios.post(`${API_BASE}/meetings/respond`, null, {
        params: { meetingId, action, targetUserEmail: getUserEmail() }
      });
      console.log(`✅ Meeting ${action} successful:`, res.data);
      setRsvpStatus(prev => ({
        ...prev,
        [meetingId]: { status: action, loading: false, error: null }
      }));
      const actionLabel = { accept: "Accepted", decline: "Declined", tentative: "Marked tentative" }[action] || "Response sent";
      addToast(`${actionLabel} ✓`, "success");
    } catch (err) {
      const errMsg =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err.message ||
        "Failed to respond to meeting";
      console.error(`❌ Meeting ${action} failed:`, errMsg);
      setRsvpStatus(prev => ({
        ...prev,
        [meetingId]: { ...prev[meetingId], loading: false, error: errMsg }
      }));
      addToast(errMsg, "error");
    }
  }, []);

  // ─── View title ───────────────────────────────────────
  const viewTitle = useMemo(() => {
    if (view === "month")
      return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
    if (view === "week") {
      const ws = startOfWeek(cursor);
      const we = new Date(ws); we.setDate(we.getDate() + 6);
      if (ws.getMonth() === we.getMonth())
        return `${MONTHS[ws.getMonth()]} ${ws.getDate()}–${we.getDate()}, ${ws.getFullYear()}`;
      return `${MONTHS[ws.getMonth()]} ${ws.getDate()} – ${MONTHS[we.getMonth()]} ${we.getDate()}, ${ws.getFullYear()}`;
    }
    return cursor.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric"
    });
  }, [cursor, view]);

  // ─── Month grid ───────────────────────────────────────
  const monthGrid = useMemo(() => {
    const year  = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDay; i++) {
      const d = new Date(year, month, -firstDay + i + 1);
      cells.push({ date: d, current: false });
    }
    for (let d = 1; d <= daysInMonth; d++)
      cells.push({ date: new Date(year, month, d), current: true });
    const remaining = 42 - cells.length;
    for (let i = 1; i <= remaining; i++)
      cells.push({ date: new Date(year, month + 1, i), current: false });
    return cells;
  }, [cursor]);

  // ─── Week days ────────────────────────────────────────
  const weekDays = useMemo(() => {
    const ws = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws); d.setDate(d.getDate() + i);
      return d;
    });
  }, [cursor]);

  // ─── Event click ─────────────────────────────────────
  const handleEventClick = (event) => setSelectedEvent(event);
  const closePanel       = () => setSelectedEvent(null);

  // ─── Sorted meetings for the currently selected day ──
  const cursorDayMeetings = useMemo(() => {
    const key = toDateKey(cursor);
    return (meetingsByDate[key] || [])
      .slice()
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }, [meetingsByDate, cursor]);

  // ─── MONTH VIEW ───────────────────────────────────────
  const MonthView = () => (
    <div className="cal-month">
      <div className="cal-month-header-row">
        {DAYS_SHORT.map(d => (
          <div key={d} className="cal-month-day-label">{d}</div>
        ))}
      </div>
      <div className="cal-month-grid">
        {monthGrid.map((cell, idx) => {
          const key    = toDateKey(cell.date);
          const events = meetingsByDate[key] || [];
          const isToday = isSameDay(cell.date, today);
          const isSel   = selectedEvent && isSameDay(cell.date, new Date(selectedEvent.start));

          return (
            <div
              key={idx}
              className={`cal-month-cell
                ${!cell.current ? "cal-cell-muted" : ""}
                ${isToday ? "cal-cell-today" : ""}
                ${isSel ? "cal-cell-selected" : ""}
              `}
              onClick={() => { closePanel(); setCursor(cell.date); openBrief(cell.date); }}
            >
              <div className={`cal-cell-num ${isToday ? "cal-cell-num-today" : ""}`}>
                {cell.date.getDate()}
              </div>
              <div className="cal-cell-events">
                {(expandedCells[key] ? events : events.slice(0, 3)).map((ev, i) => (
                  <EventChip key={i} event={ev} onClick={handleEventClick} />
                ))}
                {events.length > 3 && !expandedCells[key] && (
                  <div className="cal-chip-more" onClick={(e) => toggleCellExpand(e, key)}>
                    +{events.length - 3} more
                  </div>
                )}
                {expandedCells[key] && events.length > 3 && (
                  <div className="cal-chip-more cal-chip-collapse" onClick={(e) => toggleCellExpand(e, key)}>
                    ▲ Show less
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── WEEK VIEW ────────────────────────────────────────
  const WeekView = () => (
    <div className="cal-week">
      <div className="cal-week-header">
        <div className="cal-week-time-gutter" />
        {weekDays.map((d, i) => {
          const isToday_ = isSameDay(d, today);
          const key      = toDateKey(d);
          const count    = (meetingsByDate[key] || []).length;
          return (
            <div key={i} className={`cal-week-col-header ${isToday_ ? "cal-week-col-today" : ""}`}
              onClick={() => { setCursor(d); openBrief(d); }}>
              <div className="cal-week-dayname">{DAYS_SHORT[d.getDay()]}</div>
              <div className={`cal-week-daynum ${isToday_ ? "cal-week-daynum-today" : ""}`}>{d.getDate()}</div>
              {count > 0 && <div className="cal-week-event-dot">{count} {count === 1 ? "event" : "events"}</div>}
            </div>
          );
        })}
      </div>

      <div className="cal-week-body">
        <div className="cal-week-hours">
          {HOURS.map(h => (
            <div key={h} className="cal-week-hour-label">
              {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
            </div>
          ))}
        </div>
        <div className="cal-week-columns">
          {weekDays.map((d, di) => {
            const key      = toDateKey(d);
            const events   = (meetingsByDate[key] || []).filter(e => !e.isAllDay);
            const isToday_ = isSameDay(d, today);
            return (
              <div key={di} className={`cal-week-col ${isToday_ ? "cal-week-col-active" : ""}`}>
                {HOURS.map(h => <div key={h} className="cal-week-slot" />)}
                {isToday_ && (() => {
                  const now = new Date();
                  const pct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
                  return <div className="cal-now-line" style={{ top: `${pct}%` }}><div className="cal-now-dot" /></div>;
                })()}
                {events.map((ev, ei) => {
                  const s   = new Date(ev.start);
                  const e_  = new Date(ev.end);
                  const top = ((s.getHours() * 60 + s.getMinutes()) / 1440) * 100;
                  const h   = Math.max(((e_ - s) / 60000 / 1440) * 100, 1.5);
                  const col = getEventColor(ev.meetingId);
                  return (
                    <div key={ei}
                      className={`cal-week-event ${ev.isCancelled ? "cal-event-cancelled" : ""}`}
                      style={{ top: `${top}%`, height: `${h}%`, background: col.bg, borderLeft: `3px solid ${col.border}` }}
                      onClick={(e) => { e.stopPropagation(); handleEventClick(ev); }}
                      title={ev.subject}>
                      <div className="cal-we-title">{ev.subject}</div>
                      <div className="cal-we-time">{formatTime(ev.start)}</div>
                      {ev.location && <div className="cal-we-loc">{ev.location}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // ─── DAY VIEW ─────────────────────────────────────────
  const DayView = () => {
    const key      = toDateKey(cursor);
    const events   = (meetingsByDate[key] || []).filter(e => !e.isAllDay);
    const allDay   = (meetingsByDate[key] || []).filter(e => e.isAllDay);
    const isToday_ = isSameDay(cursor, today);

    return (
      <div className="cal-day">
        <div className="cal-day-headline">
          <div className={`cal-day-circle ${isToday_ ? "cal-day-circle-today" : ""}`}>
            {cursor.getDate()}
          </div>
          <div>
            <div className="cal-day-name">{DAYS_FULL[cursor.getDay()]}</div>
            <div className="cal-day-month">{MONTHS[cursor.getMonth()]} {cursor.getFullYear()}</div>
          </div>
          {allDay.length > 0 && (
            <div className="cal-day-allday">
              {allDay.map((ev, i) => {
                const col = getEventColor(ev.meetingId);
                return (
                  <div key={i} className="cal-allday-chip"
                    style={{ background: col.bg, borderLeft: `3px solid ${col.border}` }}
                    onClick={() => handleEventClick(ev)}>
                    All Day: {ev.subject}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="cal-day-body">
          <div className="cal-week-hours">
            {HOURS.map(h => (
              <div key={h} className="cal-week-hour-label">
                {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
              </div>
            ))}
          </div>
          <div className="cal-day-col">
            {HOURS.map(h => <div key={h} className="cal-week-slot" />)}
            {isToday_ && (() => {
              const now = new Date();
              const pct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
              return <div className="cal-now-line" style={{ top: `${pct}%` }}><div className="cal-now-dot" /></div>;
            })()}
            {events.map((ev, ei) => {
              const s   = new Date(ev.start);
              const e_  = new Date(ev.end);
              const top = ((s.getHours() * 60 + s.getMinutes()) / 1440) * 100;
              const h   = Math.max(((e_ - s) / 60000 / 1440) * 100, 2);
              const col = getEventColor(ev.meetingId);
              return (
                <div key={ei}
                  className={`cal-day-event ${ev.isCancelled ? "cal-event-cancelled" : ""}`}
                  style={{ top: `${top}%`, height: `${h}%`, background: col.bg, borderLeft: `4px solid ${col.border}` }}
                  onClick={() => handleEventClick(ev)}>
                  <div className="cal-de-title">{ev.subject}</div>
                  <div className="cal-de-time">{formatTime(ev.start)} – {formatTime(ev.end)}</div>
                  {ev.location && <div className="cal-de-loc"><MapPin size={12} /> {ev.location}</div>}
                  {ev.organizer && <div className="cal-de-org"><User size={12} /> {ev.organizer}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {events.length === 0 && !loading && (
          <div className="cal-no-events">No events scheduled for this day</div>
        )}
      </div>
    );
  };

  // ─── Mini calendar (left sidebar) ────────────────────
  const MiniCal = () => {
    const [miniCursor, setMiniCursor] = useState(new Date(cursor));
    const year  = miniCursor.getFullYear();
    const month = miniCursor.getMonth();
    const firstDay    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

    return (
      <div className="cal-mini">
        <div className="cal-mini-header">
          <button className="cal-mini-nav" onClick={() => setMiniCursor(p => { const d = new Date(p); d.setMonth(d.getMonth()-1); return d; })}>
            <ChevronLeft size={14} />
          </button>
          <span className="cal-mini-title">{MONTHS[month].slice(0,3)} {year}</span>
          <button className="cal-mini-nav" onClick={() => setMiniCursor(p => { const d = new Date(p); d.setMonth(d.getMonth()+1); return d; })}>
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="cal-mini-days">
          {DAYS_SHORT.map(d => <div key={d} className="cal-mini-day-label">{d.charAt(0)}</div>)}
          {cells.map((d, i) => {
            if (!d) return <div key={`e-${i}`} />;
            const isToday_  = isSameDay(d, today);
            const isCursor_ = isSameDay(d, cursor);
            const hasEvents = !!(meetingsByDate[toDateKey(d)]?.length);
            return (
              <div key={i}
                className={`cal-mini-date ${isToday_ ? "cal-mini-today" : ""} ${isCursor_ ? "cal-mini-selected" : ""}`}
                onClick={() => { setCursor(d); if (view !== "month") setView("day"); }}>
                {d.getDate()}
                {hasEvents && <div className="cal-mini-dot" />}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ─── Day Meeting List (below mini calendar) ───────────
  const DayMeetingList = () => {
    const isToday_  = isSameDay(cursor, today);
    const dateLabel = isToday_
      ? "Today"
      : cursor.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    return (
      <div className="cal-day-list">
        <div className="cal-day-list-header">
          <span className="cal-day-list-title">{dateLabel}</span>
          <span className="cal-day-list-count">
            {cursorDayMeetings.length === 0
              ? "No meetings"
              : `${cursorDayMeetings.length} meeting${cursorDayMeetings.length > 1 ? "s" : ""}`}
          </span>
        </div>

        {cursorDayMeetings.length === 0 ? (
          <div className="cal-day-list-empty">
            <Calendar size={20} />
            <span>Free day</span>
          </div>
        ) : (
          <div className="cal-day-list-items">
            {cursorDayMeetings.map((ev, i) => {
              const col      = getEventColor(ev.meetingId);
              const id       = ev.meetingId || ev.id;
              const isActive = selectedEvent && (selectedEvent.meetingId === ev.meetingId || selectedEvent.id === ev.id);
              const rsvp     = rsvpStatus?.[id];

              return (
                <div
                  key={i}
                  className={`cal-day-list-item
                    ${isActive ? "cal-day-list-item-active" : ""}
                    ${ev.isCancelled ? "cal-day-list-item-cancelled" : ""}
                  `}
                  style={{ borderLeft: `3px solid ${col.border}` }}
                  onClick={(e) => { e.stopPropagation(); handleEventClick(ev); }}
                  title={ev.subject}
                >
                  <div className="cal-day-list-info">
                    <div className="cal-day-list-name">{ev.subject}</div>
                    <div className="cal-day-list-meta">
                      <span className="cal-day-list-time">
                        {ev.isAllDay ? "All day" : `${formatTime(ev.start)} – ${formatTime(ev.end)}`}
                      </span>
                      {rsvp?.status && (
                        <span className={`cal-day-list-badge cal-dlb-${rsvp.status.toLowerCase()}`}>
                          {rsvp.status === "Accept" ? "✅" : "❌"}
                        </span>
                      )}
                    </div>
                    {ev.location && (
                      <div className="cal-day-list-loc">
                        <MapPin size={9} /> {ev.location}
                      </div>
                    )}
                  </div>
                  {ev.isCancelled && <span className="cal-day-list-cancelled-tag">Cancelled</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ─── RENDER ───────────────────────────────────────────
  return (
    <div className="cal-root" onClick={closePanel}>
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      {/* ── Sidebar ── */}
      <aside className="cal-sidebar">
        <div className="cal-sidebar-brand">
          <div className="cal-brand-icon"><Calendar size={20} color="white" /></div>
          <div>
            <div className="cal-brand-name">Calendar</div>
            <div className="cal-brand-sub">AI HUB</div>
          </div>
        </div>

        <button className="cal-back-btn" onClick={() => navigate("/")}>
          <ArrowLeft size={16} /> Back to Inbox
        </button>

        <div className="cal-user-badge">
          <div className="cal-user-avatar">{username.charAt(0).toUpperCase()}</div>
          <div>
            <div className="cal-user-name">{username}</div>
            <div className="cal-user-email">{getUserEmail()}</div>
          </div>
        </div>

        <MiniCal />

        {/* ── Meetings for selected day ── */}
        <DayMeetingList />

        {/* Meeting count summary */}
        <div className="cal-sidebar-stats">
          <div className="cal-stat-row">
            <Calendar size={13} className="cal-stat-icon" />
            <span>{meetings.length} meetings this period</span>
          </div>
          {meetings.filter(m => isSameDay(new Date(m.start), today)).length > 0 && (
            <div className="cal-stat-row cal-stat-today">
              <div className="cal-stat-pulse" />
              <span>{meetings.filter(m => isSameDay(new Date(m.start), today)).length} today</span>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main Area ── */}
      <div className="cal-main">
        <header className="cal-topbar">
          <div className="cal-topbar-left">
            <button className="cal-today-btn" onClick={goToday}>Today</button>
            <div className="cal-nav-group">
              <button className="cal-nav-btn" onClick={() => navigate_(-1)}><ChevronLeft size={18} /></button>
              <button className="cal-nav-btn" onClick={() => navigate_(1)}><ChevronRight size={18} /></button>
            </div>
            <h2 className="cal-view-title">{viewTitle}</h2>
          </div>
          <div className="cal-topbar-right">
            {loading && <Loader size={16} className="cal-spinner" />}
            <button className="cal-refresh-btn" onClick={() => fetchMeetings(true)} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>
        </header>

        {error && (
          <div className="cal-error-banner">
            <AlertCircle size={15} /> {error}
            <button onClick={fetchMeetings} className="cal-retry-btn">Retry</button>
          </div>
        )}

        <div className="cal-body-wrap" onClick={closePanel}>
          {loading && meetings.length === 0 ? (
            <div className="cal-loading">
              <Loader size={36} className="cal-big-spinner" />
              <p>Loading your calendar…</p>
            </div>
          ) : (
            <div className="cal-content-area" onClick={(e) => e.stopPropagation()}>
              {view === "week" ? <WeekView /> : view === "day" ? <DayView /> : <MonthView />}
            </div>
          )}
        </div>
      </div>

      {/* ── Event Detail Panel ── */}
      {selectedEvent && (
        <EventPanel
          event={selectedEvent}
          onClose={closePanel}
          rsvpStatus={rsvpStatus}
          onRsvp={respondToMeeting}
        />
      )}

      {/* ── Day Brief Modal ── */}
      {showBrief && briefDate && (
        <DayBriefModal
          date={briefDate}
          meetings={meetingsByDate[toDateKey(briefDate)] || []}
          onClose={() => setShowBrief(false)}
          rsvpStatus={rsvpStatus}
        />
      )}
    </div>
  );
};

export default CalendarView;