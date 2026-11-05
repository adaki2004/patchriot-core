import { ReportText } from './ReportText';
import { prettyJson, fencedText, reportMarkdownText } from './reportFormatting';
import { useRef, useState } from 'react';
import './assessment.css';
import { expectedReports, reviewMethod, findingRequest, reportFindings, stopExplanation, type ReportInput } from './report';

export const liveRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' } as const;
export type LiveRole = keyof typeof liveRoles;
export type HttpRecord = { id: number; method: string; url: string; status: number | null; request_headers?: Record<string, string>; headers: Record<string, string>; body_excerpt: string; body_sha256?: string | null; observed_at?: number; authenticated?: boolean; login?: boolean; request_body_excerpt?: string; request_body_sha256?: string; truncated: boolean; error: string | null };
export type LiveFinding = { title: string; severity: string; support: string; explanation: string; reproduction: string; suggested_action: string; evidence_ids: number[] };
export type LiveToolRun = { tool: string; version: string; arguments: string[]; started_at: number; duration_ms: number; exit_code: number | null; failure: string | null; evidence_ids: number[]; output_sha256: string; output_excerpt: string; output_truncated: boolean };
export type FallbackReceipt = { model: string; reason: string; primary_attempts: number; fallback_attempts: number; fallback_completed: number };
export function fallbackDescription(receipt: FallbackReceipt) { return `Venice fallback: ${receipt.model}. ${receipt.fallback_completed} completed replies from ${receipt.fallback_attempts} attempts; ${receipt.primary_attempts} NEAR attempts. Trigger: ${receipt.reason.replaceAll('_', ' ')}. Backup inference is not NEAR TEE execution. Recovery attempts share one logical call; both providers count toward the cost limit.`; }
export type LiveResult = { browser_access?: { authenticated_id: number; anonymous_id: number; check: { kind: 'protected_resource' | 'account_identity'; json_pointer?: string } }; kind: 'pentest_agent_v1'; scope_sha256: string; execution: { state: string; provider: string; model: string; image_digest?: string; duration_ms: number; inference_calls: number; http_requests: number; cost_upper_microusd: number; cleanup_confirmed: boolean; failure_reason?: string; fallback?: FallbackReceipt }; assessment: { summary: string; findings: LiveFinding[]; limitations: string[] } | null; evidence: HttpRecord[]; tool_runs?: LiveToolRun[]; raw_summary: string };
export function browserAccessDescription(result: LiveResult | null) { const proof = result?.browser_access; return proof ? `Signed-in access verified: ${proof.check.kind === 'account_identity' ? 'the account response matched the supplied identity and differed from the anonymous response' : 'the protected resource was accessible with the account and refused anonymously'}. Evidence #${proof.authenticated_id} and #${proof.anonymous_id}. This establishes access to that resource, not coverage of every private page.` : 'Signed-in access was not verified. Public checks and saved findings may still be useful; authenticated coverage remains a gap.'; }
export type LiveActivity = { received_at: number; progress: { phase: 'starting' | 'scoped_tools' | 'investigating' | 'finishing'; http_requests: number; inference_calls: number; completed_tools: number } };
export type LiveStep = { role: LiveRole; state: string; result: LiveResult | null; evidence_complete?: boolean | null; progress?: LiveActivity | null };
export type LiveTiming = { role_limit_seconds: number; started_at: number | null; active_role_deadline_at: number | null; requests_ahead: number };
const roleDuty = { investigator: 'Map the application and investigate leads.', reproducer: 'Repeat probes and challenge the initial claims.', challenger: 'Check the evidence, impact and recommended fixes.' };
const phases = { starting: 'Starting the isolated runner', scoped_tools: 'Running scoped tools', investigating: 'Investigating the evidence', finishing: 'Preparing the report' };
const support: Record<string, string> = { observed: 'Observed behavior', reproduced: 'Agent reports reproduction', not_reproduced: 'Not reproduced', needs_review: 'Unconfirmed' };

export function LiveProgress({ steps, state, policy }: { steps: LiveStep[]; state: string; policy?: Pick<ReportInput, 'review_policy' | 'third_review' | 'browser_login'> }) {
  const expected = expectedReports(policy ?? {});
  const received = steps.filter(s => s.result !== null).length;
  return <section className="live-progress" aria-label="Live test progress"><div className="section-heading"><h3>The review team</h3><span className="fine">{received} of {expected} reports received</span></div><progress aria-label="Role reports received" value={received} max={expected} />
    <ol className="live-stage-list">{steps.map((s, i) => <li key={s.role} data-state={s.state}><span className="stage-number" aria-hidden="true">{s.result && s.evidence_complete ? '✓' : `0${i + 1}`}</span><div><strong>{liveRoles[s.role]}</strong><small>{s.result ? s.evidence_complete ? 'Report received' : 'Needs review' : s.state === 'leased' || s.state === 'running' ? 'Working' : s.state === 'failed' ? 'Stopped' : s.state === 'cancelled' ? 'Not completed' : 'Up next'}</small></div><p>{roleDuty[s.role]}</p>{!s.result && ['leased', 'running'].includes(s.state) && s.progress && <details className="live-activity"><summary>Latest activity</summary><strong>{phases[s.progress.progress.phase]}</strong><p>{s.progress.progress.http_requests} requests · {s.progress.progress.inference_calls} model calls · {s.progress.progress.completed_tools} tool runs recorded</p><small>Last update: {new Date(s.progress.received_at * 1000).toLocaleTimeString()}</small></details>}</li>)}</ol>
    <p className="fine">{state === 'failed' || state === 'cancelled' ? 'This test has stopped. Any reports received remain available below.' : 'Agents work one after another. You can leave this page and return later.'}</p>
  </section>;
}

export function LiveStatus({ steps, state, deadline, timing }: { steps: LiveStep[]; state: string; deadline: number; timing?: LiveTiming }) {
  const active = steps.find(s => ['leased', 'running'].includes(s.state));
  const stopped = steps.find(s => s.state === 'failed');
  const working = state === 'running' && !!active;
  const title = state === 'awaiting_payment' ? 'Waiting for payment.' : state === 'failed' ? 'The test stopped early.' : state === 'cancelled' ? 'Test cancelled.' : state === 'needs_review' ? 'Some checks need a closer look.' : state === 'completed' ? 'Your reports are ready.' : working ? `${liveRoles[active.role]} is on the case.` : 'Your test is in the queue.';
  const description = state === 'awaiting_payment' ? 'Testing starts after payment is confirmed. Check your order for the current payment status.' : state === 'failed' ? `${stopped && !stopped.result ? `${liveRoles[stopped.role]} stopped before its report arrived. ` : ''}The assessment did not finish. This is not a clean bill of health for your website.` : state === 'cancelled' ? 'No further stages will start. You can still read any reports already received.' : state === 'needs_review' ? 'Some agents could not finish their assessments. Saved findings and unfinished work are listed below.' : state === 'completed' ? 'Read what the agents found and the suggested fixes below. Findings still need your review.' : working ? `${roleDuty[active.role]} This page updates automatically.` : 'Your place is saved. Testing starts when an assigned agent is available.';
  return <div className="assessment-status" data-active={working} data-state={state}>
    <div className="assessment-status-copy"><span className="assessment-kicker">{state === 'failed' ? 'INCOMPLETE ASSESSMENT' : state === 'cancelled' ? 'STOPPED' : state === 'completed' ? 'REPORTS RECEIVED' : state === 'needs_review' ? 'NEEDS ATTENTION' : working ? 'TEST IN PROGRESS' : 'WAITING TO START'}</span><h2>{title}</h2><p>{description}</p>{['queued', 'running'].includes(state) && (timing ? <>
      {!working && <p>{timing.requests_ahead > 0 ? `${timing.requests_ahead} earlier test${timing.requests_ahead === 1 ? '' : 's'} share your selected agents. Ready work runs in order on each machine.` : timing.started_at ? 'Waiting for the next agent to become available.' : 'Waiting for your selected Scout to become available.'}</p>}
      <small>Each agent gets up to {Math.ceil(timing.role_limit_seconds / 60)} minutes after its own work starts. Waiting does not use that allowance.</small>
      {working && timing.active_role_deadline_at && <small>This agent’s time limit ends at {new Date(timing.active_role_deadline_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; it can finish earlier.</small>}
      <details><summary>Timing & permission</summary><p>The request remains valid until {new Date(deadline * 1000).toLocaleString()}. Work must stop if permission or test-account access expires, or you cancel. This separate limit also bounds how long a request can wait.</p></details>
    </> : <small>This request has a fixed expiry: {new Date(deadline * 1000).toLocaleString()}. Saved requests keep their original limits.</small>)}</div>
    <div className="assessment-orbit" aria-hidden="true"><img src="/brand/review-orbit.png" alt="" width="1536" height="1024" /><span className="assessment-orbit-signal" /></div>
  </div>;
}

export function saveReportFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Keep model/target text inert when someone opens the exported Markdown.
const block = fencedText;

export function reportMarkdown(id: string, steps: LiveStep[], origins: string[], policy: Pick<ReportInput, 'review_policy' | 'third_review' | 'browser_login'> = {}) {
  const lines = ['# Patchriot — private website review', `Review: ${id}`, 'Scope:', block(origins.join('\n')), 'Role reports and operator-recorded HTTP evidence. Agreement is not proof of safety. Remediation is a recommendation; no production patch was tested.'];
  const findings = reportFindings({ id, steps, origins, state: '', created_at: 0 });
  lines.push('## Review method', reviewMethod(policy));
  lines.push(`## Observations (${findings.length})`, 'Repeat claims are grouped by title and first cited request. Anonymous and test-account checks stay visible within that observation. Original contributions and role-scoped references are retained. Different severities or support require review; the highest reported severity is shown.');
  for (const row of findings) {
    lines.push(`### ${row.id}`, block(`${row.finding.title}\nSeverity: ${row.finding.severity}`));
    if (row.disputed) lines.push('Roles differ — review needed.');
    for (const c of row.contributions) lines.push(`#### ${liveRoles[c.role]} contribution`, block(`Severity: ${c.finding.severity}\nSupport: ${support[c.finding.support] ?? c.finding.support}\n${c.complete ? 'Assessment received' : 'Partial assessment'}\nFirst cited request: ${findingRequest(c)}`), 'Impact and evidence:', reportMarkdownText(c.finding.explanation), 'Reproduction:', reportMarkdownText(c.finding.reproduction), 'Recommended fix (not tested):', reportMarkdownText(c.finding.suggested_action), `HTTP references: ${c.finding.evidence_ids.map(n => `${c.role}#${n}`).join(', ')}`);
  }
  for (const s of steps) {
    lines.push(`## ${liveRoles[s.role]}`, s.evidence_complete ? 'Report received with recorded requests.' : 'Incomplete role: inspect the evidence and missing checks.');
    if (policy.browser_login || s.result?.browser_access) lines.push('### Sign-in verification', browserAccessDescription(s.result));
    if (!s.result) { lines.push('No report received.'); continue; }
    const r = s.result;
    if (r.execution.fallback) lines.push(block(fallbackDescription(r.execution.fallback)));
    if (r.assessment) {
      lines.push(reportMarkdownText(r.assessment.summary));
      lines.push('### Coverage limits', block(r.assessment.limitations.join('\n')));
    } else lines.push('No usable structured assessment was returned.');
    if (r.tool_runs?.length) {
      lines.push('### Recorded tools', 'Scanner matches are leads. Check the target request and controls before accepting a finding.');
      for (const run of r.tool_runs) lines.push(block(JSON.stringify(run, null, 2), 'json'));
    }
    lines.push('### Recorded requests');
    for (const e of r.evidence) lines.push(block(JSON.stringify(e, null, 2), 'json'));
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

export function PdfReportDownload({ report, loadReport, disabled }: { report: ReportInput; loadReport: () => Promise<ReportInput>; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try {
      const { createReportPdf } = await import('./reportPdf');
      const latest = await loadReport();
      const bytes = await createReportPdf(latest);
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = `patchriot-${report.id}-report.pdf`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : 'The PDF could not be prepared. Retry before the report expires.'); }
    finally { setBusy(false); }
  }
  return <><div className="report-download-main"><button className="primary" disabled={busy || disabled} onClick={() => void download()}>{busy ? 'Preparing PDF…' : 'Download vulnerability report ↓'}</button><p>Summary, findings, evidence & recommended fixes.</p></div>{error && <p className="notice error" role="alert">{error}</p>}</>;
}

export function LiveReportDownloads({ id, steps, loadReport, disabled }: { id: string; steps: LiveStep[]; loadReport: () => Promise<ReportInput>; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoints = inventory(steps);
  async function exportFile(kind: 'markdown' | 'postman') {
    setBusy(true); setError('');
    try {
      const latest = await loadReport();
      if (kind === 'markdown') saveReportFile(`patchriot-${id}-report.md`, reportMarkdown(id, latest.steps, latest.origins, latest), 'text/markdown');
      else saveReportFile(`patchriot-${id}-endpoints.postman.json`, JSON.stringify({ info: { name: 'Patchriot observed endpoints', _postman_id: id, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Observed requests, not a complete API specification. Query values and headers are omitted. These observations do not establish authorization or BOLA. Review scope before sending any request.' }, item: inventory(latest.steps).map(e => ({ name: `${e.method} ${e.url}`, request: { method: e.method, url: { raw: e.url, query: e.query.map(key => ({ key, value: '', disabled: true, description: 'Observed name; value omitted from export.' })) }, description: `Observed HTTP status: ${[...e.statuses].join(', ') || 'No response'}. References: ${e.refs.join(', ')}. Credentials and request bodies are omitted; see the private report for account-access evidence.` }, response: [] })) }, null, 2), 'application/json');
    } catch (e) { setError(e instanceof Error ? e.message : 'The export could not be prepared.'); }
    finally { setBusy(false); }
  }
  return <section className="report-exports"><div className="review-actions"><button className="quiet" disabled={disabled || busy} onClick={() => void exportFile('markdown')}>Download readable report ↓</button><button className="quiet" disabled={disabled || busy || !endpoints.length} onClick={() => void exportFile('postman')}>Export observed endpoints ↓</button></div>{error && <p className="notice error" role="alert">{error}</p>}<details><summary>What is in the endpoint export?</summary><p>A Postman collection of the URLs and methods actually requested, with response codes and evidence references. Query values and headers are omitted. It is not a complete API specification. A publicly reachable route alone does not prove broken authorization.</p></details></section>;
}

function RequestEvidence({ entry }: { entry: HttpRecord }) {
  return <article className="request-evidence"><div className="section-heading"><strong>HTTP #{entry.id}</strong><span className="pill">{entry.method} · {entry.status ?? 'No response'}</span></div><p className="evidence-url">{entry.url}</p>{entry.login && <p className="fine">Relay-managed login. Passwords, tokens, cookies and login response content are withheld.</p>}{entry.authenticated && <p className="fine">The relay sent the supplied test account with this request.</p>}
    {entry.error && <p className="notice">Request did not complete: {entry.error.replaceAll('_', ' ')}.</p>}
    {entry.observed_at && <p className="fine">Recorded {new Date(entry.observed_at * 1000).toLocaleString()}</p>}
    <details><summary>Request and response headers</summary><h5>Request</h5><pre>{JSON.stringify(entry.request_headers ?? {}, null, 2)}</pre><h5>Recorded response headers</h5><pre>{JSON.stringify(entry.headers, null, 2)}</pre></details>
    {entry.request_body_excerpt != null && <details><summary>Submitted body (redacted excerpt)</summary><pre><code>{prettyJson(entry.request_body_excerpt)}</code></pre></details>}
    <details><summary>Response excerpt</summary><pre><code>{prettyJson(entry.body_excerpt || 'No text excerpt recorded.')}</code></pre></details>
    {entry.truncated && <p className="fine">Shortened excerpt; it does not show the complete response.</p>}
    {entry.body_sha256 && <details><summary>Response fingerprint</summary><p className="fine">SHA-256 of the bytes retained by the relay. It helps compare responses; it is not a vulnerability verdict.</p><code className="evidence-url">{entry.body_sha256}</code></details>}
  </article>;
}

export function Remediation({ text }: { text: string }) { return <ReportText text={text} />; }

export function LiveEvidence({ result, complete, technicalOnly = false, browserLogin = false }: { result: LiveResult; complete?: boolean | null; technicalOnly?: boolean; browserLogin?: boolean }) {
  const evidence = useRef<HTMLDetailsElement>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState('all');
  const findings = result.assessment?.findings ?? [];
  const shown = findings.filter(f => filter === 'all' || filter === 'unconfirmed' && ['needs_review', 'not_reproduced'].includes(f.support) || filter === 'reproduced' && f.support === 'reproduced');
  function inspect(ids: number[]) { setSelected(ids); if (evidence.current) { evidence.current.open = true; evidence.current.scrollIntoView({ behavior: 'auto', block: 'start' }); evidence.current.querySelector('summary')?.focus(); } }
  return <div className="live-assessment">
    <div className={`role-summary ${complete ? 'received' : 'incomplete'}`}><h4>{complete ? 'Report and requests received.' : 'This role needs review.'}</h4><p>{complete ? 'Read the finding, the claimed impact and the requests behind it.' : result.assessment ? 'An assessment arrived, but the run or supporting evidence did not finish cleanly. Treat these findings as incomplete.' : 'The agent did not return a usable assessment. Any requests it recorded are still available below.'}</p>
      {result.execution.failure_reason && <p>{stopExplanation(result.execution.failure_reason)}</p>}
      <details><summary>What does this status mean?</summary><p>“Received” means the server accepted a structured report and recorded requests. It does not mean the findings are correct. Missing evidence, interrupted execution or unconfirmed cleanup keep a role marked for review.</p></details>
    </div>
    {(browserLogin || result.browser_access) && <p className="notice">{browserAccessDescription(result)}</p>}
    {result.execution.fallback && <p className="notice" role="status">{fallbackDescription(result.execution.fallback)}</p>}
    <dl className="role-metrics"><div><dt>Requests recorded</dt><dd>{result.execution.http_requests}</dd></div><div><dt>Model calls</dt><dd>{result.execution.inference_calls}</dd></div><div><dt>Run time</dt><dd>{Math.round(result.execution.duration_ms / 1000)}s</dd></div></dl>
    {!!result.tool_runs?.length && <details className="tool-evidence"><summary>Tools run ({result.tool_runs.length})</summary><p>The pinned runner recorded these checks before the agent investigated their output. Matches are leads, not confirmed vulnerabilities. Open the referenced requests to see what the target actually returned.</p>{result.tool_runs.map((run, i) => <article className="request-evidence" key={i}><div className="section-heading"><strong>{run.tool} · {run.version}</strong><span className="pill">{run.failure ? run.failure.replaceAll('_', ' ') : run.exit_code === 0 ? 'Finished' : 'Tool error'}</span></div><p className="fine">{new Date(run.started_at * 1000).toLocaleString()} · {Math.round(run.duration_ms / 1000)}s · {run.evidence_ids.length} recorded requests</p><details><summary>Command arguments</summary><pre>{JSON.stringify(run.arguments, null, 2)}</pre></details><details><summary>Tool output</summary><pre>{run.output_excerpt || (run.exit_code === 0 && !run.failure ? 'No matching observations were printed. This does not prove the site is safe.' : 'No tool output was retained.')}</pre></details>{run.output_truncated && <p className="fine">Output was shortened; inspect the request evidence for the recorded response excerpts.</p>}{run.evidence_ids.length > 0 && <button className="text-button" onClick={() => inspect(run.evidence_ids)}>Inspect tool requests →</button>}</article>)}</details>}
    {!technicalOnly && result.assessment && <><ReportText text={result.assessment.summary} />
      {findings.length > 0 ? <><div className="finding-controls"><h4>Findings from this role</h4><label>Show<select aria-label="Filter findings" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All claims ({findings.length})</option><option value="reproduced">Reported reproduced</option><option value="unconfirmed">Unconfirmed or not reproduced</option></select></label></div>
      {shown.map((f, i) => <article className="live-finding" data-severity={f.severity} key={`${f.title}:${i}`}><div className="finding-heading"><h4>{f.title}</h4><span className="pill">{f.severity} severity</span></div><p className="finding-support">{support[f.support] ?? f.support}</p><h5>Why it matters / what was observed</h5><ReportText text={f.explanation} /><details><summary>Reproduce the observation</summary><p>These are the agent’s instructions. Inspect the scope and evidence before running them.</p><ReportText text={f.reproduction} /></details><details><summary>Recommended fix</summary><p className="fine">A recommendation based on the observed behavior. No production patch was tested.</p><Remediation text={f.suggested_action} /></details><button className="text-button" onClick={() => inspect(f.evidence_ids)}>Inspect {f.evidence_ids.length} supporting request{f.evidence_ids.length === 1 ? '' : 's'} →</button></article>)}
      {shown.length === 0 && <p>No findings match this filter.</p>}
      <p className="fine">Severity and reproduction labels are the agent’s assessment. Other roles may disagree. Review every role before deciding what to fix.</p></> : <p className="notice">This role reported no findings. That is not proof the site has no vulnerabilities.</p>}
      <details className="coverage-limits"><summary>What this role could not check</summary><ul>{result.assessment.limitations.map((v, i) => <li key={i}>{v}</li>)}</ul></details>
    </>}
    <details className="http-evidence" ref={evidence}><summary>Request evidence ({result.evidence.length})</summary><p>These are the requests made to your website and the responses retained by the relay. They let you check a claim against what actually came back. The operator reports these records; a response code alone does not prove a vulnerability.</p>{selected.length > 0 && <p className="notice">Showing references {selected.join(', ')}. <button className="inline" onClick={() => setSelected([])}>Show every request</button></p>}{result.evidence.filter(e => !selected.length || selected.includes(e.id)).map(e => <RequestEvidence key={e.id} entry={e} />)}</details>
    <details className="execution-details"><summary>Agent and execution details</summary><dl><dt>Primary provider / model</dt><dd>{result.execution.provider} / {result.execution.model}</dd><dt>Container cleanup</dt><dd>{result.execution.cleanup_confirmed ? 'Reported complete by relay' : 'Not confirmed'}</dd>{result.execution.image_digest && <><dt>Runtime image</dt><dd><code>{result.execution.image_digest}</code></dd></>}</dl></details>
    {!result.assessment && result.raw_summary && <details><summary>Unformatted model reply</summary><pre>{result.raw_summary}</pre></details>}
  </div>;
}
