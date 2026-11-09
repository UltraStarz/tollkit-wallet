/** Bots: templates, linked steps, the grid, the status board and opt-in sharing. Fake market; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { KNOWN } from "../src/tokens.js";
import { buildBot, maybeShare, pctBase, setShare, shareReport, shareSettings, summarize, TEMPLATES } from "../src/bots.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twb-"));
const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };

function market() {
  const state = { price: { ETH: 2500 } as Record<string, number>, bal: { ETH: 10n ** 18n, USDC: 10_000n * 1_000_000n } as Record<string, bigint>, swaps: [] as SwapRequest[], refuse: null as null | { code: string; reason: string } };
  const sym = (addr: string) => Object.values(KNOWN.base).find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol ?? "?";
  const quote = async (req: SwapRequest) => {
    const sell = sym(req.sell_token), buy = sym(req.buy_token), p = state.price.ETH!;
    const usd = sell === "USDC" ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e18) * p;
    const out = sell === "USDC" ? BigInt(Math.floor((usd / p) * 1e18)) : BigInt(Math.floor(usd * 1e6));
    void buy;
    return { ok: true, quote: { chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: out.toString(), min_buy_amount: out.toString(), fee_bps: 50, venue_fee_bps: 0, usd_value: usd, fee_usd: 0 } } as any;
  };
  const exec: Executor = { mode: "live", slippageBps: 50, quote, swap: async (req) => { if (state.refuse) return { ok: false, refused: state.refuse }; state.swaps.push(req); return { ...(await quote(req)), tx: `0xtx${state.swaps.length}` }; }, balance: async (_c, t) => state.bal[t.symbol] ?? 0n };
  const prices = { snapshot: () => ({ prices: { ETH: { usd: state.price.ETH!, change_24h: 0 } } }) };
  return { state, exec, prices };
}

// --- templates
check(TEMPLATES.map((t) => t.id).join() === "dca,dip,protect,trail,ladder,grid,smart_dca,rebalance,infinity_grid,twap,signal,range,alert", "the bots, the split order, Trade on a signal, the Range bot and the Alert in the catalog");
const dca = buildBot("dca", "ETH", "base", { amount_usd: 25, every: "week" }, undefined);
check(dca.rules.length === 1 && dca.rules[0]!.kind === "dca" && dca.rules[0]!.bot === dca.bot && dca.rules[0]!.template === "dca", "steady buyer: one recurring buy, no price needed");
const grid = buildBot("grid", "ETH", "base", { amount_usd: 20, range_pct: 10, levels: 5 }, 2500);
check(grid.rules[0]!.lower_price === 2250 && grid.rules[0]!.upper_price === 2750 && grid.rules[0]!.levels === 5, "grid: range around today's price", grid.rules[0]);
check(/needs a bigger gain/.test(err(() => buildBot("ladder", "ETH", "base", { step1: 30, step2: 20, step3: 50 }, 2500))), "ladder steps must climb");
check(/price/.test(err(() => buildBot("dip", "ETH", "base", {}, undefined))), "price-based bots need a price");
check(/from 1/.test(err(() => buildBot("grid", "ETH", "base", { amount_usd: 0 }, 2500))), "fields are range-checked");
{
  const pctMax = (k: string) => TEMPLATES.flatMap((t) => t.fields).filter((f) => f.key === k).map((f) => (f as any).max);
  check(["drop_pct", "stop_pct", "trail_pct"].every((k) => pctMax(k).every((m) => m === 99)) && pctMax("sell_percent").every((m) => m === 100), "falls go up to 99%, shares of a holding up to 100%");
  check(["profit_pct", "step1", "step2", "step3"].every((k) => pctMax(k).every((m) => m === 1000)), "gains go up to 1000%");
  check(buildBot("dip", "ETH", "base", { drop_pct: 99, profit_pct: 1000 }, 2500).rules.length === 2 && /to 99/.test(err(() => buildBot("dip", "ETH", "base", { drop_pct: 100 }, 2500))) && /to 100/.test(err(() => buildBot("protect", "ETH", "base", { sell_percent: 101 }, 2500))), "the limits are enforced, not just shown");
}
check(/too close/.test(err(() => buildBot("grid", "ETH", "base", { range_pct: 1, levels: 40 }, 2500))), "a grid whose levels are too close is refused");
const prot = buildBot("protect", "ETH", "base", {}, 2000);
check(prot.rules.length === 2 && prot.rules[0]!.group === prot.rules[1]!.group && prot.rules[0]!.trigger_price === 1800 && prot.rules[1]!.trigger_price === 2400, "protect: stop and take-profit cancel each other");

// --- buy the dip: the take-profit waits for the buy and sells only what the bot bought
{
  const dir = tmp(), m = market(), s = new RuleStore(dir);
  const ap = new Autopilot(s, m.exec, m.prices, { dir });
  const dip = buildBot("dip", "ETH", "base", { amount_usd: 100, drop_pct: 4, profit_pct: 5 }, 2500);
  const [buy, tp] = await s.addBot(dip.rules, "owner", false);
  check(tp!.after === buy!.id && tp!.sell_from === buy!.id, "linked steps point at the real rule id");
  m.state.price.ETH = 2700; await ap.tick();
  check(m.state.swaps.length === 0, "take-profit price reached before the buy: nothing sold (your own ETH is untouched)");
  m.state.price.ETH = 2400; await ap.tick();
  check(m.state.swaps.length === 1 && s.get(buy!.id)!.status === "done", "the dip buy fills");
  const bought = BigInt(s.get(buy!.id)!.state.bought_atomic!);
  m.state.price.ETH = 2525; await ap.tick();
  check(m.state.swaps.length === 2 && BigInt(m.state.swaps[1]!.sell_amount) === bought && s.get(tp!.id)!.status === "done", "then it sells exactly what it bought", [String(bought), m.state.swaps[1]?.sell_amount]);
  const sum = summarize(s.list())[0]!;
  check(sum.trades_ok === 2 && sum.trades_failed === 0 && sum.success_rate === 100 && sum.status === "done" && sum.result_usd !== null && sum.result_usd > 4 && sum.result_usd < 6, "status board: two trades, profit about $5", sum);
}

// --- the widest settings are accepted by the rule store too
{
  const s = new RuleStore(tmp());
  let added: number | string = 0;
  try { for (const [t, p] of [["trail", { trail_pct: 99 }], ["grid", { range_pct: 90, levels: 3 }], ["dip", { drop_pct: 99, profit_pct: 1000 }]] as const) added = (added as number) + (await s.addBot(buildBot(t, "ETH", "base", p, 2500).rules, "owner", false)).length; } catch (e) { added = (e as Error).message; }
  check(added === 4, "a 99% trailing stop, a ±90% grid and a 99% dip are saved", added);
}

// --- a cancelled first step cancels the next
{
  const dir = tmp(), m = market(), s = new RuleStore(dir), ap = new Autopilot(s, m.exec, m.prices, { dir });
  const [buy, tp] = await s.addBot(buildBot("dip", "ETH", "base", {}, 2500).rules, "owner", false);
  await s.setStatus(buy!.id, "cancelled"); await ap.tick();
  check(s.get(tp!.id)!.status === "cancelled", "stopping the buy cancels the take-profit");
}

// --- removing a stopped bot from the list
{
  const dir = tmp(), s = new RuleStore(dir);
  const [buy, tp] = await s.addBot(buildBot("dip", "ETH", "base", {}, 2500).rules, "owner", true);
  const live = await s.archive([buy!.id]).then(() => "removed", (e: Error) => e.message);
  check(/Stop it first/.test(live) && !s.get(buy!.id)!.archived, "a bot that can still trade can't be removed", live);
  await s.setStatus(buy!.id, "cancelled"); await s.setStatus(tp!.id, "cancelled");
  check((await s.archive([buy!.id, tp!.id])) === 2 && s.get(buy!.id)!.archived === true && s.list().length === 2, "a stopped bot can be removed from the list; its rules and trades are kept");
}

// --- grid
{
  const dir = tmp(), m = market(), s = new RuleStore(dir), ap = new Autopilot(s, m.exec, m.prices, { dir });
  const [g] = await s.addBot(buildBot("grid", "ETH", "base", { amount_usd: 20, range_pct: 10, levels: 5 }, 2500).rules, "owner", false); // levels 2250 2375 2500 2625 2750
  m.state.price.ETH = 2500; await ap.tick();
  check(m.state.swaps.length === 1 && s.get(g!.id)!.state.grid!.atomic[2] !== null, "at 2500 it buys the 2500 level");
  await ap.tick();
  check(m.state.swaps.length === 1, "one buy per level");
  m.state.price.ETH = 2360; await ap.tick(); await ap.tick();
  check(m.state.swaps.length === 2 && s.get(g!.id)!.state.grid!.atomic[1] !== null && s.get(g!.id)!.state.grid!.atomic[0] === null, "falling to 2360 buys the 2375 level only");
  m.state.price.ETH = 2630; await ap.tick(); await ap.tick(); await ap.tick();
  const st = s.get(g!.id)!.state;
  check(m.state.swaps.length === 4 && st.round_trips === 2 && st.grid!.atomic.every((x) => x === null) && (st.grid_profit_usd ?? 0) > 0, "rising to 2630 sells both, each a level up, at a profit", st);
  m.state.price.ETH = 2100; await ap.tick();
  check(m.state.swaps.length === 4, "below the range it doesn't buy");
  m.state.refuse = { code: "over_daily_limit", reason: "Over today's limit." }; m.state.price.ETH = 2400; await ap.tick();
  const b = summarize(s.list())[0]!;
  check(b.earned_usd === Math.round((st.grid_profit_usd ?? 0) * 100) / 100 && b.earned_usd > 0, "0.9.13: a grid's earned money is its finished levels' profit", b);
  check(b.trades_failed === 1 && b.trades_ok === 4 && b.round_trips === 2 && b.status === "running", "failures are counted and the bot keeps running", b);
  m.state.refuse = null;
}

// --- sharing (opt-in)
{
  const dir = tmp();
  check(shareSettings(dir).share === false, "sharing is off until the owner turns it on");
  const s = new RuleStore(dir);
  await s.addBot(buildBot("grid", "ETH", "base", {}, 2500).rules, "owner", false);
  const r = s.list()[0]!; await s.mutate((rs) => { rs[0]!.state.ok_count = 3; rs[0]!.state.spent_usd = 60; rs[0]!.state.received_usd = 63; });
  void r;
  const rep = shareReport(summarize(s.list()), shareSettings(dir).install, () => "ETH");
  const keys = Object.keys(rep.bots[0]!).sort().join();
  check(keys === "bot,chain,days,result_pct,round_trips,status,template,token,trades_failed,trades_ok" && !JSON.stringify(rep).includes("0x"), "the report has no addresses, dollars or transactions", rep);
  let sent = 0;
  const f = (async (u: string, init: any) => { sent++; check(u === "https://p.example/wallet/bots/report" && JSON.parse(init.body).install === shareSettings(dir).install, "report goes to Tollkit with the install id"); return new Response("{}", { status: 200 }); }) as any;
  check(!(await maybeShare(dir, summarize(s.list()), () => "ETH", { fetch: f, proxy: "https://p.example/wallet" })) && sent === 0, "nothing is sent while sharing is off");
  setShare(true, dir);
  await maybeShare(dir, summarize(s.list()), () => "ETH", { fetch: f, proxy: "https://p.example/wallet" });
  await maybeShare(dir, summarize(s.list()), () => "ETH", { fetch: f, proxy: "https://p.example/wallet" });
  check(sent === 1, "at most once a day");
}

// --- 0.9.6: tighter grid defaults that still earn after the 0.25% bot fee on each side
{
  const g = buildBot("grid", "SOL", "solana", {}, 200).rules[0]! as any;
  const step = (g.upper_price - g.lower_price) / (g.levels - 1), gap = (step / (g.upper_price - step)) * 100;
  check(g.levels === 16 && g.amount_usd === 25 && Math.abs(g.lower_price - 184) < 0.01 && Math.abs(g.upper_price - 216) < 0.01, "default grid: ±8%, 16 levels, $25 a level", g);
  check(gap >= 0.7 && gap < 1.2, `default levels are ${gap.toFixed(2)}% apart: 0.2%+ kept after 0.25% on each side`);
  check(/too close/.test(err(() => buildBot("grid", "SOL", "solana", { range_pct: 3, levels: 12 }, 200))), "a grid under 0.7% apart is refused (it would lose after fees)");
  check(err(() => buildBot("grid", "SOL", "solana", { range_pct: 5, levels: 12 }, 200)) === "", "a grid about 0.85% apart is allowed");
}

// --- 0.9.13: results for bots that run on TOLLkit's server (no price seen here), and earned money
{
  const s = new RuleStore(tmp());
  await s.addBot(buildBot("dip", "SOL", "solana", { amount_usd: 10, drop_pct: 2, profit_pct: 2 }, 100).rules, "owner", false);
  await s.mutate((rs) => { for (const r of rs) r.state.last_price = undefined;
    rs[0]!.state.spent_usd = 20; rs[0]!.state.bought_units = 0.2; rs[0]!.state.ok_count = 2;
    rs[1]!.state.received_usd = 10.4; rs[1]!.state.sold_units = 0.1; rs[1]!.state.ok_count = 1; });
  const noPrice = summarize(s.list())[0]!;
  check(noPrice.result_usd === null && noPrice.earned_usd === 0.4, "without a price: no result yet, but earned is known ($10.40 for coins that cost $10.00)", noPrice);
  const priced = summarize(s.list(), (c, t) => (c === "solana" && t === "SOL" ? 105 : undefined))[0]!;
  check(priced.result_usd === 0.9 && priced.value_now_usd === 10.5 && priced.last_price === 105, "with today's price: 10.40 + 0.1 SOL at $105 − 20 = +$0.90", priced);
}

// Nov 8 (money audit): a bot that sold more than it bought counts only what its own buys cover; paper bots are flagged.
{
  const mk = (paper: boolean) => ({ id: "m" + paper, kind: "limit_sell", chain: "solana", token: "SOL", bot: "mb" + paper, status: "done", paper, created_by: "agent", created_at: "2026-11-01T00:00:00Z",
    state: { runs: 1, failures: 0, fills: [], spent_usd: 100, received_usd: 220, bought_units: 1, sold_units: 2, last_price: 110 } } as any);
  const [b] = summarize([mk(false)]);
  check(Math.abs((b!.earned_usd ?? 0) - 10) < 0.01, "sold 2 for $220 after buying 1 for $100: earned $10, not $120", b!.earned_usd);
  check(summarize([mk(true)])[0]!.paper === true && b!.paper === false, "practice bots carry a paper flag");
}
// Nov 8 (money audit): % on the money a bot puts to work, not lifetime spending.
{
  check(pctBase([{ kind: "grid", amount_usd: 10, levels: 11 } as any], 1000) === 100, "a $10 x 10-level grid that cycled $1,000: % is on $100");
  check(pctBase([{ kind: "grid", amount_usd: 10, levels: 11 } as any], 30) === 30, "a grid that has only spent $30 so far: % on $30");
  check(pctBase([{ kind: "limit_buy", amount_usd: 50 } as any], 50) === 50, "anything else: % on what it spent");
}
console.log(`\nbots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
