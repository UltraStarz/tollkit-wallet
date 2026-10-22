/** Solana 24/7, the device side (src/alwayson-sol.ts): which rules can run, the allowance transaction this wallet signs, the signed calls to the server, and turning it off. Fake chain and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getBase58Encoder, getPublicKeyFromAddress, verifySignature, address } from "@solana/kit";
import { SolAlwaysOn, solRunnable, sellLamports, wrapTarget, USDC_MINT, WSOL_MINT, type TokenAcct } from "../src/alwayson-sol.js";
import { RuleStore } from "../src/rules.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

const rule = (x: any) => ({ id: "r1", status: "active", created_by: "owner", created_at: "", state: { runs: 0, failures: 0, fills: [] }, chain: "solana", token: "SOL", ...x });
check(solRunnable(rule({ kind: "dca", amount_usd: 5, every: "day" })) === null, "a recurring SOL buy can run 24/7");
check(solRunnable(rule({ kind: "take_profit", trigger_price: 300, sell_percent: 50 })) === null, "a SOL take-profit can run 24/7");
check(/Only SOL/.test(solRunnable(rule({ kind: "dca", amount_usd: 5, every: "day", token: "BONK" })) ?? ""), "only SOL for now");
check(/kind of rule/.test(solRunnable(rule({ kind: "trailing_stop", trail_pct: 5, sell_percent: 50 })) ?? ""), "trailing stops stay on the device");
check(/another rule/.test(solRunnable(rule({ kind: "take_profit", trigger_price: 300, sell_percent: 50, sell_from: "x" })) ?? ""), "bot steps that wait for another rule stay on the device");
check(sellLamports(rule({ kind: "stop_loss", sell_percent: 50 }) as any, 1_000_000_000n) === 500_000_000n && sellLamports(rule({ kind: "stop_loss", sell_amount: "5" }) as any, 1_000_000_000n) === 1_000_000_000n, "a sell sets aside its share, never more than is free");
check(wrapTarget([rule({ id: "a", group: "g" }), rule({ id: "b", group: "g" }), rule({ id: "c" })] as any, { a: 3n, b: 5n, c: 2n }) === 7n, "a take-profit and its stop-loss share the same SOL");
check(wrapTarget([rule({ id: "a", sell_percent: 100 }), rule({ id: "b", sell_percent: 100 }), rule({ id: "c", sell_amount: "1" }), rule({ id: "d", sell_amount: "1" })] as any, { a: 9n, b: 9n, c: 2n, d: 2n }) === 13n, "two \"sell all\" rules (a stop and a take-profit the AI set up separately) share one set-aside; fixed amounts each get their own");

// A fake chain: token accounts, plain SOL, and the instructions this wallet sends.
const kp = Keypair.generate(), OWN = kp.publicKey.toBase58();
const usdcA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), kp.publicKey).toBase58(), wsolA = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), kp.publicKey).toBase58();
const DELEGATE = Keypair.generate().publicKey.toBase58();
const accts: Record<string, TokenAcct> = { [usdcA]: { exists: true, amount: 40_000_000n, delegate: null, delegated: 0n }, [wsolA]: { exists: false, amount: 0n, delegate: null, delegated: 0n } };
let lamports = 1_000_000_000n;
const sent: TransactionInstruction[][] = [];
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const name = (i: TransactionInstruction) => i.programId.equals(SystemProgram.programId) ? "transfer" : i.programId.toBase58() === TOKEN ? ({ 4: "approve", 5: "revoke", 9: "close", 17: "sync" } as any)[i.data[0]!] : "create_ata";
const chain = {
  lamports: async () => lamports,
  token: async (a: string) => ({ ...(accts[a] ?? { exists: false, amount: 0n, delegate: null, delegated: 0n }) }),
  send: async (ixs: TransactionInstruction[]) => {
    sent.push(ixs);
    // Apply what the instructions do, enough for the next sync to see it.
    for (const i of ixs) {
      const acct = i.keys[0]!.pubkey.toBase58(), n = name(i);
      if (n === "create_ata") accts[i.keys[1]!.pubkey.toBase58()] ??= { exists: true, amount: 0n, delegate: null, delegated: 0n };
      if (n === "create_ata") accts[i.keys[1]!.pubkey.toBase58()]!.exists = true;
      if (n === "transfer") { const amt = i.data.readBigUInt64LE(4); lamports -= amt; accts[i.keys[1]!.pubkey.toBase58()]!.amount += amt; }
      if (n === "approve") Object.assign(accts[acct]!, { delegate: i.keys[1]!.pubkey.toBase58(), delegated: i.data.readBigUInt64LE(1) });
      if (n === "revoke") Object.assign(accts[acct]!, { delegate: null, delegated: 0n });
      if (n === "close") { lamports += accts[acct]!.amount; accts[acct] = { exists: false, amount: 0n, delegate: null, delegated: 0n }; }
    }
    return "sig" + sent.length;
  },
};

// A fake Tollkit server that checks the wallet's signature like the real one (x402-starter src/always-sol.ts).
const calls: { route: string; body: any }[] = [];
let srvFills: any[] = [];
const fakeFetch = (async (u: string, init?: RequestInit) => {
  const url = new URL(String(u));
  if (url.pathname.endsWith("/config")) return new Response(JSON.stringify({ enabled: true, delegate: DELEGATE, fee_bps: 50 }));
  const route = url.pathname.split("/").pop()!, h = init!.headers as Record<string, string>, raw = String(init!.body);
  const msg = new TextEncoder().encode(`Tollkit Always On Solana\n${route}\n${h["x-tk-address"]}\n${h["x-tk-ts"]}\n${createHash("sha256").update(raw).digest("hex")}`);
  const ok = await verifySignature(await getPublicKeyFromAddress(address(h["x-tk-address"]!)), getBase58Encoder().encode(h["x-tk-sig"]!) as any, msg as any);
  if (!ok || h["x-tk-address"] !== OWN) return new Response(JSON.stringify({ error: "Bad signature." }), { status: 401 });
  const body = JSON.parse(raw); calls.push({ route, body });
  if (route === "state") return new Response(JSON.stringify({ delegate: DELEGATE, fills: srvFills, rules: {} }));
  if (route === "sync") return new Response(JSON.stringify({ ok: true, running: body.rules.map((r: any) => r.id) }));
  return new Response(JSON.stringify({ ok: true }));
}) as any;

const dir = mkdtempSync(path.join(os.tmpdir(), "aos-"));
const store = new RuleStore(dir);
const s = new SolAlwaysOn({ key: () => kp, address: OWN, dir, rpc: "http://unused", proxy: "https://api.tollkit.dev/wallet", rules: () => store, chain, fetch: fakeFetch });
check((await s.config())?.enabled === true, "reads whether Tollkit runs Solana rules for this wallet");

const dca = await store.add({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 5, every: "day" }, "owner", true);
s.set(dca.id, true, 25);
let out = await s.sync();
check(out.running.includes(dca.id) && Object.keys(out.problems).length === 0, "a recurring buy goes to the server", out);
check(JSON.stringify(sent[0]!.map(name)) === JSON.stringify(["approve", "create_ata"]), "one transaction: allow up to $25 of USDC, and make the wrapped-SOL account the buys land in", sent[0]!.map(name));
check(accts[usdcA]!.delegate === DELEGATE && accts[usdcA]!.delegated === 25_000_000n, "the allowance names Tollkit's key for this wallet, capped at the owner's amount");
check(calls.filter((c) => c.route === "sync")[0]!.body.rules[0].amount_usd === 5, "the rule as the server needs it");
await s.sync();
check(sent.length === 1, "nothing is re-signed while the allowance still covers a buy");

// The server bought: $5 of USDC gone from the allowance, SOL landed wrapped. The fill comes back to the rule.
accts[usdcA]!.delegated = 3_000_000n; accts[usdcA]!.amount = 35_000_000n; accts[wsolA]!.amount = 27_000_000n;
srvFills = [{ id: "f1", rule_id: dca.id, ts: new Date().toISOString(), ok: true, tx: "t1", usd: 5, units: 0.027, side: "buy" }];
out = await s.sync();
check(store.get(dca.id)!.state.runs === 1 && store.get(dca.id)!.state.bought_units === 0.027, "the server's buy is recorded on the rule", store.get(dca.id)!.state);
check(sent.length === 2 && sent[1]!.map(name).join() === "approve" && accts[usdcA]!.delegated === 25_000_000n, "the allowance refills to $25 once it can't cover a buy", sent[1]?.map(name));
await s.sync();
check(store.get(dca.id)!.state.runs === 1, "a fill is recorded once");

// A take-profit with a stop-loss partner: half the free SOL set aside once, wrapped and allowed.
const tp = await store.add({ kind: "take_profit", chain: "solana", token: "SOL", sell_percent: 50, trigger_price: 400, group: "g1" }, "owner", true);
const sl = await store.add({ kind: "stop_loss", chain: "solana", token: "SOL", sell_percent: 50, trigger_price: 100, group: "g1" }, "owner", true);
s.set(tp.id, true); s.set(sl.id, true);
const before = lamports;
out = await s.sync();
const half = ((before - 20_000_000n) + 27_000_000n) / 2n; // free SOL plus what's already wrapped, halved
check(out.running.includes(tp.id) && out.running.includes(sl.id), "both sells go to the server", out);
const last = sent.at(-1)!.map(name);
check(last.includes("transfer") && last.includes("sync") && last.includes("approve"), "wraps the difference and allows it", last);
check(accts[wsolA]!.amount === half && accts[wsolA]!.delegated === half && accts[wsolA]!.delegate === DELEGATE, "the pair shares one set-aside: exactly half, not twice", { amt: accts[wsolA]!.amount, half });
const sells = calls.filter((c) => c.route === "sync").at(-1)!.body.rules.filter((r: any) => r.kind !== "dca");
check(sells.length === 2 && sells.every((r: any) => r.sell_amount === Number(half) / 1e9 && r.sell_percent === undefined), "the server is told the exact SOL each may sell", sells);
const n = sent.length; await s.sync();
check(sent.length === n, "the set-aside stays fixed on later syncs");

// Asking for more than there is.
const big = await store.add({ kind: "limit_sell", chain: "solana", token: "SOL", sell_amount: "50", trigger_price: 500 }, "owner", true);
s.set(big.id, true);
const freeNow = lamports - 20_000_000n;
out = await s.sync();
check(out.running.includes(big.id) && out.running.includes(tp.id) && accts[wsolA]!.amount === half + freeNow && lamports === 20_000_000n, "a sell asking for more than there is gets what's free, and the pair keeps its share", { problems: out.problems, w: accts[wsolA]!.amount, lamports });
const big2 = await store.add({ kind: "limit_sell", chain: "solana", token: "SOL", sell_amount: "1", trigger_price: 600 }, "owner", true);
s.set(big2.id, true);
out = await s.sync();
check(/No SOL left/.test(out.problems[big2.id] ?? "") && out.running.includes(big.id), "with nothing left, a new sell says so and the others keep running", out.problems);
s.set(big2.id, false);

// Revoke: the server drops the rules, the USDC allowance is cancelled, every wrapped SOL comes back as SOL.
const wrapped = accts[wsolA]!.amount, lp = lamports;
await s.off();
const offTx = sent.at(-1)!.map(name);
check(offTx.join() === "revoke,close", "turning it off: cancel the USDC allowance and unwrap", offTx);
check(accts[usdcA]!.delegate === null && !accts[wsolA]!.exists && lamports === lp + wrapped, "nothing allowed, and the wrapped SOL is plain SOL again");
check(calls.at(-1)!.route === "off" && s.view().rules.length === 0 && !s.serverRuns(dca.id), "the server and the device both forget the rules");

// Two "sell all" rules made separately (a stop-loss and a take-profit): both run, from one set-aside.
{
  lamports = 300_000_000n;
  const st1 = await store.add({ kind: "stop_loss", chain: "solana", token: "SOL", sell_percent: 100, trigger_price: 96 }, "owner", true);
  const tp1 = await store.add({ kind: "take_profit", chain: "solana", token: "SOL", sell_percent: 100, trigger_price: 123 }, "owner", true);
  for (const r of store.list()) if (r.id !== st1.id && r.id !== tp1.id) s.set(r.id, false);
  s.set(st1.id, true); s.set(tp1.id, true);
  const o2 = await s.sync();
  check(o2.running.includes(st1.id) && o2.running.includes(tp1.id) && accts[wsolA]!.amount === 280_000_000n && accts[wsolA]!.delegated === 280_000_000n, "both run, sharing all the free SOL (0.28), not one of them stuck with nothing", { p: o2.problems, w: accts[wsolA]!.amount });
  await s.off();
}

// Autopilot (0.9.2): its 24/7 sells set aside only SOL its own strategies bought; the owner's sells never take that.
{
  lamports = 1_020_000_000n; // 1 SOL free after the 0.02 reserve
  for (const r of store.list()) s.set(r.id, false);
  const apBuy = await store.add({ kind: "dca", chain: "solana", token: "SOL", amount_usd: 5, every: "day" }, "agent", true);
  await store.mutate((rs) => { const x = rs.find((r) => r.id === apBuy.id)!; x.by = "superbot"; x.bot = "apbot"; x.state.bought_units = 0.3; });
  const apSell = await store.add({ kind: "take_profit", chain: "solana", token: "SOL", sell_percent: 100, trigger_price: 150 }, "agent", true);
  await store.mutate((rs) => { const x = rs.find((r) => r.id === apSell.id)!; x.by = "superbot"; x.bot = "apbot"; });
  const mine = await store.add({ kind: "stop_loss", chain: "solana", token: "SOL", sell_percent: 100, trigger_price: 90 }, "owner", true);
  s.set(apSell.id, true); s.set(mine.id, true);
  const o3 = await s.sync();
  const sent3 = calls.filter((c) => c.route === "sync").at(-1)!.body.rules;
  const apAmt = sent3.find((r: any) => r.id === apSell.id)?.sell_amount, myAmt = sent3.find((r: any) => r.id === mine.id)?.sell_amount;
  check(apAmt === 0.3 && myAmt === 0.7 && o3.running.length === 2, "Autopilot's sell sets aside only the 0.3 SOL it bought; yours the other 0.7", { apAmt, myAmt, p: o3.problems });
  // Autopilot turned off: every switch off, so the next sync unwraps everything and cancels the allowance.
  s.set(apSell.id, false); s.set(mine.id, false);
  const before4 = lamports, wrapped4 = accts[wsolA]!.amount;
  await s.sync();
  check(!accts[wsolA]!.exists && lamports === before4 + wrapped4 && sent.at(-1)!.map(name).includes("close"), "with nothing left on 24/7, the set-aside SOL is unwrapped back to plain SOL", sent.at(-1)!.map(name));
}

// The server turned off for this wallet: rules come back to the device.
const s2 = new SolAlwaysOn({ key: () => kp, address: OWN, dir: mkdtempSync(path.join(os.tmpdir(), "aos-")), rpc: "x", proxy: "p", rules: () => store, chain,
  fetch: (async () => new Response(JSON.stringify({ enabled: false, delegate: null, reason: "Not turned on for this wallet yet." }))) as any });
s2.set(dca.id, true, 10);
out = await s2.sync();
check(out.running.length === 0 && /Not turned on/.test(out.problems[dca.id] ?? ""), "when the server isn't on, nothing runs there and the card says why", out);

console.log(`\nalwayson-sol: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
