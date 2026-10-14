/** Cash out with a fake Tollkit server and fake sends: link, waiting, the checks before sending, dashboard. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";
import type { SendRequest } from "../src/send.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const err = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

const PW = "pw-sell-1234567";
const dir = mkdtempSync(path.join(os.tmpdir(), "twsl-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const CB = "0x0b59d1001629c86da136a0B480Db68EDBf70e222";
let refN = 0, url = "https://pay.coinbase.com/v3/sell/input?sessionToken=t", tx: any = null;
const posts: any[] = [];
const fakeFetch = (async (u: string, init?: any) => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (/\/offramp$/.test(u)) { posts.push(JSON.parse(init.body)); return json({ url, ref: `tw-${"a".repeat(16)}-${String(++refN).padStart(16, "0")}` }); }
  if (/\/offramp\/status\?/.test(u)) return json({ transaction: tx });
  return json({}, 404);
}) as any;
const sent: SendRequest[] = [];
const w = await TollkitWallet.open(PW, { dir, fetch: fakeFetch, proxy: "https://proxy.test/wallet", send: async (r) => { sent.push(r); return "0xsent" + sent.length; } });

const s1 = await w.sales().start(w.addresses.evm, "base", "USDC", "25.5");
check(posts[0].address === w.addresses.evm && posts[0].network === "base" && posts[0].asset === "USDC" && posts[0].amount === "25.5" && s1.url === url, "asks Tollkit's server for a Coinbase sell link with only the public address, network, coin and amount");
check(w.sales().get(s1.ref)?.state === "open", "the sale is saved, waiting for Coinbase");
check(/On base you can cash out/.test(await err(() => w.sales().start(w.addresses.evm, "base", "SOL"))), "SOL on Base refused");
url = "https://evil.example/sell";
check(/Didn't get a Coinbase sell link/.test(await err(() => w.sales().start(w.addresses.evm, "base", "USDC", "5"))), "only a pay.coinbase.com sell link is accepted");
check(/how much to cash out/.test(await err(() => w.sales().start(w.addresses.evm, "base", "USDC"))), "an amount is required");
url = "https://pay.coinbase.com/v3/sell/input?sessionToken=t";

const now = () => new Date().toISOString();
const started = (o: any = {}) => ({ id: "t1", status: "TRANSACTION_STATUS_STARTED", asset: "USDC", network: "base", sell_amount: { value: "25.5", currency: "USDC" }, total: { value: "25.30", currency: "USD" }, coinbase_fee: { value: "0.20", currency: "USD" }, to_address: CB, from_address: w.addresses.evm, tx_hash: "", created_at: now(), updated_at: now(), ...o });

check(/wrong password/.test(await err(() => w.cashOutSend("nope", s1.ref))), "sending needs the password");
check(/isn't from this wallet/.test(await err(() => w.cashOutSend(PW, "tw-x"))), "unknown sale refused");
tx = null;
check(/Cash out now/.test(await err(() => w.cashOutSend(PW, s1.ref))), "nothing to send before \"Cash out now\" on Coinbase");
tx = started({ network: "ethereum" });
check(/not USDC on base/.test(await err(() => w.cashOutSend(PW, s1.ref))), "Coinbase expecting a different network: refused");
tx = started({ asset: "ETH" });
check(/not USDC on base/.test(await err(() => w.cashOutSend(PW, s1.ref))), "Coinbase expecting a different coin: refused");
tx = started({ from_address: "0x000000000000000000000000000000000000dEaD" });
check(/different wallet/.test(await err(() => w.cashOutSend(PW, s1.ref))), "Coinbase expecting it from another wallet: refused");
tx = started({ updated_at: new Date(Date.now() - 31 * 60_000).toISOString(), created_at: new Date(Date.now() - 31 * 60_000).toISOString() });
check(/30 minutes/.test(await err(() => w.cashOutSend(PW, s1.ref))), "after Coinbase's 30 minutes: refused");
tx = started({ sell_amount: { value: "30", currency: "USDC" } });
check(/more than the 25.5 you chose/.test(await err(() => w.cashOutSend(PW, s1.ref))), "Coinbase asking for more than the owner chose: refused");
tx = started({ sell_amount: { value: "25.5", currency: "ETH" } });
check(/expecting ETH, not USDC/.test(await err(() => w.cashOutSend(PW, s1.ref))), "Coinbase amount in a different coin: refused");
tx = started({ to_address: "not-an-address" });
check(/isn't a valid/.test(await err(() => w.cashOutSend(PW, s1.ref))), "a bad Coinbase address is refused");
check(sent.length === 0, "nothing sent by any refused attempt");

tx = started();
const [ok, twice] = await Promise.all([w.cashOutSend(PW, s1.ref), err(() => w.cashOutSend(PW, s1.ref))]);
check(/Already sending/.test(twice), "two clicks at once: only one send", twice);
check(ok.ok && sent.length === 1 && sent[0]!.chain === "base" && sent[0]!.token.symbol === "USDC" && sent[0]!.to === CB && sent[0]!.amount === "25500000", "sends exactly what Coinbase expects, to Coinbase's address", sent[0]);
const rec = w.receipts().at(-1)!;
check(rec.kind === "withdrawal" && rec.tool === "cash out" && rec.seller === "Coinbase" && rec.tx === "0xsent1" && /25.30 USD/.test(rec.detail ?? ""), "recorded in Activity as a cash out", rec);
check(w.sales().get(s1.ref)?.state === "sent" && /Already sent/.test(await err(() => w.cashOutSend(PW, s1.ref))), "can't send twice for the same sale");
tx = started({ status: "TRANSACTION_STATUS_SUCCESS" });
await w.sales().status(w.addresses.evm, s1.ref);
check(w.sales().get(s1.ref)?.state === "done" && w.sales().get(s1.ref)?.payout === "25.30 USD", "marked paid out when Coinbase says so");

// a send that fails can't be retried on the same sale
const s3 = await w.sales().start(w.addresses.evm, "base", "USDC", "5");
tx = started({ sell_amount: { value: "5", currency: "USDC" } });
(w as any).o.send = async () => { throw new Error("RPC timed out"); };
check(/Check Activity/.test(await err(() => w.cashOutSend(PW, s3.ref))) && w.sales().get(s3.ref)?.state === "failed" && /This sale is failed/.test(await err(() => w.cashOutSend(PW, s3.ref))), "a failed send isn't offered again (it may have gone through)");
(w as any).o.send = async (r: SendRequest) => { sent.push(r); return "0xsent" + sent.length; };

// Solana SOL
const s2 = await w.sales().start(w.addresses.solana, "solana", "SOL", "0.5");
tx = started({ network: "solana", asset: "SOL", sell_amount: { value: "0.5", currency: "SOL" }, to_address: "E5Z17Jxsr4cimRUpgcZV29PnX3SqBWH3TqzUsS3DBgkU", from_address: w.addresses.solana });
await w.cashOutSend(PW, s2.ref);
check(sent.at(-1)!.chain === "solana" && sent.at(-1)!.token.symbol === "SOL" && sent.at(-1)!.amount === "500000000", "Solana: 0.5 SOL in lamports");

// Dashboard
const dash = await startDashboard(w, PW, { port: 17453, watch: false, autopilot: false, connectApps: false, ai: false, holdings: false });
const tok = new URL(dash.url).searchParams.get("t")!;
const call = async (p: string, body?: unknown) => { const res = await fetch(`http://127.0.0.1:17453${p}`, { method: body ? "POST" : "GET", headers: { "x-tw-token": tok, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, j: await res.json() as any }; };
const st = await call("/api/sell", { chain: "base", asset: "usdc", amount: "10" });
check(st.status === 200 && st.j.url === url && /^tw-/.test(st.j.ref), "dashboard: sell link");
tx = started({ sell_amount: { value: "10", currency: "USDC" } });
const ss = await call(`/api/sell/status?ref=${st.j.ref}`);
check(ss.status === 200 && ss.j.sale.state === "open" && ss.j.transaction.to_address === CB, "dashboard: status shows where Coinbase wants it");
check((await call("/api/sell/send", { password: "x", ref: st.j.ref })).status === 403, "dashboard: wrong password refused");
const sd = await call("/api/sell/send", { password: PW, ref: st.j.ref });
check(sd.status === 200 && sd.j.tx === "0xsent" + sent.length, "dashboard: sends with the password");
await dash.close();

console.log(`\nsell: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
