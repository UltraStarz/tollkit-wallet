/** Chains, tokens and the fixed addresses the wallet trusts. */
export type Chain = "base" | "ethereum" | "solana";
export const EVM_CHAIN_ID: Record<Exclude<Chain, "solana">, number> = { ethereum: 1, base: 8453 };

/** 0x AllowanceHolder (Cancun chains incl. Ethereum and Base). The only contract we ever approve. docs.0x.org cheat sheet. */
export const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

export const DEFAULT_RPC: Record<Chain, string> = {
  base: "https://mainnet.base.org",
  ethereum: "https://ethereum-rpc.publicnode.com",
  solana: "https://api.mainnet-beta.solana.com",
};

/** Dollar stablecoins, valued at $1 for budgets. */
export const STABLES: Record<Chain, Record<string, { symbol: string; decimals: number }>> = {
  base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 } },
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  },
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
  },
};

export const NATIVE_EVM = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const WSOL = "So11111111111111111111111111111111111111112";

export const isStable = (chain: Chain, token: string) =>
  chain === "solana" ? token in STABLES.solana : token.toLowerCase() in STABLES[chain];

/** Tollkit's fee on swaps: flat, the same everywhere, shown before every trade. */
export const SWAP_FEE_BPS = 50;
