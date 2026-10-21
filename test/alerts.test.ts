/** 0.9.1: alert rules notify and never trade; RSI and the 50-hour average. Fake prices; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleStore, describeRule, ruleProblem } from "../src/rules.js";
import { Autopilot, type Executor, type AutopilotEvent } from "../src/autopilot.js";
import { rsi, sma, checkAlert } from "../src/indicators.js";
import { buildBot } from "../src/bots.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "alr-"));

// --- indicator math
{
  // Wilder's example series (New Concepts in Technical Trading Systems, 1978), as reproduced in most RSI references:
  // 15 closes give a first RSI of about 70.5.
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const v = rsi(c)!;
  check(Math.abs(v - 70.46) < 0.1, "RSI(14) matches the textbook example (~70.5)", v);
  check(rsi(c.slice(0, 10)) === null, "RSI needs 15 closes");
  check(rsi(Array(20).fill(5)) === 50 && rsi(Array.from({ length: 20 }, (_, i) => i + 1)) === 100, "flat prices give 50, only rises give 100");
  check(sma([1, 2, 3, 4], 4) === 2.5 && sma([1, 2], 4) === null, "simple average");
}

// --- validation and wording
{
  check(ruleProblem({ kind: "alert", chain: "base", token: "ETH" }) !== null, "an alert needs what to watch");
  check(ruleProblem({ kind: "alert", chain: "base", token: "ETH", alert: "above" }) !== null, "a price alert needs a price");
  check(ruleProblem({ kind: "alert", chain: "base", token: "ETH", alert: "above", trigger_price: 4000, amount_usd: 10 }) !== null, "alerts take no amounts");
  check(ruleProblem({ kind: "alert", chain: "base", token: "ETH", alert: "rsi_high" }) === null, "RSI alert defaults to 70");
  check(describeRule({ kind: "alert", chain: "solana", token: "SOL", alert: "move", alert_value: 5 }) === "Alert me when SOL moves 5% or more in a day on Solana", "plain wording", describeRule({ kind: "alert", chain: "solana", token: "SOL", alert: "move", alert_value: 5 }));
  const b = buildBot("alert", "ETH", "base", { condition: "below", pct: 10 }, 3000);
  check(b.rules.length === 1 && b.rules[0]!.kind === "alert" && b.rules[0]!.alert === "below" && b.rules[0]!.trigger_price === 2700, "the Alert template builds a price alert 10% under today's price", b.rules);
  const m = checkAlert({ alert: "ma_up" }, 110, Array(50).fill(100));
  check(m.hit && /above/.test(m.now), "price over its 50-hour average reads as above", m);
}

// --- the engine: notify once, re-arm, never trade
{
  const dir = tmp(), s = new RuleStore(dir);
  let price = 3500, clock = Date.now(), swaps = 0, hourly: number[] = Array(80).fill(3500);
  const exec: Executor = { mode: "live", slippageBps: 50, quote: async () => ({ ok: false }) as any, swap: async () => { swaps++; return { ok: true } as any; }, balance: async () => 10n ** 18n };
  const prices = { snapshot: () => ({ prices: { ETH: { usd: price, change_24h: 0 } } }) };
  const events: AutopilotEvent[] = [];
  const ap = new Autopilot(s, exec, prices as any, { dir, now: () => clock, hourly: async () => hourly, onEvent: (e) => events.push(e) });
  const tick = async (mins = 1) => { clock += mins * 60_000; await ap.tick(); };

  const up = await s.add({ kind: "alert", chain: "base", token: "ETH", alert: "above", trigger_price: 3800 }, "owner", false);
  await tick();
  check(events.length === 0 && s.get(up.id)!.status === "active", "below the line: quiet");
  price = 3810; await tick();
  check(events.length === 1 && events[0]!.type === "alert" && /above your \$3,800/.test(events[0]!.detail), "crossing $3,800 notifies", events[0]?.detail);
  check(s.get(up.id)!.status === "active" && s.get(up.id)!.state.alert_count === 1, "the alert stays on after firing");
  price = 3850; await tick(90);
  check(events.length === 1, "staying above doesn't notify again");
  price = 3700; await tick(90); price = 3820; await tick(90);
  check(events.length === 2, "after falling back under and crossing again, it notifies again");
  price = 3700; await tick(5); price = 3820; await tick(5);
  check(events.length === 2, "never more than once an hour");

  // crossing its 50-hour average: set while already above, it waits for a real cross
  hourly = Array(80).fill(3000); price = 3100;
  const ma = await s.add({ kind: "alert", chain: "base", token: "ETH", alert: "ma_up" }, "owner", false);
  const n0 = events.length;
  await tick();
  check(events.length === n0 && /above its 50h average/.test(s.get(ma.id)!.state.alert_now ?? ""), "already above its average when set: no alert yet", s.get(ma.id)!.state);
  price = 2900; await tick(); price = 3050; await tick();
  check(events.length === n0 + 1 && /crossed above its 50-hour average/.test(events.at(-1)!.detail), "a real cross up notifies", events.at(-1)?.detail);

  // RSI from hourly closes
  hourly = Array.from({ length: 80 }, (_, i) => 3000 + i * 10); price = 3800;
  const hot = await s.add({ kind: "alert", chain: "base", token: "ETH", alert: "rsi_high" }, "owner", false);
  await tick();
  check(events.at(-1)!.rule.id === hot.id && /overbought/.test(events.at(-1)!.detail), "a steady climb reads overbought", events.at(-1)?.detail);
  check(swaps === 0, "no alert ever traded");
}

console.log(`\nalerts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
