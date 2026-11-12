import { useState } from 'react';
import { Ticket } from 'lucide-react';
import { write } from './api';
import { useLive } from './useLive';
import { Button } from './components/ui/button';
import './coupons.css';

export type AccountCoupon = { id: string; label: string; expires_at: string };
type CouponRequest = { id: string; status: 'pending' | 'approved' | 'declined'; note: string; created_at: string };
export function useCoupons(_csrf: string) {
  const coupons = useLive<AccountCoupon[]>('/coupons', true, 15_000);
  const usable = !coupons.error && Array.isArray(coupons.data) ? coupons.data.filter(c => Date.parse(c.expires_at) > Date.now()) : [];
  return { ...coupons, usable };
}
export function CouponBalance({ csrf, onUse }: { csrf: string; onUse?: () => void }) {
  const coupons = useCoupons(csrf);
  const request = useLive<{request: CouponRequest | null}>('/coupons/request', true, 15_000);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function ask() {
    setBusy(true); setError('');
    try { await write('/coupons/request', csrf, {}); request.refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (coupons.usable.length) return <div className="coupon-balance"><Ticket size={21} aria-hidden="true"/><div><strong>{coupons.usable.length} free {coupons.usable.length === 1 ? 'audit' : 'audits'}</strong><small>Black-box or grey-box · choose at checkout</small></div>{onUse && <Button type="button" variant="secondary" size="sm" onClick={onUse}>Use coupon</Button>}</div>;
  const status = request.data?.request?.status;
  return <div className="coupon-balance coupon-request"><Ticket size={21} aria-hidden="true"/><div><strong>{status === 'pending' ? 'Coupon requested' : status === 'declined' ? 'Coupon request declined' : status === 'approved' ? 'Coupon already granted' : 'Need a free audit?'}</strong><small>{status === 'pending' ? 'Awaiting approval. You can still pay and start a test.' : status === 'declined' ? 'You can still pay for any test.' : status === 'approved' ? 'Check your coupons at checkout, or pay to start another test.' : 'One black-box or grey-box audit, subject to approval.'}</small>{(error || request.error || coupons.error) && <small role="status">{error || request.error || coupons.error}</small>}</div>{!status && <Button type="button" variant="secondary" size="sm" disabled={busy || !request.updated || !!request.error || !!coupons.error} onClick={() => void ask()}>{busy ? 'Requesting…' : 'Request free coupon'}</Button>}</div>;
}

type StaffCouponRequest = CouponRequest & { account_id: string; display_name: string };
export function CouponRequests({ csrf }: { csrf: string }) {
  const requests = useLive<StaffCouponRequest[]>('/admin/coupons/requests', true, 15_000);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function decide(id: string, decision: 'approve' | 'decline') {
    setBusy(true); setError('');
    try { await write(`/admin/coupons/requests/${id}/decision`, csrf, { decision }); requests.refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel access-panel"><h2>Free coupon requests</h2><p>Sign-in is open. Approving grants one black-box or grey-box audit; requesting alone grants nothing.</p>
    {(error || requests.error) && <p role="alert">{error || requests.error}</p>}
    {!requests.data && <p>Loading requests…</p>}{requests.data?.length === 0 && <p>No pending requests.</p>}
    {requests.data?.map(r => <article className="access-request" key={r.id}><h3>{r.display_name}</h3><p className="fine">{new Date(r.created_at).toLocaleDateString()} · Account {r.account_id}</p>{r.note && <p>{r.note}</p>}<div className="access-options"><Button disabled={busy} onClick={() => void decide(r.id, 'approve')}>Grant one audit to {r.display_name}</Button><Button variant="secondary" disabled={busy} onClick={() => void decide(r.id, 'decline')}>Decline {r.display_name}</Button></div></article>)}
    <p className="fine">First 100 approved sponsorships, including previously granted welcome coupons. Judge gifts are separate. A person may have more than one account; check each request before approving.</p>
  </section>;
}

type JudgeCoupon = { slot: number; code: string; expires_at: string; used: boolean };
export function JudgeCoupons({ csrf }: { csrf: string }) {
  const saved = useLive<JudgeCoupon[]>('/admin/coupons/judges', true, 30_000);
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  async function reserve() {
    setBusy(true); setMessage('');
    try { await write('/admin/coupons/judges',csrf,{}); saved.refresh(); }
    catch(e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  async function copy(c:JudgeCoupon) {
    try { await navigator.clipboard.writeText(`Your Patchriot judge coupon: ${c.code}\nCovers one black-box or grey-box audit at https://patchriot.net. Sign in, verify your domain, then choose Coupon → Enter a code at checkout. Valid until ${new Date(c.expires_at).toLocaleDateString()}.`);setMessage(`Judge coupon ${c.slot} copied.`); }
    catch { setMessage('Copy is unavailable. Select the code to copy it.'); }
  }
  return <section className="panel judge-coupons"><h2>Judge coupons</h2><p>Eight reserved places, separate from requested sponsorships. One judge coupon per account. Share each code with one judge.</p>
    {!saved.data?.length && <Button disabled={busy || !saved.data || !!saved.error} onClick={() => void reserve()}>{busy ? 'Reserving…' : 'Reserve eight judge coupons'}</Button>}
    {saved.data?.map(c => <div className="judge-coupon" key={c.slot}><strong>Judge {c.slot}</strong><code>{c.code}</code><Button variant="secondary" size="sm" disabled={c.used} onClick={() => void copy(c)}>{c.used ? 'Unavailable' : 'Copy DM text'}</Button></div>)}
    {(message || saved.error) && <p role="status">{message || saved.error}</p>}
  </section>;
}
