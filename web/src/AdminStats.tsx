import { useLive } from './useLive';

type Stats = { requested: number; live_requested: number; awaiting_verification: number; review_runs: number; awaiting_payment: number; queued: number; running: number; completed: number; needs_review: number; failed: number; cancelled: number; as_of: number };
export function AdminStats() {
  const stats = useLive<Stats>('/admin/review-stats', true, 30_000);
  const data = stats.data;
  return <section className="admin-stats" aria-label="Network usage"><div className="workspace-metrics">{([
    ['Requested', 'requested'], ['Awaiting DNS', 'awaiting_verification'], ['Queued', 'queued'], ['Running', 'running'], ['Reports ready', 'completed'], ['Needs attention', 'needs_review'],
  ] as const).map(([label, key]) => <div key={key}><strong>{data?.[key] ?? '—'}</strong><span>{label}</span></div>)}</div>
    {data && <p className="fine">All-time totals across accounts: {data.live_requested} live website scopes · {data.review_runs} assessment runs · {data.awaiting_payment} awaiting payment · {data.failed} incomplete · {data.cancelled} cancelled. Counts include records beyond the recent list. Updated {new Date(data.as_of * 1000).toLocaleTimeString()}.</p>}
    {stats.error && <p className="notice error" role="alert">Usage counts could not refresh. Saved counts may be out of date. <button className="inline" onClick={stats.refresh}>Retry counts</button></p>}
  </section>;
}
