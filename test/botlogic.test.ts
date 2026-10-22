/** 0.9.3 bots: Smart DCA, rebalancer, infinity grid, split orders (src/botlogic.ts), run by the autopilot against a fake market. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore, describeRule, ruleProblem } from "../src/rules.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { decide, applyFill, botProblem, largestBuy, type BotState } from "../src/botlogic.js";
import { buildBot } from "../src/bots.js";
import { KNOWN } from "../src/tokens.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twbl-"));

function market() {
  const state = { price: { SOL: 100 } as Record<string, number>, bal: { SOL: 5n * 10n ** 9n, USDC: 1000n * 10n ** 6n } as Record<string, bigint>, swaps: [] as SwapRequest[] };
  const sym = (addr: string) => Object.values(KNOWN.solana).find((t) => t.address === addr)?.symbol ?? "?";
  const quote = async (req: SwapRequest) => {
    const sell = sym(req.sell_token), buy = sym(req.buy_token), p = state.price.SOL!;
    const usd = sell === "USDC" ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e9) * p;
    const out = sell === "USDC" ? BigInt(Math.floor((usd / p) * 1e9)) : BigInt(Math.floor(usd * 1e6));
    return { ok: true, quote: { chain: req.chain, venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: out.toString(), min_buy_amount: out.toString(), fee_bps: 50, venue_fee_bps: 0, usd_value: usd, fee_usd: 0 } } as any;
  };
  const exec: Executor = {
    mode: "live", slippageBps: 50, quote,
    swap: async (req) => {
      state.swaps.push(req);
      const q = await quote(req), sell = sym(req.sell_token);
      if (sell === "USDC") { state.bal.USDC! -= BigInt(req.sell_amount); state.bal.SOL! += BigInt(q.quote.buy_amount); }
      else { state.bal.SOL! -= BigInt(req.sell_amount); state.bal.USDC! += BigInt(q.quote.buy_amount); }
      return { ...q, tx: `tx${state.swaps.length}` };
    },
    balance: async (_c, t) => state.bal[t.symbol] ?? 0n,
  };
  const prices = { snapshot: () => ({ prices: { SOL: { usd: state.price.SOL!, change_24h: 0 } } }) };
  return { state, exec, prices };
}
async function run(rule: any) {
  const dir = tmp(), m = market(), s = new RuleStore(dir);
  let clock = Date.now();
  const ap = new Autopilot(s, m.exec, m.prices, { dir, now: () => clock });
  const r = await s.add({ chain: "solana", token: "SOL", ...rule }, "owner", false);
  const at = async (p: number, ms = 15_000) => { m.state.price.SOL = p; clock += ms; await ap.tick(); return s.get(r.id)!; };
  return { m, s, r, at, get: () => s.get(r.id)! };
}
const usdOf = (req: SwapRequest) => Number(req.sell_amount) / 1e6;
const solOf = (req: SwapRequest) => Number(req.sell_amount) / 1e9;

// --- checks on the fields
{
  check(ruleProblem({ kind: "smart_dca", chain: "solana", token: "SOL", amount_usd: 20, step_pct: 3, safety: 4, scale: 1.5, profit_pct: 3 }) === null, "Smart DCA with all fields is fine");
  check(ruleProblem({ kind: "rebalance", chain: "solana", token: "SOL", amount_usd: 4, target_pct: 50, band_pct: 5 }) !== null, "a tiny rebalancer pot is refused");
  check(ruleProblem({ kind: "twap", chain: "solana", token: "SOL", side: "buy", amount_usd: 5, pieces: 10, hours: 5 }) !== null, "a split buy with parts under $1 is refused");
  check(ruleProblem({ kind: "twap", chain: "solana", token: "SOL", side: "sell", sell_percent: 50, pieces: 10, hours: 5 }) === null, "a split sell of half is fine");
  check(ruleProblem({ kind: "infinity_grid", chain: "solana", token: "USDC", amount_usd: 100, step_pct: 2 }) !== null, "a stablecoin can't be a bot's coin");
  check(describeRule({ kind: "rebalance", chain: "solana", token: "SOL", amount_usd: 100, target_pct: 50, band_pct: 5 }) === "Rebalance $100 to 50% SOL / 50% USDC whenever it drifts 5 points on Solana", "plain description", describeRule({ kind: "rebalance", chain: "solana", token: "SOL", amount_usd: 100, target_pct: 50, band_pct: 5 }));
  check(largestBuy({ kind: "smart_dca", amount_usd: 20, scale: 1.5, safety: 4 }) === 20 * 1.5 ** 4, "Smart DCA's largest buy is the last extra one");
  check(botProblem({ kind: "infinity_grid", amount_usd: 20, step_pct: 2 }) !== null, "an infinity grid whose steps trade under $1 is refused");
}

// --- Smart DCA: buys, adds on the way down, sells all at +3% over the average, starts over
{
  const t = await run({ kind: "smart_dca", amount_usd: 20, step_pct: 3, safety: 2, scale: 2, profit_pct: 3 });
  let r = await t.at(100);
  check(t.m.state.swaps.length === 1 && usdOf(t.m.state.swaps[0]!) === 20, "first buy of $20");
  r = await t.at(98);
  check(t.m.state.swaps.length === 1, "no extra buy at -2% (step is 3%)");
  r = await t.at(96.9);
  check(t.m.state.swaps.length === 2 && usdOf(t.m.state.swaps[1]!) === 40, "extra buy 1 is $40 (2× the first)", t.m.state.swaps[1]);
  r = await t.at(93.9);
  check(t.m.state.swaps.length === 3 && usdOf(t.m.state.swaps[2]!) === 80, "extra buy 2 is $80");
  r = await t.at(85);
  check(t.m.state.swaps.length === 3, "no more than 2 extra buys");
  const st = r.state.bot as BotState, avg = st.cost! / (Number(st.units) / 1e9);
  check(Math.abs(avg - 140 / (20 / 100 + 40 / 96.9 + 80 / 93.9)) < 0.01, "average cost tracks all three buys", avg);
  r = await t.at(avg * 1.02);
  check(t.m.state.swaps.length === 3, "holds at +2% over the average");
  r = await t.at(avg * 1.031);
  const sell = t.m.state.swaps[3]!;
  check(t.m.state.swaps.length === 4 && sell.buy_token === KNOWN.solana.USDC!.address && BigInt(sell.sell_amount) === BigInt(st.units!), "sells exactly what it bought at +3.1%", sell);
  check(r.state.round_trips === 1 && (r.state.grid_profit_usd ?? 0) > 3 && r.status === "active", "a round with ~$4 profit; still running", r.state);
  r = await t.at(avg * 1.031);
  check(t.m.state.swaps.length === 5 && usdOf(t.m.state.swaps[4]!) === 20, "starts a new round with $20");
}

// --- Rebalancer: 50/50 on $100, trades back when it drifts 5 points
{
  const t = await run({ kind: "rebalance", amount_usd: 100, target_pct: 50, band_pct: 5 });
  let r = await t.at(100);
  check(t.m.state.swaps.length === 1 && usdOf(t.m.state.swaps[0]!) === 50 && (r.state.bot as BotState).cash === 50, "sets up: $50 of SOL, $50 kept in USDC");
  r = await t.at(115);
  check(t.m.state.swaps.length === 1, "holds at +15% (SOL is 53.5% of the pot)");
  r = await t.at(125);
  const s1 = t.m.state.swaps[1]!;
  check(t.m.state.swaps.length === 2 && s1.buy_token === KNOWN.solana.USDC!.address && Math.abs(solOf(s1) * 125 - 6.25) < 0.01, "at +25% (55.6%) sells $6.25 of SOL back to 50/50", solOf(s1) * 125);
  r = await t.at(100);
  const s2 = t.m.state.swaps[2]!;
  check(t.m.state.swaps.length === 3 && s2.sell_token === KNOWN.solana.USDC!.address && Math.abs(usdOf(s2) - 5.625) < 0.01, "back at $100 (44.4%) buys $5.63 to get back to 50/50", usdOf(s2));
  const b = r.state.bot as BotState;
  check(Math.abs((b.cash ?? 0) - 50.625) < 0.01, "the pot's cash is tracked", b.cash);
}

// --- Infinity grid: keeps $100 of SOL; sells the extra every 2% up, buys back every 2% down; no buys under the floor
{
  const t = await run({ kind: "infinity_grid", amount_usd: 100, step_pct: 2, lower_price: 80 });
  let r = await t.at(100);
  check(t.m.state.swaps.length === 1 && usdOf(t.m.state.swaps[0]!) === 100, "buys its starting $100");
  r = await t.at(101.5);
  check(t.m.state.swaps.length === 1, "no trade inside a 2% step");
  r = await t.at(102.5);
  const s1 = t.m.state.swaps[1]!;
  check(t.m.state.swaps.length === 2 && Math.abs(solOf(s1) * 102.5 - 2.5) < 0.01, "+2.5%: sells the extra $2.50", solOf(s1) * 102.5);
  r = await t.at(100);
  check(t.m.state.swaps.length === 3 && Math.abs(usdOf(t.m.state.swaps[2]!) - 2.44) < 0.02, "-2.4% from that sale: buys back to $100", usdOf(t.m.state.swaps[2]!));
  r = await t.at(79);
  check(t.m.state.swaps.length === 3, "never buys under the $80 floor");
  check((r.state.round_trips ?? 0) === 1, "one sell counted as a round", r.state.round_trips);
}

// --- Split buy: $50 in 5 parts over 1 hour, one part every 12 minutes, then done
{
  const t = await run({ kind: "twap", side: "buy", amount_usd: 50, pieces: 5, hours: 1 });
  let r = await t.at(100);
  check(t.m.state.swaps.length === 1 && usdOf(t.m.state.swaps[0]!) === 10, "first part: $10 now");
  r = await t.at(101, 5 * 60_000);
  check(t.m.state.swaps.length === 1, "waits 12 minutes between parts");
  for (let i = 0; i < 4; i++) r = await t.at(100, 12 * 60_000);
  check(t.m.state.swaps.length === 5 && r.status === "done", "five parts, then done", r.status);
}

// --- Split sell: half the SOL (gas reserve kept) in 4 parts; the last part sells exactly what's left of the total
{
  const t = await run({ kind: "twap", side: "sell", sell_percent: 50, pieces: 4, hours: 2 });
  for (let i = 0; i < 4; i++) await t.at(100, 31 * 60_000);
  const total = t.m.state.swaps.reduce((a, s) => a + BigInt(s.sell_amount), 0n), want = (5n * 10n ** 9n - 10_000_000n) / 2n;
  check(t.m.state.swaps.length === 4 && total === want && t.get().status === "done", "sold exactly half of the spendable SOL in 4 parts", { total, want });
}

// --- decide is pure; a "mark" moves the infinity grid's reference without a trade
{
  const s: BotState = { started: true, units: String(10n ** 9n / 100n), cost: 1, ref: 100 };
  const a = decide({ kind: "infinity_grid", amount_usd: 100, step_pct: 2 }, s, 103, 0, { decimals: 9 });
  check(a?.side === "mark", "a step up with under $1 extra only moves the reference", a);
  const out = applyFill({ kind: "infinity_grid", amount_usd: 100, step_pct: 2 }, s, a!, { usd: 0, got: 0n }, 103, 0, 9);
  check(out.state.ref === 103 && s.ref === 100, "applyFill returns a new state and leaves the old one alone");
}

// --- the catalog builds them
{
  const b = buildBot("smart_dca", "SOL", "solana", {}, 100);
  check(b.rules[0]!.kind === "smart_dca" && b.rules[0]!.amount_usd === 20 && b.rules[0]!.safety === 4 && b.rules[0]!.scale === 1.5, "Smart DCA template with the planned defaults", b.rules[0]);
  const rb = buildBot("rebalance", "SOL", "solana", {}, 100);
  check(rb.rules[0]!.kind === "rebalance" && rb.rules[0]!.target_pct === 50 && rb.rules[0]!.band_pct === 5 && rb.rules[0]!.amount_usd === 100, "Rebalancer template", rb.rules[0]);
  const ig = buildBot("infinity_grid", "SOL", "solana", {}, 100);
  check(ig.rules[0]!.kind === "infinity_grid" && ig.rules[0]!.lower_price === 70 && ig.rules[0]!.step_pct === 2, "Infinity grid template stops buying 30% under today's price", ig.rules[0]);
  const tw = buildBot("twap", "SOL", "solana", { side: "sell", sell_percent: 25 }, 100);
  check(tw.rules[0]!.kind === "twap" && tw.rules[0]!.side === "sell" && tw.rules[0]!.sell_percent === 25 && tw.rules[0]!.pieces === 10 && tw.rules[0]!.hours === 5, "Split order template", tw.rules[0]);
}

console.log(`\nbotlogic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
