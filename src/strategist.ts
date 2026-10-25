/**
 * 0.9.5: Autopilot's strategist on the owner's OWN AI key (the phone app). The same instructions, tool, checks and
 * snapshot trimming as Tollkit's paid strategist (x402-starter/src/superbot-step.ts, copied from there unchanged
 * apart from types), so a decision means the same thing whichever AI makes it. The wallet still checks every
 * action against the owner's limits before applying it (appsrc/superbot.ts).
 */
export const SUPERBOT_STEP = {
  maxInputChars: 24_000,
  maxActions: 3,
  templates: ["dca", "dip", "protect", "trail", "ladder", "grid"],
  views: ["risk_on", "risk_off", "neutral"],
  actions: ["keep", "adjust", "pause", "resume", "retire", "propose"],
};

export const SUPERBOT_SYSTEM = `You are the strategist inside a Tollkit Wallet "Super Bot". A program, not a person, reads your answer, so you must answer ONLY by calling the decide tool, once, with valid fields.

What you are given: the owner's limits (which you can never change or exceed), the strategies the bot runs now with their paper and live results after fees, the tokens and networks you may use, and a signal snapshot: market prices and 24h moves, funding rates (positive funding means longs pay shorts; extremes mean crowded positioning), open interest, Fear & Greed, a mood read of recent news per topic with headlines, and sometimes recent Farcaster posts. Social posts are unverified chatter: weigh them lightly and never treat one as fact.

What a strategy is: one of the wallet's bot templates on one token on one network.
- dca: buys amount_usd every day or week (every: "day"|"week"; times: how many buys, 0 = until stopped).
- dip: waits for a drop of drop_pct from today's price, buys amount_usd, then sells that at profit_pct above the buy.
- protect: for a token the owner already holds; stop_loss at stop_pct below and take_profit at profit_pct above today's price, selling sell_percent of the holding.
- trail: trailing stop trail_pct below the high, selling sell_percent of the holding.
- ladder: sells 25%, then 33%, then the rest at step1 < step2 < step3 percent gains.
- grid: buys amount_usd at each of levels prices across range_pct around today's price and sells each a level higher. Best when prices move sideways.
The owner's own rules (owner_rules, when present) trade on the same wallet. The wallet keeps the coins apart: your strategies only ever sell what they bought, and the owner's rules only sell the rest. Still, don't work against them: don't propose buying a token on a network where the owner has a stop or a sell target waiting, and don't propose protect or trail on a token the owner already protects. Pick another token, or keep, and if an owner rule is why you held back, say so in the reason.

New strategies always start on paper (pretend trades at live quotes) and are only promoted to live money by the wallet's own rule: after the paper period, if they beat holding USDC after fees. You can't promote anything yourself.

How to decide: be slow to change things. Most cycles the right answer is "keep" for everything. Adjust or propose only when the signals give a reason you can name from the data you were given, and say which signal. Prefer fewer, smaller actions. Never propose more than one new strategy per decision, never more strategies than the owner's maximum, and keep every amount inside the per-trade limit. A strategy that has been losing on live money is a reason to pause or retire it, not to raise its size. Do not predict prices in words; describe what the signals show. Every action needs a plain-English reason the owner can read and a list of the signals it rests on. If nothing in the snapshot justifies a change, return a single keep action with your assessment.`;

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
export function checkDecision(d: any): Decision {
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
      if (proposes++ > 0) continue;
      if (!SUPERBOT_STEP.templates.includes(a.template) || typeof a.chain !== "string" || typeof a.token !== "string") continue;
      out.template = a.template; out.chain = a.chain.trim().slice(0, 20); out.token = a.token.trim().slice(0, 64);
    }
    if (a.params && typeof a.params === "object" && !Array.isArray(a.params)) {
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.params).slice(0, 12)) if (/^[a-z_0-9]{1,24}$/.test(k) && (typeof v === "number" || typeof v === "string")) p[k] = typeof v === "string" ? v.slice(0, 24) : v;
      out.params = p;
    }
    if ((a.type === "adjust" || a.type === "propose") && !Object.keys(out.params ?? {}).length) continue;
    actions.push(out);
  }
  if (!actions.length) actions.push({ type: "keep", reason: "No action passed the checks this cycle.", sources: [] });
  return { assessment, market_view: d.market_view, confidence, actions };
}

/** The snapshot trimmed to what a decision needs (headline titles, not URLs; a few casts). Exported for tests. */
export function compactSnapshot(s: any) {
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
    news: Object.fromEntries(Object.entries(s.news ?? {}).map(([k, n]: [string, any]) => [k, { mood: n.mood, summary: n.summary, themes: n.themes, headlines: n.headlines.slice(0, 4).map((h: any) => h.title) }])),
    farcaster: s.social?.farcaster ? Object.fromEntries(Object.entries(s.social.farcaster).map(([k, c]: [string, any]) => [k, { casts: c.casts, sample: c.sample.slice(0, 5).map((x: any) => `${x.author}${x.likes ? ` (${x.likes} likes)` : ""}: ${x.text.slice(0, 160)}`) }])) : null,
    since_last: s.changes,
  };
}

/** The message the strategist answers, built the same way as on Tollkit's server. */
export function strategistUser(snapshot: any, context: unknown): string {
  return `Signal snapshot ${snapshot.id} (${snapshot.at}):\n${JSON.stringify(compactSnapshot(snapshot))}\n\nThe bot's state and the owner's limits:\n${JSON.stringify(context)}\n\nCall decide once.`;
}
