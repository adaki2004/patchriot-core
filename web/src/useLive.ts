import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Keep the last successful value during an outage, with an explicit error. */
export function useLive<T>(path: string, enabled = true, interval = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) { setData(null); setError(''); setUpdated(null); return; }
    const controller = new AbortController();
    let pending = false;
    async function update() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const value = await api<T>(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        if (!controller.signal.aborted) { setData(value); setError(''); setUpdated(new Date()); }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to refresh.');
      } finally { pending = false; }
    }
    void update();
    const timer = window.setInterval(() => { if (!document.hidden) void update(); }, interval);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, enabled, revision, interval]);
  return { data, error, updated, refresh };
}
