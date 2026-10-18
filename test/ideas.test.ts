/** Trade ideas: Claude suggests one swap, the owner taps Approve or Dismiss. Fake quote service; no network. */
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

import { writeFileSync } from "node:fs";
import { proposeSwap, IdeaStore, IDEA_TTL_MS } from "../src/ideas.js";
import { ADVISOR_TOOLS, buildServer } from "../src/mcp.js";
import { AiAssistant, type Runner } from "../src/ai.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  const r: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "10", reason: "A small first buy." });
  const i = w.ideas().get(r.idea?.id ?? "");
  check(r.ok && i?.status === "proposed" && i.sell === "USDC" && i.buy === "WETH" && i.est.usd === 10 && i.reason === "A small first buy.", "a suggested swap becomes a waiting idea with its quote", r);
  check(sent.length === 0 && w.receipts().length === 0, "suggesting trades nothing");
  const done = await w.ideas().approve(i!.id, w);
  check(done.status === "done" && done.result?.tx === "0xswap" && sent.length === 1 && w.receipts().at(-1)?.status === "done", "Approve trades it once, with a receipt", done);
  let again = ""; try { await w.ideas().approve(i!.id, w); } catch (e) { again = (e as Error).message; }
  check(/already done/.test(again) && sent.length === 1, "a second tap can't trade it twice", again);
}
{
  const { w, sent } = await fresh();
  const r: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "60" });
  check(!r.ok && r.refused.code === "over_per_limit" && w.ideas().list().length === 0, "over the per-trade limit: refused up front, no card", r);
  const r2: any = await proposeSwap(w, { chain: "solana", sell: "USDC", buy: "SOL", amount: "5" });
  check(r2.ok, "Solana idea", r2);
  const off: any = await proposeSwap(w, { chain: "polygon", sell: "USDC", buy: "POL", amount: "5" });
  check(!off.ok && off.refused.code === "chain_off", "a network the owner hasn't turned on: refused", off);
  // $30 is over the $25 approval line and Telegram isn't set up: the owner's tap counts as the approval.
  const big: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "30" });
  const d = await w.ideas().approve(big.idea.id, w);
  check(d.status === "done" && sent.length === 1, "over the approval line: the owner's tap is the approval", d);
  const direct = await w.swap({ chain: "base", sell_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", buy_token: "0x4200000000000000000000000000000000000006", sell_amount: "30000000", slippage_bps: 50 });
  check(direct.refused?.code === "needs_approval", "an agent's own $30 swap still needs approval", direct.refused);
}
{
  const { w, sent } = await fresh();
  const r: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "5" });
  const x = await w.ideas().dismiss(r.idea.id);
  let msg = ""; try { await w.ideas().approve(r.idea.id, w); } catch (e) { msg = (e as Error).message; }
  check(x.status === "dismissed" && /dismissed/.test(msg) && sent.length === 0, "dismissed: can't be approved later", msg);
  const r2: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "5" });
  const later = new IdeaStore(w.dir, () => Date.now() + IDEA_TTL_MS + 1000);
  let ex = ""; try { await later.approve(r2.idea.id, w); } catch (e) { ex = (e as Error).message; }
  check(later.get(r2.idea.id)?.status === "expired" && /expired/.test(ex) && sent.length === 0, "after 15 minutes it expires and can't trade", ex);
}
{
  const { w } = await fresh({ execute: async () => { throw new Error("RPC said no"); } });
  const r: any = await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "5" });
  const f = await w.ideas().approve(r.idea.id, w);
  check(f.status === "failed" && /RPC said no/.test(f.result?.reason ?? ""), "a failed swap shows why", f);
}
{
  // Only the wallet's own chat gets swap_propose; connected agents keep `swap` (with approvals).
  const { w } = await fresh();
  const names = async (advisor: boolean) => {
    const c = new Client({ name: "t", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer(w, { advisor }).connect(a); await c.connect(b);
    const n = (await c.listTools()).tools.map((t) => t.name); await c.close(); return n;
  };
  const adv = await names(true), all = await names(false);
  check(adv.includes("swap_propose") && !adv.includes("swap") && ADVISOR_TOOLS.includes("swap_propose"), "the chat can suggest swaps but not make them", adv);
  check(!all.includes("swap_propose") && all.includes("swap"), "MCP agents don't get swap_propose", all);
}
{
  // The chat attaches the cards to Claude's reply.
  const { w, dir } = await fresh();
  writeFileSync(path.join(dir, "password"), PW, { mode: 0o600 });
  const runner: Runner = async () => { await proposeSwap(w, { chain: "base", sell: "USDC", buy: "WETH", amount: "20", reason: "You asked for $20 of ETH." }); return { text: "Here's the swap. It's waiting below.", sessionId: "s" }; };
  const ai = new AiAssistant(w, { dir, runner });
  const m = await ai.send("buy $20 of eth");
  check(m.swaps?.length === 1 && w.ideas().get(m.swaps[0]!)?.status === "proposed", "the suggested swap is attached to the reply", m);
}

console.log(`\nideas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
