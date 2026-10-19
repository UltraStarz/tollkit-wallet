/**
 * Every trade and payment, as an append-only log (ledger.jsonl), plus a
 * cross-process lock so parallel agent calls can't overspend: a spend is
 * reserved under the lock before it is signed, then marked done or failed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { files, walletHome } from "./paths.js";
import type { Policy } from "./policy.js";

export type Kind = "trade" | "payment" | "withdrawal" | "stake" | "move" | "dapp";
export type Status = "pending" | "done" | "failed";

export interface Entry {
  id: string;
  ts: string;
  kind: Kind;
  status: Status;
  usd: number;          // reserved, then actual value
  fee_usd?: number;     // Tollkit's swap fee
  chain?: string;
  seller?: string;      // payment host, or the swap venue
  tool?: string;        // what was bought / "swap"
  detail?: string;      // e.g. "100 USDC -> 0.03 ETH"
  tx?: string;
  fee_tx?: string;      // Tollkit's fee, when it was sent on its own (Solana pairs Jupiter can't take it from)
  reason?: string;      // why it failed
  by?: string;          // the AI app that asked for it (src/aiuse.ts); absent when the owner or autopilot did
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` while holding the wallet lock (a directory; stale after 60 s). */
export async function withLock<T>(fn: () => Promise<T> | T, dir?: string, timeoutMs = 15_000): Promise<T> {
  const lock = files(walletHome(dir)).lock;
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (Date.now() - start > timeoutMs) throw new Error("wallet is busy (lock timeout)");
      await sleep(20 + Math.random() * 30);
    }
  }
  try { return await fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Latest state of every entry, oldest first. */
export function entries(dir?: string): Entry[] {
  const f = files(walletHome(dir)).ledger;
  if (!existsSync(f)) return [];
  const byId = new Map<string, Entry>();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line) as Entry; byId.set(e.id, { ...byId.get(e.id), ...e }); } catch { /* torn line */ }
  }
  return [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

const write = (e: Entry, dir?: string) => appendFileSync(files(walletHome(dir)).ledger, JSON.stringify(e) + "\n", { mode: 0o600 });
const today = (iso = new Date().toISOString()) => iso.slice(0, 10);

/** Spent (pending + done) today, UTC. */
export function spentToday(kind: Kind, dir?: string, seller?: string): number {
  const d = today();
  return entries(dir)
    .filter((e) => e.kind === kind && e.status !== "failed" && today(e.ts) === d && (!seller || e.seller === seller))
    .reduce((s, e) => s + e.usd, 0);
}

export class LimitError extends Error { constructor(msg: string, readonly code: string) { super(msg); } }

/**
 * Check the policy and reserve the spend, atomically. Returns the entry id.
 * `approved` = the human already approved this amount (Telegram), which lifts
 * the approval threshold but never the hard limits.
 */
export async function reserve(p: Policy, kind: Kind, usd: number, meta: Omit<Entry, "id" | "ts" | "kind" | "status" | "usd">, dir?: string): Promise<string> {
  if (!(usd >= 0) || !Number.isFinite(usd)) throw new LimitError("amount must be a finite number of dollars", "bad_amount");
  return withLock(() => {
    const per = kind === "trade" ? p.per_trade_usd : p.per_payment_usd;
    const daily = kind === "trade" ? p.daily_trades_usd : p.daily_payments_usd;
    if (usd > per) throw new LimitError(`$${usd.toFixed(4)} is over the per-${kind} limit of $${per}.`, "over_per_limit");
    const spent = spentToday(kind, dir);
    if (spent + usd > daily) throw new LimitError(`This would bring today's ${kind}s to $${(spent + usd).toFixed(4)}, over the daily limit of $${daily}.`, "over_daily_limit");
    if (kind === "payment" && meta.seller) {
      const s = spentToday("payment", dir, meta.seller);
      if (s + usd > p.per_seller_daily_usd) throw new LimitError(`Over the daily limit of $${p.per_seller_daily_usd} for ${meta.seller}.`, "over_seller_limit");
    }
    const id = randomUUID();
    write({ id, ts: new Date().toISOString(), kind, status: "pending", usd, ...meta }, dir);
    return id;
  }, dir);
}

export function settle(id: string, patch: Partial<Entry> & { status: "done" | "failed" }, dir?: string) {
  const prev = entries(dir).find((e) => e.id === id);
  if (!prev) throw new Error(`no ledger entry ${id}`);
  write({ ...prev, ...patch, id, ts: prev.ts }, dir);
}

/** Adds who asked for an entry (the AI app), without touching anything else about it. */
export function tagEntry(id: string, patch: Pick<Entry, "by">, dir?: string) {
  const prev = entries(dir).find((e) => e.id === id);
  if (prev) write({ ...prev, ...patch, id, ts: prev.ts }, dir);
}

/** Receipts as CSV, newest last. */
export function exportCsv(dir?: string, since?: string): string {
  const cols: (keyof Entry)[] = ["ts", "kind", "status", "usd", "fee_usd", "chain", "seller", "tool", "detail", "tx", "reason", "by", "id"];
  const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = entries(dir).filter((e) => !since || e.ts >= since);
  return [cols.join(","), ...rows.map((e) => cols.map((c) => esc(e[c])).join(","))].join("\n") + "\n";
}

/** Log an entry that isn't limited by the policy (owner withdrawals). */
export function record(e: Entry, dir?: string) { write(e, dir); }
