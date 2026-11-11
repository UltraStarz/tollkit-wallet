/**
 * The custom bot (src/botlogic.ts kind "custom"): a bot built from five parts. First the logic alone, part by part;
 * then whole bots run by the real engine inside the backtester, fast path against slow. No network.
 */
import { applyFill, botProblem, customProblem, customSize, decide, rsi14, type BotAction, type BotState, type CustomSpec } from "../src/botlogic.js";
import { describeCustom, ruleProblem } from "../src/rules.js";
import { rsi } from "../src/indicators.js";
import { seeded, Sim, type Bar, type SimOptions, type SimResult } from "../src/backtest.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const D = 9, H = 3_600_000;

/** A tiny runner for the logic alone: asks what to do at a price and applies it at that price with no fee. */
function bot(custom: CustomSpec) {
  const p = { kind: "custom", custom };
  let s: BotState = {}, now = 0; const log: string[] = [];
  const at = (price: number, closes: number[] | null = null, hours = 0): BotAction => {
    now += hours * H;
    let a = decide(p, s, price, now, { decimals: D, closes }), guard = 0, last: BotAction = null;
    while (a && guard++ < 6) { // a mark is followed straight away by whatever comes next, as the next check would do
      last = a;
      if (a.side === "mark") s = applyFill(p, s, a, { usd: 0, got: 0n }, price, now, D).state;
      else if (a.side === "buy") { s = applyFill(p, s, a, { usd: a.usd, got: BigInt(Math.floor((a.usd / price) * 1e9)) }, price, now, D).state; log.push(`buy ${a.usd}@${price}`); }
      else { const u = Number(a.atomic) / 1e9; s = applyFill(p, s, a, { usd: u * price, got: BigInt(a.atomic) }, price, now, D).state; log.push(`sell ${a.tag}@${price}`); }
      if (a.side !== "mark") break;
      a = decide(p, s, price, now, { decimals: D, closes });
    }
    return last;
  };
  return { at, log, state: () => s, held: () => Number(s.units ?? "0") / 1e9 };
}

// ── When to buy ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  const b = bot({ buy: { type: "schedule", every_hours: 24 }, size: { usd: 10 }, limits: { max_usd: 30 } });
  b.at(100); b.at(101, null, 1); b.at(99, null, 23); b.at(98, null, 24); b.at(97, null, 24);
  check(b.log.join() === "buy 10@100,buy 10@99,buy 10@98", "schedule: buys at once, then every 24 hours, and stops at its limit ($30)", b.log);
}
{
  const b = bot({ buy: { type: "levels", step_pct: 2, levels: 3 }, size: { usd: 10 }, sell: { steps: [{ gain_pct: 3, share_pct: 100 }] }, limits: { max_usd: 100 } });
  b.at(100); b.at(99); b.at(98); b.at(97); b.at(96); b.at(94); b.at(92);
  check(b.log.join() === "buy 10@98,buy 10@96,buy 10@94" && b.state().c!.buys === 3, "levels: one buy at each 2% under the anchor, three at most", b.log);
  const avg = b.state().cost! / b.held();
  b.at(avg * 1.029); const n = b.log.length; b.at(avg * 1.031);
  check(b.log.length === n + 1 && b.held() === 0 && b.state().c!.buys === 0 && near(b.state().c!.anchor!, avg * 1.031), "…sells everything 3% over its average cost; the next round is measured from that price");
  b.at(avg * 1.031 * 1.05); b.at(avg * 1.031 * 1.05 * 0.979);
  check(b.log.at(-1)!.startsWith("buy") && near(b.state().c!.anchor!, avg * 1.031 * 1.05), "while it holds nothing the anchor follows the price up, so a rally doesn't leave it stranded", b.state().c);
}
{
  const closes = Array.from({ length: 60 }, () => 100);
  const b = bot({ buy: { type: "drop", pct: 5 }, size: { usd: 20 }, sell: { steps: [{ gain_pct: 4, share_pct: 100 }] }, limits: { max_usd: 100 } });
  b.at(96, closes); b.at(95, closes); b.at(90, closes);
  check(b.log.join() === "buy 20@95", "drop: buys once the price is 5% under where it was 24 hours ago, once a round", b.log);
  check(bot({ buy: { type: "drop", pct: 5 }, size: { usd: 20 }, limits: { max_usd: 100 } }).at(90, null) === null, "…and waits when there is no price history");
}
{
  const b = bot({ buy: { type: "price", at: 80 }, size: { usd: 20 }, limits: { max_usd: 100 } });
  b.at(81); b.at(80); b.at(70);
  check(b.log.join() === "buy 20@80", "price: buys at or under the price, once a round", b.log);
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i), r = bot({ buy: { type: "rsi", below: 30 }, size: { usd: 20 }, limits: { max_usd: 100 } });
  r.at(60, falling);
  check(r.log.length === 1 && bot({ buy: { type: "rsi", below: 30 }, size: { usd: 20 }, limits: { max_usd: 100 } }).at(140, falling) === null, "RSI: buys when hourly RSI is at or under the level, not when it is high");
  const xs = Array.from({ length: 50 }, (_, i) => 100 + 7 * Math.sin(i / 3) + (i % 5));
  check(near(rsi14(xs)!, rsi(xs)!, 1e-12) && rsi14([1, 2, 3]) === null, "the logic's RSI is the wallet's RSI, to the last digit");
}

// ── How much ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  check(customSize({ buy: { type: "price", at: 1 }, size: { usd: 20, grow: "wins" }, limits: { max_usd: 1 } }, { wins: 2 }) === 31.25 && customSize({ buy: { type: "price", at: 1 }, size: { usd: 20, grow: "wins" }, limits: { max_usd: 1 } }, { wins: 9 }) === 61.04, "growing with wins: 25% bigger after each winning round, up to five in a row");
  const b = bot({ buy: { type: "levels", step_pct: 2, levels: 3 }, size: { usd: 10, grow: "deeper", factor: 2 }, limits: { max_usd: 100 } });
  b.at(100); b.at(98); b.at(96); b.at(94);
  check(b.log.join() === "buy 10@98,buy 20@96,buy 40@94", "deeper: each further buy in a round is twice the one before", b.log);
  const w = bot({ buy: { type: "price", at: 100 }, size: { usd: 20, grow: "wins" }, sell: { steps: [{ gain_pct: 5, share_pct: 100 }] }, protect: { stop_pct: 10 }, limits: { max_usd: 500 } });
  w.at(100); w.at(106); w.at(100); w.at(89); w.at(80);
  check(w.log.join() === "buy 20@100,sell step@106,buy 25@100,sell stop@89,buy 20@80", "a winning round makes the next buy bigger; a losing one puts it back", w.log);
}

// ── When to sell ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const b = bot({ buy: { type: "price", at: 100 }, size: { usd: 100 }, sell: { steps: [{ gain_pct: 5, share_pct: 50 }], trail_pct: 4 }, limits: { max_usd: 100 } });
  b.at(100); b.at(104); b.at(105);
  check(b.log.join() === "buy 100@100,sell step@105" && near(b.held(), 0.5, 1e-9), "half at +5%", b.log);
  b.at(110); b.at(120); b.at(116); const before = b.log.length; b.at(115.1);
  check(b.log.length === before + 1 && b.log.at(-1) === "sell trail@115.1" && b.held() === 0, "…then the rest trails 4% under its high (120): sold at 115.1, not at 116", b.log);
  check(near(b.state().c!.realized!, 0.5 * 5 + 0.5 * 15.1, 1e-6) && b.state().c!.wins === 1 && b.state().cycles === 1, "what it made is counted: $2.50 on the first half, $7.55 on the rest", b.state().c);
  const t = bot({ buy: { type: "price", at: 100 }, size: { usd: 100 }, sell: { trail_pct: 5, trail_after_pct: 10 }, limits: { max_usd: 100 } });
  t.at(100); t.at(90); t.at(109); t.at(100);
  check(t.log.length === 1, "a trail that starts after +10% doesn't sell on a dip before then", t.log);
  t.at(111); t.at(120); t.at(113.9);
  check(t.log.at(-1) === "sell trail@113.9", "…and trails once the gain has been reached");
  const never = bot({ buy: { type: "price", at: 100 }, size: { usd: 100 }, limits: { max_usd: 100 } });
  never.at(100); never.at(500);
  check(never.log.length === 1, "no sell part: it never sells for profit");
}

// ── Protection and limits ────────────────────────────────────────────────────────────────────────────────────────
{
  const flat = Array.from({ length: 264 }, () => 100);
  const b = bot({ buy: { type: "levels", step_pct: 1, levels: 5 }, size: { usd: 10 }, protect: { downtrend: { hours: 240, gap_pct: 3 } }, limits: { max_usd: 100 } });
  b.at(100, flat); b.at(99, flat); b.at(98, flat); b.at(97.1, flat);
  check(b.log.length === 2 && b.held() > 0, "two levels bought, the price still within 3% of its 10-day average");
  b.at(96.9, flat);
  check(b.log.at(-1) === "sell downtrend@96.9" && b.held() === 0 && b.state().c!.out === true, "3% under the average: it sells everything to USDC and steps out", b.log);
  b.at(90, flat); b.at(102, flat);
  check(b.log.length === 3 && b.state().c!.out === true, "while out it buys nothing, however far the price falls, and doesn't come back until the price is 3% over the average");
  b.at(103.1, flat); b.at(101.9, flat);
  check(b.state().c!.out === false && b.log.at(-1) === "buy 10@101.9", "3% over the average it is back in, measuring from the price then", b.log);
  const idle = bot({ buy: { type: "price", at: 50 }, size: { usd: 10 }, protect: { downtrend: { hours: 240, gap_pct: 3 } }, limits: { max_usd: 100 } });
  idle.at(96, flat);
  check(idle.state().c?.out === true && idle.log.length === 0, "a downtrend also keeps a bot that holds nothing from starting");
  check(bot({ buy: { type: "price", at: 99 }, size: { usd: 10 }, protect: { downtrend: { hours: 240, gap_pct: 3 } }, limits: { max_usd: 100 } }).at(96, flat.slice(0, 100))?.side === "buy", "with too little history the downtrend exit stays out of the way");
}
{
  const b = bot({ buy: { type: "schedule", every_hours: 1 }, size: { usd: 50 }, limits: { max_usd: 200, max_loss_usd: 30 } });
  b.at(100); b.at(100, null, 1); b.at(100, null, 1); b.at(100, null, 1); b.at(100, null, 1);
  check(b.log.length === 4 && near(b.state().cost!, 200), "the limit: never more than $200 in the coin", b.log);
  b.at(86, null, 1); b.at(84.9, null, 1);
  check(b.log.at(-1) === "sell loss@84.9" && b.state().done === true && b.at(50, null, 5) === null, "down $30 in all: it sells everything and stops for good", b.log);
}

// ── Checks on the five parts, and their plain description ────────────────────────────────────────────────────────
{
  const ok: CustomSpec = { buy: { type: "levels", step_pct: 1, levels: 10 }, size: { usd: 25, grow: "wins" }, sell: { steps: [{ gain_pct: 5, share_pct: 50 }], trail_pct: 4 }, protect: { downtrend: { hours: 240, gap_pct: 3 } }, limits: { max_usd: 300, max_loss_usd: 30 } };
  check(customProblem(ok) === null && botProblem({ kind: "custom", custom: ok }) === null && ruleProblem({ kind: "custom", chain: "solana", token: "SOL", custom: ok }) === null, "a well-formed custom bot passes");
  const bad = (c: unknown) => customProblem(c as CustomSpec) ?? "";
  check(/needs when to buy/.test(bad(undefined)) && /at least one buy/.test(bad({ ...ok, limits: { max_usd: 10 } })) && /bigger gain/.test(bad({ ...ok, sell: { steps: [{ gain_pct: 5, share_pct: 50 }, { gain_pct: 4, share_pct: 100 }] } })) && /sell the rest/.test(bad({ ...ok, sell: { steps: [{ gain_pct: 5, share_pct: 50 }] } }))
    && /0\.4%/.test(bad({ ...ok, buy: { type: "levels", step_pct: 0.1, levels: 10 } })) && /1 to 10 days/.test(bad({ ...ok, protect: { downtrend: { hours: 500, gap_pct: 3 } } })) && /stablecoin/.test(ruleProblem({ kind: "custom", chain: "solana", token: "USDC", custom: ok }) ?? ""), "bad parts are refused in plain words");
  const words = describeCustom(ok, "SOL");
  check(words.join(" | ") === "Buys SOL every 1% down, up to 10 times | $25 a time, growing with wins | Sells 50% at +5%, then trails the rest 4% under its high | Sells to USDC in a downtrend | $300 at most, stops for good after $30 lost", "the five parts read as five short phrases", words);
}

// ── Whole bots, run by the real engine in the backtester ─────────────────────────────────────────────────────────
const T0 = Date.parse("2026-09-01T00:00:00Z");
function walk(seed: number, minutes: number, sigma: number, drift = 0): Bar[] {
  const u = seeded(seed), g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const out: Bar[] = []; let p = 100;
  for (let i = 0; i < minutes; i++) { const o = p; let h = p, l = p; for (let k = 0; k < 4; k++) { p *= Math.exp(drift / 4 + (sigma / 2) * g()); h = Math.max(h, p); l = Math.min(l, p); } out.push({ t: T0 + i * 60_000, o, h, l, c: p }); }
  return out;
}
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
const strip = (r: SimResult) => JSON.stringify(canon({ trades: r.trades.map(({ rule: _r, bot: _b, ...t }) => t), rules: r.rules.map((x) => ({ status: x.status, state: { ...x.state, last_price: 0, last_checked: "", fills: x.state.fills.map(({ ms: _m, tx: _t, ...f }) => f) } })) }));
async function both(label: string, o: SimOptions, custom: CustomSpec, min: number) {
  const run = async (fast: boolean) => { const s = new Sim({ ...o, fast }); await s.addRules([{ kind: "custom", chain: "solana", token: "SOL", custom }]); return s.run(); };
  const a = await run(true), b = await run(false);
  check(strip(a) === strip(b) && a.trades.length >= min, `fast === exact: ${label} (${a.trades.length} trades; engine runs ${a.ticks} vs ${b.ticks})`, { fast: a.trades.length, exact: b.trades.length });
  return a;
}
{
  const bars = walk(42, 4320, 0.0022), o: SimOptions = { markets: [{ symbol: "SOL", bars }], cashUsd: 1000, start: T0 + 30 * H, costs: { latencyMs: 3000, networkUsd: 0.0013, failRate: 0.1 }, seed: 3 };
  const a = await both("levels, growing size, sell in steps then trail", o, { buy: { type: "levels", step_pct: 1, levels: 6 }, size: { usd: 20, grow: "wins" }, sell: { steps: [{ gain_pct: 2, share_pct: 50 }], trail_pct: 1.5 }, limits: { max_usd: 400 } }, 8);
  check(a.trades.every((t) => near(t.fee_usd / (t.side === "buy" ? t.usd : t.units * t.mid * (1 - 0)), 0.001, 2e-4)) && a.rules[0]!.state.round_trips! > 0 && a.fails > 0, "its trades pay the 0.10% bot fee, finished sales are counted, and failed sends go through the engine's back-off", { rt: a.rules[0]!.state.round_trips, fails: a.fails });
  await both("drop buying with a stop", o, { buy: { type: "drop", pct: 2, hours: 6 }, size: { usd: 50 }, sell: { steps: [{ gain_pct: 2, share_pct: 100 }] }, protect: { stop_pct: 3 }, limits: { max_usd: 100 } }, 2);
  await both("RSI buying, trail only", o, { buy: { type: "rsi", below: 45 }, size: { usd: 50 }, sell: { trail_pct: 2, trail_after_pct: 1 }, limits: { max_usd: 100 } }, 2);
  await both("schedule with a loss limit", o, { buy: { type: "schedule", every_hours: 6 }, size: { usd: 25 }, sell: { steps: [{ gain_pct: 3, share_pct: 100 }] }, limits: { max_usd: 150, max_loss_usd: 6 } }, 3);
  // Two calm days, then a steady slide.
  const calm = walk(7, 2880, 0.0015), k = calm.at(-1)!.c / 100, slide = walk(8, 2880, 0.0015, -0.00012).map((b, i) => ({ t: calm.at(-1)!.t + (i + 1) * 60_000, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }));
  const down = [...calm, ...slide], od: SimOptions = { markets: [{ symbol: "SOL", bars: down }], cashUsd: 1000, start: T0 + 30 * H, seed: 3 };
  const spec = (exit: boolean): CustomSpec => ({ buy: { type: "levels", step_pct: 1, levels: 8 }, size: { usd: 25 }, sell: { steps: [{ gain_pct: 2, share_pct: 100 }] }, ...(exit ? { protect: { downtrend: { hours: 24, gap_pct: 2 } } } : {}), limits: { max_usd: 200 } });
  const withExit = await both("downtrend exit in a falling market", od, spec(true), 3), without = await both("the same bot without the exit", od, spec(false), 3);
  const worst = (r: SimResult) => { let top = r.curve.equity[0]!, w = 0; for (const v of r.curve.equity) { top = Math.max(top, v); w = Math.max(w, top - v); } return w; };
  check(withExit.trades.some((t) => t.side === "sell") && worst(withExit) < worst(without) && withExit.position_usd < without.position_usd, "in a steady fall the exit sells out and the worst drop is smaller than without it", { with: worst(withExit), without: worst(without) });
  check(Math.min(...a.curve.cash) >= -1e-6 && Math.max(...a.curve.position) <= 400 * 1.2, "it never spends cash it doesn't have, and stays near its $400 limit");
}

console.log(`\ncustom: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
