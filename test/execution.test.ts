/** Phase 4 (Nov 11, 2026): trade costs from decision to fill, and the slippage limit they give. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPT, adaptiveSlippage, shortfallBps, shortfallStats, type FillLike } from "../src/execution.js";
import { Autopilot } from "../src/autopilot.js";
import { RuleStore } from "../src/rules.js";
import { tradeCosts } from "../src/superbot.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const near = (a: number | undefined, b: number, tol = 0.05) => a !== undefined && Math.abs(a - b) <= tol;

// A buy at $100 that paid $10.02 for 0.1 coin: 20 bps worse. Its $0.01 fee was inside (10 bps), so 10 bps without it.
const b = shortfallBps({ ts: "2026-11-11T00:00:00Z", ok: true, side: "buy", usd: 10.02, units: 0.1, px: 100, fee: 0.01 })!;
check(near(b.total, 20) && near(b.ex_fee, 10), "a buy: paid 0.2% over the price acted on, 0.1% of it the fee", b);
const s = shortfallBps({ ts: "2026-11-11T00:00:00Z", ok: true, side: "sell", usd: 9.95, units: 0.1, px: 100, fee: 0.01, fee_out: true })!;
check(near(s.total, 50) && near(s.ex_fee, 50), "a sell: got 0.5% less; a fee paid beside the swap isn't inside that", s);
check(shortfallBps({ ts: "x", ok: true, side: "buy", usd: 10, units: 0.1 }) === null && shortfallBps({ ts: "x", ok: false, side: "buy", usd: 10, units: 0.1, px: 100 }) === null && shortfallBps({ ts: "x", ok: true, side: "buy", usd: 10, units: 0.1, px: 100, paper: true }) === null, "older fills without the price acted on, failed and practice fills don't count");
const now = Date.parse("2026-11-11T12:00:00Z"), mk = (bps: number, i: number, extra: Partial<FillLike> = {}): FillLike => ({ ts: new Date(now - i * 3_600_000).toISOString(), ok: true, side: "buy", usd: 10 * (1 + bps / 10_000), units: 0.1, px: 100, ms: 2000 + i, ...extra });
const fills = Array.from({ length: 25 }, (_, i) => mk(i < 22 ? 5 : 40, i));
const st = shortfallStats(fills, now)!;
check(st.n === 25 && near(st.median_bps, 5) && near(st.p90_bps, 40) && st.median_ms === 2012, "stats: typical 0.05%, the worst tenth 0.4%, typical time 2 s", st);
check(shortfallStats([mk(5, 24 * 40)], now) === null, "fills older than 30 days are left out");
check(adaptiveSlippage(st, 100) === 100 && adaptiveSlippage({ ...st, p90_ex_fee_bps: 4 }, 100) === ADAPT.floorBps && adaptiveSlippage({ ...st, p90_ex_fee_bps: 20 }, 100) === 60 && adaptiveSlippage({ ...st, n: 19, p90_ex_fee_bps: 4 }, 100) === 100 && adaptiveSlippage({ ...st, p90_ex_fee_bps: 4 }, 25) === 25,
  "the limit: three times the worst tenth, at least 0.3%, never over the owner's, and only with 20 fills");

// The engine uses it for live buys, never for a stop, and never in practice.
const dir = mkdtempSync(path.join(os.tmpdir(), "exec-")), store = new RuleStore(dir);
const r = await store.add({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 10, every: "day" }, "owner", false);
await store.mutate((rs) => { rs.find((x) => x.id === r.id)!.state.fills = Array.from({ length: 25 }, (_, i) => mk(3, i)) as any; });
const exec = (mode: "live" | "paper") => ({ mode, slippageBps: 100, swap: async () => { throw new Error("no"); }, quote: async () => { throw new Error("no"); }, balance: async () => 0n }) as any;
const sol = { address: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 } as any;
const live = new Autopilot(store, exec("live"), { snapshot: async () => ({ prices: {} }) } as any, { now: () => now, noLease: true });
const paper = new Autopilot(store, exec("paper"), { snapshot: async () => ({ prices: {} }) } as any, { now: () => now, noLease: true });
check(live.slip("solana", sol) === ADAPT.floorBps && live.slip("solana", sol, true) === 100 && paper.slip("solana", sol) === 100, "25 cheap SOL fills: live buys get a 0.3% limit; a stop keeps 1%; practice keeps 1%");
const tc = tradeCosts(store.list(), 100, now);
check(tc["solana:SOL"]?.fills === 25 && near(tc["solana:SOL"]?.typical_cost_bps, 3) && tc["solana:SOL"]?.slippage_limit_bps === 30, "the AI and the report see the same per-coin costs", tc);

console.log(`\nexecution: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
