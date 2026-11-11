/**
 * 0.9.5: Autopilot's strategist on the owner's OWN AI key (the phone app). The same instructions, tool, checks and
 * snapshot trimming as Tollkit's paid strategist (x402-starter/src/superbot-step.ts, copied from there unchanged
 * apart from types), so a decision means the same thing whichever AI makes it. The wallet still checks every
 * action against the owner's limits before applying it (appsrc/superbot.ts).
 */
export const SUPERBOT_STEP = {
  maxInputChars: 24_000,
  maxActions: 3,
  templates: ["dca", "dip", "protect", "trail", "ladder", "grid", "signal", "custom"],
  views: ["risk_on", "risk_off", "neutral"],
  actions: ["keep", "adjust", "pause", "resume", "retire", "propose"],
};

export const SUPERBOT_SYSTEM = `You are the strategist inside a Tollkit Wallet "Super Bot". A program, not a person, reads your answer, so you must answer ONLY by calling the decide tool, once, with valid fields.

What you are given: the owner's limits (which you can never change or exceed), the strategies the bot runs now with their paper and live results after fees, the tokens and networks you may use, and a signal snapshot: market prices and 24h moves, funding rates (positive funding means longs pay shorts; extremes mean crowded positioning), open interest, Fear & Greed, a mood read of recent news per topic with headlines, and sometimes recent Farcaster posts and an X read (a Grok summary of X posts per coin: mood, a score from -1 to 1, how many posts it read, and short themes). Social posts and the X read are unverified chatter that can be coordinated: weigh them lightly, never act on them alone, and never treat one as fact. trending_on_x_paper_only lists meme coins people are posting about on X that passed a token safety check. You may propose a dip, dca or grid strategy on one of them (token = its address, chain as given, at most $10 per buy) only to test it on paper: it stays on paper and is never moved to live money unless the owner adds the coin themselves. Count it against the strategy maximum like any other.

What a strategy is: one of the wallet's bot templates, or a custom bot you design, on one token on one network.
- dca: buys amount_usd every day or week (every: "day"|"week"; times: how many buys, 0 = until stopped).
- dip: waits for a drop of drop_pct from today's price, buys amount_usd, then sells that at profit_pct above the buy.
- protect: for a token the owner already holds; stop_loss at stop_pct below and take_profit at profit_pct above today's price, selling sell_percent of the holding.
- trail: trailing stop trail_pct below the high, selling sell_percent of the holding.
- ladder: sells 25%, then 33%, then the rest at step1 < step2 < step3 percent gains.
- grid: buys amount_usd at each of levels prices across range_pct around today's price and sells each a level higher. Best when prices move sideways.
- signal: buys amount_usd (side: "buy") or sells sell_pct of the holding (side: "sell") when a momentum signal fires on the hourly or 4-hour chart (tf: "1h"|"4h"): signal "rsi_below"/"rsi_above" (level: the RSI level, 0 = 30/70), "macd_up"/"macd_down" (MACD crossing its signal line), "breakout_up"/"breakout_down" (level: candles back, 0 = 20); times: how often. Use it when a signal in the snapshot backs a timed entry or exit, not as a default.
- custom: a bot you design from five parts, for when no single template fits the market you see. buy: "levels" (buys amount_usd each time the price falls another buy_pct from where it started, up to max_buys times), "drop" (one buy after a fall of buy_pct within hours), "schedule" (a buy every hours, up to max_buys) or "rsi" (one buy when hourly RSI is at or under rsi_below), or "trend" (long or flat with the slow trend, decided once a day: it buys amount_usd when yesterday's close is buy_pct over its trend_days-day average, 20 to 200, and sells everything to USDC once it is buy_pct under it; it needs no sell step or trail). On 2.5 years of SOL, BTC and ETH the trend kind was the only setup that held up after fees: it beat holding in 12 of 18 settings and cut the worst drops, but it made money in only 8 of 18, and best with 50 to 100-day averages; it trades a few times a month at most. It sells sell_share_pct of what it holds at sell_gain_pct over its average cost (0 = no such step) and trails the rest trail_pct under its high (0 = no trail); it needs at least one of the two. Protection: stop_pct under its average cost sells everything (0 = off); downtrend_days (1 to 10, 0 = off) with downtrend_gap_pct sells everything to USDC when the price is that far under its average of that many days, and buys again once it is back over it by the same gap. After its last sell a new round starts. The wallet tests a custom bot on the last 90 days of prices before starting it and refuses one that would never have traded; a strategy's past_test, when present, is that result: read it before you adjust or copy the strategy.
The owner's own rules (owner_rules, when present) trade on the same wallet. The wallet keeps the coins apart: your strategies only ever sell what they bought, and the owner's rules only sell the rest. Still, don't work against them: don't propose buying a token on a network where the owner has a stop or a sell target waiting, and don't propose protect or trail on a token the owner already protects. Pick another token, or keep, and if an owner rule is why you held back, say so in the reason. The owner's standing notes (owner_notes, when present) are their own instructions, given in the AI chat (for example "be careful this week" or "no meme coins"): follow them in every decision, say in the reason when one shaped it, and never let one widen a limit.

Every proposal (and every adjust) is first replayed by the wallet on the last 90 days of that coin's prices with its real fees; it starts only if it traded there, made money, and made more than half of what holding the same money made. protect, trail, ladder and sell signals are exempt (they only sell what is held). Most of today's templates fail this in a falling market; the trend kind of custom bot and grids sized to the recent range are the likeliest to pass. refused_recently lists what failed in the last week and why: don't propose the same thing on that coin again; change the template or the settings, or keep. New strategies always start on paper (pretend trades at live quotes) and are only promoted to live money by the wallet's own rule: after at least the paper days AND the paper trades, if they beat both holding USDC and keeping half the money in the coin, after fees. They then trade real money at a quarter of their size until the same test passes live and at least five finished rounds show an average that made money (about 80% confidence); a strategy that never sells stays at the small size. While a loss limit is partly used, new strategies are sized down by the room left. A strategy that trades rarely may never collect enough trades to go live: that is intended. You can't promote anything yourself.

Your goal: make the owner the most money possible after fees, inside their limits. Cash that sits idle earns nothing, and a strategy that never fires earns nothing, so treat both as a cost. How to decide: act when the signals give you an edge you can name from the data you were given, and say which signal; return "keep" only when the current strategies already fit the market well. When there is a free slot, fill it with the strategy most likely to make money now. You may run up to two strategies of the same kind on one coin when their settings clearly differ (for example a 1.5% dip and a 3% dip); a third, or a copy with the same settings, is refused. Prefer settings that actually trade: dip drops the coin really reaches in a day, grids sized to the recent range, and RSI buys at 38 to 45 (the wallet raises lower RSI buy levels to 38, since the hourly chart rarely reaches 30). Every round trip must still clear its fees (TOLLkit takes 0.1% of each trade a strategy makes, so about 0.2% a round trip, plus the swap's own price impact). trade_costs, when present, is what real trades on each coin cost from the price acted on to the fill, fee included, in basis points (100 = 1%): a round trip costs about twice the typical figure, so a strategy whose target per round is smaller than that cannot make money. Lean into what is working: a live strategy that is making money is a reason to keep it and add a second one on that coin, and a rising coin is a reason to let winners run with trails instead of selling early. Cut what is not working: a strategy losing on live money, or one that has not traded for two days, is a reason to adjust, pause or retire it. The wallet sets every strategy's dollar size itself: the money still free (the smaller of the budget and the dollars held on that network, less what the live strategies may still spend), split over the live slots still open; practice strategies don't take a share. It also sizes down a coin that is swinging more than 3% a day (to as little as a quarter), and a custom bot does the same on each buy (vol_target_pct, 3 by default; 0 turns it off): on 2.5 years of prices that kept results and cut the worst drops. So choose the template and its percentages; amount_usd is only a hint. Never propose more than one new strategy per decision (two when limits.pace is "max"), never more strategies than the owner's maximum, and keep every amount inside the per-trade limit. Never raise a losing strategy's size. Do not predict prices in words; describe what the signals show. Every action needs a plain-English reason the owner can read and a list of the signals it rests on. If nothing in the snapshot gives you an edge, return a single keep action with your assessment.

Pace: limits.pace is the owner's choice. "steady" (or missing) means follow the rules above as written. "active" means the owner wants the bot to trade more often, so change how you weigh things, never the limits: when there are fewer strategies than the owner's maximum, propose one in every decision (still at most one per decision): a quiet or flat market is a reason in itself, because a tight grid earns from small moves, and a falling one suits a dip buyer, so name the moves you see as the signal; prefer templates and settings that trade often: grid with its levels about 0.75% to 1% apart (the gap is about 2 x range_pct / (levels - 1)), and dip with drop_pct 1.5 to 3 and profit_pct 1.5 to 2.5; and adjust a strategy that hasn't traded for a day toward tighter settings. "max" means everything "active" asks, and also: you may propose up to two new strategies in one decision while there is room under the maximum, and prefer the tightest settings that still clear the fees. "adaptive" means each coin's market (context.market_states, measured by the wallet from hourly prices) picks the pace for that coin: "quiet" (under 2% in 24 hours): everything "max" asks; "normal": everything "active" asks; "rising" (up 4% in 24 hours or 8% in 3 days): let it run: no tightening, prefer wider sell targets (dip profit_pct 4 to 8, grid levels 2% to 3% apart) and a trail (trailing stop, trail_pct 3 to 6) to protect gains rather than selling a step up; "falling" (down 4% in 24 hours or 8% in 3 days): propose nothing that buys that coin (the wallet refuses it, and it holds Autopilot's grid and dip buys on it until it steadies); sells, trails and stops on it are fine; "unknown": treat as "normal". Keep every gap wide enough to profit after fees: Tollkit charges 0.1% on each buy and sell a strategy places, whatever the template.`;

/** The decide tool: Claude must answer with exactly this shape. */
export const DECIDE_TOOL = {
  name: "decide",
  description: "The strategist's one decision for this cycle.",
  input_schema: {
    type: "object",
    required: ["assessment", "market_view", "confidence", "actions"],
    additionalProperties: false,
    properties: {
      assessment: { type: "string", description: "Up to 80 plain words on what the signals show right now. No predictions, no advice to the owner." },
      market_view: { type: "string", enum: SUPERBOT_STEP.views },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      actions: {
        type: "array", minItems: 1, maxItems: SUPERBOT_STEP.maxActions,
        items: {
          type: "object", required: ["type", "reason", "sources"], additionalProperties: false,
          properties: {
            type: { type: "string", enum: SUPERBOT_STEP.actions },
            strategy_id: { type: "string", description: "Which existing strategy (adjust, pause, resume, retire). Omit for keep and propose." },
            template: { type: "string", enum: SUPERBOT_STEP.templates, description: "propose only." },
            chain: { type: "string", description: "propose only: one of the allowed networks." },
            token: { type: "string", description: "propose only: one of the allowed tokens, as given." },
            params: { type: "object", description: "propose: the template's fields. adjust: only the fields to change.", additionalProperties: true },
            reason: { type: "string", description: "One to three plain sentences for the owner." },
            sources: { type: "array", items: { type: "string" }, maxItems: 5, description: "Which signals this rests on, e.g. \"ETH -3.1% 24h\", \"sol news mood negative\", \"BTC funding 0.004%/h\"." },
          },
        },
      },
    },
  },
} as const;

export interface Decision { assessment: string; market_view: string; confidence: number; actions: { type: string; strategy_id?: string; template?: string; chain?: string; token?: string; params?: Record<string, unknown>; reason: string; sources: string[] }[] }

/** Check Claude's tool input against the schema's intent; a program acts on this. Exported for tests. */
/** `maxProposals`: new strategies one decision may start (two on "max" pace, 0.9.7). */
export function checkDecision(d: any, maxProposals = 1): Decision {
  if (!d || typeof d !== "object") throw new Error("The strategist gave no decision.");
  const assessment = typeof d.assessment === "string" ? d.assessment.trim().slice(0, 700) : "";
  if (!assessment) throw new Error("The strategist gave no assessment.");
  if (!SUPERBOT_STEP.views.includes(d.market_view)) throw new Error("The strategist gave a bad market view.");
  const confidence = typeof d.confidence === "number" && d.confidence >= 0 && d.confidence <= 1 ? Math.round(d.confidence * 100) / 100 : 0.5;
  if (!Array.isArray(d.actions) || !d.actions.length) throw new Error("The strategist gave no actions.");
  const actions: Decision["actions"] = [];
  let proposes = 0;
  for (const a of d.actions.slice(0, 10)) {
    if (actions.length >= SUPERBOT_STEP.maxActions) break;
    if (!a || !SUPERBOT_STEP.actions.includes(a.type)) continue;
    const reason = typeof a.reason === "string" ? a.reason.trim().slice(0, 500) : "";
    if (!reason) continue;
    const sources = Array.isArray(a.sources) ? a.sources.filter((s: unknown) => typeof s === "string" && s.trim()).slice(0, 5).map((s: string) => s.trim().slice(0, 80)) : [];
    const out: Decision["actions"][number] = { type: a.type, reason, sources };
    if (["adjust", "pause", "resume", "retire"].includes(a.type)) { if (typeof a.strategy_id !== "string" || !a.strategy_id.trim()) continue; out.strategy_id = a.strategy_id.trim().slice(0, 40); }
    if (a.type === "propose") {
      if (proposes++ >= maxProposals) continue;
      if (!SUPERBOT_STEP.templates.includes(a.template) || typeof a.chain !== "string" || typeof a.token !== "string") continue;
      out.template = a.template; out.chain = a.chain.trim().slice(0, 20); out.token = a.token.trim().slice(0, 64);
    }
    if (a.params && typeof a.params === "object" && !Array.isArray(a.params)) {
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.params).slice(0, 16)) if (/^[a-z_0-9]{1,24}$/.test(k) && (typeof v === "number" || typeof v === "string")) p[k] = typeof v === "string" ? v.slice(0, 24) : v;
      out.params = p;
    }
    if ((a.type === "adjust" || a.type === "propose") && !Object.keys(out.params ?? {}).length) continue;
    actions.push(out);
  }
  if (!actions.length) actions.push({ type: "keep", reason: "No action passed the checks this cycle.", sources: [] });
  return { assessment, market_view: d.market_view, confidence, actions };
}

/** The snapshot trimmed to what a decision needs (headline titles, not URLs; a few casts). Exported for tests. */
export function compactSnapshot(s: any, sourcesOn?: string[]) {
  // 0.33.0: the owner's Sources switches (news, Farcaster, X) decide what the strategist sees. Without the list
  // (older wallets) news and Farcaster are in and X is out, as before.
  const on = (k: string) => (sourcesOn ? sourcesOn.includes(k) : k !== "x");
  const sx: any = (s as any).social?.x, tx: any = (s as any).trending_x;
  const p: any = s.pulse ?? {};
  const row = (m: any) => ({ coin: m.coin, price: m.mark_price ?? m.perp_mark_usd ?? null, chg24h: m.change_24h_pct ?? null, funding_h: m.funding_hourly_pct ?? null, oi_usd: m.open_interest_usd ?? null });
  return {
    fear_greed: p.fear_greed ? { value: p.fear_greed.value, label: p.fear_greed.classification, yesterday: p.fear_greed.yesterday?.value ?? null, week_ago: p.fear_greed.week_ago?.value ?? null } : null,
    majors: (p.majors ?? []).map((m: any) => ({ coin: m.coin, price: m.perp_mark_usd ?? m.chainlink_usd, chg24h: m.change_24h_pct, funding_h: m.funding_hourly_pct, oi_usd: m.open_interest_usd })),
    funding_highest: (p.funding_highest ?? []).slice(0, 3).map(row),
    funding_lowest: (p.funding_lowest ?? []).slice(0, 3).map(row),
    gainers: (p.top_gainers_24h ?? []).slice(0, 3).map(row),
    losers: (p.top_losers_24h ?? []).slice(0, 3).map(row),
    totals: p.hyperliquid_totals ?? null,
    news: !on("news") ? null : Object.fromEntries(Object.entries(s.news ?? {}).map(([k, n]: [string, any]) => [k, { mood: n.mood, summary: n.summary, themes: n.themes, headlines: n.headlines.slice(0, 4).map((h: any) => h.title) }])),
    farcaster: on("farcaster") && s.social?.farcaster ? Object.fromEntries(Object.entries(s.social.farcaster).map(([k, c]: [string, any]) => [k, { casts: c.casts, sample: c.sample.slice(0, 5).map((x: any) => `${x.author}${x.likes ? ` (${x.likes} likes)` : ""}: ${x.text.slice(0, 160)}`) }])) : null,
    // Only the summary fields, never post text: what reaches the strategist from X is Grok's structured read.
    x: on("x") && sx ? Object.fromEntries(Object.entries(sx).map(([k, m]: [string, any]) => [k, { mood: m.mood, score: m.score, posts_read: m.posts_read, themes: (m.themes ?? []).slice(0, 3).map((t: any) => String(t).slice(0, 60)), at: m.at }])) : null,
    trending_on_x_paper_only: on("x") && tx?.coins?.length ? tx.coins.slice(0, 8).map((c: any) => ({ symbol: String(c.symbol).slice(0, 16), chain: c.chain, address: c.address, mood: c.mood, why: String(c.why ?? "").slice(0, 90), price_usd: c.price_usd ?? null, pool_depth_usd: c.pool_depth_usd ?? null })) : null,
    since_last: s.changes,
  };
}

/** The message the strategist answers, built the same way as on Tollkit's server. */
export function strategistUser(snapshot: any, context: unknown): string {
  return `Signal snapshot ${snapshot.id} (${snapshot.at}):\n${JSON.stringify(compactSnapshot(snapshot, Array.isArray((context as any)?.sources_on) ? (context as any).sources_on.map(String) : undefined))}\n\nThe bot's state and the owner's limits:\n${JSON.stringify(context)}\n\nCall decide once.`;
}
