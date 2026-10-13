/**
 * Spot swaps. EVM (Base, Ethereum): 0x Swap API v2, AllowanceHolder flow.
 * Solana: Jupiter Swap V2 (/order + /execute). Quotes come through Tollkit's
 * quote proxy (api.tollkit.dev/wallet/...), which holds the 0x and Jupiter API
 * keys and adds the flat 0.5% fee; it only ever sees public data and signed
 * transactions, never keys. The wallet checks every quote before signing:
 * fee not above 0.5%, the only approval ever given is to 0x AllowanceHolder,
 * the transaction goes to AllowanceHolder, and the minimum output is set.
 */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { Contract, JsonRpcProvider, type Wallet, type HDNodeWallet } from "ethers";
import { ALLOWANCE_HOLDER, DEFAULT_RPC, EVM_CHAIN_ID, STABLES, SWAP_FEE_BPS, isStable, type Chain } from "./chains.js";

type Fetch = typeof fetch;
export const DEFAULT_PROXY = "https://api.tollkit.dev/wallet";

export interface SwapRequest { chain: Chain; sell_token: string; buy_token: string; sell_amount: string; slippage_bps: number }
export interface SwapQuote {
  chain: Chain; venue: "0x" | "jupiter";
  sell_token: string; buy_token: string; sell_amount: string; buy_amount: string; min_buy_amount: string;
  fee_bps: number; venue_fee_bps: number; usd_value: number | null; fee_usd: number | null;
  raw: any;
}

const decimalsOf = (chain: Chain, token: string) =>
  (chain === "solana" ? STABLES.solana[token] : STABLES[chain][token.toLowerCase()])?.decimals;

async function getJson(f: Fetch, url: string, init?: RequestInit) {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message ?? j?.error ?? `quote service answered HTTP ${r.status}`);
  return j;
}

/** Dollar value of the sell side when either side is a stablecoin; else null (caller prices it). */
export function stableValue(q: Pick<SwapQuote, "chain" | "sell_token" | "buy_token" | "sell_amount" | "buy_amount">): number | null {
  if (isStable(q.chain, q.sell_token)) return Number(q.sell_amount) / 10 ** decimalsOf(q.chain, q.sell_token)!;
  if (isStable(q.chain, q.buy_token)) return Number(q.buy_amount) / 10 ** decimalsOf(q.chain, q.buy_token)!;
  return null;
}

export async function getQuote(req: SwapRequest, taker: string, opts: { fetch?: Fetch; proxy?: string } = {}): Promise<SwapQuote> {
  const f = opts.fetch ?? fetch, proxy = opts.proxy ?? DEFAULT_PROXY;
  if (req.chain === "solana") {
    const u = new URL(`${proxy}/swap/solana/order`);
    u.search = new URLSearchParams({ inputMint: req.sell_token, outputMint: req.buy_token, amount: req.sell_amount, taker, slippageBps: String(req.slippage_bps) }).toString();
    const j = await getJson(f, u.toString());
    const q: SwapQuote = {
      chain: "solana", venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token,
      sell_amount: String(j.inAmount ?? req.sell_amount), buy_amount: String(j.outAmount), min_buy_amount: String(j.otherAmountThreshold ?? j.outAmount),
      fee_bps: Number(j.feeBps ?? SWAP_FEE_BPS), venue_fee_bps: 0, usd_value: null, fee_usd: null, raw: j,
    };
    return withUsd(q);
  }
  const u = new URL(`${proxy}/swap/evm/quote`);
  u.search = new URLSearchParams({ chainId: String(EVM_CHAIN_ID[req.chain]), sellToken: req.sell_token, buyToken: req.buy_token, sellAmount: req.sell_amount, taker, slippageBps: String(req.slippage_bps) }).toString();
  const j = await getJson(f, u.toString());
  const feeAmt = BigInt(j?.fees?.integratorFee?.amount ?? "0");
  const sell = BigInt(j.sellAmount ?? req.sell_amount);
  const feeBps = sell > 0n ? Number((feeAmt * 10000n) / sell) : 0;
  // 0x's own fee (0.15% on select pairs on the Standard plan), shown to the user too.
  const zx = BigInt(j?.fees?.zeroExFee?.amount ?? "0");
  const zxToken = String(j?.fees?.zeroExFee?.token ?? "").toLowerCase();
  const venueBps = sell > 0n && zxToken === req.sell_token.toLowerCase() ? Number((zx * 10000n) / sell) : 0;
  return withUsd({
    chain: req.chain, venue: "0x", sell_token: req.sell_token, buy_token: req.buy_token,
    sell_amount: String(j.sellAmount ?? req.sell_amount), buy_amount: String(j.buyAmount), min_buy_amount: String(j.minBuyAmount ?? j.buyAmount),
    fee_bps: feeBps, venue_fee_bps: venueBps, usd_value: null, fee_usd: null, raw: j,
  });
}

function withUsd(q: SwapQuote): SwapQuote {
  const usd = stableValue(q);
  return { ...q, usd_value: usd, fee_usd: usd === null ? null : (usd * q.fee_bps) / 10000 };
}

/** Everything the wallet refuses to sign. Returns a reason, or null if the quote is safe. */
export function vetQuote(q: SwapQuote, req: SwapRequest): string | null {
  if (q.fee_bps > SWAP_FEE_BPS) return `The quote carries a ${q.fee_bps / 100}% fee; Tollkit's fee is ${SWAP_FEE_BPS / 100}%.`;
  if (!(BigInt(q.min_buy_amount) > 0n)) return "The quote has no minimum output.";
  if (q.venue === "0x") {
    const tx = q.raw?.transaction;
    if (!tx?.to || !tx?.data) return "The quote has no transaction.";
    if (String(tx.to).toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) return `The swap would be sent to ${tx.to}, not 0x AllowanceHolder.`;
    const spender = q.raw?.issues?.allowance?.spender;
    if (spender && String(spender).toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) return `The quote asks to approve ${spender}; only 0x AllowanceHolder is ever approved.`;
    if (q.sell_amount !== req.sell_amount) return "The quote is for a different amount than requested.";
  } else {
    if (!q.raw?.transaction || !q.raw?.requestId) return "The quote has no transaction.";
  }
  return null;
}

const ERC20 = ["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];

export interface ExecDeps { rpc?: Partial<Record<Chain, string>>; fetch?: Fetch; proxy?: string }

/** Sign and send. Returns the transaction hash / signature. */
export async function executeSwap(q: SwapQuote, keys: { evm: Wallet | HDNodeWallet; solana: Keypair }, deps: ExecDeps = {}): Promise<string> {
  if (q.venue === "jupiter") {
    const tx = VersionedTransaction.deserialize(Buffer.from(q.raw.transaction, "base64"));
    tx.sign([keys.solana]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    const j = await getJson(deps.fetch ?? fetch, `${deps.proxy ?? DEFAULT_PROXY}/swap/solana/execute`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedTransaction: signed, requestId: q.raw.requestId }),
    });
    if (j.status && j.status !== "Success") throw new Error(`swap failed: ${j.error ?? j.status}`);
    return String(j.signature);
  }
  const provider = new JsonRpcProvider(deps.rpc?.[q.chain] ?? DEFAULT_RPC[q.chain], EVM_CHAIN_ID[q.chain as "base" | "ethereum"]);
  const signer = keys.evm.connect(provider);
  if (q.raw?.issues?.allowance) {
    const token = new Contract(q.sell_token, ERC20, signer);
    const a = await token.approve(ALLOWANCE_HOLDER, BigInt(q.sell_amount)); // exact amount, never unlimited
    await a.wait();
  }
  const t = q.raw.transaction;
  const sent = await signer.sendTransaction({
    to: t.to, data: t.data, value: BigInt(t.value ?? "0"),
    ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
  });
  const r = await sent.wait();
  if (!r || r.status !== 1) throw new Error(`swap transaction ${sent.hash} reverted`);
  return sent.hash;
}

export { Connection };
