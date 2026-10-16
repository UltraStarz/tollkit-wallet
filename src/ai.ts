/**
 * The Autopilot tab's AI: the owner chats with their own AI (Claude Code,
 * signed in on this computer, so it runs on their plan) and it can check in
 * on a schedule.
 *
 * The AI only gets the wallet's advisor tools (`tollkit-wallet mcp --advisor`):
 * balances, limits, receipts, prices, price history, the rule list, and
 * autopilot_propose. Rules it proposes always wait for the owner to turn them
 * on. It has no tool to trade, pay, withdraw or change limits, and Claude
 * Code's own tools (files, shell, web) are switched off for these runs.
 *
 * Flags checked against Claude Code's docs (code.claude.com/docs/en/headless,
 * /agent-sdk/permissions) and `claude --help` 2.1.296 on 2026-10-14:
 *   -p, --output-format json (result, session_id), --resume <id>, --system-prompt,
 *   --tools "" (no built-in tools), --mcp-config + --strict-mcp-config (only this server),
 *   --allowedTools "mcp__tollkit-wallet__*", --permission-mode dontAsk (anything else is denied).
 * Not --bare: bare mode doesn't use the owner's subscription login.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TollkitWallet } from "./wallet.js";
import { loadTelegram } from "./wallet.js";
import { notify, requestApproval } from "./telegram.js";
import { launchConfig, which } from "./connect.js";
import { passwordFile, walletHome } from "./paths.js";
import { describeRule } from "./rules.js";

/** A swap that would pay for the AI's steps: `usd` of the chain's own coin into USDC. */
export interface FuelPlan { chain: "base" | "solana"; sell: "ETH" | "SOL"; usd: number }
/** Paying for the AI with the wallet's own USDC, topped up from SOL or ETH (the browser extension's Claude). */
export interface FuelCtl {
  mode(): "ask" | "auto";
  setMode(m: "ask" | "auto"): void;
  topUp(plan: FuelPlan): Promise<{ ok: boolean; reason?: string; tx?: string }>;
}
export interface ChatMsg { id: string; role: "you" | "ai"; text: string; ts: string; rules?: string[]; checkin?: boolean; error?: boolean; quiet?: boolean; fuel?: FuelPlan }
interface ChatFile { session_id?: string; messages: ChatMsg[]; checkin: { every_hours: number; last?: string } }
export interface RunOpts { sessionId?: string; cwd: string; mcpConfig: string; system: string }
export type Runner = (prompt: string, o: RunOpts) => Promise<{ text: string; sessionId?: string }>;

export const CHECKIN_HOURS = [0, 1, 4, 12, 24];
const MAX_MSGS = 200;

export const SYSTEM = `You are the AI inside the owner's Tollkit Wallet, on the Autopilot tab. The owner talks to you to set up and adjust autopilot rules for their own money.

What you can do, through the tollkit-wallet tools:
- read their balances, limits and recent trades (wallet_balances, wallet_status, receipts)
- check prices and price history (market_prices, price_history; ETH and SOL)
- see their rules (autopilot_rules) and suggest new ones (autopilot_propose)
You cannot trade, pay, withdraw or change limits, and you can't turn rules on. Every rule you suggest waits on a card under your message for the owner to tap "Turn on". Never say a rule is on or that you placed a trade.

Rule kinds: limit_buy, limit_sell, stop_loss, take_profit, trailing_stop, dca (recurring buy), grid (buys amount_usd at each of \`levels\` prices from lower_price to upper_price and sells each a level higher). Assets trade against USDC on Base or Solana (Ethereum only if the owner enabled it). Use exact \`rules\` in autopilot_propose, not text. Give every rule a one- or two-sentence plain \`reason\`. To change an existing rule, propose the new one with \`replaces: <old rule id>\`; turning it on cancels the old one. A take-profit and stop-loss for the same position should share a \`group\` so one cancels the other.

Before suggesting: check balances (don't plan to sell what they don't hold or spend more USDC than they have), keep each buy within their per-trade limit, and use recent prices to pick sensible triggers. If what they ask is unclear or risky (all-in, no stop), say so briefly and suggest a safer version; they decide.

Style: short, plain English, like a careful friend who knows markets. No hype, no emojis, no guarantees or predictions presented as fact. Quote real numbers from the tools. When you suggest rules, end with one line saying they're waiting below to turn on.`;

const CHECKIN = (hours: number) => `Scheduled check-in (every ${hours} hour${hours === 1 ? "" : "s"}). Look at current prices, the recent price history for the coins in the owner's rules and balances, and their open rules, with what they've told you they want in this conversation. If a rule should change (for example raising a stop-loss after a rise, or a buy level that no longer makes sense), suggest the replacement with \`replaces\`. Suggest something new only if it clearly fits what they asked for. If nothing needs changing, reply with one short line that starts with "No changes".`;

/** Claude Code, headless, locked to the wallet's advisor tools. */
export function claudeRunner(exe: string, timeoutMs = 240_000): Runner {
  return (prompt, o) => new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--system-prompt", o.system,
      "--tools", "", "--strict-mcp-config", "--mcp-config", o.mcpConfig,
      "--allowedTools", "mcp__tollkit-wallet__*", "--permission-mode", "dontAsk",
      ...(o.sessionId ? ["--resume", o.sessionId] : [])];
    const env = { ...process.env };
    delete env.TOLLKIT_WALLET_PASSWORD; delete env.TOLLKIT_WALLET_PASSWORD_FILE; // the MCP server gets its own env
    const p = spawn(exe, args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      let j: any = null;
      try { j = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? ""); } catch { /* not json */ }
      if (j && typeof j.result === "string" && !j.is_error && code === 0) return resolve({ text: j.result.trim(), sessionId: j.session_id });
      const why = (j?.result || err || out || `exit ${code}`).toString().trim().slice(-400);
      reject(Object.assign(new Error(code === null || code === 143 ? "The AI took too long and was stopped." : why), { resumeFailed: !!o.sessionId && /session|conversation/i.test(why) }));
    });
  });
}

export class AiAssistant {
  private file: string;
  busy: { kind: "chat" | "checkin"; since: string; note?: string } | null = null;
  private approving = false;
  constructor(private readonly w: TollkitWallet, private readonly o: { dir?: string; runner?: Runner; exe?: string | null; now?: () => number; fetch?: typeof fetch;
    /** Who answers, when it isn't Claude Code on this computer (the browser extension uses Claude through Tollkit's server). */
    provider?: { id: string; name: string; note: string; setup?: string };
    fuel?: FuelCtl } = {}) {
    this.file = path.join(walletHome(o.dir), "ai", "chat.json");
  }
  private now() { return this.o.now?.() ?? Date.now(); }
  private exe(): string | null { return this.o.exe !== undefined ? this.o.exe : which("claude"); }
  private runner(): Runner | null { if (this.o.runner) return this.o.runner; const e = this.exe(); return e ? claudeRunner(e) : null; }

  private load(): ChatFile {
    try { if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* start over */ }
    return { messages: [], checkin: { every_hours: 0 } };
  }
  private save(c: ChatFile) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    c.messages = c.messages.slice(-MAX_MSGS);
    const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(c, null, 2), { mode: 0o600 }); renameSync(t, this.file);
  }

  view() {
    const c = this.load(), every = c.checkin.every_hours;
    const next = every && c.checkin.last ? new Date(Date.parse(c.checkin.last) + every * 3600_000).toISOString() : every ? new Date(this.now()).toISOString() : null;
    return {
      provider: this.runner() ? (this.o.provider ?? { id: "claude-code", name: "Claude" }) : null,
      ready: existsSync(passwordFile(this.o.dir)),
      busy: this.busy, messages: c.messages.slice(-60), checkin: { every_hours: every, last: c.checkin.last ?? null, next },
      fuel: this.o.fuel ? { mode: this.o.fuel.mode() } : null,
    };
  }

  setCheckin(hours: number) {
    if (!CHECKIN_HOURS.includes(hours)) throw new Error("Pick off, 1, 4, 12 or 24 hours.");
    const c = this.load(); c.checkin.every_hours = hours; if (hours) c.checkin.last = new Date(this.now()).toISOString(); this.save(c);
  }

  newChat() { const c = this.load(); c.session_id = undefined; c.messages = []; this.save(c); }

  /** Why a message can't be sent right now, or null. */
  precheck(text = "x"): { code: string; message: string } | null {
    if (!this.runner()) return { code: "no_ai", message: "To chat here, install Claude Code on this computer and sign in once (run `claude` in Terminal)." };
    if (!existsSync(passwordFile(this.o.dir))) return { code: "needs_password", message: "Type your wallet password once so the AI can read your wallet." };
    if (this.busy) return { code: "busy", message: "The AI is still working on the last message." };
    if (!text.trim()) return { code: "empty", message: "Type a message." };
    return null;
  }

  /** Sends one message (or runs a check-in) and waits for the answer. */
  async send(text: string, kind: "chat" | "checkin" = "chat", opts: { again?: boolean } = {}): Promise<ChatMsg> {
    const bad = this.precheck(text);
    if (bad) throw Object.assign(new Error(bad.message), { code: bad.code });
    const run = this.runner()!;
    const t = text.trim().slice(0, 4000);
    this.busy = { kind, since: new Date(this.now()).toISOString() };
    const c = this.load();
    if (kind === "chat" && !opts.again) { c.messages.push({ id: randomUUID().slice(0, 8), role: "you", text: t, ts: new Date(this.now()).toISOString() }); this.save(c); }
    const before = new Set(this.w.rules().list().map((r) => r.id));
    const cwd = path.join(walletHome(this.o.dir), "ai"); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const l = launchConfig(this.o.dir);
    const mcpConfig = JSON.stringify({ mcpServers: { "tollkit-wallet": { type: "stdio", command: l.command, args: [...l.args, "--advisor"], env: l.env } } });
    let msg: ChatMsg;
    try {
      let r: { text: string; sessionId?: string };
      const prompt = kind === "chat" ? `Owner: ${t}` : t; // never starts with "-", so it can't be read as a flag
      try { r = await run(prompt, { sessionId: c.session_id, cwd, mcpConfig, system: SYSTEM }); }
      catch (e) { if (!(e as any).resumeFailed) throw e; r = await run(prompt, { cwd, mcpConfig, system: SYSTEM }); }
      const fresh = this.load();
      if (r.sessionId) fresh.session_id = r.sessionId;
      const made = this.w.rules().list().filter((x) => !before.has(x.id) && x.created_by === "agent").map((x) => x.id);
      msg = { id: randomUUID().slice(0, 8), role: "ai", text: r.text || "(no reply)", ts: new Date(this.now()).toISOString(), ...(made.length ? { rules: made } : {}), ...(kind === "checkin" ? { checkin: true, quiet: !made.length } : {}) };
      fresh.messages.push(msg);
      if (kind === "checkin") fresh.checkin.last = new Date(this.now()).toISOString();
      this.save(fresh);
      if (kind === "checkin" && made.length) void this.askOnTelegram(made);
    } catch (e) {
      const fresh = this.load();
      const fuel: FuelPlan | undefined = kind === "chat" && this.o.fuel ? (e as any).fuel ?? undefined : undefined;
      msg = { id: randomUUID().slice(0, 8), role: "ai", text: (e as Error).message, ts: new Date(this.now()).toISOString(), error: true, ...(kind === "checkin" ? { checkin: true } : {}), ...(fuel ? { fuel } : {}) };
      fresh.messages.push(msg);
      if (kind === "checkin") fresh.checkin.last = new Date(this.now()).toISOString(); // don't retry every tick
      this.save(fresh);
    } finally { this.busy = null; }
    return msg;
  }

  setFuelMode(m: string) {
    if (!this.o.fuel) throw new Error("Top-ups aren't used here.");
    if (m !== "ask" && m !== "auto") throw new Error("Pick ask or auto.");
    this.o.fuel.setMode(m);
  }

  /** The top-up a failed message offers, or why it can't be done now. */
  fuelFor(id: string): { plan?: FuelPlan; error?: string } {
    if (!this.o.fuel) return { error: "Top-ups aren't used here." };
    if (this.busy) return { error: "The AI is still working on the last message." };
    const m = this.load().messages.find((x) => x.id === id);
    return m?.error && m.fuel ? { plan: m.fuel } : { error: "That message has nothing to top up." };
  }

  /** Swaps a little SOL or ETH to USDC (inside the trading limits), then sends the owner's message again. */
  async topUpAndRetry(id: string, auto: boolean): Promise<ChatMsg | null> {
    const f = this.o.fuel, got = this.fuelFor(id);
    if (!f || !got.plan) throw new Error(got.error ?? "Nothing to top up.");
    const plan = got.plan;
    if (auto) f.setMode("auto");
    this.busy = { kind: "chat", since: new Date(this.now()).toISOString(), note: `Swapping $${plan.usd} of ${plan.sell} to USDC…` };
    let r: { ok: boolean; reason?: string };
    try { r = await f.topUp(plan); } catch (e) { r = { ok: false, reason: (e as Error).message }; } finally { this.busy = null; }
    const c = this.load(), i = c.messages.findIndex((m) => m.id === id);
    if (i < 0) return null;
    if (!r.ok) { c.messages[i] = { ...c.messages[i]!, text: `The swap to USDC didn't go through: ${r.reason ?? "unknown error"}` }; this.save(c); return c.messages[i]!; }
    const you = c.messages.slice(0, i).reverse().find((m) => m.role === "you");
    c.messages.splice(i, 1); this.save(c);
    return you ? this.send(you.text, "chat", { again: true }) : null;
  }

  /** Called by the dashboard's timer. Runs a check-in when one is due. */
  async tick(): Promise<void> {
    const c = this.load(), h = c.checkin.every_hours;
    if (!h || this.busy || !this.runner() || !existsSync(passwordFile(this.o.dir))) return;
    if (c.checkin.last && this.now() - Date.parse(c.checkin.last) < h * 3600_000) return;
    await this.send(CHECKIN(h), "checkin");
  }

  /** Check-in suggestions on Telegram, if it's set up: Approve turns them on, Deny dismisses them. */
  private async askOnTelegram(ids: string[]) {
    const cfg = loadTelegram(this.o.dir);
    if (!cfg || this.approving) return;
    this.approving = true;
    try {
      const rules = ids.map((id) => this.w.rules().get(id)).filter(Boolean);
      const text = `Your AI suggests ${rules.length === 1 ? "a change" : `${rules.length} changes`} to your autopilot:\n` + rules.map((r) => `• ${describeRule(r!)}${r!.reason ? `\n  ${r!.reason}` : ""}`).join("\n") + "\n\nApprove turns them on. You can also decide in the dashboard.";
      const d = await requestApproval(cfg, text, { timeoutMs: 30 * 60_000, fetch: this.o.fetch });
      for (const id of ids) {
        const r = this.w.rules().get(id);
        if (r?.status !== "proposed") continue;
        if (d === "approved") await this.w.rules().setStatus(id, "active");
        else if (d === "denied") await this.w.rules().setStatus(id, "cancelled");
      }
      if (d === "approved") await notify(cfg, "Turned on.", this.o.fetch).catch(() => {});
    } catch { /* Telegram is optional; the dashboard still shows them */ } finally { this.approving = false; }
  }
}
