/**
 * OFAC screening of every counterparty address. Source: the Treasury SDN list
 * as parsed nightly per chain by github.com/0xB10C/ofac-sanctioned-digital-currency-addresses
 * (MIT). Cached for 24 h in sanctions.json; if it can't be refreshed and no
 * cache exists, spending is refused rather than unscreened.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { files, walletHome } from "./paths.js";

const BASE = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
export const SANCTION_LISTS = {
  evm: ["ETH", "USDC", "USDT", "ARB", "BSC"].map((s) => `${BASE}/sanctioned_addresses_${s}.txt`),
  solana: [`${BASE}/sanctioned_addresses_SOL.txt`],
};

interface Cache { fetched_at: string; evm: string[]; solana: string[] }
type Fetch = typeof fetch;

async function fetchList(urls: string[], f: Fetch): Promise<string[] | null> {
  const out: string[] = [];
  let any = false;
  for (const u of urls) {
    try {
      const r = await f(u, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) continue;           // that chain has no list (yet)
      if (!r.ok) return null;
      any = true;
      out.push(...(await r.text()).split(/\s+/).map((s) => s.trim()).filter(Boolean));
    } catch { return null; }
  }
  return any ? out : null;
}

export class Sanctions {
  private cache: Cache | null = null;
  constructor(private readonly dir?: string, private readonly f: Fetch = fetch, private readonly now: () => number = Date.now) {}

  private load(): Cache | null {
    if (this.cache) return this.cache;
    const p = files(walletHome(this.dir)).sanctions;
    if (existsSync(p)) { try { this.cache = JSON.parse(readFileSync(p, "utf8")); } catch { /* corrupt */ } }
    return this.cache;
  }

  async refresh(force = false): Promise<Cache> {
    const c = this.load();
    if (!force && c && this.now() - Date.parse(c.fetched_at) < 24 * 3600_000) return c;
    const [evm, solana] = await Promise.all([fetchList(SANCTION_LISTS.evm, this.f), fetchList(SANCTION_LISTS.solana, this.f)]);
    if (!evm || !solana) {
      if (c) return c; // keep the last good list
      throw new Error("Could not download the OFAC address list, so payments are paused until it can be checked.");
    }
    const next: Cache = { fetched_at: new Date(this.now()).toISOString(), evm: [...new Set(evm.map((a) => a.toLowerCase()))], solana: [...new Set(solana)] };
    writeFileSync(files(walletHome(this.dir)).sanctions, JSON.stringify(next), { mode: 0o600 });
    this.cache = next;
    return next;
  }

  /** True if the address is on the list. Solana addresses are case-sensitive. */
  async isSanctioned(address: string): Promise<boolean> {
    const c = await this.refresh();
    return address.startsWith("0x") ? c.evm.includes(address.toLowerCase()) : c.solana.includes(address);
  }
}
