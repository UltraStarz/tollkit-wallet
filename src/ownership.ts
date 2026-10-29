/**
 * 0.9.1: whose coins are whose. Autopilot (rules made by the "superbot" app) and the owner's own rules trade from
 * the same wallet. Each rule keeps a running count of units it bought and sold (state.bought_units / sold_units,
 * including fills done on Tollkit's server while the app was closed), so the coins Autopilot's strategies hold are
 * known. Autopilot's sells only sell those; the owner's sells (a share of "your ETH") only sell the rest.
 * Paper rules never touch real coins, so they only count against paper balances.
 */
import { parseUnits } from "ethers";
import type { Rule } from "./rules.js";

export const AUTOPILOT_APP = "superbot";
export const isAutopilotRule = (r: Pick<Rule, "by">) => r.by === AUTOPILOT_APP;
/** Paper rules are marked when Autopilot makes them; older ones are recognised by their paper fills. */
export const isPaperRule = (r: Rule) => r.paper === true || r.state.fills.some((f) => f.paper);

function sameToken(r: Rule, chain: string, symbol: string, address: string): boolean {
  if (r.chain !== chain) return false;
  const t = r.token.toLowerCase();
  return t === symbol.toLowerCase() || t === address.toLowerCase();
}

/** Units of a token Autopilot's strategies hold right now (bought minus sold), in the given mode. */
export function autopilotUnits(rules: Rule[], chain: string, symbol: string, address: string, paper = false): number {
  // Only strategies still running own coins: once Autopilot retires one (or is turned off), what it bought is yours again.
  const LIVE = ["active", "paused", "proposed", "error"];
  const running = new Set(rules.filter((r) => isAutopilotRule(r) && LIVE.includes(r.status)).map((r) => r.bot ?? r.id));
  let n = 0;
  for (const r of rules) if (isAutopilotRule(r) && running.has(r.bot ?? r.id) && isPaperRule(r) === paper && sameToken(r, chain, symbol, address)) n += (r.state.bought_units ?? 0) - (r.state.sold_units ?? 0);
  return Math.max(0, n);
}

function toAtomic(units: number, decimals: number): bigint {
  if (!(units > 0)) return 0n;
  try { return parseUnits(units.toFixed(Math.min(decimals, 12)), decimals); } catch { return 0n; }
}

/**
 * How much of `bal` (smallest units, gas reserve already taken off) this rule may sell: Autopilot's rules only what
 * its strategies hold; everyone else's only what isn't Autopilot's.
 */
export function sellableFor(r: Rule, bal: bigint, rules: Rule[], tok: { symbol: string; address: string; decimals: number }, paper = false): bigint {
  const ap = toAtomic(autopilotUnits(rules, r.chain, tok.symbol, tok.address, paper), tok.decimals);
  if (isAutopilotRule(r)) return ap < bal ? ap : bal;
  return bal > ap ? bal - ap : 0n;
}

/**
 * 0.9.9: units the owner's own bots (grid, Smart DCA, ...) hold right now: their pools. The owner's plain sells
 * leave these alone, except stops, which may sell them (protection wins; src/pools.ts).
 */
export function ownerBotUnits(rules: Rule[], chain: string, symbol: string, address: string, paper = false): number {
  const LIVE = ["active", "paused", "proposed", "error"];
  const BOTS = ["grid", "smart_dca", "rebalance", "infinity_grid", "twap"];
  let n = 0;
  for (const r of rules) if (!isAutopilotRule(r) && BOTS.includes(r.kind) && LIVE.includes(r.status) && isPaperRule(r) === paper && sameToken(r, chain, symbol, address)) n += (r.state.bought_units ?? 0) - (r.state.sold_units ?? 0);
  return Math.max(0, n);
}
export const unitsToAtomic = toAtomic;

/** Plain reason when a sell finds nothing it may sell. */
export function nothingToSell(r: Rule, symbol: string, bal: bigint): string {
  if (isAutopilotRule(r)) return `Autopilot has no ${symbol} of its own to sell. It only sells what its strategies bought.`;
  return bal > 0n ? `The ${symbol} left belongs to Autopilot's strategies, so this rule leaves it alone.` : `No ${symbol} to sell.`;
}

/** Dollars of live trades Autopilot's rules made today (UTC), for its share of the daily trading limit. */
export function autopilotSpentToday(rules: Rule[], now = Date.now()): number {
  const day = new Date(now).toISOString().slice(0, 10);
  let usd = 0;
  for (const r of rules) if (isAutopilotRule(r) && !isPaperRule(r)) for (const f of r.state.fills) if (f.ok && !f.paper && f.ts.slice(0, 10) === day) usd += f.usd ?? 0;
  return usd;
}
