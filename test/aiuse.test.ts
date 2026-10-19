/** "Which AI is using my wallet": each tool call notes the app's name, and the receipts it makes say who asked. Fake quotes; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zxData } from "./fixtures/zx.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { ALLOWANCE_HOLDER } from "../src/chains.js";
import { buildServer, CLIENT_META } from "../src/mcp.js";
import { appName, readAiUse } from "../src/aiuse.js";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const dir = mkdtempSync(path.join(os.tmpdir(), "twai-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const quotes = (async (u: string) => { const url = new URL(u); const sell = url.searchParams.get("sellAmount")!;
  return Response.json({ sellAmount: sell, buyAmount: "1", minBuyAmount: "1", fees: { integratorFee: { amount: String(BigInt(sell) * 50n / 10000n) } }, transaction: { to: ALLOWANCE_HOLDER, data: zxData(url, "1"), value: "0" } }); }) as unknown as typeof fetch;
const w = await TollkitWallet.open(PW, { dir, fetch: quotes, proxy: "https://p.example", execute: async () => "0xswap" });
(w.sanctions as any).isSanctioned = async () => false;

const connect = async (name: string, advisor = false) => {
  const c = new Client({ name, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(w, { advisor }).connect(a); await c.connect(b);
  return c;
};

check(appName("claude-ai") === "Claude" && appName("claude-code") === "Claude Code" && appName("cursor-vscode") === "Cursor" && appName("Visual Studio Code") === "VS Code" && appName("codex-mcp-client") === "Codex" && appName("") === "An AI app" && appName("tollkit-extension-relay") === "An AI app" && appName("my_custom-agent") === "my custom agent", "app names read plainly; unknown ones are kept, tidied");

const claude = await connect("claude-ai");
await claude.callTool({ name: "wallet_status", arguments: {} });
const u1 = readAiUse(dir);
check(u1[0]?.app === "Claude" && u1[0].last_tool === "wallet_status" && u1[0].calls === 1, "a local app that names itself shows as using the wallet", u1);

const r = await claude.callTool({ name: "swap", arguments: { chain: "base", sell: "USDC", buy: "WETH", amount: "1" } });
const out = JSON.parse((r.content as any)[0].text);
const rec = entries(dir).find((e) => e.id === out.receipt_id);
check(out.ok === true && rec?.by === "Claude" && rec.status === "done", "its swap's receipt says Claude asked for it", { out: out.refused ?? out.ok, rec });

const relay = await connect("tollkit-extension-relay");
await relay.callTool({ name: "receipts", arguments: {}, _meta: { [CLIENT_META]: "openai-mcp" } });
check(readAiUse(dir)[0]?.app === "ChatGPT", "an app that came in by the connector address is named by the relay, not as the relay", readAiUse(dir)[0]);
await relay.callTool({ name: "receipts", arguments: {} });
check(readAiUse(dir)[0]?.app === "An AI app", "with no name at all it still shows, as 'An AI app'");

const advisor = await connect("claude-code", true);
await advisor.callTool({ name: "wallet_status", arguments: {} });
check(readAiUse(dir).some((x) => x.app === "Tollkit AI") && readAiUse(dir).find((x) => x.app === "Claude")!.calls === 2, "the in-app AI chat counts as Tollkit AI, separately");

console.log(`\naiuse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
