/**
 * 0.9.2: "Keep running when closed" on Solana (SOL against USDC). The server half is x402-starter src/always-sol.ts.
 *
 * Solana has no permission slips like Base's, so this uses the token program's own allowance: this wallet signs,
 * from this device, "Tollkit's key for this wallet may move up to X USDC" (for buys) and "up to Y wrapped SOL" (for
 * sells). The chain enforces those caps. The server builds each swap so the coins come back to this wallet's own
 * accounts and checks that before it signs. What stays true:
 *   - the coins never leave this wallet except into a swap whose output lands back here;
 *   - Tollkit can never move more than the allowance; the owner can cut it to zero at any time (Revoke);
 *   - SOL set aside for a sell is "wrapped" (a token account in this wallet). Turning it off unwraps it all.
 * Buys land as wrapped SOL too (that's how the swap pays out); turning it off unwraps that as well.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Connection, PublicKey, SystemProgram, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createRevokeInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createKeyPairFromBytes, getBase58Decoder, signBytes } from "@solana/kit";
import { walletHome } from "./paths.js";
import { sendAndConfirm } from "./solconfirm.js";
import { applyFills, type ServerFill } from "./alwayson.js";
import { autopilotUnits, isAutopilotRule } from "./ownership.js";
import type { Rule, RuleStore } from "./rules.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const KINDS = ["dca", "limit_buy", "limit_sell", "take_profit", "stop_loss"];
/** SOL kept unwrapped for network fees and account rent. */
export const SOL_RESERVE = 20_000_000n; // 0.02 SOL

export interface SolConfig { enabled: boolean; delegate: string | null; fee_bps?: number; reason?: string }
export interface TokenAcct { exists: boolean; amount: bigint; delegate: string | null; delegated: bigint }
/** The chain, as this client needs it (tests stand in for it). */
export interface SolChain { lamports(owner: string): Promise<bigint>; token(account: string): Promise<TokenAcct>; send(ixs: TransactionInstruction[]): Promise<string> }
interface Local {
  rules: Record<string, true>; usd_cap: number; dirty?: boolean;
  /** Lamports set aside per sell rule, fixed when it was turned on (a share of the balance then), and what it was fixed for. */
  set_aside?: Record<string, { key: string; lamports: string }>;
  running?: string[]; problems?: Record<string, string>; last_sync?: string; last_error?: string | null; last_tx?: string;
  seen_fills?: string[]; held?: { usdc_allowed: string; wsol_allowed: string; wsol_balance: string };
}
export interface SolAlwaysOpts {
  key: () => Keypair; address: string; dir?: string; rpc: string; fetch?: typeof fetch; proxy: string;
  rules: () => RuleStore; chain?: SolChain; now?: () => number;
}

const isBuy = (r: Pick<Rule, "kind">) => r.kind === "dca" || r.kind === "limit_buy";
const usdcAtomic = (usd: number) => BigInt(Math.round(usd * 1e6));

/** Which Solana rules the server can run, and why not otherwise (shown on the rule card). */
export function solRunnable(r: Rule): string | null {
  if (r.chain !== "solana") return "Not a Solana rule.";
  if (String(r.token).toUpperCase() !== "SOL") return "Only SOL rules can run 24/7 on Solana for now.";
  if (!KINDS.includes(r.kind)) return "This kind of rule runs only while the app is open.";
  if (r.after || r.sell_from) return "Rules that wait for another rule run only while the app is open.";
  if (isBuy(r) && !r.amount_usd) return "Needs a dollar amount.";
  if (r.kind !== "dca" && !r.trigger_price) return "Needs a trigger price.";
  if (!isBuy(r) && r.sell_amount === undefined && r.sell_percent === undefined) return "Needs an amount to sell.";
  return null;
}

/** How much SOL a sell rule sets aside, from the SOL free to use now (a share) or its fixed amount. */
export function sellLamports(r: Rule, free: bigint): bigint {
  const want = r.sell_percent !== undefined ? (free * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : BigInt(Math.round(Number(r.sell_amount) * 1e9));
  return want > free ? free : want;
}
/**
 * Sells that share coins count once, at the largest: a linked pair (a take-profit and its stop-loss), and every sell
 * of a share of the balance ("sell all", "sell half"), since whichever fires first sells from the same SOL.
 * Sells of a fixed amount each get their own.
 */
export const shareKey = (r: Pick<Rule, "id" | "group" | "sell_percent" | "by">) => (isAutopilotRule(r as Rule) ? "ap:" : "") + (r.group || (r.sell_percent !== undefined ? "share-of-balance" : r.id));
export function wrapTarget(rules: Rule[], amounts: Record<string, bigint>): bigint {
  const by = new Map<string, bigint>();
  for (const r of rules) { const k = shareKey(r), a = amounts[r.id] ?? 0n; if (a > (by.get(k) ?? 0n)) by.set(k, a); }
  return [...by.values()].reduce((s, a) => s + a, 0n);
}

export class SolAlwaysOn {
  private file: string;
  private cfg: SolConfig | null = null;
  private syncing: Promise<unknown> | null = null;
  constructor(private readonly o: SolAlwaysOpts) { this.file = path.join(walletHome(o.dir), "always-sol.json"); }
  private now() { return this.o.now?.() ?? Date.now(); }
  private get f(): typeof fetch { return this.o.fetch ?? ((i: any, n?: any) => fetch(i, n)); }
  private get owner() { return new PublicKey(this.o.address); }
  private ata(mint: string) { return getAssociatedTokenAddressSync(new PublicKey(mint), this.owner); }

  private get chain(): SolChain {
    if (this.o.chain) return this.o.chain;
    const conn = new Connection(this.o.rpc, "confirmed");
    return {
      lamports: async (a) => BigInt(await conn.getBalance(new PublicKey(a), "confirmed")),
      token: async (a) => {
        const info = ((await conn.getParsedAccountInfo(new PublicKey(a), "confirmed")).value?.data as any)?.parsed?.info;
        if (!info) return { exists: false, amount: 0n, delegate: null, delegated: 0n };
        return { exists: true, amount: BigInt(info.tokenAmount?.amount ?? "0"), delegate: info.delegate ?? null, delegated: BigInt(info.delegatedAmount?.amount ?? "0") };
      },
      send: (ixs) => sendAndConfirm(conn, new Transaction().add(...ixs), [this.o.key()]),
    };
  }

  private load(): Local {
    try { if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* start over */ }
    return { rules: {}, usd_cap: 0 };
  }
  private update<T>(fn: (l: Local) => T): T {
    const l = this.load(), out = fn(l);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(l, null, 2), { mode: 0o600 }); renameSync(t, this.file);
    return out;
  }

  /** Whether the server runs Solana rules for this wallet. Null: unreachable. */
  async config(): Promise<SolConfig | null> {
    try {
      const r = await this.f(`${this.o.proxy}/always/solana/config?address=${this.o.address}`, { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json().catch(() => null)) as SolConfig | null;
      this.cfg = r.ok && j ? j : { enabled: false, delegate: null, reason: (j as any)?.error ?? `HTTP ${r.status}` };
      return this.cfg;
    } catch { return null; }
  }

  view() {
    const l = this.load(), h = l.held;
    return { rules: Object.keys(l.rules), usd_cap: l.usd_cap, config: this.cfg, running: l.running ?? [], problems: l.problems ?? {}, last_sync: l.last_sync ?? null, last_error: l.last_error ?? null, last_tx: l.last_tx ?? null,
      // What Tollkit may move right now, as the chain last reported it.
      held: h ? { usdc_allowed: Number(h.usdc_allowed) / 1e6, wsol_allowed: Number(h.wsol_allowed) / 1e9, wsol_balance: Number(h.wsol_balance) / 1e9 } : null };
  }
  isOn(id: string) { return !!this.load().rules[id]; }
  serverRuns(id: string) { return (this.load().running ?? []).includes(id); }
  anyOn() { const l = this.load(); return Object.keys(l.rules).length > 0 || (l.running ?? []).length > 0 || !!(l.held && (l.held.usdc_allowed !== "0" || l.held.wsol_balance !== "0")); }
  noteError(m: string) { this.update((l) => { l.last_error = m.slice(0, 300); }); }

  /** The owner flips the switch on a Solana rule. `usd_cap`: the most USDC Tollkit may spend on buys (refilled when the app opens). */
  set(id: string, on: boolean, usd_cap?: number) {
    if (usd_cap !== undefined && !(usd_cap > 0 && usd_cap <= 100_000)) throw new Error("Pick an amount between $1 and $100,000.");
    this.update((l) => {
      if (on) l.rules[id] = true; else { delete l.rules[id]; if (l.set_aside) delete l.set_aside[id]; }
      if (usd_cap !== undefined) l.usd_cap = usd_cap;
      l.dirty = true;
    });
  }

  /** Signed request: this wallet's Solana key over the route, the time and this exact body. */
  private async call(route: string, body: unknown): Promise<any> {
    const text = JSON.stringify({ ...(body as object), _n: randomUUID() }), ts = Math.floor(this.now() / 1000);
    const msg = `Tollkit Always On Solana\n${route}\n${this.o.address}\n${ts}\n${createHash("sha256").update(text).digest("hex")}`;
    const kp = await createKeyPairFromBytes(this.o.key().secretKey);
    const sig = getBase58Decoder().decode(await signBytes(kp.privateKey, new TextEncoder().encode(msg)));
    const r = await this.f(`${this.o.proxy}/always/solana/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-tk-address": this.o.address, "x-tk-ts": String(ts), "x-tk-sig": sig }, body: text, signal: AbortSignal.timeout(60_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error ?? `Tollkit's server answered HTTP ${r.status}`), { status: r.status });
    return j;
  }

  /**
   * Turn it all off: the server drops the rules, then this wallet cancels the USDC allowance and unwraps every
   * wrapped SOL back into plain SOL (closing that account also ends its allowance).
   */
  async off(): Promise<{ tx: string | null }> {
    let serverErr: string | null = null;
    await this.call("off", {}).catch((e) => { serverErr = (e as Error).message; });
    const usdc = this.ata(USDC_MINT), wsol = this.ata(WSOL_MINT);
    const [u, w] = await Promise.all([this.chain.token(usdc.toBase58()), this.chain.token(wsol.toBase58())]);
    const ixs: TransactionInstruction[] = [];
    if (u.exists && u.delegate) ixs.push(createRevokeInstruction(usdc, this.owner));
    if (w.exists) ixs.push(createCloseAccountInstruction(wsol, this.owner, this.owner));
    let tx: string | null = null;
    if (ixs.length) tx = await this.chain.send(ixs);
    this.update((x) => { x.rules = {}; x.set_aside = {}; x.running = []; x.problems = {}; x.dirty = false; x.last_error = serverErr ? `Tollkit's server: ${serverErr}` : null; x.held = { usdc_allowed: "0", wsol_allowed: "0", wsol_balance: "0" }; if (tx) x.last_tx = tx; });
    return { tx };
  }

  async sync(): Promise<{ fills: ServerFill[]; running: string[]; problems: Record<string, string> }> {
    if (this.syncing) await this.syncing.catch(() => {});
    const p = this.doSync();
    this.syncing = p;
    try { return await p; } finally { if (this.syncing === p) this.syncing = null; }
  }

  private async doSync() {
    const cfg = await this.config();
    const l0 = this.load();
    if (!cfg) return { fills: [], running: l0.running ?? [], problems: l0.problems ?? {} };
    const store = this.o.rules();
    const problems: Record<string, string> = {};
    if (!cfg.enabled || !cfg.delegate) {
      for (const id of Object.keys(l0.rules)) problems[id] = cfg.reason ?? "Tollkit isn't running Solana rules 24/7 yet.";
      this.update((l) => { l.running = []; l.problems = problems; });
      return { fills: [], running: [], problems };
    }
    // 1. What the server did since last time.
    let state: any;
    try { state = await this.call("state", {}); }
    catch (e) { this.update((l) => { l.last_error = (e as Error).message.slice(0, 300); }); return { fills: [], running: l0.running ?? [], problems: l0.problems ?? {} }; }
    const fresh: ServerFill[] = this.update((l) => { const seen = new Set(l.seen_fills ?? []); const n = (state.fills ?? []).filter((f: ServerFill) => f.id && !seen.has(f.id)); l.seen_fills = [...seen, ...n.map((f: ServerFill) => f.id!)].slice(-1000); return n; });
    if (fresh.length) await applyFills(store, fresh);
    if (state.delegate !== cfg.delegate) throw new Error("Tollkit's server named a different key than before; not changing anything.");

    // 2. Which rules, and what each needs allowed.
    const l = this.load();
    const want = store.list().filter((r) => l.rules[r.id] && (r.status === "active" || r.status === "paused"));
    const active: Rule[] = [];
    for (const r of want) {
      const why = solRunnable(r);
      if (why) { problems[r.id] = why; continue; }
      if (r.status === "active" && !state.rules?.[r.id]?.done) active.push(r);
    }
    const delegate = new PublicKey(cfg.delegate);
    const usdcA = this.ata(USDC_MINT), wsolA = this.ata(WSOL_MINT);
    const [usdc, wsol, lamports] = await Promise.all([this.chain.token(usdcA.toBase58()), this.chain.token(wsolA.toBase58()), this.chain.lamports(this.o.address)]);
    const ours = (a: TokenAcct) => a.delegate === cfg.delegate;
    const ixs: TransactionInstruction[] = [];
    let wsolAllowed = ours(wsol) ? wsol.delegated : 0n, wsolBal = wsol.amount, usdcAllowed = ours(usdc) ? usdc.delegated : 0n;
    let wsolMade = wsol.exists;

    // Buys: USDC allowance up to the owner's cap, refilled once it can't cover the largest buy.
    const buys = active.filter(isBuy);
    if (buys.length) {
      const cap = usdcAtomic(l.usd_cap || 0), perTrade = buys.reduce((m, r) => (usdcAtomic(r.amount_usd!) > m ? usdcAtomic(r.amount_usd!) : m), 0n);
      if (cap === 0n) for (const r of buys) problems[r.id] = "Set how much it can spend first.";
      else if (!usdc.exists || usdc.amount < perTrade) for (const r of buys) problems[r.id] = `Run 24/7 needs at least $${(Number(perTrade) / 1e6).toFixed(2)} of USDC on Solana for one buy. You have $${(Number(usdc.amount) / 1e6).toFixed(2)}.`;
      else if (usdcAllowed < perTrade || (l.dirty && usdcAllowed !== cap)) { ixs.push(createApproveInstruction(usdcA, delegate, this.owner, cap)); usdcAllowed = cap; }
      // The bought SOL lands in the wrapped-SOL account: make it now, at the owner's cost, so the server never pays its rent.
      if (!wsolMade && !buys.every((r) => problems[r.id])) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, wsolA, this.owner, new PublicKey(WSOL_MINT))); wsolMade = true; }
    } else if (usdcAllowed > 0n) { ixs.push(createRevokeInstruction(usdcA, this.owner)); usdcAllowed = 0n; }

    // Sells: wrap the SOL each one may sell (fixed when it's turned on), and allow exactly that much.
    const sells = active.filter((r) => !isBuy(r));
    const sigKey = (r: Rule) => JSON.stringify([r.kind, r.sell_amount, r.sell_percent, r.trigger_price, r.group, r.state.runs]);
    const free = lamports > SOL_RESERVE ? lamports - SOL_RESERVE : 0n;
    const set: Record<string, { key: string; lamports: string }> = {};
    const amounts: Record<string, bigint> = {};
    // Rules already set aside keep their amount; new ones share what's left (a pair shares one amount). 0.9.2: as on
    // the device (src/ownership.ts), Autopilot's sells draw only on SOL its strategies bought; the owner's on the rest.
    const all = free + wsolBal, apHeld = BigInt(Math.floor(autopilotUnits(store.list(), "solana", "SOL", WSOL_MINT) * 1e9));
    const pools = { ap: apHeld < all ? apHeld : all, own: 0n };
    pools.own = all - pools.ap;
    const pool = (r: Rule): "ap" | "own" => (isAutopilotRule(r) ? "ap" : "own");
    const keep = sells.filter((r) => l.set_aside?.[r.id]?.key === sigKey(r));
    const counted = new Set<string>();
    for (const r of keep) { const a = BigInt(l.set_aside![r.id]!.lamports), g = pool(r) + shareKey(r); amounts[r.id] = a; if (!counted.has(g)) { counted.add(g); pools[pool(r)] -= a; } }
    for (const r of sells) {
      if (amounts[r.id] === undefined) {
        const k = pool(r), g = k + shareKey(r), mate = sells.find((x) => x.id !== r.id && pool(x) + shareKey(x) === g && amounts[x.id] !== undefined);
        const a = mate ? amounts[mate.id]! : sellLamports(r, pools[k] > 0n ? pools[k] : 0n);
        if (!mate && a > 0n) { counted.add(g); pools[k] -= a; }
        amounts[r.id] = a;
      }
      if (amounts[r.id]! <= 0n) { problems[r.id] = isAutopilotRule(r) ? "Autopilot's strategies hold no SOL of their own to sell yet." : "No SOL left to set aside for this sell (0.02 SOL stays for fees; SOL Autopilot bought stays with it)."; delete amounts[r.id]; continue; }
      set[r.id] = { key: sigKey(r), lamports: amounts[r.id]!.toString() };
    }
    const target = wrapTarget(sells.filter((r) => !problems[r.id]), amounts);
    if (target > 0n) {
      if (wsolBal < target) {
        const add = target - wsolBal;
        if (add > free) for (const r of sells) problems[r.id] ??= `Not enough SOL: setting this aside needs ${(Number(add) / 1e9).toFixed(4)} SOL more, plus 0.02 SOL for fees.`;
        else {
          if (!wsolMade) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, wsolA, this.owner, new PublicKey(WSOL_MINT))); wsolMade = true; }
          ixs.push(SystemProgram.transfer({ fromPubkey: this.owner, toPubkey: wsolA, lamports: add }), createSyncNativeInstruction(wsolA));
          wsolBal = target;
        }
      }
      if (!sells.some((r) => problems[r.id]?.startsWith("Not enough SOL")) && wsolAllowed !== target) { ixs.push(createApproveInstruction(wsolA, delegate, this.owner, target)); wsolAllowed = target; }
    } else if (Object.keys(l.rules).length === 0 && wsol.exists && wsolBal > 0n) {
      // Nothing on 24/7 any more (Autopilot turned off, or every switch off): unwrap it all back to plain SOL.
      ixs.push(createCloseAccountInstruction(wsolA, this.owner, this.owner)); wsolAllowed = 0n; wsolBal = 0n;
    } else if (wsolAllowed > 0n) { ixs.push(createRevokeInstruction(wsolA, this.owner)); wsolAllowed = 0n; }

    // 3. One transaction from this wallet for every change, then the rules to the server.
    let tx: string | undefined;
    if (ixs.length) {
      try { tx = await this.chain.send(ixs); }
      catch (e) {
        const m = `Couldn't set the allowance: ${(e as Error).message.slice(0, 160)}`;
        for (const r of active) problems[r.id] ??= m;
        this.update((x) => { x.problems = problems; x.last_error = m; });
        return { fills: fresh, running: l0.running ?? [], problems };
      }
    }
    const send = active.filter((r) => !problems[r.id]);
    const body = { rules: send.map((r) => ({ id: r.id, kind: r.kind, token: "SOL", amount_usd: r.amount_usd, sell_amount: !isBuy(r) ? Number(amounts[r.id] ?? 0n) / 1e9 : undefined, trigger_price: r.trigger_price,
      every: r.every, times: r.times, max_price: r.max_price, group: r.group, expires_at: r.expires_at, runs: r.state.runs, next_run: r.state.next_run })) };
    let running: string[] = l0.running ?? [];
    try { const j = await this.call("sync", body); running = j.running ?? []; }
    catch (e) { for (const r of send) problems[r.id] = (e as Error).message.slice(0, 200); }
    this.update((x) => {
      x.running = running; x.problems = problems; x.set_aside = set; x.last_sync = new Date(this.now()).toISOString(); x.dirty = false; x.last_error = null;
      x.held = { usdc_allowed: usdcAllowed.toString(), wsol_allowed: wsolAllowed.toString(), wsol_balance: wsolBal.toString() };
      if (tx) x.last_tx = tx;
    });
    return { fills: fresh, running, problems };
  }
}
