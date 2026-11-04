import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
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
function safeError(e: unknown) {
  const code = (e as { code?: unknown })?.code;
  return code === 4001 || code === "ACTION_REJECTED"
    ? "You declined the wallet request."
    : e instanceof Error && e.message.startsWith("This ")
      ? e.message
      : "The wallet could not finish. Check its connection and network, then try again.";
}
function WalletPage({ settings }: { settings: Settings }) {
  const params = new URLSearchParams(location.hash.slice(1)),
    intent = params.get("intent"),
    order = params.get("order"),
    request = params.get("request");
  const valid =
    !!window.opener &&
    uuid.test(request ?? "") &&
    (intent === "signin" || (intent === "payment" && uuid.test(order ?? "")));
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
      const saved = checkedDeposit(
        await write<Deposit>(`/orders/${order}/quote`, session.csrf_token, {}),
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
  function done() {
    window.opener?.postMessage(
      { kind: "patchriot-wallet-finished", intent, request },
      settings.origin,
    );
  }
  async function connectBrowser() {
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
        const provider = w.ethereum;
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
        setWallet({
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
        setWallet({
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
      provider.on("display_uri", (value: string) => setUri(value));
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
      setWallet({
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
        await api("/auth/wallet/verify", {
          method: "POST",
          body: JSON.stringify({ nonce: challenge.nonce, signature }),
        });
        setFinished("Signed in. Return to your workspace.");
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
                `/orders/${order}/quote`,
                session.csrf_token,
                {},
              ),
            );
            if (JSON.stringify(latest) !== JSON.stringify(quote))
              throw new Error(
                "This quote changed. Close this window and inspect the current order.",
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
  return (
    <main className="wallet-page">
      <a href="/#/home" className="wallet-brand" target="_blank" rel="noopener">
        <img src="/brand/white-hat.png" width="68" height="68" alt="" />
        patchriot_
      </a>
      {!valid ? (
        <p role="alert">
          Open this window from Patchriot sign-in or your order.
        </p>
      ) : (
        <>
          <p className="eyebrow">
            {intent === "signin" ? "ACCOUNT ACCESS" : "NEAR INTENTS / PAYMENT"}
          </p>
          <h1>
            {intent === "signin"
              ? "Sign in with your wallet."
              : "Pay for your assessment."}
          </h1>
          {finished ? (
            <>
              <p role="status">{finished}</p>
              <button className="primary full" onClick={done}>
                Return to Patchriot
              </button>
            </>
          ) : (
            <>
              {intent === "signin" ? (
                <p>
                  Sign one message to open your account. No transaction or token
                  approval.
                </p>
              ) : quote ? (
                <div className="wallet-quote">
                  <strong>
                    {tokenAmount(quote.input.amount, quote.input.token)}
                  </strong>
                  <p>
                    {chainName(quote.input.token.blockchain)} mainnet · gas is
                    extra
                  </p>
                  <code>{quote.deposit_address}</code>
                  <small>
                    Deposit address · quote ends{" "}
                    {new Date(quote.expires_at).toLocaleTimeString()}
                  </small>
                </div>
              ) : (
                <p>Loading your saved payment instructions…</p>
              )}
              {intent === "signin" && (
                <label>
                  Wallet network
                  <select
                    value={network}
                    disabled={busy}
                    onChange={(e) => {
                      setNetwork(e.target.value as Network);
                      setWallet(null);
                      setUri("");
                    }}
                  >
                    <option value="ethereum">Ethereum · personal wallet</option>
                    <option value="solana">Solana · personal wallet</option>
                  </select>
                </label>
              )}
              {!wallet ? (
                <div className="wallet-connect-options">
                  <button
                    className="quiet full"
                    disabled={busy || (intent === "payment" && !quote)}
                    onClick={() => void connectBrowser()}
                  >
                    Connect browser wallet
                  </button>
                  <button
                    className="quiet full"
                    disabled={busy || (intent === "payment" && !quote)}
                    onClick={() => void connectQr()}
                  >
                    WalletConnect · scan a QR
                  </button>
                  {qr && (
                    <div className="wallet-qr">
                      <img
                        src={qr}
                        width="280"
                        height="280"
                        alt="Scan with your wallet to connect"
                      />
                      <p>
                        Open WalletConnect in your wallet and scan this code.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className="fine">Connected wallet</p>
                  <code className="wallet-address">{wallet.address}</code>
                  <button
                    className="primary full"
                    disabled={
                      busy ||
                      (intent === "payment" &&
                        (!quote ||
                          Date.parse(quote.expires_at) <= now + 15_000))
                    }
                    onClick={() => void confirm()}
                  >
                    {busy
                      ? "Check your wallet…"
                      : intent === "signin"
                        ? "Sign in"
                        : "Confirm payment in wallet"}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setWallet(null)}
                  >
                    Choose another wallet
                  </button>
                </>
              )}
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              <p className="fine">
                {intent === "payment"
                  ? "This pays your current order. It does not change your sign-in account. You can close this window and use the manual transfer instructions instead."
                  : "Wallet sign-in creates a separate account from Google or GitHub. Use your original sign-in method to keep its existing reviews."}
              </p>
            </>
          )}
        </>
      )}
    </main>
  );
}
export async function mountWallet() {
  const root = createRoot(document.getElementById("root")!);
  try {
    const settings = await api<Settings>("/wallet/config");
    if (
      !settings.enabled ||
      !settings.project_id ||
      settings.origin !== location.origin
    )
      throw new Error("Wallet access is not configured on this address.");
    root.render(<WalletPage settings={settings} />);
  } catch {
    root.render(
      <main className="wallet-page">
        <h1>Wallet unavailable.</h1>
        <p>
          Close this window and use Google, GitHub or the manual payment
          instructions.
        </p>
      </main>,
    );
  }
}
