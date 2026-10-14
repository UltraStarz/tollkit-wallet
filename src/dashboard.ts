/**
 * Local dashboard: `tollkit-wallet ui`. A small web page served from this
 * computer only (127.0.0.1), opened with a one-time link. Shows balances,
 * activity and limits; answers approvals; saves withdrawal addresses and
 * withdraws (both need the password again). Nothing leaves the machine
 * except the same RPC calls the CLI makes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { TollkitWallet } from "./wallet.js";
import { decide, heartbeat, pending } from "./approvals.js";
import { PolicySchema } from "./policy.js";
import { resolveToken, toAtomic } from "./tokens.js";
import { PAGE } from "./ui.js";
import { Watcher } from "./watch.js";
import { PriceFeed } from "./prices.js";
import { Autopilot } from "./autopilot.js";
import { RuleInput, describeRule, ruleProblem } from "./rules.js";
import { parseStrategy } from "./parse.js";
import type { Chain } from "./chains.js";
import { existsSync } from "node:fs";
import { passwordFile } from "./paths.js";
import { addApp, appStatus, launchConfig, removeApp, savePasswordFile, vscodeLink, type AppId } from "./connect.js";
import { AiAssistant } from "./ai.js";
import { Holdings, priceChart, coinId, erc20Info, type ChartRange } from "./holdings.js";
import { KNOWN } from "./tokens.js";
import { buyLink, BUY_ASSETS } from "./buy.js";
import { backupDone, backupKind, markBackedUp, revealBackup } from "./keystore.js";

const CHAINS = ["base", "ethereum", "solana"];

export interface DashboardHandle { url: string; port: number; close(): Promise<void> }

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((res, rej) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > limit) { rej(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { rej(new Error("bad json")); } });
    req.on("error", rej);
  });
}

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export async function startDashboard(w: TollkitWallet, password: string, o: { port?: number; host?: string; watch?: boolean; autopilot?: boolean; connectApps?: boolean; ai?: AiAssistant | false; holdings?: Holdings | false } = {}): Promise<DashboardHandle> {
  const watcher = o.watch === false ? null : new Watcher(w);
  watcher?.start();
  const prices = o.watch === false ? null : new PriceFeed();
  prices?.start();
  // The autopilot runs while the dashboard is open (live money; paper mode is `tollkit-wallet autopilot --paper`).
  const autopilot = prices && o.autopilot !== false ? new Autopilot(w.rules(), w.executor("live"), prices, { dir: w.dir }) : null;
  autopilot?.start();
  // The Autopilot tab's AI chat and scheduled check-ins (runs while the dashboard is open).
  const ai = o.ai === false ? null : o.ai ?? new AiAssistant(w, { dir: w.dir });
  const aiTimer = ai ? setInterval(() => void ai.tick().catch(() => {}), 60_000) : null;
  // Every token held, priced (refreshes each minute). Off in tests unless one is passed in.
  const holdings = o.holdings === false || (o.holdings === undefined && o.watch === false) ? null : o.holdings ?? new Holdings({ evm: w.addresses.evm, solana: w.addresses.solana, chains: () => w.policy.chains, dir: w.dir });
  holdings?.start();
  const coins = Object.fromEntries(Object.entries(KNOWN).map(([c, t]) => [c, Object.fromEntries(Object.values(t).map((x) => [x.symbol, coinId(c as Chain, x.address)]))]));
  const priceOf = (t: string) => prices?.snapshot().prices[t.toUpperCase()]?.usd;
  const token = randomBytes(24).toString("hex");
  const host = o.host ?? "127.0.0.1";
  let port = o.port ?? 7420;
  const okToken = (t: string | null | undefined) => !!t && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token));

  const server = createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine (blocks DNS-rebinding pages).
      const h = String(req.headers.host ?? "");
      if (h !== `127.0.0.1:${port}` && h !== `localhost:${port}`) return send(res, 403, { error: "forbidden host" });
      const url = new URL(req.url ?? "/", `http://${h}`);
      if (req.method === "GET" && url.pathname === "/") {
        if (!okToken(url.searchParams.get("t"))) return send(res, 401, "Open the link printed by `tollkit-wallet ui`.", "text/plain");
        return send(res, 200, PAGE, "text/html; charset=utf-8");
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      // The Tollkit browser extension: its own token (from pairing), and only from a chrome-extension:// origin.
      if (url.pathname.startsWith("/api/ext/")) {
        const ext = String(req.headers.origin ?? "");
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(ext)) return send(res, 403, { error: "Only the Tollkit extension can use this." });
        const dp = w.dapps();
        const body = req.method === "POST" ? await readBody(req) : {};
        if (url.pathname === "/api/ext/pair" && req.method === "POST") {
          try { return send(res, 200, { token: dp.pair(String(body.code ?? ""), ext) }); } catch (e) { return send(res, 403, { error: (e as Error).message }); }
        }
        if (!dp.okToken(String(req.headers["x-tw-ext"] ?? ""), ext)) return send(res, 401, { error: "This browser isn't paired with Tollkit. Pair it again from the extension." });
        try {
          if (url.pathname === "/api/ext/state") return send(res, 200, { evm: w.addresses.evm, solana: w.addresses.solana, chains: w.policy.chains, sites: dp.sites() });
          if (url.pathname === "/api/ext/request" && req.method === "POST") return send(res, 200, await dp.submit(String(body.origin ?? ""), String(body.method ?? ""), body.params));
          if (url.pathname === "/api/ext/result") return send(res, 200, dp.job(String(body.id ?? url.searchParams.get("id") ?? "")));
          return send(res, 404, { error: "not found" });
        } catch (e) {
          return send(res, 200, { error: { code: (e as any).code ?? -32603, message: (e as Error).message.slice(0, 300) } });
        }
      }
      if (!okToken(req.headers["x-tw-token"] as string ?? url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
      if (req.method === "POST") {
        const origin = String(req.headers.origin ?? "");
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "bad origin" });
      }
      const p = url.pathname;
      if (req.method === "GET" && p === "/api/state") {
        return send(res, 200, { ...w.status(), pending: pending(w.dir), receipts: w.receipts().slice(-200).reverse(),
          live: watcher ? { events: watcher.events(), balances: watcher.balances(), heads: watcher.heads() } : null,
          prices: prices ? prices.snapshot() : null,
          rules: w.rules().list().slice(-200).reverse().map((r) => ({ ...r, description: describeRule(r) })),
          autopilot: { ...Autopilot.status(w.dir), here: !!autopilot?.holdsLease, last_tick: autopilot?.lastTick ?? null, agent_rules: w.policy.agent_rules },
          connect: { password_file: passwordFile(w.dir), ready: existsSync(passwordFile(w.dir)), windows: process.platform === "win32", launch: launchConfig(w.dir), apps: o.connectApps === false ? [] : appStatus(w.dir), vscode: vscodeLink(w.dir) },
          ai: ai ? ai.view() : null,
          backup: { kind: backupKind(w.dir), done: backupDone(w.dir) },
          ext: { paired: w.dapps().paired(), sites: w.dapps().sites() },
          holdings: holdings ? holdings.snapshot() : null, coins });
      }
      if (req.method === "GET" && p === "/api/balances") return send(res, 200, await w.balances());
      // SOL staking: the owner's stake accounts, the epoch clock and the minimums (all read live).
      if (req.method === "GET" && p === "/api/stake") {
        if (!w.policy.chains.includes("solana")) return send(res, 400, { error: "Solana is turned off in your settings." });
        const st = w.staking(), ep = await st.epoch();
        const [accounts, mins] = await Promise.all([st.list(ep.epoch), st.minimums()]);
        return send(res, 200, { epoch: ep, accounts, ...mins });
      }
      // Moving between networks: a fresh quote (nothing signed) and the moves still on their way.
      if (req.method === "GET" && p === "/api/move/quote") {
        const qs = url.searchParams;
        return send(res, 200, await w.moveQuote(String(qs.get("asset")) as any, String(qs.get("from")) as Chain, String(qs.get("to")) as Chain, String(qs.get("amount") ?? "")));
      }
      if (req.method === "GET" && p === "/api/moves") return send(res, 200, { moves: (await w.mover().refresh()).slice(0, 20) });
      if (req.method === "GET" && p === "/api/sell/status") {
        const sale = w.sales().get(String(url.searchParams.get("ref") ?? ""));
        if (!sale) return send(res, 404, { error: "Unknown sale." });
        const t = await w.sales().status(sale.chain === "solana" ? w.addresses.solana : w.addresses.evm, sale.ref);
        return send(res, 200, { sale: w.sales().get(sale.ref), transaction: t });
      }
      if (req.method === "GET" && p === "/api/extmgr/sites") return send(res, 200, { sites: w.dapps().sites(), paired: w.dapps().paired() });
      if (req.method === "GET" && p === "/api/sells") return send(res, 200, { sales: w.sales().list().slice(0, 10) });
      if (req.method === "GET" && p === "/api/validators") return send(res, 200, { validators: (await w.staking().validators()).slice(0, 200) });
      if (req.method === "GET" && p === "/api/chart") return send(res, 200, await priceChart(String(url.searchParams.get("coin") ?? ""), String(url.searchParams.get("range") ?? "1D") as ChartRange));
      if (req.method === "GET" && p === "/api/receipts.csv") {
        res.setHeader("content-disposition", `attachment; filename="tollkit-wallet-receipts-${new Date().toISOString().slice(0, 10)}.csv"`);
        return send(res, 200, w.receiptsCsv(), "text/csv; charset=utf-8");
      }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      const b = await readBody(req);
      if (p === "/api/approve") {
        const ok = decide(w.dir, String(b.id ?? ""), b.decision === "approved" ? "approved" : "denied");
        return send(res, ok ? 200 : 409, ok ? { ok } : { error: "That request was already answered or has expired." });
      }
      // Autopilot: preview plain English, add rules as the owner, turn rules on/off. Trades still follow the limits.
      if (p === "/api/rules/preview") {
        const pr = parseStrategy(String(b.text ?? "").slice(0, 2000), (t) => priceOf(t));
        return send(res, 200, { rules: pr.rules.map((r) => ({ ...r, description: describeRule(r), problem: ruleProblem(r) })), unparsed: pr.unparsed });
      }
      if (p === "/api/rules") {
        const list = Array.isArray(b.rules) ? b.rules.slice(0, 10) : [];
        if (!list.length) return send(res, 400, { error: "No rules to add." });
        const parsed = list.map((r: unknown) => RuleInput.safeParse(r));
        const bad = parsed.find((x: any) => !x.success);
        if (bad) return send(res, 400, { error: "A rule is incomplete: " + (bad as any).error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        const made = [];
        for (const x of parsed as any[]) { const why = ruleProblem(x.data); if (why) return send(res, 400, { error: `${describeRule(x.data)}: ${why}` }); }
        for (const x of parsed as any[]) made.push(await w.rules().add(x.data, "owner", false));
        return send(res, 200, { rules: made.map((r) => ({ ...r, description: describeRule(r) })) });
      }
      if (p === "/api/rules/status") {
        const st = String(b.status);
        if (!["active", "paused", "cancelled"].includes(st)) return send(res, 400, { error: "status must be active, paused or cancelled" });
        const r = await w.rules().setStatus(String(b.id ?? ""), st as "active" | "paused" | "cancelled");
        void autopilot?.tick();
        return send(res, 200, { rule: { ...r, description: describeRule(r) } });
      }
      // Removing an AI app only takes access away, so it doesn't need the password.
      if (p === "/api/connect" && b.action === "remove") {
        const app = String(b.app ?? "") as AppId;
        if (!["claude", "claude-code", "cursor", "codex", "gemini"].includes(app)) return send(res, 400, { error: "Unknown app." });
        if (o.connectApps === false) return send(res, 400, { error: "Turned off here." });
        return send(res, 200, { message: await removeApp(app) });
      }
      // Show a token held on Base/Ethereum that the wallet didn't find on its own (display only).
      if (p === "/api/tokens/add" || p === "/api/tokens/hide") {
        const chain = String(b.chain) as Chain, addr = String(b.address ?? "").trim();
        if (chain !== "base" && chain !== "ethereum") return send(res, 400, { error: "Solana tokens show up on their own; add Base or Ethereum tokens here." });
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return send(res, 400, { error: "Paste the token's contract address (0x…)." });
        if (!holdings) return send(res, 400, { error: "Token list is off here." });
        if (p === "/api/tokens/hide") { holdings.list.remove(chain, addr); void holdings.refresh(); return send(res, 200, { ok: true }); }
        const info = await erc20Info(chain, addr).catch(() => null);
        if (!info) return send(res, 400, { error: `That address isn't a token on ${chain === "base" ? "Base" : "Ethereum"}.` });
        holdings.list.add(chain, addr); await holdings.refresh();
        return send(res, 200, { ok: true, token: info });
      }
      // Buy with a card or bank: a single-use Coinbase checkout link for this wallet's address.
      if (p === "/api/buy") {
        const chain = String(b.chain) as Chain;
        if (!w.policy.chains.includes(chain)) return send(res, 400, { error: `${chain} is turned off in your limits.` });
        const amt = b.amount_usd === undefined || b.amount_usd === "" ? undefined : Number(b.amount_usd);
        if (amt !== undefined && !(amt >= 5 && amt <= 10_000)) return send(res, 400, { error: "Pick an amount from $5 to $10,000." });
        return send(res, 200, await buyLink(w.addresses, { chain, asset: String(b.asset ?? "").toUpperCase(), amount_usd: amt, sandbox: b.sandbox === true }, { proxy: (w as any).o?.proxy }));
      }
      // Browser extension: a one-time pairing code, disconnecting a site, unpairing every browser.
      if (p === "/api/extmgr/code") return send(res, 200, { code: w.dapps().newCode(port) });
      if (p === "/api/extmgr/disconnect") { w.dapps().disconnect(String(b.origin ?? "")); return send(res, 200, { sites: w.dapps().sites() }); }
      if (p === "/api/extmgr/unpair") { w.dapps().unpairAll(); return send(res, 200, { ok: true }); }
      // Cash out: a single-use Coinbase sell link (sending happens later, with the password).
      if (p === "/api/sell") {
        const chain = String(b.chain) as Chain;
        if (!w.policy.chains.includes(chain)) return send(res, 400, { error: `${chain} is turned off in your settings.` });
        const amount = b.amount === undefined || b.amount === "" ? undefined : String(b.amount).trim();
        return send(res, 200, await w.sales().start(chain === "solana" ? w.addresses.solana : w.addresses.evm, chain, String(b.asset ?? "").toUpperCase(), amount));
      }
      // The owner confirmed they saved their backup (the reveal itself needs the password).
      if (p === "/api/backup/done") { markBackedUp(w.dir); return send(res, 200, { ok: true }); }
      // AI chat: messages only lead to suggested rules, which the owner turns on.
      if (p === "/api/ai/chat") {
        if (!ai) return send(res, 400, { error: "AI chat is off here." });
        const text = String(b.text ?? "").slice(0, 4000), bad = ai.precheck(text);
        if (bad) return send(res, 400, { error: bad.message, code: bad.code });
        void ai.send(text).catch(() => {});
        return send(res, 200, { ok: true });
      }
      if (p === "/api/ai/checkin") { if (!ai) return send(res, 400, { error: "AI chat is off here." }); ai.setCheckin(Number(b.hours)); return send(res, 200, { ok: true }); }
      if (p === "/api/ai/new") { if (!ai) return send(res, 400, { error: "AI chat is off here." }); if (ai.busy) return send(res, 409, { error: "Wait for the AI to finish." }); ai.newChat(); return send(res, 200, { ok: true }); }
      // Everything below changes money rules or moves funds: password again, every time.
      if (typeof b.password !== "string" || b.password !== password) return send(res, 403, { error: "Wrong password." });
      if (p === "/api/policy") {
        const next = PolicySchema.safeParse({ ...w.policy, ...b.policy, withdraw_addresses: w.policy.withdraw_addresses });
        if (!next.success) return send(res, 400, { error: next.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        return send(res, 200, { policy: w.setPolicy(password, next.data) });
      }
      if (p === "/api/addresses") {
        const chain = String(b.chain) as Chain;
        if (!CHAINS.includes(chain)) return send(res, 400, { error: "Pick a chain." });
        const pol = b.action === "remove" ? w.removeWithdrawAddress(password, chain, String(b.address ?? "")) : await w.saveWithdrawAddress(password, chain, String(b.address ?? ""), String(b.label ?? ""));
        return send(res, 200, { withdraw_addresses: pol.withdraw_addresses });
      }
      // Backup: shows the recovery phrase (or older wallets' keys) to the owner, password every time.
      if (p === "/api/backup/reveal") return send(res, 200, await revealBackup(password, w.dir));
      if (p === "/api/ai/password") { savePasswordFile(password, w.dir); return send(res, 200, { ok: true }); }
      // Connect your AI: writes the AI app's own settings (and the password file) on this computer.
      if (p === "/api/connect") {
        const app = String(b.app ?? "") as AppId;
        if (!["claude", "claude-code", "cursor", "codex", "gemini"].includes(app)) return send(res, 400, { error: "Unknown app." });
        if (o.connectApps === false) return send(res, 400, { error: "Turned off here." });
        if (!existsSync(passwordFile(w.dir))) savePasswordFile(password, w.dir);
        return send(res, 200, { message: await addApp(app, w.dir) });
      }
      if (p === "/api/sell/send") return send(res, 200, await w.cashOutSend(password, String(b.ref ?? "")));
      if (p === "/api/move" && !/^\d+$/.test(String(b.receive_min ?? ""))) return send(res, 400, { error: "Get a quote first." });
      if (p === "/api/move") return send(res, 200, await w.move(password, String(b.asset) as any, String(b.from) as Chain, String(b.to) as Chain, String(b.amount ?? ""), b.receive_min === undefined ? undefined : String(b.receive_min)));
      if (p === "/api/stake") {
        const action = String(b.action);
        if (action === "stake") return send(res, 200, await w.stakeAction(password, { action, sol: Number(b.sol), vote: String(b.vote ?? "") }));
        if (action === "unstake" || action === "withdraw") return send(res, 200, await w.stakeAction(password, { action, account: String(b.account ?? "") }));
        return send(res, 400, { error: "Unknown action." });
      }
      if (p === "/api/withdraw") {
        const chain = String(b.chain) as Chain;
        if (!CHAINS.includes(chain)) return send(res, 400, { error: "Pick a chain." });
        const tok = await resolveToken(chain, String(b.token ?? ""));
        return send(res, 200, await w.withdraw(password, chain, tok, String(b.to ?? ""), toAtomic(String(b.amount ?? ""), tok.decimals)));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message.slice(0, 300) });
    }
  });

  await new Promise<void>((res, rej) => {
    const tryListen = (left: number) => {
      server.once("error", (e: any) => { if (e.code === "EADDRINUSE" && left > 0) { port++; tryListen(left - 1); } else rej(e); });
      server.listen(port, host, () => res());
    };
    tryListen(10);
  });
  heartbeat(w.dir);
  const beat = setInterval(() => { try { heartbeat(w.dir); } catch { /* ignore */ } }, 5_000);
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return {
    url, port,
    close: () => new Promise<void>((r) => { clearInterval(beat); if (aiTimer) clearInterval(aiTimer); holdings?.stop(); watcher?.stop(); prices?.stop(); autopilot?.stop(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

/** CLI entry: unlock, serve, open the browser, run until Ctrl-C. */
export async function serveDashboard(password: string, o: { port: number }): Promise<void> {
  const w = await TollkitWallet.open(password);
  const d = await startDashboard(w, password, o);
  console.log(`Dashboard: ${d.url}\n(only reachable from this computer; keep this window open, Ctrl-C to stop)`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(opener, [d.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* print only */ }
  await new Promise<void>((r) => process.once("SIGINT", () => { d.close().then(r); }));
}
