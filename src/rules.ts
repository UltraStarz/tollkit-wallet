/**
 * Autopilot rules: limit buys and sells, stop-loss, take-profit, trailing
 * stops and recurring buys (DCA). Every rule is a plain, pre-set instruction
 * the owner can read; the autopilot follows it and nothing else.
 *
 * Who turns a rule on:
 *   - rules the owner creates (CLI with the password, or the dashboard) start active;
 *   - rules an agent proposes start as "proposed" and wait for the owner to turn
 *     them on, unless the owner set policy.agent_rules = "auto".
 * Every fill still goes through the wallet's limits, approvals and receipts.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CHAIN_ENUM } from "./chains.js";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";
import { botProblem, type BotState } from "./botlogic.js";

export const RULE_KINDS = ["limit_buy", "limit_sell", "stop_loss", "take_profit", "trailing_stop", "dca", "grid", "alert", "smart_dca", "rebalance", "infinity_grid", "twap", "signal_buy", "signal_sell", "range"] as const;
/** 0.9.9: momentum signals a signal_buy / signal_sell rule waits for (src/indicators.ts checkSignal). */
export const SIGNALS = ["rsi_below", "rsi_above", "macd_up", "macd_down", "breakout_up", "breakout_down"] as const;
export type Signal = (typeof SIGNALS)[number];
/** 0.9.1: what an alert watches. Alerts only notify; they never trade. Indicators use hourly prices. */
export const ALERT_TYPES = ["above", "below", "move", "rsi_high", "rsi_low", "ma_up", "ma_down"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type RuleKind = (typeof RULE_KINDS)[number];
export const BUY_KINDS: RuleKind[] = ["limit_buy", "dca", "signal_buy"];

/** Grid price levels, lowest first. */
/** 0.9.6: 0.2% kept per round trip + 0.25% bot fee on the buy and on the sell. */
export const MIN_GRID_GAP_PCT = 0.7;
export function gridLevels(r: Pick<RuleInput, "lower_price" | "upper_price" | "levels">): number[] {
  const n = r.levels ?? 0, lo = r.lower_price ?? 0, hi = r.upper_price ?? 0;
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}
export type RuleStatus = "proposed" | "active" | "paused" | "done" | "cancelled" | "expired" | "error";

/** What an owner or agent asks for. */
export const RuleInput = z.object({
  kind: z.enum(RULE_KINDS),
  chain: z.enum(CHAIN_ENUM),
  token: z.string().min(2).describe("The asset traded: ETH, WETH, SOL, POL or a token address/mint"),
  name: z.string().max(60).optional(),
  /** Buys: dollars of USDC to spend each time. */
  amount_usd: z.number().positive().max(1_000_000).optional(),
  /** Sells: share of the current balance (1-100) or a fixed amount in normal units. */
  sell_percent: z.number().positive().max(100).optional(),
  sell_amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  /** USD price per token that triggers the rule. */
  trigger_price: z.number().positive().optional(),
  /** Trailing stop: sell when the price falls this % from the highest price seen. */
  trail_pct: z.number().min(0.5).max(99).optional(),
  /** DCA schedule. */
  every: z.enum(["hour", "day", "week"]).optional(),
  weekday: z.number().int().min(0).max(6).optional().describe("DCA weekly: 0=Sunday … 6=Saturday"),
  times: z.number().int().min(1).max(10_000).optional().describe("DCA: how many buys, then stop"),
  max_price: z.number().positive().optional().describe("DCA: skip a buy while the price is above this"),
  /** Rules sharing a group cancel each other when one fills (take-profit + stop-loss). */
  group: z.string().max(40).optional(),
  expires_at: z.string().datetime().optional(),
  /** Why this rule: one or two plain sentences, shown to the owner on the rule card (set by AI suggestions). */
  reason: z.string().max(400).optional(),
  /** Id of an existing rule this one replaces: turning this on cancels that one (e.g. moving a stop-loss up). */
  replaces: z.string().min(4).max(40).optional(),
  /** Grid: trade between these prices, buying at each level and selling one level up. amount_usd is per level. */
  lower_price: z.number().positive().optional(),
  upper_price: z.number().positive().optional(),
  levels: z.number().int().min(3).max(40).optional(),
  /** Bots: rules made together from one template share a bot id (src/bots.ts). */
  /** Wait until this rule (same bot) has filled before watching the price; and sell exactly what that rule bought. */
  after: z.string().min(2).max(40).optional(),
  sell_from: z.string().min(2).max(40).optional(),
  bot: z.string().regex(/^[\w-]{4,40}$/).optional(),
  bot_name: z.string().max(60).optional(),
  template: z.string().max(40).optional(),
  /** 0.9.1, alerts: what to watch (above/below use trigger_price; move uses alert_value as a 24h % move; rsi_high/rsi_low
   *  use alert_value as the RSI(14, hourly) level, default 70/30; ma_up/ma_down: the price crossing its 50-hour average). */
  alert: z.enum(ALERT_TYPES).optional(),
  alert_value: z.number().positive().max(100).optional(),
  /** 0.9.1: made by Autopilot for a paper trial; never trades real coins. */
  paper: z.boolean().optional(),
  /** 0.9.3 bots (src/botlogic.ts). Smart DCA: buy again every step_pct lower, up to `safety` extra buys, each `scale`
   *  times the last; sell all at profit_pct over the average. Infinity grid: step_pct. Rebalancer: target_pct coin,
   *  band_pct drift. Split order (twap): side, pieces over hours. */
  step_pct: z.number().min(0.2).max(50).optional(),
  safety: z.number().int().min(0).max(10).optional(),
  scale: z.number().min(1).max(3).optional(),
  profit_pct: z.number().min(0.2).max(1000).optional(),
  target_pct: z.number().min(5).max(95).optional(),
  band_pct: z.number().min(1).max(40).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  pieces: z.number().int().min(2).max(100).optional(),
  hours: z.number().min(0.25).max(168).optional(),
  /** 0.9.9, signal_buy / signal_sell: trade when a momentum signal fires on hourly or 4-hour closes. value: the RSI
   *  level (default 30 / 70) or, for a breakout, how many candles back (default 20). times: how often (default 1). */
  when: z.object({ signal: z.enum(SIGNALS), tf: z.enum(["1h", "4h"]).optional(), value: z.number().positive().max(200).optional() }).optional(),
  /** 0.9.9, range (Orca SOL/USDC, src/orca.ts): put amount_usd into the pool between ±range_pct of today's price; after
   *  recenter_min minutes out of range, take it out and open a new range around the price then. Runs on this device only. */
  range_pct: z.number().min(1).max(50).optional(),
  recenter_min: z.number().int().min(5).max(1440).optional(),
  /** 0.9.9: started from Autopilot's Range bot idea, so Autopilot may end it (src/superbot.ts endRangeIdeas). */
  suggested_by: z.enum(["autopilot"]).optional(),
});
export type RuleInput = z.infer<typeof RuleInput>;

export interface Fill { ts: string; ok: boolean; usd?: number; tx?: string; paper?: boolean; reason?: string; side?: "buy" | "sell"; units?: number }
export interface Rule extends RuleInput {
  id: string;
  status: RuleStatus;
  created_by: "owner" | "agent";
  /** The AI app that set it up (src/aiuse.ts names); its fills count against that app's weekly budget. */
  by?: string;
  created_at: string;
  activated_at?: string;
  /** The owner removed this finished rule from their bot list. Its trades stay in the history. */
  archived?: boolean;
  state: {
    high?: number;        // trailing stop: highest price seen while active
    runs: number;         // fills so far
    failures: number;     // consecutive failed attempts
    next_run?: string;    // DCA, or retry-after for a failed attempt
    last_price?: number;
    last_checked?: string;
    last_error?: string;
    note?: string;        // e.g. "Replaced by ab12cd34"
    /** 0.9.1: wait until then without counting a failure (nothing of its own to sell, or Autopilot's daily share used). */
    hold_until?: string;
    /** 0.9.1, alerts: false after firing until the condition clears; when it last fired; how often; the indicator now. */
    alert_armed?: boolean; last_alert?: string; alert_count?: number; alert_now?: string;
    fills: Fill[];
    /** Totals that outlive the last-50 fills list: successful and failed trades, dollars and units each way. */
    ok_count?: number; fail_count?: number;
    spent_usd?: number; received_usd?: number; bought_units?: number; sold_units?: number;
    /** Exact amount bought (smallest units), for a rule that sells what another rule bought. */
    bought_atomic?: string;
    /** Grid: units bought at each level that are waiting to be sold one level up, and what they cost. */
    grid?: { units: (number | null)[]; cost: (number | null)[]; atomic: (string | null)[] };
    /** 0.9.9, Range bot: the open Orca position (its token's mint), its range, and how it's doing. `liq` is the paper
     *  position's liquidity (paper only). out_since: when the price left the range. */
    range?: { mint?: string; lower_tick?: number; upper_tick?: number; lower?: number; upper?: number; opened_at?: string; out_since?: string;
      in_range?: boolean; value_usd?: number; sol?: number; usdc?: number; fees_usd?: number; recenters?: number; liq?: string; deposited_usd?: number; phase?: "opening" | "closing"; staged?: boolean;
      /** Fees earned and not yet collected (looked up every 5 minutes), and what the bot has done, newest last. */
      fees_pending_usd?: number; fees_checked_at?: string; log?: { ts: string; text: string }[];
      /** When it moved the range (the last 10). */
      recenter_at?: string[] };
    /** Grid: completed buy-then-sell round trips and their profit. */
    round_trips?: number; grid_profit_usd?: number;
    /** 0.9.3: Smart DCA, rebalancer, infinity grid and split orders (src/botlogic.ts). */
    bot?: BotState;
  };
}

/** Plain-language summary, shown to the owner before a rule is turned on. */
export function describeRule(r: RuleInput): string {
  const t = r.token.length > 12 ? `${r.token.slice(0, 6)}…${r.token.slice(-4)}` : r.token.toUpperCase();
  const $ = (n?: number) => (n === undefined ? "?" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`);
  // 0.9.7: a sell that follows a buy (sell_from) and names no amount sells what that buy got: say so, not "? SOL".
  const sell = r.sell_percent !== undefined ? (r.sell_percent >= 100 ? `all ${t}` : `${r.sell_percent}% of ${t}`) : r.sell_amount !== undefined ? `${r.sell_amount} ${t}` : r.sell_from ? `the ${t} it bought` : `? ${t}`;
  const on = ` on ${r.chain[0]!.toUpperCase()}${r.chain.slice(1)}`;
  switch (r.kind) {
    case "limit_buy": return `Buy ${$(r.amount_usd)} of ${t} when it's at or below ${$(r.trigger_price)}${on}`;
    case "limit_sell": return `Sell ${sell} when it's at or above ${$(r.trigger_price)}${on}`;
    case "take_profit": return `Take profit: sell ${sell} when it reaches ${$(r.trigger_price)}${on}`;
    case "stop_loss": return `Stop-loss: sell ${sell} if it falls to ${$(r.trigger_price)}${on}`;
    case "trailing_stop": return `Trailing stop: sell ${sell} if it falls ${r.trail_pct}% from its highest price${on}`;
    case "alert": {
      const w = r.alert === "above" ? `goes above ${$(r.trigger_price)}` : r.alert === "below" ? `falls below ${$(r.trigger_price)}` : r.alert === "move" ? `moves ${r.alert_value}% or more in a day`
        : r.alert === "rsi_high" ? `looks overbought (hourly RSI above ${r.alert_value ?? 70})` : r.alert === "rsi_low" ? `looks oversold (hourly RSI below ${r.alert_value ?? 30})`
        : r.alert === "ma_up" ? "crosses above its 50-hour average" : "crosses below its 50-hour average";
      return `Alert me when ${t} ${w}${on}`;
    }
    case "smart_dca": return `Smart DCA: buy ${$(r.amount_usd)} of ${t}, then ${r.safety} more ${r.safety === 1 ? "time" : "times"} every ${r.step_pct}% lower (each ${r.scale}× the last); sell it all ${r.profit_pct}% above the average cost, and repeat${on}`;
    case "rebalance": return `Rebalance ${$(r.amount_usd)} to ${r.target_pct}% ${t} / ${100 - (r.target_pct ?? 0)}% USDC whenever it drifts ${r.band_pct} points${on}`;
    case "infinity_grid": return `Infinity grid: keep ${$(r.amount_usd)} of ${t}, selling the extra every ${r.step_pct}% up and buying back every ${r.step_pct}% down${r.lower_price ? ` (no buys under ${$(r.lower_price)})` : ""}${on}`;
    case "twap": return r.side === "sell" ? `Split sell: ${sell} in ${r.pieces} parts over ${r.hours} ${r.hours === 1 ? "hour" : "hours"}${on}` : `Split buy: ${$(r.amount_usd)} of ${t} in ${r.pieces} parts over ${r.hours} ${r.hours === 1 ? "hour" : "hours"}${on}`;
    case "signal_buy": case "signal_sell": {
      const w = r.when, tf = w?.tf === "4h" ? "4-hour" : "hourly", v = w?.value;
      const sig = !w ? "?" : w.signal === "rsi_below" ? `${tf} RSI falls below ${v ?? 30}` : w.signal === "rsi_above" ? `${tf} RSI rises above ${v ?? 70}`
        : w.signal === "macd_up" ? `${tf} MACD crosses above its signal line` : w.signal === "macd_down" ? `${tf} MACD crosses below its signal line`
        : w.signal === "breakout_up" ? `the price breaks above its highest ${tf} close of the last ${v ?? 20}` : `the price breaks below its lowest ${tf} close of the last ${v ?? 20}`;
      const n = r.times && r.times > 1 ? ` (up to ${r.times} times)` : "";
      return r.kind === "signal_buy" ? `Buy ${$(r.amount_usd)} of ${t} when ${sig}${n}${on}` : `Sell ${sell} when ${sig}${n}${on}`;
    }
    case "range": return `Range bot: put ${$(r.amount_usd)} into Orca's SOL/USDC pool between ${r.range_pct ?? "?"}% below and above today's price, earning its trading fees; after ${r.recenter_min ?? 30} minutes outside the range, move it to a new range around the price`;
    case "grid": return `Grid: buy ${$(r.amount_usd)} of ${t} at each of ${r.levels ?? "?"} levels from ${$(r.lower_price)} to ${$(r.upper_price)}, and sell each one a level higher${on}`;
    case "dca": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const when = r.every === "week" && r.weekday !== undefined ? `every ${days[r.weekday]}` : `every ${r.every ?? "?"}`;
      return `Buy ${$(r.amount_usd)} of ${t} ${when}${r.times ? `, ${r.times} times` : ""}${r.max_price ? ` (skip while above ${$(r.max_price)})` : ""}${on}`;
    }
  }
}

/** Checks that the fields a kind needs are there. Returns a reason, or null. */
export function ruleProblem(r: RuleInput): string | null {
  if (r.kind === "range") {
    if (r.chain !== "solana" || !/^(SOL|So11111111111111111111111111111111111111112)$/i.test(r.token)) return "The Range bot runs on Orca's SOL/USDC pool only: chain solana, token SOL.";
    if (!r.amount_usd || r.amount_usd < 20) return "A Range bot needs amount_usd of at least $20.";
    if (!r.range_pct) return "A Range bot needs range_pct: how far either side of today's price (1 to 50%).";
    if (r.sell_percent || r.sell_amount || r.trigger_price || r.every) return "A Range bot takes amount_usd, range_pct and recenter_min only.";
    return null;
  }
  if (r.kind === "alert") {
    if (!r.alert) return "An alert needs what to watch (alert: above, below, move, rsi_high, rsi_low, ma_up or ma_down).";
    if ((r.alert === "above" || r.alert === "below") && !r.trigger_price) return "A price alert needs trigger_price.";
    if (r.alert === "move" && !(r.alert_value && r.alert_value >= 0.5 && r.alert_value <= 50)) return "A move alert needs alert_value: the % move in a day (0.5 to 50).";
    if (r.alert === "rsi_high" && r.alert_value !== undefined && (r.alert_value < 50 || r.alert_value > 95)) return "An overbought RSI level is between 50 and 95 (usually 70).";
    if (r.alert === "rsi_low" && r.alert_value !== undefined && (r.alert_value < 5 || r.alert_value > 50)) return "An oversold RSI level is between 5 and 50 (usually 30).";
    if (r.amount_usd || r.sell_percent || r.sell_amount) return "Alerts never trade, so they take no amounts.";
    if (/^(USDC|USDT)$/i.test(r.token)) return "Pick a token that moves; stablecoins stay near $1.";
    return null;
  }
  if (r.kind === "signal_buy" || r.kind === "signal_sell") {
    if (!r.when) return "A signal rule needs when: the signal to wait for (rsi_below, rsi_above, macd_up, macd_down, breakout_up or breakout_down).";
    const v = r.when.value, sg = r.when.signal;
    if (sg === "rsi_below" && v !== undefined && (v < 5 || v > 50)) return "An oversold RSI level is between 5 and 50 (usually 30).";
    if (sg === "rsi_above" && v !== undefined && (v < 50 || v > 95)) return "An overbought RSI level is between 50 and 95 (usually 70).";
    if (sg.startsWith("breakout") && v !== undefined && (!Number.isInteger(v) || v < 5 || v > 100)) return "A breakout looks back 5 to 100 candles (usually 20).";
    if (r.kind === "signal_buy" && !r.amount_usd) return "A signal buy needs amount_usd (dollars to spend).";
    if (r.kind === "signal_sell" && r.sell_percent === undefined && r.sell_amount === undefined) return "A signal sell needs sell_percent or sell_amount.";
    if (r.kind === "signal_sell" && r.sell_percent !== undefined && r.sell_amount !== undefined) return "Use sell_percent or sell_amount, not both.";
    if (r.every) return "Signal rules don't take a schedule.";
    if (/^(USDC|USDT)$/i.test(r.token)) return "Rules trade an asset against USDC; the token can't be a stablecoin.";
    return null;
  }
  if (["smart_dca", "rebalance", "infinity_grid", "twap"].includes(r.kind)) {
    if (/^(USDC|USDT)$/i.test(r.token)) return "Bots trade an asset against USDC; the token can't be a stablecoin.";
    if (r.kind === "twap" && r.side === "sell" && r.amount_usd) return "A split sell takes sell_percent, not amount_usd.";
    return botProblem(r as any);
  }
  if (r.kind === "grid") {
    if (!r.amount_usd) return "A grid needs amount_usd (dollars per level).";
    if (!r.lower_price || !r.upper_price || r.lower_price >= r.upper_price) return "A grid needs lower_price below upper_price.";
    if (!r.levels) return "A grid needs levels (3 to 40).";
    // 0.9.6: each level must still earn at least 0.2% after the bot fee on both sides (0.25% + 0.25%). The tightest
    // step is the top one: bought one level under the top, sold at the top.
    const step = (r.upper_price - r.lower_price) / (r.levels - 1), gapPct = (step / (r.upper_price - step)) * 100;
    if (gapPct < MIN_GRID_GAP_PCT) return `Grid levels are too close together (${gapPct.toFixed(2)}% apart). After the 0.25% fee on each side, every step needs at least ${MIN_GRID_GAP_PCT}%: use fewer levels or a wider range.`;
    if (/^(USDC|USDT)$/i.test(r.token)) return "Rules trade an asset against USDC; the token can't be a stablecoin.";
    return null;
  }
  const isBuy = BUY_KINDS.includes(r.kind);
  if (isBuy && !r.amount_usd) return "A buy needs amount_usd (dollars to spend).";
  if (!isBuy && r.sell_percent === undefined && r.sell_amount === undefined && !r.sell_from) return "A sell needs sell_percent or sell_amount.";
  if (!isBuy && r.sell_percent !== undefined && r.sell_amount !== undefined) return "Use sell_percent or sell_amount, not both.";
  if (["limit_buy", "limit_sell", "stop_loss", "take_profit"].includes(r.kind) && !r.trigger_price) return `A ${r.kind.replace("_", " ")} needs trigger_price.`;
  if (r.kind === "trailing_stop" && !r.trail_pct) return "A trailing stop needs trail_pct.";
  if (r.kind === "dca" && !r.every) return "A recurring buy needs every (hour, day or week).";
  if (r.kind !== "dca" && (r.every || r.times)) return "Only recurring buys (dca) and signal rules take every/times.";
  if (/^(USDC|USDT)$/i.test(r.token)) return "Rules trade an asset against USDC; the token can't be a stablecoin.";
  if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) return "expires_at is in the past.";
  return null;
}

const INTERVAL_MS = { hour: 3600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;

/** When a DCA rule should next buy, from a given time. */
export function nextRun(r: Pick<RuleInput, "every" | "weekday">, from: Date): Date {
  if (r.every === "week" && r.weekday !== undefined) {
    const d = new Date(from);
    const add = (r.weekday - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + add);
    d.setUTCHours(14, 0, 0, 0); // 14:00 UTC (10:00 New York)
    return d;
  }
  return new Date(from.getTime() + INTERVAL_MS[r.every ?? "day"]);
}

/** When a replacement goes live, the rule it replaces is cancelled so both never run. */
function retire(rules: Rule[], r: Rule) {
  if (!r.replaces) return;
  const old = rules.find((x) => x.id === r.replaces);
  if (old && !["done", "cancelled", "expired"].includes(old.status)) { old.status = "cancelled"; old.state.note = `Replaced by ${r.id}`; }
}

export class RuleStore {
  readonly file: string;
  constructor(private readonly dir?: string) { this.file = path.join(walletHome(dir), "rules.json"); }

  list(): Rule[] {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Rule[]; } catch { return []; }
  }
  get(id: string): Rule | undefined { return this.list().find((r) => r.id === id); }

  private write(rules: Rule[]) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Read-modify-write under the wallet lock, so the dashboard, CLI and autopilot never clobber each other. */
  async mutate<T>(fn: (rules: Rule[]) => T): Promise<T> {
    return withLock(() => { const rules = this.list(); const out = fn(rules); this.write(rules); return out; }, this.dir);
  }

  async add(input: RuleInput, by: "owner" | "agent", autoActivate: boolean, app?: string): Promise<Rule> {
    const parsed = RuleInput.parse(input);
    const why = ruleProblem(parsed);
    if (why) throw new Error(why);
    if (parsed.replaces) {
      const old = this.get(parsed.replaces);
      if (!old || ["done", "cancelled", "expired"].includes(old.status)) throw new Error(`replaces: no open rule ${parsed.replaces}.`);
    }
    const now = new Date();
    const active = by === "owner" || autoActivate;
    const rule: Rule = {
      ...parsed, id: randomUUID().slice(0, 8), created_by: by, ...(app ? { by: app } : {}), created_at: now.toISOString(),
      status: active ? "active" : "proposed", ...(active ? { activated_at: now.toISOString() } : {}),
      state: { runs: 0, failures: 0, fills: [], ...(parsed.kind === "grid" ? { grid: { units: Array(parsed.levels! - 1).fill(null), cost: Array(parsed.levels! - 1).fill(null), atomic: Array(parsed.levels! - 1).fill(null) } } : {}), ...(parsed.kind === "dca" ? { next_run: (parsed.every === "week" && parsed.weekday !== undefined ? nextRun(parsed, now) : now).toISOString() } : {}) },
    };
    await this.mutate((rules) => { rules.push(rule); if (active) retire(rules, rule); });
    return rule;
  }

  /** A bot's rules, added together. "@0", "@1"... in after/sell_from point at earlier rules in the same list. */
  async addBot(inputs: RuleInput[], by: "owner" | "agent", autoActivate: boolean, app?: string): Promise<Rule[]> {
    const made: Rule[] = [];
    for (const input of inputs) {
      const fix = (v?: string) => (v && /^@\d+$/.test(v) ? made[Number(v.slice(1))]?.id : v);
      const ref = { ...input, after: fix(input.after), sell_from: fix(input.sell_from) };
      if ((input.after && !ref.after) || (input.sell_from && !ref.sell_from)) throw new Error("A bot step points at a step that doesn't exist.");
      made.push(await this.add(ref, by, autoActivate, app));
    }
    return made;
  }

  /** Removes finished rules (done, cancelled or expired) from the bot list; a rule that can still trade can't be removed. */
  async archive(ids: string[]): Promise<number> {
    return this.mutate((rules) => {
      const rs = ids.map((id) => rules.find((x) => x.id === id));
      if (rs.some((r) => !r)) throw new Error("No such rule.");
      if (rs.some((r) => !["done", "cancelled", "expired"].includes(r!.status))) throw new Error("Stop it first; only stopped or finished bots can be removed.");
      for (const r of rs) r!.archived = true;
      return rs.length;
    });
  }

  /** Owner actions. Turning a rule on resets the trailing high and failure count. */
  async setStatus(id: string, status: "active" | "paused" | "cancelled"): Promise<Rule> {
    return this.mutate((rules) => {
      const r = rules.find((x) => x.id === id);
      if (!r) throw new Error(`No rule ${id}.`);
      if (["done", "cancelled", "expired"].includes(r.status)) throw new Error(`Rule ${id} is ${r.status}; make a new one instead.`);
      r.status = status;
      if (status === "active") retire(rules, r);
      if (status === "active") {
        r.activated_at = new Date().toISOString();
        r.state.high = undefined; r.state.failures = 0; r.state.last_error = undefined;
        if (r.kind !== "dca") r.state.next_run = undefined;
        else if (!r.state.next_run || Date.parse(r.state.next_run) < Date.now()) r.state.next_run = new Date().toISOString();
      }
      return { ...r };
    });
  }
}
