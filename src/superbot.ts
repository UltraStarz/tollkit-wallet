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
import { isAutopilotRule } from "./ownership.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Chain, CHAINS, isEvmChain, type EvmChain, chainName } from "./chains.js";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";
import { buildBot, summarize, TEMPLATES, type BotSummary } from "./bots.js";
import { serverRunnable } from "./alwayson.js";
import { solRunnable } from "./alwayson-sol.js";
import type { Rule, RuleStore } from "./rules.js";
import type { TollkitWallet } from "./wallet.js";
import { SUPERBOT_SYSTEM, DECIDE_TOOL, checkDecision, strategistUser } from "./strategist.js";

export const SUPERBOT = {
  file: "superbot.json",
  /** 0.9.8: a strategy that passed waits this many days for Go live, then it's dismissed. */
  readyDays: 3,
  stepPath: "/superbot/step",
  signalsPath: "/signals",
  snapRetryMs: 2 * 60_000,
  stepPriceUsd: 0.005,
  keepDecisions: 200,
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
  /** 0.9.6: "active" asks the strategist for more, smaller trades (still on paper first, inside every limit). */
  pace: "steady" | "active" | "max";
}
export const DEFAULT_SETTINGS: SuperbotSettings = {
  chains: ["base", "solana"], tokens: [{ chain: "base", token: "ETH" }, { chain: "solana", token: "SOL" }],
  sources: { news: true, farcaster: true, x: false },
  budget_usd: 100, per_trade_usd: 20, max_token_pct: 25, daily_loss_pct: 5, weekly_loss_pct: 15, slippage_bps: 100,
  paper_days: 7, paper_trades: 20, rethink_minutes: 30, max_strategies: 4, always_on: false, daily_share_pct: 50, pace: "steady",
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
  /** 0.9.8: passed its paper trial (beat holding USDC) and waits for the owner to tap Go live. Nothing moves to real
   * money on its own. */
  ready?: { at: string; result_pct: number; trades: number } | null;
}
export interface AppliedAction { type: string; strategy_id?: string; template?: string; chain?: string; token?: string; params?: Record<string, unknown>; reason: string; sources: string[]; applied: boolean; outcome: string }
export interface Decision { ts: string; snapshot_id: string | null; market_view: string; assessment: string; confidence: number; model: string | null; cost_usd: number; actions: AppliedAction[]; by: "strategist" | "rule" | "away" }
export interface Report { date: string; text: string; live_result_usd: number | null; trades: number; decisions: number }
interface State {
  enabled: boolean; since: string | null; settings: SuperbotSettings; strategies: Strategy[]; decisions: Decision[]; reports: Report[];
  paper_rules: string[];
  halted: { reason: string; at: string; until: string | null } | null;
  marks: { day: string; day_start: number; week: string; week_start: number } | null;
  /** 0.9.8: Trending on X coins the owner hid (lowercased addresses): not shown, never paper-tested. */
  x_hidden?: string[];
  stats: { cycles: number; steps: number; step_usd: number; last_cycle: string | null; last_step: string | null; last_snapshot: string | null; last_error: string | null; last_report: string | null; snap_fails?: number };
}

export interface SuperBotDeps {
  dir?: string; proxy: string; fetch?: typeof fetch; now?: () => number;
  /** Today's price for a token the bot may trade (the dashboard's feed, then a quote). */
  price: (chain: Chain, token: string) => Promise<number | undefined>;
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
  decide?: { label(): string | null; run(system: string, user: string, tool: typeof DECIDE_TOOL): Promise<{ input: unknown; model: string }> };
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
  if (b.pace !== undefined) { if (b.pace !== "steady" && b.pace !== "active" && b.pace !== "max") throw new Error("Pace is steady, active or max."); s.pace = b.pace; }
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
function describeChange(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const label: Record<string, string> = { drop_pct: "dip", profit_pct: "profit", range_pct: "range ±", step_pct: "step", band_pct: "band" };
  const parts = Object.keys(label).filter((k) => a[k] !== undefined && b[k] !== undefined && Number(a[k]) !== Number(b[k])).map((k) => `${label[k]} ${a[k]}% → ${b[k]}%`);
  return parts.length ? parts.join(", ") : "its settings";
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
    default: return 0;
  }
}

export class SuperBot {
  readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly w: TollkitWallet, private readonly d: SuperBotDeps) {
    this.file = path.join(walletHome(d.dir), SUPERBOT.file);
  }
  private now() { return this.d.now?.() ?? Date.now(); }

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
  /** 0.9.1: dollars of live trades Autopilot may make today: its share of the wallet's daily trading limit. */
  dailyCapUsd(walletDailyUsd: number): number | null {
    const s = this.load();
    if (!s.enabled) return null;
    return Math.round(walletDailyUsd * (s.settings.daily_share_pct ?? 50)) / 100;
  }
  private rulesOf(s: State, st: Strategy, all: Rule[]) { return st.bot ? all.filter((r) => r.bot === st.bot && !r.archived) : []; }
  private openRules(rules: Rule[]) { return rules.filter((r) => ["active", "paused", "proposed"].includes(r.status)); }
  private summaryOf(st: Strategy, all: Rule[]): BotSummary | null { return st.bot ? summarize(all.filter((r) => r.bot === st.bot && !r.archived))[0] ?? null : null; }

  /** What the dashboard shows. */
  view() {
    const s = this.load(), all = this.w.rules().list();
    const strategies = s.strategies.map((st) => { const sum = this.summaryOf(st, all); return { ...st, result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, trades: sum?.trades_ok ?? 0, failed: sum?.trades_failed ?? 0, status: sum?.status ?? (st.stage === "retired" ? "stopped" : "waiting"), last_trade: sum?.last_trade ?? null, days_in_stage: r2((this.now() - Date.parse(st.stage_since)) / 86_400_000) }; });
    const live = strategies.filter((x) => x.stage === "live");
    return {
      enabled: s.enabled, since: s.since, settings: s.settings, halted: s.halted, stats: s.stats,
      strategies, decisions: s.decisions.slice(-40).reverse(), reports: s.reports.slice(-7).reverse(),
      totals: { live: live.length, paper: strategies.filter((x) => x.stage === "paper").length, retired: strategies.filter((x) => x.stage === "retired").length,
        live_result_usd: r2(live.reduce((a, x) => a + (x.result_usd ?? 0), 0)), committed_usd: r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + committedUsd(x.template, x.params), 0)) },
      next_cycle: s.enabled && s.stats.last_cycle ? nowIso(Date.parse(s.stats.last_cycle) + s.settings.rethink_minutes * 60_000) : null,
      // 0.33.0: X through Grok, from Tollkit's shared snapshot: the mood per coin and the trending memes (paper only).
      x: this.xView(),
      ...(this.d.decide ? { brain: { own: true, label: this.d.decide.label() } } : {}),
    };
  }

  // ─── owner actions ───────────────────────────────────────────────────────
  async enable(body: Record<string, unknown> = {}) {
    const s = this.load();
    const settings = parseSettings(body, s.settings);
    for (const t of settings.tokens) if (!(await this.d.knownToken(t.chain, t.token))) throw new Error(`Add ${t.token} on ${chainName(t.chain)} on Home first (Add a token runs Tollkit's scam check).`);
    await this.update((st) => { st.settings = settings; st.enabled = true; st.since = st.since ?? nowIso(this.now()); st.halted = null; });
    await this.log("rule", "Autopilot turned on.", [{ type: "keep", reason: "The owner turned Autopilot on.", sources: [], applied: true, outcome: "on" }]);
    await this.cycle(true);
    return this.view();
  }
  async setSettings(body: Record<string, unknown>) {
    const s = this.load();
    const settings = parseSettings(body, s.settings);
    for (const t of settings.tokens) if (!(await this.d.knownToken(t.chain, t.token))) throw new Error(`Add ${t.token} on ${chainName(t.chain)} on Home first (Add a token runs Tollkit's scam check).`);
    await this.update((st) => { st.settings = settings; });
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
    await this.update((st) => { st.enabled = false; st.halted = null; for (const x of st.strategies) if (x.stage !== "retired") { x.stage = "retired"; x.stage_since = nowIso(this.now()); x.history.push({ ts: nowIso(this.now()), note: reason }); } st.paper_rules = []; });
    await this.log("rule", reason, [{ type: "retire", reason, sources: [], applied: true, outcome: "all strategies stopped" }]);
    this.d.onRulesChanged?.();
    return this.view();
  }
  /** After a loss stop, the owner may start again early (the stop would lift on its own at the next day or week). */
  async resume() {
    await this.update((s) => { s.halted = null; s.marks = null; });
    const s = this.load(), all = this.w.rules().list();
    for (const st of s.strategies) if (st.stage === "live") for (const r of this.rulesOf(s, st, all)) if (r.status === "paused") await this.w.rules().setStatus(r.id, "active").catch(() => {});
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
      const all = this.w.rules().list();
      await this.checkLosses(s, all);
      await this.promoteDemote(all);
      await this.dailyReport(all);
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
      const active = (after.settings.pace ?? "steady") !== "steady"; // "active" or "max"
      if (active) await this.tightenIdle(this.w.rules().list());
      if (force || moved || stale || active) await this.step(snap);
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
    const liveResult = r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + (this.summaryOf(x, all)?.result_usd ?? 0), 0));
    if (s.halted && s.halted.until && t >= Date.parse(s.halted.until)) { await this.resume(); s = this.load(); }
    if (!s.marks || s.marks.day !== today || s.marks.week !== week) {
      await this.update((x) => { x.marks = { day: today, day_start: x.marks?.day === today ? x.marks.day_start : liveResult, week, week_start: x.marks?.week === week ? x.marks.week_start : liveResult }; });
      return;
    }
    if (s.halted) return;
    const dayLoss = s.marks.day_start - liveResult, weekLoss = s.marks.week_start - liveResult;
    const dayCap = s.settings.budget_usd * s.settings.daily_loss_pct / 100, weekCap = s.settings.budget_usd * s.settings.weekly_loss_pct / 100;
    let why: string | null = null, until: string | null = null;
    if (weekLoss >= weekCap) { why = `Weekly loss stop: down $${r2(weekLoss)} this week (limit $${r2(weekCap)}).`; const d = new Date(t); d.setUTCDate(d.getUTCDate() + (8 - ((d.getUTCDay() + 6) % 7)) % 7 || 7); d.setUTCHours(0, 0, 0, 0); until = d.toISOString(); }
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
      if (st.stage === "retired") continue;
      const sum = this.summaryOf(st, all);
      const days = (t - Date.parse(st.stage_since)) / 86_400_000, trades = sum?.trades_ok ?? 0, pct = sum?.result_pct ?? null;
      if (st.stage === "paper") {
        const periodOver = days >= s.settings.paper_days || trades >= s.settings.paper_trades;
        if (!periodOver) continue;
        // 0.9.8: a strategy that beat holding USDC waits for the owner's Go live; it keeps practising on paper meanwhile.
        // A trending meme also needs the coin added on Home before it can go live (checked again on Go live).
        if (pct !== null && pct > 0) {
          if (!st.ready) {
            const sym = st.symbol ? `$${st.symbol}` : st.token.length > 12 ? `${st.token.slice(0, 4)}…` : st.token;
            const why = `Paper result +${pct}% after ${trades} trades in ${r2(days)} days beat holding USDC. Ready to go live with real money when you tap Go live.`;
            await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) { y.ready = { at: nowIso(t), result_pct: pct, trades }; y.history.push({ ts: nowIso(t), note: why }); } });
            await this.log("rule", why, [{ type: "keep", strategy_id: st.id, reason: why, sources: [`paper ${pct}%`], applied: true, outcome: "ready to go live" }]);
            await this.d.notify?.(`Autopilot: ${st.paper_only ? st.name.replace(/ · [^·]*$/, ` · ${sym}`) : st.name} passed its paper trial (+${pct}%). Open Autopilot and tap Go live to use real money.`).catch(() => {});
          } else if (t - Date.parse(st.ready.at) >= SUPERBOT.readyDays * 86_400_000) {
            // 0.9.8: nobody tapped Go live in time: it's retired so it stops holding a strategy slot.
            const why = `Passed its paper trial (+${st.ready.result_pct}%) but Go live wasn't tapped within ${SUPERBOT.readyDays} days; dismissed. It never used real money.`;
            await this.retire(st, why, all);
            await this.log("rule", why, [{ type: "retire", strategy_id: st.id, reason: why, sources: [`waited ${SUPERBOT.readyDays} days`], applied: true, outcome: "dismissed" }]);
          }
          continue;
        }
        if (st.ready) await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.ready = null; });
        if (days >= 2 * s.settings.paper_days || (trades >= s.settings.paper_trades && pct !== null && pct <= 0)) {
          const why = st.paper_only
            ? `Paper test of ${st.symbol ? `$${st.symbol}` : "this meme"} from Trending on X finished (${pct === null ? "no trades" : `${pct}%`}) without beating holding USDC; retired.`
            : `Paper result ${pct === null ? "no trades" : `${pct}%`} after ${r2(days)} days did not beat holding USDC; retired.`;
          await this.retire(st, why, all);
          await this.log("rule", why, [{ type: "retire", strategy_id: st.id, reason: why, sources: [`paper ${pct ?? "none"}%`], applied: true, outcome: "retired" }]);
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
      await this.w.rules().setStatus(r.id, "cancelled").catch(() => {});
      await this.w.rules().mutate((rules) => { const x = rules.find((y) => y.id === r.id); if (x) x.state.note = note.slice(0, 120); }).catch(() => {});
    }
    await this.update((s) => { s.paper_rules = s.paper_rules.filter((id) => !all.some((r) => r.id === id && r.bot === st.bot)); });
  }
  private async retire(st: Strategy, why: string, all: Rule[]) {
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
    for (const st of s.strategies.filter((x) => x.stage !== "retired")) {
      const sum = this.summaryOf(st, all);
      const since = Math.max(Date.parse(st.stage_since), sum?.last_trade ? Date.parse(sum.last_trade) : 0, st.tightened_at ? Date.parse(st.tightened_at) : 0);
      if (t - since < SUPERBOT.idleHours * 3_600_000) continue;
      const next = tightened(st.template, st.params);
      if (!next) continue;
      const params = this.clampParams(s, st.template, next);
      if (params.note) continue;
      const why = `No trade in ${SUPERBOT.idleHours} hours on ${s.settings.pace === "max" ? "Max" : "Active"} pace: tightened ${describeChange(st.params, params.params)} and re-centred on today's price.`;
      const res = await this.restage(st, st.stage === "live" ? "live" : "paper", why, all, params.params, true);
      await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); if (y) y.tightened_at = nowIso(t); });
      await this.log("rule", why, [{ type: "adjust", strategy_id: st.id, template: st.template, chain: st.chain, token: st.token, params: params.params, reason: why, sources: ["pace: active", `no trade for ${SUPERBOT.idleHours}h`], applied: res.applied, outcome: res.outcome }]);
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
    await this.stopRules(st, all, why);
    const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: why.slice(0, 200), ...(stage === "paper" ? { paper: true } : {}) })), "agent", true, "superbot");
    await this.update((x) => {
      const y = x.strategies.find((z) => z.id === st.id); if (!y) return;
      if (!keepClock) y.past = [...(y.past ?? []), { stage: y.stage, result_pct: sum?.result_pct ?? null, trades: sum?.trades_ok ?? 0 }].slice(-6);
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
      allowed: { chains: s.settings.chains, tokens: s.settings.tokens.map((x) => ({ ...x, price_usd: prices[`${x.chain}:${x.token}`] ?? null })) },
      templates: TEMPLATES.filter((x) => x.id !== "alert" && x.id !== "twap").map((x) => ({ id: x.id, fields: x.fields.map((f) => `${f.key}${f.min !== undefined || f.max !== undefined ? ` (${f.min ?? ""}-${f.max ?? ""})` : ""}${f.choices ? ` [${f.choices.map((c) => c[0]).join("|")}]` : ""}`) })),
      strategies: s.strategies.filter((x) => x.stage !== "retired").map((x) => { const sum = this.summaryOf(x, all); return { id: x.id, template: x.template, chain: x.chain, token: x.token, params: x.params, stage: x.stage, days_in_stage: r2((t - Date.parse(x.stage_since)) / 86_400_000), trades: sum?.trades_ok ?? 0, result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, status: sum?.status ?? "waiting", past: x.past ?? [] }; }),
      retired_recently: s.strategies.filter((x) => x.stage === "retired").slice(-3).map((x) => ({ template: x.template, token: x.token, why: x.history.at(-1)?.note ?? "" })),
      live_committed_usd: r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + committedUsd(x.template, x.params), 0)),
      recent_decisions: s.decisions.filter((d) => d.by === "strategist").slice(-3).map((d) => ({ ts: d.ts, view: d.market_view, actions: d.actions.map((a) => `${a.type}${a.strategy_id ? ` ${a.strategy_id}` : ""}${a.applied ? "" : " (not applied)"}`) })),
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
    try { got = await this.d.decide!.run(SUPERBOT_SYSTEM, user, DECIDE_TOOL); decision = checkDecision(got.input, this.load().settings.pace === "max" ? 2 : 1); }
    catch (e) { return void await fail((e as Error).message); }
    await this.update((x) => { x.stats.steps++; x.stats.last_step = nowIso(this.now()); x.stats.last_snapshot = snap.id; x.stats.last_error = null; });
    const applied: AppliedAction[] = [];
    for (const a of decision.actions as any[]) applied.push({ ...a, ...(await this.apply(a).catch((e) => ({ applied: false, outcome: (e as Error).message }))) });
    await this.log("strategist", decision.assessment, applied, { snapshot_id: snap.id, market_view: decision.market_view, confidence: decision.confidence, model: got.model, cost_usd: 0 });
    if (applied.some((a) => a.applied && a.type !== "keep")) this.d.onRulesChanged?.();
  }

  /** One action from the strategist, checked against the owner's limits before anything is created or stopped. */
  private async apply(a: any): Promise<{ applied: boolean; outcome: string }> {
    const s = this.load(), all = this.w.rules().list();
    if (s.halted) return { applied: false, outcome: "the bot is stopped by a loss limit" };
    const st = a.strategy_id ? s.strategies.find((x) => x.id === a.strategy_id) : undefined;
    switch (a.type) {
      case "keep": return { applied: true, outcome: "kept" };
      case "pause": case "resume": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        const want = a.type === "pause" ? "paused" : "active", from = a.type === "pause" ? "active" : "paused";
        let n = 0;
        for (const r of this.rulesOf(s, st, all)) if (r.status === from) { await this.w.rules().setStatus(r.id, want); n++; if (a.type === "pause" && this.ao(r).isOn(r.id)) this.ao(r).set(r.id, false); }
        await this.update((x) => { const y = x.strategies.find((z) => z.id === st.id); y?.history.push({ ts: nowIso(this.now()), note: `${a.type}: ${a.reason}` }); });
        return { applied: n > 0, outcome: n ? `${n} rule${n === 1 ? "" : "s"} ${want}` : `nothing to ${a.type}` };
      }
      case "retire": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        await this.retire(st, `AI: ${a.reason}`, all);
        return { applied: true, outcome: "retired" };
      }
      case "adjust": {
        if (!st || st.stage === "retired") return { applied: false, outcome: "no such running strategy" };
        const params = this.clampParams(s, st.template, { ...st.params, ...(a.params ?? {}) });
        if (params.note) return { applied: false, outcome: params.note };
        return this.restage(st, st.stage, `AI adjusted it: ${a.reason}`, all, params.params);
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
        if (running.some((x) => x.chain === chain && x.token.toLowerCase() === tok.token.toLowerCase() && x.template === a.template)) return { applied: false, outcome: `a ${a.template} on ${tok.token} is already running` };
        const params = this.clampParams(s, a.template, a.params ?? {});
        if (params.note) return { applied: false, outcome: params.note };
        if (meme && typeof params.params.amount_usd === "number") params.params.amount_usd = Math.min(10, params.params.amount_usd as number);
        const price = await this.d.price(chain, tok.token).catch(() => undefined);
        let built;
        try { built = buildBot(a.template, tok.token, chain, params.params, price); } catch (e) { return { applied: false, outcome: (e as Error).message }; }
        const id = randomUUID().slice(0, 8), t = nowIso(this.now());
        const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: String(a.reason).slice(0, 200), paper: true })), "agent", true, "superbot");
        await this.update((x) => {
          // The bot's name ends with the coin (a long address is shortened): show the meme's $SYMBOL there instead.
          const sym = String(meme?.symbol ?? "").slice(0, 16).toUpperCase();
          const name = !meme ? built.name : built.name.includes(tok!.token) ? built.name.split(tok!.token).join(sym) : built.name.replace(/ · [^·]*$/, ` · ${sym}`);
          x.strategies.push({ id, name, template: a.template, chain, token: tok!.token, params: params.params, stage: "paper", bot: built.bot, created_at: t, stage_since: t,
            history: [{ ts: t, note: meme ? `Proposed by the AI from Trending on X (paper only): ${a.reason}` : `Proposed by the AI: ${a.reason}` }], ...(meme ? { paper_only: true, symbol: String(meme.symbol).slice(0, 16) } : {}) });
          x.paper_rules.push(...made.map((r) => r.id));
        });
        return { applied: true, outcome: `started on paper (${made.length} rule${made.length === 1 ? "" : "s"})` };
      }
      default: return { applied: false, outcome: "unknown action" };
    }
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

  // ─── log and reports ─────────────────────────────────────────────────────
  /** 0.9.9: for Run 24/7. While Autopilot is on and running here, the server only acts "while you're away". */
  awayInfo(): { last_decision: string; drop_pct: number; rise_pct: number } | null {
    const s = this.load();
    if (!s.enabled || s.halted || !this.d.active?.()) return null;
    return { last_decision: nowIso(this.now()), drop_pct: 8, rise_pct: 4 };
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
    const liveResult = r2(live.reduce((a, x) => a + (this.summaryOf(x, all)?.result_usd ?? 0), 0));
    const fills = all.filter((r) => r.by === "superbot").flatMap((r) => r.state.fills.filter((f) => f.ts.startsWith(yday)));
    const trades = fills.filter((f) => f.ok && !f.paper).length, paperTrades = fills.filter((f) => f.ok && f.paper).length;
    const decisions = s.decisions.filter((d) => d.ts.startsWith(yday));
    const changes = decisions.flatMap((d) => d.actions.filter((a) => a.applied && a.type !== "keep").map((a) => `${a.type}${a.strategy_id ? ` ${s.strategies.find((x) => x.id === a.strategy_id)?.name ?? a.strategy_id}` : a.token ? ` ${a.template} on ${a.token}` : ""}: ${a.reason}`));
    const lines = [
      `Autopilot, ${yday}`,
      `Live: ${live.length} strateg${live.length === 1 ? "y" : "ies"}, ${trades} trade${trades === 1 ? "" : "s"}, result so far $${liveResult}${s.marks ? ` (day change $${r2(liveResult - s.marks.day_start)})` : ""}.`,
      `Paper: ${paper.length} strateg${paper.length === 1 ? "y" : "ies"}, ${paperTrades} pretend trade${paperTrades === 1 ? "" : "s"}.`,
      `AI: ${decisions.filter((d) => d.by === "strategist").length} decision${decisions.filter((d) => d.by === "strategist").length === 1 ? "" : "s"} ($${Math.round(decisions.reduce((a, d) => a + d.cost_usd, 0) * 1000) / 1000}).`,
      ...(changes.length ? ["Changes:", ...changes.slice(0, 8).map((c) => `- ${c}`)] : ["No changes."]),
      ...(s.halted ? [`Stopped: ${s.halted.reason}`] : []),
    ];
    const text = lines.join("\n");
    await this.update((x) => { x.stats.last_report = today; x.reports.push({ date: yday, text, live_result_usd: liveResult, trades, decisions: decisions.length }); if (x.reports.length > SUPERBOT.keepReports) x.reports.splice(0, x.reports.length - SUPERBOT.keepReports); });
    await this.d.notify?.(text).catch(() => {});
  }
}
