/** Live watcher: deposits with tx and confirmations, own swaps not counted as deposits, outgoing confirmations up to final. Fake RPC. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Watcher } from "../src/watch.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const ME = "0x6b11C413f916eCFA846302ff05c171c3B497924e";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DEP = "0x" + "d".repeat(64), SWAP = "0x" + "5".repeat(64), WD = "0x" + "a".repeat(64);
const chain = { head: 1000, finalized: 900, eth: 0n, usdc: 0n, logs: [] as any[], receipts: {} as Record<string, any>, calls: [] as string[] };
const hex = (n: bigint | number) => "0x" + n.toString(16);
const rpc = (async (url: string, init: any) => {
  const { method, params } = JSON.parse(init.body); chain.calls.push(`${new URL(url).host} ${method}`);
  const result = method === "eth_blockNumber" ? hex(chain.head)
    : method === "eth_getBlockByNumber" ? { number: hex(chain.finalized) }
    : method === "eth_getBalance" ? hex(chain.eth)
    : method === "eth_call" ? hex(chain.usdc)
    : method === "eth_getLogs" ? chain.logs
    : method === "eth_getTransactionReceipt" ? chain.receipts[params[0]] ?? null : null;
  return Response.json({ jsonrpc: "2.0", id: 1, result });
}) as unknown as typeof fetch;
let ledger: any[] = [];
const wallet: any = { dir: mkdtempSync(path.join(os.tmpdir(), "tww-")), policy: { chains: ["base"] }, addresses: { evm: ME }, receipts: () => ledger };
const w = new Watcher(wallet, { fetch: rpc, rpc: { base: "https://rpc.example" }, logsRpc: { base: "https://logs.example" } });

await w.poll();
check(w.events().length === 0 && w.balances().base!.length === 2, "first look only records balances");
chain.head = 1003; chain.usdc = 2_000_000n;
chain.logs = [{ transactionHash: DEP, blockNumber: hex(1002), topics: ["t", "0x000000000000000000000000bbfce2d320de6ab328ba93a771c531ebfc9ce704", "x"] }];
await w.poll();
let e = w.events()[0]!;
check(e?.direction === "in" && e.token === "USDC" && e.amount === "2.0" && e.tx === DEP && e.from === "0xbbfce2d320de6ab328ba93a771c531ebfc9ce704", "deposit: amount, tx and sender", e);
check(e.confirmations === 2 && e.status === "confirmed", "deposit: 2 blocks deep", e.confirmations);
check(chain.calls.some((c) => c === "logs.example eth_getLogs") && !chain.calls.some((c) => c === "rpc.example eth_getLogs"), "logs go to the logs RPC (mainnet.base.org refuses them)");
chain.head = 1010; await w.poll();
check(w.events()[0]!.confirmations === 9, "confirmations count up", w.events()[0]!.confirmations);
chain.finalized = 1002; await w.poll();
check(w.events()[0]!.status === "final", "final once the finalized block passes it");

// our own swap output is not a deposit; the swap shows as outgoing with confirmations
ledger = [{ id: "s1", ts: new Date().toISOString(), kind: "trade", status: "done", usd: 1, chain: "base", tx: SWAP, detail: "1 USDC -> at least 0.0004 ETH" }];
chain.head = 1012; chain.eth = 400000000000000n; chain.usdc = 1_000_000n; chain.receipts[SWAP] = { status: "0x1", blockNumber: hex(1011) };
await w.poll();
const ins = w.events().filter((x) => x.direction === "in");
check(ins.length === 1, "ETH from our own swap isn't reported as a deposit", ins.map((x) => x.token));
const sw = w.events().find((x) => x.tx === SWAP)!;
check(sw?.direction === "out" && sw.label === "Swap" && sw.confirmations === 2 && sw.status === "confirmed", "swap: outgoing, 2 confirmations", sw);

// a failed withdrawal
ledger.push({ id: "w1", ts: new Date().toISOString(), kind: "withdrawal", status: "done", usd: 1, chain: "base", tx: WD, detail: "1 USDC -> 0xbb" });
chain.receipts[WD] = { status: "0x0", blockNumber: hex(1012) };
await w.poll();
check(w.events().find((x) => x.tx === WD)?.status === "failed", "reverted transaction shows as failed");

// RPC down: no crash, no fake events
const before = 0;
const down = new Watcher({ ...wallet, dir: mkdtempSync(path.join(os.tmpdir(), "twd-")) }, { fetch: (async () => { throw new Error("offline"); }) as any, rpc: { base: "https://rpc.example" } });
let threw = false; try { await down.poll(); await down.poll(); } catch { threw = true; }
check(!threw && down.events().length === before, "RPC down: no crash, no events invented", down.events().length);

console.log(`\nwatch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
