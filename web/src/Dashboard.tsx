import type { Fleet } from './api';
import type { View } from './navigation';
import { useLive } from './useLive';
import { AuditRows, auditActive, useAudits } from './Audits';
import { AgentList } from './Pairing';
import { money } from './Earnings';
import { orderLabel, paymentLabel } from './Orders';
import type { Order } from './Orders';

type EarningsSummary = { balance: { available: string; earned: string; reserved: string; paid: string } };

export function Dashboard({ name, fleet, onOpen }: { name: string; fleet?: Fleet | null; onOpen: (view: View, id?: string | null) => void }) {
  const audits = useAudits();
  const orders = useLive<Order[]>('/orders', true, 30_000);
  const earnings = useLive<EarningsSummary>('/withdrawals', true, 60_000);
  const ready = audits.ready && !audits.error;
  return <section className="dashboard">
    <div className="dashboard-title"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Hello, {name}.</h1></div><span className="private-label">Private to your account</span></div>
    <div className="dashboard-actions"><button className="action-tile" onClick={() => onOpen('request')}><span className="action-symbol" aria-hidden="true">↗</span><span><strong>Request an audit</strong><small>Check a website or source code.</small></span><span aria-hidden="true">→</span></button><button className="action-tile" onClick={() => onOpen('guide')}><span className="action-symbol" aria-hidden="true">+</span><span><strong>Pair an agent</strong><small>Contribute from your own machine.</small></span><span aria-hidden="true">→</span></button></div>
    <div className="dashboard-metrics" aria-label="Workspace summary"><div><span>Recent audits</span><strong>{ready ? audits.items.length : '—'}</strong></div><div><span>Active in this view</span><strong>{ready ? audits.items.filter(item => auditActive(item.state)).length : '—'}</strong></div><button onClick={() => onOpen('agents')}><span>Agents online · network</span><strong>{fleet?.online_devices ?? '—'}</strong></button><button onClick={() => onOpen('earnings')}><span>Your available earnings</span><strong>{earnings.data?.balance && !earnings.error ? money(earnings.data.balance.available) : '—'}<small> USDC</small></strong></button></div>
    {earnings.error && <p className="notice error" role="alert">Earnings could not refresh. <button className="inline" onClick={earnings.refresh}>Retry earnings</button></p>}
    <div className="dashboard-grid">
      <section className="dashboard-audits dashboard-block"><div className="block-heading"><h2>Your audits</h2><button className="text-button" onClick={() => onOpen('audits')}>View all →</button></div>
        {audits.error && <p className="notice error" role="alert">Audits could not fully refresh. Saved entries may be out of date. <button className="inline" onClick={audits.refresh}>Retry audits</button></p>}
        {!audits.ready && !audits.error && <p role="status">Loading audits…</p>}
        {ready && audits.items.length === 0 && <div className="dashboard-empty"><span aria-hidden="true">↗</span><h3>Nothing to review yet.</h3><p>Your requests and reports will appear here.</p></div>}
        <AuditRows items={audits.items.slice(0, 5)} onOpen={onOpen} />
      </section>
      <section className="dashboard-orders dashboard-block"><div className="block-heading"><h2>Your orders</h2><button className="text-button" onClick={() => onOpen('orders')}>View all →</button></div>
        {orders.error && <p className="notice error" role="alert">Orders could not refresh. <button className="inline" onClick={orders.refresh}>Retry orders</button></p>}
        {!orders.data && !orders.error && <p role="status">Loading orders…</p>}
        {orders.data?.length === 0 && <div className="dashboard-empty"><h3>No paid orders yet.</h3><p>Payment records appear here after checkout.</p></div>}
        {orders.data?.slice(0, 3).map(order => <button className="dashboard-order" key={order.id} onClick={() => onOpen('orders', order.id)}><span><strong>Audit · {order.id.slice(0, 8)}</strong><small>{paymentLabel(order)}</small></span><span className={`status-chip ${order.requires_attention ? 'state-needs_review' : ''}`}>{orderLabel(order)}</span></button>)}
        <button className="dashboard-earnings" onClick={() => onOpen('earnings')}><span>Earnings & withdrawals</span><span aria-hidden="true">↗</span></button>
      </section>
      <section className="dashboard-network dashboard-block"><AgentList compact onAll={() => onOpen('agents')} /></section>
    </div>
    <p className="dashboard-footnote">Agents currently inspect saved material. Findings still need your review.</p>
  </section>;
}
