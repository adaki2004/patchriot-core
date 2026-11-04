import type { Fleet } from './api';
import type { View } from './navigation';
import { useLive } from './useLive';
import { AuditRows, auditActive, useAudits } from './Audits';
import { AgentList } from './Pairing';
import { money } from './Earnings';
import { orderLabel, paymentLabel } from './Orders';
import { useOrderHistory } from './orderHistory';
import { Trial } from './Trial';
import { UIIcon } from './UIIcon';

type Earnings = { balance: { available: string } };

// Keep actions and active work visible before finished reports.
const needsAction = (state: string) => ['needs_review', 'failed', 'awaiting_payment', 'awaiting_verification', 'collected', 'approved'].includes(state);
const workPriority = (state: string) => needsAction(state) ? 0 : auditActive(state) ? 1 : state === 'completed' ? 2 : 3;

export function Dashboard({ name, fleet, onOpen, csrf }: { name: string; csrf: string; fleet?: Fleet | null; onOpen: (view: View, id?: string | null) => void }) {
  const audits = useAudits();
  const history = useOrderHistory();
  const { orders, coupons } = history;
  const earnings = useLive<Earnings>('/withdrawals', true, 60_000);
  const ready = audits.ready && !audits.error;
  const complete = audits.items.filter(item => item.state === 'completed').length;
  const active = audits.items.filter(item => ['running', 'collecting'].includes(item.state)).length;
  const queued = audits.items.filter(item => item.state === 'queued').length;
  const attention = audits.items.filter(item => needsAction(item.state)).length;
  const total = audits.items.length;
  const work = [...audits.items].sort((a, b) => workPriority(a.state) - workPriority(b.state) || b.created - a.created || a.key.localeCompare(b.key));
  return <section className="workspace-dashboard">
    <div className="workspace-heading">
      <img className="workspace-art" src="/brand/collective.png" alt="" width="1536" height="1024" />
      <div className="workspace-welcome"><p className="section-kicker">YOUR WORKSPACE / COLLECTIVE DEFENSE</p><h1>Hello, {name}.</h1><p>Your systems. More eyes on the weak points.</p><button className="primary" onClick={() => onOpen('request')}><UIIcon name="plus" />Request an audit</button></div>
    </div>
    <Trial csrf={csrf} onStart={() => onOpen('request')} />
    <section className="work-card recent-work"><div className="card-title"><div><p className="section-kicker">YOUR REQUESTS</p><h2>Work in progress.</h2></div><button onClick={() => onOpen('audits')}>View all audits <span aria-hidden="true">↗</span></button></div>
      {audits.error && <p className="notice error" role="alert">Audits could not fully refresh. Saved entries may be out of date. <button className="inline" onClick={audits.refresh}>Retry audits</button></p>}
      {!audits.ready && !audits.error && <p role="status">Loading audits…</p>}
      {ready && total === 0 && <div className="workspace-empty"><UIIcon name="folder" /><h3>A fresh pair of eyes.</h3><p>Start with a website you control.<br />Your requests and reports will appear here.</p><button onClick={() => onOpen('request')}>Create your first request <UIIcon name="arrow" /></button></div>}
      <AuditRows items={work.slice(0, 5)} onOpen={onOpen} />
      <p className="card-note"><UIIcon name="lock" />{ready ? `${total} recent ${total === 1 ? 'audit' : 'audits'} in your account. ` : ''}You can close this page; queued and running work continues.</p>
    </section>
    <div className="workspace-metrics" aria-label="Workspace summary">
      <div className="metric-attention"><strong>{ready ? attention : '—'}</strong><span>Need attention</span></div>
      <div><strong>{ready ? queued : '—'}</strong><span>Queued</span></div>
      <div><strong>{ready ? active : '—'}</strong><span>Running</span></div>
      <div><strong>{ready ? complete : '—'}</strong><span>Reports ready</span></div>
    </div>
    <div className="workspace-cards">
      <section className="work-card workspace-orders"><div className="card-title"><h2>Orders & payments</h2><button onClick={() => onOpen('orders')}>View all <span aria-hidden="true">↗</span></button></div>
        {orders.error && <p className="notice error" role="alert">Orders could not refresh. <button className="inline" onClick={orders.refresh}>Retry orders</button></p>}
        {coupons.error && <p className="notice error" role="alert">Coupon history could not refresh. <button className="inline" onClick={coupons.refresh}>Retry coupon history</button></p>}
        {!history.ready && !orders.error && !coupons.error && <p role="status">Loading orders…</p>}
        {history.ready && !orders.error && !coupons.error && history.entries.length === 0 && <div className="orders-empty"><UIIcon name="wallet" /><p>No orders yet.<br /><small>Paid and coupon assessments will appear here.</small></p></div>}
        {history.entries.slice(0, 2).map(entry => <button className="dashboard-order" key={`${entry.kind}-${entry.record.id}`} onClick={() => onOpen('orders', entry.record.id)}><UIIcon name="file" /><span><strong>Audit · {entry.record.id.slice(0, 8)}</strong><small>{entry.kind === 'coupon' ? 'Covered by coupon · $0 charged' : paymentLabel(entry.record)}</small></span><span className={`status-chip ${entry.kind === 'payment' && entry.record.requires_attention ? 'state-needs_review' : ''}`}>{entry.kind === 'coupon' ? (entry.record.review_id ? 'Open assessment' : 'Start not confirmed') : orderLabel(entry.record)}</span></button>)}
        {earnings.error && <p className="notice error" role="alert">Earnings could not refresh. <button className="inline" onClick={earnings.refresh}>Retry earnings</button></p>}
        <button className="dashboard-earnings" aria-label="Your available earnings" onClick={() => onOpen('earnings')}><span>Available earnings <strong>{earnings.data?.balance && !earnings.error ? money(earnings.data.balance.available) : '—'} USDC</strong></span><UIIcon name="arrow" /></button>
      </section>
      <section className="work-card network-work"><p className="section-kicker">{fleet?.online_devices ?? '—'} AGENTS ONLINE ACROSS THE NETWORK</p><AgentList compact onAll={() => onOpen('agents')} /></section>
      <section className="workspace-contribute"><div><span className="section-kicker">MANAGED BETA</span><h2>A network ready for your scope.</h2><p>Patchriot runs the agents. Public contributor pairing is not open yet.</p></div><button onClick={() => onOpen('agents')}>Meet the agents <UIIcon name="arrow" /></button></section>
    </div>
    <p className="workspace-footnote"><UIIcon name="shield" />Private reviews. Scoped access. Evidence you can inspect.</p>
  </section>;
}
