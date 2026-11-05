import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { Wallet as WalletIcon, ShieldCheck, ArrowRight, LoaderCircle } from 'lucide-react';
import type { WalletRequest } from './wallet';
import UniversalProvider from "@walletconnect/universal-provider";
import { Connection, type Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";
import QRCode from "qrcode";
import { api, write, type Session } from "./api";
import {
  checkedDeposit,
  tokenAmount,
  chainName,
  useNow,
  type Deposit,
} from "./Checkout";
import {
  ethereumTransfer,
  solanaTransfer,
  messageHex,
  walletAsset,
} from "./wallet-transfer";

type Network = "ethereum" | "solana";
type Evm = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
type Sol = {
  publicKey: { toString: () => string };
  connect: () => Promise<unknown>;
  signMessage: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<{ signature: Uint8Array }>;
  signAndSendTransaction: (tx: Transaction) => Promise<{ signature: string }>;
};
type Wallet = {
  address: string;
  network: Network;
  sign: (message: string) => Promise<string>;
  send: (quote: Deposit) => Promise<string>;
};
type Settings = { enabled: boolean; project_id: string | null; origin: string };
const chains = {
  ethereum: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Announcements are untrusted. Data images avoid third-party requests. SVG is
// rendered only through img, never as inline markup or an HTML object.
function providerIcon(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 65536 && /^data:image\/(?:png|webp|jpeg|svg\+xml)[;,]/i.test(value) ? value : undefined;
}
function WalletProviderIcon({ icon }: { icon?: string }) {
  const [failed, setFailed] = useState(false);
  return icon && !failed ? <img className="wallet-provider-logo" src={icon} alt="" width={32} height={32} onError={() => setFailed(true)} /> : <WalletIcon className="wallet-provider-logo" size={32}/>;
}
function safeError(e: unknown) {
  const code = (e as { code?: unknown })?.code;
  return code === 4001 || code === "ACTION_REJECTED"
    ? "You declined the wallet request."
    : e instanceof Error && e.message.startsWith("This ")
      ? e.message
      : "The wallet could not finish. Check its connection and network, then try again.";
}
export default function WalletDialog({ settings, request, finish }: { settings: Settings; request: WalletRequest; finish: (error?: Error) => void }) {
  const {intent, orderId: order, paymentKind} = request;
  const valid = intent === 'signin' || uuid.test(order ?? '');
  const quotePath = paymentKind === 'topup' ? `/credits/topups/${order}/quote` : `/orders/${order}/quote`;
  const alive = useRef(true);
  const [injected, setInjected] = useState<{id:string;name:string;icon?:string;provider:Evm}[]>([]);
  const [accepted,setAccepted] = useState(false);
  const providerRef=useRef<Awaited<ReturnType<typeof UniversalProvider.init>> | null>(null);
  useEffect(() => {
    alive.current=true;
    const announce = (event: Event) => {
      const detail=(event as CustomEvent).detail;
      if (!detail?.info || typeof detail.info.uuid!=='string' || typeof detail.info.name!=='string' || typeof detail.provider?.request!=='function') return;
      setInjected(list=>list.some(p=>p.id===detail.info.uuid) || list.length>=12 ? list : [...list,{id:detail.info.uuid,name:detail.info.name.slice(0,40),icon:providerIcon(detail.info.icon),provider:detail.provider}]);
    };
    window.addEventListener('eip6963:announceProvider',announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => {alive.current=false;window.removeEventListener('eip6963:announceProvider',announce);providerRef.current?.abortPairingAttempt();};
  },[]);
  const [network, setNetwork] = useState<Network>("ethereum"),
    [wallet, setWallet] = useState<Wallet | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uri, setUri] = useState(""),
    [qr, setQr] = useState(""),
    [quote, setQuote] = useState<Deposit | null>(null),
    [finished, setFinished] = useState("");
  const now = useNow();
  const key = `patchriot-payment:${order}`;
  useEffect(() => {
    if (intent !== "payment" || !valid) return;
    let active = true;
    (async () => {
      if (localStorage.getItem(key)) {
        setFinished(
          "A payment was already requested for this order. Check its status before sending again.",
        );
        return;
      }
      const session = await api<Session>("/session");
      if (!session.csrf_token)
        throw new Error("This payment needs your signed-in account.");
      if (!active) return;
      const saved = checkedDeposit(
        await write<Deposit>(quotePath, session.csrf_token, {}),
      );
      if (saved.order_id !== order)
        throw new Error("This quote does not match the order.");
      walletAsset(saved);
      if (active) {
        setQuote(saved);
        setNetwork(
          saved.input.token.blockchain === "sol" ? "solana" : "ethereum",
        );
      }
    })().catch((e) => {
      if (active)
        setError(
          e instanceof Error ? e.message : "Payment instructions unavailable.",
        );
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (uri)
      void QRCode.toDataURL(uri, { width: 280, margin: 2 }).then((data) => {
        if (active) setQr(data);
      });
    else setQr("");
    return () => {
      active = false;
    };
  }, [uri]);
  function done() { finish(); }
  async function connectBrowser(selected?: Evm) {
    setBusy(true);
    setError("");
    setWallet(null);
    try {
      const w = window as unknown as {
        ethereum?: Evm;
        solana?: Sol;
        phantom?: { solana?: Sol };
      };
      if (network === "ethereum") {
        const provider = selected ?? w.ethereum;
        if (!provider)
          throw new Error(
            "This browser has no Ethereum wallet. Use WalletConnect instead.",
          );
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x1" }],
        });
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        const address = accounts[0];
        if (!/^0x[0-9a-f]{40}$/i.test(address ?? ""))
          throw new Error("Invalid wallet address.");
        const check = async () => {
          const chain = await provider.request({ method: "eth_chainId" });
          const current = (await provider.request({
            method: "eth_accounts",
          })) as string[];
          if (
            chain !== "0x1" ||
            current[0]?.toLowerCase() !== address.toLowerCase()
          )
            throw new Error("This wallet changed. Connect it again.");
        };
        if (alive.current) setWallet({
          address,
          network,
          sign: async (m) => {
            await check();
            return (await provider.request({
              method: "personal_sign",
              params: [messageHex(m), address],
            })) as string;
          },
          send: async (q) => {
            await check();
            return (await provider.request({
              method: "eth_sendTransaction",
              params: [ethereumTransfer(q, address)],
            })) as string;
          },
        });
      } else {
        const provider = w.phantom?.solana ?? w.solana;
        if (!provider)
          throw new Error(
            "This browser has no Solana wallet. Use WalletConnect instead.",
          );
        await provider.connect();
        const address = provider.publicKey.toString();
        const check = () => {
          if (provider.publicKey.toString() !== address)
            throw new Error("This wallet changed. Connect it again.");
        };
        if (alive.current) setWallet({
          address,
          network,
          sign: async (m) => {
            check();
            return bs58.encode(
              (await provider.signMessage(new TextEncoder().encode(m), "utf8"))
                .signature,
            );
          },
          send: async (q) => {
            check();
            const connection = new Connection(
              "https://api.mainnet-beta.solana.com",
              "confirmed",
            );
            const block = await connection.getLatestBlockhash();
            const tx = solanaTransfer(q, address, block.blockhash);
            return (await provider.signAndSendTransaction(tx)).signature;
          },
        });
      }
    } catch (e) {
      setError(safeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function connectQr() {
    setBusy(true);
    setError("");
    setWallet(null);
    try {
      const provider = await UniversalProvider.init({
        projectId: settings.project_id!,
        metadata: {
          name: "Patchriot",
          description: "Sign in or pay for your approved assessment.",
          url: settings.origin,
          icons: [settings.origin + "/brand/white-hat.png"],
        },
        telemetryEnabled: false,
        logger: "error",
      });
      if (!alive.current) return;
      providerRef.current=provider;
      provider.on("display_uri", (value: string) => {if(alive.current)setUri(value);});
      const chain = chains[network],
        ns = network === "ethereum" ? "eip155" : "solana";
      const methods =
        network === "ethereum"
          ? ["personal_sign", "eth_sendTransaction"]
          : ["solana_signMessage", "solana_signAndSendTransaction"];
      const has = provider.session?.namespaces[ns]?.accounts.some((a) =>
        a.startsWith(chain + ":"),
      );
      if (!has) {
        if (provider.session) await provider.disconnect();
        await provider.connect({
          namespaces: {
            [ns]: {
              chains: [chain],
              methods,
              events: ["accountsChanged", "chainChanged"],
            },
          },
        });
      }
      const address = provider.session?.namespaces[ns]?.accounts
        .find((a) => a.startsWith(chain + ":"))
        ?.slice(chain.length + 1);
      if (!address)
        throw new Error(
          "This wallet did not connect to the requested network.",
        );
      const check = () => {
        if (
          !provider.session?.namespaces[ns]?.accounts.includes(
            chain + ":" + address,
          )
        )
          throw new Error("This wallet changed. Connect it again.");
      };
      if (alive.current) setWallet({
        address,
        network,
        sign: async (message) => {
          check();
          if (network === "ethereum")
            return provider.request<string>(
              {
                method: "personal_sign",
                params: [messageHex(message), address],
              },
              chain,
            );
          return (
            await provider.request<{ signature: string }>(
              {
                method: "solana_signMessage",
                params: {
                  message: bs58.encode(new TextEncoder().encode(message)),
                  pubkey: address,
                },
              },
              chain,
            )
          ).signature;
        },
        send: async (q) => {
          check();
          if (network === "ethereum")
            return provider.request<string>(
              {
                method: "eth_sendTransaction",
                params: [ethereumTransfer(q, address)],
              },
              chain,
            );
          const connection = new Connection(
            "https://api.mainnet-beta.solana.com",
            "confirmed",
          );
          const block = await connection.getLatestBlockhash();
          const tx = solanaTransfer(q, address, block.blockhash);
          return (
            await provider.request<{ signature: string }>(
              {
                method: "solana_signAndSendTransaction",
                params: {
                  transaction: Buffer.from(
                    tx.serialize({
                      requireAllSignatures: false,
                      verifySignatures: false,
                    }),
                  ).toString("base64"),
                  sendOptions: {
                    skipPreflight: false,
                    preflightCommitment: "confirmed",
                  },
                },
              },
              chain,
            )
          ).signature;
        },
      });
      setUri("");
    } catch (e) {
      setError(safeError(e));
      setUri("");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!wallet || !valid) return;
    setBusy(true);
    setError("");
    let submitted = false;
    try {
      if (intent === "signin") {
        if (!accepted) {
        const challenge = await api<{
          nonce: string;
          message: string;
          expires_at: string;
        }>("/auth/wallet/challenge", {
          method: "POST",
          body: JSON.stringify({
            network: wallet.network,
            address: wallet.address,
          }),
        });
        if (
          !challenge.message.startsWith(
            location.host + " wants you to sign in",
          ) ||
          !challenge.message.includes(`URI: ${settings.origin}\n`)
        )
          throw new Error("This sign-in message belongs to another site.");
        const signature = await wallet.sign(challenge.message);
        if(!alive.current) return;
        await api("/auth/wallet/verify", {
          method: "POST",
          body: JSON.stringify({ nonce: challenge.nonce, signature }),
        });
        setAccepted(true);
        }
        // A verified signature is not enough to close the dialog: the browser
        // must be able to read the actual session cookie. Retry that read only.
        const session=await api<Session>('/session');
        if(!session.account || !session.csrf_token) throw new Error('This sign-in could not open a session. Retry opening your account.');
        done();
      } else {
        if (!navigator.locks)
          throw new Error(
            "This browser cannot safely coordinate wallet payments. Use the manual transfer instructions.",
          );
        await navigator.locks.request(
          key,
          { ifAvailable: true },
          async (lock) => {
            if (!lock || !quote || localStorage.getItem(key))
              throw new Error(
                "This payment was already requested. Check your order.",
              );
            walletAsset(quote);
            // Recheck the saved order and quote immediately before asking the wallet.
            const session = await api<Session>("/session");
            if (!session.csrf_token)
              throw new Error("This payment needs your signed-in account.");
            const latest = checkedDeposit(
              await write<Deposit>(
                quotePath,
                session.csrf_token,
                {},
              ),
            );
            if (JSON.stringify(latest) !== JSON.stringify(quote))
              throw new Error(
                "This quote changed. Close the wallet panel and inspect the current payment.",
              );
            localStorage.setItem(
              key,
              JSON.stringify({ state: "requested", at: Date.now() }),
            );
            submitted = true;
            const hash = await wallet.send(quote);
            if (
              typeof hash !== "string" ||
              !(
                wallet.network === "ethereum"
                  ? /^0x[0-9a-f]{64}$/i
                  : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
              ).test(hash)
            )
              throw new Error("Unknown wallet response.");
            localStorage.setItem(
              key,
              JSON.stringify({ state: "sent", hash, at: Date.now() }),
            );
            setFinished(
              "Transfer sent. Your order updates after the server confirms it.",
            );
          },
        );
      }
    } catch (e) {
      const rejected =
        (e as { code?: unknown })?.code === 4001 ||
        (e as { code?: unknown })?.code === "ACTION_REJECTED";
      if (submitted && rejected) localStorage.removeItem(key);
      if (submitted && !rejected)
        setFinished(
          "The wallet result is uncertain. Check your wallet and order before sending again.",
        );
      else setError(safeError(e));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open=>{if(!open)finish(new Error(intent==='signin'?'Wallet sign-in cancelled.':'Wallet closed. Check your payment status before sending again.'));}}>
    <DialogContent className="wallet-dialog" aria-describedby="wallet-description">
      <div className="wallet-dialog-icon"><WalletIcon size={23}/></div>
      <DialogTitle>{intent==='signin'?'Connect your wallet':paymentKind==='topup'?'Add credit':'Pay for your assessment'}</DialogTitle>
      <DialogDescription id="wallet-description">{intent==='signin'?'Connect, then sign one message to open your account.':'Confirm the saved transfer in your wallet. Network gas is extra.'}</DialogDescription>
      {finished ? <div className="wallet-success"><ShieldCheck/><p role="status">{finished}</p><Button className="full" onClick={done}>Back to Patchriot</Button></div> : <>
        {intent==='signin' && !wallet && <Tabs value={network} onValueChange={v=>{setNetwork(v as Network);setUri('');}}><TabsList className="full"><TabsTrigger value="ethereum" disabled={busy}>Ethereum</TabsTrigger><TabsTrigger value="solana" disabled={busy}>Solana</TabsTrigger></TabsList></Tabs>}
        {intent==='payment' && (quote ? <div className="wallet-payment-summary"><strong>{tokenAmount(quote.input.amount,quote.input.token)}</strong><span>{chainName(quote.input.token.blockchain)} mainnet</span><code>{quote.deposit_address}</code></div> : <p role="status">Loading payment details…</p>)}
        {!wallet ? <div className="wallet-options">
          {network==='ethereum' && injected.length>0 ? injected.map(p=><Button key={p.id} variant="outline" disabled={busy} onClick={()=>void connectBrowser(p.provider)}><WalletProviderIcon icon={p.icon}/><span>{p.name}</span><ArrowRight size={16}/></Button>) : <Button variant="outline" disabled={busy || (intent==='payment'&&!quote)} onClick={()=>void connectBrowser()}><WalletProviderIcon icon={network==='solana'?'/brand/phantom.svg':undefined}/><span>{network==='solana'?'Phantom / Solana wallet':'Browser wallet'}</span><ArrowRight size={16}/></Button>}
          <Button variant="outline" disabled={busy || (intent==='payment'&&!quote)} onClick={()=>void connectQr()}><svg className="wallet-provider-logo walletconnect-logo" viewBox="0 0 32 22" aria-hidden="true"><path d="M6 6c5.5-5.4 14.5-5.4 20 0l1 1-4 4-1-1a8.5 8.5 0 0 0-12 0l-1 1-4-4 1-1ZM0 10l4-4 8 8 4-4 4 4 8-8 4 4-12 12-4-4-4 4L0 10Z" fill="currentColor"/></svg><span>WalletConnect</span><span className="wallet-option-hint">Scan QR</span></Button>
          {qr && <div className="wallet-qr"><img src={qr} width="280" height="280" alt="Scan with your wallet to connect"/><p>Scan in your wallet’s WalletConnect screen.</p></div>}
          {busy && <p className="wallet-wait" role="status"><LoaderCircle className="spin" size={16}/>Waiting for your wallet…</p>}
        </div> : <div className="wallet-confirm"><p className="fine">Connected</p><code className="wallet-address">{wallet.address}</code><Button className="full" disabled={busy||(intent==='payment'&&(!quote||Date.parse(quote.expires_at)<=now+15000))} onClick={()=>void confirm()}>{busy?'Check your wallet…':intent==='signin'?accepted?'Open my account':'Sign in':'Confirm payment'}</Button><Button variant="ghost" disabled={busy||accepted} onClick={()=>setWallet(null)}>Choose another wallet</Button></div>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {intent==='signin' && wallet && <div className="wallet-welcome"><strong>Welcome to Patchriot!</strong><p>By signing this message, you are securely logging into your account.</p><ul><li>This action will NOT cost any gas fees.</li><li>This does not authorize any transactions or payments.</li></ul><p>Click sign to verify your wallet and enter!</p></div>}
        <p className="wallet-footnote">{intent==='signin'?'No transaction or token approval. Wallet, Google and password logins are separate accounts.':'Only this payment is requested. Your sign-in account stays the same.'}</p>
      </>}
    </DialogContent>
  </Dialog>;
}

export async function walletSettings(): Promise<Settings> {
  const settings=await api<Settings>('/wallet/config');
  if(!settings.enabled || !settings.project_id || settings.origin!==location.origin) throw new Error('Wallet access is not configured on this address.');
  return settings;
}
