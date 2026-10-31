import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';

type Check = { name: string; expected: boolean; actual: boolean };
type Run = { version: 'original' | 'patched' | 'clean'; completed: boolean; elapsed_ms: number; checks: Check[] };
type Step = {
  role: 'investigator' | 'reproducer' | 'challenger'; state: string; attempts: number;
  device_id: string | null; operator_id: string | null; compute_group: string | null;
  result: { runs: Run[] } | null; fixture_matches: boolean | null;
};
type Review = { id: string; mode: string; state: string; created_at: number; deadline_at: number; steps: Step[]; evidence_source: string };

const states: Record<string, string> = {
  queued: 'Waiting for a relay', running: 'In progress', completed: 'Fixture checks complete',
  needs_review: 'Needs review', cancelled: 'Cancelled', failed: 'Incomplete', leased: 'Assigned',
};
const label = (value: string) => states[value] ?? value.replaceAll('_', ' ');

function NewReview({ csrf, onCreated, onClose }: { csrf: string; onCreated: (review: Review) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const review = await write<Review>('/reviews', csrf, { request_id: requestId.current, scenario: 'access_control_v1' });
      onCreated(review); onClose();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="new-review-title">
    <button className="close" onClick={onClose} aria-label="Close review setup">×</button>
    <p className="eyebrow">OWNED EXAMPLE / NO CHARGE</p><h2 id="new-review-title">Watch a review move through the swarm.</h2>
    <p>A signed-in user can read someone else’s document. Three relays run the original example, its fix and a separate clean control.</p>
    <ul className="review-terms"><li>Three distinct approved devices; shared machines run one at a time.</li><li>Only the built-in example runs. No website, repository or model call is involved.</li><li>Expires after 15 minutes. You can cancel while it is queued or running.</li></ul>
    <form onSubmit={submit}>{error && <div className="notice error" role="alert">{error}</div>}<button className="primary full" disabled={busy}>{busy ? 'Creating review…' : 'Run the owned example →'}</button></form>
  </dialog>;
}

function Detail({ id, csrf, onClose, onChange }: { id: string; csrf: string; onClose: () => void; onChange: () => void }) {
  const detail = useLive<Review>(`/reviews/${id}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const review = detail.data;
  async function cancel() {
    if (!window.confirm('Cancel this fixture review? Unfinished assignments will stop being accepted.')) return;
    setBusy(true); setError('');
    try { await write(`/reviews/${id}/cancel`, csrf, {}); detail.refresh(); onChange(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const operators = new Set(review?.steps.flatMap(step => step.operator_id ? [step.operator_id] : []));
  const groups = new Set(review?.steps.flatMap(step => step.compute_group ? [step.compute_group] : []));
  const devices = new Set(review?.steps.flatMap(step => step.device_id ? [step.device_id] : []));
  return <section className="review-detail panel" aria-label="Fixture review report">
    <div className="section-heading"><div><p className="eyebrow">ACCESS CONTROL / OWNED FIXTURE</p><h2>{review ? label(review.state) : 'Loading review…'}</h2><p className="fine">{id}</p></div><button className="quiet" onClick={onClose}>Close report ×</button></div>
    {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error}</div>}
    {review && <>
      <div className="review-actions"><a className="text-button" href={`/api/reviews/${id}/report`} download>Download evidence JSON ↓</a><button className="quiet" onClick={detail.refresh}>Refresh report ↻</button>{['queued', 'running'].includes(review.state) && <button className="quiet" onClick={() => void cancel()} disabled={busy}>Cancel review</button>}</div>
      <div className="notice">{devices.size} devices · {operators.size} operators · {groups.size} declared compute groups. These are device-reported fixture results, not an independent audit or proof of model quality.</div>
      <div className="review-steps">{review.steps.map(step => <article key={step.role} className="review-step">
        <div className="step-title"><h3>{step.role}</h3><span className={`badge ${step.state === 'completed' ? 'approved' : step.state === 'failed' ? 'revoked' : 'pending'}`}>{label(step.state)}</span></div>
        <p className="fine">Attempt {step.attempts} / 3{step.compute_group ? ` · ${step.compute_group}` : ' · awaiting capacity'}</p>
        {step.result ? <><p className={`result-line ${step.fixture_matches ? 'match' : 'mismatch'}`}>{step.fixture_matches ? 'Original flaw reproduced; patch and clean control pass.' : 'The evidence does not match the expected fixture regression.'}</p><div className="table-scroll"><table><thead><tr><th>Version</th><th>Execution</th><th>Checks matching policy</th></tr></thead><tbody>{step.result.runs.map((run, index) => <tr key={`${run.version}-${index}`}><td>{run.version}</td><td>{run.completed ? 'Finished' : 'Did not finish'}</td><td>{run.checks.filter(check => check.actual === check.expected).length} / {run.checks.length}</td></tr>)}</tbody></table></div></> : <p className="subtle">No evidence received yet.</p>}
      </article>)}</div>
      <p className="fine">The original should fail one access check; the patched and clean versions should pass all three. A completed fixture workflow is not a verdict about any other system.</p>
    </>}
  </section>;
}

export function Reviews({ csrf }: { csrf: string }) {
  const reviews = useLive<Review[]>('/reviews');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Your reviews</h1><p className="subtle">Start with an owned example. No customer targets or paid work are enabled.</p></div><button className="primary" onClick={() => setCreating(true)}>New fixture review +</button></section>
    {reviews.error && <div className="notice error" role="alert">{reviews.error} <button className="inline" onClick={reviews.refresh}>Retry</button></div>}
    <section className="panel"><div className="table-toolbar"><strong>{reviews.data ? `${reviews.data.length} fixture reviews` : 'Loading reviews…'}</strong><button className="quiet" onClick={reviews.refresh}>Refresh reviews ↻</button></div>
      {reviews.data?.length === 0 && <div className="empty"><h2>Make the evidence visible.</h2><p>Send the built-in example through three relay roles and inspect the original, patched and clean results.</p></div>}
      {Boolean(reviews.data?.length) && <div className="review-list">{reviews.data!.map(review => <button className={`review-item ${selected === review.id ? 'selected' : ''}`} key={review.id} onClick={() => setSelected(review.id)}><span><strong>Access-control example</strong><small>{new Date(review.created_at * 1000).toLocaleString()} · {review.id.slice(0, 8)}</small></span><span>{label(review.state)} <span aria-hidden="true">↗</span></span></button>)}</div>}
    </section>
    {selected && <Detail key={selected} id={selected} csrf={csrf} onClose={() => setSelected(null)} onChange={reviews.refresh} />}
    <p className="fine">At most three active fixture reviews per account. Keep three approved relays connected with <code>--fixtures</code> to run the complete workflow.</p>
    {creating && <NewReview csrf={csrf} onCreated={review => { reviews.refresh(); setSelected(review.id); }} onClose={() => setCreating(false)} />}
  </>;
}
