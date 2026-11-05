import { useEffect, useState } from 'react';
import { openWallet } from './wallet';
import { useLive } from './useLive';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

export type PaymentToken = { asset_id: string; symbol: string; decimals: number; blockchain: string };
export type CheckoutOffer = { id: string; price: { asset: string; amount: string }; destination: PaymentToken; inputs: PaymentToken[]; payment_window_seconds: number };
export type CheckoutSettings = { mode: 'pilot' | 'closed' | 'paid' | 'coupons'; offer: CheckoutOffer | null };
export type Deposit = {
  order_id: string; request_id: string; review_id?: string; invoice_id: string; payment_kind?: 'topup' | 'review'; amount_cents?: number;
  input: { token: PaymentToken; amount: string }; output: { token: PaymentToken; amount: string };
  deposit_address: string; deposit_memo: string | null; refund_address: string; expires_at: string;
  provider_app_fee_bps?: number;
};

export function chainName(chain: string) {
  return ({ near: 'NEAR', sol: 'Solana', eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche' } as Record<string, string>)[chain] ?? chain;
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
    && ['near', 'sol', 'eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax'].includes(token.blockchain);
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/\s/.test(s);
  if (!value || ![value.order_id, value.request_id, value.invoice_id, value.deposit_address, value.refund_address].every(text)
    || (value.payment_kind === 'topup' ? value.review_id !== undefined || !Number.isSafeInteger(value.amount_cents) || value.amount_cents! < 200 : !text(value.review_id))
    || !tokenValid(value.input?.token) || !tokenValid(value.output?.token)
    || !tokenAmount(value.input.amount, value.input.token) || !tokenAmount(value.output.amount, value.output.token)
    || (value.deposit_memo !== null && !text(value.deposit_memo)) || !Number.isFinite(Date.parse(value.expires_at))
    || (value.provider_app_fee_bps !== undefined && (!Number.isInteger(value.provider_app_fee_bps) || value.provider_app_fee_bps < 0 || value.provider_app_fee_bps > 100))) {
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

export function PaymentFields({ offer, asset, refund, onAsset, onRefund, label = "Three-agent review", compact = false, credit = false }: { label?: string; compact?: boolean; credit?: boolean; offer: CheckoutOffer; asset: string; refund: string; onAsset: (value: string) => void; onRefund: (value: string) => void }) {
  const token = offer.inputs.find(token => token.asset_id === asset);
  return <div className="checkout-fields">
    {!compact && <div className="checkout-price"><span>{label}</span><strong>{tokenAmount(offer.price.amount, offer.destination) ?? 'Price unavailable'}</strong><small>Review fee. Your transfer amount includes the quoted swap costs; your wallet may also charge network gas.</small></div>}
    <label>Pay with<select aria-label="Pay with" required value={asset} onChange={event => onAsset(event.target.value)}><option value="">Choose a token and network</option>{offer.inputs.map(token => <option key={token.asset_id} value={token.asset_id}>{token.symbol} · {chainName(token.blockchain)}</option>)}</select></label>
    <label>Refund address{token ? ` on ${chainName(token.blockchain)}` : ''}<Input required autoComplete="off" spellCheck={false} maxLength={64} value={refund} onChange={event => onRefund(event.target.value)} placeholder={token?.blockchain === 'near' ? 'your-account.near' : 'An address you control on this network'} /><small>{token?.blockchain === 'sol' ? 'Use your Solana wallet address, not its token account. ' : ''}Used by the payment provider if the swap is refunded. {credit ? 'Service credits are separate from a wallet withdrawal.' : 'A cancelled review does not automatically refund a settled payment.'}</small></label>
    <p className="fine">{credit ? 'Next: an exact transfer amount, including swap costs. Your balance updates after confirmation; no test starts from this payment.' : compact ? `Next: an exact transfer amount, including swap costs. Wallet gas is extra. Your quote lasts ${Math.floor(offer.payment_window_seconds / 60)} minutes; work starts after payment.` : `The quote lasts ${Math.floor(offer.payment_window_seconds / 60)} minutes from preparation. Preparing it reserves the chosen review; work starts only after payment is confirmed.`}</p>
  </div>;
}

export function DepositInstructions({ quote, onSent }: { quote: Deposit; onSent: () => void }) {
  const [copied, setCopied] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const wallet = useLive<{enabled:boolean}>('/wallet/config', true, 60_000);
  const [walletError, setWalletError] = useState('');
  async function payWithWallet() { setWalletBusy(true); setWalletError(''); try { await openWallet('payment', quote.order_id, quote.payment_kind ?? 'review'); onSent(); } catch(e) { setWalletError((e as Error).message); } finally { setWalletBusy(false); } }
  const amount = tokenAmount(quote.input.amount, quote.input.token);
  const expired = Date.parse(quote.expires_at) <= useNow();
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(`${label} copied.`); }
    catch { setCopied('Copy is unavailable. Select the displayed text and copy it manually.'); }
  }
  if (!amount) return <div className="notice error" role="alert">The payment amount could not be displayed exactly. Do not send a transfer.</div>;
  return <section className="deposit-card" aria-label="Payment instructions">
    <p className="eyebrow">NEAR INTENTS / ONE PAYMENT</p>
    {expired && <p className="notice error" role="alert">These payment instructions have expired. Do not send a new transfer. If you already sent one, check your account for its status.</p>}
    <h3>Send {amount}</h3><p className="deposit-network">on <strong>{chainName(quote.input.token.blockchain)}</strong></p>
    {wallet.data?.enabled && ['eth','sol'].includes(quote.input.token.blockchain) && <Button className="primary" disabled={walletBusy || expired} onClick={() => void payWithWallet()}>{walletBusy ? 'Wallet open…' : 'Pay with wallet'}</Button>}
    {walletError && <p className="notice error" role="alert">{walletError}</p>}
    <p className="fine">Or send directly from your wallet using these instructions. No connection required.</p>
    <Button variant="outline" disabled={expired} onClick={() => void copy(amount.slice(0, -(quote.input.token.symbol.length + 1)), 'Exact amount')}>Copy exact amount</Button>
    <p className="fine">Pay before {new Date(quote.expires_at).toLocaleTimeString()}. Send once, using this token and network. If you already sent it, wait for confirmation.</p>
    {quote.provider_app_fee_bps !== undefined && quote.provider_app_fee_bps > 0 && <p className="fine">A {(quote.provider_app_fee_bps / 100).toFixed(2)}% provider app fee is included in the displayed amount. Your wallet may also charge network gas.</p>}
    <div className="deposit-value"><span>Deposit address</span><code>{quote.deposit_address}</code><Button variant="outline" disabled={expired} onClick={() => void copy(quote.deposit_address, 'Deposit address')}>Copy address</Button></div>
    {quote.deposit_memo && <div className="deposit-value"><span>Required deposit memo</span><code>{quote.deposit_memo}</code><Button variant="outline" disabled={expired} onClick={() => void copy(quote.deposit_memo!, 'Deposit memo')}>Copy memo</Button></div>}
    <p className="fine" role="status">{copied}</p>
    <Button className="primary" onClick={onSent}>I’ve sent it</Button>
    <details className="execution-details"><summary>Check token and refund details</summary><dl><dt>Input asset ID</dt><dd><code>{quote.input.token.asset_id}</code></dd><dt>Input amount · smallest units</dt><dd><code>{quote.input.amount}</code></dd><dt>{quote.payment_kind === 'topup' ? 'Credit added' : 'Review fee'}</dt><dd>{tokenAmount(quote.output.amount, quote.output.token)}</dd><dt>Destination asset ID</dt><dd><code>{quote.output.token.asset_id}</code></dd><dt>Swap refund address</dt><dd><code>{quote.refund_address}</code></dd></dl></details>
  </section>;
}
