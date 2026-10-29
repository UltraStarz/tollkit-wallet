/** 0.9.9: the runner lease (src/devsync.ts mayTrade) and Autopilot's conflict gate (src/conflict.ts). */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { DeviceSync, RUNNER_LEASE_MS } from "../src/devsync.js";
import { clashWithOwner, ownerFlow, strategyFlow } from "../src/conflict.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d)); } };

// ─── the lease ──────────────────────────────────────────────────────────────
const key = Wallet.createRandom();
const store = { rev: 0, blob: null as string | null };
let down = false;
const server = (async (url: string, init: any) => {
  if (down) return new Response("{}", { status: 503 });
  const route = String(url).split("/").pop()!, b = JSON.parse(String(init.body));
  if (route === "get") return new Response(JSON.stringify(store));
  if (b.base_rev !== store.rev) return new Response(JSON.stringify({ error: "stale", rev: store.rev }), { status: 412 });
  store.rev++; store.blob = b.blob; return new Response(JSON.stringify({ rev: store.rev }));
}) as any;
let clock = Date.parse("2026-10-29T12:00:00Z");
const dev = (name: string) => { const dir = mkdtempSync(path.join(os.tmpdir(), `lease-${name}-`)); writeFileSync(path.join(dir, "rules.json"), "[]"); return new DeviceSync({ dir, address: key.address, key: () => key, proxy: "https://x/wallet", fetch: server, deviceName: name, now: () => clock }); };
const A = dev("Chrome"), B = dev("iPhone");
await A.turnOn();
check(A.mayTrade(), "one device alone trades as before");
await B.turnOn(); await A.sync();
check(A.mayTrade() && !B.mayTrade(), "two devices: the runner trades, the other doesn't");

// B takes the bots. A hasn't synced yet, so it still thinks it runs them, but B waits out the lease.
await B.runHere();
check(B.runsHere() && !B.mayTrade(), "the new runner waits before its first trade");
const t0 = clock;
let overlap = false;
for (let s = 0; s <= 6 * 60; s += 15) {
  clock = t0 + s * 1000;
  if (s % 60 === 0 && s > 0) { await A.sync().catch(() => {}); await B.sync().catch(() => {}); } // both sync each minute
  if (A.mayTrade() && B.mayTrade()) overlap = true;
}
check(!overlap, "no moment where both may trade, checked every 15 s for 6 minutes");
check(B.mayTrade() && !A.mayTrade(), "after the lease, the new runner trades and the old one has stopped");

// The old runner can't reach the server at all: its confirmation runs out, so it stops on its own.
await A.runHere(); clock += RUNNER_LEASE_MS + 1000; await A.sync(); await B.sync();
check(A.mayTrade() && !B.mayTrade(), "back on Chrome after its wait");
down = true; clock += RUNNER_LEASE_MS + 1000;
check(!A.mayTrade(), "a runner that can't confirm for 3 minutes stops trading (another device may have taken over)");
down = false;

// ─── the conflict gate ──────────────────────────────────────────────────────
const r = (x: any) => ({ id: "r", status: "active", created_by: "owner", created_at: "", state: { runs: 0, failures: 0, fills: [] }, chain: "solana", token: "SOL", ...x });
check(strategyFlow("dca", { amount_usd: 5, every: "hour" }) === 120 && strategyFlow("grid", { amount_usd: 20 }) === 0 && strategyFlow("dip", { amount_usd: 25 }) === 25, "Δₐ: $5 an hour is $120 a day; a grid trades both ways (0)");
const sellingSol = [r({ kind: "twap", side: "sell", amount_usd: 200 })];
check(ownerFlow(sellingSol, "solana", "SOL", 100) === -200, "Δₒ: your split sell is −$200");
check(/buy about \$120 a day while your own rules sell about \$200/.test(clashWithOwner("dca", { amount_usd: 5, every: "hour" }, sellingSol as any, "solana", "SOL", 100) ?? ""), "Autopilot won't buy SOL while you're selling it", clashWithOwner("dca", { amount_usd: 5, every: "hour" }, sellingSol as any, "solana", "SOL", 100));
check(clashWithOwner("dca", { amount_usd: 5, every: "day" }, sellingSol as any, "solana", "SOL", 100) === null, "a small buyer under a quarter of your selling is let through (|Δₐ| < 0.25·|Δₒ|)");
check(clashWithOwner("grid", { amount_usd: 20 }, sellingSol as any, "solana", "SOL", 100) === null, "a grid is two-sided, never a clash");
const stops = [r({ kind: "stop_loss", sell_amount: "5", trigger_price: 99 }), r({ kind: "take_profit", sell_amount: "1", trigger_price: 150 })];
check(clashWithOwner("dip", { amount_usd: 25 }, stops as any, "solana", "SOL", 100) === null, "stops and far-off take-profits are protection, not a plan to sell");
const tpNear = [r({ kind: "take_profit", sell_amount: "1", trigger_price: 101 })];
check(clashWithOwner("dip", { amount_usd: 50 }, tpNear as any, "solana", "SOL", 100) !== null, "a take-profit 1% away is about to sell: buying into it is refused");
check(clashWithOwner("dca", { amount_usd: 5, every: "hour" }, [r({ kind: "twap", side: "sell", amount_usd: 200, by: "superbot" })] as any, "solana", "SOL", 100) === null, "Autopilot's own rules aren't the owner's");

console.log(`\nlease: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
