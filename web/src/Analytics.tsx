import { useEffect } from 'react';
import { useLive } from './useLive';
import { countPage, validMeasurementId, type AnalyticsPage } from './googleAnalytics';

const noPolling = () => false;

export function Analytics({ page, csrf }: { csrf: string; page: AnalyticsPage | null }) {
  const config = useLive<{ enabled: boolean; measurement_id?: string | null; workspace_counts_enabled?: boolean }>('/analytics', page !== null, 60_000, noPolling);
  const countActivity = page !== null && !['home', 'docs', 'incidents', 'contact'].includes(page) && config.data?.workspace_counts_enabled === true;
  useEffect(() => {
    if (!countActivity || !csrf) return;
    const controller = new AbortController();
    let lastSent = 0;
    const record = () => {
      if (document.hidden || Date.now() - lastSent < 60_000) return;
      lastSent = Date.now();
      // Best effort: analytics failure never expires a session or blocks work.
      void fetch('/api/analytics/activity', { method: 'POST', credentials: 'same-origin',
        headers: { 'x-csrf-token': csrf }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      }).catch(() => {});
    };
    record();
    const timer = window.setInterval(record, 60_000);
    document.addEventListener('visibilitychange', record);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', record); };
  }, [countActivity, csrf]);
  const id = config.data?.measurement_id;
  const enabled = !config.error && config.data?.enabled && validMeasurementId(id);
  useEffect(() => { countPage(enabled ? id! : null, page); }, [enabled, id, page]);
  return null;
}
