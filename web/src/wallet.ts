export type WalletRequest = { intent: 'signin' | 'payment'; orderId?: string; paymentKind?: 'topup' | 'review' };
type Pending = WalletRequest & { finish: (error?: Error) => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
export function walletSnapshot() { return pending; }
export function subscribeWallet(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** SDKs load on demand. One in-page flow at a time; no popup/postMessage race. */
export function openWallet(intent: WalletRequest['intent'], orderId?: string, paymentKind: WalletRequest['paymentKind'] = 'review'): Promise<void> {
  if (pending) return Promise.reject(new Error('A wallet request is already open.'));
  if (intent === 'payment' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId ?? '')) return Promise.reject(new Error('This payment is unavailable.'));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Wallet request timed out. Check your account or payment before retrying.')), 10 * 60_000);
    const finish = (error?: Error) => {
      if (pending?.finish !== finish) return;
      clearTimeout(timeout); pending = null; listeners.forEach(fn => fn());
      if (error) reject(error); else resolve();
    };
    pending = { intent, orderId, paymentKind, finish }; listeners.forEach(fn => fn());
  });
}
