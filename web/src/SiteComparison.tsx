import { useEffect, useState } from 'react';
import { api } from './api';

type Fingerprint = { sha256: string; bytes: number; content_type: string; headers: Record<string, string> };
type Resource = { kind: 'homepage' | 'external_script' | 'inline_script'; url: string; change: 'unchanged' | 'changed' | 'only_earlier' | 'only_later'; before: Fingerprint | null; after: Fingerprint | null };
type Coverage = { captured_scripts: number; skipped_scripts: number; data_only_scripts: number; script_limit_reached: boolean };
type Comparison = { baseline_id: string; current_id: string; baseline_finished_at: number; current_finished_at: number; resources: Resource[]; script_references_changed: boolean; baseline_coverage: Coverage; current_coverage: Coverage };
type Candidate = { id: string; finished_at: number };

const date = (value: number) => new Date(value * 1000).toLocaleString();
const changeLabel = { unchanged: 'Captured values match', changed: 'Changed', only_earlier: 'Only in earlier capture', only_later: 'Only in later capture' };
const kindLabel = { homepage: 'Homepage', external_script: 'External script', inline_script: 'Inline script position' };

function FingerprintView({ value, label }: { value: Fingerprint | null; label: string }) {
  return <div className="fingerprint"><h5>{label}</h5>{value ? <>
    <p className="fine">{value.bytes.toLocaleString()} bytes · {value.content_type}</p>
    <dl><dt>SHA-256</dt><dd><code>{value.sha256}</code></dd>{Object.entries(value.headers).map(([name, text]) => <div key={name}><dt>{name}</dt><dd><code>{text}</code></dd></div>)}</dl>
    {Object.keys(value.headers).length === 0 && <p className="fine">No selected response headers saved.</p>}
  </> : <p className="fine">Not captured. This does not establish that the resource was absent from the site.</p>}</div>;
}

export function SiteComparison({ siteId, candidates }: { siteId: string; candidates: Candidate[] }) {
  const [baseline, setBaseline] = useState('');
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const eligible = candidates.some(candidate => candidate.id === baseline);
  // One explicit read per selection. No recurring collection or model job starts.
  useEffect(() => {
    setData(null); setError(''); setBusy(Boolean(baseline) && eligible);
    if (!baseline || !eligible) return;
    const controller = new AbortController();
    void api<Comparison>(`/site-checks/${siteId}/compare/${baseline}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to compare these captures.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [siteId, baseline, eligible, retry]);
  const result = eligible && data?.baseline_id === baseline && data.current_id === siteId ? data : null;
  const changed = result?.resources.filter(resource => resource.change !== 'unchanged') ?? [];
  const limited = result && [result.baseline_coverage, result.current_coverage].some(c => c.skipped_scripts > 0 || c.script_limit_reached);
  return <section className="snapshot-comparison" aria-label="Compare saved snapshots">
    <h3>What changed between captures?</h3><p>Compare saved bytes and selected headers. This reads existing evidence; it does not visit the site or start an agent.</p>
    {candidates.length === 0 ? <p className="fine">No earlier retained snapshot with this requester and exact scope is available. Each new capture needs its own approval.</p> : <label>Earlier snapshot<select value={baseline} onChange={event => setBaseline(event.target.value)}><option value="">Choose a capture…</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{date(candidate.finished_at)} · {candidate.id.slice(0, 8)}</option>)}</select></label>}
    {busy && <p role="status">Comparing saved evidence…</p>}
    {error && <div className="notice error" role="alert">{error} <button className="inline" onClick={() => setRetry(value => value + 1)}>Retry comparison</button></div>}
    {result && <div className="comparison-result">
      <h4>{changed.length > 0 || result.script_references_changed ? 'Captured evidence differs.' : 'Captured values match.'}</h4>
      <p className="fine">Earlier: {date(result.baseline_finished_at)} · Later: {date(result.current_finished_at)}</p>
      <p>{changed.length} resource {changed.length === 1 ? 'difference' : 'differences'} · {result.resources.length - changed.length} matching captures{result.script_references_changed ? ' · Script references or collection results also differ' : ''}</p>
      {limited && <p className="notice">Coverage is incomplete. Earlier: {result.baseline_coverage.skipped_scripts} skipped scripts. Later: {result.current_coverage.skipped_scripts} skipped scripts.{[result.baseline_coverage, result.current_coverage].some(c => c.script_limit_reached) ? ' A capture reached the script-reference limit.' : ''} Missing captures do not prove removal.</p>}
      <p className="notice"><strong>A change is a reason to inspect.</strong> Deployments, timestamps and per-visit content can change bytes. Matching captures do not establish safety. Imports and browser behavior remain outside this check. Inline scripts match by position, so reordering them can show changes.</p>
      <div className="resource-comparisons">{result.resources.map(resource => <details className="resource-comparison" key={`${resource.kind}:${resource.url}`}>
        <summary><span><small>{kindLabel[resource.kind]}</small><code>{resource.url}</code></span><strong>{changeLabel[resource.change]}</strong></summary>
        <div className="fingerprint-pair"><FingerprintView value={resource.before} label="Earlier capture" /><FingerprintView value={resource.after} label="Later capture" /></div>
      </details>)}</div>
    </div>}
  </section>;
}
