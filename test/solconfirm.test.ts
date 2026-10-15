/** Solana send-and-confirm by polling (src/solconfirm.ts). Fake connection; no network. */
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { sendAndConfirm } from "../src/solconfirm.js";

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
check(await sendAndConfirm(a.c, tx(), [kp], { pollMs: 1 }) === "SIG" && a.sent.length === 1, "waits for confirmed, sends once");
const b = conn([{ err: { InstructionError: [0, "Custom"] } }]);
let e1 = ""; try { await sendAndConfirm(b.c, tx(), [kp], { pollMs: 1 }); } catch (e) { e1 = (e as Error).message; }
check(/failed/.test(e1), "a failed transaction throws");
const c = conn([null], 101);
let e2 = ""; try { await sendAndConfirm(c.c, tx(), [kp], { pollMs: 1 }); } catch (e) { e2 = (e as Error).message; }
check(/wasn't confirmed in time/.test(e2), "gives up once the blockhash expires");
console.log(`\nsolconfirm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
