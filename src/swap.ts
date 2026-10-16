/**
 * Spot swaps. EVM (Base, Ethereum): 0x Swap API v2, AllowanceHolder flow.
 * Solana: Jupiter Swap V2 (/order + /execute). Quotes come through Tollkit's
 * quote proxy (api.tollkit.dev/wallet/...), which holds the 0x and Jupiter API
 * keys and adds the flat 0.5% fee; it only ever sees public data and signed
 * transactions, never keys. The wallet checks every quote before signing:
 * fee not above 0.5%, the only approval ever given is to 0x AllowanceHolder
 * (exact amount), and the minimum output is set. It doesn't trust the quote
 * server with what it signs (0.2.3): verifySwapTx decodes 0x calldata (exact
 * token, amount and ETH value; the Settler call must pay this wallet the buy
 * token with the minimum shown; Settler must be listed by 0x's on-chain
 * registry, github.com/0xProject/0x-settler README), and simulates Solana
 * swaps, refusing any that take more than the coin being sold.
 */
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AbiCoder, Contract, Interface, JsonRpcProvider, ZeroAddress, type Wallet, type HDNodeWallet } from "ethers";
import { KNOWN } from "./tokens.js";
import { sendingProvider, waitMined } from "./evmsend.js";
import { ALLOWANCE_HOLDER, DEFAULT_RPC, EVM_CHAIN_ID, NATIVE_EVM, STABLES, SWAP_FEE_BPS, WSOL, isStable, type Chain } from "./chains.js";

type Fetch = typeof fetch;
export const DEFAULT_PROXY = "https://api.tollkit.dev/wallet";

export interface SwapRequest { chain: Chain; sell_token: string; buy_token: string; sell_amount: string; slippage_bps: number }
export interface SwapQuote {
  chain: Chain; venue: "0x" | "jupiter";
  sell_token: string; buy_token: string; sell_amount: string; buy_amount: string; min_buy_amount: string;
  fee_bps: number; venue_fee_bps: number; usd_value: number | null; fee_usd: number | null;
  /** Solana only: Jupiter's route doesn't carry Tollkit's fee, so the wallet sends it on its own, in SOL, after the swap. */
  fee_separate?: boolean;
  /** Solana only: built from Jupiter's instructions with Tollkit's fee (in SOL) inside the same transaction. */
  fee_inline?: boolean;
  raw: any;
}

/**
 * Jupiter pays Tollkit's 0.5% out of the route only when Tollkit has a fee account for the token Jupiter picks to
 * take the fee in (it prefers SOL, then stablecoins, then other tokens). For any other token the order comes back
 * with Jupiter's own default fee instead (developers.jup.ag/docs/swap/fees: "the order still returns but executes
 * without your fees"), and Tollkit's fee is sent separately.
 */
export function jupiterFeeInRoute(raw: any): boolean {
  return !!raw?.referralAccount && Number(raw?.platformFee?.feeBps ?? raw?.feeBps) === SWAP_FEE_BPS;
}

/** The coin Tollkit's fee is taken in on Base and Ethereum: a stablecoin side first, then ETH or WETH, else the coin sold. */
export function feeTokenFor(chain: Chain, sell: string, buy: string): string {
  const eth = (t: string) => t.toLowerCase() === NATIVE_EVM.toLowerCase() || t.toLowerCase() === (KNOWN as any)[chain]?.WETH?.address?.toLowerCase();
  if (isStable(chain, sell)) return sell;
  if (isStable(chain, buy)) return buy;
  if (eth(sell)) return sell;
  if (eth(buy)) return buy;
  return sell;
}

/** Tollkit's 0.5% in lamports: straight from the SOL side when there is one, else the trade's dollar value at SOL's price. */
export function solFeeLamports(q: Pick<SwapQuote, "sell_token" | "buy_token" | "sell_amount" | "buy_amount">, usd: number | null, solUsd: number | null): bigint {
  const bps = BigInt(SWAP_FEE_BPS);
  if (q.sell_token === WSOL) return (BigInt(q.sell_amount) * bps) / 10000n;
  if (q.buy_token === WSOL) return (BigInt(q.buy_amount) * bps) / 10000n;
  if (!(usd && usd > 0) || !(solUsd && solUsd > 0)) throw new Error("No SOL price right now to work out Tollkit's fee. Try again in a minute.");
  return BigInt(Math.ceil(((usd * SWAP_FEE_BPS) / 10000 / solUsd) * 1e9));
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

export async function getQuote(req: SwapRequest, taker: string, opts: { fetch?: Fetch; proxy?: string; build?: boolean } = {}): Promise<SwapQuote> {
  const f = opts.fetch ?? fetch, proxy = opts.proxy ?? DEFAULT_PROXY;
  if (req.chain === "solana") {
    const u = new URL(`${proxy}/swap/solana/order`);
    u.search = new URLSearchParams({ inputMint: req.sell_token, outputMint: req.buy_token, amount: req.sell_amount, taker, slippageBps: String(req.slippage_bps) }).toString();
    const j = await getJson(f, u.toString());
    const inRoute = jupiterFeeInRoute(j);
    if (!inRoute && opts.build !== false) {
      // No Tollkit fee account for the coin Jupiter would take the fee in: build the swap from Jupiter's router
      // instructions instead, so Tollkit's 0.5% (in SOL) goes in the same transaction. If that path isn't
      // available, fall back to the order with the fee sent right after (below).
      try {
        const bu = new URL(`${proxy}/swap/solana/build`);
        bu.search = new URLSearchParams({ inputMint: req.sell_token, outputMint: req.buy_token, amount: req.sell_amount, taker, slippageBps: String(req.slippage_bps) }).toString();
        const b = await getJson(f, bu.toString());
        if (b?.swapInstruction && b?.tollkit_fee && typeof b.tollkit_fee.recipient === "string") {
          return withUsd({
            chain: "solana", venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token,
            sell_amount: String(b.inAmount ?? req.sell_amount), buy_amount: String(b.outAmount), min_buy_amount: String(b.otherAmountThreshold ?? b.outAmount),
            fee_bps: Number(b.tollkit_fee.bps) === 0 ? 0 : SWAP_FEE_BPS, venue_fee_bps: 0, usd_value: null, fee_usd: null,
            raw: { build: b, swapUsdValue: j.swapUsdValue, inUsdValue: j.inUsdValue }, fee_inline: true,
          });
        }
      } catch { /* the order below, with the fee sent separately */ }
    }
    const q: SwapQuote = {
      chain: "solana", venue: "jupiter", sell_token: req.sell_token, buy_token: req.buy_token,
      sell_amount: String(j.inAmount ?? req.sell_amount), buy_amount: String(j.outAmount), min_buy_amount: String(j.otherAmountThreshold ?? j.outAmount),
      // Tollkit's fee is always 0.5%; when the route doesn't carry it, whatever the route does carry is Jupiter's own.
      fee_bps: SWAP_FEE_BPS, venue_fee_bps: inRoute ? 0 : Math.max(0, Number(j.platformFee?.feeBps ?? j.feeBps ?? 0) || 0),
      usd_value: null, fee_usd: null, raw: j, ...(inRoute ? {} : { fee_separate: true }),
    };
    return withUsd(q);
  }
  const u = new URL(`${proxy}/swap/evm/quote`);
  u.search = new URLSearchParams({ chainId: String(EVM_CHAIN_ID[req.chain]), sellToken: req.sell_token, buyToken: req.buy_token, sellAmount: req.sell_amount, taker, slippageBps: String(req.slippage_bps), feeToken: feeTokenFor(req.chain, req.sell_token, req.buy_token) }).toString();
  const j = await getJson(f, u.toString());
  const sell = BigInt(j.sellAmount ?? req.sell_amount), buy = BigInt(j.buyAmount ?? "0");
  // A fee is a share of the side it's taken from: the amount sold, or what was bought before the fee came off.
  const share = (fee: any) => {
    const amt = BigInt(fee?.amount ?? "0"), tok = String(fee?.token ?? req.sell_token).toLowerCase();
    const base = tok === req.buy_token.toLowerCase() ? buy + amt : tok === req.sell_token.toLowerCase() ? sell : 0n;
    return base > 0n ? Number((amt * 20000n / base + 1n) / 2n) : 0;
  };
  const feeBps = share(j?.fees?.integratorFee);
  // 0x's own fee (0.15% on select pairs on the Standard plan), shown to the user too.
  const venueBps = j?.fees?.zeroExFee ? share(j.fees.zeroExFee) : 0;
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
export function vetQuote(q: SwapQuote, req: SwapRequest, taker?: string): string | null {
  if (q.sell_amount !== req.sell_amount) return "The quote is for a different amount than requested.";
  if (q.fee_bps > SWAP_FEE_BPS) return `The quote carries a ${q.fee_bps / 100}% fee; Tollkit's fee is ${SWAP_FEE_BPS / 100}%.`;
  if (!(BigInt(q.min_buy_amount) > 0n)) return "The quote has no minimum output.";
  if (q.venue === "0x") {
    const tx = q.raw?.transaction;
    if (!tx?.to || !tx?.data) return "The quote has no transaction.";
    if (String(tx.to).toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) return `The swap would be sent to ${tx.to}, not 0x AllowanceHolder.`;
    const spender = q.raw?.issues?.allowance?.spender;
    if (spender && String(spender).toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) return `The quote asks to approve ${spender}; only 0x AllowanceHolder is ever approved.`;
    if (taker && tx.data !== undefined) { try { checkZeroExTx(q, taker); } catch (e) { return (e as Error).message; } }
  } else {
    if (q.raw?.build) { if (!q.raw.build.swapInstruction) return "The quote has no swap instruction."; }
    else if (!q.raw?.transaction || !q.raw?.requestId) return "The quote has no transaction.";
  }
  return null;
}

const ERC20 = ["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];

/** 0x Settler registry, the same address on every chain; feature 2 = taker-submitted swaps. */
export const SETTLER_REGISTRY = "0x00000000000004533Fe15556B1E086BB1A72cEae";
const ALLOWANCE_EXEC = new Interface(["function exec(address operator, address token, uint256 amount, address target, bytes data)"]);
const SETTLER_EXECUTE = "0x1fff991f"; // execute((address recipient, address buyToken, uint256 minAmountOut), bytes[], bytes32)

/** Decode a 0x quote's transaction and check it does only the swap shown. Returns the Settler address it uses. */
export function checkZeroExTx(q: SwapQuote, taker: string): string {
  const t = q.raw?.transaction ?? {};
  const native = q.sell_token.toLowerCase() === NATIVE_EVM.toLowerCase();
  const value = BigInt(t.value ?? "0"), sell = BigInt(q.sell_amount);
  if (String(t.to ?? "").toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase()) throw new Error("The swap isn't sent to 0x AllowanceHolder.");
  if (value !== (native ? sell : 0n)) throw new Error("The swap would send a different amount of ETH than you're selling.");
  let p: ReturnType<Interface["parseTransaction"]> = null;
  try { p = ALLOWANCE_EXEC.parseTransaction({ data: String(t.data ?? "") }); } catch { p = null; }
  if (!p || p.name !== "exec") throw new Error("The swap transaction isn't a 0x swap.");
  const [operator, token, amount, target, inner] = p.args as unknown as [string, string, bigint, string, string];
  if (token.toLowerCase() !== (native ? ZeroAddress : q.sell_token).toLowerCase() || amount !== sell) throw new Error("The swap would take a different coin or amount than you're selling.");
  if (operator.toLowerCase() !== target.toLowerCase()) throw new Error("The swap transaction isn't a 0x swap.");
  if (!inner.startsWith(SETTLER_EXECUTE) || inner.length < 10 + 64 * 3) throw new Error("The swap transaction isn't a 0x swap.");
  const [recipient, buyToken, minOut] = AbiCoder.defaultAbiCoder().decode(["address", "address", "uint256"], "0x" + inner.slice(10, 10 + 64 * 3)) as unknown as [string, string, bigint];
  if (recipient.toLowerCase() !== taker.toLowerCase()) throw new Error("The swap would pay someone other than this wallet.");
  if (buyToken.toLowerCase() !== q.buy_token.toLowerCase()) throw new Error("The swap would buy a different coin.");
  if (minOut !== BigInt(q.min_buy_amount)) throw new Error("The swap's minimum doesn't match the quote shown.");
  return target;
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Programs a Solana swap may call directly. JUP6…: Jupiter's router (Metis), as seen in live Ultra orders. */
export const SWAP_PROGRAMS = new Set(["ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", ...TOKEN_PROGRAMS, ATA_PROGRAM, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]);
export interface VerifyDeps {
  /** A Solana transaction the wallet assembled itself (Jupiter's router path), and the SOL it adds for Tollkit's fee. */ vtx?: VersionedTransaction; extraLamports?: bigint;
  /** eth_call on the swap's chain; returns the hex result. */ evmCall?: (chain: Chain, to: string, data: string) => Promise<string>;
  /** Solana connection (tests pass a fake). */ conn?: Pick<Connection, "getBalance" | "getParsedTokenAccountsByOwner" | "simulateTransaction"> & { getAddressLookupTable?: Connection["getAddressLookupTable"] };
}

/** Before signing: check the quote server's transaction does only the swap that was shown. Throws if not. */
export async function verifySwapTx(q: SwapQuote, me: { evm: string; solana: PublicKey }, d: VerifyDeps & ExecDeps = {}): Promise<void> {
  if (q.venue === "0x") {
    const settler = checkZeroExTx(q, me.evm).toLowerCase();
    const call = d.evmCall ?? ((chain: Chain, to: string, data: string) => new JsonRpcProvider(d.rpc?.[chain] ?? DEFAULT_RPC[chain], EVM_CHAIN_ID[chain as "base" | "ethereum"], { staticNetwork: true }).call({ to, data }));
    const reg = async (sel: string) => { try { return String(AbiCoder.defaultAbiCoder().decode(["address"], await call(q.chain, SETTLER_REGISTRY, sel + "0".repeat(63) + "2"))[0]).toLowerCase(); } catch { return ""; } };
    // ownerOf(2) is the current Settler; prev(2) the one before, still used while 0x's API catches up.
    if ((await reg("0x6352211e")) !== settler && (await reg("0xe2603dc2")) !== settler) throw new Error("The swap goes through a contract 0x's registry doesn't list. Not signing it.");
    return;
  }
  let vtx: VersionedTransaction;
  if (d.vtx) vtx = d.vtx;
  else try { vtx = VersionedTransaction.deserialize(Buffer.from(String(q.raw?.transaction ?? ""), "base64")); } catch { throw new Error("The quote's transaction can't be read."); }
  const signers = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures);
  if (!signers.some((k) => k.equals(me.solana))) throw new Error("The quote's transaction isn't for this wallet.");
  const conn = d.conn ?? new Connection(d.rpc?.solana ?? DEFAULT_RPC.solana, "confirmed");
  const fail = () => new Error("Couldn't check this swap before signing. Try again in a moment.");
  // Only programs whose behaviour is known: Jupiter's own router (Metis, seen in live orders 2026-10-14) and the
  // Solana programs a swap needs. A route through anything else is refused rather than trusted.
  const statics = vtx.message.staticAccountKeys;
  for (const ix of vtx.message.compiledInstructions) {
    const prog = statics[ix.programIdIndex]?.toBase58();
    if (!prog || !SWAP_PROGRAMS.has(prog)) throw new Error("This swap route goes through a program Tollkit doesn't sign for. Try again in a moment or change the amount.");
    if (prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
      // Approve, ApproveChecked, SetAuthority: never part of a swap.
      if ([4, 6, 13].includes(ix.data[0]!)) throw new Error("This swap would change who controls your tokens. Not signing it.");
    }
  }
  type Held = { mint: string; amount: bigint; delegate: string | null; close: string | null };
  const held = new Map<string, Held>();
  try {
    for (const prog of TOKEN_PROGRAMS) {
      const r = await conn.getParsedTokenAccountsByOwner(me.solana, { programId: new PublicKey(prog) });
      for (const a of r.value) { const i = (a.account.data as any).parsed?.info; if (i) held.set(a.pubkey.toBase58(), { mint: i.mint, amount: BigInt(i.tokenAmount.amount), delegate: i.delegate ?? null, close: i.closeAuthority ?? null }); }
    }
  } catch { throw fail(); }
  const luts = [];
  for (const l of vtx.message.addressTableLookups ?? []) { const t = await conn.getAddressLookupTable?.(l.accountKey).catch(() => null); if (!t?.value) throw fail(); luts.push(t.value); }
  const keys = vtx.message.getAccountKeys({ addressLookupTableAccounts: luts });
  const watch: string[] = [];
  for (let i = 0; i < keys.length; i++) { const k = keys.get(i)!.toBase58(); if (held.has(k) && vtx.message.isAccountWritable(i)) watch.push(k); }
  // The account the bought coin lands in, even if it doesn't exist yet (then it starts at 0).
  const buyAtas = q.buy_token === WSOL ? [] : TOKEN_PROGRAMS.map((p) => ataOf(me.solana, new PublicKey(q.buy_token), new PublicKey(p))).filter((a) => !watch.includes(a));
  const addresses = [me.solana.toBase58(), ...watch, ...buyAtas];
  if (addresses.length > 128) throw fail();
  let sim: any;
  try { sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses } }); } catch { throw fail(); }
  const accs = sim?.value?.accounts;
  if (sim?.value?.err || !accs?.[0]) throw fail();
  const before = await conn.getBalance(me.solana);
  if (accs[0].owner && accs[0].owner !== "11111111111111111111111111111111") throw new Error("This swap would hand your wallet account to another program. Not signing it.");
  const tokens = new Map<string, bigint>();
  const readTok = (a: any) => { const b = Buffer.from(String(a?.data?.[0] ?? ""), "base64"); return b.length >= 165 ? b : null; };
  watch.forEach((addr, i) => {
    const w = held.get(addr)!, a = accs[i + 1];
    if (!a) { tokens.set(w.mint, (tokens.get(w.mint) ?? 0n) - w.amount); return; }
    const b = readTok(a);
    if (!b) return;
    if (!b.subarray(32, 64).equals(me.solana.toBuffer())) throw new Error("This swap would give one of your token accounts to someone else. Not signing it.");
    const delegate = b.readUInt32LE(72) === 1 ? new PublicKey(b.subarray(76, 108)).toBase58() : null;
    if (delegate && delegate !== w.delegate) throw new Error("This swap would let another account spend your tokens later. Not signing it.");
    const close = b.readUInt32LE(129) === 1 ? new PublicKey(b.subarray(133, 165)).toBase58() : null;
    if (close && close !== w.close) throw new Error("This swap would let another account close one of your token accounts. Not signing it.");
    tokens.set(w.mint, (tokens.get(w.mint) ?? 0n) + b.readBigUInt64LE(64) - w.amount);
  });
  buyAtas.forEach((_addr, i) => {
    const b = readTok(accs[watch.length + 1 + i]);
    if (!b || !b.subarray(32, 64).equals(me.solana.toBuffer()) || new PublicKey(b.subarray(0, 32)).toBase58() !== q.buy_token) return;
    tokens.set(q.buy_token, (tokens.get(q.buy_token) ?? 0n) + b.readBigUInt64LE(64));
  });
  const sell = BigInt(q.sell_amount), sellingSol = q.sell_token === WSOL, buyingSol = q.buy_token === WSOL;
  const solDelta = BigInt(accs[0].lamports) - BigInt(before) + (tokens.get(WSOL) ?? 0n);
  // Network fees, priority fees and a new token account's deposit stay under 0.01 SOL.
  // Plus Tollkit's fee when the wallet put it in this transaction itself.
  const FEES = 10_000_000n + (d.extraLamports ?? 0n);
  if (sellingSol && -solDelta > sell + FEES) throw new Error("This swap would take more SOL than you're selling. Not signing it.");
  if (!sellingSol && !buyingSol && -solDelta > FEES) throw new Error("This swap would take more SOL than network fees. Not signing it.");
  for (const [mint, delta] of tokens) {
    if (delta >= 0n || mint === WSOL) continue;
    if (mint !== q.sell_token || -delta > sell) throw new Error("This swap would take a coin you aren't selling, or more of it. Not signing it.");
  }
  const min = BigInt(q.min_buy_amount);
  const got = buyingSol ? solDelta + FEES : (tokens.get(q.buy_token) ?? 0n);
  if (got < min) throw new Error("The checked swap pays less than the minimum shown. Not signing it.");
}

/** Associated token account address (the ATA program's seeds: owner, token program, mint). */
function ataOf(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): string {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
}

export interface ExecDeps { rpc?: Partial<Record<Chain, string>>; fetch?: Fetch; proxy?: string; verify?: VerifyDeps; /** tests: the EVM provider to send with */ provider?: JsonRpcProvider; /** tests: how often to check a Solana send */ pollMs?: number }

const toIx = (i: any) => new TransactionInstruction({ programId: new PublicKey(i.programId), keys: (i.accounts ?? []).map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.isSigner, isWritable: !!a.isWritable })), data: Buffer.from(String(i.data ?? ""), "base64") });
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * Jupiter's router instructions (Swap API v2 /build) plus Tollkit's fee as a plain SOL transfer, in one v0
 * transaction: compute-unit limit from a simulation (x1.2, at most 1.4M), Jupiter's priority price, a fresh
 * blockhash. Checked with the same rules as any swap, then sent and confirmed by polling.
 */
export async function assembleBuilt(q: SwapQuote, payer: PublicKey, conn: Pick<Connection, "getLatestBlockhash" | "simulateTransaction">): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number; feeLamports: bigint }> {
  const b = q.raw.build, fee = q.raw.fee as { lamports: string; to: string } | undefined;
  const feeLamports = fee ? BigInt(fee.lamports) : 0n;
  const price = (b.computeBudgetInstructions ?? []).map(toIx).filter((ix: TransactionInstruction) => !(ix.programId.toBase58() === COMPUTE_BUDGET && ix.data[0] === 2));
  const body: TransactionInstruction[] = [...(b.setupInstructions ?? []).map(toIx), toIx(b.swapInstruction), ...(b.cleanupInstruction ? [toIx(b.cleanupInstruction)] : []), ...(b.otherInstructions ?? []).map(toIx)];
  if (feeLamports > 0n) body.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(fee!.to), lamports: feeLamports }));
  const luts = Object.entries(b.addressesByLookupTableAddress ?? {}).map(([key, addrs]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: (addrs as string[]).map((a) => new PublicKey(a)) } }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const compile = (units: number) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...price, ...body] }).compileToV0Message(luts));
  const sim = await conn.simulateTransaction(compile(1_400_000), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`This swap would fail right now (${JSON.stringify(sim.value.err)}). Try again in a moment.`);
  const units = Math.min(1_400_000, Math.ceil((sim.value.unitsConsumed ?? 1_200_000) * 1.2));
  return { tx: compile(units), lastValidBlockHeight, feeLamports };
}

async function executeBuilt(q: SwapQuote, keys: { solana: Keypair }, deps: ExecDeps): Promise<string> {
  const conn = (deps.verify?.conn as unknown as Connection) ?? new Connection(deps.rpc?.solana ?? DEFAULT_RPC.solana, "confirmed");
  const { tx, lastValidBlockHeight, feeLamports } = await assembleBuilt(q, keys.solana.publicKey, conn);
  await verifySwapTx(q, { evm: "", solana: keys.solana.publicKey }, { ...deps, ...deps.verify, vtx: tx, extraLamports: feeLamports });
  tx.sign([keys.solana]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
  const until = Date.now() + 90_000;
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`swap ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (Date.now() > until || (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`Solana swap ${sig} wasn't confirmed in time. Check it on an explorer before trying again.`);
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 1500));
  }
}

/** Sign and send. Returns the transaction hash / signature. */
export async function executeSwap(q: SwapQuote, keys: { evm: Wallet | HDNodeWallet; solana: Keypair }, deps: ExecDeps = {}): Promise<string> {
  // A built Solana swap is assembled first, then checked as the exact transaction that will be signed.
  if (q.venue === "jupiter" && q.raw?.build) return executeBuilt(q, keys, deps);
  await verifySwapTx(q, { evm: keys.evm.address, solana: keys.solana.publicKey }, { ...deps, ...deps.verify });
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
  // On Ethereum mainnet the approval and the swap go through Flashbots Protect (src/evmsend.ts).
  const provider = deps.provider ?? sendingProvider(q.chain, { rpc: deps.rpc, proxy: deps.proxy, fetch: deps.fetch });
  const signer = keys.evm.connect(provider);
  if (q.raw?.issues?.allowance) {
    const token = new Contract(q.sell_token, ERC20, signer);
    const a = await token.getFunction("approve")(ALLOWANCE_HOLDER, BigInt(q.sell_amount)); // exact amount, never unlimited
    await waitMined(a, "approval");
  }
  const t = q.raw.transaction;
  const sent = await signer.sendTransaction({
    to: t.to, data: t.data, value: BigInt(t.value ?? "0"),
    ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
  });
  const r = await waitMined(sent, "swap");
  if (!r || r.status !== 1) throw new Error(`swap transaction ${sent.hash} reverted`);
  return sent.hash;
}

export { Connection };
