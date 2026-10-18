/** Arbitrum and Polygon next to Base, Ethereum and Solana: the network table and everything that reads it. No network calls. */
import { CHAINS, CHAIN_BY_ID, CHAIN_ENUM, CHAIN_INFO, DEFAULT_RPC, EVM_CHAINS, EVM_CHAIN_ID, NATIVE_EVM, STABLES, isEvmChain } from "../src/chains.js";
import { KNOWN } from "../src/tokens.js";
import { coinId } from "../src/holdings.js";
import { CCTP_DOMAIN, USDC, canMove } from "../src/bridge.js";
import { offerFromX402 } from "../src/pay.js";
import { parseStrategy } from "../src/parse.js";
import { PolicySchema, DEFAULT_POLICY } from "../src/policy.js";
import { BUY_ASSETS } from "../src/buy.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

// The table itself
check(CHAINS.length === 5 && [...CHAIN_ENUM].sort().join() === [...CHAINS].sort().join(), "five networks, the same in the list and the schema enum");
check(EVM_CHAINS.every((c) => CHAIN_BY_ID[EVM_CHAIN_ID[c]] === c) && new Set(Object.values(EVM_CHAIN_ID)).size === EVM_CHAINS.length, "chain ids are unique and map back");
check(EVM_CHAIN_ID.arbitrum === 42161 && EVM_CHAIN_ID.polygon === 137, "Arbitrum One is 42161, Polygon PoS is 137");
check(CHAINS.every((c) => CHAIN_INFO[c] && DEFAULT_RPC[c]?.startsWith("https://") && STABLES[c]), "every network has a name, an RPC and its stablecoins");
check(isEvmChain("polygon") && isEvmChain("arbitrum") && !isEvmChain("solana"), "Arbitrum and Polygon use the EVM address and keys");
check(CHAIN_INFO.polygon.native === "POL" && CHAIN_INFO.arbitrum.native === "ETH", "native coins: POL on Polygon, ETH on Arbitrum");

// Native USDC only, the same address in every table
const usdcArb = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", usdcPol = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
check(KNOWN.arbitrum.USDC!.address === usdcArb && USDC.arbitrum === usdcArb && STABLES.arbitrum[usdcArb.toLowerCase()]?.symbol === "USDC", "Arbitrum USDC: Circle's native token everywhere");
check(KNOWN.polygon.USDC!.address === usdcPol && USDC.polygon === usdcPol && STABLES.polygon[usdcPol.toLowerCase()]?.symbol === "USDC", "Polygon USDC: Circle's native token everywhere");
check(!STABLES.polygon["0x2791bca1f2de4661ed88a30c99a7a9449aa84174"], "bridged USDC.e on Polygon isn't treated as USDC");
check(KNOWN.polygon.POL?.address === NATIVE_EVM && !KNOWN.polygon.ETH, "on Polygon the native coin is POL, not ETH");

// Prices
check(coinId("polygon", NATIVE_EVM) === "coingecko:polygon-ecosystem-token" && coinId("arbitrum", NATIVE_EVM) === "coingecko:ethereum", "native coin prices: POL and ETH");
check(coinId("arbitrum", usdcArb) === `arbitrum:${usdcArb}` && coinId("polygon", usdcPol) === `polygon:${usdcPol}`, "token prices use DefiLlama's arbitrum: and polygon: keys");

// Moving USDC (Circle CCTP domains 3 and 7); ETH moves stay Base <-> Ethereum
check(CCTP_DOMAIN.arbitrum === 3 && CCTP_DOMAIN.polygon === 7, "CCTP domains: Arbitrum 3, Polygon 7");
check(canMove("USDC", "base", "polygon") && canMove("USDC", "arbitrum", "solana") && canMove("USDC", "polygon", "arbitrum"), "USDC moves to and from Arbitrum and Polygon");
check(!canMove("ETH", "base", "arbitrum") && !canMove("ETH", "arbitrum", "ethereum") && canMove("ETH", "base", "ethereum"), "ETH moves: Base <-> Ethereum only");

// Paying for tools with x402
const o1 = offerFromX402({ network: "eip155:42161", asset: usdcArb, amount: "10000", payTo: "0x000000000000000000000000000000000000dEaD" }, "https://api.example.com/x");
check(o1.chain === "arbitrum" && Math.abs(o1.usd - 0.01) < 1e-9, "an x402 offer on eip155:42161 is Arbitrum USDC, priced at $0.01", o1);
const o2 = offerFromX402({ network: "polygon" as any, asset: usdcPol, amount: "20000", payTo: "0x000000000000000000000000000000000000dEaD" }, "https://api.example.com/x");
check(o2.chain === "polygon" && Math.abs(o2.usd - 0.02) < 1e-9, "x402 v1 \"polygon\" is Polygon USDC", o2);

// Rules in plain English
const px = (t: string) => (t.toUpperCase() === "POL" ? 0.1 : t.toUpperCase() === "ETH" ? 3000 : undefined);
const r1 = parseStrategy("buy $10 of POL every Monday", px);
check(r1.rules[0]?.chain === "polygon" && /pol/i.test(String(r1.rules[0]?.token)), "\"buy $10 of POL\" is a Polygon rule", r1);
const r2 = parseStrategy("buy $50 of ETH on arbitrum every Friday", px);
check(r2.rules[0]?.chain === "arbitrum", "\"on arbitrum\" picks Arbitrum", r2);

// Settings
check(PolicySchema.safeParse({ ...DEFAULT_POLICY, chains: ["base", "arbitrum", "polygon"] }).success, "Arbitrum and Polygon can be turned on in the limits");
check(!DEFAULT_POLICY.chains.includes("arbitrum") && !DEFAULT_POLICY.chains.includes("polygon"), "new wallets start with them off, like Ethereum");
check(!BUY_ASSETS.arbitrum && !BUY_ASSETS.polygon, "Coinbase buy isn't offered on Arbitrum or Polygon until its network names are confirmed");

console.log(`\nnetworks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
