/**
 * "Buy": asks Tollkit's server (POST {proxy}/onramp) for a single-use Coinbase
 * Onramp checkout link that sends the crypto to this wallet's own address.
 * Only the public address, network, coin and amount are sent. Coinbase does
 * the payment and ID checks; the wallet never handles card details.
 */
import { DEFAULT_PROXY } from "./swap.js";
import type { Chain } from "./chains.js";
import type { RampAuth } from "./rampauth.js";

export const BUY_ASSETS: Record<Chain, string[]> = { base: ["USDC", "ETH"], ethereum: ["USDC", "ETH"], solana: ["USDC", "SOL"] };

export async function buyLink(addresses: { evm: string; solana: string }, o: { chain: Chain; asset: string; amount_usd?: number; sandbox?: boolean }, opts: { proxy?: string; fetch?: typeof fetch; sign?: (network: Chain, address: string) => Promise<RampAuth> } = {}): Promise<{ url: string; sandbox: boolean }> {
  if (!BUY_ASSETS[o.chain]?.includes(o.asset)) throw new Error(`On ${o.chain} you can buy ${(BUY_ASSETS[o.chain] ?? []).join(" or ")}.`);
  const address = o.chain === "solana" ? addresses.solana : addresses.evm;
  const auth = opts.sign ? await opts.sign(o.chain, address) : {};
  const r = await (opts.fetch ?? fetch)(`${opts.proxy ?? DEFAULT_PROXY}/onramp`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ address, network: o.chain, asset: o.asset, ...auth, ...(o.amount_usd ? { amount_usd: o.amount_usd } : {}), ...(o.sandbox ? { sandbox: true } : {}) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 404 ? "Buying isn't available from Tollkit's server yet." : j?.message ?? `Tollkit's server answered HTTP ${r.status}.`);
  if (typeof j.url !== "string" || !j.url.startsWith("https://pay.coinbase.com/")) throw new Error("Didn't get a Coinbase checkout link.");
  return { url: j.url, sandbox: !!j.sandbox };
}
