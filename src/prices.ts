/**
 * Dollar prices for the dashboard, from Coinbase Exchange's public product
 * stats (no key; GET https://api.exchange.coinbase.com/products/{id}/stats,
 * "30day and 24hour stats for a product"). 24h change = last vs open.
 * USDC is $1 (Coinbase Exchange has no USDC-USD product). Only public market
 * data is requested; nothing about the wallet is sent.
 */
export interface Price { usd: number; change_24h: number | null }

const PRODUCTS: Record<string, string> = { ETH: "ETH-USD", SOL: "SOL-USD", USDT: "USDT-USD" };
const BASE = "https://api.exchange.coinbase.com/products";

export class PriceFeed {
  private p: Record<string, Price> = { USDC: { usd: 1, change_24h: 0 } };
  private at: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly o: { fetch?: typeof fetch; intervalMs?: number } = {}) {}

  snapshot(): { prices: Record<string, Price>; at: string | null } {
    const p = { ...this.p };
    if (p.ETH) p.WETH = p.ETH;
    return { prices: p, at: this.at };
  }

  async refresh(): Promise<void> {
    const f = this.o.fetch ?? fetch;
    await Promise.all(Object.entries(PRODUCTS).map(async ([sym, id]) => {
      try {
        const r = await f(`${BASE}/${id}/stats`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
        if (!r.ok) return;
        const j: any = await r.json();
        const last = Number(j.last), open = Number(j.open);
        if (!(last > 0)) return;
        this.p[sym] = { usd: last, change_24h: open > 0 ? (last - open) / open : null };
      } catch { /* keep the last good price */ }
    }));
    this.at = new Date().toISOString();
  }

  start() { if (!this.timer) { void this.refresh(); this.timer = setInterval(() => void this.refresh(), this.o.intervalMs ?? 15_000); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
