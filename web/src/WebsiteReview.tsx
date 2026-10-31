import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';

export type WebsiteReviewer = { device_id: string; operator_id: string; operator_name: string; device_name: string; declared_model: string; compute_group: string };
export type WebsiteContext = { site_check_id: string; snapshot_sha256: string; reviewers: WebsiteReviewer[] };
type Plan = { site_check_id: string; snapshot_sha256: string; candidates: WebsiteReviewer[] };
type Finding = { title: string; support: 'observed_in_snapshot' | 'needs_live_test' | 'not_supported'; explanation: string; suggested_action: string; citations: { resource_sha256: string; quote: string }[] };
export type WebsiteResult = {
  kind: 'website_agent_v1'; snapshot_sha256: string; inspected_snapshot_sha256: string | null;
  execution: { state: string; declared_model: string; model: string; model_digest: string; image_digest: string; duration_ms: number; inference_calls: number; terminal_calls: number; cleanup_confirmed: boolean };
  assessment: { summary: string; findings: Finding[]; limitations: string[] } | null; raw_summary: string;
};
const roles = ['Investigator', 'Reproducer', 'Challenger'];

export function WebsiteReviewSetup({ siteId, csrf, onCreated, onClose }: { siteId: string; csrf: string; onCreated: (id: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const plan = useLive<Plan>(`/site-checks/${siteId}/review-plan`);
  const [selected, setSelected] = useState(['', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reviewers = selected.map(id => plan.data?.candidates.find(device => device.device_id === id));
  const ready = reviewers.every(Boolean) && new Set(selected).size === 3 && !plan.error;
  const operators = new Set(reviewers.flatMap(device => device ? [device.operator_id] : []));
  const groups = new Set(reviewers.flatMap(device => device ? [`${device.operator_id}:${device.compute_group}`] : []));
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || !plan.data) return;
    const accepted = new FormData(event.currentTarget).get('consent') === 'on';
    setBusy(true); setError('');
    try {
      const review = await write<{ id: string }>(`/site-checks/${siteId}/review`, csrf, { request_id: requestId.current, snapshot_sha256: plan.data.snapshot_sha256, device_ids: selected, accepts_operator_access: accepted });
      onCreated(review.id); onClose();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} aria-labelledby="website-review-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <button className="close" aria-label="Close agent selection" disabled={busy} onClick={onClose}>×</button>
    <p className="eyebrow">PRIVATE SNAPSHOT / AGENT REVIEW</p><h2 id="website-review-title">Choose who can see it.</h2>
    <p>These operators can read the saved homepage, scripts and earlier review findings. The agents review saved text in isolation; they do not browse or attack your site.</p>
    {(error || plan.error) && <div className="notice error" role="alert">{error || plan.error}</div>}
    <form className="site-form" onSubmit={submit} onChange={() => { requestId.current = crypto.randomUUID(); }}><fieldset disabled={busy}>
      <div className="reviewer-list">{roles.map((role, index) => <label key={role}>{role}<select required aria-label={`${role} device`} value={selected[index]} onChange={event => setSelected(current => current.map((value, i) => i === index ? event.target.value : value))}>
        <option value="">Select an approved device</option>{plan.data?.candidates.map(device => <option key={device.device_id} value={device.device_id} disabled={selected.includes(device.device_id) && selected[index] !== device.device_id}>{device.device_name} · {device.operator_name} · {device.device_id.slice(0, 8)}</option>)}
      </select>{reviewers[index] && <small><strong>{reviewers[index]!.operator_name}</strong> · {reviewers[index]!.declared_model}<br />Declared compute group: {reviewers[index]!.compute_group}</small>}</label>)}</div>
      {(plan.data?.candidates.length ?? 0) < 3 && <p className="notice">{plan.data ? `${plan.data.candidates.length} eligible devices online. Three are needed.` : 'Checking available devices…'} Each needs private-work approval and the operator’s website-review opt-in.</p>}
      {ready && <p className="notice">3 devices · {operators.size} {operators.size === 1 ? 'operator' : 'operators'} · {groups.size} declared compute {groups.size === 1 ? 'group' : 'groups'}. Shared operators, machines or models are not independent reviewers.</p>}
      <label className="check"><input type="checkbox" name="consent" required /><span>I allow these three devices and their named operators to read this snapshot and earlier reports for this review.</span></label>
      <p className="fine">Free pilot. Three sequential roles, up to 35 minutes including waiting. No automatic replacement devices. Reports can include quoted website text; raw snapshot bodies expire after seven days.</p>
      <button className="primary full" disabled={busy || !ready}>{busy ? 'Starting review…' : 'Share snapshot & start review →'}</button>
      <button type="button" className="quiet full" onClick={plan.refresh}>Refresh eligible devices ↻</button>
    </fieldset></form>
  </dialog>;
}

export function WebsiteEvidence({ result, complete }: { result: WebsiteResult; complete: boolean | null | undefined }) {
  const run = result.execution;
  const support = { observed_in_snapshot: 'Observed in saved text', needs_live_test: 'Needs a live test', not_supported: 'Claim not supported' };
  const status = run.state === 'timed_out'
    ? run.inference_calls === 0 ? 'The time limit was reached before a model call started. No security assessment was made.' : 'This role reached its time limit. Its assessment is incomplete.'
    : run.state === 'failed' || run.state === 'cancelled'
      ? 'This agent run did not finish. Any text below is an unverified partial result.'
      : complete ? 'Report received with matching snapshot and citations. Reasoning is unverified.' : 'Missing or inconsistent evidence. Inspect the report before acting.';
  return <>
    <p className={`result-line ${complete ? '' : 'mismatch'}`}>{status}</p>
    <p className="model-name"><strong>{run.model}</strong><small>{Math.round(run.duration_ms / 1000)} seconds</small></p>
    {result.assessment && <div className="website-assessment"><p>{result.assessment.summary}</p>
      {result.assessment.findings.map((finding, index) => <article className="website-finding" key={index}><h4>{finding.title}</h4><span className="badge pending">{support[finding.support]}</span><p>{finding.explanation}</p><p><strong>Suggested next step:</strong> {finding.suggested_action}</p><details><summary>Quoted evidence</summary>{finding.citations.map((citation, i) => <div key={i}><blockquote>{citation.quote}</blockquote><p className="fine">Resource SHA-256: <code>{citation.resource_sha256}</code></p></div>)}</details></article>)}
      {result.assessment.findings.length === 0 && <p className="fine">No supported finding was reported. This does not establish that the site is safe.</p>}
      <p className="fine">LIMITATIONS REPORTED BY THE AGENT</p><ul>{result.assessment.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </div>}
    {result.raw_summary && <><p className="fine">MODEL RESPONSE / DID NOT MATCH THE REPORT FORMAT</p><pre className="agent-summary">{result.raw_summary}</pre></>}
    <details className="execution-details"><summary>Execution details</summary><dl><dt>Run state</dt><dd>{run.state.replaceAll('_', ' ')}</dd><dt>Snapshot read</dt><dd>{result.inspected_snapshot_sha256 === result.snapshot_sha256 ? 'Recorded for this snapshot' : 'Not confirmed'}</dd><dt>Model calls</dt><dd>{run.inference_calls}</dd><dt>Completed terminal calls</dt><dd>{run.terminal_calls}</dd><dt>Container cleanup</dt><dd>{run.cleanup_confirmed ? 'Reported complete' : 'Not confirmed'}</dd><dt>Snapshot SHA-256</dt><dd><code>{result.snapshot_sha256}</code></dd><dt>Model digest</dt><dd><code>{run.model_digest}</code></dd><dt>Agent image</dt><dd><code>{run.image_digest}</code></dd></dl><p className="fine">Terminal counts include the snapshot reader, which the runtime may run before inference. These records are reported by the operator.</p></details>
  </>;
}
