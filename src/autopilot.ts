/**
 * The autopilot: checks prices every few seconds and carries out the owner's
 * active rules (limit buys and sells, stop-loss, take-profit, trailing stops,
 * recurring buys). Every fill goes through the wallet's normal swap path, so
 * limits, Telegram/dashboard approvals, the 0.5% fee and receipts all apply.
 *
 * It runs while the wallet runs: inside `tollkit-wallet ui`, or on its own
 * with `tollkit-wallet autopilot` (for a server that stays on). Only one
 * process runs rules at a time (a lease file), so two copies never double-fill.
 */
import { checkAlert, checkSignal, hourlyCloses } from "./indicators.js";
import { autopilotSpentToday, isAutopilotRule, isPaperRule, nothingToSell, ownerBotUnits, sellableFor, unitsToAtomic } from "./ownership.js";
import { allocateSells, sellTier, type SellAsk } from "./pools.js";
import { plainError } from "./errors.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_RPC, LOW_FEE_BOTS, NATIVE_EVM, WSOL, type Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { BUY_KINDS, nextRun, RuleStore, type Rule } from "./rules.js";
import { DEC_A, DEC_B } from "./orca.js";
import { rangeTicks, shareInA, tickToPrice } from "./clmm.js";
import { applyFill, decide, isBotKind, type BotState } from "./botlogic.js";
import { KNOWN, resolveToken, toAtomic, type Token } from "./tokens.js";
import type { Price } from "./prices.js";
import type { SwapRequest } from "./swap.js";
import type { SwapResult } from "./wallet.js";

export interface Executor {
  mode: "live" | "paper";
  swap(req: SwapRequest, o?: { by?: string }): Promise<SwapResult>;
  quote(req: SwapRequest): Promise<SwapResult>;
  balance(chain: Chain, token: Token): Promise<bigint>;
  slippageBps: number;
  /** 0.9.9: Orca liquidity for the Range bot (live wallets only; src/orca.ts). */
  lp?: LpExecutor;
}
/** 0.9.9: what the Range bot needs from the wallet. Amounts in smallest units (SOL 9 decimals, USDC 6). */
export interface LpExecutor {
  pool(): Promise<{ price: number; spacing: number }>;
  open(o: { lower: number; upper: number; maxSol: bigint; maxUsdc: bigint; beforeSend?: (mint: string) => Promise<void> }): Promise<{ mint: string; tx: string }>;
  close(mint: string): Promise<{ tx: string; sol: bigint; usdc: bigint; feesSol: bigint; feesUsdc: bigint }>;
  read(mint: string): Promise<{ sol: number; usdc: number; inRange: boolean; lower: number; upper: number } | null>;
  /** Fees the position has earned and not yet collected (optional; shown on the bot card). */
  fees?(mint: string): Promise<{ sol: bigint; usdc: bigint } | null>;
  /** Add the Activity line for a position opened before Activity listed pool moves (once). */
  backfill?(mint: string, o: { ts: string; usd: number; lower: number; upper: number }): Promise<void>;
}
export interface PriceSource { snapshot(): { prices: Record<string, Price> } }

/** Gas kept back when selling a chain's native coin, so the wallet can still pay fees. */
const GAS_RESERVE: Record<Chain, bigint> = { base: 50_000_000_000_000n /* 0.00005 ETH */, ethereum: 2_000_000_000_000_000n /* 0.002 ETH */, arbitrum: 100_000_000_000_000n /* 0.0001 ETH */, polygon: 100_000_000_000_000_000n /* 0.1 POL */, solana: 10_000_000n /* 0.01 SOL */ };
const QUOTE_PRICE_TTL = 60_000;

export interface AutopilotOptions { dir?: string; intervalMs?: number; now?: () => number; leaseId?: string; resolve?: typeof resolveToken; onEvent?: (e: AutopilotEvent) => void;
  /** Rules Tollkit's server is running while the app is closed (src/alwayson.ts): the device leaves them alone. */
  skip?: (id: string) => boolean;
  /** 0.8.5: a replay (src/botviz.ts) runs alone in memory and takes no lease. */
  noLease?: boolean;
  /** 0.8.5: every price a rule was checked against (the Bots screen's price tape). */
  onPrice?: (r: Rule, price: number) => void;
  /** 0.9.1: dollars of live trades Autopilot's own rules may make today (its share of the daily limit), or null for no cap. */
  autopilotDailyCap?: () => number | null;
  /** 0.9.1: hourly closes for alert indicators (tests pass their own). */
  hourly?: (chain: Chain, t: Token) => Promise<number[]> }
export interface AutopilotEvent { type: "filled" | "failed" | "skipped" | "expired" | "cancelled" | "alert"; rule: Rule; detail: string }

export class Autopilot {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly leaseFile: string;
  private readonly leaseId: string;
  private quotePrices = new Map<string, { usd: number; at: number }>();
  private tokens = new Map<string, Token>();
  lastTick: string | null = null;
  holdsLease = false;

  constructor(readonly store: RuleStore, private readonly exec: Executor, private readonly prices: PriceSource, private readonly o: AutopilotOptions = {}) {
    this.leaseFile = path.join(walletHome(o.dir), "autopilot.lease");
    this.leaseId = o.leaseId ?? randomUUID();
  }

  private now() { return this.o.now?.() ?? Date.now(); }
  private interval() { return this.o.intervalMs ?? 15_000; }

  start() { if (!this.timer) { void this.tick(); this.timer = setInterval(() => void this.tick(), this.interval()); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.releaseLease(); }

  /** Only one process runs rules. A lease older than 3 intervals is free to take. */
  private takeLease(): boolean {
    if (this.o.noLease) return (this.holdsLease = true);
    try {
      if (existsSync(this.leaseFile)) {
        const l = JSON.parse(readFileSync(this.leaseFile, "utf8"));
        if (l.id !== this.leaseId && this.now() - l.ts < this.interval() * 3) return (this.holdsLease = false);
      }
      writeFileSync(this.leaseFile, JSON.stringify({ id: this.leaseId, pid: process.pid, mode: this.exec.mode, ts: this.now() }), { mode: 0o600 });
      return (this.holdsLease = true);
    } catch { return (this.holdsLease = false); }
  }
  private releaseLease() {
    try { const l = JSON.parse(readFileSync(this.leaseFile, "utf8")); if (l.id === this.leaseId) writeFileSync(this.leaseFile, JSON.stringify({ ...l, ts: 0 })); } catch { /* none */ }
  }
  /** Who is running the autopilot, if anyone. */
  static status(dir?: string, now = Date.now(), intervalMs = 15_000): { running: boolean; mode?: string; pid?: number } {
    try { const l = JSON.parse(readFileSync(path.join(walletHome(dir), "autopilot.lease"), "utf8")); return now - l.ts < intervalMs * 3 ? { running: true, mode: l.mode, pid: l.pid } : { running: false }; }
    catch { return { running: false }; }
  }

  private async token(chain: Chain, sym: string): Promise<Token> {
    const k = `${chain}:${sym}`;
    let t = this.tokens.get(k);
    if (!t) { t = await (this.o.resolve ?? resolveToken)(chain, sym); this.tokens.set(k, t); }
    return t;
  }

  /** USD price of one token: Coinbase feed for ETH/SOL, otherwise a live quote for 1 token -> USDC (cached a minute). */
  async price(chain: Chain, t: Token): Promise<number | undefined> {
    const feed = this.prices.snapshot().prices[t.symbol.toUpperCase()];
    if (feed?.usd) return feed.usd;
    const k = `${chain}:${t.address}`, hit = this.quotePrices.get(k);
    if (hit && this.now() - hit.at < QUOTE_PRICE_TTL) return hit.usd;
    const q = await this.exec.quote({ chain, sell_token: t.address, buy_token: KNOWN[chain].USDC!.address, sell_amount: (10n ** BigInt(t.decimals)).toString(), slippage_bps: this.exec.slippageBps });
    if (q.ok && q.quote?.usd_value) { this.quotePrices.set(k, { usd: q.quote.usd_value, at: this.now() }); return q.quote.usd_value; }
    return undefined;
  }

  /** 0.9.7: resolves once the check in progress (and any trade it's placing) has finished. */
  private current: Promise<void> | null = null;
  async idle(): Promise<void> { await this.current?.catch(() => {}); }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const p = this.tickOnce();
    this.current = p;
    try { await p; } finally { if (this.current === p) this.current = null; }
  }

  private async tickOnce(): Promise<void> {
    try {
      if (!this.takeLease()) return;
      this.lastTick = new Date(this.now()).toISOString();
      // 0.9.9: stops first, then take-profits, then bots, then the rest (src/pools.ts). Plain sells that fire in the
      // same check are collected and share the coins by tier before any of them trades.
      const due = this.store.list().filter((r) => r.status === "active").sort((a, b) => sellTier(a.kind) - sellTier(b.kind));
      this.pending = [];
      for (const r of due) await this.consider(r).catch((e) => this.record(r.id, { error: (e as Error).message }));
      // 0.9.9: a Range bot that was stopped takes its money out of the pool, back into the wallet.
      for (const r of this.store.list()) if (r.kind === "range" && r.status === "cancelled" && r.state.range?.mint && !this.o.skip?.(r.id))
        await this.rangeWithdraw(r).catch((e) => this.record(r.id, { error: plainError((e as Error).message, "solana") }));
      const fired = this.pending; this.pending = null;
      if (fired.length) await this.fireSells(fired);
    } finally { this.running = false; }
  }

  private pending: { r: Rule; t: Token; p: number }[] | null = null;

  /**
   * 0.9.9: the plain sells that fired together, per coin and owner (Autopilot's or yours): each asks for its amount,
   * and allocateSells shares what may be sold. Stops may sell the coins your bots hold; take-profits and limit sells
   * only what no bot holds. Then each trades its share.
   */
  private async fireSells(fired: { r: Rule; t: Token; p: number }[]) {
    const groups = new Map<string, typeof fired>();
    for (const f of fired) { const k = `${f.r.chain}|${f.t.address}|${isAutopilotRule(f.r) ? "ap" : "you"}`; groups.set(k, [...(groups.get(k) ?? []), f]); }
    for (const g of groups.values()) {
      const { r: r0, t } = g[0]!, paper = this.exec.mode === "paper";
      let bal = await this.exec.balance(r0.chain, t).catch(() => 0n);
      if (t.address === NATIVE_EVM || t.address === WSOL) bal = bal > GAS_RESERVE[r0.chain] ? bal - GAS_RESERVE[r0.chain] : 0n;
      const all = this.store.list();
      const mine = sellableFor(r0, bal, all, t, paper);
      const bots = isAutopilotRule(r0) ? 0n : unitsToAtomic(ownerBotUnits(all, r0.chain, t.symbol, t.address, paper), t.decimals);
      const free = mine > bots ? mine - bots : 0n;
      const asks: SellAsk[] = g.map(({ r }) => {
        const pool = sellTier(r.kind) === 0 ? mine : free;
        const want = r.sell_percent !== undefined ? (pool * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : BigInt(toAtomic(r.sell_amount!, t.decimals));
        return { id: r.id, tier: sellTier(r.kind), want };
      });
      const got = allocateSells(asks, (tier) => (tier === 0 ? mine : free));
      for (const { r, t: tk, p } of g) await this.fire(r, tk, p, got.get(r.id) ?? 0n, bal > 0n).catch((e) => this.record(r.id, { error: (e as Error).message }));
    }
  }

  private async consider(r: Rule) {
    if (this.o.skip?.(r.id)) return;
    const now = this.now();
    if (r.expires_at && Date.parse(r.expires_at) <= now) { await this.finish(r.id, "expired", "Expired before it triggered."); return; }
    if (r.state.hold_until && Date.parse(r.state.hold_until) > now) return;
    if (r.state.next_run && Date.parse(r.state.next_run) > now) {
      // DCA waits for its schedule; a failed attempt waits for its retry time.
      if (r.kind === "dca" || r.state.failures > 0) return;
    }
    if (r.after) {
      // Part of a bot: waits for an earlier step (e.g. take profit only after the dip buy filled).
      const prev = this.store.get(r.after);
      if (!prev || ["cancelled", "expired", "error"].includes(prev.status)) { await this.finishAs(r.id, "cancelled", "Cancelled because the step before it didn't happen."); return; }
      if (prev.status !== "done") return;
    }
    const t = await this.token(r.chain, r.token);
    const p = await this.price(r.chain, t);
    if (p === undefined) { await this.record(r.id, { checked: true }); return; }
    try { this.o.onPrice?.(r, p); } catch { /* charts never break trading */ }
    if (r.kind === "range") { await this.record(r.id, { price: p, checked: true }); await this.range(r, t, p); return; }
    if (isBotKind(r.kind)) { await this.record(r.id, { price: p, checked: true }); await this.bot(r, t, p); return; }
    if (r.kind === "alert") { await this.record(r.id, { price: p, checked: true }); await this.alert(r, t, p); return; }
    // 0.9.9: signal rules trade when their momentum signal fires (src/indicators.ts checkSignal).
    if ((r.kind === "signal_buy" || r.kind === "signal_sell") && r.when) {
      let closes: number[] | null = null;
      try { closes = await (this.o.hourly ?? ((c, tk) => hourlyCloses(c, tk)))(r.chain, t); } catch { closes = null; }
      const c = checkSignal(r.when, p, closes);
      let armed = r.state.alert_armed ?? true;
      if (!armed && c.clear) armed = true;
      await this.store.mutate((rs) => { const x = rs.find((y) => y.id === r.id); if (x) { x.state.alert_now = c.now; x.state.alert_armed = armed; x.state.last_price = p; x.state.last_checked = new Date(now).toISOString(); } });
      if (!(armed && c.hit)) return;
      if (this.pending && r.kind === "signal_sell") { this.pending.push({ r, t, p }); return; }
      await this.fire(r, t, p);
      return;
    }
    let high = r.state.high;
    if (r.kind === "trailing_stop") high = Math.max(high ?? p, p);
    const hit =
      r.kind === "limit_buy" ? p <= r.trigger_price! :
      r.kind === "stop_loss" ? p <= r.trigger_price! :
      r.kind === "limit_sell" || r.kind === "take_profit" ? p >= r.trigger_price! :
      r.kind === "trailing_stop" ? p <= high! * (1 - r.trail_pct! / 100) :
      r.kind === "dca" ? (!r.max_price || p <= r.max_price) : false;
    await this.record(r.id, { price: p, high, checked: true });
    if (!hit) {
      if (r.kind === "dca" && r.state.next_run && Date.parse(r.state.next_run) <= now) {
        // Skipped this round because the price is above max_price: try again next period.
        await this.store.mutate((rs) => { const x = rs.find((y) => y.id === r.id); if (x) x.state.next_run = nextRun(x, new Date(now)).toISOString(); });
        this.o.onEvent?.({ type: "skipped", rule: r, detail: `Price $${p} is above the max $${r.max_price}; skipped this round.` });
      }
      return;
    }
    // 0.9.9: a plain sell waits for the others that fired in this check, so they can share the coins (fireSells).
    if (this.pending && !BUY_KINDS.includes(r.kind) && !r.sell_from) { this.pending.push({ r, t, p }); return; }
    await this.fire(r, t, p);
  }

  private async fire(r: Rule, t: Token, price: number, share?: bigint, held?: boolean) {
    const usdc = KNOWN[r.chain].USDC!;
    let req: SwapRequest;
    if (BUY_KINDS.includes(r.kind)) {
      req = { chain: r.chain, sell_token: usdc.address, buy_token: t.address, sell_amount: toAtomic(r.amount_usd!.toFixed(6), 6), slippage_bps: this.exec.slippageBps };
    } else {
      let bal = await this.exec.balance(r.chain, t);
      if (t.address === NATIVE_EVM || t.address === WSOL) bal = bal > GAS_RESERVE[r.chain] ? bal - GAS_RESERVE[r.chain] : 0n;
      // 0.9.1: Autopilot's rules sell only what its strategies bought; everyone else's leave those coins alone.
      const whole = bal;
      bal = sellableFor(r, bal, this.store.list(), t, this.exec.mode === "paper");
      const from = r.sell_from ? this.store.get(r.sell_from) : undefined;
      let amt = from ? BigInt(from.state.bought_atomic ?? "0") : r.sell_percent !== undefined ? (bal * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : BigInt(toAtomic(r.sell_amount!, t.decimals));
      if (share !== undefined) amt = share; // 0.9.9: its share of what the sells that fired together may sell
      if (amt > bal) amt = bal;
      if (amt <= 0n) {
        if (bal <= 0n && (isAutopilotRule(r) || whole > 0n)) { await this.hold(r, this.now() + 5 * 60_000, nothingToSell(r, t.symbol, whole)); return; }
        if (share !== undefined && held && bal > 0n) { await this.hold(r, this.now() + 5 * 60_000, `The ${t.symbol} it could sell went to a stop or another sell that fired first, or is held by your bots.`); return; }
        await this.fail(r, "insufficient_balance", `No ${t.symbol} to sell.`); return;
      }
      req = { chain: r.chain, sell_token: t.address, buy_token: usdc.address, sell_amount: amt.toString(), slippage_bps: this.exec.slippageBps };
    }
    // Limit orders only fill at their price or better (1% allowance for the fee and spread). Stops always exit.
    if (r.kind === "limit_buy" || r.kind === "limit_sell" || r.kind === "take_profit") {
      const q = await this.exec.quote(req);
      if (!q.ok || !q.quote) { await this.fail(r, q.refused?.code ?? "no_quote", q.refused?.reason ?? "No quote."); return; }
      const units = BUY_KINDS.includes(r.kind) ? Number(q.quote.buy_amount) / 10 ** t.decimals : Number(req.sell_amount) / 10 ** t.decimals;
      const eff = (q.quote.usd_value ?? 0) / units;
      if (r.kind === "limit_buy" ? eff > r.trigger_price! * 1.01 : eff < r.trigger_price! * 0.99) return; // the market moved back; keep waiting
    }
    if (await this.overShare(r, BUY_KINDS.includes(r.kind) ? r.amount_usd! : (Number(req.sell_amount) / 10 ** t.decimals) * price)) return;
    const res = await this.exec.swap(req, r.by ? { by: r.by } : undefined);
    if (!res.ok) { await this.fail(r, res.refused?.code ?? "swap_failed", res.refused?.reason ?? "Swap failed."); return; }
    const usd = res.quote?.usd_value ?? undefined;
    const now = new Date(this.now());
    const buy = BUY_KINDS.includes(r.kind);
    const units = buy ? Number(res.quote?.buy_amount ?? 0) / 10 ** t.decimals : Number(req.sell_amount) / 10 ** t.decimals;
    const updated = await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id)!;
      x.state.fills.push({ ts: now.toISOString(), ok: true, usd, tx: res.tx, paper: this.exec.mode === "paper", side: buy ? "buy" : "sell", units });
      x.state.fills = x.state.fills.slice(-50);
      tally(x, buy ? "buy" : "sell", usd, units);
      if (buy) x.state.bought_atomic = (BigInt(x.state.bought_atomic ?? "0") + BigInt(String(res.quote?.buy_amount ?? "0"))).toString();
      x.state.runs += 1; x.state.failures = 0; x.state.last_error = undefined; x.state.hold_until = undefined;
      if (x.kind === "dca") {
        x.state.next_run = nextRun(x, now).toISOString();
        if (x.times && x.state.runs >= x.times) x.status = "done";
      } else if (x.kind === "signal_buy" || x.kind === "signal_sell") {
        // 0.9.9: a signal rule waits for the signal to clear before it can fire again, up to `times` (default once).
        x.state.alert_armed = false; x.state.last_alert = now.toISOString();
        if (x.state.runs >= (x.times ?? 1)) x.status = "done";
      } else x.status = "done";
      if (x.group && x.status === "done") for (const s of rs) if (s.id !== x.id && s.group === x.group && (s.status === "active" || s.status === "paused" || s.status === "proposed")) {
        s.status = "cancelled"; s.state.last_error = `Cancelled because rule ${x.id} in the same group filled.`;
      }
      return { ...x };
    });
    this.o.onEvent?.({ type: "filled", rule: updated, detail: `${this.exec.mode === "paper" ? "Paper fill" : "Filled"} at about $${price}${usd ? ` for $${usd.toFixed(2)}` : ""}${res.tx ? ` (${res.tx})` : ""}` });
  }

  /**
   * 0.9.3: grids, Smart DCA, rebalancers, infinity grids and split orders. One trade per check, decided by
   * src/botlogic.ts (the same code Tollkit's server runs for them 24/7 on Solana). A bot sells only coins it bought
   * itself, except a split sell, which sells a share of what the owner holds (Autopilot's coins left alone).
   */
  private async bot(r: Rule, t: Token, p: number) {
    if (r.state.next_run && Date.parse(r.state.next_run) > this.now()) return; // backing off after a failure
    const usdc = KNOWN[r.chain].USDC!, now = this.now();
    const st: BotState = { ...(r.state.bot ?? {}), ...(r.kind === "grid" && r.state.grid ? { grid: r.state.grid } : {}) };
    let avail: bigint | undefined;
    if (r.kind === "twap" && r.side === "sell" && st.sell_total === undefined) {
      let bal = await this.exec.balance(r.chain, t);
      if (t.address === NATIVE_EVM || t.address === WSOL) bal = bal > GAS_RESERVE[r.chain] ? bal - GAS_RESERVE[r.chain] : 0n;
      avail = sellableFor(r, bal, this.store.list(), t, this.exec.mode === "paper");
    }
    const a = decide(r as any, st, p, now, { decimals: t.decimals, avail });
    if (!a) {
      if (r.kind === "twap" && r.side === "sell" && avail !== undefined && avail <= 0n) await this.hold(r, now + 5 * 60_000, nothingToSell(r, t.symbol, 0n));
      return;
    }
    const save = async (fn: (x: Rule, next: BotState) => void, next: BotState) => this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id)!;
      if (x.kind === "grid") { x.state.grid = next.grid; const { grid: _g, ...rest } = next; x.state.bot = rest; } else x.state.bot = next;
      fn(x, next);
      return { ...x };
    });
    if (a.side === "mark") { await save(() => {}, applyFill(r as any, st, a, { usd: 0, got: 0n }, p, now, t.decimals).state); return; }
    let req: SwapRequest;
    // 0.9.6: Grid, Infinity grid and Smart DCA trades ask for the bot fee (0.25%).
    const bot = LOW_FEE_BOTS.includes(r.kind) ? { bot: true } : {};
    if (a.side === "buy") req = { chain: r.chain, sell_token: usdc.address, buy_token: t.address, sell_amount: toAtomic(a.usd.toFixed(6), 6), slippage_bps: this.exec.slippageBps, ...bot };
    else {
      let amt = BigInt(a.atomic);
      // 0.9.9: grids too: a bot never sells more than is held and is its owner's to sell (another rule may have sold it).
      {
        let bal = await this.exec.balance(r.chain, t);
        if (t.address === NATIVE_EVM || t.address === WSOL) bal = bal > GAS_RESERVE[r.chain] ? bal - GAS_RESERVE[r.chain] : 0n;
        const may = sellableFor(r, bal, this.store.list(), t, this.exec.mode === "paper");
        // Less than a tenth of the level left (another rule sold the rest): wait rather than sell dust.
        if (amt > may && may * 10n < amt) { await this.hold(r, now + 5 * 60_000, may > 0n ? `Most of the ${t.symbol} for this level was sold by another rule; waiting.` : nothingToSell(r, t.symbol, bal)); return; }
        if (amt > may) amt = may;
      }
      req = { chain: r.chain, sell_token: t.address, buy_token: usdc.address, sell_amount: amt.toString(), slippage_bps: this.exec.slippageBps, ...bot };
    }
    if (await this.overShare(r, a.side === "buy" ? a.usd : (Number(req.sell_amount) / 10 ** t.decimals) * p)) return;
    const res = await this.exec.swap(req, r.by ? { by: r.by } : undefined);
    if (!res.ok) { await this.fail(r, res.refused?.code ?? "swap_failed", res.refused?.reason ?? "Swap failed."); return; }
    const usd = res.quote?.usd_value ?? (a.side === "buy" ? a.usd : (Number(req.sell_amount) / 10 ** t.decimals) * p);
    const got = a.side === "buy" ? BigInt(String(res.quote?.buy_amount ?? "0")) : BigInt(req.sell_amount);
    const units = Number(got) / 10 ** t.decimals;
    const out = applyFill(r as any, st, a, { usd, got }, p, now, t.decimals);
    const updated = await save((x) => {
      x.state.fills.push({ ts: new Date(now).toISOString(), ok: true, usd, tx: res.tx, paper: this.exec.mode === "paper", side: a.side, units });
      x.state.fills = x.state.fills.slice(-50);
      tally(x, a.side, usd, units);
      if (a.side === "buy") x.state.bought_atomic = (BigInt(x.state.bought_atomic ?? "0") + got).toString();
      if (out.profit !== undefined) { x.state.round_trips = (x.state.round_trips ?? 0) + 1; x.state.grid_profit_usd = (x.state.grid_profit_usd ?? 0) + out.profit; }
      x.state.runs += 1; x.state.failures = 0; x.state.last_error = undefined; x.state.next_run = undefined; x.state.hold_until = undefined;
      if (out.done) x.status = "done";
    }, out.state);
    this.o.onEvent?.({ type: "filled", rule: updated, detail: `${a.why} at about $${p}${usd ? ` (${a.side === "buy" ? "spent" : "got"} $${usd.toFixed(2)})` : ""}${res.tx ? ` (${res.tx})` : ""}` });
  }

  /**
   * 0.9.9: the Range bot. Puts its dollars into Orca's SOL/USDC pool between ±range_pct of the price, split so all of
   * it fits (src/clmm.ts shareInA), buying the SOL share with the 0.25% bot fee. While the price stays in range the
   * position earns the pool's trading fees. After recenter_min minutes outside, it takes everything out (coins and
   * fees), swaps back to the right split and opens a new range around the price then. Only the owner can start one,
   * and it runs only on this device: the position is the owner's token and only their key can move it.
   */
  private async range(r: Rule, t: Token, p: number): Promise<void> {
    const lp = this.exec.lp;
    if (!lp) { await this.hold(r, this.now() + 3600_000, this.exec.mode === "paper" ? "Range bots don't run on paper yet." : "This app can't reach Orca yet."); return; }
    if (r.created_by !== "owner") { await this.finishAs(r.id, "cancelled", "Only you can start a Range bot."); return; }
    const st = r.state.range ?? {}, now = this.now();
    if (st.mint) {
      const pos = await lp.read(st.mint);
      // The app stopped while a new position was being sent: it either landed (carry on) or never did (open again).
      if (st.phase === "opening") { await this.saveRange(r, pos ? { phase: undefined } : { phase: undefined, mint: undefined }); r = this.store.get(r.id)!; if (!pos) return this.range(r, t, p); }
      if (!pos) { await this.saveRange(r, { mint: undefined, out_since: undefined, note: "The position was closed outside TOLLkit, so the bot stopped.", event: "The position was closed outside TOLLkit, so the bot stopped." }, "done"); return; }
      const value = pos.sol * p + pos.usdc;
      // 0.9.9: a bot whose first open was retried lost what went in; it's the dollars it started with.
      if (!st.deposited_usd && !st.recenters) await this.saveRange(r, { deposited_usd: r.amount_usd });
      if (!st.ledgered && lp.backfill && st.opened_at && st.lower && st.upper) { await lp.backfill(st.mint, { ts: st.opened_at, usd: st.value_usd ?? r.amount_usd ?? 0, lower: st.lower, upper: st.upper }).catch(() => {}); await this.saveRange(r, { ledgered: true }); }
      // Fees earned so far, looked up every 5 minutes (they're only paid out when the position is touched).
      let pending: { fees_pending_usd?: number; fees_checked_at?: string } = {};
      if (lp.fees && (!st.fees_checked_at || now - Date.parse(st.fees_checked_at) >= 5 * 60_000)) {
        const f = await lp.fees(st.mint).catch(() => null);
        if (f) pending = { fees_pending_usd: (Number(f.sol) / 1e9) * p + Number(f.usdc) / 1e6, fees_checked_at: new Date(now).toISOString() };
      }
      if (pos.inRange) {
        await this.saveRange(r, { in_range: true, out_since: undefined, value_usd: value, sol: pos.sol, usdc: pos.usdc, ...pending,
          ...(st.out_since ? { event: `SOL came back into the range at $${p.toFixed(2)}, so it stays put and keeps earning.` } : {}) });
        return;
      }
      const since = st.out_since ? Date.parse(st.out_since) : now;
      await this.saveRange(r, { in_range: false, out_since: new Date(since).toISOString(), value_usd: value, sol: pos.sol, usdc: pos.usdc, ...pending,
        ...(!st.out_since ? { event: `SOL ${p > (st.upper ?? p) ? "rose above" : "fell below"} the range ($${p.toFixed(2)}). It earns no fees out here; if it stays out ${r.recenter_min ?? 30} minutes, the bot moves the range.` } : {}) });
      if (r.status !== "active" || now - since < (r.recenter_min ?? 30) * 60_000) return;
      let out: Awaited<ReturnType<LpExecutor["close"]>>;
      try { out = await lp.close(st.mint); } catch (e) { await this.fail(r, "lp_failed", (e as Error).message); return; }
      const fees = (Number(out.feesSol) / 1e9) * p + Number(out.feesUsdc) / 1e6;
      await this.saveRange(r, { mint: undefined, out_since: undefined, fees_usd: (st.fees_usd ?? 0) + fees, fees_pending_usd: 0, recenters: (st.recenters ?? 0) + 1, staged: true, recenter_at: [...(st.recenter_at ?? []), new Date(now).toISOString()].slice(-10),
        sol: Number(out.sol) / 1e9, usdc: Number(out.usdc) / 1e6, note: `Price left the range; took out $${value.toFixed(2)} to move it.`,
        event: `Out of range for ${r.recenter_min ?? 30} minutes: took out $${(value + fees).toFixed(2)} (including $${fees.toFixed(2)} in fees) to open a new range around $${p.toFixed(2)}.` });
      r = this.store.get(r.id)!;
    }
    // Open: first with amount_usd of USDC; after a re-center, with what came back out.
    // `staged`: the coins it will put in are in the wallet already (after a re-center, or a swap whose open failed).
    const first = !r.state.range?.staged && !r.state.range?.opened_at;
    if (!first && !r.state.range?.staged) return;
    const pool = await lp.pool();
    const { lower, upper } = rangeTicks(pool.price, r.range_pct!, pool.spacing, DEC_A, DEC_B);
    const lo = tickToPrice(lower, DEC_A, DEC_B), hi = tickToPrice(upper, DEC_A, DEC_B), share = shareInA(pool.price, lo, hi);
    const usdc = KNOWN.solana.USDC!;
    let solHave = first ? 0n : BigInt(Math.floor((r.state.range?.sol ?? 0) * 1e9)), usdcHave = first ? BigInt(toAtomic(r.amount_usd!.toFixed(6), 6)) : BigInt(Math.floor((r.state.range?.usdc ?? 0) * 1e6));
    const total = (Number(solHave) / 1e9) * pool.price + Number(usdcHave) / 1e6, wantSolUsd = total * share, haveSolUsd = (Number(solHave) / 1e9) * pool.price;
    const walletSol = await this.exec.balance("solana", t);
    if (walletSol < solHave + GAS_RESERVE.solana * 3n) { await this.fail(r, "insufficient_balance", "Keep about 0.03 SOL in the wallet for fees and Orca's refundable deposit."); return; }
    if (Math.abs(wantSolUsd - haveSolUsd) >= 1) {
      const buy = wantSolUsd > haveSolUsd, usd = Math.abs(wantSolUsd - haveSolUsd);
      const req: SwapRequest = buy
        ? { chain: "solana", sell_token: usdc.address, buy_token: t.address, sell_amount: toAtomic(usd.toFixed(6), 6), slippage_bps: this.exec.slippageBps, bot: true }
        : { chain: "solana", sell_token: t.address, buy_token: usdc.address, sell_amount: BigInt(Math.floor((usd / pool.price) * 1e9)).toString(), slippage_bps: this.exec.slippageBps, bot: true };
      const res = await this.exec.swap(req, r.by ? { by: r.by } : undefined);
      if (!res.ok) { await this.fail(r, res.refused?.code ?? "swap_failed", res.refused?.reason ?? "Swap failed."); return; }
      const got = BigInt(String(res.quote?.buy_amount ?? "0"));
      if (buy) { usdcHave -= BigInt(req.sell_amount); solHave += got; } else { solHave -= BigInt(req.sell_amount); usdcHave += got; }
      await this.saveRange(r, { staged: true, sol: Number(solHave) / 1e9, usdc: Number(usdcHave < 0n ? 0n : usdcHave) / 1e6,
        event: buy ? `Bought ${(Number(got) / 1e9).toFixed(4)} SOL for $${usd.toFixed(2)}, so the money goes in about ${Math.round(share * 100)}% SOL and ${100 - Math.round(share * 100)}% USDC.`
          : `Sold ${(Number(req.sell_amount) / 1e9).toFixed(4)} SOL for about $${usd.toFixed(2)} to get back to about ${Math.round(share * 100)}% SOL and ${100 - Math.round(share * 100)}% USDC.` });
      await this.store.mutate((rs) => { const x = rs.find((y) => y.id === r.id)!; x.state.fills.push({ ts: new Date(now).toISOString(), ok: true, usd, tx: res.tx, side: buy ? "buy" : "sell", units: Number(buy ? got : BigInt(req.sell_amount)) / 1e9 });
        x.state.fills = x.state.fills.slice(-50); tally(x, buy ? "buy" : "sell", usd, Number(buy ? got : BigInt(req.sell_amount)) / 1e9); });
    }
    // Never ask Orca for more than the wallet holds (a swap can land a little under its quote).
    const usdcBal = await this.exec.balance("solana", usdc), solBal = await this.exec.balance("solana", t);
    if (usdcHave > usdcBal) usdcHave = usdcBal;
    if (usdcHave < 0n) usdcHave = 0n;
    if (solHave > solBal - GAS_RESERVE.solana * 2n) solHave = solBal > GAS_RESERVE.solana * 2n ? solBal - GAS_RESERVE.solana * 2n : 0n;
    let opened: { mint: string; tx: string };
    try { opened = await lp.open({ lower, upper, maxSol: solHave, maxUsdc: usdcHave, beforeSend: (mint) => this.saveRange(r, { phase: "opening", mint, staged: true, sol: Number(solHave) / 1e9, usdc: Number(usdcHave) / 1e6 }) }); }
    catch (e) { await this.saveRange(r, { phase: undefined, mint: undefined }); await this.fail(r, "lp_failed", (e as Error).message); return; }
    await this.saveRange(r, { phase: undefined, staged: undefined, ledgered: true, mint: opened.mint, lower_tick: lower, upper_tick: upper, lower: lo, upper: hi, opened_at: new Date(now).toISOString(), in_range: true,
      out_since: undefined, deposited_usd: r.state.range?.deposited_usd ?? r.amount_usd, value_usd: total, fees_pending_usd: 0, fees_checked_at: new Date(now).toISOString(),
      note: `In Orca's SOL/USDC pool from $${lo.toFixed(2)} to $${hi.toFixed(2)}.`,
      event: `Put about $${total.toFixed(2)} into Orca's SOL/USDC pool between $${lo.toFixed(2)} and $${hi.toFixed(2)}. It earns a share of the pool's trading fees while SOL stays in between.` });
    const updated = this.store.get(r.id)!;
    this.o.onEvent?.({ type: "filled", rule: updated, detail: `Range $${lo.toFixed(2)}–$${hi.toFixed(2)} opened with about $${total.toFixed(2)} (${opened.tx})` });
  }

  /** A stopped Range bot: everything back to the wallet. */
  private async rangeWithdraw(r: Rule) {
    const lp = this.exec.lp; if (!lp || !r.state.range?.mint) return;
    const p = r.state.last_price ?? (await lp.pool()).price;
    const out = await lp.close(r.state.range.mint);
    const back = (Number(out.sol) / 1e9) * p + Number(out.usdc) / 1e6, fees = (Number(out.feesSol) / 1e9) * p + Number(out.feesUsdc) / 1e6;
    await this.saveRange(r, { mint: undefined, out_since: undefined, in_range: undefined, value_usd: 0, fees_usd: (r.state.range.fees_usd ?? 0) + fees,
      note: `Took out about $${back.toFixed(2)} (${out.sol > 0n ? `${(Number(out.sol) / 1e9).toFixed(4)} SOL and ` : ""}${(Number(out.usdc) / 1e6).toFixed(2)} USDC) back to your wallet.`, fees_pending_usd: 0,
      event: `Stopped: took out about $${back.toFixed(2)} (including $${fees.toFixed(2)} in fees) back to your wallet.` });
    this.o.onEvent?.({ type: "cancelled", rule: this.store.get(r.id)!, detail: `Range bot stopped: about $${back.toFixed(2)} back in your wallet (${out.tx})` });
  }

  private async saveRange(r: Rule, u: Partial<NonNullable<Rule["state"]["range"]>> & { note?: string; event?: string }, status?: "done") {
    const { note, event, ...rest } = u;
    await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id); if (!x) return;
      const next: Record<string, unknown> = { ...(x.state.range ?? {}) };
      for (const [k, v] of Object.entries(rest)) if (v === undefined) delete next[k]; else next[k] = v;
      if (event) next.log = [...((next.log as { ts: string; text: string }[] | undefined) ?? []), { ts: new Date(this.now()).toISOString(), text: event }].slice(-20);
      x.state.range = next as any;
      if (note) x.state.note = note;
      x.state.failures = 0; x.state.last_error = undefined; x.state.next_run = undefined;
      if (status) x.status = status;
    });
  }

  /**
   * 0.9.1: an alert only notifies. It fires when its condition holds, then waits for the condition to clear before it
   * can fire again (and never more than once an hour). A crossing alert set while the price is already across waits
   * for it to cross back first, so it reports a real cross.
   */
  private async alert(r: Rule, t: Token, p: number) {
    let closes: number[] | null = null;
    if (r.alert !== "above" && r.alert !== "below") { try { closes = await (this.o.hourly ?? ((c, tk) => hourlyCloses(c, tk)))(r.chain, t); } catch { closes = null; } }
    const c = checkAlert(r, p, closes), now = this.now();
    let armed = r.state.alert_armed ?? (r.alert === "ma_up" || r.alert === "ma_down" ? !c.hit : true);
    const since = r.state.last_alert ? now - Date.parse(r.state.last_alert) : Infinity;
    const fire = armed && c.hit && since >= 3600_000;
    if (!fire && !armed && c.clear) armed = true;
    const updated = await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id)!;
      x.state.alert_now = c.now;
      if (fire) { x.state.alert_armed = false; x.state.last_alert = new Date(now).toISOString(); x.state.alert_count = (x.state.alert_count ?? 0) + 1; x.state.runs += 1; x.state.note = `${t.symbol} ${c.detail}`.slice(0, 120); }
      else x.state.alert_armed = armed;
      return { ...x };
    });
    if (fire) this.o.onEvent?.({ type: "alert", rule: updated, detail: `${t.symbol} ${c.detail} (${r.chain[0]!.toUpperCase()}${r.chain.slice(1)}).` });
  }

  /** 0.9.1: wait without counting a failure, with a note on the rule card. */
  private async hold(r: Rule, until: number, note: string) {
    const updated = await this.store.mutate((rs) => { const x = rs.find((y) => y.id === r.id)!; x.state.hold_until = new Date(until).toISOString(); x.state.last_error = note; return { ...x }; });
    this.o.onEvent?.({ type: "skipped", rule: updated, detail: note });
  }

  /** 0.9.1: Autopilot's live trades stop for the day once they reach its share of the daily trading limit. */
  private async overShare(r: Rule, usd: number): Promise<boolean> {
    if (!isAutopilotRule(r) || this.exec.mode !== "live" || isPaperRule(r)) return false;
    const cap = this.o.autopilotDailyCap?.() ?? null;
    if (cap === null) return false;
    const spent = autopilotSpentToday(this.store.list(), this.now());
    if (spent + (Number.isFinite(usd) ? usd : 0) <= cap + 0.005) return false;
    const midnight = new Date(this.now()); midnight.setUTCHours(24, 0, 30, 0);
    await this.hold(r, midnight.getTime(), `Autopilot used its share of today's trading limit ($${spent.toFixed(2)} of $${cap.toFixed(2)}). It picks up again tomorrow; your own rules keep the rest.`);
    return true;
  }

  /** Back off after a failure. Stops retry fast; anything else slows down and stops after 5 tries. */
  private async fail(r: Rule, code: string, reason: string) {
    reason = plainError(reason, r.chain);
    if (r.kind === "range") await this.store.mutate((rs) => { const x = rs.find((y) => y.id === r.id); if (!x) return; const g = x.state.range ?? {};
      x.state.range = { ...g, log: [...(g.log ?? []), { ts: new Date(this.now()).toISOString(), text: `Couldn't go ahead: ${reason} It tries again in 5 minutes.` }].slice(-20) }; });
    const urgent = r.kind === "stop_loss" || r.kind === "trailing_stop";
    const wait = code === "over_daily_limit" ? 3600_000 : urgent ? 60_000 : 300_000;
    const updated = await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id)!;
      x.state.failures += 1; x.state.last_error = reason; x.state.fail_count = (x.state.fail_count ?? 0) + 1;
      x.state.fills.push({ ts: new Date(this.now()).toISOString(), ok: false, reason });
      x.state.fills = x.state.fills.slice(-50);
      if (code === "denied") { x.status = "paused"; x.state.last_error = "You denied this trade, so the rule is paused."; }
      else if (!urgent && x.state.failures >= 5) x.status = "error";
      else x.state.next_run = new Date(this.now() + wait).toISOString();
      return { ...x };
    });
    this.o.onEvent?.({ type: "failed", rule: updated, detail: reason });
  }

  private async finishAs(id: string, status: "cancelled", why: string) {
    const r = await this.store.mutate((rs) => { const x = rs.find((y) => y.id === id)!; x.status = status; x.state.last_error = why; return { ...x }; });
    this.o.onEvent?.({ type: "cancelled", rule: r, detail: why });
  }

  private async finish(id: string, status: "expired", why: string) {
    const r = await this.store.mutate((rs) => { const x = rs.find((y) => y.id === id)!; x.status = status; x.state.last_error = why; return { ...x }; });
    this.o.onEvent?.({ type: status, rule: r, detail: why });
  }

  private async record(id: string, u: { price?: number; high?: number; checked?: boolean; error?: string }) {
    await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === id); if (!x) return;
      if (u.price !== undefined) x.state.last_price = u.price;
      if (u.high !== undefined) x.state.high = u.high;
      if (u.checked) x.state.last_checked = new Date(this.now()).toISOString();
      if (u.error) x.state.last_error = u.error;
    });
  }
}

/** Running totals for a rule's trades. */
function tally(x: Rule, side: "buy" | "sell", usd: number | undefined, units: number) {
  x.state.ok_count = (x.state.ok_count ?? 0) + 1;
  if (side === "buy") { x.state.spent_usd = (x.state.spent_usd ?? 0) + (usd ?? 0); x.state.bought_units = (x.state.bought_units ?? 0) + units; }
  else { x.state.received_usd = (x.state.received_usd ?? 0) + (usd ?? 0); x.state.sold_units = (x.state.sold_units ?? 0) + units; }
}

/** Token balances for live sells (native coin or token), straight from public RPCs. */
export async function liveBalance(addresses: { evm: string; solana: string }, chain: Chain, t: Token, rpc?: string, f: typeof fetch = fetch): Promise<bigint> {
  if (chain === "solana") {
    const conn = new Connection(rpc ?? DEFAULT_RPC.solana, "confirmed");
    const owner = new PublicKey(addresses.solana);
    if (t.address === WSOL) return BigInt(await conn.getBalance(owner, "confirmed"));
    const accts = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(t.address) }, "confirmed");
    return accts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  const call = async (method: string, params: unknown[]) => {
    const r = await f(rpc ?? DEFAULT_RPC[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j: any = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  };
  if (t.address === NATIVE_EVM) return BigInt(await call("eth_getBalance", [addresses.evm, "latest"]));
  return BigInt(await call("eth_call", [{ to: t.address, data: "0x70a08231" + addresses.evm.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
}
