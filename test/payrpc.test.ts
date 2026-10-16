/** Paying on Solana uses the wallet's own Solana RPC (the extension's points at Tollkit's route), not a public default. */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { DEFAULT_RPC } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const methods: string[] = [];
const rpc = createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { try { methods.push(JSON.parse(b).method); } catch { /* */ } r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "test rpc" } })); }); }).listen(0);
await new Promise((r) => rpc.once("listening", r));
const old = DEFAULT_RPC.solana;
DEFAULT_RPC.solana = `http://127.0.0.1:${(rpc.address() as any).port}`;
const dir = mkdtempSync(path.join(os.tmpdir(), "twrpc-"));
await createKeystore("pw-rpc-1234567", { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const URL_ = "https://seller.example/ai";
const pr = { x402Version: 2, resource: { url: URL_, description: "t", mimeType: "application/json" }, accepts: [
  { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "20000", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", maxTimeoutSeconds: 60, extra: { feePayer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } }] };
const sellerHits: string[] = [];
const f = (async (u: any, init?: any) => {
  const url = String(u?.url ?? u);
  if (url.includes("/check?")) return Response.json({ signals: [], offers: [] });
  const h = new Headers(init?.headers ?? (u instanceof Request ? u.headers : {}));
  sellerHits.push(h.get("payment-signature") ? "paid" : "probe");
  return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(pr as any) } });
}) as unknown as typeof fetch;
const w = await TollkitWallet.open("pw-rpc-1234567", { dir, fetch: f });
(w as any).sanctions.isSanctioned = async () => false;
const r = await w.pay(URL_, { method: "POST", body: "{}" }, { prefer: ["solana"] });
check(methods.includes("getAccountInfo") && sellerHits.join() === "probe" && !r.paid, "a Solana payment builds through the wallet's own RPC (and stops when that RPC fails)", { methods, sellerHits, refused: r.refused });
DEFAULT_RPC.solana = old; rpc.close();
console.log(`\npayrpc: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
