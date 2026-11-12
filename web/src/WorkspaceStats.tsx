import { useLive } from './useLive';

type WorkspaceCounts = { enabled: boolean; counts?: { active_15m: number; active_24h: number; active_7d: number }; as_of?: number };
export function WorkspaceStats() {
  const stats = useLive<WorkspaceCounts>('/admin/workspace-counts', true, 60_000);
  if (!stats.error && !stats.data?.enabled) return null;
  return <section className="admin-stats" aria-label="Private workspace activity">
    <h2>Signed-in users</h2>
    <div className="workspace-metrics">{([
      ['Active · last 15 min', 'active_15m'], ['Active · last 24 hours', 'active_24h'], ['Active · last 7 days', 'active_7d'],
    ] as const).map(([label, key]) => <div key={key}><strong>{stats.data?.counts?.[key] ?? '—'}</strong><span>{label}</span></div>)}</div>
    <p className="fine">Admin only · distinct accounts, including admins · visible workspace tabs · counts begin when enabled. Public visitors are excluded.{stats.data?.as_of ? ` Updated ${new Date(stats.data.as_of * 1000).toLocaleTimeString()}.` : ''}</p>
    {stats.error && <p className="notice" role="status">User counts could not refresh. <button className="inline" onClick={stats.refresh}>Retry</button></p>}
  </section>;
}
