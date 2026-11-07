/**
 * Setup requests: changes an AI app prepares that only the owner can make. The app fills in the form; the owner
 * sees a card on the Approvals screen ("Claude wants to raise the per-swap limit to $100"), reads it, and taps
 * Apply, typing the password where the wallet always asks for it. Nothing here changes a limit, moves money or
 * connects an app by itself: a request is a filled-in form waiting for the owner's hand.
 *
 * Requests live in <wallet>/setups.json, expire after a day, and are kept (applied or dismissed) for a week so
 * the app can see what happened to them.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CHAIN_ENUM, chainName } from "./chains.js";
import { walletHome } from "./paths.js";
import { withLock } from "./ledger.js";

const usd = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;
const Addr = z.string().min(32).max(64);

/** What an app may ask the owner to do. Each kind maps to one existing owner action in the dashboard. */
export const SetupKinds = {
  limits: z.object({
    per_trade_usd: z.number().positive().optional(), daily_trades_usd: z.number().positive().optional(),
    per_payment_usd: z.number().positive().optional(), daily_payments_usd: z.number().positive().optional(),
    per_seller_daily_usd: z.number().positive().optional(), approval_above_usd: z.number().nonnegative().optional(),
    max_slippage_bps: z.number().int().min(1).max(1000).optional(),
    chains: z.array(z.enum(CHAIN_ENUM)).min(1).optional(), block_seller_warnings: z.boolean().optional(),
    agent_rules: z.enum(["propose", "auto"]).optional(),
  }).strict(),
  withdraw_address: z.object({ action: z.enum(["add", "remove"]), chain: z.enum(CHAIN_ENUM), address: Addr, label: z.string().max(40).optional() }).strict(),
  withdraw: z.object({ chain: z.enum(CHAIN_ENUM), token: z.string().min(2).max(64), to: Addr, amount: z.string().regex(/^\d+(\.\d+)?$/) }).strict(),
  move: z.object({ asset: z.enum(["USDC", "ETH"]), from: z.enum(CHAIN_ENUM), to: z.enum(CHAIN_ENUM), amount: z.string().regex(/^\d+(\.\d+)?$/) }).strict(),
  cash_out: z.object({ chain: z.enum(CHAIN_ENUM), asset: z.enum(["USDC", "ETH", "SOL"]), amount: z.string().regex(/^\d+(\.\d+)?$/) }).strict(),
  connect_app: z.object({ app: z.enum(["claude", "claude-code", "cursor", "vscode", "codex", "gemini"]) }).strict(),
  app_budget: z.object({ app: z.string().min(1).max(40), weekly_usd: z.number().positive().max(1_000_000).nullable() }).strict(),
  always_budget: z.object({ budget_usd: z.number().min(1).max(100_000) }).strict(),
  // 0.9.13: the AI chat steers Autopilot through the owner: a strategy for Autopilot to run, or a change to its settings.
  autopilot_strategy: z.object({ template: z.string().min(2).max(20), chain: z.enum(CHAIN_ENUM), token: z.string().min(2).max(64), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() }).strict(),
  autopilot_settings: z.object({
    budget_usd: z.number().min(10).max(100_000).optional(), per_trade_usd: z.number().min(1).max(100_000).optional(), max_strategies: z.number().int().min(1).max(10).optional(),
    max_token_pct: z.number().min(5).max(100).optional(), daily_loss_pct: z.number().min(1).max(50).optional(), weekly_loss_pct: z.number().min(1).max(90).optional(),
    pace: z.enum(["steady", "active", "max", "adaptive"]).optional(), active_mode: z.boolean().optional(), always_on: z.boolean().optional(),
    tokens: z.array(z.object({ chain: z.enum(CHAIN_ENUM), token: z.string().min(2).max(64) })).min(1).max(12).optional(),
    // Nov 5: Big moves.
    moves: z.object({ on: z.boolean().optional(), own: z.boolean().optional(), share_pct: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).optional(), trail_pct: z.union([z.literal(2), z.literal(3), z.literal(5), z.literal(8)]).optional() }).strict().optional(),
  }).strict(),
  // Nov 5: the AI asks the owner to act on Autopilot itself: stop or put live one strategy, turn Autopilot on or off,
  // or resume it after a loss stop. Nothing happens until the owner taps Apply.
  autopilot_action: z.object({ action: z.enum(["stop_strategy", "go_live", "turn_on", "turn_off", "resume", "set_sizing"]), strategy_id: z.string().min(2).max(40).optional(), sizing: z.enum(["fixed", "compound"]).optional() }).strict(),
} as const;
export type SetupKind = keyof typeof SetupKinds;
export const SETUP_KIND_NAMES = Object.keys(SetupKinds) as SetupKind[];

export type SetupStatus = "waiting" | "applied" | "dismissed" | "expired";
export interface SetupRequest {
  id: string; kind: SetupKind; params: Record<string, unknown>; reason: string;
  /** The AI app that asked (src/aiuse.ts name). */
  by: string;
  created: string; expires: string; status: SetupStatus;
  /** What applying it did, or why it failed, for the app to read. */
  note?: string;
}

const LIMIT_LABELS: Record<string, string> = {
  per_trade_usd: "per-swap limit", daily_trades_usd: "daily swap limit", per_payment_usd: "per-payment limit", daily_payments_usd: "daily payment limit",
  per_seller_daily_usd: "per-seller daily limit", approval_above_usd: "ask-me-above amount", max_slippage_bps: "max slippage (bps)",
};

/** Plain English for the card, e.g. "Raise the per-swap limit to $100 and the daily swap limit to $500." */
const SZ: Record<string, string> = { fixed: "the same size every trade", compound: "adding its profits to the next trade (Add profits)", step_up: "25% bigger after each win, back to the start after a loss (Bet bigger on wins)" };
export function describeSetup(kind: SetupKind, p: Record<string, any>): string {
  switch (kind) {
    case "limits": {
      const parts: string[] = [];
      for (const [k, label] of Object.entries(LIMIT_LABELS)) if (p[k] !== undefined) parts.push(`set the ${label} to ${k === "max_slippage_bps" ? p[k] : usd(p[k])}`);
      if (p.chains) parts.push(`turn on ${p.chains.map(chainName).join(", ")} only`);
      if (p.block_seller_warnings !== undefined) parts.push(p.block_seller_warnings ? "block sellers with warnings" : "allow sellers with warnings");
      if (p.agent_rules) parts.push(p.agent_rules === "auto" ? "let AI apps turn rules on without asking" : "make AI apps wait for your OK on each rule");
      return parts.length ? cap(parts.join(", ")) + "." : "Change your limits.";
    }
    case "withdraw_address": return p.action === "add" ? `Save ${p.label ? `"${p.label}" ` : ""}${p.address} as a withdrawal address on ${chainName(p.chain)}.` : `Remove the withdrawal address ${p.address} on ${chainName(p.chain)}.`;
    case "withdraw": return `Withdraw ${p.amount} ${p.token} on ${chainName(p.chain)} to ${p.to}.`;
    case "move": return `Move ${p.amount} ${p.asset} from ${chainName(p.from)} to ${chainName(p.to)}.`;
    case "cash_out": return `Cash out ${p.amount} ${p.asset} on ${chainName(p.chain)} to your bank through Coinbase.`;
    case "connect_app": return `Connect ${p.app} to this wallet.`;
    case "app_budget": return p.weekly_usd === null ? `Remove ${p.app}'s weekly budget.` : `Give ${p.app} a weekly budget of ${usd(p.weekly_usd)}.`;
    case "always_budget": return `Let Tollkit's server spend up to ${usd(p.budget_usd)} of USDC in total for rules that keep running when the app is closed.`;
    case "autopilot_strategy": {
      // Nov 7: the card says exactly what will run: the amount and how it sizes, so nothing different can slip through.
      const amt = p.params?.amount_usd !== undefined ? ` with ${usd(Number(p.params.amount_usd))} a trade` : "";
      const sz = p.params?.sizing && SZ[p.params.sizing] ? `, ${SZ[p.params.sizing]}` : "";
      return `Have Autopilot run ${TPL[p.template] ? `a ${TPL[p.template]} bot` : `a ${String(p.template).replace(/_/g, " ")}`} on ${String(p.token).length > 12 ? "this coin" : p.token} (${chainName(p.chain)})${amt}${sz}. It starts on paper and waits for your Go live; Autopilot keeps your settings.`;
    }
    case "autopilot_action": return p.action === "set_sizing" ? `Set the Autopilot strategy ${p.strategy_id}'s trade size to ${SZ[p.sizing] ?? p.sizing}.` : p.action === "stop_strategy" ? `Stop the Autopilot strategy ${p.strategy_id} for good.` : p.action === "go_live" ? `Put the Autopilot strategy ${p.strategy_id} live with real money.` : p.action === "turn_on" ? "Turn Autopilot on." : p.action === "turn_off" ? "Turn Autopilot off (every strategy stops)." : "Resume Autopilot after its loss stop.";
    case "autopilot_settings": {
      const parts: string[] = [], L: Record<string, string> = { budget_usd: "budget", per_trade_usd: "most per trade", max_token_pct: "most in one token", daily_loss_pct: "daily loss stop", weekly_loss_pct: "weekly loss stop" };
      for (const [k, l] of Object.entries(L)) if (p[k] !== undefined) parts.push(`set Autopilot's ${l} to ${k.endsWith("_pct") ? p[k] + "%" : usd(p[k])}`);
      if (p.max_strategies !== undefined) parts.push(`let it run up to ${p.max_strategies} strategies`);
      if (p.pace) parts.push(`set its pace to ${p.pace}`);
      if (p.active_mode !== undefined) parts.push(p.active_mode ? "let strategies that pass on paper go live by themselves" : "wait for your Go live on each strategy");
      if (p.always_on !== undefined) parts.push(p.always_on ? "keep it running 24/7" : "stop it while your devices are off");
      if (p.tokens) parts.push(`trade only ${p.tokens.map((t: any) => t.token.length > 12 ? "a coin" : t.token).join(", ")}`);
      if (p.moves) { const m = p.moves; if (m.on === false) parts.push("turn off Big moves"); else { if (m.on) parts.push("turn on Big moves"); if (m.share_pct) parts.push(`protect ${m.share_pct}% of a strategy's coins on big moves`); if (m.trail_pct) parts.push(`use a ${m.trail_pct}% trailing stop on big moves`); if (m.own !== undefined) parts.push(m.own ? "guard your own bots on big moves too" : "leave your own bots alone on big moves"); } }
      return parts.length ? cap(parts.join(", ")) + "." : "Change Autopilot's settings.";
    }
  }
}
const TPL: Record<string, string> = { dip: "Buy the dip", grid: "Grid trader", dca: "Steady buyer", signal: "Trade on a signal", protect: "Protect a position", trail: "Trailing stop", ladder: "Take-profit ladder", smart_dca: "Smart DCA", rebalance: "Rebalancer", infinity_grid: "Infinity grid" };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** True for the kinds the dashboard asks the password for before applying. */
export const needsPassword = (k: SetupKind) => !["app_budget", "cash_out", "always_budget", "autopilot_strategy", "autopilot_settings", "autopilot_action"].includes(k);

const DAY = 24 * 3600_000, KEEP = 7 * DAY, MAX_WAITING = 20;
const fileOf = (dir?: string) => path.join(walletHome(dir), "setups.json");

export class Setups {
  constructor(private readonly dir?: string, private readonly now: () => Date = () => new Date()) {}
  private read(): SetupRequest[] {
    try { const f = fileOf(this.dir); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []; } catch { return []; }
  }
  private write(list: SetupRequest[]) {
    const f = fileOf(this.dir), t = `${f}.${process.pid}.tmp`;
    writeFileSync(t, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(t, f);
  }
  /** Marks expiry and drops old finished requests. */
  private tidy(list: SetupRequest[]): SetupRequest[] {
    const t = this.now().getTime();
    for (const r of list) if (r.status === "waiting" && Date.parse(r.expires) <= t) r.status = "expired";
    return list.filter((r) => r.status === "waiting" || t - Date.parse(r.created) < KEEP);
  }
  list(): SetupRequest[] { return this.tidy(this.read()); }
  waiting(): SetupRequest[] { return this.list().filter((r) => r.status === "waiting"); }
  get(id: string): SetupRequest | undefined { return this.list().find((r) => r.id === id); }

  /** Validates the form and queues it for the owner. Throws a plain reason for a bad form. */
  async add(kind: SetupKind, params: unknown, reason: string, by: string): Promise<SetupRequest> {
    const schema = SetupKinds[kind];
    if (!schema) throw new Error("Unknown setup kind.");
    const parsed = schema.safeParse(params ?? {});
    if (!parsed.success) throw new Error("The form is incomplete: " + parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
    if (kind === "limits" && !Object.keys(parsed.data).length) throw new Error("Say which limit to change.");
    const t = this.now();
    const r: SetupRequest = {
      id: randomBytes(6).toString("hex"), kind, params: parsed.data as Record<string, unknown>, reason: String(reason ?? "").slice(0, 300), by,
      created: t.toISOString(), expires: new Date(t.getTime() + DAY).toISOString(), status: "waiting",
    };
    await withLock(() => {
      const list = this.tidy(this.read());
      if (list.filter((x) => x.status === "waiting").length >= MAX_WAITING) throw new Error("There are already 20 requests waiting for the owner. Wait for those first.");
      list.push(r); this.write(list);
    }, this.dir);
    return r;
  }

  /** The owner applied or dismissed it, or the app withdrew it. Returns the updated request, or null if it wasn't waiting. */
  async finish(id: string, status: "applied" | "dismissed", note?: string): Promise<SetupRequest | null> {
    return withLock(() => {
      const list = this.tidy(this.read()), r = list.find((x) => x.id === id);
      if (!r || r.status !== "waiting") return null;
      r.status = status; if (note) r.note = note.slice(0, 300);
      this.write(list);
      return r;
    }, this.dir);
  }
}

/** For the app and the card: the request with its plain description. */
export function showSetup(r: SetupRequest) {
  return { ...r, description: describeSetup(r.kind, r.params), needs_password: needsPassword(r.kind) };
}
