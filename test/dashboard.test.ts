/** Dashboard server: access control, state, approvals end-to-end, password-gated changes. Local only; fake quotes. */
import { writeFileSync, mkdtempSync } from "node:fs";
import { zxData } from "./fixtures/zx.js";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";
import { dashboardOpen, pending } from "../src/approvals.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", WETH = "0x4200000000000000000000000000000000000006";
const dir = mkdtempSync(path.join(os.tmpdir(), "twd-"));
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "twd-home-")); // AI-app settings checks and removes stay in a scratch home
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const quotes = (async (u: string) => { const url = new URL(u); const sell = url.searchParams.get("sellAmount")!;
  return Response.json({ sellAmount: sell, buyAmount: "1", minBuyAmount: "1", fees: { integratorFee: { amount: String(BigInt(sell) * 50n / 10000n) } }, transaction: { to: ALLOWANCE_HOLDER, data: zxData(url, "1"), value: "0" } }); }) as unknown as typeof fetch;
const w = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", execute: async () => "0xswap" });
(w.sanctions as any).isSanctioned = async () => false; // the fake fetch only serves quotes
const d = await startDashboard(w, PW, { port: 17420, watch: false });
const tok = new URL(d.url).searchParams.get("t")!;

function raw(p: string, o: { method?: string; host?: string; token?: string | null; body?: unknown; origin?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${d.port}`, "content-type": "application/json" };
    if (o.token !== null) headers["x-tw-token"] = o.token ?? tok;
    if (o.origin) headers.origin = o.origin;
    const r = request({ host: "127.0.0.1", port: d.port, path: p, method: o.method ?? "GET", headers }, (s) => { let b = ""; s.on("data", (c) => (b += c)); s.on("end", () => res({ status: s.statusCode!, body: b })); });
    r.on("error", rej); if (o.body) r.write(JSON.stringify(o.body)); r.end();
  });
}
const j = async (p: string, o?: any) => { const r = await raw(p, o); return { status: r.status, ...JSON.parse(r.body || "{}") }; };

check((await raw(`/?t=${tok}`)).body.includes("<title>Tollkit</title>"), "page served with the link's token");
check((await raw("/?t=wrong")).status === 401, "page refused without the token");
check((await raw("/api/state", { token: null })).status === 401, "API refused without the token");
check((await raw("/api/state", { host: "evil.example:17420" })).status === 403, "other Host header refused (DNS rebinding)");
check((await raw("/api/approve", { method: "POST", origin: "https://evil.example", body: {} })).status === 403, "cross-site POST refused");
const st = await j("/api/state");
check(st.status === 200 && st.addresses.evm && Array.isArray(st.pending) && st.approvals === "dashboard", "state: addresses, pending list, dashboard counts as an approval channel", st.approvals);
check(dashboardOpen(dir), "heartbeat written while open");

// A $30 trade (over the $25 line) waits for the dashboard.
const trade = w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "30000000", slippage_bps: 50 });
let p: any[] = []; for (let i = 0; i < 40 && !p.length; i++) { await new Promise((r) => setTimeout(r, 100)); p = pending(dir); }
check(p.length === 1 && /Swap \$30\.00/.test(p[0].text), "trade shows up as pending in the dashboard", p);
const seen = await j("/api/state");
check(seen.pending.length === 1, "state lists it");
check((await j("/api/approve", { method: "POST", body: { id: "nothex", decision: "approved" } })).status === 409, "unknown id rejected");
check((await j("/api/approve", { method: "POST", body: { id: p[0].id, decision: "approved" } })).ok === true, "approve from the dashboard");
const tr = await trade;
check(tr.ok && tr.tx === "0xswap", "the trade went through after approval", tr.refused);
check((await j("/api/approve", { method: "POST", body: { id: p[0].id, decision: "denied" } })).status === 409, "can't answer twice");

const t2 = w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "30000000", slippage_bps: 50 });
p = []; for (let i = 0; i < 40 && !p.length; i++) { await new Promise((r) => setTimeout(r, 100)); p = pending(dir); }
await j("/api/approve", { method: "POST", body: { id: p[0].id, decision: "denied" } });
check((await t2).refused?.code === "denied", "deny from the dashboard stops the trade");

// Password-gated changes
check((await j("/api/policy", { method: "POST", body: { password: "nope", policy: { per_trade_usd: 999 } } })).status === 403, "limits: wrong password refused");
const pol = await j("/api/policy", { method: "POST", body: { password: PW, policy: { per_trade_usd: 75 } } });
check(pol.policy?.per_trade_usd === 75 && w.policy.per_trade_usd === 75, "limits: saved with the password", pol);
const sneaky = await j("/api/policy", { method: "POST", body: { password: PW, policy: { withdraw_addresses: [{ chain: "base", address: "0x" + "9".repeat(40) }] } } });
check(sneaky.policy?.withdraw_addresses.length === 0, "limits form can't add withdrawal addresses");
check((await j("/api/policy", { method: "POST", body: { password: PW, policy: { per_trade_usd: -1 } } })).status === 400, "bad values refused");
const ad = await j("/api/addresses", { method: "POST", body: { password: PW, chain: "base", address: "0x2222222222222222222222222222222222222222", label: "cb" } });
check(ad.withdraw_addresses?.length === 1, "address saved from the dashboard");
// Autopilot rules through the dashboard
const pv = await j("/api/rules/preview", { method: "POST", body: { text: "buy $25 of SOL every monday. make me rich" } });
check(pv.rules?.[0]?.kind === "dca" && pv.rules[0].description === "Buy $25 of SOL every Monday on Solana" && pv.unparsed?.[0] === "make me rich", "rule preview: plain description + what wasn't understood", pv);
const { description: _d, problem: _p, ...rule } = pv.rules[0];
const add = await j("/api/rules", { method: "POST", body: { rules: [rule] } });
check(add.rules?.[0]?.status === "active" && add.rules[0].created_by === "owner", "owner turns a rule on from the dashboard", add);
const st2 = await j("/api/state");
check(st2.rules?.length === 1 && st2.autopilot && st2.autopilot.agent_rules === "propose", "state lists rules and autopilot status", st2.autopilot);
const pause = await j("/api/rules/status", { method: "POST", body: { id: add.rules[0].id, status: "paused" } });
check(pause.rule?.status === "paused", "pause a rule");
check((await j("/api/rules", { method: "POST", body: { rules: [{ kind: "stop_loss", chain: "base", token: "ETH" }] } })).status === 400, "incomplete rule refused");
check((await raw("/api/rules", { method: "POST", token: null, body: { rules: [rule] } })).status === 401, "rules need the dashboard token");
const csv = await raw(`/api/receipts.csv?t=${tok}`, { token: null });
check(csv.status === 200 && csv.body.includes("0xswap"), "CSV export");
// "Connect your AI": the page gets the password-file path and whether it exists, never the password
const c1 = (await j("/api/state")).connect;
check(c1 && c1.ready === false && c1.password_file === path.join(dir, "password") && c1.launch?.env?.TOLLKIT_WALLET_HOME === dir && c1.launch.args.at(-1) === "mcp" && c1.apps.length === 6, "connect: launch config, app list, not ready yet", c1);
writeFileSync(path.join(dir, "password"), PW, { mode: 0o600 });
const c2 = (await j("/api/state")).connect;
check(c2.ready === true && !JSON.stringify(c2).includes(PW), "connect: ready once the file exists; password never sent to the page", c2);
// First run: AI trading or Python trading
check((await j("/api/state")).trade_mode === null, "trade mode: not picked on a new wallet");
const tm = await j("/api/trade-mode", { method: "POST", body: { mode: "python" } });
check(tm.status === 200 && tm.trade_mode === "python" && (await j("/api/state")).trade_mode === "python", "trade mode: picking Python is saved");
check((await j("/api/trade-mode", { method: "POST", body: { mode: "rocket" } })).status === 400, "trade mode: only ai or python");
const page = await raw(`/?t=${tok}`, { token: null });
check(!page.body.includes("How do you want to trade?") && page.body.includes("For developers") && page.body.includes("pip install tollkit-wallet") && page.body.includes("Python bots"), "no AI-or-Python pick; Python bots setup is in Settings for developers");
check(page.body.includes("Connect your AI") && page.body.includes("cursor://anysphere.cursor-deeplink/mcp/install") && page.body.includes("Do it by hand"), "page has the Connect your AI picker");
const noPw = await raw("/api/connect", { method: "POST", body: { app: "cursor", action: "add", password: "nope" } });
check(noPw.status === 403, "connect: adding an app needs the wallet password");
const rm = await raw("/api/connect", { method: "POST", body: { app: "cursor", action: "remove" } });
check(rm.status !== 403, "connect: removing an app doesn't need the password", rm.status);
await d.close();
console.log(`\ndashboard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
