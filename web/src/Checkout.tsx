import { useEffect, useState } from 'react';
import { openWallet } from './wallet';
import { useLive } from './useLive';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { ArrowUpRight, Copy, Wallet } from 'lucide-react';

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
    <fieldset className="payment-assets"><legend>Pay with</legend><p>Choose the token and the network you’ll send it on.</p><div>{offer.inputs.map(token => <label key={token.asset_id} className={asset === token.asset_id ? 'selected' : ''}><input type="radio" name="payment-asset" required value={token.asset_id} checked={asset === token.asset_id} onChange={() => onAsset(token.asset_id)} aria-label={`${token.symbol} · ${chainName(token.blockchain)}`} /><span className="asset-symbol" aria-hidden="true">{token.symbol === 'USDC' || token.symbol === 'USDT' ? '$' : token.symbol.slice(0, 1)}</span><span><strong>{token.symbol}</strong><small>{chainName(token.blockchain)}</small></span></label>)}</div></fieldset>
    <label>Refund address{token ? ` on ${chainName(token.blockchain)}` : ''}<Input required autoComplete="off" spellCheck={false} maxLength={64} value={refund} onChange={event => onRefund(event.target.value)} placeholder={token?.blockchain === 'near' ? 'your-account.near' : 'An address you control on this network'} /><small>{token?.blockchain === 'sol' ? 'Use your Solana wallet address, not its token account. ' : ''}Used by the payment provider if the swap is refunded. {credit ? 'Service credits are separate from a wallet withdrawal.' : 'A cancelled review does not automatically refund a settled payment.'}</small></label>
    <p className="fine">{credit ? 'Next: an exact transfer amount, including swap costs. Your balance updates after confirmation; no test starts from this payment.' : compact ? `Next: an exact transfer amount, including swap costs. Wallet gas is extra. Your quote lasts ${Math.floor(offer.payment_window_seconds / 60)} minutes; work starts after payment.` : `The quote lasts ${Math.floor(offer.payment_window_seconds / 60)} minutes from preparation. Preparing it reserves the chosen review; work starts only after payment is confirmed.`}</p>
  </div>;
}

export function DepositInstructions({ quote, onSent }: { quote: Deposit; onSent: () => void }) {
  const [copied, setCopied] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const wallet = useLive<{enabled:boolean}>('/wallet/config', true, 60_000);
  const [walletError, setWalletError] = useState('');
  const [method, setMethod] = useState<'direct' | 'wallet' | null>(null);
  // An uncertain wallet send must not be followed by a second manual transfer.
  let walletRequested = false;
  try { walletRequested = Boolean(localStorage.getItem(`patchriot-payment:${quote.order_id}`)); } catch { /* Wallet sends require working storage in WalletPage. */ }
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
    {walletRequested ? <div className="notice"><p>A wallet payment was already requested. Check its status before sending again.</p><Button onClick={onSent}>Check payment status</Button></div> : <>
    {!method ? <><h3>How would you like to pay?</h3><div className="payment-methods"><Button variant="outline" className="payment-method direct" disabled={expired} onClick={() => setMethod('direct')}><span className="payment-method-art"><Copy size={30}/><ArrowUpRight size={20}/></span><strong>Send to an address</strong><span>Copy the details and send from your wallet or exchange. No connection needed.</span></Button><Button variant="outline" className="payment-method connected" disabled={expired || !wallet.data?.enabled || !['eth','sol'].includes(quote.input.token.blockchain)} onClick={() => setMethod('wallet')}><span className="payment-method-art"><Wallet size={32}/><ArrowUpRight size={20}/></span><strong>Connect a wallet</strong><span>Review the exact transfer and approve it in your wallet.</span></Button></div>{(!wallet.data?.enabled || !['eth','sol'].includes(quote.input.token.blockchain)) && <p className="fine">Use direct transfer for this token and network. Wallet connection is unavailable here.</p>}</> : <>
    <Button variant="ghost" size="sm" disabled={walletBusy} onClick={() => { setMethod(null); setWalletError(''); }}>← Payment methods</Button>
    <h3>Send {amount}</h3><div className="payment-chain"><span>ONLY THIS TOKEN<strong>{quote.input.token.symbol}</strong></span><span>ONLY THIS NETWORK<strong>{chainName(quote.input.token.blockchain)}</strong></span></div>
    {method === 'wallet' && <Button className="primary" disabled={walletBusy || expired} onClick={() => void payWithWallet()}>{walletBusy ? 'Wallet open…' : 'Pay with wallet'}</Button>}
    {walletError && <p className="notice error" role="alert">{walletError}</p>}
    {method === 'direct' && <>
    <p className="fine">Send this exact amount to the address below. A different token or network may not be recoverable.</p>
    <Button variant="outline" disabled={expired} onClick={() => void copy(amount.slice(0, -(quote.input.token.symbol.length + 1)), 'Exact amount')}>Copy exact amount</Button>
    <div className="deposit-value"><span>Deposit address</span><code>{quote.deposit_address}</code><Button variant="outline" disabled={expired} onClick={() => void copy(quote.deposit_address, 'Deposit address')}>Copy address</Button></div>
    {quote.deposit_memo && <div className="deposit-value"><span>Required deposit memo</span><code>{quote.deposit_memo}</code><Button variant="outline" disabled={expired} onClick={() => void copy(quote.deposit_memo!, 'Deposit memo')}>Copy memo</Button></div>}
    <p className="fine" role="status">{copied}</p>
    <Button className="primary" onClick={onSent}>I’ve sent it</Button>
    </>}
    <p className="fine">Pay before {new Date(quote.expires_at).toLocaleTimeString()}. Send once. If you already sent it, wait for confirmation.</p>
    {quote.provider_app_fee_bps !== undefined && quote.provider_app_fee_bps > 0 && <p className="fine">A {(quote.provider_app_fee_bps / 100).toFixed(2)}% provider app fee is included in the displayed amount. Your wallet may also charge network gas.</p>}
    <details className="execution-details"><summary>Check token and refund details</summary><dl><dt>Input asset ID</dt><dd><code>{quote.input.token.asset_id}</code></dd><dt>Input amount · smallest units</dt><dd><code>{quote.input.amount}</code></dd><dt>{quote.payment_kind === 'topup' ? 'Credit added' : 'Review fee'}</dt><dd>{tokenAmount(quote.output.amount, quote.output.token)}</dd><dt>Destination asset ID</dt><dd><code>{quote.output.token.asset_id}</code></dd><dt>Swap refund address</dt><dd><code>{quote.refund_address}</code></dd></dl></details>
    </>}
    </>}
    <p className="payment-provider-note">Payments use NEAR Intents 1Click. Conversion and confirmation can take longer than a regular on-chain transfer. {quote.payment_kind === 'topup' ? 'Credit appears after settlement is confirmed.' : 'Your assessment starts after settlement is confirmed.'}</p>
  </section>;
}
