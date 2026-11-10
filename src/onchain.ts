/**
 * Nov 7 (Joe: "I want a data audit, is our data correct"): what a Solana transaction actually did to this wallet,
 * read from the chain, so the records follow the chain instead of what the wallet guessed at the time.
 *
 * The audit found two swaps recorded as "the network dropped this swap" that had landed (bought 25.21 and 25.16 of a
 * coin for $3.26 each), so no bot owned the coins. reconcileDropped() re-checks such records against the chain and
 * fixes both the receipt and the bot's fill. swapDeltas() gives the real amounts for a receipt's line.
 */
import { Connection } from "@solana/web3.js";

export interface Deltas { sol: number; tokens: Record<string, number>; decimals?: Record<string, number> }

/** What a landed transaction changed for `owner`: SOL (after the network fee) and each token, by mint. Null: not found or failed. */
export async function txDeltas(conn: Connection, owner: string, sig: string): Promise<Deltas | null> {
  const t: any = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!t?.meta || t.meta.err) return null;
  const keys: string[] = t.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey?.toBase58?.() ?? String(k.pubkey)));
  const i = keys.indexOf(owner);
  const sol = i >= 0 ? (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 : 0;
  const tokens: Record<string, number> = {}, decimals: Record<string, number> = {};
  const add = (list: any[], sign: number) => { for (const b of list ?? []) if (b.owner === owner) { tokens[b.mint] = (tokens[b.mint] ?? 0) + sign * Number(b.uiTokenAmount?.uiAmountString ?? 0); if (typeof b.uiTokenAmount?.decimals === "number") decimals[b.mint] = b.uiTokenAmount.decimals; } };
  add(t.meta.postTokenBalances, 1); add(t.meta.preTokenBalances, -1);
  for (const k of Object.keys(tokens)) if (Math.abs(tokens[k]!) < 1e-12) delete tokens[k];
  return { sol, tokens, decimals };
}

/** A full signature from the short form the wallet shows ("5MjWSg…1Qux"), among this wallet's recent transactions. */
export async function findSig(conn: Connection, owner: string, short: string): Promise<string | null> {
  const m = /^([1-9A-HJ-NP-Za-km-z]{4,})…([1-9A-HJ-NP-Za-km-z]{3,})$/.exec(short);
  if (!m) return null;
  const { PublicKey } = await import("@solana/web3.js");
  const list = await conn.getSignaturesForAddress(new PublicKey(owner), { limit: 200 }).catch(() => []);
  const hit = list.find((s) => s.signature.startsWith(m[1]!) && s.signature.endsWith(m[2]!));
  return hit ? hit.signature : null;
}

/** "3.26 USDC -> 25.47 Dz9m…": the line for a receipt, from what actually moved. */
export function describeDeltas(d: Deltas, name: (mint: string) => string): string | null {
  const out = Object.entries(d.tokens).filter(([, v]) => v < 0), inn = Object.entries(d.tokens).filter(([, v]) => v > 0);
  const fmt = (v: number) => Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 4 });
  // Native SOL counts when it moved more than a network fee would.
  if (d.sol < -0.001) out.push(["SOL", d.sol]); else if (d.sol > 0.001) inn.push(["SOL", d.sol]);
  if (!out.length || !inn.length) return null;
  const side = (L: [string, number][]) => L.map(([k, v]) => `${fmt(v)} ${k === "SOL" ? "SOL" : name(k)}`).join(" + ");
  return `${side(out)} -> ${side(inn)}`;
}
