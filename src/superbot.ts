/**
 * Autopilot (0.9.0; the module keeps its working name "superbot"; the rules engine and its tab are now "Bots"): strategies that change with the market, inside limits only the owner can set.
 *
 * Every `rethink_minutes` (30 by default) while the wallet is open, the bot:
 *   1. reads Tollkit's shared signal snapshot (free; GET <proxy>/signals: prices, funding, Fear & Greed,
 *      news moods, Farcaster chatter when Tollkit has a key);
 *   2. measures every strategy it runs (the wallet's own bot templates: dca, dip, protect, trail, ladder,
 *      grid) from its rules' fills, on paper and live;
 *   3. promotes or demotes on its own rule: a paper strategy that beat holding USDC after fees for
 *      `paper_days` or `paper_trades` goes live; a live one that is losing goes back to paper;
 *   4. if the snapshot says something moved since the last decision (or an hour passed), pays Tollkit's
 *      server $0.005 for ONE strategist decision (Claude, src/superbot-step.ts there) and applies only the
 *      actions that fit the owner's limits: adjust a strategy's settings, pause, resume, retire, or propose
 *      one new strategy, which always starts on paper;
 *   5. writes every decision, with its reasons and sources, to a log the owner can read.
 *
 * Paper strategies trade through the wallet's PaperBook (pretend fills at live quotes, fees included), live
 * ones through the normal swap path, so the owner's per-trade and daily limits, approvals, the 0.5% fee and
 * receipts all apply. On top of those the bot keeps its own: a total budget, a per-trade cap, a cap per token,
 * daily and weekly loss stops that halt everything, and a kill switch that cancels every rule.
 *
 * "Keep running when closed": live strategies on Base in ETH can be handed to Tollkit's Always On (its
 * on-chain permission slips; src/alwayson.ts). Everything else pauses when the wallet closes and resumes
 * when it opens. The strategist's decision is advice to a program: nothing it says is applied without
 * passing the same checks the owner's own forms pass.
 */
import { clashWithOwner } from "./conflict.js";
import { isAutopilotRule } from "./ownership.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { type Chain, CHAINS, isEvmChain, type EvmChain, chainName } from "./chains.js";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";
import { buildBot, summarize, TEMPLATES, type BotSummary } from "./bots.js";
import { serverRunnable } from "./alwayson.js";
import { solRunnable } from "./alwayson-sol.js";
import { describeRule, type Rule, type RuleStore } from "./rules.js";
import type { TollkitWallet } from "./wallet.js";
import { SUPERBOT_SYSTEM, DECIDE_TOOL, checkDecision, strategistUser } from "./strategist.js";
import { marketState, type MarketState } from "./botlogic.js";

export const SUPERBOT = {
  file: "superbot.json",
  /** 0.9.8: a strategy that passed waits this many days for Go live, then it's dismissed. */
  readyDays: 3,
  stepPath: "/superbot/step",
  signalsPath: "/signals",
  snapRetryMs: 2 * 60_000,
  stepPriceUsd: 0.005,
  keepDecisions: 500,
  keepReports: 30,
  /** Without a "moved" snapshot, a decision is still taken this often. */
  forceStepMinutes: 60,
  rethink: [15, 30, 60] as const,
  /** 0.9.7 Active pace: a strategy with no trade for this long is tightened by a plain rule. */
  idleHours: 24,
  maxContextChars: 20_000,
};

export type Stage = "paper" | "live" | "retired";
export interface SuperbotSettings {
  chains: Chain[];
  /** Tokens the bot may trade, as the Bots screen passes them (a symbol for core tokens, else an address). */
  tokens: { chain: Chain; token: string }[];
  sources: { news: boolean; farcaster: boolean; x: boolean };
  budget_usd: number;
  per_trade_usd: number;
  max_token_pct: number;
  daily_loss_pct: number;
  weekly_loss_pct: number;
  slippage_bps: number;
  paper_days: number;
  paper_trades: number;
  rethink_minutes: (typeof SUPERBOT.rethink)[number];
  max_strategies: number;
  always_on: boolean;
  /** 0.9.1: the most of the wallet's daily trading limit Autopilot's live trades may use (%); the rest stays for your own rules. */
  daily_share_pct: number;
  /** 0.9.6: "active" asks the strategist for more, smaller trades (still on paper first, inside every limit).
   *  0.9.12 "adaptive": each coin's market picks the pace (see MarketState): quiet → max, normal → active, rising →
   *  wider targets and no tightening, falling → no new buys on that coin and its grid and dip buys wait. */
  pace: "steady" | "active" | "max" | "adaptive";
  /** 0.9.10: Think 24/7: while no device is checking, Autopilot keeps deciding on TOLLkit's server (Solana, paid from the
   *  prepaid AI balance). Active mode: a strategy that passed its paper trial goes live by itself, inside the budget. */
  think_24_7: boolean; active_mode: boolean;
  /** 0.9.13: when no device is checking, may TOLLkit's server pause Autopilot's rules after a big move (8% drop, or half
   *  of a 4% rise given back)? Off by default: rules keep running; the daily and weekly loss stops still apply. */
  away_pause: boolean;
  /** 0.9.13: the owner's standing instructions, kept from the AI chat ("be careful this week", "no meme coins").
   *  Autopilot's strategist reads them before every decision; they never widen a limit. */
  notes?: string[];
  /** Nov 5: Big moves. When a coin jumps or drops 8% or more in 24 hours: Autopilot's holdings get a trailing stop on
   *  share_pct of what they hold (trail_pct below the high), buys wait while it falls (and DCA buys while it spikes),
   *  a grid that broke out above its range follows the price within the hour, and the owner gets an alert. `own`:
   *  the owner's own grid bots wait to buy while their coin falls too. */
  moves?: { on: boolean; own: boolean; share_pct: number; trail_pct: number };
}
export const MOVES = { bigPct: 8, followMs: 3600_000, alertMs: 24 * 3600_000 } as const;
export const DEFAULT_MOVES = { on: true, own: true, share_pct: 50, trail_pct: 3 };
/** 0.9.13: a strategy is rebuilt with new settings at most this often, so its bot isn't swapped out every check. */
export const REBUILD_MS = 12 * 3600_000;
export const DEFAULT_SETTINGS: SuperbotSettings = {
  chains: ["base", "solana"], tokens: [{ chain: "base", token: "ETH" }, { chain: "solana", token: "SOL" }],
  sources: { news: true, farcaster: true, x: false },
  budget_usd: 100, per_trade_usd: 20, max_token_pct: 25, daily_loss_pct: 5, weekly_loss_pct: 15, slippage_bps: 100,
  paper_days: 7, paper_trades: 20, rethink_minutes: 30, max_strategies: 4, always_on: false, daily_share_pct: 50, pace: "adaptive",
  think_24_7: false, active_mode: false, away_pause: false, moves: { ...DEFAULT_MOVES },
};

export interface Strategy {
  id: string; name: string; template: string; chain: Chain; token: string; params: Record<string, unknown>;
  stage: Stage; bot: string | null; created_at: string; stage_since: string;
  history: { ts: string; note: string }[];
  /** 0.33.0: a meme coin from "Trending on X": tested on paper only; it never moves to live money unless the owner
   * adds the coin on Home. */
  paper_only?: boolean; symbol?: string;
  /** Results of the stage before this one, kept when a strategy moves between paper and live. */
  past?: { stage: Stage; result_pct: number | null; trades: number }[];
  /** 0.9.7: when Active pace last tightened it for sitting idle. */
  tightened_at?: string;
  /** 0.9.12: the bot whose take-profit Adaptive pace already raised while its coin was rising. */
  widened_bot?: string;
  /** 0.9.10: its bots from earlier in this stage. An AI tweak rebuilds the rules but keeps the clock and the results. */
  prev_bots?: string[];
  /** 0.9.13: every bot this strategy ran before its current one (any stage), so a leftover copy can be found and
   *  stopped, and the Bots list shows one bot per strategy. */
  old_bots?: string[];
  /** 0.9.13: when Autopilot last rebuilt it with new settings (an AI tweak, tightening, a resize). At most once in REBUILD_MS. */
  rebuilt_at?: string;
  /** 0.9.9: the owner stopped it (never rebuilt), paused its bot (Autopilot leaves it alone), or removed it from the list. */
  stopped_by_owner?: boolean; owner_paused?: boolean; /** Nov 7: the owner asked for it with their own settings: Autopilot doesn't resize, adjust or retire it. */ owner_set?: boolean; /** Nov 7 (Joe: "trade $100 of SOL and scale from there"): how the trade size moves. fixed: always the start
   * amount; compound: the start plus everything it has made (or less what it lost); step_up: 25% bigger after each
   * win, back to the start after a loss. A one-shot bot (a dip) is re-armed after each sale. */ sizing?: Sizing; sizing_base?: number; sizing_seen?: number; /** Nov 7: when it stopped for lack of cash. */ sizing_wait?: string; removed?: boolean;
  /** 0.9.8: passed its paper trial (beat holding USDC) and waits for the owner to tap Go live. Nothing moves to real
   * money on its own. */
  ready?: { at: string; result_pct: number; trades: number } | null;
  /** Nov 5: Big moves: the trailing stop it added for the current big move, and when a broken-out grid last followed. */
  guard?: { rule: string; kind: "rising" | "falling"; at: string } | null;
  followed_at?: string;
}
/** Nov 5: a big move on one coin, for the alert on Home (key chain:token). */
export interface MoveAlert { chain: Chain; token: string; kind: "rising" | "falling"; d1: number; at: string; did: string[]; seen?: boolean }
export interface AppliedAction { type: string; strategy_id?: string; template?: string; chain?: string; token?: string; params?: Record<string, unknown>; reason: string; sources: string[]; applied: boolean; outcome: string }
export interface Decision { ts: string; snapshot_id: string | null; market_view: string; assessment: string; confidence: number; model: string | null; cost_usd: number; actions: AppliedAction[]; by: "strategist" | "rule" | "away" | "server" }
export interface Report { date: string; text: string; live_result_usd: number | null; trades: number; decisions: number }
interface State {
  enabled: boolean; since: string | null; settings: SuperbotSettings; strategies: Strategy[]; decisions: Decision[]; reports: Report[];
  paper_rules: string[];
  moves_seen?: Record<string, MoveAlert>;
  halted: { reason: string; at: string; until: string | null } | null;
  marks: { day: string; day_start: number; week: string; week_start: number } | null;
  /** Nov 8 (money audit): what strategies made or lost live before they left live (retired, back to paper), so the live
   * total and the loss stops don't jump when one leaves. */
  live_banked?: { result: number; earned: number };
  /** 0.9.8: Trending on X coins the owner hid (lowercased addresses): not shown, never paper-tested. */
  x_hidden?: string[];
  /** 0.9.11: strategies made before balance sizing were resized (1 when done). */
  sized?: number;
  /** 0.9.12: Max pace moved to Adaptive once (Joe chose it for his wallet). */
  adaptive_moved?: number;
  /** 0.9.9: the owner tapped Not now on the Range bot idea; it stays hidden until then. */
  range_idea_until?: string;
  /** 0.9.10: the server's decisions already copied into the log. */
  server_seen?: string[];
  stats: { cycles: number; steps: number; step_usd: number; last_cycle: string | null; last_step: string | null; last_snapshot: string | null; last_error: string | null; last_report: string | null; snap_fails?: number };
}

export interface SuperBotDeps {
  dir?: string; proxy: string; fetch?: typeof fetch; now?: () => number;
  /** Today's price for a token the bot may trade (the dashboard's feed, then a quote). */
  price: (chain: Chain, token: string) => Promise<number | undefined>;
  /** 0.9.13: the dashboard's latest price, right now (for results of strategies that run on TOLLkit's server). */
  livePrice?: (chain: Chain, token: string) => number | undefined;
  /** True for tokens the owner's wallet already knows (core tokens, or added on Home after the scam check). */
  knownToken: (chain: Chain, token: string) => Promise<boolean>;
  onRulesChanged?: () => void;
  /** 0.9.7: false while another device runs the bots (Sync my devices): no cycles here. */
  active?: () => boolean;
  notify?: (text: string) => Promise<void>;
  /**
   * 0.9.5, the phone app: decide with the owner's own AI key instead of paying Tollkit's server per decision.
   * `label` names the model (null until a key is added); `run` makes one forced `decide` call (app/own-ai.ts).
   */
  decide?: { label(): string | null; run(system: string, user: string, tool: typeof DECIDE_TOOL): Promise<{ input: unknown; model: string }>;
    /** 0.9.11: the owner's key and Autopilot model, for Think 24/7 on TOLLkit's server (billed to the owner, not TOLLkit). */
    serverKey?(): { provider: string; model: string; key: string } | null };
  /** 0.9.10: what TOLLkit's server reported about Think 24/7 at the last sync (its balance, whether it's thinking). */
  serverBrain?: () => unknown;
  /** 0.9.11: dollar stablecoins (USDC, USDT) this wallet holds on a network, for sizing strategies. */
  stableUsd?: (chain: Chain) => Promise<number | undefined>;
  /** 0.9.12: hourly closes for a token, oldest first (Adaptive pace reads each coin's market from them). */
  closes?: (chain: Chain, token: string) => Promise<number[]>;
}

const nowIso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => nowIso(ms).slice(0, 10);
const weekOf = (ms: number) => { const d = new Date(ms); const m = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - m); return d.toISOString().slice(0, 10); };
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, def: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

/** Checked settings from a form or an API body. Throws a plain reason. */
export function parseSettings(b: Record<string, unknown>, base: SuperbotSettings = DEFAULT_SETTINGS): SuperbotSettings {
  const s: SuperbotSettings = { ...base, sources: { ...base.sources }, tokens: [...base.tokens], chains: [...base.chains] };
  if (b.chains !== undefined) { if (!Array.isArray(b.chains) || !b.chains.length || !b.chains.every((c) => CHAINS.includes(c))) throw new Error("Pick at least one network."); s.chains = [...new Set(b.chains as Chain[])]; }
  if (b.tokens !== undefined) {
    if (!Array.isArray(b.tokens) || !b.tokens.length || b.tokens.length > 12) throw new Error("Pick 1 to 12 tokens.");
    s.tokens = (b.tokens as any[]).map((t) => { if (!t || !CHAINS.includes(t.chain) || typeof t.token !== "string" || !t.token.trim()) throw new Error("Each token needs a network and a name."); return { chain: t.chain as Chain, token: t.token.trim() }; });
  }
  if (b.sources && typeof b.sources === "object") { const o = b.sources as any; s.sources = { news: o.news !== false, farcaster: !!o.farcaster, x: !!o.x }; }
  if (b.budget_usd !== undefined) s.budget_usd = num(b.budget_usd, 100, 10, 100_000);
  if (b.per_trade_usd !== undefined) s.per_trade_usd = num(b.per_trade_usd, 20, 1, 10_000);
  if (b.max_token_pct !== undefined) s.max_token_pct = num(b.max_token_pct, 25, 5, 100);
  if (b.daily_share_pct !== undefined) s.daily_share_pct = num(b.daily_share_pct, 50, 10, 100);
  if (b.daily_loss_pct !== undefined) s.daily_loss_pct = num(b.daily_loss_pct, 5, 1, 50);
  if (b.weekly_loss_pct !== undefined) s.weekly_loss_pct = num(b.weekly_loss_pct, 15, 1, 90);
  if (b.slippage_bps !== undefined) s.slippage_bps = num(b.slippage_bps, 100, 10, 500);
  if (b.paper_days !== undefined) s.paper_days = num(b.paper_days, 7, 1, 60);
  if (b.paper_trades !== undefined) s.paper_trades = num(b.paper_trades, 20, 1, 500);
  if (b.rethink_minutes !== undefined) { const m = Number(b.rethink_minutes); if (!(SUPERBOT.rethink as readonly number[]).includes(m)) throw new Error("Rethink every 15, 30 or 60 minutes."); s.rethink_minutes = m as 15 | 30 | 60; }
  if (b.max_strategies !== undefined) s.max_strategies = num(b.max_strategies, 4, 1, 10);
  if (b.always_on !== undefined) s.always_on = !!b.always_on;
  if (b.think_24_7 !== undefined) s.think_24_7 = !!b.think_24_7;
  // 0.9.12: one Run 24/7 switch: turning it on or off turns deciding while away (Think 24/7) on or off with it.
  else if (b.always_on !== undefined) s.think_24_7 = !!b.always_on;
  if (b.active_mode !== undefined) s.active_mode = !!b.active_mode;
  if (b.away_pause !== undefined) s.away_pause = !!b.away_pause;
  if (b.notes !== undefined) { if (!Array.isArray(b.notes)) throw new Error("Notes are a list."); s.notes = b.notes.map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 8); }
  if (b.moves !== undefined) {
    const m = (b.moves && typeof b.moves === "object" ? b.moves : {}) as any, cur = { ...DEFAULT_MOVES, ...(base.moves ?? {}) };
    s.moves = { on: m.on === undefined ? cur.on : !!m.on, own: m.own === undefined ? cur.own : !!m.own,
      share_pct: m.share_pct === undefined ? cur.share_pct : [25, 50, 75, 100].includes(Number(m.share_pct)) ? Number(m.share_pct) : (() => { throw new Error("Protect 25, 50, 75 or 100%."); })(),
      trail_pct: m.trail_pct === undefined ? cur.trail_pct : [2, 3, 5, 8].includes(Number(m.trail_pct)) ? Number(m.trail_pct) : (() => { throw new Error("Trail 2, 3, 5 or 8%."); })() };
  }
  if (b.pace !== undefined) { if (b.pace !== "steady" && b.pace !== "active" && b.pace !== "max" && b.pace !== "adaptive") throw new Error("Pace is steady, active, max or adaptive."); s.pace = b.pace; }
  if (s.per_trade_usd > s.budget_usd) throw new Error("The per-trade cap can't be more than the budget.");
  if (s.tokens.some((t) => !s.chains.includes(t.chain))) throw new Error("Every token's network must be turned on.");
  return s;
}

/** Dollars a strategy can put into buys over its life (sells don't count). Exported for tests. */
/**
 * 0.9.7 Active pace: an idle strategy's tighter settings, still wide enough to profit after Tollkit's fee (0.25% a
 * side on grids, 0.5% on the rest). Null: nothing left to tighten. A grid is also rebuilt around today's price.
 */
export function tightened(template: string, p: Record<string, unknown>): Record<string, unknown> | null {
  const n = (k: string) => Number(p[k]), at = (v: number, min: number) => +Math.max(min, v).toFixed(2);
  switch (template) {
    case "dip": { const d = at(n("drop_pct") * 0.6, 1.5), g = at(n("profit_pct") * 0.8, 1.5); return d < n("drop_pct") || g < n("profit_pct") ? { ...p, drop_pct: d, profit_pct: g } : null; }
    case "grid": { const lv = n("levels"), r = at(n("range_pct") * 0.7, Math.max(1, (0.75 * (lv - 1)) / 2)); return { ...p, range_pct: Math.min(r, n("range_pct")) }; }
    case "smart_dca": { const st = at(n("step_pct") * 0.7, 1.5), g = at(n("profit_pct") * 0.8, 1.5); return st < n("step_pct") || g < n("profit_pct") ? { ...p, step_pct: st, profit_pct: g } : null; }
    case "infinity_grid": { const st = at(n("step_pct") * 0.7, 1); return st < n("step_pct") ? { ...p, step_pct: st } : null; }
    case "rebalance": { const b = at(n("band_pct") * 0.7, 2); return b < n("band_pct") ? { ...p, band_pct: b } : null; }
    default: return null;
  }
}
/**
 * 0.9.12 Adaptive pace, coin rising: an idle strategy that holds nothing is rebuilt wider so it rides the move
 * instead of selling a step up: a grid's range × 1.5, a dip or Smart DCA's profit target at least 4% (up to 8%).
 * Null: nothing to widen.
 */
export function widened(template: string, p: Record<string, unknown>): Record<string, unknown> | null {
  const n = (k: string) => Number(p[k]), up = (v: number) => +Math.min(8, Math.max(4, v * 1.6)).toFixed(2);
  switch (template) {
    case "grid": { const r = +Math.min(90, n("range_pct") * 1.5).toFixed(2); return r > n("range_pct") ? { ...p, range_pct: r } : null; }
    case "dip": case "smart_dca": { const g = up(n("profit_pct")); return g > n("profit_pct") ? { ...p, profit_pct: g } : null; }
    default: return null;
  }
}
/** 0.9.12: a dip's take-profit price after Adaptive pace raises its target from `from`% to `to`% over cost. */
export const raisedTarget = (trigger: number, from: number, to: number) => +(trigger * (1 + to / 100) / (1 + from / 100)).toFixed(6);
function describeChange(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const label: Record<string, string> = { drop_pct: "dip", profit_pct: "profit", range_pct: "range ±", step_pct: "step", band_pct: "band" };
  const parts = Object.keys(label).filter((k) => a[k] !== undefined && b[k] !== undefined && Number(a[k]) !== Number(b[k])).map((k) => `${label[k]} ${a[k]}% → ${b[k]}%`);
  return parts.length ? parts.join(", ") : "its settings";
}

/**
 * Nov 10 (Joe: "it seems very hesitant"): Autopilot's RSI dip buys fire at 38 or above, not the textbook 30, which
 * the hourly chart rarely reaches. Buys only; the owner's own settings are left alone.
 */
export const EAGER_RSI = 38;
export function eagerRsi(template: string, p: Record<string, unknown>): Record<string, unknown> {
  if (template !== "signal" || p.side === "sell" || (p.signal ?? "rsi_below") !== "rsi_below") return p;
  const lv = Number(p.level) || 0;
  return lv >= EAGER_RSI && lv <= 45 ? p : { ...p, level: lv > 45 ? 45 : EAGER_RSI };
}
/** Nov 10 (audit): a strategy that bought and is waiting to sell; rebuilding it would cancel its sells. */
export function holdsToSell(st: { template: string; params: Record<string, unknown> }, sum: { units_held: number } | null | undefined): boolean {
  const neverSells = st.template === "dca" || (st.template === "signal" && st.params.side !== "sell");
  return !neverSells && (sum?.units_held ?? 0) > 1e-9;
}
/** Nov 10: how many strategies of one kind may run on one coin (with different settings). */
export const MAX_TWINS = 2;
/** Nov 10: two strategies' settings are the same when every number but the dollar size is within 15% (or 0.3) of the other's. */
export function sameSetup(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "amount_usd") continue;
    const x = a[k], y = b[k];
    if (typeof x === "number" && typeof y === "number") { if (Math.abs(x - y) > Math.max(0.3, 0.15 * Math.max(Math.abs(x), Math.abs(y)))) return false; }
    else if (x !== undefined && y !== undefined && x !== y) return false;
  }
  return true;
}
export function committedUsd(template: string, params: Record<string, unknown>): number {
  const a = Number(params.amount_usd) || 0;
  switch (template) {
    case "dca": { const t = Number(params.times) || 0; return a * (t > 0 ? t : 10); }
    case "dip": return a;
    case "grid": return a * Math.max(1, (Number(params.levels) || 2) - 1);
    // 0.9.3: Smart DCA's first buy plus every extra one; a rebalancer's pot; an infinity grid's amount plus a buy-back.
    case "smart_dca": { const k = Number(params.scale) || 1, n = Math.max(0, Number(params.safety) || 0); let t = 0; for (let i = 0; i <= n; i++) t += a * k ** i; return t; }
    case "rebalance": return a;
    case "infinity_grid": return a * 1.5;
    // 0.9.9: a signal buy commits its amount each time it may fire; a signal sell spends nothing.
    case "signal": return params.side === "sell" ? 0 : a * Math.max(1, Number(params.times) || 1);
    default: return 0;
  }
}

/**
 * 0.9.11 (Joe: "it should be based on the size of the balance"): the wallet, not the AI, sets each strategy's dollar
 * size. Every strategy gets an equal share: the smaller of the budget and the dollars held on that network, divided
 * by the maximum number of strategies. The amount is then spread the way each template spends it (a grid over its
 * levels, a steady buyer over its buys), so committedUsd() comes out at the share. Per-trade cap still applies after.
 */
export type Sizing = "fixed" | "compound" | "step_up";
export const SIZINGS: Sizing[] = ["fixed", "compound", "step_up"];
/** The next trade size for a sizing mode. `made`: everything the strategy has made so far (realized), `seen`: at the last resize. */
export function nextSize(mode: Sizing, base: number, cur: number, made: number, seen: number): number {
  const r = (n: number) => Math.floor(n * 100) / 100;
  if (mode === "compound") return r(Math.max(1, base + made));
  if (mode === "step_up") return made > seen + 0.005 ? r(cur * 1.25) : made < seen - 0.005 ? r(base) : r(cur);
  return r(base);
}
/** Nov 10: the money is split over this many live strategies (half the slots; the rest are for practice). */
export function liveSlots(maxStrategies: number): number { return Math.max(1, Math.ceil(maxStrategies / 2)); }
export function shareUsd(budget: number, stable: number | undefined, maxStrategies: number,
  others?: { committed: number; live_committed: number; count: number }): number {
  const cash = stable !== undefined && Number.isFinite(stable) && stable >= 0 ? stable : budget;
  // Nov 7 (Joe: "it just doesn't want to trade anything other than measly trades"): the money still free, not the whole
  // balance, shared over the slots still open, not all of them. Before, $116 of USDC over 5 slots was $23 a strategy
  // even with 4 slots taken and most of the cash idle. Free budget: the budget less what the other strategies are
  // sized at; free cash: the USDC less what the other live ones may still spend (paper ones spend none).
  if (others) {
    const base = Math.max(0, Math.min(budget - others.committed, cash - others.live_committed));
    return Math.floor((base / Math.max(1, maxStrategies - others.count)) * 100) / 100;
  }
  return Math.floor((Math.min(budget, cash) / Math.max(1, maxStrategies)) * 100) / 100;
}
export function sizeToShare(template: string, params: Record<string, unknown>, share: number): Record<string, unknown> {
  if (!(share > 0) || params.amount_usd === undefined) return params;
  const k = Number(params.scale) || 1, n = Math.max(0, Number(params.safety) || 0);
  let per: number;
  switch (template) {
    case "grid": per = share / Math.max(1, (Number(params.levels) || 2) - 1); break;
    case "dca": { const t = Number(params.times) || 0; per = share / (t > 0 ? t : 10); break; }
    case "signal": if (params.side === "sell") return params; per = share / Math.max(1, Number(params.times) || 1); break;
    case "smart_dca": { let t = 0; for (let i = 0; i <= n; i++) t += k ** i; per = share / t; break; }
    case "infinity_grid": per = share / 1.5; break;
    case "dip": case "rebalance": per = share; break;
    default: return params;
  }
  return { ...params, amount_usd: Math.floor(per * 100) / 100 };
}

/**
 * 0.9.13: everything Autopilot is doing, read-only, for the AI chat (autopilot_status): whether it's on, its
 * settings and limits, each strategy with its stage, settings, results and money earned, its recent decisions with
 * their reasons and outcomes, and its daily reports. The chat explains Autopilot; it never changes it.
 */
/**
 * Nov 5: Autopilot's full decision log for the AI chat, newest first, with everything each decision did: the
 * strategist's view and confidence, the model and its cost, and each action's template, coin, settings, sources and
 * outcome. Filters: a strategy, a coin, only what was applied, and paging back with `before` (an ISO time).
 */
export function autopilotLog(w: { dir: string }, o: { limit?: number; before?: string; strategy?: string; token?: string; applied_only?: boolean; by?: "strategist" | "rule" } = {}) {
  let s: Partial<State> | null = null;
  try { const f = path.join(walletHome(w.dir), SUPERBOT.file); if (existsSync(f)) s = JSON.parse(readFileSync(f, "utf8")); } catch { s = null; }
  if (!s) return { on: false, note: "Autopilot hasn't been turned on in this wallet.", decisions: [] };
  const names = new Map((s.strategies ?? []).map((x) => [x.id, x.name] as const));
  const tok = o.token?.toLowerCase();
  let ds = (s.decisions ?? []).slice().sort((a, b) => b.ts.localeCompare(a.ts));
  const total = ds.length;
  if (o.before) ds = ds.filter((d) => d.ts < o.before!);
  if (o.by) ds = ds.filter((d) => d.by === o.by);
  if (o.strategy) ds = ds.filter((d) => (d.actions ?? []).some((a) => a.strategy_id === o.strategy || (a.strategy_id && names.get(a.strategy_id)?.toLowerCase().includes(o.strategy!.toLowerCase()))));
  if (tok) ds = ds.filter((d) => (d.actions ?? []).some((a) => a.token?.toLowerCase() === tok) || d.assessment.toLowerCase().includes(tok));
  if (o.applied_only) ds = ds.filter((d) => (d.actions ?? []).some((a) => a.applied));
  const limit = Math.min(200, Math.max(1, o.limit ?? 50)), page = ds.slice(0, limit);
  return {
    kept: total, oldest: (s.decisions ?? []).reduce((m, d) => (!m || d.ts < m ? d.ts : m), "" as string) || null, matching: ds.length, returned: page.length,
    next_before: ds.length > limit ? page.at(-1)!.ts : null,
    decisions: page.map((d) => ({ ts: d.ts, by: d.by, market_view: d.market_view, assessment: d.assessment, confidence: d.confidence, model: d.model, cost_usd: d.cost_usd,
      actions: (d.actions ?? []).map((a) => ({ type: a.type, ...(a.strategy_id ? { strategy_id: a.strategy_id, strategy: names.get(a.strategy_id) ?? null } : {}), ...(a.template ? { template: a.template } : {}), ...(a.chain ? { chain: a.chain } : {}), ...(a.token ? { token: a.token } : {}), ...(a.params ? { params: a.params } : {}), reason: a.reason, sources: a.sources, applied: a.applied, outcome: a.outcome })) })),
  };
}
export function autopilotReport(w: { dir: string; rules(): { list(): Rule[] } }, o: { decisions?: number } = {}) {
  let s: Partial<State> | null = null;
  try { const f = path.join(walletHome(w.dir), SUPERBOT.file); if (existsSync(f)) s = JSON.parse(readFileSync(f, "utf8")); } catch { s = null; }
  if (!s) return { on: false, note: "Autopilot hasn't been turned on in this wallet." };
  const st = { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) }, all = w.rules().list();
  const strategies = (s.strategies ?? []).filter((x) => !x.removed).map((x) => {
    const ids = new Set([x.bot, ...(x.prev_bots ?? [])].filter(Boolean) as string[]);
    const sum = summarize(all.filter((r) => r.bot && ids.has(r.bot) && !r.archived).map((r) => (r.bot === x.bot ? r : { ...r, bot: x.bot! })), (w as any).hooks?.livePrice)[0] ?? null;
    const rules = all.filter((r) => r.bot === x.bot && !r.archived).map((r) => ({ id: r.id, status: r.status, description: describeRule(r), ...(r.state.last_error ? { last_error: r.state.last_error } : {}) }));
    return { id: x.id, name: x.name, template: x.template, chain: x.chain, token: x.token, stage: x.stage, since: x.stage_since, params: x.params, money: x.stage === "live" ? "real" : x.stage === "paper" ? "practice" : "none",
      status: sum?.status ?? null, trades: sum?.trades_ok ?? 0, failed: sum?.trades_failed ?? 0, earned_usd: sum?.earned_usd ?? 0, result_usd: sum?.result_usd ?? null, result_pct: sum?.result_pct ?? null, last_trade: sum?.last_trade ?? null,
      ...(x.ready ? { passed_paper: x.ready } : {}), ...(x.owner_paused ? { paused_by_owner: true } : {}), ...(x.stopped_by_owner ? { stopped_by_owner: true } : {}),
      recent: (x.history ?? []).slice(-4).map((h) => `${h.ts.slice(0, 16)} ${h.note}`), rules };
  });
  const live = strategies.filter((x) => x.stage === "live");
  return {
    on: !!s.enabled, since: s.since ?? null, halted: s.halted ?? null, notes: st.notes ?? [],
    big_moves: { ...DEFAULT_MOVES, ...(st.moves ?? {}), alerts: Object.entries(s.moves_seen ?? {}).map(([key, a]) => ({ key, ...a })).slice(-8) },
    decisions_kept: (s.decisions ?? []).length,
    settings: { budget_usd: st.budget_usd, per_trade_usd: st.per_trade_usd, max_strategies: st.max_strategies, max_token_pct: st.max_token_pct, daily_loss_pct: st.daily_loss_pct, weekly_loss_pct: st.weekly_loss_pct,
      pace: st.pace, active_mode: st.active_mode, run_24_7: st.always_on, think_24_7: st.think_24_7, rethink_minutes: st.rethink_minutes, chains: st.chains, tokens: st.tokens, sources: st.sources, paper_days: st.paper_days, paper_trades: st.paper_trades },
    totals: { live: live.length, practice: strategies.filter((x) => x.stage === "paper").length, earned_live_usd: Math.round(live.reduce((a, x) => a + (x.earned_usd ?? 0), 0) * 100) / 100, result_live_usd: Math.round(live.reduce((a, x) => a + (x.result_usd ?? 0), 0) * 100) / 100 },
    strategies: strategies.filter((x) => x.stage !== "retired"),
    retired: strategies.filter((x) => x.stage === "retired").slice(-8).map((x) => ({ name: x.name, token: x.token, why: x.recent.at(-1) ?? null, earned_usd: x.earned_usd, result_usd: x.result_usd })),
    last_check: s.stats?.last_cycle ?? null,
    decisions: (s.decisions ?? []).slice().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, o.decisions ?? 15).map((d) => ({ ts: d.ts, by: d.by, view: d.market_view, assessment: d.assessment,
      actions: (d.actions ?? []).map((a) => ({ type: a.type, ...(a.strategy_id ? { strategy: a.strategy_id } : {}), reason: a.reason, applied: a.applied, outcome: a.outcome })) })),
    reports: (s.reports ?? []).slice(-3).reverse(),
  };
}

/**
 * 0.9.11: the size the AI tab uses when the owner names no amount: Autopilot's equal share per network (shareUsd with
 * the owner's Autopilot budget and maximum strategies, or the defaults), capped at the per-trade limit.
 */
export async function suggestedSizes(w: { dir: string; balances(): Promise<Record<string, { token: string; amount: string }[] | { error: string }>> }): Promise<Record<string, number>> {
  let st: SuperbotSettings = DEFAULT_SETTINGS;
  try { const f = path.join(walletHome(w.dir), SUPERBOT.file); if (existsSync(f)) st = { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(f, "utf8")).settings ?? {}) }; } catch { /* defaults */ }
  const out: Record<string, number> = {};
  for (const [chain, rows] of Object.entries(await w.balances())) {
    if (!Array.isArray(rows)) continue;
    const stable = rows.filter((x) => /^(USDC|USDT|USDC\.e)$/i.test(x.token)).reduce((t, x) => t + (Number(x.amount) || 0), 0);
    out[chain] = Math.min(st.per_trade_usd, shareUsd(st.budget_usd, stable, liveSlots(st.max_strategies)));
  }
  return out;
}

/** Same fingerprint as TOLLkit's server (x402-starter src/key-vault.ts keyFp). */
export const brainKeyFp = (key: string) => createHash("sha256").update(`tollkit-brain-key:${key}`).digest("hex").slice(0, 16);

export class SuperBot {
  readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly w: TollkitWallet, private readonly d: SuperBotDeps) {
    this.file = path.join(walletHome(d.dir), SUPERBOT.file);
  }
  private now() { return this.d.now?.() ?? Date.now(); }
  /** 0.9.12: each allowed coin's market ("chain:token" → state), read at every cycle while the pace is Adaptive. */
  private market: Record<string, { state: MarketState; d1: number; d3: number; at: string }> = {};
  private adaptive(s: State = this.load()) { return s.settings.pace === "adaptive"; }
  /** A coin's market under Adaptive pace; null when the pace isn't Adaptive or its history couldn't be read. */
  marketOf(chain: Chain, token: string): MarketState | null {
    if (!this.adaptive()) return null;
    return this.market[`${chain}:${token.toLowerCase()}`]?.state ?? null;
  }
  private mv(s: State = this.load()) { return { ...DEFAULT_MOVES, ...(s.settings.moves ?? {}) }; }
  /** Nov 5: the coins whose market Autopilot reads: its own, plus the owner's running bots' coins under Big moves. */
  private watched(s: State) {
    const out = [...s.settings.tokens], seen = new Set(out.map((x) => `${x.chain}:${x.token.toLowerCase()}`)), m = this.mv(s);
    if (m.on && m.own) for (const r of this.w.rules().list()) {
      if (r.by === "superbot" || r.status !== "active" || !["grid", "infinity_grid", "smart_dca"].includes(r.kind)) continue;
      const k = `${r.chain}:${r.token.toLowerCase()}`; if (seen.has(k) || out.length >= 16) continue; seen.add(k); out.push({ chain: r.chain, token: r.token });
    }
    return out;
  }
  private async readMarket(s: State) {
    if (!this.d.closes) return;
    for (const x of this.watched(s)) {
      const m = marketState(await this.d.closes(x.chain, x.token).catch(() => []));
      const k = `${x.chain}:${x.token.toLowerCase()}`;
      if (m) this.market[k] = { ...m, at: nowIso(this.now()) }; else delete this.market[k];
    }
  }
  /**
   * 0.9.12: why an Autopilot grid or dip buy waits right now (its coin is falling on Adaptive pace), or null. The
   * rules engine asks before every buy; sells and the owner's own rules never wait.
   */
  holdBuy(r: Pick<Rule, "chain" | "token" | "template" | "by" | "kind">): string | null {
    const s = this.load(), mv = this.mv(s), m = this.market[`${r.chain}:${r.token.toLowerCase()}`], coin = r.token.length > 12 ? "This coin" : r.token;
    if (!m) return null;
    if (r.by === "superbot") {
      if ((r.template === "grid" || r.template === "dip") && m.state === "falling" && (this.adaptive(s) || mv.on))
        return `${coin} is falling (${m.d1}% in 24 hours, ${m.d3}% in 3 days): ${this.adaptive(s) ? "Adaptive pace" : "Big moves"} holds grid and dip buys until it steadies.`;
      // Nov 5: easy on buys near the top: a DCA-style buy waits while the coin is up 8% or more in a day.
      if (mv.on && m.d1 >= MOVES.bigPct && (r.template === "dca" || r.template === "smart_dca"))
        return `${coin} jumped ${m.d1}% in 24 hours: Big moves holds new buys near the top until it settles.`;
      return null;
    }
    if (mv.on && mv.own && ["grid", "infinity_grid", "smart_dca"].includes(r.kind) && m.state === "falling")
      return `${coin} is falling (${m.d1}% in 24 hours): Big moves holds your bot's buys until it steadies. Its sells keep going.`;
    return null;
  }

  // ─── state ───────────────────────────────────────────────────────────────
  load(): State {
    if (existsSync(this.file)) { try { const s = JSON.parse(readFileSync(this.file, "utf8")); if (s && s.settings) return { ...this.fresh(), ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } }; } catch { /* fresh */ } }
    return this.fresh();
  }
  private fresh(): State {
    return { enabled: false, since: null, settings: { ...DEFAULT_SETTINGS }, strategies: [], decisions: [], reports: [], paper_rules: [], halted: null, marks: null,
      stats: { cycles: 0, steps: 0, step_usd: 0, last_cycle: null, last_step: null, last_snapshot: null, last_error: null, last_report: null } };
  }
  private save(s: State) { const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(t, this.file); }
  private async update<T>(fn: (s: State) => T): Promise<T> { return withLock(() => { const s = this.load(); const out = fn(s); this.save(s); return out; }, this.d.dir); }

  isPaperRule(id: string) { return this.load().paper_rules.includes(id); }
  /** Nov 10 (audit): holds coins and still has a sell waiting for them (a rebuild or demotion would cancel it). */
  private holds(st: Strategy, all: Rule[]): boolean {
    if (!holdsToSell(st, this.summaryOf(st, all))) return false;
    return this.openRules(this.rulesOf(this.load(), st, all)).some((r) => !["dca", "limit_buy", "signal_buy"].includes(r.kind));
  }
  /** 0.9.1: dollars of live trades Autopilot may make today: its share of the wallet's daily trading limit. */
  dailyCapUsd(walletDailyUsd: number): number | null {
    const s = this.load();
    if (!s.enabled) return null;
    return Math.round(walletDailyUsd * (s.settings.daily_share_pct ?? 50)) / 100;
  }
  private rulesOf(s: State, st: Strategy, all: Rule[]) { return st.bot ? all.filter((r) => r.bot === st.bot && !r.archived) : []; }
  private openRules(rules: Rule[]) { return rules.filter((r) => ["active", "paused", "proposed"].includes(r.status)); }
  /** 0.9.10: a strategy's results count the rules it had earlier in the same stage (before an AI tweak rebuilt it). */
  private summaryOf(st: Strategy, all: Rule[]): BotSummary | null {
    if (!st.bot) return null;
    const ids = new Set([st.bot, ...(st.prev_bots ?? [])]);
    return summarize(all.filter((r) => r.bot && ids.has(r.bot) && !r.archived).map((r) => (r.bot === st.bot ? r : { ...r, bot: st.bot! })), this.d.livePrice)[0] ?? null;
  }

  /** 0.9.13: for the Bots list: older copies of a strategy's bot fold into its current one (same stage) or are hidden. */
  botFold(): { fold: Record<string, string>; hide: Set<string> } {
    const fold: Record<string, string> = {}, hide = new Set<string>(), cur = new Set<string>();
    for (const st of this.load().strategies) {
      if (st.bot) cur.add(st.bot);
      if (st.bot) for (const b of st.prev_bots ?? []) fold[b] = st.bot;
      for (const b of st.old_bots ?? []) if (!fold[b]) hide.add(b);
    }
    for (const b of cur) hide.delete(b);
    return { fold, hide };
  }

  /** What the dashboard shows. */
  view() {
    const s = this.load(), all = this.w.rules().list();
    const strategies = s.strategies.filter((st) => !st.removed).map((st) => { const sum = this.summaryOf(st, all); return { ...st, result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, earned_usd: sum?.earned_usd ?? 0, trades: sum?.trades_ok ?? 0, failed: sum?.trades_failed ?? 0, status: sum?.status ?? (st.stage === "retired" ? "stopped" : "waiting"), last_trade: sum?.last_trade ?? null, days_in_stage: r2((this.now() - Date.parse(st.stage_since)) / 86_400_000) }; });
    const live = strategies.filter((x) => x.stage === "live");
    return {
      enabled: s.enabled, since: s.since, settings: { ...s.settings, moves: this.mv(s) }, halted: s.halted, stats: s.stats,
      moves: Object.entries(s.moves_seen ?? {}).filter(([, a]) => !a.seen && this.now() - Date.parse(a.at) < MOVES.alertMs).map(([key, a]) => ({ key, ...a })),
      // 0.9.12: each coin's market while the pace is Adaptive (the Autopilot screen shows it).
      market: this.adaptive(s) ? s.settings.tokens.map((x) => { const m = this.market[`${x.chain}:${x.token.toLowerCase()}`]; return { chain: x.chain, token: x.token, state: m?.state ?? null, d1: m?.d1 ?? null, d3: m?.d3 ?? null, at: m?.at ?? null }; }) : null,
      strategies, decisions: s.decisions.slice().sort((x, y) => x.ts.localeCompare(y.ts)).slice(-40).reverse(), reports: s.reports.slice(-7).reverse(),
      totals: { live: live.length, paper: strategies.filter((x) => x.stage === "paper").length, retired: strategies.filter((x) => x.stage === "retired").length,
        live_result_usd: r2((s.live_banked?.result ?? 0) + live.reduce((a, x) => a + (x.result_usd ?? 0), 0)), // Nov 8: + what left live
        // 0.9.13: what live strategies have made on what they sold, the Autopilot screen's headline.
        live_earned_usd: r2((s.live_banked?.earned ?? 0) + live.reduce((a, x) => a + (x.earned_usd ?? 0), 0)), paper_earned_usd: r2(strategies.filter((x) => x.stage === "paper").reduce((a, x) => a + (x.earned_usd ?? 0), 0)), committed_usd: r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + committedUsd(x.template, x.params), 0)) },
      next_cycle: s.enabled && s.stats.last_cycle ? nowIso(Date.parse(s.stats.last_cycle) + s.settings.rethink_minutes * 60_000) : null,
      // 0.33.0: X through Grok, from Tollkit's shared snapshot: the mood per coin and the trending memes (paper only).
      x: this.xView(),
      // Nov 7: the market numbers Autopilot reads, for the Market card on Home (from the shared snapshot).
      pulse: (() => { const p = this.lastSnap?.pulse; if (!p) return null; const fg = p.fear_greed;
        return { at: this.lastSnap.at ?? null, fear_greed: fg ? { value: fg.value, label: fg.classification, yesterday: fg.yesterday?.value ?? null } : null,
          majors: (p.majors ?? []).slice(0, 4).map((m: any) => ({ coin: m.coin, d1: m.change_24h_pct, funding: m.funding_hourly_pct })) }; })(),
      range_idea: this.rangeIdea(s, all),
      server: this.d.serverBrain?.() ?? null,
      ...(this.d.decide ? { brain: { own: true, label: this.d.decide.label() } } : {}),
    };
  }

  /**
   * 0.9.9: when Autopilot has nothing to do (its last decisions over 12 hours all read the market as flat and changed
   * nothing, and none of its strategies traded), a Range bot on Orca's SOL/USDC pool is the kind of thing that earns in
   * a flat market. Autopilot only suggests it: the owner opens the form and starts it, and the money is never moved by
   * Autopilot. Not shown while a Range bot is already running or the owner said Not now.
   */
  rangeIdea(s: State = this.load(), all: Rule[] = this.w.rules().list()): { why: string; amount_usd: number; range_pct: number; recenter_min: number } | null {
    const now = this.now(), since = now - 12 * 3600_000;
    if (!s.enabled || s.halted) return null;
    if (!s.settings.tokens.some((t) => t.chain === "solana" && /^SOL$/i.test(t.token))) return null;
    if (s.range_idea_until && Date.parse(s.range_idea_until) > now) return null;
    if (all.some((r) => r.kind === "range" && !r.archived && ["active", "paused", "proposed"].includes(r.status))) return null;
    const recent = s.decisions.filter((d) => Date.parse(d.ts) >= since && d.by === "strategist");
    if (recent.length < 3) return null;
    const flat = recent.every((d) => d.market_view === "neutral" && d.actions.every((a) => a.type === "keep" || !a.applied));
    if (!flat) return null;
    const traded = s.strategies.some((st) => this.rulesOf(s, st, all).some((r) => r.state.fills.some((f) => f.ok && Date.parse(f.ts) >= since)));
    if (traded) return null;
    return { why: `For the last 12 hours Autopilot has read the market as flat and its strategies haven't traded. A Range bot earns a share of Orca's SOL/USDC trading fees while SOL stays in a band, which is when a flat market pays.`,
      amount_usd: 100, range_pct: 5, recenter_min: 30 };
  }
  /**
   * 0.9.9: a Range bot started from Autopilot's idea ends (everything goes back to the wallet) when the reason for it
   * is gone: Autopilot's last 2 decisions read the market as moving, it moved the range 3 times in 24 hours (SOL is
   * trending), or it's down more than 3% of what went in, counting fees earned. Range bots the owner set up on their
   * own are never touched. Ending = cancelling the rule; the device running it takes the money out.
   */
  private async endRangeIdeas() {
    const s = this.load(), now = this.now(), rules = this.w.rules();
    for (const r of rules.list()) {
      if (r.kind !== "range" || r.suggested_by !== "autopilot" || !["active", "paused"].includes(r.status)) continue;
      const g = r.state.range ?? {}, since = Date.parse(r.created_at);
      const views = s.decisions.filter((d) => d.by === "strategist" && Date.parse(d.ts) > since).slice(-2);
      let why: string | null = null;
      if (views.length === 2 && views.every((d) => d.market_view !== "neutral")) why = `the market stopped being flat (Autopilot's last two reads: ${views.map((d) => d.market_view.replace("_", " ")).join(", ")})`;
      const moves = (g.recenter_at ?? []).filter((t) => now - Date.parse(t) <= 86_400_000).length;
      if (!why && moves >= 3) why = `it moved the range ${moves} times in 24 hours, so SOL is trending rather than flat`;
      const p = r.state.last_price;
      const worth = g.mint ? g.value_usd : g.staged && p ? (g.sol ?? 0) * p + (g.usdc ?? 0) : undefined;
      if (!why && g.deposited_usd && worth !== undefined) {
        const res = worth + (g.fees_pending_usd ?? 0) - g.deposited_usd;
        if (res < -0.03 * g.deposited_usd) why = `it was down $${Math.abs(res).toFixed(2)} (${((-res / g.deposited_usd) * 100).toFixed(1)}%) of the $${g.deposited_usd.toFixed(2)} that went in, counting fees`;
      }
      if (!why) continue;
      const text = `Autopilot ended it: ${why}. Everything goes back to your wallet.`;
      await rules.mutate((rs) => { const x = rs.find((y) => y.id === r.id); if (!x) return; x.status = "cancelled"; x.state.note = text;
        const gg = x.state.range ?? {}; x.state.range = { ...gg, log: [...(gg.log ?? []), { ts: nowIso(now), text }].slice(-20) }; });
      await this.log("rule", `Ended the Range bot it suggested: ${why}.`, [{ type: "retire", reason: text, sources: ["Range bot idea"], applied: true, outcome: "ended" }]);
      await this.d.notify?.(`Autopilot ended your Range bot: ${why}. The money goes back to your wallet.`).catch(() => {});
    }
  }

  /** The owner tapped Not now: hide the idea for 3 days. */
  async rangeIdeaLater() {
    await this.update((st) => { st.range_idea_until = nowIso(this.now() + 3 * 86_400_000); });
    return this.view();
  }

  // ─── owner actions ───────────────────────────────────────────────────────
  /** 0.9.12: a network the wallet's own limits turn off says so (it used to read as a failed scam check). */
  private async checkPicks(settings: { chains: Chain[]; tokens: { chain: Chain; token: string }[] }) {
    const on = this.w.policy?.chains;
    for (const c of settings.chains) if (on && !on.includes(c)) throw new Error(`${chainName(c)} is off for this wallet. Turn it on in Settings under Networks, then add it here.`);
    for (const t of settings.tokens) if (!(await this.d.knownToken(t.chain, t.token))) throw new Error(`Add ${t.token} on ${chainName(t.chain)} on Home first (Add a token runs Tollkit's scam check).`);
  }
  async enable(body: Record<string, unknown> = {}) {
    const s = this.load();
    const settings = parseSettings(body, s.settings);
    await this.checkPicks(settings);
    await this.update((st) => { st.settings = settings; st.enabled = true; st.since = st.since ?? nowIso(this.now()); st.halted = null; if (body.pace !== undefined) st.adaptive_moved = 1; });
    await this.log("rule", "Autopilot turned on.", [{ type: "keep", reason: "The owner turned Autopilot on.", sources: [], applied: true, outcome: "on" }]);
    await this.cycle(true);
    return this.view();
  }
  async setSettings(body: Record<string, unknown>) {
    const s = this.load();
    const settings = parseSettings(body, s.settings);
    await this.checkPicks(settings);
    // 0.9.12: picking a pace by hand (or Max again) keeps it: the one-time move to Adaptive is done.
    await this.update((st) => { st.settings = settings; if (body.pace !== undefined) st.adaptive_moved = 1; });
    if (settings.pace === "adaptive") await this.readMarket(this.load()).catch(() => {});
    // 0.9.2: the 24/7 switch applies to strategies already live, both ways, right away.
    if (settings.always_on !== s.settings.always_on && s.enabled) {
      const all = this.w.rules().list(), live = s.strategies.filter((x) => x.stage === "live").flatMap((x) => this.rulesOf(s, x, all)).filter((r) => r.status === "active");
      if (settings.always_on) await this.handToAlwaysOn(live);
      else for (const r of live) if (this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false);
      this.d.onRulesChanged?.();
    }
    return this.view();
  }
  /** The kill switch: every strategy's rules are cancelled, Always On is turned off for them, the bot stops. */
  async disable(reason = "The owner turned Autopilot off.") {
    const s = this.load(), all = this.w.rules().list();
    for (const st of s.strategies) if (st.stage !== "retired") await this.stopRules(st, all, reason);
    // 0.9.13: and every other rule Autopilot made, tracked here or not (a copy another device made, an older bot),
    // so turning it off really stops all of it.
    const left = this.w.rules().list().filter((r) => r.by === "superbot" && ["active", "paused", "proposed"].includes(r.status));
    for (const r of left) if (this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false);
    if (left.length) await this.w.rules().mutate((rs) => { for (const r of rs) if (left.some((x) => x.id === r.id)) { r.status = "cancelled"; r.state.note = reason.slice(0, 120); } });
    await this.update((st) => { st.enabled = false; st.halted = null; for (const x of st.strategies) if (x.stage !== "retired") { x.stage = "retired"; x.stage_since = nowIso(this.now()); x.history.push({ ts: nowIso(this.now()), note: reason }); } st.paper_rules = []; });
    await this.log("rule", reason, [{ type: "retire", reason, sources: [], applied: true, outcome: "all strategies stopped" }]);
    this.d.onRulesChanged?.();
    return this.view();
  }
  /** After a loss stop, the owner may start again early (the stop would lift on its own at the next day or week). */
  async resume(byOwner = true) {
    // Nov 10 (audit): the owner starting again early starts the count over; a stop lifting on its own keeps this
    // week's losses (only the day starts fresh), so the weekly stop still adds up a bad week.
    await this.update((s) => { s.halted = null; s.marks = byOwner ? null : s.marks ? { ...s.marks, day: "" } : null; });
    const s = this.load(), all = this.w.rules().list();
    // ...and a bot the owner paused stays paused.
    for (const st of s.strategies) if (st.stage === "live" && !st.owner_paused) for (const r of this.rulesOf(s, st, all)) if (r.status === "paused") await this.w.rules().setStatus(r.id, "active").catch(() => {});
    this.d.onRulesChanged?.();
    return this.view();
  }

  // ─── the cycle ───────────────────────────────────────────────────────────
  start() { if (this.timer) return; this.timer = setInterval(() => void this.tick().catch(() => {}), 60_000); this.timer.unref?.(); void this.tick().catch(() => {}); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Once a minute: run a cycle when one is due. */
  async tick() {
    const s = this.load();
    if (!s.enabled || this.d.active?.() === false) return;
    const due = !s.stats.last_cycle || this.now() - Date.parse(s.stats.last_cycle) >= s.settings.rethink_minutes * 60_000 - 5_000;
    if (due) await this.cycle();
  }

  async cycle(force = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.load();
      if (!s.enabled) return;
      const t = this.now();
      await this.update((x) => { x.stats.cycles++; x.stats.last_cycle = nowIso(t); x.stats.last_error = null; });
      // 0.9.12 (Joe chose it): Max pace becomes Adaptive once. Adaptive is Max whenever a coin is quiet.
      if (s.settings.pace === "max" && !s.adaptive_moved) {
        await this.update((x) => { x.settings.pace = "adaptive"; x.adaptive_moved = 1; });
        await this.log("rule", "Pace changed from Max to Adaptive: Max when a coin is quiet, wider targets when it's rising, and no new buys on a coin that's falling.", [{ type: "keep", reason: "Adaptive pace", sources: ["0.9.12 update"], applied: true, outcome: "pace: adaptive" }]);
      }
      if (this.adaptive() || this.mv().on) await this.readMarket(this.load());
      const all = this.w.rules().list();
      await this.checkLosses(s, all);
      await this.promoteDemote(all);
      await this.resizeToBalance(this.w.rules().list());
      await this.dailyReport(all);
      await this.endRangeIdeas();
      const after = this.load();
      if (after.halted) return;
      const snap = await this.snapshot();
      if (!snap) {
        // One missed reply is usually a server restart: check again in 2 minutes, and only show a problem after two misses in a row.
        await this.update((x) => {
          const n = (x.stats.snap_fails ?? 0) + 1; x.stats.snap_fails = n;
          if (n >= 2) x.stats.last_error = "No signal snapshot from Tollkit's server.";
          x.stats.last_cycle = nowIso(t - x.settings.rethink_minutes * 60_000 + SUPERBOT.snapRetryMs);
        });
        return;
      }
      if (after.stats.snap_fails) await this.update((x) => { x.stats.snap_fails = 0; });
      const moved = !!snap.changes?.moved && snap.id !== after.stats.last_snapshot;
      const stale = !after.stats.last_step || t - Date.parse(after.stats.last_step) >= SUPERBOT.forceStepMinutes * 60_000;
      // 0.9.7: Active pace tightens idle strategies, and decides at every rethink, not only when the market moved.
      const active = (after.settings.pace ?? "steady") !== "steady"; // "active", "max" or "adaptive"
      await this.noticeOwnerStops(this.w.rules().list());
      await this.stopLeftovers(this.w.rules().list());
      await this.sizePass(this.w.rules().list());
      if (active) await this.tightenIdle(this.w.rules().list());
      if (this.adaptive(after)) await this.rideRising(this.w.rules().list());
      if (this.mv(after).on) await this.bigMoves(this.w.rules().list());
      if (force || moved || stale || active) { await this.step(snap); await this.endRangeIdeas(); }
    } catch (e) {
      await this.update((x) => { x.stats.last_error = (e as Error).message.slice(0, 300); });
    } finally { this.busy = false; }
  }

  private async snapshot(): Promise<any | null> {
    const f = this.d.fetch ?? fetch;
    try { const r = await f(`${this.d.proxy}${SUPERBOT.signalsPath}`, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) return null; const j = await r.json(); this.lastSnap = j; return j; } catch { return null; }
  }

  /** Daily and weekly loss stops, measured on live strategies' result against marks set at the start of each day and week. */
  private async checkLosses(s: State, all: Rule[]) {
    const t = this.now(), today = day(t), week = weekOf(t);
    const liveResult = r2((s.live_banked?.result ?? 0) + s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + (this.summaryOf(x, all)?.result_usd ?? 0), 0));
    if (s.halted && s.halted.until && t >= Date.parse(s.halted.until)) { await this.resume(false); s = this.load(); }
    if (!s.marks || s.marks.day !== today || s.marks.week !== week) {
      await this.update((x) => { x.marks = { day: today, day_start: x.marks?.day === today ? x.marks.day_start : liveResult, week, week_start: x.marks?.week === week ? x.marks.week_start : liveResult }; });
      return;
    }
    if (s.halted) return;
    const dayLoss = s.marks.day_start - liveResult, weekLoss = s.marks.week_start - liveResult;
    const dayCap = s.settings.budget_usd * s.settings.daily_loss_pct / 100, weekCap = s.settings.budget_usd * s.settings.weekly_loss_pct / 100;
    let why: string | null = null, until: string | null = null;
    if (weekLoss >= weekCap) { why = `Weekly loss stop: down $${r2(weekLoss)} this week (limit $${r2(weekCap)}).`; const d = new Date(t); d.setUTCDate(d.getUTCDate() + 7 - ((d.getUTCDay() + 6) % 7)); /* Nov 10 (audit): next Monday, never today */ d.setUTCHours(0, 0, 0, 0); until = d.toISOString(); }
    else if (dayLoss >= dayCap) { why = `Daily loss stop: down $${r2(dayLoss)} today (limit $${r2(dayCap)}).`; until = `${today}T00:00:00.000Z`; until = nowIso(Date.parse(until) + 86_400_000); }
    if (!why) return;
    for (const st of s.strategies) if (st.stage === "live") for (const r of this.rulesOf(s, st, all)) if (r.status === "active") { await this.w.rules().setStatus(r.id, "paused").catch(() => {}); if (this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false); }
    await this.update((x) => { x.halted = { reason: why!, at: nowIso(t), until }; });
    await this.log("rule", why, [{ type: "pause", reason: why, sources: [`live result $${liveResult}`], applied: true, outcome: `live strategies paused until ${until}` }]);
    this.d.onRulesChanged?.();
    await this.d.notify?.(`Autopilot stopped. ${why} It resumes ${until ? `at ${until.slice(0, 16).replace("T", " ")} UTC` : "when you say so"}; you can resume earlier in the wallet.`).catch(() => {});
  }

  /** Paper -> live when a strategy beat holding USDC for the paper period; live -> paper when it is losing. */
  private async promoteDemote(all: Rule[]) {
    const s = this.load(), t = this.now();
    for (const st of s.strategies) {
      if (st.stage === "retired" || st.owner_paused) continue;
      const sum = this.summaryOf(st, all);
      const days = (t - Date.parse(st.stage_since)) / 86_400_000, trades = sum?.trades_ok ?? 0, pct = sum?.result_pct ?? null;
      if (st.stage === "paper") {
        const periodOver = days >= s.settings.paper_days || trades >= s.settings.paper_trades;
        if (!periodOver) continue;
        // 0.9.8: a strategy that beat holding USDC waits for the owner's Go live; it keeps practising on paper meanwhile.
        // A trending meme also needs the coin added on Home before it can go live (checked again on Go live).
        if (pct !== null && pct > 0) {
          // 0.9.10 Active mode: it goes live by itself when it fits the budget (never a Trending-on-X coin: those need the owner).
          if (s.settings.active_mode && !st.paper_only && !st.owner_set) { // Nov 7: one the owner set up waits for their Go live
            const why = `Paper result +${pct}% after ${trades} trades in ${r2(days)} days beat holding USDC. Active mode is on, so it went live with real money.`;
            const ok = await this.restage(st, "live", why, all);
            if (ok.applied) {
              await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.ready = null; });
              await this.log("rule", why, [{ type: "promote", strategy_id: st.id, reason: why, sources: [`paper ${pct}%`, "Active mode"], applied: true, outcome: ok.outcome }]);
              await this.d.notify?.(`Autopilot: ${st.name} passed its paper trial (+${pct}%) and went live (Active mode).`).catch(() => {});
              continue;
            }
          }
          if (!st.ready) {
            const sym = st.symbol ? `$${st.symbol}` : st.token.length > 12 ? `${st.token.slice(0, 4)}…` : st.token;
            const why = `Paper result +${pct}% after ${trades} trades in ${r2(days)} days beat holding USDC. Ready to go live with real money when you tap Go live.`;
            await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.ready = { at: nowIso(t), result_pct: pct, trades }; y.history.push({ ts: nowIso(t), note: why }); } });
            await this.log("rule", why, [{ type: "keep", strategy_id: st.id, reason: why, sources: [`paper ${pct}%`], applied: true, outcome: "ready to go live" }]);
            await this.d.notify?.(`Autopilot: ${st.paper_only ? st.name.replace(/ · [^·]*$/, ` · ${sym}`) : st.name} passed its paper trial (+${pct}%). Open Autopilot and tap Go live to use real money.`).catch(() => {});
          } else if (!st.owner_set && t - Date.parse(st.ready.at) >= SUPERBOT.readyDays * 86_400_000) {
            // 0.9.8: nobody tapped Go live in time: it's retired so it stops holding a strategy slot.
            const why = `Passed its paper trial (+${st.ready.result_pct}%) but Go live wasn't tapped within ${SUPERBOT.readyDays} days; dismissed. It never used real money.`;
            await this.retire(st, why, all);
            await this.log("rule", why, [{ type: "retire", strategy_id: st.id, reason: why, sources: [`waited ${SUPERBOT.readyDays} days`], applied: true, outcome: "dismissed" }]);
          }
          continue;
        }
        if (st.ready) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.ready = null; });
        if (!st.owner_set && (days >= 2 * s.settings.paper_days || (trades >= s.settings.paper_trades && pct !== null && pct <= 0))) {
          const why = st.paper_only
            ? `Paper test of ${st.symbol ? `$${st.symbol}` : "this meme"} from Trending on X finished (${pct === null ? "no trades" : `${pct}%`}) without beating holding USDC; retired.`
            : `Paper result ${pct === null ? "no trades" : `${pct}%`} after ${r2(days)} days did not beat holding USDC; retired.`;
          await this.retire(st, why, all);
          await this.log("rule", why, [{ type: "retire", strategy_id: st.id, reason: why, sources: [`paper ${pct ?? "none"}%`], applied: true, outcome: "retired" }]);
        }
      } else if (st.stage === "live" && pct !== null && pct < 0 && trades >= 3 && days >= 1 && this.holds(st, all)) {
        // Nov 10 (audit, round 4): losing but holding coins its sells wait for. Moving it to paper would cancel those
        // sells, so it stops buying more instead (its plain buy rules pause) and moves to paper once it has sold.
        const buys = this.openRules(this.rulesOf(s, st, all)).filter((r) => r.status === "active" && ["dca", "limit_buy", "signal_buy"].includes(r.kind));
        if (buys.length) {
          const why = `Live result ${pct}% after ${trades} trades: no more buys; it moves to paper once its coins are sold.`;
          for (const r of buys) await this.w.rules().setStatus(r.id, "paused").catch(() => {});
          await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.history.push({ ts: nowIso(this.now()), note: why }); });
          await this.log("rule", why, [{ type: "pause", strategy_id: st.id, reason: why, sources: [`live ${pct}%`], applied: true, outcome: `${buys.length} buy rule${buys.length === 1 ? "" : "s"} paused` }]);
          this.d.onRulesChanged?.();
        }
      } else if (st.stage === "live" && pct !== null && pct < 0 && trades >= 3 && days >= 1) {
        const why = `Live result ${pct}% after ${trades} trades; moved back to paper.`;
        const ok = await this.restage(st, "paper", why, all);
        await this.log("rule", why, [{ type: "demote", strategy_id: st.id, reason: why, sources: [`live ${pct}%`], applied: ok.applied, outcome: ok.outcome }]);
      }
    }
  }

  /** Cancel a strategy's open rules (and Always On for them). */
  private async stopRules(st: Strategy, all: Rule[], note: string) {
    for (const r of this.openRules(this.rulesOf(this.load(), st, all))) {
      if (this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false);
      // Nov 7 (Joe: "2 bots keep starting and finishing immediately"): status and note in one write. Cancelled with no
      // note reads as the owner's own Stop (noticeOwnerStops), so a check landing between two writes retired the strategy.
      await this.w.rules().mutate((rules) => { const x = rules.find((y) => y.id === r.id); if (x && ["active", "paused", "proposed"].includes(x.status)) { x.status = "cancelled"; x.state.note = note.slice(0, 120); } }).catch(() => {});
    }
    await this.update((s) => { s.paper_rules = s.paper_rules.filter((id) => !all.some((r) => r.id === id && r.bot === st.bot)); });
  }
  /** Nov 8 (money audit): keep a strategy's live result when it leaves live. */
  private async bank(sum: { result_usd: number | null; earned_usd: number } | null) {
    if (!sum) return;
    await this.update((x) => { const b = x.live_banked ?? { result: 0, earned: 0 }; x.live_banked = { result: r2(b.result + (sum.result_usd ?? 0)), earned: r2(b.earned + (sum.earned_usd ?? 0)) }; });
  }
  private async retire(st: Strategy, why: string, all: Rule[]) {
    if (st.stage === "live") await this.bank(this.summaryOf(st, all)); // Nov 8: its live record stays in the live total
    await this.stopRules(st, all, why);
    await this.update((s) => { const x = s.strategies.find((y) => y.id === st.id); if (x) { x.stage = "retired"; x.stage_since = nowIso(this.now()); x.history.push({ ts: nowIso(this.now()), note: why }); } });
    this.d.onRulesChanged?.();
  }

  /** Rebuild a strategy's rules at today's price in a stage (same template and params). */
  /**
   * 0.9.7 Active pace: a strategy that hasn't traded for a day is rebuilt tighter (and around today's price) by a
   * plain rule, at most once a day, keeping its stage and its paper clock.
   */
  private async tightenIdle(all: Rule[]) {
    const s = this.load(), t = this.now();
    for (const st of s.strategies.filter((x) => x.stage !== "retired" && !x.owner_paused)) {
      // 0.9.12 Adaptive: a rising or falling coin's strategies aren't tightened (quiet, normal or unknown ones are).
      const mk = this.marketOf(st.chain, st.token);
      if (mk === "rising" || mk === "falling") continue;
      const sum = this.summaryOf(st, all);
      if (this.holds(st, all)) continue; // Nov 10 (audit): waiting on its sell is not idle; a rebuild would orphan its coins
      const since = Math.max(Date.parse(st.stage_since), sum?.last_trade ? Date.parse(sum.last_trade) : 0, st.tightened_at ? Date.parse(st.tightened_at) : 0);
      if (t - since < SUPERBOT.idleHours * 3_600_000) continue;
      const next = tightened(st.template, st.params);
      if (!next) continue;
      const params = this.clampParams(s, st.template, next);
      if (params.note) continue;
      const why = `No trade in ${SUPERBOT.idleHours} hours on ${s.settings.pace === "max" ? "Max" : s.settings.pace === "adaptive" ? `Adaptive (${st.token.length > 12 ? "the coin" : st.token} ${mk ?? "steady"})` : "Active"} pace: tightened ${describeChange(st.params, params.params)} and re-centred on today's price.`;
      if (this.rebuiltLately(st)) continue;
      const res = await this.restage(st, st.stage === "live" ? "live" : "paper", why, all, params.params, true);
      await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.tightened_at = nowIso(t); });
      await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, template: st.template, chain: st.chain, token: st.token, params: params.params, reason: why, sources: ["pace: active", `no trade for ${SUPERBOT.idleHours}h`], applied: res.applied, outcome: res.outcome }]);
    }
  }

  /**
   * Nov 5: Big moves (8% or more in 24 hours, up or down). Live strategies holding the coin get a trailing stop on part
   * of what they hold (one per move; it shares the take-profit's group, so only one of them sells). Grids are left to
   * their own sells, but one that broke out above its range is rebuilt around the price within the hour. When the coin
   * calms down (under 4% in a day), an unfilled trailing stop is cancelled. Each move raises one alert.
   */
  private async bigMoves(all: Rule[]) {
    const s = this.load(), mv = this.mv(s), t = this.now();
    const kindOf = (k: string) => { const m = this.market[k]; return m && m.d1 >= MOVES.bigPct ? "rising" as const : m && m.d1 <= -MOVES.bigPct ? "falling" as const : null; };
    const did: Record<string, string[]> = {};
    const note = (k: string, x: string) => { (did[k] ??= []).push(x); };
    for (const st of s.strategies.filter((x) => x.stage === "live" && !x.owner_paused && !x.stopped_by_owner)) {
      const k = `${st.chain}:${st.token.toLowerCase()}`, kind = kindOf(k), m = this.market[k], coin = st.token.length > 12 ? "the coin" : st.token;
      const rules = this.rulesOf(s, st, all), g = st.guard ? all.find((r) => r.id === st.guard!.rule) : undefined;
      if (!kind) {
        // Calm again: an unfilled trailing stop from the move is cancelled.
        if (st.guard && m && Math.abs(m.d1) < 4) {
          if (g && g.status === "active") { await this.w.rules().setStatus(g.id, "cancelled").catch(() => {}); if (this.ao(g).isOn(g.id)) this.ao(g).set(g.id, false); }
          await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.guard = null; });
          this.d.onRulesChanged?.();
        }
        continue;
      }
      if (st.template === "grid") {
        if (kind === "rising") {
          const grid = rules.find((r) => r.kind === "grid" && r.status === "active"), held = this.summaryOf(st, all)?.units_held ?? 0;
          const price = await this.d.price(st.chain, st.token).catch(() => undefined);
          if (grid?.upper_price && price && price > grid.upper_price && held <= 1e-9 && (!st.followed_at || t - Date.parse(st.followed_at) >= MOVES.followMs)) {
            const why = `${coin} broke out above ${st.name}'s range ($${grid.upper_price}) and is up ${m!.d1}% today: Big moves rebuilt the grid around $${r2(price)} so it keeps trading.`;
            const res = await this.restage(st, "live", why, all, st.params, true);
            await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.followed_at = nowIso(t); y.history.push({ ts: nowIso(t), note: why }); } });
            await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, reason: why, sources: ["big moves", `${coin} +${m!.d1}%`], applied: res.applied, outcome: res.outcome }]);
            if (res.applied) note(k, `rebuilt ${st.name} around the new price`);
          }
        }
        continue;
      }
      if (st.guard && st.guard.kind === kind && g && g.status === "active") continue; // already guarded for this move
      const held = this.summaryOf(st, all)?.units_held ?? 0;
      if (held <= 1e-9) {
        // Nov 10 (audit): its coins are sold; a guard still waiting would sell another strategy's coins.
        if (g && ["active", "paused"].includes(g.status)) { await this.w.rules().setStatus(g.id, "cancelled").catch(() => {}); await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.guard = null; }); }
        continue;
      }
      const amt = Math.floor(held * (mv.share_pct / 100) * 1e6) / 1e6;
      if (!(amt > 0)) continue;
      const tp = rules.find((r) => (r.kind === "take_profit" || r.kind === "limit_sell") && r.status === "active");
      // Nov 10 (audit): only a guard that sells everything joins the take-profit's group. A partial one sells its share
      // and leaves the take-profit on for the rest, so no coins are left without a sell.
      const whole = mv.share_pct >= 100;
      const group = whole ? tp?.group ?? `guard-${st.id}` : `guard-${st.id}`;
      if (whole && tp && !tp.group) await this.w.rules().mutate((rs) => { const x = rs.find((y) => y.id === tp.id); if (x) x.group = group; });
      const why = kind === "rising"
        ? `${coin} jumped ${m!.d1}% in 24 hours: Big moves locks in the gain. ${mv.share_pct}% of what ${st.name} holds sells if ${coin} falls ${mv.trail_pct}% from its new high.`
        : `${coin} fell ${Math.abs(m!.d1)}% in 24 hours: Big moves protects ${mv.share_pct}% of what ${st.name} holds. It sells if ${coin} falls another ${mv.trail_pct}% from here (or from any bounce).`;
      let made: Rule;
      try { made = await this.w.rules().add({ kind: "trailing_stop", chain: st.chain, token: st.token, trail_pct: mv.trail_pct, sell_amount: String(amt), bot: st.bot ?? undefined, bot_name: `Autopilot · ${st.name}`, group, reason: why.slice(0, 400) } as any, "agent", true, "superbot"); }
      catch (e) { await this.log("rule", `Big moves couldn't protect ${st.name}: ${(e as Error).message}`, []); continue; }
      if (g && g.status === "active") await this.w.rules().setStatus(g.id, "cancelled").catch(() => {});
      // 24/7: the trailing stop runs on TOLLkit's server too when the strategy's rules do.
      if (rules.some((r) => this.ao(r).isOn(r.id))) this.ao(made).set(made.id, true);
      await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.guard = { rule: made.id, kind, at: nowIso(t) }; y.history.push({ ts: nowIso(t), note: why }); } });
      await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, reason: why, sources: ["big moves", `${coin} ${m!.d1}%`], applied: true, outcome: `trailing stop ${mv.trail_pct}% on ${amt} ${st.token.length > 12 ? "" : st.token}`.trim() }]);
      note(k, kind === "rising" ? `set a ${mv.trail_pct}% trailing stop to lock in ${st.name}'s gain` : `set a ${mv.trail_pct}% trailing stop on ${mv.share_pct}% of ${st.name}`);
      this.d.onRulesChanged?.();
    }
    // The owner's own bots whose buys now wait (Big moves "own").
    if (mv.own) for (const r of all) {
      if (r.by === "superbot" || r.status !== "active" || !["grid", "infinity_grid", "smart_dca"].includes(r.kind)) continue;
      const k = `${r.chain}:${r.token.toLowerCase()}`;
      if (kindOf(k) === "falling") note(k, `held buys on your ${r.bot_name ?? (r.kind === "grid" ? "grid bot" : "bot")}`);
    }
    // One alert per coin per move.
    for (const x of this.watched(s)) {
      const k = `${x.chain}:${x.token.toLowerCase()}`, kind = kindOf(k), m = this.market[k];
      if (!kind || !m) continue;
      const prev = (this.load().moves_seen ?? {})[k];
      if (prev && prev.kind === kind && t - Date.parse(prev.at) < MOVES.alertMs) { if (did[k]?.length) await this.update((y) => { const a = y.moves_seen?.[k]; if (a) a.did = [...new Set([...a.did, ...did[k]!])].slice(0, 6); }); continue; }
      if (kind === "falling" && !did[k]?.length && s.strategies.every((st) => `${st.chain}:${st.token.toLowerCase()}` !== k)) note(k, "watching it; nothing of yours was buying it");
      const a: MoveAlert = { chain: x.chain, token: x.token, kind, d1: m.d1, at: nowIso(t), did: (did[k] ?? []).slice(0, 6) };
      await this.update((y) => { y.moves_seen = { ...(y.moves_seen ?? {}), [k]: a }; });
      const coin = x.token.length > 12 ? "A coin you hold" : x.token;
      await this.d.notify?.(`${coin} is ${kind === "rising" ? "up" : "down"} ${Math.abs(m.d1)}% in 24 hours. ${a.did.length ? `Autopilot ${a.did.join("; ")}.` : "Autopilot is watching it."} Open TOLLkit to lock it in now or keep going.`).catch(() => {});
    }
  }
  /** Nov 5: the Big moves card on Home: Sell now (the protected share, at the market) or Keep going. */
  async moveAct(key: string, act: "sell_now" | "keep") {
    const s = this.load(), a = (s.moves_seen ?? {})[key];
    if (!a) throw new Error("That alert is gone.");
    let sold = 0;
    if (act === "sell_now") {
      const all = this.w.rules().list();
      for (const st of s.strategies.filter((x) => x.stage === "live" && `${x.chain}:${x.token.toLowerCase()}` === key && x.guard)) {
        const g = all.find((r) => r.id === st.guard!.rule);
        if (!g || g.status !== "active" || !g.sell_amount) continue;
        const price = await this.d.price(st.chain, st.token).catch(() => undefined);
        if (!price) continue;
        // A limit sell just under today's price fills at the next check; it shares the group, so the trailing stop ends.
        const made = await this.w.rules().add({ kind: "limit_sell", chain: st.chain, token: st.token, trigger_price: r2(price * 0.995) || price * 0.995, sell_amount: g.sell_amount, bot: st.bot ?? undefined, bot_name: g.bot_name, group: g.group, reason: "The owner tapped Sell now on the Big moves alert." } as any, "agent", true, "superbot");
        if (this.ao(g).isOn(g.id)) this.ao(made).set(made.id, true);
        sold++;
      }
      await this.log("rule", sold ? `Selling the protected share of ${sold} strateg${sold === 1 ? "y" : "ies"} now (the owner tapped Sell now).` : "Sell now: nothing protected to sell.", []);
      this.d.onRulesChanged?.();
    }
    await this.update((x) => { const y = x.moves_seen?.[key]; if (y) y.seen = true; });
    return { ...this.view(), sold };
  }

  /**
   * 0.9.12 Adaptive pace, coin rising: let winners run. A dip holding coins gets its take-profit raised once (to at
   * least 4% over cost, up to 8%); an idle strategy holding nothing is rebuilt wider (see widened()), at most once a
   * day. Grids holding coins keep their levels: rebuilding one would leave its coins without their sells.
   */
  private async rideRising(all: Rule[]) {
    const s = this.load(), t = this.now();
    for (const st of s.strategies.filter((x) => x.stage !== "retired" && !x.owner_paused)) {
      if (this.marketOf(st.chain, st.token) !== "rising") continue;
      const m = this.market[`${st.chain}:${st.token.toLowerCase()}`]!, coin = st.token.length > 12 ? "the coin" : st.token;
      const sum = this.summaryOf(st, all), holds = (sum?.units_held ?? 0) > 1e-9;
      if (st.template === "dip" && holds && st.bot && st.widened_bot !== st.bot) {
        const from = Number(st.params.profit_pct), to = widened("dip", st.params)?.profit_pct as number | undefined;
        const tp = this.rulesOf(s, st, all).find((r) => r.kind === "take_profit" && r.status === "active" && r.trigger_price);
        if (!tp || !to || !(from > 0)) continue;
        const price = raisedTarget(tp.trigger_price!, from, to);
        await this.w.rules().mutate((rules) => { const x = rules.find((y) => y.id === tp.id); if (x) { x.trigger_price = price; x.state.note = `Adaptive pace: ${coin} is rising, so it sells at +${to}% instead of +${from}%.`; } return x ? { ...x } : null; });
        const why = `${coin} is rising (${m.d1}% in 24 hours, ${m.d3}% in 3 days): ${st.name} now sells at $${price} (+${to}% over cost instead of +${from}%).`;
        await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.widened_bot = st.bot!; y.history.push({ ts: nowIso(t), note: why }); } });
        await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, reason: why, sources: ["pace: adaptive", `${coin} rising`], applied: true, outcome: "take-profit raised" }]);
        if (this.ao(tp).isOn(tp.id)) this.d.onRulesChanged?.();
        continue;
      }
      if (holds) continue;
      const since = Math.max(Date.parse(st.stage_since), sum?.last_trade ? Date.parse(sum.last_trade) : 0, st.tightened_at ? Date.parse(st.tightened_at) : 0);
      if (t - since < SUPERBOT.idleHours * 3_600_000) continue;
      const next = widened(st.template, st.params);
      if (!next) continue;
      const params = this.clampParams(s, st.template, next);
      if (params.note) continue;
      const why = `${coin} is rising (${m.d1}% in 24 hours, ${m.d3}% in 3 days) and ${st.name} hasn't traded in ${SUPERBOT.idleHours} hours: widened ${describeChange(st.params, params.params)} on Adaptive pace and re-centred on today's price.`;
      if (this.rebuiltLately(st)) continue;
      const res = await this.restage(st, st.stage === "live" ? "live" : "paper", why, all, params.params, true);
      await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.tightened_at = nowIso(t); });
      await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, template: st.template, chain: st.chain, token: st.token, params: params.params, reason: why, sources: ["pace: adaptive", `${coin} rising`], applied: res.applied, outcome: res.outcome }]);
    }
  }

  /**
   * 0.9.9: the owner's Stop on any strategy (paper or live): its rules are cancelled, its slot is freed, and Autopilot
   * never rebuilds, adjusts or restarts it. Coins it bought stay in the wallet and count as the owner's again.
   */
  async stopStrategy(id: unknown) {
    const s = this.load(), st = s.strategies.find((x) => x.id === id && !x.removed);
    if (!st) throw new Error("That strategy isn't there any more.");
    if (st.stage === "retired") return this.view();
    const why = `You stopped it${st.stage === "live" ? " (it was trading real money)" : ""}. Autopilot won't restart or change it; any coins it bought stay in your wallet.`;
    await this.retire(st, why, this.w.rules().list());
    await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.stopped_by_owner = true; y.owner_paused = false; } });
    await this.log("rule", why, [{ type: "retire", strategy_id: st.id, template: st.template, chain: st.chain, token: st.token, reason: why, sources: ["owner tapped Stop"], applied: true, outcome: "stopped by you" }]);
    return this.view();
  }

  /** 0.9.9: the owner's Remove: stops it if it's still running, then takes it off the list. Its trades stay in Activity. */
  async removeStrategy(id: unknown) {
    const s = this.load(), st = s.strategies.find((x) => x.id === id && !x.removed);
    if (!st) throw new Error("That strategy isn't there any more.");
    if (st.stage !== "retired") await this.stopStrategy(id);
    const ids = this.w.rules().list().filter((r) => r.by === "superbot" && st.bot && r.bot === st.bot && ["done", "cancelled", "expired"].includes(r.status)).map((r) => r.id);
    if (ids.length) await this.w.rules().archive(ids).catch(() => 0);
    await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.removed = true; y.history.push({ ts: nowIso(this.now()), note: "You removed it from the list." }); } });
    this.d.onRulesChanged?.();
    return this.view();
  }

  /** 0.9.9: the owner paused or resumed an Autopilot bot on the Bots screen. While paused, Autopilot leaves it alone. */
  async ownerHold(bot: string, paused: boolean) {
    const st = this.load().strategies.find((x) => x.bot === bot && x.stage !== "retired");
    if (st) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.owner_paused = paused; y.history.push({ ts: nowIso(this.now()), note: paused ? "You paused its bot; Autopilot leaves it alone." : "You resumed its bot." }); } });
  }

  /** 0.9.9: an Autopilot bot the owner stopped on the Bots screen (every rule cancelled there) is a stopped strategy. */
  async ownerStoppedBot(bot: string) {
    const st = this.load().strategies.find((x) => x.bot === bot && x.stage !== "retired");
    if (st) await this.stopStrategy(st.id);
  }

  /**
   * 0.9.9: catches stops made before this version, or by another device: a strategy whose bot has no active or paused
   * rule left and at least one the owner cancelled (Autopilot's own cancels carry a note) is treated as stopped.
   */
  /**
   * 0.9.13: a bot Autopilot replaced (an older copy of a strategy) or a strategy it retired or removed must not keep
   * trading. Only bots Autopilot itself recorded as its own are stopped; anything it never tracked is left alone.
   */
  private async stopLeftovers(all: Rule[]) {
    const s = this.load(), cur = new Set(s.strategies.filter((x) => x.stage !== "retired" && !x.removed && x.bot).map((x) => x.bot!));
    for (const st of s.strategies) for (const b of st.prev_bots ?? []) cur.add(b); // same-stage copies already stopped; never touch the current set
    const gone = new Set<string>();
    for (const st of s.strategies) {
      for (const b of st.old_bots ?? []) if (!cur.has(b)) gone.add(b);
      if ((st.stage === "retired" || st.removed) && st.bot && !cur.has(st.bot)) gone.add(st.bot);
    }
    const left = all.filter((r) => r.by === "superbot" && r.bot && gone.has(r.bot) && ["active", "paused", "proposed"].includes(r.status));
    if (!left.length) return;
    await this.w.rules().mutate((rs) => { for (const r of rs) if (left.some((x) => x.id === r.id)) { r.status = "cancelled"; r.state.note = "Stopped: Autopilot replaced this bot with a newer copy."; } });
    for (const r of left) if (this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false);
    await this.log("rule", `Stopped ${left.length} rule${left.length === 1 ? "" : "s"} of older copies of its bots, so each strategy runs once.`, [{ type: "retire", reason: "older copy still running", sources: [], applied: true, outcome: `${left.length} rule${left.length === 1 ? "" : "s"} cancelled` }]);
    this.d.onRulesChanged?.();
  }

  private async noticeOwnerStops(all: Rule[]) {
    for (const st of this.load().strategies.filter((x) => x.stage !== "retired" && x.bot)) {
      const rs = all.filter((r) => r.by === "superbot" && r.bot === st.bot);
      if (!rs.length || rs.some((r) => r.status === "active" || r.status === "paused" || r.status === "proposed")) continue;
      if (rs.some((r) => r.status === "cancelled" && !r.state.note)) await this.stopStrategy(st.id);
    }
  }

  /** 0.9.8: the owner's Dismiss on a strategy waiting for Go live: retired, never on real money, slot freed. */
  async dismiss(id: unknown) {
    const s = this.load(), st = s.strategies.find((x) => x.id === id);
    if (!st || st.stage !== "paper") throw new Error("That strategy isn't waiting any more.");
    const why = `You dismissed it${st.ready ? ` after it passed its paper trial (+${st.ready.result_pct}%)` : ""}. It never used real money.`;
    await this.retire(st, why, this.w.rules().list());
    await this.log("rule", why, [{ type: "retire", strategy_id: st.id, reason: why, sources: ["owner tapped Dismiss"], applied: true, outcome: "dismissed" }]);
    return this.view();
  }
  /** 0.9.8: hide a Trending on X coin (or show them all again). Hidden coins are never paper-tested. */
  async xHide(address: unknown, hide = true) {
    await this.update((x) => {
      const cur = new Set((x.x_hidden ?? []).map((a) => a.toLowerCase()));
      if (!hide) cur.clear(); else if (typeof address === "string" && /^[\w]{20,64}$/.test(address)) cur.add(address.toLowerCase());
      x.x_hidden = [...cur].slice(-200);
    });
    return this.view();
  }

  /** 0.9.8: the owner's Go live on a strategy that passed its paper trial. Only the owner reaches this (dashboard). */
  async goLive(id: unknown) {
    const s = this.load(), st = s.strategies.find((x) => x.id === id);
    if (!st || st.stage !== "paper") throw new Error("That strategy isn't on paper any more.");
    if (!st.ready) throw new Error("It hasn't passed its paper trial yet.");
    if (!(await this.d.knownToken(st.chain, st.token).catch(() => false))) throw new Error(`Add ${st.symbol ? `$${st.symbol}` : st.token} on Home first. Add runs TOLLkit's token check, then tap Go live again.`);
    const all = this.w.rules().list();
    const why = `You tapped Go live after a paper result of +${st.ready.result_pct}% over ${st.ready.trades} trades; now trading with real money.`;
    const ok = await this.restage(st, "live", why, all);
    if (!ok.applied) throw new Error(`It stayed on paper: ${ok.outcome.replace(/^stayed on paper: /, "")}.`);
    await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.ready = null; });
    await this.log("rule", why, [{ type: "promote", strategy_id: st.id, reason: why, sources: [`paper ${st.ready.result_pct}%`, "owner tapped Go live"], applied: true, outcome: ok.outcome }]);
    return this.view();
  }

  private rebuiltLately(st: Strategy) { return !!st.rebuilt_at && this.now() - Date.parse(st.rebuilt_at) < REBUILD_MS; }
  private async restage(st: Strategy, stage: "paper" | "live", why: string, all: Rule[], params = st.params, keepClock = false): Promise<{ applied: boolean; outcome: string }> {
    const s = this.load();
    if (stage === "live") {
      const fit = this.fitsBudget(s, st, params);
      if (fit) return { applied: false, outcome: `stayed on paper: ${fit}` };
    }
    const price = await this.d.price(st.chain, st.token).catch(() => undefined);
    let built;
    try { built = buildBot(st.template, st.token, st.chain, params, price); } catch (e) { return { applied: false, outcome: (e as Error).message }; }
    const sum = this.summaryOf(st, all);
    if (st.stage === "live" && stage !== "live") await this.bank(sum); // Nov 8: its live record stays in the live total
    await this.stopRules(st, all, why);
    const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: why.slice(0, 200), ...(stage === "paper" ? { paper: true } : {}) })), "agent", true, "superbot");
    await this.update((x) => {
      const y = x.strategies.find((z) => z.id === st.id); if (!y) return;
      if (!keepClock) y.past = [...(y.past ?? []), { stage: y.stage, result_pct: sum?.result_pct ?? null, trades: sum?.trades_ok ?? 0 }].slice(-6);
      // 0.9.10: same stage, clock kept: the old bot's results stay with the strategy; a new stage starts clean.
      y.prev_bots = keepClock && y.stage === stage && y.bot ? [...(y.prev_bots ?? []), y.bot].slice(-200) : []; // Nov 7: 200, so a re-armed dip keeps its whole record
      if (y.bot) y.old_bots = [...(y.old_bots ?? []).filter((b) => b !== y.bot), y.bot].slice(-40);
      if (keepClock) y.rebuilt_at = nowIso(this.now());
      y.stage = stage; if (!keepClock) y.stage_since = nowIso(this.now()); y.bot = built.bot; y.params = params; y.name = built.name; y.history.push({ ts: nowIso(this.now()), note: why });
      if (stage === "paper") x.paper_rules.push(...made.map((r) => r.id));
    });
    if (stage === "live") await this.handToAlwaysOn(made);
    this.d.onRulesChanged?.();
    return { applied: true, outcome: `${stage}: ${made.length} rule${made.length === 1 ? "" : "s"} started` };
  }

  /** Why a live strategy with these params would break the budget or the per-token cap, or null. Exported for tests through fitsBudget(). */
  fitsBudget(s: State, st: Pick<Strategy, "id" | "token" | "chain" | "template">, params: Record<string, unknown>): string | null {
    const mine = committedUsd(st.template, params);
    const others = s.strategies.filter((x) => x.stage === "live" && x.id !== st.id);
    const total = others.reduce((a, x) => a + committedUsd(x.template, x.params), 0) + mine;
    if (total > s.settings.budget_usd) return `$${r2(total)} committed would pass the $${s.settings.budget_usd} budget`;
    const sameToken = others.filter((x) => x.chain === st.chain && x.token.toLowerCase() === st.token.toLowerCase()).reduce((a, x) => a + committedUsd(x.template, x.params), 0) + mine;
    const cap = s.settings.budget_usd * s.settings.max_token_pct / 100;
    if (sameToken > cap) return `$${r2(sameToken)} in ${st.token} would pass the ${s.settings.max_token_pct}% per-token cap ($${r2(cap)})`;
    return null;
  }

  /** 0.9.2: the 24/7 switch for a rule's network: Base and the other EVM networks, or Solana (src/alwayson-sol.ts). */
  private ao(r: Pick<Rule, "chain">): { isOn(id: string): boolean; set(id: string, on: boolean, budget?: number): void } {
    const sol = r.chain === "solana" ? (this.w as any).alwaysSol?.() : null;
    return sol ?? this.w.always();
  }

  private async handToAlwaysOn(rules: Rule[]) {
    const s = this.load();
    if (!s.settings.always_on) return;
    const evm = rules.filter((r) => r.chain !== "solana"), sol = rules.filter((r) => r.chain === "solana");
    if (evm.length) {
      let cfg; try { cfg = await this.w.always().config(); } catch { cfg = null; }
      if (cfg?.enabled) for (const r of evm) if (!serverRunnable(r, cfg.chains as EvmChain[], cfg.kinds)) this.w.always().set(r.id, true, s.settings.budget_usd);
    }
    // Solana: buys under a USDC allowance of the Autopilot budget; sells set aside only SOL Autopilot's strategies bought.
    const so = (this.w as any).alwaysSol?.();
    if (sol.length && so) {
      let cfg; try { cfg = await so.config(); } catch { cfg = null; }
      if (cfg?.enabled) for (const r of sol) if (!solRunnable(r)) so.set(r.id, true, s.settings.budget_usd);
    }
  }

  // ─── the strategist ──────────────────────────────────────────────────────
  private context(s: State, all: Rule[], prices: Record<string, number | null>) {
    const t = this.now();
    return {
      limits: { budget_usd: s.settings.budget_usd, per_trade_usd: s.settings.per_trade_usd, max_token_pct: s.settings.max_token_pct, max_strategies: s.settings.max_strategies, slippage_bps: s.settings.slippage_bps, paper_period: `${s.settings.paper_days} days or ${s.settings.paper_trades} trades`, pace: s.settings.pace ?? "steady" },
      // 0.9.12 Adaptive pace: each coin's market, measured by the wallet (the strategist follows it per coin).
      ...(this.adaptive(s) ? { market_states: Object.fromEntries(s.settings.tokens.map((x) => { const m = this.market[`${x.chain}:${x.token.toLowerCase()}`]; return [`${x.chain}:${x.token}`, m ? { state: m.state, chg_24h_pct: m.d1, chg_3d_pct: m.d3 } : { state: "unknown" }]; })) } : {}),
      allowed: { chains: s.settings.chains, tokens: s.settings.tokens.map((x) => ({ ...x, price_usd: prices[`${x.chain}:${x.token}`] ?? null })) },
      templates: TEMPLATES.filter((x) => x.id !== "alert" && x.id !== "twap" && x.id !== "range").map((x) => ({ id: x.id, fields: x.fields.map((f) => `${f.key}${f.min !== undefined || f.max !== undefined ? ` (${f.min ?? ""}-${f.max ?? ""})` : ""}${f.choices ? ` [${f.choices.map((c) => c[0]).join("|")}]` : ""}`) })),
      strategies: s.strategies.filter((x) => x.stage !== "retired").map((x) => { const sum = this.summaryOf(x, all); return { id: x.id, template: x.template, chain: x.chain, token: x.token, params: x.params, stage: x.stage, days_in_stage: r2((t - Date.parse(x.stage_since)) / 86_400_000), trades: sum?.trades_ok ?? 0, result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, status: sum?.status ?? "waiting", past: x.past ?? [] }; }),
      retired_recently: s.strategies.filter((x) => x.stage === "retired").slice(-3).map((x) => ({ template: x.template, token: x.token, why: x.history.at(-1)?.note ?? "" })),
      live_committed_usd: r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + committedUsd(x.template, x.params), 0)),
      recent_decisions: s.decisions.filter((d) => d.by === "strategist").slice(-3).map((d) => ({ ts: d.ts, view: d.market_view, actions: d.actions.map((a) => `${a.type}${a.strategy_id ? ` ${a.strategy_id}` : ""}${a.applied ? "" : " (not applied)"}`) })),
      // 0.9.13: the owner's standing instructions from the AI chat.
      ...(s.settings.notes?.length ? { owner_notes: s.settings.notes } : {}),
      // 0.9.1: the owner's own rules, so the strategist doesn't work against them.
      owner_rules: all.filter((r) => !isAutopilotRule(r) && ["active", "paused", "proposed"].includes(r.status)).slice(0, 20).map((r) => ({ kind: r.kind, chain: r.chain, token: r.token.length > 12 ? r.token.slice(0, 8) + "…" : r.token, status: r.status, ...(r.trigger_price ? { trigger_price: r.trigger_price } : {}), ...(r.amount_usd ? { amount_usd: r.amount_usd } : {}), ...(r.sell_percent ? { sell_percent: r.sell_percent } : {}), ...(r.trail_pct ? { trail_pct: r.trail_pct } : {}), ...(r.every ? { every: r.every } : {}) })),
      sources_on: Object.entries(s.settings.sources).filter(([, v]) => v).map(([k]) => k),
    };
  }

  /** 0.33.0: the snapshot the current decision was made on (its "Trending on X" list is what a meme proposal must match). */
  private lastSnap: any = null;
  /** What the Autopilot screen shows from X: the mood per coin and the trending memes, from the latest snapshot. */
  xView() { const sn = this.lastSnap; if (!sn) return null; const hid = new Set((this.load().x_hidden ?? []).map((a) => a.toLowerCase()));
    return { at: sn.at ?? null, moods: sn.social?.x ?? null, trending: (sn.trending_x?.coins ?? []).filter((c: any) => !hid.has(String(c?.address ?? "").toLowerCase())), hidden: hid.size }; }
  private async step(snap: any) {
    this.lastSnap = snap ?? this.lastSnap;
    const s = this.load(), all = this.w.rules().list();
    const prices: Record<string, number | null> = {};
    for (const x of s.settings.tokens) prices[`${x.chain}:${x.token}`] = (await this.d.price(x.chain, x.token).catch(() => undefined)) ?? null;
    const context = this.context(s, all, prices);
    let body = JSON.stringify({ snapshot_id: snap.id, context });
    if (body.length > SUPERBOT.maxContextChars) { context.recent_decisions = []; context.retired_recently = []; body = JSON.stringify({ snapshot_id: snap.id, context }); }
    if (this.d.decide) return this.stepOwn(snap, context);
    const r = await this.w.pay(`${this.d.proxy}${SUPERBOT.stepPath}`, { method: "POST", headers: { "content-type": "application/json" }, body }, { publicOnly: true, by: "superbot" });
    const j: any = r.response ? await r.response.json().catch(() => null) : null;
    if (!(r.paid || r.owner) || !r.response?.ok || !j?.decision) {
      const why = r.refused ? `${r.refused.reason}` : j?.error ?? `Tollkit's server answered HTTP ${r.status ?? "?"}`;
      await this.update((x) => { x.stats.last_error = `AI step: ${why}`.slice(0, 300); x.stats.last_snapshot = snap.id; });
      return;
    }
    const cost = SUPERBOT.stepPriceUsd;
    await this.update((x) => { x.stats.steps++; x.stats.step_usd = r2(x.stats.step_usd + cost); x.stats.last_step = nowIso(this.now()); x.stats.last_snapshot = j.snapshot_id ?? snap.id; });
    const applied: AppliedAction[] = [];
    for (const a of j.decision.actions as any[]) applied.push({ ...a, ...(await this.apply(a).catch((e) => ({ applied: false, outcome: (e as Error).message }))) });
    await this.log("strategist", j.decision.assessment, applied, { snapshot_id: j.snapshot_id ?? snap.id, market_view: j.decision.market_view, confidence: j.decision.confidence, model: j.model ?? null, cost_usd: cost });
    if (applied.some((a) => a.applied && a.type !== "keep")) this.d.onRulesChanged?.();
  }

  /** 0.9.5: one decision on the owner's own AI key; the provider bills them, so nothing is paid here. */
  private async stepOwn(snap: any, context: any) {
    const fail = (why: string) => this.update((x) => { x.stats.last_error = `AI step: ${why}`.slice(0, 300); x.stats.last_snapshot = snap.id; });
    if (!this.d.decide!.label()) return void await this.update((x) => { x.stats.last_error = "Add your AI key on the AI tab so Autopilot can decide."; });
    if (!snap?.id || !snap.pulse) return void await fail("the market snapshot was incomplete");
    let user = strategistUser(snap, context);
    if (JSON.stringify(context).length > SUPERBOT.maxContextChars) { context.recent_decisions = []; context.retired_recently = []; user = strategistUser(snap, context); }
    let got: { input: unknown; model: string }, decision: ReturnType<typeof checkDecision>;
    try { got = await this.d.decide!.run(SUPERBOT_SYSTEM, user, DECIDE_TOOL); decision = checkDecision(got.input, this.maxProposals()); }
    catch (e) { return void await fail((e as Error).message); }
    await this.update((x) => { x.stats.steps++; x.stats.last_step = nowIso(this.now()); x.stats.last_snapshot = snap.id; x.stats.last_error = null; });
    const applied: AppliedAction[] = [];
    for (const a of decision.actions as any[]) applied.push({ ...a, ...(await this.apply(a).catch((e) => ({ applied: false, outcome: (e as Error).message }))) });
    await this.log("strategist", decision.assessment, applied, { snapshot_id: snap.id, market_view: decision.market_view, confidence: decision.confidence, model: got.model, cost_usd: 0 });
    if (applied.some((a) => a.applied && a.type !== "keep")) this.d.onRulesChanged?.();
  }

  /** New strategies one decision may start: two on Max, and on Adaptive while any allowed coin is quiet. */
  private maxProposals(s: State = this.load()) {
    if (s.settings.pace === "max") return 2;
    return this.adaptive(s) && s.settings.tokens.some((x) => this.marketOf(x.chain, x.token) === "quiet") ? 2 : 1;
  }

  /** One action from the strategist, checked against the owner's limits before anything is created or stopped. */
  /**
   * 0.9.13: the owner asked (from the AI chat, then tapped Apply) for Autopilot to run a strategy. It goes through
   * exactly the checks Autopilot's own proposals do (budget, slots, no doubles, the owner's rules, paper first) and
   * Autopilot manages it from then on.
   */
  async ownerAsk(a: { template: string; chain: string; token: string; params?: Record<string, unknown>; reason?: string }) {
    if (!this.load().enabled) throw new Error("Turn Autopilot on first.");
    const why = String(a.reason ?? "You asked for it from the AI chat.").slice(0, 200);
    const { sizing, ...params } = (a.params ?? {}) as Record<string, unknown>;
    const mode = SIZINGS.includes(sizing as Sizing) ? (sizing as Sizing) : undefined;
    const res = await this.apply({ type: "propose", template: a.template, chain: a.chain, token: a.token, params, reason: why, sources: ["you asked"], owner: true, sizing: mode });
    await this.log("rule", res.applied ? `You asked for a ${a.template} on ${a.token}; Autopilot added it.` : `You asked for a ${a.template} on ${a.token}; Autopilot couldn't add it: ${res.outcome}.`, [{ type: "propose", reason: why, sources: ["you asked"], ...res }]);
    this.d.onRulesChanged?.();
    return res;
  }
  /** 0.9.13: add or remove one of the owner's standing notes. */
  async setNote(op: "add" | "remove" | "clear", text?: string) {
    const s = this.load(), cur = s.settings.notes ?? [], t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const next = op === "clear" ? [] : op === "remove" ? cur.filter((x) => x.toLowerCase() !== t.toLowerCase()) : t && !cur.some((x) => x.toLowerCase() === t.toLowerCase()) ? [...cur, t].slice(-8) : cur;
    await this.update((x) => { x.settings = { ...x.settings, notes: next }; });
    return next;
  }

  private async apply(a: any): Promise<{ applied: boolean; outcome: string }> {
    const s = this.load(), all = this.w.rules().list();
    if (s.halted) return { applied: false, outcome: "the bot is stopped by a loss limit" };
    const st = a.strategy_id ? s.strategies.find((x) => x.id === a.strategy_id) : undefined;
    switch (a.type) {
      case "keep": return { applied: true, outcome: "kept" };
      case "pause": case "resume": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        if (st.owner_paused) return { applied: false, outcome: "the owner paused it; Autopilot leaves it alone" };
        const want = a.type === "pause" ? "paused" : "active", from = a.type === "pause" ? "active" : "paused";
        let n = 0;
        for (const r of this.rulesOf(s, st, all)) if (r.status === from) { await this.w.rules().setStatus(r.id, want); n++; if (a.type === "pause" && this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false); }
        await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); y?.history.push({ ts: nowIso(this.now()), note: `${a.type}: ${a.reason}` }); });
        return { applied: n > 0, outcome: n ? `${n} rule${n === 1 ? "" : "s"} ${want}` : `nothing to ${a.type}` };
      }
      case "retire": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        if (st.owner_set) return { applied: false, outcome: "the owner set this one up; only they stop it" };
        await this.retire(st, `AI: ${a.reason}`, all);
        return { applied: true, outcome: "retired" };
      }
      case "adjust": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        if (st.owner_set) return { applied: false, outcome: "the owner set this one up; Autopilot leaves its settings alone" };
        if (st.owner_paused) return { applied: false, outcome: "the owner paused it; Autopilot leaves it alone" };
        const params = this.clampParams(s, st.template, { ...st.params, ...(a.params ?? {}) });
        if (!st.owner_set) params.params = eagerRsi(st.template, params.params);
        if (params.note) return { applied: false, outcome: params.note };
        // 0.9.11: on paper the wallet re-sizes it to the equal share; a live one keeps its amount (budget checked at go-live).
        if (st.stage === "paper") { try { params.params = await this.sized(s, st.chain, st.template, params.params, st.id, undefined, st.token); } catch { /* keeps its size */ } }
        // Nov 10 (code audit): a tweak may not turn it into a copy of its twin on the same coin.
        if (s.strategies.some((x) => x.id !== st.id && x.stage !== "retired" && x.template === st.template && x.chain === st.chain && x.token.toLowerCase() === st.token.toLowerCase() && sameSetup(x.params, params.params))) return { applied: false, outcome: "not changed: that would copy another strategy on this coin" };
        const clash = clashWithOwner(st.template, params.params, all, st.chain, st.token, await this.d.price(st.chain, st.token).catch(() => undefined));
        if (clash) return { applied: false, outcome: `not changed: ${clash}` };
        // 0.9.10: a tweak keeps the paper (or live) clock and the results so far, so a paper test can finish.
        if (this.rebuiltLately(st)) return { applied: false, outcome: "changed less than 12 hours ago; left as it is" };
        if (this.holds(st, all)) return { applied: false, outcome: "not changed: it holds coins waiting on its sell" }; // Nov 10 (audit)
        return this.restage(st, st.stage, `AI adjusted it: ${a.reason}`, all, params.params, true);
      }
      case "propose": {
        const running = s.strategies.filter((x) => x.stage !== "retired");
        if (running.length >= s.settings.max_strategies) return { applied: false, outcome: `already at the ${s.settings.max_strategies}-strategy maximum` };
        const chain = String(a.chain ?? "") as Chain;
        if (!s.settings.chains.includes(chain)) return { applied: false, outcome: `${a.chain} is not an allowed network` };
        let tok: { chain: Chain; token: string } | undefined = s.settings.tokens.find((x) => x.chain === chain && x.token.toLowerCase() === String(a.token ?? "").toLowerCase());
        // 0.33.0: a meme coin from "Trending on X" (only with the X source on): paper only, small, and only these templates.
        let meme: any = null;
        if (!tok && s.settings.sources.x) {
          meme = (this.lastSnap?.trending_x?.coins ?? []).find((c: any) => c?.safe !== false && c?.chain === chain && String(c?.address ?? "").toLowerCase() === String(a.token ?? "").toLowerCase()) ?? null;
          if (meme && (s.x_hidden ?? []).includes(String(meme.address).toLowerCase())) return { applied: false, outcome: "the owner hid this coin" };
          if (meme && !["dip", "dca", "grid"].includes(a.template)) return { applied: false, outcome: "a trending meme can only be tested with dip, dca or grid" };
          if (meme) tok = { chain, token: meme.address };
        }
        if (!tok) return { applied: false, outcome: `${a.token} is not on the allowed list for ${chainName(chain)}` };
        if (a.template === "alert" || a.template === "twap" || !TEMPLATES.some((x) => x.id === a.template)) return { applied: false, outcome: "unknown template" };
        // Nov 7 (Joe: "but nothing is running"): the no-doubles rules are for Autopilot's own picks. The owner may run a
        // second dip on SOL next to one Autopilot started, or next to a paused leftover it can't see.
        const params = this.clampParams(s, a.template, a.params ?? {});
        if (params.note) return { applied: false, outcome: params.note };
        if (!a.owner) params.params = eagerRsi(a.template, params.params);
        // Nov 10 (Joe: "make the most money possible"): up to two of a kind on one coin, when their settings differ
        // (a 1.5% dip next to a 3% one). Before, one of each was the limit and good ideas were turned away all night.
        const coinName = tok.token.length > 12 ? "this coin" : tok.token;
        const twins = running.filter((x) => x.chain === chain && x.token.toLowerCase() === tok!.token.toLowerCase() && x.template === a.template);
        if (!a.owner && twins.some((x) => sameSetup(x.params, params.params))) return { applied: false, outcome: `a ${a.template} on ${coinName} with these settings is already running` };
        // 0.9.13: and never more copies of a bot that is still running than that, even ones no strategy tracks any more.
        const bots = new Set(all.filter((r) => r.by === "superbot" && !r.archived && ["active", "paused", "proposed"].includes(r.status) && r.template === a.template && r.chain === chain && r.token.toLowerCase() === tok!.token.toLowerCase()).map((r) => r.bot ?? r.id));
        const tracked = new Set(running.map((x) => x.bot).filter(Boolean));
        if (!a.owner && [...bots].some((b) => !tracked.has(b))) return { applied: false, outcome: `a ${a.template} on ${coinName} is already running` };
        if (!a.owner && Math.max(twins.length, bots.size) >= MAX_TWINS) return { applied: false, outcome: `${MAX_TWINS} ${a.template} strategies on ${coinName} are already running` };
        // 0.9.12 Adaptive pace: nothing new that buys a coin while it's falling.
        if (this.marketOf(chain, tok.token) === "falling" && committedUsd(a.template, params.params) > 0) return { applied: false, outcome: `not started: ${tok.token.length > 12 ? "the coin" : tok.token} is falling, and Adaptive pace starts no new buys on it` };
        try { params.params = await this.sized(s, chain, a.template, params.params, undefined, a.owner && Number(a.params?.amount_usd) > 0 ? Number(a.params.amount_usd) : undefined, tok.token); }
        catch (e) { return { applied: false, outcome: `not started: ${(e as Error).message}` }; }
        if (meme && typeof params.params.amount_usd === "number") params.params.amount_usd = Math.min(10, params.params.amount_usd as number);
        const price = await this.d.price(chain, tok.token).catch(() => undefined);
        // 0.9.9: never against the owner's own rules on this coin (src/conflict.ts).
        const clash = clashWithOwner(a.template, params.params, all, chain, tok.token, price);
        if (clash) return { applied: false, outcome: `not started: ${clash}` };
        let built;
        try { built = buildBot(a.template, tok.token, chain, params.params, price); } catch (e) { return { applied: false, outcome: (e as Error).message }; }
        const id = randomUUID().slice(0, 8), t = nowIso(this.now());
        const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: String(a.reason).slice(0, 200), paper: true })), "agent", true, "superbot");
        await this.update((x) => {
          // The bot's name ends with the coin (a long address is shortened): show the meme's $SYMBOL there instead.
          const sym = String(meme?.symbol ?? "").slice(0, 16).toUpperCase();
          const name = !meme ? built.name : built.name.includes(tok!.token) ? built.name.split(tok!.token).join(sym) : built.name.replace(/ · [^·]*$/, ` · ${sym}`);
          x.strategies.push({ id, name, template: a.template, chain, token: tok!.token, params: params.params, stage: "paper", bot: built.bot, created_at: t, stage_since: t,
            history: [{ ts: t, note: a.owner ? `You asked for it: ${a.reason}` : meme ? `Proposed by the AI from Trending on X (paper only): ${a.reason}` : `Proposed by the AI: ${a.reason}` }], ...(meme ? { paper_only: true, symbol: String(meme.symbol).slice(0, 16) } : {}), ...(a.owner ? { owner_set: true } : {}), ...(a.sizing ? { sizing: a.sizing, sizing_base: Number(params.params.amount_usd) || undefined, sizing_seen: 0 } : {}) });
          x.paper_rules.push(...made.map((r) => r.id));
        });
        return { applied: true, outcome: `started on paper (${made.length} rule${made.length === 1 ? "" : "s"})` };
      }
      default: return { applied: false, outcome: "unknown action" };
    }
  }

  /**
   * 0.9.11 (Joe: "resize all, live too"): strategies made before balance sizing are rebuilt once at the equal share,
   * keeping their clock and results. A live one that sells what it bought (grid, dip, smart DCA...) waits until it
   * holds nothing, so no coins it bought are left without their sell; a live one must still fit the budget and the
   * per-coin cap (restage checks), or it keeps its size.
   */
  private async resizeToBalance(all: Rule[]) {
    const s = this.load();
    if ((s.sized ?? 0) >= 3 || s.halted) return; // Nov 7: 2 = sized again with free cash over open slots; Nov 10: 3 = over live slots, RSI 38
    let waiting = false;
    for (const st of s.strategies) {
      if (st.stage === "retired" || st.owner_paused || st.owner_set || st.params.amount_usd === undefined) continue;
      let next: Record<string, unknown>; try { next = await this.sized(this.load(), st.chain, st.template, st.params, st.id, undefined, st.token); } catch { next = { ...st.params }; } // fresh: earlier ones in this pass may have grown
      if (st.paper_only && typeof next.amount_usd === "number") next = { ...next, amount_usd: Math.min(10, next.amount_usd) };
      next = eagerRsi(st.template, next);
      const a0 = Number(st.params.amount_usd), a1 = Number(next.amount_usd), rsi = next.level !== st.params.level;
      if (!rsi && (!(a1 > 0) || Math.abs(a1 - a0) < Math.max(0.5, a0 * 0.1))) continue;
      const neverSells = st.template === "dca" || (st.template === "signal" && st.params.side !== "sell");
      if (st.stage === "live" && !neverSells && (this.summaryOf(st, all)?.units_held ?? 0) > 1e-9) { waiting = true; continue; }
      if (this.rebuiltLately(st)) { waiting = true; continue; } // Nov 10 (code audit): try again later, not never
      await this.restage(st, st.stage, `${a1 !== a0 ? `Resized from your balance: $${r2(a0)} → $${r2(a1)}${st.template === "grid" ? " a level" : st.template === "dca" ? " a buy" : ""}.` : ""}${rsi ? `${a1 !== a0 ? " " : ""}Buys when hourly RSI falls below ${next.level} (was ${Number(st.params.level) || 30}), so it trades more often.` : ""}`, this.w.rules().list(), next, true);
    }
    if (!waiting) await this.update((x) => { x.sized = 3; });
  }

  /**
   * Nov 7: owner-picked sizing (see Strategy.sizing). Only between trades (holding nothing it bought), so no coins are
   * left without their sell. A one-shot dip is re-armed at today's price once it has sold; a repeating bot (grid,
   * Smart DCA) is rebuilt at the new size once it has made or lost money since the last time. Inside the per-trade cap.
   */
  private async sizePass(all: Rule[]) {
    const s = this.load();
    if (s.halted) return;
    for (const st of s.strategies) {
      if (!st.sizing || st.stage === "retired" || st.owner_paused || st.params.amount_usd === undefined) continue;
      const sum = this.summaryOf(st, all);
      if (!sum || (sum.units_held ?? 0) > 1e-9) continue;
      const rules = this.rulesOf(s, st, all), oneShot = st.template === "dip";
      const finished = rules.length > 0 && !rules.some((r) => ["active", "paused", "proposed"].includes(r.status));
      const made = r2(sum.result_usd ?? 0), seen = st.sizing_seen ?? 0, cur = Number(st.params.amount_usd);
      if (oneShot ? !finished : Math.abs(made - seen) < 0.005) continue;
      const base = st.sizing_base ?? cur;
      let want = Math.min(s.settings.per_trade_usd, nextSize(st.sizing, base, cur, made, seen));
      // Nov 7 (Joe: "what happens when it runs out of money to trade?"): never bigger than the cash still free on this
      // network (its USDC less what the other live strategies may still spend). A live one sizes down to what's
      // there; with under $1 free it waits, holding nothing, and says so once, instead of failing a buy at every check.
      if (st.stage === "live") {
        const stable = await this.d.stableUsd?.(st.chain).catch(() => undefined);
        if (stable !== undefined) {
          const others = s.strategies.filter((x) => x.stage === "live" && x.id !== st.id).reduce((a, x) => a + committedUsd(x.template, x.params), 0);
          const per = committedUsd(st.template, { ...st.params, amount_usd: 1 }) || 1; // dollars committed per $1 of amount
          const room = Math.floor(((stable - others) / per) * 100) / 100;
          if (room < 1) {
            if (!st.sizing_wait) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.sizing_wait = nowIso(this.now()); y.history.push({ ts: nowIso(this.now()), note: `Out of cash to trade: $${r2(Math.max(0, stable - others))} of USDC is free on ${st.chain}. It waits and starts again when there's at least $1.` }); } });
            continue;
          }
          if (want > room) want = room;
        }
      }
      if (st.sizing_wait) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) delete y.sizing_wait; });
      const next = { ...st.params, amount_usd: want };
      const why = oneShot
        ? `Sold; buying again at $${r2(want)}${want !== cur ? ` (was $${r2(cur)}, ${st.sizing === "compound" ? "adding what it made" : st.sizing === "step_up" ? (made > seen ? "25% bigger after a win" : "back to the start after a loss") : "same size"})` : ""}.`
        : `${made >= seen ? "Made" : "Lost"} $${r2(Math.abs(made - seen))} since the last size: next trades $${r2(want)} (was $${r2(cur)}).`;
      const ok = await this.restage(st, st.stage, why, all, next, true);
      if (ok.applied) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.sizing_seen = made; });
    }
  }

  /** Nov 7: the owner picks how a strategy's trade size moves (from the app or the AI chat's Approvals card). */
  async setSizing(id: string, mode: Sizing) {
    if (!SIZINGS.includes(mode)) throw new Error("Pick fixed, compound or step_up.");
    const st = this.load().strategies.find((x) => x.id === id && x.stage !== "retired");
    if (!st) throw new Error("No such running strategy.");
    const sum = this.summaryOf(st, this.w.rules().list());
    await this.update((x) => { const y = x.strategies.find((z) => z.id === id); if (y) { y.sizing = mode; y.sizing_base ??= Number(y.params.amount_usd) || undefined; y.sizing_seen = r2(sum?.result_usd ?? 0); y.history.push({ ts: nowIso(this.now()), note: `You set its trade size to ${mode === "compound" ? "add profits" : mode === "step_up" ? "bet bigger on wins" : "stay the same"}.` }); } });
  }

  /** Last share per network, for Think 24/7 (brainInfo is synchronous). */
  private shares: Partial<Record<Chain, number>> = {};
  /** This network's equal share (see shareUsd), sized into the template's fields and clamped again. */
  private async sized(s: State, chain: Chain, template: string, params: Record<string, unknown>, self?: string, ownerAmount?: number, token?: string): Promise<Record<string, unknown>> {
    const stable = await this.d.stableUsd?.(chain).catch(() => undefined);
    // Nov 10 (Joe: "make the most money possible"): practice strategies no longer take a share of the real money, and a
    // live one's reserve is only what it may still spend (a dip that already bought holds coins, not cash).
    const others = s.strategies.filter((x) => x.stage === "live" && x.id !== self), all = this.w.rules().list();
    const left = (x: Strategy) => { const m = this.summaryOf(x, all); return Math.max(0, committedUsd(x.template, x.params) - (m?.units_held ?? 0) * (m?.avg_cost ?? 0)); }; // Nov 10 (code audit): what is in coins now, not lifetime spending
    const o = { committed: others.reduce((a, x) => a + committedUsd(x.template, x.params), 0), live_committed: others.reduce((a, x) => a + Math.min(committedUsd(x.template, x.params), left(x)), 0), count: others.length };
    let share = shareUsd(s.settings.budget_usd, stable, liveSlots(s.settings.max_strategies), o);
    // ...and never more than the per-token cap leaves, so a practice strategy can still go live at its size.
    if (token) share = Math.max(0, Math.min(share, Math.floor((s.settings.budget_usd * s.settings.max_token_pct / 100 - s.strategies.filter((x) => x.stage !== "retired" && x.id !== self && x.chain === chain && x.token.toLowerCase() === token.toLowerCase()).reduce((a, x) => a + committedUsd(x.template, x.params), 0)) * 100) / 100));
    this.shares[chain] = share;
    // Nov 7: a size the owner named in the AI chat ("a $100 first buy") is kept, inside the per-trade cap and the cash
    // still free; before, it was always replaced by the equal share ($1.81).
    if (ownerAmount !== undefined && ownerAmount > 0) {
      const free = Math.max(0, Math.min(s.settings.budget_usd - o.committed, (stable ?? s.settings.budget_usd) - o.live_committed));
      const want = { ...params, amount_usd: ownerAmount };
      const need = committedUsd(template, want);
      if (ownerAmount > s.settings.per_trade_usd) throw new Error(`$${r2(ownerAmount)} is over Autopilot's per-trade cap of $${r2(s.settings.per_trade_usd)}`);
      if (need > free + 0.005) throw new Error(`that needs $${r2(need)} and Autopilot has $${r2(free)} free on this network`);
      const out = this.clampParams(s, template, want);
      return out.note ? params : out.params;
    }
    // Nov 10 (code audit): with no money free (or the coin's cap used up), start nothing rather than keep the AI's hint,
    // which could never go live and would hold a slot.
    if (params.amount_usd !== undefined && share < 1) throw new Error(share <= 0 ? "no money is free for another strategy on this coin" : `only $${r2(share)} is free for another strategy`);
    const out = this.clampParams(s, template, sizeToShare(template, params, share));
    return out.note ? params : out.params;
  }

  /** Template fields only, numbers inside each field's range, dollars capped at the per-trade limit. */
  private clampParams(s: State, template: string, raw: Record<string, unknown>): { params: Record<string, unknown>; note?: string } {
    const tpl = TEMPLATES.find((x) => x.id === template);
    if (!tpl) return { params: {}, note: "unknown template" };
    const out: Record<string, unknown> = {};
    for (const f of tpl.fields) {
      const v = raw[f.key] ?? f.default;
      if (f.kind === "choice") { out[f.key] = f.choices!.some((c) => c[0] === v) ? v : f.default; continue; }
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number(f.default);
      if (f.min !== undefined) n = Math.max(f.min, n);
      if (f.max !== undefined) n = Math.min(f.max, n);
      if (f.kind === "int") n = Math.round(n);
      if (f.kind === "usd") n = Math.min(n, s.settings.per_trade_usd);
      out[f.key] = n;
    }
    return { params: out };
  }

  // ─── 0.9.10: Think 24/7 ──────────────────────────────────────────────────
  /** What TOLLkit's server needs to keep deciding while no device checks: settings and the Solana strategies. Null: off. */
  brainInfo(): unknown | null {
    const s = this.load();
    if (!s.enabled || s.halted || !s.settings.think_24_7 || !s.settings.always_on || this.d.active?.() === false) return null;
    const all = this.w.rules().list(), t = this.now(), st = s.settings;
    return {
      on: true, active: !!st.active_mode,
      ...(() => {
        // 0.9.11: Think 24/7 runs on the owner's own key. The key goes only when the server's fingerprint differs.
        const k = this.d.decide?.serverKey?.() ?? null;
        if (!k) return {};
        const fp = brainKeyFp(k.key), seen = (this.d.serverBrain?.() as any)?.ai?.fp;
        return { ai: { provider: k.provider, model: k.model, fp, ...(seen === fp ? {} : { key: k.key }) } };
      })(),
      settings: { budget_usd: st.budget_usd, per_trade_usd: st.per_trade_usd, max_token_pct: st.max_token_pct, max_strategies: st.max_strategies, pace: st.pace, daily_loss_pct: st.daily_loss_pct,
        share_usd: this.shares.solana ?? shareUsd(st.budget_usd, undefined, liveSlots(st.max_strategies)),
        paper_days: st.paper_days, paper_trades: st.paper_trades, rethink_minutes: st.rethink_minutes, slippage_bps: st.slippage_bps,
        tokens: st.tokens.filter((x) => x.chain === "solana").map((x) => ({ token: x.token })), sources_on: Object.entries(st.sources).filter(([, v]) => v).map(([k]) => k), ...(st.notes?.length ? { notes: st.notes } : {}) },
      strategies: s.strategies.filter((x) => x.stage !== "retired" && x.chain === "solana").map((x) => { const sum = this.summaryOf(x, all); return { id: x.id, name: x.name, template: x.template, token: x.token, params: x.params, stage: x.stage,
        rule_ids: this.rulesOf(s, x, all).filter((r) => r.status === "active" || r.status === "paused").map((r) => r.id), result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, trades: sum?.trades_ok ?? 0, days_in_stage: r2((t - Date.parse(x.stage_since)) / 86_400_000) }; }),
    };
  }

  /**
   * Back from being away: what the server's Autopilot decided goes into the log (and its pause, resume and retire of
   * strategies here are applied here too), and each strategy it started is taken over under the same rule ids: paper
   * ones keep practising here, live ones keep running 24/7. Returns the ids taken over (the server then lets go).
   */
  async adoptServer(b: { strategies?: any[]; log?: any[] }): Promise<string[]> {
    const seen = new Set(this.load().server_seen ?? []);
    const fresh = (b.log ?? []).filter((e) => e && typeof e.id === "string" && !seen.has(e.id));
    for (const e of fresh) {
      const acts: AppliedAction[] = (e.actions ?? []).map((a: any) => ({ type: String(a.type), strategy_id: a.strategy_id, template: a.template, chain: a.chain, token: a.token, params: a.params, reason: String(a.reason ?? ""), sources: a.sources ?? [], applied: !!a.applied, outcome: String(a.outcome ?? "") }));
      await this.log("server", `While you were away: ${String(e.assessment ?? "")}`, acts, { ts: e.ts, market_view: e.market_view ?? "neutral", confidence: e.confidence ?? 1, model: e.model ?? null, cost_usd: e.cost_usd ?? 0, snapshot_id: e.snapshot_id ?? null });
      for (const a of acts) {
        if (!a.applied || !a.strategy_id) continue;
        const s = this.load(), st = s.strategies.find((x) => x.id === a.strategy_id && x.stage !== "retired");
        if (!st) continue;
        if (a.type === "retire") await this.retire(st, `Autopilot retired it while you were away: ${a.reason}`, this.w.rules().list());
        else if (a.type === "pause" || a.type === "resume") for (const r of this.rulesOf(s, st, this.w.rules().list())) if (r.status === (a.type === "pause" ? "active" : "paused")) await this.w.rules().setStatus(r.id, a.type === "pause" ? "paused" : "active").catch(() => {});
      }
    }
    if (fresh.length) await this.update((x) => { x.server_seen = [...seen, ...fresh.map((e) => e.id as string)].slice(-300); });
    const out: string[] = [];
    for (const sv of b.strategies ?? []) {
      if (!sv || typeof sv.id !== "string") continue;
      if (this.load().strategies.some((x) => x.id === sv.id)) { out.push(sv.id); continue; } // taken over before; tell the server again
      const at = typeof sv.created_at === "string" ? sv.created_at : nowIso(this.now()), bot = randomUUID().slice(0, 8);
      const stage: Stage = sv.stage === "live" ? "live" : sv.stage === "retired" ? "retired" : "paper";
      const made = stage === "retired" ? [] : (sv.rules ?? []).filter((r: any) => r && !r.done).map((r: any) => ruleFromServer(r, sv, bot, at, stage === "paper"));
      if (made.length) await this.w.rules().mutate((rs) => { for (const m of made) if (!rs.some((x) => x.id === m.id)) rs.push(m); });
      await this.update((x) => {
        x.strategies.push({ id: sv.id, name: String(sv.name ?? sv.template), template: String(sv.template), chain: "solana", token: String(sv.token), params: sv.params ?? {}, stage, bot: made.length ? bot : null, created_at: at,
          stage_since: typeof sv.stage_since === "string" ? sv.stage_since : at, history: [...(Array.isArray(sv.history) ? sv.history : []), { ts: nowIso(this.now()), note: "Taken over from TOLLkit's server when this device came back." }].slice(-40),
          ...(sv.ready ? { ready: sv.ready } : {}) });
        if (stage === "paper") x.paper_rules.push(...made.map((r: Rule) => r.id));
      });
      if (stage === "live") for (const m of made) this.ao(m).set(m.id, true, this.load().settings.budget_usd);
      out.push(sv.id);
    }
    if (out.length || fresh.length) this.d.onRulesChanged?.();
    return out;
  }

  // ─── log and reports ─────────────────────────────────────────────────────
  /** 0.9.9: for Run 24/7. While Autopilot is on and running here, the server only acts "while you're away". */
  awayInfo(): { last_decision: string; drop_pct: number; rise_pct: number; pause: boolean } | null {
    const s = this.load();
    if (!s.enabled || s.halted || !this.d.active?.()) return null;
    // 0.9.13: pause: false tells the server not to pause rules for price moves while away (the default).
    return { last_decision: nowIso(this.now()), drop_pct: 8, rise_pct: 4, pause: s.settings.away_pause === true };
  }

  /** 0.9.9: what Tollkit's server paused while no device was open, into Autopilot's decisions. */
  async logAway(entries: { ts: string; rule_id: string; text: string }[]) {
    for (const e of entries) await this.log("away", `While you were away: ${e.text}`, [{ type: "pause", reason: e.text, sources: [], applied: true, outcome: `Rule ${e.rule_id} paused on Tollkit's server.` }], { ts: e.ts });
  }

  private async log(by: Decision["by"], assessment: string, actions: AppliedAction[], extra: Partial<Decision> = {}) {
    const d: Decision = { ts: nowIso(this.now()), snapshot_id: null, market_view: "neutral", assessment: assessment.slice(0, 700), confidence: 1, model: null, cost_usd: 0, actions, by, ...extra };
    await this.update((s) => { s.decisions.push(d); if (s.decisions.length > SUPERBOT.keepDecisions) s.decisions.splice(0, s.decisions.length - SUPERBOT.keepDecisions); }).catch(() => {});
  }

  /** Once a day (the first cycle after 00:00 UTC): what happened yesterday, to the log and to Telegram. */
  private async dailyReport(all: Rule[]) {
    const s = this.load(), t = this.now(), today = day(t);
    if (s.stats.last_report === today) return;
    if (!s.stats.last_report) { await this.update((x) => { x.stats.last_report = today; }); return; }
    const yday = day(t - 86_400_000);
    const live = s.strategies.filter((x) => x.stage === "live"), paper = s.strategies.filter((x) => x.stage === "paper");
    const liveResult = r2((s.live_banked?.result ?? 0) + live.reduce((a, x) => a + (this.summaryOf(x, all)?.result_usd ?? 0), 0));
    // Nov 8 (money audit): the day's change is against yesterday's report (the day mark has already moved by now).
    const prevRep = s.reports.at(-1), dayChange = r2(liveResult - (prevRep?.live_result_usd ?? s.marks?.day_start ?? liveResult));
    const fills = all.filter((r) => r.by === "superbot").flatMap((r) => r.state.fills.filter((f) => f.ts.startsWith(yday)));
    const trades = fills.filter((f) => f.ok && !f.paper).length, paperTrades = fills.filter((f) => f.ok && f.paper).length;
    const decisions = s.decisions.filter((d) => d.ts.startsWith(yday));
    const changes = decisions.flatMap((d) => d.actions.filter((a) => a.applied && a.type !== "keep").map((a) => `${a.type}${a.strategy_id ? ` ${s.strategies.find((x) => x.id === a.strategy_id)?.name ?? a.strategy_id}` : a.token ? ` ${a.template} on ${a.token}` : ""}: ${a.reason}`));
    const lines = [
      `Autopilot, ${yday}`,
      `Live: ${live.length} strateg${live.length === 1 ? "y" : "ies"}, ${trades} trade${trades === 1 ? "" : "s"}, result so far $${liveResult} (day change $${dayChange}).`,
      `Paper: ${paper.length} strateg${paper.length === 1 ? "y" : "ies"}, ${paperTrades} pretend trade${paperTrades === 1 ? "" : "s"}.`,
      `AI: ${decisions.filter((d) => d.by === "strategist").length} decision${decisions.filter((d) => d.by === "strategist").length === 1 ? "" : "s"} ($${Math.round(decisions.reduce((a, d) => a + d.cost_usd, 0) * 1000) / 1000}).`,
      ...(changes.length ? ["Changes:", ...changes.slice(0, 8).map((c) => `- ${c}`)] : ["No changes."]),
      ...(s.halted ? [`Stopped: ${s.halted.reason}`] : []),
    ];
    const text = lines.join("\n");
    await this.update((x) => { x.stats.last_report = today; x.reports.push({ date: yday, text, live_result_usd: liveResult, day_change_usd: dayChange, trades, decisions: decisions.length } as any); if (x.reports.length > SUPERBOT.keepReports) x.reports.splice(0, x.reports.length - SUPERBOT.keepReports); });
    await this.d.notify?.(text).catch(() => {});
  }
}

/** 0.9.10: a rule TOLLkit's server ran for Autopilot (x402-starter src/always-sol.ts SRule), as this wallet keeps it. */
export function ruleFromServer(r: any, sv: any, bot: string, at: string, paper: boolean): Rule {
  const kind = String(r.kind);
  const { grid, ...rest } = (r.bot && typeof r.bot === "object" ? r.bot : {}) as any;
  const lv = Number(r.levels) || 0;
  return {
    id: String(r.id), chain: "solana", token: String(sv.token), kind: kind as any, bot, bot_name: `Autopilot · ${String(sv.name ?? sv.template)}`, template: String(sv.template),
    ...(r.amount_usd !== undefined ? { amount_usd: r.amount_usd } : {}), ...(r.every ? { every: r.every } : {}), ...(r.times ? { times: r.times } : {}),
    ...(r.lower_price !== undefined ? { lower_price: r.lower_price, upper_price: r.upper_price, levels: r.levels } : {}), ...(r.when ? { when: r.when } : {}),
    reason: "Started by Autopilot on TOLLkit's server while you were away.", ...(paper ? { paper: true } : {}),
    status: "active", created_by: "agent", by: "superbot", created_at: at, activated_at: at,
    state: { runs: Number(r.runs) || 0, failures: 0, fills: [], ...(r.next_run ? { next_run: r.next_run } : {}), ...(r.ref_price ? { last_price: r.ref_price } : {}),
      ...(kind === "grid" ? { grid: grid ?? { units: Array(Math.max(0, lv - 1)).fill(null), cost: Array(Math.max(0, lv - 1)).fill(null), atomic: Array(Math.max(0, lv - 1)).fill(null) } } : {}),
      ...(Object.keys(rest).length ? { bot: rest } : {}), ...(kind.startsWith("signal_") && r.armed === false ? { alert_armed: false } : {}) },
  } as Rule;
}
