/** AgentKit provider, ElizaOS plugin and MCP server all expose the same actions, inside the same limits. Fake quotes; no network. */
import { mkdtempSync } from "node:fs";
import { zxData } from "./fixtures/zx.js";
import os from "node:os";
import path from "node:path";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";
import { tollkitWalletActionProvider } from "../src/agentkit.js";
import { tollkitWalletPlugin, useWallet, parseJsonObject } from "../src/elizaos.js";
import { buildServer, ADVISOR_TOOLS } from "../src/mcp.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const dir = mkdtempSync(path.join(os.tmpdir(), "twpl-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const quotes = (async (u: string) => { const url = new URL(u); const sell = url.searchParams.get("sellAmount")!;
  return Response.json({ sellAmount: sell, buyAmount: "4000000000000000", minBuyAmount: "3960000000000000", fees: { integratorFee: { amount: String(BigInt(sell) * 50n / 10000n) } }, transaction: { to: ALLOWANCE_HOLDER, data: zxData(url, "3960000000000000"), value: "0" } }); }) as unknown as typeof fetch;
const sent: string[] = [];
const w = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", approve: null, execute: async (q) => { sent.push(q.sell_amount); return "0xswap"; } });

// --- AgentKit
{
  const p = tollkitWalletActionProvider(w);
  const acts = p.getActions({} as any);
  check(acts.length === 30 && acts.every((a) => a.name.startsWith("tollkit_")), "AgentKit: 30 actions, tollkit_ prefix", acts.map((a) => a.name));
  check(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" } as any), "AgentKit: works on any network");
  const swap = acts.find((a) => a.name === "tollkit_swap")!;
  const r = JSON.parse(await swap.invoke({ chain: "base", sell: "USDC", buy: "WETH", amount: "10" }));
  check(r.ok && r.tx === "0xswap" && sent.length === 1, "AgentKit: swap 10 USDC goes through the wallet", r);
  const big = JSON.parse(await swap.invoke({ chain: "base", sell: "USDC", buy: "WETH", amount: "80" }));
  check(big.refused?.code === "over_per_limit" && sent.length === 1, "AgentKit: over the limit is refused", big.refused);
  const badArgs = JSON.parse(await swap.invoke({ chain: "polygon", sell: "USDC" } as any));
  check(badArgs.refused?.code === "bad_request", "AgentKit: bad arguments refused", badArgs);
  check(!acts.some((a) => /withdraw|budget|polic|address/.test(a.name)), "AgentKit: no tool can change limits or withdraw");
  const prop = acts.find((a) => a.name === "tollkit_autopilot_propose")!;
  const pr = JSON.parse(await prop.invoke({ rules: [{ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 10, trigger_price: 1000 }] }));
  check(pr.ok && pr.rules[0].status === "proposed" && /Buy \$10 of ETH/.test(pr.rules[0].description), "AgentKit: an agent's rule waits for the owner", pr);
  const bad = JSON.parse(await prop.invoke({ rules: [{ kind: "stop_loss", chain: "base", token: "ETH", trigger_price: 1000 }] }));
  check(bad.refused?.code === "bad_rule", "AgentKit: incomplete rule refused", bad);
}

// --- ElizaOS
{
  const replies: string[] = [];
  let modelReply = '```json\n{"chain":"base","sell":"USDC","buy":"WETH","amount":"5","slippage_bps":null}\n```';
  const rt = { getSetting: () => null, useModel: async (_t: string, _p: { prompt: string }) => modelReply };
  check(tollkitWalletPlugin.actions!.length === 30 && tollkitWalletPlugin.actions!.some((a) => a.name === "TOLLKIT_SWAP") && tollkitWalletPlugin.actions!.some((a) => a.name === "TOLLKIT_AUTOPILOT_SET"), "Eliza: 30 actions incl. TOLLKIT_SWAP and TOLLKIT_AUTOPILOT_SET");
  const swap = tollkitWalletPlugin.actions!.find((a) => a.name === "TOLLKIT_SWAP")!;
  check(!(await swap.validate(rt as any, {})), "Eliza: not offered when no wallet is configured");
  useWallet(rt as any, w);
  check(await swap.validate(rt as any, {}), "Eliza: offered once a wallet is attached");
  const res = await swap.handler(rt as any, { content: { text: "swap 5 usdc to weth on base" } }, undefined, undefined, async (c) => { replies.push(c.text ?? ""); return []; });
  check(res.success && /Swapped/.test(replies[0] ?? "") && sent.length === 2, "Eliza: swap from a chat message", replies);
  modelReply = '{"chain":"base","sell":"USDC","buy":"WETH","amount":"500"}';
  const over = await swap.handler(rt as any, { content: { text: "swap 500 usdc" } }, undefined, undefined, async (c) => { replies.push(c.text ?? ""); return []; });
  check(!over.success && /per-trade limit/.test(replies[1] ?? ""), "Eliza: limits apply", replies[1]);
  modelReply = "I'm not sure what you mean";
  const vague = await swap.handler(rt as any, { content: { text: "do a trade" } }, undefined, undefined, async (c) => { replies.push(c.text ?? ""); return []; });
  check(!vague.success && /need more detail/.test(replies[2] ?? "") && sent.length === 2, "Eliza: missing details: asks, doesn't trade", replies[2]);
  check(JSON.stringify(parseJsonObject('x ```json\n{"a":1}\n``` y')) === '{"a":1}' && parseJsonObject("nope") === null, "JSON extraction from model replies");
}

// --- MCP uses the same list
{
  const s: any = buildServer(w);
  const names = Object.keys(s._registeredTools ?? {});
  check(names.length === 30 && names.includes("swap") && names.includes("bot_start") && names.includes("setup_request") && names.includes("autopilot_propose") && names.includes("price_history"), "MCP: same 30 tools", names);
  const adv: any = buildServer(w, { advisor: true });
  const an = Object.keys(adv._registeredTools ?? {});
  check(an.length === ADVISOR_TOOLS.length && !an.some((n) => /^(swap|pay_fetch|autopilot_cancel|paper_swap|seller_check)$/.test(n)), "MCP advisor mode: read, prices and suggest only, no trading", an);
  // advisor suggestions wait for the owner even when agents may turn rules on
  w.policy.agent_rules = "auto";
  const res = JSON.parse((await adv._registeredTools.autopilot_propose.handler({ rules: [{ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 10, trigger_price: 1000, reason: "test" }] })).content[0].text);
  check(res.ok && res.rules[0].status === "proposed" && res.rules[0].rule.reason === "test", "advisor: rules stay proposed even with agent_rules=auto", res);
  const full: any = buildServer(w);
  const res2 = JSON.parse((await full._registeredTools.autopilot_propose.handler({ rules: [{ kind: "limit_buy", chain: "base", token: "ETH", amount_usd: 10, trigger_price: 1000 }] })).content[0].text);
  check(res2.ok && res2.rules[0].status === "active", "full server still honours agent_rules=auto", res2.rules?.[0]?.status);
  w.policy.agent_rules = "propose";
}

console.log(`\nplugins: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
