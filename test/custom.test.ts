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
  check(w.log.join() === "buy 20@100,sell step@106,buy 25@100,sell stop@89", "after a stop it does not buy at the next check (review, Nov 11)", w.log);
  w.at(80, null, 23); const n23 = w.log.length; w.at(80, null, 2);
  check(n23 === 4 && w.log.join() === "buy 20@100,sell step@106,buy 25@100,sell stop@89,buy 20@80", "a winning round makes the next buy bigger; a losing one puts it back, a day after the stop", w.log);
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

// ── Review fixes, Nov 11, 2026 ───────────────────────────────────────────────────────────────────────────────────
{
  const { cleanCustomState, cleanCustom } = await import("../src/botlogic.js");
  const P = (custom: CustomSpec) => ({ kind: "custom", custom });
  // A "sell everything" the wallet cut short by a sliver still ends the round.
  const c1: CustomSpec = { buy: { type: "levels", step_pct: 1, levels: 3 }, size: { usd: 10 }, sell: { steps: [{ gain_pct: 2, share_pct: 100 }] }, limits: { max_usd: 30 } };
  let s: BotState = { units: "1000000000", cost: 100, c: { anchor: 100, buys: 1 } };
  const a1 = decide(P(c1), s, 103, 0, { decimals: D }) as any;
  const cut = applyFill(P(c1), s, a1, { usd: 102.9, got: 999_999_000n }, 103, 0, D).state;
  check(a1.side === "sell" && cut.units === "0" && cut.cost === 0 && cut.c!.buys === 0 && cut.cycles === 1, "a sell of everything cut short by a sliver ends the round", cut);
  // Cut short by a lot: the rest stays, and is sold at the next check even though the steps are done.
  const half = applyFill(P(c1), s, a1, { usd: 51.5, got: 500_000_000n }, 103, 0, D).state;
  const a2 = decide(P(c1), half, 103, 0, { decimals: D }) as any;
  check(half.units === "500000000" && half.c!.step === 1 && a2?.side === "sell" && a2.atomic === "500000000", "cut short by a lot: what is left is sold at the next check", { half, a2 });
  // The fee paid beside the swap must not cancel the last planned buy.
  const c3: CustomSpec = { buy: { type: "levels", step_pct: 1, levels: 6 }, size: { usd: 25 }, sell: { steps: [{ gain_pct: 50, share_pct: 100 }] }, limits: { max_usd: 150 } };
  const a3 = decide(P(c3), { units: "1300000000", cost: 125.125, c: { anchor: 100, buys: 5 } }, 93, 0, { decimals: D }) as any;
  check(a3?.side === "buy" && a3.usd === 25, "five buys that each cost 0.1% more still leave room for the sixth", a3);
  check(decide(P(c3), { units: "1560000000", cost: 150.15, c: { anchor: 100, buys: 5 } }, 80, 0, { decimals: D }) === null, "and nothing past the limit");
  // A step worth under $1 sells everything rather than a crumb.
  const c4: CustomSpec = { buy: { type: "price", at: 100 }, size: { usd: 1 }, sell: { steps: [{ gain_pct: 1, share_pct: 1 }, { gain_pct: 2, share_pct: 100 }] }, limits: { max_usd: 1 } };
  const a4 = decide(P(c4), { units: "10000000", cost: 1, c: { buys: 1 } }, 101.5, 0, { decimals: D }) as any;
  check(a4?.side === "sell" && a4.atomic === "10000000", "a sell step worth under $1 sells everything", a4);
  // What customProblem now refuses.
  const base: CustomSpec = { buy: { type: "levels", step_pct: 1, levels: 5 }, size: { usd: 25 }, sell: { trail_pct: 4 }, limits: { max_usd: 125 } };
  check(/whole|168 hours/.test(customProblem({ ...base, buy: { type: "drop", pct: 5, hours: 1.5 } }) ?? "") && /price of zero/.test(customProblem({ ...base, buy: { type: "levels", step_pct: 50, levels: 5 } }) ?? "") && /at least 2% of one buy/.test(customProblem({ ...base, limits: { max_usd: 125, max_loss_usd: 0.01 } }) ?? "")
    && /Start trailing/.test(customProblem({ ...base, sell: { trail_pct: 4, trail_after_pct: "x" as any } }) ?? "") && /Pick how the size changes/.test(customProblem({ ...base, size: { usd: 25, grow: "big" as any } }) ?? "") && /must be a list/.test(customProblem({ ...base, sell: { steps: {} as any, trail_pct: 4 } }) ?? "")
    && /1% to 90%/.test(customProblem({ ...base, protect: { stop_pct: 0.5 } }) ?? "") && customProblem(base) === null, "refused: fractional hours, levels reaching zero, a loss limit under one buy's fee, a bad trail start, size rule or steps, a stop under 1%");
  // Past its loss limit it starts no new round.
  check(decide(P({ ...base, limits: { max_usd: 125, max_loss_usd: 10 } }), { units: "0", cost: 0, c: { anchor: 100, realized: -11 } }, 90, 0, { decimals: D }) === null, "past its loss limit it starts no new round");
  // The downtrend exit works on a little less history than asked, and state from outside is cleaned.
  const dt: CustomSpec = { ...base, protect: { downtrend: { hours: 240, gap_pct: 3 } } };
  const a5 = decide(P(dt), { units: "1000000000", cost: 100, c: { anchor: 100, buys: 1 } }, 90, 0, { decimals: D, closes: Array(186).fill(100) }) as any;
  check(a5?.side === "sell" && a5.tag === "downtrend" && (decide(P(dt), { units: "1000000000", cost: 100, c: { anchor: 100, buys: 1 } }, 90, 0, { decimals: D, closes: Array(100).fill(100) }) as any)?.tag !== "downtrend", "the downtrend exit works with 186 of 240 hours, and waits with far too few", a5);
  const cs = cleanCustomState({ step: -1, buys: 2.7, wins: "3", anchor: -5, peak: 110, realized: -4, rest_until: 99, out: true, evil: 1 }) as any;
  check(cs.step === undefined && cs.buys === 2 && cs.wins === undefined && cs.anchor === undefined && cs.peak === 110 && cs.realized === -4 && cs.rest_until === 99 && cs.out === true && cs.evil === undefined, "state from outside: counts whole and never negative, prices positive", cs);
  check(decide(P(c1), { units: "1000000000", cost: 100, c: { step: -1 as any } }, 103, 0, { decimals: D }) !== undefined && cleanCustom({ buy: { type: "drop", pct: 5 }, size: { usd: 5 }, limits: { max_usd: 5 } })?.buy.type === "drop", "a bad step count no longer throws");
  check(describeCustom({ ...base, sell: { trail_pct: 4, trail_after_pct: 6 }, protect: { stop_pct: 8 } }, "SOL").join("; ").includes("trails 4% under its high once it is up 6%; Stops 8% under its cost, then waits a day"), "the card says when the trail starts and that a stop is followed by a day's wait");
}

// ── Phase 3 (Nov 11, 2026): the trend part, long or flat with the slow trend, decided once a day ──────────────────
{
  const { trendState } = await import("../src/botlogic.js");
  const flat = (n: number, v: number) => Array(n).fill(v);
  check(trendState(flat(60, 100), 100, 3) === null && trendState([...flat(99, 100), 104], 100, 3)!.side === "in" && trendState([...flat(99, 100), 96], 100, 3)!.side === "out" && trendState([...flat(99, 100), 102], 100, 3)!.side === "hold", "the last daily close against its average: in over the gap, out under it, hold between, nothing without enough days");
  const T: CustomSpec = { buy: { type: "trend", days: 100, gap_pct: 3 }, size: { usd: 100 }, limits: { max_usd: 100 } };
  const P = { kind: "custom", custom: T };
  check(customProblem(T) === null && /20 to 200 days/.test(customProblem({ ...T, buy: { type: "trend", days: 10, gap_pct: 3 } }) ?? "") && /0\.5% to 20%/.test(customProblem({ ...T, buy: { type: "trend", days: 100, gap_pct: 30 } }) ?? "") && /20 to 200 days/.test(customProblem({ ...T, buy: { type: "trend", days: 100.5, gap_pct: 3 } }) ?? ""), "a trend bot needs no sell part; its average and gap are checked");
  const up = [...flat(99, 100), 104], down = [...flat(99, 100), 96], mid = [...flat(99, 100), 101];
  const b1 = decide(P, {}, 104, 0, { decimals: D, daily: up }) as any;
  check(b1?.side === "buy" && b1.usd === 100 && /over its 100-day average/.test(b1.why), "yesterday's close 4% over its average: it buys", b1);
  check(decide(P, {}, 104, 0, { decimals: D, daily: mid }) === null && decide(P, {}, 104, 0, { decimals: D, daily: null }) === null && decide(P, {}, 104, 0, { decimals: D, daily: down }) === null, "between the gaps, without history, or under the average: no buy");
  const held: BotState = { units: "961538461", cost: 100, c: { buys: 1 } };
  check(decide(P, held, 120, 0, { decimals: D, daily: [...flat(99, 100), 120] }) === null && decide(P, held, 99, 0, { decimals: D, daily: mid }) === null, "holding: no sell while the trend holds, even on a red day inside the gap");
  const s1 = decide(P, held, 95, 0, { decimals: D, daily: down }) as any;
  check(s1?.side === "sell" && s1.atomic === "961538461" && s1.tag === "trend", "yesterday's close 4% under its average: sells everything to USDC", s1);
  const after = applyFill(P, held, s1, { usd: 91.3, got: 961_538_461n }, 95, 0, D).state;
  check(after.units === "0" && after.cycles === 1 && decide(P, after, 95, 0, { decimals: D, daily: down }) === null && (decide(P, after, 104, 0, { decimals: D, daily: up }) as any)?.side === "buy", "then waits in cash, and buys again once the trend turns up");
  check(describeCustom(T, "SOL").join("; ") === "Buys SOL while… ".slice(0, 0) + "Holds SOL while its daily close is 3% over its 100-day average; sells to USDC 3% under it; $100 a time; Sells only when the trend turns; $100 at most", "the card says it plainly", describeCustom(T, "SOL"));
  // The simulator hands it finished days only, and the whole bot runs in the real engine.
  const day = 86_400_000, bars: Bar[] = [];
  const px = (d: number) => d < 120 ? 100 : d < 160 ? 100 + (d - 120) * 1.5 : 160 - (d - 160) * 2; // flat, up 60%, then down
  for (let h = 0; h < 220 * 24; h++) { const v = px(h / 24); bars.push({ t: h * 3_600_000, o: v, h: v, l: v, c: v }); }
  const sim = new Sim({ markets: [{ symbol: "SOL", decimals: 9, bars, barMs: 3_600_000 }], start: 101 * day, end: 219 * day, cashUsd: 300, pollMs: 60_000, timing: "fixed" });
  const mk = (sim as any).markets[0];
  const d0 = mk.daily(130 * day + 5 * 3_600_000);
  check(d0.length === 130 && d0.at(-1) === px(129 + 23 / 24) && mk.daily(131 * day - 1) === d0, "daily closes: the last price of each finished day, the day in progress left out", d0.at(-1));
  await sim.addRules([{ kind: "custom", chain: "solana", token: "SOL", custom: T }]);
  const r = await sim.run();
  const sides = r.trades.map((x: any) => x.side).join(",");
  const buyDay = r.trades[0] ? Math.floor(r.trades[0].t / day) : -1, sellDay = r.trades[1] ? Math.floor(r.trades[1].t / day) : -1;
  check(sides === "buy,sell" && buyDay > 120 && buyDay < 130 && sellDay > 160 && sellDay < 190 && r.pnl_usd > 0, "in the engine: buys early in the rise, sells to cash in the fall, once each, ahead", { sides, buyDay, sellDay, pnl: r.pnl_usd });
}

// ── Phase 3, step 3 (Nov 11, 2026): smaller when the market is wild ───────────────────────────────────────────────
{
  const { dailyVolPct, volScale } = await import("../src/botlogic.js");
  // Hourly closes that swing a fixed amount: log returns alternate ±x, so the daily swing is x·√24 (a sample std, close to it).
  const swing = (dailyPct: number, n = 200) => { const x = dailyPct / 100 / Math.sqrt(24); let p = 100; const out = [p]; for (let i = 1; i < n; i++) { p *= Math.exp(i % 2 ? x : -x); out.push(p); } return out; };
  const v6 = dailyVolPct(swing(6))!, v2 = dailyVolPct(swing(2))!;
  check(Math.abs(v6 - 6) < 0.1 && Math.abs(v2 - 2) < 0.1 && dailyVolPct(swing(6, 40)) === null && dailyVolPct(null) === null, "the daily swing from a week of hourly closes; nothing with under two days", { v6, v2 });
  check(Math.abs(volScale(3, swing(6)) - 0.5) < 0.01 && volScale(3, swing(2)) === 1 && volScale(3, swing(30)) === 0.25 && volScale(undefined, swing(6)) === 1 && volScale(3, null) === 1, "the scale: target / swing, between a quarter and the full size; off or without history: full size");
  const V: CustomSpec = { buy: { type: "price", at: 200 }, size: { usd: 40, vol_target_pct: 3 }, limits: { max_usd: 40 } };
  const P = { kind: "custom", custom: V };
  const calm = decide(P, {}, 100, 0, { decimals: D, closes: swing(2) }) as any, wild = decide(P, {}, 100, 0, { decimals: D, closes: swing(6) }) as any, none = decide(P, {}, 100, 0, { decimals: D, closes: null }) as any;
  check(calm?.usd === 40 && Math.abs(wild?.usd - 20) < 0.5 && none?.usd === 40, "a custom bot's buy: full size when calm, about half at a 6% daily swing, full size without history", { calm: calm?.usd, wild: wild?.usd });
  check(customProblem(V) === null && /0\.5% to 20%/.test(customProblem({ ...V, size: { usd: 40, vol_target_pct: 50 } }) ?? "") && describeCustom(V, "SOL")[1] === "$40 a time, smaller when daily swings pass 3%", "checked, and the card says it", describeCustom(V, "SOL")[1]);
}

// ── Review 2 (Nov 11, 2026) ───────────────────────────────────────────────────────────────────────────────────────
{
  const { trendState, cleanCustomState } = await import("../src/botlogic.js");
  const flat = (n: number, v: number) => Array(n).fill(v), up = [...flat(99, 100), 104], mid = [...flat(99, 100), 101];
  // A trend bot with a profit step: after the step sells it out it does not buy straight back.
  const T: CustomSpec = { buy: { type: "trend", days: 100, gap_pct: 3 }, size: { usd: 100 }, sell: { steps: [{ gain_pct: 5, share_pct: 100 }] }, limits: { max_usd: 100 } };
  const P = { kind: "custom", custom: T };
  const b1 = decide(P, {}, 104, 0, { decimals: D, daily: up }) as any;
  let s = applyFill(P, {}, b1, { usd: 100, got: 961_538_461n }, 104, 0, D).state;
  const sell = decide(P, s, 110, 0, { decimals: D, daily: up }) as any;
  s = applyFill(P, s, sell, { usd: 105.7, got: 961_538_461n }, 110, 0, D).state;
  check(sell?.tag === "step" && s.units === "0" && s.c?.wait_trend === true && decide(P, s, 110, 0, { decimals: D, daily: up }) === null, "a trend bot that took profit doesn't buy back while the same trend is on", s.c);
  const m = decide(P, s, 101, 0, { decimals: D, daily: mid }) as any;
  s = applyFill(P, s, m, { usd: 0, got: 0n }, 101, 0, D).state;
  check(m?.side === "mark" && s.c?.wait_trend === false && decide(P, s, 101, 0, { decimals: D, daily: mid }) === null && (decide(P, s, 105, 0, { decimals: D, daily: up }) as any)?.side === "buy", "once the trend has paused it buys the next one", m);
  check(cleanCustomState({ wait_trend: true, anchor: 1 })?.wait_trend === true, "the wait survives the hand-off to the server");
  // A little short history still gives a trend reading; far too little doesn't.
  check(trendState([...flat(79, 100), 104], 100, 3)?.side === "in" && trendState([...flat(60, 100), 104], 100, 3) === null, "80 of 100 days is enough for the trend; 61 is not");
  // Scaling never takes a buy under $1, and a buy grown past the limit is cut to the room left.
  const swing = (dailyPct: number, n = 200) => { const x = dailyPct / 100 / Math.sqrt(24); let p = 100; const out = [p]; for (let i = 1; i < n; i++) { p *= Math.exp(i % 2 ? x : -x); out.push(p); } return out; };
  const small = decide({ kind: "custom", custom: { buy: { type: "price", at: 200 }, size: { usd: 3, vol_target_pct: 1 }, limits: { max_usd: 3 } } }, {}, 100, 0, { decimals: D, closes: swing(8) }) as any;
  check(small?.side === "buy" && small.usd === 1, "a $3 buy scaled to a quarter is $1, not dropped", small);
  const W: CustomSpec = { buy: { type: "price", at: 200 }, size: { usd: 100, grow: "wins" }, sell: { steps: [{ gain_pct: 5, share_pct: 100 }] }, limits: { max_usd: 100 } };
  const won = decide({ kind: "custom", custom: W }, { units: "0", cost: 0, c: { wins: 1 } }, 100, 0, { decimals: D }) as any;
  check(won?.side === "buy" && won.usd === 100, "bigger after a win, but never past the limit: $125 is cut to $100, not refused", won);
}

console.log(`\ncustom: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
