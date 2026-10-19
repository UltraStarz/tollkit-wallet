/** Errors shown to people are short and plain; library detail (raw transactions, RPC payloads) is dropped. */
import { plainError } from "../src/errors.js";
let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
// The exact message the iPhone showed on a grid bot (2026-10-19), from ethers 6.17.
const seen = 'insufficient funds for intrinsic transaction cost (transaction="0x02f8af82210580830f424083a7d8c082db68948300", info={ "error": { "code": -32003, "message": "insufficient funds for gas * price + value: have 0 want 617848000000" } }, code=INSUFFICIENT_FUNDS, version=6.17.0)';
check(plainError(new Error(seen), "base") === "Not enough ETH on Base to pay the network fee.", "the iPhone's long gas error becomes one short line", plainError(new Error(seen), "base"));
check(plainError(seen, "polygon") === "Not enough POL on Polygon to pay the network fee.", "it names the right coin per network");
check(plainError(new Error("Transaction simulation failed: Attempt to debit an account but found no record of a prior credit."), "solana") === "Not enough SOL to pay the network fee.", "Solana's empty-account error too");
check(plainError(new Error('execution reverted: "BuyAmountTooLow" (action="estimateGas", data="0x…")'), "base").startsWith("The transaction would fail: BuyAmountTooLow"), "a revert keeps its reason and drops the payload");
check(plainError(new Error("nonce too low (code=NONCE_EXPIRED, version=6.17.0)"), "base") === "The network was busy with another transaction from this wallet. Try again in a moment.", "nonce clashes read as busy");
const ours = "On this pair Tollkit's 0.5% fee is paid in SOL (0.0021 SOL), and the wallet doesn't have enough SOL for that plus the network fee. Add a little SOL and try again.";
check(plainError(ours, "solana") === ours, "the wallet's own plain refusals pass through unchanged");
const odd = "Something odd (code=WEIRD, version=6.17.0)" + "x".repeat(300);
check(plainError(new Error(odd)) === "Something odd", "unknown library errors keep just their first part", plainError(new Error(odd)));
check(plainError(new Error("")) === "Something went wrong.", "an empty error still says something");
console.log(`\nerrors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
