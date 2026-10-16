/** Ethereum mainnet sends go through Flashbots Protect (via Tollkit); reads and Base stay on the normal RPC. Local fakes only. */
import { createServer } from "node:http";
import { Transaction, Wallet, JsonRpcProvider } from "ethers";
import { ProtectedProvider, sendingProvider, waitMined } from "../src/evmsend.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

// A stand-in for the normal RPC: answers reads, records any send that reaches it (none should).
const rpcSeen: string[] = [];
const srv = createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { const m = JSON.parse(b); const one = (x: any) => { rpcSeen.push(x.method); const res: any = { eth_chainId: "0x1", eth_blockNumber: "0x10", net_version: "1" }; return { jsonrpc: "2.0", id: x.id, result: res[x.method] ?? null }; }; r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m))); }); }).listen(17490);
const url = "http://127.0.0.1:17490";

const w = Wallet.createRandom();
const signed = await w.signTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: 1n, type: 2 });
const hash = Transaction.from(signed).hash!;
let sentTo = "", sentBody: any = null;
const f = (async (u: string, init: any) => { sentTo = u; sentBody = JSON.parse(init.body); return Response.json({ jsonrpc: "2.0", id: 1, result: hash }); }) as unknown as typeof fetch;

const p = sendingProvider("ethereum", { rpc: { ethereum: url }, proxy: "https://p.example/wallet", fetch: f });
check(p instanceof ProtectedProvider, "Ethereum mainnet: a protected provider");
check(!(sendingProvider("base", { rpc: { base: url } }) instanceof ProtectedProvider) && sendingProvider("base", { rpc: { base: url } }) instanceof JsonRpcProvider, "Base: the normal RPC");
const tx = await p.broadcastTransaction(signed);
check(tx.hash === hash && sentTo === "https://p.example/wallet/rpc/ethereum-protect" && sentBody.method === "eth_sendRawTransaction" && sentBody.params[0] === signed, "the signed transaction goes to Tollkit's Flashbots Protect route", { sentTo, method: sentBody?.method });
check(!rpcSeen.includes("eth_sendRawTransaction") && rpcSeen.includes("eth_blockNumber"), "reads stay on the normal RPC; the send never touches it", rpcSeen);
const bad = new ProtectedProvider(url, "https://p.example/x", (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "tx dropped: priority fee 0" } })) as unknown as typeof fetch);
let msg = ""; try { await bad.broadcastTransaction(signed); } catch (e) { msg = (e as Error).message; }
check(/Flashbots Protect: tx dropped/.test(msg), "a refused send says why", msg);
const late = await waitMined({ hash: "0xabc", wait: async () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } }, "swap", 60_000).then(() => "", (e) => (e as Error).message);
check(/wasn't included within 1 minute. It may still land/.test(late), "not included in time: says it may still land, check before retrying", late);

srv.close();
console.log(`\nevmsend: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
