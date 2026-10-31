import { useEffect, useRef, useState } from 'react';
import { write } from './api';
import { useLive } from './useLive';
import { ReviewDetail } from './Reviews';

type Order = {
  id: string; review_id: string | null; state: string;
  price: { asset: string; amount: string }; created_at: string; expires_at: string;
  payment: { state: string; received_amount: string | null; deadline: string } | null;
  cancellation: { requested_at: string; confirmed_at: string | null; review_state: string | null } | null;
  requires_attention: boolean; can_cancel: boolean;
};

function orderLabel(order: Order) {
  if (order.cancellation) {
    if (!order.cancellation.confirmed_at) return 'Cancellation requested';
    return ({ cancelled: 'Work stopped', failed: 'Work ended incomplete', completed: 'Work already finished', needs_review: 'Review ended; inspect report' } as Record<string, string>)[order.cancellation.review_state ?? ''] ?? 'Needs attention';
  }
  if (order.requires_attention) return 'Needs attention';
  if (['preparing', 'awaiting_payment'].includes(order.state) && Date.parse(order.expires_at) <= Date.now()) return 'Payment window ended';
  return ({ preparing: 'Preparing order', awaiting_payment: 'Waiting for payment', activated: 'Work activated', cancelled: 'Order closed', expired: 'Payment window ended', needs_review: 'Needs attention' } as Record<string, string>)[order.state] ?? 'Needs attention';
}

function paymentLabel(order: Order) {
  if (!order.payment) return 'No invoice yet';
  return ({ pending: 'No payment confirmed', processing: 'Transfer being processed', incomplete: 'Transfer incomplete', expired: 'Payment window ended', failed: 'Transfer failed', refunded: 'Provider reports refund', settled: 'Funds recorded', held: 'Funds held for review', needs_review: 'Payment needs review' } as Record<string, string>)[order.payment.state] ?? 'Payment needs review';
}

function OrderDetail({ id, csrf, onClose, onChange }: { id: string; csrf: string; onClose: () => void; onChange: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const detail = useLive<Order>(`/orders/${id}`);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [report, setReport] = useState(false);
  const order = detail.data;
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start' }); }, []);
  useEffect(() => { if (order) onChange(); }, [order?.state, order?.payment?.state, order?.cancellation?.confirmed_at, order?.requires_attention, onChange]);
  async function cancel() {
    if (!window.confirm('Request cancellation? This closes checkout and asks the agents to stop. Work already done and transfers already sent cannot be undone. This does not issue a refund.')) return;
    setBusy(true); setError('');
    try {
      await write(`/orders/${id}/cancel`, csrf, {});
      setRequested(true); detail.refresh(); onChange();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <>
    <section ref={panel} tabIndex={-1} className="review-detail panel order-detail" aria-label="Order details">
      <div className="section-heading"><div><p className="eyebrow">PAYMENT & WORK / PRIVATE</p><h2>{requested && !order?.cancellation ? 'Cancellation requested' : order ? orderLabel(order) : 'Loading order…'}</h2><p className="fine">{id}</p></div><button className="quiet" onClick={onClose}>Close order ×</button></div>
      {(detail.error || error) && <div className="notice error" role="alert">{detail.error || error}<br />The last saved status is shown; it may be out of date. Refresh before taking another action.</div>}
      {order && <>
        <div className="order-facts"><div><span>Payment</span><strong>{paymentLabel(order)}</strong></div><div><span>Created</span><strong>{new Date(order.created_at).toLocaleString()}</strong></div></div>
        {(requested || order.cancellation) && <div className="notice" role="status">{order.cancellation?.confirmed_at ? order.cancellation.review_state === 'cancelled' ? 'The review has stopped. Cancellation does not return funds.' : 'The review had already ended when cancellation was checked. Its actual result is preserved.' : 'Your cancellation is saved. Confirmation that the review stopped is still pending.'} Do not send another payment.</div>}
        {order.requires_attention && <div className="notice error" role="status">This order needs a manual check. Any recorded funds remain recorded; no refund is issued by cancelling work.</div>}
        {!order.cancellation && !requested && <p className="fine">{order.state === 'activated' ? 'Payment authorized this review to start. Open the report for its current progress and result.' : 'This history is not a payment instruction. A saved or expired order is not permission to send a new transfer.'}</p>}
        <div className="review-actions">
          <button className="quiet" onClick={() => { setError(''); detail.refresh(); }}>Refresh order ↻</button>
          {order.review_id && <button className="text-button" onClick={() => setReport(true)}>Open review report →</button>}
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
    {report && order?.review_id && <ReviewDetail key={order.review_id} id={order.review_id} csrf={csrf} onClose={() => setReport(false)} onChange={detail.refresh} onOpenOrders={() => { setReport(false); panel.current?.focus(); }} />}
  </>;
}

export function Orders({ csrf }: { csrf: string }) {
  const orders = useLive<Order[]>('/orders');
  const [selected, setSelected] = useState<string | null>(null);
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">PRIVATE WORKSPACE</p><h1 className="page-title">Your orders</h1><p className="subtle">Track payment and work separately. A received payment is not a completed review.</p></div><button className="quiet" onClick={orders.refresh}>Refresh orders ↻</button></section>
    {orders.error && <div className="notice error" role="alert">{orders.error}<br />The last saved list remains visible; it may be out of date.</div>}
    <section className="panel" aria-label="Order history">
      {orders.data === null && <div className="empty"><p>{orders.error ? 'Order history could not be loaded.' : 'Loading orders…'}</p></div>}
      {orders.data?.length === 0 && <div className="empty"><h2>No paid orders yet.</h2><p>The current pilot reviews are free. Paid checkout is not enabled.</p></div>}
      {orders.data?.map(order => <button key={order.id} className={`review-item ${selected === order.id ? 'selected' : ''}`} onClick={() => setSelected(order.id)}><span><strong>Website review · {order.id.slice(0, 8)}</strong><small>{new Date(order.created_at).toLocaleString()} · {paymentLabel(order)}</small></span><span className={`badge ${order.requires_attention ? 'revoked' : 'pending'}`}>{orderLabel(order)}</span></button>)}
    </section>
    {orders.data?.length === 50 && <p className="fine">Showing your 50 most recent orders.</p>}
    {selected && <OrderDetail key={selected} id={selected} csrf={csrf} onClose={() => setSelected(null)} onChange={orders.refresh} />}
  </>;
}
