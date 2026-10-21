/** Owner pass: when a tollkit.dev quote asks to pay this wallet itself, sign a pass instead of paying. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet, verifyMessage } from "ethers";
import { Keypair } from "@solana/web3.js";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { payFetch, OWNER_HEADER, type PayDeps } from "../src/pay.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const keys = { evm: Wallet.createRandom() as any, solana: Keypair.generate() };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function seller(url: string, payTo: { evm?: string; sol?: string }) {
  const calls: Request[] = [];
  const accepts = [
    ...(payTo.evm ? [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "20000", payTo: payTo.evm, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] : []),
    ...(payTo.sol ? [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: SOL_USDC, amount: "20000", payTo: payTo.sol, maxTimeoutSeconds: 60, extra: { feePayer: payTo.sol } }] : []),
  ];
  const pr = { x402Version: 2, resource: { url, description: "t", mimeType: "application/json" }, accepts };
  const f = (async (input: any, init?: any) => {
    const req = new Request(input, init); calls.push(req);
    if (req.headers.get(OWNER_HEADER)) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(pr as any) } });
  }) as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch, dir: string): PayDeps => ({
  dir, policy: { ...DEFAULT_POLICY, chains: ["base", "solana"] }, fetch: f,
  sanctions: { check: async () => ({ hit: false }) } as any, checkSeller: async () => ({ ok: true, warnings: [] }) as any, approve: async () => "approved" as any,
});

const dir = mkdtempSync(path.join(os.tmpdir(), "own-"));
const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

{
  const url = "https://api.tollkit.dev/wallet/ai/step";
  const s = seller(url, { evm: keys.evm.address, sol: "HBasGEGD1szEkNCWckRoZg2vZGhzt7yLSixLgSHi3gYf" });
  const r = await payFetch(url, init, keys, deps(s.f, dir));
  const h = s.calls[1]?.headers.get(OWNER_HEADER) ?? "";
  const [chain, addr, ts, sig] = h.split(".");
  check(r.owner === true && r.status === 200 && !r.refused, "EVM payout = this wallet: served with an owner pass", r);
  check(chain === "evm" && addr === keys.evm.address, "pass names the EVM address");
  check(verifyMessage(`TOLLkit owner pass\nPOST /wallet/ai/step\n${ts}`, sig) === keys.evm.address, "signature recovers this wallet");
  check(!s.calls[1]?.headers.get("payment-signature"), "no payment was sent");
  check(s.calls[1]?.headers.get("content-type") === "application/json", "original headers kept");
  check(entries(dir).length === 0, "nothing reserved in the ledger");
}
{
  const url = "https://web.tollkit.dev/read";
  const sol = keys.solana.publicKey.toBase58();
  const s = seller(url, { evm: "0x1111111111111111111111111111111111111111", sol });
  const r = await payFetch(url, init, keys, deps(s.f, dir));
  const h = s.calls[1]?.headers.get(OWNER_HEADER) ?? "";
  check(r.owner === true && h.startsWith(`solana.${sol}.`), "Solana payout = this wallet: Solana owner pass", h);
  const [, , ts, sig] = h.split(".");
  const nacl = (await import("tweetnacl")).default, bs58 = (await import("bs58")).default;
  check(nacl.sign.detached.verify(new TextEncoder().encode(`TOLLkit owner pass\nPOST /read\n${ts}`), bs58.decode(sig), keys.solana.publicKey.toBytes()), "Solana signature verifies");
}
{
  const url = "https://evil.example/wallet/ai/step";
  const s = seller(url, { evm: keys.evm.address });
  await payFetch(url, init, keys, deps(s.f, dir)).catch(() => null);
  check(!s.calls.some((c) => c.headers.get(OWNER_HEADER)), "never sends a pass to a non-tollkit host");
}
{
  const url = "http://api.tollkit.dev/wallet/ai/step";
  const s = seller(url, { evm: keys.evm.address });
  await payFetch(url, init, keys, deps(s.f, dir)).catch(() => null);
  check(!s.calls.some((c) => c.headers.get(OWNER_HEADER)), "never over plain http");
}
{
  const url = "https://api.tollkit.dev/wallet/ai/step";
  const s = seller(url, { evm: "0x1111111111111111111111111111111111111111" });
  await payFetch(url, init, keys, deps(s.f, dir)).catch(() => null);
  check(!s.calls.some((c) => c.headers.get(OWNER_HEADER)), "payout is someone else: normal payment path, no pass");
}
console.log(`\nownerpass: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
