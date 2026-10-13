/**
 * The wallet as one object: unlock once, then swap, pay, read balances and
 * receipts. Every spend goes through the owner's policy, the ledger lock,
 * and (above the threshold) a Telegram approval. Used by the CLI, the MCP
 * server, the dashboard and the framework plugins.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, STABLES, SWAP_FEE_BPS, WSOL, NATIVE_EVM, type Chain } from "./chains.js";
import { addresses, unlock, type Keys } from "./keystore.js";
import { entries, exportCsv, LimitError, record, reserve, settle, spentToday, type Entry } from "./ledger.js";
import { payFetch, type PayResult } from "./pay.js";
import { loadPolicy, savePolicy, type Policy } from "./policy.js";
import { files, walletHome } from "./paths.js";
import { Sanctions } from "./sanctions.js";
import { checkSeller } from "./seller.js";
import { executeSwap, getQuote, vetQuote, DEFAULT_PROXY, type SwapQuote, type SwapRequest } from "./swap.js";
import { requestApproval, type Decision, type TelegramConfig } from "./telegram.js";
import { balanceAtomic, checkDestination, sendTokens, type SendRequest } from "./send.js";
import { dashboardOpen, requestLocal } from "./approvals.js";
import { randomUUID } from "node:crypto";
import { KNOWN, type Token } from "./tokens.js";
import { RuleStore } from "./rules.js";
import { PaperBook } from "./paper.js";
import { liveBalance, type Executor } from "./autopilot.js";

type Fetch = typeof fetch;

export interface WalletOptions {
  dir?: string;
  fetch?: Fetch;
  proxy?: string;
  rpc?: Partial<Record<Chain, string>>;
  /** Override for tests: send a withdrawal. */
  send?: (r: SendRequest, keys: Keys) => Promise<string>;
  /** Override for tests: sign + send a vetted quote. */
  execute?: (q: SwapQuote, keys: Keys) => Promise<string>;
  /** Override for tests / other channels. Default: Telegram if configured. */
  approve?: ((text: string) => Promise<Decision>) | null;
}

export interface SwapResult {
  ok: boolean;
  /** e.g. "Not enough balance for this trade" (quotes still price without funds). */
  warning?: string;
  quote?: Omit<SwapQuote, "raw">;
  tx?: string;
  receipt_id?: string;
  refused?: { code: string; reason: string };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const strip = ({ raw: _raw, ...q }: SwapQuote) => q;

export function loadTelegram(dir?: string): TelegramConfig | null {
  const f = files(walletHome(dir)).telegram;
  if (!existsSync(f)) return null;
  try { const j = JSON.parse(readFileSync(f, "utf8")); return j?.token && j?.chat_id ? { token: String(j.token), chat_id: String(j.chat_id) } : null; } catch { return null; }
}
export function saveTelegram(cfg: TelegramConfig, dir?: string) {
  writeFileSync(files(walletHome(dir)).telegram, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** The venue's own "you can't afford this" signal, in plain words. */
export function balanceWarning(q: SwapQuote): string | undefined {
  const jup = q.raw?.errorMessage ?? q.raw?.error;
  if (q.venue === "jupiter" && jup) return `Jupiter: ${jup}`;
  const b = q.raw?.issues?.balance;
  if (q.venue === "0x" && b) return `Not enough balance: the wallet has ${b.actual} and needs ${b.expected} (atomic units of ${b.token}).`;
  return undefined;
}

/** "30 USDC" / "0.0118 WETH" for known tokens; shortened address + raw units otherwise. */
export function describeAmount(chain: Chain, token: string, atomic: string): string {
  const t = Object.values(KNOWN[chain]).find((k) => k.address.toLowerCase() === token.toLowerCase());
  if (!t) return `${atomic} units of ${token.slice(0, 6)}…${token.slice(-4)}`;
  const n = Number(formatUnits(BigInt(atomic), t.decimals));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 })} ${t.symbol}`;
}

export class TollkitWallet {
  readonly dir: string;
  private constructor(private keys: Keys, private password: string, readonly policy: Policy, private readonly o: WalletOptions, readonly sanctions: Sanctions) {
    this.dir = walletHome(o.dir);
  }

  /** Unlock with the owner's password. Fails on a wrong password or an edited policy. */
  static async open(password: string, o: WalletOptions = {}): Promise<TollkitWallet> {
    const keys = await unlock(password, o.dir);
    const policy = loadPolicy(password, o.dir);
    return new TollkitWallet(keys, password, policy, o, new Sanctions(o.dir, o.fetch ?? fetch));
  }

  get addresses() { return addresses(this.o.dir); }
  private get f(): Fetch { return this.o.fetch ?? fetch; }
  private rpc(c: Chain) { return this.o.rpc?.[c] ?? DEFAULT_RPC[c]; }

  /**
   * Who can approve: Telegram (if set up) and the dashboard (while it's open).
   * Both are asked at once; the first answer wins and the other is closed.
   */
  private get approver(): ((text: string) => Promise<Decision>) | null {
    if (this.o.approve !== undefined) return this.o.approve;
    const tg = loadTelegram(this.o.dir);
    const local = dashboardOpen(this.o.dir);
    if (!tg && !local) return null;
    return async (text) => {
      const stop = new AbortController();
      const asks: Promise<Decision>[] = [];
      if (tg) asks.push(requestApproval(tg, text, { fetch: this.f, signal: stop.signal }).catch(() => "timeout" as Decision));
      if (local) asks.push(requestLocal(this.o.dir, text, { signal: stop.signal }));
      // First real answer wins; a timeout from one channel waits for the others.
      const d = await new Promise<Decision>((res) => {
        let left = asks.length;
        for (const a of asks) a.then((x) => { if (x !== "timeout") res(x); else if (--left === 0) res("timeout"); });
      });
      stop.abort();
      return d;
    };
  }

  /** Save a withdrawal address (password needed). Checked for format and sanctions before saving. */
  async saveWithdrawAddress(password: string, chain: Chain, address: string, label = ""): Promise<Policy> {
    if (password !== this.password) throw new Error("wrong password");
    const dest = checkDestination(chain, address);
    if (await this.sanctions.isSanctioned(dest)) throw new Error(`${dest} is on the OFAC sanctions list.`);
    const list = this.policy.withdraw_addresses.filter((a) => !(a.chain === chain && a.address === dest));
    return this.setPolicy(password, { ...this.policy, withdraw_addresses: [...list, { chain, address: dest, label: label.slice(0, 40) }] });
  }

  removeWithdrawAddress(password: string, chain: Chain, address: string): Policy {
    if (password !== this.password) throw new Error("wrong password");
    return this.setPolicy(password, { ...this.policy, withdraw_addresses: this.policy.withdraw_addresses.filter((a) => !(a.chain === chain && a.address.toLowerCase() === address.trim().toLowerCase())) });
  }

  /** Change limits. Needs the password again, so an agent holding an open wallet can't do it. */
  setPolicy(password: string, next: Policy): Policy {
    if (password !== this.password) throw new Error("wrong password");
    const p = savePolicy(password, next, this.o.dir);
    Object.assign(this.policy, p);
    return p;
  }

  status() {
    return {
      addresses: this.addresses,
      policy: this.policy,
      spent_today: { trades_usd: spentToday("trade", this.o.dir), payments_usd: spentToday("payment", this.o.dir) },
      approvals: [loadTelegram(this.o.dir) ? "telegram" : null, dashboardOpen(this.o.dir) ? "dashboard" : null].filter(Boolean).join("+") || "none",
      swap_fee_bps: SWAP_FEE_BPS,
    };
  }

  receipts(since?: string): Entry[] { return entries(this.o.dir).filter((e) => !since || e.ts >= since); }
  receiptsCsv(since?: string): string { return exportCsv(this.o.dir, since); }

  /** Native coin + dollar stablecoins on every enabled chain. Errors per chain are reported, not thrown. */
  async balances(): Promise<Record<string, { token: string; amount: string }[] | { error: string }>> {
    const out: Record<string, any> = {};
    const a = this.addresses;
    await Promise.all(this.policy.chains.map(async (c) => {
      try {
        if (c === "solana") {
          const conn = new Connection(this.rpc("solana"), "confirmed");
          const owner = new PublicKey(a.solana);
          const lamports = await conn.getBalance(owner);
          const rows = [{ token: "SOL", amount: formatUnits(BigInt(lamports), 9) }];
          for (const [mint, meta] of Object.entries(STABLES.solana)) {
            const accts = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
            const raw = accts.value.reduce((s, x) => s + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
            rows.push({ token: meta.symbol, amount: formatUnits(raw, meta.decimals) });
          }
          out[c] = rows;
        } else {
          const p = new JsonRpcProvider(this.rpc(c), EVM_CHAIN_ID[c], { staticNetwork: true });
          const rows = [{ token: "ETH", amount: formatUnits(await p.getBalance(a.evm), 18) }];
          for (const [addr, meta] of Object.entries(STABLES[c])) {
            const bal = await new Contract(addr, ["function balanceOf(address) view returns (uint256)"], p).balanceOf!(a.evm);
            rows.push({ token: meta.symbol, amount: formatUnits(bal, meta.decimals) });
          }
          out[c] = rows;
        }
      } catch (e) { out[c] = { error: (e as Error).message.slice(0, 200) }; }
    }));
    return out;
  }

  private taker(chain: Chain) { return chain === "solana" ? this.addresses.solana : this.addresses.evm; }

  /** Dollar value of a quote. Stable side if there is one; Jupiter reports it; otherwise price the sell side against USDC. */
  async valueOf(q: SwapQuote): Promise<number | null> {
    if (q.usd_value !== null) return q.usd_value;
    if (q.venue === "jupiter") { const v = Number(q.raw?.swapUsdValue ?? q.raw?.inUsdValue); return Number.isFinite(v) && v > 0 ? v : null; }
    const usdc = Object.entries(STABLES[q.chain]).find(([, m]) => m.symbol === "USDC")?.[0];
    if (!usdc) return null;
    try {
      const ref = await getQuote({ chain: q.chain, sell_token: q.sell_token, buy_token: usdc, sell_amount: q.sell_amount, slippage_bps: 100 }, this.taker(q.chain), { fetch: this.f, proxy: this.o.proxy ?? DEFAULT_PROXY });
      return Number(ref.buy_amount) / 1e6;
    } catch { return null; }
  }

  /** A priced, checked quote. Nothing is signed. */
  async quote(req: SwapRequest): Promise<SwapResult> {
    const r = await this.priced(req, false);
    if (!("q" in r)) return r;
    const warning = balanceWarning(r.q);
    return { ok: true, quote: strip(r.q), ...(warning ? { warning } : {}) };
  }

  private async priced(req: SwapRequest, forTrade = true): Promise<{ q: SwapQuote } | SwapResult> {
    const refuse = (code: string, reason: string): SwapResult => ({ ok: false, refused: { code, reason } });
    if (!this.policy.chains.includes(req.chain)) return refuse("chain_off", `Trading on ${req.chain} is turned off.`);
    if (req.slippage_bps > this.policy.max_slippage_bps) return refuse("slippage", `Slippage ${req.slippage_bps / 100}% is over your maximum of ${this.policy.max_slippage_bps / 100}%.`);
    if (req.sell_token.toLowerCase() === req.buy_token.toLowerCase()) return refuse("same_token", "Sell and buy tokens are the same.");
    let q: SwapQuote;
    try { q = await getQuote(req, this.taker(req.chain), { fetch: this.f, proxy: this.o.proxy ?? DEFAULT_PROXY }); }
    catch (e) { return refuse("no_quote", (e as Error).message); }
    const bad = vetQuote(q, req);
    // A quote without a transaction is still a price; only trading needs one.
    if (bad && (forTrade || !/no transaction/.test(bad))) {
      const w = balanceWarning(q);
      return w && /no transaction/.test(bad) ? refuse("insufficient_balance", w) : refuse("unsafe_quote", bad);
    }
    const usd = await this.valueOf(q);
    if (usd === null) return refuse("unpriced", "Couldn't put a dollar value on this trade, so it can't be checked against your limits.");
    return { q: { ...q, usd_value: usd, fee_usd: (usd * q.fee_bps) / 10000 } };
  }

  /** Quote, check, approve if needed, reserve, sign, send, record. */
  async swap(req: SwapRequest): Promise<SwapResult> {
    const pr = await this.priced(req);
    if (!("q" in pr)) return pr;
    const q = pr.q;
    const usd = q.usd_value!;
    const p = this.policy;
    if (usd > p.per_trade_usd) return { ok: false, quote: strip(q), refused: { code: "over_per_limit", reason: `${money(usd)} is over the per-trade limit of ${money(p.per_trade_usd)}.` } };
    if (spentToday("trade", this.o.dir) + usd > p.daily_trades_usd) return { ok: false, quote: strip(q), refused: { code: "over_daily_limit", reason: `This would go over today's trading limit of ${money(p.daily_trades_usd)}.` } };
    if (usd > p.approval_above_usd) {
      const ask = this.approver;
      if (!ask) return { ok: false, quote: strip(q), refused: { code: "needs_approval", reason: `Trades over ${money(p.approval_above_usd)} need your approval, but Telegram approvals aren't set up.` } };
      const d = await ask(`Swap ${money(usd)} on ${q.chain} (${q.venue})?\nSell ${describeAmount(q.chain, q.sell_token, q.sell_amount)}\nGet at least ${describeAmount(q.chain, q.buy_token, q.min_buy_amount)}\nTollkit fee ${q.fee_bps / 100}% (${money(q.fee_usd ?? 0)})${q.venue_fee_bps ? `, venue fee ${q.venue_fee_bps / 100}%` : ""}`);
      if (d !== "approved") return { ok: false, quote: strip(q), refused: { code: d === "denied" ? "denied" : "approval_timeout", reason: d === "denied" ? "You denied this trade." : "No approval in time, so it wasn't traded." } };
    }
    let id: string;
    try { id = await reserve(p, "trade", usd, { chain: q.chain, seller: q.venue, tool: "swap", fee_usd: q.fee_usd ?? undefined, detail: `${describeAmount(q.chain, q.sell_token, q.sell_amount)} -> at least ${describeAmount(q.chain, q.buy_token, q.min_buy_amount)}` }, this.o.dir); }
    catch (e) { if (e instanceof LimitError) return { ok: false, quote: strip(q), refused: { code: e.code, reason: e.message } }; throw e; }
    try {
      const tx = await (this.o.execute ?? ((qq, k) => executeSwap(qq, k, { fetch: this.f, proxy: this.o.proxy, rpc: this.o.rpc })))(q, this.keys);
      settle(id, { status: "done", tx }, this.o.dir);
      return { ok: true, quote: strip(q), tx, receipt_id: id };
    } catch (e) {
      settle(id, { status: "failed", reason: (e as Error).message.slice(0, 300) }, this.o.dir);
      return { ok: false, quote: strip(q), receipt_id: id, refused: { code: "swap_failed", reason: (e as Error).message } };
    }
  }

  /** Fetch a URL, paying through x402 or MPP if it asks, within the owner's rules. */
  async pay(url: string, init?: RequestInit): Promise<PayResult> {
    return payFetch(url, init, this.keys, {
      dir: this.o.dir, policy: this.policy, fetch: this.f, sanctions: this.sanctions,
      checkSeller: (u, payTo) => checkSeller(u, payTo, this.f), approve: this.approver, solanaRpc: this.o.rpc?.solana,
    });
  }

  /**
   * Owner withdrawal. Needs the password again, so an agent holding an open
   * wallet can't move funds out this way. Not subject to the spending limits.
   */
  async withdraw(password: string, chain: Chain, token: Token, to: string, amountAtomic: string): Promise<{ ok: boolean; tx?: string; to?: string; refused?: { code: string; reason: string } }> {
    if (password !== this.password) return { ok: false, refused: { code: "wrong_password", reason: "wrong password" } };
    let dest: string;
    try { dest = checkDestination(chain, to); } catch (e) { return { ok: false, refused: { code: "bad_address", reason: (e as Error).message } }; }
    const saved = this.policy.withdraw_addresses.some((a) => a.chain === chain && (chain === "solana" ? a.address === dest : a.address.toLowerCase() === dest.toLowerCase()));
    if (!saved) return { ok: false, to: dest, refused: { code: "not_saved", reason: `${dest} isn't one of your saved withdrawal addresses on ${chain}. Add it first with \`tollkit-wallet addresses add ${chain} ${dest} <label>\`.` } };
    if (await this.sanctions.isSanctioned(dest)) return { ok: false, refused: { code: "sanctioned", reason: `${dest} is on the OFAC sanctions list.` } };
    if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) return { ok: false, refused: { code: "bad_amount", reason: "Amount must be more than zero." } };
    if (!this.o.send) {
      try {
        const have = await balanceAtomic(chain, token, chain === "solana" ? this.addresses.solana : this.addresses.evm, this.rpc(chain));
        if (have < BigInt(amountAtomic)) return { ok: false, to: dest, refused: { code: "insufficient_balance", reason: `The wallet has ${formatUnits(have, token.decimals)} ${token.symbol} on ${chain}, less than the ${formatUnits(BigInt(amountAtomic), token.decimals)} requested.` } };
      } catch { /* balance check unavailable; the chain will refuse an overdraft anyway */ }
    }
    const id = randomUUID(), ts = new Date().toISOString();
    const usd = /USD/.test(token.symbol) ? Number(amountAtomic) / 10 ** token.decimals : 0;
    const base = { id, ts, kind: "withdrawal" as const, usd, chain, seller: dest, tool: "withdraw", detail: `${Number(amountAtomic) / 10 ** token.decimals} ${token.symbol} -> ${dest}` };
    const log = (e: { status: "done" | "failed"; tx?: string; reason?: string }) => record({ ...base, ...e }, this.o.dir);
    try {
      const tx = await (this.o.send ?? ((r, k) => sendTokens(r, k, this.rpc(chain))))({ chain, token, to: dest, amount: amountAtomic }, this.keys);
      log({ status: "done", tx });
      return { ok: true, tx, to: dest };
    } catch (e) {
      log({ status: "failed", reason: (e as Error).message.slice(0, 300) });
      return { ok: false, to: dest, refused: { code: "send_failed", reason: (e as Error).message } };
    }
  }

  /** Autopilot rules for this wallet. */
  rules(): RuleStore { return new RuleStore(this.o.dir); }
  /** Paper trading book (real quotes, pretend money). */
  paper(startUsd?: number): PaperBook { return new PaperBook(this, { dir: this.o.dir, startUsd }); }
  /** What the autopilot trades with: the real wallet, or the paper book. */
  executor(mode: "live" | "paper" = "live"): Executor {
    const slippageBps = Math.min(100, this.policy.max_slippage_bps);
    if (mode === "paper") { const pb = this.paper(); return { mode, slippageBps, swap: (r) => pb.swap(r), quote: (r) => this.quote(r), balance: async (c, t) => pb.balance(c, t) }; }
    return { mode, slippageBps, swap: (r) => this.swap(r), quote: (r) => this.quote(r), balance: (c, t) => liveBalance(this.addresses, c, t, this.rpc(c), this.f) };
  }

  /** Drop the keys from memory. */
  lock() { this.keys = null as any; this.password = ""; }
}

export { NATIVE_EVM, WSOL };
