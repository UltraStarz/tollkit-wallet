/**
 * Send a Solana transaction and wait for it by polling, without websockets.
 *
 * web3.js's sendAndConfirmTransaction waits on a websocket signature subscription. The browser extension reaches
 * Solana through Tollkit's HTTP-only RPC route (Solana's public endpoint refuses extensions), where no websocket
 * exists, so confirmation would never arrive. This polls getSignatureStatuses instead, and gives up once the
 * transaction's blockhash can no longer land (getBlockHeight past lastValidBlockHeight).
 */
import type { Connection, Keypair, Transaction } from "@solana/web3.js";

export async function sendAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[], o: { pollMs?: number; maxMs?: number } = {}): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  if (!tx.feePayer) tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
  return pollSolana(conn, sig, lastValidBlockHeight, "transaction", o);
}

/**
 * Wait for a sent Solana transaction. 0.9.3: when the network drops it, wait until its blockhash has expired and
 * check once more, so the wallet can say for certain that nothing happened instead of "check an explorer".
 */
export async function pollSolana(conn: Connection, sig: string, lastValidBlockHeight: number, what: string, o: { pollMs?: number; maxMs?: number } = {}): Promise<string> {
  const until = Date.now() + (o.maxMs ?? 150_000), short = `${sig.slice(0, 6)}…${sig.slice(-4)}`;
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
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
  }
}
