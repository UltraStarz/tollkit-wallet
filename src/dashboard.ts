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
import type { Chain } from "./chains.js";

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

export async function startDashboard(w: TollkitWallet, password: string, o: { port?: number; host?: string; watch?: boolean } = {}): Promise<DashboardHandle> {
  const watcher = o.watch === false ? null : new Watcher(w);
  watcher?.start();
  const prices = o.watch === false ? null : new PriceFeed();
  prices?.start();
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
      if (!okToken(req.headers["x-tw-token"] as string ?? url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
      if (req.method === "POST") {
        const origin = String(req.headers.origin ?? "");
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "bad origin" });
      }
      const p = url.pathname;
      if (req.method === "GET" && p === "/api/state") {
        return send(res, 200, { ...w.status(), pending: pending(w.dir), receipts: w.receipts().slice(-200).reverse(),
          live: watcher ? { events: watcher.events(), balances: watcher.balances(), heads: watcher.heads() } : null,
          prices: prices ? prices.snapshot() : null });
      }
      if (req.method === "GET" && p === "/api/balances") return send(res, 200, await w.balances());
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
    close: () => new Promise<void>((r) => { clearInterval(beat); watcher?.stop(); prices?.stop(); server.close(() => r()); server.closeAllConnections?.(); }),
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
