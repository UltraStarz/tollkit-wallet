/** 0.9.9: when sells compete (src/pools.ts): each rule's pool, stops first, pro rata within a tier, grids capped. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { KNOWN } from "../src/tokens.js";
import { allocateSells, sellTier } from "../src/pools.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); } };

// ─── the math ───────────────────────────────────────────────────────────────
check(sellTier("stop_loss") === 0 && sellTier("trailing_stop") === 0 && sellTier("take_profit") === 1 && sellTier("grid") === 2 && sellTier("dca") === 3, "tiers: stops, then take-profits, then bots, then the rest");
{ const g = allocateSells([{ id: "a", tier: 1, want: 100n }, { id: "b", tier: 1, want: 50n }], () => 1000n);
  check(g.get("a") === 100n && g.get("b") === 50n, "enough for everyone: each gets what it asked"); }
{ const g = allocateSells([{ id: "s", tier: 0, want: 40n }, { id: "a", tier: 1, want: 100n }, { id: "b", tier: 1, want: 50n }, { id: "c", tier: 3, want: 5n }], (t) => (t === 0 ? 200n : 100n));
  check(g.get("s") === 40n && g.get("a") === 40n && g.get("b") === 20n && g.get("c") === 0n, "the stop is served first; the take-profits share the 60 left 2:1; later tiers wait", [...g]); }
{ const g = allocateSells([{ id: "a", tier: 1, want: 7n }, { id: "b", tier: 1, want: 7n }, { id: "c", tier: 1, want: 7n }], () => 10n);
  const sum = [...g.values()].reduce((x, y) => x + y, 0n);
  check(sum === 10n && [...g.values()].every((v) => v === 3n || v === 4n), "rounding: nothing lost, nothing over (Σ = what's held)", [...g]); }
{ let ok = true;
  for (let i = 0; i < 300; i++) {
    const asks = Array.from({ length: 1 + (i % 6) }, (_, k) => ({ id: `r${k}`, tier: ((i + k) % 4) as 0 | 1 | 2 | 3, want: BigInt(1 + ((i * 7919 + k * 104729) % 5000)) }));
    const H = BigInt((i * 37) % 9000), cap1 = H / 2n;
    const g = allocateSells(asks, (t) => (t === 0 ? H : cap1));
    const tot = [...g.values()].reduce((x, y) => x + y, 0n);
    if (tot > H || asks.some((a) => g.get(a.id)! > a.want || g.get(a.id)! < 0n)) ok = false;
    const later = asks.filter((a) => a.tier >= 1).reduce((s, a) => s + g.get(a.id)!, 0n);
    if (later > cap1 && later > 0n && asks.filter((a) => a.tier >= 1).length) { const t0 = asks.filter((a) => a.tier === 0).reduce((s, a) => s + g.get(a.id)!, 0n); if (t0 + later > H) ok = false; }
  }
  check(ok, "300 random cases: Σ granted ≤ H, no rule over its ask, none negative"); }

// ─── on the device ──────────────────────────────────────────────────────────
const ETH = KNOWN.base.ETH!.address, USDC = KNOWN.base.USDC!.address, GAS = 50_000_000_000_000n;
function market(eth: bigint) {
  const st = { price: 2500, eth, swaps: [] as SwapRequest[] };
  const quote = async (req: SwapRequest) => {
    const buying = req.sell_token.toLowerCase() === USDC.toLowerCase();
    const usd = buying ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e18) * st.price;
    const out = buying ? BigInt(Math.floor((usd / st.price) * 1e18)) : BigInt(Math.floor(usd * 1e6));
    return { ok: true, quote: { chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: out.toString(), min_buy_amount: out.toString(), fee_bps: 50, venue_fee_bps: 0, usd_value: usd } } as any;
  };
  const exec: Executor = { mode: "live", slippageBps: 50, quote, swap: async (req) => { const q = await quote(req); st.swaps.push(req); if (req.buy_token.toLowerCase() === ETH.toLowerCase()) st.eth += BigInt(q.quote.buy_amount); else st.eth -= BigInt(req.sell_amount); return { ...q, tx: `0x${st.swaps.length}` }; }, balance: async (_c, t) => (t.address.toLowerCase() === ETH.toLowerCase() ? st.eth : 10n ** 12n) };
  return { st, exec, prices: { snapshot: () => ({ prices: { ETH: { usd: st.price, change_24h: 0 } } }) } };
}
const ONE = 10n ** 18n;
const setup = async (eth: bigint) => { const dir = mkdtempSync(path.join(os.tmpdir(), "pools-")), m = market(eth), s = new RuleStore(dir); let clock = Date.now(); const ap = new Autopilot(s, m.exec, m.prices as any, { dir, now: () => clock }); return { s, m, tick: async () => { clock += 15_000; await ap.tick(); } }; };
// Your grid holds 1 ETH of the 3 you have (its pool), set by its own record of what it bought.
const gridOf = async (s: RuleStore) => { const g = await s.add({ kind: "grid", chain: "base", token: "ETH", amount_usd: 20, lower_price: 1000, upper_price: 1100, levels: 3, bot: "grid1" }, "owner", true); await s.mutate((rs) => { const x = rs.find((y) => y.id === g.id)!; x.state.bought_units = 1; x.status = "paused"; }); return g; };

{ // A take-profit for all your ETH leaves the grid's coins alone.
  const W = await setup(3n * ONE + GAS); await gridOf(W.s);
  const tp = await W.s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2400 }, "owner", true);
  await W.tick();
  check(W.m.st.swaps.length === 1 && BigInt(W.m.st.swaps[0]!.sell_amount) === 2n * ONE && W.s.get(tp.id)!.status === "done", "take-profit 100%: sells the 2 ETH no bot holds, not the grid's 1", W.m.st.swaps.map((x) => x.sell_amount)); }
{ // A stop may sell everything (protection wins).
  const W = await setup(3n * ONE + GAS); await gridOf(W.s);
  await W.s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2600 }, "owner", true);
  await W.tick();
  check(W.m.st.swaps.length === 1 && BigInt(W.m.st.swaps[0]!.sell_amount) === 3n * ONE, "stop 100%: sells all 3 ETH, the grid's included", W.m.st.swaps.map((x) => x.sell_amount)); }
{ // Stop and take-profit fire in the same check: the stop goes first, the take-profit gets what's left (no failed swap).
  const W = await setup(2n * ONE + GAS);
  const st = await W.s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_amount: "1.5", trigger_price: 2600 }, "owner", true);
  const tp = await W.s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_amount: "1.5", trigger_price: 2400 }, "owner", true);
  await W.tick();
  const amts = W.m.st.swaps.map((x) => BigInt(x.sell_amount));
  check(amts[0] === 1_500_000_000_000_000_000n && amts[1] === 500_000_000_000_000_000n && W.m.st.eth === GAS, "1.5 + 1.5 wanted, 2 held: the stop sells 1.5 first, the take-profit the 0.5 left", amts);
  check(W.s.get(st.id)!.status === "done" && W.s.get(tp.id)!.state.failures === 0, "nothing failed"); }
{ // Two take-profits wanting more than is free share it pro rata.
  const W = await setup(3n * ONE + GAS);
  await W.s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_amount: "3", trigger_price: 2400 }, "owner", true);
  await W.s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_amount: "1", trigger_price: 2300 }, "owner", true);
  await W.tick();
  const amts = W.m.st.swaps.map((x) => BigInt(x.sell_amount)).sort((a, b) => (a < b ? 1 : -1));
  check(amts[0] === 2_250_000_000_000_000_000n && amts[1] === 750_000_000_000_000_000n, "3 + 1 wanted, 3 free: 2.25 and 0.75 (3:1)", amts); }
{ // A grid whose coins were sold by another rule waits instead of failing a swap.
  const W = await setup(GAS + 10n);
  const g = await W.s.add({ kind: "grid", chain: "base", token: "ETH", amount_usd: 20, lower_price: 2000, upper_price: 2400, levels: 3, bot: "grid2" }, "owner", true);
  await W.s.mutate((rs) => { const x = rs.find((y) => y.id === g.id)!; x.state.bought_units = 0.5; x.state.grid = { units: [0.5, null, null], cost: [1000, null, null], atomic: [(ONE / 2n).toString(), null, null] }; });
  await W.tick();
  check(!W.m.st.swaps.some((x) => x.sell_token.toLowerCase() === ETH.toLowerCase()) && W.s.get(g.id)!.state.failures === 0 && !!W.s.get(g.id)!.state.hold_until, "a grid whose coins another rule sold waits; no failed swap, no dust sale", W.s.get(g.id)!.state); }

console.log(`\npools: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
