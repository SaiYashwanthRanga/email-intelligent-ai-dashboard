import { useCallback, useEffect, useState } from 'react';
import { explainEmail, fetchEmailDetail } from '../api/trackerApi';

// Loads one tracked email — recipients, reminders and the live conversation.
// `emailId` null = nothing open.
export default function useEmailDetail(mailbox, emailId) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!emailId || !mailbox) { setDetail(null); return undefined; }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchEmailDetail(mailbox, emailId, { signal: ctrl.signal })
      .then(setDetail)
      .catch((err) => { if (err.name !== 'AbortError') setError(err); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [mailbox, emailId, reloadKey]);

  // A different email was opened: drop the previous one straight away.
  useEffect(() => { setDetail(null); }, [emailId]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Ask the AI why this email is tracked (force = analyse again).
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState(null);
  const explain = useCallback(async (force = false) => {
    if (!emailId || !mailbox) return;
    setExplaining(true);
    setExplainError(null);
    try {
      const d = await explainEmail(mailbox, emailId, { force });
      setDetail((cur) => (cur && cur.id === d.id ? d : cur));
    } catch (err) {
      setExplainError(err);
    } finally {
      setExplaining(false);
    }
  }, [mailbox, emailId]);
  useEffect(() => { setExplainError(null); }, [emailId]);

  return { detail, loading, error, reload, explain, explaining, explainError };
}
