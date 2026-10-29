/** 0.9.9: Solana 24/7 for other coins, and "while you're away", the device side (src/alwayson-sol.ts). Fake chain and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SolAlwaysOn, solRunnable, coinMint, USDC_MINT, type TokenAcct, type CoinInfo } from "../src/alwayson-sol.js";
import { RuleStore } from "../src/rules.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); } };

const COIN = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk", SKETCHY = "9zqmZ3ADHpHL9TLtWDEm6zv1QGb1b43VbNpFaBbSkbPN", SUS = "AnxJmUebpwvt9EnYkHUQNk3HY1rGu3HSpd3HUq7Q7oDf";
const rule = (x: any) => ({ id: "r1", status: "active", created_by: "owner", created_at: "", state: { runs: 0, failures: 0, fills: [] }, chain: "solana", token: "SOL", ...x });
check(solRunnable(rule({ kind: "dca", amount_usd: 5, every: "day", token: COIN })) === null && coinMint(rule({ token: COIN }) as any) === COIN, "a Solana coin by its address can run 24/7");
check(/Only SOL and Solana coins/.test(solRunnable(rule({ kind: "dca", amount_usd: 5, every: "day", token: "BONK" })) ?? ""), "a coin given only by its name can't (the server needs the address)");
check(coinMint(rule({ token: USDC_MINT }) as any) === null, "USDC itself isn't a coin to trade against USDC");

const kp = Keypair.generate(), OWN = kp.publicKey.toBase58(), DELEGATE = Keypair.generate().publicKey.toBase58();
const atA = (m: string) => getAssociatedTokenAddressSync(new PublicKey(m), kp.publicKey).toBase58();
const usdcA = atA(USDC_MINT), coinA = atA(COIN);
const accts: Record<string, TokenAcct> = { [usdcA]: { exists: true, amount: 40_000_000n, delegate: null, delegated: 0n, decimals: 6 }, [coinA]: { exists: true, amount: 900_000_000n, delegate: null, delegated: 0n, decimals: 6 } };
const sent: { name: string; acct: string; amount?: bigint }[][] = [];
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const chain = {
  lamports: async () => 1_000_000_000n,
  token: async (a: string) => ({ ...(accts[a] ?? { exists: false, amount: 0n, delegate: null, delegated: 0n }) }),
  send: async (ixs: TransactionInstruction[]) => {
    const tx = ixs.map((i) => {
      const n = i.programId.toBase58() === TOKEN ? ({ 4: "approve", 5: "revoke", 9: "close", 17: "sync" } as any)[i.data[0]!] : i.programId.equals(new PublicKey("11111111111111111111111111111111")) ? "transfer" : "create_ata";
      const acct = n === "create_ata" ? i.keys[1]!.pubkey.toBase58() : i.keys[0]!.pubkey.toBase58();
      if (n === "create_ata") accts[acct] ??= { exists: true, amount: 0n, delegate: null, delegated: 0n, decimals: 6 };
      if (n === "approve") Object.assign(accts[acct]!, { delegate: i.keys[1]!.pubkey.toBase58(), delegated: i.data.readBigUInt64LE(1) });
      if (n === "revoke") Object.assign(accts[acct]!, { delegate: null, delegated: 0n });
      return { name: n, acct, ...(n === "approve" ? { amount: i.data.readBigUInt64LE(1) } : {}) };
    });
    sent.push(tx);
    return "sig" + sent.length;
  },
};
const calls: { route: string; body: any }[] = [];
let awayLog: any[] = [];
const fakeFetch = (async (u: string, init?: RequestInit) => {
  const url = new URL(String(u));
  if (url.pathname.endsWith("/config")) return new Response(JSON.stringify({ enabled: true, delegate: DELEGATE, fee_bps: 50, coins: true, max_coins: 10 }));
  const route = url.pathname.split("/").pop()!, body = JSON.parse(String(init!.body));
  calls.push({ route, body });
  if (route === "state") return new Response(JSON.stringify({ delegate: DELEGATE, fills: [], rules: {}, away_log: awayLog }));
  if (route === "sync") return new Response(JSON.stringify({ ok: true, running: body.rules.map((r: any) => r.id) }));
  return new Response(JSON.stringify({ ok: true }));
}) as any;
const coinInfo = async (ms: string[]) => new Map<string, CoinInfo>(ms.map((m) => [m, m === COIN ? { symbol: "USELESS", decimals: 6, trust: "listed" } : m === SUS ? { symbol: "SUS", decimals: 6, trust: "listed", jupiter: { suspicious: true } } : { symbol: "NEW", decimals: 6, trust: "unlisted" }]));

const dir = mkdtempSync(path.join(os.tmpdir(), "aosc-"));
const store = new RuleStore(dir);
const s = new SolAlwaysOn({ key: () => kp, address: OWN, dir, rpc: "http://unused", proxy: "https://api.tollkit.dev/wallet", rules: () => store, chain, fetch: fakeFetch, coinInfo });
const awayNotes: any[] = [];
const lastSeen = "2026-10-29T12:50:00.000Z";
s.awayInfo = () => ({ last_decision: lastSeen, drop_pct: 8, rise_pct: 4 });
s.onAway = (e) => { awayNotes.push(...e); };

// A buy and a take-profit on USELESS: USDC allowed up to the cap, and exactly the coins the sell may sell.
const buy = await store.add({ kind: "dca", chain: "solana", token: COIN, amount_usd: 10, every: "day" }, "owner", true);
const tp = await store.add({ kind: "take_profit", chain: "solana", token: COIN, sell_amount: "100", trigger_price: 0.25 }, "owner", true);
s.set(buy.id, true, 50); s.set(tp.id, true);
let out = await s.sync();
check(out.running.includes(buy.id) && out.running.includes(tp.id) && !Object.keys(out.problems).length, "both USELESS rules go to the server", out);
const tx1 = sent[0]!;
check(tx1.some((x) => x.name === "approve" && x.acct === usdcA && x.amount === 50_000_000n), "USDC allowed up to the owner's $50 cap", tx1);
check(tx1.some((x) => x.name === "approve" && x.acct === coinA && x.amount === 100_000_000n), "exactly 100 USELESS allowed for the take-profit", tx1);
check(!tx1.some((x) => x.name === "transfer" || x.name === "sync"), "nothing is wrapped for a coin", tx1);
const sb = calls.filter((c) => c.route === "sync").at(-1)!.body;
const rTp = sb.rules.find((r: any) => r.id === tp.id), rBuy = sb.rules.find((r: any) => r.id === buy.id);
check(rTp.token === COIN && rTp.symbol === "USELESS" && rTp.sell_amount === 100 && rBuy.token === COIN && rBuy.amount_usd === 10, "the server gets each coin rule by mint, with its name", sb.rules);
check(sb.away?.last_decision === lastSeen && sb.away.drop_pct === 8, "and when Autopilot last checked in here", sb.away);
check(s.view().held?.coins?.[COIN]?.allowed === 100 && s.view().held?.coins?.[COIN]?.symbol === "USELESS", "the wallet shows what Tollkit may sell of the coin", s.view().held);
const n1 = sent.length; await s.sync();
check(sent.length === n1, "nothing re-signed while the allowances still fit");

// Unverified and suspicious coins stay on the device.
const raw = await store.add({ kind: "dca", chain: "solana", token: SKETCHY, amount_usd: 5, every: "day" }, "owner", true);
const sus = await store.add({ kind: "dca", chain: "solana", token: SUS, amount_usd: 5, every: "day" }, "owner", true);
s.set(raw.id, true); s.set(sus.id, true);
out = await s.sync();
check(/isn't verified/.test(out.problems[raw.id] ?? "") && /suspicious/.test(out.problems[sus.id] ?? ""), "an unverified coin and a flagged one stay on the device, and say why", out.problems);
check(!calls.filter((c) => c.route === "sync").at(-1)!.body.rules.some((r: any) => r.id === raw.id || r.id === sus.id), "neither reaches the server");
check(s.handedOff(raw.id) === false, "so the device keeps trading it itself");
s.set(raw.id, false); s.set(sus.id, false);

// Autopilot's own rule on the coin: marked, with the price Autopilot last saw.
const ap = await store.add({ kind: "dca", chain: "solana", token: COIN, amount_usd: 5, every: "hour" }, "agent", true, "superbot");
await store.mutate((rs) => { const r = rs.find((x) => x.id === ap.id)!; r.state.last_price = 0.17; });
s.set(ap.id, true);
await s.sync();
const apR = calls.filter((c) => c.route === "sync").at(-1)!.body.rules.find((r: any) => r.id === ap.id);
check(apR?.ap === true && apR.ref_price === 0.17, "an Autopilot rule goes with the price Autopilot last saw", apR);
check(calls.filter((c) => c.route === "sync").at(-1)!.body.rules.find((r: any) => r.id === buy.id).ap === undefined, "the owner's own rules aren't marked");

// What the server paused while away comes back once, into Autopilot's decisions.
awayLog = [{ ts: "2026-10-29T14:10:00.000Z", rule_id: ap.id, text: "USELESS fell 8.8% below $0.170, the price Autopilot last saw. Paused until you're back." }];
await s.sync(); await s.sync();
check(awayNotes.length === 1 && /fell 8\.8%/.test(awayNotes[0].text), "the server's away note arrives once", awayNotes);

// Turning the take-profit off ends the coin allowance (the buys don't need one).
s.set(tp.id, false);
await s.sync();
check(sent.at(-1)!.some((x) => x.name === "revoke" && x.acct === coinA) && accts[coinA]!.delegated === 0n, "with no USELESS sells on 24/7, its allowance is revoked", sent.at(-1));

// Another device reads the allowances from the chain without changing anything.
accts[coinA]!.delegate = DELEGATE; accts[coinA]!.delegated = 7_000_000n;
const n2 = sent.length; await s.refreshHeld();
check(sent.length === n2 && s.view().held?.coins?.[COIN]?.allowed === 7, "refreshHeld reads what Tollkit may move, sends nothing", s.view().held);

// Off: every coin allowance ends; the coins stay put.
s.set(tp.id, true); await s.sync();
await s.off();
check(sent.at(-1)!.some((x) => x.name === "revoke" && x.acct === coinA) && !sent.at(-1)!.some((x) => x.name === "close" && x.acct === coinA), "turning 24/7 off revokes the coin allowance and keeps the coins", sent.at(-1));
check(accts[coinA]!.amount === 900_000_000n, "the coins themselves never moved");

console.log(`\nalwayson-sol-coins: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
