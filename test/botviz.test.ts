/**
 * 0.8.5: what the Bots screen draws. Levels, next move and trades from a bot's rules; the price tape; Coinbase
 * candles in pages of 300; and the 30-day replay, which runs the real autopilot on past prices in memory.
 * Fake price server; no network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { botLevels, botNext, botTrades, coinbaseProduct, hourlyCandles, PriceTape, replay } from "../src/botviz.js";
import type { Rule } from "../src/rules.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const dir = mkdtempSync(path.join(os.tmpdir(), "twbv-"));

const rule = (o: Partial<Rule>): Rule => ({ kind: "limit_buy", chain: "base", token: "ETH", id: Math.random().toString(36).slice(2, 10), status: "active", created_by: "owner", created_at: "2026-10-01T00:00:00Z", state: { runs: 0, failures: 0, fills: [] }, ...o } as Rule);

// ── Levels and the next move.
const buy = rule({ kind: "limit_buy", amount_usd: 50, trigger_price: 2000 });
const tp = rule({ kind: "take_profit", trigger_price: 2200, after: buy.id, sell_from: buy.id });
let lv = botLevels([buy, tp]);
check(lv.length === 2 && lv[0]!.kind === "buy" && lv[0]!.price === 2000 && lv[1]!.kind === "sell" && lv[1]!.label === "Take profit", "a dip bot draws its buy and take-profit lines", lv);
let nx = botNext([buy, tp], 2100);
check(nx?.price === 2000 && nx.dist_pct === -4.8 && /Buys \$50 at \$2,000/.test(nx.text), "next: the buy, 4.8% below (the sell waits for it)", nx);
buy.status = "done";
nx = botNext([buy, tp], 2100);
check(nx?.price === 2200 && nx.dist_pct === 4.8 && /Sells at/.test(nx.text), "after the buy fills, next is the sale", nx);
check(botLevels([buy, tp])[0]!.live === false, "a finished step's line is faded");
const trail = rule({ kind: "trailing_stop", trail_pct: 10, sell_percent: 100, state: { runs: 0, failures: 0, fills: [], high: 3000, last_price: 2900 } });
check(botLevels([trail])[0]!.price === 2700 && botNext([trail], 2900)!.price === 2700, "a trailing stop sits 10% under the high it has seen");
const grid = rule({ kind: "grid", amount_usd: 20, lower_price: 90, upper_price: 110, levels: 5, state: { runs: 0, failures: 0, fills: [], grid: { units: [null, 1, null, null], cost: [null, 20, null, null], atomic: [null, "1", null, null] } } });
check(botLevels([grid]).length === 5, "a grid draws every level");
const gn = botNext([grid], 101);
check(gn?.price === 100 && /Buys a level/.test(gn.text), "grid: the nearest open level below the price", gn);
const dca = rule({ kind: "dca", amount_usd: 25, every: "week", state: { runs: 0, failures: 0, fills: [], next_run: "2026-10-26T14:00:00Z" } });
check(botNext([dca], 100)?.at === "2026-10-26T14:00:00Z", "a steady buyer's next move is its next date");
check(botNext([rule({ ...dca, status: "paused" })], 100) === null, "a paused bot has no next move");

// ── Trades.
const filled = rule({ kind: "grid", state: { runs: 2, failures: 0, fills: [{ ts: "2026-10-02T00:00:00Z", ok: true, usd: 20, units: 0.2, side: "buy" }, { ts: "2026-10-03T00:00:00Z", ok: false, reason: "No gas" }, { ts: "2026-10-04T00:00:00Z", ok: true, usd: 22, units: 0.2, side: "sell" }] } });
const tr = botTrades([filled]);
check(tr.length === 3 && tr[0]!.side === "sell" && tr[0]!.price === 110 && tr[1]!.ok === false && tr[1]!.reason === "No gas" && tr[2]!.price === 100, "trades newest first, with the price each got", tr);

// ── Price tape: one point per five minutes, a week kept.
const tape = new PriceTape(dir);
const t0 = Date.parse("2026-10-10T00:00:00Z");
for (let i = 0; i < 40; i++) tape.add("base", "0xAbC", 1 + i / 100, t0 + i * 60_000);
check(tape.series("base", "0xabc").length === 8, "a point at most every five minutes (case-insensitive token)", tape.series("base", "0xabc").length);
tape.add("base", "0xabc", 5, t0 + 8 * 86_400_000);
check(tape.series("base", "0xabc").length === 1, "older than a week drops off");
tape.flush();
check(new PriceTape(dir).series("base", "0xabc")[0]![1] === 5, "saved and read back");

// ── Coinbase candles: pages of up to 300, oldest first.
check(coinbaseProduct("weth") === "ETH-USD" && coinbaseProduct("SOL") === "SOL-USD" && coinbaseProduct("POL") === "POL-USD" && coinbaseProduct("0xabc") === null, "which tokens Coinbase has");
const NOW = Date.parse("2026-10-19T12:00:00Z");
let calls = 0;
/** A made-up ETH path: 100 at the start, falls 12% over 10 days, recovers to 105 by day 30. */
const priceAt = (h: number) => (h < 240 ? 100 - (12 * h) / 240 : 88 + (17 * (h - 240)) / 480);
const fake = (async (u: string) => {
  calls++;
  const q = new URL(String(u)), s = Date.parse(q.searchParams.get("start")!), e = Date.parse(q.searchParams.get("end")!);
  const start = NOW - 720 * 3_600_000, rows: number[][] = [];
  for (let t = s; t < e; t += 3_600_000) { const h = (t - start) / 3_600_000; if (h < 0 || h >= 720) continue; const o = priceAt(h), c = priceAt(h + 1); rows.push([t / 1000, Math.min(o, c) * 0.999, Math.max(o, c) * 1.001, o, c, 1]); }
  if (rows.length > 300) return new Response(JSON.stringify({ message: "Count of aggregations requested exceeds 300" }), { status: 400 });
  return Response.json(rows.reverse());
}) as unknown as typeof fetch;
const cs = await hourlyCandles("ETH-USD", 720, fake, NOW);
check(cs.length === 720 && calls === 3 && cs[0]!.t < cs[1]!.t && Math.abs(cs[0]!.o - 100) < 1e-9, "30 days comes back in three requests, oldest first", { n: cs.length, calls });

// ── Replay.
const dip = await replay({ template: "dip", chain: "base", token: "ETH", params: { amount_usd: 50, drop_pct: 5, profit_pct: 8 }, fetch: fake, now: NOW + 1 });
check(dip.trades.length === 2 && dip.trades[0]!.side === "buy" && Math.abs(dip.trades[0]!.price - 95) < 0.3 && dip.trades[1]!.side === "sell" && Math.abs(dip.trades[1]!.price - 95 * 1.08) < 0.3, "dip: buys near −5%, sells near +8% over the buy", dip.trades);
check(dip.spent_usd === 50 && dip.result_usd > 2.5 && dip.result_usd < 4.1 && dip.baseline_label === "Buying it all at the start", "dip: about +$3 after the 0.5% fee each way", dip);
const prot = await replay({ template: "protect", chain: "base", token: "ETH", params: { sell_percent: 100, stop_pct: 10, profit_pct: 20 }, hold_usd: 200, fetch: fake, now: NOW + 2 });
check(prot.trades.length === 1 && prot.trades[0]!.side === "sell" && Math.abs(prot.trades[0]!.price - 90) < 0.3 && Math.abs(prot.received_usd - 200 * 0.9 * 0.995) < 0.5, "protect: stops out near −10% on a $200 holding", prot.trades);
check(prot.baseline_label === "Just holding" && Math.abs(prot.baseline_usd - 10) < 0.1 && prot.result_usd < prot.baseline_usd, "protect: compared with just holding (which ended +5%)", prot);
const none = await replay({ template: "ladder", chain: "base", token: "ETH", params: { step1: 50, step2: 60, step3: 70 }, fetch: fake, now: NOW + 3 });
check(none.trades.length === 0 && none.result_usd === none.baseline_usd, "a bot whose levels are never reached doesn't trade");
const g = await replay({ template: "grid", chain: "base", token: "ETH", params: { amount_usd: 10, range_pct: 15, levels: 7 }, fetch: fake, now: NOW + 4 });
check(g.trades.some((t) => t.side === "buy") && g.trades.some((t) => t.side === "sell") && g.levels.length === 7, "grid: buys on the way down and sells on the way up", g.trades.length);
const d = await replay({ template: "dca", chain: "base", token: "ETH", params: { amount_usd: 10, every: "day" }, fetch: fake, now: NOW + 5 });
check(d.trades.length === 30 && d.spent_usd === 300, "steady buyer: one buy a day for 30 days", d.trades.length);
let bad = ""; try { await replay({ template: "dip", chain: "base", token: "0x1234567890123456789012345678901234567890", params: {}, fetch: fake }); } catch (e: any) { bad = e.message; }
check(/ETH, SOL and POL/.test(bad), "tokens Coinbase doesn't have are refused plainly", bad);

console.log(`\nbotviz: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
