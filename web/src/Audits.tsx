import { useState } from 'react';
import { useLive } from './useLive';
import type { View } from './navigation';

type Run = { id: string; mode: string; state: string; created_at: number; steps: { state: string }[]; website?: { site_check_id: string }; source?: { source_id: string }; pentest?: { pentest_id: string; scope: { origins: string[] } } };
type Website = { id: string; scope: { homepage: string }; state: string; created_at: number };
type Source = { id: string; title: string; state: string; created_at: number };
export type Audit = { key: string; id: string; view: 'sites' | 'sources' | 'reviews' | 'pentests'; title: string; kind: 'Website' | 'Source code' | 'Example'; state: string; created: number; run?: Run };
const labels: Record<string, string> = { awaiting_verification: 'Verify domain', pending_approval: 'Awaiting approval', queued: 'Queued', collecting: 'Saving snapshot', collected: 'Choose review team', approved: 'Choose review team', awaiting_payment: 'Awaiting payment', running: 'Agents working', completed: 'Report ready', needs_review: 'Needs attention', failed: 'Incomplete', cancelled: 'Cancelled', rejected: 'Not approved', deleted: 'Files deleted', expired: 'Expired' };
export const auditLabel = (state: string) => labels[state] ?? state.replaceAll('_', ' ');
export const auditActive = (state: string) => ['queued', 'collecting', 'running', 'awaiting_payment', 'pending_approval'].includes(state);

/** Personal lists are narrowed on the server, including for admin accounts. */
export function useAudits(all = false) {
  const suffix = all ? '?scope=all' : '?scope=mine';
  const runs = useLive<Run[]>(`/reviews${suffix}`, true, 30_000);
  const websites = useLive<Website[]>(`/site-checks${suffix}`, true, 30_000);
  const live = useLive<{id:string; scope:{origins:string[]};state:string;created_at:number;ownership_verified?:boolean}[]>(`/pentests${suffix}`, true, 30_000);
  const sources = useLive<Source[]>(`/sources${suffix}`, true, 30_000);
  const used = new Set<string>();
  const attach = (item: Audit, match: (run: Run) => boolean): Audit => {
    const matches = (runs.data ?? []).filter(match).sort((a, b) => b.created_at - a.created_at);
    matches.forEach(run => used.add(run.id));
    const run = matches[0];
    return run ? { ...item, run, state: run.state, created: Math.max(item.created, run.created_at) } : item;
  };
  const items: Audit[] = [
    ...(live.data ?? []).map(item => attach({key:`live:${item.id}`,id:item.id,view:'pentests',title:item.scope.origins.join(', '),kind:'Website',state:item.state === 'pending_approval' && !item.ownership_verified ? 'awaiting_verification' : item.state,created:item.created_at}, run => run.pentest?.pentest_id===item.id)),
    ...(websites.data ?? []).map(item => attach({ key: `site:${item.id}`, id: item.id, view: 'sites', title: item.scope.homepage, kind: 'Website', state: item.state, created: item.created_at }, run => run.website?.site_check_id === item.id)),
    ...(sources.data ?? []).map(item => attach({ key: `source:${item.id}`, id: item.id, view: 'sources', title: item.title, kind: 'Source code', state: item.state, created: item.created_at }, run => run.source?.source_id === item.id)),
  ];
  (runs.data ?? []).filter(run => !used.has(run.id)).forEach(run => items.push({ key: `run:${run.id}`, id: run.id, view: 'reviews', title: run.mode === 'pentest_agent' ? 'Live website test' : run.mode === 'website_agent' ? 'Website review' : run.mode === 'source_agent' ? 'Source code review' : 'Access-control example', kind: ['pentest_agent','website_agent'].includes(run.mode) ? 'Website' : run.mode === 'source_agent' ? 'Source code' : 'Example', state: run.state, created: run.created_at, run }));
  items.sort((a, b) => b.created - a.created || a.key.localeCompare(b.key));
  return { items, ready: !!(runs.data && websites.data && sources.data && live.data), error: runs.error || websites.error || sources.error || live.error, refresh: () => { runs.refresh(); websites.refresh(); sources.refresh(); live.refresh(); } };
}

export function AuditRows({ items, onOpen }: { items: Audit[]; onOpen: (view: View, id?: string | null) => void }) {
  return <div className="audit-rows">{items.map(item => <article key={item.key} className="audit-row" data-state={item.state}>
    <span className={`audit-kind kind-${item.kind === 'Website' ? 'web' : item.kind === 'Source code' ? 'source' : 'example'}`} aria-hidden="true">{item.kind === 'Website' ? '↗' : item.kind === 'Source code' ? '{ }' : '✓'}</span>
    <button className="audit-title" onClick={() => onOpen(item.run ? 'reviews' : item.view, item.run?.id ?? item.id)}><strong>{item.title}</strong><small>{item.kind} · {new Date(item.created * 1000).toLocaleDateString()}</small></button>
    <div className="audit-state"><span className={`status-chip state-${item.state}`}>{auditLabel(item.state)}</span>{item.state === 'queued' && <small className="queue-note">Waiting for agents. Check back later.</small>}{item.run && <span className="role-progress" aria-label={`${item.run.steps.filter(s => s.state === 'completed').length} of ${item.run.steps.length} role reports received`}>{item.run.steps.map((step, index) => <i key={index} data-done={step.state === 'completed'} />)}</span>}</div>
    {item.run && item.view !== 'reviews' && <button className="quiet audit-material" onClick={() => onOpen(item.view, item.id)}>Material</button>}
  </article>)}</div>;
}

export function Audits({ onOpen, admin = false }: { onOpen: (view: View, id?: string | null) => void; admin?: boolean }) {
  const data = useAudits(admin);
  const [filter, setFilter] = useState('All');
  const [status, setStatus] = useState('All work');
  const items = data.items.filter(item => (filter === 'All' || item.kind === filter) && (status === 'All work' || (status === 'Queued' ? item.state === 'queued' : ['running', 'collecting'].includes(item.state))));
  return <section className="audits-page">
    <div className="dashboard-title"><div><p className="eyebrow">{admin ? 'ADMINISTRATION' : 'YOUR WORK'}</p><h1>{admin ? 'Audit activity' : 'Audits'}</h1><p className="subtle">{admin ? 'Queued work, active tests and reports across accounts.' : 'Your requests, saved material and agent reports.'}</p></div><button className="primary" onClick={() => onOpen('request')}>Request an audit</button></div>
    <div className="audit-controls"><div className="segmented" aria-label="Audit type">{['All', 'Website', 'Source code', 'Example'].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div><button className="quiet" onClick={data.refresh}>Refresh audits</button></div>
    <div className="audit-controls"><div className="segmented" aria-label="Work status">{['All work', 'Queued', 'Running'].map(value => <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value}</button>)}</div></div>
    {data.error && <p className="notice error" role="alert">Some audits could not refresh. Any entries shown may be out of date.</p>}
    {!data.ready && !data.error && <p role="status">Loading your audits…</p>}
    <div className="panel">{items.length > 0 ? <AuditRows items={items} onOpen={onOpen} /> : data.ready && !data.error && <div className="dashboard-empty"><h2>{status !== 'All work' ? `No ${status.toLowerCase()} requests.` : filter === 'All' ? 'Your first audit starts here.' : `No ${filter.toLowerCase()} audits yet.`}</h2><p>{status !== 'All work' ? 'Open All work to see your other requests and reports.' : 'Choose a website or a few source files you have permission to review.'}</p></div>}</div>
    <details className="audit-tools"><summary>Saved material and test examples</summary><div className="review-actions"><button className="quiet" onClick={() => onOpen('pentests')}>Live website tests</button><button className="quiet" onClick={() => onOpen('sites')}>Website snapshots</button><button className="quiet" onClick={() => onOpen('sources')}>Source uploads</button><button className="quiet" onClick={() => onOpen('reviews')}>Reports</button></div><p className="fine">Recent records only. A snapshot is saved evidence; an audit adds the agents’ review. Live tests use a separate approved scope; saved-page approval does not authorize live probes.</p></details>
  </section>;
}
