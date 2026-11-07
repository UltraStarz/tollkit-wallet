/**
 * The AI tab's assistant: the owner chats with their own AI (Claude Code,
 * signed in on this computer, so it runs on their plan) and it can check in
 * on a schedule.
 *
 * The AI only gets the wallet's advisor tools (`tollkit-wallet mcp --advisor`):
 * balances, limits, receipts, prices, price history, the rule list, and
 * autopilot_propose and swap_propose. Rules it proposes always wait for the
 * owner to turn them on, and swaps for the owner to tap Approve. It has no tool to trade, pay, withdraw or change limits, and Claude
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
export interface ChatMsg { id: string; role: "you" | "ai"; text: string; ts: string; rules?: string[]; swaps?: string[]; checkin?: boolean; error?: boolean; quiet?: boolean; fuel?: FuelPlan;
  /** 0.9.4: small previews of the pictures the owner attached (the pictures themselves go to the AI once). */
  images?: string[] }
/** 0.9.4: a picture the owner attached, base64, for an AI that can see images. */
export type ChatImage = { media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string };
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_IMAGES = 4;
interface ChatFile { session_id?: string; messages: ChatMsg[]; checkin: { every_hours: number; last?: string } }
export interface RunOpts { sessionId?: string; cwd: string; mcpConfig: string; system: string; images?: ChatImage[] }
export type Runner = (prompt: string, o: RunOpts) => Promise<{ text: string; sessionId?: string }>;

export const CHECKIN_HOURS = [0, 1, 4, 12, 24];

/**
 * 0.8.4: which Tollkit AI model answers in the extension's chat. Fast (Claude Haiku, $0.02 a step) is the default;
 * Smart (Claude Sonnet, $0.04 a step) is for harder questions. Kept in ai/tier.json.
 */
export type AiTier = "fast" | "smart";
const tierFile = (dir?: string) => path.join(walletHome(dir), "ai", "tier.json");
export function aiTier(dir?: string): AiTier {
  try { return JSON.parse(readFileSync(tierFile(dir), "utf8"))?.tier === "smart" ? "smart" : "fast"; } catch { return "fast"; }
}
export function setAiTier(dir: string | undefined, t: unknown): AiTier {
  if (t !== "fast" && t !== "smart") throw new Error("Pick Fast or Smart.");
  const f = tierFile(dir); mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ tier: t }), { mode: 0o600 }); renameSync(tmp, f);
  return t;
}
const MAX_MSGS = 200;

/** 0.9.13: no scheduled check-ins. Only Autopilot acts without being asked. */
export const CHECKINS_OFF = true;
export const SYSTEM = `You are the AI assistant inside the owner's Tollkit Wallet, on its AI tab. The owner talks to you about their own money: what they hold, what prices are doing, one-off trades, and autopilot rules. If they ask what AI or model you are, say plainly that you run on Claude, made by Anthropic.

What you can do, through the tollkit-wallet tools:
- read their balances, limits and recent trades (wallet_balances, wallet_status, receipts)
- check prices and price history (market_prices, price_history; ETH, SOL and POL)
- suggest one swap to do now (swap_propose), when they ask to buy, sell or swap something now
- see their rules (autopilot_rules) and suggest new ones (autopilot_propose)
- set things up for them: ready-made bots (bot_templates, bot_preview, bot_start, bots_status, bot_control), tokens on their list (token_search, token_check, token_add, token_hide), "keep running when closed" for a rule (always_on), quotes and links they can use (move_quote, buy_link)
- ask them to make a change only they can make (setup_request): limits, withdrawal addresses, withdrawing, moving between networks, staking, cashing out, connecting another AI app, a weekly budget for an AI app, the Always On budget. It shows as a card on their Approvals screen; they tap Apply and type their password where the wallet asks. setup_requests shows what they did with it.
You cannot trade, pay, withdraw or change limits yourself, and you can't turn rules or bots on. Every swap, rule or bot you suggest waits on a card: the owner taps "Approve" for a swap or "Turn on" for a rule or bot. Never say a swap happened, a rule is on, or that you placed a trade. When they ask you to set something up, do it with the tools (don't just describe it), then say in one line what's waiting for them and where.

Swaps: use swap_propose with the chain, the token sold, the token bought and the amount in the sold token's units (for "$20 of ETH", sell 20 USDC). Give a one- or two-sentence plain \`reason\`. If it's refused (limits, balance, unknown token), tell the owner why in plain words and offer what would work. One swap per request unless they ask for more.

Rule kinds: limit_buy, limit_sell, stop_loss, take_profit, trailing_stop, dca (recurring buy), grid (buys amount_usd at each of \`levels\` prices from lower_price to upper_price and sells each a level higher), and alert. Stop-loss, take-profit and trailing stop SELL when they trigger; they don't warn. To only warn, use an alert: it never trades, it notifies the owner on screen and on Telegram (if linked) while the wallet app is running. Alert fields: \`alert\` is above or below (with trigger_price), move (alert_value = % move in 24 hours), rsi_high or rsi_low (hourly RSI(14); alert_value is the level, default 70 and 30), ma_up or ma_down (the price crossing its 50-hour average); no amounts. Autopilot, the separate strategy feature, already reads funding rates, open interest, Fear & Greed, news mood and Farcaster before each decision; plain rules only watch the price. Assets trade against USDC on the networks the owner turned on (wallet_status lists them). Use exact \`rules\` in autopilot_propose, not text. Give every rule a one- or two-sentence plain \`reason\`. To change an existing rule, propose the new one with \`replaces: <old rule id>\`; turning it on cancels the old one. A take-profit and stop-loss for the same position should share a \`group\` so one cancels the other.

Before suggesting: check balances (don't plan to sell what they don't hold or spend more USDC than they have), keep each trade within their per-trade limit, and use recent prices to pick sensible triggers. Amounts: when the owner names one, use theirs. When they don't, size from their money, not tiny test amounts: use suggested_size_usd from wallet_status for that network (an equal share of their dollars there, the same size Autopilot uses). For a grid that is the whole bot, spread over its levels (amount_usd per level = suggested size / (levels - 1)); for a recurring buy, spread over its buys. If what they ask is unclear or risky (all-in, no stop, a coin they don't know), say so briefly and suggest a safer version; they decide.

Style: short, plain English, like a careful friend who knows markets. No hype, no emojis, no guarantees or predictions presented as fact. Quote real numbers from the tools. When you suggest a swap or rules, end with one line saying they're waiting below for the owner. Autopilot is the part of the wallet that runs on its own: it starts, tweaks and stops its own strategies inside the owner's budget, and its rules belong to it (rules by "superbot"; they show on the Autopilot and Bots tabs). Call autopilot_status whenever the owner asks about Autopilot, its bots, its trades, its results or why it did something, and explain it plainly from what it says: you can see everything Autopilot does. For its full history of decisions (why it started, changed or stopped something, back to its oldest kept decision), call autopilot_log; filter by strategy or coin and page back with before. To stop one of its strategies, put one live, turn Autopilot on or off, or resume it after a loss stop, use setup_request autopilot_action; Big moves settings go in autopilot_settings moves. You act only when the owner asks. When they ask for a bot, ask whether Autopilot should run it (it then counts against Autopilot's budget and slots, starts on paper and is managed by Autopilot: use setup_request autopilot_strategy, and they tap Apply on the Approvals screen) or whether it's their own bot (bot_start; they tap Start). Nov 7 (Joe: "I want more say in what happens"): when the owner names the trade themselves (an amount, a coin, buy low and sell high), it's their own bot by default (bot_start) with exactly what they said: their amount, their coin, the simplest template that does it ("buy low, sell high" is a dip bot: buy on a drop, sell at a gain). Don't swap in a different template (one trade means one buy and one sell, never Smart DCA's stacked buys), split it smaller, or route it through Autopilot unless they ask for Autopilot or for paper. Own bots trade real money; if they want it on paper ("in paper", "test it first"), use setup_request autopilot_strategy with that same template and their exact amount: Autopilot then keeps their settings as they are (it won't resize, change or stop it) and only the paper trial and their Go live tap stand between it and real money. If it doesn't fit (more than their USDC there, or over their per-trade limit), say the exact number that does and ask; never shrink it quietly. Only when they leave the choice to you and Autopilot is on, offer Autopilot. When they say how the size should move ("scale from there", "grow it", "bigger after wins"), set sizing: compound grows with what it makes, step_up goes 25% bigger after each win and back after a loss, fixed stays the same; if it's unclear, ask which of the three. Nov 7 (Joe: "give plenty of options in trading, I don't want constriction"): when the owner asks for a trade or a bot and hasn't pinned every detail, lay out 2 to 4 real options side by side before setting anything up: different templates (dip, grid, Smart DCA, trailing stop, take-profit ladder, signal, recurring buy...), sizes and sizings, tighter or wider triggers, paper or live, each with one plain line on how it makes money, what it risks and what it needs in cash. Use every template that fits, not only the cautious one, and let them pick; then do exactly the one they picked. Don't narrow their choices for them: if one option breaks a limit (cash, per-trade cap), still show it and say what limit it hits and the setting that would allow it. Before sending any bot or strategy, say back in one line exactly what will run (template in plain words, coin/USDC, amount a trade, its triggers, sizing, paper or live) so the owner can catch a mismatch. When they ask for a one-off order, use autopilot_propose. To change how Autopilot works (budget, trade size, pace, coins, Active mode, 24/7) use setup_request autopilot_settings; they tap Apply. For a standing preference ("be careful this week", "no meme coins") save it with autopilot_note: Autopilot reads its notes before every decision. Never change, replace or cancel one of Autopilot's rules, and never set up something that duplicates a bot Autopilot already runs on that coin: say what Autopilot is doing instead, and if they want it to behave differently (more careful, a different coin, its pace or budget), tell them it's in Autopilot's settings.`;

const CHECKIN = (hours: number) => `Scheduled check-in (every ${hours} hour${hours === 1 ? "" : "s"}). Don't suggest one-off swaps in a check-in; only rules. Look at current prices, the recent price history for the coins in the owner's rules and balances, and their open rules, with what they've told you they want in this conversation. If a rule should change (for example raising a stop-loss after a rise, or a buy level that no longer makes sense), suggest the replacement with \`replaces\`. Suggest something new only if it clearly fits what they asked for. If nothing needs changing, reply with one short line that starts with "No changes".`;

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

type Provider = { id: string; name: string; note: string; setup?: string; tiers?: boolean; images?: boolean };
export class AiAssistant {
  private file: string;
  busy: { kind: "chat" | "checkin"; since: string; note?: string } | null = null;
  private approving = false;
  constructor(private readonly w: TollkitWallet, private readonly o: { dir?: string; runner?: Runner; exe?: string | null; now?: () => number; fetch?: typeof fetch;
    /** Who answers, when it isn't Claude Code on this computer (the browser extension uses Claude through Tollkit's server). */
    provider?: Provider | (() => Provider | null);
    fuel?: FuelCtl;
    /** 0.9.4, the phone: the owner's own AI account. The runner exists once they've added a key. */
    getRunner?: () => Runner | null;
    /** What the page shows to set up or change the owner's own AI (app/own-ai.ts). */
    own?: () => unknown;
    /** Shown when there's no AI to answer yet. */
    noAi?: string } = {}) {
    this.file = path.join(walletHome(o.dir), "ai", "chat.json");
  }
  private now() { return this.o.now?.() ?? Date.now(); }
  private exe(): string | null { return this.o.exe !== undefined ? this.o.exe : which("claude"); }
  private runner(): Runner | null { if (this.o.getRunner) return this.o.getRunner(); if (this.o.runner) return this.o.runner; const e = this.exe(); return e ? claudeRunner(e) : null; }

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
      provider: this.runner() ? ((typeof this.o.provider === "function" ? this.o.provider() : this.o.provider) ?? { id: "claude-code", name: "Claude Code" }) : null,
      ready: existsSync(passwordFile(this.o.dir)),
      busy: this.busy, messages: c.messages.slice(-60), checkin: { every_hours: every, last: c.checkin.last ?? null, next },
      fuel: this.o.fuel ? { mode: this.o.fuel.mode() } : null,
      tier: aiTier(this.o.dir),
      ...(this.o.own ? { own: this.o.own() } : {}),
    };
  }

  setCheckin(hours: number) {
    if (!CHECKIN_HOURS.includes(hours)) throw new Error("Pick off, 1, 4, 12 or 24 hours.");
    if (CHECKINS_OFF) hours = 0;
    const c = this.load(); c.checkin.every_hours = hours; if (hours) c.checkin.last = new Date(this.now()).toISOString(); this.save(c);
  }

  newChat() { const c = this.load(); c.session_id = undefined; c.messages = []; this.save(c); }

  /** Why a message can't be sent right now, or null. */
  precheck(text = "x", images = 0): { code: string; message: string } | null {
    if (!this.runner()) return { code: "no_ai", message: this.o.noAi ?? "To chat here, install Claude Code on this computer and sign in once (run `claude` in Terminal)." };
    if (!existsSync(passwordFile(this.o.dir))) return { code: "needs_password", message: "Type your wallet password once so the AI can read your wallet." };
    if (this.busy) return { code: "busy", message: "The AI is still working on the last message." };
    if (!text.trim() && !images) return { code: "empty", message: "Type a message." };
    return null;
  }

  /** Sends one message (or runs a check-in) and waits for the answer. */
  async send(text: string, kind: "chat" | "checkin" = "chat", opts: { again?: boolean; images?: ChatImage[]; thumbs?: string[] } = {}): Promise<ChatMsg> {
    const images = (opts.images ?? []).slice(0, MAX_IMAGES);
    const bad = this.precheck(text, images.length);
    if (bad) throw Object.assign(new Error(bad.message), { code: bad.code });
    const run = this.runner()!;
    const t = text.trim().slice(0, 4000);
    this.busy = { kind, since: new Date(this.now()).toISOString() };
    const c = this.load();
    const thumbs = (opts.thumbs ?? []).slice(0, MAX_IMAGES);
    if (kind === "chat" && !opts.again) { c.messages.push({ id: randomUUID().slice(0, 8), role: "you", text: t, ts: new Date(this.now()).toISOString(), ...(thumbs.length ? { images: thumbs } : {}) }); this.save(c); }
    const before = new Set(this.w.rules().list().map((r) => r.id)), ideasBefore = new Set(this.w.ideas().list().map((i) => i.id));
    const cwd = path.join(walletHome(this.o.dir), "ai"); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const l = launchConfig(this.o.dir);
    const mcpConfig = JSON.stringify({ mcpServers: { "tollkit-wallet": { type: "stdio", command: l.command, args: [...l.args, "--advisor"], env: l.env } } });
    let msg: ChatMsg;
    try {
      let r: { text: string; sessionId?: string };
      const said = t || (images.length === 1 ? "(sent a picture)" : "(sent pictures)");
      const prompt = kind === "chat" ? `Owner: ${said}` : t; // never starts with "-", so it can't be read as a flag
      const pics = images.length ? { images } : {};
      try { r = await run(prompt, { sessionId: c.session_id, cwd, mcpConfig, system: SYSTEM, ...pics }); }
      catch (e) { if (!(e as any).resumeFailed) throw e; r = await run(prompt, { cwd, mcpConfig, system: SYSTEM, ...pics }); }
      const fresh = this.load();
      if (r.sessionId) fresh.session_id = r.sessionId;
      const made = this.w.rules().list().filter((x) => !before.has(x.id) && x.created_by === "agent").map((x) => x.id);
      const swaps = this.w.ideas().list().filter((x) => !ideasBefore.has(x.id)).map((x) => x.id);
      msg = { id: randomUUID().slice(0, 8), role: "ai", text: r.text || "(no reply)", ts: new Date(this.now()).toISOString(), ...(made.length ? { rules: made } : {}), ...(swaps.length ? { swaps } : {}), ...(kind === "checkin" ? { checkin: true, quiet: !made.length && !swaps.length } : {}) };
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

  /** Called by the dashboard's timer. 0.9.13: scheduled check-ins are retired: Autopilot is the one part of the wallet
   *  that acts on its own; the chat only answers when the owner asks. */
  async tick(): Promise<void> {
    if (CHECKINS_OFF) return;
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
