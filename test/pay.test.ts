/** Payments: x402 and MPP against a fake seller, with every gate exercised. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { Keypair } from "@solana/web3.js";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { Challenge, Receipt, evm as mppEvmServer } from "mppx";
import { payFetch, protocolOf, offerFromMpp, type PayDeps } from "../src/pay.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twp-"));
const keys = { evm: Wallet.createRandom() as any, solana: Keypair.generate() };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x1111111111111111111111111111111111111111";
const URL_ = "https://seller.example/tool?q=1";

function x402Seller(opts: { amount?: string; asset?: string; network?: string; settle?: boolean } = {}) {
  const calls: Request[] = [];
  const pr = {
    x402Version: 2, resource: { url: URL_, description: "t", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: opts.network ?? "eip155:8453", asset: opts.asset ?? USDC, amount: opts.amount ?? "10000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
  };
  const f = (async (input: any, init?: any) => {
    const req = new Request(input, init); calls.push(req);
    const sig = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
    if (!sig) return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(pr as any) } });
    if (opts.settle === false) return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(pr as any) } });
    return Response.json({ ok: true }, { headers: { "payment-response": encodePaymentResponseHeader({ success: true, transaction: "0xtxhash", network: "eip155:8453" } as any) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const deps = (over: Partial<PayDeps> = {}): PayDeps => ({
  dir: tmp(), policy: { ...DEFAULT_POLICY }, sanctions: { isSanctioned: async () => false },
  checkSeller: async () => ({ ok: true, warnings: [], cautions: [], quoted_pay_to: [SELLER], checked: true }),
  approve: null, ...over,
});

// --- x402 happy path
{
  const s = x402Seller(); const d = deps({ fetch: s.f });
  const r = await payFetch(URL_, undefined, keys, d);
  check(r.paid && r.status === 200 && r.tx === "0xtxhash", "x402: pays $0.01 on Base and gets the result", r.refused);
  check(s.calls.length === 2 && !!s.calls[1]!.headers.get("payment-signature"), "x402: exactly one probe and one paid request", s.calls.length);
  const e = entries(d.dir);
  check(e.length === 1 && e[0]!.status === "done" && e[0]!.usd === 0.01 && e[0]!.tx === "0xtxhash" && e[0]!.seller === "seller.example", "x402: receipt written as done", e);
}
// --- free endpoint passes through
{
  const f = (async () => Response.json({ free: true })) as unknown as typeof fetch;
  const r = await payFetch(URL_, undefined, keys, deps({ fetch: f }));
  check(!r.paid && r.status === 200, "free endpoint: no payment");
}
// --- limits
{
  const s = x402Seller({ amount: "300000" }); const d = deps({ fetch: s.f });
  const r = await payFetch(URL_, undefined, keys, d);
  check(!r.paid && r.refused?.code === "over_per_limit" && s.calls.length === 1, "x402: $0.30 vs $0.25 per-payment limit is refused before signing", r.refused);
  check(entries(d.dir).length === 0, "refused payment leaves no receipt");
}
{
  const d = deps({ policy: { ...DEFAULT_POLICY, daily_payments_usd: 0.025, per_seller_daily_usd: 1 } });
  let paid = 0;
  for (let i = 0; i < 4; i++) { const s = x402Seller(); const r = await payFetch(URL_, undefined, keys, { ...d, fetch: s.f }); if (r.paid) paid++; }
  check(paid === 2, "x402: daily limit $0.025 allows two $0.01 payments, not four", paid);
}
// --- sanctions, seller check, approvals
{
  const s = x402Seller();
  const r = await payFetch(URL_, undefined, keys, deps({ fetch: s.f, sanctions: { isSanctioned: async (a) => a === SELLER } }));
  check(r.refused?.code === "sanctioned" && s.calls.length === 1, "sanctioned recipient is refused", r.refused);
}
{
  const warn = async () => ({ ok: false, warnings: [{ code: "pay_to_mismatch", level: "warning" as const, detail: "bad pay-to" }], cautions: [], quoted_pay_to: [], checked: true });
  const s = x402Seller();
  const r = await payFetch(URL_, undefined, keys, deps({ fetch: s.f, checkSeller: warn }));
  check(r.refused?.code === "seller_warning", "seller warning blocks by default", r.refused);
  let asked = "";
  const s2 = x402Seller();
  const r2 = await payFetch(URL_, undefined, keys, deps({ fetch: s2.f, checkSeller: warn, policy: { ...DEFAULT_POLICY, block_seller_warnings: false }, approve: async (t) => { asked = t; return "approved"; } }));
  check(r2.paid && /seller check warned/.test(asked), "with blocking off, a warning goes to the owner and can be approved", asked);
}
{
  const pol = { ...DEFAULT_POLICY, approval_above_usd: 0.005 };
  const r = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller().f, policy: pol }));
  check(r.refused?.code === "needs_approval", "needs approval but no Telegram: refused", r.refused);
  const r2 = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller().f, policy: pol, approve: async () => "denied" }));
  check(r2.refused?.code === "denied", "owner denies: not paid");
  const r3 = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller().f, policy: pol, approve: async () => "timeout" }));
  check(r3.refused?.code === "approval_timeout", "no answer in time: not paid");
  const r4 = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller().f, policy: pol, approve: async () => "approved" }));
  check(r4.paid, "owner approves: paid");
}
// --- what the wallet won't pay with
{
  const r = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller({ asset: "0x4200000000000000000000000000000000000006" }).f }));
  check(!r.paid && r.refused?.code === "no_payable_offer", "non-stablecoin asset: refused", r.refused);
  const r2 = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller({ network: "eip155:137" }).f }));
  check(!r2.paid && r2.refused?.code === "no_payable_offer", "unsupported chain: refused", r2.refused);
  const r3 = await payFetch(URL_, undefined, keys, deps({ fetch: x402Seller().f, policy: { ...DEFAULT_POLICY, chains: ["solana"] } }));
  check(!r3.paid, "Base payment with Base turned off: refused", r3.refused);
}
// --- seller takes the signature but doesn't settle
{
  const d = deps({ fetch: x402Seller({ settle: false }).f });
  const r = await payFetch(URL_, undefined, keys, d);
  const e = entries(d.dir);
  check(!r.paid && e.length === 1 && e[0]!.status === "failed", "unsettled payment: receipt marked failed, budget released", e);
}

// --- MPP (evm charge on Base)
function mppSeller(amount = "0.01") {
  const calls: Request[] = [];
  const ch = Challenge.fromMethod(mppEvmServer.charge as any, { id: "c1", realm: "seller.example", request: { amount, chainId: 8453, currency: USDC, decimals: 6, recipient: SELLER } } as any);
  const f = (async (input: any, init?: any) => {
    const req = new Request(input, init); calls.push(req);
    if (!req.headers.get("authorization")) return new Response("{}", { status: 402, headers: { "www-authenticate": Challenge.serialize(ch as any) } });
    return Response.json({ ok: true }, { headers: { "payment-receipt": Receipt.serialize({ method: "evm", reference: "0xmpptx", status: "success", timestamp: new Date().toISOString() } as any) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
{
  const s = mppSeller(); const d = deps({ fetch: s.f });
  const r = await payFetch(URL_, undefined, keys, d);
  check(r.paid && r.offer?.protocol === "mpp" && r.tx === "0xmpptx", "MPP: pays an evm charge on Base", r.refused ?? r.status);
  check(/^Payment /i.test(s.calls[s.calls.length - 1]?.headers.get("authorization") ?? ""), "MPP: credential sent in Authorization: Payment");
  check(entries(d.dir)[0]?.status === "done", "MPP: receipt written");
  const big = await payFetch(URL_, undefined, keys, deps({ fetch: mppSeller("1").f }));
  check(big.refused?.code === "over_per_limit", "MPP: $1 vs $0.25 limit refused", big.refused);
}
{
  const o = offerFromMpp({ method: "solana", intent: "charge", request: { amount: "5000", currency: "USDC", recipient: "So1", methodDetails: { network: "mainnet", splits: [{ recipient: "Sp1", amount: "100" }] } } }, URL_);
  check(o.chain === "solana" && o.usd === 0.005 && o.recipients.join() === "So1,Sp1", "MPP Solana: USDC symbol resolved, splits screened too", o);
  let msg = ""; try { offerFromMpp({ method: "solana", intent: "charge", request: { amount: "1", currency: "USDC", recipient: "x", methodDetails: { network: "devnet" } } }, URL_); } catch (e: any) { msg = e.code; }
  check(msg === "unsupported_network", "MPP Solana devnet refused");
  msg = ""; try { offerFromMpp({ method: "evm", intent: "session", request: {} }, URL_); } catch (e: any) { msg = e.code; }
  check(msg === "unsupported_intent", "MPP sessions refused (charges only)");
}
{
  const h = new Headers({ "www-authenticate": 'Payment id="x"' });
  check(protocolOf(new Response("", { status: 402, headers: h }), "") === "mpp", "detects MPP by WWW-Authenticate");
  check(protocolOf(new Response("", { status: 402 }), '{"x402Version":1,"accepts":[]}') === "x402", "detects x402 v1 by body");
  check(protocolOf(new Response("", { status: 402 }), "pay me") === null, "unknown 402 format: not paid");
}

console.log(`\npay: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
