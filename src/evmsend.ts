/**
 * Ethereum mainnet sends stay out of the public mempool. Reads (balances, nonce, gas) use the normal RPC; the signed
 * transaction goes through Tollkit's /wallet/rpc/ethereum-protect route to Flashbots Protect, so it can't be
 * front-run or sandwiched, and a transaction that would revert isn't included (and costs nothing)
 * (docs.flashbots.net/flashbots-protect/quick-start). Base keeps its normal RPC: its sequencer has no public mempool
 * to watch.
 */
import { JsonRpcProvider } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, type Chain, type EvmChain } from "./chains.js";

type Fetch = typeof fetch;
export const DEFAULT_SEND_PROXY = "https://api.tollkit.dev/wallet";

export class ProtectedProvider extends JsonRpcProvider {
  constructor(url: string, private readonly sendUrl: string, private readonly f: Fetch = ((i: any, n?: any) => fetch(i, n))) { super(url, EVM_CHAIN_ID.ethereum, { staticNetwork: true }); }
  override async _perform(req: any): Promise<any> {
    if (req?.method !== "broadcastTransaction") return super._perform(req);
    const r = await this.f(this.sendUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [req.signedTransaction] }), signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.error || typeof j?.result !== "string") throw new Error(`Couldn't send through Flashbots Protect: ${j?.error?.message ?? j?.message ?? `HTTP ${r.status}`}`);
    return j.result;
  }
}

/** The provider to sign and send with on `chain`: protected on Ethereum mainnet, the normal RPC elsewhere. */
export function sendingProvider(chain: Chain, o: { rpc?: Partial<Record<Chain, string>>; proxy?: string; fetch?: Fetch; protect?: boolean } = {}): JsonRpcProvider {
  const url = o.rpc?.[chain] ?? DEFAULT_RPC[chain];
  if (chain === "ethereum" && o.protect !== false) return new ProtectedProvider(url, `${o.proxy ?? DEFAULT_SEND_PROXY}/rpc/ethereum-protect`, o.fetch);
  return new JsonRpcProvider(url, EVM_CHAIN_ID[chain as EvmChain], { staticNetwork: true });
}

/** Wait for a sent transaction, but not forever: Flashbots may take a few blocks, and may never include a failing one. */
export async function waitMined(tx: { hash: string; wait: (c?: number, t?: number) => Promise<any> }, what = "transaction", ms = 240_000) {
  try { return await tx.wait(1, ms); }
  catch (e: any) {
    if (e?.code === "TIMEOUT") throw new Error(`The ${what} ${tx.hash} wasn't included within ${Math.round(ms / 60000)} minute${Math.round(ms / 60000) === 1 ? "" : "s"}. It may still land; check a block explorer before trying again.`);
    throw e;
  }
}
