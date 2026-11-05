import { useEffect, useState, useSyncExternalStore } from 'react';
import { walletSnapshot, subscribeWallet } from './wallet';
import type { ComponentProps } from 'react';
import type WalletDialog from './WalletPage';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';

export function WalletHost() {
  const request = useSyncExternalStore(subscribeWallet, walletSnapshot);
  const [loaded, setLoaded] = useState<{ Component: typeof WalletDialog; settings: ComponentProps<typeof WalletDialog>['settings'] } | null>(null);
  useEffect(() => {
    if (!request) { setLoaded(null); return; }
    let active = true;
    import('./WalletPage').then(async module => {
      const settings = await module.walletSettings();
      if (active) setLoaded({ Component: module.default, settings });
    }).catch(error => { if (active) request.finish(error instanceof Error ? error : new Error('Wallet unavailable.')); });
    return () => { active = false; };
  }, [request]);
  if (!request) return null;
  if (!loaded) return <Dialog open onOpenChange={open => { if (!open) request.finish(new Error('Wallet connection cancelled.')); }}><DialogContent><DialogTitle>Connect your wallet</DialogTitle><DialogDescription>Loading wallet options…</DialogDescription></DialogContent></Dialog>;
  return <loaded.Component settings={loaded.settings} request={request} finish={request.finish} />;
}
