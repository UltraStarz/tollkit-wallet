/**
 * Every token the wallet holds, with prices and price history, for the dashboard.
 *
 * Finding tokens:
 *   Solana   getParsedTokenAccountsByOwner for the SPL Token and Token-2022 programs (all mints held).
 *   Ethereum Blockscout's public API, GET eth.blockscout.com/api/v2/addresses/{addr}/token-balances (ERC-20s).
 *   Base     no free, key-less index works here (base.blockscout.com answers a Cloudflare challenge),
 *            so the wallet tracks tokens it swaps into and tokens the owner adds by address.
 * Prices and charts: DefiLlama's public coins API (no key):
 *   GET coins.llama.fi/prices/current/{chain:address,...}  -> price, symbol, decimals
 *   GET coins.llama.fi/chart/{coin}?span=&period=           -> price points
 * Tokens with no price are counted as hidden (most airdropped spam has none).
 * Only public addresses are sent to these services, never keys.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { evmBalances, evmList, findListed, loadExtraLists, solanaInfo } from "./tokenlist.js";
import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, NATIVE_EVM, WSOL, type Chain } from "./chains.js";
import { KNOWN } from "./tokens.js";
import { walletHome } from "./paths.js";

type Fetch = typeof fetch;
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";      // @solana/spl-token TOKEN_PROGRAM_ID
const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // @solana/spl-token TOKEN_2022_PROGRAM_ID
const LLAMA = "https://coins.llama.fi";
const LLAMA_CHAIN: Record<Chain, string> = { base: "base", ethereum: "ethereum", solana: "solana" };
const NATIVE_COIN: Record<Chain, string> = { base: "coingecko:ethereum", ethereum: "coingecko:ethereum", solana: "coingecko:solana" };
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"];

export interface Holding { chain: Chain; address: string; symbol: string; name?: string; decimals: number; amount: string; price?: number; usd?: number; change_24h?: number; icon?: string; coin: string;
  /** listed: on the wallet's token list (or Jupiter-verified on Solana); unlisted: anything else. */
  trust?: "core" | "listed" | "unlisted";
  /** The owner added it, so it shows even at zero. */
  watched?: boolean }

/** The DefiLlama id for a token: chain:address, or the coin itself for native ETH/SOL. */
export function coinId(chain: Chain, address: string): string {
  if (address === NATIVE_EVM || address === WSOL) return NATIVE_COIN[chain];
  return `${LLAMA_CHAIN[chain]}:${address}`;
}

const isCore = (chain: Chain, addr: string) => Object.values(KNOWN[chain]).some((k) => k.address.toLowerCase() === addr.toLowerCase());

/** Tokens the owner added or the wallet swapped into (EVM chains). */
export class TokenList {
  private file: string;
  constructor(dir?: string) { this.file = path.join(walletHome(dir), "tokens.json"); }
  list(): Partial<Record<Chain, string[]>> { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; } catch { return {}; } }
  add(chain: Chain, address: string) {
    if (isCore(chain, address)) return; // core tokens are always shown
    const l = this.list(), a = chain === "solana" ? address : getAddress(address);
    if ((l[chain] ?? []).some((x) => x.toLowerCase() === a.toLowerCase())) return;
    l[chain] = [...(l[chain] ?? []), a];
    const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(l, null, 2)); renameSync(t, this.file);
  }
  remove(chain: Chain, address: string) {
    const l = this.list(); l[chain] = (l[chain] ?? []).filter((x) => x.toLowerCase() !== address.toLowerCase());
    const t = `${this.file}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(l, null, 2)); renameSync(t, this.file);
  }
}

/** Reads an ERC-20's symbol, name and decimals; throws if the address isn't one. */
export async function erc20Info(chain: Chain, address: string, rpc = DEFAULT_RPC[chain]) {
  const c = new Contract(getAddress(address), ERC20, new JsonRpcProvider(rpc, EVM_CHAIN_ID[chain as "base" | "ethereum"], { staticNetwork: true }));
  const [symbol, decimals, name] = await Promise.all([c.symbol!(), c.decimals!(), c.name!().catch(() => undefined)]);
  return { symbol: String(symbol), decimals: Number(decimals), name: name ? String(name) : undefined };
}

export class Holdings {
  private snap: { tokens: Holding[]; hidden: number; at: string | null; errors: string[] } = { tokens: [], hidden: 0, at: null, errors: [] };
  private timer: NodeJS.Timeout | null = null;
  readonly list: TokenList;
  constructor(private readonly o: { evm: string; solana: string; chains: () => Chain[]; dir?: string; fetch?: Fetch; rpc?: Partial<Record<Chain, string>>; intervalMs?: number }) {
    this.list = new TokenList(o.dir);
  }
  private get f(): Fetch { return this.o.fetch ?? fetch; }
  private rpc(c: Chain) { return this.o.rpc?.[c] ?? DEFAULT_RPC[c]; }
  snapshot() { return this.snap; }

  private async getJson(url: string, timeoutMs = 12_000): Promise<any> {
    const r = await this.f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  private async solana(): Promise<Omit<Holding, "coin">[]> {
    const conn = new Connection(this.rpc("solana"), "confirmed"), owner = new PublicKey(this.o.solana);
    const raw = new Map<string, { amount: bigint; decimals: number }>();
    for (const prog of [SPL_TOKEN, SPL_TOKEN_2022]) {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(prog) });
      for (const a of res.value) {
        const info = a.account.data.parsed.info, amt = info.tokenAmount;
        if (amt.amount === "0" || isCore("solana", info.mint)) continue;
        const prev = raw.get(info.mint);
        raw.set(info.mint, { amount: (prev?.amount ?? 0n) + BigInt(amt.amount), decimals: amt.decimals });
      }
    }
    return [...raw].map(([mint, v]) => ({ chain: "solana" as Chain, address: mint, symbol: "", decimals: v.decimals, amount: formatUnits(v.amount, v.decimals) }));
  }

  private async ethereumIndex(): Promise<Omit<Holding, "coin">[]> {
    const rows: any[] = await this.getJson(`https://eth.blockscout.com/api/v2/addresses/${this.o.evm}/token-balances`, 25_000);
    return rows.filter((r) => r.token?.type === "ERC-20" && r.value !== "0" && !isCore("ethereum", r.token.address_hash)).map((r) => ({
      chain: "ethereum" as Chain, address: getAddress(r.token.address_hash), symbol: String(r.token.symbol ?? ""), name: r.token.name ?? undefined,
      decimals: Number(r.token.decimals ?? 18), amount: formatUnits(BigInt(r.value), Number(r.token.decimals ?? 18)), icon: r.token.icon_url ?? undefined,
    }));
  }

  private async tracked(chain: Chain): Promise<Omit<Holding, "coin">[]> {
    const addrs = this.list.list()[chain] ?? [];
    const p = new JsonRpcProvider(this.rpc(chain), EVM_CHAIN_ID[chain as "base" | "ethereum"], { staticNetwork: true });
    const out: Omit<Holding, "coin">[] = [];
    await Promise.all(addrs.map(async (a) => {
      try {
        const c = new Contract(a, ERC20, p);
        const [bal, decimals, symbol] = await Promise.all([c.balanceOf!(this.o.evm), c.decimals!(), c.symbol!()]);
        out.push({ chain, address: a, symbol: String(symbol), decimals: Number(decimals), amount: formatUnits(BigInt(bal), Number(decimals)), watched: true });
      } catch { /* skip a token that doesn't answer */ }
    }));
    return out;
  }

  /** Listed tokens this wallet holds, in one Multicall3 call per chain. */
  private async listed(chain: Chain): Promise<Omit<Holding, "coin">[]> {
    await loadExtraLists(this.f);
    const list = evmList(chain).filter((t) => t.trust === "listed");
    const bals = await evmBalances(chain, this.o.evm, list.map((t) => t.address), this.rpc(chain));
    return list.filter((t) => bals.has(t.address)).map((t) => ({ chain, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, amount: formatUnits(bals.get(t.address)!, t.decimals), icon: t.logo, trust: "listed" as const }));
  }

  /** Finds holdings on the enabled chains and prices them. */
  async refresh(): Promise<void> {
    const chains = this.o.chains(), errors: string[] = [];
    const found: Omit<Holding, "coin">[] = [];
    const add = (rows: Omit<Holding, "coin">[]) => { for (const r of rows) if (!found.some((x) => x.chain === r.chain && x.address.toLowerCase() === r.address.toLowerCase())) found.push(r); };
    await Promise.all(chains.map(async (c) => {
      try {
        if (c === "solana") {
          const held = await this.solana();
          const watched = (this.list.list().solana ?? []).filter((m) => !held.some((h) => h.address === m));
          const rows = [...held, ...watched.map((m) => ({ chain: "solana" as Chain, address: m, symbol: "", decimals: 0, amount: "0", watched: true }))];
          const info = await solanaInfo(rows.map((r) => r.address), this.f).catch(() => new Map());
          for (const r of rows) { const t = info.get(r.address); if (t) Object.assign(r, { symbol: r.symbol || t.symbol, name: t.name, icon: t.logo, trust: t.trust, ...(r.watched ? { decimals: t.decimals } : {}) }); }
          for (const r of rows) if ((this.list.list().solana ?? []).includes(r.address)) (r as any).watched = true;
          add(rows);
        }
        else {
          try { add(await this.listed(c)); } catch (e) { errors.push(`${c} list: ${(e as Error).message}`); }
          if (c === "ethereum") { try { add(await this.ethereumIndex()); } catch (e) { errors.push(`ethereum index: ${(e as Error).message}`); } }
          add(await this.tracked(c));
        }
      } catch (e) { errors.push(`${c}: ${(e as Error).message}`); }
    }));
    let prices: Record<string, { price?: number; symbol?: string; decimals?: number }> = {};
    const ids = found.map((h) => coinId(h.chain, h.address));
    for (let i = 0; i < ids.length; i += 60) {
      try { prices = { ...prices, ...(await this.getJson(`${LLAMA}/prices/current/${ids.slice(i, i + 60).join(",")}?searchWidth=6h`)).coins }; }
      catch (e) { errors.push(`prices: ${(e as Error).message}`); }
    }
    // 24h change in percent (GET coins.llama.fi/percentage/{coins}?period=24h)
    let pct: Record<string, number> = {};
    const priced = ids.filter((id) => prices[id]?.price);
    for (let i = 0; i < priced.length; i += 60) {
      try { pct = { ...pct, ...(await this.getJson(`${LLAMA}/percentage/${priced.slice(i, i + 60).join(",")}?period=24h`)).coins }; } catch { /* change is optional */ }
    }
    const tokens: Holding[] = found.map((h) => {
      const coin = coinId(h.chain, h.address), p = prices[coin];
      const price = p?.price && p.price > 0 ? p.price : undefined;
      return { ...h, coin, symbol: h.symbol || (p?.symbol ? String(p.symbol).toUpperCase() : `${h.address.slice(0, 4)}…`), price, usd: price !== undefined ? price * Number(h.amount) : undefined, ...(typeof pct[coin] === "number" ? { change_24h: pct[coin] / 100 } : {}) };
    });
    for (const t of tokens) if (!t.trust) t.trust = findListed(t.chain, t.address) ? "listed" : "unlisted";
    for (const t of tokens) if (!t.icon) t.icon = findListed(t.chain, t.address)?.logo;
    // Shown: anything with a price, and tokens the owner added. Unpriced tokens nobody added (often airdropped spam) stay hidden.
    const shown = tokens.filter((t) => t.price !== undefined || t.watched).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    this.snap = { tokens: shown, hidden: tokens.length - shown.length, at: new Date().toISOString(), errors };
  }

  start() { if (!this.timer) { void this.refresh().catch(() => {}); this.timer = setInterval(() => void this.refresh().catch(() => {}), this.o.intervalMs ?? 60_000); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Ranges for the price chart. DefiLlama span/period pairs, checked against the live API on 2026-10-14. */
export const CHART_RANGES = { "1D": { span: 24, period: "1h" }, "1W": { span: 42, period: "4h" }, "1M": { span: 30, period: "1d" }, "1Y": { span: 52, period: "1w" } } as const;
export type ChartRange = keyof typeof CHART_RANGES;

export async function priceChart(coin: string, range: ChartRange, f: Fetch = fetch): Promise<{ coin: string; symbol?: string; range: ChartRange; points: { t: number; p: number }[] }> {
  if (!/^(coingecko:[a-z0-9-]+|(base|ethereum|solana):[0-9A-Za-z]{32,44})$/.test(coin)) throw new Error("Unknown coin.");
  const r = CHART_RANGES[range];
  if (!r) throw new Error("Pick 1D, 1W, 1M or 1Y.");
  const res = await f(`${LLAMA}/chart/${coin}?span=${r.span}&period=${r.period}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Price history isn't available right now (HTTP ${res.status}).`);
  const c = (await res.json())?.coins?.[coin];
  return { coin, symbol: c?.symbol, range, points: (c?.prices ?? []).map((x: any) => ({ t: Number(x.timestamp), p: Number(x.price) })).filter((x: any) => x.p > 0) };
}
