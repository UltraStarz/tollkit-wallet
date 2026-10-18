/**
 * The wallet as one object: unlock once, then swap, pay, read balances and
 * receipts. Every spend goes through the owner's policy, the ledger lock,
 * and (above the threshold) a Telegram approval. Used by the CLI, the MCP
 * server, the dashboard and the framework plugins.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { sendAndConfirm } from "./solconfirm.js";
import { PriceFeed } from "./prices.js";
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { CHAIN_INFO, DEFAULT_RPC, EVM_CHAIN_ID, STABLES, SWAP_FEE_BPS, WSOL, NATIVE_EVM, chainName, type Chain } from "./chains.js";
import { addresses, unlock, type Keys } from "./keystore.js";
import { TokenList } from "./holdings.js";
import { findListed, isCoreToken, loadExtraLists, solanaInfo } from "./tokenlist.js";
import { entries, exportCsv, LimitError, record, reserve, settle, spentToday, type Entry } from "./ledger.js";
import { payFetch, type PayResult } from "./pay.js";
import { loadPolicy, savePolicy, type Policy } from "./policy.js";
import { files, walletHome } from "./paths.js";
import { Sanctions } from "./sanctions.js";
import { checkSeller } from "./seller.js";
import { executeSwap, getQuote, solFeeLamports, vetQuote, DEFAULT_PROXY, type SwapQuote, type SwapRequest } from "./swap.js";
import { requestApproval, type Decision, type TelegramConfig } from "./telegram.js";
import { balanceAtomic, checkDestination, sendTokens, type SendRequest } from "./send.js";
import { dashboardOpen, requestLocal } from "./approvals.js";
import { randomUUID } from "node:crypto";
import { KNOWN, type Token } from "./tokens.js";
import { RuleStore } from "./rules.js";
import { PaperBook } from "./paper.js";
import { liveBalance, type Executor } from "./autopilot.js";
import { Staking, type StakingOptions } from "./stake.js";
import { Sales, SEND_WINDOW_MS } from "./sell.js";
import { signRamp, type RampAuth, type RampKind } from "./rampauth.js";
import { DappBridge } from "./dapp.js";
import { publicFetch } from "./netguard.js";
import { Mover, canMove, fmtAmount, type MoveAsset, type MoverOptions, type MoveQuote } from "./bridge.js";

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
  /** Override for tests: the Solana connection and sender used for staking. */
  staking?: Pick<StakingOptions, "conn" | "send">;
  /** Override for tests: chain calls used when moving between networks. */
  mover?: Partial<MoverOptions>;
  /** Override for tests: network calls and approvals for sites using the browser extension. */
  dapp?: Partial<ConstructorParameters<typeof DappBridge>[0]>;
  /** Override for tests / other channels. Default: Telegram if configured. */
  approve?: ((text: string) => Promise<Decision>) | null;
  /** Override for tests: Tollkit's separately-sent Solana fee (recipient, SOL price, balance and sender). */
  solFee?: { recipient?: string; solUsd?: number; balance?: () => Promise<bigint>; send?: (lamports: bigint, to: string) => Promise<string> };
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
          const rows = [{ token: CHAIN_INFO[c].native, amount: formatUnits(await p.getBalance(a.evm), 18) }];
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

  /** Where and how much Tollkit's separately-sent Solana fee is. */
  private async separateFee(q: SwapQuote): Promise<{ lamports: bigint; to: string }> {
    let to = this.o.solFee?.recipient ?? q.raw?.build?.tollkit_fee?.recipient;
    if (!to) {
      const r = await this.f(`${this.o.proxy ?? DEFAULT_PROXY}/bridge/config`, { signal: AbortSignal.timeout(15_000) });
      const j: any = r.ok ? await r.json().catch(() => null) : null;
      to = String(j?.fee_recipient?.solana ?? "");
    }
    try { to = new PublicKey(to).toBase58(); } catch { throw new Error("Tollkit's fee address isn't available right now. Try again in a minute."); }
    let solUsd = this.o.solFee?.solUsd ?? null;
    if (solUsd === null && q.sell_token !== WSOL && q.buy_token !== WSOL) { const pf = new PriceFeed({ fetch: this.f }); await pf.refresh(); solUsd = pf.snapshot().prices.SOL?.usd ?? null; }
    return { lamports: solFeeLamports(q, q.usd_value, solUsd), to };
  }

  private async sendSolFee(fee: { lamports: bigint; to: string }): Promise<string> {
    if (this.o.solFee?.send) return this.o.solFee.send(fee.lamports, fee.to);
    const conn = new Connection(this.rpc("solana"), "confirmed");
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: this.keys.solana.publicKey, toPubkey: new PublicKey(fee.to), lamports: fee.lamports }));
    return sendAndConfirm(conn, tx, [this.keys.solana]);
  }

  /** A priced, checked quote. Nothing is signed. */
  async quote(req: SwapRequest): Promise<SwapResult> {
    const r = await this.priced(req, false);
    if (!("q" in r)) return r;
    const warning = balanceWarning(r.q);
    return { ok: true, quote: strip(r.q), ...(warning ? { warning } : {}) };
  }

  /** Core, listed (Superchain list on Base/Ethereum, Jupiter-verified on Solana) or added by the owner. */
  private async knownToken(chain: Chain, token: string): Promise<boolean> {
    if (token === NATIVE_EVM || token === WSOL || isCoreToken(chain, token)) return true;
    if ((new TokenList(this.o.dir).list()[chain] ?? []).some((a) => a.toLowerCase() === token.toLowerCase())) return true;
    if (chain !== "solana") { await loadExtraLists(this.f); return !!findListed(chain, token); }
    try { return (await solanaInfo([token], this.f)).get(token)?.trust === "listed"; } catch { return false; }
  }

  private async priced(req: SwapRequest, forTrade = true): Promise<{ q: SwapQuote } | SwapResult> {
    const refuse = (code: string, reason: string): SwapResult => ({ ok: false, refused: { code, reason } });
    if (!this.policy.chains.includes(req.chain)) return refuse("chain_off", `Trading on ${chainName(req.chain)} is turned off.`);
    if (req.slippage_bps > this.policy.max_slippage_bps) return refuse("slippage", `Slippage ${req.slippage_bps / 100}% is over your maximum of ${this.policy.max_slippage_bps / 100}%.`);
    if (req.sell_token.toLowerCase() === req.buy_token.toLowerCase()) return refuse("same_token", "Sell and buy tokens are the same.");
    // Buying a token the wallet doesn't know: only after the owner added it (which runs Tollkit's token check).
    if (forTrade && !(await this.knownToken(req.chain, req.buy_token))) return refuse("unchecked_token", `${req.buy_token} isn't on the wallet's token list and you haven't added it. Add it on Home (Add a token) first; that runs Tollkit's scam check.`);
    let q: SwapQuote;
    try { q = await getQuote(req, this.taker(req.chain), { fetch: this.f, proxy: this.o.proxy ?? DEFAULT_PROXY }); }
    catch (e) { return refuse("no_quote", (e as Error).message); }
    const bad = vetQuote(q, req, req.chain === "solana" ? undefined : this.taker(req.chain));
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
    // Solana pairs whose route can't carry Tollkit's 0.5%: built so the fee (in SOL) is inside the swap's own
    // transaction (fee_inline), or, when that path isn't available, sent on its own right after (fee_separate).
    let fee: { lamports: bigint; to: string } | null = null;
    if ((q.fee_separate || q.fee_inline) && q.fee_bps > 0) {
      try { fee = await this.separateFee(q); }
      catch (e) { return { ok: false, quote: strip(q), refused: { code: "no_quote", reason: (e as Error).message } }; }
      const have = await (this.o.solFee?.balance ?? (() => liveBalance(this.addresses, "solana", KNOWN.solana.SOL!, this.rpc("solana"), this.f)))();
      const need = fee.lamports + 15_000n + (q.sell_token === WSOL ? BigInt(q.sell_amount) : 0n);
      if (have < need) return { ok: false, quote: strip(q), refused: { code: "insufficient_balance", reason: `On this pair Tollkit's 0.5% fee is paid in SOL (${formatUnits(fee.lamports, 9)} SOL), and the wallet doesn't have enough SOL for it. Add a little SOL and try again.` } };
      if (q.fee_inline) { q.raw.fee = { lamports: fee.lamports.toString(), to: fee.to }; fee = null; } // goes in the swap itself
    }
    let id: string;
    try { id = await reserve(p, "trade", usd, { chain: q.chain, seller: q.venue, tool: "swap", fee_usd: q.fee_usd ?? undefined, detail: `${describeAmount(q.chain, q.sell_token, q.sell_amount)} -> at least ${describeAmount(q.chain, q.buy_token, q.min_buy_amount)}` }, this.o.dir); }
    catch (e) { if (e instanceof LimitError) return { ok: false, quote: strip(q), refused: { code: e.code, reason: e.message } }; throw e; }
    try {
      const tx = await (this.o.execute ?? ((qq, k) => executeSwap(qq, k, { fetch: this.f, proxy: this.o.proxy, rpc: this.o.rpc })))(q, this.keys);
      let feeNote: { fee_tx?: string; reason?: string } = {};
      if (fee) {
        try { feeNote = { fee_tx: await this.sendSolFee(fee) }; }
        catch (e) { feeNote = { reason: `The swap went through, but Tollkit's fee wasn't sent: ${(e as Error).message.slice(0, 200)}` }; }
      }
      settle(id, { status: "done", tx, ...feeNote }, this.o.dir);
      if (q.chain !== "solana" && q.buy_token !== NATIVE_EVM) try { new TokenList(this.o.dir).add(q.chain, q.buy_token); } catch { /* display only */ }
      return { ok: true, quote: strip(q), tx, receipt_id: id };
    } catch (e) {
      settle(id, { status: "failed", reason: (e as Error).message.slice(0, 300) }, this.o.dir);
      return { ok: false, quote: strip(q), receipt_id: id, refused: { code: "swap_failed", reason: (e as Error).message } };
    }
  }

  /** Fetch a URL, paying through x402 or MPP if it asks, within the owner's rules. */
  async pay(url: string, init?: RequestInit, opts: { publicOnly?: boolean; prefer?: Chain[] } = {}): Promise<PayResult> {
    // Agents only reach the public internet (not this computer or the local network), redirects included.
    const f = opts.publicOnly ? publicFetch(this.f) : this.f;
    return payFetch(url, init, this.keys, {
      dir: this.o.dir, policy: this.policy, fetch: f, sanctions: this.sanctions,
      checkSeller: (u, payTo) => checkSeller(u, payTo, f), approve: this.approver, solanaRpc: this.rpc("solana"), prefer: opts.prefer, // the same RPC as everything else (the public one refuses browser extensions)
    });
  }

  /** One token's balance on one chain, in atomic units (live, from the chain). */
  async balanceOf(chain: Chain, t: Token): Promise<bigint> {
    return liveBalance(this.addresses, chain, t, this.rpc(chain), this.f);
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

  /** SOL staking. Reading is open; stake, unstake and withdraw need the password every time. */
  staking(): Staking {
    return this.stk ??= new Staking({ owner: this.addresses.solana, rpc: this.rpc("solana"), ...(this.o.staking ?? {}) });
  }
  private stk?: Staking;

  async stakeAction(password: string, a: { action: "stake"; sol: number; vote: string } | { action: "unstake" | "withdraw"; account: string }): Promise<{ tx: string; account?: string }> {
    if (password !== this.password) throw new Error("wrong password");
    if (!this.policy.chains.includes("solana")) throw new Error("Solana is turned off in your settings.");
    const id = randomUUID(), ts = new Date().toISOString(), st = this.staking();
    const name = async (vote: string) => (await st.validators().catch(() => [])).find((v) => v.vote === vote)?.name ?? `${vote.slice(0, 4)}…${vote.slice(-4)}`;
    let detail = "", seller = "";
    const log = (e: { status: "done" | "failed"; tx?: string; reason?: string }) => record({ id, ts, kind: "stake", usd: 0, chain: "solana", seller, tool: a.action, detail, ...e }, this.o.dir);
    try {
      if (a.action === "stake") {
        if (!Number.isFinite(a.sol) || a.sol <= 0) throw new Error("Enter how much SOL to stake.");
        seller = a.vote; detail = `Stake ${a.sol} SOL with ${await name(a.vote)}`;
        const r = await st.stake(this.keys.solana, Math.round(a.sol * 1e9), a.vote);
        log({ status: "done", tx: r.tx });
        return r;
      }
      const acct = (await st.list()).find((x) => x.address === a.account);
      seller = acct?.voter ?? a.account;
      const sol = acct ? (a.action === "withdraw" ? acct.lamports : acct.delegated) / 1e9 : 0;
      detail = `${a.action === "unstake" ? "Unstake" : "Withdraw stake:"} ${sol} SOL${acct?.voter ?  " from " + (await name(acct.voter)) : ""}`;
      const tx = a.action === "unstake" ? await st.unstake(this.keys.solana, a.account) : (await st.withdraw(this.keys.solana, a.account)).tx;
      log({ status: "done", tx });
      return { tx };
    } catch (e) {
      if (detail) log({ status: "failed", reason: (e as Error).message.slice(0, 300) });
      throw e;
    }
  }

  /** Moving USDC/ETH between this wallet's own addresses on different networks. */
  mover(): Mover {
    return this.mv ??= new Mover({ evm: this.addresses.evm, solana: this.addresses.solana, dir: this.o.dir, proxy: this.o.proxy ?? DEFAULT_PROXY, fetch: this.o.fetch, rpc: this.o.rpc, ...(this.o.mover ?? {}) });
  }
  private mv?: Mover;

  /** A priced move (nothing signed). `amount` is in coins, e.g. "25" USDC or "0.05" ETH. */
  async moveQuote(asset: MoveAsset, from: Chain, to: Chain, amount: string): Promise<MoveQuote> {
    if (asset !== "USDC" && asset !== "ETH") throw new Error("Pick USDC or ETH.");
    for (const c of [from, to]) if (!this.policy.chains.includes(c)) throw new Error(`${chainName(c)} is turned off in your settings.`);
    if (!canMove(asset, from, to)) throw new Error(asset === "ETH" ? "ETH moves between Base and Ethereum only." : "Pick two different networks.");
    let atomic: bigint;
    try { atomic = parseUnits(String(amount).trim(), asset === "USDC" ? 6 : 18); } catch { throw new Error("Enter an amount like 25 or 0.05."); }
    return this.mover().quote(asset, from, to, atomic.toString());
  }

  /** Move with a fresh quote. Needs the password every time. */
  async move(password: string, asset: MoveAsset, from: Chain, to: Chain, amount: string, seenReceiveMin?: string) {
    if (password !== this.password) throw new Error("wrong password");
    const q = await this.moveQuote(asset, from, to, amount);
    // The quote is fetched again here; never accept one worse than what the owner was shown.
    if (seenReceiveMin !== undefined && /^\d+$/.test(seenReceiveMin) && BigInt(q.receive_min) < BigInt(seenReceiveMin)) throw new Error(`The price changed: you'd now get at least ${fmtAmount(asset, q.receive_min)}. Check the new quote and try again.`);
    const id = randomUUID(), ts = new Date().toISOString();
    const usd = asset === "USDC" ? Number(q.amount) / 1e6 : 0;
    const base = { id, ts, kind: "move" as const, usd, chain: from, seller: q.via === "cctp" ? "Circle CCTP" : "Across", tool: "move", fee_usd: asset === "USDC" ? Number(q.tollkit_fee) / 1e6 : undefined, detail: `${fmtAmount(asset, q.amount)} ${from} -> ${to}` };
    try {
      const rec = await this.mover().execute(q, this.keys);
      record({ ...base, status: "done", tx: rec.tx }, this.o.dir);
      return { ok: true, move: rec, quote: q };
    } catch (e) {
      record({ ...base, status: "failed", reason: (e as Error).message.slice(0, 300) }, this.o.dir);
      throw e;
    }
  }

  /** Websites using this wallet through the Tollkit browser extension. Approvals happen in the dashboard. */
  dapps(): DappBridge {
    return this.dp ??= new DappBridge({ evm: this.addresses.evm, solana: this.addresses.solana, keys: () => this.keys, chains: () => this.policy.chains, dir: this.o.dir, rpc: this.o.rpc, proxy: this.o.proxy,
      approve: (text) => requestLocal(this.o.dir, text, { timeoutMs: 5 * 60_000 }), ...(this.o.dapp ?? {}) });
  }
  private dp?: DappBridge;

  /** Cash-out sales started from the dashboard. */
  sales(): Sales { return this.sl ??= new Sales({ dir: this.o.dir, proxy: this.o.proxy, fetch: this.o.fetch, sign: (kind, network, address) => this.rampAuth(kind, network, address) }); }

  /** Signs a buy or cash-out request for one of this wallet's own addresses (Tollkit's server checks it). */
  rampAuth(kind: RampKind, network: Chain, address: string): Promise<RampAuth> {
    const own = network === "solana" ? this.addresses.solana : this.addresses.evm;
    if (network === "solana" ? address !== own : address.toLowerCase() !== own.toLowerCase()) return Promise.reject(new Error("That isn't this wallet's address."));
    return signRamp(this.keys, kind, network, own);
  }
  private sl?: Sales;

  /**
   * Send the crypto for a Coinbase sale, after the owner clicked "Cash out now" there. Needs the password.
   * Sends only what Coinbase reports for this sale, on the network and coin the owner picked, from this wallet.
   */
  async cashOutSend(password: string, ref: string): Promise<{ ok: true; tx: string; to: string; amount: string }> {
    if (password !== this.password) throw new Error("wrong password");
    const sale = this.sales().get(ref);
    if (!sale) throw new Error("That sale isn't from this wallet.");
    if (sale.state !== "open") throw new Error(sale.state === "sent" || sale.state === "sending" ? "Already sent for this sale. Check Activity." : `This sale is ${sale.state}.`);
    if (!sale.amount) throw new Error("This sale has no amount set. Start a new cash out with an amount.");
    if (this.selling.has(ref)) throw new Error("Already sending for this sale.");
    this.selling.add(ref);
    try { return await this.cashOutSendLocked(sale, ref); } finally { this.selling.delete(ref); }
  }
  private selling = new Set<string>();
  private async cashOutSendLocked(sale: NonNullable<ReturnType<Sales["get"]>>, ref: string): Promise<{ ok: true; tx: string; to: string; amount: string }> {
    const own = sale.chain === "solana" ? this.addresses.solana : this.addresses.evm;
    const t = await this.sales().status(own, ref);
    if (!t || !/STARTED/.test(t.status) || !t.to_address) throw new Error("Coinbase isn't ready yet. Click \"Cash out now\" on the Coinbase page first.");
    if (t.network.toLowerCase() !== sale.chain || t.asset.toUpperCase() !== sale.asset) throw new Error(`Coinbase is expecting ${t.asset} on ${t.network}, not ${sale.asset} on ${sale.chain}. Start a new cash out.`);
    if (t.from_address && (sale.chain === "solana" ? t.from_address !== own : t.from_address.toLowerCase() !== own.toLowerCase())) throw new Error("Coinbase is expecting the crypto from a different wallet.");
    const since = Date.parse(t.updated_at || t.created_at || "");
    if (Number.isFinite(since) && Date.now() - since > SEND_WINDOW_MS) throw new Error("Coinbase's 30 minutes to send have passed. Start a new cash out.");
    const token = KNOWN[sale.chain][sale.asset];
    if (!token) throw new Error("Unsupported coin.");
    const dest = checkDestination(sale.chain, t.to_address);
    let atomic: bigint;
    try { atomic = parseUnits(String(t.sell_amount?.value ?? ""), token.decimals); } catch { throw new Error("Coinbase didn't say how much to send."); }
    if (atomic <= 0n) throw new Error("Coinbase didn't say how much to send.");
    // Never more than the owner chose to sell, and only in the coin they picked.
    if (t.sell_amount?.currency && t.sell_amount.currency.toUpperCase() !== token.symbol) throw new Error(`Coinbase is expecting ${t.sell_amount.currency}, not ${token.symbol}. Start a new cash out.`);
    if (atomic > parseUnits(sale.amount!, token.decimals)) throw new Error(`Coinbase is expecting ${t.sell_amount!.value} ${token.symbol}, more than the ${sale.amount} you chose. Start a new cash out.`);
    if (!this.o.send) {
      const have = await balanceAtomic(sale.chain, token, own, this.rpc(sale.chain)).catch(() => null);
      if (have !== null && have < atomic) throw new Error(`The wallet has ${formatUnits(have, token.decimals)} ${token.symbol} on ${sale.chain}, less than the ${t.sell_amount!.value} Coinbase is expecting.`);
    }
    const id = randomUUID(), ts = new Date().toISOString();
    const base = { id, ts, kind: "withdrawal" as const, usd: token.symbol === "USDC" ? Number(t.sell_amount!.value) : 0, chain: sale.chain, seller: "Coinbase", tool: "cash out", detail: `${t.sell_amount!.value} ${token.symbol} -> Coinbase (cash out${t.total ? `, ${t.total.value} ${t.total.currency}` : ""})` };
    // Marked before signing, so a retry or a second click can never send twice.
    this.sales().update(ref, { state: "sending" });
    try {
      const tx = await (this.o.send ?? ((r, k) => sendTokens(r, k, this.rpc(sale.chain))))({ chain: sale.chain, token, to: dest, amount: atomic.toString() }, this.keys);
      record({ ...base, status: "done", tx }, this.o.dir);
      this.sales().update(ref, { state: "sent", tx });
      return { ok: true, tx, to: dest, amount: `${t.sell_amount!.value} ${token.symbol}` };
    } catch (e) {
      record({ ...base, status: "failed", reason: (e as Error).message.slice(0, 300) }, this.o.dir);
      // It may or may not have reached the network; don't offer to send again for this sale.
      this.sales().update(ref, { state: "failed", reason: (e as Error).message.slice(0, 200) });
      throw new Error(`${(e as Error).message.slice(0, 200)} Check Activity before starting a new cash out.`);
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
