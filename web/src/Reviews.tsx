import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';
import { useDialog } from './useDialog';
import { WebsiteEvidence } from './WebsiteReview';
import type { WebsiteContext, WebsiteResult } from './WebsiteReview';
import { LiveEvidence, LiveProgress, LiveStatus, LiveReportDownloads, PdfReportDownload, saveReportFile, liveRoles } from './LiveReport';
import type { LiveActivity, LiveResult, LiveStep, LiveTiming } from './LiveReport';
import type { PentestContext } from './Pentests';
import { VulnerabilityReport } from './VulnerabilityReport';
import type { ReportInput } from './report';
import { SponsoredReviews } from './ReviewCodes';

type Check = { name: string; expected: boolean; actual: boolean };
type Run = { version: 'original' | 'patched' | 'clean'; completed: boolean; elapsed_ms: number; checks: Check[] };
type Observation = { owner_reads: boolean; blocks_other_user: boolean };
type AgentResult = {
  kind: 'owned_agent_v1'; outcome: string; declared_model: string; model: string; model_digest: string;
  image_digest: string; duration_ms: number; inference_calls: number; terminal_calls: number;
  cleanup_confirmed: boolean; observation: { original: Observation; patched: Observation } | null; summary: string;
};
type Step = {
  role: 'investigator' | 'reproducer' | 'challenger'; state: string; attempts: number;
  device_id: string | null; operator_id: string | null; compute_group: string | null;
  result: { runs: Run[] } | AgentResult | WebsiteResult | LiveResult | null; fixture_matches: boolean | null; evidence_complete?: boolean | null; progress?: LiveActivity | null;
};
type Retention = { first_downloaded_at: number; expires_at: number; content_deleted: boolean };
type Review = { retention?: Retention; id: string; mode: string; state: string; created_at: number; deadline_at: number; timing?: LiveTiming; steps: Step[]; evidence_source: string; pentest?: PentestContext; website?: WebsiteContext; source?: { source_id: string; snapshot_sha256: string; reviewers: WebsiteContext['reviewers'] }; payment?: { price: { asset: string; amount: string }; expires_at: number; invoice_id: string | null; funded_at: number | null } };
// Finished evidence is immutable until deletion. Recheck on export, manual
// refresh, tab return or retention expiry instead of pulling megabytes forever.
const pollActiveReview = (review: Review) => ['awaiting_payment', 'queued', 'running'].includes(review.state);

function reportInput(review: Review): ReportInput {
  const liveSteps: LiveStep[] = review.steps.map(s => ({ role: s.role, state: s.state, evidence_complete: s.evidence_complete, progress: s.progress, result: s.result && 'kind' in s.result && s.result.kind === 'pentest_agent_v1' ? s.result : null }));
  const team = review.pentest?.reviewers ?? [];
  return { id: review.id, state: review.state, created_at: review.created_at, steps: liveSteps, origins: review.pentest?.scope.origins ?? [], methods: review.pentest?.scope.methods, profile: review.pentest?.scope.profile, authentication: review.pentest?.scope.authentication, auth_check_path: review.pentest?.scope.auth_check_path, scope_sha256: review.pentest?.scope_sha256, team };
}

const states: Record<string, string> = {
  awaiting_payment: 'Waiting for payment', queued: 'Waiting for a relay', running: 'In progress', completed: 'Example checks complete',
  needs_review: 'Needs review', cancelled: 'Cancelled', failed: 'Incomplete', leased: 'Assigned',
};
const label = (value: string) => states[value] ?? value.replaceAll('_', ' ');
const reviewLabel = (review: Review) => review.retention?.content_deleted ? 'Report deleted' : ['website_agent', 'source_agent', 'pentest_agent'].includes(review.mode) && review.state === 'completed' ? 'Reports received' : label(review.state);
function stepLabel(step: Step) {
  if (step.state !== 'completed') return label(step.state);
  const result = step.result;
  const outcome = result && !('runs' in result) ? result.kind !== 'owned_agent_v1' ? result.execution.state : result.outcome : null;
  return outcome === 'timed_out' ? 'Timed out' : outcome === 'failed' ? 'Run failed' : outcome === 'cancelled' ? 'Run cancelled' : 'Reported';
}

function NewReview({ csrf, onCreated, onClose }: { csrf: string; onCreated: (review: Review) => void; onClose: () => void }) {
  const dialog = useDialog('input[name="review-mode"]:checked');
  const requestId = useRef(crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'owned_fixture' | 'owned_agent'>('owned_fixture');
  const limits = useLive<{ agent_review_timeout_seconds?: number }>('/fleet', mode === 'owned_agent');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const review = await write<Review>('/reviews', csrf, { request_id: requestId.current, scenario: 'access_control_v1', ...(mode === 'owned_agent' ? { mode } : {}) });
      onCreated(review); onClose();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="new-review-title">
    <button className="close" onClick={onClose} disabled={busy} aria-label="Close review setup">×</button>
    <p className="eyebrow">OWNED EXAMPLE / NO CHARGE</p><h2 id="new-review-title">Watch a review move through the swarm.</h2>
    <p>A signed-in user can read someone else’s document. The example includes that bug and a supplied fix.</p>
    <form onSubmit={submit}>
      <fieldset className="review-mode" disabled={busy}><legend>How should it run?</legend>
        <label><input type="radio" name="review-mode" checked={mode === 'owned_fixture'} onChange={() => { setMode('owned_fixture'); requestId.current = crypto.randomUUID(); }} /><span><strong>Quick fixture check</strong><small>Built-in tests. No model calls.</small></span></label>
        <label><input type="radio" name="review-mode" checked={mode === 'owned_agent'} onChange={() => { setMode('owned_agent'); requestId.current = crypto.randomUUID(); }} /><span><strong>Local agent check</strong><small>Agents inspect the code and run tools.</small></span></label>
      </fieldset>
      <ul className="review-terms"><li>Three distinct approved devices; shared machines run one at a time.</li><li>{mode === 'owned_agent' ? 'Each agent checks the same supplied bug and fix. CPU models can take several minutes per role.' : 'Each relay runs the original, the fix and a separate clean control.'}</li><li>Expires after {mode === 'owned_agent' ? Math.ceil((limits.data?.agent_review_timeout_seconds ?? 2100) / 60) : 15} minutes, including waiting. You can cancel while it is queued or running.</li></ul>
      {(error || limits.error) && <div className="notice error" role="alert">{error || limits.error}</div>}<button className="primary full" disabled={busy || mode === 'owned_agent' && (!limits.data || !!limits.error)}>{busy ? 'Creating review…' : mode === 'owned_agent' ? 'Run agent checks →' : 'Run the owned example →'}</button>
    </form>
  </dialog>;
}

function Evidence({ step }: { step: Step }) {
  if (!step.result) return <p className="subtle">No evidence received yet.</p>;
  if ('runs' in step.result) return <>
    <p className={`result-line ${step.fixture_matches ? 'match' : 'mismatch'}`}>{step.fixture_matches ? 'Original flaw reproduced; patch and clean control pass.' : 'The evidence does not match the expected fixture regression.'}</p>
    <div className="table-scroll"><table><thead><tr><th>Version</th><th>Execution</th><th>Checks matching policy</th></tr></thead><tbody>{step.result.runs.map((run, index) => <tr key={`${run.version}-${index}`}><td>{run.version}</td><td>{run.completed ? 'Finished' : 'Did not finish'}</td><td>{run.checks.filter(check => check.actual === check.expected).length} / {run.checks.length}</td></tr>)}</tbody></table></div>
  </>;
  const result = step.result;
  if (result.kind === 'pentest_agent_v1') return <LiveEvidence result={result} complete={step.evidence_complete} />;
  if (result.kind !== 'owned_agent_v1') return <WebsiteEvidence result={result} complete={step.evidence_complete} />;
  return <>
    <p className={`result-line ${step.fixture_matches ? 'match' : 'mismatch'}`}>{step.fixture_matches ? 'Tool evidence shows the original flaw and the supplied fix passing.' : 'The agent did not provide a complete, matching tool result.'}</p>
    <p className="model-name"><strong>{result.model}</strong><small>{Math.round(result.duration_ms / 1000)} seconds · {result.inference_calls} model calls · {result.terminal_calls} completed terminal calls</small></p>
    {result.observation && <div className="table-scroll"><table><thead><tr><th>Observed check</th><th>Original</th><th>Patched</th></tr></thead><tbody>
      <tr><td>Owner can read</td><td>{result.observation.original.owner_reads ? 'Yes' : 'No'}</td><td>{result.observation.patched.owner_reads ? 'Yes' : 'No'}</td></tr>
      <tr><td>Other user is blocked</td><td>{result.observation.original.blocks_other_user ? 'Yes' : 'No'}</td><td>{result.observation.patched.blocks_other_user ? 'Yes' : 'No'}</td></tr>
    </tbody></table></div>}
    {result.summary && <><p className="fine"><strong>Agent explanation · unverified</strong><br />Passing the tool checks does not validate this explanation.</p><pre className="agent-summary">{result.summary}</pre></>}
    <details className="execution-details"><summary>Execution details</summary><dl><dt>Outcome</dt><dd>{result.outcome.replaceAll('_', ' ')}</dd><dt>Container cleanup</dt><dd>{result.cleanup_confirmed ? 'Confirmed by relay' : 'Not confirmed'}</dd><dt>Paired model declaration</dt><dd>{result.declared_model}</dd><dt>Model digest</dt><dd><code>{result.model_digest}</code></dd><dt>Runtime image</dt><dd><code>{result.image_digest}</code></dd></dl></details>
  </>;
}

export function ReviewDetail({ id, csrf, onClose, onChange, onOpenOrders }: { id: string; csrf: string; onClose: () => void; onChange: () => void; onOpenOrders?: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const detail = useLive<Review>(`/reviews/${id}`, true, 10_000, pollActiveReview);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const review = detail.data;
  const [downloadRetention, setDownloadRetention] = useState<Retention>();
  const [clockExpired, setClockExpired] = useState(false);
  const retention = downloadRetention ?? review?.retention;
  const deleted = clockExpired || Boolean(retention?.content_deleted);
  const canExport = Boolean(review && !deleted && !['awaiting_payment', 'queued', 'running'].includes(review.state));
  useEffect(() => {
    if (!retention) return;
    const delay = retention.expires_at * 1000 - Date.now();
    if (delay <= 0) { setClockExpired(true); return; }
    const timer = window.setTimeout(() => { setClockExpired(true); detail.refresh(); }, delay);
    return () => window.clearTimeout(timer);
  }, [retention?.expires_at, detail.refresh]);
  async function exportReview(): Promise<Review> {
    const latest = await write<Review>(`/reviews/${id}/report`, csrf, {});
    if (latest.retention) setDownloadRetention(latest.retention);
    detail.refresh();
    return latest;
  }
  const loadReport = async () => reportInput(await exportReview());
  async function exportEvidence() {
    setBusy(true); setError('');
    try { saveReportFile(`patchriot-review-${id}.json`, JSON.stringify(await exportReview(), null, 2), 'application/json'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const retentionNotice = <p className="notice report-retention" role="status">{retention ? <>Save a copy before <strong>{new Date(retention.expires_at * 1000).toLocaleString()}</strong>. Private findings and evidence will be deleted then; further downloads do not extend this time.</> : <>{!canExport && 'Downloads become available when the test ends. '}The requester’s first download starts a 12-hour deletion timer. Save the files you need. Staff exports do not start this timer.</>}</p>;
  const material = review?.website ?? review?.source;
  const liveSteps: LiveStep[] = review?.steps.map(s => ({ role: s.role, state: s.state, evidence_complete: s.evidence_complete, progress: s.progress, result: s.result && 'kind' in s.result && s.result.kind === 'pentest_agent_v1' ? s.result : null })) ?? [];
  useEffect(() => { if (review) onChange(); }, [review?.state, onChange]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: 'start' });
  }, [id]);
  async function cancel() {
    if (!window.confirm('Cancel this review? Connected agents will stop when they check their lease; further results will be rejected.')) return;
    setBusy(true); setError('');
    try { await write(`/reviews/${id}/cancel`, csrf, {}); detail.refresh(); onChange(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const operators = new Set(review?.steps.flatMap(step => step.operator_id ? [step.operator_id] : []));
  const groups = new Set(review?.steps.flatMap(step => step.compute_group ? [`${step.operator_id}:${step.compute_group}`] : []));
  const devices = new Set(review?.steps.flatMap(step => step.device_id ? [step.device_id] : []));
  if (review && deleted) return <section ref={panel} tabIndex={-1} className="review-detail panel" aria-label="Review report"><div className="section-heading"><h2>Private report deleted</h2><button className="quiet" onClick={onClose}>Close report ×</button></div><p>The 12-hour download window ended. Findings, HTTP evidence and tool output are no longer available here. Your job, permission and payment records remain.</p><p>Copies you or your operator already saved are outside this deletion.</p>{review.payment && onOpenOrders && <button className="quiet" onClick={onOpenOrders}>View order →</button>}</section>;
  if (review?.mode === 'pentest_agent') {
    const team = review.pentest?.reviewers ?? [];
    const teamOperators = new Set(team.map(r => r.operator_id)).size;
    const teamGroups = new Set(team.map(r => `${r.operator_id}:${r.compute_group}`)).size;
    const report = reportInput(review);
    const target = review.pentest?.scope.origins.map(origin => { try { return new URL(origin).host; } catch { return origin; } }).join(', ');
    return <section ref={panel} tabIndex={-1} className="review-detail panel live-review" aria-label="Review report">
      <div className="section-heading"><div><p className="eyebrow">PRIVATE WEBSITE ASSESSMENT</p><h2 className="review-target">{target || 'Website test'}</h2><p className="fine">Requested {new Date(review.created_at * 1000).toLocaleString()}</p></div><button className="quiet" onClick={onClose}>Close report ×</button></div>
      {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error} <button className="inline" onClick={detail.refresh}>Retry report</button></div>}
      {!['completed', 'needs_review'].includes(review.state) && <LiveStatus steps={liveSteps} state={review.state} deadline={review.deadline_at} timing={review.timing} />}
      {['awaiting_payment', 'queued', 'running'].includes(review.state) && <LiveProgress steps={liveSteps} state={review.state} />}
      {retentionNotice}<PdfReportDownload report={report} loadReport={loadReport} disabled={!canExport} />
      <div className="review-actions report-controls">{['failed', 'cancelled'].includes(review.state) && <a className="text-button" href="#/pentests">Test a website ↗</a>}<button className="quiet" onClick={detail.refresh}>Refresh report ↻</button>{!review.payment && ['queued', 'running'].includes(review.state) && <button className="quiet" onClick={() => void cancel()} disabled={busy}>Cancel test</button>}{review.payment && onOpenOrders && <button className="quiet" onClick={onOpenOrders}>Manage order →</button>}</div>
      <VulnerabilityReport report={report} />
      <details className="assessment-disclosure report-technical"><summary>Other downloads & test details</summary>
        <LiveReportDownloads id={review.id} steps={liveSteps} loadReport={loadReport} disabled={!canExport} />
        <button className="quiet" disabled={!canExport || busy} onClick={() => void exportEvidence()}>Download evidence JSON ↓</button>
        <dl><dt>Reference</dt><dd>{id}</dd><dt>Website</dt><dd>{review.pentest?.scope.origins.join(', ')}</dd><dt>Test plan</dt><dd>{review.pentest?.scope.objective}</dd><dt>Model provider</dt><dd>{review.pentest?.provider}</dd><dt>Selected team</dt><dd>{team.length} agents · {teamOperators} operator(s) · {teamGroups} machine group(s). Shared machines and models are not independent reviewers.</dd></dl>
        <ol>{team.map((r, i) => <li key={r.device_id}>{Object.values(liveRoles)[i]} · {r.device_name} · {r.declared_model}</li>)}</ol>
      </details>
      <p className="report-footnote">An automated assessment within the approved methods and account access. It does not replace a full human penetration test.</p>
    </section>;
  }
  return <section ref={panel} tabIndex={-1} className="review-detail panel" aria-label="Review report">
    <div className="section-heading"><div><p className="eyebrow">{!review ? 'PRIVATE REVIEW' : review.mode === 'pentest_agent' ? 'LIVE WEBSITE / PRIVATE REPORT' : review.mode === 'source_agent' ? 'SOURCE CODE / PRIVATE AGENT REVIEW' : review.mode === 'website_agent' ? 'WEBSITE SNAPSHOT / PRIVATE AGENT REVIEW' : `ACCESS CONTROL / ${review.mode === 'owned_agent' ? 'LOCAL AGENT CHECK' : 'OWNED FIXTURE'}`}</p><h2>{review ? reviewLabel(review) : detail.error ? 'Review unavailable' : 'Loading review…'}</h2><p className="fine">{id}</p></div><button className="quiet" onClick={onClose}>Close report ×</button></div>
    {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error} {detail.error && <button className="inline" onClick={detail.refresh}>Retry report</button>}</div>}
    {review && <>
      {retentionNotice}
      <div className="review-actions"><button className="quiet" disabled={!canExport || busy} onClick={() => void exportEvidence()}>Download evidence JSON ↓</button><button className="quiet" onClick={detail.refresh}>Refresh report ↻</button>{!review.payment && ['queued', 'running'].includes(review.state) && <button className="quiet" onClick={() => void cancel()} disabled={busy}>Cancel review</button>}</div>
      {review.payment && <p className="fine">This review has a payment record. Manage cancellation in Orders.{onOpenOrders && <button className="inline" onClick={onOpenOrders}>Open orders →</button>}</p>}
      {review.mode === 'pentest_agent' && <><LiveProgress steps={liveSteps} state={review.state} /><LiveReportDownloads id={review.id} steps={liveSteps} loadReport={loadReport} disabled={!canExport} /></>}
      {review.mode !== 'pentest_agent' && ['queued', 'running'].includes(review.state) && <p className="fine">{review.steps.filter(step => step.state === 'completed').length} of 3 reports received · Ends at {new Date(review.deadline_at * 1000).toLocaleTimeString()}</p>}
      <div className="notice">{devices.size} {devices.size === 1 ? 'device' : 'devices'} · {operators.size} {operators.size === 1 ? 'operator' : 'operators'} · {groups.size} declared compute {groups.size === 1 ? 'group' : 'groups'}. {review.mode === 'pentest_agent' ? 'These agents make approved live HTTP probes and retain request evidence. Coverage is limited to the approved methods and account access.' : review.mode === 'source_agent' ? 'These agents inspect source excerpts. This mode does not build or execute the code.' : review.mode === 'website_agent' ? 'These agents review saved text. No browser execution or live exploit reproduction was performed.' : 'These are operator-reported checks of our owned example.'} Shared machines and models are not independent reviewers.</div>
      {review.pentest && <details className="execution-details"><summary>Approved scope and review team</summary><p>{review.pentest.scope.origins.join(', ')}</p><p>{review.pentest.scope.objective}</p><p>Model provider: {review.pentest.provider}</p><ol>{review.pentest.reviewers.map(r => <li key={r.device_id}>{r.device_name} · {r.operator_name} · {r.declared_model} · {r.compute_group}</li>)}</ol></details>}
      {material && <details className="execution-details"><summary>Who received permission?</summary><ol>{material.reviewers.map((device, i) => <li key={device.device_id}><strong>{['Investigator', 'Reproducer', 'Challenger'][i]}:</strong> {device.device_name} · {device.operator_name}<br /><span className="fine">{device.declared_model} · {device.compute_group} · {device.device_id}</span></li>)}</ol><p className="fine">Consent applies to this snapshot: <code>{material.snapshot_sha256}</code></p></details>}
      <div className="review-steps">{review.steps.map(step => <article key={step.role} className="review-step">
        <div className="step-title"><h3>{review.mode === 'pentest_agent' ? liveRoles[step.role] : step.role}</h3><span className={`badge ${step.state === 'completed' && step.fixture_matches ? 'approved' : step.state === 'failed' ? 'revoked' : 'pending'}`}>{stepLabel(step)}</span></div>
        <p className="fine">Attempt {step.attempts} / {review.mode === 'pentest_agent' ? 1 : 3}{step.compute_group ? ` · ${step.compute_group}` : ' · awaiting capacity'}</p>
        <Evidence step={step} />
      </article>)}</div>
      <p className="fine">{review.mode === 'pentest_agent' ? 'Live reports retain request evidence. A finding still needs human assessment; operator records and model agreement are not independent proof of safety.' : ['website_agent', 'source_agent'].includes(review.mode) ? 'Reports are claims to inspect, not a safety certificate. Matching quotations do not validate security reasoning or prove an exploit. Model identities and cleanup are operator-reported.' : `${review.mode === 'owned_agent' ? 'The fix is supplied, not generated by these agents. Model names and digests are operator declarations.' : 'The original should fail one access check; the patched and clean versions should pass all three.'} Completing this example is not a verdict about any other system.`}</p>
    </>}
  </section>;
}

export function Reviews({ csrf, selected, onSelect, onOpenOrders, admin = false }: { csrf: string; selected: string | null; onSelect: (id: string | null) => void; onOpenOrders?: () => void; admin?: boolean }) {
  const reviews = useLive<Review[]>('/reviews?scope=mine');
  const [creating, setCreating] = useState(false);
  return <>
    {!selected && <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Your reports</h1><p className="subtle">Follow your tests and review the findings.</p></div><a className="primary" href="#/pentests">Test a website ↗</a></section>}
    {reviews.error && <div className="notice error" role="alert">{reviews.error} <button className="inline" onClick={reviews.refresh}>Retry</button></div>}
    {selected && <ReviewDetail key={selected} id={selected} csrf={csrf} onClose={() => onSelect(null)} onChange={reviews.refresh} onOpenOrders={onOpenOrders} />}
    <details className="assessment-disclosure"><summary>Coupon history & interrupted checkouts</summary><SponsoredReviews csrf={csrf} onOpen={id => { reviews.refresh(); onSelect(id); }} /></details>
    {!selected && <section className="panel"><div className="table-toolbar"><strong>{reviews.data ? `${reviews.data.length} ${reviews.data.length === 1 ? 'report' : 'reports'}` : 'Loading reports…'}</strong><button className="quiet" onClick={reviews.refresh}>Refresh reports ↻</button></div>
      {reviews.data?.length === 0 && <div className="empty"><h2>No tests yet.</h2><p>Start with a website you own. Your progress and findings will appear here.</p></div>}
      {Boolean(reviews.data?.length) && <div className="review-list">{reviews.data!.map(review => <button className={`review-item ${selected === review.id ? 'selected' : ''}`} key={review.id} onClick={() => onSelect(review.id)}><span><strong>{review.mode === 'pentest_agent' ? 'Live website test' : review.mode === 'source_agent' ? 'Source code review' : review.mode === 'website_agent' ? 'Website snapshot review' : 'Access-control example'}</strong><small>{review.mode === 'owned_fixture' ? 'Fixture tests' : review.mode === 'pentest_agent' ? 'Live agents' : 'Local agents'} · {new Date(review.created_at * 1000).toLocaleString()} · {review.id.slice(0, 8)}</small></span><span>{reviewLabel(review)} <span aria-hidden="true">↗</span></span></button>)}</div>}
    </section>}
    {admin && <details className="assessment-disclosure"><summary>Developer checks · staff only</summary><p>Run a built-in example to check the review infrastructure. This does not assess a customer website.</p><button className="quiet" onClick={() => setCreating(true)}>Run example check</button></details>}
    {admin && creating && <NewReview csrf={csrf} onCreated={review => { reviews.refresh(); onSelect(review.id); }} onClose={() => setCreating(false)} />}
  </>;
}
