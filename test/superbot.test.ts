/** Autopilot (src/superbot.ts): settings, the cycle, the strategist's actions against the owner's limits, promotion and demotion, loss stops, the kill switch, reports. Fake wallet and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { committedUsd, DEFAULT_SETTINGS, parseSettings, SUPERBOT, SuperBot, tightened } from "../src/superbot.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twsb-"));
const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };

// ─── settings ───────────────────────────────────────────────────────────────
const s0 = parseSettings({});
check(s0.rethink_minutes === 30 && s0.budget_usd === 100 && s0.per_trade_usd === 20 && !s0.sources.x && !("reddit" in s0.sources), "defaults: 30 minutes, $100, $20 a trade, no X, no Reddit", s0);
check(/15, 30 or 60/.test(err(() => parseSettings({ rethink_minutes: 10 }))), "rethink is 15, 30 or 60");
check(/can't be more than the budget/.test(err(() => parseSettings({ budget_usd: 50, per_trade_usd: 60 }))), "per-trade cap inside the budget");
check(/network must be turned on/.test(err(() => parseSettings({ chains: ["base"], tokens: [{ chain: "solana", token: "SOL" }] }))), "a token's network must be on");
check(parseSettings({ budget_usd: 5, per_trade_usd: 5 }).budget_usd === 10 && parseSettings({ daily_loss_pct: 99 }).daily_loss_pct === 50, "numbers are clamped");
// 0.9.6: pace
check(s0.pace === "steady" && parseSettings({ pace: "active" }).pace === "active", "pace is steady by default, active when chosen");
check(/steady, active or max/.test(err(() => parseSettings({ pace: "turbo" }))) && parseSettings({ pace: "max" }).pace === "max", "only steady, active or max");
{ const { SUPERBOT_SYSTEM } = await import("../src/strategist.js");
  check(/limits\.pace/.test(SUPERBOT_SYSTEM) && /0\.25% on each buy and sell placed by grid/.test(SUPERBOT_SYSTEM), "the strategist is told what active pace means and the fees it must clear"); }
{ const { TEMPLATES } = await import("../src/bots.js");
  const sd = TEMPLATES.find((t: any) => t.id === "smart_dca")!; const d = (k: string) => (sd.fields as any[]).find((f) => f.key === k).default;
  check(d("step_pct") === 2 && d("profit_pct") === 2, "Smart DCA defaults: 2% steps, 2% profit"); }
check(committedUsd("dca", { amount_usd: 10, times: 5 }) === 50 && committedUsd("dca", { amount_usd: 10 }) === 100 && committedUsd("grid", { amount_usd: 20, levels: 6 }) === 100 && committedUsd("protect", { sell_percent: 50 }) === 0, "dollars a strategy commits");

// ─── a fake wallet, server and clock ────────────────────────────────────────
function world(o: { decision?: () => any; signals?: () => any; price?: number } = {}) {
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
  const bot = new SuperBot(w, { dir, proxy: "https://api.test/wallet", fetch, now: () => now, price: async () => o.price ?? 2500, knownToken: async (_c, t) => ["ETH", "SOL", "USDC"].includes(t.toUpperCase()), notify: async (t) => { notes.push(t); } });
  return { dir, store, bot, calls, notes, always, alwaysSol, setNow: (iso: string) => { now = Date.parse(iso); }, advance: (ms: number) => { now += ms; }, setDecision: (f: () => any) => { decision = f; }, setSignals: (f: () => any) => { signals = f; } };
}

// ─── on, first cycle, a keep decision ───────────────────────────────────────
{
  const W = world();
  const v0 = W.bot.view();
  check(!v0.enabled && v0.strategies.length === 0, "off to start");
  await W.bot.enable({ budget_usd: 100, per_trade_usd: 20 });
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
  check(v.strategies[0].params.amount_usd === 20, "dollars per level capped at the per-trade limit", v.strategies[0].params);
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
  let e2 = ""; try { await W2.bot.goLive(W2.bot.view().strategies[0].id); } catch (e) { e2 = (e as Error).message; }
  const v2 = W2.bot.view();
  check(v2.strategies[0].stage === "paper" && /budget/.test(e2), "$200 committed does not fit a $100 budget: Go live is refused, it stays on paper", e2);
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
  await s2.bot.enable({ tokens: [{ chain: "base", token: "ETH" }], chains: ["base"] });
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
  check(st.params.amount_usd === 10, "and small: $10 at most per buy", st.params);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
