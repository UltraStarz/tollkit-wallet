/** Autopilot: rules, plain-English parser, triggers, fills, OCO, DCA, retries, lease, paper trading. Fake prices and swaps; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore, describeRule, ruleProblem, nextRun, type RuleInput } from "../src/rules.js";
import { parseStrategy } from "../src/parse.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { PaperBook } from "../src/paper.js";
import { KNOWN } from "../src/tokens.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twa-"));
const tryErr = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e: any) { return e.message as string; } };

// --- rules
{
  check(ruleProblem({ kind: "limit_buy", chain: "base", token: "ETH", trigger_price: 2000 }) !== null, "a buy without amount is refused");
  check(ruleProblem({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100 }) !== null, "a stop without a price is refused");
  check(ruleProblem({ kind: "dca", chain: "base", token: "USDC", amount_usd: 5, every: "day" }) !== null, "stablecoin as the asset is refused");
  check(describeRule({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 25, every: "week", weekday: 1 }) === "Buy $25 of SOL every Monday on Solana", "plain description", describeRule({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 25, every: "week", weekday: 1 }));
  check(describeRule({ kind: "take_profit", chain: "solana", token: "SOL", trigger_price: 100.11, sell_from: "abcd" } as any) === "Take profit: sell the SOL it bought when it reaches $100.11 on Solana", "a sell that follows a buy says it sells what that buy got, not \"? SOL\"");
  const mon = nextRun({ every: "week", weekday: 1 }, new Date("2026-10-13T12:00:00Z")); // a Tuesday
  check(mon.toISOString() === "2026-10-19T14:00:00.000Z", "weekly DCA lands on the next Monday", mon.toISOString());
  const s = new RuleStore(tmp());
  const owner = await s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2000 }, "owner", false);
  const agent = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 10, trigger_price: 2000 }, "agent", false);
  const auto = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 10, trigger_price: 2000 }, "agent", true);
  check(owner.status === "active" && agent.status === "proposed" && auto.status === "active", "owner rules start on; agent rules wait for the owner unless set to auto");
  await s.setStatus(agent.id, "active");
  check(s.get(agent.id)!.status === "active", "owner turns a proposed rule on");
  await s.setStatus(agent.id, "cancelled");
  check(/cancelled/.test(await tryErr(() => s.setStatus(agent.id, "active"))), "a cancelled rule can't come back");
}

// --- parser
{
  const px = (t: string) => ({ ETH: 2500, SOL: 100 } as Record<string, number>)[t];
  const r1 = parseStrategy("buy $25 of SOL every Monday", px);
  check(r1.rules[0]?.kind === "dca" && r1.rules[0].amount_usd === 25 && r1.rules[0].weekday === 1 && r1.rules[0].chain === "solana", "DCA every Monday", r1);
  const r2 = parseStrategy("buy $100 of ETH if it drops to $2,300", px);
  check(r2.rules[0]?.kind === "limit_buy" && r2.rules[0].trigger_price === 2300 && r2.rules[0].chain === "base", "buy at a price", r2);
  const r3 = parseStrategy("buy $50 of SOL if it drops 5%", px);
  check(r3.rules[0]?.trigger_price === 95, "buy on a 5% dip uses the current price", r3.rules[0]);
  const r4 = parseStrategy("sell half my ETH if it rises 10% and sell all ETH if it falls 8%", px);
  const [tp, sl] = r4.rules;
  check(tp?.kind === "take_profit" && tp.sell_percent === 50 && tp.trigger_price === 2750 && sl?.kind === "stop_loss" && sl.sell_percent === 100 && sl.trigger_price === 2300, "take-profit + stop-loss", r4);
  check(!!tp?.group && tp.group === sl?.group, "take-profit and stop-loss are linked (one cancels the other)");
  const r5 = parseStrategy("trailing stop 10% on SOL", px);
  check(r5.rules[0]?.kind === "trailing_stop" && r5.rules[0].trail_pct === 10 && r5.rules[0].sell_percent === 100, "trailing stop", r5);
  const r6 = parseStrategy("buy $10 of eth daily on ethereum, 30 times", px);
  check(r6.rules[0]?.kind === "dca" && r6.rules[0].every === "day" && r6.rules[0].times === 30 && r6.rules[0].chain === "ethereum", "daily DCA on Ethereum with a count", r6);
  const r7 = parseStrategy("make me rich", px);
  check(r7.rules.length === 0 && r7.unparsed[0] === "make me rich", "anything unclear is returned, not guessed");
  const r8 = parseStrategy("sell all SOL below $90", px);
  check(r8.rules[0]?.kind === "stop_loss" && r8.rules[0].trigger_price === 90, "sell below a price = stop-loss", r8);
}

// --- autopilot with a fake market
function market() {
  const state = { price: { ETH: 2500, SOL: 100 } as Record<string, number>, bal: { ETH: 10n ** 18n, SOL: 5n * 10n ** 9n } as Record<string, bigint>, swaps: [] as SwapRequest[], refuse: null as null | { code: string; reason: string } };
  const sym = (addr: string) => [...Object.values(KNOWN.base), ...Object.values(KNOWN.solana)].find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol ?? "?";
  const quote = async (req: SwapRequest) => {
    const sell = sym(req.sell_token), buy = sym(req.buy_token);
    const p = state.price[sell === "USDC" ? buy : sell]!;
    const usd = sell === "USDC" ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 10 ** (sell === "SOL" ? 9 : 18)) * p;
    const out = sell === "USDC" ? BigInt(Math.floor((usd / p) * 10 ** (buy === "SOL" ? 9 : 18))) : BigInt(Math.floor(usd * 1e6));
    return { ok: true, quote: { chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: out.toString(), min_buy_amount: out.toString(), fee_bps: 50, venue_fee_bps: 0, usd_value: usd, fee_usd: usd * 0.005 } } as any;
  };
  const exec: Executor = {
    mode: "live", slippageBps: 50, quote,
    swap: async (req) => { if (state.refuse) return { ok: false, refused: state.refuse }; state.swaps.push(req); return { ...(await quote(req)), tx: `0xtx${state.swaps.length}` }; },
    balance: async (_c, t) => state.bal[t.symbol] ?? 0n,
  };
  const prices = { snapshot: () => ({ prices: { ETH: { usd: state.price.ETH!, change_24h: 0 }, SOL: { usd: state.price.SOL!, change_24h: 0 } } }) };
  return { state, exec, prices };
}
{
  const dir = tmp(), m = market(), s = new RuleStore(dir);
  let clock = Date.now(); // the store stamps new rules with the real clock
  const events: string[] = [];
  const ap = new Autopilot(s, m.exec, m.prices, { dir, now: () => clock, onEvent: (e) => events.push(`${e.type}:${e.rule.kind}`) });
  const buy = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 2400 }, "owner", false);
  const prop = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 2600 }, "agent", false);
  await ap.tick();
  check(m.state.swaps.length === 0 && s.get(buy.id)!.state.last_price === 2500, "no fill above the limit; price recorded");
  check(s.get(prop.id)!.status === "proposed", "a proposed rule never trades, even when its price is hit");
  m.state.price.ETH = 2390; clock += 15_000; await ap.tick();
  const b = s.get(buy.id)!;
  check(m.state.swaps.length === 1 && b.status === "done" && b.state.fills[0]?.tx === "0xtx1" && m.state.swaps[0]!.sell_amount === "20000000", "limit buy fills at $2,390 for $20 of USDC", b);

  // OCO: take-profit + stop-loss
  const [tp, sl] = await Promise.all([
    s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_percent: 50, trigger_price: 2700, group: "g1" }, "owner", false),
    s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2200, group: "g1" }, "owner", false),
  ]);
  m.state.price.ETH = 2710; clock += 15_000; await ap.tick();
  check(s.get(tp.id)!.status === "done" && s.get(sl.id)!.status === "cancelled", "take-profit fills and cancels its stop-loss");
  const sold = m.state.swaps.at(-1)!;
  check(sold.sell_amount === String((10n ** 18n - 50_000_000_000_000n) / 2n) && sold.buy_token === KNOWN.base.USDC!.address, "sold half the spendable ETH (gas reserve kept) for USDC", sold);

  // Trailing stop tracks the high, then fires; native coin keeps a gas reserve
  const ts = await s.add({ kind: "trailing_stop", chain: "base", token: "ETH", trail_pct: 10, sell_percent: 100 }, "owner", false);
  for (const p of [2700, 3000, 2800]) { m.state.price.ETH = p; clock += 15_000; await ap.tick(); }
  check(s.get(ts.id)!.status === "active" && s.get(ts.id)!.state.high === 3000, "trailing stop remembers the $3,000 high and holds at $2,800");
  m.state.price.ETH = 2690; clock += 15_000; await ap.tick();
  check(s.get(ts.id)!.status === "done", "fires at $2,690 (more than 10% under $3,000)");
  check(m.state.swaps.at(-1)!.sell_amount === String(10n ** 18n - 50_000_000_000_000n), "keeps 0.00005 ETH for gas when selling all ETH", m.state.swaps.at(-1));

  // DCA with a count and a max price
  const dca = await s.add({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 10, every: "day", times: 2, max_price: 120 }, "owner", false);
  const n0 = m.state.swaps.length;
  clock += 15_000; await ap.tick();
  check(m.state.swaps.length === n0 + 1 && s.get(dca.id)!.state.runs === 1, "first DCA buy right away");
  clock += 3600_000; await ap.tick();
  check(m.state.swaps.length === n0 + 1, "no second buy before a day passes");
  m.state.price.SOL = 130; clock += 86_400_000; await ap.tick();
  check(m.state.swaps.length === n0 + 1 && events.includes("skipped:dca"), "skips a round while above the $120 max");
  m.state.price.SOL = 110; clock += 86_400_000; await ap.tick();
  check(s.get(dca.id)!.status === "done" && s.get(dca.id)!.state.runs === 2, "done after 2 buys");

  // Failures: limits back off, denial pauses
  const lb = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 5000 }, "owner", false);
  m.state.refuse = { code: "over_daily_limit", reason: "over today's limit" };
  clock += 15_000; await ap.tick();
  check(s.get(lb.id)!.state.failures === 1 && s.get(lb.id)!.status === "active", "over the daily limit: kept, retries later");
  clock += 60_000; await ap.tick();
  check(s.get(lb.id)!.state.failures === 1, "waits an hour before retrying after a limit refusal");
  m.state.refuse = { code: "denied", reason: "You denied this trade." };
  clock += 3600_000; await ap.tick();
  check(s.get(lb.id)!.status === "paused", "owner denies on Telegram/dashboard: rule pauses");
  m.state.refuse = null;

  // Expiry
  const ex = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 1, expires_at: new Date(clock + 60_000).toISOString() }, "owner", false);
  clock += 120_000; await ap.tick();
  check(s.get(ex.id)!.status === "expired", "expired rules stop");

  // Only one autopilot at a time
  const other = new Autopilot(s, m.exec, m.prices, { dir, now: () => clock });
  const before = m.state.swaps.length;
  await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 99999 }, "owner", false);
  await other.tick();
  check(!other.holdsLease && m.state.swaps.length === before, "a second autopilot stands by while the first holds the lease");
  ap.stop(); await other.tick();
  check(other.holdsLease && m.state.swaps.length === before + 1, "it takes over when the first stops");
  check(Autopilot.status(dir, clock).running === true, "status shows the autopilot running");
}

// --- paper trading
{
  const dir = tmp();
  const ETH = KNOWN.base.ETH!, USDC = KNOWN.base.USDC!;
  const fakeWallet: any = {
    policy: { ...DEFAULT_POLICY, per_trade_usd: 50 },
    quote: async (req: SwapRequest) => {
      const buyEth = req.sell_token === USDC.address;
      const usd = buyEth ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e18) * 2500;
      const out = buyEth ? BigInt(Math.floor((usd * 0.995 / 2500) * 1e18)) : BigInt(Math.floor(usd * 0.995 * 1e6));
      return { ok: true, quote: { buy_amount: out.toString(), usd_value: usd, fee_usd: usd * 0.005 } };
    },
  };
  const pb = new PaperBook(fakeWallet, { dir, startUsd: 100 });
  pb.reset(100);
  check(pb.balance("base", USDC) === 100_000_000n, "paper starts with $100 USDC per chain");
  const r = await pb.swap({ chain: "base", sell_token: USDC.address, buy_token: ETH.address, sell_amount: "40000000", slippage_bps: 50 });
  check(r.ok && /^paper-/.test(r.tx!) && pb.balance("base", USDC) === 60_000_000n && pb.balance("base", ETH) > 0n, "paper buy moves pretend balances at the live quote (fee included)", r);
  const big = await pb.swap({ chain: "base", sell_token: USDC.address, buy_token: ETH.address, sell_amount: "55000000", slippage_bps: 50 });
  check(big.refused?.code === "over_per_limit", "paper trades obey the same per-trade limit");
  const broke = await pb.swap({ chain: "solana", sell_token: KNOWN.solana.USDC!.address, buy_token: KNOWN.solana.SOL!.address, sell_amount: "200000000", slippage_bps: 50 });
  check(broke.refused?.code === "insufficient_balance", "can't spend more paper money than you have");
  const sum = pb.summary();
  check(sum.fills === 1 && sum.fees_usd === 0.2 && sum.balances.some((b) => b.token === "ETH"), "paper summary: fills, fees, balances", sum);
}

console.log(`\nautopilot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
