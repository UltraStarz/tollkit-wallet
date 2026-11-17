/** Nov 17: the Swap screen's slippage pick and quote details (price impact, network fee, route). No network. */
import { quoteExtras, swapSlip } from "../src/dashboard.js";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${name}`); c ? pass++ : fail++; };

ok("no pick: 1%, or the owner's limit if lower", swapSlip(undefined, 100) === 100 && swapSlip(undefined, 50) === 50);
ok("a pick above the owner's limit is cut to it", swapSlip(300, 100) === 100);
ok("a pick inside the limit is used", swapSlip(50, 100) === 50 && swapSlip(200, 300) === 200);
ok("nonsense picks fall back", swapSlip("x", 100) === 100 && swapSlip(1, 100) === 100);
const j = quoteExtras({ chain: "solana", route: "Jupiter Ultra", raw: { priceImpactPct: "0.0123", signatureFeeLamports: 5000, prioritizationFeeLamports: 95000 } });
ok("Jupiter: impact as a percent, fee in SOL, route", j.impact_pct === 1.23 && j.net_fee?.symbol === "SOL" && Math.abs(j.net_fee.amount - 0.0001) < 1e-12 && j.route === "Jupiter Ultra");
const m = quoteExtras({ chain: "solana", route: "Metis", raw: { inUsdValue: 100, outUsdValue: 99.5 } });
ok("Metis: impact from the dollar values", m.impact_pct === 0.5 && !m.net_fee);
const x = quoteExtras({ chain: "base", route: "0x", raw: { totalNetworkFee: "20000000000000" } });
ok("0x: network fee in ETH, no impact when the route doesn't say", x.net_fee?.symbol === "ETH" && x.net_fee.amount === 0.00002 && x.impact_pct === undefined);
console.log(`\nswapdetails: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
