import { useEffect, useRef, useState } from 'react';
import { write } from './api';
import { useLive } from './useLive';
import { ReviewDetail } from './Reviews';
import { DepositInstructions, checkedDeposit, useNow } from './Checkout';
import type { CheckoutSettings, Deposit } from './Checkout';

export type Order = {
  id: string; review_id: string | null; state: string;
  price: { asset: string; amount: string }; created_at: string; expires_at: string;
  payment: { state: string; received_amount: string | null; deadline: string } | null;
  cancellation: { requested_at: string; confirmed_at: string | null; review_state: string | null } | null;
  requires_attention: boolean; can_cancel: boolean;
};

export function orderLabel(order: Order) {
  if (order.cancellation) {
    if (!order.cancellation.confirmed_at) return 'Cancellation requested';
    return ({ cancelled: 'Work stopped', failed: 'Work ended incomplete', completed: 'Work already finished', needs_review: 'Review ended; inspect report' } as Record<string, string>)[order.cancellation.review_state ?? ''] ?? 'Needs attention';
  }
  if (order.requires_attention) return 'Needs attention';
  if (['preparing', 'awaiting_payment'].includes(order.state) && Date.parse(order.expires_at) <= Date.now()) return 'Payment window ended';
  return ({ preparing: 'Preparing order', awaiting_payment: 'Waiting for payment', activated: 'Work activated', cancelled: 'Order closed', expired: 'Payment window ended', needs_review: 'Needs attention' } as Record<string, string>)[order.state] ?? 'Needs attention';
}

export function paymentLabel(order: Order) {
  if (!order.payment) return 'No invoice yet';
  return ({ pending: 'No payment confirmed', processing: 'Transfer being processed', incomplete: 'Transfer incomplete', expired: 'Payment window ended', failed: 'Transfer failed', refunded: 'Provider reports refund', settled: 'Funds recorded', held: 'Funds held for review', needs_review: 'Payment needs review' } as Record<string, string>)[order.payment.state] ?? 'Payment needs review';
}

function OrderDetail({ id, csrf, initialQuote, paymentEnabled, report, onReport, onClose, onChange }: { id: string; csrf: string; initialQuote?: Deposit | null; paymentEnabled: boolean; report: boolean; onReport: (open: boolean) => void; onClose: () => void; onChange: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const detail = useLive<Order>(`/orders/${id}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [quote, setQuote] = useState<Deposit | null>(initialQuote ?? null);
  const [sent, setSent] = useState(false);
  const now = useNow();
  const order = detail.data;
  const canPay = paymentEnabled && order && !requested && !sent && !order.cancellation && !order.requires_attention && !detail.error && !error && !busy
    && ['preparing', 'awaiting_payment'].includes(order.state) && (!order.payment || order.payment.state === 'pending')
    && Date.parse(order.expires_at) > now && (!order.payment || Date.parse(order.payment.deadline) > now);
  const currentQuote = canPay && quote && quote.order_id === id && quote.review_id === order.review_id
    && quote.output.token.asset_id === order.price.asset && quote.output.amount === order.price.amount && Date.parse(quote.expires_at) > now ? quote : null;
  useEffect(() => { if (!report) { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start' }); } }, [report]);
  useEffect(() => { if (order) onChange(); }, [order?.state, order?.payment?.state, order?.cancellation?.confirmed_at, order?.requires_attention, onChange]);
  async function cancel() {
    if (!window.confirm('Request cancellation? This closes checkout and asks the agents to stop. Work already done and transfers already sent cannot be undone. This does not issue a refund.')) return;
    setBusy(true); setError(''); setQuote(null);
    try {
      await write(`/orders/${id}/cancel`, csrf, {});
      setRequested(true); detail.refresh(); onChange();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function resume() {
    setBusy(true); setError(''); setQuote(null);
    try {
      const value = checkedDeposit(await write<Deposit>(`/orders/${id}/quote`, csrf, {}));
      if (value.order_id !== id) throw new Error('The quote does not match this order. Do not send a transfer.');
      setQuote(value); detail.refresh();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <>
    <section ref={panel} tabIndex={-1} className="review-detail panel order-detail" aria-label="Order details">
      <div className="section-heading"><div><p className="eyebrow">PAYMENT & WORK / PRIVATE</p><h2>{requested && !order?.cancellation ? 'Cancellation requested' : order ? orderLabel(order) : detail.error ? 'Order unavailable' : 'Loading order…'}</h2><p className="fine">{id}</p></div><button className="quiet" onClick={onClose}>Close order ×</button></div>
      {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error}{order && <><br />The last saved status is shown; it may be out of date. Refresh before taking another action.</>} {detail.error && <button className="inline" onClick={() => { setError(''); detail.refresh(); }}>Retry order</button>}</div>}
      {order && <>
        <div className="order-facts"><div><span>Payment</span><strong>{paymentLabel(order)}</strong></div><div><span>Created</span><strong>{new Date(order.created_at).toLocaleString()}</strong></div></div>
        {(requested || order.cancellation) && <div className="notice" role="status">{order.cancellation?.confirmed_at ? order.cancellation.review_state === 'cancelled' ? 'The review has stopped. Cancellation does not return funds.' : 'The review had already ended when cancellation was checked. Its actual result is preserved.' : 'Your cancellation is saved. Confirmation that the review stopped is still pending.'} Do not send another payment.</div>}
        {order.requires_attention && <div className="notice error" role="status">This order needs a manual check. Any recorded funds remain recorded; no refund is issued by cancelling work.</div>}
        {!order.cancellation && !requested && <p className="fine">{order.state === 'activated' ? 'Payment authorized this review to start. Open the report for its current progress and result.' : 'Only use current payment instructions. A saved or expired order is not permission to send a new transfer.'}</p>}
        {sent && order.payment && ['pending', 'processing'].includes(order.payment.state) && <p className="notice" role="status">Waiting for confirmation. Your click does not confirm payment; the server checks settlement. Do not send another transfer.</p>}
        {currentQuote && <DepositInstructions key={currentQuote.invoice_id} quote={currentQuote} onSent={() => { setSent(true); setQuote(null); detail.refresh(); }} />}
        {!currentQuote && quote && <p className="fine">Payment instructions are hidden. Do not use a previous address or quote.</p>}
        <div className="review-actions">
          <button className="quiet" onClick={() => { setError(''); detail.refresh(); }}>Refresh order ↻</button>
          {canPay && !currentQuote && <button className="primary" onClick={() => void resume()}>{order.state === 'preparing' ? 'Resume checkout →' : 'Show current payment instructions →'}</button>}
          {order.review_id && <button className="text-button" onClick={() => onReport(true)}>Open review report →</button>}
          {order.can_cancel && !requested && <button className="quiet" onClick={() => void cancel()} disabled={busy || !!detail.error}>{busy ? 'Saving request…' : 'Request cancellation'}</button>}
        </div>
        <details className="execution-details"><summary>Payment record</summary><dl>
          <dt>Quoted asset</dt><dd><code>{order.price.asset}</code></dd>
          <dt>Quoted amount · smallest units</dt><dd><code>{order.price.amount}</code></dd>
          <dt>Received amount · same asset, smallest units</dt><dd><code>{order.payment?.received_amount ?? 'Not recorded'}</code></dd>
          <dt>Order payment deadline</dt><dd>{new Date(order.expires_at).toLocaleString()}</dd>
        </dl><p className="fine">Amounts are exact token units, not dollar balances. Funds received, work completed and a refund are separate records.</p></details>
        {detail.updated && <p className="fine">Last checked {detail.updated.toLocaleTimeString()}</p>}
      </>}
    </section>
    {report && order?.review_id && <ReviewDetail key={order.review_id} id={order.review_id} csrf={csrf} onClose={() => onReport(false)} onChange={detail.refresh} onOpenOrders={() => { onReport(false); panel.current?.focus(); }} />}
  </>;
}

export function Orders({ csrf, selected, onSelect, report, onReport, initialQuote, onClearQuote }: { csrf: string; selected: string | null; onSelect: (id: string | null) => void; report: boolean; onReport: (open: boolean) => void; initialQuote?: Deposit | null; onClearQuote: () => void }) {
  const orders = useLive<Order[]>('/orders');
  const checkout = useLive<CheckoutSettings>('/checkout');
  // The fresh response is consumed once. Returning to Orders must recheck the
  // saved quote explicitly, especially after the customer says they sent it.
  useEffect(() => { if (initialQuote) onClearQuote(); }, [initialQuote, onClearQuote]);
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Your orders</h1><p className="subtle">Track payment and work separately. A received payment is not a completed review.</p></div><button className="quiet" onClick={orders.refresh}>Refresh orders ↻</button></section>
    {orders.error && <div className="notice error" role="alert">{orders.error}<br />The last saved list remains visible; it may be out of date.</div>}
    {checkout.error && <div className="notice error" role="alert">Payment instructions are unavailable. Your saved order records remain visible.</div>}
    {checkout.data?.mode === 'closed' && <p className="notice">New payments are paused. Do not send a transfer using an earlier quote.</p>}
    {selected && <OrderDetail key={selected} id={selected} csrf={csrf} initialQuote={initialQuote?.order_id === selected ? initialQuote : null} paymentEnabled={checkout.data?.mode === 'paid' && !checkout.error} report={report} onReport={onReport} onClose={() => { onSelect(null); onClearQuote(); }} onChange={orders.refresh} />}
    <section className="panel" aria-label="Order history">
      {orders.data === null && <div className="empty"><p>{orders.error ? 'Order history could not be loaded.' : 'Loading orders…'}</p></div>}
      {orders.data?.length === 0 && <div className="empty"><h2>No paid orders yet.</h2><p>{checkout.data?.mode === 'pilot' ? 'The current pilot reviews are free. Paid checkout is not enabled.' : checkout.data?.mode === 'coupons' ? 'Reviews covered by a code appear under Reviews. They do not create a paid order.' : 'Website review orders will appear here after checkout is prepared.'}</p></div>}
      {orders.data?.map(order => <button key={order.id} className={`review-item ${selected === order.id ? 'selected' : ''}`} onClick={() => onSelect(order.id)}><span><strong>Audit · {order.id.slice(0, 8)}</strong><small>{new Date(order.created_at).toLocaleString()} · {paymentLabel(order)}</small></span><span className={`badge ${order.requires_attention ? 'revoked' : 'pending'}`}>{orderLabel(order)}</span></button>)}
    </section>
    {orders.data?.length === 50 && <p className="fine">Showing your 50 most recent orders.</p>}
  </>;
}
