/**
 * A weekly dollar allowance per AI app ("Claude gets $5 a week, ChatGPT $2"). Every trade or payment an app asks
 * for, and every fill of a bot that app started, counts against it; the week starts Monday 00:00 UTC. The owner
 * sets budgets in the wallet (AI tab); an app can only ask for a change through a setup request. The owner's
 * limits in policy.json still apply on top: a budget never raises them.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { walletHome } from "./paths.js";
import { entries } from "./ledger.js";

export interface AppBudget { app: string; weekly_usd: number }
export interface AppBudgetView extends AppBudget { spent_usd: number; left_usd: number; week_start: string }

const fileOf = (dir?: string) => path.join(walletHome(dir), "app-budgets.json");

export function readBudgets(dir?: string): AppBudget[] {
  try {
    const f = fileOf(dir);
    if (!existsSync(f)) return [];
    const v = JSON.parse(readFileSync(f, "utf8"));
    return (Array.isArray(v) ? v : []).filter((x: any) => x && typeof x.app === "string" && typeof x.weekly_usd === "number" && x.weekly_usd > 0);
  } catch { return []; }
}

/** `weekly_usd` null removes the budget (the app is then limited only by the owner's limits). */
export function setBudget(dir: string | undefined, app: string, weekly_usd: number | null): AppBudget[] {
  const name = app.trim();
  if (!name || name.length > 40) throw new Error("Name the AI app.");
  if (weekly_usd !== null && !(Number.isFinite(weekly_usd) && weekly_usd > 0 && weekly_usd <= 1_000_000)) throw new Error("Pick a weekly amount over $0.");
  const list = readBudgets(dir).filter((b) => b.app !== name);
  if (weekly_usd !== null) list.push({ app: name, weekly_usd: Math.round(weekly_usd * 100) / 100 });
  if (list.length > 50) throw new Error("That's enough budgets.");
  const f = fileOf(dir), t = `${f}.${process.pid}.tmp`;
  writeFileSync(t, JSON.stringify(list, null, 2), { mode: 0o600 });
  renameSync(t, f);
  return list;
}

/** Monday 00:00 UTC of the week that holds `now`. */
export function weekStart(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/** Dollars an app has spent (or reserved) this week: its own trades and payments, and its bots' fills. */
export function spentThisWeek(dir: string | undefined, app: string, now = new Date()): number {
  const since = weekStart(now).toISOString();
  return entries(dir).filter((e) => e.by === app && e.status !== "failed" && e.ts >= since).reduce((s, e) => s + e.usd, 0);
}

export function budgetView(dir?: string, now = new Date()): AppBudgetView[] {
  const ws = weekStart(now).toISOString();
  return readBudgets(dir).map((b) => { const spent = spentThisWeek(dir, b.app, now); return { ...b, spent_usd: +spent.toFixed(4), left_usd: +Math.max(0, b.weekly_usd - spent).toFixed(4), week_start: ws }; });
}

/** Why `app` may not spend `usd` more this week, or null if it may. Apps without a budget are not limited here. */
export function budgetProblem(dir: string | undefined, app: string | undefined, usd: number, now = new Date()): string | null {
  if (!app) return null;
  const b = readBudgets(dir).find((x) => x.app === app);
  if (!b) return null;
  const spent = spentThisWeek(dir, app, now);
  if (spent + usd > b.weekly_usd + 1e-9) {
    const left = Math.max(0, b.weekly_usd - spent);
    return `${app}'s weekly budget is $${b.weekly_usd} and $${spent.toFixed(2)} is used, so $${left.toFixed(2)} is left this week. The owner can raise it in the wallet.`;
  }
  return null;
}
