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
  const until = Date.now() + (o.maxMs ?? 90_000);
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Solana transaction ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (Date.now() > until || (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error(`Solana transaction ${sig} wasn't confirmed in time. Check it on an explorer before trying again.`);
    }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
  }
}
