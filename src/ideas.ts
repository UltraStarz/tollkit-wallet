/**
 * Trade ideas: one-off swaps the wallet's AI chat suggests. An idea is only a suggestion with the quote it was
 * based on; nothing is signed until the owner taps Approve. Then the wallet gets a fresh quote and trades it
 * through the normal swap path (limits, token checks, receipts). The owner's tap is the approval, so it doesn't
 * ask a second time. Ideas expire after IDEA_TTL_MS because prices move.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatUnits } from "ethers";
import type { Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { spentToday, withLock } from "./ledger.js";
import { resolveToken, toAtomic } from "./tokens.js";
import type { TollkitWallet } from "./wallet.js";

export const IDEA_TTL_MS = 15 * 60_000;
const KEEP = 100;

export type IdeaStatus = "proposed" | "running" | "done" | "failed" | "dismissed" | "expired";
export interface TradeIdea {
  id: string;
  chain: Chain;
  /** What the owner sees: symbols and the amount sold, in normal units. */
  sell: string; buy: string; amount: string;
  /** What the wallet trades: the resolved token addresses. */
  sell_token: string; buy_token: string; sell_decimals: number; buy_decimals: number;
  slippage_bps?: number;
  reason?: string;
  created_at: string;
  status: IdeaStatus;
  /** The quote the idea was based on (an estimate; Approve gets a fresh one). */
  est: { usd: number; fee_usd: number; buy_amount: string; min_buy_amount: string };
  result?: { tx?: string; reason?: string; usd?: number; at: string };
}

export class IdeaStore {
  readonly file: string;
  constructor(private readonly dir?: string, private readonly now: () => number = Date.now) { this.file = path.join(walletHome(dir), "ideas.json"); }

  /** All ideas, newest last; proposals older than IDEA_TTL_MS read as expired. */
  list(): TradeIdea[] {
    let L: TradeIdea[] = [];
    try { if (existsSync(this.file)) L = JSON.parse(readFileSync(this.file, "utf8")); } catch { L = []; }
    const t = this.now();
    return L.map((i) => (i.status === "proposed" && t - Date.parse(i.created_at) > IDEA_TTL_MS ? { ...i, status: "expired" as const } : i));
  }
  get(id: string) { return this.list().find((i) => i.id === id); }

  private async mutate<T>(fn: (L: TradeIdea[]) => T): Promise<T> {
    return withLock(() => {
      const L = this.list(), out = fn(L);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(L.slice(-KEEP), null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      return out;
    }, this.dir);
  }

  async add(i: Omit<TradeIdea, "id" | "created_at" | "status">): Promise<TradeIdea> {
    const idea: TradeIdea = { ...i, id: randomUUID().slice(0, 8), created_at: new Date(this.now()).toISOString(), status: "proposed" };
    await this.mutate((L) => { L.push(idea); });
    return idea;
  }

  async dismiss(id: string): Promise<TradeIdea> {
    return this.mutate((L) => {
      const i = L.find((x) => x.id === id);
      if (!i) throw new Error("That trade idea isn't here anymore.");
      if (i.status !== "proposed") throw new Error(`That trade idea is already ${i.status}.`);
      i.status = "dismissed";
      return i;
    });
  }

  /** The owner tapped Approve: claim it (so a second tap can't trade twice), trade it, record what happened. */
  async approve(id: string, w: Pick<TollkitWallet, "swap">): Promise<TradeIdea> {
    const idea = await this.mutate((L) => {
      const i = L.find((x) => x.id === id);
      if (!i) throw new Error("That trade idea isn't here anymore.");
      if (i.status === "expired") throw new Error("This idea expired because prices move. Ask Claude again for a fresh one.");
      if (i.status !== "proposed") throw new Error(`That trade idea is already ${i.status}.`);
      i.status = "running";
      return { ...i };
    });
    let r: Awaited<ReturnType<TollkitWallet["swap"]>>;
    try {
      r = await w.swap({ chain: idea.chain, sell_token: idea.sell_token, buy_token: idea.buy_token, sell_amount: toAtomic(idea.amount, idea.sell_decimals), slippage_bps: idea.slippage_bps ?? 50 }, { ownerApproved: true });
    } catch (e) { r = { ok: false, refused: { code: "swap_failed", reason: (e as Error).message } }; }
    const at = new Date(this.now()).toISOString();
    return this.mutate((L) => {
      const i = L.find((x) => x.id === id)!;
      i.status = r.ok ? "done" : "failed";
      i.result = r.ok ? { tx: r.tx, usd: r.quote?.usd_value ?? undefined, at } : { reason: r.refused?.reason ?? "The swap didn't go through.", at };
      return i;
    });
  }
}

/**
 * Turns the AI's suggestion into an idea card: resolves the tokens, gets a checked quote, and refuses up front what
 * the owner's limits would refuse anyway, so the AI can say why instead of showing a card that can't work.
 */
export async function proposeSwap(w: TollkitWallet, a: { chain: string; sell: string; buy: string; amount: string; slippage_bps?: number; reason?: string }) {
  const refuse = (code: string, reason: string) => ({ ok: false, refused: { code, reason } });
  try {
    const chain = a.chain as Chain;
    const [sell, buy] = await Promise.all([resolveToken(chain, a.sell), resolveToken(chain, a.buy)]);
    if (!(await w.knownToken(chain, buy.address))) return refuse("unchecked_token", `${buy.symbol} isn't on the wallet's token list. The owner can add it on Home (Add a token), which runs Tollkit's scam check.`);
    const slippage = Math.min(a.slippage_bps ?? 50, w.policy.max_slippage_bps);
    const q = await w.quote({ chain, sell_token: sell.address, buy_token: buy.address, sell_amount: toAtomic(a.amount, sell.decimals), slippage_bps: slippage });
    if (!q.ok || !q.quote) return refuse(q.refused?.code ?? "no_quote", q.refused?.reason ?? "No quote for that swap.");
    const usd = q.quote.usd_value ?? 0;
    if (usd > w.policy.per_trade_usd) return refuse("over_per_limit", `That's about $${usd.toFixed(2)}, over the owner's per-trade limit of $${w.policy.per_trade_usd}. Suggest a smaller amount.`);
    if (spentToday("trade", w.dir) + usd > w.policy.daily_trades_usd) return refuse("over_daily_limit", `That would go over the owner's daily trading limit of $${w.policy.daily_trades_usd}.`);
    if (q.warning) return refuse("insufficient_balance", q.warning);
    const idea = await w.ideas().add({
      chain, sell: sell.symbol, buy: buy.symbol, amount: a.amount.trim(),
      sell_token: sell.address, buy_token: buy.address, sell_decimals: sell.decimals, buy_decimals: buy.decimals,
      ...(a.slippage_bps ? { slippage_bps: slippage } : {}), ...(a.reason ? { reason: a.reason.slice(0, 300) } : {}),
      est: { usd, fee_usd: q.quote.fee_usd ?? 0, buy_amount: formatUnits(BigInt(q.quote.buy_amount), buy.decimals), min_buy_amount: formatUnits(BigInt(q.quote.min_buy_amount), buy.decimals) },
    });
    return { ok: true, idea: { id: idea.id, swap: `${idea.amount} ${idea.sell} -> about ${(+idea.est.buy_amount).toPrecision(4)} ${idea.buy} on ${chain}`, usd: +usd.toFixed(2), fee_usd: +idea.est.fee_usd.toFixed(2) },
      note: "Shown to the owner as a card with an Approve button. Nothing has traded. It expires in 15 minutes." };
  } catch (e) { return refuse("bad_request", (e as Error).message); }
}
