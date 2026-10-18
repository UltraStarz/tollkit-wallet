/** Chains, tokens and the fixed addresses the wallet trusts. */
export type EvmChain = "base" | "ethereum" | "arbitrum" | "polygon";
export type Chain = EvmChain | "solana";
/** Every network the wallet knows, in the order screens list them. */
export const CHAINS: Chain[] = ["base", "solana", "ethereum", "arbitrum", "polygon"];
export const EVM_CHAINS: EvmChain[] = ["base", "ethereum", "arbitrum", "polygon"];
/** For schemas (zod enums need a literal tuple). */
export const CHAIN_ENUM = ["base", "ethereum", "arbitrum", "polygon", "solana"] as const satisfies readonly Chain[];
export const isEvmChain = (c: string): c is EvmChain => (EVM_CHAINS as string[]).includes(c);
export const EVM_CHAIN_ID: Record<EvmChain, number> = { ethereum: 1, base: 8453, arbitrum: 42161, polygon: 137 };
export const CHAIN_BY_ID: Record<number, EvmChain> = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 137: "polygon" };

/**
 * What screens and messages need about each network. Native coins: ETH on Base, Ethereum and Arbitrum,
 * POL on Polygon (docs.polygon.technology/pos/concepts/tokens/matic-to-pol), SOL on Solana.
 * Explorers from each chain's docs (docs.arbitrum.io chain-info, docs.polygon.technology rpc-endpoints).
 */
export const CHAIN_INFO: Record<Chain, { name: string; native: string; nativeDecimals: number; explorerTx: string; coingecko: string }> = {
  base: { name: "Base", native: "ETH", nativeDecimals: 18, explorerTx: "https://basescan.org/tx/", coingecko: "ethereum" },
  ethereum: { name: "Ethereum", native: "ETH", nativeDecimals: 18, explorerTx: "https://etherscan.io/tx/", coingecko: "ethereum" },
  arbitrum: { name: "Arbitrum", native: "ETH", nativeDecimals: 18, explorerTx: "https://arbiscan.io/tx/", coingecko: "ethereum" },
  polygon: { name: "Polygon", native: "POL", nativeDecimals: 18, explorerTx: "https://polygonscan.com/tx/", coingecko: "polygon-ecosystem-token" },
  solana: { name: "Solana", native: "SOL", nativeDecimals: 9, explorerTx: "https://solscan.io/tx/", coingecko: "solana" },
};
export const chainName = (c: Chain) => CHAIN_INFO[c]?.name ?? c;

/** 0x AllowanceHolder (Cancun chains incl. Ethereum, Base, Arbitrum and Polygon). The only contract we ever approve. docs.0x.org cheat sheet. */
export const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

/** Public RPCs. Arbitrum: the Arbitrum Foundation's endpoint (docs.arbitrum.io node-providers); Polygon: listed in docs.polygon.technology. */
export const DEFAULT_RPC: Record<Chain, string> = {
  base: "https://mainnet.base.org",
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  polygon: "https://polygon.drpc.org",
  solana: "https://api.mainnet-beta.solana.com",
};

/** Dollar stablecoins, valued at $1 for budgets. Native USDC only (Circle's addresses, developers.circle.com), never bridged USDC.e. */
export const STABLES: Record<Chain, Record<string, { symbol: string; decimals: number }>> = {
  base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 } },
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  },
  arbitrum: { "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 } },
  polygon: { "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 } },
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
