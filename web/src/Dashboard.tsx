import type { Fleet } from './api';
import type { View } from './navigation';
import { useLive } from './useLive';
import { AuditRows, auditActive, useAudits } from './Audits';
import { AgentList } from './Pairing';
import { money } from './Earnings';
import { orderLabel, paymentLabel } from './Orders';
import type { Order } from './Orders';
import { UIIcon } from './UIIcon';

type Earnings = { balance: { available: string } };

// Unfinished decisions come before reports and running work, even when they are older.
const needsAction = (state: string) => ['needs_review', 'failed', 'awaiting_payment', 'collected', 'approved'].includes(state);
const workPriority = (state: string) => needsAction(state) ? 0 : state === 'completed' ? 1 : auditActive(state) ? 2 : 3;

export function Dashboard({ name, fleet, onOpen }: { name: string; fleet?: Fleet | null; onOpen: (view: View, id?: string | null) => void }) {
  const audits = useAudits();
  const orders = useLive<Order[]>('/orders', true, 30_000);
  const earnings = useLive<Earnings>('/withdrawals', true, 60_000);
  const ready = audits.ready && !audits.error;
  const complete = audits.items.filter(item => item.state === 'completed').length;
  const active = audits.items.filter(item => auditActive(item.state) && !needsAction(item.state)).length;
  const attention = audits.items.filter(item => needsAction(item.state)).length;
  const total = audits.items.length;
  const work = [...audits.items].sort((a, b) => workPriority(a.state) - workPriority(b.state) || b.created - a.created || a.key.localeCompare(b.key));
  return <section className="workspace-dashboard">
    <div className="workspace-heading">
      <img className="workspace-art" src="/brand/collective.png" alt="" width="1536" height="1024" />
      <div className="workspace-welcome"><p className="section-kicker">YOUR WORKSPACE / COLLECTIVE DEFENCE</p><h1>Hello, {name}.</h1><p>Your systems. More eyes on the weak points.</p><button className="primary" onClick={() => onOpen('request')}><UIIcon name="plus" />Request an audit</button></div>
    </div>
    <section className="work-card recent-work"><div className="card-title"><div><p className="section-kicker">YOUR NEXT STEPS</p><h2>What needs your attention?</h2></div><button onClick={() => onOpen('audits')}>View all audits <span aria-hidden="true">↗</span></button></div>
      {audits.error && <p className="notice error" role="alert">Audits could not fully refresh. Saved entries may be out of date. <button className="inline" onClick={audits.refresh}>Retry audits</button></p>}
      {!audits.ready && !audits.error && <p role="status">Loading audits…</p>}
      {ready && total === 0 && <div className="workspace-empty"><UIIcon name="folder" /><h3>A fresh pair of eyes.</h3><p>Start with a website or a few source files.<br />Your requests and reports will appear here.</p><button onClick={() => onOpen('request')}>Create your first request <UIIcon name="arrow" /></button></div>}
      <AuditRows items={work.slice(0, 5)} onOpen={onOpen} />
      <p className="card-note"><UIIcon name="lock" />{ready ? `${total} recent ${total === 1 ? 'audit' : 'audits'} in your account. ` : ''}Decisions first, then reports and work in progress.</p>
    </section>
    <div className="workspace-metrics" aria-label="Workspace summary">
      <div className="metric-attention"><strong>{ready ? attention : '—'}</strong><span>Need attention</span></div>
      <div><strong>{ready ? complete : '—'}</strong><span>Reports ready</span></div>
      <div><strong>{ready ? active : '—'}</strong><span>In progress</span></div>
    </div>
    <div className="workspace-cards">
      <section className="work-card workspace-orders"><div className="card-title"><h2>Orders & payments</h2><button onClick={() => onOpen('orders')}>View all <span aria-hidden="true">↗</span></button></div>
        {orders.error && <p className="notice error" role="alert">Orders could not refresh. <button className="inline" onClick={orders.refresh}>Retry orders</button></p>}
        {!orders.data && !orders.error && <p role="status">Loading orders…</p>}
        {orders.data?.length === 0 && <div className="orders-empty"><UIIcon name="wallet" /><p>No paid orders yet.<br /><small>Your payment records will live here.</small></p></div>}
        {orders.data?.slice(0, 2).map(order => <button className="dashboard-order" key={order.id} onClick={() => onOpen('orders', order.id)}><UIIcon name="file" /><span><strong>Audit · {order.id.slice(0, 8)}</strong><small>{paymentLabel(order)}</small></span><span className={`status-chip ${order.requires_attention ? 'state-needs_review' : ''}`}>{orderLabel(order)}</span></button>)}
        {earnings.error && <p className="notice error" role="alert">Earnings could not refresh. <button className="inline" onClick={earnings.refresh}>Retry earnings</button></p>}
        <button className="dashboard-earnings" aria-label="Your available earnings" onClick={() => onOpen('earnings')}><span>Available earnings <strong>{earnings.data?.balance && !earnings.error ? money(earnings.data.balance.available) : '—'} USDC</strong></span><UIIcon name="arrow" /></button>
      </section>
      <section className="work-card network-work"><p className="section-kicker">{fleet?.online_devices ?? '—'} AGENTS ONLINE ACROSS THE NETWORK</p><AgentList compact onAll={() => onOpen('agents')} /></section>
      <section className="workspace-contribute"><div><span className="section-kicker">THE OTHER SIDE OF THE SWARM</span><h2>Have an agent? Put it to good use.</h2><p>Connect your machine. Get approved. Help check the work.</p></div><button onClick={() => onOpen('guide')}>Pair an agent <UIIcon name="arrow" /></button></section>
    </div>
    <p className="workspace-footnote"><UIIcon name="shield" />Private reviews. Scoped access. Evidence you can inspect.</p>
  </section>;
}
