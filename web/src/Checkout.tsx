import { useEffect, useState } from 'react';

export type PaymentToken = { asset_id: string; symbol: string; decimals: number; blockchain: string };
export type CheckoutOffer = { id: string; price: { asset: string; amount: string }; destination: PaymentToken; inputs: PaymentToken[]; payment_window_seconds: number };
export type CheckoutSettings = { mode: 'pilot' | 'closed' | 'paid'; offer: CheckoutOffer | null };
export type Deposit = {
  order_id: string; request_id: string; review_id: string; invoice_id: string;
  input: { token: PaymentToken; amount: string }; output: { token: PaymentToken; amount: string };
  deposit_address: string; deposit_memo: string | null; refund_address: string; expires_at: string;
};

export function chainName(chain: string) {
  return ({ near: 'NEAR', eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche' } as Record<string, string>)[chain] ?? chain;
}

/** Keep every token digit; Number would round 18- and 24-decimal amounts. */
export function tokenAmount(amount: string, token: PaymentToken): string | null {
  if (typeof amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amount) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 30) return null;
  const padded = amount.padStart(token.decimals + 1, '0');
  const whole = token.decimals ? padded.slice(0, -token.decimals) : padded;
  const fraction = token.decimals ? padded.slice(-token.decimals).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''} ${token.symbol}`;
}

/** An unreadable success reply must not become a payment instruction. */
export function checkedDeposit(value: Deposit): Deposit {
  const tokenValid = (token?: PaymentToken) => token && typeof token.asset_id === 'string' && token.asset_id.startsWith('nep141:')
    && typeof token.symbol === 'string' && /^[A-Za-z0-9._-]{1,16}$/.test(token.symbol)
    && ['near', 'eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax'].includes(token.blockchain);
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/\s/.test(s);
  if (!value || ![value.order_id, value.request_id, value.review_id, value.invoice_id, value.deposit_address, value.refund_address].every(text)
    || !tokenValid(value.input?.token) || !tokenValid(value.output?.token)
    || !tokenAmount(value.input.amount, value.input.token) || !tokenAmount(value.output.amount, value.output.token)
    || (value.deposit_memo !== null && !text(value.deposit_memo)) || !Number.isFinite(Date.parse(value.expires_at))) {
    throw new Error('The payment instructions could not be verified. Do not send a transfer. Check the order before trying again.');
  }
  return value;
}

export function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1_000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);
  return now;
}

export function PaymentFields({ offer, asset, refund, onAsset, onRefund }: { offer: CheckoutOffer; asset: string; refund: string; onAsset: (value: string) => void; onRefund: (value: string) => void }) {
  const token = offer.inputs.find(token => token.asset_id === asset);
  return <div className="checkout-fields">
    <div className="checkout-price"><span>Three-agent snapshot review</span><strong>{tokenAmount(offer.price.amount, offer.destination) ?? 'Price unavailable'}</strong><small>Review fee. Your transfer amount includes the quoted swap costs; your wallet may also charge network gas.</small></div>
    <label>Pay with<select aria-label="Pay with" required value={asset} onChange={event => onAsset(event.target.value)}><option value="">Choose a token and network</option>{offer.inputs.map(token => <option key={token.asset_id} value={token.asset_id}>{token.symbol} · {chainName(token.blockchain)}</option>)}</select></label>
    <label>Refund address{token ? ` on ${chainName(token.blockchain)}` : ''}<input required autoComplete="off" spellCheck={false} maxLength={64} value={refund} onChange={event => onRefund(event.target.value)} placeholder={token?.blockchain === 'near' ? 'your-account.near' : 'An address you control on this network'} /><small>Used by the payment provider if the swap is refunded. A cancelled review does not automatically refund a settled payment.</small></label>
    <p className="fine">The quote lasts {Math.floor(offer.payment_window_seconds / 60)} minutes from preparation. Preparing it reserves the chosen review; work starts only after payment is confirmed.</p>
  </div>;
}

export function DepositInstructions({ quote, onSent }: { quote: Deposit; onSent: () => void }) {
  const [copied, setCopied] = useState('');
  const amount = tokenAmount(quote.input.amount, quote.input.token);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(`${label} copied.`); }
    catch { setCopied('Copy is unavailable. Select the displayed text and copy it manually.'); }
  }
  if (!amount) return <div className="notice error" role="alert">The payment amount could not be displayed exactly. Do not send a transfer.</div>;
  return <section className="deposit-card" aria-label="Payment instructions">
    <p className="eyebrow">NEAR INTENTS / ONE PAYMENT</p>
    <h3>Send {amount}</h3><p className="deposit-network">on <strong>{chainName(quote.input.token.blockchain)}</strong></p>
    <button className="quiet" onClick={() => void copy(amount.slice(0, -(quote.input.token.symbol.length + 1)), 'Exact amount')}>Copy exact amount</button>
    <p className="fine">Pay before {new Date(quote.expires_at).toLocaleTimeString()}. Send once, using this token and network. If you already sent it, wait for confirmation.</p>
    <div className="deposit-value"><span>Deposit address</span><code>{quote.deposit_address}</code><button className="quiet" onClick={() => void copy(quote.deposit_address, 'Deposit address')}>Copy address</button></div>
    {quote.deposit_memo && <div className="deposit-value"><span>Required deposit memo</span><code>{quote.deposit_memo}</code><button className="quiet" onClick={() => void copy(quote.deposit_memo!, 'Deposit memo')}>Copy memo</button></div>}
    <p className="fine" role="status">{copied}</p>
    <button className="primary" onClick={onSent}>I’ve sent it · hide instructions</button>
    <details className="execution-details"><summary>Check token and refund details</summary><dl><dt>Input asset ID</dt><dd><code>{quote.input.token.asset_id}</code></dd><dt>Input amount · smallest units</dt><dd><code>{quote.input.amount}</code></dd><dt>Review fee</dt><dd>{tokenAmount(quote.output.amount, quote.output.token)}</dd><dt>Destination asset ID</dt><dd><code>{quote.output.token.asset_id}</code></dd><dt>Swap refund address</dt><dd><code>{quote.refund_address}</code></dd></dl></details>
  </section>;
}
