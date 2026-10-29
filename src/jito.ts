/**
 * 0.9.9: private sending on Solana. Swaps the wallet builds itself carry a small Jito tip with Jito's "dontfront"
 * marker; Tollkit's Solana route (x402-starter src/solana-rpc-proxy.ts) sends those through Jito's block engine, which
 * only lands them at the front of a bundle, so nothing can be placed before them to sandwich them. Constants copied
 * from x402-starter src/jito.ts (sources there); keep the two in step.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

export const DONT_FRONT = "jitodontfront111111111111111111111111111111";
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
/** 10,000 lamports (0.00001 SOL) a protected swap, ten times Jito's minimum. */
export const JITO_TIP_LAMPORTS = 10_000n;

/** The tip transfer, with the dontfront marker on it (a read-only, non-signer account). */
export function jitoTipIx(payer: PublicKey, rand = Math.random): TransactionInstruction {
  const to = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(rand() * JITO_TIP_ACCOUNTS.length) % JITO_TIP_ACCOUNTS.length]!);
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: JITO_TIP_LAMPORTS });
  ix.keys.push({ pubkey: new PublicKey(DONT_FRONT), isSigner: false, isWritable: false });
  return ix;
}
