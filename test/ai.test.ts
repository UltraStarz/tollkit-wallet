/** Autopilot AI chat and check-ins, with a fake AI (no model calls), plus replaces and price history. */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { AiAssistant, claudeRunner, SYSTEM, type Runner } from "../src/ai.js";
import { proposeRules, priceHistory } from "../src/actions.js";
import { saveTelegram } from "../src/wallet.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "pw-ai-1234567";
const dir = mkdtempSync(path.join(os.tmpdir(), "twai-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const w = await TollkitWallet.open(PW, { dir });

// The fake AI: records what it was given, and proposes a rule when asked to (as the MCP server would).
const calls: { prompt: string; sessionId?: string; mcpConfig: string; system: string; cwd: string }[] = [];
let reply = "Sure.", propose: any[] | null = null, failResume = false;
const runner: Runner = async (prompt, o) => {
  calls.push({ prompt, ...o });
  if (failResume && o.sessionId) { failResume = false; throw Object.assign(new Error("No conversation found with session ID"), { resumeFailed: true }); }
  if (propose) await proposeRules(w, { rules: propose }, { neverAuto: true });
  return { text: reply, sessionId: "sess-1" };
};
let clock = Date.parse("2026-10-14T12:00:00Z");
const ai = new AiAssistant(w, { dir, runner, now: () => clock });

check(ai.precheck("hi")?.code === "needs_password", "needs the password file first", ai.precheck("hi"));
check(new AiAssistant(w, { dir, exe: null }).precheck("hi")?.code === "no_ai", "no Claude Code: says how to set it up");
writeFileSync(path.join(dir, "password"), PW, { mode: 0o600 });
check(ai.precheck("hi") === null && ai.precheck("  ")?.code === "empty", "ready once the password file exists");

// chat: owner message, AI reply, a suggested rule attached to the reply
propose = [{ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2000, reason: "Caps the loss if ETH falls hard." }];
reply = "I'd add a stop-loss at $2,000. It's waiting below.";
const m1 = await ai.send("protect my ETH");
const v1 = ai.view();
const rule = w.rules().get(m1.rules?.[0] ?? "");
check(v1.messages.length === 2 && v1.messages[0]!.role === "you" && v1.messages[1]!.text === reply, "chat: owner message and AI reply saved", v1.messages);
check(rule?.status === "proposed" && rule.reason === "Caps the loss if ETH falls hard." && rule.created_by === "agent", "chat: suggested rule attached to the reply, waiting for the owner", rule);
check(calls[0]!.prompt === "Owner: protect my ETH" && calls[0]!.system === SYSTEM && !calls[0]!.sessionId, "first message: no session yet, prompt can't be read as a flag");
const mcp = JSON.parse(calls[0]!.mcpConfig).mcpServers["tollkit-wallet"];
check(mcp.args.at(-1) === "--advisor" && mcp.args.at(-2) === "mcp" && mcp.env.TOLLKIT_WALLET_PASSWORD_FILE === path.join(dir, "password"), "AI gets the advisor-only server with the password file", mcp);
check(calls[0]!.cwd === path.join(dir, "ai"), "runs in the wallet's own ai folder (no project files)");
propose = null; reply = "Done.";
await ai.send("thanks");
check(calls[1]!.sessionId === "sess-1", "follow-ups continue the same conversation");
failResume = true;
await ai.send("again");
check(calls.at(-1)!.sessionId === undefined && ai.view().messages.at(-1)!.text === "Done.", "a lost session starts a fresh one instead of failing");

// replaces: turning on the replacement cancels the old rule
await w.rules().setStatus(rule!.id, "active");
propose = [{ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 2400, replaces: rule!.id, reason: "ETH is up; raise the floor." }];
const m2 = await ai.send("move it up");
const r2 = w.rules().get(m2.rules![0]!)!;
check(r2.replaces === rule!.id && w.rules().get(rule!.id)!.status === "active", "a replacement waits; the old rule keeps running meanwhile");
await w.rules().setStatus(r2.id, "active");
check(w.rules().get(rule!.id)!.status === "cancelled" && w.rules().get(rule!.id)!.state.note === `Replaced by ${r2.id}`, "turning on the replacement cancels the old one", w.rules().get(rule!.id));
let err = ""; try { await w.rules().add({ kind: "stop_loss", chain: "base", token: "ETH", sell_percent: 100, trigger_price: 1, replaces: "nope1234" }, "agent", false); } catch (e) { err = (e as Error).message; }
check(/no open rule/.test(err), "can't replace a rule that doesn't exist", err);

// errors show in the chat instead of breaking it
const bad = new AiAssistant(w, { dir, runner: async () => { throw new Error("Not logged in · Please run /login"); }, now: () => clock });
const em = await bad.send("hi");
check(em.error === true && /Not logged in/.test(em.text) && bad.busy === null, "AI errors appear as a message; not left busy", em);

// check-ins
propose = null; reply = "No changes. Prices are flat.";
await ai.tick();
const n0 = calls.length;
check(ai.view().checkin.every_hours === 0 && calls.length === n0, "check-ins off by default");
let e2 = ""; try { ai.setCheckin(5); } catch (e) { e2 = (e as Error).message; }
check(/Pick off/.test(e2), "only the offered schedules");
ai.setCheckin(4);
await ai.tick();
check(calls.length === n0, "first check-in waits a full period");
clock += 4 * 3600_000 + 1000;
await ai.tick();
const ck = ai.view().messages.at(-1)!;
check(calls.length === n0 + 1 && /Scheduled check-in \(every 4 hours\)/.test(calls.at(-1)!.prompt) && !!ck.checkin && !!ck.quiet, "check-in runs when due; 'No changes' shows as a quiet line", ck);
await ai.tick();
check(calls.length === n0 + 1, "and not again until the next period");

// a check-in suggestion goes to Telegram; Approve turns it on
const sentTg: any[] = [];
const tgFetch = (async (url: string, init: any) => {
  const m = String(url).split("/").pop(), body = JSON.parse(init.body);
  sentTg.push({ m, body });
  if (m === "getUpdates") {
    const msg = sentTg.find((x) => x.m === "sendMessage" && x.body.reply_markup);
    const data = msg?.body.reply_markup.inline_keyboard[0][0].callback_data;
    return new Response(JSON.stringify({ ok: true, result: data && body.timeout !== 0 ? [{ update_id: 7, callback_query: { id: "c", data, message: { chat: { id: 1 } } } }] : [] }));
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
}) as any;
saveTelegram({ token: "t", chat_id: "1" }, dir);
const ai2 = new AiAssistant(w, { dir, runner, now: () => clock, fetch: tgFetch });
clock += 4 * 3600_000 + 1000;
propose = [{ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 20, trigger_price: 1500, reason: "Buys a dip." }];
reply = "Suggest a buy at $1,500.";
const ck2 = await ai2.send("check", "checkin");
await new Promise((r) => setTimeout(r, 300));
const sug = w.rules().get(ck2.rules![0]!)!;
check(sentTg.some((x) => x.m === "sendMessage" && /Your AI suggests a change/.test(x.body.text) && /Buys a dip/.test(x.body.text)), "check-in suggestion sent to Telegram with the reason");
check(sug.status === "active", "Approve on Telegram turns it on", sug.status);

// new chat clears the conversation
ai.newChat();
check(ai.view().messages.length === 0, "New chat starts over");

// price history from Coinbase candles (fake fetch)
const rows = [[1760000000, 90, 110, 100, 105, 1], [1759996400, 85, 102, 95, 100, 1]];
const ph: any = await priceHistory({ token: "SOL", interval: "1h", points: 10 }, (async (u: string) => { check(/SOL-USD\/candles\?granularity=3600/.test(u), "price history asks Coinbase for SOL hourly candles", u); return new Response(JSON.stringify(rows)); }) as any);
check(ph.ok && ph.open === 95 && ph.last === 105 && ph.high === 110 && ph.low === 85 && ph.candles[0].t < ph.candles[1].t && ph.change_pct === 10.53, "price history: oldest first, change, high, low", ph);

// the real runner's command line (no model call): fake claude that prints its args as the result
const fake = path.join(dir, "fakeclaude");
writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(process.argv.slice(2)), session_id: "s9" }));\n`, { mode: 0o755 });
const out = await claudeRunner(fake)("Owner: hi", { cwd: dir, mcpConfig: "{}", system: "SYS", sessionId: "s1" });
const argv = JSON.parse(out.text);
const at = (f: string) => argv[argv.indexOf(f) + 1];
check(argv[0] === "-p" && argv[1] === "Owner: hi" && at("--tools") === "" && argv.includes("--strict-mcp-config") && at("--allowedTools") === "mcp__tollkit-wallet__*" && at("--permission-mode") === "dontAsk" && at("--resume") === "s1" && at("--system-prompt") === "SYS" && !argv.includes("--bare") && out.sessionId === "s9", "Claude Code is run locked down: no built-in tools, only the wallet server, deny the rest", argv);

console.log(`\nai: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
