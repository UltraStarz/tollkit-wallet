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
import { TEMPLATES, buildBot, summarize } from "./bots.js";
import { TokenList } from "./holdings.js";
import { KNOWN } from "./tokens.js";
import { checkToken, isCoreToken, loadExtraLists, searchEvm, searchSolana } from "./tokenlist.js";
import { serverRunnable } from "./alwayson.js";
import { buyLink } from "./buy.js";
import { budgetView } from "./appbudget.js";
import { SETUP_KIND_NAMES, Setups, showSetup, type SetupKind } from "./setups.js";

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

export const TokenArgs = z.object({ chain: z.enum(CHAIN_ENUM), address: z.string().min(32).max(64).describe("Contract address (0x…) or Solana mint") });
export const BotArgs = z.object({
  chain: z.enum(CHAIN_ENUM),
  token: z.string().min(2).max(64).describe("ETH, SOL, POL or a token address/mint the owner has added"),
  template: z.enum(["dca", "dip", "protect", "trail", "ladder", "grid"]),
  params: z.record(z.union([z.number(), z.string()])).optional().describe("The template's fields (bot_templates); defaults otherwise"),
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

/** Who is calling: the AI app's name (src/aiuse.ts), and whether it's the wallet's own AI chat (advisor). */
export interface ActionCtx { app?: string; advisor?: boolean }

export interface WalletAction<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  spends: boolean;
  /** `sets`: changes something in the wallet (rules, tokens, requests) without spending. */
  sets?: boolean;
  run: (w: TollkitWallet, args: z.infer<S>, ctx?: ActionCtx) => Promise<unknown>;
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
    run: async (w, a, ctx) => { try { const { req, sell, buy } = await swapRequest(w, a); return { ...(await w.swap(req, { by: ctx?.app })), sell, buy }; } catch (e) { return bad(e); } } }),
  def({ name: "pay_fetch", spends: true, schema: PayArgs,
    description: "Fetch a URL and pay for it if it asks (x402 or MPP, USDC/USDT on Base, Ethereum or Solana). Checks the seller, screens the recipient against OFAC, stays within the owner's limits. Returns the response body.",
    run: async (w, a, ctx) => {
      if (isLocalUrl(a.url)) return { paid: false, status: 0, refused: { code: "local_address", reason: "pay_fetch only calls public internet addresses." } };
      const r = await w.pay(a.url, { method: a.method ?? (a.body ? "POST" : "GET"), headers: a.headers, body: a.body }, { publicOnly: true, by: ctx?.app });
      let body: string | undefined;
      if (r.response) { const t = await r.response.text(); body = t.length > MAX_BODY ? t.slice(0, MAX_BODY) + `\n…[truncated ${t.length - MAX_BODY} chars]` : t; }
      return { paid: r.paid, status: r.status, receipt_id: r.receipt_id, cost_usd: r.offer?.usd, protocol: r.offer?.protocol, chain: r.offer?.chain, tx: r.tx, refused: r.refused, content_type: r.response?.headers.get("content-type"), body };
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
    description: "Set up autopilot rules: limit buy/sell, stop-loss, take-profit, trailing stop, recurring buy (DCA), grid, or an alert (kind \"alert\": notifies only, never trades; price above/below, a big 24h move, hourly RSI overbought/oversold, or crossing the 50-hour average). Give plain English in `text` (e.g. \"buy $25 of SOL every Monday; sell half my ETH if it rises 10% and all if it falls 8%\") or exact `rules`. Give each rule a short plain `reason`; to change an existing rule, propose its replacement with `replaces: <id>`. Unless the owner allows auto, rules wait for the owner to turn them on in the dashboard; fills follow the owner's limits.",
    run: async (w, a, ctx) => proposeRules(w, a, { neverAuto: ctx?.advisor, app: ctx?.app }) }),
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

  // ── 0.8.0: set up anything the owner can set up in the app ─────────────────────────────────────────────────
  // Tier 1 (below): done at once. Nothing here moves money or loosens a limit; the owner's limits, approvals and
  // each app's weekly budget still apply to every trade these set up.
  def({ name: "bot_templates", spends: false, schema: NoArgs,
    description: "The ready-made bots the owner can run (steady buyer/DCA, buy the dip, protect a position, trailing stop, take-profit ladder, grid) with each one's fields, defaults and risk, plus the owner's per-app budgets.",
    run: async (w) => ({ templates: TEMPLATES, app_budgets: budgetView(w.dir), agent_rules: w.policy.agent_rules }) }),
  def({ name: "bot_preview", spends: false, sets: false, schema: BotArgs,
    description: "Preview a bot at today's price without starting it: the plain rules it would make. Use it to show the owner what a bot will do.",
    run: async (w, a) => { try { const b = await makeBot(w, a); return { ok: true, name: b.built.name, price: b.price ?? null, rules: b.built.rules.map(describeRule) }; } catch (e) { return bad(e); } } }),
  def({ name: "bot_start", spends: false, sets: true, schema: BotArgs.extend({ reason: z.string().max(300).optional().describe("One plain sentence on why, shown to the owner") }),
    description: "Start a ready-made bot for the owner. Its trades follow the owner's limits and this app's weekly budget. Unless the owner allows auto, the bot waits for the owner to turn it on in the wallet.",
    run: async (w, a, ctx) => {
      try {
        const b = await makeBot(w, a);
        const auto = !ctx?.advisor && w.policy.agent_rules === "auto";
        const rules = b.built.rules.map((r) => ({ ...r, ...(a.reason ? { reason: a.reason } : {}) }));
        const made = await w.rules().addBot(rules, "agent", auto, ctx?.app);
        w.hooks.rulesChanged?.();
        return { ok: true, bot: b.built.bot, name: b.built.name, status: auto ? "active" : "proposed", rules: made.map(showRule),
          note: auto ? "The bot is on. It trades while the wallet is open, or on Tollkit's server if the owner turns on Keep running when closed." : "The bot is waiting for the owner to turn it on in the wallet (Bots tab)." };
      } catch (e) { return bad(e); }
    } }),
  def({ name: "bots_status", spends: false, schema: NoArgs,
    description: "Every bot and hand-made rule, grouped: status, trades, money in and out, result so far.",
    run: async (w) => summarize(w.rules().list().filter((r) => !r.archived)) }),
  def({ name: "bot_control", spends: false, sets: true, schema: z.object({ bot: z.string().min(4).max(40).describe("The bot id from bots_status"), action: z.enum(["pause", "resume", "stop", "remove"]) }),
    description: "Pause, resume or stop a bot, or remove a stopped or finished one from the list (its trades stay in Activity).",
    run: async (w, a) => {
      try {
        const store = w.rules(), done = (r: { status: string }) => ["done", "cancelled", "expired"].includes(r.status);
        const rs = store.list().filter((r) => !r.archived && (r.bot ?? `rule-${r.id}`) === a.bot);
        if (!rs.length) return { ok: false, refused: { code: "no_such_bot", reason: "No bot with that id." } };
        if (a.action === "remove") {
          if (!rs.every(done)) return { ok: false, refused: { code: "still_running", reason: "Stop it first; only stopped or finished bots can be removed." } };
          await store.archive(rs.map((r) => r.id)); return { ok: true, removed: rs.length };
        }
        const live = rs.filter((r) => !done(r));
        if (!live.length) return { ok: false, refused: { code: "finished", reason: "That bot has nothing left to change." } };
        const st = a.action === "pause" ? "paused" : a.action === "resume" ? "active" : "cancelled";
        for (const r of live) await store.setStatus(r.id, st);
        w.hooks.rulesChanged?.();
        return { ok: true, status: st, rules: live.map((r) => r.id) };
      } catch (e) { return bad(e); }
    } }),
  def({ name: "token_search", spends: false, schema: z.object({ chain: z.enum(CHAIN_ENUM), q: z.string().max(80).describe("Symbol or name; empty for the top tokens") }),
    description: "Search the wallet's token lists (Superchain and Uniswap lists on Base and Ethereum, Jupiter on Solana).",
    run: async (w, a) => { const f = (w as any).f ?? fetch; if (a.chain !== "solana") await loadExtraLists(f); return { tokens: a.chain === "solana" ? await searchSolana(a.q, f) : searchEvm(a.chain, a.q) }; } }),
  def({ name: "token_check", spends: false, schema: TokenArgs,
    description: "Tollkit's scam check on a token: symbol, decimals, whether it's on a trusted list, and plain warnings. Run it before token_add.",
    run: async (w, a) => { try { return { check: await checkToken(a.chain, a.address, { fetch: (w as any).f ?? fetch, proxy: (w as any).o?.proxy }) }; } catch (e) { return bad(e); } } }),
  def({ name: "token_add", spends: false, sets: true, schema: TokenArgs,
    description: "Add a token to the owner's wallet list so bots and swaps can buy it. Only tokens that pass the scam check with no warnings; otherwise the owner must add it in the wallet themselves.",
    run: async (w, a) => {
      try {
        if (isCoreToken(a.chain, a.address)) return { ok: true, note: "That's a core token; it's always on the list." };
        const check = await checkToken(a.chain, a.address, { fetch: (w as any).f ?? fetch, proxy: (w as any).o?.proxy });
        if (check.decimals === null) return { ok: false, refused: { code: "not_a_token", reason: `That address isn't a token on ${a.chain}.` } };
        if (check.warnings.length) return { ok: false, refused: { code: "needs_owner", reason: "This token has warnings, so only the owner can add it (Home, Add a token): " + check.warnings.join("; ") }, check };
        new TokenList(w.dir).add(a.chain, a.address);
        return { ok: true, token: { symbol: check.symbol, name: check.name }, check };
      } catch (e) { return bad(e); }
    } }),
  def({ name: "token_hide", spends: false, sets: true, schema: TokenArgs,
    description: "Take a token off the owner's wallet list (display only; nothing is sold).",
    run: async (w, a) => { new TokenList(w.dir).remove(a.chain, a.address); return { ok: true }; } }),
  def({ name: "always_on", spends: false, sets: true, schema: z.object({
      action: z.enum(["status", "on", "off", "off_all"]).describe("status: what runs on Tollkit's server; on/off: one rule; off_all: retire every permission"),
      rule: z.string().min(4).max(40).optional().describe("Rule id (autopilot_rules or bots_status), for on/off"),
    }),
    description: "\"Keep running when closed\": have Tollkit's server run a rule while the owner's device is off (gas paid by Tollkit, trades inside the limits the owner signed). Turning a rule on needs the owner to have picked the Always On budget once; raising that budget is a setup_request.",
    run: async (w, a) => {
      try {
        const ao = w.always();
        if (a.action === "status") return { ...ao.view(), config: (await ao.config()) ?? ao.view().config };
        if (a.action === "off_all") return { ok: true, ...(await ao.off()) };
        if (!a.rule) return { ok: false, refused: { code: "bad_request", reason: "Say which rule." } };
        const r = w.rules().get(a.rule);
        if (!r) return { ok: false, refused: { code: "no_such_rule", reason: "No rule with that id." } };
        if (a.action === "off") { ao.set(r.id, false); w.hooks.rulesChanged?.(); return { ok: true, rule: r.id, on: false }; }
        const cfg = await ao.config();
        if (!cfg?.enabled) return { ok: false, refused: { code: "unavailable", reason: cfg?.reason ?? "Can't reach Tollkit's server right now." } };
        if (!["active", "paused"].includes(r.status)) return { ok: false, refused: { code: "not_active", reason: "Turn the rule on first; only active rules can run on the server." } };
        const why = serverRunnable(r, cfg.chains);
        if (why) return { ok: false, refused: { code: "not_runnable", reason: why } };
        const v = ao.view();
        if ((r.kind === "dca" || r.kind === "limit_buy") && !(v.budget_usd > 0)) return { ok: false, refused: { code: "needs_owner", reason: "The owner hasn't picked the Always On budget yet. Ask them to turn on Keep running when closed once in the wallet, or send a setup_request of kind always_budget." } };
        ao.set(r.id, true); w.hooks.rulesChanged?.();
        return { ok: true, rule: r.id, on: true, budget_usd: v.budget_usd, note: "Handed to Tollkit's server on the next sync (within a few minutes while the wallet is open)." };
      } catch (e) { return bad(e); }
    } }),
  def({ name: "move_quote", spends: false, schema: z.object({ asset: z.enum(["USDC", "ETH"]), from: z.enum(CHAIN_ENUM), to: z.enum(CHAIN_ENUM), amount: z.string().regex(/^\d+(\.\d+)?$/) }),
    description: "Quote moving USDC or ETH between networks (nothing is signed). To do the move, send a setup_request of kind move; the owner taps Apply.",
    run: async (w, a) => { try { return await w.moveQuote(a.asset, a.from, a.to, a.amount); } catch (e) { return bad(e); } } }),
  def({ name: "buy_link", spends: false, schema: z.object({ chain: z.enum(CHAIN_ENUM), asset: z.string().max(8).describe("USDC, ETH or SOL"), amount_usd: z.number().min(5).max(10_000).optional() }),
    description: "A single-use Coinbase checkout link that buys crypto straight into this wallet with a card or bank. Give it to the owner to open; nothing is bought until they pay there.",
    run: async (w, a) => {
      try {
        if (!w.policy.chains.includes(a.chain)) return { ok: false, refused: { code: "chain_off", reason: `${a.chain} is turned off in the owner's limits.` } };
        return await buyLink(w.addresses, { chain: a.chain, asset: a.asset.toUpperCase(), amount_usd: a.amount_usd }, { proxy: (w as any).o?.proxy, fetch: (w as any).f, sign: (n, ad) => w.rampAuth("onramp", n, ad) });
      } catch (e) { return bad(e); }
    } }),
  // Tier 2: the app fills in the form, the owner applies it in the wallet (Approvals screen).
  def({ name: "setup_request", spends: false, sets: true, schema: z.object({
      kind: z.enum(SETUP_KIND_NAMES as [SetupKind, ...SetupKind[]]),
      params: z.record(z.unknown()).describe("The form for that kind; see the description"),
      reason: z.string().max(300).describe("One or two plain sentences for the owner on why"),
    }),
    description: "Ask the owner to make a change only they can make. They see it as a card in the wallet and tap Apply (with their password where the wallet always asks). Kinds and forms: "
      + "limits {per_trade_usd?, daily_trades_usd?, per_payment_usd?, daily_payments_usd?, per_seller_daily_usd?, approval_above_usd?, max_slippage_bps?, chains?, block_seller_warnings?, agent_rules?: propose|auto}; "
      + "withdraw_address {action: add|remove, chain, address, label?}; withdraw {chain, token, to (a saved address), amount}; move {asset: USDC|ETH, from, to, amount}; "
      + "cash_out {chain, asset, amount}; connect_app {app: claude|claude-code|cursor|vscode|codex|gemini}; "
      + "app_budget {app, weekly_usd (null removes)}; always_budget {budget_usd}. Requests expire after a day.",
    run: async (w, a, ctx) => { try { return { ok: true, request: showSetup(await new Setups(w.dir).add(a.kind, a.params, a.reason, ctx?.app ?? "An AI app")), note: "The owner will see this on the wallet's Approvals screen. Check setup_requests for what happened." }; } catch (e) { return bad(e); } } }),
  def({ name: "setup_requests", spends: false, schema: z.object({ status: z.enum(["waiting", "applied", "dismissed", "expired"]).optional() }),
    description: "Setup requests and what the owner did with them.",
    run: async (w, a) => new Setups(w.dir).list().filter((r) => !a.status || r.status === a.status).map(showSetup) }),
  def({ name: "setup_cancel", spends: false, sets: true, schema: RuleIdArgs,
    description: "Withdraw a setup request that is still waiting.",
    run: async (w, a) => { const r = await new Setups(w.dir).finish(a.id, "dismissed", "Withdrawn by the app"); return r ? { ok: true, request: showSetup(r) } : { ok: false, refused: { code: "not_waiting", reason: "That request isn't waiting." } }; } }),
] as const;


/** Resolve the token, check the owner knows it, price it, and build the template's rules (the same checks as the app). */
async function makeBot(w: TollkitWallet, a: z.infer<typeof BotArgs>) {
  if (!w.policy.chains.includes(a.chain)) throw new Error(`${a.chain} is turned off in the owner's limits.`);
  const unknown = "The owner hasn't added this token. Run token_check, then token_add (or ask the owner to add it on Home), then make the bot.";
  // An address the owner never added is refused before any network call; a symbol is resolved first.
  if (/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(a.token) && !(await w.knownToken(a.chain, a.token))) throw new Error(unknown);
  const tok = await resolveToken(a.chain, a.token);
  if (!(await w.knownToken(a.chain, tok.address))) throw new Error(unknown);
  let price: number | undefined;
  if (a.template !== "dca") {
    const feed = new PriceFeed(); await feed.refresh();
    price = feed.snapshot().prices[tok.symbol.toUpperCase()]?.usd;
    if (!price) {
      const q = await w.quote({ chain: a.chain, sell_token: tok.address, buy_token: KNOWN[a.chain].USDC!.address, sell_amount: (10n ** BigInt(tok.decimals)).toString(), slippage_bps: Math.min(100, w.policy.max_slippage_bps) });
      if (q.ok && q.quote?.usd_value) price = q.quote.usd_value;
    }
  }
  const sym = tok.symbol && /^[A-Z0-9.]{2,12}$/i.test(tok.symbol) && isCoreToken(a.chain, tok.address) ? tok.symbol : tok.address;
  return { tok, price, built: buildBot(a.template, sym, a.chain, a.params ?? {}, price) };
}

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

export async function proposeRules(w: TollkitWallet, a: z.infer<typeof ProposeArgs>, o: { neverAuto?: boolean; app?: string } = {}) {
  let drafts: RuleInput[] = [...(a.rules ?? [])], unparsed: string[] = [];
  if (a.text) {
    const feed = new PriceFeed(); await feed.refresh();
    const pr = parseStrategy(a.text, (t) => feed.snapshot().prices[t.toUpperCase()]?.usd);
    drafts = drafts.concat(pr.rules); unparsed = pr.unparsed;
  }
  if (!drafts.length) return { ok: false, refused: { code: "nothing_understood", reason: "No rules were understood. Try e.g. \"buy $25 of SOL every Monday\" or pass `rules`." }, unparsed };
  for (const d of drafts) { const why = ruleProblem(d); if (why) return { ok: false, refused: { code: "bad_rule", reason: `${describeRule(d)}: ${why}` }, unparsed }; }
  const store = w.rules(), auto = !o.neverAuto && w.policy.agent_rules === "auto", made = [] as ReturnType<typeof showRule>[];
  for (const d of drafts) { try { made.push(showRule(await store.add(d, "agent", auto, o.app))); } catch (e) { return { ok: false, refused: { code: "bad_rule", reason: `${describeRule(d)}: ${(e as Error).message}` }, rules: made, unparsed }; } }
  w.hooks.rulesChanged?.();
  return {
    ok: true, rules: made, unparsed,
    note: auto ? "These rules are on. The autopilot runs while the wallet's dashboard or `tollkit-wallet autopilot` is running." : "These rules are waiting for the owner to turn them on in the dashboard (Bots tab) or with `tollkit-wallet rule on <id>`.",
  };
}
