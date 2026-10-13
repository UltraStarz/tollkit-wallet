/**
 * Paper trading: real quotes from 0x and Jupiter, pretend money. Fills use
 * the quote's actual output (after Tollkit's fee and the venue's), and the
 * owner's per-trade and daily limits still apply, so a strategy that works
 * here behaves the same with real funds. Nothing is signed or sent.
 * State lives in <wallet>/paper.json; reset with `tollkit-wallet paper reset`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatUnits } from "ethers";
import { walletHome } from "./paths.js";
import { KNOWN, type Token } from "./tokens.js";
import type { Chain } from "./chains.js";
import type { SwapRequest } from "./swap.js";
import type { SwapResult, TollkitWallet } from "./wallet.js";

export interface PaperFill { id: string; ts: string; chain: Chain; sell_token: string; buy_token: string; sell_amount: string; buy_amount: string; usd: number; fee_usd: number; detail: string }
interface PaperState { created_at: string; balances: Record<string, string>; fills: PaperFill[] }

const key = (chain: Chain, token: string) => `${chain}:${chain === "solana" ? token : token.toLowerCase()}`;

export class PaperBook {
  readonly file: string;
  constructor(private readonly w: Pick<TollkitWallet, "quote" | "policy">, private readonly o: { dir?: string; startUsd?: number } = {}) {
    this.file = path.join(walletHome(o.dir), "paper.json");
  }

  private load(): PaperState {
    if (existsSync(this.file)) { try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* reset below */ } }
    return this.fresh();
  }
  private fresh(): PaperState {
    const usd = this.o.startUsd ?? 1000;
    const balances: Record<string, string> = {};
    for (const c of ["base", "ethereum", "solana"] as Chain[]) balances[key(c, KNOWN[c].USDC!.address)] = String(BigInt(Math.round(usd * 1e6)));
    return { created_at: new Date().toISOString(), balances, fills: [] };
  }
  private save(s: PaperState) { const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(t, this.file); }

  reset(startUsd?: number) { if (startUsd !== undefined) this.o.startUsd = startUsd; this.save(this.fresh()); return this.summary(); }

  balance(chain: Chain, token: Token): bigint { return BigInt(this.load().balances[key(chain, token.address)] ?? "0"); }

  summary() {
    const s = this.load();
    const rows = Object.entries(s.balances).filter(([, v]) => v !== "0").map(([k, v]) => {
      const [chain, addr] = k.split(":") as [Chain, string];
      const t = Object.values(KNOWN[chain]).find((x) => key(chain, x.address) === k);
      return { chain, token: t?.symbol ?? addr, amount: t ? formatUnits(BigInt(v), t.decimals) : v };
    });
    return { since: s.created_at, balances: rows, fills: s.fills.length, fees_usd: +s.fills.reduce((a, f) => a + f.fee_usd, 0).toFixed(4), recent: s.fills.slice(-20).reverse() };
  }

  /** A pretend swap at the live quote. Same limits as real trades. */
  async swap(req: SwapRequest): Promise<SwapResult> {
    const q = await this.w.quote(req);
    if (!q.ok || !q.quote) return q;
    const s = this.load();
    const have = BigInt(s.balances[key(req.chain, req.sell_token)] ?? "0");
    if (have < BigInt(req.sell_amount)) return { ok: false, quote: q.quote, refused: { code: "insufficient_balance", reason: "Not enough paper balance for this trade." } };
    const usd = q.quote.usd_value ?? 0, p = this.w.policy;
    if (usd > p.per_trade_usd) return { ok: false, quote: q.quote, refused: { code: "over_per_limit", reason: `$${usd.toFixed(2)} is over the per-trade limit of $${p.per_trade_usd}.` } };
    const today = new Date().toISOString().slice(0, 10);
    const spent = s.fills.filter((f) => f.ts.slice(0, 10) === today).reduce((a, f) => a + f.usd, 0);
    if (spent + usd > p.daily_trades_usd) return { ok: false, quote: q.quote, refused: { code: "over_daily_limit", reason: `This would go over today's trading limit of $${p.daily_trades_usd}.` } };
    s.balances[key(req.chain, req.sell_token)] = String(have - BigInt(req.sell_amount));
    const bk = key(req.chain, req.buy_token);
    s.balances[bk] = String(BigInt(s.balances[bk] ?? "0") + BigInt(q.quote.buy_amount));
    const id = `paper-${randomUUID().slice(0, 8)}`;
    s.fills.push({ id, ts: new Date().toISOString(), chain: req.chain, sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: q.quote.buy_amount, usd, fee_usd: q.quote.fee_usd ?? 0, detail: `${req.sell_amount} -> ${q.quote.buy_amount}` });
    this.save(s);
    return { ok: true, quote: q.quote, tx: id };
  }
}
