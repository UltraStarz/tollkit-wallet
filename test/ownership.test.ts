/** 0.9.1: Autopilot and the owner's own rules share one wallet but never sell each other's coins. Fake market; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore } from "../src/rules.js";
import { Autopilot, type Executor } from "../src/autopilot.js";
import { KNOWN } from "../src/tokens.js";
import { autopilotUnits, autopilotSpentToday } from "../src/ownership.js";
import type { SwapRequest } from "../src/swap.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "own-"));
const GAS = 50_000_000_000_000n; // the engine keeps this much ETH on Base for gas
const ETH = KNOWN.base.ETH!.address, USDC = KNOWN.base.USDC!.address;

function market() {
  const st = { price: 2500, eth: 10n ** 18n, swaps: [] as SwapRequest[] };
  const quote = async (req: SwapRequest) => {
    const buying = req.sell_token.toLowerCase() === USDC.toLowerCase();
    const usd = buying ? Number(req.sell_amount) / 1e6 : (Number(req.sell_amount) / 1e18) * st.price;
    const out = buying ? BigInt(Math.floor((usd / st.price) * 1e18)) : BigInt(Math.floor(usd * 1e6));
    return { ok: true, quote: { chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token, sell_amount: req.sell_amount, buy_amount: out.toString(), min_buy_amount: out.toString(), fee_bps: 50, venue_fee_bps: 0, usd_value: usd } } as any;
  };
  const exec: Executor = {
    mode: "live", slippageBps: 50, quote,
    swap: async (req) => {
      const q = await quote(req); st.swaps.push(req);
      if (req.buy_token.toLowerCase() === ETH.toLowerCase()) st.eth += BigInt(q.quote.buy_amount); else st.eth -= BigInt(req.sell_amount);
      return { ...q, tx: `0xtx${st.swaps.length}` };
    },
    balance: async (_c, t) => (t.address.toLowerCase() === ETH.toLowerCase() ? st.eth : 10n ** 12n),
  };
  const prices = { snapshot: () => ({ prices: { ETH: { usd: st.price, change_24h: 0 } } }) };
  return { st, exec, prices };
}

{
  const dir = tmp(), m = market(), s = new RuleStore(dir);
  let clock = Date.now(), cap: number | null = null;
  const ap = new Autopilot(s, m.exec, m.prices as any, { dir, now: () => clock, autopilotDailyCap: () => cap });
  const tick = async () => { clock += 15_000; await ap.tick(); };

  // You hold 1 ETH. Autopilot's strategy buys $250 of ETH (0.1 ETH at $2,500).
  const apBuy = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 250, trigger_price: 2600, bot: "apbot1" }, "agent", true, "superbot");
  await tick();
  // Its strategy keeps running (a take-profit waiting), so the coins stay Autopilot's.
  const apTp = await s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 5000, bot: "apbot1" }, "agent", true, "superbot");
  check(s.get(apBuy.id)!.status === "done" && Math.abs(autopilotUnits(s.list(), "base", "ETH", ETH) - 0.1) < 1e-9, "Autopilot's buy is counted as its own 0.1 ETH");

  // Your stop-loss sells "all my ETH": it leaves Autopilot's 0.1 ETH alone.
  const mine = await s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2450 }, "owner", false);
  m.st.price = 2400; await tick();
  const ownerSell = BigInt(m.st.swaps.at(-1)!.sell_amount);
  check(s.get(mine.id)!.status === "done" && ownerSell <= 10n ** 18n - GAS && ownerSell > 10n ** 18n - GAS - 10n ** 7n, "your 'sell all' sells your 1 ETH (minus gas), not Autopilot's 0.1", ownerSell.toString());
  check(m.st.eth >= 10n ** 17n && m.st.eth <= 10n ** 17n + GAS + 10n ** 7n, "Autopilot's 0.1 ETH is still in the wallet", m.st.eth.toString());

  // Autopilot's own stop sells only its 0.1 ETH even after you buy more.
  m.st.eth += 2n * 10n ** 18n; // you deposit 2 ETH
  const apStop = await s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2350, bot: "apbot1" }, "agent", true, "superbot");
  m.st.price = 2300; await tick();
  const apSell = BigInt(m.st.swaps.at(-1)!.sell_amount);
  check(s.get(apStop.id)!.status === "done" && apSell <= 10n ** 17n && apSell > 10n ** 17n - 10n ** 7n, "Autopilot's stop sells only the ETH it bought, not your 2 ETH", apSell.toString());
  check(m.st.eth > 2n * 10n ** 18n - GAS, "your 2 ETH stay put");

  // An Autopilot protect on coins it doesn't hold waits quietly: no swap, no failure.
  await s.setStatus(apTp.id, "cancelled");
  const before = m.st.swaps.length;
  const apProtect = await s.add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2400, bot: "apbot2" }, "agent", true, "superbot");
  await tick();
  const pr = s.get(apProtect.id)!;
  check(m.st.swaps.length === before && pr.status === "active" && pr.state.failures === 0 && /no ETH of its own/.test(pr.state.last_error ?? ""), "Autopilot with nothing of its own to sell waits, without counting a failure", pr.state);

  // Retired strategies hand their coins back: once no rule of the bot is running, nothing counts as Autopilot's.
  const apBuy2 = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 100, trigger_price: 2600, bot: "apbot3" }, "agent", true, "superbot");
  await tick();
  check(s.get(apBuy2.id)!.status === "done" && autopilotUnits(s.list(), "base", "ETH", ETH) === 0, "a finished strategy's coins are yours again");

  // Daily share: Autopilot stops for the day at its cap; your rules don't.
  cap = 120;
  const spent = autopilotSpentToday(s.list(), clock);
  check(Math.abs(spent - 580) < 1, "Autopilot's live trades today are tracked: $250 + $100 buys and its $230 sell", spent);
  const apDca = await s.add({ kind: "dca", chain: "base", token: "ETH", amount_usd: 20, every: "day", bot: "apbot4" }, "agent", true, "superbot");
  const n0 = m.st.swaps.length;
  await tick();
  const d = s.get(apDca.id)!;
  check(m.st.swaps.length === n0 && d.status === "active" && d.state.failures === 0 && !!d.state.hold_until && /share of today's trading limit/.test(d.state.last_error ?? ""), "over its share, Autopilot waits until tomorrow without failing", d.state);
  const myBuy = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 2600 }, "owner", false);
  await tick();
  check(s.get(myBuy.id)!.status === "done", "your own rule still trades");
  clock += 26 * 3600_000; await ap.tick();
  check(s.get(apDca.id)!.state.runs === 1, "Autopilot picks up again the next day", s.get(apDca.id)!.state);

  // Paper rules never count against real coins.
  const liveBefore = autopilotUnits(s.list(), "base", "ETH", ETH, false);
  const paper = await s.add({ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 50, trigger_price: 2600, bot: "apbot5", paper: true }, "agent", true, "superbot");
  await s.mutate((rs) => { const x = rs.find((y) => y.id === paper.id)!; x.state.bought_units = 0.02; });
  await s.add({ kind: "take_profit", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 9000, bot: "apbot5", paper: true }, "agent", true, "superbot");
  check(autopilotUnits(s.list(), "base", "ETH", ETH, false) === liveBefore && Math.abs(autopilotUnits(s.list(), "base", "ETH", ETH, true) - 0.02) < 1e-9, "paper holdings stay on paper");
}

console.log(`\nownership: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
