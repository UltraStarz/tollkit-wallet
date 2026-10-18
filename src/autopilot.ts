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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_RPC, NATIVE_EVM, WSOL, type Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { BUY_KINDS, gridLevels, nextRun, RuleStore, type Rule } from "./rules.js";
import { KNOWN, resolveToken, toAtomic, type Token } from "./tokens.js";
import type { Price } from "./prices.js";
import type { SwapRequest } from "./swap.js";
import type { SwapResult } from "./wallet.js";

export interface Executor {
  mode: "live" | "paper";
  swap(req: SwapRequest): Promise<SwapResult>;
  quote(req: SwapRequest): Promise<SwapResult>;
  balance(chain: Chain, token: Token): Promise<bigint>;
  slippageBps: number;
}
export interface PriceSource { snapshot(): { prices: Record<string, Price> } }

/** Gas kept back when selling a chain's native coin, so the wallet can still pay fees. */
const GAS_RESERVE: Record<Chain, bigint> = { base: 50_000_000_000_000n /* 0.00005 ETH */, ethereum: 2_000_000_000_000_000n /* 0.002 ETH */, arbitrum: 100_000_000_000_000n /* 0.0001 ETH */, polygon: 100_000_000_000_000_000n /* 0.1 POL */, solana: 10_000_000n /* 0.01 SOL */ };
const QUOTE_PRICE_TTL = 60_000;

export interface AutopilotOptions { dir?: string; intervalMs?: number; now?: () => number; leaseId?: string; resolve?: typeof resolveToken; onEvent?: (e: AutopilotEvent) => void }
export interface AutopilotEvent { type: "filled" | "failed" | "skipped" | "expired" | "cancelled"; rule: Rule; detail: string }

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

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.takeLease()) return;
      this.lastTick = new Date(this.now()).toISOString();
      const due = this.store.list().filter((r) => r.status === "active");
      for (const r of due) await this.consider(r).catch((e) => this.record(r.id, { error: (e as Error).message }));
    } finally { this.running = false; }
  }

  private async consider(r: Rule) {
    const now = this.now();
    if (r.expires_at && Date.parse(r.expires_at) <= now) { await this.finish(r.id, "expired", "Expired before it triggered."); return; }
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
    if (r.kind === "grid") { await this.record(r.id, { price: p, checked: true }); await this.grid(r, t, p); return; }
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
    await this.fire(r, t, p);
  }

  private async fire(r: Rule, t: Token, price: number) {
    const usdc = KNOWN[r.chain].USDC!;
    let req: SwapRequest;
    if (BUY_KINDS.includes(r.kind)) {
      req = { chain: r.chain, sell_token: usdc.address, buy_token: t.address, sell_amount: toAtomic(r.amount_usd!.toFixed(6), 6), slippage_bps: this.exec.slippageBps };
    } else {
      let bal = await this.exec.balance(r.chain, t);
      if (t.address === NATIVE_EVM || t.address === WSOL) bal = bal > GAS_RESERVE[r.chain] ? bal - GAS_RESERVE[r.chain] : 0n;
      const from = r.sell_from ? this.store.get(r.sell_from) : undefined;
      let amt = from ? BigInt(from.state.bought_atomic ?? "0") : r.sell_percent !== undefined ? (bal * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : BigInt(toAtomic(r.sell_amount!, t.decimals));
      if (amt > bal) amt = bal;
      if (amt <= 0n) { await this.fail(r, "insufficient_balance", `No ${t.symbol} to sell.`); return; }
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
    const res = await this.exec.swap(req);
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
      x.state.runs += 1; x.state.failures = 0; x.state.last_error = undefined;
      if (x.kind === "dca") {
        x.state.next_run = nextRun(x, now).toISOString();
        if (x.times && x.state.runs >= x.times) x.status = "done";
      } else x.status = "done";
      if (x.group && x.status === "done") for (const s of rs) if (s.id !== x.id && s.group === x.group && (s.status === "active" || s.status === "paused" || s.status === "proposed")) {
        s.status = "cancelled"; s.state.last_error = `Cancelled because rule ${x.id} in the same group filled.`;
      }
      return { ...x };
    });
    this.o.onEvent?.({ type: "filled", rule: updated, detail: `${this.exec.mode === "paper" ? "Paper fill" : "Filled"} at about $${price}${usd ? ` for $${usd.toFixed(2)}` : ""}${res.tx ? ` (${res.tx})` : ""}` });
  }

  /**
   * Grid: levels L0 < L1 < ... from lower_price to upper_price. Slot i buys amount_usd at L(i) and sells those
   * units at L(i+1), then can buy again. One trade per check: sells first (a filled slot whose sell level is
   * reached), then the level the price has just come down to. Below the range it doesn't buy.
   */
  private async grid(r: Rule, t: Token, p: number) {
    const L = gridLevels(r), g = r.state.grid ?? { units: Array(L.length - 1).fill(null), cost: Array(L.length - 1).fill(null), atomic: Array(L.length - 1).fill(null) };
    if (r.state.next_run && Date.parse(r.state.next_run) > this.now()) return; // backing off after a failure
    const usdc = KNOWN[r.chain].USDC!;
    const sellAt = g.atomic.findIndex((a, i) => a !== null && p >= L[i + 1]!);
    if (sellAt >= 0) {
      const req: SwapRequest = { chain: r.chain, sell_token: t.address, buy_token: usdc.address, sell_amount: g.atomic[sellAt]!, slippage_bps: this.exec.slippageBps };
      const res = await this.exec.swap(req);
      if (!res.ok) { await this.fail(r, res.refused?.code ?? "swap_failed", res.refused?.reason ?? "Swap failed."); return; }
      const usd = res.quote?.usd_value ?? undefined, units = Number(req.sell_amount) / 10 ** t.decimals;
      const updated = await this.store.mutate((rs) => {
        const x = rs.find((y) => y.id === r.id)!, gg = x.state.grid!;
        const profit = usd !== undefined && gg.cost[sellAt] != null ? usd - gg.cost[sellAt]! : 0;
        gg.units[sellAt] = null; gg.cost[sellAt] = null; gg.atomic[sellAt] = null;
        x.state.fills.push({ ts: new Date(this.now()).toISOString(), ok: true, usd, tx: res.tx, paper: this.exec.mode === "paper", side: "sell", units });
        x.state.fills = x.state.fills.slice(-50);
        tally(x, "sell", usd, units);
        x.state.round_trips = (x.state.round_trips ?? 0) + 1; x.state.grid_profit_usd = (x.state.grid_profit_usd ?? 0) + profit;
        x.state.runs += 1; x.state.failures = 0; x.state.last_error = undefined; x.state.next_run = undefined;
        return { ...x };
      });
      this.o.onEvent?.({ type: "filled", rule: updated, detail: `Grid sold level ${sellAt + 1} at about $${p}${usd ? ` for $${usd.toFixed(2)}` : ""}` });
      return;
    }
    if (p < L[0]!) return;
    // Buy the level the price has just reached: at or below it, but less than one step below (lower levels wait
    // for the price to get there; levels above today's price were never reached on the way down).
    const step = L[1]! - L[0]!;
    let buyAt = -1;
    for (let i = L.length - 2; i >= 0; i--) if (g.atomic[i] === null && p <= L[i]! && L[i]! - p < step) { buyAt = i; break; }
    if (buyAt < 0) return;
    const req: SwapRequest = { chain: r.chain, sell_token: usdc.address, buy_token: t.address, sell_amount: toAtomic(r.amount_usd!.toFixed(6), 6), slippage_bps: this.exec.slippageBps };
    const res = await this.exec.swap(req);
    if (!res.ok) { await this.fail(r, res.refused?.code ?? "swap_failed", res.refused?.reason ?? "Swap failed."); return; }
    const usd = res.quote?.usd_value ?? undefined, atomic = String(res.quote?.buy_amount ?? "0"), units = Number(atomic) / 10 ** t.decimals;
    const updated = await this.store.mutate((rs) => {
      const x = rs.find((y) => y.id === r.id)!;
      x.state.grid ??= { units: Array(L.length - 1).fill(null), cost: Array(L.length - 1).fill(null), atomic: Array(L.length - 1).fill(null) };
      x.state.grid.units[buyAt] = units; x.state.grid.cost[buyAt] = usd ?? r.amount_usd!; x.state.grid.atomic[buyAt] = atomic;
      x.state.fills.push({ ts: new Date(this.now()).toISOString(), ok: true, usd, tx: res.tx, paper: this.exec.mode === "paper", side: "buy", units });
      x.state.fills = x.state.fills.slice(-50);
      tally(x, "buy", usd, units);
      x.state.runs += 1; x.state.failures = 0; x.state.last_error = undefined; x.state.next_run = undefined;
      return { ...x };
    });
    this.o.onEvent?.({ type: "filled", rule: updated, detail: `Grid bought level ${buyAt + 1} at about $${p}${usd ? ` for $${usd.toFixed(2)}` : ""}` });
  }

  /** Back off after a failure. Stops retry fast; anything else slows down and stops after 5 tries. */
  private async fail(r: Rule, code: string, reason: string) {
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
