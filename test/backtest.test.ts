/**
 * The backtester (src/backtest.ts): prices a polling bot would see, honest fills, costs, and the proof that the fast
 * path (running the engine only when a rule could act) trades exactly like running it on every check. No network.
 */
import { backtest, Market, seeded, Sim, type Bar, type SimOptions, type SimResult } from "../src/backtest.js";
import { BOT_FEE_BPS, SWAP_FEE_BPS } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const T0 = Date.parse("2026-09-01T00:00:00Z");

/** Made-up minute candles: a random walk with `sigma` a minute, each candle built from four smaller moves. */
function walk(seed: number, minutes: number, sigma: number, start = 100, drift = 0): Bar[] {
  const u = seeded(seed), g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const out: Bar[] = []; let p = start;
  for (let i = 0; i < minutes; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 4; k++) { p *= Math.exp(drift / 4 + (sigma / 2) * g()); h = Math.max(h, p); l = Math.min(l, p); }
    out.push({ t: T0 + i * 60_000, o, h, l, c: p });
  }
  return out;
}
const flat = (minutes: number, p = 100): Bar[] => Array.from({ length: minutes }, (_, i) => ({ t: T0 + i * 60_000, o: p, h: p, l: p, c: p }));

// ── Prices inside a candle ───────────────────────────────────────────────────────────────────────────────────────
{
  const bars: Bar[] = [{ t: T0, o: 100, h: 103, l: 99, c: 102 }, { t: T0 + 60_000, o: 102, h: 102.5, l: 98, c: 99 }, { t: T0 + 4 * 60_000, o: 99, h: 99, l: 99, c: 99 }];
  const m = new Market({ symbol: "sol", bars }, 1, true);
  check(m.symbol === "SOL" && m.n === 5 && m.filled === 2, "a market fills missing candles flat at the last close", { n: m.n, filled: m.filled });
  check(m.priceAt(T0) === 100 && near(m.priceAt(T0 + 20_000), 99, 1e-9) && near(m.priceAt(T0 + 40_000), 103, 1e-9) && near(m.priceAt(T0 + 59_999), 102, 1e-3), "a rising candle runs open, low, high, close");
  check(near(m.priceAt(T0 + 80_000), 102.5, 1e-9) && near(m.priceAt(T0 + 100_000), 98, 1e-9), "a falling candle runs open, high, low, close");
  check(m.priceAt(T0 + 150_000) === 99 && m.priceAt(T0 - 5) === 100 && m.priceAt(T0 + 10 * 60_000) === 99, "a gap stays at the last close; before the data is the first open, after it the last close");
  const a = new Market({ symbol: "SOL", bars }, 7, false), b = new Market({ symbol: "SOL", bars }, 7, false), c = new Market({ symbol: "SOL", bars }, 8, false);
  const at = [5_000, 17_000, 31_000, 44_000, 58_000].map((x) => T0 + x);
  check(at.every((t) => a.priceAt(t) === b.priceAt(t)) && at.some((t) => a.priceAt(t) !== c.priceAt(t)), "seeded timing: the same seed gives the same path, another seed a different one");
  check(at.every((t) => a.priceAt(t) >= 99 - 1e-9 && a.priceAt(t) <= 103 + 1e-9), "the path never leaves the candle's low and high");
}
{
  // Hourly closes as the app reads them: finished hours, then the hour in progress, re-read every 10 minutes.
  const bars = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * 60_000, o: 100 + i, h: 100 + i + 1, l: 100 + i, c: 100 + i + 1 }));
  const m = new Market({ symbol: "SOL", bars }, 1, true);
  check(m.hourly(T0 + 30 * 60_000) === null, "no hourly closes before an hour has finished");
  const h = m.hourly(T0 + 125 * 60_000)!; // 2 hours finished; read at minute 120
  check(h.length === 3 && h[0] === 160 && h[1] === 220 && h[2] === 220, "two finished hours and the hour in progress, as read at the last 10-minute mark", h);
  check(m.hourly(T0 + 129 * 60_000) === h && m.hourly(T0 + 131 * 60_000) !== h, "the reading is kept for 10 minutes");
}

// ── Costs: a round trip at a flat price loses exactly its costs ──────────────────────────────────────────────────
{
  const sim = new Sim({ markets: [{ symbol: "SOL", bars: flat(600), impactBps: (usd) => 5 + usd / 100 }], cashUsd: 1000, costs: { networkUsd: 0.01 }, pollMs: 15_000 });
  await sim.addBot("twap", "SOL", { side: "buy", amount_usd: 200, pieces: 2, hours: 1 });
  const r = await sim.run();
  const t = r.trades;
  check(t.length === 2 && t.every((x) => x.side === "buy" && x.usd === 100), "a split buy of $200 in 2 parts makes two $100 buys", t.length);
  const fee = 100 * (BOT_FEE_BPS / 1e4), imp = (100 - fee) * ((6 / 1e4) / (1 + 6 / 1e4));
  check(near(t[0]!.fee_usd, fee, 1e-9) && near(t[0]!.impact_usd, imp, 1e-9) && t[0]!.network_usd === 0.01 && near(t[0]!.delay_usd, 0, 1e-12), "each buy pays the bot fee, 6 bps of spread and impact, and 1 cent of network cost", t[0]);
  check(near(t[0]!.units, (100 - fee) / (100 * (1 + 6 / 1e4)), 1e-8), "units bought = dollars after the fee, over the price with its impact", t[0]!.units);
  check(near(r.pnl_usd, -(r.costs.fee_usd + r.costs.impact_usd + r.costs.network_usd), 1e-6) && near(r.costs.total_usd, 2 * (fee + imp + 0.01), 1e-9), "at a flat price the account is down by exactly its costs", { pnl: r.pnl_usd, costs: r.costs });
  check(near(r.equity_usd, r.cash_usd + r.position_usd - r.costs.network_usd, 1e-9) && near(r.cash_usd, 800, 1e-9), "value = cash + coins at the market price − network costs");
}
{
  // Grid trades pay the bot fee; scale 0 is the zero-fee benchmark; scale 1.5 the stress test.
  const bars = walk(3, 1440, 0.002);
  const run = (scale: number) => backtest({ markets: [{ symbol: "SOL", bars, impactBps: () => 4 }], cashUsd: 1000, costs: { scale, networkUsd: 0.002 }, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 20, range_pct: 6, levels: 13 } }] });
  const a = await run(1), z = await run(0), s = await run(1.5);
  const buy = a.trades.find((t) => t.side === "buy")!;
  check(a.trades.length > 6 && near(buy.fee_usd / buy.usd, BOT_FEE_BPS / 1e4, 1e-12), "grid trades pay the bot fee", { n: a.trades.length, fee: buy.fee_usd / buy.usd });
  check(z.costs.fee_usd === 0 && z.costs.impact_usd === 0 && z.costs.network_usd === 0 && z.trades.length > 0, "cost scale 0: no fee, no impact, no network cost (the zero-fee benchmark)", z.costs);
  check(near(s.trades[0]!.fee_usd / s.trades[0]!.usd, 1.5 * BOT_FEE_BPS / 1e4, 1e-12) && s.trades[0]!.network_usd === 0.003, "cost scale 1.5 raises every cost by half (the stress test)");
  check(z.pnl_usd > a.pnl_usd && a.pnl_usd > s.pnl_usd, "more cost, less money: zero-fee > normal > stressed", [z.pnl_usd, a.pnl_usd, s.pnl_usd]);
}

// ── Honest fills: at the price a moment after deciding, never at the level ───────────────────────────────────────
{
  // The price slides from 100 to 90 over 10 hours; a dip bot waits at 95 (5% under the 100 it started at).
  const bars: Bar[] = Array.from({ length: 600 }, (_, i) => { const o = 100 - i / 60, c = 100 - (i + 1) / 60; return { t: T0 + i * 60_000, o, h: o, l: c, c }; });
  const sim = new Sim({ markets: [{ symbol: "SOL", bars }], cashUsd: 500, pollMs: 15_000, costs: { latencyMs: 45_000 }, timing: "fixed" });
  const { rules } = await sim.addBot("dip", "SOL", { amount_usd: 50, drop_pct: 5, profit_pct: 8 });
  const r = await sim.run(), t = r.trades[0]!, trig = rules[0]!.trigger_price!;
  check(r.trades.length === 1 && t.side === "buy" && t.seen <= trig && t.seen > trig - 0.02, "the dip buy fires on the first check at or under its price", { seen: t?.seen, trig });
  check(t.mid < t.seen && near(t.mid, sim.markets[0]!.priceAt(t.t + 45_000), 1e-12) && t.delay_usd < 0, "it fills at the market price when the trade lands (45 seconds later here), not at the trigger; the fall helped the buyer", { seen: t.seen, mid: t.mid });
  check(near(t.usd / t.units, t.mid / (1 - BOT_FEE_BPS / 1e4), 1e-6), "the all-in price is the market price plus the fee", t.usd / t.units);
  check(t.rule === rules[0]!.id && t.template === "dip" && t.kind === "limit_buy" && !!t.bot, "each trade is tagged with its rule, bot and template");
  check(r.bots.length === 1 && r.bots[0]!.trades_ok === 1 && r.bots[0]!.spent_usd === 50 && near(r.bots[0]!.units_held, t.units, 1e-9), "the bot summary is the app's own (src/bots.ts summarize)", r.bots[0]);
}
{
  // A token priced by a quote is seen up to a minute late.
  const bars: Bar[] = Array.from({ length: 120 }, (_, i) => { const o = 1 - i * 0.002, c = 1 - (i + 1) * 0.002; return { t: T0 + i * 60_000, o, h: o, l: c, c }; });
  const mk = (staleMs: number) => backtest({ markets: [{ symbol: "MEME", token: "MemeMint1111111111111111111111111111111111", decimals: 6, bars, staleMs }], cashUsd: 100, timing: "fixed", bots: [{ template: "dip", token: "MEME", params: { amount_usd: 10, drop_pct: 5, profit_pct: 8 } }] });
  const fresh = await mk(0), stale = await mk(60_000);
  check(fresh.trades.length === 1 && stale.trades.length === 1 && stale.trades[0]!.t >= fresh.trades[0]!.t && stale.trades[0]!.t - fresh.trades[0]!.t <= 60_000, "a quote-priced token: the buy comes up to a minute later", [fresh.trades[0]?.t, stale.trades[0]?.t]);
  check(stale.trades[0]!.mid <= stale.trades[0]!.seen && stale.rules[0]!.token === "MemeMint1111111111111111111111111111111111", "and fills at the market's price then, lower than the old price it acted on");
}

// ── Cash, limits and failed sends ────────────────────────────────────────────────────────────────────────────────
{
  const bars = walk(11, 2880, 0.0025, 100, -0.00004);
  const base: SimOptions = { markets: [{ symbol: "SOL", bars }], pollMs: 15_000 };
  const rich = await backtest({ ...base, cashUsd: 5000, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 10, levels: 21 } }] });
  const poor = await backtest({ ...base, cashUsd: 120, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 10, levels: 21 } }] });
  check(Math.min(...rich.curve.cash) < 4800 && Math.min(...poor.curve.cash) >= 0 && poor.trades.filter((t) => t.side === "buy").length < rich.trades.filter((t) => t.side === "buy").length, "live rules share real cash: a buy with no cash behind it waits", { rich: rich.trades.length, poor: poor.trades.length });
  check(poor.rules.some((r) => /Waiting for cash/.test(r.state.last_error ?? "")) || (poor.events.skipped ?? 0) > 0, "the engine's own cash check held the buy (not a failed trade)", poor.events);
  const paper = await backtest({ ...base, mode: "paper", bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 10, levels: 21 } }] });
  check(paper.trades.length === rich.trades.length && paper.trades.every((t) => t.mode === "paper") && paper.rules.every((r) => r.paper === true && r.state.fills.every((f) => !f.ok || f.paper)), "practice mode: cash never runs out and every fill is marked paper", paper.trades.length);
  const capped = await backtest({ ...base, cashUsd: 5000, limits: { dailyUsd: 100 }, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 10, levels: 21 } }] });
  const perDay = new Map<number, number>(); for (const t of capped.trades) { const d = Math.floor(t.t / 86_400_000); perDay.set(d, (perDay.get(d) ?? 0) + (t.side === "buy" ? t.usd : t.units * t.mid)); }
  check(capped.trades.length > 0 && [...perDay.values()].every((v) => v <= 100 + 1e-6) && capped.trades.length < rich.trades.length, "the owner's daily trading limit is never passed", [...perDay.values()]);
  const flaky = await backtest({ ...base, cashUsd: 5000, costs: { failRate: 0.3 }, seed: 5, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 10, levels: 21 } }] });
  check(flaky.fails > 0 && (flaky.events.failed ?? 0) === flaky.fails && flaky.rules[0]!.state.fills.some((f) => !f.ok), "failed sends are counted and go through the engine's own back-off", { fails: flaky.fails, events: flaky.events });
}

// ── Two engines over one set of rules, as in the app: practice rules never trade real money ──────────────────────
{
  const bars = walk(21, 1440, 0.002);
  const sim = new Sim({ markets: [{ symbol: "SOL", bars }], mode: "none" });
  let paperIds = new Set<string>();
  sim.addEngine("live", { cashUsd: 1000, options: { skip: (id) => paperIds.has(id) } });
  sim.addEngine("paper", { options: { skip: (id) => !paperIds.has(id) } });
  await sim.addBot("grid", "SOL", { amount_usd: 20, range_pct: 5, levels: 11 });
  const p = await sim.addBot("grid", "SOL", { amount_usd: 30, range_pct: 5, levels: 11 }, { paper: true });
  paperIds = new Set(p.rules.map((r) => r.id));
  const r = await sim.run();
  const live = r.trades.filter((t) => t.mode === "live"), paper = r.trades.filter((t) => t.mode === "paper");
  check(live.length > 0 && paper.length > 0 && live.every((t) => t.rule !== p.rules[0]!.id && near(t.side === "buy" ? t.usd : 20, 20, 1e-9)) && paper.every((t) => t.rule === p.rules[0]!.id), "the live engine trades the real bot, the practice engine the practice bot", { live: live.length, paper: paper.length });
  check(near(sim.engines[0]!.exec.cash, 1000 - live.reduce((a, t) => a + (t.side === "buy" ? t.usd : -t.usd), 0), 1e-6) && r.rules.find((x) => x.id === p.rules[0]!.id)!.state.fills.every((f) => f.paper), "real cash moves only for real trades");
}

{
  // Review round 1: a practice trailing stop beside a busy live rule keeps its high; and a skip that changes with time is asked every check.
  for (const seed of [6, 9]) {
    const bars = walk(seed, 2880, 0.0022);
    const run = async (fast: boolean) => {
      const sim = new Sim({ markets: [{ symbol: "SOL", bars }], mode: "none", fast });
      let paper = new Set<string>();
      sim.addEngine("live", { cashUsd: 5000, options: { skip: (id) => paper.has(id) } });
      sim.addEngine("paper", { options: { skip: (id) => !paper.has(id) } });
      sim.deposit("SOL", 3, 1);
      await sim.addBot("twap", "SOL", { side: "buy", amount_usd: 480, pieces: 48, hours: 48 });
      paper = new Set((await sim.addBot("trail", "SOL", { sell_percent: 50, trail_pct: 1.5 }, { paper: true })).rules.map((r) => r.id));
      const r = await sim.run();
      return r.trades.filter((t) => t.mode === "paper").map((t) => [t.t, t.usd]);
    };
    const a = await run(true), b = await run(false);
    check(a.length === 1 && JSON.stringify(a) === JSON.stringify(b), `two engines: the practice trailing stop sells at the same moment fast and exact (path ${seed})`, { a, b });
  }
  const bars: Bar[] = Array.from({ length: 720 }, (_, i) => { const o = 100 - i / 72, c = 100 - (i + 1) / 72; return { t: T0 + i * 60_000, o, h: o, l: c, c }; });
  for (const fast of [true, false]) {
    const sim: Sim = new Sim({ markets: [{ symbol: "SOL", bars }], cashUsd: 500, fast, engine: { skip: () => sim.clock < T0 + 5 * 3_600_000 } });
    await sim.addRules([{ chain: "solana", token: "SOL", kind: "limit_buy", amount_usd: 50, trigger_price: 97 }]);
    const r = await sim.run();
    check(r.trades.length === 1 && r.trades[0]!.t >= T0 + 5 * 3_600_000 && r.trades[0]!.t < T0 + 5 * 3_600_000 + 30_000, `a rule skipped for the first five hours trades as soon as it may (${fast ? "fast" : "exact"})`, r.trades.map((t) => t.t - T0));
  }
  const s2 = new Sim({ markets: [{ symbol: "SOL", bars: flat(600) }], cashUsd: 1000, sampleMs: 7 * 60_000 });
  await s2.addBot("twap", "SOL", { side: "buy", amount_usd: 200, pieces: 2, hours: 1 });
  const r2 = await s2.run();
  {
    // A trade at the very last check is in the closing value.
    const bars: Bar[] = [...flat(120), { t: T0 + 120 * 60_000, o: 96, h: 96, l: 96, c: 96 }];
    const s3 = new Sim({ markets: [{ symbol: "SOL", bars }], cashUsd: 1000, sampleMs: 3_600_000, end: T0 + 120 * 60_000, costs: { networkUsd: 0.5 } });
    await s3.addRules([{ chain: "solana", token: "SOL", kind: "limit_buy", amount_usd: 500, trigger_price: 97 }]);
    const r3 = await s3.run(), again = await s3.run(T0 + 500 * 60_000);
    check(r3.trades.length === 1 && Math.abs(r3.curve.equity.at(-1)! - 1000 - r3.pnl_usd) < 1e-9 && r3.curve.position.at(-1)! > 490 && r3.curve.t.length === 3 && again.curve.t.length === 3, "a trade on the last check shows in the closing value; running past the end adds nothing", { pnl: r3.pnl_usd, curve: r3.curve.equity, t: again.curve.t.length });
  }
  check(r2.curve.equity[0] === 1000 && Math.abs(r2.curve.equity.at(-1)! - r2.equity_usd) < 1e-9 && r2.curve.t.at(-1) === r2.to, "the value curve starts at the starting value (before the first trade's costs) and ends at the end", [r2.curve.equity[0], r2.curve.equity.at(-1), r2.equity_usd]);
}

// ── The short cut changes nothing: fast === exact, for every kind of rule ────────────────────────────────────────
/** Everything that matters, in one string: keys sorted, and the things that differ by design left out (random rule ids, the bookkeeping fields the engine writes on every check). */
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : typeof v === "string" ? v.replace(/rule [0-9a-f]{8}/g, "rule #") : v;
const strip = (r: SimResult) => JSON.stringify(canon({ trades: r.trades.map(({ rule: _r, bot: _b, ...t }) => t), rules: r.rules.map((x) => ({ kind: x.kind, status: x.status,
  state: { ...x.state, last_price: 0, last_checked: "", alert_now: "", fills: x.state.fills.map(({ ms: _m, tx: _t, ...f }) => f) } })) }));
async function both(label: string, o: SimOptions, setup: (s: Sim) => Promise<void>, min = 1) {
  const run = async (fast: boolean) => { const s = new Sim({ ...o, fast }); await setup(s); return s.run(); };
  const a = await run(true), b = await run(false);
  const same = strip(a) === strip(b);
  check(same && a.trades.length >= min && a.ticks < b.ticks, `fast === exact: ${label} (${a.trades.length} trades; engine runs ${a.ticks} vs ${b.ticks})`, same ? { trades: a.trades.length } : { fast: a.trades.length, exact: b.trades.length, firstDiff: a.trades.findIndex((t, i) => JSON.stringify({ ...t, rule: 0, bot: 0 }) !== JSON.stringify({ ...b.trades[i], rule: 0, bot: 0 })) });
  return a;
}
{
  const bars = walk(42, 2160, 0.0022), sol = { symbol: "SOL", bars, impactBps: (usd: number) => 1 + usd / 500 };
  const o: SimOptions = { markets: [sol], cashUsd: 2000, pollMs: 15_000, costs: { latencyMs: 3000, networkUsd: 0.0013 }, seed: 9 };
  await both("grid", o, async (s) => { await s.addBot("grid", "SOL", { amount_usd: 20, range_pct: 6, levels: 13 }); }, 8);
  await both("Smart DCA", o, async (s) => { await s.addBot("smart_dca", "SOL", { amount_usd: 20, step_pct: 1, safety: 4, scale: "1.5", profit_pct: 1 }); }, 3);
  await both("infinity grid", o, async (s) => { await s.addBot("infinity_grid", "SOL", { amount_usd: 200, step_pct: 1, floor_pct: 30 }); }, 3);
  await both("rebalancer", o, async (s) => { await s.addBot("rebalance", "SOL", { amount_usd: 400, target_pct: 50, band_pct: 1 }); }, 2);
  await both("split buy", o, async (s) => { await s.addBot("twap", "SOL", { side: "buy", amount_usd: 300, pieces: 12, hours: 6 }); }, 12);
  await both("split sell", o, async (s) => { s.deposit("SOL", 5); await s.addBot("twap", "SOL", { side: "sell", sell_percent: 60, pieces: 6, hours: 3 }); }, 6);
  await both("dip with its take-profit", o, async (s) => { await s.addBot("dip", "SOL", { amount_usd: 50, drop_pct: 1, profit_pct: 1.5 }); }, 1);
  await both("protect (stop and take-profit, one cancels the other)", o, async (s) => { s.deposit("SOL", 3); await s.addBot("protect", "SOL", { sell_percent: 100, stop_pct: 2, profit_pct: 2 }); }, 1);
  await both("trailing stop", o, async (s) => { s.deposit("SOL", 3); await s.addBot("trail", "SOL", { sell_percent: 50, trail_pct: 1.5 }); }, 1);
  await both("take-profit ladder", o, async (s) => { s.deposit("SOL", 4); await s.addBot("ladder", "SOL", { step1: 1, step2: 2, step3: 3 }); }, 1);
  await both("steady buyer", o, async (s) => { await s.addBot("dca", "SOL", { amount_usd: 10, every: "day", times: 0 }); }, 2);
  const week = { ...o, markets: [{ ...sol, bars: walk(44, 7200, 0.0022) }] };
  for (const [signal, level] of [["rsi_below", 35], ["rsi_above", 65], ["macd_up", 0], ["macd_down", 0], ["breakout_up", 12], ["breakout_down", 12]] as const)
    await both(`signal buy on ${signal}`, week, async (s) => { await s.addBot("signal", "SOL", { side: "buy", signal, tf: "1h", level, amount_usd: 15, times: 6 }); }, 1);
  await both("signal sell on rsi_above", o, async (s) => { s.deposit("SOL", 4); await s.addBot("signal", "SOL", { side: "sell", signal: "rsi_above", tf: "1h", level: 60, sell_pct: 25, times: 4 }); }, 1);
  await both("4-hour signal", { ...o, markets: [{ ...sol, bars: walk(43, 7200, 0.0022) }] }, async (s) => { await s.addBot("signal", "SOL", { side: "buy", signal: "rsi_below", tf: "4h", level: 45, amount_usd: 15, times: 5 }); }, 1);
  // Everything at once, sharing one wallet, with failed sends, a stale price feed and a daily limit.
  const hard: SimOptions = { ...o, markets: [{ ...sol, staleMs: 60_000 }], cashUsd: 600, costs: { latencyMs: 3000, networkUsd: 0.0013, failRate: 0.15 }, limits: { dailyUsd: 900 } };
  const all = await both("a portfolio: grid, Smart DCA, dip, signal, trailing stop and ladder on one wallet, with failures and limits", hard, async (s) => {
    s.deposit("SOL", 2);
    await s.addBot("grid", "SOL", { amount_usd: 25, range_pct: 6, levels: 13 });
    await s.addBot("smart_dca", "SOL", { amount_usd: 20, step_pct: 1, safety: 3, scale: "2", profit_pct: 1 });
    await s.addBot("dip", "SOL", { amount_usd: 60, drop_pct: 1.5, profit_pct: 2 });
    await s.addBot("signal", "SOL", { side: "buy", signal: "rsi_below", tf: "1h", level: 40, amount_usd: 30, times: 5 });
    await s.addBot("trail", "SOL", { sell_percent: 50, trail_pct: 2 });
    await s.addBot("ladder", "SOL", { step1: 1.5, step2: 3, step3: 5 });
    s.at(T0 + 20 * 3_600_000, async (x) => { await x.addBot("infinity_grid", "SOL", { amount_usd: 100, step_pct: 1, floor_pct: 20 }); });
  }, 15);
  check(all.fails > 0 && Math.min(...all.curve.cash) >= -1e-6, "…and in that run sends failed and cash never went below zero", { fails: all.fails, minCash: Math.min(...all.curve.cash) });
}

// ── Same inputs, same answer; speed ──────────────────────────────────────────────────────────────────────────────
{
  const bars = walk(77, 20_160, 0.0015);
  const run = (seed: number) => backtest({ markets: [{ symbol: "SOL", bars }], cashUsd: 2000, seed, costs: { failRate: 0.05, latencyMs: 3000 }, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 20, range_pct: 8, levels: 17 } }] });
  const a = await run(3), b = await run(3), c = await run(4);
  check(JSON.stringify(a.trades.map(({ rule: _r, bot: _b, ...t }) => t)) === JSON.stringify(b.trades.map(({ rule: _r, bot: _b, ...t }) => t)) && a.pnl_usd === b.pnl_usd, "the same seed gives the same trades, to the last digit", a.trades.length);
  check(JSON.stringify(a.trades.map((t) => t.t)) !== JSON.stringify(c.trades.map((t) => t.t)), "another seed moves where prices fall inside each candle, so trades shift a little");
}
{
  const bars = walk(5, 525_600, 0.0006);
  const t0 = Date.now();
  const r = await backtest({ markets: [{ symbol: "SOL", bars }], cashUsd: 5000, pollMs: 15_000, bots: [{ template: "grid", token: "SOL", params: { amount_usd: 50, range_pct: 20, levels: 21 } }] });
  const ms = Date.now() - t0;
  console.log(`  one year of minute candles, checked every 15 s: ${r.polls.toLocaleString()} checks, ${r.ticks.toLocaleString()} engine runs, ${r.trades.length} trades, ${ms} ms`);
  check(r.polls === 2_102_400 && ms < 15_000, "a year of minute candles for one strategy runs in seconds", { ms, polls: r.polls });
}

console.log(`\nbacktest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
