/** Websites through the browser extension: pairing, per-site connections, approvals, signing, sending. Fake network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AbiCoder, Interface, MaxUint256, verifyMessage, verifyTypedData } from "ethers";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";
import { DappBridge, normalOrigin, plainText, signInWarning, solanaWarnings } from "../src/dapp.js";
const USDC_ACCT = Keypair.generate().publicKey;
let OWNER: Buffer = Buffer.alloc(32), DELEGATE: Buffer | null = null;
const usdcData = (amt: bigint) => { const b = Buffer.alloc(165); OWNER.copy(b, 32); b.writeBigUInt64LE(amt, 64); if (DELEGATE) { b.writeUInt32LE(1, 72); DELEGATE.copy(b, 76); } return b.toString("base64"); };

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "pw-dapp-1234567";
const dir = mkdtempSync(path.join(os.tmpdir(), "twdp-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
let answer: "approved" | "denied" = "approved", hold = false;
const asked: string[] = [];
const rpcCalls: any[] = [];
const sentEvm: any[] = [];
let simErr: unknown = null;
const w = await TollkitWallet.open(PW, { dir, dapp: {
  rejectCooldownMs: 0,
  approve: async (t) => { asked.push(t); if (hold) return new Promise(() => {}); return answer; },
  evmRpc: async (chain, method, params: any) => { rpcCalls.push({ chain, method, params }); if (method === "eth_call" && params[0]?.data === "0x95d89b41") return AbiCoder.defaultAbiCoder().encode(["string"], ["USDC"]); if (method === "eth_call" && params[0]?.data === "0x313ce567") return AbiCoder.defaultAbiCoder().encode(["uint8"], [6]); return method === "eth_blockNumber" ? "0x10" : "0x5208"; },
  sendEvm: async (chain, tx) => { sentEvm.push({ chain, tx }); return "0xhash"; },
  solConn: { getBalance: async () => 2e9, getParsedTokenAccountsByOwner: async (_o: any, f: any) => ({ value: f.programId.toBase58().startsWith("Tokenkeg") ? [{ pubkey: USDC_ACCT, account: { data: { parsed: { info: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: { amount: "50000000", decimals: 6 } } } } } }] : [] }), simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: simErr, logs: [], accounts: [{ lamports: 2e9 - 5000 - 1e7 }, { lamports: 1, data: [usdcData(42_500_000n), "base64"] }] } }), sendRawTransaction: async () => "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" } as any,
} });
await w.setPolicy(PW, { ...w.policy, chains: ["base", "solana", "ethereum"] });
const dp = w.dapps();
const run = async (origin: string, method: string, params?: unknown) => {
  try {
    const r: any = await dp.submit(origin, method, params);
    if ("result" in r) return { result: r.result };
    for (let i = 0; i < 200; i++) { const j = dp.job(r.id); if (j.status !== "pending") return j.status === "done" ? { result: j.result } : { error: j.error }; await new Promise((x) => setTimeout(x, 10)); }
    return { error: { code: -1, message: "timeout" } };
  } catch (e) { return { error: { code: (e as any).code, message: (e as Error).message } }; }
};
const APP = "https://app.example.com", OTHER = "https://other.example";

check(normalOrigin("https://app.example.com/path?x=1") === APP && (() => { try { normalOrigin("http://evil.example"); return false; } catch { return true; } })(), "only https sites (and localhost) can connect");
check((await run(APP, "eth_chainId")).result === "0x2105" && (await run(APP, "eth_accounts")).result.length === 0, "before connecting: Base, no accounts");
check((await run(APP, "personal_sign", ["0x68656c6c6f", w.addresses.evm])).error?.code === 4100 && asked.length === 0, "signing before connecting: 4100, nothing asked");

answer = "denied";
check((await run(APP, "eth_requestAccounts")).error?.code === 4001 && /app.example.com wants to connect/.test(asked.at(-1)!), "connect asks the owner (naming the site); a no is 4001");
answer = "approved";
const acc = await run(APP, "eth_requestAccounts");
check(acc.result?.[0] === w.addresses.evm && dp.sites().some((s) => s.origin === APP && s.evm), "approved: the site gets the address and is remembered");
const n = asked.length;
check((await run(APP, "eth_requestAccounts")).result?.[0] === w.addresses.evm && asked.length === n, "already connected: no second prompt");
check((await run(OTHER, "eth_accounts")).result.length === 0, "other sites still see nothing");

// read-only calls go to the network for the site's chain
check((await run(APP, "eth_blockNumber")).result === "0x10" && rpcCalls.at(-1).chain === "base", "read calls go straight to the network");
check((await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x1" }])).result === null && (await run(APP, "eth_chainId")).result === "0x1", "switch to Ethereum");
check((await run(APP, "wallet_switchEthereumChain", [{ chainId: "0xa" }])).error?.code === 4902, "unsupported chains (Optimism): 4902");
{ const r = await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x89" }]); check(r.error?.code === 4901 && /Polygon is turned off/.test(r.error?.message ?? ""), "Polygon while it's off in settings: 4901 with its name", r); }
await w.setPolicy(PW, { ...w.policy, chains: ["base", "solana", "ethereum", "arbitrum", "polygon"] });
check((await run(APP, "wallet_switchEthereumChain", [{ chainId: "0xa4b1" }])).result === null && (await run(APP, "eth_chainId")).result === "0xa4b1" && (await run(APP, "net_version")).result === "42161", "switch to Arbitrum");
check((await run(APP, "eth_blockNumber")).result === "0x10" && rpcCalls.at(-1).chain === "arbitrum", "read calls go to Arbitrum after switching");
check((await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x89" }])).result === null && (await run(APP, "eth_chainId")).result === "0x89", "switch to Polygon");
check((await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x1" }])).result === null, "back to Ethereum");
await w.setPolicy(PW, { ...w.policy, chains: ["base", "solana", "ethereum"] });
check((await run(APP, "eth_sign", [w.addresses.evm, "0x00"])).error?.code === 4200, "eth_sign refused");
check((await run(APP, "eth_foo")).error?.code === 4200, "unknown methods: 4200");
await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x2105" }]);

// personal_sign
const sig = await run(APP, "personal_sign", ["0x68656c6c6f20746f6c6c6b6974", w.addresses.evm]);
check(verifyMessage("hello tollkit", sig.result) === w.addresses.evm && /sign a message:\n\nhello tollkit/.test(asked.at(-1)!), "personal_sign: shows the text, signature recovers to this wallet");
// typed data
const td = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }], Permit: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }] }, primaryType: "Permit", domain: { name: "USD Coin", chainId: 8453 }, message: { spender: "0x000000000000000000000000000000000000dEaD", value: "1000" } };
const tsig = await run(APP, "eth_signTypedData_v4", [w.addresses.evm, JSON.stringify(td)]);
const { EIP712Domain: _x, ...types } = td.types;
check(verifyTypedData(td.domain, types, td.message, tsig.result) === w.addresses.evm && /Warning: signatures like this/.test(asked.at(-1)!) && /Chain: 8453/.test(asked.at(-1)!), "typed data: signed correctly, permits get a warning");
// send
const tx = await run(APP, "eth_sendTransaction", [{ from: w.addresses.evm, to: "0x000000000000000000000000000000000000dEaD", value: "0x2386f26fc10000", data: "0xa9059cbb00" }]);
check(tx.result === "0xhash" && sentEvm[0].chain === "base" && sentEvm[0].tx.value === 10_000_000_000_000_000n && /send a transaction on Base:\nTo 0x000000000000000000000000000000000000dEaD\nValue 0.01 ETH\nCalls 0xa9059cbb/.test(asked.at(-1)!), "send: shows network, recipient, value and call; sends after OK", asked.at(-1));
const appr = new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", ["0x000000000000000000000000000000000000bEEF", MaxUint256]);
await run(APP, "eth_sendTransaction", [{ to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: appr }]);
check(/Approves 0x000000000000000000000000000000000000bEEF to spend UNLIMITED USDC of your USDC\. Warning/.test(asked.at(-1)!), "token approvals are spelled out, with a warning", asked.at(-1));
check(w.receipts().at(-1)!.kind === "dapp" && w.receipts().at(-1)!.seller === "app.example.com", "recorded in Activity with the site's name");
check((await run(APP, "eth_sendTransaction", [{ from: "0x0000000000000000000000000000000000000001", to: "0x000000000000000000000000000000000000dEaD" }])).error?.code === 4100, "sending from another address refused");

// Solana
check((await run(APP, "sol_connect", { silent: true })).error?.code === 4001, "Solana silent connect before approval: refused");
const sc = await run(APP, "sol_connect");
check(sc.result?.address === w.addresses.solana && Buffer.from(sc.result.publicKey, "base64").equals(new PublicKey(w.addresses.solana).toBuffer()), "Solana connect: address and public key");
const me = new PublicKey(w.addresses.solana);
OWNER = Buffer.from(me.toBytes());
const msg = new TransactionMessage({ payerKey: me, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: 1e7 })] }).compileToV0Message();
const raw = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
const st = await run(APP, "sol_signTransaction", { transaction: raw });
const signed = VersionedTransaction.deserialize(Buffer.from(st.result.signedTransaction, "base64"));
check(signed.signatures[0]!.some((b) => b !== 0) && /using System/.test(asked.at(-1)!) && /SOL -0.010005, USDC -7.5/.test(asked.at(-1)!) && /You pay the network fee/.test(asked.at(-1)!), "sign: shows programs and the simulated SOL change; returns it signed", asked.at(-1));
check(!/can't read/.test(asked.at(-1)!), "known programs only: no unknown-program warning");
const odd = Keypair.generate().publicKey;
const oddMsg = new TransactionMessage({ payerKey: me, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [{ programId: odd, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.from([1]) }] }).compileToV0Message();
await run(APP, "sol_signTransaction", { transaction: Buffer.from(new VersionedTransaction(oddMsg).serialize()).toString("base64") });
check(new RegExp(`runs programs Tollkit can't read \\(${odd.toBase58().slice(0, 4)}`).test(asked.at(-1)!), "a program Tollkit can't read gets a warning", asked.at(-1));
DELEGATE = Keypair.generate().publicKey.toBuffer();
await run(APP, "sol_signTransaction", { transaction: raw });
check(/Warning: .*spend your USDC later/.test(asked.at(-1)!), "a hidden token approval (seen in the simulated account) gets a warning", asked.at(-1));
DELEGATE = null;
const ss = await run(APP, "sol_signAndSendTransaction", { transaction: raw });
check(Buffer.from(ss.result.signature, "base64").length === 64, "sign and send: returns the 64-byte signature");
const other = new TransactionMessage({ payerKey: Keypair.generate().publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message();
check((await run(APP, "sol_signTransaction", { transaction: Buffer.from(new VersionedTransaction(other).serialize()).toString("base64") })).error?.message.includes("doesn't need this wallet") === true, "transactions that don't involve this wallet are refused");
const sm = await run(APP, "sol_signMessage", { message: Buffer.from("Sign in to app.example.com").toString("base64") });
const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), me.toBuffer()]), format: "der", type: "spki" });
check(edVerify(null, Buffer.from("Sign in to app.example.com"), pub, Buffer.from(sm.result.signature, "base64")), "Solana signMessage: valid ed25519 signature");
check((await run(OTHER, "sol_signMessage", { message: "aGk=" })).error?.code === 4100, "Solana signing from an unconnected site: 4100");

check((await run(APP, "sol_signMessage", { message: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64") })).error?.code === 4200, "Solana: raw bytes (a transaction in disguise) can't be signed as a message");
check(normalOrigin("https://xn--80ak6aa92e.com") === "https://xn--80ak6aa92e.com" && (() => { try { normalOrigin("https://a'b.example.com"); return false; } catch { return true; } })(), "odd characters in a site name are refused");
const approveIx = new TransactionMessage({ payerKey: me, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [{ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [], data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]) }] }).compileToV0Message();
check(solanaWarnings(new VersionedTransaction(approveIx)).some((x) => /spend your tokens/.test(x)), "Solana token approvals get a warning");
hold = true;
for (let i = 0; i < 3; i++) await dp.submit(OTHER, "eth_requestAccounts", []);
check((await run(OTHER, "eth_requestAccounts")).error?.code === 4001, "a site can't pile up more than 3 waiting requests");
hold = false;

const { publicFetch } = await import("../src/netguard.js");
const hops: string[] = [];
const redirector = publicFetch((async (u: string) => { hops.push(u); return new Response("", { status: 307, headers: { location: "http://127.0.0.1:7420/api/ext/pair" } }); }) as any);
check(/private network/.test(await redirector("https://seller.example/tool", { method: "POST" }).then(() => "", (e) => e.message)) && hops.length === 1, "agents' paid calls can't be redirected to this computer");

// disconnect
dp.disconnect(APP);
check((await run(APP, "eth_accounts")).result.length === 0 && !dp.sites().length, "disconnect forgets the site");

// pairing and the dashboard routes
const dash = await startDashboard(w, PW, { port: 17454, watch: false, autopilot: false, connectApps: false, ai: false, holdings: false });
const tok = new URL(dash.url).searchParams.get("t")!;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const call = async (p: string, o: { body?: unknown; ext?: string; origin?: string; dash?: boolean } = {}) => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (o.dash) h["x-tw-token"] = tok; else h.origin = o.origin ?? EXT;
  if (o.ext) h["x-tw-ext"] = o.ext;
  const r = await fetch(`http://127.0.0.1:17454${p}`, { method: o.body ? "POST" : "GET", headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, j: await r.json() as any };
};
const code = (await call("/api/extmgr/code", { body: {}, dash: true })).j.code;
check(/^17454-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code), "pairing code includes the dashboard's port", code);
check((await call("/api/ext/pair", { body: { code }, origin: "https://evil.example" })).status === 403, "pairing from a web page is refused");
check((await call("/api/ext/pair", { body: { code: "17454-0000-0000" } })).status === 403, "wrong code refused");
const pr = await call("/api/ext/pair", { body: { code } });
check(pr.status === 200 && /^[0-9a-f]{64}$/.test(pr.j.token), "the extension gets a token for the right code");
check((await call("/api/ext/pair", { body: { code } })).status === 403, "codes work once");
check((await call("/api/ext/state")).status === 401 && (await call("/api/ext/state", { ext: pr.j.token, origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).status === 401, "no token, or another extension with the token: refused");
const stt = await call("/api/ext/state", { ext: pr.j.token, body: {} });
check(stt.status === 200 && stt.j.evm === w.addresses.evm, "paired extension can read the wallet's state");
const q = await call("/api/ext/request", { ext: pr.j.token, body: { origin: APP, method: "eth_chainId" } });
check(q.j.result === "0x2105", "requests through the dashboard");
const rq = await call("/api/ext/request", { ext: pr.j.token, body: { origin: APP, method: "eth_requestAccounts" } });
await new Promise((x) => setTimeout(x, 50));
const res = await call("/api/ext/result", { ext: pr.j.token, body: { id: rq.j.id } });
check(res.j.status === "done" && res.j.result[0] === w.addresses.evm, "slow requests: id, then the result");
check((await call("/api/extmgr/sites", { dash: true })).j.sites.length === 1, "dashboard lists connected sites");
await call("/api/extmgr/disconnect", { body: { origin: APP }, dash: true });
check((await call("/api/extmgr/sites", { dash: true })).j.sites.length === 0, "dashboard can disconnect a site");
await call("/api/extmgr/unpair", { body: {}, dash: true });
check((await call("/api/ext/state", { ext: pr.j.token })).status === 401, "unpair: the extension's token stops working");
await dash.close();

await run(APP, "eth_requestAccounts");
// ---- warnings carried over from the Chrome extension's review ----------------------------------------
check(signInWarning("evil.example wants you to sign in with your Ethereum account:\n0xabc", "app.example.com").length === 1 && signInWarning("app.example.com wants you to sign in with your Ethereum account:\n0xabc", "app.example.com").length === 0, "sign-in messages for another site are flagged; this site's are not");
const pt = plainText("Send 1 USDC‮0001 ot");
check(pt.text.includes("[U+202E]") && pt.warnings.length === 1 && plainText("plain words").warnings.length === 0, "hidden direction characters are shown and flagged");
await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x2105" }]);
const siwe = await run(APP, "personal_sign", ["0x" + Buffer.from("evil.example wants you to sign in with your Ethereum account:\n" + w.addresses.evm).toString("hex"), w.addresses.evm]);
check(!!siwe.result && /this sign-in message is for evil.example, not app.example.com/.test(asked.at(-1)!), "personal_sign: a sign-in for another site carries a warning");
const mismatch = await run(APP, "eth_signTypedData_v4", [w.addresses.evm, JSON.stringify({ types: { EIP712Domain: [], Permit: [{ name: "spender", type: "address" }] }, primaryType: "Mail", domain: { chainId: 8453 }, message: { spender: w.addresses.evm } })]);
check(mismatch.error?.code === -32602 && /won't sign/.test(mismatch.error.message), "typed data whose primaryType doesn't match its types is refused", mismatch);
const onlyMail = (chainId?: number) => JSON.stringify({ types: { EIP712Domain: [], Mail: [{ name: "to", type: "address" }] }, primaryType: "Mail", domain: { name: "X", ...(chainId === undefined ? {} : { chainId }) }, message: { to: w.addresses.evm } });
await run(APP, "eth_signTypedData_v4", [w.addresses.evm, onlyMail(1)]);
check(/it's for chain 1, but this site is on Base \(8453\)/.test(asked.at(-1)!), "typed data for another chain than the site's is flagged");
const chainsBefore = w.policy.chains;
await w.setPolicy(PW, { ...w.policy, chains: [...chainsBefore, "arbitrum"] });
await run(APP, "wallet_switchEthereumChain", [{ chainId: "0xa4b1" }]);
await run(APP, "eth_signTypedData_v4", [w.addresses.evm, onlyMail(8453)]);
check(/it.s for chain 8453, but this site is on Arbitrum \(42161\)/.test(asked.at(-1)!), "the warning names the site's network (Arbitrum), not Base", asked.at(-1));
await run(APP, "wallet_switchEthereumChain", [{ chainId: "0x2105" }]);
await w.setPolicy(PW, { ...w.policy, chains: chainsBefore });
await run(APP, "eth_signTypedData_v4", [w.addresses.evm, onlyMail()]);
check(/isn't tied to a chain/.test(asked.at(-1)!), "typed data with no chain is flagged");
await run(APP, "eth_signTypedData_v4", [w.addresses.evm, onlyMail(8453)]);
check(!/Warning:/.test(asked.at(-1)!), "plain typed data on the site's chain has no warning");
// a Deny makes that site wait before asking again (cooldown), and subdomains share the waiting cap
const cd = new DappBridge({ evm: w.addresses.evm, solana: w.addresses.solana, keys: () => ({}) as any, chains: () => ["base"], dir, approve: async () => "denied", rejectCooldownMs: 60_000 });
const sub = async (o: string, m: string) => { try { const r: any = await cd.submit(o, m, []); if ("result" in r) return "result"; for (;;) { const j = cd.job(r.id); if (j.status !== "pending") return j.status === "error" ? j.error!.code : "done"; await new Promise((x) => setTimeout(x, 5)); } } catch (e) { return (e as any).code; } };
const dc = await sub("https://pest.example", "eth_requestAccounts");
check(dc === 4001, "denied connect", dc);
let threw: unknown = null; try { await cd.submit("https://pest.example", "eth_requestAccounts", []); } catch (e) { threw = (e as any).code; }
check(threw === 4001, "right after a Deny the same site is refused without asking");
const held = new DappBridge({ evm: w.addresses.evm, solana: w.addresses.solana, keys: () => ({}) as any, chains: () => ["base"], dir, approve: () => new Promise(() => {}) });
for (const h of ["a", "b", "c"]) await held.submit(`https://${h}.spam.example`, "eth_requestAccounts", []);
let capped: unknown = null; try { await held.submit("https://d.spam.example", "eth_requestAccounts", []); } catch (e) { capped = (e as any).message; }
const shared = new DappBridge({ evm: w.addresses.evm, solana: w.addresses.solana, keys: () => ({}) as any, chains: () => ["base"], dir, approve: () => new Promise(() => {}) });
for (const h of ["a", "b", "c"]) await shared.submit(`https://${h}.vercel.app`, "eth_requestAccounts", []);
let sharedErr: unknown = null; try { await shared.submit("https://other-project.vercel.app", "eth_requestAccounts", []); } catch (e) { sharedErr = e; }
check(sharedErr === null, "different sites on a shared host (vercel.app) don't share a cap");
await run(APP, "eth_signTypedData_v4", [w.addresses.evm, JSON.stringify({ types: { EIP712Domain: [], Mail: [{ name: "to", type: "string" }] }, primaryType: "Mail", domain: { name: "Pay\u202eX", chainId: 8453 }, message: { to: "a\u200bb" } })]);
check(/\[U\+202E\]/.test(asked.at(-1)!) && /\[U\+200B\]/.test(asked.at(-1)!) && /hidden characters/.test(asked.at(-1)!), "typed data shows hidden characters in its name and message");
check(/already has requests waiting/.test(String(capped)), "subdomains of one site share the 3-request cap", capped);

console.log(`\ndapp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
