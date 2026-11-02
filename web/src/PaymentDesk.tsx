import { useLive } from './useLive';
import { TreasuryDesk } from './Earnings';

type PaymentRecord = {
  invoice_id: string; account_id: string; account_name: string; account_disabled: boolean;
  asset: string; required_amount: string; received_amount: string | null;
  origin_asset: string | null; deposit_address: string; deposit_memo: string | null;
  recipient: string; recipient_type: string | null; payment_confirmed: boolean;
  payment_state: string; payment_reason: string | null; poll_error: string | null;
  provider_updated_at: string | null; created_at: string; updated_at: string;
  ledger_amount: string | null; ledger_credit: string | null;
  order_id: string | null; order_state: string | null; order_error: string | null; review_id: string | null;
  funding_state: string | null; funding_error: string | null; earnings_error: string | null;
  cancel_requested_at: string | null; cancel_confirmed_at: string | null; cancel_review_state: string | null;
  requires_attention: boolean;
};
const label = (value: string | null) => value ? value.replaceAll('_', ' ') : 'Not recorded';
const time = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded';

export function PaymentDesk() {
  const records = useLive<PaymentRecord[]>('/admin/payments');
  // A revoked admin session must lose this data even if its next status read is
  // forbidden rather than expired. Hide the old rows on every failed refresh.
  const rows = records.error ? undefined : records.data;
  return <>
    <section className="section-heading fleet-heading"><div><p className="eyebrow">ADMIN / SAVED PAYMENT FACTS</p><h1 className="page-title">Payment desk</h1><p className="subtle">Inspect confirmation, accounting and work delivery separately.</p></div><button className="quiet" onClick={records.refresh}>Refresh payments ↻</button></section>
    <TreasuryDesk />
    <p className="notice">Read-only. A received payment does not prove work finished. Cancelling work does not return funds. Check the saved payment, review and any previous refund before making a money decision.</p>
    {records.error && <div className="notice error" role="alert">{records.error} Payment records are hidden until access and storage can be checked.</div>}
    <section className="panel payment-desk" aria-label="Admin payment records">
      <div className="table-toolbar"><strong>{rows ? `${rows.length} recent invoice${rows.length === 1 ? '' : 's'}` : records.error ? 'Records unavailable' : 'Loading payments…'}</strong><span className="fine">Newest 50 · amounts in token smallest units</span></div>
      {rows?.length === 0 && <div className="empty"><h2>No payment records yet.</h2><p>Prepared quotes appear here. A quote alone does not create a ledger credit.</p></div>}
      {rows?.map(row => <details key={row.invoice_id} className="payment-record"><summary><span><strong>{row.account_name}{row.account_disabled ? ' · account disabled' : ''}</strong><small>{time(row.created_at)} · order {row.order_id?.slice(0, 8) ?? 'not linked'}</small></span><span className={`badge ${row.requires_attention ? 'revoked' : row.payment_confirmed ? 'approved' : 'pending'}`}>{row.payment_confirmed ? `Paid${row.requires_attention ? ' · needs attention' : ''}` : row.requires_attention ? 'Needs attention' : label(row.payment_state)}</span></summary>
        <div className="payment-record-body">
          {row.requires_attention && <p className="notice error">Inspect the records below. This flag does not authorize a refund or another work attempt.</p>}
          <dl><dt>Asset</dt><dd><code>{row.asset}</code></dd><dt>Quoted amount · smallest units</dt><dd><code>{row.required_amount}</code></dd><dt>Provider-reported received amount</dt><dd><code>{row.received_amount ?? 'Not recorded'}</code></dd><dt>Ledger credit · smallest units</dt><dd><code>{row.ledger_amount ?? 'Not recorded'}</code> · {label(row.ledger_credit)}</dd><dt>Payment status</dt><dd>{label(row.payment_state)}</dd><dt>Order</dt><dd>{label(row.order_state)}</dd><dt>Review activation</dt><dd>{label(row.funding_state)}</dd><dt>Cancellation requested</dt><dd>{time(row.cancel_requested_at)}</dd><dt>Cancellation confirmed</dt><dd>{time(row.cancel_confirmed_at)}{row.cancel_review_state ? ` · review ${label(row.cancel_review_state)}` : ''}</dd></dl>
          <details className="execution-details"><summary>Deposit and treasury destination</summary><p className="fine">Saved route for this order. These are historical records, not instructions to send another payment.</p><dl><dt>Order ID</dt><dd><code>{row.order_id ?? 'Not linked'}</code></dd><dt>Deposit asset</dt><dd><code>{row.origin_asset ?? 'Not recorded'}</code></dd><dt>Deposit address</dt><dd><code>{row.deposit_address}</code></dd>{row.deposit_memo && <><dt>Deposit memo</dt><dd><code>{row.deposit_memo}</code></dd></>}<dt>Treasury location</dt><dd>{row.recipient_type === 'INTENTS' ? 'Inside NEAR Intents' : row.recipient_type === 'DESTINATION_CHAIN' ? 'Destination-chain wallet' : 'Not recorded'}</dd><dt>Treasury recipient</dt><dd><code>{row.recipient}</code></dd></dl></details>
          {[row.payment_reason, row.poll_error, row.order_error, row.funding_error, row.earnings_error].some(Boolean) && <div className="notice"><strong>Recorded reasons</strong><ul>{[...new Set([row.payment_reason, row.poll_error, row.order_error, row.funding_error, row.earnings_error].filter(Boolean))].map(reason => <li key={reason}>{label(reason)}</li>)}</ul></div>}
          <details className="execution-details"><summary>Record identifiers and timestamps</summary><dl><dt>Invoice</dt><dd><code>{row.invoice_id}</code></dd><dt>Account</dt><dd><code>{row.account_id}</code></dd><dt>Order</dt><dd><code>{row.order_id ?? 'Not recorded'}</code></dd><dt>Review</dt><dd><code>{row.review_id ?? 'Not recorded'}</code></dd><dt>Provider status timestamp</dt><dd>{time(row.provider_updated_at)}</dd><dt>Saved payment updated</dt><dd>{time(row.updated_at)}</dd></dl></details>
        </div>
      </details>)}
    </section>
    {records.updated && !records.error && <p className="fine">Loaded {records.updated.toLocaleTimeString()}. These are saved records; opening this page does not query the payment provider.</p>}
  </>;
}
