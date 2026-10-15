/**
 * Which tokens the wallet knows: a bundled list for Base and Ethereum, Jupiter's token data for Solana, and
 * the token check (Tollkit's own /chain/check facts, run free for the wallet at api.tollkit.dev/wallet/token/check).
 *
 * Sources (checked 2026-10-15):
 *  - Base/Ethereum: the Superchain Token List, src/data/token-list.ts (MIT; Base's docs name it as Base's reference
 *    list). Not a safety review: the list itself says tokens on it are not reviewed.
 *  - Base/Ethereum, at run time: the Uniswap Labs default token list (tokens.uniswap.org), which adds Base-native
 *    tokens the Superchain list lacks (AERO, DEGEN, cbBTC...). Fetched on this device at most daily and kept in
 *    memory; not bundled (its licence is GPL-3.0).
 *  - Solana: Jupiter Tokens API v2 (developers.jup.ag/docs/tokens): /search (symbol, name or up to 100 mints) and
 *    /toptraded/24h. No API key (0.5 requests a second); answers are kept on this device only, never bundled or
 *    passed on (Jupiter's API terms), and the wallet shows "Powered by Jupiter" where they appear.
 *  - Balances on Base/Ethereum for listed tokens: one Multicall3 aggregate3 call (0xcA11bde05977b3631167028862bE2a173976CA11,
 *    github.com/mds1/multicall; bytecode checked on both chains with eth_getCode on 2026-10-15).
 */
import { Interface, JsonRpcProvider, getAddress } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, NATIVE_EVM, WSOL, type Chain } from "./chains.js";
import { KNOWN } from "./tokens.js";
import { EVM_TOKENS, LOGO_BASE } from "./data/token-list.js";
import { DEFAULT_PROXY } from "./swap.js";

type Fetch = typeof fetch;
export interface ListedToken {
  chain: Chain; address: string; symbol: string; name: string; decimals: number; logo?: string;
  /** core: always shown; listed: on the bundled list or Jupiter-verified; unlisted: anything else. */
  trust: "core" | "listed" | "unlisted";
  /** Base/Ethereum: which list it's on. */
  source?: "superchain" | "uniswap";
  /** Solana, from Jupiter: its own signals. */
  jupiter?: { verified: boolean; strict: boolean; organic?: number; organicLabel?: string; suspicious?: boolean; mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPct?: number; liquidity?: number };
}

const CHAIN_ID: Record<number, Chain> = { 1: "ethereum", 8453: "base" };
const logoUrl = (p: string) => (!p ? undefined : /^https:\/\//.test(p) ? p : LOGO_BASE + p);
let evmCache: Map<Chain, ListedToken[]> | null = null;

const extra = new Map<Chain, ListedToken[]>();
let extraAt = 0, extraLoading: Promise<void> | null = null;
export const UNISWAP_LIST = "https://tokens.uniswap.org";
/** Adds the Uniswap default list (refreshed at most daily). Failures leave the bundled list as it is. */
export function loadExtraLists(f: Fetch = fetch): Promise<void> {
  if (Date.now() - extraAt < 86_400_000) return Promise.resolve();
  return (extraLoading ??= (async () => {
    try {
      const r = await f(UNISWAP_LIST, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return;
      const j: any = await r.json();
      const next = new Map<Chain, ListedToken[]>([["base", []], ["ethereum", []]]);
      for (const t of Array.isArray(j?.tokens) ? j.tokens : []) {
        const c = CHAIN_ID[t?.chainId];
        if (!c || typeof t.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t.address) || typeof t.symbol !== "string" || !Number.isInteger(t.decimals)) continue;
        next.get(c)!.push({ chain: c, address: getAddress(t.address), symbol: t.symbol.slice(0, 16), name: String(t.name ?? t.symbol).slice(0, 60), decimals: t.decimals, logo: typeof t.logoURI === "string" && t.logoURI.startsWith("https://") ? t.logoURI : undefined, trust: "listed", source: "uniswap" });
      }
      extra.clear(); for (const [k, v] of next) extra.set(k, v);
      extraAt = Date.now(); merged.clear();
    } catch { /* keep the bundled list */ } finally { extraLoading = null; }
  })());
}
const merged = new Map<Chain, ListedToken[]>();

/** Core tokens (ETH, USDC...) plus the bundled list and the Uniswap list, for Base or Ethereum. */
export function evmList(chain: Chain): ListedToken[] {
  if (chain === "solana") return [];
  const m = merged.get(chain);
  if (m) return m;
  const base = bundledList(chain), seen = new Set(base.map((t) => t.address.toLowerCase()));
  const all = [...base, ...(extra.get(chain) ?? []).filter((t) => !seen.has(t.address.toLowerCase()))];
  merged.set(chain, all);
  return all;
}
function bundledList(chain: Chain): ListedToken[] {
  if (chain === "solana") return [];
  if (!evmCache) {
    evmCache = new Map([["base", []], ["ethereum", []]]);
    for (const [id, address, symbol, name, decimals, logo] of EVM_TOKENS) {
      const c = CHAIN_ID[id]; if (!c) continue;
      evmCache.get(c)!.push({ chain: c, address: getAddress(address), symbol, name, decimals, logo: logoUrl(logo), trust: "listed", source: "superchain" });
    }
  }
  const core = Object.values(KNOWN[chain]).filter((t) => t.address !== NATIVE_EVM).map((t) => ({ chain, address: t.address, symbol: t.symbol, name: t.symbol, decimals: t.decimals, trust: "core" as const }));
  const listed = evmCache.get(chain)!.filter((t) => !core.some((k) => k.address.toLowerCase() === t.address.toLowerCase()));
  return [...core.map((k) => ({ ...k, logo: evmCache!.get(chain)!.find((t) => t.address.toLowerCase() === k.address.toLowerCase())?.logo })), ...listed];
}

export function isCoreToken(chain: Chain, address: string): boolean {
  return Object.values(KNOWN[chain]).some((k) => k.address.toLowerCase() === address.toLowerCase());
}
export function findListed(chain: Chain, address: string): ListedToken | undefined {
  return evmList(chain).find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/** Search the bundled list by symbol, name or address. Exact symbol matches and the list's own top tier come first. */
export function searchEvm(chain: Chain, q: string, limit = 20): ListedToken[] {
  const s = q.trim().toLowerCase();
  if (!s) return evmList(chain).slice(0, limit);
  const score = (t: ListedToken) => (t.trust === "core" ? 0 : 10) + (t.symbol.toLowerCase() === s ? 0 : t.symbol.toLowerCase().startsWith(s) ? 1 : t.name.toLowerCase().includes(s) ? 2 : 3);
  return evmList(chain).filter((t) => t.address.toLowerCase() === s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s)).sort((a, b) => score(a) - score(b)).slice(0, limit);
}

// ---- Solana: Jupiter ---------------------------------------------------------------------------------------
export const JUPITER = "https://api.jup.ag/tokens/v2";
const jupCache = new Map<string, { at: number; v: ListedToken | null }>();
function fromJupiter(x: any): ListedToken | null {
  if (!x || typeof x.id !== "string" || typeof x.decimals !== "number") return null;
  const tags: string[] = Array.isArray(x.tags) ? x.tags.map(String) : [];
  const verified = x.isVerified === true || tags.includes("verified");
  const core = isCoreToken("solana", x.id);
  return {
    chain: "solana", address: x.id, symbol: String(x.symbol ?? "").slice(0, 16), name: String(x.name ?? "").slice(0, 60), decimals: x.decimals,
    logo: typeof x.icon === "string" && /^https:\/\//.test(x.icon) ? x.icon : undefined,
    trust: core ? "core" : verified && !x.audit?.isSus ? "listed" : "unlisted",
    jupiter: {
      verified, strict: tags.includes("strict"), organic: typeof x.organicScore === "number" ? Math.round(x.organicScore) : undefined, organicLabel: x.organicScoreLabel,
      suspicious: x.audit?.isSus === true, mintAuthorityDisabled: x.audit?.mintAuthorityDisabled, freezeAuthorityDisabled: x.audit?.freezeAuthorityDisabled,
      topHoldersPct: typeof x.audit?.topHoldersPercentage === "number" ? Math.round(x.audit.topHoldersPercentage * 10) / 10 : undefined,
      liquidity: typeof x.liquidity === "number" ? Math.round(x.liquidity) : undefined,
    },
  };
}
async function jupGet(path: string, f: Fetch): Promise<any[]> {
  const r = await f(`${JUPITER}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`Jupiter token data isn't available right now (HTTP ${r.status}).`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
/** Symbol, name or mint search. */
export async function searchSolana(q: string, f: Fetch = fetch, limit = 20): Promise<ListedToken[]> {
  const s = q.trim();
  if (!s) return topSolana(f, limit);
  const out = (await jupGet(`/search?query=${encodeURIComponent(s.slice(0, 64))}`, f)).map(fromJupiter).filter((t): t is ListedToken => !!t);
  for (const t of out) jupCache.set(t.address, { at: Date.now(), v: t });
  return out.sort((a, b) => Number(b.trust === "listed") - Number(a.trust === "listed")).slice(0, limit);
}
let topCache: { at: number; v: ListedToken[] } | null = null;
export async function topSolana(f: Fetch = fetch, limit = 20): Promise<ListedToken[]> {
  if (!topCache || Date.now() - topCache.at > 3600_000) topCache = { at: Date.now(), v: (await jupGet("/toptraded/24h?limit=100", f)).map(fromJupiter).filter((t): t is ListedToken => !!t && t.trust !== "unlisted") };
  return topCache.v.slice(0, limit);
}
/** Jupiter's data for up to 100 mints at a time (cached 30 minutes). Mints Jupiter doesn't know come back as null. */
export async function solanaInfo(mints: string[], f: Fetch = fetch): Promise<Map<string, ListedToken | null>> {
  const out = new Map<string, ListedToken | null>(), want: string[] = [];
  for (const m of new Set(mints)) { const h = jupCache.get(m); if (h && Date.now() - h.at < 1800_000) out.set(m, h.v); else want.push(m); }
  for (let i = 0; i < want.length; i += 100) {
    const part = want.slice(i, i + 100);
    try {
      const got = (await jupGet(`/search?query=${part.join(",")}`, f)).map(fromJupiter).filter((t): t is ListedToken => !!t);
      for (const m of part) { const t = got.find((x) => x.address === m) ?? null; jupCache.set(m, { at: Date.now(), v: t }); out.set(m, t); }
    } catch { for (const m of part) out.set(m, null); }
  }
  return out;
}

// ---- Balances of listed EVM tokens in one call --------------------------------------------------------------
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);
const BAL = new Interface(["function balanceOf(address) view returns (uint256)"]);
/** Non-zero balances of the given tokens for one owner. Tokens that fail to answer are skipped. */
export async function evmBalances(chain: Chain, owner: string, tokens: string[], rpc = DEFAULT_RPC[chain], call?: (data: string) => Promise<string>): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const p = call ? null : new JsonRpcProvider(rpc, EVM_CHAIN_ID[chain as "base" | "ethereum"], { staticNetwork: true });
  for (let i = 0; i < tokens.length; i += 400) {
    const part = tokens.slice(i, i + 400);
    const data = MC.encodeFunctionData("aggregate3", [part.map((t) => ({ target: t, allowFailure: true, callData: BAL.encodeFunctionData("balanceOf", [owner]) }))]);
    const raw = call ? await call(data) : await p!.call({ to: MULTICALL3, data });
    const [res] = MC.decodeFunctionResult("aggregate3", raw);
    (res as any[]).forEach((r, j) => { if (r.success && r.returnData && r.returnData.length >= 66) { const v = BigInt(r.returnData.slice(0, 66)); if (v > 0n) out.set(part[j]!, v); } });
  }
  return out;
}

// ---- The token check ------------------------------------------------------------------------------------------
export interface TokenCheck {
  chain: Chain; address: string; symbol: string | null; name: string | null; decimals: number | null; logo?: string;
  trust: ListedToken["trust"];
  /** Plain warnings. Empty does not mean safe. Any warning means adding the token needs a second tap. */
  warnings: string[];
  /** Contract powers of a listed token (e.g. USDC's issuer can pause or block addresses): shown, not blocking. */
  powers: string[];
  /** Plain facts worth seeing either way. */
  facts: string[];
  checked: boolean;
}
const checkCache = new Map<string, { at: number; v: TokenCheck }>();

/**
 * Tollkit's token check (the same facts as the paid /chain/check tool, free for the wallet), plus the list
 * and Jupiter signals. Warnings are facts, not a verdict.
 */
export async function checkToken(chain: Chain, address: string, o: { fetch?: Fetch; proxy?: string } = {}): Promise<TokenCheck> {
  const f = o.fetch ?? fetch;
  const key = `${chain}:${address}`, hit = checkCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const listed = chain === "solana" ? (await solanaInfo([address], f)).get(address) ?? undefined : findListed(chain, address);
  const warnings: string[] = [], facts: string[] = [], powers: string[] = [];
  // Issuer powers (upgradeable, mint, pause, blacklist) are normal for big listed tokens like USDC; on an unknown
  // token they are warnings. Fee setters, pool and authority problems are warnings either way.
  const POWERS = new Set(["upgradeable", "can_mint", "can_pause", "blacklist"]);
  let srv: any = null;
  try {
    const r = await f(`${o.proxy ?? DEFAULT_PROXY}/token/check?chain=${chain}&token=${encodeURIComponent(address)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => null);
    if (r.ok) srv = j;
    else if (r.status === 400 || r.status === 422) throw new Error(j?.message ?? j?.error ?? "That address isn't a token on this network.");
  } catch (e) { if (/isn't a token|not an spl|must include|invalid/i.test((e as Error).message)) throw e; }
  if (srv) {
    for (const w of srv.warnings ?? []) if (typeof w?.message === "string") (listed && listed.trust !== "unlisted" && POWERS.has(w.code) ? powers : warnings).push(w.message);
    if (srv.price_usd != null) facts.push(`Price about $${Number(srv.price_usd).toLocaleString("en-US", { maximumSignificantDigits: 6 })}${srv.pool_depth_usd != null ? `, with about $${Math.round(srv.pool_depth_usd).toLocaleString("en-US")} of pool depth` : ""}.`);
    if (srv.total_supply != null) facts.push(`Total supply ${Number(srv.total_supply).toLocaleString("en-US", { maximumFractionDigits: 2 })}.`);
  }
  const j = listed?.jupiter;
  if (j) {
    if (j.suspicious) warnings.push("Jupiter flags this token as suspicious.");
    if (!j.verified) warnings.push("Jupiter hasn't verified this token.");
    if (j.organicLabel === "low" && !j.verified) warnings.push("Little real trading activity (Jupiter's organic score is low).");
    if (j.topHoldersPct !== undefined && j.topHoldersPct > 50) warnings.push(`The top holders own about ${j.topHoldersPct}% of the supply.`);
    if (j.organic !== undefined) facts.push(`Jupiter organic score ${j.organic} of 100${j.organicLabel ? ` (${j.organicLabel})` : ""}.`);
  }
  if (chain !== "solana") facts.push(listed ? (listed.trust === "core" ? "One of the wallet's built-in tokens." : listed.source === "uniswap" ? "On the Uniswap default token list. Being listed isn't a safety review." : "On the Superchain token list (Base's reference list). Being listed isn't a safety review.") : "Not on the wallet's token lists.");
  else if (listed) facts.push(j?.verified ? "Verified by Jupiter." : "Known to Jupiter, not verified.");
  else warnings.push("Jupiter doesn't know this token.");
  if (!srv) warnings.push("Tollkit's token check couldn't run just now, so contract controls and liquidity weren't checked.");
  const v: TokenCheck = {
    chain, address, symbol: srv?.symbol ?? listed?.symbol ?? null, name: srv?.name ?? listed?.name ?? null, decimals: srv?.decimals ?? listed?.decimals ?? null, logo: listed?.logo,
    trust: listed?.trust ?? "unlisted", warnings: [...new Set(warnings)], powers, facts, checked: !!srv,
  };
  if (srv) checkCache.set(key, { at: Date.now(), v });
  return v;
}

export const NATIVE_ADDRESS: Record<Chain, string> = { base: NATIVE_EVM, ethereum: NATIVE_EVM, solana: WSOL };
