/**
 * 0.9.9: Autopilot never opens a strategy that works against the owner's own rules on the same coin.
 *
 * Each side's intended flow over the next 24 hours, in dollars (+ buys, − sells):
 *   Δₐ  what the proposed strategy would do: a DCA buys amount × runs a day; a dip buyer or Smart DCA buys its
 *       amount; grids and rebalancers trade both ways (≈ 0); a split sell sells.
 *   Δₒ  what the owner's active rules are set to do: scheduled DCA buys, split sells, and limit or take-profit
 *       orders whose price is within 2% of the market (about to fill). Stops are protection, not a plan to sell,
 *       so they don't count.
 * The proposal is refused when the two point opposite ways and Autopilot's side is material:
 *   Δₐ · Δₒ < 0  and  |Δₐ| ≥ 0.25 · |Δₒ|.
 */
import type { Rule } from "./rules.js";

const PER_DAY: Record<string, number> = { hour: 24, day: 1, week: 1 / 7 };
const NEAR = 0.02;

/** Δₐ for a template and its settings, in dollars over 24 hours. */
export function strategyFlow(template: string, params: Record<string, unknown>): number {
  const usd = Number(params.amount_usd) || 0;
  if (template === "dca") return usd * (PER_DAY[String(params.every ?? "day")] ?? 1);
  if (template === "dip" || template === "smart_dca") return usd;
  if (template === "twap") return params.side === "sell" ? -usd : usd;
  return 0; // grid, infinity grid, rebalance: both ways
}

/** Δₒ: the owner's own active rules on this coin, in dollars over 24 hours, at `price`. */
export function ownerFlow(rules: Rule[], chain: string, token: string, price: number | undefined): number {
  const t = token.toLowerCase();
  let flow = 0;
  for (const r of rules) {
    if (r.by === "superbot" || r.status !== "active" || r.chain !== chain || String(r.token).toLowerCase() !== t) continue;
    const near = (p?: number) => !!price && !!p && Math.abs(price - p) / price <= NEAR;
    if (r.kind === "dca") flow += (r.amount_usd ?? 0) * (PER_DAY[r.every ?? "day"] ?? 1);
    else if (r.kind === "twap") flow += r.side === "sell" ? -(r.amount_usd ?? (price && r.sell_amount ? Number(r.sell_amount) * price : 0)) : (r.amount_usd ?? 0);
    else if (r.kind === "limit_buy" && near(r.trigger_price)) flow += r.amount_usd ?? 0;
    else if ((r.kind === "limit_sell" || r.kind === "take_profit") && near(r.trigger_price) && price && r.sell_amount) flow -= Number(r.sell_amount) * price;
  }
  return flow;
}

/** A plain reason when the proposal works against the owner, or null. */
export function clashWithOwner(template: string, params: Record<string, unknown>, rules: Rule[], chain: string, token: string, price: number | undefined): string | null {
  const a = strategyFlow(template, params), o = ownerFlow(rules, chain, token, price);
  if (a * o < 0 && Math.abs(a) >= 0.25 * Math.abs(o)) {
    const usd = (n: number) => `$${Math.abs(n).toFixed(0)}`;
    return `it would ${a > 0 ? "buy" : "sell"} about ${usd(a)} a day while your own rules ${o > 0 ? "buy" : "sell"} about ${usd(o)} of it`;
  }
  return null;
}
