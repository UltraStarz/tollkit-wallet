/**
 * Plain-English strategies -> autopilot rules, without an AI model.
 *
 *   "buy $25 of SOL every Monday"
 *   "buy $100 of ETH if it drops to $2,300"        "buy $50 of SOL if it drops 5%"
 *   "sell half my ETH if it rises 10%"             "sell all ETH at $3,000"
 *   "sell all ETH if it falls 8%"                  "sell all SOL below $90"
 *   "trailing stop 10% on SOL"                     "sell SOL if it drops 10% from its high"
 *
 * Several sentences can be joined with "and", ";" or new lines. A take-profit
 * and a stop-loss on the same token are linked: when one fills, the other is
 * cancelled. Percent moves are turned into prices using the current price,
 * which the caller passes in. Anything not understood is returned, never guessed.
 */
import type { RuleInput } from "./rules.js";
import type { Chain } from "./chains.js";

export interface ParseResult { rules: RuleInput[]; unparsed: string[] }
export type PriceLookup = (token: string, chain: Chain) => number | undefined;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const num = (s: string) => Number(s.replace(/,/g, ""));
const TOKEN = String.raw`(eth|weth|sol|[a-z0-9]{2,10}|0x[0-9a-f]{40}|[1-9a-hj-np-z]{32,44})`;

function chainFor(token: string, text: string): Chain {
  const m = /\bon (base|ethereum|solana|mainnet)\b/i.exec(text);
  if (m) return (m[1]!.toLowerCase() === "mainnet" ? "ethereum" : m[1]!.toLowerCase()) as Chain;
  if (/^sol$/i.test(token) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) return "solana";
  return "base";
}

function sellShare(s: string): Pick<RuleInput, "sell_percent" | "sell_amount"> | null {
  if (/\b(all|everything|entire|whole)\b/i.test(s)) return { sell_percent: 100 };
  if (/\bhalf\b/i.test(s)) return { sell_percent: 50 };
  if (/\b(a )?quarter\b/i.test(s)) return { sell_percent: 25 };
  const pct = /\b(\d+(?:\.\d+)?)\s*%\s*(?:of)?/i.exec(s);
  if (pct && /\bsell\s+(\d+(?:\.\d+)?)\s*%/i.test(s)) return { sell_percent: num(pct[1]!) };
  const amt = new RegExp(String.raw`\bsell\s+(\d+(?:\.\d+)?)\s+${TOKEN}\b`, "i").exec(s);
  if (amt) return { sell_amount: amt[1]! };
  return null;
}

function parseOne(raw: string, price: PriceLookup): RuleInput | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const tok = (re: RegExp) => { const m = re.exec(s); return m?.[1]?.toUpperCase(); };

  // Recurring buy: "buy $25 of SOL every monday|day|week|hour", "dca $10 into eth daily"
  let m = new RegExp(String.raw`(?:buy|dca)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(?:usd|usdc|dollars)?\s+(?:of|in|into|worth of)\s+${TOKEN}\b.*?\b(?:every|each)\s+(hour|day|week|${DAYS.join("|")})`, "i").exec(s)
    ?? new RegExp(String.raw`(?:buy|dca)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(?:usd|usdc|dollars)?\s+(?:of|in|into|worth of)\s+${TOKEN}\b.*?\b(hourly|daily|weekly)`, "i").exec(s);
  if (m) {
    const token = m[2]!.toUpperCase(), unit = m[3]!.toLowerCase();
    const weekday = DAYS.indexOf(unit);
    const every = unit === "hourly" || unit === "hour" ? "hour" : unit === "daily" || unit === "day" ? "day" : "week";
    const times = /\b(\d+)\s+times\b/.exec(s)?.[1];
    const max = /\b(?:below|under|while (?:it'?s )?(?:below|under))\s+\$?(\d[\d,]*(?:\.\d+)?)/.exec(s)?.[1];
    return { kind: "dca", chain: chainFor(token, s), token, amount_usd: num(m[1]!), every, ...(weekday >= 0 ? { weekday } : {}), ...(times ? { times: Number(times) } : {}), ...(max ? { max_price: num(max) } : {}) };
  }

  // Trailing stop: "trailing stop 10% on SOL", "sell sol if it drops 10% from its high"
  m = new RegExp(String.raw`trailing stop(?: of)? (\d+(?:\.\d+)?)\s*% (?:on|for) ${TOKEN}`, "i").exec(s);
  const fromHigh = new RegExp(String.raw`sell .*?${TOKEN}.*?(?:drops?|falls?) (\d+(?:\.\d+)?)\s*% from (?:its|the) (?:high|peak|top)`, "i").exec(s);
  if (m || fromHigh) {
    const token = (m ? m[2]! : fromHigh![1]!).toUpperCase(), pct = num(m ? m[1]! : fromHigh![2]!);
    return { kind: "trailing_stop", chain: chainFor(token, s), token, trail_pct: pct, ...(sellShare(s) ?? { sell_percent: 100 }) };
  }

  // Buy on a dip / at a price: "buy $100 of eth if it drops to $2,300", "buy $50 of sol if it drops 5%", "buy $20 of sol below $90"
  m = new RegExp(String.raw`buy\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(?:usd|usdc|dollars)?\s+(?:of|worth of)\s+${TOKEN}\b(.*)`, "i").exec(s);
  if (m) {
    const token = m[2]!.toUpperCase(), rest = m[3]!, chain = chainFor(token, s);
    const at = /(?:drops? to|falls? to|at or below|below|under|at|hits?)\s+\$(\d[\d,]*(?:\.\d+)?)/.exec(rest);
    const dip = /(?:drops?|falls?|dips?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/.exec(rest);
    let trigger = at ? num(at[1]!) : undefined;
    if (!trigger && dip) { const p = price(token, chain); if (p) trigger = +(p * (1 - num(dip[1]!) / 100)).toPrecision(6); }
    if (trigger) return { kind: "limit_buy", chain, token, amount_usd: num(m[1]!), trigger_price: trigger };
    return null;
  }

  // Sells: take-profit, stop-loss, limit sell
  if (/\bsell\b/.test(s)) {
    const token = tok(new RegExp(String.raw`sell (?:(?:all|half|a quarter|everything|my|of|\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?)\s+)*(?:of\s+)?(?:my\s+)?${TOKEN}\b`, "i"));
    const share = sellShare(s);
    if (!token || !share) return null;
    const chain = chainFor(token, s);
    const p = price(token, chain);
    const up = /(?:rises?|goes up|gains?|is up|climbs?|pumps?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/.exec(s);
    const down = /(?:falls?|drops?|goes down|is down|loses?|dumps?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/.exec(s);
    const above = /(?:at|above|over|reaches?|hits?|rises to|goes to)\s+\$(\d[\d,]*(?:\.\d+)?)/.exec(s);
    const below = /(?:below|under|falls? to|drops? to)\s+\$(\d[\d,]*(?:\.\d+)?)/.exec(s);
    if (below) return { kind: "stop_loss", chain, token, trigger_price: num(below[1]!), ...share };
    if (down && p) return { kind: "stop_loss", chain, token, trigger_price: +(p * (1 - num(down[1]!) / 100)).toPrecision(6), ...share };
    if (above) return { kind: /take profit|profit/.test(s) ? "take_profit" : "limit_sell", chain, token, trigger_price: num(above[1]!), ...share };
    if (up && p) return { kind: "take_profit", chain, token, trigger_price: +(p * (1 + num(up[1]!) / 100)).toPrecision(6), ...share };
    return null;
  }
  return null;
}

export function parseStrategy(text: string, price: PriceLookup): ParseResult {
  const parts = text.split(/\n|;|\.\s+|\band then\b|\band\b(?=\s+(?:buy|sell|dca|trailing))/i).map((x) => x.trim()).filter(Boolean);
  const rules: RuleInput[] = [], unparsed: string[] = [];
  for (const p of parts) { const r = parseOne(p, price); if (r) rules.push(r); else unparsed.push(p); }
  // Link a take-profit with a stop-loss on the same token so one cancels the other.
  const byToken = new Map<string, RuleInput[]>();
  for (const r of rules) if (["take_profit", "limit_sell", "stop_loss", "trailing_stop"].includes(r.kind)) {
    const k = `${r.chain}:${r.token}`; byToken.set(k, [...(byToken.get(k) ?? []), r]);
  }
  for (const [k, rs] of byToken) if (rs.length > 1 && rs.some((r) => r.kind === "stop_loss" || r.kind === "trailing_stop")) {
    const g = `oco-${k.split(":")[1]!.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
    for (const r of rs) r.group = g;
  }
  return { rules, unparsed };
}
