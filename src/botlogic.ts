/**
 * 0.9.3: the step-by-step logic of the stateful bots, shared word for word by the wallet (src/autopilot.ts runs it
 * while the app is open) and Tollkit's server (x402-starter src/botlogic.ts, for Run 24/7 on Solana). Pure: no
 * network, no clock of its own. Each check asks `decide` what to do at today's price; after a trade goes through,
 * `applyFill` records it. Amounts of the coin are in its smallest units (strings, so JSON keeps them exact).
 *
 *   grid           buys amount_usd at each level as the price falls through a range; sells each one a level up.
 *   smart_dca      buys, then buys more (each `scale` times bigger) every `step_pct` lower, up to `safety` extra
 *                  buys; sells everything at `profit_pct` over the average cost, then starts over.
 *   rebalance      keeps a pot of amount_usd split `target_pct` coin / the rest USDC; trades back when the coin's
 *                  share drifts more than `band_pct` points.
 *   infinity_grid  keeps amount_usd worth of the coin: every `step_pct` up it sells the extra, every `step_pct`
 *                  down it buys back to amount_usd; never buys below `lower_price`. No top.
 *   twap           one big buy (amount_usd) or sell (sell_percent of the coin) in `pieces` equal parts spread
 *                  over `hours`.
 *   custom         Nov 11, 2026: a bot built from five parts the owner (or the AI) chooses: when to buy, how much,
 *                  when to sell, protection, limits. See CustomSpec. It works in rounds: a round starts with a buy
 *                  while it holds nothing and ends when everything is sold.
 */
export const BOT_KINDS = ["grid", "smart_dca", "rebalance", "infinity_grid", "twap", "custom"] as const;
export type BotKind = (typeof BOT_KINDS)[number];
export const isBotKind = (k: string): k is BotKind => (BOT_KINDS as readonly string[]).includes(k);
/** Smallest trade a bot makes, in dollars: below this, rounding and fees eat it. */
export const MIN_TRADE_USD = 1;

export interface BotParams {
  kind: string;
  amount_usd?: number;
  lower_price?: number; upper_price?: number; levels?: number;
  step_pct?: number; safety?: number; scale?: number; profit_pct?: number;
  target_pct?: number; band_pct?: number;
  side?: "buy" | "sell"; sell_percent?: number; pieces?: number; hours?: number;
  custom?: CustomSpec;
}
/**
 * The five parts of a custom bot. Percentages are plain numbers (5 = 5%).
 *   buy      when a round starts, and (levels, schedule) when it adds to one:
 *            schedule  every `every_hours`
 *            drop      when the price is `pct` below where it was `hours` ago (24 unless given)
 *            levels    each `step_pct` below the anchor, up to `levels` buys a round. The anchor is the highest price
 *                      seen while it holds nothing (the price it last sold everything at, to begin with)
 *            price     when the price is at or below `at`
 *            rsi       when hourly RSI(14) is at or below `below`
 *   size     `usd` a buy. grow "wins": 25% bigger after each winning round (up to 5 in a row), back to `usd` after a
 *            losing one. grow "deeper": each further buy in a round is `factor` times the one before.
 *   sell     steps: when the price is `gain_pct` over the average cost, sell `share_pct` of what it holds (the last
 *            step should be 100 unless a trail takes the rest). trail_pct: once the steps are done (and the gain has
 *            reached `trail_after_pct`, if given), sell everything when the price falls that far from its high.
 *            Neither: it only sells for protection.
 *   protect  stop_pct: sell everything when the price is that far under the average cost. downtrend: sell everything
 *            and stop buying when the price is `gap_pct` under its `hours`-hour average; buy again once it is
 *            `gap_pct` over it.
 *   limits   max_usd: the most it may have in the coin (at cost). max_loss_usd: when it is down this much in all, it
 *            sells everything and stops for good.
 */
export interface CustomSpec {
  buy: { type: "schedule"; every_hours: number } | { type: "drop"; pct: number; hours?: number } | { type: "levels"; step_pct: number; levels: number } | { type: "price"; at: number } | { type: "rsi"; below: number }
    /** Phase 3 (Nov 11, 2026): long or flat with the slow trend. Decided once a day from finished daily closes: holds the coin while the close is gap_pct over its `days`-day average, and sells everything to USDC once it is gap_pct under it. */
    | { type: "trend"; days: number; gap_pct: number };
  size: { usd: number; grow?: "none" | "wins" | "deeper"; factor?: number };
  sell?: { steps?: { gain_pct: number; share_pct: number }[]; trail_pct?: number; trail_after_pct?: number };
  protect?: { stop_pct?: number; downtrend?: { hours: number; gap_pct: number } };
  limits: { max_usd: number; max_loss_usd?: number };
}
/** What a custom bot remembers between checks. */
export interface CustomState {
  /** Levels: the price its buys are measured from. */
  anchor?: number;
  /** This round: buys made, sell steps done, the highest price seen since the steps finished. */
  buys?: number; step?: number; peak?: number;
  /** Schedule: when the next buy is due (ms). */
  next_at?: number;
  /** Stepped out of a downtrend: no buys until the price is back over its average. */
  out?: boolean;
  /** Review, Nov 11: after a stop-loss, no buys until this time (ms), so a stop is never followed by a buy at the next check. */
  rest_until?: number;
  /** Dollars made on everything sold so far, this round's share of it, and winning rounds in a row. */
  realized?: number; round?: number; wins?: number;
}
export interface GridSlots { units: (number | null)[]; cost: (number | null)[]; atomic: (string | null)[] }
export interface BotState {
  /** Coin the bot holds (smallest units) and what it cost in dollars. */
  units?: string; cost?: number;
  /** Rebalancer: the pot's dollars not in the coin. */
  cash?: number;
  /** Infinity grid: the price of its last trade. Smart DCA: the price of its last buy. */
  ref?: number;
  /** Smart DCA: extra buys made this round. */
  buys?: number;
  /** Rounds finished (Smart DCA sells, rebalances, infinity-grid sells). */
  cycles?: number;
  started?: boolean; done?: boolean;
  /** Split order: parts done, when the next is due (ms), and the total to sell once fixed. */
  pieces?: number; next_at?: number; sell_total?: string;
  grid?: GridSlots;
  /** Custom bot (see CustomState). */
  c?: CustomState;
  /** Counts every applied fill, so the newer copy (app or server) wins. */
  v?: number;
}
export type BotAction =
  | { side: "buy"; usd: number; slot?: number; why: string }
  | { side: "sell"; atomic: string; slot?: number; why: string; sell_total?: string; /** Custom bot: why it sold ("step", "trail", "stop", "downtrend", "loss"). */ tag?: string }
  | { side: "mark"; ref: number; why: string; /** Custom bot: what to remember. */ c?: Partial<CustomState> }
  | null;

const big = (s?: string | null) => BigInt(s ?? "0");
const toUnits = (a: bigint, d: number) => Number(a) / 10 ** d;
const toAtomic = (u: number, d: number) => BigInt(Math.max(0, Math.floor(u * 10 ** d)));
const pct = (n?: number) => (n ?? 0) / 100;

export function gridLevels(p: Pick<BotParams, "lower_price" | "upper_price" | "levels">): number[] {
  const n = p.levels ?? 0, lo = p.lower_price ?? 0, hi = p.upper_price ?? 0;
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}
export const emptyGrid = (n: number): GridSlots => ({ units: Array(n).fill(null), cost: Array(n).fill(null), atomic: Array(n).fill(null) });

/** The most one buy of this bot can spend: what a USDC allowance must cover at least. */
export function largestBuy(p: BotParams): number {
  const a = p.amount_usd ?? 0;
  switch (p.kind) {
    case "smart_dca": return a * Math.pow(p.scale ?? 1, p.safety ?? 0);
    case "rebalance": return a * Math.max(pct(p.target_pct), 1 - pct(p.target_pct));
    case "twap": return p.side === "sell" ? 0 : a / Math.max(1, p.pieces ?? 1);
    case "custom": { const c = p.custom; if (!c) return 0; const f = c.size.grow === "wins" ? Math.pow(1.25, 5) : c.size.grow === "deeper" && c.buy.type === "levels" ? Math.pow(c.size.factor ?? 1.5, Math.max(0, c.buy.levels - 1)) : 1; return Math.min(c.limits.max_usd, c.size.usd * f); }
    default: return a;
  }
}
/** Whether the bot ever buys or ever sells (a split order does one or the other). */
export const botBuys = (p: BotParams) => !(p.kind === "twap" && p.side === "sell");
export const botSells = (p: BotParams) => !(p.kind === "twap" && p.side !== "sell");

/** Average cost per coin of what the bot holds, or null. */
export function avgCost(s: BotState, decimals: number): number | null {
  const u = toUnits(big(s.units), decimals);
  return u > 0 && s.cost ? s.cost / u : null;
}

/**
 * What to do now. `avail`: the most of the coin the bot may sell right now (its balance after the gas reserve, or
 * on the server the allowance); a split sell fixes its total from it on the first part.
 */
export function decide(p: BotParams, s: BotState, price: number, nowMs: number, o: { decimals: number; avail?: bigint; /** Hourly closes, oldest first (a custom bot's drop, RSI and downtrend parts read them). */ closes?: number[] | null; /** Finished daily closes, oldest first (a custom bot's trend part reads them). */ daily?: number[] | null }): BotAction {
  if (s.done || !(price > 0)) return null;
  const d = o.decimals, held = big(s.units), heldU = toUnits(held, d), value = heldU * price;
  switch (p.kind) {
    case "custom": return decideCustom(p.custom!, s, price, nowMs, held, value, o.closes ?? null, o.daily ?? null);
    case "grid": {
      const L = gridLevels(p), g = s.grid ?? emptyGrid(L.length - 1);
      const sellAt = g.atomic.findIndex((a, i) => a !== null && price >= L[i + 1]!);
      if (sellAt >= 0) return { side: "sell", atomic: g.atomic[sellAt]!, slot: sellAt, why: `Grid sells level ${sellAt + 1}` };
      if (price < L[0]!) return null;
      const step = L[1]! - L[0]!;
      for (let i = L.length - 2; i >= 0; i--) if (g.atomic[i] === null && price <= L[i]! && L[i]! - price < step) return { side: "buy", usd: p.amount_usd!, slot: i, why: `Grid buys level ${i + 1}` };
      return null;
    }
    case "smart_dca": {
      if (held <= 0n) return { side: "buy", usd: p.amount_usd!, why: "Smart DCA starts a round" };
      const avg = avgCost(s, d);
      if (avg && price >= avg * (1 + pct(p.profit_pct))) return { side: "sell", atomic: held.toString(), why: `Smart DCA sells at ${p.profit_pct}% over its average cost` };
      const n = s.buys ?? 0;
      if (n < (p.safety ?? 0) && s.ref && price <= s.ref * (1 - pct(p.step_pct))) return { side: "buy", usd: +(p.amount_usd! * Math.pow(p.scale ?? 1, n + 1)).toFixed(2), why: `Smart DCA extra buy ${n + 1} of ${p.safety}` };
      return null;
    }
    case "rebalance": {
      const t = pct(p.target_pct);
      if (!s.started) return { side: "buy", usd: +(p.amount_usd! * t).toFixed(2), why: "Rebalancer sets up its mix" };
      const cash = s.cash ?? 0, total = value + cash;
      if (!(total > 0)) return null;
      const share = value / total, band = pct(p.band_pct), goal = total * t;
      if (share > t + band && value - goal >= MIN_TRADE_USD) return { side: "sell", atomic: toAtomic((value - goal) / price, d).toString(), why: `Rebalancer: the coin is ${(share * 100).toFixed(1)}% of the pot, over ${p.target_pct}%` };
      const need = Math.min(cash, goal - value);
      if (share < t - band && need >= MIN_TRADE_USD) return { side: "buy", usd: +need.toFixed(2), why: `Rebalancer: the coin is ${(share * 100).toFixed(1)}% of the pot, under ${p.target_pct}%` };
      return null;
    }
    case "infinity_grid": {
      if (!s.started) return { side: "buy", usd: p.amount_usd!, why: "Infinity grid buys its starting amount" };
      const ref = s.ref ?? price, step = pct(p.step_pct);
      if (price >= ref * (1 + step)) {
        const extra = value - p.amount_usd!;
        return extra >= MIN_TRADE_USD ? { side: "sell", atomic: toAtomic(extra / price, d).toString(), why: `Infinity grid sells the extra after a ${p.step_pct}% rise` } : { side: "mark", ref: price, why: "Price moved up a step" };
      }
      if (price <= ref * (1 - step)) {
        if (p.lower_price && price < p.lower_price) return null;
        const need = p.amount_usd! - value;
        return need >= MIN_TRADE_USD ? { side: "buy", usd: +need.toFixed(2), why: `Infinity grid buys back after a ${p.step_pct}% drop` } : { side: "mark", ref: price, why: "Price moved down a step" };
      }
      return null;
    }
    case "twap": {
      const n = Math.max(1, p.pieces ?? 1), done = s.pieces ?? 0;
      if (done >= n) return null;
      if (s.next_at && nowMs < s.next_at) return null;
      if (p.side === "sell") {
        const total = s.sell_total !== undefined ? big(s.sell_total) : (( o.avail ?? 0n) * BigInt(Math.round((p.sell_percent ?? 100) * 100))) / 10_000n;
        if (total <= 0n) return null;
        const sold = total * BigInt(done) / BigInt(n);
        const part = done === n - 1 ? total - sold : total / BigInt(n);
        return part > 0n ? { side: "sell", atomic: part.toString(), sell_total: total.toString(), why: `Split sell, part ${done + 1} of ${n}` } : null;
      }
      return { side: "buy", usd: +(p.amount_usd! / n).toFixed(2), why: `Split buy, part ${done + 1} of ${n}` };
    }
  }
  return null;
}

/** Wilder's RSI(14) over closes (oldest first), or null with too few. The same sum as the wallet's indicators. */
export function rsi14(c: number[]): number | null {
  const n = 14; if (c.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const x = c[i]! - c[i - 1]!; if (x > 0) g += x; else l -= x; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const x = c[i]! - c[i - 1]!; g = (g * (n - 1) + Math.max(0, x)) / n; l = (l * (n - 1) + Math.max(0, -x)) / n; }
  return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
}
/**
 * Nov 11, 2026 (24/7): a custom bot's parts as they arrive in a request: only the known fields, numbers only.
 * customProblem then checks the ranges. Tollkit's server reads the wallet's bots through this.
 */
export function cleanCustom(x: any): CustomSpec | undefined {
  if (!x || typeof x !== "object" || !x.buy || !x.size || !x.limits) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined), opt = <K extends string>(k: K, v: number | undefined) => (v === undefined ? {} : { [k]: v } as Record<K, number>);
  const b = x.buy, t = b.type;
  const buy = t === "schedule" ? { type: t, every_hours: n(b.every_hours) } : t === "drop" ? { type: t, pct: n(b.pct), ...opt("hours", n(b.hours)) } : t === "levels" ? { type: t, step_pct: n(b.step_pct), levels: n(b.levels) }
    : t === "trend" ? { type: t, days: n(b.days), gap_pct: n(b.gap_pct) } : t === "price" ? { type: t, at: n(b.at) } : t === "rsi" ? { type: t, below: n(b.below) } : { type: "none" };
  const g = x.size.grow, size = { usd: n(x.size.usd), ...(g === "wins" || g === "deeper" || g === "none" ? { grow: g } : {}), ...opt("factor", n(x.size.factor)) };
  const sl = x.sell && typeof x.sell === "object" ? x.sell : undefined, steps = Array.isArray(sl?.steps) ? sl.steps.slice(0, 7).map((s: any) => ({ gain_pct: n(s?.gain_pct), share_pct: n(s?.share_pct) })) : undefined;
  const sell = sl ? { ...(steps ? { steps } : {}), ...opt("trail_pct", n(sl.trail_pct)), ...opt("trail_after_pct", n(sl.trail_after_pct)) } : undefined;
  const pr = x.protect && typeof x.protect === "object" ? x.protect : undefined, dt = pr?.downtrend && typeof pr.downtrend === "object" ? { hours: n(pr.downtrend.hours), gap_pct: n(pr.downtrend.gap_pct) } : undefined;
  const protect = pr ? { ...opt("stop_pct", n(pr.stop_pct)), ...(dt ? { downtrend: dt } : {}) } : undefined;
  const limits = { max_usd: n(x.limits.max_usd), ...opt("max_loss_usd", n(x.limits.max_loss_usd)) };
  return { buy, size, ...(sell ? { sell } : {}), ...(protect ? { protect } : {}), limits } as unknown as CustomSpec;
}
/** The same for what a custom bot remembers. */
export function cleanCustomState(x: any): CustomState | undefined {
  if (!x || typeof x !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined), out: Record<string, number | boolean> = {};
  // Review, Nov 11: counts are whole and never negative, prices and times are positive; a bad one is dropped.
  for (const k of ["anchor", "peak", "next_at", "rest_until"]) { const v = n(x[k]); if (v !== undefined && v > 0) out[k] = v; }
  for (const k of ["buys", "step", "wins"]) { const v = n(x[k]); if (v !== undefined && v >= 0) out[k] = Math.floor(v); }
  for (const k of ["realized", "round"]) { const v = n(x[k]); if (v !== undefined) out[k] = v; }
  if (typeof x.out === "boolean") out.out = x.out;
  return out as CustomState;
}
/** The dollars a custom bot's next buy spends. */
export function customSize(c: CustomSpec, cs: CustomState): number {
  const f = c.size.grow === "wins" ? Math.pow(1.25, Math.min(5, cs.wins ?? 0)) : c.size.grow === "deeper" ? Math.pow(c.size.factor ?? 1.5, cs.buys ?? 0) : 1;
  return +(c.size.usd * f).toFixed(2);
}
/** Phase 3: where the last finished daily close sits against its average: "in" (gap over), "out" (gap under), "hold" (between), or null without enough days. */
export function trendState(daily: number[] | null | undefined, days: number, gapPct: number): { side: "in" | "out" | "hold"; close: number; mean: number } | null {
  if (!daily || daily.length < days || days < 1) return null;
  let sum = 0; for (let i = daily.length - days; i < daily.length; i++) sum += daily[i]!;
  const mean = sum / days, close = daily[daily.length - 1]!;
  return { side: close > mean * (1 + gapPct / 100) ? "in" : close < mean * (1 - gapPct / 100) ? "out" : "hold", close, mean };
}
function decideCustom(c: CustomSpec, s: BotState, price: number, nowMs: number, held: bigint, value: number, closes: number[] | null, daily: number[] | null): BotAction {
  const cs = s.c ?? {}, cost = s.cost ?? 0, holding = held > 0n && cost > 0, avg = holding ? cost / (value / price) : 0, gain = holding ? (price / avg - 1) * 100 : 0;
  const all = (why: string, tag: string): BotAction => ({ side: "sell", atomic: held.toString(), why, tag });
  // 1. Protection comes first.
  const tr = c.buy.type === "trend" ? trendState(daily, c.buy.days, c.buy.gap_pct) : null;
  if (holding && c.limits.max_loss_usd && (cs.realized ?? 0) + value - cost <= -c.limits.max_loss_usd) return all(`Down $${c.limits.max_loss_usd} in all: sells everything and stops`, "loss");
  if (holding && c.protect?.stop_pct && gain <= -c.protect.stop_pct) return all(`Stop: ${c.protect.stop_pct}% under its average cost`, "stop");
  if (holding && tr?.side === "out" && c.buy.type === "trend") return all(`Trend: yesterday's close was ${c.buy.gap_pct}% or more under its ${c.buy.days}-day average, so it sells to USDC`, "trend");
  const dt = c.protect?.downtrend;
  // Review, Nov 11: a price source can return a little less history than asked (186 of 200 points seen). The average
  // then uses what there is, down to 70% of its window, so the exit doesn't switch itself off.
  const dn = dt && closes ? Math.min(dt.hours, closes.length) : 0;
  if (dt && closes && dn >= Math.max(24, dt.hours * 0.7)) {
    let sum = 0; for (let i = closes.length - dn; i < closes.length; i++) sum += closes[i]!;
    const mean = sum / dn;
    if (!cs.out && price < mean * (1 - dt.gap_pct / 100)) return holding ? all(`Downtrend: ${dt.gap_pct}% under its ${Math.round(dt.hours / 24)}-day average, so it sells to USDC`, "downtrend") : { side: "mark", ref: price, why: "Downtrend: waiting in USDC", c: { out: true } };
    if (cs.out && price > mean * (1 + dt.gap_pct / 100)) return { side: "mark", ref: price, why: "The downtrend lifted: buying again", c: { out: false, anchor: price } };
  }
  // 2. Selling what it holds.
  if (holding && c.sell) {
    const steps = Array.isArray(c.sell.steps) ? c.sell.steps : [], i = Math.max(0, Math.floor(cs.step ?? 0));
    if (i < steps.length) {
      if (gain >= steps[i]!.gain_pct) {
        const share = Math.min(100, steps[i]!.share_pct), part = share >= 100 || (value * share) / 100 < MIN_TRADE_USD ? held : (held * BigInt(Math.round(share * 100))) / 10_000n; // a step worth under $1 sells everything instead
        if (part > 0n) return { side: "sell", atomic: part.toString(), why: `Up ${steps[i]!.gain_pct}% on its average cost: sells ${share >= 100 ? "the rest" : `${share}%`}`, tag: "step" };
      }
    } else if (!c.sell.trail_pct) {
      // Review, Nov 11: the steps are done but coin is left (a sell the wallet cut short): sell it at the last step's gain.
      if (steps.length && gain >= steps[steps.length - 1]!.gain_pct) return all(`Up ${steps[steps.length - 1]!.gain_pct}% on its average cost: sells the rest`, "step");
    } else {
      const armed = cs.peak !== undefined || gain >= (c.sell.trail_after_pct ?? -Infinity);
      if (armed) {
        const peak = cs.peak ?? price;
        if (price <= peak * (1 - c.sell.trail_pct / 100)) return all(`Fell ${c.sell.trail_pct}% from its high: sells`, "trail");
        // A new high is remembered once it is 0.2% above the last one kept, so the state isn't rewritten on every tick.
        if (cs.peak === undefined || price > peak * 1.002) return { side: "mark", ref: price, why: "New high", c: { peak: price } };
      }
    }
  }
  // 3. Buying.
  if (cs.out || (cs.rest_until && nowMs < cs.rest_until)) return null;
  if (c.limits.max_loss_usd && (cs.realized ?? 0) <= -c.limits.max_loss_usd) return null; // past its loss limit: no new round
  const usd = customSize(c, cs), b = c.buy, n = cs.buys ?? 0;
  if (usd < MIN_TRADE_USD || cost + usd > c.limits.max_usd * 1.005 + 0.005) return null; // 0.5% of room: a fee paid beside the swap counts in the cost and must not cancel the last buy
  const buy = (why: string): BotAction => ({ side: "buy", usd, why });
  switch (b.type) {
    case "schedule": return !cs.next_at || nowMs >= cs.next_at ? buy("Scheduled buy") : null;
    case "levels": {
      if (!holding && (cs.anchor === undefined || price > cs.anchor * 1.002)) return { side: "mark", ref: price, why: "Following the price up", c: { anchor: price } };
      if (n >= b.levels) return null;
      return price <= cs.anchor! * (1 - (b.step_pct / 100) * (n + 1)) ? buy(`Level ${n + 1} of ${b.levels}: ${(b.step_pct * (n + 1)).toFixed(1)}% under $${+cs.anchor!.toPrecision(6)}`) : null;
    }
    case "drop": { if (holding || !closes) return null; const h = Math.round(b.hours ?? 24), was = closes[closes.length - 1 - h]; return was && price <= was * (1 - b.pct / 100) ? buy(`Down ${b.pct}% in ${h} hours`) : null; }
    case "price": return !holding && price <= b.at ? buy(`At or under $${b.at}`) : null;
    case "trend": return !holding && tr?.side === "in" ? buy(`Trend: yesterday's close was ${b.gap_pct}% or more over its ${b.days}-day average`) : null;
    case "rsi": { if (holding || !closes) return null; const v = rsi14([...closes, price]); return v !== null && v <= b.below ? buy(`Hourly RSI ${v.toFixed(0)}, at or under ${b.below}`) : null; }
  }
  return null;
}

/**
 * Record a trade that went through. `got`: for a buy, the coin received (smallest units); for a sell, what was
 * sold. `usd`: dollars spent (buy) or received (sell). Returns the new state, whether the bot is finished, and the
 * profit of a finished round (grid level, Smart DCA round, infinity-grid sell), if any.
 */
export function applyFill(p: BotParams, s0: BotState, a: Exclude<BotAction, null>, fill: { usd: number; got: bigint }, price: number, nowMs: number, decimals: number): { state: BotState; done: boolean; profit?: number } {
  const s: BotState = JSON.parse(JSON.stringify(s0 ?? {}));
  s.v = (s.v ?? 0) + 1;
  if (a.side === "mark") { s.ref = a.ref; s.v -= 1; if (a.c) s.c = { ...(s.c ?? {}), ...a.c }; return { state: s, done: false }; }
  if (p.kind === "custom") return applyCustom(p.custom!, s, a, fill, price, nowMs);
  const held = big(s.units), usd = fill.usd;
  let profit: number | undefined;
  if (p.kind === "grid") {
    const L = gridLevels(p); s.grid ??= emptyGrid(L.length - 1);
    const i = a.slot!;
    if (a.side === "buy") { s.grid.units[i] = toUnits(fill.got, decimals); s.grid.cost[i] = usd; s.grid.atomic[i] = fill.got.toString(); }
    else { profit = s.grid.cost[i] != null ? usd - s.grid.cost[i]! : 0; s.grid.units[i] = null; s.grid.cost[i] = null; s.grid.atomic[i] = null; s.cycles = (s.cycles ?? 0) + 1; }
    return { state: s, done: false, profit };
  }
  if (a.side === "buy") {
    if (p.kind === "smart_dca") s.buys = held > 0n ? (s.buys ?? 0) + 1 : 0;
    s.units = (held + fill.got).toString(); s.cost = (s.cost ?? 0) + usd;
    if (p.kind === "rebalance") { s.cash = s.started ? (s.cash ?? 0) - usd : (p.amount_usd ?? 0) - usd; if ((s.cash ?? 0) < 0) s.cash = 0; if (s.started) s.cycles = (s.cycles ?? 0) + 1; }
    s.started = true; s.ref = price;
  } else {
    const sold = fill.got > held && p.kind !== "twap" ? held : fill.got;
    const share = held > 0n ? Number(sold) / Number(held) : 0, costOut = (s.cost ?? 0) * share;
    if (p.kind !== "twap" || held > 0n) { s.units = (held > sold ? held - sold : 0n).toString(); s.cost = Math.max(0, (s.cost ?? 0) - costOut); }
    if (p.kind === "smart_dca") { profit = usd - costOut; s.cycles = (s.cycles ?? 0) + 1; s.buys = 0; s.units = "0"; s.cost = 0; }
    if (p.kind === "rebalance") { s.cash = (s.cash ?? 0) + usd; s.cycles = (s.cycles ?? 0) + 1; }
    if (p.kind === "infinity_grid") { profit = usd - costOut; s.cycles = (s.cycles ?? 0) + 1; }
    if (p.kind === "twap" && a.sell_total) s.sell_total = a.sell_total;
    s.ref = price;
  }
  if (p.kind === "twap") {
    const n = Math.max(1, p.pieces ?? 1);
    s.pieces = (s.pieces ?? 0) + 1;
    s.next_at = nowMs + ((p.hours ?? 1) * 3_600_000) / n;
    if (s.pieces >= n) s.done = true;
  }
  return { state: s, done: !!s.done, profit };
}

/** After a stop-loss a custom bot waits this long before it may buy again. */
export const STOP_REST_MS = 24 * 3_600_000;
function applyCustom(c: CustomSpec, s: BotState, a: Exclude<BotAction, null | { side: "mark" }>, fill: { usd: number; got: bigint }, price: number, nowMs: number): { state: BotState; done: boolean; profit?: number } {
  const held = big(s.units), cs: CustomState = (s.c = { ...(s.c ?? {}) });
  if (a.side === "buy") {
    s.units = (held + fill.got).toString(); s.cost = (s.cost ?? 0) + fill.usd; s.ref = price;
    cs.buys = (cs.buys ?? 0) + 1; cs.peak = undefined;
    if (cs.anchor === undefined) cs.anchor = price;
    if (c.buy.type === "schedule") cs.next_at = nowMs + c.buy.every_hours * 3_600_000;
    return { state: s, done: false };
  }
  const sold = fill.got > held ? held : fill.got, share = held > 0n ? Number(sold) / Number(held) : 0, costOut = (s.cost ?? 0) * share, profit = fill.usd - costOut;
  // Review, Nov 11: a sell of everything that the wallet cut short by a sliver (rounding, a little kept for network
  // fees) still ends the round: under 1% left is let go, as Smart DCA does. More than that stays and is sold next.
  let left = held - sold;
  if (left > 0n && BigInt(a.atomic) >= held && left * 100n <= held) left = 0n;
  s.units = left.toString(); s.cost = left === 0n ? 0 : Math.max(0, (s.cost ?? 0) - costOut); s.ref = price;
  cs.realized = (cs.realized ?? 0) + profit; cs.round = (cs.round ?? 0) + profit;
  if (a.tag === "step") cs.step = (cs.step ?? 0) + 1;
  if (big(s.units) <= 0n) { // the round is over
    s.units = "0"; s.cost = 0; s.cycles = (s.cycles ?? 0) + 1;
    cs.wins = (cs.round ?? 0) > 0 ? (cs.wins ?? 0) + 1 : 0;
    cs.buys = 0; cs.step = 0; cs.peak = undefined; cs.round = 0; cs.anchor = price;
    if (a.tag === "downtrend") cs.out = true;
    if (a.tag === "stop") cs.rest_until = nowMs + STOP_REST_MS;
    if (a.tag === "loss") s.done = true;
  }
  return { state: s, done: !!s.done, profit };
}

/**
 * 0.9.8: when the device and Tollkit's server each hold a copy of a bot's state, should `other` replace `mine`?
 * A split order compares parts done first, so a part one side already sold is never forgotten (on 2026-10-27 a
 * tie in `v` let the server keep its own copy and sell 3 parts of a 2-part split). Otherwise the higher `v` wins;
 * `onTie` says what a tie does (the device takes the server's copy, the server keeps its own).
 */
export function botNewer(kind: string, mine: BotState | undefined, other: BotState | undefined, onTie: boolean): boolean {
  if (!other) return false;
  if (!mine) return true;
  if (kind === "twap") {
    const a = mine.pieces ?? 0, b = other.pieces ?? 0;
    if (a !== b) return b > a;
  }
  const va = mine.v ?? 0, vb = other.v ?? 0;
  return vb === va ? onTie : vb > va;
}

/** Checks the fields a bot kind needs. Returns a reason, or null. */
export function botProblem(p: BotParams): string | null {
  const a = p.amount_usd;
  switch (p.kind) {
    case "grid":
      if (!a || !p.lower_price || !p.upper_price || !p.levels) return "A grid needs amount_usd (per level), lower_price, upper_price and levels.";
      if (p.lower_price >= p.upper_price) return "The grid's lower price must be below its upper price.";
      return null;
    case "smart_dca":
      if (!a || !p.step_pct || !p.profit_pct || p.safety === undefined || !p.scale) return "Smart DCA needs amount_usd, step_pct, safety, scale and profit_pct.";
      if (!(p.scale >= 1 && p.scale <= 3)) return "Each extra buy can be 1 to 3 times the one before.";
      if (!(p.safety >= 0 && p.safety <= 10)) return "Smart DCA allows 0 to 10 extra buys.";
      return null;
    case "rebalance":
      if (!a || !p.target_pct || !p.band_pct) return "A rebalancer needs amount_usd (the pot), target_pct and band_pct.";
      if (!(p.target_pct >= 5 && p.target_pct <= 95)) return "The coin's share must be 5% to 95%.";
      if (!(p.band_pct >= 1 && p.band_pct <= 40)) return "Rebalance after a drift of 1 to 40 points.";
      if (a < 10) return "The pot is too small to rebalance; use at least $10.";
      return null;
    case "infinity_grid":
      if (!a || !p.step_pct) return "An infinity grid needs amount_usd and step_pct.";
      if (a * pct(p.step_pct) < MIN_TRADE_USD) return `Each step would trade under $${MIN_TRADE_USD}; raise the amount or the step.`;
      return null;
    case "twap":
      if (!p.pieces || !p.hours) return "A split order needs pieces and hours.";
      if (!(p.pieces >= 2 && p.pieces <= 100)) return "Split into 2 to 100 parts.";
      if (!(p.hours >= 0.25 && p.hours <= 168)) return "Spread it over 15 minutes to 7 days.";
      if (p.side === "sell") return p.sell_percent ? null : "A split sell needs sell_percent.";
      if (!a) return "A split buy needs amount_usd.";
      if (a / p.pieces < MIN_TRADE_USD) return `Each part would be under $${MIN_TRADE_USD}; use fewer parts.`;
      return null;
    case "custom": return customProblem(p.custom);
  }
  return "Unknown bot.";
}

/**
 * 0.9.12 Adaptive pace (Joe, Nov 3: "4% a day or 8% in 3 days"): what a coin's market is doing, from hourly closes
 * (oldest first, at least 73). Rising or falling: 4% or more over 24 hours, or 8% or more over 3 days while the last
 * day didn't move 2% the other way. Quiet: under 2% over 24 hours. Anything else is normal. Null: not enough history.
 */
export type MarketState = "quiet" | "normal" | "rising" | "falling";
export const MARKET = { dayPct: 4, threeDayPct: 8, quietPct: 2 } as const;
export function marketState(closes: number[]): { state: MarketState; d1: number; d3: number } | null {
  const c = closes.filter((x) => x > 0);
  if (c.length < 73) return null;
  const last = c[c.length - 1]!, pctFrom = (h: number) => Math.round((last / c[c.length - 1 - h]! - 1) * 10_000) / 100;
  const d1 = pctFrom(24), d3 = pctFrom(72);
  const state: MarketState = d1 >= MARKET.dayPct || (d3 >= MARKET.threeDayPct && d1 > -MARKET.quietPct) ? "rising"
    : d1 <= -MARKET.dayPct || (d3 <= -MARKET.threeDayPct && d1 < MARKET.quietPct) ? "falling"
    : Math.abs(d1) < MARKET.quietPct ? "quiet" : "normal";
  return { state, d1, d3 };
}

/** Checks a custom bot's five parts. Returns a plain reason, or null. */
export function customProblem(c: CustomSpec | undefined): string | null {
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (!c || !c.buy || !c.size || !c.limits) return "A custom bot needs when to buy, how much, and its limits.";
  const b = c.buy;
  if (b.type === "schedule") { if (!num(b.every_hours, 1, 24 * 30)) return "Buy on a schedule: every 1 hour to 30 days."; }
  else if (b.type === "drop") { if (!num(b.pct, 0.5, 90) || (b.hours !== undefined && (!Number.isInteger(b.hours) || !num(b.hours, 1, 168)))) return "Buy after a drop: 0.5% to 90%, over 1 to 168 hours."; }
  else if (b.type === "levels") { if (!num(b.step_pct, 0.4, 50) || !Number.isInteger(b.levels) || !num(b.levels, 1, 40)) return "Buy at levels: steps of 0.4% to 50%, 1 to 40 levels."; if (b.step_pct * b.levels >= 95) return "Those levels would reach a price of zero: use fewer or smaller steps."; }
  else if (b.type === "price") { if (!num(b.at, 1e-12, 1e12)) return "Buy at a price: give the price."; }
  else if (b.type === "trend") { if (!Number.isInteger(b.days) || !num(b.days, 20, 200) || !num(b.gap_pct, 0.5, 20)) return "Follow the trend: an average of 20 to 200 days, and a gap of 0.5% to 20%."; }
  else if (b.type === "rsi") { if (!num(b.below, 5, 60)) return "Buy on RSI: a level from 5 to 60."; }
  else return "Pick when to buy: on a schedule, after a drop, at levels, at a price, on RSI, or with the trend.";
  if (!num(c.size.usd, MIN_TRADE_USD, 1_000_000)) return `Each buy needs at least $${MIN_TRADE_USD}.`;
  if (c.size.grow !== undefined && !["none", "wins", "deeper"].includes(c.size.grow)) return "Pick how the size changes: the same, bigger after wins, or bigger as it falls.";
  if (c.size.grow === "deeper" && c.size.factor !== undefined && !num(c.size.factor, 1, 3)) return "Each further buy can be 1 to 3 times the one before.";
  if (!num(c.limits.max_usd, c.size.usd, 10_000_000)) return "The limit must be at least one buy.";
  if (c.limits.max_loss_usd !== undefined && !num(c.limits.max_loss_usd, Math.max(0.01, c.size.usd * 0.02), 10_000_000)) return "The loss limit must be at least 2% of one buy.";
  if (c.sell?.steps !== undefined && !Array.isArray(c.sell.steps)) return "Sell steps must be a list.";
  const steps = c.sell?.steps ?? [];
  if (steps.length > 6) return "At most 6 sell steps.";
  for (let i = 0; i < steps.length; i++) {
    if (!num(steps[i]!.gain_pct, 0.3, 1000) || !num(steps[i]!.share_pct, 1, 100)) return "Each sell step needs a gain of 0.3% or more and a share of 1% to 100%.";
    if (i > 0 && steps[i]!.gain_pct <= steps[i - 1]!.gain_pct) return "Each sell step needs a bigger gain than the one before.";
  }
  if (c.sell?.trail_pct !== undefined && !num(c.sell.trail_pct, 0.5, 90)) return "Trail by 0.5% to 90%.";
  if (c.sell?.trail_after_pct !== undefined && !num(c.sell.trail_after_pct, 0, 1000)) return "Start trailing after a gain of 0% to 1000%.";
  if (steps.length && steps[steps.length - 1]!.share_pct < 100 && !c.sell?.trail_pct) return "The last sell step should sell the rest (100%), or add a trail for what's left.";
  if (c.protect?.stop_pct !== undefined && !num(c.protect.stop_pct, 1, 90)) return "Stop at 1% to 90% under the average cost.";
  const dt = c.protect?.downtrend;
  if (dt && (!Number.isInteger(dt.hours) || !num(dt.hours, 24, 240) || !num(dt.gap_pct, 0.5, 20))) return "Downtrend exit: an average of 1 to 10 days, and a gap of 0.5% to 20%.";
  return null;
}
