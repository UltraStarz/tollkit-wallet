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
  }
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** True for the kinds the dashboard asks the password for before applying. */
export const needsPassword = (k: SetupKind) => !["app_budget", "cash_out", "always_budget"].includes(k);

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
