import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchTrackedEmails, fetchTrackerSummary } from '../api/trackerApi';
import { DEFAULT_CONFIG, enrichRows, summarize } from '../utils/status';

// Celery refreshes the data every few minutes; re-read it on the same rhythm
// so the page stays current without a manual refresh.
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// Loads the signed-in mailbox's tracked sent emails (last 7 days) plus the
// tracker config, and keeps them fresh.
export default function useTrackedEmails(mailbox) {
  const [rawRows, setRawRows] = useState([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);       // first load: nothing to show yet
  const [refreshing, setRefreshing] = useState(false); // any request in flight
  const [error, setError] = useState(null);
  const [lastLoaded, setLastLoaded] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!mailbox) {
      setLoading(false);
      setError(new Error('Not signed in — no mailbox to load.'));
      return undefined;
    }
    const ctrl = new AbortController();
    setRefreshing(true);
    Promise.all([
      fetchTrackerSummary(mailbox, { signal: ctrl.signal }),
      fetchTrackedEmails(mailbox, { signal: ctrl.signal }),
    ])
      .then(([summary, rows]) => {
        setConfig({ ...DEFAULT_CONFIG, ...summary });
        setRawRows(rows);
        setError(null);
        setLastLoaded(new Date());
      })
      .catch((err) => { if (err.name !== 'AbortError') setError(err); })
      .finally(() => {
        if (!ctrl.signal.aborted) { setLoading(false); setRefreshing(false); }
      });
    return () => ctrl.abort();
  }, [mailbox, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const id = setInterval(reload, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);

  const rows = useMemo(() => enrichRows(rawRows), [rawRows]);
  const stats = useMemo(() => summarize(rows), [rows]);

  // Local update after an action (e.g. a reminder was sent) so the UI reacts
  // immediately; the next reload brings the authoritative state.
  const patchRow = useCallback((id, patch) => {
    setRawRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  return { rows, stats, config, loading, refreshing, error, lastLoaded, reload, patchRow };
}
