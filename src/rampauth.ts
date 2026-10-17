/**
 * Signed buy and cash-out requests. Tollkit's server only asks Coinbase for an Onramp or Offramp session when the
 * request is signed by the key of the address the crypto goes to (or comes from), within the last 5 minutes, with a
 * random nonce that hasn't been used before. So nobody can use Tollkit's Coinbase access for an address they don't
 * control, and a captured request can't be replayed.
 *
 *   Base / Ethereum: an EIP-191 personal message signature (hex), checked by recovering the signer's address.
 *   Solana: an Ed25519 signature over the message bytes (base64), checked against the address's public key.
 *
 * The server builds the same message (x402-starter src/rampauth.ts); keep the two in step.
 */
import { createKeyPairSignerFromBytes, signBytes } from "@solana/kit";
import type { Chain } from "./chains.js";
import type { Keys } from "./keystore.js";

export type RampKind = "onramp" | "offramp";
export interface RampAuth { ts: number; nonce: string; sig: string }

export function rampMessage(kind: RampKind, network: string, address: string, ts: number, nonce: string): string {
  return `Tollkit ${kind} request\nnetwork: ${network}\naddress: ${address}\ntime: ${ts}\nnonce: ${nonce}`;
}

const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

export async function signRamp(keys: Pick<Keys, "evm" | "solana">, kind: RampKind, network: Chain, address: string, now = Date.now()): Promise<RampAuth> {
  const ts = Math.floor(now / 1000);
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const msg = rampMessage(kind, network, address, ts, nonce);
  if (network === "solana") {
    const signer = await createKeyPairSignerFromBytes(keys.solana.secretKey);
    const sig = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(msg));
    return { ts, nonce, sig: b64(new Uint8Array(sig)) };
  }
  return { ts, nonce, sig: await keys.evm.signMessage(msg) };
}
