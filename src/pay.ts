/**
 * Paying for things: x402 (v1 + v2, Base / Ethereum / Solana) and MPP
 * charges (EVM on Base / Ethereum, Solana). Every payment goes through the
 * same gate before anything is signed:
 *   1. dollar stablecoin on an allowed chain, priced at $1
 *   2. per-payment / daily / per-seller limits (checked, then reserved atomically)
 *   3. OFAC screening of every recipient
 *   4. seller check (Weigh Station): warnings block, or need approval
 *   5. Telegram approval above the owner's threshold
 * then the receipt is written to the ledger as done or failed.
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader, type PaymentRequirements } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { Mppx, evm as mppEvm } from "mppx/client";
import { Receipt, evm as mppEvmAssets } from "mppx";
import { solana as mppSolana, resolveStablecoinMint } from "@solana/mpp/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import type { Keypair } from "@solana/web3.js";
import type { HDNodeWallet, Wallet } from "ethers";
import { STABLES, type Chain } from "./chains.js";
import { LimitError, reserve, settle, spentToday } from "./ledger.js";
import type { Policy } from "./policy.js";
import type { SellerVerdict } from "./seller.js";
import type { Decision } from "./telegram.js";

type Fetch = typeof fetch;

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const CAIP_TO_CHAIN: Record<string, Chain> = { "eip155:8453": "base", "eip155:1": "ethereum", [SOLANA_MAINNET]: "solana" };
const V1_TO_CHAIN: Record<string, Chain> = { base: "base", ethereum: "ethereum", solana: "solana" };
const CHAIN_ID_TO_CHAIN: Record<number, Chain> = { 8453: "base", 1: "ethereum" };

/** What a seller is asking for, normalised across protocols. */
export interface Offer {
  protocol: "x402" | "mpp";
  chain: Chain;
  asset: string;
  amount: string;           // atomic units
  usd: number;
  recipients: string[];     // pay_to plus any split recipients
  seller: string;           // host of the URL
}

export interface PayDeps {
  dir?: string;
  policy: Policy;
  fetch?: Fetch;
  sanctions: { isSanctioned(address: string): Promise<boolean> };
  checkSeller: (url: string, payTo: string) => Promise<SellerVerdict>;
  /** Ask the owner. null = no approval channel configured. */
  approve: ((text: string) => Promise<Decision>) | null;
  /** Solana RPC for building x402 / MPP Solana payments. */
  solanaRpc?: string;
}

export interface PayResult {
  paid: boolean;
  status: number | null;
  response: Response | null;
  offer?: Offer;
  receipt_id?: string;
  tx?: string;
  refused?: { code: string; reason: string };
}

export class Refusal extends Error { constructor(readonly code: string, msg: string) { super(msg); } }

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Price a stablecoin amount; anything that isn't a known dollar stablecoin is refused. */
export function priceStable(chain: Chain, asset: string, amount: string): number {
  const meta = chain === "solana" ? STABLES.solana[asset] : STABLES[chain][asset.toLowerCase()];
  if (!meta) throw new Refusal("unsupported_asset", `Only dollar stablecoins are paid (got ${asset} on ${chain}).`);
  if (!/^\d+$/.test(amount)) throw new Refusal("bad_amount", `Bad amount ${amount}.`);
  return Number(amount) / 10 ** meta.decimals;
}

/** x402 requirement -> Offer. */
export function offerFromX402(req: Pick<PaymentRequirements, "network" | "asset" | "amount" | "payTo"> & { maxAmountRequired?: string }, url: string): Offer {
  const chain = CAIP_TO_CHAIN[req.network] ?? V1_TO_CHAIN[req.network];
  if (!chain) throw new Refusal("unsupported_network", `Network ${req.network} isn't supported.`);
  const amount = String(req.amount ?? req.maxAmountRequired ?? "");
  return { protocol: "x402", chain, asset: req.asset, amount, usd: priceStable(chain, req.asset, amount), recipients: [req.payTo], seller: hostOf(url) };
}

/** MPP charge challenge -> Offer. Handles the raw and the parsed request shape. */
export function offerFromMpp(ch: { method: string; intent: string; request: any }, url: string): Offer {
  if (ch.intent !== "charge") throw new Refusal("unsupported_intent", `Only one-off MPP charges are paid (got "${ch.intent}").`);
  const r = ch.request ?? {};
  const md = r.methodDetails ?? {};
  let chain: Chain | undefined, asset = String(r.currency ?? "");
  if (ch.method === "evm") chain = CHAIN_ID_TO_CHAIN[Number(r.chainId ?? md.chainId)];
  else if (ch.method === "solana") {
    const net = String(md.network ?? "mainnet");
    if (net !== "mainnet" && net !== "mainnet-beta") throw new Refusal("unsupported_network", `Solana ${net} isn't supported.`);
    chain = "solana";
    asset = resolveStablecoinMint(asset, "mainnet") ?? asset;
  }
  if (!chain) throw new Refusal("unsupported_network", `MPP method ${ch.method} isn't supported.`);
  const splits: any[] = Array.isArray(r.splits ?? md.splits) ? (r.splits ?? md.splits) : [];
  return {
    protocol: "mpp", chain, asset, amount: String(r.amount),
    usd: priceStable(chain, asset, String(r.amount)),
    recipients: [String(r.recipient), ...splits.map((s) => String(s.recipient))],
    seller: hostOf(url),
  };
}

const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * Everything short of signing. Throws Refusal with a plain-language reason.
 * Returns the ledger reservation id.
 */
export async function gate(offer: Offer, url: string, deps: PayDeps): Promise<string> {
  const p = deps.policy;
  if (!p.chains.includes(offer.chain)) throw new Refusal("chain_off", `Payments on ${offer.chain} are turned off.`);
  // Cheap limit check first so we never ask a human about something that can't go through.
  if (offer.usd > p.per_payment_usd) throw new Refusal("over_per_limit", `${money(offer.usd)} is over the per-payment limit of ${money(p.per_payment_usd)}.`);
  if (spentToday("payment", deps.dir) + offer.usd > p.daily_payments_usd) throw new Refusal("over_daily_limit", `This would go over today's payment limit of ${money(p.daily_payments_usd)}.`);
  for (const r of offer.recipients) {
    if (await deps.sanctions.isSanctioned(r)) throw new Refusal("sanctioned", `The recipient ${r} is on the OFAC sanctions list.`);
  }
  const verdict = await deps.checkSeller(url, offer.recipients[0] ?? "");
  let needApproval = offer.usd > p.approval_above_usd;
  let why = needApproval ? `over your approval threshold of ${money(p.approval_above_usd)}` : "";
  if (!verdict.ok) {
    const w = verdict.warnings.map((s) => s.detail).join(" ");
    if (p.block_seller_warnings) throw new Refusal("seller_warning", `Seller check failed: ${w}`);
    needApproval = true; why = `the seller check warned: ${w}`;
  }
  if (needApproval) {
    if (!deps.approve) throw new Refusal("needs_approval", `This payment needs your approval (${why}), but Telegram approvals aren't set up.`);
    const d = await deps.approve(`Pay ${money(offer.usd)} to ${offer.seller} (${offer.protocol}, ${offer.chain})?\nReason for asking: ${why}.\n${url}`);
    if (d !== "approved") throw new Refusal(d === "denied" ? "denied" : "approval_timeout", d === "denied" ? "You denied this payment." : "No approval in time, so it wasn't paid.");
  }
  try {
    return await reserve(p, "payment", offer.usd, { chain: offer.chain, seller: offer.seller, tool: url, detail: `${offer.protocol} ${money(offer.usd)}` }, deps.dir);
  } catch (e) {
    if (e instanceof LimitError) throw new Refusal(e.code, e.message);
    throw e;
  }
}

/** Which protocol a 402 speaks. x402 wins when both are offered (wider seller support). */
export function protocolOf(res: Response, body: string): "x402" | "mpp" | null {
  if (res.headers.get("payment-required")) return "x402";
  try { const j = JSON.parse(body); if (j && typeof j.x402Version === "number") return "x402"; } catch { /* not json */ }
  if (/^\s*Payment\b/i.test(res.headers.get("www-authenticate") ?? "")) return "mpp";
  return null;
}

/** The first call returns the response we already have; later calls hit the network. */
function replayFirst(first: Response, f: Fetch): Fetch {
  let used = false;
  return (async (input: any, init?: any) => {
    if (!used) { used = true; return first; }
    return f(input, init);
  }) as Fetch;
}

export interface Signers { evm: Wallet | HDNodeWallet; solana: Keypair }

/** Fetch a URL, paying if it asks, within the owner's rules. */
export async function payFetch(url: string, init: RequestInit | undefined, keys: Signers, deps: PayDeps): Promise<PayResult> {
  const f = deps.fetch ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { paid: false, status: first.status, response: first };
  const body = await first.clone().text();
  const proto = protocolOf(first, body);
  if (!proto) return { paid: false, status: 402, response: first, refused: { code: "unknown_protocol", reason: "The seller asked for payment in a format the wallet doesn't speak." } };
  const evmAccount = privateKeyToAccount(keys.evm.privateKey as `0x${string}`);
  const solSigner = await createKeyPairSignerFromBytes(keys.solana.secretKey);
  return proto === "x402"
    ? payX402(url, init, first, evmAccount, solSigner, deps)
    : payMpp(url, init, first, evmAccount, solSigner, deps);
}

async function payX402(url: string, init: RequestInit | undefined, first: Response, evmAccount: any, solSigner: any, deps: PayDeps): Promise<PayResult> {
  const f = deps.fetch ?? fetch;
  const client = new x402Client();
  const evmNets = deps.policy.chains.filter((c) => c !== "solana").map((c) => (c === "base" ? "eip155:8453" : "eip155:1")) as `${string}:${string}`[];
  if (evmNets.length) registerExactEvmScheme(client, { signer: evmAccount, networks: evmNets });
  if (deps.policy.chains.includes("solana")) registerExactSvmScheme(client, { signer: solSigner, networks: [SOLANA_MAINNET], ...(deps.solanaRpc ? { rpcUrl: deps.solanaRpc } : {}) } as any);
  // Our own limits replace the library's $1 default cap (they are checked in gate()).
  client.setSpendControls(false);
  // Prefer an offer we can actually pay: allowed chain + known stablecoin, cheapest first.
  client.registerPolicy((_v, reqs) => {
    const ok = reqs.filter((r) => { try { offerFromX402(r as any, url); return true; } catch { return false; } });
    return ok.sort((a, b) => offerFromX402(a as any, url).usd - offerFromX402(b as any, url).usd);
  });
  let offer: Offer | undefined, receipt: string | undefined, refusal: Refusal | undefined;
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    if (receipt) return; // a retry of the same purchase: already reserved
    try {
      offer = offerFromX402(selectedRequirements as any, url);
      receipt = await gate(offer, url, deps);
    } catch (e) {
      refusal = e instanceof Refusal ? e : new Refusal("error", (e as Error).message);
      return { abort: true as const, reason: refusal.message };
    }
  });
  const paidFetch = wrapFetchWithPayment(replayFirst(first, f), client);
  let res: Response;
  try { res = await paidFetch(url, init); }
  catch (e) {
    if (receipt) settle(receipt, { status: "failed", reason: (e as Error).message }, deps.dir);
    const r = refusal ?? new Refusal("no_payable_offer", /no.*(scheme|requirement)|registered/i.test((e as Error).message)
      ? "None of the seller's payment options fit your rules (chain, stablecoin)." : (e as Error).message);
    return { paid: false, status: 402, response: null, offer, receipt_id: receipt, refused: { code: r.code, reason: r.message } };
  }
  const hdr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  let tx: string | undefined, settled = false;
  if (hdr) { try { const s = decodePaymentResponseHeader(hdr); settled = !!s.success; tx = s.transaction; } catch { /* unreadable */ } }
  // A second 402 means the seller (or its facilitator) turned the payment down; its reason is in PAYMENT-REQUIRED.error.
  let why: string | undefined;
  if (!settled && res.status === 402) {
    try { const pr = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? ""); why = pr.error; } catch { /* no header */ }
    if (!why) { try { const j = JSON.parse(await res.clone().text()); why = j?.error ?? j?.message; } catch { /* not json */ } }
    if (why && /execution reverted|insufficient/i.test(why)) why += ` (usually: not enough ${offer ? "stablecoin on " + offer.chain : "funds"} in this wallet)`;
    if (why === "Payment required") why += " (the seller didn't accept a payment on this request; check the HTTP method and body the tool expects)";
  }
  if (receipt) {
    if (settled || (res.ok && !hdr)) settle(receipt, { status: "done", tx }, deps.dir);
    else settle(receipt, { status: "failed", reason: why ? `seller rejected the payment: ${why}` : `seller answered HTTP ${res.status}` }, deps.dir);
  }
  const paid = settled || (res.ok && !!receipt);
  return { paid, status: res.status, response: res, offer, receipt_id: receipt, tx,
    ...(paid ? {} : { refused: { code: res.status === 402 ? "payment_rejected" : "seller_error", reason: why ? `The seller rejected the payment: ${why}` : `The seller answered HTTP ${res.status} after payment; nothing was charged unless a transaction is shown.` } }) };
}

/**
 * USDC with its EIP-3009 signing domain. Base: mppx's built-in asset.
 * Ethereum: domain "USD Coin" / "2", as listed in @x402/evm's default assets.
 * (USDT on Ethereum has no EIP-3009, so MPP charges in it can't be signed.)
 */
const MPP_EVM_CURRENCIES = [
  mppEvmAssets.assets.base.USDC,
  mppEvmAssets.assets.define({ address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, network: "eip155:1", transfer: { type: "eip3009", name: "USD Coin", version: "2" } }),
];

async function payMpp(url: string, init: RequestInit | undefined, first: Response, evmAccount: any, solSigner: any, deps: PayDeps): Promise<PayResult> {
  const f = deps.fetch ?? fetch;
  const methods: any[] = [];
  const evmIds = deps.policy.chains.filter((c) => c !== "solana").map((c) => (c === "base" ? 8453 : 1));
  if (evmIds.length) methods.push(mppEvm.charge({ account: evmAccount, networks: evmIds, currencies: MPP_EVM_CURRENCIES }));
  if (deps.policy.chains.includes("solana")) methods.push(mppSolana.charge({ signer: solSigner, expectedNetwork: "mainnet", ...(deps.solanaRpc ? { rpcUrl: deps.solanaRpc } : {}) }));
  const mppx = Mppx.create({ methods, polyfill: false, fetch: replayFirst(first, f) } as any) as any;
  let prepared: any;
  try { prepared = await mppx.prepareRequest(url, init); }
  catch (e) { return { paid: false, status: 402, response: null, refused: { code: "no_payable_offer", reason: `None of the seller's MPP options fit your rules: ${(e as Error).message}` } }; }
  if (!prepared.payment) return { paid: false, status: prepared.response.status, response: prepared.response };
  let offer: Offer, receipt: string;
  try { offer = offerFromMpp(prepared.payment.challenge, url); receipt = await gate(offer, url, deps); }
  catch (e) {
    const r = e instanceof Refusal ? e : new Refusal("error", (e as Error).message);
    return { paid: false, status: 402, response: null, refused: { code: r.code, reason: r.message } };
  }
  let res: Response;
  try { res = await prepared.payment.pay(); }
  catch (e) {
    settle(receipt, { status: "failed", reason: (e as Error).message }, deps.dir);
    return { paid: false, status: null, response: null, offer, receipt_id: receipt, refused: { code: "payment_failed", reason: (e as Error).message } };
  }
  let tx: string | undefined;
  const hdr = res.headers.get("payment-receipt");
  if (hdr) { try { tx = Receipt.deserialize(hdr).reference; } catch { /* unreadable */ } }
  const ok = res.ok || !!tx;
  settle(receipt, ok ? { status: "done", tx } : { status: "failed", reason: `seller answered HTTP ${res.status}` }, deps.dir);
  return { paid: ok, status: res.status, response: res, offer, receipt_id: receipt, tx };
}
