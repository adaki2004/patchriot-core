import { useEffect, useRef, useState } from 'react';
import { write } from './api';
import { useLive } from './useLive';

export type CodeStart = { redemption_id: string; request_id: string; review_id: string };
type Reservation = {
  id: string; label: string; site_check_id: string; request_id: string; reserved_at: string;
  consent: { snapshot_sha256: string; device_ids: string[] }; review_id: string | null; last_error: string | null;
};

export function checkedCodeStart(value: CodeStart, requestId: string, redemptionId?: string): CodeStart {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!value || value.request_id !== requestId || !uuid.test(value.review_id) || !uuid.test(value.redemption_id)
    || redemptionId !== undefined && value.redemption_id !== redemptionId) {
    throw new Error('The review reply could not be matched to your request. Check Sponsored reviews under Reviews before trying again.');
  }
  return value;
}

/** Saved requests are recoverable without putting the secret code in a URL or browser storage. */
export function SponsoredReviews({ csrf, onOpen }: { csrf: string; onOpen: (id: string) => void }) {
  const records = useLive<Reservation[]>('/review-codes');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function resume(record: Reservation) {
    setBusy(record.id); setError('');
    try {
      const reply = checkedCodeStart(await write<CodeStart>(`/review-codes/${record.id}/resume`, csrf, {}), record.request_id, record.id);
      if (active.current) { records.refresh(); onOpen(reply.review_id); }
    } catch (error) { if (active.current) { setError((error as Error).message); records.refresh(); } }
    finally { if (active.current) setBusy(null); }
  }
  if (!records.error && !records.data?.length) return null;
  return <section className="panel" aria-label="Sponsored reviews">
    <div className="table-toolbar"><strong>Sponsored reviews</strong><button className="quiet" onClick={records.refresh}>Refresh sponsored reviews ↻</button></div>
    <p className="fine">A review code covers one request. It is not a payment or cash balance. Retrying keeps the same snapshot and selected agents.</p>
    {(records.error || error) && <div className="notice error" role="alert">{error || `Could not load sponsored reviews. ${records.error}`}</div>}
    <div className="review-list">{records.data?.map(record => <article className="sponsored-review" key={record.id}>
      <div><strong>{record.label}</strong><p className="fine">{new Date(record.reserved_at).toLocaleString()} · {record.review_id ? 'Review created' : 'Start not confirmed'}</p>
        {!record.review_id && <p className="fine">The code is reserved for this request. Resume it to check whether the review started. If the selected agents remain unavailable, contact the operator.</p>}
        <details className="execution-details"><summary>Saved sharing permission</summary><p>Permission applies to these three devices and this snapshot. Resume cannot replace them.</p><ol>{record.consent.device_ids.map((id, index) => <li key={id}>{['Investigator', 'Reproducer', 'Challenger'][index]}: <code>{id}</code></li>)}</ol><p className="fine">Snapshot: <code>{record.consent.snapshot_sha256}</code></p></details>
      </div>
      <button className="quiet" disabled={busy !== null} onClick={() => record.review_id ? onOpen(record.review_id) : void resume(record)}>{busy === record.id ? 'Checking saved request…' : record.review_id ? 'Open sponsored review →' : 'Resume saved request →'}</button>
    </article>)}</div>
  </section>;
}
