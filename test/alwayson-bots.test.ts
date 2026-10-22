/** 0.9.3: bots on Solana 24/7, the device side (src/alwayson-sol.ts): which rules can run, the allowance transaction this wallet signs, the signed calls to the server, and turning it off. Fake chain and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getBase58Encoder, getPublicKeyFromAddress, verifySignature, address } from "@solana/kit";
import { SolAlwaysOn, solRunnable, botHeld, USDC_MINT, WSOL_MINT, type TokenAcct } from "../src/alwayson-sol.js";
import { RuleStore } from "../src/rules.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

const rule = (x: any) => ({ id: "r1", status: "active", created_by: "owner", created_at: "", state: { runs: 0, failures: 0, fills: [] }, chain: "solana", token: "SOL", ...x });
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
let srvFills: any[] = [], srvRules: any = {}, KINDS = ["dca", "limit_buy", "limit_sell", "take_profit", "stop_loss"];
const fakeFetch = (async (u: string, init?: RequestInit) => {
  const url = new URL(String(u));
  if (url.pathname.endsWith("/config")) return new Response(JSON.stringify({ enabled: true, delegate: DELEGATE, fee_bps: 50, kinds: KINDS }));
  const route = url.pathname.split("/").pop()!, h = init!.headers as Record<string, string>, raw = String(init!.body);
  const msg = new TextEncoder().encode(`Tollkit Always On Solana\n${route}\n${h["x-tk-address"]}\n${h["x-tk-ts"]}\n${createHash("sha256").update(raw).digest("hex")}`);
  const ok = await verifySignature(await getPublicKeyFromAddress(address(h["x-tk-address"]!)), getBase58Encoder().encode(h["x-tk-sig"]!) as any, msg as any);
  if (!ok || h["x-tk-address"] !== OWN) return new Response(JSON.stringify({ error: "Bad signature." }), { status: 401 });
  const body = JSON.parse(raw); calls.push({ route, body });
  if (route === "state") return new Response(JSON.stringify({ delegate: DELEGATE, fills: srvFills, rules: srvRules }));
  if (route === "sync") return new Response(JSON.stringify({ ok: true, running: body.rules.map((r: any) => r.id) }));
  return new Response(JSON.stringify({ ok: true }));
}) as any;


check(solRunnable(rule({ kind: "smart_dca", amount_usd: 20, step_pct: 3, safety: 4, scale: 1.5, profit_pct: 3 })) === null, "a SOL Smart DCA can run 24/7");
check(solRunnable(rule({ kind: "twap", side: "sell", sell_percent: 50, pieces: 4, hours: 2 })) === null, "a split sell can run 24/7");
check(/Only SOL/.test(solRunnable(rule({ kind: "rebalance", amount_usd: 100, target_pct: 50, band_pct: 5, token: "BONK" })) ?? ""), "only SOL bots for now");
check(botHeld(rule({ kind: "grid", state: { runs: 0, failures: 0, fills: [], grid: { units: [], cost: [], atomic: ["5", null, "7"] } } }) as any) === 12n, "a grid holds what its filled levels bought");
check(botHeld(rule({ kind: "twap", side: "sell", pieces: 4, state: { runs: 0, failures: 0, fills: [], bot: { sell_total: "400", pieces: 1 } } }) as any) === 300n, "a split sell holds what's left of its total");

const dir = mkdtempSync(path.join(os.tmpdir(), "aob-"));
const store = new RuleStore(dir);
const s = new SolAlwaysOn({ key: () => kp, address: OWN, dir, rpc: "http://unused", proxy: "https://api.tollkit.dev/wallet", rules: () => store, chain, fetch: fakeFetch });

// A Smart DCA the device has been running: it holds 0.1 SOL (plain SOL in the wallet) that cost $10.
const sd = await store.add({ kind: "smart_dca", chain: "solana", token: "SOL", amount_usd: 20, step_pct: 3, safety: 4, scale: 1.5, profit_pct: 3 }, "owner", false);
await store.mutate((rs) => { const x = rs.find((y) => y.id === sd.id)!; x.state.bot = { units: "100000000", cost: 10, ref: 100, buys: 0, started: true, v: 3 }; x.state.last_price = 100; x.state.bought_units = 0.1; });
s.set(sd.id, true, 50);
let out = await s.sync();
check(!out.running.includes(sd.id) && /doesn't run this bot 24\/7 yet/.test(out.problems[sd.id] ?? ""), "an older server that doesn't know bots: the bot stays on the device, nothing sent", out.problems);
check(sent.length === 0 && !calls.some((c) => c.route === "sync" && c.body.rules.length), "and no allowance is signed for it");

KINDS = [...KINDS, "grid", "smart_dca", "rebalance", "infinity_grid", "twap"];
out = await s.sync();
check(out.running.includes(sd.id) && !out.problems[sd.id], "a server that runs bots takes it", out.problems);
const tx = sent.at(-1)!.map(name);
check(tx.includes("approve") && tx.includes("transfer") && tx.includes("sync"), "one transaction: allow USDC, wrap the 0.1 SOL the bot holds, allow wrapped SOL", tx);
check(accts[usdcA]!.delegated === 50_000_000n, "USDC allowed up to the owner's cap");
check(accts[wsolA]!.amount === 100_000_000n, "exactly the bot's 0.1 SOL is wrapped", accts[wsolA]);
check(accts[wsolA]!.delegated === 100_000_000n + 1_000_000_000n, "wrapped SOL allowed: its 0.1 plus room for $50 of buys at half today's price (1 SOL)", accts[wsolA]!.delegated);
const sent1 = calls.filter((c) => c.route === "sync").at(-1)!.body.rules[0];
check(sent1.kind === "smart_dca" && sent1.step_pct === 3 && sent1.safety === 4 && sent1.scale === 1.5 && sent1.bot.units === "100000000" && sent1.bot.v === 3, "the server gets the bot's settings and its state", sent1);

// The server bought more and reports it: the fill tallies, the bot keeps running, its state copy comes back.
const n0 = sent.length;
srvFills = [{ id: "f1", rule_id: sd.id, ts: new Date().toISOString(), ok: true, tx: "t1", side: "buy", usd: 30, units: 0.31 }];
srvRules = { [sd.id]: { runs: 4, bot: { units: "410000000", cost: 40, ref: 96.8, buys: 1, started: true, v: 4 } } };
accts[wsolA]!.amount += 310_000_000n; accts[usdcA]!.delegated -= 30_000_000n; accts[usdcA]!.amount -= 30_000_000n; // what the server's buy did on chain
out = await s.sync();
let r = store.get(sd.id)!;
check(r.status === "active" && r.state.spent_usd === 30 && r.state.bot!.units === "410000000" && r.state.bot!.buys === 1, "server fill tallied; the bot's state copy taken (newer)", r.state);
check(sent.length === n0, "no new allowance needed while the room lasts", sent.slice(n0).map((x) => x.map(name)));
// An older copy doesn't overwrite a newer one.
srvRules = { [sd.id]: { runs: 4, bot: { units: "1", v: 2 } } };
await s.sync();
check(store.get(sd.id)!.state.bot!.units === "410000000", "an older server copy is ignored");
// The server says the split sell finished: the device marks it done.
const tw = await store.add({ kind: "twap", chain: "solana", token: "SOL", side: "sell", sell_percent: 10, pieces: 2, hours: 1 }, "owner", false);
s.set(tw.id, true);
await s.sync();
srvRules = { [tw.id]: { runs: 2, done: true, bot: { pieces: 2, sell_total: "50000000", done: true, v: 2 } } };
await s.sync();
check(store.get(tw.id)!.status === "done", "a bot the server finished is done here too", store.get(tw.id)!.status);
const twSent = calls.filter((c) => c.route === "sync").find((c) => c.body.rules.some((x: any) => x.id === tw.id))!.body.rules.find((x: any) => x.id === tw.id);
check(twSent.side === "sell" && twSent.sell_percent === 10 && BigInt(twSent.bot.sell_total) > 0n, "a split sell goes with its share, its total fixed here", twSent);

console.log(`\nalwayson-bots: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
