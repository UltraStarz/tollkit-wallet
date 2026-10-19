/**
 * 0.8.1: Tollkit's paid tools offered to a connected AI by name. The catalog comes from the server (cached,
 * snapshot fallback), the owner can hide tools, and a call is an ordinary paid fetch from this wallet: the
 * limits and the app's budget apply, failures are free. Fake server; no network.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { buildServer } from "../src/mcp.js";
import { readCatalog, refreshCatalog, offeredTools, setHidden, catalogView, zodShape, describeTool, CATALOG_URL } from "../src/tollkit-tools.js";
import { TOLLKIT_TOOLS_SNAPSHOT } from "../src/data/tollkit-tools.js";
import { setBudget } from "../src/appbudget.js";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const dir = mkdtempSync(path.join(os.tmpdir(), "twtk-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });

// ── The catalog.
const snap = readCatalog(dir);
check(snap.tools.length >= 25 && snap.fetched_at === null && snap.tools.some((t) => t.name === "read_page") && snap.tools.some((t) => t.name === "web_search"), "with nothing cached the built-in snapshot is used", snap.tools.length);
check(snap.tools.every((t) => /^https:\/\/[a-z]+\.tollkit\.dev\//.test(t.url)), "every snapshot tool points at a tollkit.dev host");
const live = { version: "9.9.9", tools: [
  { name: "read_page", title: "Read", path: "/read", url: "https://web.tollkit.dev/read", price_usd: 0.003, description: "Read a page.", input_schema: { type: "object", required: ["url"], properties: { url: { type: "string", description: "The page" } } }, free_trial: true },
  { name: "evil", title: "Evil", path: "/x", url: "https://evil.example/x", price_usd: 0.001, description: "Not ours.", input_schema: { type: "object", properties: {} }, free_trial: false },
  { name: "pricey", title: "Pricey", path: "/p", url: "https://web.tollkit.dev/p", price_usd: 500, description: "Too much.", input_schema: { type: "object", properties: {} }, free_trial: false },
] };
let fetched = 0;
const f = (async (u: string) => { if (String(u) === CATALOG_URL) { fetched++; return Response.json(live); } return new Response("nope", { status: 404 }); }) as unknown as typeof fetch;
check(await refreshCatalog(dir, f) === true && fetched === 1, "the live catalog is fetched and cached");
const cur = readCatalog(dir);
check(cur.version === "9.9.9" && cur.tools.length === 1 && cur.tools[0]!.price_usd === 0.003, "only sane tools are kept: tollkit.dev hosts, prices up to $10", cur.tools.map((t) => t.name));
check(await refreshCatalog(dir, f) === false && fetched === 1, "a fresh cache isn't refetched");
check(await refreshCatalog(dir, f, Date.now() + 7 * 3600_000) === true && fetched === 2, "after six hours it is");
const bad = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
check(await refreshCatalog(dir, bad, Date.now() + 20 * 3600_000) === false && readCatalog(dir).version === "9.9.9", "offline keeps the cached catalog");
writeFileSync(path.join(dir, "tollkit-tools.json"), "{garbage");
check(readCatalog(dir).tools.length === snap.tools.length, "a broken cache falls back to the snapshot");

// ── Hiding.
setHidden(dir, "web_search", true);
check(!offeredTools(dir).some((t) => t.name === "web_search") && catalogView(dir).tools.find((t) => t.name === "web_search")?.hidden === true, "a hidden tool isn't offered and shows as hidden in Settings");
setHidden(dir, "web_search", false);
check(offeredTools(dir).some((t) => t.name === "web_search"), "unhidden again");

// ── Schemas and descriptions.
const shape = zodShape({ type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 10, description: "q" }, num: { type: "integer", minimum: 1, maximum: 10 }, chain: { type: "string", enum: ["base", "solana"] }, urls: { type: "array", maxItems: 2, items: { type: "string" } }, flag: { type: "boolean" }, weird: { type: "object" } } });
const Z = (await import("zod")).z.object(shape);
check(Z.safeParse({ query: "x" }).success && !Z.safeParse({}).success && !Z.safeParse({ query: "x", num: 11 }).success && !Z.safeParse({ query: "x", chain: "tron" }).success && !Z.safeParse({ query: "x", urls: ["a", "b", "c"] }).success && Z.safeParse({ query: "x", flag: true, weird: { any: 1 } }).success, "JSON schema becomes a zod shape: required, ranges, enums, array caps; unknown types pass through");
check(shape.query!.description === "q", "descriptions carry over");
const ws = TOLLKIT_TOOLS_SNAPSHOT.tools.find((t) => t.name === "web_search")!;
check(/Costs \$0\.003 per call/.test(describeTool(ws)) && /weekly budget/.test(describeTool(ws)) && /never charged/.test(describeTool(ws)), "the description states the price, the budget and that failures are free", describeTool(ws));

// ── Over MCP: offered to connected apps, paid through the wallet, budgeted per app; not in the in-app chat.
const PR = { x402Version: 2, resource: { url: "https://web.tollkit.dev/read", description: "Read", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "2000", payTo: "0xBbfCE2D320dE6aB328Ba93A771c531ebFC9cE704", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] };
let paidCalls = 0, lastBody: any = null;
const seller = (async (u: any, init?: RequestInit) => {
  const req = new Request(u, init), url = req.url;
  if (url === CATALOG_URL) return Response.json(live);
  if (url === "https://web.tollkit.dev/read") {
    if (!req.headers.get("payment-signature")) return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(PR)).toString("base64"), "content-type": "application/json" } });
    paidCalls++; lastBody = await req.json();
    return Response.json({ title: "Hello", text: "page text" }, { headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0x1" })).toString("base64") } });
  }
  if (/\/health|\/check/.test(url)) return Response.json({ status: "ok" });
  return new Response("nope", { status: 404 });
}) as unknown as typeof fetch;
const w = await TollkitWallet.open(PW, { dir, fetch: seller, proxy: "https://p.example", execute: async () => "0xswap" });
(w.sanctions as any).isSanctioned = async () => false;
(w as any).o.checkSeller = undefined;
const connect = async (name: string, advisor = false) => { const c = new Client({ name, version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await buildServer(w, { advisor }).connect(a); await c.connect(b); return c; };
const claude = await connect("claude-ai");
const names = (await claude.listTools()).tools.map((t) => t.name);
check(names.includes("tollkit_read_page") && names.includes("tollkit_web_search") && names.includes("tollkit_sec_financials") && names.filter((n) => n.startsWith("tollkit_")).length >= 25, "a connected app sees Tollkit's tools by name", names.filter((n) => n.startsWith("tollkit_")).length);
const adv = await connect("x", true);
check(!(await adv.listTools()).tools.some((t) => t.name.startsWith("tollkit_")), "Tollkit AI (in-app chat) doesn't get the paid tools");
const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await claude.callTool({ name, arguments: args })).content as any)[0].text);
const miss = await claude.callTool({ name: "tollkit_read_page", arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
check(miss.isError === true, "a missing required field is refused before any call");
// The seller check is skipped for tollkit.dev hosts? No: pay() runs it; the fake fetch answers the check with ok.
const r1 = await call("tollkit_read_page", { url: "https://example.com/a" });
check(r1.paid === true && r1.cost_usd === 0.002 && r1.result?.title === "Hello" && paidCalls === 1 && lastBody?.url === "https://example.com/a", "a call pays $0.002 from the wallet and returns the tool's answer", r1);
check(entries(dir).find((e) => e.id === r1.receipt_id)?.by === "Claude" && entries(dir).find((e) => e.id === r1.receipt_id)?.seller === "web.tollkit.dev", "the receipt says by Claude and names the seller");
setBudget(dir, "Claude", 0.003);
const r2 = await call("tollkit_read_page", { url: "https://example.com/b" });
check(r2.paid === false && r2.refused?.code === "over_app_budget" && paidCalls === 1, "Claude's weekly budget stops the next call before it's paid", r2);
setBudget(dir, "Claude", null);

console.log(`\ntollkit-tools: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
