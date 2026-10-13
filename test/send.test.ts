/** Owner withdrawals: password, address checks, sanctions, receipts. Sender faked; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { KNOWN } from "../src/tokens.js";
import { checkDestination } from "../src/send.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const dir = mkdtempSync(path.join(os.tmpdir(), "tws-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const sent: any[] = [];
const BAD = "0x8589427373D6D84E98730D7795D8f6f8731FDA16";
const w = await TollkitWallet.open(PW, { dir, approve: null, send: async (r) => { sent.push(r); return "0xsent"; } });
(w.sanctions as any).isSanctioned = async (a: string) => a.toLowerCase() === BAD.toLowerCase();

const to = "0x2222222222222222222222222222222222222222";
const unsaved = await w.withdraw(PW, "base", KNOWN.base.USDC!, to, "5000000");
check(unsaved.refused?.code === "not_saved" && sent.length === 0, "address not saved yet: refused", unsaved.refused);
let em = ""; try { await w.saveWithdrawAddress("nope nope nope", "base", to); } catch (x: any) { em = x.message; }
check(em === "wrong password", "saving an address needs the password");
em = ""; try { await w.saveWithdrawAddress(PW, "base", BAD, "bad"); } catch (x: any) { em = x.message; }
check(/sanctions/.test(em), "a sanctioned address can't be saved");
await w.saveWithdrawAddress(PW, "base", to, "my coinbase");
await w.saveWithdrawAddress(PW, "base", "0x3333333333333333333333333333333333333333", "other");
check(w.policy.withdraw_addresses.length === 2, "two addresses saved");
const again = await TollkitWallet.open(PW, { dir });
check(again.policy.withdraw_addresses[0]?.label === "my coinbase", "saved addresses persist, sealed with the policy");
const r = await w.withdraw(PW, "base", KNOWN.base.USDC!, to, "5000000");
check(r.ok && r.tx === "0xsent" && sent.length === 1 && sent[0].amount === "5000000", "owner withdraws 5 USDC on Base", r);
const e = w.receipts().at(-1)!;
check(e.kind === "withdrawal" && e.status === "done" && e.usd === 5 && e.seller === to, "withdrawal receipt logged", e);
check(w.status().spent_today.trades_usd === 0 && w.status().spent_today.payments_usd === 0, "withdrawals don't use the agent's budgets");
check((await w.withdraw("nope nope nope", "base", KNOWN.base.USDC!, to, "1")).refused?.code === "wrong_password", "needs the password");
check((await w.withdraw(PW, "ethereum", KNOWN.ethereum.USDC!, to, "1")).refused?.code === "not_saved", "saved on Base doesn't mean saved on Ethereum");
w.removeWithdrawAddress(PW, "base", to);
check((await w.withdraw(PW, "base", KNOWN.base.USDC!, to, "1")).refused?.code === "not_saved", "removed address refused");
await w.saveWithdrawAddress(PW, "base", to, "my coinbase");
check((await w.withdraw(PW, "base", KNOWN.base.USDC!, "0x123", "1")).refused?.code === "bad_address", "bad EVM address refused");
check((await w.withdraw(PW, "solana", KNOWN.solana.USDC!, to, "1")).refused?.code === "bad_address", "EVM address on Solana refused");
check((await w.withdraw(PW, "base", KNOWN.base.USDC!, to, "0")).refused?.code === "bad_amount", "zero refused");
const sol = Keypair.generate().publicKey.toBase58();
check(checkDestination("solana", sol) === sol, "regular Solana address accepted");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey("11111111111111111111111111111111"));
let m = ""; try { checkDestination("solana", pda.toBase58()); } catch (x: any) { m = x.message; }
check(/regular Solana wallet/.test(m), "program-derived (off-curve) addresses refused", m);
check(sent.length === 1, "nothing else was sent");
console.log(`\nsend: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
