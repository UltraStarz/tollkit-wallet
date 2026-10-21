/**
 * 0.8.0: an AI app can set up anything the owner can set up in the app, within two tiers. Tier 1 (bots, tokens,
 * Always On, quotes) happens at once and never moves money; Tier 2 (limits, funds, apps) is a form the owner
 * applies on the Approvals screen with the password. Per-app weekly budgets cap what each app's actions may spend.
 * Fake quotes, no network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zxData } from "./fixtures/zx.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";
import { buildServer, ADVISOR_TOOLS } from "../src/mcp.js";
import { ACTIONS } from "../src/actions.js";
import { startDashboard } from "../src/dashboard.js";
import { budgetProblem, budgetView, setBudget, spentThisWeek, weekStart } from "../src/appbudget.js";
import { Setups, describeSetup, needsPassword } from "../src/setups.js";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const dir = mkdtempSync(path.join(os.tmpdir(), "twsetup-"));
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "twsetup-home-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const quotes = (async (u: string) => { const url = new URL(u); const sell = url.searchParams.get("sellAmount")!;
  return Response.json({ sellAmount: sell, buyAmount: "1", minBuyAmount: "1", fees: { integratorFee: { amount: String(BigInt(sell) * 50n / 10000n) } }, transaction: { to: ALLOWANCE_HOLDER, data: zxData(url, "1"), value: "0" } }); }) as unknown as typeof fetch;
const w = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", execute: async () => "0xswap" });
(w.sanctions as any).isSanctioned = async () => false;

const connect = async (name: string, advisor = false) => {
  const c = new Client({ name, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(w, { advisor }).connect(a); await c.connect(b);
  return c;
};
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => JSON.parse(((await c.callTool({ name, arguments: args })).content as any)[0].text);

// ── Surface: every setup tool exists, for connected apps and for Tollkit AI; nothing can apply a request or reveal keys.
const names = ACTIONS.map((a) => a.name);
const setupTools = ["bot_templates", "bot_preview", "bot_start", "bots_status", "bot_control", "token_search", "token_check", "token_add", "token_hide", "always_on", "move_quote", "buy_link", "setup_request", "setup_requests", "setup_cancel"];
check(setupTools.every((n) => names.includes(n)), "all setup tools are defined", names);
check(setupTools.every((n) => ADVISOR_TOOLS.includes(n)), "Tollkit AI (advisor) gets the same setup tools");
check(!names.some((n) => /policy|limit|backup|reveal|password|approve|withdraw$|^move$|^stake$|connect_app/.test(n)), "no tool changes limits, moves funds, approves, connects apps or reveals keys directly");
const claude = await connect("claude-ai");
const listed = (await claude.listTools()).tools.map((t) => t.name);
check(setupTools.every((n) => listed.includes(n)), "a connected app sees the setup tools over MCP");
const advisor = await connect("claude-code", true);
const advListed = (await advisor.listTools()).tools.map((t) => t.name);
check(advListed.includes("bot_start") && advListed.includes("setup_request") && !advListed.includes("swap") && !advListed.includes("pay_fetch"), "Tollkit AI can set up but still never trades or pays on its own");

// ── Tier 1: bots.
const tpl = await call(claude, "bot_templates");
check(Array.isArray(tpl.templates) && tpl.templates.some((t: any) => t.id === "dca") && tpl.agent_rules === "propose", "bot templates listed with the owner's agent_rules setting");
const prev = await call(claude, "bot_preview", { chain: "base", token: "ETH", template: "dca", params: { amount_usd: 10, every: "week" } });
check(prev.ok === true && /\$10/.test(prev.rules.join(" ")), "a bot can be previewed in plain words", prev);
const started = await call(claude, "bot_start", { chain: "base", token: "ETH", template: "dca", params: { amount_usd: 10, every: "day" }, reason: "You asked for a steady buyer." });
check(started.ok === true && started.status === "proposed" && started.rules[0]?.rule?.by === "Claude" && started.rules[0]?.rule?.reason === "You asked for a steady buyer.", "a bot started by Claude waits for the owner (agent_rules=propose) and is tagged by: Claude", started);
const botId = started.bot;
const stat = await call(claude, "bots_status");
check(Array.isArray(stat) && !stat.some((b: any) => b.id === botId), "a waiting (proposed) bot isn't on the status board until the owner turns it on");
const rs = w.rules();
await rs.setStatus(started.rules[0].id, "active"); // the owner turned it on
const paused = await call(claude, "bot_control", { bot: botId, action: "pause" });
check(paused.ok === true && rs.get(started.rules[0].id)?.status === "paused", "an AI can pause a bot");
const rm1 = await call(claude, "bot_control", { bot: botId, action: "remove" });
check(rm1.ok === false && rm1.refused.code === "still_running", "a running bot can't be removed, only stopped");
const stop = await call(claude, "bot_control", { bot: botId, action: "stop" });
const rm2 = await call(claude, "bot_control", { bot: botId, action: "remove" });
check(stop.ok === true && rm2.ok === true && rs.get(started.rules[0].id)?.archived === true, "stop, then remove: the rule is archived, its history kept");
const badTok = await call(claude, "bot_start", { chain: "base", token: "0x1111111111111111111111111111111111111111", template: "dca" });
check(badTok.ok === false && /token_check|add/.test(badTok.refused.reason), "a token the owner hasn't added is refused with the next step", badTok);
const autoW = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", execute: async () => "0xswap" });
autoW.setPolicy(PW, { ...autoW.policy, agent_rules: "auto" });
const c2 = new Client({ name: "cursor", version: "1" }); { const [a, b] = InMemoryTransport.createLinkedPair(); await buildServer(autoW).connect(a); await c2.connect(b); }
const auto = await call(c2, "bot_start", { chain: "base", token: "ETH", template: "dca", params: { amount_usd: 5, every: "week" } });
check(auto.ok === true && auto.status === "active" && auto.rules[0].rule.by === "Cursor", "with agent_rules=auto the bot starts at once, tagged with the app", auto);
const adv2 = new Client({ name: "x", version: "1" }); { const [a, b] = InMemoryTransport.createLinkedPair(); await buildServer(autoW, { advisor: true }).connect(a); await adv2.connect(b); }
const advBot = await call(adv2, "bot_start", { chain: "base", token: "ETH", template: "dca", params: { amount_usd: 5, every: "week" } });
check(advBot.ok === true && advBot.status === "proposed" && advBot.rules[0].rule.by === "Tollkit AI", "Tollkit AI's bots always wait for the owner, whatever agent_rules says");
autoW.setPolicy(PW, { ...autoW.policy, agent_rules: "propose" });
for (const r of rs.list()) if (!["done", "cancelled", "expired"].includes(r.status)) await rs.setStatus(r.id, "cancelled");

// ── Tier 1: Always On needs the server and the owner's budget.
const ao = await call(claude, "always_on", { action: "on", rule: "nope1234" });
check(ao.ok === false && ao.refused.code === "no_such_rule", "Always On on an unknown rule is refused");
const aoOff = await call(claude, "always_on", { action: "off", rule: started.rules[0].id });
check(aoOff.ok === true && aoOff.on === false, "turning Always On off never needs anything");

// ── Tier 2: setup requests.
const req = await call(claude, "setup_request", { kind: "limits", params: { per_trade_usd: 100 }, reason: "So the weekly buyer fits in one swap." });
check(req.ok === true && req.request.status === "waiting" && req.request.by === "Claude" && req.request.description === "Set the per-swap limit to $100." && req.request.needs_password === true, "a limits request is queued for the owner, in plain words, password required", req);
check(w.policy.per_trade_usd === 50, "the request itself changed nothing");
const badReq = await call(claude, "setup_request", { kind: "limits", params: { per_trade_usd: -1 }, reason: "x" });
check(badReq.ok === false && /incomplete|positive|greater/i.test(badReq.refused.reason), "a bad form is refused with the field named", badReq);
const unknownField = await call(claude, "setup_request", { kind: "limits", params: { withdraw_addresses: [] }, reason: "x" });
check(unknownField.ok === false, "a limits request can't smuggle in withdrawal addresses");
const mv = await call(claude, "setup_request", { kind: "move", params: { asset: "USDC", from: "base", to: "solana", amount: "10" }, reason: "Fees are lower there." });
check(mv.ok === true && mv.request.description === "Move 10 USDC from Base to Solana.", "a move request reads plainly");
const ab = await call(claude, "setup_request", { kind: "app_budget", params: { app: "Claude", weekly_usd: 5 }, reason: "A sensible cap." });
check(ab.ok === true && ab.request.needs_password === false && describeSetup("app_budget", { app: "Claude", weekly_usd: 5 }) === "Give Claude a weekly budget of $5.", "an app budget request needs no password");
check(needsPassword("withdraw") && needsPassword("limits") && !needsPassword("always_budget"), "password rule per kind");
const mine = await call(claude, "setup_requests", { status: "waiting" });
check(mine.length === 3, "the app can list its waiting requests", mine.length);
const cancel = await call(claude, "setup_cancel", { id: mv.request.id });
check(cancel.ok === true && cancel.request.status === "dismissed", "the app can withdraw a request");

// ── The owner applies them in the dashboard.
const d = await startDashboard(w, PW, { port: 17431, watch: false });
const tok = new URL(d.url).searchParams.get("t")!;
const j = (p: string, body?: unknown): Promise<any> => new Promise((res, rej) => {
  const r = request({ host: "127.0.0.1", port: d.port, path: p, method: body ? "POST" : "GET", headers: { host: `127.0.0.1:${d.port}`, "content-type": "application/json", "x-tw-token": tok } },
    (s) => { let b = ""; s.on("data", (c) => (b += c)); s.on("end", () => res({ status: s.statusCode, ...JSON.parse(b || "{}") })); });
  r.on("error", rej); if (body) r.write(JSON.stringify(body)); r.end();
});
const st = await j("/api/state");
check(st.setups.length === 2 && st.setups[0].description === "Set the per-swap limit to $100." && Array.isArray(st.app_budgets), "the dashboard state carries the waiting requests and budgets", st.setups);
const noPw = await j("/api/setups/apply", { id: req.request.id });
check(noPw.status === 403, "applying a limits request without the password is refused");
const applied = await j("/api/setups/apply", { id: req.request.id, password: PW });
check(applied.status === 200 && applied.ok === true && w.policy.per_trade_usd === 100, "with the password the limit changes", applied);
check(new Setups(dir).get(req.request.id)?.status === "applied", "the request is marked applied for the app to see");
const again = await j("/api/setups/apply", { id: req.request.id, password: PW });
check(again.status === 409, "a request can't be applied twice");
const abApplied = await j("/api/setups/apply", { id: ab.request.id });
check(abApplied.status === 200 && budgetView(dir)[0]?.app === "Claude" && budgetView(dir)[0]?.weekly_usd === 5, "an app-budget request applies without a password", abApplied);
const dis = await j("/api/setups", { id: "zzzzzzzzzzzz", action: "dismiss" });
check(dis.status === 409, "dismissing a request that isn't waiting says so");
const seen = await call(claude, "setup_requests", {});
check(seen.find((r: any) => r.id === req.request.id)?.status === "applied" && seen.find((r: any) => r.id === ab.request.id)?.note === "Budget set.", "the app sees what happened to each request");

// ── Per-app budgets cap the app's spending.
check(weekStart(new Date("2026-10-21T10:00:00Z")).toISOString() === "2026-10-19T00:00:00.000Z" && weekStart(new Date("2026-10-19T00:00:00Z")).toISOString() === "2026-10-19T00:00:00.000Z", "weeks start Monday 00:00 UTC");
const b1 = await j("/api/app-budgets", { app: "Claude", weekly_usd: 1.5 });
check(b1.status === 200 && b1.app_budgets[0].weekly_usd === 1.5, "the owner sets a budget on the dashboard without a password");
const s1 = await call(claude, "swap", { chain: "base", sell: "USDC", buy: "WETH", amount: "1" });
check(s1.ok === true && entries(dir).find((e) => e.id === s1.receipt_id)?.by === "Claude", "a $1 swap by Claude goes through and the receipt says by Claude", s1);
check(Math.abs(spentThisWeek(dir, "Claude") - 1) < 0.01, "it counts against Claude's week", spentThisWeek(dir, "Claude"));
const s2 = await call(claude, "swap", { chain: "base", sell: "USDC", buy: "WETH", amount: "1" });
check(s2.ok === false && s2.refused.code === "over_app_budget" && /Claude's weekly budget is \$1.5/.test(s2.refused.reason), "the next $1 would pass $1.50, so Claude is refused in plain words", s2);
check(budgetProblem(dir, "Cursor", 100) === null, "an app without a budget is only limited by the owner's limits");
const cur = await connect("cursor");
const s3 = await call(cur, "swap", { chain: "base", sell: "USDC", buy: "WETH", amount: "1" });
check(s3.ok === true, "Cursor's swap is unaffected by Claude's budget");
const left = budgetView(dir).find((b) => b.app === "Claude")!;
check(left.spent_usd >= 1 && left.left_usd <= 0.5, "the view shows spent and left", left);
const b2 = await j("/api/app-budgets", { app: "Claude", weekly_usd: null });
check(b2.status === 200 && !b2.app_budgets.some((b: any) => b.app === "Claude"), "removing the budget");
const s4 = await call(claude, "swap", { chain: "base", sell: "USDC", buy: "WETH", amount: "1" });
check(s4.ok === true, "without a budget Claude can swap again");
let threw = "";
try { setBudget(dir, "", 5); } catch (e) { threw = (e as Error).message; }
check(/Name/.test(threw), "a budget needs an app name");

// ── A bot's fills count against the app that started it.
setBudget(dir, "Claude", 5);
const bot2 = await call(claude, "bot_start", { chain: "base", token: "ETH", template: "dca", params: { amount_usd: 1, every: "day" } });
await rs.setStatus(bot2.rules[0].id, "active");
const ex = w.executor("live");
const fill = await ex.swap({ chain: "base", sell_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", buy_token: "0x4200000000000000000000000000000000000006", sell_amount: "1000000", slippage_bps: 50 }, { by: rs.get(bot2.rules[0].id)!.by });
check(fill.ok === true && entries(dir).find((e) => e.id === fill.receipt_id)?.by === "Claude", "a fill made on behalf of Claude's bot is tagged by Claude (what the autopilot passes)", fill);
await d.close();

console.log(`\nsetup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
