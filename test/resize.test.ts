/** 0.9.11: strategies made before balance sizing are resized once; the AI tab gets a suggested size. Fakes only. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { SuperBot, suggestedSizes, SUPERBOT } from "../src/superbot.js";
import { walletHome } from "../src/paths.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const dir = mkdtempSync(path.join(os.tmpdir(), "rsz-"));
const store = new RuleStore(dir);
const alwaysSol = { isOn: () => false, set: () => {}, config: async () => ({ enabled: true, delegate: "So1" }) };
let decision: any = { assessment: "a", market_view: "neutral", confidence: 0.5, actions: [
  { type: "propose", template: "grid", chain: "solana", token: "SOL", params: { amount_usd: 9, range_pct: 4, levels: 6 }, reason: "Range.", sources: [] },
  { type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 9, every: "day", times: 5 }, reason: "Steady.", sources: [] }] };
const w: any = { dir, policy: { chains: ["solana"] }, rules: () => store, always: () => ({ isOn: () => false, set: () => {}, config: async () => ({ enabled: false }) }), alwaysSol: () => alwaysSol,
  pay: async (_u: string, init: any) => ({ paid: true, status: 200, response: new Response(JSON.stringify({ decision, snapshot_id: JSON.parse(init.body).snapshot_id, model: "m" })) }),
  balances: async () => ({ solana: [{ token: "SOL", amount: "1.9" }, { token: "USDC", amount: "152.82" }] }) };
const bot = new SuperBot(w, { dir, proxy: "https://api.test/wallet", fetch: (async () => Response.json({ id: `s${Math.random()}`, at: new Date().toISOString(), changes: { moved: true } })) as any,
  price: async () => 100, knownToken: async () => true, active: () => true, stableUsd: async () => 152.82 });
await bot.enable({ chains: ["solana"], tokens: [{ chain: "solana", token: "SOL" }], budget_usd: 300, per_trade_usd: 100, max_strategies: 4, max_token_pct: 100, pace: "max" });
let v = bot.view();
check(v.strategies.length === 2 && v.strategies.find((x: any) => x.template === "grid")!.params.amount_usd === 15.28, "new (Nov 10): a 6-level grid at $15.28 a level ($152.82 over 2 live slots, over 5 buys)", v.strategies.map((x: any) => x.params));

// Pretend they were made before sizing: tiny amounts, not resized yet; one is live (a steady buyer never sells).
const f = path.join(walletHome(dir), SUPERBOT.file);
const st = JSON.parse(readFileSync(f, "utf8"));
for (const x of st.strategies) { x.params.amount_usd = 1.5; if (x.template === "dca") x.stage = "live"; }
delete st.sized;
writeFileSync(f, JSON.stringify(st));
decision = { assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "-", sources: [] }] };
await bot.cycle(true);
v = bot.view();
const g = v.strategies.find((x: any) => x.template === "grid")!, d = v.strategies.find((x: any) => x.template === "dca")!;
check(g.params.amount_usd === 29.06 && g.stage === "paper", "old practice grid resized to $29.06 a level ($152.82 less the live buyer's $7.50, over the 1 live slot left, over 5 buys)", g.params);
check(d.params.amount_usd === 15.28 && d.stage === "live", "old live steady buyer resized too ($76.41 over 5 buys), still live", { p: d.params, s: d.stage });
check(/Resized from your balance: \$1\.5 → \$29\.06/.test(JSON.stringify(g.history)), "its history says why", g.history.at(-1));
check(JSON.parse(readFileSync(f, "utf8")).sized === 3, "done once");

// The AI tab's suggested size.
const sz = await suggestedSizes(w);
check(sz.solana === 76.41, "AI tab: suggested size on Solana = $76.41 ($152.82 over 2 live slots)", sz);
console.log(`\nresize: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
