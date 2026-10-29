/**
 * 0.9.9: concentrated-liquidity math for the Range bot (Orca Whirlpools). Ported from Orca's own core library
 * (github.com/orca-so/whirlpools rust-sdk/core: math/price.rs, math/tick.rs), so the wallet needs no WebAssembly.
 * test/clmm.test.ts checks these against Orca's published @orca-so/whirlpools-core.
 *
 *   price(tick) = 1.0001^tick · 10^(decimalsA − decimalsB)        sqrtPriceX64 = √price_raw · 2^64
 *   A position holds liquidity L between sqrt prices a < b. At sqrt price s:
 *     s ≤ a: all token A,  amountA = L·(b − a)/(a·b)
 *     s ≥ b: all token B,  amountB = L·(b − a)
 *     else:  amountA = L·(b − s)/(s·b),  amountB = L·(s − a)
 */
export const Q64 = 2n ** 64n;
const Q64F = 18446744073709551616.0;
export const TICK_ARRAY_SIZE = 88;
export const MIN_TICK = -443636, MAX_TICK = 443636;
export const MIN_SQRT_PRICE = 4295048016n, MAX_SQRT_PRICE = 79226673515401279992447579055n;

/** Orca's price_to_sqrt_price: floor(√(price / 10^(dA−dB)) · 2^64). */
export function priceToSqrtPrice(price: number, decA: number, decB: number): bigint {
  return BigInt(Math.floor(Math.sqrt(price / 10 ** (decA - decB)) * Q64F));
}
export function sqrtPriceToPrice(sqrt: bigint, decA: number, decB: number): number {
  return (Number(sqrt) / Q64F) ** 2 * 10 ** (decA - decB);
}
/** The sqrt price at a tick, in floating point (good to about 1e-12; used for estimates, never sent as-is). */
export function tickToSqrtPrice(tick: number): bigint {
  return BigInt(Math.round(Math.sqrt(1.0001 ** tick) * Q64F));
}
export function tickToPrice(tick: number, decA: number, decB: number): number { return 1.0001 ** tick * 10 ** (decA - decB); }
/** The tick at or below a price. */
export function priceToTick(price: number, decA: number, decB: number): number {
  const raw = price / 10 ** (decA - decB);
  let t = Math.floor(Math.log(raw) / Math.log(1.0001));
  // Floating point can land one off at an exact boundary: settle it against the tick's own price.
  if (1.0001 ** (t + 1) <= raw) t += 1; else if (1.0001 ** t > raw) t -= 1;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}
const divE = (a: number, b: number) => Math.floor(a / b);
/** Orca's get_initializable_tick_index: a multiple of the spacing; up, down, or nearest. */
export function initializableTick(tick: number, spacing: number, roundUp?: boolean): number {
  const rem = ((tick % spacing) + spacing) % spacing, base = divE(tick, spacing) * spacing;
  const up = roundUp === undefined ? rem >= spacing / 2 && rem > 0 : roundUp && rem > 0;
  return up ? base + spacing : base;
}
/** Orca's get_tick_array_start_tick_index. */
export function tickArrayStart(tick: number, spacing: number): number {
  return divE(divE(tick, spacing), TICK_ARRAY_SIZE) * spacing * TICK_ARRAY_SIZE;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
/** Orca's get_sqrt_price_slippage_bounds: the pool's sqrt price may move by `bps` of price either way. */
export function sqrtPriceSlippageBounds(sqrt: bigint, bps: number): { min: bigint; max: bigint } {
  const b = BigInt(Math.min(Math.max(0, Math.round(bps)), 10_000));
  const lo = isqrt((10_000n - b) * 1_000_000n);
  const hiR = (10_000n + b) * 1_000_000n, hiF = isqrt(hiR), hi = hiF * hiF === hiR ? hiF : hiF + 1n;
  const min = (sqrt * lo) / 100_000n, max = (sqrt * hi) / 100_000n;
  return { min: min > MIN_SQRT_PRICE ? min : MIN_SQRT_PRICE, max: max < MAX_SQRT_PRICE ? max : MAX_SQRT_PRICE };
}

/** Token amounts for liquidity L between sqrt prices lo < hi at the pool's sqrt price s (rounded down). */
export function amountsForLiquidity(L: bigint, s: bigint, lo: bigint, hi: bigint): { a: bigint; b: bigint } {
  if (L <= 0n) return { a: 0n, b: 0n };
  const A = (x: bigint, y: bigint) => (L * (y - x) * Q64) / x / y;
  const B = (x: bigint, y: bigint) => (L * (y - x)) / Q64;
  if (s <= lo) return { a: A(lo, hi), b: 0n };
  if (s >= hi) return { a: 0n, b: B(lo, hi) };
  return { a: A(s, hi), b: B(lo, s) };
}
/** The most liquidity amounts a and b can buy between lo < hi at sqrt price s. */
export function liquidityForAmounts(a: bigint, b: bigint, s: bigint, lo: bigint, hi: bigint): bigint {
  const fromA = (x: bigint, y: bigint) => (a * x * y) / Q64 / (y - x);
  const fromB = (x: bigint, y: bigint) => (b * Q64) / (y - x);
  if (s <= lo) return fromA(lo, hi);
  if (s >= hi) return fromB(lo, hi);
  const la = fromA(s, hi), lb = fromB(lo, s);
  return la < lb ? la : lb;
}

/**
 * How a dollar pot splits between the coin (A) and USDC (B) for a range around today's price, so all of it fits:
 * the share of the pot's value that goes in as A. At the middle of a symmetric range this is close to half.
 */
export function shareInA(price: number, lowerPrice: number, upperPrice: number): number {
  if (price <= lowerPrice) return 1;
  if (price >= upperPrice) return 0;
  const s = Math.sqrt(price), a = Math.sqrt(lowerPrice), b = Math.sqrt(upperPrice);
  const valA = ((b - s) / (s * b)) * price, valB = s - a; // per unit of liquidity, in B
  return valA / (valA + valB);
}

/** The tick range for "± pct around price", on the pool's spacing; never empty. */
export function rangeTicks(price: number, pct: number, spacing: number, decA: number, decB: number): { lower: number; upper: number } {
  let lower = initializableTick(priceToTick(price * (1 - pct / 100), decA, decB), spacing, false);
  let upper = initializableTick(priceToTick(price * (1 + pct / 100), decA, decB), spacing, true);
  if (upper <= lower) upper = lower + spacing;
  lower = Math.max(lower, initializableTick(MIN_TICK, spacing, true)); upper = Math.min(upper, initializableTick(MAX_TICK, spacing, false));
  return { lower, upper };
}
