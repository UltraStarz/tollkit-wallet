/** Live watcher on Solana (0.9.2): a failed balance read is not a deposit, and nothing without a transaction is shown as one. Local fake RPC. */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { Watcher } from "../src/watch.js";
import { walletHome } from "../src/paths.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const ME = Keypair.generate().publicKey.toBase58();
const chain = { usdc: 6_873_761n, failUsdc: false, sigs: [] as any[] };
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const { id, method } = JSON.parse(b), ok = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    res.setHeader("content-type", "application/json");
    if (method === "getSlot") return ok(1000);
    if (method === "getBalance") return ok({ context: { slot: 1000 }, value: 50_000_000 });
    if (method === "getTokenAccountBalance") {
      if (chain.failUsdc) return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: upstream timeout" } }));
      return ok({ context: { slot: 1000 }, value: { amount: String(chain.usdc), decimals: 6, uiAmount: Number(chain.usdc) / 1e6, uiAmountString: "" } });
    }
    if (method === "getSignaturesForAddress") return ok(chain.sigs);
    if (method === "getSignatureStatuses") return ok({ context: { slot: 1000 }, value: [] });
    ok(null);
  });
});
await new Promise<void>((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${(srv.address() as any).port}`;
const dir = mkdtempSync(path.join(os.tmpdir(), "tws-"));
// An old phantom saved by the earlier version: a Solana deposit with no transaction.
mkdirSync(walletHome(dir), { recursive: true });
writeFileSync(path.join(walletHome(dir), "live.json"), JSON.stringify([{ id: "solana:x:1", chain: "solana", direction: "in", token: "USDC", amount: "6.873761", first_seen: "2026-10-21T11:16:00Z", status: "confirmed", confirmations: 0 }]));
const wallet: any = { dir, policy: { chains: ["solana"] }, addresses: { solana: ME }, receipts: () => [] };
const w = new Watcher(wallet, { rpc: { solana: url } });
check(w.events().length === 0, "an old deposit saved with no transaction is dropped (it could never confirm)");
await w.poll();
check(w.balances().solana!.some((b) => b.token === "USDC" && b.amount === "6.873761"), "first look records the balance");
chain.failUsdc = true; await w.poll();
check(w.balances().solana!.find((b) => b.token === "USDC")!.amount === "6.873761", "a failed read keeps the last balance instead of 0");
chain.failUsdc = false; await w.poll();
check(w.events().length === 0, "so the next good read isn't a fake deposit of everything", w.events());
chain.usdc += 1_000_000n; await w.poll();
check(w.events().length === 0, "a rise with no transaction behind it isn't shown as a deposit");
chain.usdc += 2_000_000n; chain.sigs = [{ signature: "Sig1111111111111111111111111111111111111111111", slot: 999, err: null, memo: null, blockTime: 1792580000, confirmationStatus: "confirmed" }]; await w.poll();
const e = w.events()[0];
check(w.events().length === 1 && e?.tx === chain.sigs[0].signature && Number(e.amount) === 2, "a real deposit (with its transaction) still shows", w.events());
srv.close();
console.log(`\nwatchsol: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
