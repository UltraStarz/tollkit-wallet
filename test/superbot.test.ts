/** Autopilot (src/superbot.ts): settings, the cycle, the strategist's actions against the owner's limits, promotion and demotion, loss stops, the kill switch, reports. Fake wallet and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { committedUsd, shareUsd, nextSize, DEFAULT_SETTINGS, parseSettings, raisedTarget, SUPERBOT, SuperBot, tightened, widened } from "../src/superbot.js";
import { marketState } from "../src/botlogic.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twsb-"));
const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };

// ─── settings ───────────────────────────────────────────────────────────────
const s0 = parseSettings({});
check(s0.rethink_minutes === 30 && s0.budget_usd === 100 && s0.per_trade_usd === 20 && !s0.sources.x && !("reddit" in s0.sources), "defaults: 30 minutes, $100, $20 a trade, no X, no Reddit", s0);
check(s0.away_pause === false && parseSettings({ away_pause: true }).away_pause === true, "0.9.13: no pausing while away unless the owner turns it on");
check(/15, 30 or 60/.test(err(() => parseSettings({ rethink_minutes: 10 }))), "rethink is 15, 30 or 60");
check(/can't be more than the budget/.test(err(() => parseSettings({ budget_usd: 50, per_trade_usd: 60 }))), "per-trade cap inside the budget");
check(/network must be turned on/.test(err(() => parseSettings({ chains: ["base"], tokens: [{ chain: "solana", token: "SOL" }] }))), "a token's network must be on");
check(parseSettings({ budget_usd: 5, per_trade_usd: 5 }).budget_usd === 10 && parseSettings({ daily_loss_pct: 99 }).daily_loss_pct === 50, "numbers are clamped");
// 0.9.6: pace
check(s0.pace === "adaptive" && parseSettings({ pace: "active" }).pace === "active", "0.9.13: pace is Adaptive by default, active when chosen");
// 0.9.12: one Run 24/7 switch
check(parseSettings({ always_on: true }).think_24_7 === true && parseSettings({ always_on: false }, { ...DEFAULT_SETTINGS, think_24_7: true }).think_24_7 === false && parseSettings({ always_on: true, think_24_7: false }).think_24_7 === false,
  "Run 24/7 turns deciding while away on and off with it, unless that's set on its own");
check(/steady, active, max or adaptive/.test(err(() => parseSettings({ pace: "turbo" }))) && parseSettings({ pace: "max" }).pace === "max" && parseSettings({ pace: "adaptive" }).pace === "adaptive", "only steady, active, max or adaptive");
{ const { SUPERBOT_SYSTEM } = await import("../src/strategist.js");
  check(/limits\.pace/.test(SUPERBOT_SYSTEM) && /0\.1% on each buy and sell a strategy places/.test(SUPERBOT_SYSTEM), "the strategist is told what active pace means and the fees it must clear"); }
{ const { TEMPLATES } = await import("../src/bots.js");
  const sd = TEMPLATES.find((t: any) => t.id === "smart_dca")!; const d = (k: string) => (sd.fields as any[]).find((f) => f.key === k).default;
  check(d("step_pct") === 2 && d("profit_pct") === 2, "Smart DCA defaults: 2% steps, 2% profit"); }
check(committedUsd("dca", { amount_usd: 10, times: 5 }) === 50 && committedUsd("dca", { amount_usd: 10 }) === 100 && committedUsd("grid", { amount_usd: 20, levels: 6 }) === 100 && committedUsd("protect", { sell_percent: 50 }) === 0, "dollars a strategy commits");

// ─── a fake wallet, server and clock ────────────────────────────────────────
function world(o: { decision?: () => any; signals?: () => any; price?: number; closes?: (chain: string, token: string) => Promise<number[]> } = {}) {
  const dir = tmp();
  let now = Date.parse("2026-10-20T08:00:00Z");
  const store = new RuleStore(dir);
  const always = { on: new Set<string>(), isOn: (id: string) => always.on.has(id), set: (id: string, on: boolean) => { if (on) always.on.add(id); else always.on.delete(id); }, config: async () => ({ enabled: true, chains: ["base"], delegate: "0x1" }), serverRuns: () => false, anyOn: () => always.on.size > 0 };
  const alwaysSol = { on: new Map<string, number | undefined>(), isOn: (id: string) => alwaysSol.on.has(id), set: (id: string, on: boolean, b?: number) => { if (on) alwaysSol.on.set(id, b); else alwaysSol.on.delete(id); }, config: async () => ({ enabled: true, delegate: "So1" }) };
  const calls: any[] = [];
  const notes: string[] = [];
  let decision = o.decision ?? (() => ({ assessment: "Nothing moved.", market_view: "neutral", confidence: 0.3, actions: [{ type: "keep", reason: "Quiet.", sources: [] }] }));
  let signals = o.signals ?? (() => ({ id: `snap-${now}`, at: new Date(now).toISOString(), changes: { moved: true, notes: ["first"] } }));
  const w: any = {
    dir, policy: { chains: ["base", "solana"] },
    rules: () => store,
    always: () => always,
    alwaysSol: () => alwaysSol,
    pay: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      const d = decision();
      if (d === "refuse") return { paid: false, status: null, response: null, refused: { code: "over_daily_limit", reason: "Daily limit for paying tools reached." } };
      return { paid: true, status: 200, response: new Response(JSON.stringify({ decision: d, snapshot_id: body.snapshot_id, model: "claude-haiku-4-5-20251001" }), { status: 200 }), receipt_id: "r", tx: "0x1" };
    },
  };
  const fetch = (async (url: string) => Response.json(signals())) as any;
  const bot = new SuperBot(w, { dir, ...(o.closes ? { closes: o.closes as any } : {}), proxy: "https://api.test/wallet", fetch, now: () => now, price: async () => o.price ?? 2500, knownToken: async (_c, t) => ["ETH", "SOL", "USDC"].includes(t.toUpperCase()), notify: async (t) => { notes.push(t); } });
  return { dir, store, bot, calls, notes, always, alwaysSol, setNow: (iso: string) => { now = Date.parse(iso); }, advance: (ms: number) => { now += ms; }, setDecision: (f: () => any) => { decision = f; }, setSignals: (f: () => any) => { signals = f; } };
}

// ─── on, first cycle, a keep decision ───────────────────────────────────────
{
  const W = world();
  const v0 = W.bot.view();
  check(!v0.enabled && v0.strategies.length === 0, "off to start");
  await W.bot.enable({ budget_usd: 100, per_trade_usd: 20, pace: "steady" });
  await new Promise((r) => setTimeout(r, 30));
  const v = W.bot.view();
  check(v.enabled && v.stats.cycles === 1 && v.stats.steps === 1 && W.calls.length === 1, "turning on runs a cycle and one strategist step", v.stats);
  check(W.calls[0].url.endsWith(SUPERBOT.stepPath) && W.calls[0].body.context.limits.budget_usd === 100 && W.calls[0].body.context.allowed.tokens.length === 2, "the step gets the limits and the allowed tokens", W.calls[0].body.context.limits);
  check(v.decisions[0].by === "strategist" && v.decisions[0].actions[0].type === "keep" && v.decisions[0].cost_usd === 0.005, "the decision is logged with its cost", v.decisions[0]);
  await W.bot.tick();
  check(W.bot.view().stats.cycles === 1, "no cycle before the rethink time");
  W.advance(30 * 60_000);
  W.setSignals(() => ({ id: "same", at: "x", changes: { moved: false } }));
  await W.bot.tick(); await W.bot.tick();
  check(W.bot.view().stats.cycles === 2 && W.calls.length === 1, "a cycle ran but nothing moved: no paid step", W.bot.view().stats);
  W.advance(31 * 60_000);
  await W.bot.tick();
  check(W.calls.length === 2, "an hour without a decision forces one");
}

// ─── propose: limits and a paper start ──────────────────────────────────────
{
  const W = world({ decision: () => ({ assessment: "SOL news mood turned positive; funding flat.", market_view: "risk_on", confidence: 0.6, actions: [
    { type: "propose", template: "grid", chain: "base", token: "ETH", params: { amount_usd: 500, range_pct: 8, levels: 6 }, reason: "Sideways range.", sources: ["ETH +0.4% 24h"] },
    { type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 10 }, reason: "second", sources: [] },
    { type: "pause", strategy_id: "nope", reason: "x", sources: [] },
  ] }) });
  await W.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base", "solana"] });
  await new Promise((r) => setTimeout(r, 30));
  const v = W.bot.view();
  const d = v.decisions[0];
  check(v.strategies.length === 1 && v.strategies[0].stage === "paper" && v.strategies[0].template === "grid", "one proposal becomes a paper strategy", v.strategies);
  // 0.9.11: the wallet sizes it: $100 budget / 4 strategies = $25, over a 6-level grid's 5 buys = $5 a level.
  check(v.strategies[0].params.amount_usd === 5, "the wallet sizes it to an equal share of the budget ($25 over 5 grid buys)", v.strategies[0].params);
  check(d.actions[1].applied === false && /not on the allowed list/.test(d.actions[1].outcome), "a token off the list is refused", d.actions[1]);
  check(d.actions[2].applied === false && /no such/.test(d.actions[2].outcome), "pause of an unknown strategy is refused", d.actions[2]);
  const rules = W.store.list();
  check(rules.length === 1 && rules[0].status === "active" && rules[0].by === "superbot" && !!rules[0].bot_name?.startsWith("Autopilot") && W.bot.isPaperRule(rules[0].id), "its rule is active, tagged, and marked paper", rules[0]);
  // The same proposal again: refused as a duplicate; a 5th strategy: refused by the maximum.
  await W.bot.cycle(true);
  check(W.bot.view().strategies.length === 1 && /already running/.test(W.bot.view().decisions[0].actions[0].outcome), "no duplicate strategy", W.bot.view().decisions[0].actions[0]);
}

// ─── adjust, pause, resume, retire ──────────────────────────────────────────
{
  let step = 0;
  const W = world({ decision: () => {
    step++;
    if (step === 1) return { assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, reason: "Dip buyer.", sources: ["s"] }] };
    const id = W.bot.view().strategies[0].id;
    if (step === 2) return { assessment: "b", market_view: "risk_off", confidence: 0.5, actions: [{ type: "adjust", strategy_id: id, params: { drop_pct: 8, amount_usd: 999 }, reason: "Wider dip.", sources: ["ETH -3%"] }] };
    if (step === 3) return { assessment: "c", market_view: "risk_off", confidence: 0.5, actions: [{ type: "pause", strategy_id: id, reason: "Volatile.", sources: ["s"] }] };
    if (step === 4) return { assessment: "d", market_view: "neutral", confidence: 0.5, actions: [{ type: "resume", strategy_id: id, reason: "Calmer.", sources: ["s"] }] };
    return { assessment: "e", market_view: "neutral", confidence: 0.5, actions: [{ type: "retire", strategy_id: id, reason: "Done with it.", sources: ["s"] }] };
  } });
  await W.bot.enable({});
  await new Promise((r) => setTimeout(r, 30));
  const s1 = W.bot.view().strategies[0], bot1 = s1.bot;
  await W.bot.cycle(true);
  const s2 = W.bot.view().strategies[0];
  check(s2.params.drop_pct === 8 && s2.params.amount_usd === 20 && s2.bot !== bot1 && s2.stage === "paper", "adjust rebuilds the rules with clamped params, same stage", s2.params);
  const old = W.store.list().filter((r) => r.bot === bot1);
  check(old.every((r) => r.status === "cancelled") && !W.bot.isPaperRule(old[0].id), "the old rules are cancelled and unmarked");
  await W.bot.cycle(true);
  check(W.store.list().filter((r) => r.bot === s2.bot).every((r) => r.status === "paused"), "pause pauses the bot's rules");
  await W.bot.cycle(true);
  check(W.store.list().filter((r) => r.bot === s2.bot).every((r) => r.status === "active"), "resume");
  await W.bot.cycle(true);
  const v = W.bot.view();
  check(v.strategies[0].stage === "retired" && W.store.list().filter((r) => r.bot === s2.bot).every((r) => ["cancelled", "done"].includes(r.status)), "retire cancels its rules", v.strategies[0]);
}

// ─── promotion after the paper period, demotion on live losses, budget cap ──
{
  const W = world({ decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dca", chain: "base", token: "ETH", params: { amount_usd: 10, every: "day", times: 3 }, reason: "Steady.", sources: ["s"] }] }) });
  await W.bot.enable({ budget_usd: 100, per_trade_usd: 20, paper_days: 7, paper_trades: 20, max_token_pct: 50 });
  await new Promise((r) => setTimeout(r, 30));
  const st = W.bot.view().strategies[0];
  // Give its paper rule a winning record.
  await W.store.mutate((rules) => { const r = rules.find((x) => x.bot === st.bot)!; r.state.ok_count = 5; r.state.spent_usd = 30; r.state.bought_units = 0.012; r.state.last_price = 2700; r.state.fills = [{ ts: "2026-10-21T01:00:00Z", ok: true, paper: true, usd: 10 }]; });
  W.setDecision(() => ({ assessment: "quiet", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
  W.advance(3 * 86_400_000);
  await W.bot.cycle(true);
  check(W.bot.view().strategies[0].stage === "paper", "before the paper period ends it stays on paper");
  W.advance(5 * 86_400_000);
  await W.bot.cycle(true);
  let v = W.bot.view();
  // 0.9.8: passing never moves money on its own; it waits for the owner's Go live.
  check(v.strategies[0].stage === "paper" && !!(v.strategies[0] as any).ready && W.notes.some((n) => /passed its paper trial/.test(n) && /Go live/.test(n)), "a winning paper strategy waits for Go live (and tells the owner)", v.strategies[0]);
  await W.bot.cycle(true);
  check(W.bot.view().strategies[0].stage === "paper" && W.notes.filter((n) => /passed its paper trial/.test(n)).length === 1, "it keeps waiting, and the owner is told once");
  // Dismiss and auto-dismiss (on a twin world, so this one can still go live).
  {
    const D = world({ decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dca", chain: "base", token: "ETH", params: { amount_usd: 10, every: "day", times: 3 }, reason: "Steady.", sources: ["s"] }] }) });
    await D.bot.enable({ budget_usd: 100, per_trade_usd: 20, paper_days: 7, paper_trades: 20, max_token_pct: 50 });
    await new Promise((r) => setTimeout(r, 30));
    const ds = D.bot.view().strategies[0];
    await D.store.mutate((rules) => { const r = rules.find((x) => x.bot === ds.bot)!; r.state.ok_count = 5; r.state.spent_usd = 30; r.state.bought_units = 0.012; r.state.last_price = 2700; });
    D.setDecision(() => ({ assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
    D.advance(8 * 86_400_000); await D.bot.cycle(true);
    check(!!(D.bot.view().strategies[0] as any).ready, "twin: passed and waiting");
    D.advance(2 * 86_400_000); await D.bot.cycle(true);
    check(D.bot.view().strategies[0].stage === "paper", "2 days later it still waits");
    D.advance(1.1 * 86_400_000); await D.bot.cycle(true);
    const dv = D.bot.view();
    check(dv.strategies[0].stage === "retired" && /wasn't tapped within 3 days/.test(dv.strategies[0].history.at(-1)!.note) && D.store.list().every((r) => r.status !== "active"), "after 3 days without Go live it's dismissed, its rules stopped", dv.strategies[0].history.at(-1));
    // A second one, dismissed by hand.
    D.setDecision(() => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 10, drop_pct: 4, profit_pct: 4 }, reason: "Dip.", sources: ["s"] }] }));
    await D.bot.cycle(true);
    const d2 = D.bot.view().strategies.find((x) => x.stage === "paper")!;
    await D.bot.dismiss(d2.id);
    check(D.bot.view().strategies.find((x) => x.id === d2.id)!.stage === "retired" && D.bot.view().decisions.some((d) => /You dismissed it/.test(d.assessment)), "Dismiss retires it and logs the owner's tap");
  }
  await W.bot.goLive(v.strategies[0].id);
  v = W.bot.view();
  check(v.strategies[0].stage === "live" && v.strategies[0].past?.[0]?.stage === "paper" && (v.strategies[0].past?.[0]?.result_pct ?? 0) > 0, "Go live moves it to real money", v.strategies[0]);
  const liveRule = W.store.list().find((r) => r.bot === v.strategies[0].bot && r.status === "active")!;
  check(!!liveRule && !W.bot.isPaperRule(liveRule.id), "its new rule is a live rule");
  check(W.always.on.size === 0, "Always On stays off unless the owner turned it on");
  check(v.decisions.some((d) => d.by === "rule" && /You tapped Go live/.test(d.assessment)), "going live is logged with the owner's tap");
  let gl = ""; try { await W.bot.goLive(v.strategies[0].id); } catch (e) { gl = (e as Error).message; }
  check(/isn't on paper/.test(gl), "Go live twice does nothing", gl);
  // Losing on live money: back to paper after 3 trades.
  await W.store.mutate((rules) => { const r = rules.find((x) => x.id === liveRule.id)!; r.state.ok_count = 3; r.state.spent_usd = 30; r.state.bought_units = 0.012; r.state.last_price = 2000; });
  W.advance(2 * 86_400_000);
  await W.bot.cycle(true);
  v = W.bot.view();
  check(v.strategies[0].stage === "paper" && v.decisions.some((d) => /back to paper/.test(d.assessment)), "a losing live strategy goes back to paper", v.strategies[0].stage);
  // A paper strategy that never beat USDC is retired after twice the period.
  W.advance(15 * 86_400_000);
  await W.bot.cycle(true);
  check(W.bot.view().strategies[0].stage === "retired", "a paper strategy that didn't beat USDC is retired after twice the period");
  // Budget cap: a live promotion that would pass the budget stays on paper.
  const W2 = world({ decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dca", chain: "base", token: "ETH", params: { amount_usd: 20, every: "day", times: 10 }, reason: "Big.", sources: ["s"] }] }) });
  await W2.bot.enable({ budget_usd: 100, per_trade_usd: 20, max_token_pct: 100 });
  await new Promise((r) => setTimeout(r, 30));
  const st2 = W2.bot.view().strategies[0];
  await W2.store.mutate((rules) => { const r = rules.find((x) => x.bot === st2.bot)!; r.state.ok_count = 25; r.state.spent_usd = 100; r.state.bought_units = 0.05; r.state.last_price = 2600; });
  W2.setDecision(() => ({ assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
  W2.advance(8 * 86_400_000);
  await W2.bot.cycle(true);
  // 0.9.11: proposals are sized inside the budget, so the owner lowering the budget afterwards is what overflows it.
  await W2.bot.setSettings({ budget_usd: 10, per_trade_usd: 10 });
  let e2 = ""; try { await W2.bot.goLive(W2.bot.view().strategies[0].id); } catch (e) { e2 = (e as Error).message; }
  const v2 = W2.bot.view();
  check(v2.strategies[0].stage === "paper" && /budget/.test(e2), "$25 committed does not fit a budget lowered to $10: Go live is refused, it stays on paper", e2);
}

// ─── 0.9.2: a live Solana SOL strategy goes to Solana 24/7, under the Autopilot budget ───
{
  const W = world({ price: 107, decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 10, every: "day", times: 2 }, reason: "Steady.", sources: ["s"] }] }) });
  await W.bot.enable({ budget_usd: 100, daily_loss_pct: 5, always_on: true });
  await new Promise((r) => setTimeout(r, 30));
  const st = W.bot.view().strategies[0];
  check(!!st && W.alwaysSol.on.size === 0, "a paper SOL strategy never goes 24/7", [...W.alwaysSol.on]);
  await W.store.mutate((rules) => { const r = rules.find((x) => x.bot === st.bot)!; r.state.ok_count = 25; r.state.spent_usd = 20; r.state.bought_units = 0.19; r.state.last_price = 107; });
  W.setDecision(() => ({ assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
  W.advance(8 * 86_400_000);
  await W.bot.cycle(true);
  await W.bot.goLive(st.id);
  const v = W.bot.view();
  check(v.strategies[0].stage === "live" && W.alwaysSol.on.size === 1 && [...W.alwaysSol.on.values()][0] === 100 && W.always.on.size === 0, "live: handed to Solana 24/7 (not Base), with the $100 Autopilot budget as its allowance", [v.strategies[0].stage, [...W.alwaysSol.on]]);
  await W.bot.setSettings({ always_on: false });
  check(W.alwaysSol.on.size === 0, "the 24/7 switch off takes live strategies off the server right away", [...W.alwaysSol.on]);
  await W.bot.setSettings({ always_on: true });
  check(W.alwaysSol.on.size === 1, "and back on hands them over again", [...W.alwaysSol.on]);
  await W.bot.disable();
  check(W.alwaysSol.on.size === 0, "turning Autopilot off takes it off Solana 24/7", [...W.alwaysSol.on]);
}

// ─── loss stops and the kill switch ─────────────────────────────────────────
{
  const W = world({ decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dca", chain: "base", token: "ETH", params: { amount_usd: 10, every: "day", times: 2 }, reason: "Steady.", sources: ["s"] }] }) });
  await W.bot.enable({ budget_usd: 100, daily_loss_pct: 5, always_on: true });
  await new Promise((r) => setTimeout(r, 30));
  const st = W.bot.view().strategies[0];
  await W.store.mutate((rules) => { const r = rules.find((x) => x.bot === st.bot)!; r.state.ok_count = 25; r.state.spent_usd = 20; r.state.bought_units = 0.01; r.state.last_price = 2500; });
  W.setDecision(() => ({ assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
  W.advance(8 * 86_400_000);
  await W.bot.cycle(true); // passed, marks set
  await W.bot.goLive(st.id);
  let v = W.bot.view();
  check(v.strategies[0].stage === "live" && W.always.on.size === 1, "live, and handed to Always On when the owner asked", [v.strategies[0].stage, [...W.always.on]]);
  const live = W.store.list().find((r) => r.bot === v.strategies[0].bot && r.status === "active")!;
  await W.bot.cycle(true); // marks for today
  await W.store.mutate((rules) => { const r = rules.find((x) => x.id === live.id)!; r.state.spent_usd = 20; r.state.bought_units = 0.01; r.state.last_price = 1000; }); // from +$5 to -$10: a $15 fall on a $100 budget
  await W.bot.cycle(true);
  v = W.bot.view();
  check(!!v.halted && /Daily loss stop/.test(v.halted.reason) && W.store.get(live.id)!.status === "paused" && W.always.on.size === 0, "a 5% daily loss pauses live rules, revokes Always On, halts", v.halted);
  check(W.notes.some((n) => /Autopilot stopped/.test(n)), "the owner is told", W.notes);
  const before = W.calls.length;
  await W.bot.cycle(true);
  check(W.calls.length === before, "no strategist step while halted");
  await W.bot.resume();
  check(!W.bot.view().halted && W.store.get(live.id)!.status === "active", "the owner can resume");
  await W.bot.disable();
  v = W.bot.view();
  check(!v.enabled && v.strategies.every((x) => x.stage === "retired") && W.store.list().every((r) => ["cancelled", "done"].includes(r.status)) && W.bot.isPaperRule(live.id) === false, "the kill switch cancels everything", v.strategies.map((x) => x.stage));
}

// ─── a refused payment, a failed server, and the daily report ───────────────
{
  const W = world({ decision: () => "refuse" });
  await W.bot.enable({});
  await new Promise((r) => setTimeout(r, 30));
  check(/Daily limit/.test(W.bot.view().stats.last_error ?? "") && W.bot.view().stats.steps === 0, "a refused step is reported, not counted", W.bot.view().stats);
  W.setSignals(() => { throw new Error("down"); });
  W.setDecision(() => ({ assessment: "q", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }));
  await W.bot.cycle(true);
  const v1 = W.bot.view();
  check(!v1.stats.last_error && v1.stats.snap_fails === 1, "one missed snapshot: no warning yet", v1.stats);
  W.advance(60_000);
  await W.bot.tick();
  check(W.bot.view().stats.snap_fails === 1, "not retried before 2 minutes");
  W.advance(60_000);
  await W.bot.tick();
  await new Promise((r) => setTimeout(r, 30));
  check(W.bot.view().stats.snap_fails === 2, "retried 2 minutes later", W.bot.view().stats);
  check(/No signal snapshot/.test(W.bot.view().stats.last_error ?? ""), "two misses in a row: says so, nothing charged");
  W.setSignals(() => ({ id: "s2", at: "x", changes: { moved: true } }));
  W.setNow("2026-10-21T00:10:00Z");
  await W.bot.cycle(true);
  W.setNow("2026-10-22T00:10:00Z");
  await W.bot.cycle(true);
  const v = W.bot.view();
  check(v.reports.length === 2 && v.reports[0].date === "2026-10-21" && /Autopilot, 2026-10-21/.test(v.reports[0].text) && W.notes.some((n) => n.startsWith("Autopilot, 2026-10-21")), "the first cycle of a new day sends yesterday's report", v.reports);
}

// ─── 0.9.5: the phone app decides on the owner's own AI key (no payment) ────
{
  const dir = tmp();
  let now = Date.parse("2026-10-20T08:00:00Z");
  const store = new RuleStore(dir);
  const off = { on: new Set<string>(), isOn: () => false, set: () => {}, config: async () => null, serverRunnable: () => false };
  const pays: any[] = [], asks: any[] = [];
  let label: string | null = null;
  const w: any = { dir, policy: { chains: ["base", "solana"] }, rules: () => store, always: () => off, alwaysSol: () => off, pay: async (url: string) => { pays.push(url); throw new Error("must not pay"); } };
  const snap = () => ({ id: `snap-${now}`, at: new Date(now).toISOString(), changes: { moved: true }, pulse: { fear_greed: { value: 55, classification: "Greed" }, majors: [{ coin: "ETH", perp_mark_usd: 2500, change_24h_pct: 1.2 }] }, news: { eth: { mood: "neutral", summary: "quiet", themes: [], headlines: [{ title: "ETH steady" }] } }, social: {} });
  const fetch = (async () => Response.json(snap())) as any;
  const bot = new SuperBot(w, { dir, proxy: "https://api.test/wallet", fetch, now: () => now, price: async () => 2500, knownToken: async (_c, t) => ["ETH", "SOL", "USDC"].includes(t.toUpperCase()),
    decide: { label: () => label, run: async (system, user, tool) => { asks.push({ system, user, tool }); return { input: { assessment: "Quiet market.", market_view: "neutral", confidence: 0.4, actions: [{ type: "keep", reason: "Nothing moved enough.", sources: ["ETH +1.2% 24h"] }] }, model: "claude-haiku-5-5" }; } } });
  await bot.enable({ budget_usd: 100, per_trade_usd: 20 });
  await new Promise((r) => setTimeout(r, 30));
  let v: any = bot.view();
  check(v.brain?.own === true && v.brain.label === null && /Add your AI key on the AI tab/.test(v.stats.last_error ?? "") && asks.length === 0 && pays.length === 0, "no key yet: Autopilot says to add one, and nothing is paid", v.stats);
  label = "Haiku 5.5 on your Anthropic key";
  now += 61 * 60_000;
  await bot.tick();
  v = bot.view();
  check(asks.length === 1 && pays.length === 0, "with a key: one decision on the owner's key, nothing paid to Tollkit", { asks: asks.length, pays });
  check(/strategist inside a Tollkit Wallet/.test(asks[0].system) && asks[0].tool.name === "decide" && /Signal snapshot snap-/.test(asks[0].user) && /"fear_greed"/.test(asks[0].user) && /budget_usd/.test(asks[0].user), "the same instructions, decide tool, snapshot and limits as Tollkit's strategist");
  check(v.decisions[0].by === "strategist" && v.decisions[0].model === "claude-haiku-5-5" && v.decisions[0].cost_usd === 0 && v.stats.step_usd === 0 && v.stats.last_error === null, "logged with its model, costing the wallet nothing", v.decisions[0]);
  check(v.brain.label === "Haiku 5.5 on your Anthropic key", "the Autopilot screen can name the model");
}

// ─── 0.9.7: Active pace decides every rethink and tightens idle strategies ─────
{
  check(JSON.stringify(tightened("dip", { amount_usd: 25, drop_pct: 5, profit_pct: 8 })) === JSON.stringify({ amount_usd: 25, drop_pct: 3, profit_pct: 6.4 }) && tightened("dip", { drop_pct: 1.5, profit_pct: 1.5 }) === null, "an idle dip buyer waits for a smaller drop and takes a smaller profit, never under 1.5%");
  const g = tightened("grid", { amount_usd: 20, range_pct: 8, levels: 16 })!;
  check(g.range_pct === 5.63 && (2 * Number(g.range_pct)) / 15 >= 0.75 && tightened("grid", { range_pct: 5.63, levels: 16 })!.range_pct === 5.63, "an idle grid narrows but keeps its levels at least 0.75% apart (above the 0.5% round-trip fee)", g);
  let n = 0;
  const W = world({ decision: () => (n++ === 0 ? { assessment: "Quiet.", market_view: "neutral", confidence: 0.4, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 20, drop_pct: 5, profit_pct: 8 }, reason: "Flat market.", sources: ["ETH +0.1%"] }] } : { assessment: "Quiet.", market_view: "neutral", confidence: 0.4, actions: [{ type: "keep", reason: "Quiet.", sources: [] }] }) });
  await W.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"], pace: "active", rethink_minutes: 15 });
  await new Promise((r) => setTimeout(r, 30));
  const since = W.bot.view().strategies[0]!.stage_since;
  W.setSignals(() => ({ id: "same", at: "x", changes: { moved: false } }));
  const c0 = W.calls.length;
  W.advance(15 * 60_000); await W.bot.tick();
  check(W.calls.length === c0 + 1, "Active decides at every rethink, even when nothing moved", W.calls.length - c0);
  W.advance(24 * 3_600_000); await W.bot.tick();
  const v = W.bot.view(), st = v.strategies[0]!, rd = v.decisions.find((d: any) => d.by === "rule");
  check(st.params.drop_pct === 3 && st.params.profit_pct === 6.4 && st.stage === "paper" && st.stage_since === since, "a day with no trade: tightened by a plain rule, still on paper, its paper clock kept", st);
  check(!!rd && /No trade in 24 hours/.test(rd.assessment) && /dip 5% → 3%/.test(rd.assessment), "the decision list says what was tightened and why", rd?.assessment);
  W.advance(60 * 60_000); await W.bot.tick();
  check(W.bot.view().strategies[0]!.params.drop_pct === 3, "at most once a day");
  const s2 = world();
  await s2.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"], pace: "steady" });
  await new Promise((r) => setTimeout(r, 30));
  s2.setSignals(() => ({ id: "same", at: "x", changes: { moved: false } }));
  const k0 = s2.calls.length; s2.advance(31 * 60_000); await s2.bot.tick();
  check(s2.calls.length === k0, "Steady still waits for the market to move");
}

{ const { checkDecision } = await import("../src/strategist.js");
  const two = { assessment: "Flat.", market_view: "neutral", confidence: 0.5, actions: [1, 2].map((i) => ({ type: "propose", template: "grid", chain: "base", token: "ETH", params: { range_pct: 3 + i }, reason: "Flat market.", sources: ["ETH +0.1%"] })) };
  check(checkDecision(two).actions.length === 1 && checkDecision(two, 2).actions.length === 2, "Max pace may start two new strategies in one decision; the others one"); }

// ─── 0.33.0: Trending on X: paper only, small, only with the X source on ─────
{
  const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const meme = (o: any = {}) => ({ type: "propose", template: "dca", chain: "solana", token: MINT, params: { amount_usd: 50, every: "day", times: 3 }, reason: "Trending on X.", sources: ["trending on X"], ...o });
  const snap = (id: string) => ({ id, at: "2026-10-20T08:00:00Z", changes: { moved: true, notes: [] }, social: { x: { sol: { mood: "bullish", score: 0.4, posts_read: 30, themes: ["etf"], posts: [], at: "t" } } },
    trending_x: { at: "t", coins: [{ symbol: "BONK", chain: "solana", address: MINT, mood: "bullish", why: "w", safe: true }, { symbol: "RUG", chain: "solana", address: "So1aNaRuG1111111111111111111111111111111111", mood: "bullish", why: "w", safe: false }] } });
  let n = 0;
  const W = world({ signals: () => snap(`s${n}`), decision: () => (n++ === 0 ? { assessment: "a", market_view: "neutral", confidence: 0.5, actions: [meme()] } : { assessment: "b", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }) });
  await W.bot.enable({ chains: ["base", "solana"], tokens: [{ chain: "solana", token: "SOL" }] });
  await new Promise((r) => setTimeout(r, 30));
  check(W.bot.view().strategies.length === 0 && /not on the allowed list/.test(W.bot.view().decisions[0].actions[0].outcome), "X source off: a trending meme is refused like any unlisted coin");

  let k = 0;
  const X = world({ signals: () => snap(`x${k}`), decision: () => (k++ === 0 ? { assessment: "a", market_view: "neutral", confidence: 0.5, actions: [meme(), meme({ template: "smart_dca" }), meme({ token: "So1aNaRuG1111111111111111111111111111111111", template: "dip" })] } : { assessment: "b", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "q", sources: [] }] }) });
  await X.bot.enable({ chains: ["base", "solana"], tokens: [{ chain: "solana", token: "SOL" }], sources: { news: true, x: true } });
  await new Promise((r) => setTimeout(r, 30));
  const v = X.bot.view(), st = v.strategies[0] as any, acts = v.decisions[0].actions;
  check(v.strategies.length === 1 && st.paper_only === true && st.stage === "paper" && st.symbol === "BONK" && / · BONK$/.test(st.name), "X source on: a safe trending meme starts on paper, marked paper only, named by its ticker (BONK)", st);
  check((st.params.amount_usd as number) <= 10, "and small: $10 at most per buy", st.params);
  check(acts[1].applied === false && /dip, dca or grid/.test(acts[1].outcome) && acts[2].applied === false, "only dip, dca or grid; a coin that failed the token check is refused", acts);
  check(v.x?.trending?.length === 2 && v.x?.moods?.sol?.mood === "bullish", "the Autopilot screen gets the X moods and trending list", v.x);
  await X.bot.xHide("So1aNaRuG1111111111111111111111111111111111");
  check(X.bot.view().x?.trending?.length === 1 && X.bot.view().x?.hidden === 1, "a hidden coin leaves the list", X.bot.view().x);
  await X.bot.xHide(MINT);
  const hv = await (async () => { k = 0; X.setDecision(() => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [meme({ template: "dip", params: { amount_usd: 5, drop_pct: 4, profit_pct: 4 } })] })); await X.bot.cycle(true); return X.bot.view().decisions[0].actions[0]; })();
  check(hv.applied === false && /hid this coin/.test(hv.outcome), "Autopilot won't test a coin the owner hid", hv);
  await X.bot.xHide(null, false);
  check(X.bot.view().x?.trending?.length === 2 && X.bot.view().x?.hidden === 0, "Show them again brings them back");
  // A meme that wins on paper: Go live waits until the coin is added on Home.
  const memeSt = X.bot.view().strategies[0] as any;
  await X.store.mutate((rules) => { const r = rules.find((x) => x.bot === memeSt.bot)!; r.state.ok_count = 25; r.state.spent_usd = 10; r.state.bought_units = 70; r.state.last_price = 0.2; });
  X.advance(8 * 86_400_000);
  await X.bot.cycle(true);
  const rdy = X.bot.view().strategies[0] as any;
  let me = ""; try { await X.bot.goLive(rdy.id); } catch (e) { me = (e as Error).message; }
  check(rdy.stage === "paper" && !!rdy.ready && /Add \$BONK on Home first/.test(me), "a winning meme is ready, but Go live needs the coin added on Home first", me);
  await X.store.mutate((rules) => { const r = rules.find((x) => x.bot === X.bot.view().strategies[0].bot)!; r.state.last_price = 0.1; });
  X.advance(7 * 86_400_000);
  await X.bot.cycle(true);
  const after = X.bot.view().strategies[0] as any;
  check(after.stage === "retired" && /Trending on X finished/.test(after.history.at(-1).note), "with no winning trades, after twice the paper period it's retired, never moved to live money", after.history.at(-1));
}

// ─── 0.9.9: the owner stops, pauses and removes strategies; Autopilot never brings them back ──────
{
  const prop = { assessment: "Quiet.", market_view: "neutral", confidence: 0.4, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 20, drop_pct: 5, profit_pct: 8 }, reason: "Flat market.", sources: ["ETH +0.1%"] }] };
  const keep = { assessment: "Quiet.", market_view: "neutral", confidence: 0.3, actions: [{ type: "keep", reason: "Quiet.", sources: [] }] };
  const mk = async () => { let n = 0; const W = world({ decision: () => (n++ === 0 ? prop : keep) }); await W.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"], pace: "active", rethink_minutes: 15 }); await new Promise((r) => setTimeout(r, 30)); W.setSignals(() => ({ id: "same", at: "x", changes: { moved: false } })); return W; };

  // Stop from the Autopilot page.
  const A = await mk(); const st = A.bot.view().strategies[0]!;
  await A.bot.stopStrategy(st.id);
  const a1 = A.bot.view().strategies[0]!;
  check(a1.stage === "retired" && a1.stopped_by_owner === true && A.store.list().every((r) => r.status !== "active"), "Stop: retired, its rules cancelled, marked as stopped by you", a1);
  check(A.bot.view().decisions.some((d: any) => /You stopped it/.test(d.assessment)), "and the decision list says so");
  A.advance(48 * 3_600_000); await A.bot.tick();
  check(A.store.list().every((r) => r.status !== "active") && A.bot.view().strategies[0]!.stage === "retired", "two idle days later Active pace doesn't rebuild it");
  await A.bot.removeStrategy(st.id);
  check(A.bot.view().strategies.length === 0 && A.store.list().filter((r: any) => !r.archived).length === 0, "Remove: off the list, its stopped rules tidied away");

  // Stopped on the Bots screen (rules cancelled there, before 0.9.9 knew about it).
  const B = await mk(); const sb = B.bot.view().strategies[0]!;
  for (const r of B.store.list().filter((x) => x.bot === sb.bot)) await B.store.setStatus(r.id, "cancelled");
  B.advance(48 * 3_600_000); await B.bot.tick();
  const b1 = B.bot.view().strategies[0]!;
  check(b1.stage === "retired" && b1.stopped_by_owner === true && B.store.list().every((r) => r.status !== "active"), "a bot stopped on the Bots screen is noticed and stays stopped (not rebuilt)", b1);

  // Paused on the Bots screen: Autopilot leaves it alone until the owner resumes it.
  const C = await mk(); const sc = C.bot.view().strategies[0]!;
  for (const r of C.store.list().filter((x) => x.bot === sc.bot)) await C.store.setStatus(r.id, "paused");
  await C.bot.ownerHold(sc.bot!, true);
  C.advance(48 * 3_600_000); await C.bot.tick();
  const c1 = C.bot.view().strategies[0]!;
  check(c1.params.drop_pct === 5 && c1.bot === sc.bot && c1.stage === "paper" && C.store.list().filter((r) => r.bot === sc.bot).every((r) => r.status === "paused"), "an owner-paused bot isn't tightened or restarted", c1.params);
  check(/owner paused it/.test(String((await (C.bot as any).apply({ type: "adjust", strategy_id: sc.id, params: { drop_pct: 2 }, reason: "x", sources: [] }))?.outcome)), "and the AI can't adjust it either");
}

// ─── 0.9.9: a flat market with nothing to do suggests a Range bot (the owner starts it) ─────────────────
{
  const W = world();
  await W.bot.enable({});
  await new Promise((r) => setTimeout(r, 30));
  check(W.bot.view().range_idea === null, "one flat decision isn't enough");
  for (let i = 0; i < 3; i++) { W.advance(61 * 60_000); await W.bot.tick(); }
  const idea = W.bot.view().range_idea;
  check(!!idea && idea.amount_usd === 100 && idea.range_pct === 5 && /flat/.test(idea.why), "three flat decisions in 12 hours and no trades: it suggests a Range bot", idea);
  await W.bot.rangeIdeaLater();
  check(W.bot.view().range_idea === null, "Not now hides it");
  W.advance(3 * 86_400_000 + 60_000);
  W.setDecision(() => ({ assessment: "Risk on.", market_view: "risk_on", confidence: 0.7, actions: [{ type: "keep", reason: "x", sources: [] }] }));
  for (let i = 0; i < 2; i++) { W.advance(61 * 60_000); await W.bot.tick(); }
  check(W.bot.view().range_idea === null, "not when Autopilot reads the market as moving");
  const W2 = world();
  await W2.bot.enable({});
  for (let i = 0; i < 3; i++) { W2.advance(61 * 60_000); await W2.bot.tick(); }
  await W2.store.add({ kind: "range", chain: "solana", token: "SOL", amount_usd: 50, range_pct: 5 }, "owner", true);
  check(W2.bot.view().range_idea === null, "not while a Range bot is already running");
  const W3 = world();
  await W3.bot.enable({ tokens: [{ chain: "base", token: "ETH" }] });
  for (let i = 0; i < 3; i++) { W3.advance(61 * 60_000); await W3.bot.tick(); }
  check(W3.bot.view().range_idea === null, "not when Autopilot doesn't trade SOL");
}

// ─── 0.9.9: Autopilot ends a Range bot it suggested once the reason is gone; never one the owner set up alone ──
{
  const mk = async (W: any, o: { mine?: boolean; range?: any }) => {
    const r = await W.store.add({ kind: "range", chain: "solana", token: "SOL", amount_usd: 100, range_pct: 5, ...(o.mine ? {} : { suggested_by: "autopilot" }) }, "owner", true);
    await W.store.mutate((rs: any[]) => { const x = rs.find((y) => y.id === r.id); x.created_at = "2026-10-20T08:00:00.000Z"; x.state.last_price = 100; x.state.range = { mint: "m", deposited_usd: 100, value_usd: 100, in_range: true, ...o.range }; });
    return r.id as string;
  };
  const cycles = async (W: any, n: number) => { for (let i = 0; i < n; i++) { W.advance(61 * 60_000); await W.bot.tick(); } };
  // the market starts moving
  const A = world(); await A.bot.enable({});
  const a1 = await mk(A, {}), a2 = await mk(A, { mine: true });
  await cycles(A, 1);
  check(A.store.get(a1)!.status === "active", "still flat: it keeps running");
  A.setDecision(() => ({ assessment: "Breaking out.", market_view: "risk_on", confidence: 0.7, actions: [{ type: "keep", reason: "x", sources: [] }] }));
  await cycles(A, 1);
  check(A.store.get(a1)!.status === "active", "one moving read isn't enough");
  await cycles(A, 1);
  const ea = A.store.get(a1)!;
  check(ea.status === "cancelled" && /stopped being flat/.test(ea.state.note ?? "") && /Autopilot ended it/.test(ea.state.range!.log!.at(-1)!.text), "two moving reads in a row: Autopilot ends the bot it suggested", ea.state.note);
  check(A.store.get(a2)!.status === "active", "the owner's own Range bot is left alone");
  check(A.notes.some((n) => /ended your Range bot/.test(n)) && A.bot.view().decisions.some((d: any) => /Ended the Range bot/.test(d.assessment)), "it says so in the log and the notification");
  // moving the range too often
  const B = world(); await B.bot.enable({});
  const t0 = new Date(Date.parse("2026-10-20T08:00:00Z")).toISOString();
  const b1 = await mk(B, { range: { recenter_at: [t0, t0, t0] } });
  await cycles(B, 1);
  check(B.store.get(b1)!.status === "cancelled" && /moved the range 3 times/.test(B.store.get(b1)!.state.note ?? ""), "3 moves in 24 hours: ended");
  // losing more than 3%
  const C = world(); await C.bot.enable({});
  const c1 = await mk(C, { range: { value_usd: 97.5, fees_pending_usd: 0.4 } }), c2 = await mk(C, { range: { value_usd: 96.5, fees_pending_usd: 0.2 } });
  await cycles(C, 1);
  check(C.store.get(c1)!.status === "active", "down 2.1% after fees: keeps going");
  check(C.store.get(c2)!.status === "cancelled" && /down \$3\.30 \(3\.3%\)/.test(C.store.get(c2)!.state.note ?? ""), "down 3.3% after fees: ended", C.store.get(c2)!.state.note);
}

// ─── 0.9.12: Adaptive pace ──────────────────────────────────────────────────
{
  // 80 hourly closes: flat at 100 until 72 hours ago, then a straight line to `d3` % now, with the last day at `d1` %.
  const hist = (d3: number, d1: number) => { const c: number[] = Array(8).fill(100); const at24 = 100 * (1 + d3 / 100) / (1 + d1 / 100);
    for (let h = 71; h >= 0; h--) c.push(h >= 24 ? 100 + (at24 - 100) * (72 - h) / 48 : at24 + (at24 * (1 + d1 / 100) - at24) * (24 - h) / 24); return c; };
  check(marketState(hist(0.5, 0.3))?.state === "quiet" && marketState(hist(3, 2.5))?.state === "normal", "under 2% a day is quiet; between is normal");
  check(marketState(hist(4.5, 4.2))?.state === "rising" && marketState(hist(-5, -4.1))?.state === "falling", "4% in a day: rising or falling");
  check(marketState(hist(-8.5, -1))?.state === "falling" && marketState(hist(9, 1))?.state === "rising", "8% over 3 days counts while the last day goes the same way or stays flat");
  check(marketState(hist(-9, 3))?.state === "normal", "a 3-day fall with a 3% bounce today isn't 'falling'");
  check(marketState(Array(50).fill(100)) === null, "too little history: no state");
  const m = marketState(hist(-8.5, -1))!; check(m.d1 === -1 && m.d3 === -8.5, "it reports the 24-hour and 3-day moves", m);
  check(widened("grid", { range_pct: 6, levels: 9 })!.range_pct === 9 && widened("dip", { drop_pct: 2, profit_pct: 2 })!.profit_pct === 4 && widened("dip", { profit_pct: 8 }) === null && widened("dca", {}) === null,
    "rising: a grid's range × 1.5, a dip sells at 4% to 8%; nothing else is widened");
  check(raisedTarget(102, 2, 5) === 105, "a take-profit set 2% over cost moves to 5% over cost");
  { const { SUPERBOT_SYSTEM } = await import("../src/strategist.js"); check(/"adaptive" means each coin's market/.test(SUPERBOT_SYSTEM) && /"falling".*propose nothing that buys/.test(SUPERBOT_SYSTEM), "the strategist is told what Adaptive means per coin"); }

  let state = hist(-6, -4.5);
  let n = 0;
  const W = world({ closes: async () => state, decision: () => (n++ === 0
    ? { assessment: "SOL keeps sliding.", market_view: "risk_off", confidence: 0.5, actions: [{ type: "propose", template: "grid", chain: "solana", token: "SOL", params: { amount_usd: 10, range_pct: 4, levels: 9 }, reason: "Range.", sources: ["SOL -4.5%"] }] }
    : { assessment: "Quiet.", market_view: "neutral", confidence: 0.4, actions: [{ type: "keep", reason: "q", sources: [] }] }) });
  await W.bot.enable({ chains: ["base", "solana"], tokens: [{ chain: "solana", token: "SOL" }], pace: "adaptive" });
  await new Promise((r) => setTimeout(r, 30));
  const v = W.bot.view() as any;
  check(v.market?.[0]?.state === "falling" && v.market[0].d1 === -4.5, "the view shows each coin's market", v.market);
  check(v.strategies.length === 0 && /SOL is falling, and Adaptive pace starts no new buys/.test(v.decisions[0].actions[0].outcome), "falling: a new grid on SOL is refused", v.decisions[0]?.actions?.[0]?.outcome);
  const ctx = JSON.parse(W.calls.at(-1)!.body.context ? JSON.stringify(W.calls.at(-1)!.body.context) : "{}");
  check(ctx.limits?.pace === "adaptive" && ctx.market_states?.["solana:SOL"]?.state === "falling", "the strategist gets each coin's state", ctx.market_states);
  const ap = (template: string) => ({ chain: "solana", token: "SOL", template, by: "superbot" }) as any;
  check(/SOL is falling \(-4.5% in 24 hours/.test(W.bot.holdBuy(ap("grid")) ?? "") && !!W.bot.holdBuy(ap("dip")), "falling: Autopilot's grid and dip buys wait");
  check(W.bot.holdBuy(ap("dca")) === null, "Steady buyer never waits");
  check(/Big moves holds your bot's buys/.test(W.bot.holdBuy({ ...ap("grid"), template: undefined, kind: "grid", by: undefined }) ?? ""), "Nov 5: the owner's own grid waits too (Big moves, on by default)");
  await W.bot.setSettings({ moves: { own: false } });
  check(W.bot.holdBuy({ ...ap("grid"), template: undefined, kind: "grid", by: undefined }) === null, "Nov 5: with 'Guard my own bots' off, the owner's grid buys");
  state = hist(0.4, 0.2); W.advance(31 * 60_000); await W.bot.tick();
  check(W.bot.holdBuy(ap("grid")) === null && (W.bot.view() as any).market[0].state === "quiet", "once SOL steadies, buys go again");
  await W.bot.setSettings({ pace: "steady", moves: { on: false } });
  state = hist(-6, -4.5); W.advance(31 * 60_000); await W.bot.tick();
  check(W.bot.holdBuy(ap("grid")) === null && (W.bot.view() as any).market === null, "other paces with Big moves off never hold buys");
  await W.bot.setSettings({ moves: { on: true } }); W.advance(31 * 60_000); await W.bot.tick();
  check(/Big moves holds grid and dip buys/.test(W.bot.holdBuy(ap("grid")) ?? ""), "Nov 5: on Steady, Big moves still holds grid buys while the coin falls");
}
// Max moves to Adaptive once; choosing a pace by hand afterwards sticks.
{
  const W = world({ closes: async () => Array(80).fill(100) });
  await W.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"] });
  await (W.bot as any).update((x: any) => { x.settings.pace = "max"; delete x.adaptive_moved; });
  W.advance(31 * 60_000); await W.bot.tick();
  const v = W.bot.view() as any;
  check(v.settings.pace === "adaptive" && v.decisions.some((d: any) => /Pace changed from Max to Adaptive/.test(d.assessment)), "an existing Max pace becomes Adaptive, and the log says so");
  await W.bot.setSettings({ pace: "max" }); W.advance(31 * 60_000); await W.bot.tick();
  check((W.bot.view() as any).settings.pace === "max", "picking Max again afterwards keeps it");
}

// ─── Nov 5: Big moves ───────────────────────────────────────────────────────
{
  const hist = (d3: number, d1: number) => { const c: number[] = Array(8).fill(100); const at24 = 100 * (1 + d3 / 100) / (1 + d1 / 100);
    for (let h = 71; h >= 0; h--) c.push(h >= 24 ? 100 + (at24 - 100) * (72 - h) / 48 : at24 + (at24 * (1 + d1 / 100) - at24) * (24 - h) / 24); return c; };
  check(parseSettings({}).moves?.on === true && parseSettings({}).moves?.share_pct === 50 && parseSettings({ moves: { trail_pct: 5 } }).moves?.trail_pct === 5, "Nov 5: Big moves is on by default (50%, 3% trail), and its picks are kept");
  check(/Trail 2, 3, 5 or 8%/.test(err(() => parseSettings({ moves: { trail_pct: 4 } }))), "Nov 5: only the offered trail sizes");
  let state = hist(-11, -9.5);
  const W = world({ closes: async () => state });
  await W.bot.enable({ chains: ["base"], tokens: [{ chain: "base", token: "ETH" }], pace: "steady" });
  await new Promise((r) => setTimeout(r, 30));
  const { buildBot } = await import("../src/bots.js");
  const fs = await import("node:fs");
  const b = buildBot("dip", "ETH", "base", { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, 2500);
  await W.store.addBot(b.rules.map((r) => ({ ...r, bot_name: "Autopilot · Buy the dip · ETH" })), "agent", true, "superbot");
  const st = JSON.parse(fs.readFileSync(path.join(W.dir, "superbot.json"), "utf8"));
  st.strategies.push({ id: "bm1", name: "Buy the dip · ETH", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, stage: "live", bot: b.bot, created_at: "2026-10-19T00:00:00Z", stage_since: "2026-10-19T00:00:00Z", history: [] });
  fs.writeFileSync(path.join(W.dir, "superbot.json"), JSON.stringify(st));
  (W.bot as any).summaryOf = () => ({ units_held: 2, result_usd: 0, result_pct: 0, trades_ok: 1, earned_usd: 0 });
  W.advance(31 * 60_000); await W.bot.tick(); await new Promise((r) => setTimeout(r, 30));
  const ts = W.store.list().filter((r) => r.kind === "trailing_stop" && r.status === "active");
  const tp = W.store.list().find((r) => r.bot === b.bot && r.kind === "take_profit");
  check(ts.length === 1 && ts[0]!.trail_pct === 3 && ts[0]!.sell_amount === "1" && ts[0]!.by === "superbot" && ts[0]!.bot === b.bot, "Nov 5: a 9.5% drop puts a 3% trailing stop on half of what the live strategy holds", ts);
  // Nov 10 (audit): a guard that sells only its share (50% here) stays out of the take-profit's group, so the
  // take-profit still sells the rest after the guard fills; a 100% guard joins the group so only one sells.
  check(!!tp && tp.status === "active" && tp.group !== ts[0]?.group && ts[0]?.group === "guard-bm1", "Nov 10: a 50% guard stays apart from the take-profit, which keeps the rest", [tp?.group, ts[0]?.group]);
  const v = W.bot.view() as any;
  check(v.moves?.length === 1 && v.moves[0].kind === "falling" && v.moves[0].did.some((x: string) => /trailing stop/.test(x)), "Nov 5: one Big move alert, saying what it did", v.moves);
  check(W.notes.some((n) => /ETH is down 9.5% in 24 hours/.test(n)), "Nov 5: the owner is told", W.notes);
  W.advance(31 * 60_000); await W.bot.tick();
  check(W.store.list().filter((r) => r.kind === "trailing_stop" && r.status === "active").length === 1 && W.notes.filter((n) => /is down/.test(n)).length === 1, "Nov 5: one stop and one alert per move, not one per check");
  const r1 = await W.bot.moveAct(v.moves[0].key, "sell_now");
  const ls = W.store.list().filter((r) => r.kind === "limit_sell" && r.reason && /Sell now/.test(r.reason));
  check(r1.sold === 1 && ls.length === 1 && ls[0]!.sell_amount === "1" && ls[0]!.group === ts[0]!.group && ls[0]!.trigger_price! < 2500, "Nov 5: Sell now sells the protected share just under today's price, in the same group", ls);
  check(((W.bot.view() as any).moves ?? []).length === 0, "Nov 5: the alert goes away once answered");
  state = hist(0.5, 0.3); W.advance(31 * 60_000); await W.bot.tick();
  check(W.store.get(ts[0]!.id)?.status === "cancelled", "Nov 5: once the coin calms down, an unfilled trailing stop is cancelled", W.store.get(ts[0]!.id)?.status);
  // A spike: DCA buys wait near the top.
  state = hist(12, 10); W.advance(31 * 60_000); await W.bot.tick();
  check(/jumped 10% in 24 hours/.test(W.bot.holdBuy({ chain: "base", token: "ETH", template: "smart_dca", by: "superbot", kind: "smart_dca" } as any) ?? ""), "Nov 5: on a 10% spike, Autopilot's DCA buys wait near the top");
}

// ─── 0.9.13: no doubles. A bot of the same kind on the same coin that still runs blocks a new one, and a bot of a
// strategy Autopilot retired (or replaced) that kept running is stopped. ───────────────────────────────────────────
{
  const W = world({ decision: () => ({ assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, reason: "Dip buyer.", sources: ["s"] }] }) });
  const { buildBot } = await import("../src/bots.js");
  const fs = await import("node:fs");
  const old = buildBot("dip", "ETH", "base", { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, 2500);
  await W.store.addBot(old.rules.map((r) => ({ ...r, bot_name: "Autopilot · Buy the dip · ETH" })), "agent", true, "superbot");
  await W.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"] });
  await new Promise((r) => setTimeout(r, 30));
  const d = W.bot.view().decisions.find((x: any) => x.actions?.some((a: any) => a.type === "propose"));
  check(!!d && d.actions[0].applied === false && /already running/.test(d.actions[0].outcome), "0.9.13: a second dip buyer on ETH is refused while one still runs", d?.actions);
  check(W.store.list().filter((r) => r.status === "active").length === 2, "0.9.13: the one already running is left alone (Autopilot never tracked it)");
  const st = JSON.parse(fs.readFileSync(path.join(W.dir, "superbot.json"), "utf8"));
  st.strategies.push({ id: "old1", name: "Buy the dip · ETH", template: "dip", chain: "base", token: "ETH", params: {}, stage: "retired", bot: old.bot, created_at: "2026-10-19T00:00:00Z", stage_since: "2026-10-19T00:00:00Z", history: [] });
  fs.writeFileSync(path.join(W.dir, "superbot.json"), JSON.stringify(st));
  W.advance(60 * 60_000); await W.bot.tick(); await new Promise((r) => setTimeout(r, 30));
  const rs = W.store.list().filter((r) => r.bot === old.bot);
  check(rs.length === 2 && rs.every((r) => r.status === "cancelled" && /newer copy/.test(r.state.note ?? "")), "0.9.13: a retired strategy's bot that kept running is stopped, with a note", rs.map((r) => [r.status, r.state.note]));
}

// ─── 0.9.13: a strategy is rebuilt with new settings at most once every 12 hours ───────────────────────────────────
{
  let step = 0;
  const W = world({ decision: () => {
    step++;
    if (step === 1) return { assessment: "a", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, reason: "Dip buyer.", sources: ["s"] }] };
    const id = W.bot.view().strategies[0].id;
    return { assessment: "b", market_view: "neutral", confidence: 0.5, actions: [{ type: "adjust", strategy_id: id, params: { drop_pct: 5 + step }, reason: "Tweak.", sources: ["s"] }] };
  } });
  await W.bot.enable({});
  await new Promise((r) => setTimeout(r, 30));
  await W.bot.cycle(true);
  const b1 = W.bot.view().strategies[0].bot;
  W.advance(60 * 60_000); await W.bot.cycle(true);
  const v = W.bot.view(), last = v.decisions[0].actions[0];
  check(v.strategies[0].bot === b1 && last.applied === false && /12 hours/.test(last.outcome), "0.9.13: a second tweak an hour later is left alone", last);
  W.advance(12 * 3600_000); await W.bot.cycle(true);
  check(W.bot.view().strategies[0].bot !== b1, "0.9.13: after 12 hours it can change again");
}
// ─── 0.9.13: an assistant can't replace one of Autopilot's rules ────────────────────────────────────────────────────
{
  const st = new RuleStore(tmp());
  const ap = await st.add({ kind: "limit_buy", chain: "solana", token: "SOL", amount_usd: 5, trigger_price: 90 }, "agent", true, "superbot");
  const err = await st.add({ kind: "limit_buy", chain: "solana", token: "SOL", amount_usd: 6, trigger_price: 91, replaces: ap.id }, "agent", true, "claude").then(() => "", (e) => (e as Error).message);
  check(/belongs to Autopilot/.test(err) && st.list().length === 1, "0.9.13: replacing an Autopilot rule from an assistant is refused", err);
}

// ─── 0.9.13: the chat sees everything Autopilot does (autopilot_status) ─────────────────────────────────────────────
{
  const W = world({ decision: () => ({ assessment: "Quiet market; adding a dip buyer.", market_view: "neutral", confidence: 0.5, actions: [{ type: "propose", template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, reason: "Dip buyer for a quiet week.", sources: ["s"] }] }) });
  const { autopilotReport } = await import("../src/superbot.js");
  check(autopilotReport({ dir: W.dir, rules: () => W.store }).on === false, "0.9.13: before it's on, the report says so");
  await W.bot.enable({ budget_usd: 100 });
  await new Promise((r) => setTimeout(r, 30));
  const r = autopilotReport({ dir: W.dir, rules: () => W.store }) as any;
  const st = r.strategies[0], d = r.decisions.find((x: any) => x.by === "strategist");
  check(r.on && r.settings.budget_usd === 100 && st && st.template === "dip" && st.money === "practice" && st.rules.length === 2 && /Buy/.test(st.rules[0].description), "0.9.13: the report has its settings and each strategy with its stage and rules", st);
  check(d && /dip buyer/.test(d.assessment) && d.actions[0].type === "propose" && d.actions[0].applied === true && /quiet week/.test(d.actions[0].reason), "0.9.13: and its decisions, with the reason and what happened", d);
}

// ─── 0.9.13: the chat steers Autopilot: a strategy it asked for, standing notes, settings through Approvals ───────
{
  const W = world();
  await W.bot.enable({ budget_usd: 100, tokens: [{ chain: "base", token: "ETH" }], chains: ["base"] });
  await new Promise((r) => setTimeout(r, 30));
  const res = await W.bot.ownerAsk({ template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4 }, reason: "You asked for a dip buyer." });
  const v = W.bot.view();
  check(res.applied && v.strategies.some((x: any) => x.template === "dip" && x.stage === "paper"), "0.9.13: a strategy the owner asked for becomes one of Autopilot's, on paper", res);
  {
    const mine: any = W.bot.view().strategies.find((x: any) => x.template === "dip");
    const raw: any = (W.bot as any).load().strategies.find((x: any) => x.template === "dip");
    check(mine?.params?.amount_usd === 15 && raw?.owner_set === true, "Nov 7: the owner's own amount is kept ($15, not the equal share), and it's marked as theirs", mine?.params);
    const adj = await (W.bot as any).apply({ type: "adjust", strategy_id: raw.id, params: { amount_usd: 3 }, reason: "smaller" });
    const ret = await (W.bot as any).apply({ type: "retire", strategy_id: raw.id, reason: "weak" });
    check(!adj.applied && !ret.applied && /owner/.test(adj.outcome + ret.outcome), "Nov 7: Autopilot can't change or stop a strategy the owner set up", [adj, ret]);
  }
  const big = await W.bot.ownerAsk({ template: "grid", chain: "base", token: "ETH", params: { amount_usd: 90, levels: 5 } });
  check(!big.applied && /needs \$|per-trade cap/.test(big.outcome), "Nov 7: a size that doesn't fit is refused with the number, not shrunk", big);
  const again = await W.bot.ownerAsk({ template: "dip", chain: "base", token: "ETH", params: {} });
  check(again.applied, "Nov 7: the owner may run a second one of the same kind (the no-doubles rule is for Autopilot's own picks)", again);
  check(v.decisions.some((d: any) => /You asked for a dip/.test(d.assessment)), "0.9.13: the log says the owner asked for it");
  const n1 = await W.bot.setNote("add", "Be careful this week"); await W.bot.setNote("add", "be careful this week"); const n2 = await W.bot.setNote("add", "No meme coins");
  check(n1.length === 1 && n2.length === 2, "0.9.13: notes are kept once each", n2);
  W.advance(SUPERBOT.rethink[1] * 60_000 + 1000); await W.bot.cycle(true);
  check(JSON.stringify(W.calls.at(-1)?.body?.context?.owner_notes) === JSON.stringify(["Be careful this week", "No meme coins"]), "0.9.13: Autopilot's next decision gets the owner's notes", W.calls.at(-1)?.body?.context?.owner_notes);
  check((await W.bot.setNote("remove", "no meme coins")).length === 1 && (await W.bot.setNote("clear")).length === 0, "0.9.13: notes can be removed or cleared");
  const { describeSetup, SetupKinds } = await import("../src/setups.js");
  check(SetupKinds.autopilot_settings.safeParse({ pace: "max", per_trade_usd: 10 }).success && !SetupKinds.autopilot_settings.safeParse({ pace: "wild" }).success, "0.9.13: an Autopilot settings card only takes real settings");
  check(/Autopilot's most per trade to \$10/.test(describeSetup("autopilot_settings", { per_trade_usd: 10 })) && /Autopilot run a Buy the dip bot on ETH/.test(describeSetup("autopilot_strategy", { template: "dip", chain: "base", token: "ETH" })), "0.9.13: the Approvals cards say what will change");
}

// ─── 0.9.13: Turn off stops every rule Autopilot made, even ones no strategy here tracks ──────────────────────────
{
  const W = world();
  const { buildBot } = await import("../src/bots.js");
  const other = buildBot("trail", "ETH", "base", { sell_percent: 50, trail_pct: 5 }, 2500);
  await W.store.addBot(other.rules.map((r) => ({ ...r, bot_name: "Autopilot · Trailing stop · ETH" })), "agent", true, "superbot");
  const mine = await W.store.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 5, trigger_price: 1000 }, "owner", true);
  await W.bot.enable({});
  await new Promise((r) => setTimeout(r, 30));
  await W.bot.disable();
  const rs = W.store.list();
  check(rs.filter((r) => r.by === "superbot").every((r) => r.status === "cancelled") && rs.find((r) => r.id === mine.id)!.status === "active", "0.9.13: Turn off cancels every Autopilot rule, tracked or not, and leaves the owner's own rules alone", rs.map((r) => [r.by, r.status]));
}

// Nov 7: sizing from the money still free, over the slots still open.
{
  check(shareUsd(400, 116, 5) === 23.2, "old way kept when no other strategies are given: $116 over 5 slots");
  check(shareUsd(400, 116, 5, { committed: 0, live_committed: 0, count: 0 }) === 23.2, "nothing running: the same equal share");
  check(shareUsd(400, 116, 5, { committed: 75.5, live_committed: 15.78, count: 4 }) === 100.22, "4 of 5 slots taken, $15.78 held back by live ones: the last slot gets the free $100.22", shareUsd(400, 116, 5, { committed: 75.5, live_committed: 15.78, count: 4 }));
  check(shareUsd(100, 500, 4, { committed: 90, live_committed: 0, count: 2 }) === 5, "the budget still caps it: $10 of budget left over 2 slots");
  check(shareUsd(400, 10, 4, { committed: 0, live_committed: 30, count: 1 }) === 0, "live ones already need more than the cash: nothing new");
}

// Nov 7: the owner's sizing choices.
{
  check(nextSize("fixed", 100, 100, 6, 0) === 100, "fixed: always the start amount");
  check(nextSize("compound", 100, 100, 6, 0) === 106 && nextSize("compound", 100, 106, 2, 6) === 102, "compound: start plus what it has made, less what it lost");
  check(nextSize("step_up", 100, 100, 3, 0) === 125 && nextSize("step_up", 100, 125, 7, 3) === 156.25 && nextSize("step_up", 100, 156.25, 5, 7) === 100, "step up: 25% bigger after each win, back to the start after a loss");
  const { describeSetup, SetupKinds } = await import("../src/setups.js");
  check(/\$100(\.00)? a trade, adding its profits/.test(describeSetup("autopilot_strategy", { template: "dip", chain: "solana", token: "SOL", params: { amount_usd: 100, sizing: "compound" } })), "the Approvals card says the amount and the sizing", describeSetup("autopilot_strategy", { template: "dip", chain: "solana", token: "SOL", params: { amount_usd: 100, sizing: "compound" } }));
  check(SetupKinds.autopilot_action.safeParse({ action: "set_sizing", strategy_id: "abcd1234", sizing: "compound" }).success && !SetupKinds.autopilot_action.safeParse({ action: "set_sizing", strategy_id: "abcd1234", sizing: "step_up" }).success, "a sizing card only takes Same size or Add profits");
  const W = world();
  await W.bot.enable({ budget_usd: 100, tokens: [{ chain: "base", token: "ETH" }], chains: ["base"] });
  await new Promise((r) => setTimeout(r, 30));
  const res = await W.bot.ownerAsk({ template: "dip", chain: "base", token: "ETH", params: { amount_usd: 15, drop_pct: 5, profit_pct: 4, sizing: "compound" } });
  const raw: any = (W.bot as any).load().strategies.find((x: any) => x.template === "dip");
  check(res.applied && raw?.sizing === "compound" && raw?.sizing_base === 15 && raw?.params?.sizing === undefined, "the owner's sizing is kept on the strategy, not passed to the bot", raw);
  await W.bot.setSizing(raw.id, "step_up");
  check((W.bot as any).load().strategies.find((x: any) => x.id === raw.id)?.sizing === "step_up", "and can be changed later");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
