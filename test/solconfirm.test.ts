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
check(/still waiting/.test(e4) && !/nothing changed/.test(e4), "not expired yet but out of time: doesn't claim nothing happened", e4);

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
console.log(`\nsolconfirm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
