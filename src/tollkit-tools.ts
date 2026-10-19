/**
 * Tollkit's paid tools, offered to a connected AI by name (0.8.1): `tollkit_read_page`, `tollkit_web_search`,
 * `tollkit_sec_financials` and so on, each with its price. Until now an AI only had `pay_fetch` with a URL, so it
 * never knew these existed. Each call is an ordinary x402 payment from this wallet: the owner's payment limits,
 * the app's weekly budget, the seller check and the receipt all apply, and a failed call is never charged.
 *
 * The list comes from the server's catalog (GET api.tollkit.dev/tools.json), cached in the wallet folder and
 * refreshed in the background; a built-in snapshot (src/data/tollkit-tools.ts) covers the first run and offline.
 * The owner can hide any tool in Settings; hidden tools aren't offered at all. Only tollkit.dev hosts are ever
 * called, whatever the catalog says.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { walletHome } from "./paths.js";
import { TOLLKIT_TOOLS_SNAPSHOT } from "./data/tollkit-tools.js";

export interface CatalogTool {
  name: string; title: string; path: string; url: string; price_usd: number; description: string;
  input_schema: Record<string, unknown>; free_trial: boolean;
}

export const CATALOG_URL = "https://api.tollkit.dev/tools.json";
export const TOOL_PREFIX = "tollkit_";
const REFRESH_MS = 6 * 3600_000;
const HOST = /^https:\/\/([a-z0-9-]+\.)*tollkit\.dev\//;

const fileOf = (dir?: string) => path.join(walletHome(dir), "tollkit-tools.json");
const hiddenFile = (dir?: string) => path.join(walletHome(dir), "tollkit-tools-hidden.json");

function sane(t: unknown): t is CatalogTool {
  const x = t as CatalogTool;
  return !!x && typeof x.name === "string" && /^[a-z0-9_]{2,40}$/.test(x.name) && typeof x.title === "string" && typeof x.url === "string" && HOST.test(x.url)
    && typeof x.price_usd === "number" && x.price_usd >= 0 && x.price_usd <= 10 && typeof x.description === "string"
    && !!x.input_schema && typeof x.input_schema === "object" && (x.input_schema as any).type === "object";
}

/** The catalog to offer right now: the cached live one if it's sane, otherwise the built-in snapshot. */
export function readCatalog(dir?: string): { tools: CatalogTool[]; fetched_at: string | null; version: string } {
  try {
    const f = fileOf(dir);
    if (existsSync(f)) {
      const v = JSON.parse(readFileSync(f, "utf8"));
      const tools = (Array.isArray(v?.tools) ? v.tools : []).filter(sane);
      if (tools.length) return { tools, fetched_at: typeof v.fetched_at === "string" ? v.fetched_at : null, version: String(v.version ?? "?") };
    }
  } catch { /* fall back */ }
  return { tools: TOLLKIT_TOOLS_SNAPSHOT.tools.filter(sane), fetched_at: null, version: TOLLKIT_TOOLS_SNAPSHOT.version };
}

/** Fetches the live catalog when the cached one is older than six hours. Never throws; the snapshot always works. */
export async function refreshCatalog(dir: string | undefined, f: typeof fetch = (i, n) => fetch(i, n), now = Date.now()): Promise<boolean> {
  try {
    const cur = readCatalog(dir);
    if (cur.fetched_at && now - Date.parse(cur.fetched_at) < REFRESH_MS) return false;
    const r = await f(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return false;
    const j: any = await r.json();
    const tools = (Array.isArray(j?.tools) ? j.tools : []).filter(sane).map((t: CatalogTool) => ({ name: t.name, title: t.title, path: t.path, url: t.url, price_usd: t.price_usd, description: t.description, input_schema: t.input_schema, free_trial: !!t.free_trial }));
    if (!tools.length) return false;
    const file = fileOf(dir), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: String(j.version ?? "?"), fetched_at: new Date(now).toISOString(), tools }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function hiddenTools(dir?: string): string[] {
  try { const v = JSON.parse(readFileSync(hiddenFile(dir), "utf8")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
export function setHidden(dir: string | undefined, name: string, hidden: boolean): string[] {
  const list = hiddenTools(dir).filter((x) => x !== name);
  if (hidden) list.push(name);
  const file = hiddenFile(dir), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); renameSync(tmp, file);
  return list;
}

/** What the owner sees in Settings: every tool, its price, and whether it's offered. */
export function catalogView(dir?: string) {
  const c = readCatalog(dir), hidden = new Set(hiddenTools(dir));
  return { version: c.version, fetched_at: c.fetched_at, tools: c.tools.map((t) => ({ name: t.name, tool: TOOL_PREFIX + t.name, title: t.title, price_usd: t.price_usd, free_trial: t.free_trial, hidden: hidden.has(t.name) })) };
}

/** The tools to offer an AI: the catalog minus what the owner hid. */
export function offeredTools(dir?: string): CatalogTool[] {
  const hidden = new Set(hiddenTools(dir));
  return readCatalog(dir).tools.filter((t) => !hidden.has(t.name));
}

const money = (n: number) => `$${n % 1 ? String(n) : n}`;

/** The MCP description: what it does, what it costs, and that the owner's limits and this app's budget apply. */
export function describeTool(t: CatalogTool): string {
  return `${t.description}\n\nCosts ${money(t.price_usd)} per call, paid in USDC from this wallet (inside the owner's payment limits and your weekly budget); a failed call is never charged. Tollkit's own tool.`;
}

/**
 * JSON schema (the subset Tollkit's catalog uses: objects of strings, numbers, booleans, enums and string arrays)
 * to the zod shape the MCP server registers. Anything odd becomes "any", so a schema change can't break a tool.
 */
export function zodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, any>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [k, p] of Object.entries(props)) {
    let t: z.ZodTypeAny;
    if (Array.isArray(p?.enum) && p.enum.every((e: unknown) => typeof e === "string") && p.enum.length) t = z.enum(p.enum as [string, ...string[]]);
    else if (p?.type === "string") { let s = z.string(); if (typeof p.minLength === "number") s = s.min(p.minLength); if (typeof p.maxLength === "number") s = s.max(p.maxLength); if (typeof p.pattern === "string") { try { s = s.regex(new RegExp(p.pattern)); } catch { /* keep plain */ } } t = s; }
    else if (p?.type === "number" || p?.type === "integer") { let n = p.type === "integer" ? z.number().int() : z.number(); if (typeof p.minimum === "number") n = n.min(p.minimum); if (typeof p.maximum === "number") n = n.max(p.maximum); if (typeof p.exclusiveMinimum === "number") n = n.gt(p.exclusiveMinimum); t = n; }
    else if (p?.type === "boolean") t = z.boolean();
    else if (p?.type === "array") { const it = p.items?.type === "number" || p.items?.type === "integer" ? z.number() : p.items?.type === "string" ? z.string() : z.any(); let a = z.array(it); if (typeof p.maxItems === "number") a = a.max(p.maxItems); if (typeof p.minItems === "number") a = a.min(p.minItems); t = a; }
    else t = z.any();
    if (typeof p?.description === "string") t = t.describe(p.description);
    out[k] = required.has(k) ? t : t.optional();
  }
  return out;
}
