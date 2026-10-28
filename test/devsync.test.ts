/** 0.9.7: Sync my devices (src/devsync.ts): two devices, one wallet, a stand-in for Tollkit's server. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Wallet, verifyMessage } from "ethers";
import { DeviceSync, syncKey, seal, open } from "../src/devsync.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d)); } };

const key = Wallet.createRandom(), other = Wallet.createRandom();
// The server: one copy per wallet, numbered; only signed requests; a stale save is refused (412).
const store = new Map<string, { rev: number; blob: string | null }>();
const sent: string[] = [];
let failNext = 0, racer: (() => void) | null = null;
const server = (async (url: string, init: any) => {
  const route = String(url).split("/").pop()!, h = init.headers, body = String(init.body);
  const msg = `Tollkit Sync\n${route}\n${h["x-tk-address"]}\n${h["x-tk-ts"]}\n${createHash("sha256").update(body).digest("hex")}`;
  if (verifyMessage(msg, h["x-tk-sig"]).toLowerCase() !== h["x-tk-address"].toLowerCase()) return new Response(JSON.stringify({ error: "bad sig" }), { status: 401 });
  if (failNext > 0) { failNext--; return new Response("{}", { status: 503 }); }
  const k = h["x-tk-address"].toLowerCase(), cur = store.get(k) ?? { rev: 0, blob: null };
  if (route === "get") return new Response(JSON.stringify(cur));
  const b = JSON.parse(body);
  if (racer) { const r = racer; racer = null; r(); return new Response(JSON.stringify({ error: "Another device saved first.", rev: store.get(k)!.rev }), { status: 412 }); }
  if (b.base_rev !== (store.get(k)?.rev ?? 0)) return new Response(JSON.stringify({ error: "Another device saved first.", rev: cur.rev }), { status: 412 });
  sent.push(b.blob);
  store.set(k, { rev: cur.rev + 1, blob: b.blob });
  return new Response(JSON.stringify({ rev: cur.rev + 1 }));
}) as any;

const dev = (name: string, k = key) => { const dir = mkdtempSync(path.join(os.tmpdir(), `sync-${name}-`)); return { dir, s: new DeviceSync({ dir, address: k.address, key: () => k, proxy: "https://x/wallet", fetch: server, deviceName: name }) }; };
const put = (dir: string, f: string, v: unknown) => writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v));
const get = (dir: string, f: string) => existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : null;
const led = (id: string, ts: string) => JSON.stringify({ id, ts, kind: "trade", status: "done", usd: 5 }) + "\n";

// The lock: same wallet, same key; another wallet can't open it.
{
  const sealed = seal(syncKey(key.privateKey), "hello bots");
  check(open(syncKey(key.privateKey), sealed) === "hello bots", "the copy opens with this wallet's key");
  let err = ""; try { open(syncKey(other.privateKey), sealed); } catch (e) { err = String(e); }
  check(err !== "", "another wallet's key can't open it");
}

const A = dev("Chrome"), B = dev("iPhone");
put(A.dir, "rules.json", [{ id: "g1", kind: "grid", token: "ETH" }]);
put(A.dir, "superbot.json", { enabled: true, settings: { pace: "active" } });
appendFileSync(path.join(A.dir, "ledger.jsonl"), led("t1", "2026-10-20T10:00:00Z"));
put(A.dir, "keystore.json", { secret: "KEYS-NEVER-LEAVE" });
put(A.dir, "policy.json", { sealed: "per-device" });

// 1. The first device turns it on: it uploads and runs the bots.
await A.s.turnOn();
check(store.get(key.address.toLowerCase())?.rev === 1 && A.s.runsHere() && A.s.view().devices[0]!.runs_bots, "first device: uploads, and runs the bots");
const raw = Buffer.from(sent.at(-1)!, "base64").toString("latin1");
check(!/grid|g1|superbot|KEYS-NEVER-LEAVE/.test(raw), "the server only ever sees scrambled bytes (no rule names)");
const plain = open(syncKey(key.privateKey), sent.at(-1)!);
check(!plain.includes("KEYS-NEVER-LEAVE") && !plain.includes("per-device"), "keys and the spending limits are never in the copy");

// 2. The phone joins: it gets the bots, Autopilot and history, and doesn't trade.
await B.s.turnOn();
check(get(B.dir, "rules.json") === get(A.dir, "rules.json") && get(B.dir, "superbot.json") === get(A.dir, "superbot.json"), "the phone gets the bots and Autopilot");
check((get(B.dir, "ledger.jsonl") ?? "").includes('"t1"'), "and the trade history");
check(!B.s.runsHere() && B.s.view().runner === A.s.view().here.id, "the phone shows them but doesn't trade (Chrome runs them)");
check(B.s.view().devices.length === 2, "both devices are listed", B.s.view().devices);

// 3. A bot made on the phone reaches Chrome, which runs it.
put(B.dir, "rules.json", [{ id: "g1", kind: "grid", token: "ETH" }, { id: "d2", kind: "smart_dca", token: "SOL" }]);
await B.s.sync(); await A.s.sync();
check((get(A.dir, "rules.json") ?? "").includes("d2"), "a bot made on the phone reaches the device that runs bots");

// 3b. A bot made on the phone while Chrome's bots were trading (rules changed on both): both kept.
put(A.dir, "rules.json", [{ id: "g1", kind: "grid", token: "ETH", state: { runs: 5 } }, { id: "d2", kind: "smart_dca", token: "SOL" }]);
put(B.dir, "rules.json", [{ id: "g1", kind: "grid", token: "ETH" }, { id: "d2", kind: "smart_dca", token: "SOL" }, { id: "n3", kind: "dip_buy", token: "ETH" }]);
await A.s.sync(); await B.s.sync(); await A.s.sync();
const ra = JSON.parse(get(A.dir, "rules.json")!), rb = JSON.parse(get(B.dir, "rules.json")!);
check(ra.length === 3 && ra.find((r: any) => r.id === "g1").state?.runs === 5 && ra.some((r: any) => r.id === "n3") && JSON.stringify(ra) === JSON.stringify(rb), "rules changed on both: the trading device's state kept, the phone's new bot added", ra);

// 4. Trades on both sides: every one kept, once, in time order.
appendFileSync(path.join(A.dir, "ledger.jsonl"), led("t3", "2026-10-22T10:00:00Z"));
appendFileSync(path.join(B.dir, "ledger.jsonl"), led("t2", "2026-10-21T10:00:00Z"));
await A.s.sync(); await B.s.sync(); await A.s.sync();
const ids = (d: string) => (get(d, "ledger.jsonl") ?? "").trim().split("\n").map((l) => JSON.parse(l).id);
check(JSON.stringify(ids(A.dir)) === '["t1","t2","t3"]' && JSON.stringify(ids(B.dir)) === '["t1","t2","t3"]', "trade history merges line by line, nothing lost or doubled", [ids(A.dir), ids(B.dir)]);

// 5. Both change the same file: the device running the bots wins (it's the one trading).
put(A.dir, "paper.json", { from: "chrome" }); put(B.dir, "paper.json", { from: "phone" });
await A.s.sync(); await B.s.sync(); await A.s.sync();
check(get(A.dir, "paper.json") === get(B.dir, "paper.json") && (get(B.dir, "paper.json") ?? "").includes("chrome"), "a clash goes to the device that runs the bots");

// 6. Run bots here: the phone takes over; Chrome stops at its next sync.
await B.s.runHere(); await A.s.sync();
check(B.s.runsHere() && !A.s.runsHere(), "Run bots here moves the bots to the phone; Chrome stops");

// 7. Two devices saving at once: the late one re-reads and tries again.
put(A.dir, "tokens.json", { base: ["0xabc"] });
racer = () => { const k = key.address.toLowerCase(); store.set(k, { rev: store.get(k)!.rev + 1, blob: store.get(k)!.blob }); };
await A.s.sync();
check(A.s.view().last_error === null && (open(syncKey(key.privateKey), store.get(key.address.toLowerCase())!.blob!)).includes("0xabc"), "a save that lost the race is retried on the newer copy");

// 8. The server down: nothing changes here, the error is shown, and the next sync works.
failNext = 1;
let e8 = ""; try { await A.s.sync(); } catch (e) { e8 = String((e as Error).message); }
check(/HTTP 503/.test(e8) && A.s.view().last_error !== null, "server trouble is reported, not hidden", e8);
await A.s.sync();
check(A.s.view().last_error === null, "and clears on the next sync");

// 9. Off: this device keeps its files and trades on its own again.
A.s.turnOff();
check(A.s.runsHere() && !A.s.view().on && get(A.dir, "rules.json") !== null, "turning sync off keeps the files and runs bots here again");

// 10. A different wallet's device can't join this copy.
const C = dev("Other", other);
await C.s.turnOn();
check(get(C.dir, "rules.json") === null && C.s.runsHere(), "another wallet never sees this wallet's copy");

// 11. 0.9.8 Remove: the phone takes the old Mac off the list; the Mac stops at its next check-in, keeps its files,
//     and can join again as a new device. The bots move to the phone if the Mac ran them.
{
  const k3 = Wallet.createRandom();
  const P = dev("Phone", k3), M = dev("Mac", k3), Cr = dev("Chrome", k3);
  put(M.dir, "rules.json", [{ id: "r1", kind: "dca" }]);
  await M.s.turnOn(); await P.s.turnOn(); await Cr.s.turnOn(); await M.s.sync(); await P.s.sync();
  const macId = M.s.view().here.id;
  check(P.s.view().devices.length === 3 && !P.s.runsHere() && M.s.runsHere(), "three devices, the Mac runs the bots", P.s.view().devices.map((d) => d.name));
  let eSelf = ""; try { await P.s.remove(P.s.view().here.id); } catch (e) { eSelf = String((e as Error).message); }
  check(/turn Sync my devices off/.test(eSelf), "a device can't remove itself (it turns sync off instead)", eSelf);
  await P.s.remove(macId);
  check(!P.s.view().devices.some((d) => d.id === macId) && P.s.runsHere(), "the phone drops the Mac and takes over the bots");
  await M.s.sync();
  const mv = M.s.view();
  check(!mv.on && !!mv.removed_at && M.s.runsHere() && get(M.dir, "rules.json") !== null, "the Mac stops syncing at its next check-in, says it was removed, keeps its files", mv);
  await Cr.s.sync();
  check(!Cr.s.view().devices.some((d) => d.id === macId) && !Cr.s.runsHere(), "Chrome no longer lists the Mac, and leaves the bots to the phone");
  await P.s.sync();
  check(!P.s.view().devices.some((d) => d.id === macId), "the Mac doesn't come back into the list on its own");
  await M.s.turnOn(); await P.s.sync();
  const nv = M.s.view();
  check(nv.on && !nv.removed_at && nv.here.id !== macId && P.s.view().devices.some((d) => d.id === nv.here.id) && !M.s.runsHere(), "turning sync on again joins as a new device, without the bots", nv);
}

console.log(`\ndevsync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
