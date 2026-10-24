/** All tokens + charts: DefiLlama ids, the tracked-token list, chart ranges, and the dashboard endpoints. No network. */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coinId, TokenList, priceChart, CHART_RANGES, toCandles } from "../src/holdings.js";
import { NATIVE_EVM, WSOL } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const dir = mkdtempSync(path.join(os.tmpdir(), "twho-"));

check(coinId("base", NATIVE_EVM) === "coingecko:ethereum" && coinId("solana", WSOL) === "coingecko:solana" && coinId("base", "0xabc") === "base:0xabc" && coinId("solana", "JUPx") === "solana:JUPx", "DefiLlama ids: native coins by CoinGecko id, tokens by chain:address");

const l = new TokenList(dir);
const BRETT = "0x532f27101965dd16442e59d40670faf5ebb142e4";
l.add("base", BRETT); l.add("base", BRETT.toUpperCase().replace("0X", "0x")); l.add("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); l.add("solana", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
check(JSON.stringify(l.list()) === JSON.stringify({ base: ["0x532f27101965dd16442E59d40670FaF5eBB142E4"], solana: ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"] }), "token list: checksummed, no duplicates, core tokens skipped, Solana mints kept as typed", l.list());
l.remove("base", BRETT);
check((l.list().base ?? []).length === 0, "token list: remove");

const calls: string[] = [];
const fake = (async (u: string) => { calls.push(u); return new Response(JSON.stringify({ coins: { "coingecko:solana": { symbol: "SOL", prices: [{ timestamp: 1, price: 100 }, { timestamp: 2, price: 0 }, { timestamp: 3, price: 105 }] } } })); }) as any;
const c = await priceChart("coingecko:solana", "1W", fake);
check(calls[0] === "https://coins.llama.fi/chart/coingecko:solana?span=168&period=1h" && c.points.length === 2 && c.points[1]!.p === 105, "chart: 1W asks DefiLlama for 168×1h and drops zero prices", { calls, c });
check(c.candles.length === 0 && c.candle_source === null, "chart: no candles are made up when the candle source fails (the line is shown)", c);
// Real candles: Coinbase rows are [time, low, high, open, close, volume], newest first.
const cbcalls: string[] = [];
const cbfake = (async (u: string) => { cbcalls.push(u); if (u.includes("coins.llama.fi")) return new Response(JSON.stringify({ coins: { "coingecko:ethereum": { prices: [{ timestamp: 1, price: 3000 }] } } }));
  return new Response(JSON.stringify([[7200, 2990, 3030, 3000, 3020, 1], [3600, 2980, 3010, 2995, 3000, 1]])); }) as any;
const c2 = await priceChart("coingecko:ethereum", "1D", cbfake);
check(cbcalls.some((u) => u.startsWith("https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=900&start=")) && JSON.stringify(c2.candles) === JSON.stringify([[3600, 2995, 3010, 2980, 3000, 1], [7200, 3000, 3030, 2990, 3020, 1]]) && c2.candle_source === "Coinbase" && c2.candle_size === 900, "chart: ETH 1D candles are Coinbase's 15-minute candles, oldest first, open/high/low/close/volume", c2);
for (const [r, v] of Object.entries(CHART_RANGES)) { calls.length = 0; await priceChart("coingecko:solana", r as any, fake); check(calls[0]!.endsWith(`span=${v.span}&period=${v.period}`), `chart range ${r}`); }
// Candles: open is the last price before the candle (so they join up), high/low cover everything inside it.
const k = toCandles([{ t: 0, p: 10 }, { t: 30, p: 12 }, { t: 59, p: 11 }, { t: 60, p: 9 }, { t: 90, p: 13 }, { t: 200, p: 0 }, { t: 250, p: 14 }], 60);
check(JSON.stringify(k) === JSON.stringify([[0, 10, 12, 10, 11], [60, 11, 13, 9, 13], [240, 13, 14, 13, 14]]), "candles: from single prices, empty buckets skipped, zero prices dropped", k);
const k2 = toCandles([{ t: 3, o: 5, h: 8, l: 4, c: 6 }, { t: 1, o: 4, h: 6, l: 3, c: 5 }, { t: 5, o: 6, h: 7, l: 2, c: 7 }], 4);
check(JSON.stringify(k2) === JSON.stringify([[0, 4, 8, 3, 6], [4, 6, 7, 2, 7]]), "candles: merges finer candles (sorted), keeping the true highs and lows", k2);
const k3 = toCandles([{ t: 0, o: 1, h: 2, l: 1, c: 2, v: 5 }, { t: 1, o: 2, h: 3, l: 2, c: 3, v: 7 }], 2);
check(JSON.stringify(k3) === JSON.stringify([[0, 1, 3, 1, 3, 12]]), "candles: volume adds up when candles merge", k3);
check(Object.values(CHART_RANGES).every((v) => ({ "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as any)[v.period] * v.span / v.candle >= 24), "chart ranges: at least 24 candles each");
let e = ""; try { await priceChart("http://evil/x", "1D", fake); } catch (x) { e = (x as Error).message; }
check(/Unknown coin/.test(e), "chart: refuses anything that isn't a coin id (no URL injection)");

console.log(`\nholdings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
