/**
 * "Cash out": sell crypto to your bank or PayPal through Coinbase Offramp.
 *
 * 1. The wallet asks Tollkit's server (POST {proxy}/offramp) for a single-use Coinbase sell link and a reference.
 * 2. The owner signs in to Coinbase, picks where the money goes and clicks "Cash out now".
 * 3. Coinbase then says where to send the crypto (GET {proxy}/offramp/status). The wallet shows that to the owner,
 *    who confirms with the password; only then is the crypto sent. Coinbase allows 30 minutes for this.
 * Only the public address, network, coin and amount are sent to Tollkit's server. A Coinbase account is required.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROXY } from "./swap.js";
import { walletHome } from "./paths.js";
import { chainName, type Chain } from "./chains.js";

export const SELL_ASSETS: Partial<Record<Chain, string[]>> = { base: ["USDC", "ETH"], ethereum: ["USDC", "ETH"], solana: ["USDC", "SOL"] };
/** Coinbase's window after "Cash out now" (docs.cdp.coinbase.com/onramp/offramp/offramp-integration-guide). */
export const SEND_WINDOW_MS = 30 * 60_000;

export interface Sale { ref: string; ts: string; chain: Chain; asset: string; amount: string | null; state: "open" | "sending" | "sent" | "done" | "failed" | "expired"; tx?: string; payout?: string; reason?: string }
export interface OfframpTx { id: string; status: string; asset: string; network: string; sell_amount: { value: string; currency: string } | null; total: { value: string; currency: string } | null; coinbase_fee: { value: string; currency: string } | null; to_address: string; from_address: string; tx_hash: string; created_at: string; updated_at: string }

type Fetch = typeof fetch;

export class Sales {
  private file: string;
  constructor(private o: { dir?: string; proxy?: string; fetch?: Fetch; sign?: (kind: "offramp", network: Chain, address: string) => Promise<{ ts: number; nonce: string; sig: string }> }) { this.file = path.join(walletHome(o.dir), "sales.json"); }
  private get f(): Fetch { return this.o.fetch ?? fetch; }
  private get proxy() { return this.o.proxy ?? DEFAULT_PROXY; }

  list(): Sale[] { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : []; } catch { return []; } }
  get(ref: string): Sale | undefined { return this.list().find((s) => s.ref === ref); }
  update(ref: string, patch: Partial<Sale>) {
    const l = this.list().map((s) => (s.ref === ref ? { ...s, ...patch } : s));
    writeFileSync(this.file, JSON.stringify(l, null, 2), { mode: 0o600 });
  }

  async start(address: string, chain: Chain, asset: string, amount?: string): Promise<{ url: string; ref: string }> {
    if (!SELL_ASSETS[chain]?.includes(asset)) throw new Error(SELL_ASSETS[chain] ? `On ${chainName(chain)} you can cash out ${SELL_ASSETS[chain]!.join(" or ")}.` : `Cashing out with Coinbase isn't available on ${chainName(chain)} yet. Move it to Base first.`);
    if (amount === undefined || !(/^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0)) throw new Error("Enter how much to cash out, like 25 or 0.05.");
    const auth = this.o.sign ? await this.o.sign("offramp", chain, address) : {};
    const r = await this.f(`${this.proxy}/offramp`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(25_000), body: JSON.stringify({ address, network: chain, asset, ...(amount ? { amount } : {}), ...auth }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 404 ? "Cashing out isn't available from Tollkit's server yet." : j?.message ?? `Tollkit's server answered HTTP ${r.status}.`);
    if (typeof j.url !== "string" || !j.url.startsWith("https://pay.coinbase.com/v3/sell/") || !/^tw-[0-9a-f]{16}-[0-9a-f]{16}$/.test(String(j.ref))) throw new Error("Didn't get a Coinbase sell link.");
    const sale: Sale = { ref: j.ref, ts: new Date().toISOString(), chain, asset, amount: amount ?? null, state: "open" };
    writeFileSync(this.file, JSON.stringify([sale, ...this.list()].slice(0, 50), null, 2), { mode: 0o600 });
    return { url: j.url, ref: j.ref };
  }

  /** Coinbase's latest word on a sale (null until the owner has started on Coinbase). */
  async status(address: string, ref: string): Promise<OfframpTx | null> {
    const r = await this.f(`${this.proxy}/offramp/status?${new URLSearchParams({ ref, address })}`, { signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.message ?? `Tollkit's server answered HTTP ${r.status}.`);
    const t = j.transaction as OfframpTx | null;
    if (t) {
      const s = this.get(ref);
      if (s && s.state !== "done" && /SUCCESS/.test(t.status)) this.update(ref, { state: "done", payout: t.total ? `${t.total.value} ${t.total.currency}` : undefined });
      else if (s && s.state !== "failed" && /FAILED/.test(t.status)) this.update(ref, { state: "failed" });
      else if (s && s.state === "open" && /EXPIRED/.test(t.status)) this.update(ref, { state: "expired" });
    }
    return t;
  }
}
