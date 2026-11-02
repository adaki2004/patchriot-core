import { useState } from 'react';
import type { FormEvent } from 'react';
import { write } from './api';
import { useLive } from './useLive';

type Destination = { asset_id: string; symbol: string; blockchain: 'eth' | 'sol' };
type Claim = { id: string; amount: string; destination_asset: string; recipient: string; state: string; expires_at: string; expected_amount: string | null; minimum_amount: string | null; last_error: string | null };
type Withdrawals = { enabled: boolean; minimum_claim: string; balance: { earned: string; available: string; reserved: string; paid: string }; destinations: Destination[]; claims: Claim[]; receipts: { claim_id: string; amount: string; source_transaction: string; destination_transactions: { hash: string }[] }[] };
type Work = { invoice_id: string; role: string; device_id: string; amount: string; reported_duration_ms: number; reported_model: string; created_at: string };

export function money(value: string) {
  const amount = BigInt(value), fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
function units(value: string) {
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(value)) throw new Error('Use an amount with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}
const network = (d?: Destination) => d?.blockchain === 'eth' ? 'Ethereum' : 'Solana';
const label = (value: string) => value.replaceAll('_', ' ');

export function Earnings({ csrf }: { csrf: string }) {
  const records = useLive<{ work: Work[] }>('/earnings');
  const withdrawals = useLive<Withdrawals>('/withdrawals');
  const data = withdrawals.error ? undefined : withdrawals.data;
  const [amount, setAmount] = useState('10');
  const [destination, setDestination] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const current = data?.claims.find(c => !['paid', 'cancelled'].includes(c.state));
  const chosen = data?.destinations.find(d => d.asset_id === destination) ?? data?.destinations[0];
  const refresh = () => { records.refresh(); withdrawals.refresh(); };
  async function prepare(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await write('/withdrawals', csrf, { id: requestId, amount: units(amount), destination_asset: chosen?.asset_id, recipient: recipient.trim() });
      setRequestId(crypto.randomUUID());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); withdrawals.refresh(); }
  }
  async function action(id: string, action: 'confirm' | 'cancel') {
    setBusy(true); setError('');
    try { await write(`/withdrawals/${id}/${action}`, csrf, {}); setChecked(null); setRequestId(crypto.randomUUID()); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); withdrawals.refresh(); }
  }
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">YOUR CONTRIBUTION</p><h1 className="page-title">Earnings</h1><p className="subtle">90% of each completed paid review goes to its three roles. Patchriot keeps 10%.</p></div><button className="quiet" onClick={refresh}>Refresh earnings</button></section>
    <p>Each role receives an equal share. An operator handling several roles receives their combined share. Coupon reviews do not create paid earnings.</p>
    {(error || withdrawals.error || records.error) && <p className="notice error" role="alert">{error || withdrawals.error || records.error}</p>}
    {!data && !withdrawals.error && <p role="status">Loading earnings…</p>}
    {data && <>
      <section className="panel earnings-balances" aria-label="Your balance"><dl><dt>Available</dt><dd><strong>{money(data.balance.available)} USDC</strong></dd><dt>Reserved for withdrawal</dt><dd>{money(data.balance.reserved)} USDC</dd><dt>Already paid · before conversion fees</dt><dd>{money(data.balance.paid)} USDC</dd><dt>Total earned</dt><dd>{money(data.balance.earned)} USDC</dd></dl></section>
      <section className="panel earnings-claim" aria-label="Withdraw earnings"><h2>Withdraw earnings</h2><p>Minimum {money(data.minimum_claim)} USDC. Choose USDC or USDT on Ethereum or Solana. The quote includes conversion and delivery fees, deducted from your withdrawal.</p>
        {!data.enabled && <p className="notice">Withdrawals are not enabled on this installation. Your earnings remain recorded.</p>}
        {current ? <div>
          <dl><dt>Status</dt><dd>{label(current.state)}</dd><dt>From your balance</dt><dd>{money(current.amount)} USDC</dd><dt>Receive on</dt><dd>{network(data.destinations.find(d => d.asset_id === current.destination_asset))}</dd><dt>Wallet address</dt><dd><code className="wallet-address">{current.recipient}</code></dd>{current.expected_amount && <><dt>Expected receipt</dt><dd>{money(current.expected_amount)} {data.destinations.find(d => d.asset_id === current.destination_asset)?.symbol}</dd><dt>Minimum receipt</dt><dd>{money(current.minimum_amount!)}</dd></>}</dl>
          {current.last_error && <p className="notice">{label(current.last_error)}. The reserved amount cannot be spent twice.</p>}
          {current.state === 'quoted' && <><p>Confirm before {new Date(current.expires_at).toLocaleTimeString()}. Check the network and address carefully.</p><label className="check"><input type="checkbox" checked={checked === current.id} onChange={e => setChecked(e.target.checked ? current.id : null)} /><span>I checked the receiving network, wallet address and quoted amount.</span></label><button className="primary" disabled={busy || checked !== current.id || Date.parse(current.expires_at) <= Date.now()} onClick={() => void action(current.id, 'confirm')}>Confirm withdrawal</button></>}
          {['preparing', 'quoted', 'queued'].includes(current.state) && <button className="quiet" disabled={busy} onClick={() => void action(current.id, 'cancel')}>Cancel unsigned withdrawal</button>}
          {current.state === 'signed' && <p>Payment is being checked. Keep this request; do not start another transfer.</p>}
          {current.state === 'needs_review' && <p>An administrator must check the saved transaction. Your reservation remains in place until the outcome is known.</p>}
        </div> : <form onSubmit={prepare}>
          <label>Amount from balance · USDC<input value={amount} onChange={e => { setAmount(e.target.value); setRequestId(crypto.randomUUID()); }} inputMode="decimal" required disabled={busy} /></label>
          <label htmlFor="withdrawal-destination">Receive as</label><select id="withdrawal-destination" value={chosen?.asset_id ?? ''} onChange={e => { setDestination(e.target.value); setRecipient(''); setRequestId(crypto.randomUUID()); }} disabled={busy}>{data.destinations.map(d => <option key={d.asset_id} value={d.asset_id}>{d.symbol} on {network(d)}</option>)}</select>
          <label>Receiving wallet on {network(chosen)}<input value={recipient} onChange={e => { setRecipient(e.target.value); setRequestId(crypto.randomUUID()); }} autoComplete="off" spellCheck={false} maxLength={64} required disabled={busy} /></label>
          <p className="fine">Use a wallet you control on the selected network. On Solana, enter the wallet address, not a token account.</p>
          <button className="primary" disabled={busy || !data.enabled || BigInt(data.balance.available) < BigInt(data.minimum_claim)}>{busy ? 'Preparing…' : 'Get withdrawal quote'}</button>
          {BigInt(data.balance.available) < BigInt(data.minimum_claim) && <p className="fine">The balance has not reached the withdrawal minimum.</p>}
        </form>}
      </section>
      {data.claims.length > 0 && <section className="panel earnings-history" aria-label="Withdrawal history"><h2>Withdrawal history</h2>{data.claims.map(c => <details key={c.id}><summary>{money(c.amount)} USDC · {label(c.state)}</summary><p><code className="wallet-address">{c.recipient}</code></p><p>{data.destinations.find(d => d.asset_id === c.destination_asset)?.symbol} on {network(data.destinations.find(d => d.asset_id === c.destination_asset))}</p>{data.receipts.filter(r => r.claim_id === c.id).map(r => <div key={r.claim_id}><p>Received: {money(r.amount)} {data.destinations.find(d => d.asset_id === c.destination_asset)?.symbol}</p>{r.destination_transactions.map(t => <p key={t.hash}><code className="wallet-address">{t.hash}</code></p>)}</div>)}</details>)}</section>}
    </>}
    <section className="panel earnings-work" aria-label="Paid work history"><h2>Paid work</h2><p className="fine">Duration and model are reported by the operator. They do not change the payment or prove a finding correct.</p>{!records.error && records.data?.work.length === 0 && <p>No paid work has been allocated yet.</p>}{!records.error && records.data?.work.map(w => <div className="earning-row" key={`${w.invoice_id}/${w.role}`}><strong>{label(w.role)} · {money(w.amount)} USDC</strong><span>{w.reported_model} · {Math.round(w.reported_duration_ms / 1000)} seconds</span><small>{new Date(w.created_at).toLocaleString()} · device {w.device_id.slice(0, 8)}</small></div>)}</section>
  </>;
}

type Treasury = { liabilities: string; platform_revenue: string; observation: null | { balance: string; liabilities: string; buffer: string; sufficient: boolean; observed_at: string }; claims: { id: string; operator: string; amount: string; recipient: string; state: string; last_error: string | null }[]; work: (Work & { operator: string })[] };
export function TreasuryDesk() {
  const records = useLive<Treasury>('/admin/treasury');
  const data = records.error ? undefined : records.data;
  return <section className="panel treasury-desk" aria-label="Treasury accounting"><div className="table-toolbar"><h2>Treasury accounting</h2><button className="quiet" onClick={records.refresh}>Refresh accounting</button></div>{records.error && <p className="notice error" role="alert">{records.error}</p>}{data && <>
    <dl><dt>Customer and operator balances still owed</dt><dd>{money(data.liabilities)} USDC</dd><dt>Platform share earned · before expenses</dt><dd>{money(data.platform_revenue)} USDC</dd></dl>
    {data.observation ? <p>Last signing check: {new Date(data.observation.observed_at).toLocaleString()}. Treasury {money(data.observation.balance)} USDC; balances owed then {money(data.observation.liabilities)} USDC; required buffer {money(data.observation.buffer)} USDC. {data.observation.sufficient ? 'Covered at that check.' : 'Transfer blocked: insufficient coverage.'}</p> : <p>No on-chain signing check recorded yet.</p>}
    <p className="fine">Every new payment checks treasury coverage again. This saved observation is not a live balance. Do not spend treasury backing outside the payout process.</p>
    {data.claims.map(c => <details key={c.id}><summary>{c.operator} · {money(c.amount)} USDC · {label(c.state)}</summary><p><code className="wallet-address">{c.recipient}</code></p>{c.last_error && <p>{label(c.last_error)}</p>}</details>)}
    <h3>Recent operator earnings</h3><p className="fine">Newest 100 role payments. Reported model and time describe work; they do not set its price.</p>{data.work.length === 0 && <p>No operator earnings allocated yet.</p>}{data.work.map(w => <div className="earning-row" key={`${w.invoice_id}/${w.role}`}><strong>{w.operator} · {money(w.amount)} USDC</strong><span>{label(w.role)} · {w.reported_model} · {Math.round(w.reported_duration_ms / 1000)} seconds</span></div>)}
  </>}</section>;
}
