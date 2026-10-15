/** Core tests: keystore, policy seal, budgets under parallel calls, receipts, sanctions, Telegram, seller check. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeystore, unlock, addresses } from "../src/keystore.js";
import { DEFAULT_POLICY, loadPolicy, savePolicy } from "../src/policy.js";
import { reserve, settle, entries, exportCsv, spentToday, LimitError } from "../src/ledger.js";
import { Sanctions } from "../src/sanctions.js";
import { requestApproval } from "../src/telegram.js";
import { checkSeller } from "../src/seller.js";
import { files } from "../src/paths.js";
import { getQuote, vetQuote } from "../src/swap.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "tw-"));
const FAST = { N: 1 << 10, r: 8, p: 1 };
const PW = "correct horse battery";

// --- keystore
{
  const dir = tmp();
  const a = await createKeystore(PW, { dir, scrypt: FAST });
  check(/^0x[0-9a-fA-F]{40}$/.test(a.evm) && a.solana.length >= 32, "creates EVM + Solana addresses", a);
  check(JSON.stringify(addresses(dir)) === JSON.stringify({ evm: a.evm, solana: a.solana }) && a.phrase?.split(" ").length === 12, "addresses readable without password; new wallets come with a 12-word phrase");
  const raw = readFileSync(files(dir).keystore, "utf8");
  check(!raw.includes("privateKey") && !/[0-9a-f]{128}/.test(JSON.parse(raw).solana.ct.slice(0, 10) + "x"), "no plaintext key in the file");
  const k = await unlock(PW, dir);
  check(k.evm.address === a.evm && k.solana.publicKey.toBase58() === a.solana, "unlocks to the same keys");
  let msg = ""; try { await unlock("wrong password here", dir); } catch (e: any) { msg = e.message; }
  check(msg === "wrong password", "wrong password refused", msg);
  msg = ""; try { await createKeystore(PW, { dir, scrypt: FAST }); } catch (e: any) { msg = e.message; }
  check(/already exists/.test(msg), "never overwrites a wallet");
  msg = ""; try { await createKeystore("short", { dir: tmp(), scrypt: FAST }); } catch (e: any) { msg = e.message; }
  check(/12 characters/.test(msg), "short password refused");
}

// --- policy seal
{
  const dir = tmp();
  const p = loadPolicy(PW, dir);
  check(p.per_trade_usd === DEFAULT_POLICY.per_trade_usd, "defaults written on first load");
  savePolicy(PW, { ...p, daily_trades_usd: 500 }, dir);
  check(loadPolicy(PW, dir).daily_trades_usd === 500, "owner can change it with the password");
  const f = files(dir).policy;
  const j = JSON.parse(readFileSync(f, "utf8")); j.policy.daily_trades_usd = 999999; writeFileSync(f, JSON.stringify(j));
  let msg = ""; try { loadPolicy(PW, dir); } catch (e: any) { msg = e.message; }
  check(/changed outside the wallet/.test(msg), "hand-edited policy is refused", msg);
  msg = ""; try { loadPolicy("another password!!", tmp()); savePolicy(PW, p, dir); loadPolicy("another password!!", dir); } catch (e: any) { msg = e.message; }
  check(/changed outside/.test(msg), "wrong password can't validate the policy");
}

// --- budgets hold under parallel calls (the ElizaOS bug: 10 x $1 vs $5/day)
{
  const dir = tmp();
  const p = { ...DEFAULT_POLICY, per_payment_usd: 1, daily_payments_usd: 5, per_seller_daily_usd: 100 };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(p, "payment", 1, { seller: "a.example" }, dir)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  check(ok === 5, "10 parallel $1 payments vs $5/day: exactly 5 pass", ok);
  check(results.some((r) => r.status === "rejected" && (r.reason as LimitError).code === "over_daily_limit"), "the rest are refused as over the daily limit");
  const ids = entries(dir).map((e) => e.id);
  settle(ids[0]!, { status: "failed", reason: "seller 500" }, dir);
  check(Math.abs(spentToday("payment", dir) - 4) < 1e-9, "a failed payment frees its budget");
  const per = await reserve(p, "payment", 2, {}, dir).catch((e) => e.code);
  check(per === "over_per_limit", "per-payment limit", per);
  const p2 = { ...p, daily_payments_usd: 100, per_seller_daily_usd: 1.5 };
  await reserve(p2, "payment", 1, { seller: "b.example" }, dir);
  const s = await reserve(p2, "payment", 1, { seller: "b.example" }, dir).catch((e) => e.code);
  check(s === "over_seller_limit", "per-seller daily limit", s);
  const t = await reserve({ ...p, per_trade_usd: 50, daily_trades_usd: 60 }, "trade", 40, { tool: "swap" }, dir);
  const t2 = await reserve({ ...p, per_trade_usd: 50, daily_trades_usd: 60 }, "trade", 40, { tool: "swap" }, dir).catch((e) => e.code);
  check(typeof t === "string" && t2 === "over_daily_limit", "trades have their own daily limit", t2);
  settle(t, { status: "done", tx: "0xabc", fee_usd: 0.2, detail: "40 USDC -> ETH" }, dir);
  const csv = exportCsv(dir);
  check(csv.split("\n")[0]!.startsWith("ts,kind,status,usd,fee_usd") && csv.includes("0xabc") && csv.includes("seller 500"), "CSV receipts include trades, fees and failures");
}

// --- sanctions
{
  const dir = tmp();
  let calls = 0;
  const lists: Record<string, string> = {
    ETH: "0x8589427373D6D84E98730D7795D8f6f8731FDA16\n0x722122dF12D4e14e13Ac3b6895a86e84145b6967\n",
    SOL: "SanctionedSoLAddr1111111111111111111111111\n",
  };
  const fake = (async (u: string) => {
    calls++;
    const sym = /addresses_([A-Z]+)\.txt/.exec(u)?.[1] ?? "";
    return lists[sym] ? new Response(lists[sym]) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const s = new Sanctions(dir, fake);
  check(await s.isSanctioned("0x722122df12d4e14e13ac3b6895a86e84145b6967"), "EVM match is case-insensitive");
  check(!(await s.isSanctioned("0x0000000000000000000000000000000000000001")), "clean EVM address passes");
  check(await s.isSanctioned("SanctionedSoLAddr1111111111111111111111111"), "Solana match");
  const before = calls; await s.isSanctioned("0x1"); check(calls === before, "cached for 24 h");
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  let msg = ""; try { await new Sanctions(tmp(), down).isSanctioned("0x1"); } catch (e: any) { msg = e.message; }
  check(/paused/.test(msg), "no list and no cache: refuse rather than skip screening", msg);
  check(await new Sanctions(dir, down, () => Date.now() + 2 * 86400_000).isSanctioned("0x722122df12d4e14e13ac3b6895a86e84145b6967"), "offline with a stale cache keeps the last list");
}

// --- telegram approvals
{
  const sent: any[] = [];
  const make = (answer: "y" | "n" | null, staleTap = false) => {
    let nonce = "";
    return (async (url: string, init: any) => {
      const m = url.split("/").pop()!; const b = JSON.parse(init.body);
      sent.push(m);
      if (m === "sendMessage") { nonce = /tw:([0-9a-f]+):/.exec(b.reply_markup.inline_keyboard[0][0].callback_data)![1]!; return Response.json({ ok: true, result: { message_id: 7 } }); }
      if (m === "getUpdates") {
        if (!nonce) return Response.json({ ok: true, result: staleTap ? [{ update_id: 1, callback_query: { id: "old", data: "tw:aaaaaaaaaaaa:y", message: { chat: { id: 42 } } } }] : [] });
        if (answer === null) return Response.json({ ok: true, result: [] });
        return Response.json({ ok: true, result: [
          { update_id: 5, callback_query: { id: "x", data: `tw:${nonce}:y`, message: { chat: { id: 999 } } } }, // other chat: ignored
          { update_id: 6, callback_query: { id: "q", data: `tw:${nonce}:${answer}`, message: { chat: { id: 42 } } } },
        ] });
      }
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;
  };
  const cfg = { token: "T", chat_id: "42" };
  check(await requestApproval(cfg, "Swap $40?", { fetch: make("y") }) === "approved", "Approve tap approves");
  check(await requestApproval(cfg, "Swap $40?", { fetch: make("n") }) === "denied", "Deny tap denies");
  check(await requestApproval(cfg, "Swap $40?", { fetch: make(null, true), timeoutMs: 1500 }) === "timeout", "no tap (and an old queued tap) = not approved");
}

// --- seller check
{
  const ok = (async () => Response.json({ offers: [{ pay_to: "0xAbC" }], signals: [{ code: "payer_history", level: "caution", detail: "x" }] })) as unknown as typeof fetch;
  const v = await checkSeller("https://s.example/a", "0xabc", ok);
  check(v.ok && v.cautions.length === 1, "matching pay-to with cautions passes", v);
  const w = await checkSeller("https://s.example/a", "0xEVIL", ok);
  check(!w.ok && w.warnings[0]!.code === "pay_to_mismatch", "pay-to that differs from the seller's quote is a warning");
  const bad = (async () => Response.json({ offers: [], signals: [{ code: "pay_to_differs_from_listing", level: "warning", detail: "x" }] })) as unknown as typeof fetch;
  check(!(await checkSeller("https://s.example/b", "0x1", bad)).ok, "seller warnings block");
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  const d = await checkSeller("https://s.example/c", "0x1", down);
  check(d.ok && !d.checked, "check service down: advisory, doesn't block");
  let n = 0;
  const counted = (async () => { n++; return Response.json({ offers: [{ pay_to: "0xAbC" }], signals: [] }); }) as unknown as typeof fetch;
  await checkSeller("https://s.example/y", "0xabc", counted); await checkSeller("https://s.example/y", "0xabc", counted);
  const again = await checkSeller("https://s.example/y", "0xEVIL", counted);
  check(n === 1 && !again.ok, "a seller is checked once per 10 minutes; the pay-to is still compared every time", n);
}


// --- swap quotes (0x via proxy) and the checks before signing
{
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  let seen = "";
  const zx = (over: any = {}) => (async (u: string) => { seen = u; return Response.json({
    sellAmount: "40000000", buyAmount: "12000000000000000", minBuyAmount: "11880000000000000",
    fees: { integratorFee: { amount: "200000", token: USDC }, zeroExFee: { amount: "60000", token: USDC.toLowerCase() } },
    issues: { allowance: { spender: ALLOWANCE_HOLDER, actual: "0" } },
    transaction: { to: ALLOWANCE_HOLDER, data: "0xdead", value: "0", gas: "300000" }, ...over }); }) as unknown as typeof fetch;
  const req = { chain: "base" as const, sell_token: USDC, buy_token: WETH, sell_amount: "40000000", slippage_bps: 100 };
  const q = await getQuote(req, "0xTaker", { fetch: zx(), proxy: "https://p.example" });
  check(/chainId=8453/.test(seen) && /taker=0xTaker/.test(seen) && /slippageBps=100/.test(seen), "quote request has chain, taker, slippage", seen);
  check(q.fee_bps === 50 && q.usd_value === 40 && Math.abs(q.fee_usd! - 0.2) < 1e-9, "0.5% fee and $40 value read from the quote", q);
  check(vetQuote(q, req) === null, "a clean quote passes");
  check(q.venue_fee_bps === 15, "0x's own 0.15% is read and shown separately", q.venue_fee_bps);
  const greedy = await getQuote(req, "0xT", { fetch: zx({ fees: { integratorFee: { amount: "400000" } } }), proxy: "https://p.example" });
  check(/fee/.test(vetQuote(greedy, req) ?? ""), "a fee above 0.5% is refused");
  const evilTo = await getQuote(req, "0xT", { fetch: zx({ transaction: { to: "0x000000000000000000000000000000000000beef", data: "0x1" } }), proxy: "https://p.example" });
  check(/not 0x AllowanceHolder/.test(vetQuote(evilTo, req) ?? ""), "a transaction to any other contract is refused");
  const evilApprove = await getQuote(req, "0xT", { fetch: zx({ issues: { allowance: { spender: "0x000000000000000000000000000000000000beef" } } }), proxy: "https://p.example" });
  check(/only 0x AllowanceHolder/.test(vetQuote(evilApprove, req) ?? ""), "approving any other spender is refused");
  const noMin = await getQuote(req, "0xT", { fetch: zx({ minBuyAmount: "0" }), proxy: "https://p.example" });
  check(/minimum/.test(vetQuote(noMin, req) ?? ""), "no minimum output is refused");
  const other = await getQuote({ ...req, sell_token: WETH, buy_token: "0x0000000000000000000000000000000000000abc" }, "0xT", { fetch: zx(), proxy: "https://p.example" });
  check(other.usd_value === null, "non-stable pair: value left for the caller to price");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
