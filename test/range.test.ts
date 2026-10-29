/** 0.9.9: the Range bot on Orca's SOL/USDC pool (src/autopilot.ts range, src/bots.ts). Fake pool and swaps, no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore, ruleProblem, describeRule } from "../src/rules.js";
import { Autopilot, type Executor, type LpExecutor } from "../src/autopilot.js";
import { KNOWN } from "../src/tokens.js";
import { buildBot, summarize } from "../src/bots.js";
import { amountsForLiquidity, liquidityForAmounts, priceToSqrtPrice, tickToPrice, tickToSqrtPrice } from "../src/clmm.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d)); } };

// ─── rules and the template ─────────────────────────────────────────────────
check(/SOL\/USDC pool only/.test(ruleProblem({ kind: "range", chain: "base", token: "ETH", amount_usd: 100, range_pct: 5 } as any) ?? ""), "SOL/USDC on Solana only");
check(/at least \$20/.test(ruleProblem({ kind: "range", chain: "solana", token: "SOL", amount_usd: 5, range_pct: 5 } as any) ?? ""), "at least $20");
const built = buildBot("range", "SOL", "solana", { amount_usd: 200, range_pct: 4, recenter_min: 20 }, undefined);
check(built.rules[0]!.kind === "range" && built.rules[0]!.range_pct === 4 && built.rules[0]!.recenter_min === 20 && built.rules[0]!.amount_usd === 200, "the template builds a range rule", built.rules[0]);
check(/Orca's SOL\/USDC pool between 4% below and above/.test(describeRule(built.rules[0]!)), "plain description", describeRule(built.rules[0]!));

// ─── on the device ──────────────────────────────────────────────────────────
const SOL = KNOWN.solana.SOL!.address, USDC = KNOWN.solana.USDC!.address;
const st = { price: 100, swaps: [] as SwapRequest[], wallet: { sol: 2_000_000_000n, usdc: 500_000_000n }, opens: [] as any[], closes: 0, failOpen: false };
const quote = async (req: SwapRequest) => { const buying = req.sell_token === USDC; const usd = buying ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e9) * st.price;
  return { ok: true, quote: { chain: "solana", venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: String(buying ? BigInt(Math.floor((usd * 0.9975 / st.price) * 1e9)) : BigInt(Math.floor(usd * 0.9975 * 1e6))), min_buy_amount: "0", fee_bps: 25, venue_fee_bps: 0, usd_value: usd } } as any; };
const positions = new Map<string, { L: bigint; lower: number; upper: number }>();
const sqrtNow = () => priceToSqrtPrice(st.price, 9, 6);
const lp: LpExecutor = {
  pool: async () => ({ price: st.price, spacing: 4 }),
  open: async (o) => {
    if (st.failOpen) throw new Error("This transaction would fail right now");
    const mint = `pos${st.opens.length + 1}`; await o.beforeSend?.(mint);
    const L = liquidityForAmounts(o.maxSol, o.maxUsdc, sqrtNow(), tickToSqrtPrice(o.lower), tickToSqrtPrice(o.upper));
    const used = amountsForLiquidity(L, sqrtNow(), tickToSqrtPrice(o.lower), tickToSqrtPrice(o.upper));
    st.wallet.sol -= used.a; st.wallet.usdc -= used.b;
    positions.set(mint, { L, lower: o.lower, upper: o.upper }); st.opens.push({ ...o, used }); return { mint, tx: `open${st.opens.length}` };
  },
  close: async (mint) => { const p = positions.get(mint)!; positions.delete(mint); st.closes++;
    const a = amountsForLiquidity(p.L, sqrtNow(), tickToSqrtPrice(p.lower), tickToSqrtPrice(p.upper));
    st.wallet.sol += a.a + 1_000_000n; st.wallet.usdc += a.b + 100_000n;
    return { tx: `close${st.closes}`, sol: a.a + 1_000_000n, usdc: a.b + 100_000n, feesSol: 1_000_000n, feesUsdc: 100_000n }; },
  read: async (mint) => { const p = positions.get(mint); if (!p) return null; const a = amountsForLiquidity(p.L, sqrtNow(), tickToSqrtPrice(p.lower), tickToSqrtPrice(p.upper));
    const lo = tickToPrice(p.lower, 9, 6), hi = tickToPrice(p.upper, 9, 6); return { sol: Number(a.a) / 1e9, usdc: Number(a.b) / 1e6, inRange: st.price >= lo && st.price < hi, lower: lo, upper: hi }; },
};
const exec: Executor = { mode: "live", slippageBps: 50, quote, lp,
  swap: async (req) => { const q = await quote(req); st.swaps.push(req); if (req.sell_token === USDC) { st.wallet.usdc -= BigInt(req.sell_amount); st.wallet.sol += BigInt(q.quote.buy_amount); } else { st.wallet.sol -= BigInt(req.sell_amount); st.wallet.usdc += BigInt(q.quote.buy_amount); } return { ...q, tx: `swap${st.swaps.length}` }; },
  balance: async (_c, t) => (t.address === SOL ? st.wallet.sol : st.wallet.usdc) };
const dir = mkdtempSync(path.join(os.tmpdir(), "range-")), s = new RuleStore(dir);
let clock = Date.parse("2026-10-29T12:00:00Z");
const ap = new Autopilot(s, exec, { snapshot: () => ({ prices: { SOL: { usd: st.price, change_24h: 0 } } }) } as any, { dir, now: () => clock });
const tick = async (ms = 15_000) => { clock += ms; await ap.tick(); };

const agent = await s.add({ kind: "range", chain: "solana", token: "SOL", amount_usd: 100, range_pct: 5 }, "agent", true);
await tick();
check(s.get(agent.id)!.status === "cancelled" && st.opens.length === 0, "an AI app can't start one: only the owner", s.get(agent.id)!.state.last_error);

const [r] = await s.addBot(buildBot("range", "SOL", "solana", { amount_usd: 100, range_pct: 5, recenter_min: 30 }, 100).rules, "owner", true);
await tick();
const r1 = s.get(r!.id)!, rg = r1.state.range!;
check(st.swaps.length === 1 && st.swaps[0]!.sell_token === USDC && st.swaps[0]!.bot === true && Math.abs(Number(st.swaps[0]!.sell_amount) / 1e6 - 50) < 3, "buys about half in SOL, with the 0.25% bot fee", st.swaps[0]);
check(st.opens.length === 1 && !!rg.mint && rg.lower! < 100 && rg.upper! > 100 && Math.abs(rg.lower! - 95) < 0.3 && Math.abs(rg.upper! - 105) < 0.3, "opens $95–$105 around $100", rg);
check(Number(st.opens[0].used.a) > Number(st.opens[0].maxSol) * 0.98 && Number(st.opens[0].used.b) > Number(st.opens[0].maxUsdc) * 0.98, "nearly all of both coins go in", st.opens[0]);
check(rg.deposited_usd === 100 && !rg.staged && !rg.phase, "deposited $100; nothing left waiting");

st.price = 103; await tick();
check(s.get(r!.id)!.state.range!.in_range === true && st.closes === 0, "inside the range: stays put");
st.price = 108; await tick();
const out1 = s.get(r!.id)!.state.range!;
check(out1.in_range === false && !!out1.out_since && st.closes === 0, "leaves the range: starts the clock, doesn't move yet", out1);
await tick(20 * 60_000);
check(st.closes === 0, "20 minutes out: still waiting (recenter after 30)");
st.price = 108.5; await tick(11 * 60_000);
const r2 = s.get(r!.id)!.state.range!;
check(st.closes === 1 && st.opens.length === 2 && r2.recenters === 1 && r2.lower! < 108.5 && r2.upper! > 108.5, "31 minutes out: takes it out and opens a new range around $108.50", r2);
check(st.swaps.length === 2 && st.swaps[1]!.sell_token === USDC, "above the range it was all USDC, so it buys SOL back to about half", st.swaps[1]);
check(Math.abs((r2.fees_usd ?? 0) - (0.001 * 108.5 + 0.1)) < 0.01, "fees taken out are counted", r2.fees_usd);

const sum = summarize(s.list()).find((b) => b.template === "range")!;
check(!!sum.range && sum.range.open && sum.range.recenters === 1 && sum.result_usd !== null, "status board: open, one re-center, a result against the $100", sum.range);

// A failed open leaves the coins in the wallet and retries with them, without buying again.
st.price = 120; st.failOpen = true; await tick(); await tick(31 * 60_000);
const f = s.get(r!.id)!;
check(st.closes === 2 && f.state.range!.staged === true && !f.state.range!.mint && f.state.failures === 1, "re-center whose open fails: coins wait in the wallet", f.state.range);
const swapsBefore = st.swaps.length; st.failOpen = false; await tick(6 * 60_000);
const g = s.get(r!.id)!.state.range!;
check(!!g.mint && st.opens.length === 3 && st.swaps.length === swapsBefore, "next try opens with the same coins and doesn't swap again", { g, swaps: st.swaps.length - swapsBefore });

// Stop: everything back to the wallet.
await s.mutate((rs) => { const x = rs.find((y) => y.id === r!.id)!; x.status = "cancelled"; });
await tick();
const z = s.get(r!.id)!.state;
check(st.closes === 3 && !z.range!.mint && positions.size === 0 && /back to your wallet/.test(z.note ?? ""), "stopping takes it all out", z.note);

// The app stopped mid-open: the next check finds the position that landed.
const [q] = await s.addBot(buildBot("range", "SOL", "solana", { amount_usd: 50, range_pct: 10, recenter_min: 30 }, 120).rules, "owner", true);
await s.mutate((rs) => { const x = rs.find((y) => y.id === q!.id)!; x.state.range = { phase: "opening", mint: "ghost", staged: true, sol: 0.2, usdc: 25 }; });
await tick();
const qq = s.get(q!.id)!.state.range!;
check(qq.mint !== "ghost" && !!qq.mint && !qq.phase, "an open that never landed is opened again", qq);

console.log(`\nrange: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
