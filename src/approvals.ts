/**
 * Approvals on this computer, answered from the dashboard. Each request is a
 * small file in <wallet>/approvals/; the process that wants to spend waits
 * for the dashboard to mark it approved or denied. Used alongside Telegram:
 * whichever answers first wins. Only used while the dashboard is open
 * (it writes a heartbeat), so an agent never waits on a page nobody has open.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { walletHome } from "./paths.js";
import type { Decision } from "./telegram.js";

export interface ApprovalRequest { id: string; text: string; created: string; expires: string; status: "pending" | "approved" | "denied" | "timeout"; answered_by?: string }

const dirOf = (dir?: string) => { const d = path.join(walletHome(dir), "approvals"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const fileOf = (dir: string | undefined, id: string) => path.join(dirOf(dir), `${id}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(f: string, v: unknown) { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); renameSync(t, f); }
function read(f: string): ApprovalRequest | null { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }

/** The dashboard calls this every few seconds while it's open. */
export function heartbeat(dir?: string) { writeFileSync(path.join(dirOf(dir), ".heartbeat"), new Date().toISOString(), { mode: 0o600 }); }
export function dashboardOpen(dir?: string, now = Date.now()): boolean {
  try { return now - statSync(path.join(dirOf(dir), ".heartbeat")).mtimeMs < 15_000; } catch { return false; }
}

export function pending(dir?: string, now = Date.now()): ApprovalRequest[] {
  return readdirSync(dirOf(dir)).filter((n) => n.endsWith(".json"))
    .map((n) => read(path.join(dirOf(dir), n))).filter((r): r is ApprovalRequest => !!r && r.status === "pending" && Date.parse(r.expires) > now)
    .sort((a, b) => a.created.localeCompare(b.created));
}

/** Answer a pending request. Returns false if it was already answered or expired. */
export function decide(dir: string | undefined, id: string, d: "approved" | "denied", by = "dashboard"): boolean {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const f = fileOf(dir, id);
  const r = existsSync(f) ? read(f) : null;
  if (!r || r.status !== "pending" || Date.parse(r.expires) <= Date.now()) return false;
  writeAtomic(f, { ...r, status: d, answered_by: by });
  return true;
}

/** Wait for an answer from the dashboard. `signal` lets another channel (Telegram) win. */
export async function requestLocal(dir: string | undefined, text: string, o: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {}): Promise<Decision> {
  const id = randomBytes(8).toString("hex");
  const now = Date.now(), timeout = o.timeoutMs ?? 5 * 60_000;
  const f = fileOf(dir, id);
  writeAtomic(f, { id, text, created: new Date(now).toISOString(), expires: new Date(now + timeout).toISOString(), status: "pending" } satisfies ApprovalRequest);
  while (Date.now() - now < timeout) {
    const r = read(f);
    if (r?.status === "approved" || r?.status === "denied") return r.status;
    if (o.signal?.aborted) { const cur = read(f); if (cur?.status === "pending") writeAtomic(f, { ...cur, status: "timeout", answered_by: "other channel" }); return "timeout"; }
    await sleep(o.pollMs ?? 400);
  }
  const r = read(f);
  if (r?.status === "pending") writeAtomic(f, { ...r, status: "timeout" });
  return r?.status === "approved" || r?.status === "denied" ? r.status : "timeout";
}
