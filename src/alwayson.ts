/**
 * "Keep running when closed": rules that Tollkit's server places while the app is closed, under permission slips
 * the chain enforces (src/delegation.ts). The keys never leave this device. What the server can do, per slip:
 *   - call only 0x AllowanceHolder.exec (a swap), lending 0x only the rule's token and exact amount;
 *   - only if the bought coin lands in the owner's own address, at or above a floor price signed here;
 *   - only inside one day's window (recurring buys) or the slip's window (one-shot rules), a set number of times;
 *   - never after the owner turns it off or the app re-signs (a nonce bump retires every earlier slip).
 * The server pays the gas. A rule the server confirmed it runs is left alone by the device's own autopilot until
 * the server confirms it stopped, so nothing trades twice.
 *
 * Known limit: a slip can be used any time in its window, so a hijacked server could fill a stop-loss early, at
 * its floor (15% under the stop). Floors are the worst price the owner accepts, not the price the rule waits for.
 *
 * Supported now: the EVM networks the server lists (Base first), ETH against USDC, for recurring buys, limit buys,
 * take-profits, limit sells and stop-losses. Other rules keep running on the device while the app is open.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Contract, JsonRpcProvider, formatUnits, parseUnits, type HDNodeWallet, type Wallet } from "ethers";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { EVM_CHAIN_ID, NATIVE_EVM, chainName, isEvmChain, type Chain, type EvmChain } from "./chains.js";
import { KNOWN } from "./tokens.js";
import { walletHome } from "./paths.js";
import { ALLOWANCE_HOLDER, C, DF, EXEC_SELECTOR, NONCE_ABI, bumpNonceCalldata, pinExec, signDelegation, slipJson, type Caveat } from "./delegation.js";
import type { Rule, RuleStore } from "./rules.js";

/** How far ahead permissions are signed; the app re-signs when it's opened. */
export const AHEAD_DAYS = 7;
/** Re-sign when this little coverage is left. */
const REFRESH_DAYS = 3;
/** Floors: the worst price the owner accepts, as a share of the price the floor is based on. */
export const FLOOR = { dcaBand: 0.12, limit: 0.03, takeProfit: 0.03, stopLoss: 0.15 } as const;
/** ETH left for the device's own transactions when a sell is "all" or a share of the balance (as autopilot.ts). */
const RESERVE: Partial<Record<EvmChain, bigint>> = { base: 50_000_000_000_000n, ethereum: 2_000_000_000_000_000n, arbitrum: 100_000_000_000_000n };
const DAY = 86_400;
const KINDS = ["dca", "limit_buy", "limit_sell", "take_profit", "stop_loss"];

export interface AlwaysConfig { enabled: boolean; chains: EvmChain[]; delegate: string | null; reason?: string }
interface Signed { at: number; until: number; price: number; key: string; sell?: string; failed?: boolean }
interface Local {
  rules: Record<string, true>; budget_usd: number; dirty?: boolean;
  /** Rules the server last confirmed it runs. The device leaves these alone. */
  running?: string[]; problems?: Record<string, string>; last_sync?: string; last_error?: string | null;
  signed?: Record<string, Signed>; seen_fills?: string[];
}
export interface AlwaysOpts {
  key: () => Wallet | HDNodeWallet;
  address: string;
  dir?: string;
  rpc: (c: Chain) => string;
  fetch?: typeof fetch;
  proxy: string;
  rules: () => RuleStore;
  price: (sym: string) => Promise<number | undefined>;
  balance: (chain: EvmChain, token: string) => Promise<bigint>;
  now?: () => number;
}

export interface ServerFill { id?: string; rule_id: string; ts: string; ok: boolean; tx?: string; usd?: number; units?: number; side: "buy" | "sell"; reason?: string }
interface ServerState { fills: ServerFill[]; rules: Record<string, { runs: number; next_run?: string; done?: boolean }> }

/** Which rules the server can run, and why not otherwise (shown on the rule card). */
export function serverRunnable(r: Rule, chains: EvmChain[]): string | null {
  if (!isEvmChain(r.chain) || !chains.includes(r.chain)) return `Runs on ${chainName(r.chain)} only while the app is open.`;
  if (r.token.toUpperCase() !== "ETH") return "Only ETH rules can run while the app is closed for now.";
  if (!KINDS.includes(r.kind)) return "This kind of rule runs only while the app is open.";
  if (r.after || r.sell_from) return "Rules that wait for another rule run only while the app is open.";
  if (["limit_buy", "dca"].includes(r.kind) && !r.amount_usd) return "Needs a dollar amount.";
  return null;
}

export class AlwaysOn {
  private file: string;
  private cfg: AlwaysConfig | null = null;
  private syncing: Promise<unknown> | null = null;
  constructor(private readonly o: AlwaysOpts) { this.file = path.join(walletHome(o.dir), "always.json"); }
  private now() { return this.o.now?.() ?? Date.now(); }
  private get f(): typeof fetch { return this.o.fetch ?? ((i: any, n?: any) => fetch(i, n)); }

  private load(): Local {
    try { if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* start over */ }
    return { rules: {}, budget_usd: 0 };
  }
  /** Read-modify-write in one step, so a switch flipped during a sync isn't lost. */
  private update<T>(fn: (l: Local) => T): T {
    const l = this.load(), out = fn(l);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(l, null, 2), { mode: 0o600 }); renameSync(t, this.file);
    return out;
  }

  /** Whether the server runs rules for this wallet (it's off for everyone until Tollkit turns it on). Null: unreachable. */
  async config(): Promise<AlwaysConfig | null> {
    try {
      const r = await this.f(`${this.o.proxy}/always/config?address=${this.o.address}`, { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json().catch(() => null)) as AlwaysConfig | null;
      this.cfg = r.ok && j ? j : { enabled: false, chains: [], delegate: null, reason: (j as any)?.error ?? `HTTP ${r.status}` };
      return this.cfg;
    } catch { return null; }
  }

  view() {
    const l = this.load();
    return { rules: Object.keys(l.rules), budget_usd: l.budget_usd, config: this.cfg, running: l.running ?? [], problems: l.problems ?? {}, last_sync: l.last_sync ?? null, last_error: l.last_error ?? null };
  }
  isOn(id: string) { return !!this.load().rules[id]; }
  /** The server confirmed it runs this rule (and hasn't confirmed it stopped): the device leaves it alone. */
  serverRuns(id: string) { return (this.load().running ?? []).includes(id); }
  anyOn() { const l = this.load(); return Object.keys(l.rules).length > 0 || (l.running ?? []).length > 0; }
  noteError(m: string) { this.update((l) => { l.last_error = m.slice(0, 300); }); }

  /** The owner flips the switch on a rule. `budget_usd`: the USDC 0x may be approved to spend (a total, refilled when the app opens). */
  set(id: string, on: boolean, budget_usd?: number) {
    if (budget_usd !== undefined && !(budget_usd > 0 && budget_usd <= 100_000)) throw new Error("Pick an amount between $1 and $100,000.");
    this.update((l) => {
      if (on) l.rules[id] = true; else delete l.rules[id];
      if (budget_usd !== undefined) l.budget_usd = budget_usd;
      l.dirty = true; // re-sign everything on the next sync, retiring what was signed before
    });
  }

  /** Signed request to Tollkit's server: the signature covers the route, the time and this exact body. */
  private async call(route: string, body: unknown): Promise<any> {
    // A fresh nonce in every body: two requests in the same second must never look like a replay.
    const text = JSON.stringify({ ...(body as object), _n: randomUUID() }), ts = Math.floor(this.now() / 1000);
    const msg = `Tollkit Always On\n${route}\n${getAddress(this.o.address)}\n${ts}\n${createHash("sha256").update(text).digest("hex")}`;
    const sig = await this.o.key().signMessage(msg);
    const r = await this.f(`${this.o.proxy}/always/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-tk-address": getAddress(this.o.address), "x-tk-ts": String(ts), "x-tk-sig": sig }, body: text, signal: AbortSignal.timeout(240_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error ?? `Tollkit's server answered HTTP ${r.status}`), { status: r.status });
    return j;
  }

  private provider(chain: EvmChain) { return new JsonRpcProvider(this.o.rpc(chain), EVM_CHAIN_ID[chain], { staticNetwork: true }); }
  private async nonceOf(chain: EvmChain): Promise<bigint> {
    return new Contract(DF.NonceEnforcer, NONCE_ABI as any, this.provider(chain)).currentNonce!(DF.DelegationManager, getAddress(this.o.address));
  }

  /**
   * Turn everything off. The server spends each network's kill switch (a nonce bump retiring every slip). The device
   * then checks the chain; if a network's nonce didn't move, it bumps it itself (needs a little ETH there).
   */
  async off(): Promise<{ revoked: EvmChain[] }> {
    const l = this.load();
    const chains = [...new Set(Object.keys(l.signed ?? {}).map((k) => k.split(":")[0] as EvmChain))];
    const before = new Map<EvmChain, bigint>();
    for (const c of chains) before.set(c, await this.nonceOf(c).catch(() => -1n));
    let serverErr: string | null = null;
    await this.call("off", {}).catch((e) => { serverErr = (e as Error).message; });
    const revoked: EvmChain[] = [], stuck: string[] = [];
    for (const c of chains) {
      const b = before.get(c)!;
      if (b >= 0n && (await this.nonceOf(c).catch(() => b)) > b) { revoked.push(c); continue; }
      try {
        const signer = this.o.key().connect(this.provider(c));
        const tx = await signer.sendTransaction({ to: DF.NonceEnforcer, data: bumpNonceCalldata() });
        await tx.wait();
        revoked.push(c);
      } catch (e) { stuck.push(`${chainName(c)}: ${(e as Error).message.slice(0, 120)}`); }
    }
    if (stuck.length) {
      this.update((x) => { x.last_error = `Not retired yet on ${stuck.join("; ")}`; });
      throw new Error(`Couldn't retire the permissions on ${stuck.map((s) => s.split(":")[0]).join(", ")}${serverErr ? ` (Tollkit's server: ${serverErr})` : ""}. Add a little ETH there and try again; until then they expire on their own within a week.`);
    }
    this.update((x) => { x.rules = {}; x.signed = {}; x.running = []; x.problems = {}; x.dirty = false; x.last_error = null; });
    return { revoked };
  }

  /** Called when the app opens and every few minutes while it's open. One at a time. */
  async sync(): Promise<{ fills: ServerFill[]; running: string[]; problems: Record<string, string> }> {
    if (this.syncing) await this.syncing.catch(() => {});
    const p = this.doSync();
    this.syncing = p;
    try { return await p; } finally { if (this.syncing === p) this.syncing = null; }
  }

  private async doSync() {
    const cfg = await this.config();
    const l0 = this.load();
    if (!cfg) return { fills: [], running: l0.running ?? [], problems: l0.problems ?? {} }; // unreachable: change nothing
    const store = this.o.rules();
    const problems: Record<string, string> = {};
    if (!cfg.enabled || !cfg.delegate) {
      // The server says it isn't running anything for this wallet: the device takes every rule back.
      for (const id of Object.keys(l0.rules)) problems[id] = cfg.reason ?? "Tollkit isn't running rules while the app is closed yet.";
      this.update((l) => { l.running = []; l.problems = problems; });
      return { fills: [], running: [], problems };
    }
    // 1. First bring back what the server did, so signing below starts from the true state.
    let state: ServerState = { fills: [], rules: {} };
    try { state = await this.call("state", {}); }
    catch (e) { this.update((l) => { l.last_error = (e as Error).message.slice(0, 300); }); return { fills: [], running: l0.running ?? [], problems: l0.problems ?? {} }; }
    const fresh = this.update((l) => { const seen = new Set(l.seen_fills ?? []); const n = state.fills.filter((f) => f.id && !seen.has(f.id)); l.seen_fills = [...seen, ...n.map((f) => f.id!)].slice(-1000); return n; });
    if (fresh.length) await applyFills(store, fresh);
    // 2. Each network: set up once, re-sign when needed, send the rules.
    const l = this.load();
    const want = store.list().filter((r) => l.rules[r.id] && (r.status === "active" || r.status === "paused"));
    const byChain = new Map<EvmChain, Rule[]>();
    for (const r of want) {
      const why = serverRunnable(r, cfg.chains);
      if (why) { problems[r.id] = why; continue; }
      if (r.status !== "active" || state.rules[r.id]?.done) continue;
      byChain.set(r.chain as EvmChain, [...(byChain.get(r.chain as EvmChain) ?? []), r]);
    }
    const prevRunning = l.running ?? [];
    const running: string[] = [];
    let failedChain = false;
    const chains = new Set<EvmChain>([...byChain.keys(), ...Object.keys(l.signed ?? {}).map((k) => k.split(":")[0] as EvmChain).filter((c) => cfg.chains.includes(c))]);
    for (const chain of chains) {
      const rules = byChain.get(chain) ?? [];
      try {
        const out = await this.syncChain(chain, rules, cfg.delegate, l);
        running.push(...out.running);
        for (const [id, why] of Object.entries(out.problems)) problems[id] = String(why);
        this.update((x) => { x.signed = { ...Object.fromEntries(Object.entries(x.signed ?? {}).filter(([k]) => !k.startsWith(chain + ":"))), ...out.signed }; });
      } catch (e) {
        // Nothing changed on the server for this network: whatever it ran before, it still runs.
        failedChain = true;
        running.push(...prevRunning.filter((id) => store.get(id)?.chain === chain));
        for (const r of rules) problems[r.id] = (e as Error).message.slice(0, 200);
      }
    }
    this.update((x) => { x.running = running; x.problems = problems; x.last_sync = new Date(this.now()).toISOString(); if (!failedChain) x.dirty = false; x.last_error = null; });
    return { fills: fresh, running, problems };
  }

  private async syncChain(chain: EvmChain, rules: Rule[], delegate: string, l: Local) {
    const key = this.o.key(), me = getAddress(this.o.address), chainId = EVM_CHAIN_ID[chain];
    const provider = this.provider(chain);
    const usdc = KNOWN[chain].USDC!, now = Math.floor(this.now() / 1000);
    const body: any = { chain, rules: [], slips: [] };
    // Once per network: the 7702 upgrade (same address, same key; the server sends it and pays).
    const code = (await provider.getCode(me)).toLowerCase();
    const upgraded = code === ("0xef0100" + DF.EIP7702StatelessDeleGatorImpl.slice(2)).toLowerCase();
    if (!upgraded) {
      if (code !== "0x") throw new Error(`This address on ${chainName(chain)} already runs other smart-account code, so Tollkit won't change it.`);
      const auth = await key.authorize({ address: DF.EIP7702StatelessDeleGatorImpl, nonce: await provider.getTransactionCount(me), chainId });
      body.upgrade = { address: auth.address, chainId: Number(auth.chainId), nonce: Number(auth.nonce), r: auth.signature.r, s: auth.signature.s, yParity: auth.signature.yParity };
    }
    const nonce = await this.nonceOf(chain);
    const killSwitch = async (n: bigint) => slipJson(await signDelegation(key, chainId, delegate, [C.targets([DF.NonceEnforcer]), C.exactCalldata(bumpNonceCalldata()), C.limitedCalls(1), C.nonce(n)]));
    body.off_slip = await killSwitch(nonce);
    const eth = await this.o.price("ETH");
    if (!eth) throw new Error("No ETH price right now; trying again shortly.");
    const ethBal = await this.o.balance(chain, NATIVE_EVM);
    const sigKey = (r: Rule) => JSON.stringify([r.kind, r.amount_usd, r.sell_amount, r.sell_percent, r.trigger_price, r.every, r.weekday, r.times, r.max_price, r.group, r.expires_at, r.state.runs]);
    const signed = Object.fromEntries(Object.entries(l.signed ?? {}).filter(([k]) => k.startsWith(chain + ":")));
    const stale = rules.filter((r) => {
      const s = signed[`${chain}:${r.id}`];
      return !s || s.key !== sigKey(r) || (!s.failed && s.until - now < REFRESH_DAYS * DAY) || (s.failed && s.until < now) || (r.kind === "dca" && Math.abs(eth - s.price) / s.price > 0.05) || (s.sell !== undefined && BigInt(s.sell) > ethBal);
    });
    const gone = Object.keys(signed).filter((k) => !rules.some((r) => `${chain}:${r.id}` === k));
    const problems: Record<string, string> = {};
    const out: Record<string, Signed> = { ...signed };
    let next = nonce;
    if (l.dirty || stale.length || gone.length || !upgraded) {
      // Once the account is set up, every re-sign moves to a new nonce: the server first spends `off_slip`, which
      // retires every earlier slip on-chain, so old and new can never both be valid.
      if (upgraded) { next = nonce + 1n; body.replace = true; body.off_next = await killSwitch(next); }
      for (const k of gone) delete out[k];
      for (const r of rules) {
        try {
          const built = await this.slipsFor(chain, r, delegate, next, now, eth, ethBal);
          body.slips.push(...built.slips.map((s) => ({ ...s, delegation: slipJson(s.delegation) })));
          out[`${chain}:${r.id}`] = { at: now, until: now + AHEAD_DAYS * DAY, price: eth, key: sigKey(r), ...(built.sell !== undefined ? { sell: built.sell.toString() } : {}) };
        } catch (e) {
          problems[r.id] = (e as Error).message.slice(0, 200);
          out[`${chain}:${r.id}`] = { at: now, until: now + DAY, price: eth, key: sigKey(r), failed: true }; // don't re-sign every sync for it
        }
      }
    }
    // The spending approval for 0x, checked every sync (swaps made on the device use the same allowance).
    const buys = rules.filter((r) => (r.kind === "dca" || r.kind === "limit_buy") && !problems[r.id]);
    if (buys.length) {
      const cap = parseUnits(String(l.budget_usd || 0), usdc.decimals);
      if (cap === 0n) for (const r of buys) problems[r.id] ??= "Set how much Autopilot can use first.";
      else {
        const perTrade = buys.reduce((m, r) => { const a = parseUnits(r.amount_usd!.toFixed(usdc.decimals), usdc.decimals); return a > m ? a : m; }, 0n);
        const allowance: bigint = await new Contract(usdc.address, ["function allowance(address,address) view returns (uint256)"], provider).allowance!(me, ALLOWANCE_HOLDER);
        if (allowance < perTrade || (body.replace && allowance < cap)) {
          const data = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [ALLOWANCE_HOLDER, cap] });
          body.approve = { amount: cap.toString(), delegation: slipJson(await signDelegation(key, chainId, delegate, [C.targets([usdc.address]), C.exactCalldata(data), C.limitedCalls(1), C.nonce(next)])) };
        }
      }
    }
    body.rules = rules.filter((r) => !problems[r.id]).map((r) => ({
      id: r.id, kind: r.kind, amount_usd: r.amount_usd, trigger_price: r.trigger_price, every: r.every,
      times: r.times, max_price: r.max_price, group: r.group, expires_at: r.expires_at, runs: r.state.runs, next_run: r.state.next_run,
    }));
    const j = await this.call("sync", body);
    return { running: (j.running ?? []) as string[], problems: { ...problems, ...(j.problems ?? {}) }, signed: out };
  }

  /** The slips for one rule: what it may sell, at what floor, in which windows. */
  private async slipsFor(chain: EvmChain, r: Rule, delegate: string, nonce: bigint, now: number, eth: number, ethBal: bigint) {
    const key = this.o.key(), me = getAddress(this.o.address), chainId = EVM_CHAIN_ID[chain];
    const usdc = KNOWN[chain].USDC!;
    const end = Math.min(now + AHEAD_DAYS * DAY, r.expires_at ? Math.floor(Date.parse(r.expires_at) / 1000) : Infinity);
    if (end <= now) throw new Error("This rule has expired.");
    const base = (extra: Caveat[]) => [C.targets([ALLOWANCE_HOLDER]), C.methods([EXEC_SELECTOR]), ...extra, C.nonce(nonce)];
    const out: { rule_id: string; side: "buy" | "sell"; not_before: number; not_after: number; limit: number; sell_atomic: string; floor_atomic: string; delegation: Awaited<ReturnType<typeof signDelegation>> }[] = [];
    const sign = async (side: "buy" | "sell", from: number, to: number, limit: number, sellAtomic: bigint, floor: bigint) => {
      const caveats = side === "buy"
        ? base([C.valueLte(0n), pinExec(usdc.address, sellAtomic), C.erc20Change(usdc.address, me, sellAtomic, 1), C.nativeChange(me, floor, 0), C.timestamp(from, to), C.limitedCalls(limit)])
        : base([C.valueLte(sellAtomic), pinExec(zeroAddress, sellAtomic), C.nativeChange(me, sellAtomic, 1), C.erc20Change(usdc.address, me, floor, 0), C.timestamp(from, to), C.limitedCalls(limit)]);
      out.push({ rule_id: r.id, side, not_before: from, not_after: to, limit, sell_atomic: sellAtomic.toString(), floor_atomic: floor.toString(), delegation: await signDelegation(key, chainId, delegate, caveats) });
    };
    const eth18 = (usd: number, price: number) => parseUnits((usd / price).toFixed(18), 18);
    if (r.kind === "dca" || r.kind === "limit_buy") {
      const amt = parseUnits(r.amount_usd!.toFixed(usdc.decimals), usdc.decimals);
      if (r.kind === "limit_buy") {
        await sign("buy", now - 60, end, 1, amt, eth18(r.amount_usd! * (1 - FLOOR.limit), r.trigger_price!));
        return { slips: out };
      }
      // Recurring buys: one slip per day, each covering only that day's buys, and never more buys than are left.
      let left = r.times ? Math.max(0, r.times - r.state.runs) : Infinity;
      if (!left) throw new Error("All its buys are done.");
      const ceiling = Math.min(eth * (1 + FLOOR.dcaBand), r.max_price ? r.max_price * (1 + FLOOR.limit) : Infinity);
      const floor = eth18(r.amount_usd!, ceiling);
      const next = Math.max(now, r.state.next_run ? Math.floor(Date.parse(r.state.next_run) / 1000) : now);
      const starts: number[] = [];
      if (r.every === "week") for (let t = next; t < end; t += 7 * DAY) starts.push(t);
      else { starts.push(next); for (let d = (Math.floor(next / DAY) + 1) * DAY; d < end; d += DAY) starts.push(d); }
      for (const from of starts) {
        if (!left) break;
        const to = Math.min((Math.floor(from / DAY) + 1) * DAY, end);
        if (to <= from) continue;
        let n = r.every === "hour" ? Math.ceil((to - from) / 3600) : 1;
        if (n > left) n = left as number;
        await sign("buy", from === next ? from - 60 : from, to, n, amt, floor);
        left -= n;
      }
      if (!out.length) throw new Error("No buys are due in the next week.");
      return { slips: out };
    }
    // Sells: a fixed amount of ETH, set now: a share of today's balance (keeping a little for gas), or the rule's amount.
    const spendable = ethBal > (RESERVE[chain] ?? 0n) ? ethBal - (RESERVE[chain] ?? 0n) : 0n;
    let sellAtomic = r.sell_percent !== undefined ? (spendable * BigInt(Math.round(r.sell_percent * 100))) / 10_000n : parseUnits(r.sell_amount!, 18);
    if (sellAtomic > spendable) sellAtomic = spendable;
    if (sellAtomic <= 0n) throw new Error("No ETH to sell on this network.");
    const cut = r.kind === "stop_loss" ? FLOOR.stopLoss : r.kind === "take_profit" ? FLOOR.takeProfit : FLOOR.limit;
    const floor = parseUnits((Number(formatUnits(sellAtomic, 18)) * r.trigger_price! * (1 - cut)).toFixed(usdc.decimals), usdc.decimals);
    await sign("sell", now - 60, end, 1, sellAtomic, floor);
    return { slips: out, sell: sellAtomic };
  }
}

/** Records what the server traded on the device's copy of the rules, so the app shows it and doesn't repeat it. */
export async function applyFills(store: RuleStore, fills: ServerFill[]) {
  await store.mutate((rules) => {
    for (const f of fills) {
      const r = rules.find((x) => x.id === f.rule_id);
      if (!r || (f.tx && r.state.fills.some((x) => x.tx === f.tx))) continue;
      r.state.fills.push({ ts: f.ts, ok: f.ok, tx: f.tx, usd: f.usd, units: f.units, side: f.side, reason: f.ok ? undefined : f.reason });
      r.state.fills = r.state.fills.slice(-50);
      if (!f.ok) { r.state.fail_count = (r.state.fail_count ?? 0) + 1; r.state.last_error = f.reason; continue; }
      r.state.runs += 1; r.state.ok_count = (r.state.ok_count ?? 0) + 1; r.state.last_error = undefined;
      if (f.side === "buy") { r.state.spent_usd = (r.state.spent_usd ?? 0) + (f.usd ?? 0); r.state.bought_units = (r.state.bought_units ?? 0) + (f.units ?? 0); }
      else { r.state.received_usd = (r.state.received_usd ?? 0) + (f.usd ?? 0); r.state.sold_units = (r.state.sold_units ?? 0) + (f.units ?? 0); }
      if (r.kind === "dca") {
        const step = r.every === "hour" ? 3600_000 : r.every === "week" ? 7 * 86_400_000 : 86_400_000;
        r.state.next_run = new Date(Date.parse(f.ts) + step).toISOString();
        if (r.times && r.state.runs >= r.times) r.status = "done";
      } else {
        r.status = "done";
        if (r.group) for (const o of rules) if (o.id !== r.id && o.group === r.group && ["active", "paused"].includes(o.status)) { o.status = "cancelled"; o.state.note = "Its partner rule filled"; }
      }
    }
  });
}
