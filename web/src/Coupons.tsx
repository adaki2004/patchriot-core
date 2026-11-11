import { useEffect, useState } from 'react';
import { Ticket } from 'lucide-react';
import { write } from './api';
import { useLive } from './useLive';
import { Button } from './components/ui/button';
import './coupons.css';

export type AccountCoupon = { id: string; label: string; expires_at: string };
export function useCoupons(csrf: string) {
  const coupons = useLive<AccountCoupon[]>('/coupons', true, 15_000);
  const [claimError, setClaimError] = useState('');
  useEffect(() => {
    let active = true;
    void write('/coupons/welcome', csrf, {}).then(() => { if (active) { setClaimError(''); coupons.refresh(); } }).catch(() => {
      if (active) setClaimError('Welcome coupon availability could not be checked. Refresh to try again.');
    });
    return () => { active = false; };
  }, [csrf, coupons.refresh]);
  const usable = !coupons.error && Array.isArray(coupons.data) ? coupons.data.filter(c => Date.parse(c.expires_at) > Date.now()) : [];
  return { ...coupons, usable, claimError };
}
export function CouponBalance({ csrf, onUse }: { csrf: string; onUse?: () => void }) {
  const coupons = useCoupons(csrf);
  if (!coupons.usable.length) return coupons.error || coupons.claimError ? <small role="status">{coupons.error || coupons.claimError}</small> : null;
  return <div className="coupon-balance"><Ticket size={21} aria-hidden="true"/><div><strong>{coupons.usable.length} free {coupons.usable.length === 1 ? 'audit' : 'audits'}</strong><small>Black-box or grey-box · choose at checkout</small></div>{onUse && <Button type="button" variant="secondary" size="sm" onClick={onUse}>Use coupon</Button>}</div>;
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
  return <section className="panel judge-coupons"><h2>Judge coupons</h2><p>Eight reserved places, separate from the 100 welcome audits. One judge coupon per account. Share each code with one judge.</p>
    {!saved.data?.length && <Button disabled={busy || !saved.data || !!saved.error} onClick={() => void reserve()}>{busy ? 'Reserving…' : 'Reserve eight judge coupons'}</Button>}
    {saved.data?.map(c => <div className="judge-coupon" key={c.slot}><strong>Judge {c.slot}</strong><code>{c.code}</code><Button variant="secondary" size="sm" disabled={c.used} onClick={() => void copy(c)}>{c.used ? 'Unavailable' : 'Copy DM text'}</Button></div>)}
    {(message || saved.error) && <p role="status">{message || saved.error}</p>}
  </section>;
}
