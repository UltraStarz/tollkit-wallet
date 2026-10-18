/**
 * The wallet's agent-facing actions, defined once and shared by the MCP
 * server, the AgentKit provider and the ElizaOS plugin. Spending stays inside
 * the owner's policy; nothing here can change limits, keys or withdrawal
 * addresses.
 */
import { z } from "zod";
import { isLocalUrl } from "./netguard.js";
export { isLocalUrl } from "./netguard.js";
import type { TollkitWallet } from "./wallet.js";
import { resolveToken, toAtomic } from "./tokens.js";
import { checkSeller } from "./seller.js";
import { CHAIN_ENUM, type Chain } from "./chains.js";
import { RuleInput, describeRule, ruleProblem, type Rule } from "./rules.js";
import { parseStrategy } from "./parse.js";
import { PriceFeed } from "./prices.js";
import { proposeSwap } from "./ideas.js";

const MAX_BODY = 50_000;

export const SwapArgs = z.object({
  chain: z.enum(CHAIN_ENUM).describe("Chain to trade on"),
  sell: z.string().describe("Token to sell: symbol (USDC, USDT, ETH, WETH, SOL, POL) or contract/mint address"),
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
export const ProposeArgs = z.object({
  text: z.string().max(2000).optional().describe("Plain-English strategy"),
  rules: z.array(RuleInput).max(10).optional().describe("Exact rules instead of text"),
});
export const RulesListArgs = z.object({ status: z.enum(["proposed", "active", "paused", "done", "cancelled", "expired", "error"]).optional() });
export const RuleIdArgs = z.object({ id: z.string().min(4).max(40) });
export const HistoryArgs = z.object({
  token: z.enum(["ETH", "WETH", "SOL", "POL"]).describe("ETH (also WETH), SOL or POL; prices from Coinbase Exchange"),
  interval: z.enum(["15m", "1h", "6h", "1d"]).optional().describe("Candle size (default 1h)"),
  points: z.number().int().min(5).max(200).optional().describe("How many candles, newest last (default 48)"),
});

const GRAN = { "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 } as const;
/** Coinbase Exchange public candles: [time, low, high, open, close, volume], newest first, at most 300, no key. */
export async function priceHistory(a: z.infer<typeof HistoryArgs>, f: typeof fetch = fetch) {
  const product = a.token === "SOL" ? "SOL-USD" : a.token === "POL" ? "POL-USD" : "ETH-USD", interval = a.interval ?? "1h";
  const r = await f(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${GRAN[interval]}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { ok: false, refused: { code: "unavailable", reason: `Price history isn't available right now (HTTP ${r.status}).` } };
  const rows = ((await r.json()) as number[][]).sort((x, y) => x[0]! - y[0]!).slice(-(a.points ?? 48));
  if (!rows.length) return { ok: false, refused: { code: "unavailable", reason: "No price history returned." } };
  const closes = rows.map((x) => x[4]!), first = rows[0]![3]!, last = closes.at(-1)!;
  return {
    ok: true, token: a.token, interval, source: "Coinbase Exchange",
    from: new Date(rows[0]![0]! * 1000).toISOString(), to: new Date(rows.at(-1)![0]! * 1000).toISOString(),
    open: first, last, change_pct: +(((last - first) / first) * 100).toFixed(2),
    high: Math.max(...rows.map((x) => x[2]!)), low: Math.min(...rows.map((x) => x[1]!)),
    candles: rows.map(([t, low, high, open, close]) => ({ t: new Date(t! * 1000).toISOString(), open, high, low, close })),
  };
}

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
      if (isLocalUrl(a.url)) return { paid: false, status: 0, refused: { code: "local_address", reason: "pay_fetch only calls public internet addresses." } };
      const r = await w.pay(a.url, { method: a.method ?? (a.body ? "POST" : "GET"), headers: a.headers, body: a.body }, { publicOnly: true });
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
  def({ name: "market_prices", spends: false, schema: NoArgs,
    description: "Live USD prices and 24-hour change for ETH, SOL and USDT (Coinbase Exchange; USDC is $1).",
    run: async () => { const f = new PriceFeed(); await f.refresh(); return f.snapshot(); } }),
  def({ name: "price_history", spends: false, schema: HistoryArgs,
    description: "Recent price candles for ETH or SOL (open, high, low, close) with the period's change, high and low. Use it to judge trends and to set sensible trigger prices.",
    run: async (_w, a) => priceHistory(a) }),
  def({ name: "autopilot_propose", spends: false, schema: ProposeArgs,
    description: "Set up autopilot rules: limit buy/sell, stop-loss, take-profit, trailing stop, recurring buy (DCA). Give plain English in `text` (e.g. \"buy $25 of SOL every Monday; sell half my ETH if it rises 10% and all if it falls 8%\") or exact `rules`. Give each rule a short plain `reason`; to change an existing rule, propose its replacement with `replaces: <id>`. Unless the owner allows auto, rules wait for the owner to turn them on in the dashboard; fills follow the owner's limits.",
    run: async (w, a) => proposeRules(w, a) }),
  def({ name: "autopilot_rules", spends: false, schema: RulesListArgs,
    description: "The autopilot's rules with a plain description of each, status, last price seen, fills and any error.",
    run: async (w, a) => w.rules().list().filter((r) => !a.status || r.status === a.status).map(showRule) }),
  def({ name: "autopilot_cancel", spends: false, schema: RuleIdArgs,
    description: "Cancel an autopilot rule so it never trades.",
    run: async (w, a) => { try { return showRule(await w.rules().setStatus(a.id, "cancelled")); } catch (e) { return bad(e); } } }),
  def({ name: "paper_swap", spends: false, schema: SwapArgs,
    description: "Practice a swap with pretend money at the real live quote (fees included). Same limits as real trades; nothing is signed or sent.",
    run: async (w, a) => { try { const { req, sell, buy } = await swapRequest(w, a); return { ...(await w.paper().swap(req)), sell, buy, paper: true }; } catch (e) { return bad(e); } } }),
  def({ name: "paper_status", spends: false, schema: NoArgs,
    description: "Paper-trading balances, number of practice fills and fees they would have cost.",
    run: async (w) => w.paper().summary() }),
] as const;

export const SwapProposeArgs = SwapArgs.extend({
  reason: z.string().max(300).optional().describe("One or two plain sentences on why, shown on the card"),
});
/**
 * Only for the wallet's own AI chat (advisor mode): suggest one swap for the owner to approve with a tap. Agents
 * connected over MCP have `swap` itself, inside the owner's limits and approvals.
 */
export const SWAP_PROPOSE = def({ name: "swap_propose", spends: false, schema: SwapProposeArgs,
  description: "Suggest a single swap right now (not a rule). The wallet checks it against the owner's limits and shows it as a card with an Approve button; nothing trades until the owner taps it. Use when the owner asks to buy, sell or swap something now. Give `amount` in the sell token's units.",
  run: async (w, a) => proposeSwap(w, a) });

function showRule(r: Rule) {
  const last = r.state.fills.at(-1);
  return { id: r.id, status: r.status, description: describeRule(r), created_by: r.created_by, last_price: r.state.last_price, fills: r.state.fills.filter((f) => f.ok).length, last_fill: last, error: r.state.last_error, rule: { ...r, state: undefined } };
}

export async function proposeRules(w: TollkitWallet, a: z.infer<typeof ProposeArgs>, o: { neverAuto?: boolean } = {}) {
  let drafts: RuleInput[] = [...(a.rules ?? [])], unparsed: string[] = [];
  if (a.text) {
    const feed = new PriceFeed(); await feed.refresh();
    const pr = parseStrategy(a.text, (t) => feed.snapshot().prices[t.toUpperCase()]?.usd);
    drafts = drafts.concat(pr.rules); unparsed = pr.unparsed;
  }
  if (!drafts.length) return { ok: false, refused: { code: "nothing_understood", reason: "No rules were understood. Try e.g. \"buy $25 of SOL every Monday\" or pass `rules`." }, unparsed };
  for (const d of drafts) { const why = ruleProblem(d); if (why) return { ok: false, refused: { code: "bad_rule", reason: `${describeRule(d)}: ${why}` }, unparsed }; }
  const store = w.rules(), auto = !o.neverAuto && w.policy.agent_rules === "auto", made = [] as ReturnType<typeof showRule>[];
  for (const d of drafts) { try { made.push(showRule(await store.add(d, "agent", auto))); } catch (e) { return { ok: false, refused: { code: "bad_rule", reason: `${describeRule(d)}: ${(e as Error).message}` }, rules: made, unparsed }; } }
  return {
    ok: true, rules: made, unparsed,
    note: auto ? "These rules are on. The autopilot runs while the wallet's dashboard or `tollkit-wallet autopilot` is running." : "These rules are waiting for the owner to turn them on in the dashboard (Autopilot tab) or with `tollkit-wallet rule on <id>`.",
  };
}
