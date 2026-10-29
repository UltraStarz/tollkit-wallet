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
 *
 * 0.9.9: any Solana coin the wallet's token list (Jupiter) has verified, besides SOL. Buys spend the same USDC
 * allowance and land in that coin's own account here; sells draw on a capped allowance on that account. Unverified or
 * suspicious coins stay on the device. And "while you're away": each sync tells the server when Autopilot last checked
 * the market here, and the price it saw for each of its rules; the server pauses (never trades) those rules if their coin
 * falls far, or gives back half a rise, while no device is checking. Its notes come back into Autopilot's decisions.
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
import { botBuys, botNewer, isBotKind } from "./botlogic.js";
import { solanaInfo } from "./tokenlist.js";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const KINDS = ["dca", "limit_buy", "limit_sell", "take_profit", "stop_loss"];
/** SOL kept unwrapped for network fees and account rent. */
export const SOL_RESERVE = 20_000_000n; // 0.02 SOL

export interface SolConfig { enabled: boolean; delegate: string | null; fee_bps?: number; reason?: string; kinds?: string[]; coins?: boolean; max_coins?: number }
export interface TokenAcct { exists: boolean; amount: bigint; delegate: string | null; delegated: bigint; decimals?: number }
/** 0.9.9: what the token list says about a coin (src/tokenlist.ts solanaInfo). */
export type CoinInfo = { symbol?: string; decimals?: number; trust?: string; jupiter?: { suspicious?: boolean } } | null;
/** 0.9.9: Autopilot's last check-in here, and how far a coin may move while no device is checking. */
export interface AwayInfo { last_decision: string; drop_pct: number; rise_pct: number }
export interface AwayEntry { ts: string; rule_id: string; text: string }
/** The chain, as this client needs it (tests stand in for it). */
export interface SolChain { lamports(owner: string): Promise<bigint>; token(account: string): Promise<TokenAcct>; send(ixs: TransactionInstruction[]): Promise<string> }
interface Local {
  rules: Record<string, true>; usd_cap: number; dirty?: boolean;
  /** Lamports set aside per sell rule, fixed when it was turned on (a share of the balance then), and what it was fixed for. */
  set_aside?: Record<string, { key: string; lamports: string }>;
  running?: string[]; problems?: Record<string, string>; last_sync?: string; last_error?: string | null; last_tx?: string;
  seen_fills?: string[]; held?: { usdc_allowed: string; wsol_allowed: string; wsol_balance: string; coins?: Record<string, { allowed: string; balance: string; decimals: number; symbol?: string }> };
  /** 0.9.9: coins this wallet has allowed Tollkit to sell (so turning them off revokes them), and away notes already seen. */
  coins_used?: string[]; seen_away?: string[];
}
export interface SolAlwaysOpts {
  key: () => Keypair; address: string; dir?: string; rpc: string; fetch?: typeof fetch; proxy: string;
  rules: () => RuleStore; chain?: SolChain; now?: () => number;
  /** 0.9.9: the token list's view of coins (tests stand in for it). */
  coinInfo?: (mints: string[]) => Promise<Map<string, CoinInfo>>;
}

const isBuy = (r: Pick<Rule, "kind">) => r.kind === "dca" || r.kind === "limit_buy";
/** 0.9.3: grids, Smart DCA, rebalancers, infinity grids and split orders (src/botlogic.ts) run 24/7 too. */
const isBot = (r: Pick<Rule, "kind">) => isBotKind(r.kind);
/** The SOL a bot holds now (smallest units), which it may sell: its own coins, or what's left of a split sell. */
export function botHeld(r: Rule): bigint {
  const b = r.state.bot ?? {};
  if (r.kind === "grid") return (r.state.grid?.atomic ?? []).reduce((a, x) => a + BigInt(x ?? "0"), 0n);
  if (r.kind === "twap") return r.side === "sell" && b.sell_total ? (BigInt(b.sell_total) * BigInt(Math.max(0, (r.pieces ?? 1) - (b.pieces ?? 0)))) / BigInt(r.pieces ?? 1) : 0n;
  return BigInt(b.units ?? "0");
}
const usdcAtomic = (usd: number) => BigInt(Math.round(usd * 1e6));
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** 0.9.9: SOL, or another Solana coin by its mint (null: neither). */
export const isSolRule = (r: Pick<Rule, "token">) => String(r.token).toUpperCase() === "SOL";
export function coinMint(r: Pick<Rule, "token">): string | null {
  const t = String(r.token);
  return !isSolRule(r) && B58.test(t) && t !== USDC_MINT && t !== WSOL_MINT ? t : null;
}

/** Which Solana rules the server can run, and why not otherwise (shown on the rule card). */
export function solRunnable(r: Rule): string | null {
  if (r.chain !== "solana") return "Not a Solana rule.";
  if (!isSolRule(r) && !coinMint(r)) return "Only SOL and Solana coins (by their address) can run 24/7.";
  if (isBot(r)) return r.kind === "twap" && r.side === "sell" ? null : r.amount_usd ? null : "Needs a dollar amount.";
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
        return { exists: true, amount: BigInt(info.tokenAmount?.amount ?? "0"), delegate: info.delegate ?? null, delegated: BigInt(info.delegatedAmount?.amount ?? "0"), decimals: typeof info.tokenAmount?.decimals === "number" ? info.tokenAmount.decimals : undefined };
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
      held: h ? { usdc_allowed: Number(h.usdc_allowed) / 1e6, wsol_allowed: Number(h.wsol_allowed) / 1e9, wsol_balance: Number(h.wsol_balance) / 1e9,
        coins: Object.fromEntries(Object.entries(h.coins ?? {}).map(([m, c]) => [m, { allowed: Number(c.allowed) / 10 ** c.decimals, balance: Number(c.balance) / 10 ** c.decimals, symbol: c.symbol }])) } : null };
  }
  /**
   * 0.9.9: what Tollkit may move, read from the chain without changing anything. The device that runs the bots learns
   * it at each sync; the others call this, so their "SOL set aside" never shows an amount the server already traded.
   */
  async refreshHeld(): Promise<void> {
    const l = this.load();
    if (!l.held && !l.coins_used?.length) return;
    const d = this.cfg?.delegate ?? (await this.config())?.delegate ?? null;
    const [u, w] = await Promise.all([this.chain.token(this.ata(USDC_MINT).toBase58()), this.chain.token(this.ata(WSOL_MINT).toBase58())]);
    const coins: NonNullable<NonNullable<Local["held"]>["coins"]> = {};
    for (const m of l.coins_used ?? []) {
      const a = await this.chain.token(this.ata(m).toBase58()), old = l.held?.coins?.[m];
      coins[m] = { allowed: (d && a.delegate === d ? a.delegated : 0n).toString(), balance: a.amount.toString(), decimals: a.decimals ?? old?.decimals ?? 0, symbol: old?.symbol };
    }
    this.update((x) => { x.held = { usdc_allowed: (d && u.delegate === d ? u.delegated : 0n).toString(), wsol_allowed: (d && w.delegate === d ? w.delegated : 0n).toString(), wsol_balance: w.amount.toString(), coins }; });
  }
  isOn(id: string) { return !!this.load().rules[id]; }
  serverRuns(id: string) { return (this.load().running ?? []).includes(id); }
  /** 0.9.7: switched on for 24/7 and not refused: the device stops trading it now (see src/alwayson.ts). */
  handedOff(id: string) { const l = this.load(); return !!l.rules[id] && !(l.problems ?? {})[id]; }
  anyOn() { const l = this.load(); return Object.keys(l.rules).length > 0 || (l.running ?? []).length > 0 || !!(l.held && (l.held.usdc_allowed !== "0" || l.held.wsol_balance !== "0" || Object.values(l.held.coins ?? {}).some((c) => c.allowed !== "0"))); }
  /** 0.9.9: set by the dashboard: Autopilot's last check-in here (null: Autopilot is off), and where its away notes go. */
  awayInfo?: () => AwayInfo | null;
  onAway?: (entries: AwayEntry[]) => Promise<void> | void;
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
    // 0.9.9: each coin's allowance ends too; the coins themselves stay where they are.
    for (const m of this.load().coins_used ?? []) { const a = this.ata(m), c = await this.chain.token(a.toBase58()); if (c.exists && c.delegate) ixs.push(createRevokeInstruction(a, this.owner)); }
    let tx: string | null = null;
    if (ixs.length) tx = await this.chain.send(ixs);
    this.update((x) => { x.rules = {}; x.set_aside = {}; x.running = []; x.problems = {}; x.dirty = false; x.last_error = serverErr ? `Tollkit's server: ${serverErr}` : null; x.held = { usdc_allowed: "0", wsol_allowed: "0", wsol_balance: "0", coins: {} }; x.coins_used = []; if (tx) x.last_tx = tx; });
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
    // 0.9.3: a bot the server ran carries its own state (what it holds, its next step); the newer copy wins.
    const sb = Object.entries(state.rules ?? {}).filter(([, v]: any) => v && v.bot);
    if (sb.length) await store.mutate((rs) => {
      for (const [id, v] of sb as [string, any][]) {
        const r = rs.find((x) => x.id === id);
        // 0.9.8: a split order's parts done never go backwards (see botNewer); on a tie the server's copy wins.
        if (!r || !isBot(r) || !botNewer(r.kind, r.state.bot, v.bot, true)) continue;
        const { grid, ...rest } = v.bot; r.state.bot = rest; if (r.kind === "grid" && grid) r.state.grid = grid;
        if (v.done && (r.status === "active" || r.status === "paused")) r.status = "done";
      }
    });
    if (state.delegate !== cfg.delegate) throw new Error("Tollkit's server named a different key than before; not changing anything.");
    // 0.9.9: what the server paused while no device was checking, once each, into Autopilot's decisions.
    const awayNew: AwayEntry[] = this.update((x) => { const seen = new Set(x.seen_away ?? []), key = (e: AwayEntry) => `${e.ts}|${e.rule_id}`; const n = (state.away_log ?? []).filter((e: AwayEntry) => e && !seen.has(key(e))); x.seen_away = [...seen, ...n.map(key)].slice(-300); return n; });
    if (awayNew.length && this.onAway) await Promise.resolve(this.onAway(awayNew)).catch(() => {});

    // 2. Which rules, and what each needs allowed.
    const l = this.load();
    const want = store.list().filter((r) => l.rules[r.id] && (r.status === "active" || r.status === "paused"));
    const active: Rule[] = [];
    // 0.9.9: other coins only if the server takes them and the token list has verified them (not flagged as suspicious).
    const mintsWanted = [...new Set(want.map(coinMint).filter((m): m is string => !!m))];
    let info = new Map<string, CoinInfo>();
    if (mintsWanted.length && cfg.coins) try { info = await (this.o.coinInfo ?? ((m) => solanaInfo(m, this.f) as Promise<Map<string, CoinInfo>>))(mintsWanted); } catch { /* treated as unknown below */ }
    const coinWhy = (m: string): string | null => {
      if (!cfg.coins) return "Tollkit's server runs only SOL 24/7 for now; this coin trades while the app is open.";
      const c = info.get(m);
      if (!c) return "Couldn't check this coin with the token list just now; it trades while the app is open and tries 24/7 again later.";
      if (c.jupiter?.suspicious) return "The token list flags this coin as suspicious, so it trades only while the app is open.";
      if (c.trust !== "listed" && c.trust !== "core") return "This coin isn't verified on the token list, so it trades only while the app is open.";
      return null;
    };
    for (const r of want) {
      const m = coinMint(r);
      const why = solRunnable(r) ?? (isBot(r) && !(cfg.kinds ?? []).includes(r.kind) ? "Tollkit's server doesn't run this bot 24/7 yet; it runs while the app is open." : null) ?? (m ? coinWhy(m) : null);
      if (why) { problems[r.id] = why; continue; }
      if (r.status === "active" && !state.rules?.[r.id]?.done) active.push(r);
    }
    const coinActive = active.filter((r) => !isSolRule(r));
    active.splice(0, active.length, ...active.filter(isSolRule), ...coinActive); // SOL first; the SOL steps below see only SOL
    const solActive = active.filter(isSolRule);
    const delegate = new PublicKey(cfg.delegate);
    const usdcA = this.ata(USDC_MINT), wsolA = this.ata(WSOL_MINT);
    const [usdc, wsol, lamports] = await Promise.all([this.chain.token(usdcA.toBase58()), this.chain.token(wsolA.toBase58()), this.chain.lamports(this.o.address)]);
    const ours = (a: TokenAcct) => a.delegate === cfg.delegate;
    const ixs: TransactionInstruction[] = [];
    let wsolAllowed = ours(wsol) ? wsol.delegated : 0n, wsolBal = wsol.amount, usdcAllowed = ours(usdc) ? usdc.delegated : 0n;
    let wsolMade = wsol.exists, usdcRefilled = false;

    // Buys: USDC allowance up to the owner's cap, refilled once it can't cover the largest buy. 0.9.9: every coin's buys
    // draw on the same USDC allowance.
    const bots = solActive.filter(isBot);
    const buys = active.filter((r) => isBuy(r) || (isBot(r) && botBuys(r as any)));
    const solBuys = buys.filter(isSolRule);
    // A bot's next buy: its first one (a rebalancer's set-up, a split buy's part). Later buys draw on the same cap.
    const oneBuy = (r: Rule) => usdcAtomic(!isBot(r) ? r.amount_usd! : r.kind === "rebalance" ? (r.amount_usd! * (r.target_pct ?? 50)) / 100 : r.kind === "twap" ? r.amount_usd! / (r.pieces ?? 1) : r.amount_usd!);
    if (buys.length) {
      const cap = usdcAtomic(l.usd_cap || 0), perTrade = buys.reduce((m, r) => (oneBuy(r) > m ? oneBuy(r) : m), 0n);
      if (cap === 0n) for (const r of buys) problems[r.id] = "Set how much it can spend first.";
      // A bot that holds SOL can keep going on sells alone; everything else needs USDC for its next buy.
      else if (!usdc.exists || usdc.amount < perTrade) for (const r of buys) { if (isBot(r) && botHeld(r) > 0n) continue; problems[r.id] = `Run 24/7 needs at least $${(Number(perTrade) / 1e6).toFixed(2)} of USDC on Solana for one buy. You have $${(Number(usdc.amount) / 1e6).toFixed(2)}.`; }
      else if (usdcAllowed < perTrade || (l.dirty && usdcAllowed !== cap)) { ixs.push(createApproveInstruction(usdcA, delegate, this.owner, cap)); usdcAllowed = cap; usdcRefilled = true; }
      // The bought SOL lands in the wrapped-SOL account: make it now, at the owner's cost, so the server never pays its rent.
      if (!wsolMade && solBuys.length && !solBuys.every((r) => problems[r.id])) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, wsolA, this.owner, new PublicKey(WSOL_MINT))); wsolMade = true; }
    } else if (usdcAllowed > 0n) { ixs.push(createRevokeInstruction(usdcA, this.owner)); usdcAllowed = 0n; }

    // Sells: wrap the SOL each one may sell (fixed when it's turned on), and allow exactly that much.
    const sells = solActive.filter((r) => !isBuy(r) && !isBot(r));
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
    // Bots: wrap the SOL each holds now (or a split sell's total), and allow enough on top for them to sell what they
    // may still buy with the USDC Tollkit may spend, at half today's price. Every sale pays USDC back into this wallet.
    let botWrap = 0n, botRoom = 0n, px = 0;
    const splitTotal: Record<string, string> = {};
    for (const r of bots) {
      if (problems[r.id]) continue;
      let h = botHeld(r);
      if (r.kind === "twap" && r.side === "sell" && !r.state.bot?.sell_total) {
        const k = pool(r), a = (pools[k] > 0n ? pools[k] : 0n) * BigInt(Math.round((r.sell_percent ?? 100) * 100)) / 10_000n;
        if (a <= 0n) { problems[r.id] = "No SOL to sell (0.02 SOL stays for fees)."; continue; }
        pools[k] -= a; h = a; splitTotal[r.id] = a.toString(); // fixed here, so the server sells exactly this share
      }
      botWrap += h;
      const p = r.state.last_price ?? 0;
      if (botBuys(r as any) && p > 0 && (!px || p < px)) px = p;
    }
    // 0.9.8: the total is written into the rule now, once, so the device and the server split the same amount.
    const fixT = Object.entries(splitTotal);
    if (fixT.length) await this.o.rules().mutate((rs) => { for (const [id, t] of fixT) { const x = rs.find((y) => y.id === id); if (x && !x.state.bot?.sell_total) x.state.bot = { ...(x.state.bot ?? {}), sell_total: t }; } });
    if (px > 0) botRoom = BigInt(Math.ceil((Number(usdcAllowed) / 1e6 / (px * 0.5)) * 1e9));
    const target = wrapTarget(sells.filter((r) => !problems[r.id]), amounts) + botWrap, allow = target + botRoom;
    if (target > 0n || botRoom > 0n) {
      if (wsolBal < target) {
        const add = target - wsolBal;
        if (add > free) for (const r of [...sells, ...bots]) problems[r.id] ??= `Not enough SOL: setting this aside needs ${(Number(add) / 1e9).toFixed(4)} SOL more, plus 0.02 SOL for fees.`;
        else {
          if (!wsolMade) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, wsolA, this.owner, new PublicKey(WSOL_MINT))); wsolMade = true; }
          ixs.push(SystemProgram.transfer({ fromPubkey: this.owner, toPubkey: wsolA, lamports: add }), createSyncNativeInstruction(wsolA));
          wsolBal = target;
        }
      }
      if (!wsolMade && botRoom > 0n) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, wsolA, this.owner, new PublicKey(WSOL_MINT))); wsolMade = true; }
      const short = [...sells, ...bots].some((r) => problems[r.id]?.startsWith("Not enough SOL"));
      // Plain sells allow exactly what's set aside; with bots on, re-sign when it no longer covers what they hold, or the USDC side was refilled.
      if (!short && (bots.length ? wsolAllowed < target || l.dirty || usdcRefilled : wsolAllowed !== allow)) { ixs.push(createApproveInstruction(wsolA, delegate, this.owner, allow)); wsolAllowed = allow; }
    } else if (Object.keys(l.rules).length === 0 && wsol.exists && wsolBal > 0n) {
      // Nothing on 24/7 any more (Autopilot turned off, or every switch off): unwrap it all back to plain SOL.
      ixs.push(createCloseAccountInstruction(wsolA, this.owner, this.owner)); wsolAllowed = 0n; wsolBal = 0n;
    } else if (wsolAllowed > 0n) { ixs.push(createRevokeInstruction(wsolA, this.owner)); wsolAllowed = 0n; }

    // 0.9.9: each coin. Nothing to wrap: sells draw on an allowance on the coin's own account, sized like SOL's (what the
    // sells may sell, what the bots hold, and room for what the bots may buy); buys land in that account, made here.
    const coinAmounts: Record<string, bigint> = {}, coinDec: Record<string, number> = {}, coinHeld: NonNullable<NonNullable<Local["held"]>["coins"]> = {};
    const used = new Set(l.coins_used ?? []);
    for (const m of [...new Set([...coinActive.map((r) => coinMint(r)!), ...used])]) {
      const rs = coinActive.filter((r) => coinMint(r) === m && !problems[r.id]);
      const accA = this.ata(m), acc = await this.chain.token(accA.toBase58());
      const dec = acc.decimals ?? info.get(m)?.decimals;
      if (dec === undefined) { for (const r of rs) problems[r.id] = "Couldn't read this coin's decimals; it trades while the app is open."; continue; }
      coinDec[m] = dec;
      let allowed = ours(acc) ? acc.delegated : 0n;
      if (!rs.length) { // nothing on 24/7 for this coin any more: end its allowance
        if (allowed > 0n) { ixs.push(createRevokeInstruction(accA, this.owner)); allowed = 0n; }
        used.delete(m);
        continue;
      }
      const cBuys = rs.filter((r) => isBuy(r) || (isBot(r) && botBuys(r as any)));
      if (!acc.exists && cBuys.some((r) => !problems[r.id])) ixs.push(createAssociatedTokenAccountIdempotentInstruction(this.owner, accA, this.owner, new PublicKey(m)));
      const cSells = rs.filter((r) => !isBuy(r) && !isBot(r)), cBots = rs.filter(isBot);
      const cAp = BigInt(Math.floor(autopilotUnits(store.list(), "solana", m, m) * 10 ** dec));
      const cPools = { ap: cAp < acc.amount ? cAp : acc.amount, own: 0n };
      cPools.own = acc.amount - cPools.ap;
      const counted2 = new Set<string>();
      for (const r of cSells) {
        const k = pool(r), g = k + shareKey(r), mate = cSells.find((x) => x.id !== r.id && pool(x) + shareKey(x) === g && coinAmounts[x.id] !== undefined);
        const fr = cPools[k] > 0n ? cPools[k] : 0n;
        let a = mate ? coinAmounts[mate.id]! : r.sell_percent !== undefined ? (fr * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : BigInt(Math.round(Number(r.sell_amount) * 10 ** dec));
        if (a > fr && !mate) a = fr;
        if (!mate && a > 0n && !counted2.has(g)) { counted2.add(g); cPools[k] -= a; }
        if (a <= 0n) { problems[r.id] = isAutopilotRule(r) ? "Autopilot's strategies hold none of this coin to sell yet." : "None of this coin left to sell."; continue; }
        coinAmounts[r.id] = a;
      }
      let cWrap = 0n, cPx = 0;
      for (const r of cBots) {
        if (problems[r.id]) continue;
        let h = botHeld(r);
        if (r.kind === "twap" && r.side === "sell" && !r.state.bot?.sell_total) {
          const k = pool(r), a = (cPools[k] > 0n ? cPools[k] : 0n) * BigInt(Math.round((r.sell_percent ?? 100) * 100)) / 10_000n;
          if (a <= 0n) { problems[r.id] = "None of this coin to sell."; continue; }
          cPools[k] -= a; h = a; splitTotal[r.id] = a.toString();
        }
        cWrap += h;
        const p = r.state.last_price ?? 0;
        if (botBuys(r as any) && p > 0 && (!cPx || p < cPx)) cPx = p;
      }
      const cTarget = wrapTarget(cSells.filter((r) => !problems[r.id]), coinAmounts) + cWrap;
      const cRoom = cPx > 0 ? BigInt(Math.ceil((Number(usdcAllowed) / 1e6 / (cPx * 0.5)) * 10 ** dec)) : 0n;
      if (cTarget > acc.amount) for (const r of [...cSells, ...cBots]) problems[r.id] ??= `Not enough of this coin: these need ${(Number(cTarget) / 10 ** dec).toFixed(dec > 4 ? 4 : dec)} and you hold ${(Number(acc.amount) / 10 ** dec).toFixed(dec > 4 ? 4 : dec)}.`;
      const cAllow = cTarget + cRoom;
      const anySell = rs.some((r) => !problems[r.id] && (!isBuy(r)));
      if (anySell && cAllow > 0n && (cBots.length ? allowed < cTarget || l.dirty || usdcRefilled : allowed !== cAllow) && !rs.some((r) => problems[r.id]?.startsWith("Not enough of this coin"))) { ixs.push(createApproveInstruction(accA, delegate, this.owner, cAllow)); allowed = cAllow; }
      else if (!anySell && allowed > 0n) { ixs.push(createRevokeInstruction(accA, this.owner)); allowed = 0n; }
      used.add(m);
      coinHeld[m] = { allowed: allowed.toString(), balance: acc.amount.toString(), decimals: dec, symbol: info.get(m)?.symbol };
    }

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
    // 0.9.9: a coin's split-sell total, written once like SOL's above.
    const fixC = Object.entries(splitTotal).filter(([id]) => coinActive.some((r) => r.id === id));
    if (fixC.length) await this.o.rules().mutate((rs) => { for (const [id, t] of fixC) { const x = rs.find((y) => y.id === id); if (x && !x.state.bot?.sell_total) x.state.bot = { ...(x.state.bot ?? {}), sell_total: t }; } });
    const send = active.filter((r) => !problems[r.id]);
    // 0.9.9: what the server needs for "while you're away": Autopilot's rules and the price it last saw for each.
    const away = this.awayInfo?.() ?? null;
    const tok = (r: Rule) => (isSolRule(r) ? { token: "SOL" } : { token: coinMint(r)!, symbol: info.get(coinMint(r)!)?.symbol });
    const apx = (r: Rule) => (isAutopilotRule(r) ? { ap: true, ref_price: r.state.last_price } : {});
    const sellAmt = (r: Rule) => (isSolRule(r) ? Number(amounts[r.id] ?? 0n) / 1e9 : Number(coinAmounts[r.id] ?? 0n) / 10 ** (coinDec[coinMint(r)!] ?? 0));
    const body = { ...(away ? { away } : {}), rules: send.map((r) => isBot(r) ? ({ id: r.id, kind: r.kind, ...tok(r), ...apx(r), amount_usd: r.amount_usd, lower_price: r.lower_price, upper_price: r.upper_price, levels: r.levels, step_pct: r.step_pct, safety: r.safety, scale: r.scale,
        profit_pct: r.profit_pct, target_pct: r.target_pct, band_pct: r.band_pct, side: r.side, sell_percent: r.sell_percent, pieces: r.pieces, hours: r.hours, expires_at: r.expires_at, runs: r.state.runs,
        bot: { ...(r.state.bot ?? {}), ...(r.kind === "grid" ? { grid: r.state.grid } : {}), ...(splitTotal[r.id] ? { sell_total: splitTotal[r.id], v: (r.state.bot?.v ?? 0) + 1 } : {}) } })
      : ({ id: r.id, kind: r.kind, ...tok(r), ...apx(r), amount_usd: r.amount_usd, sell_amount: !isBuy(r) ? sellAmt(r) : undefined, trigger_price: r.trigger_price,
      every: r.every, times: r.times, max_price: r.max_price, group: r.group, expires_at: r.expires_at, runs: r.state.runs, next_run: r.state.next_run })) };
    let running: string[] = l0.running ?? [];
    try { const j = await this.call("sync", body); running = j.running ?? []; }
    catch (e) { for (const r of send) problems[r.id] = (e as Error).message.slice(0, 200); }
    this.update((x) => {
      x.running = running; x.problems = problems; x.set_aside = set; x.last_sync = new Date(this.now()).toISOString(); x.dirty = false; x.last_error = null;
      x.held = { usdc_allowed: usdcAllowed.toString(), wsol_allowed: wsolAllowed.toString(), wsol_balance: wsolBal.toString(), coins: coinHeld };
      x.coins_used = [...used];
      if (tx) x.last_tx = tx;
    });
    return { fills: fresh, running, problems };
  }
}
