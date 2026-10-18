/** "Keep running when closed", the parts that run on the device: slip encodings (checked against @metamask/delegation-core 3.0.0 output), which rules can run, and recording the server's fills. The full flow on a copy of Base is checked separately (anvil fork). */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet, verifyTypedData } from "ethers";
import { C, DF, ROOT_AUTHORITY, encodeDelegations, signDelegation, execution } from "../src/delegation.js";
import { serverRunnable, applyFills } from "../src/alwayson.js";
import { RuleStore } from "../src/rules.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const V = {"targets":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA029131111111111111111111111111111111111111111","methods":"0x2213bc0b","valueLte":"0x0000000000000000000000000000000000000000000000000000000000003039","erc20Inc":"0x00833589fcd6edb6e08f4c7c32d4f71b54bda0291311111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000989680","erc20Dec":"0x01833589fcd6edb6e08f4c7c32d4f71b54bda0291311111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000989680","nativeInc":"0x001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000e35fa931a0000","timestamp":"0x00000000000000000000000068e7780000000000000000000000000068e8c980","limited":"0x0000000000000000000000000000000000000000000000000000000000000003","exact":"0xdeadbeef","nonce":"0x0000000000000000000000000000000000000000000000000000000000000005","encoded":"0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002abcd000000000000000000000000000000000000000000000000000000000000"};
const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", T = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const low = (x: string) => x.toLowerCase();

check(low(C.targets([T, A]).terms) === low(V.targets), "allowed targets encode like MetaMask's library");
check(C.methods(["0x2213bc0b"]).terms === V.methods, "allowed methods");
check(C.valueLte(12345n).terms === V.valueLte, "max value");
check(low(C.erc20Change(T, A, 10_000_000n, 0).terms) === V.erc20Inc && low(C.erc20Change(T, A, 10_000_000n, 1).terms) === V.erc20Dec, "token balance must rise / may fall by at most");
check(low(C.nativeChange(A, 4_000_000_000_000_000n, 0).terms) === V.nativeInc, "ETH balance must rise");
check(C.timestamp(1760000000, 1760086400).terms === V.timestamp, "time window");
check(C.limitedCalls(3).terms === V.limited && C.exactCalldata("0xdeadbeef").terms === V.exact && C.nonce(5n).terms === V.nonce, "call count, exact call, nonce");
check(low(encodeDelegations([{ delegate: A, delegator: B, authority: ROOT_AUTHORITY, caveats: [{ enforcer: T, terms: "0x01", args: "0x" }], salt: 7n, signature: "0xabcd" }])) === low(V.encoded), "the permission context encodes like MetaMask's library");
check(C.targets([A]).enforcer === DF.AllowedTargetsEnforcer && execution(A, "0xdeadbeef").length === 2 + 2 * (20 + 32 + 4), "enforcer addresses and the single-call encoding");

// The user's own key signs, over the DelegationManager's EIP-712 domain.
const key = Wallet.createRandom();
const d = await signDelegation(key, 8453, A, [C.limitedCalls(1)], 9n);
const who = verifyTypedData({ name: "DelegationManager", version: "1", chainId: 8453, verifyingContract: DF.DelegationManager },
  { Delegation: [{ name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" }, { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" }], Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }] },
  { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })), salt: d.salt }, d.signature);
check(who === key.address && d.delegator === key.address, "a slip is signed by the wallet's own key, naming the server as delegate");

// Which rules the server can run.
const rule = (x: any) => ({ id: "r1", status: "active", created_by: "owner", created_at: "", state: { runs: 0, failures: 0, fills: [] }, chain: "base", token: "ETH", ...x });
check(serverRunnable(rule({ kind: "dca", amount_usd: 10, every: "day" }), ["base"]) === null, "a recurring ETH buy on Base can run while closed");
check(/Solana/.test(serverRunnable(rule({ kind: "dca", amount_usd: 10, every: "day", chain: "solana", token: "SOL" }), ["base"]) ?? ""), "Solana rules stay on the device");
check(/ETH rules/.test(serverRunnable(rule({ kind: "dca", amount_usd: 10, every: "day", token: "WETH" }), ["base"]) ?? ""), "only ETH for now");
check(/kind of rule/.test(serverRunnable(rule({ kind: "trailing_stop", trail_pct: 5, sell_percent: 50 }), ["base"]) ?? ""), "trailing stops stay on the device");
check(/another rule/.test(serverRunnable(rule({ kind: "take_profit", trigger_price: 5000, sell_from: "x" }), ["base"]) ?? ""), "bot steps that wait for another rule stay on the device");

// Recording the server's fills: once, with the schedule moved on and partners cancelled.
const dir = mkdtempSync(path.join(os.tmpdir(), "ao-"));
const store = new RuleStore(dir);
const dca = await store.add({ kind: "dca", chain: "base", token: "ETH", amount_usd: 10, every: "day" }, "owner", true);
const tp = await store.add({ kind: "take_profit", chain: "base", token: "ETH", sell_percent: 50, trigger_price: 9000, group: "g1" }, "owner", true);
const sl = await store.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 50, trigger_price: 1000, group: "g1" }, "owner", true);
const ts = "2026-10-18T12:00:00.000Z";
const fills = [{ rule_id: dca.id, ts, ok: true, tx: "0xaa", usd: 10, units: 0.004, side: "buy" as const }, { rule_id: sl.id, ts, ok: true, tx: "0xbb", usd: 3, units: 0.001, side: "sell" as const }];
await applyFills(store, fills); await applyFills(store, fills);
const a = store.get(dca.id)!, b = store.get(sl.id)!, c = store.get(tp.id)!;
check(a.state.runs === 1 && a.state.next_run === "2026-10-19T12:00:00.000Z" && a.state.spent_usd === 10, "a server buy is recorded once, and the next one is tomorrow", a.state);
check(b.status === "done" && c.status === "cancelled", "a filled stop-loss cancels its take-profit partner", [b.status, c.status]);

console.log(`\nalwayson: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
