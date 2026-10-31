/** Think 24/7, the device side: what Autopilot sends the server, taking over what the server started while away, the server's decisions in the log, Active mode, and the AI balance top-up. Fake wallet, chain and server; no network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { RuleStore } from "../src/rules.js";
import { SuperBot, parseSettings, ruleFromServer } from "../src/superbot.js";
import { SolAlwaysOn, USDC_MINT, WSOL_MINT, type TokenAcct } from "../src/alwayson-sol.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "t247-"));

check(parseSettings({}).think_24_7 === false && parseSettings({}).active_mode === false, "Think 24/7 and Active mode are off by default");
check(parseSettings({ think_24_7: true, active_mode: 1 }).think_24_7 === true && parseSettings({ active_mode: 1 }).active_mode === true, "and the owner turns them on");

function world(price = 100) {
  const dir = tmp();
  let now = Date.parse("2026-11-02T08:00:00Z");
  const store = new RuleStore(dir);
  const alwaysSol = { on: new Map<string, number | undefined>(), isOn: (id: string) => alwaysSol.on.has(id), set: (id: string, on: boolean, b?: number) => { if (on) alwaysSol.on.set(id, b); else alwaysSol.on.delete(id); }, config: async () => ({ enabled: true, delegate: "So1" }) };
  const always = { isOn: () => false, set: () => {}, config: async () => ({ enabled: false }) };
  let decision: any = { assessment: "Flat.", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "-", sources: [] }] };
  const w: any = { dir, policy: { chains: ["base", "solana"] }, rules: () => store, always: () => always, alwaysSol: () => alwaysSol,
    pay: async (_u: string, init: any) => ({ paid: true, status: 200, response: new Response(JSON.stringify({ decision, snapshot_id: JSON.parse(init.body).snapshot_id, model: "m" })) }) };
  const fetch = (async () => Response.json({ id: `snap-${now}`, at: new Date(now).toISOString(), changes: { moved: true } })) as any;
  const bot = new SuperBot(w, { dir, proxy: "https://api.test/wallet", fetch, now: () => now, price: async () => price, knownToken: async (_c, t) => ["ETH", "SOL", "USDC"].includes(t.toUpperCase()), active: () => true });
  return { bot, store, alwaysSol, advance: (ms: number) => { now += ms; }, setDecision: (d: any) => { decision = d; } };
}

// ─── what goes to the server ──────────────────────────────────────────────
{
  const x = world();
  await x.bot.enable({ chains: ["base", "solana"], tokens: [{ chain: "base", token: "ETH" }, { chain: "solana", token: "SOL" }] });
  check(x.bot.brainInfo() === null, "nothing for the server while Think 24/7 is off");
  await x.bot.setSettings({ think_24_7: true });
  check(x.bot.brainInfo() === null, "nor without Run 24/7 (the server's strategies need its allowance)");
  await x.bot.setSettings({ always_on: true, active_mode: true });
  x.setDecision({ assessment: "Sideways.", market_view: "neutral", confidence: 0.6, actions: [{ type: "propose", template: "grid", chain: "solana", token: "SOL", params: { amount_usd: 10, range_pct: 5, levels: 5 }, reason: "Range.", sources: [] }] });
  await x.bot.cycle(true);
  const bi: any = x.bot.brainInfo();
  check(bi?.on === true && bi.active === true, "on, with Active mode", bi);
  check(JSON.stringify(bi.settings.tokens) === JSON.stringify([{ token: "SOL" }]), "only Solana tokens go", bi.settings.tokens);
  check(bi.strategies.length === 1 && bi.strategies[0].template === "grid" && bi.strategies[0].rule_ids.length === 1 && bi.strategies[0].stage === "paper", "its Solana strategies, with their rule ids", bi.strategies);
}

// ─── back from away: decisions and strategies taken over ──────────────────
{
  const x = world();
  await x.bot.enable({ chains: ["solana"], tokens: [{ chain: "solana", token: "SOL" }], always_on: true, think_24_7: true });
  x.setDecision({ assessment: "Dip buyer.", market_view: "neutral", confidence: 0.6, actions: [{ type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 5, every: "day" }, reason: "Steady.", sources: [] }] });
  await x.bot.cycle(true);
  const mine = x.bot.view().strategies[0]!;
  const sv = { id: "srv1", name: "Grid trader · SOL", template: "grid", token: "SOL", params: { amount_usd: 10, range_pct: 5, levels: 5 }, stage: "paper", created_at: "2026-11-02T03:00:00Z", stage_since: "2026-11-02T03:00:00Z",
    history: [{ ts: "2026-11-02T03:00:00Z", note: "Proposed by the AI while you were away: Range." }],
    rules: [{ id: "srvrule1", kind: "grid", amount_usd: 10, lower_price: 95, upper_price: 105, levels: 5, runs: 2, ap: true, srv: "srv1", paper: true, ref_price: 100, bot: { v: 2, grid: { units: [0.1, null, null, null], cost: [9.9, null, null, null], atomic: ["100000000", null, null, null] } } }] };
  const log = [{ id: "L1", ts: "2026-11-02T03:00:00Z", by: "server", market_view: "neutral", assessment: "Sideways.", confidence: 0.6, model: "m", cost_usd: 0.005, actions: [{ type: "propose", template: "grid", chain: "solana", token: "SOL", reason: "Range.", sources: [], applied: true, outcome: "started on paper on TOLLkit's server" }] },
    { id: "L2", ts: "2026-11-02T04:00:00Z", by: "server", market_view: "risk_off", assessment: "Risk off.", confidence: 0.6, model: "m", cost_usd: 0.005, actions: [{ type: "retire", strategy_id: mine.id, reason: "Falling.", sources: [], applied: true, outcome: "retired" }] }];
  const ids = await x.bot.adoptServer({ strategies: [sv], log });
  check(JSON.stringify(ids) === '["srv1"]', "tells the server which strategies it took over", ids);
  const r = x.store.get("srvrule1");
  check(!!r && r.paper === true && r.by === "superbot" && r.kind === "grid" && r.state.grid?.atomic[0] === "100000000" && r.state.runs === 2, "the server's rule, same id, with what its grid holds", r);
  const v = x.bot.view();
  const s1 = v.strategies.find((z: any) => z.id === "srv1");
  check(!!s1 && s1.stage === "paper" && s1.bot === r!.bot, "a strategy in Autopilot's list, practising on paper here", s1);
  check(v.strategies.find((z: any) => z.id === mine.id)!.stage === "retired", "what the server retired is retired here too");
  const srvDec = v.decisions.filter((d: any) => d.by === "server");
  check(srvDec.length === 2 && /^While you were away/.test(srvDec[0]!.assessment) && srvDec[0]!.ts === "2026-11-02T04:00:00.000Z".replace(".000", "") , "the server's decisions are in the log, at their own times", srvDec.map((d: any) => [d.ts, d.assessment]));
  const again = await x.bot.adoptServer({ strategies: [sv], log });
  check(JSON.stringify(again) === '["srv1"]' && x.store.list().filter((y) => y.id === "srvrule1").length === 1 && x.bot.view().decisions.filter((d: any) => d.by === "server").length === 2, "taking over twice changes nothing");
  // A live one keeps running 24/7.
  await x.bot.adoptServer({ strategies: [{ ...sv, id: "srv2", stage: "live", rules: [{ id: "srvrule2", kind: "dca", amount_usd: 5, every: "day", runs: 0, ap: true, srv: "srv2" }] }], log: [] });
  check(x.alwaysSol.isOn("srvrule2") && x.store.get("srvrule2")!.paper === undefined, "a live one is switched to Run 24/7 here, so the server keeps running it");
  check(ruleFromServer({ id: "a", kind: "signal_buy", amount_usd: 5, when: { signal: "rsi_below", tf: "1h" }, armed: false, runs: 1 }, { token: "SOL", template: "signal", name: "Trade on a signal · SOL" }, "b", "2026-11-02T00:00:00Z", true).state.alert_armed === false, "a signal that already fired waits for it to clear");
}

// ─── Active mode on the device ────────────────────────────────────────────
{
  const x = world();
  await x.bot.enable({ chains: ["solana"], tokens: [{ chain: "solana", token: "SOL" }], paper_days: 1, active_mode: true });
  x.setDecision({ assessment: "Steady.", market_view: "neutral", confidence: 0.6, actions: [{ type: "propose", template: "dca", chain: "solana", token: "SOL", params: { amount_usd: 5, every: "day", times: 2 }, reason: "Steady.", sources: [] }] });
  await x.bot.cycle(true);
  const st = x.bot.view().strategies[0]!;
  // A paper buy at $90, now worth more at $100: it beat holding USDC.
  await x.store.mutate((rs) => { for (const r of rs) if (r.bot === st.bot) { r.state.fills.push({ ts: new Date().toISOString(), ok: true, usd: 5, units: 0.0556, side: "buy", paper: true }); r.state.spent_usd = 5; r.state.bought_units = 0.0556; r.state.ok_count = 1; r.state.last_price = 100; } });
  x.setDecision({ assessment: "Flat.", market_view: "neutral", confidence: 0.5, actions: [{ type: "keep", reason: "-", sources: [] }] });
  x.advance(25 * 3600_000);
  await x.bot.cycle(true);
  const after = x.bot.view().strategies.find((z: any) => z.id === st.id)!;
  check(after.stage === "live" && !after.ready, "Active mode: it went live by itself", after);
  check(x.bot.view().decisions.some((d: any) => /Active mode is on/.test(d.assessment)), "and the log says why");
}

// ─── the client: hand-off order, adopted ids, top-up ──────────────────────
{
  const kp = Keypair.generate(), OWN = kp.publicKey.toBase58(), TREASURY = Keypair.generate().publicKey.toBase58(), DELEGATE = Keypair.generate().publicKey.toBase58();
  const usdcA = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), kp.publicKey).toBase58();
  const accts: Record<string, TokenAcct> = { [usdcA]: { exists: true, amount: 40_000_000n, delegate: null, delegated: 0n } };
  const sent: TransactionInstruction[][] = [];
  const chain = { lamports: async () => 1_000_000_000n, token: async (a: string) => ({ ...(accts[a] ?? { exists: false, amount: 0n, delegate: null, delegated: 0n }) }), send: async (ixs: TransactionInstruction[]) => { sent.push(ixs); return "TopupSig" + sent.length; } };
  const calls: { route: string; body: any }[] = [];
  let topupSeen = 0;
  const brain = { on: true, active: false, thinking: false, last_step: null, last_error: null, halted: null, credit: { balance_usd: 0, free: false, decision_usd: 0.005, credit_to: TREASURY, decisions: 0, spent_usd: 0 },
    strategies: [{ id: "srvA", name: "Steady buyer · SOL", template: "dca", token: "SOL", params: { amount_usd: 5, every: "day" }, stage: "paper", created_at: "2026-11-02T03:00:00Z", stage_since: "2026-11-02T03:00:00Z", history: [], rules: [{ id: "ruleA", kind: "dca", amount_usd: 5, every: "day", runs: 1, paper: true, srv: "srvA" }] }], log: [] };
  const fetch = (async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/config")) return new Response(JSON.stringify({ enabled: true, delegate: DELEGATE, brain: { decision_usd: 0.005, credit_to: TREASURY, free: false } }));
    const route = url.pathname.split("/").pop()!, body = JSON.parse(String(init!.body));
    calls.push({ route, body });
    if (route === "state") return new Response(JSON.stringify({ delegate: DELEGATE, fills: [{ id: "pf1", rule_id: "ruleA", ts: "2026-11-02T03:05:00Z", ok: true, usd: 5, units: 0.05, side: "buy", paper: true }], rules: {}, brain }));
    if (route === "sync") return new Response(JSON.stringify({ ok: true, running: [] }));
    if (route === "topup") { topupSeen++; return topupSeen < 2 ? new Response(JSON.stringify({ error: "not yet" }), { status: 404 }) : new Response(JSON.stringify({ ...brain.credit, balance_usd: 5, credited_usd: 5 })); }
    return new Response(JSON.stringify({ ok: true }));
  }) as any;
  const dir = tmp(), store = new RuleStore(dir);
  const s = new SolAlwaysOn({ key: () => kp, address: OWN, dir, rpc: "http://unused", proxy: "https://api.tollkit.dev/wallet", rules: () => store, chain, fetch });
  let order: string[] = [];
  s.brainInfo = () => ({ on: true, active: false, settings: {}, strategies: [] });
  s.onBrain = async (b) => { order.push("brain"); await store.mutate((rs) => { rs.push(ruleFromServer(b.strategies[0].rules[0], b.strategies[0], "bb", "2026-11-02T03:00:00Z", true)); }); return ["srvA"]; };
  await s.sync();
  const r = store.get("ruleA");
  check(!!r && r.state.spent_usd === 5 && r.state.fills[0]?.paper === true, "the strategy is taken over before the fills, so its pretend buy lands on it", r?.state);
  const sync1 = calls.filter((c) => c.route === "sync").at(-1)!;
  check(sync1.body.brain?.on === true && JSON.stringify(sync1.body.brain.adopted) === '["srvA"]', "the sync tells the server Think 24/7 is on and which strategy was taken over", sync1.body.brain);
  await s.sync();
  check(JSON.stringify(calls.filter((c) => c.route === "sync").at(-1)!.body.brain.adopted) === '["srvA"]', "until the server stops sending it, it's named again");
  check((s.view() as any).brain?.credit?.credit_to === TREASURY && !("strategies" in ((s.view() as any).brain ?? {})), "the server's report is kept, without its strategies");
  // Top-up: a USDC transfer to TOLLkit, then the server is asked until it has read it.
  const t = await s.topup(5);
  const ix = sent.at(-1)!;
  check(ix.length === 2 && ix[1]!.data[0] === 12 && ix[1]!.data.readBigUInt64LE(1) === 5_000_000n, "one transaction: make sure TOLLkit's USDC account exists, then send exactly $5.00 (transferChecked)", ix.map((i) => i.data[0]));
  check(ix[1]!.keys[2]!.pubkey.toBase58() === getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(TREASURY), true).toBase58(), "to TOLLkit's own USDC account");
  check(t.credited && t.credit?.balance_usd === 5 && (s.view() as any).topup_pending === null, "credited once the server read it from the chain", t);
  let e = ""; try { await s.topup(500); } catch (x) { e = (x as Error).message; }
  check(/between \$1 and \$100/.test(e), "a top-up is $1 to $100");
  void WSOL_MINT; order = [];
}

console.log(`\nthink247: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
