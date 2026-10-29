/** 0.9.9: the Range bot's math (src/clmm.ts) against values from Orca's own @orca-so/whirlpools-core (test/clmm-vectors.json). */
import { readFileSync } from "node:fs";
import { amountsForLiquidity, initializableTick, liquidityForAmounts, priceToSqrtPrice, priceToTick, rangeTicks, shareInA, sqrtPriceSlippageBounds, tickArrayStart, tickToPrice, tickToSqrtPrice } from "../src/clmm.js";
const V = JSON.parse(readFileSync(new URL("./clmm-vectors.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log("  FAIL", m); } };
const rel = (x: bigint, y: bigint) => Math.abs(Number(x - y)) / Number(y);

for (const [p, a, b, tick, sqrt] of V.ticks) {
  ok(priceToTick(p, a, b) === tick, `tick ${p} ${a}/${b}: ${priceToTick(p, a, b)} vs Orca ${tick}`);
  ok(priceToSqrtPrice(p, a, b) === BigInt(sqrt), `sqrt price ${p} ${a}/${b}`);
}
for (const [t, s] of V.sqrt) ok(rel(tickToSqrtPrice(t), BigInt(s)) < 1e-9, `sqrt at tick ${t}: ${tickToSqrtPrice(t)} vs ${s}`);
for (const [s, bps, mn, mx] of V.slip) { const r = sqrtPriceSlippageBounds(BigInt(s), bps); ok(r.min === BigInt(mn) && r.max === BigInt(mx), `slippage ${s} ${bps}: ${r.min},${r.max} vs ${mn},${mx}`); }
for (const [t, sp, ru, want] of V.init) ok(initializableTick(t, sp, ru ?? undefined) === want, `initializable ${t}/${sp}/${ru}`);
for (const [t, sp, want] of V.start) ok(tickArrayStart(t, sp) === want, `array start ${t}/${sp}: ${tickArrayStart(t, sp)} vs ${want}`);
{
  const lo = tickToSqrtPrice(-23232), hi = tickToSqrtPrice(-22720);
  for (const [s, ea, eb] of V.dec) { const r = amountsForLiquidity(1_000_000_000n, BigInt(s), lo, hi);
    ok((BigInt(ea) === 0n ? r.a === 0n : rel(r.a, BigInt(ea)) < 1e-6) && (BigInt(eb) === 0n ? r.b === 0n : rel(r.b, BigInt(eb)) < 1e-6), `amounts at ${s}: ${r.a},${r.b} vs ${ea},${eb}`); }
}
{
  // SOL/USDC at $100.50, ±5%: about half the value each way, and the amounts round-trip through liquidity.
  const r = rangeTicks(100.5, 5, 4, 9, 6);
  ok(r.lower % 4 === 0 && r.upper % 4 === 0 && r.lower < r.upper, "range ticks on the spacing");
  ok(Math.abs(tickToPrice(r.lower, 9, 6) - 95.475) < 0.1 && Math.abs(tickToPrice(r.upper, 9, 6) - 105.525) < 0.1, `range prices ${tickToPrice(r.lower, 9, 6)}–${tickToPrice(r.upper, 9, 6)}`);
  const share = shareInA(100.5, tickToPrice(r.lower, 9, 6), tickToPrice(r.upper, 9, 6));
  ok(share > 0.45 && share < 0.55, `about half in SOL (${share})`);
  const s = priceToSqrtPrice(100.5, 9, 6), lo = tickToSqrtPrice(r.lower), hi = tickToSqrtPrice(r.upper);
  const sol = BigInt(Math.floor((100 * share / 100.5) * 1e9)), usdc = BigInt(Math.floor(100 * (1 - share) * 1e6));
  const L = liquidityForAmounts(sol, usdc, s, lo, hi), back = amountsForLiquidity(L, s, lo, hi);
  ok(back.a <= sol && back.b <= usdc && Number(back.a) > Number(sol) * 0.99 && Number(back.b) > Number(usdc) * 0.99, `fits and uses ≥99% of both (${back.a}/${sol}, ${back.b}/${usdc})`);
  ok(shareInA(90, 95, 105) === 1 && shareInA(110, 95, 105) === 0, "below the range: all coin; above: all USDC");
}
console.log(`\nclmm: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
