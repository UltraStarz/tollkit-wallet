/**
 * Owner withdrawals: send native coin or a known stablecoin to an address.
 * Only reachable with the password (CLI / dashboard), never through the
 * agent tools. Recipients are screened against the OFAC list.
 */
import { Connection, PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import { sendAndConfirm } from "./solconfirm.js";
import { Contract, JsonRpcProvider, getAddress, isAddress, type HDNodeWallet, type Wallet } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, NATIVE_EVM, WSOL, type Chain } from "./chains.js";
import type { Token } from "./tokens.js";

export interface SendRequest { chain: Chain; token: Token; to: string; amount: string /* atomic */ }

/** Normalise and validate the destination. Throws a plain-language error. */
export function checkDestination(chain: Chain, to: string): string {
  const t = to.trim();
  if (chain === "solana") {
    try { const pk = new PublicKey(t); if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error("off-curve"); return pk.toBase58(); }
    catch { throw new Error(`${t} isn't a regular Solana wallet address.`); }
  }
  if (!isAddress(t)) throw new Error(`${t} isn't a valid ${chain} address.`);
  return getAddress(t.toLowerCase());
}

export async function sendTokens(r: SendRequest, keys: { evm: Wallet | HDNodeWallet; solana: Keypair }, rpc?: string): Promise<string> {
  if (r.chain === "solana") {
    const conn = new Connection(rpc ?? DEFAULT_RPC.solana, "confirmed");
    const from = keys.solana.publicKey, to = new PublicKey(r.to);
    const tx = new Transaction();
    if (r.token.address === WSOL) {
      tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(r.amount) }));
    } else {
      // Loaded only here: @solana/spl-token prints a native-bindings warning on import.
      const { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const mint = new PublicKey(r.token.address);
      const src = getAssociatedTokenAddressSync(mint, from);
      const dst = getAssociatedTokenAddressSync(mint, to);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mint)); // we pay the recipient's account rent if it's new
      tx.add(createTransferCheckedInstruction(src, mint, dst, from, BigInt(r.amount), r.token.decimals));
    }
    return sendAndConfirm(conn, tx, [keys.solana]);
  }
  const p = new JsonRpcProvider(rpc ?? DEFAULT_RPC[r.chain], EVM_CHAIN_ID[r.chain], { staticNetwork: true });
  const signer = keys.evm.connect(p);
  const sent = r.token.address === NATIVE_EVM
    ? await signer.sendTransaction({ to: r.to, value: BigInt(r.amount) })
    : await (new Contract(r.token.address, ["function transfer(address to, uint256 amount) returns (bool)"], signer) as any).transfer(r.to, BigInt(r.amount));
  const rc = await sent.wait();
  if (!rc || rc.status !== 1) throw new Error(`transfer ${sent.hash} reverted`);
  return sent.hash;
}

/** Current balance of a token (atomic units), to refuse a withdrawal the wallet can't cover before signing anything. */
export async function balanceAtomic(chain: Chain, token: Token, owner: string, rpc?: string): Promise<bigint> {
  if (chain === "solana") {
    const conn = new Connection(rpc ?? DEFAULT_RPC.solana, "confirmed");
    const pk = new PublicKey(owner);
    if (token.address === WSOL) return BigInt(await conn.getBalance(pk, "confirmed"));
    const accts = await conn.getParsedTokenAccountsByOwner(pk, { mint: new PublicKey(token.address) }, "confirmed");
    return accts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  const p = new JsonRpcProvider(rpc ?? DEFAULT_RPC[chain], EVM_CHAIN_ID[chain], { staticNetwork: true });
  if (token.address === NATIVE_EVM) return p.getBalance(owner);
  return (new Contract(token.address, ["function balanceOf(address) view returns (uint256)"], p) as any).balanceOf(owner);
}
