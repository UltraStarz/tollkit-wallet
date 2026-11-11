/**
 * Nov 11 (trading research, Phase 1): the backtester.
 *
 * It runs the wallet's real rule engine (src/autopilot.ts, and through it src/botlogic.ts and src/indicators.ts) over
 * past prices, with a pretend wallet and a clock it controls. Nothing here decides a trade: the engine does, by the
 * same code that trades in the app. So a backtest and the app can't drift apart, and the Bots screen's 30-day replay
 * (src/botviz.ts) is a thin wrapper around this file.
 *
 * What it adds around the engine:
 *   prices   Candles turned into the prices a polling bot would have seen: inside each candle the price runs open →
 *            first extreme → second extreme → close (usually low first on a rising candle; when and in which order
 *            is seeded, so several seeds show how much the unknown path matters), and the bot looks every pollMs.
 *            A trade fills at the price a moment after the bot decided (latencyMs), never at its level or trigger:
 *            filling at the level only counts the crossings that kept going, which biases results (research log 8).
 *   costs    TOLLkit's fee (the bot fee, 0.10%, on every trade a rule makes), spread and price
 *            impact by trade size, a network cost per trade, and a share of sends that fail.
 *   speed    The engine is only run on the checks where a rule could do something. `quiet()` below mirrors the
 *            engine's own gates and test/backtest.test.ts proves the short cut changes no trade (fast === exact).
 *
 * No network, no keys, no real money: the pretend wallet is a few numbers in memory.
 */
import os from "node:os";
import path from "node:path";
import { Autopilot, type AutopilotEvent, type AutopilotOptions, type Executor } from "./autopilot.js";
import { decide, isBotKind, type BotState } from "./botlogic.js";
import { buildBot, summarize, type BotSummary } from "./bots.js";
import { BOT_FEE_BPS, SWAP_FEE_BPS, type Chain } from "./chains.js";
import { checkSignal } from "./indicators.js";
import { isPaperRule } from "./ownership.js";
import { nextRun, RuleStore, type Rule, type RuleInput } from "./rules.js";
import type { SwapRequest } from "./swap.js";
import { KNOWN, type Token } from "./tokens.js";
import type { SwapResult } from "./wallet.js";

// ── prices ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Bar { t: number; o: number; h: number; l: number; c: number }
/** The same candles as columns (lighter for a year of minutes). */
export interface BarColumns { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number> }

export interface MarketSpec {
  /** What the price feed calls it: "SOL". */
  symbol: string;
  /** What rules call it, when that isn't the symbol (a token address). */
  token?: string;
  decimals?: number;
  /** Candles, oldest first. Missing candles are filled flat at the last close (nothing traded). */
  bars: Bar[] | BarColumns;
  barMs?: number;
  /** How old a price the engine may act on, in ms (a token priced by a quote is cached a minute; a feed token, 0). */
  staleMs?: number;
  /** Spread and price impact one way, in bps, for a trade of `usd` dollars. */
  impactBps?: (usd: number) => number;
}

/** A cheap hash to [0, 1): where inside a candle its extremes fall. */
function unit(a: number): number {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Seeded random numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class Market {
  readonly symbol: string; readonly token: Token; readonly t0: number; readonly n: number; readonly barMs: number; readonly staleMs: number;
  /** Candles that were missing in the data and filled flat. */
  readonly filled: number;
  private readonly O: Float64Array; private readonly H: Float64Array; private readonly L: Float64Array; private readonly C: Float64Array;
  private readonly impactFn: (usd: number) => number;
  /** The price the engine sees right now, and when it was read. */
  seen = 0; seenAt = -Infinity;
  private hours: Float64Array | null = null; private hour0 = 0;
  private hBucket = -1; private hCloses: number[] | null = null;
  private dDay = -1; private dCloses: number[] | null = null;

  constructor(spec: MarketSpec, private readonly seed: number, private readonly fixedTiming: boolean) {
    this.symbol = spec.symbol.toUpperCase();
    this.token = { address: spec.token ?? `sim:${this.symbol}`, symbol: this.symbol, decimals: spec.decimals ?? 9 };
    this.barMs = spec.barMs ?? 60_000; this.staleMs = spec.staleMs ?? 0; this.impactFn = spec.impactBps ?? (() => 0);
    const b = spec.bars, col = !Array.isArray(b), len = col ? (b as BarColumns).t.length : (b as Bar[]).length;
    if (!len) throw new Error(`No candles for ${this.symbol}.`);
    const at = (i: number): Bar => col ? { t: (b as BarColumns).t[i]!, o: (b as BarColumns).o[i]!, h: (b as BarColumns).h[i]!, l: (b as BarColumns).l[i]!, c: (b as BarColumns).c[i]! } : (b as Bar[])[i]!;
    this.t0 = at(0).t;
    this.n = Math.round((at(len - 1).t - this.t0) / this.barMs) + 1;
    this.O = new Float64Array(this.n); this.H = new Float64Array(this.n); this.L = new Float64Array(this.n); this.C = new Float64Array(this.n);
    const have = new Uint8Array(this.n);
    for (let j = 0; j < len; j++) {
      const k = at(j), i = Math.round((k.t - this.t0) / this.barMs);
      if (i < 0 || i >= this.n || !(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0)) continue;
      this.O[i] = k.o; this.H[i] = Math.max(k.h, k.o, k.c); this.L[i] = Math.min(k.l, k.o, k.c); this.C[i] = k.c; have[i] = 1;
    }
    let last = 0, filled = 0;
    for (let i = 0; i < this.n; i++) {
      if (have[i]) { last = this.C[i]!; continue; }
      if (!(last > 0)) throw new Error(`The first candle for ${this.symbol} has no price.`);
      this.O[i] = this.H[i] = this.L[i] = this.C[i] = last; filled++;
    }
    this.filled = filled;
  }

  get end(): number { return this.t0 + this.n * this.barMs; }
  impact(usd: number): number { const x = this.impactFn(usd); return x > 0 ? x : 0; }

  /** The price at a moment. Before the first candle: its open. After the last: its close. */
  priceAt(t: number): number {
    const x = (t - this.t0) / this.barMs;
    if (x <= 0) return this.O[0]!;
    const i = Math.floor(x);
    if (i >= this.n) return this.C[this.n - 1]!;
    const u = x - i, o = this.O[i]!, c = this.C[i]!, hi = this.H[i]!, lo = this.L[i]!;
    // Low first on a rising candle is only the likelier order. With seeded timing the order flips with a chance that
    // goes from one in two (the candle closed where it opened) to none (it ran straight from one extreme to the other).
    const likely = c >= o, flip = !this.fixedTiming && hi > lo && unit(Math.imul(this.seed, 0x85ebca6b) + i) < 0.5 * (1 - Math.abs(c - o) / (hi - lo));
    const up = likely !== flip, a = up ? lo : hi, b = up ? hi : lo;
    const u1 = this.fixedTiming ? 1 / 3 : 0.1 + 0.4 * unit(Math.imul(this.seed, 0x9e3779b1) + i * 2);
    const u2 = this.fixedTiming ? 2 / 3 : 0.5 + 0.4 * unit(Math.imul(this.seed, 0x9e3779b1) + i * 2 + 1);
    if (u < u1) return o + (a - o) * (u / u1);
    if (u < u2) return a + (b - a) * ((u - u1) / (u2 - u1));
    return b + (c - b) * ((u - u2) / (1 - u2));
  }

  /**
   * Hourly closes as the app would have them at time t (src/indicators.ts hourlyCloses): up to 263 finished hours
   * and the hour in progress, read at most every 10 minutes. Oldest first. Null before any hour has finished.
   */
  /** Phase 3: finished daily closes at time t (src/indicators.ts dailyCloses): the last price of each UTC day before t's day, up to 260. */
  daily(t: number): number[] | null {
    const day = Math.floor(t / 86_400_000);
    if (day === this.dDay) return this.dCloses;
    this.dDay = day;
    const out: number[] = [], first = Math.floor(this.t0 / 86_400_000);
    for (let d = Math.max(first, day - 260); d < day; d++) { const end = (d + 1) * 86_400_000 - 1; if (end < this.t0) continue; out.push(this.priceAt(Math.min(end, this.end - 1))); }
    return (this.dCloses = out.length ? out : null);
  }
  hourly(t: number): number[] | null {
    const bucket = Math.floor(t / 600_000);
    if (bucket === this.hBucket) return this.hCloses;
    if (!this.hours) {
      this.hour0 = Math.floor(this.t0 / 3_600_000);
      const n = Math.floor((this.end - 1) / 3_600_000) - this.hour0 + 1;
      this.hours = new Float64Array(n);
      for (let i = 0; i < this.n; i++) this.hours[Math.floor((this.t0 + i * this.barMs) / 3_600_000) - this.hour0] = this.C[i]!; // the last candle of each hour wins
      for (let j = 1; j < n; j++) if (!(this.hours[j]! > 0)) this.hours[j] = this.hours[j - 1]!;
    }
    const at = bucket * 600_000, done = Math.min(this.hours.length, Math.floor(at / 3_600_000) - this.hour0); // hours finished before `at`
    this.hBucket = bucket;
    if (done < 1) return (this.hCloses = null);
    const out: number[] = [];
    for (let j = Math.max(0, done - 263); j < done; j++) out.push(this.hours[j]!);
    out.push(this.priceAt(at));
    return (this.hCloses = out);
  }
}

// ── rules in memory ──────────────────────────────────────────────────────────────────────────────────────────────

/** The wallet's rule store, kept in memory. Same behaviour as the file one: callers get copies. */
export class SimRules extends RuleStore {
  private rows: Rule[] = [];
  /** Goes up on every change, so the simulator knows when to look at the rules again. */
  ver = 0;
  override list(): Rule[] { return structuredClone(this.rows); }
  override get(id: string): Rule | undefined { const r = this.rows.find((x) => x.id === id); return r ? structuredClone(r) : undefined; }
  override async mutate<T>(fn: (rules: Rule[]) => T): Promise<T> { const rs = structuredClone(this.rows); const out = fn(rs); this.rows = rs; this.ver++; return out; }
  /** The rules themselves, not a copy. Read only. */
  peek(): readonly Rule[] { return this.rows; }
  /** The simulator's own bookkeeping, in place. */
  touch(fn: (rules: Rule[]) => void) { fn(this.rows); }
}

// ── the pretend wallet ───────────────────────────────────────────────────────────────────────────────────────────

export interface SimCosts {
  /** TOLLkit's fee per side, in bps. Defaults: the wallet's own constants. */
  swapFeeBps?: number; botFeeBps?: number;
  /** Network cost per trade, in dollars. */
  networkUsd?: number;
  /** Share of sends that fail (0 to 1). */
  failRate?: number;
  /** From the bot deciding to the trade landing, in ms. */
  latencyMs?: number;
  /** Multiplies every cost (1.5 for a stress test, 0 for the zero-fee benchmark). */
  scale?: number;
}
export interface SimLimits { perTradeUsd?: number; dailyUsd?: number }

export interface SimTrade {
  t: number; mode: "live" | "paper"; symbol: string; side: "buy" | "sell";
  /** Dollars in (buy) or out (sell), the stablecoin side, as the app records it. */
  usd: number; units: number;
  /** The price the engine acted on, and the market price when the trade landed. */
  seen: number; mid: number;
  /** What each cost took, in dollars. delay: the price moving between deciding and landing (can be negative). */
  fee_usd: number; impact_usd: number; delay_usd: number; network_usd: number;
  rule?: string; bot?: string; template?: string; kind?: string;
}

export class SimExec implements Executor {
  slippageBps = 100;
  cash: number; readonly units = new Map<string, bigint>(); start: number;
  networkUsd = 0; fails = 0;
  private day = -1; private daySpent = 0;
  constructor(private readonly sim: Sim, readonly mode: "live" | "paper", cashUsd: number, readonly unlimited: boolean, private readonly limits: SimLimits) { this.cash = cashUsd; this.start = cashUsd; }

  async quote(req: SwapRequest): Promise<SwapResult> { return this.fill(req, false); }
  async swap(req: SwapRequest): Promise<SwapResult> { return this.fill(req, true); }
  async balance(_chain: Chain, t: Token): Promise<bigint> {
    if (t.address === this.sim.usdc.address) return this.unlimited ? 10n ** 15n : BigInt(Math.max(0, Math.floor(this.cash * 1e6 + 1e-6)));
    return this.units.get(t.address) ?? 0n;
  }
  /** Coins held, valued at the market price now. */
  position(): number { let v = 0; for (const m of this.sim.markets) { const u = this.units.get(m.token.address); if (u) v += (Number(u) / 10 ** m.token.decimals) * m.priceAt(this.sim.clock); } return v; }

  private refuse(code: string, reason: string, quote?: SwapResult["quote"]): SwapResult { return { ok: false, ...(quote ? { quote } : {}), refused: { code, reason } }; }

  private fill(req: SwapRequest, commit: boolean): SwapResult {
    const sim = this.sim, buying = req.sell_token === sim.usdc.address;
    const m = sim.byAddress(buying ? req.buy_token : req.sell_token);
    if (!m) return this.refuse("no_quote", "No market for this token in the simulation.");
    const c = sim.costs, feeBps = (req.bot ? c.botFeeBps : c.swapFeeBps) * c.scale, f = feeBps / 1e4;
    const mid = m.priceAt(sim.clock + (commit ? c.latencyMs : 0)), dec = 10 ** m.token.decimals;
    let usd: number, units: number, feeUsd: number, impactUsd: number, gross: number, buy_amount: string;
    if (buying) {
      usd = gross = Number(req.sell_amount) / 1e6;
      const imp = (m.impact(usd) * c.scale) / 1e4;
      units = Math.floor(((usd * (1 - f)) / (mid * (1 + imp))) * dec) / dec;
      feeUsd = usd * f; impactUsd = usd * (1 - f) * (imp / (1 + imp)); buy_amount = BigInt(Math.round(units * dec)).toString();
    } else {
      units = Number(req.sell_amount) / dec; gross = units * mid;
      const imp = (m.impact(gross) * c.scale) / 1e4;
      impactUsd = gross * imp; feeUsd = gross * (1 - imp) * f;
      usd = Math.floor((gross - impactUsd - feeUsd) * 1e6) / 1e6; buy_amount = String(Math.round(usd * 1e6));
    }
    const quote: SwapResult["quote"] = { chain: req.chain, venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount, min_buy_amount: "0", fee_bps: feeBps, venue_fee_bps: 0, usd_value: usd, fee_usd: feeUsd };
    if (!commit) return { ok: true, quote };
    // The owner's limits, then the money, then the network.
    const L = this.limits, day = Math.floor(sim.clock / 86_400_000);
    if (day !== this.day) { this.day = day; this.daySpent = 0; }
    if (L.perTradeUsd !== undefined && gross > L.perTradeUsd + 1e-9) return this.refuse("over_per_limit", `$${gross.toFixed(2)} is over the per-trade limit of $${L.perTradeUsd}.`, quote);
    if (L.dailyUsd !== undefined && this.daySpent + gross > L.dailyUsd + 1e-9) return this.refuse("over_daily_limit", `This would go over today's trading limit of $${L.dailyUsd}.`, quote);
    if (buying ? !this.unlimited && usd > this.cash + 1e-9 : BigInt(req.sell_amount) > (this.units.get(m.token.address) ?? 0n)) return this.refuse("insufficient_balance", "Not enough balance for this trade.", quote);
    if (c.failRate > 0 && sim.rng() < c.failRate) { this.fails++; return this.refuse("swap_failed", "The swap didn't go through. Try again in a moment.", quote); }
    const held = this.units.get(m.token.address) ?? 0n;
    if (buying) { this.cash -= usd; this.units.set(m.token.address, held + BigInt(buy_amount)); }
    else { this.cash += usd; this.units.set(m.token.address, held - BigInt(req.sell_amount)); }
    const net = c.networkUsd * c.scale;
    this.networkUsd += net; this.daySpent += gross;
    const delay = buying ? usd * (1 - m.seen / mid) : units * (m.seen - mid);
    sim.note({ t: sim.clock, mode: this.mode, symbol: m.symbol, side: buying ? "buy" : "sell", usd, units, seen: m.seen, mid, fee_usd: feeUsd, impact_usd: impactUsd, delay_usd: delay, network_usd: net });
    return { ok: true, quote, tx: `sim-${sim.trades.length}` };
  }
}

// ── the simulator ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SimOptions {
  markets: MarketSpec[];
  chain?: Chain;
  /** First and last moment simulated (ms). Default: the first market's candles. */
  start?: number; end?: number;
  /** How often the bot looks: 15 s in the app, 30 s on TOLLkit's server. */
  pollMs?: number;
  seed?: number;
  /** "seeded": each candle's extremes fall at seeded moments. "fixed": at one third and two thirds. */
  timing?: "seeded" | "fixed";
  /** "live": real-money rules with the cash below. "paper": practice rules, cash never runs out. "none": add engines yourself. */
  mode?: "live" | "paper" | "none";
  cashUsd?: number;
  costs?: SimCosts; limits?: SimLimits;
  /** False runs the engine on every check (slow; for proving the short cut). */
  fast?: boolean;
  /** How often the account's value is recorded, in ms. */
  sampleMs?: number;
  /** Extra engine options (holdBuy, autopilotDailyCap, skip, onEvent). */
  engine?: Partial<AutopilotOptions>;
  dir?: string;
}

type Watch = (now: number) => boolean;
export interface SimEngine { mode: "live" | "paper"; ap: Autopilot; exec: SimExec; opts: Partial<AutopilotOptions>; watch: Watch[]; ver: number; highs: Map<string, number>; ticks: number; curve: { equity: number[]; position: number[]; cash: number[] } }
interface Hook { t: number; every?: number; fn: (sim: Sim) => void | Promise<void> }

export interface SimResult {
  from: number; to: number; polls: number; ticks: number;
  trades: SimTrade[]; rules: Rule[]; bots: BotSummary[];
  /** The first engine's account: what it started with, holds now and made. Coins are valued at the last price. */
  start_usd: number; cash_usd: number; position_usd: number; equity_usd: number; pnl_usd: number;
  turnover_usd: number; costs: { fee_usd: number; impact_usd: number; delay_usd: number; network_usd: number; total_usd: number }; fails: number;
  events: Record<string, number>;
  curve: { t: number[]; equity: number[]; position: number[]; cash: number[] };
}

export class Sim {
  readonly chain: Chain; readonly usdc: Token; readonly store: SimRules; readonly markets: Market[]; readonly trades: SimTrade[] = [];
  readonly costs: Required<SimCosts>; readonly rng: () => number; readonly pollMs: number; readonly start: number; readonly end: number;
  readonly engines: SimEngine[] = []; readonly events: Record<string, number> = {};
  clock: number; polls = 0;
  private readonly snap: Record<string, { usd: number; change_24h: null }> = {};
  private readonly hooks: Hook[] = []; private readonly fast: boolean; private readonly sampleMs: number; private nextSample: number; private readonly times: number[] = [];
  private last: SimTrade | null = null; private readonly dir: string; private readonly limits: SimLimits;
  private readonly outages: [number, number][] = []; private outAt = 0;

  constructor(o: SimOptions) {
    this.chain = o.chain ?? "solana"; this.usdc = KNOWN[this.chain].USDC!;
    this.dir = o.dir ?? path.join(os.tmpdir(), "tollkit-sim"); this.store = new SimRules(this.dir);
    const seed = o.seed ?? 1;
    this.rng = seeded(seed ^ 0x5bd1e995);
    this.markets = o.markets.map((m) => new Market(m, seed, o.timing === "fixed"));
    for (const m of this.markets) this.snap[m.symbol] = { usd: 0, change_24h: null };
    const c = o.costs ?? {};
    this.costs = { swapFeeBps: c.swapFeeBps ?? SWAP_FEE_BPS, botFeeBps: c.botFeeBps ?? BOT_FEE_BPS, networkUsd: c.networkUsd ?? 0, failRate: c.failRate ?? 0, latencyMs: c.latencyMs ?? 0, scale: c.scale ?? 1 };
    this.limits = o.limits ?? {};
    this.pollMs = o.pollMs ?? 15_000; this.fast = o.fast !== false; this.sampleMs = o.sampleMs ?? 3_600_000;
    this.start = o.start ?? this.markets[0]!.t0; this.end = o.end ?? this.markets[0]!.end - 1;
    this.clock = this.start; this.nextSample = this.start;
    const mode = o.mode ?? "live";
    if (mode !== "none") this.addEngine(mode, { cashUsd: o.cashUsd ?? (mode === "paper" ? 0 : 1000), options: o.engine });
    this.look();
  }

  /** One engine and its account. The app runs two over the same rules: live (real cash) and paper (practice, cash never runs out). */
  addEngine(mode: "live" | "paper", o: { cashUsd?: number; unlimited?: boolean; options?: Partial<AutopilotOptions> } = {}): SimEngine {
    const exec = new SimExec(this, mode, o.cashUsd ?? 0, o.unlimited ?? mode === "paper", this.limits), opts = o.options ?? {};
    const ap = new Autopilot(this.store, exec, { snapshot: () => ({ prices: this.snap }) }, {
      ...opts, dir: this.dir, now: () => this.clock, noLease: true,
      resolve: async (_c, sym) => { const m = this.find(sym); if (!m) throw new Error(`No market for ${sym} in the simulation.`); return m.token; },
      hourly: async (_c, t) => this.byAddress(t.address)?.hourly(this.clock) ?? [],
      daily: async (_c, t) => this.byAddress(t.address)?.daily(this.clock) ?? [],
      onEvent: (e: AutopilotEvent) => {
        this.events[e.type] = (this.events[e.type] ?? 0) + 1;
        if (e.type === "filled" && this.last && !this.last.rule) { this.last.rule = e.rule.id; this.last.bot = e.rule.bot; this.last.template = e.rule.template; this.last.kind = e.rule.kind; }
        opts.onEvent?.(e);
      },
    });
    const e: SimEngine = { mode, ap, exec, opts, watch: [], ver: -1, highs: new Map(), ticks: 0, curve: { equity: [], position: [], cash: [] } };
    this.engines.push(e);
    return e;
  }

  find(token: string): Market | undefined { const k = token.toLowerCase(); return this.markets.find((m) => m.symbol.toLowerCase() === k || m.token.address.toLowerCase() === k); }
  byAddress(address: string): Market | undefined { return this.markets.find((m) => m.token.address === address); }
  note(t: SimTrade) { this.trades.push(t); this.last = t; }

  /** What the engines see at the clock: each market's price, as fresh as its feed allows. */
  private look() {
    for (const m of this.markets) if (this.clock - m.seenAt >= m.staleMs) { m.seen = m.priceAt(this.clock); m.seenAt = this.clock; this.snap[m.symbol]!.usd = m.seen; }
  }

  /** Rules straight from a caller (already built). They start at the clock. `paper`: practice rules. */
  async addRules(inputs: RuleInput[], o: { by?: "owner" | "agent"; app?: string; paper?: boolean } = {}): Promise<Rule[]> {
    for (const r of inputs) { if (r.kind === "range") throw new Error("The simulator doesn't cover the Range bot: its result depends on the pool's fees."); if (!this.find(r.token)) throw new Error(`No market for ${r.token} in the simulation.`); }
    const made = await this.store.addBot(inputs, o.by ?? "owner", true, o.app), ids = new Set(made.map((r) => r.id)), at = new Date(this.clock);
    return this.store.mutate((rs) => rs.filter((r) => ids.has(r.id)).map((r) => {
      r.created_at = r.activated_at = at.toISOString();
      if (o.paper) r.paper = true;
      if (r.kind === "dca") { if (r.every === "week") r.weekday = at.getUTCDay(); r.state.next_run = (r.every === "week" ? nextRun(r, at) : at).toISOString(); }
      return structuredClone(r);
    }));
  }

  /** A bot from one of the wallet's templates, set up at the price the engine sees now. */
  async addBot(template: string, token: string, params: Record<string, unknown>, o: { by?: "owner" | "agent"; app?: string; paper?: boolean } = {}): Promise<{ bot: string; rules: Rule[] }> {
    const m = this.find(token);
    if (!m) throw new Error(`No market for ${token} in the simulation.`);
    const built = buildBot(template, m.token.address.startsWith("sim:") ? m.symbol : m.token.address, this.chain, params, m.seen);
    return { bot: built.bot, rules: await this.addRules(built.rules, o) };
  }

  /** A rule as it is, with no checks (research only: settings the app itself would refuse). */
  async addRaw(rule: Rule): Promise<void> { await this.store.mutate((rs) => { rs.push(structuredClone(rule)); }); }

  /** Coins the pretend wallet starts with (for bots that sell what you hold). Counted in the starting value. */
  deposit(token: string, units: number, engine = 0) {
    const m = this.find(token), e = this.engines[engine];
    if (!m || !e) throw new Error(`No market for ${token} in the simulation.`);
    e.exec.units.set(m.token.address, (e.exec.units.get(m.token.address) ?? 0n) + BigInt(Math.floor(units * 10 ** m.token.decimals)));
    e.exec.start += units * m.priceAt(this.clock);
  }

  /** Units of a coin the pretend wallet holds now. */
  held(token: string, engine = 0): number { const m = this.find(token), e = this.engines[engine]; return m && e ? Number(e.exec.units.get(m.token.address) ?? 0n) / 10 ** m.token.decimals : 0; }

  /** Stop a bot: its open rules are cancelled, as when the owner taps Stop. Coins it holds stay. */
  async stopBot(bot: string, note = "Stopped."): Promise<void> {
    await this.store.mutate((rs) => { for (const r of rs) if ((r.bot ?? r.id) === bot && ["active", "paused", "proposed", "error"].includes(r.status)) { r.status = "cancelled"; r.state.note = note; } });
  }

  /** The app was closed (or offline) from `from` to `to`: the engines don't look at prices in between. */
  down(from: number, to: number) { this.outages.push([from, to]); this.outages.sort((a, b) => a[0] - b[0]); }
  private isDown(now: number): boolean {
    const o = this.outages;
    while (this.outAt < o.length && o[this.outAt]![1] <= now) this.outAt++;
    return this.outAt < o.length && o[this.outAt]![0] <= now;
  }

  /** Run something at a time (or every so often from then): add or stop a bot, change a setting. */
  at(t: number, fn: Hook["fn"], every?: number) {
    const h: Hook = { t, fn, ...(every ? { every } : {}) };
    let i = this.hooks.length; while (i > 0 && this.hooks[i - 1]!.t > t) i--;
    this.hooks.splice(i, 0, h);
  }

  private flush(e: SimEngine) {
    if (!e.highs.size) return;
    this.store.touch((rs) => { for (const [id, h] of e.highs) { const r = rs.find((x) => x.id === id); if (r && r.status === "active") r.state.high = Math.max(r.state.high ?? h, h); } });
    e.highs.clear();
  }

  private compile(e: SimEngine) {
    this.flush(e); // highs tracked since the last look go into the rules before the checks are rebuilt from them
    const rows = this.store.peek(), w: Watch[] = [];
    for (const r of rows) {
      if (r.status !== "active" || (e.mode === "live" && isPaperRule(r))) continue;
      w.push(this.quiet(e, r, rows));
    }
    e.watch = w; e.ver = this.store.ver;
  }

  /**
   * For one active rule: a check that says "nothing to do at this price and time" (true) without running the engine.
   * It mirrors, gate for gate, what Autopilot.consider() does before it would trade or change the rule. When in
   * doubt it answers false and the engine looks for itself.
   */
  private quiet(e: SimEngine, r: Rule, rows: readonly Rule[]): Watch {
    const m = this.find(r.token);
    if (!m) return () => false;
    const exp = r.expires_at ? Date.parse(r.expires_at) : Infinity, hold = r.state.hold_until ? Date.parse(r.state.hold_until) : 0, next = r.state.next_run ? Date.parse(r.state.next_run) : 0;
    const waits = next > 0 && (r.kind === "dca" || r.state.failures > 0);
    let dep = 0; // 1: waiting for an earlier step. 2: that step didn't happen, so the engine cancels this one.
    if (r.after) { const prev = rows.find((x) => x.id === r.after); dep = !prev || prev.status === "cancelled" || prev.status === "expired" || prev.status === "error" ? 2 : prev.status !== "done" ? 1 : 0; }
    const core = this.core(e, r, m, next), skip = e.opts.skip, id = r.id;
    return (now) => {
      if (skip?.(id)) return true; // asked on every check: who runs a rule can change without the rules changing
      if (now >= exp) return false;
      if (now < hold) return true;
      if (waits && now < next) return true;
      if (dep) return dep === 1;
      return core(now);
    };
  }

  private core(e: SimEngine, r: Rule, m: Market, next: number): Watch {
    const holdBuy = e.opts.holdBuy;
    if (isBotKind(r.kind)) {
      // A split sell fixes its total from the wallet's balance on its first part: the engine looks.
      if (r.kind === "twap" && r.side === "sell" && r.state.bot?.sell_total === undefined) return (now) => next > now;
      const st: BotState = { ...(r.state.bot ?? {}), ...(r.kind === "grid" && r.state.grid ? { grid: r.state.grid } : {}) }, opt: { decimals: number; closes?: number[] | null; daily?: number[] | null } = { decimals: m.token.decimals };
      const custom = r.kind === "custom", trend = custom && r.custom?.buy.type === "trend";
      return (now) => {
        if (next > now) return true;
        if (custom) opt.closes = m.hourly(now); // the same closes the engine would be handed at this moment
        if (trend) opt.daily = m.daily(now);
        const a = decide(r as any, st, m.seen, now, opt);
        return !a || (a.side === "buy" && !!holdBuy?.(r));
      };
    }
    switch (r.kind) {
      case "alert": return () => true; // alerts never trade, so the fast path doesn't run them (no alert events in a fast run)
      case "signal_buy": case "signal_sell": {
        if (!r.when) return () => true;
        // Within one reading of the hourly closes, "nothing to do" holds on a single stretch of prices (RSI, the MACD
        // histogram and a breakout all move one way with the newest price), so prices between two quiet ones are quiet.
        const when = r.when, armed = r.state.alert_armed ?? true;
        let bucket = -1, lo = Infinity, hi = -Infinity, closes: number[] | null = null;
        return (now) => {
          const b = Math.floor(now / 600_000), p = m.seen;
          if (b !== bucket) { bucket = b; closes = m.hourly(now); lo = Infinity; hi = -Infinity; }
          if (p >= lo && p <= hi) return true;
          const c = checkSignal(when, p, closes);
          if (armed ? c.hit : c.clear) return false;
          if (p < lo) lo = p; if (p > hi) hi = p;
          return true;
        };
      }
      case "trailing_stop": {
        const k = 1 - r.trail_pct! / 100, highs = e.highs;
        let hi = r.state.high;
        return () => { const p = m.seen; if (hi === undefined || p > hi) { hi = p; highs.set(r.id, p); } return p > hi * k; };
      }
      case "limit_buy": { const trig = r.trigger_price!; return () => m.seen > trig || !!holdBuy?.(r); }
      case "stop_loss": { const trig = r.trigger_price!; return () => m.seen > trig; }
      case "limit_sell": case "take_profit": { const trig = r.trigger_price!; return () => m.seen < trig; }
      default: return () => false; // dca at its time, and anything this doesn't know: the engine looks
    }
  }

  private sample(now: number) {
    this.times.push(now);
    for (const e of this.engines) { const pos = e.exec.position(); e.curve.position.push(pos); e.curve.cash.push(e.exec.cash); e.curve.equity.push(e.exec.cash + pos - e.exec.networkUsd); }
  }

  /** Run to `until` (default: the end). Can be called again to carry on. */
  async run(until = this.end): Promise<SimResult> {
    if (until > this.end) until = this.end;
    while (this.clock <= until) {
      const now = this.clock;
      this.look();
      let dirty = false;
      while (this.hooks.length && this.hooks[0]!.t <= now) {
        const h = this.hooks.shift()!;
        for (const e of this.engines) this.flush(e);
        await h.fn(this); dirty = true;
        if (h.every) this.at(h.t + h.every, h.fn, h.every);
      }
      // The account's value is recorded before this check's trades, so the first sample is the starting value and every cost shows up in the changes after it.
      if (now >= this.nextSample) { this.sample(now); this.nextSample += this.sampleMs; }
      if (!this.isDown(now)) for (const e of this.engines) {
        if (dirty || e.ver !== this.store.ver) this.compile(e);
        let act = !this.fast && this.store.peek().some((r) => r.status === "active"); // the slow path doesn't lean on the checks it is there to prove
        if (!act) { const w = e.watch; for (let i = 0; i < w.length; i++) if (!w[i]!(now)) { act = true; break; } }
        if (act) { this.flush(e); await e.ap.tick(); e.ticks++; }
      }
      this.polls++; this.clock = now + this.pollMs;
    }
    for (const e of this.engines) this.flush(e);
    if (until >= this.end) {
      // The closing value, after the last check's trades. It replaces a regular sample taken at the same moment.
      if (this.times.at(-1) === this.end) { this.times.pop(); for (const e of this.engines) { e.curve.equity.pop(); e.curve.position.pop(); e.curve.cash.pop(); } }
      const was = this.clock; this.clock = this.end; this.sample(this.end); this.clock = was;
    }
    return this.result();
  }

  result(): SimResult {
    const e = this.engines[0], mine = this.trades.filter((t) => !e || t.mode === e.mode), sum = (f: (t: SimTrade) => number) => mine.reduce((a, t) => a + f(t), 0);
    const at = Math.min(this.clock, this.end), was = this.clock; this.clock = at;
    const position = e ? e.exec.position() : 0, cash = e ? e.exec.cash : 0, net = e ? e.exec.networkUsd : 0; this.clock = was;
    const fee = sum((t) => t.fee_usd), impact = sum((t) => t.impact_usd), delay = sum((t) => t.delay_usd);
    const rules = this.store.list();
    return {
      from: this.start, to: at, polls: this.polls, ticks: this.engines.reduce((a, x) => a + x.ticks, 0),
      trades: this.trades, rules, bots: summarize(rules, (_c, token) => this.find(token)?.priceAt(at)),
      start_usd: e?.exec.start ?? 0, cash_usd: cash, position_usd: position, equity_usd: cash + position - net, pnl_usd: cash + position - net - (e?.exec.start ?? 0),
      turnover_usd: sum((t) => (t.side === "buy" ? t.usd : t.units * t.mid)), costs: { fee_usd: fee, impact_usd: impact, delay_usd: delay, network_usd: net, total_usd: fee + impact + delay + net }, fails: e?.exec.fails ?? 0,
      events: { ...this.events }, curve: { t: this.times, equity: e?.curve.equity ?? [], position: e?.curve.position ?? [], cash: e?.curve.cash ?? [] },
    };
  }
}

/** One call: these bots, from the start of the candles to the end. */
export async function backtest(o: SimOptions & { bots: { template: string; token: string; params: Record<string, unknown>; at?: number; stop?: number; paper?: boolean }[] }): Promise<SimResult> {
  const sim = new Sim(o);
  for (const b of o.bots) {
    let id = "";
    sim.at(b.at ?? sim.start, async (s) => { id = (await s.addBot(b.template, b.token, b.params, { paper: b.paper ?? o.mode === "paper" })).bot; });
    if (b.stop !== undefined) sim.at(b.stop, async (s) => { await s.stopBot(id); });
  }
  return sim.run();
}
