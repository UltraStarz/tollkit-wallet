/** 0.2.3: the wallet checks what the quote server asks it to sign. No network. */
import { AbiCoder, Interface, Wallet } from "ethers";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkZeroExTx, executeSwap, verifySwapTx, vetQuote, type SwapQuote } from "../src/swap.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ALLOWANCE_HOLDER } from "../src/chains.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const err = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

const me = Wallet.createRandom(), sol = Keypair.generate();
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// Seen live on Base, 2026-10-14: 0x quoted through the previous Settler while ownerOf(2) already named the next one.
const SETTLER = "0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059", CURRENT = "0x7d6839415693801e94cdc4a7d732c9a3fdbbd1d7";
const AH = new Interface(["function exec(address operator, address token, uint256 amount, address target, bytes data)"]);
const exec = (o: { token?: string; amount?: bigint; to?: string; buy?: string; min?: bigint; settler?: string } = {}) => AH.encodeFunctionData("exec", [o.settler ?? SETTLER, o.token ?? USDC, o.amount ?? 10_000_000n, o.settler ?? SETTLER,
  "0x1fff991f" + AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256"], [o.to ?? me.address, o.buy ?? ETH, o.min ?? 3980000000000000n]).slice(2) + "00".repeat(96)]);
const q = (tx: Record<string, unknown> = {}, over: Partial<SwapQuote> = {}): SwapQuote => ({ chain: "base", venue: "0x", sell_token: USDC, buy_token: ETH, sell_amount: "10000000", buy_amount: "4000000000000000", min_buy_amount: "3980000000000000", fee_bps: 50, venue_fee_bps: 0, usd_value: 10, fee_usd: 0.05, raw: { transaction: { to: ALLOWANCE_HOLDER, data: exec(), value: "0", ...tx } }, ...over });
const word = (a: string) => AbiCoder.defaultAbiCoder().encode(["address"], [a]);
const evmCall = async (_c: string, to: string, data: string) => { if (to.toLowerCase() !== "0x00000000000004533fe15556b1e086bb1a72ceae") throw new Error("?"); return data.startsWith("0x6352211e") ? word(CURRENT) : word(SETTLER); };
const v = (x: SwapQuote) => err(() => verifySwapTx(x, { evm: me.address, solana: sol.publicKey }, { evmCall }));

check(checkZeroExTx(q(), me.address).toLowerCase() === SETTLER.toLowerCase() && !(await v(q())), "a normal 0x quote passes (Settler found via the registry's prev())");
check(/different amount of ETH/.test(await v(q({ value: "50000000000000000000" }))), "a quote that also sends ETH is refused");
check(/someone other than this wallet/.test(await v(q({ data: exec({ to: "0x000000000000000000000000000000000000dEaD" }) }))), "a quote that pays another address is refused");
check(/different coin or amount/.test(await v(q({ data: exec({ amount: 20_000_000n }) }))), "a quote that takes more than the amount sold is refused");
check(/minimum doesn't match/.test(await v(q({ data: exec({ min: 1n }) }))), "a quote with a lower on-chain minimum than shown is refused");
check(/different coin/.test(await v(q({ data: exec({ buy: USDC }) }))), "a quote that buys a different coin is refused");
check(/registry doesn't list/.test(await v(q({ data: exec({ settler: "0x000000000000000000000000000000000000bEEF" }) }))), "a contract 0x's registry doesn't list is refused");
check(/isn.t a 0x swap/.test(await v(q({ data: "0x12345678" }))) && /different coin or amount/.test(await v(q({ data: "0x2213bc0b" + "00".repeat(160) }))), "other calls and zeroed calldata are refused");
const ethSell = q({ value: "10000000", data: exec({ token: "0x0000000000000000000000000000000000000000", buy: USDC, min: 1n }) }, { sell_token: ETH, buy_token: USDC, min_buy_amount: "1" });
check(!(await v(ethSell)), "selling ETH: value equal to the amount sold is fine");
check(/isn't sent to 0x AllowanceHolder/.test(await err(() => executeSwap(q({ to: "0x000000000000000000000000000000000000dEaD" }), { evm: me, solana: sol }, { verify: { evmCall } }))), "executeSwap checks before it signs anything");

// Solana
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", WSOL = "So11111111111111111111111111111111111111112";
const acct = Keypair.generate().publicKey;
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const tx = (payer = sol.publicKey, prog = JUP, extra: PublicKey[] = []) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [{ programId: prog, keys: [...extra, acct].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.from([1]) }] }).compileToV0Message()).serialize()).toString("base64");
const tokData = (amt: bigint, owner = sol.publicKey, delegate?: PublicKey) => { const b = Buffer.alloc(165); owner.toBuffer().copy(b, 32); b.writeBigUInt64LE(amt, 64); if (delegate) { b.writeUInt32LE(1, 72); delegate.toBuffer().copy(b, 76); } return [b.toString("base64"), "base64"]; };
let simReply: any = null;
const conn: any = {
  getBalance: async () => 2e9,
  getParsedTokenAccountsByOwner: async (_o: any, f: any) => ({ value: f.programId.toBase58().startsWith("Tokenkeg") ? [{ pubkey: acct, account: { data: { parsed: { info: { mint: USDC_SOL, tokenAmount: { amount: "50000000", decimals: 6 } } } } } }] : [] }),
  simulateTransaction: async () => simReply,
};
const sq = (over: Partial<SwapQuote> = {}): SwapQuote => ({ chain: "solana", venue: "jupiter", sell_token: USDC_SOL, buy_token: WSOL, sell_amount: "10000000", buy_amount: "60000000", min_buy_amount: "59700000", fee_bps: 50, venue_fee_bps: 0, usd_value: 10, fee_usd: 0.05, raw: { transaction: tx(), requestId: "r1" }, ...over });
const sim = (lamports: number, data: unknown) => ({ value: { err: null, accounts: [{ lamports, owner: "11111111111111111111111111111111" }, { lamports: 1, data }] } });
const sv = (x: SwapQuote) => err(() => verifySwapTx(x, { evm: me.address, solana: sol.publicKey }, { conn }));
simReply = sim(2e9 + 59_000_000, tokData(40_000_000n));
check(!(await sv(sq())), "Solana: sells 10 USDC, gets SOL: passes");
simReply = sim(1e9, tokData(40_000_000n));
check(/more SOL|pays less than the minimum/.test(await sv(sq())), "Solana: a transaction that also takes SOL is refused");
simReply = sim(2e9 + 59_000_000, tokData(0n));
check(/coin you aren't selling/.test(await sv(sq())), "Solana: taking more USDC than sold is refused");
simReply = sim(2e9 + 59_000_000, tokData(40_000_000n, Keypair.generate().publicKey));
check(/token accounts to someone else/.test(await sv(sq())), "Solana: changing who owns a token account is refused");
simReply = sim(2e9 + 59_000_000, tokData(40_000_000n, sol.publicKey, Keypair.generate().publicKey));
check(/spend your tokens later/.test(await sv(sq())), "Solana: a hidden token approval is refused");
simReply = { value: { err: { InstructionError: [0, "Custom"] }, accounts: null } };
check(/Couldn't check this swap/.test(await sv(sq())), "Solana: if it can't be simulated, it isn't signed");
check(/isn't for this wallet/.test(await sv(sq({ raw: { transaction: tx(Keypair.generate().publicKey), requestId: "r1" } }))), "Solana: a transaction this wallet doesn't sign is refused");
simReply = sim(2e9 + 59_000_000, tokData(40_000_000n));
check(/program Tollkit doesn't sign for/.test(await sv(sq({ raw: { transaction: tx(sol.publicKey, Keypair.generate().publicKey), requestId: "r1" } }))), "Solana: a route through a program outside Jupiter's router is refused");
check(/program Tollkit doesn't sign for/.test(await sv(sq({ raw: { transaction: tx(sol.publicKey, new PublicKey("Stake11111111111111111111111111111111111111")), requestId: "r1" } }))), "Solana: a stake instruction inside a swap is refused");
check(vetQuote(sq({ sell_amount: "5000000000" }), { chain: "solana", sell_token: USDC_SOL, buy_token: WSOL, sell_amount: "10000000", slippage_bps: 50 }) !== null, "a quote for more than the amount asked is refused (both venues)");
simReply = sim(2e9 - 5000, tokData(40_000_000n));
check(/pays less than the minimum/.test(await sv(sq())), "Solana: selling USDC for SOL with no SOL paid out is refused");
// Buying a token the wallet doesn't hold yet: the new account is read too
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const bonkAta = getAssociatedTokenAddressSync(new PublicKey(BONK), sol.publicKey);
const bonkData = (amt: bigint) => { const b = Buffer.alloc(165); new PublicKey(BONK).toBuffer().copy(b, 0); sol.publicKey.toBuffer().copy(b, 32); b.writeBigUInt64LE(amt, 64); return [b.toString("base64"), "base64"]; };
const bq = sq({ buy_token: BONK, min_buy_amount: "1000" });
simReply = { value: { err: null, accounts: [{ lamports: 2e9 - 2_100_000, owner: "11111111111111111111111111111111" }, { lamports: 1, data: tokData(40_000_000n) }, { lamports: 2039280, data: bonkData(1500n) }, null] } };
check(!(await sv(bq)), "Solana: buying a new token: its new account (same address spl-token computes) gets at least the minimum");
simReply = { value: { err: null, accounts: [{ lamports: 2e9 - 2_100_000, owner: "11111111111111111111111111111111" }, { lamports: 1, data: tokData(40_000_000n) }, null, null] } };
check(/pays less than the minimum/.test(await sv(bq)), "Solana: buying a token that never arrives is refused");
void bonkAta;
simReply = sim(2e9 + 59_000_000, tokData(40_000_000n, sol.publicKey));
const closeData = () => { const d = tokData(40_000_000n) as string[]; const b = Buffer.from(d[0]!, "base64"); b.writeUInt32LE(1, 129); Keypair.generate().publicKey.toBuffer().copy(b, 133); return [b.toString("base64"), "base64"]; };
simReply = sim(2e9 + 59_000_000, closeData());
check(/close one of your token accounts/.test(await sv(sq())), "Solana: handing over a token account's close authority is refused");
// 70 accounts the wallet holds, all writable: every one is checked, not just the first 60
const spam = Array.from({ length: 70 }, () => Keypair.generate().publicKey);
const conn2: any = { ...conn, getParsedTokenAccountsByOwner: async (_o: any, f: any) => ({ value: f.programId.toBase58().startsWith("Tokenkeg") ? [...spam, acct].map((pubkey, i) => ({ pubkey, account: { data: { parsed: { info: { mint: i < 70 ? Keypair.generate().publicKey.toBase58() : USDC_SOL, tokenAmount: { amount: "50000000", decimals: 6 } } } } } })) : [] }), simulateTransaction: async (_t: any, o: any) => ({ value: { err: null, accounts: o.accounts.addresses.map((_a: string, i: number) => i === 0 ? { lamports: 2e9 + 59_000_000, owner: "11111111111111111111111111111111" } : i === 71 ? { lamports: 1, data: tokData(0n) } : { lamports: 1, data: tokData(50_000_000n) }) } }) };
const lut = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: spam } });
const lutTx = Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: sol.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [{ programId: JUP, keys: [...spam, acct].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.from([1]) }] }).compileToV0Message([lut])).serialize()).toString("base64");
conn2.getAddressLookupTable = async () => ({ value: lut });
check(/coin you aren't selling/.test(await err(() => verifySwapTx(sq({ raw: { transaction: lutTx, requestId: "r1" } }), { evm: me.address, solana: sol.publicKey }, { conn: conn2 }))), "Solana: a drain hidden behind 70 other token accounts (via a lookup table) is still caught");

console.log(`\nswapcheck: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
