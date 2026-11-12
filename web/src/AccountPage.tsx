import { CouponBalance } from './Coupons';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, Plus, ShieldCheck, UserRound, Wallet } from 'lucide-react';
import { write, type Account } from './api';
import { useLive } from './useLive';
import { checkedDeposit, DepositInstructions, PaymentFields, type CheckoutOffer, type Deposit } from './Checkout';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import './account.css';

export type CreditPurchase = { id: string; pentest_id: string; product: string; amount_cents: number; state: string; review_id: string | null; created_at: string; last_error: string | null; cancel_requested_at?: string | null };
type Topup = { id: string; amount_cents: number; state: string; expires_at: string; created_at: string };
type Entry = { id: string; kind: string; amount_cents: number; created_at: string; purchase_id: string | null; topup_id: string | null };
export type Credits = { available_cents: number; topups: Topup[]; purchases: CreditPurchase[]; history: Entry[]; topup_offer: CheckoutOffer | null; minimum_topup_cents: number; maximum_topup_cents: number; prices: { black: number; grey: number; white: number }; white_available: boolean };
export const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const stateLabel = (state: string) => ({ reserved: 'Starting', admitted: 'Starting', funding: 'Starting', activated: 'Test started', completed: 'Completed', released: 'Credit returned', needs_review: 'Payment review', settled: 'Added to balance', pending: 'Waiting for transfer', processing: 'Confirming transfer', preparing: 'Preparing transfer', held: 'Payment review', expired: 'Expired', refunded: 'Swap refunded', incomplete: 'Deposit incomplete', failed: 'Transfer failed' } as Record<string, string>)[state] ?? state;

export function AccountPage({ account, csrf, returnTo, onReturn, onReview }: { account: Account; csrf: string; returnTo?: string | null; onReturn: (id: string) => void; onReview: (id: string) => void }) {
  const credits = useLive<Credits>('/credits', true, 10_000);
  const [adding, setAdding] = useState(false);
  const [quote, setQuote] = useState<Deposit | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const data = credits.data;
  const [cancelling,setCancelling]=useState<string|null>(null);
  async function cancel(p:CreditPurchase) {
    if(!window.confirm('Request cancellation? If work already started, credit is held for payment review.'))return;
    setCancelling(p.id);setError('');
    try {await write(`/credits/purchases/${p.id}/cancel`,csrf,{});}catch(e){setError((e as Error).message);}finally{setCancelling(null);credits.refresh();}
  }
  async function resume(id: string) {
    setResuming(id); setError('');
    try { const q = checkedDeposit(await write<Deposit>(`/credits/topups/${id}/quote`, csrf, {})); if (q.order_id !== id || q.payment_kind !== 'topup') throw new Error('These payment details do not match the top-up.'); setQuote(q); setAdding(true); }
    catch (e) { setError((e as Error).message); } finally { setResuming(null); credits.refresh(); }
  }
  const reserved = data?.purchases.filter(p => ['reserved', 'admitted', 'funding'].includes(p.state)).reduce((n, p) => n + p.amount_cents, 0) ?? 0;
  return <section className="account-page">
    <header className="account-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>Your account.</h1><p>Ready when your next release is.</p></div>{returnTo && <Button variant="outline" onClick={() => onReturn(returnTo)}>Back to your test <ArrowUpRight size={16}/></Button>}</header>
    {credits.error && <p role="alert" className="notice error">{credits.error} <Button variant="ghost" onClick={credits.refresh}>Retry</Button></p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="account-summary">
      <Card className="balance-card"><CardHeader><span className="balance-label"><Wallet size={18}/> Available credit</span></CardHeader><CardContent><div className="balance-amount">{data ? dollars(data.available_cents) : '—'}</div><CouponBalance csrf={csrf}/><p>{reserved > 0 ? `${dollars(reserved)} reserved while your test starts.` : 'One balance. Use it whenever you need a test.'}</p><Button disabled={!data?.topup_offer} onClick={() => { setQuote(null); setAdding(true); }}><Plus size={18}/> Add credit</Button><small>Crypto via NEAR Intents. Card payments are coming later.</small></CardContent></Card>
      <Card className="identity-card"><CardHeader><div className="account-avatar"><UserRound size={24}/></div><CardTitle>{account.display_name}</CardTitle><CardDescription>{account.role === 'admin' ? 'Administrator' : 'Personal workspace'}</CardDescription></CardHeader><CardContent><p><ShieldCheck size={17}/> Your tests and reports are private.</p><small>Use the same sign-in method each time. Wallet, Google and password accounts have separate balances.</small></CardContent></Card>
    </div>
    <div className="account-prices" aria-label="Assessment prices">{([['black', 'Black box', 'Public pages, APIs and exposed configuration.', 'blackbox'], ['grey', 'Grey box', 'Public checks plus access with a test account.', 'greybox'], ['white', 'White box', 'Source code and running application. Coming later.', 'whitebox']] as const).map(([key, name, description, art]) => <article key={key}><img src={`/brand/product-${art}.jpg`} alt="" width="960" height="640" loading="lazy"/><div><h2>{name}</h2><strong>{data ? dollars(data.prices[key]) : '—'}{key === 'white' && <small>Roadmap</small>}</strong><p>{description}</p></div></article>)}</div>
    <Card className="account-activity"><CardHeader><CardTitle>Activity</CardTitle><CardDescription>Top-ups, assessment charges and returned reservations.</CardDescription></CardHeader><CardContent>
      <Tabs defaultValue="balance"><TabsList><TabsTrigger value="balance">Balance</TabsTrigger><TabsTrigger value="topups">Top-ups</TabsTrigger><TabsTrigger value="tests">Paid tests</TabsTrigger></TabsList>
        <TabsContent value="balance">{data?.history.length ? <div className="account-ledger">{data.history.map(e => <div className="account-entry" key={e.id}><span className={`entry-icon ${e.amount_cents > 0 ? 'positive' : ''}`}>{e.amount_cents > 0 ? <ArrowDownLeft size={18}/> : <ArrowUpRight size={18}/>}</span><div><strong>{e.kind === 'topup' ? 'Credit added' : e.kind === 'release' ? 'Reservation returned' : 'Assessment reserved'}</strong><small>{date(e.created_at)}</small></div><b className={e.amount_cents > 0 ? 'positive' : ''}>{e.amount_cents > 0 ? '+' : '−'}{dollars(Math.abs(e.amount_cents))}</b></div>)}</div> : <div className="account-empty"><Wallet size={25}/><p>Your balance activity will appear here.</p></div>}</TabsContent>
        <TabsContent value="topups">{data?.topups.length ? data.topups.map(t => <div className="account-entry" key={t.id}><span className="entry-icon"><Plus size={18}/></span><div><strong>{dollars(t.amount_cents)} top-up</strong><small>{date(t.created_at)} · {stateLabel(t.state)}</small></div>{['pending', 'preparing'].includes(t.state) && Date.parse(t.expires_at) > Date.now() && <Button variant="outline" size="sm" disabled={resuming === t.id} onClick={() => void resume(t.id)}>Payment details</Button>}</div>) : <div className="account-empty"><p>No top-ups yet.</p></div>}</TabsContent>
        <TabsContent value="tests">{data?.purchases.length ? data.purchases.map(p => <div className="account-entry" key={p.id}><span className="entry-icon"><ShieldCheck size={18}/></span><div><strong>{p.product === 'grey' ? 'Test-account assessment' : 'Website assessment'}</strong><small>{date(p.created_at)} · {p.cancel_requested_at && ['reserved','admitted','funding','activated'].includes(p.state) ? 'Cancellation requested' : stateLabel(p.state)}</small></div><b>{dollars(p.amount_cents)}</b>{['reserved','admitted','funding','activated'].includes(p.state) && <Button size="sm" variant="ghost" disabled={Boolean(p.cancel_requested_at)||cancelling===p.id} onClick={()=>void cancel(p)}>Cancel test</Button>}{p.review_id && <Button size="sm" variant="outline" onClick={() => onReview(p.review_id!)}>Open test</Button>}</div>) : <div className="account-empty"><p>Tests paid with credit will appear here. Coupons are listed in Orders.</p></div>}</TabsContent>
      </Tabs>
    </CardContent></Card>
    <p className="account-footnote">Credits are for Patchriot assessments. A reservation returns if the test cannot start. Once work starts, cancellation does not automatically return it. A coupon covers one test without spending your balance.</p>
    {adding && data?.topup_offer && <TopupDialog csrf={csrf} offer={data.topup_offer} minimum={data.minimum_topup_cents ?? 100} maximum={Math.min(500, data.maximum_topup_cents ?? 500)} initialQuote={quote} topups={data.topups} onClose={() => { setAdding(false); setQuote(null); credits.refresh(); }} onChange={credits.refresh}/>}
  </section>;
}

function TopupDialog({ csrf, offer, minimum, maximum, initialQuote, topups, onClose, onChange }: { csrf: string; offer: CheckoutOffer; minimum: number; maximum: number; initialQuote: Deposit | null; topups: Topup[]; onClose: () => void; onChange: () => void }) {
  const [amount, setAmount] = useState('5');
  const [asset, setAsset] = useState(''); const [refund, setRefund] = useState('');
  const [quote, setQuote] = useState(initialQuote); const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const request = useRef(crypto.randomUUID());
  const cents = /^\d{1,4}(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const valid = cents >= minimum && cents <= maximum;
  const status = topups.find(t => t.id === quote?.order_id)?.state;
  const settled = status === 'settled';
  useEffect(() => { if (settled) onChange(); }, [settled, onChange]);
  function edit(fn: () => void) { fn(); request.current = crypto.randomUUID(); setError(''); }
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!valid || busy) return; setBusy(true); setError('');
    try {
      const saved = checkedDeposit(await write<Deposit>('/credits/topups', csrf, { request_id: request.current, amount_cents: cents, offer_id: offer.id, origin_asset: asset, refund_address: refund.trim() }));
      if (saved.payment_kind !== 'topup' || saved.request_id !== request.current || saved.amount_cents !== cents || saved.output.amount !== (BigInt(cents) * 10000n).toString() || saved.output.token.asset_id !== offer.destination.asset_id || saved.input.token.asset_id !== asset || saved.refund_address !== refund.trim()) throw new Error('The payment details do not match your top-up. Check Activity before trying again.');
      setQuote(saved); onChange();
    } catch (e) { setError((e as Error).message); onChange(); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="topup-dialog"><DialogTitle>{settled ? 'Credit added' : quote ? 'Complete your top-up' : 'Add credit'}</DialogTitle><DialogDescription>{settled ? `${dollars(quote!.amount_cents!)} is ready to use.` : quote ? 'An exact-amount top-up. Use the token amount in your payment instructions.' : 'Choose how much credit to add. We’ll then quote the exact token amount to send, including conversion costs.'}</DialogDescription>
    {settled ? <div className="topup-complete"><Check size={40}/><Button onClick={onClose}>Done</Button></div> : quote ? <><div className="topup-credit-summary">Adds <strong>{dollars(quote.amount_cents!)}</strong> to your account</div>{sent || (status && !['pending', 'preparing'].includes(status)) ? <div className="topup-pending"><span className="status-orbit" aria-hidden="true"/><p role="status">{status ? stateLabel(status) : 'Waiting for confirmation'}</p><p>You can close this panel. Your balance updates after confirmation.</p>{(!status || ['pending','preparing'].includes(status)) && <Button variant="outline" onClick={() => setSent(false)}>Show payment details</Button>}</div> : <DepositInstructions quote={quote} onSent={() => { setSent(true); onChange(); }}/>}</> : <form onSubmit={submit}><fieldset disabled={busy}><div className="topup-presets" aria-label="Top-up amount">{[1, 2.5, 5].filter(n => n * 100 >= minimum && n * 100 <= maximum).map(n => <Button key={n} variant={amount === String(n) ? 'default' : 'outline'} type="button" aria-pressed={amount === String(n)} onClick={() => edit(() => setAmount(String(n)))}>${n}</Button>)}</div><label>Or choose a credit amount in USD<Input type="text" inputMode="decimal" value={amount} onChange={e => edit(() => setAmount(e.target.value))} aria-describedby="topup-limits" required/><small id="topup-limits">{dollars(minimum)}–{dollars(maximum)} per top-up during the pilot. You can top up again.</small></label><PaymentFields compact credit offer={offer} asset={asset} refund={refund} onAsset={v => edit(() => { setAsset(v); setRefund(''); })} onRefund={v => edit(() => setRefund(v))} label="Account credit"/><Button className="full" disabled={!valid || !asset || !refund.trim() || busy}>{busy ? 'Preparing transfer…' : `Continue · ${dollars(valid ? cents : 0)}`}</Button></fieldset></form>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </DialogContent></Dialog>;
}
