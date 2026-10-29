/** 0.9.9: momentum signals (src/indicators.ts) and signal_buy / signal_sell rules (src/autopilot.ts). */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore, ruleProblem, describeRule } from "../src/rules.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { KNOWN } from "../src/tokens.js";
import { ema, macdHist, rsi, fourHour, checkSignal } from "../src/indicators.js";
import { buildBot } from "../src/bots.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d)); } };

// ─── the math ───────────────────────────────────────────────────────────────
const e = ema([1, 2, 3, 4, 5, 6], 3);
check(e[1] === null && e[2] === 2 && Math.abs(e[3]! - 3) < 1e-12 && Math.abs(e[5]! - 5) < 1e-12, "EMA: seeded with the 3-period average, then (close − prev) × 2/(n+1) + prev", e);
check(rsi(Array.from({ length: 20 }, (_, i) => 100 + i)) === 100 && rsi(Array.from({ length: 20 }, (_, i) => 100 - i)) === 0, "RSI: only gains is 100, only losses is 0");
const flatThenUp = [...Array(40).fill(100), 101, 103, 106];
const h = macdHist(flatThenUp);
check(!!h && h.now > 0, "MACD histogram turns positive when prices start rising after a flat stretch", h);
check(macdHist(Array(30).fill(1)) === null, "MACD needs 26 + 9 closes");
check(JSON.stringify(fourHour([1, 2, 3, 4, 5, 6, 7, 8, 9])) === JSON.stringify([1, 5, 9]), "4-hour closes: every 4th hourly close, ending with the latest");
const down = Array.from({ length: 60 }, (_, i) => 100 - i * 0.8);
check(checkSignal({ signal: "rsi_below" }, 52, down).hit && !checkSignal({ signal: "rsi_above" }, 52, down).hit, "a steady fall reads oversold (RSI below 30), not overbought");
const range = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));
check(checkSignal({ signal: "breakout_up", value: 20 }, 101.5, range).hit && !checkSignal({ signal: "breakout_up", value: 20 }, 100.9, range).hit, "breakout: above the highest close of the last 20, and not before");
check(checkSignal({ signal: "breakout_down" }, 98.5, range).hit, "breakdown: below the lowest close");
check(checkSignal({ signal: "macd_up" }, 100, [100, 100]).now === "Waiting for price history", "not enough history: waits, never trades");

// ─── rules ──────────────────────────────────────────────────────────────────
check(/needs when/.test(ruleProblem({ kind: "signal_buy", chain: "base", token: "ETH", amount_usd: 10 } as any) ?? ""), "a signal rule needs a signal");
check(/between 5 and 50/.test(ruleProblem({ kind: "signal_buy", chain: "base", token: "ETH", amount_usd: 10, when: { signal: "rsi_below", value: 60 } } as any) ?? ""), "RSI levels are checked");
check(describeRule({ kind: "signal_buy", chain: "base", token: "ETH", amount_usd: 20, when: { signal: "rsi_below", tf: "4h" } } as any) === "Buy $20 of ETH when 4-hour RSI falls below 30 on Base", "plain description", describeRule({ kind: "signal_buy", chain: "base", token: "ETH", amount_usd: 20, when: { signal: "rsi_below", tf: "4h" } } as any));
const built = buildBot("signal", "ETH", "base", { side: "sell", signal: "breakout_down", tf: "1h", level: 0, sell_pct: 50, times: 2 }, 2500);
check(built.rules[0]!.kind === "signal_sell" && built.rules[0]!.sell_percent === 50 && built.rules[0]!.when?.signal === "breakout_down" && built.rules[0]!.times === 2 && built.rules[0]!.when?.value === undefined, "the Trade on a signal template builds a signal sell", built.rules[0]);

// ─── on the device ──────────────────────────────────────────────────────────
const ETH = KNOWN.base.ETH!.address, USDC = KNOWN.base.USDC!.address;
const st = { price: 2500, swaps: [] as SwapRequest[] };
const quote = async (req: SwapRequest) => { const buying = req.sell_token.toLowerCase() === USDC.toLowerCase(); const usd = buying ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e18) * st.price; return { ok: true, quote: { chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: String(buying ? BigInt(Math.floor((usd / st.price) * 1e18)) : BigInt(Math.floor(usd * 1e6))), min_buy_amount: "0", fee_bps: 50, venue_fee_bps: 0, usd_value: usd } } as any; };
const exec: Executor = { mode: "live", slippageBps: 50, quote, swap: async (req) => { const q = await quote(req); st.swaps.push(req); return { ...q, tx: `0x${st.swaps.length}` }; }, balance: async (_c, t) => (t.address.toLowerCase() === ETH.toLowerCase() ? 10n ** 18n : 10n ** 12n) };
const dir = mkdtempSync(path.join(os.tmpdir(), "mom-")), s = new RuleStore(dir);
let clock = Date.now(), closes = down.map((x) => x * 25);
const ap = new Autopilot(s, exec, { snapshot: () => ({ prices: { ETH: { usd: st.price, change_24h: 0 } } }) } as any, { dir, now: () => clock, hourly: async () => closes });
const tick = async () => { clock += 15_000; await ap.tick(); };
st.price = 1300;
const r = await s.add({ kind: "signal_buy", chain: "base", token: "ETH", amount_usd: 25, when: { signal: "rsi_below" }, times: 2 }, "owner", true);
await tick();
check(st.swaps.length === 1 && Number(st.swaps[0]!.sell_amount) === 25_000_000, "oversold: it buys $25 of ETH", st.swaps.length);
await tick(); await tick();
check(st.swaps.length === 1 && s.get(r.id)!.status === "active", "still oversold: it doesn't buy again until the signal clears");
closes = Array.from({ length: 60 }, (_, i) => 1000 + i * 10); st.price = 1610;
await tick();
check(st.swaps.length === 1 && s.get(r.id)!.state.alert_armed === true, "RSI recovers: re-armed, no trade");
closes = down.map((x) => x * 25); st.price = 1300;
await tick();
check(st.swaps.length === 2 && s.get(r.id)!.status === "done", "oversold again: second buy, then done (times: 2)", s.get(r.id)!.status);

console.log(`\nmomentum: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
