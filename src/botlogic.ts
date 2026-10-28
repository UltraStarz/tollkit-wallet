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
 */
export const BOT_KINDS = ["grid", "smart_dca", "rebalance", "infinity_grid", "twap"] as const;
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
  /** Counts every applied fill, so the newer copy (app or server) wins. */
  v?: number;
}
export type BotAction =
  | { side: "buy"; usd: number; slot?: number; why: string }
  | { side: "sell"; atomic: string; slot?: number; why: string; sell_total?: string }
  | { side: "mark"; ref: number; why: string }
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
export function decide(p: BotParams, s: BotState, price: number, nowMs: number, o: { decimals: number; avail?: bigint }): BotAction {
  if (s.done || !(price > 0)) return null;
  const d = o.decimals, held = big(s.units), heldU = toUnits(held, d), value = heldU * price;
  switch (p.kind) {
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

/**
 * Record a trade that went through. `got`: for a buy, the coin received (smallest units); for a sell, what was
 * sold. `usd`: dollars spent (buy) or received (sell). Returns the new state, whether the bot is finished, and the
 * profit of a finished round (grid level, Smart DCA round, infinity-grid sell), if any.
 */
export function applyFill(p: BotParams, s0: BotState, a: Exclude<BotAction, null>, fill: { usd: number; got: bigint }, price: number, nowMs: number, decimals: number): { state: BotState; done: boolean; profit?: number } {
  const s: BotState = JSON.parse(JSON.stringify(s0 ?? {}));
  s.v = (s.v ?? 0) + 1;
  if (a.side === "mark") { s.ref = a.ref; s.v -= 1; return { state: s, done: false }; }
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
  }
  return "Unknown bot.";
}
