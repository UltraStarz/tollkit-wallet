/** Tollkit's 0.5% on every swap: inside the 0x / Jupiter route, or sent on its own in SOL when Jupiter's route can't carry it. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { assembleBuilt, executeSwap, feeTokenFor, getQuote, jupiterFeeInRoute, solFeeLamports, type SwapQuote } from "../src/swap.js";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Wallet as EvmWallet } from "ethers";
import { entries } from "../src/ledger.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const PW = "correct horse battery";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const FEE_TO = "HBasGEGD1szEkNCWckRoZg2vZGhzt7yLSixLgSHi3gYf";

// Shapes copied from live Tollkit /wallet/swap/solana/order answers (2026-10-16): USDC->BONK carries Tollkit's 50 bps
// (fee taken in USDC); BONK->JUP falls back to Jupiter's own 10 bps because Tollkit has no fee account for BONK.
const order = (o: { feeBps: number; feeMint: string; inAmount: string; outAmount: string; usd: number }) => ({
  inAmount: o.inAmount, outAmount: o.outAmount, otherAmountThreshold: o.outAmount, feeBps: o.feeBps, feeMint: o.feeMint,
  platformFee: { feeBps: o.feeBps, feeMint: o.feeMint }, referralAccount: "GaezRGEobGTMVrisPn9oXqPpXawXEBhaSGTWpWZwn1g4",
  transaction: "AAAA", requestId: "r1", swapUsdValue: o.usd, router: "okx",
});
const jf = (body: any) => (async () => Response.json(body)) as unknown as typeof fetch;

// --- reading the route
{
  const covered = await getQuote({ chain: "solana", sell_token: USDC, buy_token: BONK, sell_amount: "10000000", slippage_bps: 50 }, "me", { fetch: jf(order({ feeBps: 50, feeMint: USDC, inAmount: "10000000", outAmount: "3000000000", usd: 10 })) });
  check(covered.fee_bps === 50 && covered.venue_fee_bps === 0 && !covered.fee_separate, "Tollkit's fee inside Jupiter's route: nothing extra to send", covered);
  const gap = await getQuote({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 }, "me", { fetch: jf(order({ feeBps: 10, feeMint: BONK, inAmount: "1000000000", outAmount: "50000000", usd: 31.2 })) });
  check(gap.fee_bps === 50 && gap.venue_fee_bps === 10 && gap.fee_separate === true, "Jupiter's fallback fee is shown as Jupiter's; Tollkit's 0.5% is still charged, separately", gap);
  check(!jupiterFeeInRoute({ feeBps: 50 }) && jupiterFeeInRoute({ feeBps: 50, referralAccount: "x", platformFee: { feeBps: 50 } }), "only a route with Tollkit's referral and 50 bps counts");
}

// --- how much SOL
check(solFeeLamports({ sell_token: WSOL, buy_token: USDC, sell_amount: "2000000000", buy_amount: "0" }, null, null) === 10_000_000n, "selling 2 SOL: 0.01 SOL fee");
check(solFeeLamports({ sell_token: USDC, buy_token: WSOL, sell_amount: "0", buy_amount: "1000000000" }, null, null) === 5_000_000n, "buying 1 SOL: 0.005 SOL fee");
check(solFeeLamports({ sell_token: BONK, buy_token: JUP, sell_amount: "1", buy_amount: "1" }, 200, 100) === 10_000_000n, "a $200 token-to-token trade at $100 SOL: 0.01 SOL ($1)");
let noPrice = ""; try { solFeeLamports({ sell_token: BONK, buy_token: JUP, sell_amount: "1", buy_amount: "1" }, 200, null); } catch (e) { noPrice = (e as Error).message; }
check(/No SOL price/.test(noPrice), "no SOL price: says so instead of guessing");

// --- the wallet sends it
async function wallet(o: { feeBps: number; balance: bigint; sendFails?: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "twf-"));
  await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
  const swaps: string[] = [], fees: { lamports: bigint; to: string }[] = [];
  const f = jf(order({ feeBps: o.feeBps, feeMint: o.feeBps === 50 ? USDC : BONK, inAmount: o.feeBps === 50 ? "20000000" : "1000000000", outAmount: "50000000", usd: 20 }));
  const w = await TollkitWallet.open(PW, {
    dir, fetch: f, proxy: "https://p.example", approve: null,
    execute: async () => { swaps.push("swap"); return "SwapSig111"; },
    solFee: { recipient: FEE_TO, solUsd: 100, balance: async () => o.balance, send: async (lamports, to) => { if (o.sendFails) throw new Error("blockhash expired"); fees.push({ lamports, to }); return "FeeSig222"; } },
  });
  // BONK and JUP are listed Solana tokens; skip the list lookup in this offline test.
  (w as any).knownToken = async () => true;
  return { w, swaps, fees, dir };
}
{
  const { w, swaps, fees, dir } = await wallet({ feeBps: 10, balance: 50_000_000n });
  const r = await w.swap({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 });
  check(r.ok && swaps.length === 1 && fees.length === 1 && fees[0]!.to === FEE_TO && fees[0]!.lamports === 1_000_000n, "a pair Jupiter can't take the fee on: the swap, then 0.5% ($0.10 of $20) in SOL to Tollkit", { r, fees });
  const e = entries(dir).at(-1)!;
  check(e.status === "done" && e.fee_tx === "FeeSig222" && e.tx === "SwapSig111" && e.fee_usd === 0.1, "the receipt has both transactions and the fee", e);
}
{
  const { w, swaps, fees } = await wallet({ feeBps: 50, balance: 0n });
  const r = await w.swap({ chain: "solana", sell_token: USDC, buy_token: BONK, sell_amount: "20000000", slippage_bps: 50 });
  check(r.ok && swaps.length === 1 && fees.length === 0, "fee inside the route: no separate transfer, no SOL needed", r);
}
{
  const { w, swaps } = await wallet({ feeBps: 10, balance: 100_000n });
  const r = await w.swap({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 });
  check(!r.ok && r.refused?.code === "insufficient_balance" && /paid in SOL/.test(r.refused.reason) && swaps.length === 0, "not enough SOL for the fee: nothing is traded", r.refused);
}
{
  const { w, dir } = await wallet({ feeBps: 10, balance: 50_000_000n, sendFails: true });
  const r = await w.swap({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 });
  const e = entries(dir).at(-1)!;
  check(r.ok && e.status === "done" && /fee wasn't sent/.test(e.reason ?? ""), "if the fee transfer fails after the swap, the receipt says so", e);
}

// --- the wallet puts the fee inside a built swap (no second transfer)
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "twf-"));
  await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
  let execQ: any = null; const fees: bigint[] = [];
  const f = (async (u: string) => new URL(u).pathname.endsWith("/build")
    ? Response.json({ inAmount: "1000000000", outAmount: "50000000", otherAmountThreshold: "49750000", swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [], data: "" }, tollkit_fee: { bps: 50, recipient: FEE_TO } })
    : Response.json(order({ feeBps: 10, feeMint: BONK, inAmount: "1000000000", outAmount: "50000000", usd: 20 }))) as unknown as typeof fetch;
  const w = await TollkitWallet.open(PW, { dir, fetch: f, proxy: "https://p.example", approve: null, execute: async (q) => { execQ = q; return "BuiltSig"; },
    solFee: { solUsd: 100, balance: async () => 50_000_000n, send: async (l) => { fees.push(l); return "x"; } } });
  (w as any).knownToken = async () => true;
  const r = await w.swap({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 });
  check(r.ok && execQ?.fee_inline && execQ.raw.fee?.lamports === "1000000" && execQ.raw.fee.to === FEE_TO && fees.length === 0, "the wallet hands the swap its fee (0.5% of $20 = 0.001 SOL at $100) and sends no second transfer", { ok: r.ok, fee: execQ?.raw?.fee, fees });
}

// --- Base and Ethereum: 0x takes it from the sold token, inside the swap
{
  const zx = await getQuote({ chain: "base", sell_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", buy_token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", sell_amount: "10000000", slippage_bps: 50 }, "0x1111111111111111111111111111111111111111",
    { fetch: jf({ sellAmount: "10000000", buyAmount: "4051239874730981", minBuyAmount: "4030000000000000", fees: { integratorFee: { amount: "50000", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", type: "volume" }, zeroExFee: { amount: "15000", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", type: "volume" } } }) });
  check(zx.fee_bps === 50 && zx.venue_fee_bps === 15 && !zx.fee_separate && zx.fee_usd === 0.05, "0x: Tollkit's 0.5% of the sold token ($0.05 of $10) is in the swap itself", zx);
}

// --- which coin the fee is taken in on Base and Ethereum
{
  const B_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ETHN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", B_WETH = "0x4200000000000000000000000000000000000006", PEPE = "0x1234567890123456789012345678901234567890", AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  check(feeTokenFor("base", ETHN, B_USDC) === B_USDC && feeTokenFor("base", B_USDC, ETHN) === B_USDC, "USDC on either side: the fee is USDC");
  check(feeTokenFor("base", PEPE, ETHN) === ETHN && feeTokenFor("base", B_WETH, AERO) === B_WETH, "no stablecoin: ETH or WETH");
  check(feeTokenFor("base", PEPE, AERO) === PEPE, "neither: the coin sold");
  let asked = "";
  const zxBuy = await getQuote({ chain: "base", sell_token: ETHN, buy_token: B_USDC, sell_amount: "10000000000000000", slippage_bps: 50 }, "0x1111111111111111111111111111111111111111",
    { fetch: (async (u: string) => { asked = new URL(u).searchParams.get("feeToken") ?? ""; return Response.json({ sellAmount: "10000000000000000", buyAmount: "24875000", minBuyAmount: "24750000", fees: { integratorFee: { amount: "125000", token: B_USDC.toLowerCase(), type: "volume" } } }); }) as unknown as typeof fetch });
  check(asked === B_USDC && zxBuy.fee_bps === 50 && zxBuy.fee_usd !== null && Math.abs(zxBuy.fee_usd! - 0.124375) < 1e-9, "selling ETH for USDC: the wallet asks for the fee in USDC, and reads 0.5% of what was bought", { asked, zxBuy });
}

// --- Solana, no Tollkit fee account for the coin: Jupiter's router instructions + the fee in the same transaction
{
  const me = Keypair.generate(), JUP6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", acct = Keypair.generate().publicKey;
  const ixj = (programId: string, accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[], data = "AQ==") => ({ programId, accounts, data });
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 });
  const build = {
    inAmount: "1000000000", outAmount: "50000000", otherAmountThreshold: "49750000",
    computeBudgetInstructions: [{ programId: price.programId.toBase58(), accounts: [], data: Buffer.from(price.data).toString("base64") }],
    setupInstructions: [], swapInstruction: ixj(JUP6, [{ pubkey: me.publicKey.toBase58(), isSigner: true, isWritable: true }, { pubkey: acct.toBase58(), isSigner: false, isWritable: true }]),
    cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
    tollkit_fee: { bps: 50, recipient: FEE_TO },
  };
  let calls: string[] = [];
  const fq = (async (u: string) => { const path = new URL(u).pathname; calls.push(path); if (path.endsWith("/order")) return Response.json(order({ feeBps: 10, feeMint: BONK, inAmount: "1000000000", outAmount: "50000000", usd: 31.2 })); if (path.endsWith("/build")) return Response.json(build); return Response.json({}, { status: 404 }); }) as unknown as typeof fetch;
  const q = await getQuote({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 }, me.publicKey.toBase58(), { fetch: fq });
  check(q.fee_inline === true && !q.fee_separate && q.fee_bps === 50 && q.venue_fee_bps === 0 && q.raw.build && calls.length === 2 && calls[0]!.endsWith("/swap/solana/order") && calls[1]!.endsWith("/swap/solana/build"), "the router path is used, with no Jupiter fee and Tollkit's 0.5% inline", { q: { ...q, raw: undefined }, calls });
  const noBuild = (async (u: string) => new URL(u).pathname.endsWith("/build") ? Response.json({ error: "x" }, { status: 503 }) : fq(u)) as unknown as typeof fetch;
  const q2 = await getQuote({ chain: "solana", sell_token: BONK, buy_token: JUP, sell_amount: "1000000000", slippage_bps: 50 }, me.publicKey.toBase58(), { fetch: noBuild });
  check(q2.fee_separate === true && !q2.fee_inline, "router path unavailable: falls back to the order with the fee sent after");

  const built: SwapQuote = { ...q, usd_value: 31.2, fee_usd: 0.156, raw: { ...q.raw, fee: { lamports: "1560000", to: FEE_TO } } };
  let simTx: any = null;
  const conn: any = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    simulateTransaction: async (tx: any, o: any) => { simTx = tx; return o?.accounts ? simReply : { value: { err: null, unitsConsumed: 200_000 } }; },
    getBalance: async () => 2e9,
    getParsedTokenAccountsByOwner: async (_o: any, f: any) => ({ value: f.programId.toBase58().startsWith("Tokenkeg") ? [{ pubkey: acct, account: { data: { parsed: { info: { mint: BONK, tokenAmount: { amount: "5000000000", decimals: 5 } } } } } }] : [] }),
    sendRawTransaction: async () => "BuiltSig1",
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    getBlockHeight: async () => 1,
  };
  const { tx, feeLamports } = await assembleBuilt(built, me.publicKey, conn);
  const keys = tx.message.staticAccountKeys, ins = tx.message.compiledInstructions;
  const progs = ins.map((i) => keys[i.programIdIndex]!.toBase58());
  const limit = Buffer.from(ins[0]!.data).readUInt32LE(1);
  const xfer = ins[3]!, to = keys[xfer.accountKeyIndexes[1]!]!.toBase58(), lamports = Buffer.from(xfer.data).readBigUInt64LE(4);
  check(progs.join() === ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", JUP6, SystemProgram.programId.toBase58()].join() && limit === 240_000, "one transaction: compute limit (1.2 x simulated), Jupiter's priority price, the swap, then Tollkit's fee", { progs, limit });
  check(to === FEE_TO && lamports === 1_560_000n && feeLamports === 1_560_000n, "the fee goes to Tollkit's Solana fee wallet, the amount the wallet worked out", { to, lamports: String(lamports) });

  // Signed and sent only if the simulated result checks out, with the fee allowed on top of network fees
  const tokData = (amt: bigint) => { const b = Buffer.alloc(165); me.publicKey.toBuffer().copy(b, 32); b.writeBigUInt64LE(amt, 64); return [b.toString("base64"), "base64"]; };
  const ataJup = Keypair.generate(); void ataJup;
  var simReply: any = { value: { err: null, accounts: [{ lamports: 2e9 - 1_560_000 - 3_000_000, owner: "11111111111111111111111111111111" }, { lamports: 1, data: tokData(4_000_000_000n) }, null, null] } };
  const ev = EvmWallet.createRandom();
  let sent = "";
  try { sent = await executeSwap({ ...built, buy_token: "So11111111111111111111111111111111111111112", min_buy_amount: "1" }, { evm: ev as any, solana: me }, { verify: { conn }, pollMs: 1 }); } catch (e) { sent = "ERR " + (e as Error).message; }
  check(sent === "BuiltSig1", "a built swap whose only extra SOL is Tollkit's fee is signed and sent", sent);
  simReply = { value: { err: null, accounts: [{ lamports: 2e9 - 1_560_000 - 30_000_000, owner: "11111111111111111111111111111111" }, { lamports: 1, data: tokData(4_000_000_000n) }, null, null] } };
  let refused = ""; try { await executeSwap({ ...built, buy_token: JUP, min_buy_amount: "1" }, { evm: ev as any, solana: me }, { verify: { conn }, pollMs: 1 }); } catch (e) { refused = (e as Error).message; }
  check(/more SOL than network fees/.test(refused), "anything taking more SOL than network fees plus Tollkit's fee is refused", refused);
  void simTx;
}

console.log(`\nfees: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
