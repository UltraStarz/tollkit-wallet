/**
 * Phase 4 (trading brief, workstream G): what a trade cost between the price a rule acted on and the price it got.
 *
 * A fill keeps `px` (the price the engine acted on, a Jupiter or 0x quote for one unit), `usd` and `units` (what was
 * paid or received), `fee` (TOLLkit's fee in dollars) and `fee_out` (the fee was paid beside the swap, so it is not
 * inside usd/units). Implementation shortfall, in basis points (1 bp = 0.01%), is how much worse the fill price was
 * than `px`: for a buy, paying more; for a sell, receiving less. "ex_fee" leaves TOLLkit's fee out, which is what a
 * slippage limit has to cover.
 *
 * Nothing here trades. adaptiveSlippage() only narrows the owner's slippage limit for a coin once enough real trades
 * with measured slippage show it can be narrower; it never widens it. In the app the shortfall figures compare the
 * price acted on with the QUOTED amounts (what the app records), so they describe fee and quoted price impact, not
 * slippage after the quote.
 */

export interface FillLike { ts: string; ok: boolean; side: "buy" | "sell"; usd?: number; units?: number; px?: number; fee?: number; fee_out?: boolean; paper?: boolean; ms?: number; /** Slippage met between the quote and the fill, in bps (Run 24/7 records it). */ sl?: number }

/** One fill's shortfall in bps, or null when it lacks what's needed (an older fill, a failed one, practice). */
export function shortfallBps(f: FillLike): { total: number; ex_fee: number } | null {
  if (!f.ok || f.paper || !(f.px && f.px > 0) || !(f.usd && f.usd > 0) || !(f.units && f.units > 0)) return null;
  const got = f.usd / f.units, total = (f.side === "buy" ? got / f.px - 1 : 1 - got / f.px) * 10_000;
  const feeBps = f.fee && f.fee > 0 ? (f.fee / f.usd) * 10_000 : 0;
  return { total, ex_fee: f.fee_out ? total : total - feeBps };
}

const quant = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!; };

export interface ShortfallStats { n: number; median_bps: number; p90_bps: number; median_ex_fee_bps: number; p90_ex_fee_bps: number; median_ms: number | null }
/** The cost of real (not practice) fills, newest `keep` of them within `days`. Null with none. */
export function shortfallStats(fills: FillLike[], now = Date.now(), days = 30, keep = 200): ShortfallStats | null {
  const cut = now - days * 86_400_000;
  const xs = fills.filter((f) => Date.parse(f.ts) >= cut).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, keep * 2)
    .map((f) => ({ s: shortfallBps(f), ms: f.ms })).filter((x) => x.s !== null).slice(0, keep) as { s: { total: number; ex_fee: number }; ms?: number }[];
  if (!xs.length) return null;
  const r1 = (n: number) => Math.round(n * 10) / 10, ms = xs.map((x) => x.ms).filter((m): m is number => typeof m === "number");
  return { n: xs.length, median_bps: r1(quant(xs.map((x) => x.s.total), 0.5)), p90_bps: r1(quant(xs.map((x) => x.s.total), 0.9)),
    median_ex_fee_bps: r1(quant(xs.map((x) => x.s.ex_fee), 0.5)), p90_ex_fee_bps: r1(quant(xs.map((x) => x.s.ex_fee), 0.9)), median_ms: ms.length ? Math.round(quant(ms, 0.5)) : null };
}

/** Fills a coin needs before its slippage limit adapts, the narrowest limit it may get, and the multiple of its worst tenth. */
export const ADAPT = { minFills: 20, floorBps: 50, mult: 3 };
/**
 * The slippage limit for a coin. Review 2 (Nov 11, 2026): it is worked out only from fills that record `sl`, the
 * slippage really met between the quote and what arrived (Run 24/7 on the server records it; the app's fills hold
 * the quoted amounts, so they never narrow anything). The owner's limit until ADAPT.minFills such fills exist in
 * the last 30 days; then three times their worst tenth, never under 0.5% and never over the owner's limit.
 */
export function adaptiveSlippage(fills: FillLike[], ownerBps: number, now = Date.now()): number {
  const cut = now - 30 * 86_400_000;
  const xs = fills.filter((f) => f.ok && !f.paper && typeof f.sl === "number" && Number.isFinite(f.sl) && Date.parse(f.ts) >= cut).map((f) => f.sl as number);
  if (xs.length < ADAPT.minFills) return ownerBps;
  return Math.min(ownerBps, Math.max(ADAPT.floorBps, Math.ceil(Math.max(0, quant(xs, 0.9)) * ADAPT.mult)));
}
