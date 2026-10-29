/**
 * 0.9.9: when sells compete for the same coins. Tollkit's server keeps a copy of this file (x402-starter
 * src/pools.ts); keep the two in step.
 *
 * Every rule sells from its own pool, and the pools never add up to more than the wallet holds:
 *   Σ granted ≤ H.
 * When the sells that fire together want more than that, they are served by tier: stops first (they protect),
 * then take-profits and limit sells, then bots, then anything else. Each tier in turn gets what's left. The first
 * tier that doesn't fit is shared pro rata:
 *   gᵢ = ⌊wantᵢ · avail / Σwant⌋, and the few units of rounding left over go one each to the largest asks,
 * so nothing is lost and no rule gets more than it asked for. Tiers after it get nothing this round and try again.
 *
 * A tier can have its own ceiling: a stop may sell coins the owner's bots hold (protection wins), while a
 * take-profit may only sell coins no bot holds. `capFor(tier)` is the most all sells up to and including that tier
 * may take in total.
 */
export type Tier = 0 | 1 | 2 | 3;
const BOTS = ["grid", "smart_dca", "rebalance", "infinity_grid", "twap"];

export function sellTier(kind: string): Tier {
  if (kind === "stop_loss" || kind === "trailing_stop") return 0;
  if (kind === "take_profit" || kind === "limit_sell") return 1;
  if (BOTS.includes(kind)) return 2;
  return 3;
}

export interface SellAsk { id: string; tier: Tier; want: bigint }

export function allocateSells(asks: SellAsk[], capFor: (tier: Tier) => bigint): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let used = 0n, starved = false;
  for (const tier of [0, 1, 2, 3] as Tier[]) {
    const group = asks.filter((a) => a.tier === tier && a.want > 0n);
    for (const a of asks) if (a.tier === tier && !(a.want > 0n)) out.set(a.id, 0n);
    if (!group.length) continue;
    if (starved) { for (const a of group) out.set(a.id, 0n); continue; }
    const cap = capFor(tier), avail = cap > used ? cap - used : 0n;
    const total = group.reduce((s, a) => s + a.want, 0n);
    if (total <= avail) { for (const a of group) out.set(a.id, a.want); used += total; continue; }
    let given = 0n;
    for (const a of group) { const g = avail === 0n ? 0n : (a.want * avail) / total; out.set(a.id, g); given += g; }
    let left = avail - given;
    for (const a of [...group].sort((x, y) => (y.want > x.want ? 1 : y.want < x.want ? -1 : 0))) {
      if (left <= 0n) break;
      if (out.get(a.id)! < a.want) { out.set(a.id, out.get(a.id)! + 1n); left -= 1n; }
    }
    used += avail - left; starved = true;
  }
  return out;
}
