/**
 * Send a Solana transaction and wait for it by polling, without websockets.
 *
 * web3.js's sendAndConfirmTransaction waits on a websocket signature subscription. The browser extension reaches
 * Solana through Tollkit's HTTP-only RPC route (Solana's public endpoint refuses extensions), where no websocket
 * exists, so confirmation would never arrive. This polls getSignatureStatuses instead, and gives up once the
 * transaction's blockhash can no longer land (getBlockHeight past lastValidBlockHeight).
 */
import { ComputeBudgetProgram, type Connection, type Keypair, type Transaction } from "@solana/web3.js";

/**
 * Nov 5: plain transactions (the Run 24/7 allowance, sends, staking) now pay a priority fee like swaps do. Without
 * one they were often dropped while Solana was busy ("Couldn't set the allowance: ... dropped"). The price is the
 * recent going rate for the accounts it writes (75th percentile), kept between 20,000 and 2,000,000 micro-lamports
 * per unit with a 300,000-unit limit: at most 0.0006 SOL, usually far less.
 */
export const PRIO_UNITS = 300_000, PRIO_MIN = 20_000, PRIO_MAX = 2_000_000;
export async function priorityPrice(conn: Connection, tx: Transaction): Promise<number> {
  try {
    const keys = [...new Set(tx.instructions.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))].slice(0, 128);
    const { PublicKey } = await import("@solana/web3.js");
    const fees = (await (conn as any).getRecentPrioritizationFees({ lockedWritableAccounts: keys.map((k) => new PublicKey(k)) })) as { prioritizationFee: number }[];
    const v = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.75)]! : 0;
    return Math.min(PRIO_MAX, Math.max(PRIO_MIN, Math.ceil(p * 1.2)));
  } catch { return PRIO_MIN * 5; }
}

export async function sendAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[], o: { pollMs?: number; maxMs?: number } = {}): Promise<string> {
  if (!tx.instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId))) {
    const price = await priorityPrice(conn, tx);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: PRIO_UNITS }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  }
  if (!tx.feePayer) tx.feePayer = signers[0]!.publicKey;
  // Nov 5: dropped means nothing happened (its blockhash expired), so try once more with a fresh one before saying so.
  for (let attempt = 0; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(...signers);
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 3 });
    try { return await pollSolana(conn, sig, lastValidBlockHeight, "transaction", { ...o, resend: () => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }) }); }
    catch (e) { if (attempt >= 1 || !/network dropped/.test((e as Error).message)) throw e; }
  }
}

/** How long a swap goes only through Jito before its resends also go the normal way (see pollSolana's `resend`). */
export const JITO_ALONE_MS = 10_000;

/**
 * Wait for a sent Solana transaction. 0.9.3: when the network drops it, wait until its blockhash has expired and
 * check once more, so the wallet can say for certain that nothing happened instead of "check an explorer".
 */
export async function pollSolana(conn: Connection, sig: string, lastValidBlockHeight: number, what: string,
  o: { pollMs?: number; maxMs?: number; resend?: (direct: boolean) => Promise<unknown> } = {}): Promise<string> {
  // 0.9.12: `resend` sends the same signed transaction again at every check until it lands or its blockhash expires
  // (a single send was dropped about 1 in 3 times on Nov 3); `direct` turns true once JITO_ALONE_MS has passed.
  const t0 = Date.now(), until = t0 + (o.maxMs ?? 150_000), short = `${sig.slice(0, 6)}…${sig.slice(-4)}`;
  const done = (st: any) => st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Solana ${what} ${sig} failed: ${JSON.stringify(st.err)}`);
    if (done(st)) return sig;
    const expired = (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight;
    if (expired) {
      const last = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (last?.err) throw new Error(`Solana ${what} ${sig} failed: ${JSON.stringify(last.err)}`);
      if (done(last)) return sig;
      throw new Error(`The Solana network dropped this ${what} (${short}), so nothing changed in your wallet. It's safe to try again.`);
    }
    if (Date.now() > until) throw new Error(`Solana ${what} ${sig} is still waiting for the network. Check it on an explorer before trying again.`);
    if (o.resend && !st) try { await o.resend(Date.now() - t0 >= JITO_ALONE_MS); } catch { /* the next check tries again */ }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
  }
}
