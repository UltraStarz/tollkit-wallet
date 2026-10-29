/**
 * 0.9.7: "Sync my devices". The same wallet on a computer, in Chrome and on a phone keeps the same bots, rules,
 * Autopilot, paper strategies, trade history and token list.
 *
 * How:
 *   - Each device that has sync on keeps an encrypted copy of those files on Tollkit's server, one per wallet.
 *   - The copy is locked before it leaves the device with AES-256-GCM, under a key made from the wallet's own
 *     Base/Ethereum private key (HMAC-SHA256 of a fixed label). Every device with this wallet can make the same key;
 *     Tollkit's server can't, so it only ever stores and returns scrambled bytes.
 *   - Requests are signed with the same key (like Run 24/7), so only this wallet can read or replace its copy.
 *   - The server keeps a revision number; a device only replaces the copy it last saw, so two devices never
 *     overwrite each other blindly. Each file is merged on its own: the side that changed it wins; trade history
 *     (ledger.jsonl) is merged line by line, so no trade is ever lost.
 *   - One device runs the bots (the "runner"). The others show the same bots and history but don't trade, so
 *     nothing trades twice. "Run bots here" moves the job to this device.
 *
 * 0.9.8: Remove takes another device off the list. It stops syncing at its next check-in and says so; it can turn sync
 * on again (it holds the keys), and then it joins as a new device.
 *
 * Never synced: the keys (keystore.json), the spending limits (policy.json, sealed with each device's own password),
 * the AI key, Telegram, connected apps and websites, chat history, caches.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { getAddress } from "ethers";
import { walletHome } from "./paths.js";

/** What travels: the wallet's state, never its keys or anything sealed to one device. */
export const SYNC_FILES = ["rules.json", "bots.json", "superbot.json", "paper.json", "ideas.json", "setups.json", "tokens.json", "sales.json", "moves.json",
  "always.json", "always-sol.json", "app-budgets.json"] as const;
export const LEDGER = "ledger.jsonl";
const MAX_BYTES = 3_000_000;
const LABEL = "Tollkit device sync v1";

export interface Device { id: string; name: string; seen: string }
/** The decrypted copy. */
export interface Removed { id: string; name: string; at: string }
export interface Snapshot { v: 1; files: Record<string, { hash: string; at: string; data: string } | null>; ledger: string[]; runner: string | null; devices: Device[]; at: string; removed?: Removed[] }
interface Local { on: boolean; device: { id: string; name: string }; rev: number; base: Record<string, string>; last_sync: string | null; last_error: string | null; runner: string | null; devices: Device[]; removed: Removed[]; removed_at: string | null;
  /** 0.9.9: the runner lease (see mayTrade): when the server last confirmed this device runs the bots, and when it took them over. */
  runner_ok_at?: string | null; claimed_at?: string | null }
export interface SyncView { on: boolean; here: { id: string; name: string }; runner: string | null; runs_here: boolean; devices: (Device & { runs_bots: boolean; this_device: boolean })[]; last_sync: string | null; last_error: string | null; removed_at: string | null }

/** 0.9.9: how long a runner confirmation lasts, and how long a device that takes the bots over waits (mayTrade). */
export const RUNNER_LEASE_MS = 180_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The key that locks the copy: only someone holding this wallet's private key can make it. */
export function syncKey(evmPrivateKey: string): Buffer {
  return createHmac("sha256", Buffer.from(evmPrivateKey.replace(/^0x/, ""), "hex")).update(LABEL).digest();
}
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final()]), tag = c.getAuthTag();
  return Buffer.concat([Buffer.from(iv), Buffer.from(tag), body]).toString("base64");
}
export function open(key: Buffer, sealed: string): string {
  const b = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export interface SyncOpts {
  dir?: string;
  address: string;
  /** The wallet's Base/Ethereum key: signs requests and makes the lock key. */
  key: () => { privateKey: string; signMessage(m: string): Promise<string> };
  proxy: string;
  fetch?: typeof fetch;
  /** What this device is called in the list ("iPhone", "Chrome", "Mac"). */
  deviceName?: string;
  now?: () => number;
}

/** The winner's rules, plus rules only the other side has (by id). Null if either isn't a list. */
export function mergeRules(winner: string, other: string): string | null {
  try {
    const w = JSON.parse(winner), o = JSON.parse(other);
    if (!Array.isArray(w) || !Array.isArray(o)) return null;
    const ids = new Set(w.map((r: any) => r?.id));
    return JSON.stringify([...w, ...o.filter((r: any) => r?.id && !ids.has(r.id))], null, 2);
  } catch { return null; }
}

export class DeviceSync {
  private file: string;
  private home: string;
  private running: Promise<void> | null = null;
  constructor(private readonly o: SyncOpts) { this.home = walletHome(o.dir); this.file = path.join(this.home, "sync.json"); }
  private now() { return this.o.now?.() ?? Date.now(); }
  private get f(): typeof fetch { return this.o.fetch ?? ((i: any, n?: any) => fetch(i, n)); }

  private load(): Local {
    let l: Partial<Local> = {};
    try { if (existsSync(this.file)) l = JSON.parse(readFileSync(this.file, "utf8")); } catch { /* start over */ }
    return { on: !!l.on, device: l.device?.id ? l.device : { id: randomUUID().slice(0, 12), name: this.o.deviceName ?? "This device" }, rev: l.rev ?? 0, base: l.base ?? {},
      last_sync: l.last_sync ?? null, last_error: l.last_error ?? null, runner: l.runner ?? null, devices: l.devices ?? [], removed: l.removed ?? [], removed_at: l.removed_at ?? null, runner_ok_at: l.runner_ok_at ?? null, claimed_at: l.claimed_at ?? null };
  }
  private save(l: Local) {
    mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  view(): SyncView {
    const l = this.load();
    if (this.o.deviceName && l.device.name !== this.o.deviceName) { l.device.name = this.o.deviceName; this.save(l); }
    const devices = l.devices.some((d) => d.id === l.device.id) ? l.devices : [...l.devices, { id: l.device.id, name: l.device.name, seen: new Date(this.now()).toISOString() }];
    return { on: l.on, here: l.device, runner: l.runner, runs_here: this.runsHere(), devices: devices.map((d) => ({ ...d, runs_bots: d.id === l.runner, this_device: d.id === l.device.id })), last_sync: l.last_sync, last_error: l.last_error, removed_at: l.removed_at };
  }
  /**
   * 0.9.9: may this device place trades right now? A lease, so two devices never trade at once while the bots move.
   * With L = 3 minutes and a sync every minute: the runner trades only while the server confirmed it as the runner
   * within L (a sync is stamped with the time it was sent), and a device that takes the bots over waits L first.
   * The old runner's last confirmation was sent before the takeover, so it stops by takeover + L, which is when
   * the new one starts. A device alone on the list trades as before.
   */
  mayTrade(): boolean {
    const l = this.load(), me = l.device.id, now = this.now();
    if (!l.on) return true;
    if (l.runner && l.runner !== me) return false;
    if (!l.devices.some((d) => d.id !== me && now - Date.parse(d.seen) < 6 * 3600_000)) return true;
    if (l.claimed_at && now - Date.parse(l.claimed_at) < RUNNER_LEASE_MS) return false;
    return !!l.runner_ok_at && now - Date.parse(l.runner_ok_at) <= RUNNER_LEASE_MS;
  }
  /** Bots, Autopilot and Run 24/7 act here unless sync is on and another device runs them. */
  runsHere(): boolean { const l = this.load(); return !l.on || !l.runner || l.runner === l.device.id; }

  async turnOn(): Promise<SyncView> {
    const l = this.load();
    // Removed earlier: come back as a new device, so the old removal doesn't stop it again.
    if (l.removed_at) { l.device = { id: randomUUID().slice(0, 12), name: l.device.name }; l.removed_at = null; l.rev = 0; l.base = {}; l.runner = null; l.devices = []; }
    l.on = true; l.last_error = null; this.save(l); await this.sync(); return this.view();
  }
  /** Take another device off the list. It stops syncing at its next check-in; the bots move here if it ran them. */
  async remove(id: string): Promise<SyncView> {
    const l = this.load();
    if (!l.on) throw new Error("Turn on Sync my devices first.");
    if (id === l.device.id) throw new Error("To stop syncing this device, turn Sync my devices off.");
    const d = l.devices.find((x) => x.id === id);
    if (!d) throw new Error("That device isn't in the list any more.");
    l.devices = l.devices.filter((x) => x.id !== id);
    l.removed = [...l.removed.filter((x) => x.id !== id), { id, name: d.name, at: new Date(this.now()).toISOString() }].slice(-20);
    const tookBots = l.runner === id;
    if (tookBots) { l.runner = l.device.id; l.claimed_at = new Date(this.now()).toISOString(); }
    this.save(l);
    await this.sync(tookBots);
    return this.view();
  }
  turnOff(): SyncView { const l = this.load(); l.on = false; l.rev = 0; l.base = {}; this.save(l); return this.view(); }
  /** Move the bots to this device (the others stop trading at their next sync). */
  async runHere(): Promise<SyncView> { const l = this.load(); if (!l.on) throw new Error("Turn on Sync my devices first."); if (l.runner && l.runner !== l.device.id) l.claimed_at = new Date(this.now()).toISOString(); l.runner = l.device.id; this.save(l); await this.sync(true); return this.view(); }

  // ─── the server ───────────────────────────────────────────────────────────
  private async call(route: "get" | "put", body: object): Promise<any> {
    const text = JSON.stringify({ ...body, _n: randomUUID() }), ts = Math.floor(this.now() / 1000), me = getAddress(this.o.address);
    const sig = await this.o.key().signMessage(`Tollkit Sync\n${route}\n${me}\n${ts}\n${sha(text)}`);
    const r = await this.f(`${this.o.proxy}/sync/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-tk-address": me, "x-tk-ts": String(ts), "x-tk-sig": sig }, body: text, signal: AbortSignal.timeout(30_000) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 412) return { conflict: true, ...j }; // another device saved first
    if (!r.ok) throw new Error(j?.error ?? `Tollkit's server answered HTTP ${r.status}`);
    return j;
  }

  // ─── files ────────────────────────────────────────────────────────────────
  private read(name: string): string | null { const p = path.join(this.home, name); try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; } }
  private write(name: string, data: string) { const p = path.join(this.home, name), tmp = `${p}.sync.tmp`; writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, p); }
  private ledgerLines(): string[] { return (this.read(LEDGER) ?? "").split("\n").filter((x) => x.trim()); }

  /** This device's files as they are now. */
  private snapshot(l: Local, at: string): Snapshot {
    const files: Snapshot["files"] = {};
    for (const n of SYNC_FILES) { const d = this.read(n); files[n] = d === null ? null : { hash: sha(d), at, data: d }; }
    const devices = [...l.devices.filter((d) => d.id !== l.device.id), { id: l.device.id, name: l.device.name, seen: at }].slice(-12);
    return { v: 1, files, ledger: this.ledgerLines(), runner: l.runner, devices, at, removed: l.removed };
  }

  /**
   * Bring this device and the server's copy together. First time on a device that joins an existing copy, the
   * copy wins (the device was just set up). After that, per file: whichever side changed since the last sync wins;
   * if both did, the device that runs the bots wins (it's the one trading). Trade history is merged line by line.
   */
  async sync(claimRunner = false): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doSync(claimRunner).finally(() => { this.running = null; });
    return this.running;
  }
  private async doSync(claimRunner: boolean, attempt = 0): Promise<void> {
    const l = this.load();
    if (!l.on) return;
    const at = new Date(this.now()).toISOString(), key = syncKey(this.o.key().privateKey), before = l.runner;
    try {
      const got = await this.call("get", {});
      let remote: Snapshot | null = null;
      if (got.blob) {
        try { remote = JSON.parse(open(key, got.blob)) as Snapshot; }
        catch { throw new Error("The synced copy couldn't be opened with this wallet's key."); }
      }
      // Removed from another device: stop here, keep this device's files, and say so.
      if (remote?.removed?.some((x) => x.id === l.device.id)) {
        const after = this.load();
        Object.assign(after, { on: false, rev: 0, base: {}, runner: null, devices: [], removed_at: remote.removed.find((x) => x.id === l.device.id)!.at, last_error: null });
        this.save(after);
        return;
      }
      // Removals from either side, so a removed device never comes back into the list.
      const removed = [...l.removed];
      for (const x of remote?.removed ?? []) if (!removed.some((y) => y.id === x.id)) removed.push(x);
      l.removed = removed.slice(-20);
      const gone = new Set(l.removed.map((x) => x.id));
      const changed: string[] = [];
      if (remote && got.rev !== l.rev) {
        const firstJoin = l.rev === 0;
        const remoteRunsBots = !!remote.runner && remote.runner !== l.device.id;
        for (const n of SYNC_FILES) {
          const r = remote.files[n] ?? null, mine = this.read(n), mineHash = mine === null ? null : sha(mine), base = l.base[n] ?? null;
          if ((r?.hash ?? null) === mineHash) continue;
          const remoteChanged = (r?.hash ?? null) !== base, localChanged = mineHash !== base;
          const takeRemote = firstJoin || (remoteChanged && (!localChanged || remoteRunsBots));
          // Rules changed on both sides (the device running the bots updates them as it trades): keep its version of
          // each rule, plus any rule the other device added, so a bot made on the phone is never dropped.
          if (n === "rules.json" && !firstJoin && remoteChanged && localChanged && r && mine !== null) {
            const merged = mergeRules(takeRemote ? r.data : mine, takeRemote ? mine : r.data);
            if (merged !== null && sha(merged) !== mineHash) { this.write(n, merged); changed.push(n); }
            continue;
          }
          if (takeRemote && r) { this.write(n, r.data); changed.push(n); }
        }
        // Trade history: every line from either side, in time order, once.
        const mineLines = this.ledgerLines(), seen = new Set(mineLines), add = remote.ledger.filter((x) => !seen.has(x));
        if (add.length) {
          const all = [...mineLines, ...add].map((line, i) => ({ line, i, ts: (() => { try { return String(JSON.parse(line).ts ?? ""); } catch { return ""; } })() }));
          all.sort((a, b) => a.ts.localeCompare(b.ts) || a.i - b.i);
          this.write(LEDGER, all.map((x) => x.line).join("\n") + "\n"); changed.push(LEDGER);
        }
        if (!claimRunner) l.runner = remote.runner ?? l.runner;
        l.devices = remote.devices ?? l.devices;
      }
      l.devices = l.devices.filter((d) => !gone.has(d.id));
      if (l.runner && gone.has(l.runner)) l.runner = l.device.id;
      if (claimRunner || !l.runner) l.runner = l.device.id;
      // Now send this device's view back if the server's copy differs from it.
      const snap = this.snapshot(l, at);
      const same = remote && got.rev !== undefined && JSON.stringify(Object.fromEntries(SYNC_FILES.map((n) => [n, snap.files[n]?.hash ?? null]))) === JSON.stringify(Object.fromEntries(SYNC_FILES.map((n) => [n, remote!.files[n]?.hash ?? null])))
        && snap.ledger.length === remote.ledger.length && snap.runner === remote.runner && (snap.removed?.length ?? 0) === (remote.removed?.length ?? 0) && snap.devices.length === remote.devices.length && remote.devices.some((d) => d.id === l.device.id && this.now() - Date.parse(d.seen) < 6 * 3600_000);
      let rev = got.rev ?? 0;
      if (!same) {
        // Keep each file's time from the copy when it didn't change here.
        for (const n of SYNC_FILES) { const r = remote?.files[n]; if (r && snap.files[n]?.hash === r.hash) snap.files[n]!.at = r.at; }
        const blob = seal(key, JSON.stringify(snap));
        if (blob.length > MAX_BYTES) throw new Error("This wallet's history is too big to sync right now.");
        const put = await this.call("put", { base_rev: got.rev ?? 0, blob });
        if (put.conflict) { if (attempt < 2) return this.doSync(claimRunner, attempt + 1); throw new Error("Another device was syncing at the same time; trying again shortly."); }
        rev = put.rev;
      }
      const after = this.load(); // the device may have been switched off meanwhile
      // 0.9.9: the runner lease. Confirmed as the runner by this sync (stamped when it was sent), or not any more.
      const mine = l.runner === l.device.id;
      after.runner_ok_at = mine ? at : null;
      if (!mine) after.claimed_at = null; else if (before && before !== l.device.id && !after.claimed_at) after.claimed_at = at;
      Object.assign(after, { rev, runner: l.runner, devices: snap.devices, removed: l.removed, last_sync: at, last_error: null, base: Object.fromEntries(SYNC_FILES.map((n) => [n, snap.files[n]?.hash ?? null]).filter(([, h]) => h)) });
      this.save(after);
      if (changed.length) this.onChanged?.(changed);
    } catch (e) {
      const after = this.load(); after.last_error = String((e as Error).message).slice(0, 200); this.save(after);
      throw e;
    }
  }
  /** Set by the dashboard: files arrived from another device (reload rules, restart timers). */
  onChanged?: (files: string[]) => void;
}
