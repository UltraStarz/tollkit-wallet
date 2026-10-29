/**
 * 0.9.9: the Range bot's Orca transactions. Instructions come from Orca's own generated client
 * (@orca-so/whirlpools-client), assembled the way Orca's SDK (@orca-so/whirlpools 8.0.1) does it:
 *   open:  openPositionWithTokenExtensions → increaseLiquidityByTokenAmountsV2
 *   close: decreaseLiquidityV2 (all of it) → collectFeesV2 → collectRewardV2 (if any) → closePositionWithTokenExtensions
 * SOL goes in and out through a fresh wrapped-SOL account made for that one transaction and closed at its end, so the
 * owner's own wrapped SOL (and anything Run 24/7 holds) is never touched. Only the owner's key signs; the position is a
 * token in the owner's wallet, so nobody else (TOLLkit included) can move it.
 */
import { AccountRole, address, type Address, type TransactionSigner } from "@solana/kit";
import {
  getClosePositionWithTokenExtensionsInstruction, getCollectFeesV2Instruction, getCollectRewardV2Instruction, getDecreaseLiquidityV2Instruction,
  getIncreaseLiquidityByTokenAmountsV2Instruction, getInitializeDynamicTickArrayInstruction, getOpenPositionWithTokenExtensionsInstruction,
  getPositionAddress, getPositionDecoder, getTickArrayAddress, getUpdateFeesAndRewardsInstruction, getWhirlpoolDecoder, increaseLiquidityMethod, type Position, type Whirlpool,
} from "@orca-so/whirlpools-client";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import {
  ACCOUNT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createInitializeAccount3Instruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { amountsForLiquidity, sqrtPriceSlippageBounds, sqrtPriceToPrice, tickArrayStart, tickToPrice, tickToSqrtPrice } from "./clmm.js";

export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/** Orca's SOL/USDC Whirlpool (tick spacing 4, 0.04% fee): the deepest SOL pool on Orca (api.orca.so, Oct 2026). */
export const SOL_USDC_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Orca's metadata authority for position tokens (the SDK's own value). */
const METADATA_AUTH = "3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr";
const DEFAULT = "11111111111111111111111111111111";
const WSOL_RENT = 2_039_280; // rent-exempt minimum for a 165-byte token account
export const DEC_A = 9, DEC_B = 6;

/** A kit instruction as a web3.js one (the wallet signs with web3.js). */
export function toWeb3(ix: { programAddress: string; accounts?: readonly { address: string; role: number }[]; data?: Uint8Array | ReadonlyUint8Array }): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER, isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}
type ReadonlyUint8Array = { readonly [n: number]: number; readonly length: number };
/** The client wants signer objects; it only reads their address. Signing happens in web3.js. */
const signer = (a: string) => ({ address: address(a), signTransactions: async () => [] }) as unknown as TransactionSigner;
const A = (s: string | PublicKey) => address(typeof s === "string" ? s : s.toBase58()) as Address;

export interface Pool { address: string; data: Whirlpool; price: number }
export async function readPool(conn: Pick<Connection, "getAccountInfo">, pool = SOL_USDC_POOL): Promise<Pool> {
  const acc = await conn.getAccountInfo(new PublicKey(pool), "confirmed");
  if (!acc) throw new Error("Couldn't read Orca's SOL/USDC pool. Try again in a minute.");
  const data = getWhirlpoolDecoder().decode(acc.data);
  return { address: pool, data, price: sqrtPriceToPrice(data.sqrtPrice, DEC_A, DEC_B) };
}
export async function positionAddress(mint: string): Promise<string> { return (await getPositionAddress(A(mint)))[0]; }
export async function readPosition(conn: Pick<Connection, "getAccountInfo">, mint: string): Promise<Position | null> {
  const acc = await conn.getAccountInfo(new PublicKey(await positionAddress(mint)), "confirmed");
  return acc ? getPositionDecoder().decode(acc.data) : null;
}

/** A wrapped-SOL account for one transaction: made, funded with `lamports`, and closed back to the owner at the end. */
function tempWsol(owner: PublicKey, lamports: bigint) {
  const kp = Keypair.generate();
  return {
    kp,
    open: [
      SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: kp.publicKey, lamports: WSOL_RENT + Number(lamports), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(kp.publicKey, NATIVE_MINT, owner),
    ],
    close: createCloseAccountInstruction(kp.publicKey, owner, owner),
  };
}

export interface OpenPlan { tx: Transaction; signers: Keypair[]; positionMint: string; lower: number; upper: number; newArrays: number; price: number }
/**
 * Open a position between two ticks with up to `maxSol` lamports and `maxUsdc` (6 decimals). Slippage: the pool's
 * price may move `slippageBps` before it lands, or the transaction fails and nothing moves.
 */
export async function buildOpen(conn: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo">, o: { owner: PublicKey; lower: number; upper: number; maxSol: bigint; maxUsdc: bigint; slippageBps: number; pool?: Pool }): Promise<OpenPlan> {
  const pool = o.pool ?? await readPool(conn), w = pool.data, sp = w.tickSpacing;
  if (w.tokenMintA !== NATIVE_MINT.toBase58() || w.tokenMintB !== USDC_MINT) throw new Error("That isn't the SOL/USDC pool.");
  if (!(o.lower < o.upper) || o.lower % sp || o.upper % sp) throw new Error("The range isn't on the pool's tick spacing.");
  const mint = Keypair.generate(), owner = o.owner;
  const position = await positionAddress(mint.publicKey.toBase58());
  const posAta = getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
  const loStart = tickArrayStart(o.lower, sp), hiStart = tickArrayStart(o.upper, sp);
  const [loArr] = await getTickArrayAddress(A(pool.address), loStart), [hiArr] = await getTickArrayAddress(A(pool.address), hiStart);
  const arrays = await conn.getMultipleAccountsInfo([new PublicKey(loArr), new PublicKey(hiArr)], "confirmed");
  const wsol = tempWsol(owner, o.maxSol), usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner);
  const ixs: TransactionInstruction[] = [...wsol.open,
    createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, new PublicKey(USDC_MINT))];
  // A price level nobody has used yet needs its tick array made first (a small one-off rent the owner pays, as in Orca's app).
  let newArrays = 0;
  for (const [i, start, arr] of [[0, loStart, loArr], [1, hiStart, hiArr]] as const) {
    if (arrays[i] || (i === 1 && hiStart === loStart)) continue;
    ixs.push(toWeb3(getInitializeDynamicTickArrayInstruction({ whirlpool: A(pool.address), funder: signer(owner.toBase58()), tickArray: arr, startTickIndex: start, idempotent: true })));
    newArrays++;
  }
  ixs.push(toWeb3(getOpenPositionWithTokenExtensionsInstruction({
    funder: signer(owner.toBase58()), owner: A(owner), position: A(position), positionMint: signer(mint.publicKey.toBase58()), positionTokenAccount: A(posAta),
    whirlpool: A(pool.address), token2022Program: A(TOKEN_2022_PROGRAM_ID), metadataUpdateAuth: A(METADATA_AUTH),
    tickLowerIndex: o.lower, tickUpperIndex: o.upper, withTokenMetadataExtension: true,
  })));
  const { min, max } = sqrtPriceSlippageBounds(w.sqrtPrice, o.slippageBps);
  ixs.push(toWeb3(getIncreaseLiquidityByTokenAmountsV2Instruction({
    whirlpool: A(pool.address), tokenProgramA: A(TOKEN_PROGRAM_ID), tokenProgramB: A(TOKEN_PROGRAM_ID), memoProgram: A(MEMO),
    positionAuthority: signer(owner.toBase58()), position: A(position), positionTokenAccount: A(posAta),
    tokenMintA: w.tokenMintA, tokenMintB: w.tokenMintB, tokenOwnerAccountA: A(wsol.kp.publicKey), tokenOwnerAccountB: A(usdcAta),
    tokenVaultA: w.tokenVaultA, tokenVaultB: w.tokenVaultB, tickArrayLower: loArr, tickArrayUpper: hiArr,
    method: increaseLiquidityMethod("ByTokenAmounts", { tokenMaxA: o.maxSol, tokenMaxB: o.maxUsdc, minSqrtPrice: min, maxSqrtPrice: max }), remainingAccountsInfo: null,
  })));
  ixs.push(wsol.close);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = owner;
  return { tx, signers: [mint, wsol.kp], positionMint: mint.publicKey.toBase58(), lower: o.lower, upper: o.upper, newArrays, price: pool.price };
}

export interface ClosePlan { tx: Transaction; signers: Keypair[]; estSol: bigint; estUsdc: bigint; feesSol: bigint; feesUsdc: bigint; price: number }
/** Take everything out of a position (its coins, fees and any rewards) and close it, back into the owner's wallet. */
export async function buildClose(conn: Pick<Connection, "getAccountInfo">, o: { owner: PublicKey; positionMint: string; slippageBps: number; pool?: Pool }): Promise<ClosePlan> {
  const pos = await readPosition(conn, o.positionMint);
  if (!pos) throw new Error("That position is already closed.");
  const pool = o.pool ?? await readPool(conn, pos.whirlpool), w = pool.data, sp = w.tickSpacing, owner = o.owner;
  const position = await positionAddress(o.positionMint);
  const posAta = getAssociatedTokenAddressSync(new PublicKey(o.positionMint), owner, false, TOKEN_2022_PROGRAM_ID);
  const [loArr] = await getTickArrayAddress(A(pool.address), tickArrayStart(pos.tickLowerIndex, sp));
  const [hiArr] = await getTickArrayAddress(A(pool.address), tickArrayStart(pos.tickUpperIndex, sp));
  const est = amountsForLiquidity(pos.liquidity, w.sqrtPrice, tickToSqrtPrice(pos.tickLowerIndex), tickToSqrtPrice(pos.tickUpperIndex));
  const keep = BigInt(10_000 - Math.min(10_000, Math.round(o.slippageBps)));
  const wsol = tempWsol(owner, 0n), usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner);
  const ixs: TransactionInstruction[] = [...wsol.open,
    createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, new PublicKey(USDC_MINT))];
  const common = {
    whirlpool: A(pool.address), positionAuthority: signer(owner.toBase58()), position: A(position), positionTokenAccount: A(posAta),
    tokenMintA: w.tokenMintA, tokenMintB: w.tokenMintB, tokenOwnerAccountA: A(wsol.kp.publicKey), tokenOwnerAccountB: A(usdcAta),
    tokenVaultA: w.tokenVaultA, tokenVaultB: w.tokenVaultB, tokenProgramA: A(TOKEN_PROGRAM_ID), tokenProgramB: A(TOKEN_PROGRAM_ID), memoProgram: A(MEMO), remainingAccountsInfo: null,
  };
  if (pos.liquidity > 0n) ixs.push(toWeb3(getDecreaseLiquidityV2Instruction({ ...common, tickArrayLower: loArr, tickArrayUpper: hiArr,
    liquidityAmount: pos.liquidity, tokenMinA: (est.a * keep) / 10_000n, tokenMinB: (est.b * keep) / 10_000n })));
  ixs.push(toWeb3(getCollectFeesV2Instruction(common)));
  // Rewards: any reward the pool has set up is collected, so the position is empty and can close.
  w.rewardInfos.forEach((ri, i) => {
    if (ri.mint === DEFAULT || (ri.emissionsPerSecondX64 === 0n && pos.rewardInfos[i]!.amountOwed === 0n && ri.growthGlobalX64 === 0n)) return;
    const ata = getAssociatedTokenAddressSync(new PublicKey(ri.mint), owner);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, new PublicKey(ri.mint)));
    ixs.push(toWeb3(getCollectRewardV2Instruction({ whirlpool: A(pool.address), positionAuthority: signer(owner.toBase58()), position: A(position), positionTokenAccount: A(posAta),
      rewardOwnerAccount: A(ata), rewardMint: ri.mint, rewardVault: ri.vault, rewardIndex: i, rewardTokenProgram: A(TOKEN_PROGRAM_ID), memoProgram: A(MEMO), remainingAccountsInfo: null })));
  });
  ixs.push(toWeb3(getClosePositionWithTokenExtensionsInstruction({ positionAuthority: signer(owner.toBase58()), receiver: A(owner), position: A(position),
    positionMint: A(o.positionMint), positionTokenAccount: A(posAta), token2022Program: A(TOKEN_2022_PROGRAM_ID) })));
  ixs.push(wsol.close);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = owner;
  return { tx, signers: [wsol.kp], estSol: est.a, estUsdc: est.b, feesSol: pos.feeOwedA, feesUsdc: pos.feeOwedB, price: pool.price };
}

/** What a position holds now, in plain numbers. */
export function describePosition(pos: Position, pool: Pool) {
  const amt = amountsForLiquidity(pos.liquidity, pool.data.sqrtPrice, tickToSqrtPrice(pos.tickLowerIndex), tickToSqrtPrice(pos.tickUpperIndex));
  const lower = tickToPrice(pos.tickLowerIndex, DEC_A, DEC_B), upper = tickToPrice(pos.tickUpperIndex, DEC_A, DEC_B);
  const sol = Number(amt.a) / 1e9, usdc = Number(amt.b) / 1e6;
  return { lower, upper, sol, usdc, usd: sol * pool.price + usdc, inRange: pool.data.tickCurrentIndex >= pos.tickLowerIndex && pool.data.tickCurrentIndex < pos.tickUpperIndex };
}

/**
 * The fees a position has earned so far, exactly: Orca only writes them into the position when it's touched, so this
 * simulates its updateFeesAndRewards step (read-only: nothing is signed or sent) and reads the position afterwards.
 */
export async function feesOwed(conn: Pick<Connection, "getAccountInfo" | "simulateTransaction" | "getLatestBlockhash">, owner: PublicKey, mint: string): Promise<{ sol: bigint; usdc: bigint } | null> {
  const pos = await readPosition(conn, mint);
  if (!pos) return null;
  if (pos.liquidity === 0n) return { sol: pos.feeOwedA, usdc: pos.feeOwedB };
  const pool = await readPool(conn, pos.whirlpool), sp = pool.data.tickSpacing, position = await positionAddress(mint);
  const [lo] = await getTickArrayAddress(A(pool.address), tickArrayStart(pos.tickLowerIndex, sp)), [hi] = await getTickArrayAddress(A(pool.address), tickArrayStart(pos.tickUpperIndex, sp));
  const tx = new Transaction().add(toWeb3(getUpdateFeesAndRewardsInstruction({ whirlpool: A(pool.address), position: A(position), tickArrayLower: lo, tickArrayUpper: hi })));
  tx.feePayer = owner; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const sim = await conn.simulateTransaction(tx, undefined, [new PublicKey(position)]);
  const acc = sim.value.accounts?.[0];
  if (sim.value.err || !acc) return { sol: pos.feeOwedA, usdc: pos.feeOwedB };
  const after = getPositionDecoder().decode(Buffer.from(acc.data[0], "base64"));
  return { sol: after.feeOwedA, usdc: after.feeOwedB };
}
