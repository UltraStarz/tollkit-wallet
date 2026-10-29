/** 0.9.9: buy and cash-out requests sign the coin and amount (version 2), checked here against the signer's own key. */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { generateKeyPair, getAddressFromPublicKey, verifySignature, createKeyPairSignerFromBytes } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import { rampMessage, signRamp } from "../src/rampauth.js";
import { buyLink } from "../src/buy.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d === undefined ? "" : JSON.stringify(d)); } };
const evm = privateKeyToAccount(generatePrivateKey()), kp = Keypair.generate();
const keys: any = { evm: { signMessage: (m: string) => evm.signMessage({ message: m }) }, solana: { secretKey: kp.secretKey } };
const sol = kp.publicKey.toBase58();

const a = await signRamp(keys, "onramp", "base", evm.address, Date.now(), { asset: "USDC", amount: "50.00" });
const signer = await recoverMessageAddress({ message: rampMessage("onramp", "base", evm.address, a.ts, a.nonce, { asset: "USDC", amount: "50.00" }), signature: a.sig as `0x${string}` });
check(a.v === 2 && signer === evm.address, "Base: v2 signs network, address, coin and amount", a);
const other = await recoverMessageAddress({ message: rampMessage("onramp", "base", evm.address, a.ts, a.nonce, { asset: "USDC", amount: "500.00" }), signature: a.sig as `0x${string}` });
check(other !== evm.address, "a different amount doesn't match the signature");

const s = await signRamp(keys, "offramp", "solana", sol, Date.now(), { asset: "SOL", amount: "0.25" });
const pub = (await createKeyPairSignerFromBytes(kp.secretKey)).keyPair.publicKey;
check(s.v === 2 && await verifySignature(pub, Uint8Array.from(Buffer.from(s.sig, "base64")) as any, new TextEncoder().encode(rampMessage("offramp", "solana", sol, s.ts, s.nonce, { asset: "SOL", amount: "0.25" }))), "Solana: v2 Ed25519 signature over the same message");

// buyLink signs the amount exactly as the server reads it (to the cent).
let body: any = null, what: any = null;
const f = (async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ url: "https://pay.coinbase.com/buy?x=1" })); }) as any;
await buyLink({ evm: evm.address, solana: sol }, { chain: "base", asset: "USDC", amount_usd: 50 }, { fetch: f, sign: async (n, ad, w) => { what = w; return signRamp(keys, "onramp", n, ad, Date.now(), w); } });
check(what?.asset === "USDC" && what?.amount === "50.00" && body.v === 2 && body.amount_usd === 50, "Buy signs USDC and 50.00 and sends v: 2", { what, body });
void generateKeyPair; void getAddressFromPublicKey;
console.log(`\nrampauth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
