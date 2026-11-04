import { Interface, getAddress, hexlify, toUtf8Bytes } from "ethers";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import type { Deposit } from "./Checkout";

/** Known native token contracts; display symbols alone never select a transfer. */
const assets: Record<
  string,
  { chain: "eth" | "sol"; address: string; symbol: string }
> = {
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": {
    chain: "eth",
    symbol: "USDC",
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near": {
    chain: "eth",
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": {
    chain: "sol",
    symbol: "USDC",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near": {
    chain: "sol",
    symbol: "USDT",
    address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};
export function walletAsset(quote: Deposit) {
  const asset = assets[quote.input.token.asset_id];
  if (
    !asset ||
    asset.chain !== quote.input.token.blockchain ||
    asset.symbol !== quote.input.token.symbol ||
    quote.input.token.decimals !== 6
  )
    throw new Error("Use the manual instructions for this token.");
  if (
    !Number.isFinite(Date.parse(quote.expires_at)) ||
    Date.parse(quote.expires_at) <= Date.now() + 15_000
  )
    throw new Error(
      "This quote is too close to expiry. Open the order for fresh instructions.",
    );
  if (!/^[1-9][0-9]{0,77}$/.test(quote.input.amount))
    throw new Error("Invalid payment amount.");
  return asset;
}
export function ethereumTransfer(quote: Deposit, from: string) {
  const asset = walletAsset(quote);
  if (asset.chain !== "eth" || quote.deposit_memo !== null)
    throw new Error("Unexpected Ethereum payment details.");
  return {
    chainId: "0x1",
    from: getAddress(from),
    to: getAddress(asset.address),
    value: "0x0",
    data: new Interface([
      "function transfer(address to,uint256 amount) returns(bool)",
    ]).encodeFunctionData("transfer", [
      getAddress(quote.deposit_address),
      BigInt(quote.input.amount),
    ]),
  };
}
const tokenProgram = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const associatedProgram = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
function ata(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    associatedProgram,
  )[0];
}
/** Only an idempotent destination token-account creation and a checked SPL transfer. */
export function solanaTransfer(
  quote: Deposit,
  from: string,
  blockhash: string,
) {
  const asset = walletAsset(quote);
  const amount = BigInt(quote.input.amount);
  if (asset.chain !== "sol" || amount > 0xffffffffffffffffn)
    throw new Error("Unexpected Solana payment details.");
  const payer = new PublicKey(from),
    owner = new PublicKey(quote.deposit_address),
    mint = new PublicKey(asset.address),
    source = ata(payer, mint),
    destination = ata(owner, mint);
  if (
    !PublicKey.isOnCurve(payer.toBytes()) ||
    !PublicKey.isOnCurve(owner.toBytes())
  )
    throw new Error("Use a normal wallet address for this transfer.");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  tx.add(
    new TransactionInstruction({
      programId: associatedProgram,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }),
  );
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  tx.add(
    new TransactionInstruction({
      programId: tokenProgram,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: false },
      ],
      data,
    }),
  );
  if (quote.deposit_memo !== null) {
    if (
      new TextEncoder().encode(quote.deposit_memo).length > 100 ||
      /[\u0000-\u001f]/.test(quote.deposit_memo)
    )
      throw new Error("Use manual instructions for this payment memo.");
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [],
        data: Buffer.from(quote.deposit_memo, "utf8"),
      }),
    );
  }
  return tx;
}
export const messageHex = (message: string) => hexlify(toUtf8Bytes(message));
