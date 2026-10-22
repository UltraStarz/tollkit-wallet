/**
 * What the Bots screen draws (0.8.5): each bot's price levels, its next move, its trades, a price chart, and a
 * replay of a bot's settings over the last 30 days.
 *
 * Prices for charts and replays:
 *   - ETH (and WETH), SOL and POL: hourly candles from Coinbase Exchange (api.exchange.coinbase.com, public, no key;
 *     at most 300 candles per request, so 30 days takes three).
 *   - Any other token: the prices the autopilot itself saw while the bot ran (the price tape, one point every
 *     five minutes, kept seven days). A replay needs the Coinbase history, so it works for ETH, SOL and POL.
 *
 * The replay runs the real autopilot (src/autopilot.ts) against the past prices, with rules kept in memory and a
 * pretend exchange that fills at the replayed price minus Tollkit's 0.5% fee. Nothing is traded and nothing is
 * written to the wallet's own rules.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { BUY_KINDS, describeRule, gridLevels, nextRun, RuleStore, type Rule } from "./rules.js";
import { Autopilot, type Executor } from "./autopilot.js";
import { buildBot } from "./bots.js";
import type { Token } from "./tokens.js";
import type { SwapRequest } from "./swap.js";
import type { SwapResult } from "./wallet.js";

// ── Prices ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Candle { t: number; o: number; h: number; l: number; c: number }

/** The Coinbase product for a bot's token, or null when Coinbase doesn't list it. */
export function coinbaseProduct(token: string): string | null {
  const s = token.toUpperCase();
  return s === "ETH" || s === "WETH" ? "ETH-USD" : s === "SOL" || s === "WSOL" ? "SOL-USD" : s === "POL" ? "POL-USD" : null;
}

const candleCache = new Map<string, { at: number; rows: Candle[] }>();
/**
 * Hourly candles for the last `hours` hours, oldest first. Coinbase answers [time, low, high, open, close, volume],
 * newest first, at most 300 per request.
 */
export async function hourlyCandles(product: string, hours: number, f: typeof fetch = fetch, now = Date.now()): Promise<Candle[]> {
  const key = `${product}:${hours}`, hit = candleCache.get(key);
  if (hit && now - hit.at < 5 * 60_000) return hit.rows;
  const end = Math.floor(now / 3_600_000) * 3_600_000, out = new Map<number, Candle>();
  for (let to = end; to > end - hours * 3_600_000; to -= 290 * 3_600_000) {
    const from = Math.max(end - hours * 3_600_000, to - 290 * 3_600_000);
    const u = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    const r = await f(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Price history isn't available right now (HTTP ${r.status}).`);
    const rows = (await r.json()) as number[][];
    for (const x of Array.isArray(rows) ? rows : []) if (Array.isArray(x) && x.length >= 5) out.set(x[0]! * 1000, { t: x[0]! * 1000, l: x[1]!, h: x[2]!, o: x[3]!, c: x[4]! });
  }
  const rows = [...out.values()].sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error("No price history came back.");
  candleCache.set(key, { at: now, rows });
  return rows;
}

/** Prices the autopilot saw, per token: one point per five minutes, seven days, in bot-prices.json. */
export class PriceTape {
  private data: Record<string, [number, number][]> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly dir?: string) {}
  private file() { return path.join(walletHome(this.dir), "bot-prices.json"); }
  private load() {
    if (this.data) return this.data;
    try { const f = this.file(); this.data = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { this.data = {}; }
    return this.data!;
  }
  add(chain: Chain, token: string, price: number, now = Date.now()) {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const d = this.load(), k = `${chain}:${token.toLowerCase()}`, a = (d[k] ??= []);
    const last = a.at(-1);
    if (last && now - last[0] < 5 * 60_000) return;
    a.push([now, price]);
    const cut = now - 7 * 86_400_000;
    while (a.length && a[0]![0] < cut) a.shift();
    this.dirty = true;
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 30_000); (this.timer as any).unref?.(); }
  }
  flush() {
    this.timer = null;
    if (!this.dirty || !this.data) return;
    try { const f = this.file(), t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(this.data), { mode: 0o600 }); renameSync(t, f); this.dirty = false; } catch { /* best effort */ }
  }
  series(chain: Chain, token: string, since = 0): [number, number][] {
    return (this.load()[`${chain}:${token.toLowerCase()}`] ?? []).filter((p) => p[0] >= since);
  }
}

// ── A bot's levels, next move and trades ───────────────────────────────────────────────────────────────────────
export interface Level { price: number; kind: "buy" | "sell" | "stop" | "grid" | "cap"; label: string; live: boolean }
export interface Trade { ts: string; ok: boolean; side: "buy" | "sell" | null; usd: number | null; units: number | null; price: number | null; paper: boolean; reason?: string }
export interface NextMove { text: string; price?: number; at?: string; dist_pct?: number }

const fmt = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : n < 100 ? 4 : 2 })}`;
const open = (r: Rule) => r.status === "active" || r.status === "paused";

/** The prices a bot acts at, for drawing on its chart. Finished steps are kept, faded (live: false). */
export function botLevels(rs: Rule[]): Level[] {
  const out: Level[] = [];
  for (const r of rs) {
    const live = open(r);
    if (r.kind === "limit_buy" && r.trigger_price) out.push({ price: r.trigger_price, kind: "buy", label: "Buy", live });
    else if ((r.kind === "take_profit" || r.kind === "limit_sell") && r.trigger_price) out.push({ price: r.trigger_price, kind: "sell", label: r.kind === "take_profit" ? "Take profit" : "Sell", live });
    else if (r.kind === "stop_loss" && r.trigger_price) out.push({ price: r.trigger_price, kind: "stop", label: "Stop", live });
    else if (r.kind === "trailing_stop" && r.trail_pct) {
      const high = r.state.high ?? r.state.last_price;
      if (high) out.push({ price: high * (1 - r.trail_pct / 100), kind: "stop", label: `Trailing stop (−${r.trail_pct}% from the high)`, live });
    } else if (r.kind === "grid" && r.lower_price && r.upper_price && r.levels) {
      gridLevels(r).forEach((p, i) => out.push({ price: p, kind: "grid", label: i === 0 ? "Grid bottom" : i === r.levels! - 1 ? "Grid top" : `Grid level ${i + 1}`, live }));
    } else if (r.kind === "dca" && r.max_price) out.push({ price: r.max_price, kind: "cap", label: "Skips buys above", live });
    else for (const m of botMarks(r)) out.push({ ...m, live });
  }
  return out;
}

/** 0.9.3: where a Smart DCA, rebalancer or infinity grid acts next, from its own state. */
function botMarks(r: Rule): { price: number; kind: Level["kind"]; label: string; text: string }[] {
  const b = r.state.bot ?? {}, held = Math.max(0, (r.state.bought_units ?? 0) - (r.state.sold_units ?? 0)), out: { price: number; kind: Level["kind"]; label: string; text: string }[] = [];
  if (r.kind === "smart_dca" && held > 0 && b.cost) {
    const avg = b.cost / held;
    out.push({ price: avg * (1 + (r.profit_pct ?? 0) / 100), kind: "sell", label: `Sells all (+${r.profit_pct}%)`, text: `Sells everything at ${fmt(avg * (1 + (r.profit_pct ?? 0) / 100))}` });
    if ((b.buys ?? 0) < (r.safety ?? 0) && b.ref) { const p = b.ref * (1 - (r.step_pct ?? 0) / 100); out.push({ price: p, kind: "buy", label: `Extra buy ${(b.buys ?? 0) + 1}/${r.safety}`, text: `Buys ${fmt((r.amount_usd ?? 0) * Math.pow(r.scale ?? 1, (b.buys ?? 0) + 1))} more at ${fmt(p)}` }); }
  } else if (r.kind === "rebalance" && b.started && held > 0) {
    const t = (r.target_pct ?? 50) / 100, band = (r.band_pct ?? 5) / 100, cash = b.cash ?? 0, at = (share: number) => (share * cash) / ((1 - share) * held);
    if (t + band < 1) out.push({ price: at(t + band), kind: "sell", label: "Sells to target", text: `Sells some at ${fmt(at(t + band))}` });
    if (cash > 0 && t - band > 0) out.push({ price: at(t - band), kind: "buy", label: "Buys to target", text: `Buys some at ${fmt(at(t - band))}` });
  } else if (r.kind === "infinity_grid" && b.started && b.ref) {
    const st = (r.step_pct ?? 2) / 100;
    out.push({ price: b.ref * (1 + st), kind: "sell", label: `Sells the extra (+${r.step_pct}%)`, text: `Sells the extra at ${fmt(b.ref * (1 + st))}` });
    if (!r.lower_price || b.ref * (1 - st) >= r.lower_price) out.push({ price: b.ref * (1 - st), kind: "buy", label: `Buys back (−${r.step_pct}%)`, text: `Buys back at ${fmt(b.ref * (1 - st))}` });
    if (r.lower_price) out.push({ price: r.lower_price, kind: "cap", label: "No buys below", text: "" });
  }
  return out;
}

/** What the bot does next, in a sentence, with how far the price is from it. */
export function botNext(rs: Rule[], price: number | null, now = Date.now()): NextMove | null {
  const active = rs.filter((r) => r.status === "active" && (!r.after || rs.find((x) => x.id === r.after)?.status === "done"));
  if (!active.length) return null;
  const moves: NextMove[] = [];
  const dist = (p: number) => (price ? Math.round(((p - price) / price) * 1000) / 10 : undefined);
  for (const r of active) {
    if (r.kind === "dca") {
      const at = r.state.next_run ?? new Date(now).toISOString();
      moves.push({ text: `Buys ${fmt(r.amount_usd ?? 0)}`, at });
    } else if (r.kind === "limit_buy" && r.trigger_price) moves.push({ text: `Buys ${fmt(r.amount_usd ?? 0)} at ${fmt(r.trigger_price)}`, price: r.trigger_price, dist_pct: dist(r.trigger_price) });
    else if ((r.kind === "take_profit" || r.kind === "limit_sell") && r.trigger_price) moves.push({ text: `Sells at ${fmt(r.trigger_price)}`, price: r.trigger_price, dist_pct: dist(r.trigger_price) });
    else if (r.kind === "stop_loss" && r.trigger_price) moves.push({ text: `Stops out at ${fmt(r.trigger_price)}`, price: r.trigger_price, dist_pct: dist(r.trigger_price) });
    else if (r.kind === "trailing_stop" && r.trail_pct) {
      const high = r.state.high ?? price;
      if (high) { const p = high * (1 - r.trail_pct / 100); moves.push({ text: `Sells if it falls to ${fmt(p)}`, price: p, dist_pct: dist(p) }); }
    } else if (r.kind === "grid" && price && r.levels) {
      const L = gridLevels(r), g = r.state.grid;
      const sells = (g?.atomic ?? []).map((a, i) => (a !== null ? L[i + 1]! : null)).filter((x): x is number => x !== null && x > price);
      const buys = L.slice(0, -1).filter((p, i) => (g?.atomic?.[i] ?? null) === null && p <= price);
      if (sells.length) { const p = Math.min(...sells); moves.push({ text: `Sells a level at ${fmt(p)}`, price: p, dist_pct: dist(p) }); }
      if (buys.length) { const p = Math.max(...buys); moves.push({ text: `Buys a level at ${fmt(p)}`, price: p, dist_pct: dist(p) }); }
    } else if (r.kind === "twap") {
      const b = r.state.bot ?? {}, n = r.pieces ?? 1, part = r.side === "sell" ? "Sells" : `Buys ${fmt((r.amount_usd ?? 0) / n)}`;
      moves.push({ text: `${part}: part ${(b.pieces ?? 0) + 1} of ${n}`, at: b.next_at ? new Date(b.next_at).toISOString() : new Date(now).toISOString() });
    } else if (["smart_dca", "rebalance", "infinity_grid"].includes(r.kind)) {
      const b = r.state.bot ?? {};
      if (!b.started && !(r.kind === "smart_dca" && (r.state.bought_units ?? 0) > (r.state.sold_units ?? 0))) moves.push({ text: r.kind === "rebalance" ? `Buys ${fmt((r.amount_usd ?? 0) * (r.target_pct ?? 50) / 100)} to set up its mix` : `Buys ${fmt(r.amount_usd ?? 0)} to start`, at: new Date(now).toISOString() });
      else for (const m of botMarks(r)) if (m.text) moves.push({ text: m.text, price: m.price, dist_pct: dist(m.price) });
    }
  }
  if (!moves.length) return null;
  // The nearest price move first; a scheduled buy counts as near when it's due within a day.
  const score = (m: NextMove) => (m.at ? Math.max(0, (Date.parse(m.at) - now) / 86_400_000) * 5 : Math.abs(m.dist_pct ?? 100));
  return moves.sort((a, b) => score(a) - score(b))[0]!;
}

/** Every attempt the bot made, newest first, with the price it got. */
export function botTrades(rs: Rule[], limit = 50): Trade[] {
  return rs.flatMap((r) => r.state.fills.map((f) => ({
    ts: f.ts, ok: f.ok, side: f.side ?? (f.ok ? (BUY_KINDS.includes(r.kind) ? "buy" : r.kind === "grid" ? null : "sell") : null),
    usd: f.usd ?? null, units: f.units ?? null, price: f.usd && f.units ? f.usd / f.units : null, paper: !!f.paper, ...(f.reason ? { reason: f.reason } : {}),
  }))).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

// ── Replay ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Rules in memory, for a replay: same behavior as the wallet's store, no files. */
class MemoryRules extends RuleStore {
  private rows: Rule[] = [];
  constructor() { super("/nonexistent-replay"); }
  override list(): Rule[] { return structuredClone(this.rows); }
  override async mutate<T>(fn: (rules: Rule[]) => T): Promise<T> { const rs = structuredClone(this.rows); const out = fn(rs); this.rows = rs; return out; }
}

export interface ReplayResult {
  token: string; product: string; from: string; to: string; start_price: number; end_price: number; change_pct: number;
  prices: [number, number][];
  levels: Level[];
  rules: string[];
  trades: { ts: string; side: "buy" | "sell"; price: number; usd: number }[];
  hold_usd: number;
  spent_usd: number; received_usd: number; fees_usd: number; units_end: number; value_end_usd: number;
  /** With the bot: dollars out (received + what's left at the end price) minus dollars in. */
  result_usd: number; result_pct: number | null;
  /** Doing nothing instead: the starting holding (or the same dollars bought at the start) at the end price. */
  baseline_label: string; baseline_usd: number; baseline_pct: number | null;
  note: string;
}

const FEE = 0.005;

/**
 * Runs a template's settings over the last `days` days of hourly prices. `hold_usd`: for bots that sell what you
 * hold (protect, trailing stop, ladder), the holding to start with.
 */
export async function replay(o: { template: string; chain: Chain; token: string; params: Record<string, unknown>; days?: number; hold_usd?: number; fetch?: typeof fetch; now?: number }): Promise<ReplayResult> {
  const product = coinbaseProduct(o.token);
  if (!product) throw new Error("Replays use Coinbase's price history, which has ETH, SOL and POL. This token isn't on it.");
  const days = Math.min(30, Math.max(3, o.days ?? 30));
  const candles = await hourlyCandles(product, days * 24, o.fetch, o.now);
  const start = candles[0]!, end = candles.at(-1)!;
  const built = buildBot(o.template, o.token, o.chain, o.params, start.o);
  const sells = ["protect", "trail", "ladder"].includes(o.template) || (o.template === "twap" && o.params.side === "sell");
  const hold = sells ? Math.min(1_000_000, Math.max(1, o.hold_usd ?? 100)) : 0;

  let clock = start.t, price = start.o;
  const DEC = 18, ONE = 10 ** DEC;
  const tok: Token = { address: "replay-token", symbol: o.token.toUpperCase(), decimals: DEC };
  let units = sells ? hold / start.o : 0, spent = 0, received = 0, fees = 0;
  const trades: ReplayResult["trades"] = [];
  const fill = (req: SwapRequest, commit: boolean): SwapResult => {
    const buying = req.buy_token === tok.address;
    if (buying) {
      const usd = Number(req.sell_amount) / 1e6, got = (usd * (1 - FEE)) / price;
      if (commit) { spent += usd; fees += usd * FEE; units += got; trades.push({ ts: new Date(clock).toISOString(), side: "buy", price, usd }); }
      return { ok: true, tx: commit ? "replay" : undefined, quote: { chain: o.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: BigInt(Math.floor(got * ONE)).toString(), min_buy_amount: "0", fee_bps: 50, venue_fee_bps: 0, usd_value: usd, fee_usd: usd * FEE } };
    }
    const u = Number(req.sell_amount) / ONE, gross = u * price, net = gross * (1 - FEE);
    if (commit) { received += net; fees += gross * FEE; units = Math.max(0, units - u); trades.push({ ts: new Date(clock).toISOString(), side: "sell", price, usd: net }); }
    return { ok: true, tx: commit ? "replay" : undefined, quote: { chain: o.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: String(Math.floor(net * 1e6)), min_buy_amount: "0", fee_bps: 50, venue_fee_bps: 0, usd_value: gross, fee_usd: gross * FEE } };
  };
  const exec: Executor = {
    mode: "paper", slippageBps: 100,
    swap: async (req) => fill(req, true),
    quote: async (req) => fill(req, false),
    balance: async () => BigInt(Math.floor(units * ONE)),
  };
  const store = new MemoryRules();
  await store.addBot(built.rules, "owner", true);
  // Start the bot at the first candle: created then, and a recurring buy's first run counted from then.
  await store.mutate((rs) => { for (const r of rs) { r.created_at = r.activated_at = new Date(start.t).toISOString(); if (r.kind === "dca") r.state.next_run = (r.every === "week" && r.weekday !== undefined ? nextRun(r, new Date(start.t)) : new Date(start.t)).toISOString(); } });
  const levels = botLevels(store.list().map((r) => ({ ...r, state: { ...r.state, last_price: start.o } })));
  const ap = new Autopilot(store, exec, { snapshot: () => ({ prices: { [tok.symbol]: { usd: price, change_24h: null } } }) }, { now: () => clock, noLease: true, resolve: async () => tok });
  // Each hour goes open, low, high, close (open, high, low, close on a falling hour: the order a candle most
  // likely took), walked in steps of at most 0.25%, so a level is met close to its price the way the live bot
  // (checking every 15 seconds) would meet it, not at the hour's extreme.
  for (const k of candles) {
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    const pts: number[] = [path[0]!];
    for (let i = 1; i < 4; i++) {
      const a = path[i - 1]!, b = path[i]!, n = Math.min(40, Math.max(1, Math.ceil(Math.abs(b - a) / (a * 0.0025))));
      for (let j = 1; j <= n; j++) pts.push(a + ((b - a) * j) / n);
    }
    for (let i = 0; i < pts.length; i++) { clock = k.t + Math.floor((i / pts.length) * 3_600_000); price = pts[i]!; await ap.tick(); }
  }
  const endUnits = units, valueEnd = endUnits * end.c;
  const inUsd = sells ? hold : spent;
  const result = received + valueEnd - spent - hold;
  const baseline = sells ? hold * (end.c / start.o) - hold : spent > 0 ? spent * (end.c / start.o) - spent : 0;
  const pct = (n: number) => (inUsd > 0 ? Math.round((n / inUsd) * 1000) / 10 : null);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    token: tok.symbol, product, from: new Date(start.t).toISOString(), to: new Date(end.t + 3_600_000).toISOString(),
    start_price: start.o, end_price: end.c, change_pct: Math.round(((end.c - start.o) / start.o) * 1000) / 10,
    prices: candles.map((k) => [k.t, k.c]),
    levels,
    rules: built.rules.map((r) => describeRule(r)),
    trades,
    hold_usd: hold, spent_usd: r2(spent), received_usd: r2(received), fees_usd: r2(fees), units_end: endUnits, value_end_usd: r2(valueEnd),
    result_usd: r2(result), result_pct: pct(result),
    baseline_label: sells ? "Just holding" : "Buying it all at the start", baseline_usd: r2(baseline), baseline_pct: pct(baseline),
    note: "Hourly prices from Coinbase (each hour's open, low, high and close). Includes Tollkit's 0.5% fee; not network fees or slippage. Past prices don't predict future ones.",
  };
}
