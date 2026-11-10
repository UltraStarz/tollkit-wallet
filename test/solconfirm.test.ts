/** Solana send-and-confirm by polling (src/solconfirm.ts). Fake connection; no network. */
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { JITO_ALONE_MS, pollSolana, sendAndConfirm } from "../src/solconfirm.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const kp = Keypair.generate();
const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
const conn = (statuses: any[], height = 10) => { let i = 0; const sent: Buffer[] = []; return { sent, c: {
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  sendRawTransaction: async (b: Buffer) => { sent.push(b); return "SIG"; },
  getSignatureStatuses: async () => ({ value: [statuses[Math.min(i++, statuses.length - 1)]] }),
  getBlockHeight: async () => height,
} as any }; };
const a = conn([null, { confirmationStatus: "processed" }, { confirmationStatus: "confirmed" }]);
check(await sendAndConfirm(a.c, tx(), [kp], { pollMs: 1 }) === "SIG" && a.sent.length === 2, "waits for confirmed, resending while the network hasn't seen it", a.sent.length);
const b = conn([{ err: { InstructionError: [0, "Custom"] } }]);
let e1 = ""; try { await sendAndConfirm(b.c, tx(), [kp], { pollMs: 1 }); } catch (e) { e1 = (e as Error).message; }
check(/failed/.test(e1), "a failed transaction throws");
const c = conn([null], 101);
let e2 = ""; try { await sendAndConfirm(c.c, tx(), [kp], { pollMs: 1 }); } catch (e) { e2 = (e as Error).message; }
check(/dropped this transaction \(SIG…SIG\), so nothing changed/.test(e2), "expired and never landed: says nothing changed", e2);
const d = conn([null, { confirmationStatus: "confirmed" }], 101);
check(await sendAndConfirm(d.c, tx(), [kp], { pollMs: 1 }) === "SIG", "expired but found on the last look: counts as done");
const f = conn([null, { err: { InstructionError: [0, "Custom"] } }], 101);
let e3 = ""; try { await sendAndConfirm(f.c, tx(), [kp], { pollMs: 1 }); } catch (e) { e3 = (e as Error).message; }
check(/failed/.test(e3) && !/nothing changed/.test(e3), "expired, last look shows it failed: says failed", e3);
const g = conn([null], 10);
let e4 = ""; try { await sendAndConfirm(g.c, tx(), [kp], { pollMs: 1, maxMs: 30 }); } catch (e) { e4 = (e as Error).message; }
check(/hasn't confirmed/.test(e4) && !/nothing changed/.test(e4), "not expired yet but out of time: doesn't claim nothing happened", e4);

// Nov 5: plain transactions pay a priority fee (going rate, kept in bounds) and try once more after being dropped.
{
  const t = tx(); const a2 = conn([null, { confirmationStatus: "confirmed" }]);
  a2.c.getRecentPrioritizationFees = async () => [{ prioritizationFee: 0 }, { prioritizationFee: 50_000 }, { prioritizationFee: 90_000 }, { prioritizationFee: 9_000_000 }];
  await sendAndConfirm(a2.c, t, [kp], { pollMs: 1 });
  const cb = t.instructions.filter((i) => i.programId.toBase58() === "ComputeBudget111111111111111111111111111111");
  const price = cb.length === 2 ? Number(cb[1]!.data.readBigUInt64LE(1)) : -1;
  check(cb.length === 2 && price === 2_000_000, "adds a unit limit and a priority price, capped at 2,000,000", price);
  const t2 = tx(); const a3 = conn([null]); a3.c.getRecentPrioritizationFees = async () => [];
  await sendAndConfirm(a3.c, t2, [kp], { pollMs: 1, maxMs: 1 }).catch(() => {});
  const p2 = Number(t2.instructions[1]!.data.readBigUInt64LE(1));
  check(p2 === 20_000, "no recent fees: the minimum price", p2);
  let calls = 0, h = 101; const st2: any[] = [null, null, { confirmationStatus: "confirmed" }]; let si = 0;
  const r: any = { getLatestBlockhash: async () => { calls++; return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; }, sendRawTransaction: async () => "SIG",
    getSignatureStatuses: async (_s: any, opt?: any) => ({ value: [calls >= 2 ? { confirmationStatus: "confirmed" } : null] }), getBlockHeight: async () => (calls >= 2 ? 10 : h) };
  check(await sendAndConfirm(r, tx(), [kp], { pollMs: 1 }) === "SIG" && calls === 2, "dropped once: tries again with a fresh blockhash and lands", calls);
  void st2; void si;
}

// 0.9.12: resends at every check until it lands; after JITO_ALONE_MS they go the normal way too.
{
  const sent: boolean[] = []; let i = 0, now = 1_000_000;
  const realNow = Date.now; Date.now = () => now;
  const st = [null, null, null, { confirmationStatus: "confirmed" }];
  const c2: any = { getSignatureStatuses: async () => ({ value: [st[Math.min(i++, st.length - 1)]] }), getBlockHeight: async () => 10 };
  const sig = await pollSolana(c2, "SIG", 100, "swap", { pollMs: 1, resend: async (direct) => { sent.push(direct); now += JITO_ALONE_MS / 2; } });
  Date.now = realNow;
  check(sig === "SIG" && sent.length === 3 && sent[0] === false && sent[2] === true, "resent at each check; the later resends go the normal way", sent);
  let thrown = false; i = 0;
  try { await pollSolana(c2, "SIG", 100, "swap", { pollMs: 1, resend: () => { throw new Error("no route"); } }); } catch { thrown = true; }
  check(!thrown, "a resend that fails doesn't stop the wait");
}
// Nov 7: a landed transaction isn't called dropped because one look didn't find it.
{
  const h = conn([null, null, { confirmationStatus: "finalized" }], 101);
  check(await sendAndConfirm(h.c, tx(), [kp], { pollMs: 1, settleMs: 1 } as any) === "SIG" && h.sent.length === 1, "unknown on the first history look, found on the second: done, not sent again", h.sent.length);
  const k = conn([null], 101); (k.c as any).getTransaction = async () => ({ slot: 5, meta: { err: null } });
  check(await sendAndConfirm(k.c, tx(), [kp], { pollMs: 1, settleMs: 1 } as any) === "SIG" && k.sent.length === 1, "history never shows it but the transaction is there: done, not sent again");
  const m = conn([null], 101); (m.c as any).getTransaction = async () => null;
  let e5 = ""; try { await sendAndConfirm(m.c, tx(), [kp], { pollMs: 1, settleMs: 1 } as any); } catch (e) { e5 = (e as Error).message; }
  check(/dropped/.test(e5), "nowhere to be found: still says dropped", e5);
}
// Nov 7 (data audit): a "dropped" error carries the full signature, so the record can be re-checked on the chain later.
{
  const m = conn([null], 101); (m.c as any).getTransaction = async () => null;
  let err: any = null; try { await sendAndConfirm(m.c, tx(), [kp], { pollMs: 1, settleMs: 1 } as any); } catch (e) { err = e; }
  check(err?.sig === "SIG", "the dropped error carries the signature", err?.sig);
  const { describeDeltas } = await import("../src/onchain.js");
  const name = (m: string) => (m.startsWith("EPj") ? "USDC" : m.slice(0, 4) + "…");
  check(describeDeltas({ sol: -0.000015, tokens: { Dz9mQ9: 25.2088, EPjFWdd5: -3.26 } }, name) === "3.26 USDC -> 25.2088 Dz9m…", "a swap's line is what actually moved", describeDeltas({ sol: -0.000015, tokens: { Dz9mQ9: 25.2088, EPjFWdd5: -3.26 } }, name));
  check(describeDeltas({ sol: -1.6985, tokens: { EPjFWdd5: 152.333651 } }, name) === "1.6985 SOL -> 152.3337 USDC", "selling SOL reads as SOL out, USDC in");
  check(describeDeltas({ sol: -0.00001, tokens: {} }, name) === null, "nothing traded: no line");
}
console.log(`\nsolconfirm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
