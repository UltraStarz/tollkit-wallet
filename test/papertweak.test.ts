/** 0.9.10: an AI tweak keeps a strategy's paper clock and its results, so a paper test can finish. Fake wallet and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { SuperBot } from "../src/superbot.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const dir = mkdtempSync(path.join(os.tmpdir(), "ptw-"));
let now = Date.parse("2026-11-02T08:00:00Z"), price = 100;
const store = new RuleStore(dir);
const ao = { isOn: () => false, set: () => {}, config: async () => ({ enabled: false }) };
let decision: any = { assessment: "Steady.", market_view: "neutral", confidence: 0.6, actions: [{ type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 5, every: "day", times: 3 }, reason: "Steady.", sources: [] }] };
const w: any = { dir, policy: { chains: ["solana"] }, rules: () => store, always: () => ao, alwaysSol: () => ao,
  pay: async (_u: string, init: any) => ({ paid: true, status: 200, response: new Response(JSON.stringify({ decision, snapshot_id: JSON.parse(init.body).snapshot_id, model: "m" })) }) };
const fetch = (async () => Response.json({ id: `snap-${now}`, at: new Date(now).toISOString(), changes: { moved: true } })) as any;
const bot = new SuperBot(w, { dir, proxy: "https://api.test/wallet", fetch, now: () => now, price: async () => price, knownToken: async () => true, active: () => true });
await bot.enable({ chains: ["solana"], tokens: [{ chain: "solana", token: "SOL" }], paper_days: 2, paper_trades: 50 });
const st0 = bot.view().strategies[0]!;
// One pretend buy at $90.
await store.mutate((rs) => { for (const r of rs) if (r.bot === st0.bot) { r.state.fills.push({ ts: new Date(now).toISOString(), ok: true, usd: 5, units: 5 / 90, side: "buy", paper: true }); r.state.spent_usd = 5; r.state.bought_units = 5 / 90; r.state.ok_count = 1; r.state.last_price = 100; } });
now += 26 * 3600_000;
decision = { assessment: "Tweak.", market_view: "neutral", confidence: 0.6, actions: [{ type: "adjust", strategy_id: st0.id, params: { amount_usd: 4 }, reason: "Smaller.", sources: [] }] };
await bot.cycle(true);
const st1 = bot.view().strategies.find((x: any) => x.id === st0.id)!;
check(st1.bot !== st0.bot && st1.params.amount_usd === 4, "the AI's tweak rebuilt it with the new settings", st1.params);
check(st1.stage_since === st0.stage_since && st1.stage === "paper", "its paper clock kept running", [st0.stage_since, st1.stage_since]);
check(st1.trades === 1 && st1.result_pct !== null && st1.result_pct > 0, "and its paper results so far count", [st1.trades, st1.result_pct]);
decision = { assessment: "Flat.", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "-", sources: [] }] };
now += 24 * 3600_000;
await bot.cycle(true);
const st2 = bot.view().strategies.find((x: any) => x.id === st0.id)!;
check(!!st2.ready, "so it finishes its 2-day paper test and waits for Go live", st2);
console.log(`\npapertweak: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
