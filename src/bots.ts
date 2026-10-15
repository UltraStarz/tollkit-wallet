/**
 * Bots: ready-made, rule-based (no AI) trading bots built from the autopilot's rules, a status board for them,
 * and an opt-in, anonymous share of their results for Tollkit's public bot board.
 *
 * A bot is one or more rules made together from a template; they share a bot id. Every trade a bot makes is an
 * ordinary autopilot fill, so the owner's limits, approvals, the 0.5% fee and receipts all apply.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { describeRule, gridLevels, ruleProblem, type Rule, type RuleInput } from "./rules.js";

export interface TemplateField { key: string; label: string; kind: "usd" | "pct" | "int" | "choice"; default: number | string; min?: number; max?: number; choices?: [string, string][] }
export interface Template { id: string; name: string; blurb: string; fields: TemplateField[]; risk: string }

/** Owner-facing catalog. Each builds plain rules the owner can read before turning them on. */
export const TEMPLATES: Template[] = [
  { id: "dca", name: "Steady buyer", blurb: "Buys a fixed dollar amount on a schedule, whatever the price (dollar-cost averaging).", risk: "Keeps buying in a falling market.",
    fields: [{ key: "amount_usd", label: "Dollars each time", kind: "usd", default: 25, min: 1 }, { key: "every", label: "How often", kind: "choice", default: "week", choices: [["day", "Every day"], ["week", "Every week"]] }, { key: "times", label: "How many buys (0 = no end)", kind: "int", default: 0, min: 0, max: 10000 }] },
  { id: "dip", name: "Buy the dip", blurb: "Buys when the price falls a set amount, then sells for a profit if it recovers.", risk: "The price may keep falling after it buys.",
    fields: [{ key: "amount_usd", label: "Dollars to buy", kind: "usd", default: 50, min: 1 }, { key: "drop_pct", label: "Buy after a drop of (%)", kind: "pct", default: 5, min: 0.5, max: 80 }, { key: "profit_pct", label: "Then sell at a gain of (%)", kind: "pct", default: 8, min: 0.5, max: 500 }] },
  { id: "protect", name: "Protect a position", blurb: "Sells what you hold if the price falls too far, or takes the profit if it rises; whichever comes first.", risk: "A quick dip can trigger the stop, then recover.",
    fields: [{ key: "sell_percent", label: "Share of your holding to sell (%)", kind: "pct", default: 100, min: 1, max: 100 }, { key: "stop_pct", label: "Stop if it falls (%)", kind: "pct", default: 10, min: 0.5, max: 90 }, { key: "profit_pct", label: "Take profit if it rises (%)", kind: "pct", default: 20, min: 0.5, max: 1000 }] },
  { id: "trail", name: "Trailing stop", blurb: "Follows the price up and sells if it falls a set amount from its highest point.", risk: "Normal swings can trigger it.",
    fields: [{ key: "sell_percent", label: "Share of your holding to sell (%)", kind: "pct", default: 100, min: 1, max: 100 }, { key: "trail_pct", label: "Sell after a fall from the high of (%)", kind: "pct", default: 10, min: 0.5, max: 90 }] },
  { id: "ladder", name: "Take-profit ladder", blurb: "Sells a quarter at +10%, a quarter at +25% and the rest at +50% (you can change the steps).", risk: "Sells early if the price keeps climbing.",
    fields: [{ key: "step1", label: "First sale at a gain of (%)", kind: "pct", default: 10, min: 1, max: 1000 }, { key: "step2", label: "Second at (%)", kind: "pct", default: 25, min: 1, max: 1000 }, { key: "step3", label: "Last at (%)", kind: "pct", default: 50, min: 1, max: 1000 }] },
  { id: "grid", name: "Grid trader", blurb: "Buys a little at each level as the price falls through a range and sells each one a level higher. Works best when the price moves sideways.", risk: "If the price drops out of the range, it holds what it bought; if it rises out, it stops buying.",
    fields: [{ key: "amount_usd", label: "Dollars per level", kind: "usd", default: 20, min: 1 }, { key: "range_pct", label: "Range around today's price (± %)", kind: "pct", default: 10, min: 1, max: 60 }, { key: "levels", label: "Levels", kind: "int", default: 8, min: 3, max: 40 }] },
];

const round = (n: number) => Number(n.toPrecision(6));

/** The rules a template makes, at today's price. Throws a plain reason for a bad field. */
export function buildBot(templateId: string, token: string, chain: Chain, params: Record<string, unknown>, price: number | undefined): { bot: string; name: string; rules: RuleInput[] } {
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error("Pick a bot.");
  const v: Record<string, number | string> = {};
  for (const f of tpl.fields) {
    const raw = params[f.key] ?? f.default;
    if (f.kind === "choice") { if (!f.choices!.some((c) => c[0] === raw)) throw new Error(`Pick ${f.label.toLowerCase()}.`); v[f.key] = String(raw); continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max) || (f.kind === "int" && !Number.isInteger(n))) throw new Error(`${f.label}: ${f.min !== undefined ? `from ${f.min}` : ""}${f.max !== undefined ? ` to ${f.max}` : ""}.`);
    v[f.key] = n;
  }
  const needsPrice = templateId !== "dca";
  if (needsPrice && !(price && price > 0)) throw new Error("No price for this token right now, so the bot's levels can't be set. Try again in a minute.");
  const bot = randomUUID().slice(0, 8), T = token.length > 12 ? `${token.slice(0, 4)}…` : token.toUpperCase();
  const name = `${tpl.name} · ${T}`;
  const base = { chain, token, bot, bot_name: name, template: tpl.id } as const;
  const n = (k: string) => v[k] as number;
  const p = price!;
  let rules: RuleInput[];
  switch (tpl.id) {
    case "dca": rules = [{ ...base, kind: "dca", amount_usd: n("amount_usd"), every: v.every as "day" | "week", ...(n("times") > 0 ? { times: n("times") } : {}), ...(v.every === "week" ? { weekday: new Date().getUTCDay() } : {}) }]; break;
    case "dip": {
      const buyAt = round(p * (1 - n("drop_pct") / 100));
      // The take-profit waits for the buy, then sells exactly what the bot bought (not the rest of your holding).
      rules = [{ ...base, kind: "limit_buy", amount_usd: n("amount_usd"), trigger_price: buyAt },
        { ...base, kind: "take_profit", sell_from: "@0", after: "@0", trigger_price: round(buyAt * (1 + n("profit_pct") / 100)) }];
      break;
    }
    case "protect": {
      const group = `bot-${bot}`;
      rules = [{ ...base, group, kind: "stop_loss", sell_percent: n("sell_percent"), trigger_price: round(p * (1 - n("stop_pct") / 100)) },
        { ...base, group, kind: "take_profit", sell_percent: n("sell_percent"), trigger_price: round(p * (1 + n("profit_pct") / 100)) }];
      break;
    }
    case "trail": rules = [{ ...base, kind: "trailing_stop", sell_percent: n("sell_percent"), trail_pct: n("trail_pct") }]; break;
    case "ladder": {
      const steps = [n("step1"), n("step2"), n("step3")];
      if (!(steps[0]! < steps[1]! && steps[1]! < steps[2]!)) throw new Error("Each step needs a bigger gain than the one before.");
      // 25% of the holding, then a third of what's left (25% of the start), then all the rest.
      rules = [{ ...base, kind: "take_profit", sell_percent: 25, trigger_price: round(p * (1 + steps[0]! / 100)) },
        { ...base, kind: "take_profit", sell_percent: 33.33, trigger_price: round(p * (1 + steps[1]! / 100)) },
        { ...base, kind: "take_profit", sell_percent: 100, trigger_price: round(p * (1 + steps[2]! / 100)) }];
      break;
    }
    case "grid": rules = [{ ...base, kind: "grid", amount_usd: n("amount_usd"), lower_price: round(p * (1 - n("range_pct") / 100)), upper_price: round(p * (1 + n("range_pct") / 100)), levels: n("levels") }]; break;
    default: throw new Error("Pick a bot.");
  }
  for (const r of rules) { const why = ruleProblem(r); if (why) throw new Error(why); }
  return { bot, name, rules };
}

export interface BotSummary {
  id: string; name: string; template: string | null; chain: Chain; token: string;
  status: "running" | "paused" | "waiting" | "done" | "stopped" | "error";
  rules: { id: string; description: string; status: string; last_error?: string }[];
  trades_ok: number; trades_failed: number; success_rate: number | null;
  spent_usd: number; received_usd: number; units_held: number; value_now_usd: number | null;
  /** received + value now − spent, when the bot bought something. */
  result_usd: number | null; result_pct: number | null;
  round_trips: number; last_trade: string | null; last_price: number | null; started: string;
}

/** Status board: rules grouped into bots (a rule made by hand is a bot of one). */
export function summarize(rules: Rule[]): BotSummary[] {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) { if (r.status === "proposed") continue; const k = r.bot ?? `rule-${r.id}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const out: BotSummary[] = [];
  for (const [id, rs] of groups) {
    const s = (f: (r: Rule) => number | undefined) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
    const ok = s((r) => r.state.ok_count ?? r.state.fills.filter((x) => x.ok).length), bad = s((r) => r.state.fail_count ?? r.state.fills.filter((x) => !x.ok).length);
    const spent = s((r) => r.state.spent_usd), got = s((r) => r.state.received_usd);
    const held = Math.max(0, s((r) => r.state.bought_units) - s((r) => r.state.sold_units));
    const price = rs.map((r) => r.state.last_price).find((x) => typeof x === "number") ?? null;
    const value = price !== null ? held * price : null;
    const st = rs.map((r) => r.status);
    const status = st.some((x) => x === "error") ? "error" : st.some((x) => x === "active") ? (ok > 0 || rs.some((r) => r.kind === "grid" || r.kind === "dca") ? "running" : "waiting") : st.some((x) => x === "paused") ? "paused" : st.every((x) => x === "done" || (x === "cancelled" && st.includes("done"))) ? "done" : "stopped";
    const last = rs.flatMap((r) => r.state.fills.filter((x) => x.ok).map((x) => x.ts)).sort().at(-1) ?? null;
    const result = spent > 0 && value !== null ? got + value - spent : spent > 0 && held === 0 ? got - spent : null;
    out.push({
      id, name: rs[0]!.bot_name ?? describeRule(rs[0]!), template: rs[0]!.template ?? null, chain: rs[0]!.chain, token: rs[0]!.token, status,
      rules: rs.map((r) => ({ id: r.id, description: describeRule(r), status: r.status, ...(r.state.last_error ? { last_error: r.state.last_error } : {}) })),
      trades_ok: ok, trades_failed: bad, success_rate: ok + bad ? Math.round((ok / (ok + bad)) * 1000) / 10 : null,
      spent_usd: Math.round(spent * 100) / 100, received_usd: Math.round(got * 100) / 100, units_held: held, value_now_usd: value === null ? null : Math.round(value * 100) / 100,
      result_usd: result === null ? null : Math.round(result * 100) / 100, result_pct: result === null ? null : Math.round((result / spent) * 1000) / 10,
      round_trips: s((r) => r.state.round_trips), last_trade: last, last_price: price, started: rs.map((r) => r.created_at).sort()[0]!,
    });
  }
  const order = { running: 0, waiting: 1, error: 2, paused: 3, done: 4, stopped: 5 } as const;
  return out.sort((a, b) => order[a.status] - order[b.status] || b.started.localeCompare(a.started));
}

/** Grid levels for showing a grid bot's range. */
export { gridLevels };

// ---- Opt-in sharing with Tollkit's public bot board ------------------------------------------------------------
interface ShareFile { share: boolean; install: string; last_sent?: string }
const shareFile = (dir?: string) => path.join(walletHome(dir), "bots.json");
export function shareSettings(dir?: string): ShareFile {
  try { if (existsSync(shareFile(dir))) { const j = JSON.parse(readFileSync(shareFile(dir), "utf8")); if (typeof j.install === "string") return j; } } catch { /* new */ }
  return { share: false, install: randomUUID() };
}
export function setShare(on: boolean, dir?: string): ShareFile {
  const f = { ...shareSettings(dir), share: on };
  writeFileSync(shareFile(dir), JSON.stringify(f, null, 2), { mode: 0o600 });
  return f;
}

/**
 * What is shared, when the owner turns it on: per bot, the template, chain and token symbol (only for the
 * built-in or listed tokens), trade counts, success rate, result %, round trips and days running. A random
 * id for this install lets Tollkit replace earlier reports instead of counting them twice. No addresses,
 * amounts in dollars, transaction ids or keys.
 */
export function shareReport(bots: BotSummary[], install: string, symbolOf: (chain: Chain, token: string) => string | null, now = Date.now()) {
  return {
    install,
    bots: bots.filter((b) => b.template && b.trades_ok + b.trades_failed > 0).slice(0, 50).map((b) => ({
      bot: b.id, template: b.template, chain: b.chain, token: symbolOf(b.chain, b.token), status: b.status,
      trades_ok: b.trades_ok, trades_failed: b.trades_failed, result_pct: b.result_pct, round_trips: b.round_trips,
      days: Math.max(0, Math.round((now - Date.parse(b.started)) / 86_400_000)),
    })),
  };
}

/** Sends the report at most once a day. */
export async function maybeShare(dir: string | undefined, bots: BotSummary[], symbolOf: (chain: Chain, token: string) => string | null, o: { fetch?: typeof fetch; proxy: string; now?: number }): Promise<boolean> {
  const s = shareSettings(dir), now = o.now ?? Date.now();
  if (!s.share) return false;
  if (s.last_sent && now - Date.parse(s.last_sent) < 23 * 3600_000) return false;
  const body = shareReport(bots, s.install, symbolOf, now);
  if (!body.bots.length) return false;
  const r = await (o.fetch ?? fetch)(`${o.proxy}/bots/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return false;
  writeFileSync(shareFile(dir), JSON.stringify({ ...s, last_sent: new Date(now).toISOString() }, null, 2), { mode: 0o600 });
  return true;
}
