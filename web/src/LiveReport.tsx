import { useRef, useState, type ReactNode } from 'react';

export const liveRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' } as const;
export type LiveRole = keyof typeof liveRoles;
export type HttpRecord = { id: number; method: string; url: string; status: number | null; request_headers?: Record<string, string>; headers: Record<string, string>; body_excerpt: string; body_sha256?: string | null; observed_at?: number; truncated: boolean; error: string | null };
export type LiveFinding = { title: string; severity: string; support: string; explanation: string; reproduction: string; suggested_action: string; evidence_ids: number[] };
export type LiveToolRun = { tool: string; version: string; arguments: string[]; started_at: number; duration_ms: number; exit_code: number | null; failure: string | null; evidence_ids: number[]; output_sha256: string; output_excerpt: string; output_truncated: boolean };
export type LiveResult = { kind: 'pentest_agent_v1'; scope_sha256: string; execution: { state: string; provider: string; model: string; image_digest?: string; duration_ms: number; inference_calls: number; http_requests: number; cost_upper_microusd: number; cleanup_confirmed: boolean; failure_reason?: string }; assessment: { summary: string; findings: LiveFinding[]; limitations: string[] } | null; evidence: HttpRecord[]; tool_runs?: LiveToolRun[]; raw_summary: string };
export type LiveActivity = { received_at: number; progress: { phase: 'starting' | 'scoped_tools' | 'investigating' | 'finishing'; http_requests: number; inference_calls: number; completed_tools: number } };
export type LiveStep = { role: LiveRole; state: string; result: LiveResult | null; evidence_complete?: boolean | null; progress?: LiveActivity | null };
const roleDuty = { investigator: 'Map the application and investigate leads.', reproducer: 'Repeat probes and challenge the initial claims.', challenger: 'Check the evidence, impact and recommended fixes.' };
const phases = { starting: 'Starting the isolated runner', scoped_tools: 'Running scoped tools', investigating: 'Investigating the evidence', finishing: 'Preparing the report' };
const support: Record<string, string> = { observed: 'Observed behavior', reproduced: 'Agent reports reproduction', not_reproduced: 'Not reproduced', needs_review: 'Unconfirmed' };

export function LiveProgress({ steps, state }: { steps: LiveStep[]; state: string }) {
  const received = steps.filter(s => s.result !== null).length;
  return <section className="live-progress" aria-label="Live test progress"><div className="section-heading"><div><p className="eyebrow">THREE ROLES / ONE SCOPE</p><h3>{received} of 3 role reports received</h3></div><span className="status-chip">{state.replaceAll('_', ' ')}</span></div><progress aria-label="Role reports received" value={received} max={3} />
    <ol className="live-stage-list">{steps.map(s => <li key={s.role} data-state={s.state}><span className="stage-dot" aria-hidden="true" /><strong>{liveRoles[s.role]}</strong><small>{s.result ? s.evidence_complete ? 'Report received' : 'Report needs review' : s.state === 'leased' || s.state === 'running' ? 'Working' : s.state === 'failed' ? 'Stopped' : s.state === 'cancelled' ? 'Cancelled' : 'Waiting'}</small><p>{roleDuty[s.role]}</p>{!s.result && ['leased', 'running'].includes(s.state) && s.progress && <div className="live-activity"><strong>{phases[s.progress.progress.phase]}</strong><p>{s.progress.progress.http_requests} requests · {s.progress.progress.inference_calls} model calls · {s.progress.progress.completed_tools} tool runs recorded</p><small>Last relay update: {new Date(s.progress.received_at * 1000).toLocaleTimeString()}</small></div>}</li>)}</ol>
    <p className="fine">Progress comes from saved role reports; activity counts come from the assigned relay. It does not estimate how much of the website is covered. {state === 'failed' || state === 'cancelled' ? 'Work stopped; earlier evidence remains available.' : 'Each role runs after the previous one.'}</p>
  </section>;
}

function save(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Keep model/target text inert when someone opens the exported Markdown.
const block = (value: string) => { const fence = '`'.repeat(Array.from(value.matchAll(/`+/g)).reduce((max, m) => Math.max(max, m[0].length + 1), 3)); return `${fence}text\n${value}\n${fence}`; };

function markdown(id: string, steps: LiveStep[], origins: string[]) {
  const lines = ['# Patchriot — private website review', `Review: ${id}`, 'Scope:', block(origins.join('\n')), 'Role reports and operator-recorded HTTP evidence. Agreement is not proof of safety. Remediation is a recommendation; no production patch was tested.'];
  for (const s of steps) {
    lines.push(`## ${liveRoles[s.role]}`, s.evidence_complete ? 'Report received with recorded requests.' : 'Incomplete role: inspect the evidence and missing checks.');
    if (!s.result) { lines.push('No report received.'); continue; }
    const r = s.result;
    if (r.assessment) {
      lines.push(block(r.assessment.summary));
      for (const [i, f] of r.assessment.findings.entries()) lines.push(`### Finding ${i + 1}`, block(`${f.title}\nSeverity: ${f.severity}\nSupport: ${support[f.support] ?? f.support}`), 'Impact and evidence:', block(f.explanation), 'Reproduction:', block(f.reproduction), 'Recommended fix (not tested):', block(f.suggested_action), `HTTP references: ${f.evidence_ids.map(n => `${s.role}#${n}`).join(', ')}`);
      lines.push('### Coverage limits', block(r.assessment.limitations.join('\n')));
    } else lines.push('No usable structured assessment was returned.');
    if (r.tool_runs?.length) {
      lines.push('### Recorded tools', 'Scanner matches are leads. Check the target request and controls before accepting a finding.');
      for (const run of r.tool_runs) lines.push(block(JSON.stringify(run, null, 2)));
    }
    lines.push('### Recorded requests');
    for (const e of r.evidence) lines.push(block(JSON.stringify(e, null, 2)));
  }
  return lines.join('\n\n');
}

function inventory(steps: LiveStep[]) {
  const rows = new Map<string, { method: string; url: string; statuses: Set<number>; refs: string[]; query: string[] }>();
  for (const s of steps) for (const e of s.result?.evidence ?? []) {
    let url: URL; try { url = new URL(e.url); } catch { continue; }
    const query = [...new Set(url.searchParams.keys())].sort();
    // Values may contain private inputs. Exports list names without credentials
    // or a replayable active probe, and never infer an API schema from one GET.
    const normalized = `${url.origin}${url.pathname}`;
    const key = `${e.method} ${normalized}?${query.join('&')}`;
    const row = rows.get(key) ?? { method: e.method, url: normalized, statuses: new Set<number>(), refs: [], query };
    if (e.status !== null) row.statuses.add(e.status);
    row.refs.push(`${s.role}#${e.id}`); rows.set(key, row);
  }
  return [...rows.values()];
}

export function LiveReportDownloads({ id, steps, origins }: { id: string; steps: LiveStep[]; origins: string[] }) {
  const endpoints = inventory(steps);
  function exportPostman() {
    save(`patchriot-${id}-endpoints.postman.json`, JSON.stringify({ info: { name: 'Patchriot observed endpoints', _postman_id: id, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Observed unauthenticated requests, not a complete API specification. Query values and headers are omitted. These observations do not establish authorization or BOLA. Review scope before sending any request.' }, item: endpoints.map(e => ({ name: `${e.method} ${e.url}`, request: { method: e.method, url: { raw: e.url, query: e.query.map(key => ({ key, value: '', disabled: true, description: 'Observed name; value omitted from export.' })) }, description: `Observed HTTP status: ${[...e.statuses].join(', ') || 'No response'}. References: ${e.refs.join(', ')}. Authentication not tested.` }, response: [] })) }, null, 2), 'application/json');
  }
  return <section className="report-exports"><div className="review-actions"><button className="quiet" onClick={() => save(`patchriot-${id}-report.md`, markdown(id, steps, origins), 'text/markdown')}>Download readable report ↓</button><button className="quiet" disabled={!endpoints.length} onClick={exportPostman}>Export observed endpoints ↓</button></div><details><summary>What is in the endpoint export?</summary><p>A Postman collection of the URLs and methods actually requested, with response codes and evidence references. Query values and headers are omitted. It is not a complete API specification. A publicly reachable route alone does not prove broken authorization.</p></details></section>;
}

function RequestEvidence({ entry }: { entry: HttpRecord }) {
  return <article className="request-evidence"><div className="section-heading"><strong>HTTP #{entry.id}</strong><span className="pill">{entry.method} · {entry.status ?? 'No response'}</span></div><p className="evidence-url">{entry.url}</p>
    {entry.error && <p className="notice">Request did not complete: {entry.error.replaceAll('_', ' ')}.</p>}
    {entry.observed_at && <p className="fine">Recorded {new Date(entry.observed_at * 1000).toLocaleString()}</p>}
    <details><summary>Request and response headers</summary><h5>Request</h5><pre>{JSON.stringify(entry.request_headers ?? {}, null, 2)}</pre><h5>Recorded response headers</h5><pre>{JSON.stringify(entry.headers, null, 2)}</pre></details>
    <h5>Response excerpt</h5><pre>{entry.body_excerpt || 'No text excerpt recorded.'}</pre>
    {entry.truncated && <p className="fine">Shortened excerpt; it does not show the complete response.</p>}
    {entry.body_sha256 && <details><summary>Response fingerprint</summary><p className="fine">SHA-256 of the bytes retained by the relay. It helps compare responses; it is not a vulnerability verdict.</p><code className="evidence-url">{entry.body_sha256}</code></details>}
  </article>;
}

function Remediation({ text }: { text: string }) {
  // Recognize fenced examples only. Model prose, HTML and links stay literal
  // React text; a security report must never execute the payload it describes.
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/^(`{3,})[ \t]*([a-z0-9_+.-]*)[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gmi)) {
    const before = text.slice(cursor, match.index);
    if (before.trim()) parts.push(<p className="finding-prose" key={`text-${cursor}`}>{before.trim()}</p>);
    parts.push(<figure className="remediation-example" key={`code-${match.index}`}><figcaption>Suggested example{match[2] ? ` · ${match[2]}` : ''}</figcaption><pre><code>{match[3]}</code></pre></figure>);
    cursor = match.index + match[0].length;
  }
  if (text.slice(cursor).trim()) parts.push(<p className="finding-prose" key={`text-${cursor}`}>{text.slice(cursor).trim()}</p>);
  return <div className="remediation">{parts}</div>;
}

export function LiveEvidence({ result, complete }: { result: LiveResult; complete?: boolean | null }) {
  const evidence = useRef<HTMLDetailsElement>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState('all');
  const findings = result.assessment?.findings ?? [];
  const shown = findings.filter(f => filter === 'all' || filter === 'unconfirmed' && ['needs_review', 'not_reproduced'].includes(f.support) || filter === 'reproduced' && f.support === 'reproduced');
  function inspect(ids: number[]) { setSelected(ids); if (evidence.current) { evidence.current.open = true; evidence.current.scrollIntoView({ behavior: 'auto', block: 'start' }); evidence.current.querySelector('summary')?.focus(); } }
  return <div className="live-assessment">
    <div className={`role-summary ${complete ? 'received' : 'incomplete'}`}><h4>{complete ? 'Report and requests received.' : 'This role needs review.'}</h4><p>{complete ? 'Read the finding, the claimed impact and the requests behind it.' : result.assessment ? 'An assessment arrived, but the run or supporting evidence did not finish cleanly. Treat these findings as incomplete.' : 'The agent did not return a usable assessment. Any requests it recorded are still available below.'}</p>
      {result.execution.failure_reason && <p>Stopped: {result.execution.failure_reason.replaceAll('_', ' ')}.</p>}
      <details><summary>What does this status mean?</summary><p>“Received” means the server accepted a structured report and recorded requests. It does not mean the findings are correct. Missing evidence, interrupted execution or unconfirmed cleanup keep a role marked for review.</p></details>
    </div>
    <dl className="role-metrics"><div><dt>Requests recorded</dt><dd>{result.execution.http_requests}</dd></div><div><dt>Model calls</dt><dd>{result.execution.inference_calls}</dd></div><div><dt>Run time</dt><dd>{Math.round(result.execution.duration_ms / 1000)}s</dd></div></dl>
    {!!result.tool_runs?.length && <details className="tool-evidence"><summary>Tools run ({result.tool_runs.length})</summary><p>The pinned runner recorded these checks before the agent investigated their output. Matches are leads, not confirmed vulnerabilities. Open the referenced requests to see what the target actually returned.</p>{result.tool_runs.map((run, i) => <article className="request-evidence" key={i}><div className="section-heading"><strong>{run.tool} · {run.version}</strong><span className="pill">{run.failure ? run.failure.replaceAll('_', ' ') : run.exit_code === 0 ? 'Finished' : 'Tool error'}</span></div><p className="fine">{new Date(run.started_at * 1000).toLocaleString()} · {Math.round(run.duration_ms / 1000)}s · {run.evidence_ids.length} recorded requests</p><details><summary>Command arguments</summary><pre>{JSON.stringify(run.arguments, null, 2)}</pre></details><pre>{run.output_excerpt || (run.exit_code === 0 && !run.failure ? 'No matching observations were printed. This does not prove the site is safe.' : 'No tool output was retained.')}</pre>{run.output_truncated && <p className="fine">Output was shortened; inspect the request evidence for the recorded response excerpts.</p>}{run.evidence_ids.length > 0 && <button className="text-button" onClick={() => inspect(run.evidence_ids)}>Inspect tool requests →</button>}</article>)}</details>}
    {result.assessment && <><p className="assessment-summary">{result.assessment.summary}</p>
      {findings.length > 0 ? <><div className="finding-controls"><h4>Findings from this role</h4><label>Show<select aria-label="Filter findings" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All claims ({findings.length})</option><option value="reproduced">Reported reproduced</option><option value="unconfirmed">Unconfirmed or not reproduced</option></select></label></div>
      {shown.map((f, i) => <article className="live-finding" data-severity={f.severity} key={`${f.title}:${i}`}><div className="finding-heading"><h4>{f.title}</h4><span className="pill">{f.severity} severity</span></div><p className="finding-support">{support[f.support] ?? f.support}</p><h5>Why it matters / what was observed</h5><p className="finding-prose">{f.explanation}</p><details><summary>Reproduce the observation</summary><p>These are the agent’s instructions. Inspect the scope and evidence before running them.</p><pre>{f.reproduction}</pre></details><details><summary>Recommended fix</summary><p className="fine">A recommendation based on the observed behavior. No production patch was tested.</p><Remediation text={f.suggested_action} /></details><button className="text-button" onClick={() => inspect(f.evidence_ids)}>Inspect {f.evidence_ids.length} supporting request{f.evidence_ids.length === 1 ? '' : 's'} →</button></article>)}
      {shown.length === 0 && <p>No findings match this filter.</p>}
      <p className="fine">Severity and reproduction labels are the agent’s assessment. Other roles may disagree. Review every role before deciding what to fix.</p></> : <p className="notice">This role reported no findings. That is not proof the site has no vulnerabilities.</p>}
      <details className="coverage-limits" open><summary>What this role could not check</summary><ul>{result.assessment.limitations.map((v, i) => <li key={i}>{v}</li>)}</ul></details>
    </>}
    <details className="http-evidence" ref={evidence}><summary>Request evidence ({result.evidence.length})</summary><p>These are the requests made to your website and the responses retained by the relay. They let you check a claim against what actually came back. The operator reports these records; a response code alone does not prove a vulnerability.</p>{selected.length > 0 && <p className="notice">Showing references {selected.join(', ')}. <button className="inline" onClick={() => setSelected([])}>Show every request</button></p>}{result.evidence.filter(e => !selected.length || selected.includes(e.id)).map(e => <RequestEvidence key={e.id} entry={e} />)}</details>
    <details className="execution-details"><summary>Agent and execution details</summary><dl><dt>Provider / model</dt><dd>{result.execution.provider} / {result.execution.model}</dd><dt>Container cleanup</dt><dd>{result.execution.cleanup_confirmed ? 'Reported complete by relay' : 'Not confirmed'}</dd>{result.execution.image_digest && <><dt>Runtime image</dt><dd><code>{result.execution.image_digest}</code></dd></>}</dl></details>
    {!result.assessment && result.raw_summary && <details><summary>Unformatted model reply</summary><pre>{result.raw_summary}</pre></details>}
  </div>;
}
