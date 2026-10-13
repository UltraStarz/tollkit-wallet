/**
 * The wallet's agent-facing actions, defined once and shared by the MCP
 * server, the AgentKit provider and the ElizaOS plugin. Spending stays inside
 * the owner's policy; nothing here can change limits, keys or withdrawal
 * addresses.
 */
import { z } from "zod";
import type { TollkitWallet } from "./wallet.js";
import { resolveToken, toAtomic } from "./tokens.js";
import { checkSeller } from "./seller.js";
import type { Chain } from "./chains.js";

const MAX_BODY = 50_000;

export const SwapArgs = z.object({
  chain: z.enum(["base", "ethereum", "solana"]).describe("Chain to trade on"),
  sell: z.string().describe("Token to sell: symbol (USDC, USDT, ETH, WETH, SOL) or contract/mint address"),
  buy: z.string().describe("Token to buy: symbol or contract/mint address"),
  amount: z.string().describe('Amount of the sell token in normal units, e.g. "25" or "0.01"'),
  slippage_bps: z.number().int().min(1).max(1000).optional().describe("Max slippage in basis points (default 50, capped by the owner's limit)"),
});
export const PayArgs = z.object({
  url: z.string().url().describe("The paid endpoint"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional().describe("Request body, e.g. JSON text"),
});
export const SellerArgs = z.object({ url: z.string().url(), pay_to: z.string().optional() });
export const ReceiptArgs = z.object({
  since: z.string().optional().describe("ISO date, e.g. 2026-10-01"),
  limit: z.number().int().min(1).max(500).optional(),
});
export const NoArgs = z.object({});

export interface WalletAction<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  spends: boolean;
  run: (w: TollkitWallet, args: z.infer<S>) => Promise<unknown>;
}

async function swapRequest(w: TollkitWallet, a: z.infer<typeof SwapArgs>) {
  const chain = a.chain as Chain;
  const [sell, buy] = await Promise.all([resolveToken(chain, a.sell), resolveToken(chain, a.buy)]);
  return { req: { chain, sell_token: sell.address, buy_token: buy.address, sell_amount: toAtomic(a.amount, sell.decimals), slippage_bps: a.slippage_bps ?? Math.min(50, w.policy.max_slippage_bps) }, sell, buy };
}
const bad = (e: unknown) => ({ ok: false, refused: { code: "bad_request", reason: (e as Error).message } });

const def = <S extends z.ZodTypeAny>(a: WalletAction<S>) => a;

export const ACTIONS = [
  def({ name: "wallet_status", spends: false, schema: NoArgs,
    description: "Wallet addresses, the owner's spending limits, what has been spent today, and whether approvals are on.",
    run: async (w) => w.status() }),
  def({ name: "wallet_balances", spends: false, schema: NoArgs,
    description: "Balances of the native coin and USDC/USDT on each enabled chain.",
    run: async (w) => w.balances() }),
  def({ name: "swap_quote", spends: false, schema: SwapArgs,
    description: "Get a checked quote for a spot swap without trading: dollar value, minimum received, Tollkit's 0.5% fee and any venue fee.",
    run: async (w, a) => { try { const { req, sell, buy } = await swapRequest(w, a); return { ...(await w.quote(req)), sell, buy }; } catch (e) { return bad(e); } } }),
  def({ name: "swap", spends: true, schema: SwapArgs,
    description: "Swap tokens (Base/Ethereum via 0x, Solana via Jupiter) within the owner's limits. Larger trades wait for the owner's approval. Flat 0.5% fee, shown in the result.",
    run: async (w, a) => { try { const { req, sell, buy } = await swapRequest(w, a); return { ...(await w.swap(req)), sell, buy }; } catch (e) { return bad(e); } } }),
  def({ name: "pay_fetch", spends: true, schema: PayArgs,
    description: "Fetch a URL and pay for it if it asks (x402 or MPP, USDC/USDT on Base, Ethereum or Solana). Checks the seller, screens the recipient against OFAC, stays within the owner's limits. Returns the response body.",
    run: async (w, a) => {
      const r = await w.pay(a.url, { method: a.method ?? (a.body ? "POST" : "GET"), headers: a.headers, body: a.body });
      let body: string | undefined;
      if (r.response) { const t = await r.response.text(); body = t.length > MAX_BODY ? t.slice(0, MAX_BODY) + `\n…[truncated ${t.length - MAX_BODY} chars]` : t; }
      return { paid: r.paid, status: r.status, cost_usd: r.offer?.usd, protocol: r.offer?.protocol, chain: r.offer?.chain, tx: r.tx, refused: r.refused, content_type: r.response?.headers.get("content-type"), body };
    } }),
  def({ name: "seller_check", spends: false, schema: SellerArgs,
    description: "Check a paid endpoint before buying: is it up, does its live price match its listing, does it pay where it says (Tollkit Weigh Station).",
    run: async (_w, a) => checkSeller(a.url, a.pay_to ?? "") }),
  def({ name: "receipts", spends: false, schema: ReceiptArgs,
    description: "Recent trades, payments and withdrawals with amounts, fees and transaction hashes.",
    run: async (w, a) => w.receipts(a.since).slice(-(a.limit ?? 50)) }),
] as const;
