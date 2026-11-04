import { useState } from 'react';
import { write } from './api';
import { useLive } from './useLive';

type Claim = { id: string; code: string; expires_at: string; reserved_at: string | null; review_id: string | null; revoked_at: string | null };
type Offer = { available: boolean; ends_at: string | null; claim: Claim | null };

/** A click claims sponsorship; simply signing in never consumes an allowance. */
export function Trial({ csrf, onUse, onStart }: { csrf: string; onUse?: (code: string) => void; onStart?: () => void }) {
  const trial = useLive<Offer>('/trial', true, 60_000);
  const [claimed, setClaimed] = useState<Claim | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const coupon = trial.data?.claim ?? claimed;
  const usable = coupon && !coupon.reserved_at && !coupon.revoked_at && Date.parse(coupon.expires_at) > Date.now();
  async function claim() {
    setBusy(true); setError('');
    try {
      const result = await write<Claim>('/trial', csrf, { accepts_trial: true });
      setClaimed(result); trial.refresh();
      if (onUse) onUse(result.code);
    } catch(e) { setError((e as Error).message); trial.refresh(); }
    finally { setBusy(false); }
  }
  if (!trial.data && !trial.error) return null;
  if (!trial.data?.available && !usable && !error) return null;
  return <aside className="trial-card" aria-label="Free trial">
    <div><span className="section-kicker">ONE ASSESSMENT / ON US</span><h2>{usable ? 'Your free test is ready.' : 'Try it on your own website.'}</h2><p>{usable ? 'Your coupon covers one black-box or grey-box assessment.' : 'Request a free-test coupon. Verify your domain, then start when you are ready.'}</p></div>
    {usable ? <><p className="fine">Use by {new Date(coupon.expires_at).toLocaleString()}. Ownership verification and team consent still apply.</p><details><summary>Your personal coupon</summary><code className="trial-code">{coupon.code}</code><small>Only your signed-in account can use this coupon.</small></details><button type="button" className="primary" disabled={busy} onClick={() => onUse ? onUse(coupon.code) : onStart?.()}>{onUse ? 'Use my free-test coupon' : 'Start my free test'} ↗</button></> : <><p className="fine">One per account. Claim window ends {trial.data?.ends_at ? new Date(trial.data.ends_at).toLocaleString() : 'when places are taken'}. You have seven days to use it.</p><button type="button" className="primary" disabled={busy} onClick={() => void claim()}>{busy ? 'Reserving your coupon…' : 'Request my free test'}</button></>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </aside>;
}

type Campaign = { ends_at: string; stopped_at: string | null; claim_limit: number; claimed: number };
type Desk = { campaign: Campaign | null; total_claimed: number; reserved: number; started: number };
export function TrialDesk({ csrf }: { csrf: string }) {
  const data = useLive<Desk>('/admin/trial', true, 30_000);
  const [hours, setHours] = useState(24), [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = data.data?.campaign && !data.data.campaign.stopped_at && Date.parse(data.data.campaign.ends_at) > Date.now();
  async function configure(action: 'start' | 'stop') {
    setBusy(true); setError('');
    try { await write('/admin/trial', csrf, action === 'start' ? { action, hours, claim_limit: limit } : { action }); data.refresh(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel trial-admin"><p className="section-kicker">FREE-TEST CAMPAIGN</p><h2>Let people try their own website.</h2><p>Accounts must request a coupon. Each account gets at most one trial, across all campaigns. Claimed coupons last seven days. Starting a campaign does not run tests.</p>
    <div className="workspace-metrics"><div><strong>{data.data?.total_claimed ?? '—'}</strong><span>Trials claimed</span></div><div><strong>{data.data?.reserved ?? '—'}</strong><span>Coupons reserved</span></div><div><strong>{data.data?.started ?? '—'}</strong><span>Assessments started</span></div></div>
    {active ? <div><p>{data.data!.campaign!.claimed} / {data.data!.campaign!.claim_limit} places claimed. Ends {new Date(data.data!.campaign!.ends_at).toLocaleString()}.</p><button disabled={busy} onClick={() => void configure('stop')}>Stop new claims</button><p className="fine">Already issued coupons remain valid.</p></div> : <form className="trial-settings" onSubmit={e => { e.preventDefault(); void configure('start'); }}><label>Claim window<select value={hours} onChange={e => setHours(Number(e.target.value))}><option value={24}>24 hours</option><option value={48}>48 hours</option></select></label><label>Maximum free assessments<input type="number" required min={1} max={10000} value={limit} onChange={e => setLimit(Number(e.target.value))} /></label><button className="primary" disabled={busy || !data.data || !!data.error}>{busy ? 'Saving…' : 'Open free-test campaign'}</button></form>}
    <p className="fine">This limits sponsorship by account, not by human. Wallets and separate sign-ins can create separate accounts. Keep the total allowance within your testing budget.</p>
    {(error || data.error) && <p className="notice error" role="alert">{error || data.error}<button className="inline" onClick={data.refresh}>Refresh</button></p>}
  </section>;
}
