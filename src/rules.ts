/**
 * Autopilot rules: limit buys and sells, stop-loss, take-profit, trailing
 * stops and recurring buys (DCA). Every rule is a plain, pre-set instruction
 * the owner can read; the autopilot follows it and nothing else.
 *
 * Who turns a rule on:
 *   - rules the owner creates (CLI with the password, or the dashboard) start active;
 *   - rules an agent proposes start as "proposed" and wait for the owner to turn
 *     them on, unless the owner set policy.agent_rules = "auto".
 * Every fill still goes through the wallet's limits, approvals and receipts.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";

export const RULE_KINDS = ["limit_buy", "limit_sell", "stop_loss", "take_profit", "trailing_stop", "dca"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const BUY_KINDS: RuleKind[] = ["limit_buy", "dca"];
export type RuleStatus = "proposed" | "active" | "paused" | "done" | "cancelled" | "expired" | "error";

/** What an owner or agent asks for. */
export const RuleInput = z.object({
  kind: z.enum(RULE_KINDS),
  chain: z.enum(["base", "ethereum", "solana"]),
  token: z.string().min(2).describe("The asset traded: ETH, WETH, SOL or a token address/mint"),
  name: z.string().max(60).optional(),
  /** Buys: dollars of USDC to spend each time. */
  amount_usd: z.number().positive().max(1_000_000).optional(),
  /** Sells: share of the current balance (1-100) or a fixed amount in normal units. */
  sell_percent: z.number().positive().max(100).optional(),
  sell_amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  /** USD price per token that triggers the rule. */
  trigger_price: z.number().positive().optional(),
  /** Trailing stop: sell when the price falls this % from the highest price seen. */
  trail_pct: z.number().min(0.5).max(90).optional(),
  /** DCA schedule. */
  every: z.enum(["hour", "day", "week"]).optional(),
  weekday: z.number().int().min(0).max(6).optional().describe("DCA weekly: 0=Sunday … 6=Saturday"),
  times: z.number().int().min(1).max(10_000).optional().describe("DCA: how many buys, then stop"),
  max_price: z.number().positive().optional().describe("DCA: skip a buy while the price is above this"),
  /** Rules sharing a group cancel each other when one fills (take-profit + stop-loss). */
  group: z.string().max(40).optional(),
  expires_at: z.string().datetime().optional(),
});
export type RuleInput = z.infer<typeof RuleInput>;

export interface Fill { ts: string; ok: boolean; usd?: number; tx?: string; paper?: boolean; reason?: string }
export interface Rule extends RuleInput {
  id: string;
  status: RuleStatus;
  created_by: "owner" | "agent";
  created_at: string;
  activated_at?: string;
  state: {
    high?: number;        // trailing stop: highest price seen while active
    runs: number;         // fills so far
    failures: number;     // consecutive failed attempts
    next_run?: string;    // DCA, or retry-after for a failed attempt
    last_price?: number;
    last_checked?: string;
    last_error?: string;
    fills: Fill[];
  };
}

/** Plain-language summary, shown to the owner before a rule is turned on. */
export function describeRule(r: RuleInput): string {
  const t = r.token.length > 12 ? `${r.token.slice(0, 6)}…${r.token.slice(-4)}` : r.token.toUpperCase();
  const $ = (n?: number) => (n === undefined ? "?" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`);
  const sell = r.sell_percent !== undefined ? (r.sell_percent >= 100 ? `all ${t}` : `${r.sell_percent}% of ${t}`) : `${r.sell_amount ?? "?"} ${t}`;
  const on = ` on ${r.chain[0]!.toUpperCase()}${r.chain.slice(1)}`;
  switch (r.kind) {
    case "limit_buy": return `Buy ${$(r.amount_usd)} of ${t} when it's at or below ${$(r.trigger_price)}${on}`;
    case "limit_sell": return `Sell ${sell} when it's at or above ${$(r.trigger_price)}${on}`;
    case "take_profit": return `Take profit: sell ${sell} when it reaches ${$(r.trigger_price)}${on}`;
    case "stop_loss": return `Stop-loss: sell ${sell} if it falls to ${$(r.trigger_price)}${on}`;
    case "trailing_stop": return `Trailing stop: sell ${sell} if it falls ${r.trail_pct}% from its highest price${on}`;
    case "dca": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const when = r.every === "week" && r.weekday !== undefined ? `every ${days[r.weekday]}` : `every ${r.every ?? "?"}`;
      return `Buy ${$(r.amount_usd)} of ${t} ${when}${r.times ? `, ${r.times} times` : ""}${r.max_price ? ` (skip while above ${$(r.max_price)})` : ""}${on}`;
    }
  }
}

/** Checks that the fields a kind needs are there. Returns a reason, or null. */
export function ruleProblem(r: RuleInput): string | null {
  const isBuy = BUY_KINDS.includes(r.kind);
  if (isBuy && !r.amount_usd) return "A buy needs amount_usd (dollars to spend).";
  if (!isBuy && r.sell_percent === undefined && r.sell_amount === undefined) return "A sell needs sell_percent or sell_amount.";
  if (!isBuy && r.sell_percent !== undefined && r.sell_amount !== undefined) return "Use sell_percent or sell_amount, not both.";
  if (["limit_buy", "limit_sell", "stop_loss", "take_profit"].includes(r.kind) && !r.trigger_price) return `A ${r.kind.replace("_", " ")} needs trigger_price.`;
  if (r.kind === "trailing_stop" && !r.trail_pct) return "A trailing stop needs trail_pct.";
  if (r.kind === "dca" && !r.every) return "A recurring buy needs every (hour, day or week).";
  if (r.kind !== "dca" && (r.every || r.times)) return "Only recurring buys (dca) take every/times.";
  if (/^(USDC|USDT)$/i.test(r.token)) return "Rules trade an asset against USDC; the token can't be a stablecoin.";
  if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) return "expires_at is in the past.";
  return null;
}

const INTERVAL_MS = { hour: 3600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;

/** When a DCA rule should next buy, from a given time. */
export function nextRun(r: Pick<RuleInput, "every" | "weekday">, from: Date): Date {
  if (r.every === "week" && r.weekday !== undefined) {
    const d = new Date(from);
    const add = (r.weekday - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + add);
    d.setUTCHours(14, 0, 0, 0); // 14:00 UTC (10:00 New York)
    return d;
  }
  return new Date(from.getTime() + INTERVAL_MS[r.every ?? "day"]);
}

export class RuleStore {
  readonly file: string;
  constructor(private readonly dir?: string) { this.file = path.join(walletHome(dir), "rules.json"); }

  list(): Rule[] {
    if (!existsSync(this.file)) return [];
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Rule[]; } catch { return []; }
  }
  get(id: string): Rule | undefined { return this.list().find((r) => r.id === id); }

  private write(rules: Rule[]) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rules, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Read-modify-write under the wallet lock, so the dashboard, CLI and autopilot never clobber each other. */
  async mutate<T>(fn: (rules: Rule[]) => T): Promise<T> {
    return withLock(() => { const rules = this.list(); const out = fn(rules); this.write(rules); return out; }, this.dir);
  }

  async add(input: RuleInput, by: "owner" | "agent", autoActivate: boolean): Promise<Rule> {
    const parsed = RuleInput.parse(input);
    const why = ruleProblem(parsed);
    if (why) throw new Error(why);
    const now = new Date();
    const active = by === "owner" || autoActivate;
    const rule: Rule = {
      ...parsed, id: randomUUID().slice(0, 8), created_by: by, created_at: now.toISOString(),
      status: active ? "active" : "proposed", ...(active ? { activated_at: now.toISOString() } : {}),
      state: { runs: 0, failures: 0, fills: [], ...(parsed.kind === "dca" ? { next_run: (parsed.every === "week" && parsed.weekday !== undefined ? nextRun(parsed, now) : now).toISOString() } : {}) },
    };
    await this.mutate((rules) => { rules.push(rule); });
    return rule;
  }

  /** Owner actions. Turning a rule on resets the trailing high and failure count. */
  async setStatus(id: string, status: "active" | "paused" | "cancelled"): Promise<Rule> {
    return this.mutate((rules) => {
      const r = rules.find((x) => x.id === id);
      if (!r) throw new Error(`No rule ${id}.`);
      if (["done", "cancelled", "expired"].includes(r.status)) throw new Error(`Rule ${id} is ${r.status}; make a new one instead.`);
      r.status = status;
      if (status === "active") {
        r.activated_at = new Date().toISOString();
        r.state.high = undefined; r.state.failures = 0; r.state.last_error = undefined;
        if (r.kind !== "dca") r.state.next_run = undefined;
        else if (!r.state.next_run || Date.parse(r.state.next_run) < Date.now()) r.state.next_run = new Date().toISOString();
      }
      return { ...r };
    });
  }
}
