/**
 * Token names and human amounts. Agents and people say "10 USDC" or "0.01 ETH";
 * the swap APIs want addresses and atomic units. Known tokens below were
 * checked on-chain (symbol() via public RPC, 2026-10-13); anything else is
 * passed as an address and its decimals are read from the chain.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Contract, JsonRpcProvider, parseUnits } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, NATIVE_EVM, WSOL, type Chain } from "./chains.js";

export interface Token { address: string; symbol: string; decimals: number }

export const KNOWN: Record<Chain, Record<string, Token>> = {
  base: {
    ETH: { address: NATIVE_EVM, symbol: "ETH", decimals: 18 },
    WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  },
  ethereum: {
    ETH: { address: NATIVE_EVM, symbol: "ETH", decimals: 18 },
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
  },
  solana: {
    SOL: { address: WSOL, symbol: "SOL", decimals: 9 },
    USDC: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
    USDT: { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
  },
};

const isEvmAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isSolAddr = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Symbol or address -> token with decimals. */
export async function resolveToken(chain: Chain, token: string, rpc?: string): Promise<Token> {
  const t = token.trim();
  const known = KNOWN[chain][t.toUpperCase()] ?? Object.values(KNOWN[chain]).find((k) => k.address.toLowerCase() === t.toLowerCase());
  if (known) return known;
  if (chain === "solana") {
    if (!isSolAddr(t)) throw new Error(`"${t}" isn't a known token on Solana or a mint address.`);
    const info = await new Connection(rpc ?? DEFAULT_RPC.solana, "confirmed").getParsedAccountInfo(new PublicKey(t));
    const d = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof d !== "number") throw new Error(`${t} isn't a token mint on Solana.`);
    return { address: t, symbol: t.slice(0, 4) + "…", decimals: d };
  }
  if (!isEvmAddr(t)) throw new Error(`"${t}" isn't a known token on ${chain} or a contract address.`);
  const p = new JsonRpcProvider(rpc ?? DEFAULT_RPC[chain], EVM_CHAIN_ID[chain], { staticNetwork: true });
  const c = new Contract(t, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], p);
  const [d, s] = await Promise.all([c.decimals!(), c.symbol!().catch(() => t.slice(0, 6))]);
  return { address: t, symbol: String(s), decimals: Number(d) };
}

/** "10.5" with 6 decimals -> "10500000". Refuses more precision than the token has. */
export function toAtomic(amount: string | number, decimals: number): string {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`"${s}" isn't a plain positive number.`);
  const v = parseUnits(s, decimals);
  if (v <= 0n) throw new Error("Amount must be more than zero.");
  return v.toString();
}
