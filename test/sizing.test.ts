/** 0.9.11: strategies are sized from the balance (Joe: "it should be based on the size of the balance"). */
import { shareUsd, sizeToShare, committedUsd, liveSlots, sameSetup, eagerRsi } from "../src/superbot.js";
let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
check(shareUsd(300, 152.82, 4) === 38.2, "share = smaller of budget and dollars held, / max strategies ($152.82 / 4)", shareUsd(300, 152.82, 4));
check(shareUsd(300, 5000, 4) === 75, "the budget caps it when the wallet holds more ($300 / 4)");
check(shareUsd(300, undefined, 4) === 75, "balance unknown: the budget alone");
check(shareUsd(300, 0, 4) === 0, "no dollars on the network: no size");
const near = (a: number, b: number) => Math.abs(a - b) <= 0.06;
for (const [t, p] of [["grid", { amount_usd: 1.5, levels: 6, range_pct: 3 }], ["dca", { amount_usd: 10, times: 5 }], ["dip", { amount_usd: 25, drop_pct: 2 }], ["signal", { amount_usd: 6, side: "buy", times: 2 }], ["smart_dca", { amount_usd: 5, safety: 3, scale: 1.5 }], ["infinity_grid", { amount_usd: 4 }], ["rebalance", { amount_usd: 9 }]] as const) {
  const out = sizeToShare(t, { ...p }, 38.2);
  check(near(committedUsd(t, out), 38.2) && committedUsd(t, out) <= 38.2, `${t}: commits the share ($${committedUsd(t, out).toFixed(2)})`, out);
}
check(sizeToShare("grid", { amount_usd: 1.5, levels: 6 }, 38.2).amount_usd === 7.64, "the example: a 6-level grid buys $7.64 a level, not $1.50");
check(sizeToShare("signal", { amount_usd: 6, side: "sell", sell_pct: 50 }, 38.2).amount_usd === 6, "a signal sell spends nothing: unchanged");
check(sizeToShare("protect", { sell_percent: 50 }, 38.2).amount_usd === undefined, "templates without a dollar amount: unchanged");
check(sizeToShare("dip", { amount_usd: 25 }, 0).amount_usd === 25, "share 0: unchanged");
// Nov 10 (Joe: "make the most money possible"): live slots, twins with different settings, eager RSI buys.
check(liveSlots(8) === 4 && liveSlots(5) === 3 && liveSlots(1) === 1, "live slots: half the strategy slots, rounded up");
check(sameSetup({ amount_usd: 80, drop_pct: 2, profit_pct: 1.5 }, { amount_usd: 20, drop_pct: 2.1, profit_pct: 1.5 }), "same setup: only the dollar size differs");
check(!sameSetup({ amount_usd: 80, drop_pct: 2, profit_pct: 1.5 }, { amount_usd: 80, drop_pct: 3, profit_pct: 2.5 }), "different setup: a 3% dip next to a 2% one");
check(eagerRsi("signal", { side: "buy", signal: "rsi_below", level: 30 }).level === 38 && eagerRsi("signal", { side: "buy", signal: "rsi_below", level: 0 }).level === 38, "RSI buys at 30 (or the usual 0) fire at 38");
check(eagerRsi("signal", { side: "buy", signal: "rsi_below", level: 42 }).level === 42 && eagerRsi("signal", { side: "sell", signal: "rsi_above", level: 70 }).level === 70 && eagerRsi("dip", { level: 30 }).level === 30, "RSI 38-45 kept; sells and other templates untouched");
console.log(`\nsizing: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
