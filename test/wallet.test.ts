/** The wallet object: swaps through limits and approvals, receipts, policy changes. Fake quote service; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";
import { AbiCoder, Interface } from "ethers";
// A real-shaped 0x AllowanceHolder.exec call (as decoded from a live Base quote, 2026-10-14), so the wallet's calldata check passes.
const SETTLER = "0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059";
const zxData = (sellTok: string, sell: string, taker: string, buyTok: string, min: string) => new Interface(["function exec(address,address,uint256,address,bytes)"]).encodeFunctionData("exec", [SETTLER, sellTok, sell, SETTLER,
  "0x1fff991f" + AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256"], [taker, buyTok, min]).slice(2) + "00".repeat(96)]);

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

async function fresh(over: any = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tww-"));
  await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
  const sent: string[] = [];
  const quotes = (async (u: string) => {
    const url = new URL(u);
    if (url.pathname.endsWith("/swap/solana/order")) {
      return Response.json({ inAmount: url.searchParams.get("amount"), outAmount: "92000000", otherAmountThreshold: "91000000", feeBps: 50, platformFee: { feeBps: 50, feeMint: WSOL }, referralAccount: "GaezRGEobGTMVrisPn9oXqPpXawXEBhaSGTWpWZwn1g4", transaction: "AAAA", requestId: "r1", swapUsdValue: 9.99 });
    }
    const sell = url.searchParams.get("sellAmount")!; const buyTok = url.searchParams.get("buyToken")!;
    const isUsdcOut = buyTok.toLowerCase() === USDC.toLowerCase();
    return Response.json({ sellAmount: sell, buyAmount: isUsdcOut ? "3000000" : "12000000000000000", minBuyAmount: isUsdcOut ? "2970000" : "11880000000000000",
      fees: { integratorFee: { amount: String(BigInt(sell) * 50n / 10000n) } }, transaction: { to: ALLOWANCE_HOLDER, data: zxData(url.searchParams.get("sellToken")!, sell, url.searchParams.get("taker")!, buyTok, isUsdcOut ? "2970000" : "11880000000000000"), value: "0" } });
  }) as unknown as typeof fetch;
  const w = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", approve: null, execute: async (q) => { sent.push(q.sell_amount); return "0xswap"; }, ...over });
  return { w, sent, dir };
}

{
  const { w, sent } = await fresh();
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "10000000", slippage_bps: 50 });
  check(r.ok && r.tx === "0xswap" && r.quote?.usd_value === 10 && Math.abs(r.quote.fee_usd! - 0.05) < 1e-9, "swap $10 USDC -> WETH: sent, $0.05 fee recorded", r);
  const e = w.receipts();
  check(e.length === 1 && e[0]!.kind === "trade" && e[0]!.status === "done" && e[0]!.fee_usd === 0.05, "trade receipt with fee", e);
  check(w.status().spent_today.trades_usd === 10, "spent today counts it");
  check(w.receiptsCsv().includes("0xswap"), "CSV export has it");
  check(sent.length === 1, "executed once");
}
{
  const { w, sent } = await fresh();
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "60000000", slippage_bps: 50 });
  check(!r.ok && r.refused?.code === "over_per_limit" && sent.length === 0, "$60 vs $50 per-trade limit: refused, nothing signed", r.refused);
  const s = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "1000000", slippage_bps: 500 });
  check(s.refused?.code === "slippage", "slippage over the owner's max: refused");
}
{
  const { w, sent } = await fresh();
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "30000000", slippage_bps: 50 });
  check(r.refused?.code === "needs_approval" && sent.length === 0, "$30 over the $25 approval line with no Telegram: refused", r.refused);
}
{
  let asked = "";
  const { w, sent } = await fresh({ approve: async (t: string) => { asked = t; return "approved"; } });
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "30000000", slippage_bps: 50 });
  check(r.ok && sent.length === 1 && /Swap \$30\.00/.test(asked) && /Tollkit fee 0\.5%/.test(asked), "$30 approved on Telegram: traded; message shows amount and fee", asked);
}
{
  const { w } = await fresh({ approve: async () => "denied" });
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "30000000", slippage_bps: 50 });
  check(r.refused?.code === "denied", "denied: not traded");
}
{
  const { w } = await fresh();
  const r = await w.quote({ chain: "base", sell_token: WETH, buy_token: "0x0000000000000000000000000000000000000abc", sell_amount: "1000000000000000", slippage_bps: 50 });
  check(r.ok && r.quote?.usd_value === 3, "non-stable pair priced against USDC", r);
  const s = await w.quote({ chain: "solana", sell_token: WSOL, buy_token: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", sell_amount: "100000000", slippage_bps: 50 });
  check(s.ok && s.quote?.usd_value === 9.99, "Solana non-stable pair priced from Jupiter's USD value", s);
}
{
  const { w } = await fresh({ execute: async () => { throw new Error("reverted"); } });
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "10000000", slippage_bps: 50 });
  check(!r.ok && r.refused?.code === "swap_failed" && w.receipts()[0]!.status === "failed" && w.status().spent_today.trades_usd === 0, "failed swap: receipt failed, budget released", r);
}
{
  const { w, dir } = await fresh();
  let msg = ""; try { w.setPolicy("not the password", { ...w.policy, per_trade_usd: 1e6 }); } catch (e: any) { msg = e.message; }
  check(msg === "wrong password", "limits can't change without the password");
  w.setPolicy(PW, { ...w.policy, chains: ["solana"] });
  const r = await w.swap({ chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "1000000", slippage_bps: 50 });
  check(r.refused?.code === "chain_off", "owner turns Base off: Base trades refused");
  const again = await TollkitWallet.open(PW, { dir });
  check(again.policy.chains.join() === "solana", "policy change persists");
  let m2 = ""; try { await TollkitWallet.open("wrong password!!", { dir }); } catch (e: any) { m2 = e.message; }
  check(m2 === "wrong password", "wrong password can't open the wallet");
}

console.log(`\nwallet: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
