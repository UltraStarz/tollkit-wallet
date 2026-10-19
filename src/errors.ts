/**
 * Short, plain error text for people. Library errors (ethers, viem, Solana RPC) carry the raw transaction, RPC
 * payloads and version strings; the app shows them on cards, in Activity and in the AI chat, where they overflow
 * and mean nothing to most owners. The full text still goes to logs where it's useful for debugging.
 */
const NATIVE: Record<string, string> = { base: "ETH", ethereum: "ETH", arbitrum: "ETH", polygon: "POL", solana: "SOL" };
const NAME: Record<string, string> = { base: "Base", ethereum: "Ethereum", arbitrum: "Arbitrum", polygon: "Polygon", solana: "Solana" };

export function plainError(e: unknown, chain?: string): string {
  const raw = String((e as any)?.shortMessage ?? (e as any)?.message ?? e ?? "");
  const gas = chain ? `${NATIVE[chain] ?? "gas"}${NAME[chain] ? ` on ${NAME[chain]}` : ""}` : "gas money";
  if (/INSUFFICIENT_FUNDS|insufficient funds for (intrinsic transaction cost|gas)|gas \* price \+ value/i.test(raw)) return `Not enough ${gas} to pay the network fee.`;
  if (/insufficient lamports|no record of a prior credit|AccountNotFound/i.test(raw)) return "Not enough SOL to pay the network fee.";
  if (/nonce (too low|has already been used)|replacement (transaction )?underpriced|already known/i.test(raw)) return "The network was busy with another transaction from this wallet. Try again in a moment.";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|network error/i.test(raw)) return "The network didn't answer in time. Try again in a moment.";
  const rev = /reverted(?: with reason string)?:? "([^"]{1,120})"/i.exec(raw);
  if (rev) return `The transaction would fail: ${rev[1]}.`;
  if (/execution reverted|CALL_EXCEPTION/i.test(raw)) return "The network rejected this transaction.";
  // Anything else: drop the ethers/viem detail that follows the first sentence, and keep it short.
  // Our own messages (limits, refusals) are already plain and pass through untouched.
  const lib = / \((?:transaction|action|info|code|data|request|reason)=| Request Arguments:| Details:| Version: |\n/;
  let s = raw.split(lib)[0]!.trim();
  const cap = lib.test(raw) ? 160 : 400;
  if (s.length > cap) s = s.slice(0, cap - 3).trimEnd() + "…";
  return s || "Something went wrong.";
}
