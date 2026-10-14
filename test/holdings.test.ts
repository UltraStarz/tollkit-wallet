/** All tokens + charts: DefiLlama ids, the tracked-token list, chart ranges, and the dashboard endpoints. No network. */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coinId, TokenList, priceChart, CHART_RANGES } from "../src/holdings.js";
import { NATIVE_EVM, WSOL } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const dir = mkdtempSync(path.join(os.tmpdir(), "twho-"));

check(coinId("base", NATIVE_EVM) === "coingecko:ethereum" && coinId("solana", WSOL) === "coingecko:solana" && coinId("base", "0xabc") === "base:0xabc" && coinId("solana", "JUPx") === "solana:JUPx", "DefiLlama ids: native coins by CoinGecko id, tokens by chain:address");

const l = new TokenList(dir);
const BRETT = "0x532f27101965dd16442e59d40670faf5ebb142e4";
l.add("base", BRETT); l.add("base", BRETT.toUpperCase().replace("0X", "0x")); l.add("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); l.add("solana", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
check(JSON.stringify(l.list()) === JSON.stringify({ base: ["0x532f27101965dd16442E59d40670FaF5eBB142E4"] }), "token list: checksummed, no duplicates, core tokens and Solana skipped", l.list());
l.remove("base", BRETT);
check((l.list().base ?? []).length === 0, "token list: remove");

const calls: string[] = [];
const fake = (async (u: string) => { calls.push(u); return new Response(JSON.stringify({ coins: { "coingecko:solana": { symbol: "SOL", prices: [{ timestamp: 1, price: 100 }, { timestamp: 2, price: 0 }, { timestamp: 3, price: 105 }] } } })); }) as any;
const c = await priceChart("coingecko:solana", "1W", fake);
check(calls[0] === "https://coins.llama.fi/chart/coingecko:solana?span=42&period=4h" && c.points.length === 2 && c.points[1]!.p === 105, "chart: 1W asks DefiLlama for 42×4h and drops zero prices", { calls, c });
for (const [r, v] of Object.entries(CHART_RANGES)) { calls.length = 0; await priceChart("coingecko:solana", r as any, fake); check(calls[0]!.endsWith(`span=${v.span}&period=${v.period}`), `chart range ${r}`); }
let e = ""; try { await priceChart("http://evil/x", "1D", fake); } catch (x) { e = (x as Error).message; }
check(/Unknown coin/.test(e), "chart: refuses anything that isn't a coin id (no URL injection)");

console.log(`\nholdings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
