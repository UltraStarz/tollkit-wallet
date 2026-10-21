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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Chain, CHAINS, isEvmChain, type EvmChain, chainName } from "./chains.js";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";
import { buildBot, summarize, TEMPLATES, type BotSummary } from "./bots.js";
import { serverRunnable } from "./alwayson.js";
import type { Rule, RuleStore } from "./rules.js";
import type { TollkitWallet } from "./wallet.js";

export const SUPERBOT = {
  file: "superbot.json",
  stepPath: "/superbot/step",
  signalsPath: "/signals",
  stepPriceUsd: 0.005,
  keepDecisions: 200,
  keepReports: 30,
  /** Without a "moved" snapshot, a decision is still taken this often. */
  forceStepMinutes: 60,
  rethink: [15, 30, 60] as const,
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
}
export const DEFAULT_SETTINGS: SuperbotSettings = {
  chains: ["base", "solana"], tokens: [{ chain: "base", token: "ETH" }, { chain: "solana", token: "SOL" }],
  sources: { news: true, farcaster: true, x: false },
  budget_usd: 100, per_trade_usd: 20, max_token_pct: 25, daily_loss_pct: 5, weekly_loss_pct: 15, slippage_bps: 100,
  paper_days: 7, paper_trades: 20, rethink_minutes: 30, max_strategies: 4, always_on: false,
};

export interface Strategy {
  id: string; name: string; template: string; chain: Chain; token: string; params: Record<string, unknown>;
  stage: Stage; bot: string | null; created_at: string; stage_since: string;
  history: { ts: string; note: string }[];
  /** Results of the stage before this one, kept when a strategy moves between paper and live. */
  past?: { stage: Stage; result_pct: number | null; trades: number }[];
}
export interface AppliedAction { type: string; strategy_id?: string; template?: string; chain?: string; token?: string; params?: Record<string, unknown>; reason: string; sources: string[]; applied: boolean; outcome: string }
export interface Decision { ts: string; snapshot_id: string | null; market_view: string; assessment: string; confidence: number; model: string | null; cost_usd: number; actions: AppliedAction[]; by: "strategist" | "rule" }
export interface Report { date: string; text: string; live_result_usd: number | null; trades: number; decisions: number }
interface State {
  enabled: boolean; since: string | null; settings: SuperbotSettings; strategies: Strategy[]; decisions: Decision[]; reports: Report[];
  paper_rules: string[];
  halted: { reason: string; at: string; until: string | null } | null;
  marks: { day: string; day_start: number; week: string; week_start: number } | null;
  stats: { cycles: number; steps: number; step_usd: number; last_cycle: string | null; last_step: string | null; last_snapshot: string | null; last_error: string | null; last_report: string | null };
}

export interface SuperBotDeps {
  dir?: string; proxy: string; fetch?: typeof fetch; now?: () => number;
  /** Today's price for a token the bot may trade (the dashboard's feed, then a quote). */
  price: (chain: Chain, token: string) => Promise<number | undefined>;
  /** True for tokens the owner's wallet already knows (core tokens, or added on Home after the scam check). */
  knownToken: (chain: Chain, token: string) => Promise<boolean>;
  onRulesChanged?: () => void;
  notify?: (text: string) => Promise<void>;
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
  if (b.daily_loss_pct !== undefined) s.daily_loss_pct = num(b.daily_loss_pct, 5, 1, 50);
  if (b.weekly_loss_pct !== undefined) s.weekly_loss_pct = num(b.weekly_loss_pct, 15, 1, 90);
  if (b.slippage_bps !== undefined) s.slippage_bps = num(b.slippage_bps, 100, 10, 500);
  if (b.paper_days !== undefined) s.paper_days = num(b.paper_days, 7, 1, 60);
  if (b.paper_trades !== undefined) s.paper_trades = num(b.paper_trades, 20, 1, 500);
  if (b.rethink_minutes !== undefined) { const m = Number(b.rethink_minutes); if (!(SUPERBOT.rethink as readonly number[]).includes(m)) throw new Error("Rethink every 15, 30 or 60 minutes."); s.rethink_minutes = m as 15 | 30 | 60; }
  if (b.max_strategies !== undefined) s.max_strategies = num(b.max_strategies, 4, 1, 10);
  if (b.always_on !== undefined) s.always_on = !!b.always_on;
  if (s.per_trade_usd > s.budget_usd) throw new Error("The per-trade cap can't be more than the budget.");
  if (s.tokens.some((t) => !s.chains.includes(t.chain))) throw new Error("Every token's network must be turned on.");
  return s;
}

/** Dollars a strategy can put into buys over its life (sells don't count). Exported for tests. */
export function committedUsd(template: string, params: Record<string, unknown>): number {
  const a = Number(params.amount_usd) || 0;
  switch (template) {
    case "dca": { const t = Number(params.times) || 0; return a * (t > 0 ? t : 10); }
    case "dip": return a;
    case "grid": return a * Math.max(1, (Number(params.levels) || 2) - 1);
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
      x_note: "X (Twitter) needs a paid key and isn't available yet.",
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
    if (!s.enabled) return;
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
      if (!snap) { await this.update((x) => { x.stats.last_error = "No signal snapshot from Tollkit's server."; }); return; }
      const moved = !!snap.changes?.moved && snap.id !== after.stats.last_snapshot;
      const stale = !after.stats.last_step || t - Date.parse(after.stats.last_step) >= SUPERBOT.forceStepMinutes * 60_000;
      if (force || moved || stale) await this.step(snap);
    } catch (e) {
      await this.update((x) => { x.stats.last_error = (e as Error).message.slice(0, 300); });
    } finally { this.busy = false; }
  }

  private async snapshot(): Promise<any | null> {
    const f = this.d.fetch ?? fetch;
    try { const r = await f(`${this.d.proxy}${SUPERBOT.signalsPath}`, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) return null; return await r.json(); } catch { return null; }
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
    for (const st of s.strategies) if (st.stage === "live") for (const r of this.rulesOf(s, st, all)) if (r.status === "active") { await this.w.rules().setStatus(r.id, "paused").catch(() => {}); if (this.w.always().isOn(r.id)) this.w.always().set(r.id, false); }
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
        if (pct !== null && pct > 0) {
          const why = `Paper result +${pct}% after ${trades} trades in ${r2(days)} days beat holding USDC; moved to live money.`;
          const ok = await this.restage(st, "live", why, all);
          await this.log("rule", why, [{ type: "promote", strategy_id: st.id, reason: why, sources: [`paper ${pct}%`], applied: ok.applied, outcome: ok.outcome }]);
        } else if (days >= 2 * s.settings.paper_days || (trades >= s.settings.paper_trades && pct !== null && pct <= 0)) {
          const why = `Paper result ${pct === null ? "no trades" : `${pct}%`} after ${r2(days)} days did not beat holding USDC; retired.`;
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
      if (this.w.always().isOn(r.id)) this.w.always().set(r.id, false);
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
  private async restage(st: Strategy, stage: "paper" | "live", why: string, all: Rule[], params = st.params): Promise<{ applied: boolean; outcome: string }> {
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
    const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: why.slice(0, 200) })), "agent", true, "superbot");
    await this.update((x) => {
      const y = x.strategies.find((z) => z.id === st.id); if (!y) return;
      y.past = [...(y.past ?? []), { stage: y.stage, result_pct: sum?.result_pct ?? null, trades: sum?.trades_ok ?? 0 }].slice(-6);
      y.stage = stage; y.stage_since = nowIso(this.now()); y.bot = built.bot; y.params = params; y.name = built.name; y.history.push({ ts: nowIso(this.now()), note: why });
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

  private async handToAlwaysOn(rules: Rule[]) {
    const s = this.load();
    if (!s.settings.always_on) return;
    let cfg; try { cfg = await this.w.always().config(); } catch { return; }
    if (!cfg?.enabled) return;
    for (const r of rules) if (!serverRunnable(r, cfg.chains as EvmChain[])) this.w.always().set(r.id, true, s.settings.budget_usd);
  }

  // ─── the strategist ──────────────────────────────────────────────────────
  private context(s: State, all: Rule[], prices: Record<string, number | null>) {
    const t = this.now();
    return {
      limits: { budget_usd: s.settings.budget_usd, per_trade_usd: s.settings.per_trade_usd, max_token_pct: s.settings.max_token_pct, max_strategies: s.settings.max_strategies, slippage_bps: s.settings.slippage_bps, paper_period: `${s.settings.paper_days} days or ${s.settings.paper_trades} trades` },
      allowed: { chains: s.settings.chains, tokens: s.settings.tokens.map((x) => ({ ...x, price_usd: prices[`${x.chain}:${x.token}`] ?? null })) },
      templates: TEMPLATES.map((x) => ({ id: x.id, fields: x.fields.map((f) => `${f.key}${f.min !== undefined || f.max !== undefined ? ` (${f.min ?? ""}-${f.max ?? ""})` : ""}${f.choices ? ` [${f.choices.map((c) => c[0]).join("|")}]` : ""}`) })),
      strategies: s.strategies.filter((x) => x.stage !== "retired").map((x) => { const sum = this.summaryOf(x, all); return { id: x.id, template: x.template, chain: x.chain, token: x.token, params: x.params, stage: x.stage, days_in_stage: r2((t - Date.parse(x.stage_since)) / 86_400_000), trades: sum?.trades_ok ?? 0, result_pct: sum?.result_pct ?? null, result_usd: sum?.result_usd ?? null, status: sum?.status ?? "waiting", past: x.past ?? [] }; }),
      retired_recently: s.strategies.filter((x) => x.stage === "retired").slice(-3).map((x) => ({ template: x.template, token: x.token, why: x.history.at(-1)?.note ?? "" })),
      live_committed_usd: r2(s.strategies.filter((x) => x.stage === "live").reduce((a, x) => a + committedUsd(x.template, x.params), 0)),
      recent_decisions: s.decisions.filter((d) => d.by === "strategist").slice(-3).map((d) => ({ ts: d.ts, view: d.market_view, actions: d.actions.map((a) => `${a.type}${a.strategy_id ? ` ${a.strategy_id}` : ""}${a.applied ? "" : " (not applied)"}`) })),
      sources_on: Object.entries(s.settings.sources).filter(([, v]) => v).map(([k]) => k),
    };
  }

  private async step(snap: any) {
    const s = this.load(), all = this.w.rules().list();
    const prices: Record<string, number | null> = {};
    for (const x of s.settings.tokens) prices[`${x.chain}:${x.token}`] = (await this.d.price(x.chain, x.token).catch(() => undefined)) ?? null;
    const context = this.context(s, all, prices);
    let body = JSON.stringify({ snapshot_id: snap.id, context });
    if (body.length > SUPERBOT.maxContextChars) { context.recent_decisions = []; context.retired_recently = []; body = JSON.stringify({ snapshot_id: snap.id, context }); }
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
        for (const r of this.rulesOf(s, st, all)) if (r.status === from) { await this.w.rules().setStatus(r.id, want); n++; if (a.type === "pause" && this.w.always().isOn(r.id)) this.w.always().set(r.id, false); }
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
        const tok = s.settings.tokens.find((x) => x.chain === chain && x.token.toLowerCase() === String(a.token ?? "").toLowerCase());
        if (!tok) return { applied: false, outcome: `${a.token} is not on the allowed list for ${chainName(chain)}` };
        if (!TEMPLATES.some((x) => x.id === a.template)) return { applied: false, outcome: "unknown template" };
        if (running.some((x) => x.chain === chain && x.token.toLowerCase() === tok.token.toLowerCase() && x.template === a.template)) return { applied: false, outcome: `a ${a.template} on ${tok.token} is already running` };
        const params = this.clampParams(s, a.template, a.params ?? {});
        if (params.note) return { applied: false, outcome: params.note };
        const price = await this.d.price(chain, tok.token).catch(() => undefined);
        let built;
        try { built = buildBot(a.template, tok.token, chain, params.params, price); } catch (e) { return { applied: false, outcome: (e as Error).message }; }
        const id = randomUUID().slice(0, 8), t = nowIso(this.now());
        const made = await this.w.rules().addBot(built.rules.map((r) => ({ ...r, bot_name: `Autopilot · ${built.name}`, reason: String(a.reason).slice(0, 200) })), "agent", true, "superbot");
        await this.update((x) => {
          x.strategies.push({ id, name: built.name, template: a.template, chain, token: tok.token, params: params.params, stage: "paper", bot: built.bot, created_at: t, stage_since: t, history: [{ ts: t, note: `Proposed by the AI: ${a.reason}` }] });
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
