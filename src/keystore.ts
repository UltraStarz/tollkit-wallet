/**
 * Keys live only on the user's machine, encrypted with their password.
 * EVM: the standard Ethereum JSON keystore (ethers v6, scrypt + AES-128-CTR).
 * Solana: the 64-byte secret key, scrypt-derived key + AES-256-GCM.
 * Tollkit never sees either key or the password.
 */
import { Keypair } from "@solana/web3.js";
import { Wallet, HDNodeWallet, encryptKeystoreJson } from "ethers";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { files, walletHome } from "./paths.js";

export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

export interface KeystoreFile {
  version: 1;
  created_at: string;
  evm_address: string;
  solana_address: string;
  evm: string; // Ethereum JSON keystore
  solana: { kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string };
}

export interface Keys { evm: Wallet | HDNodeWallet; solana: Keypair }

const scrypt = (pw: string, salt: Buffer, s: ScryptParams) =>
  new Promise<Buffer>((res, rej) =>
    scryptCb(pw, salt, 32, { N: s.N, r: s.r, p: s.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function sealSolana(secret: Uint8Array, pw: string, s: ScryptParams) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(pw, salt, s);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return { kdf: "scrypt" as const, ...s, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

async function openSolana(box: KeystoreFile["solana"], pw: string): Promise<Keypair> {
  const key = await scrypt(pw, Buffer.from(box.salt, "hex"), { N: box.N, r: box.r, p: box.p });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "hex"));
  d.setAuthTag(Buffer.from(box.tag, "hex"));
  let secret: Buffer;
  try { secret = Buffer.concat([d.update(Buffer.from(box.ct, "hex")), d.final()]); }
  catch { throw new Error("wrong password"); }
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

function checkPassword(pw: string) {
  if (typeof pw !== "string" || pw.length < 12) throw new Error("Use a password of at least 12 characters.");
}

/** Make a new wallet (or import keys). Refuses to overwrite an existing one. */
export async function createKeystore(password: string, opts: { dir?: string; evmPrivateKey?: string; solanaSecretKey?: Uint8Array; scrypt?: ScryptParams } = {}) {
  checkPassword(password);
  const f = files(walletHome(opts.dir));
  if (existsSync(f.keystore)) throw new Error(`A wallet already exists at ${f.keystore}. Back it up and remove it first if you want a new one.`);
  const s = opts.scrypt ?? DEFAULT_SCRYPT;
  const evm = opts.evmPrivateKey ? new Wallet(opts.evmPrivateKey) : Wallet.createRandom();
  const sol = opts.solanaSecretKey ? Keypair.fromSecretKey(opts.solanaSecretKey) : Keypair.generate();
  const evmJson = await encryptKeystoreJson({ address: evm.address, privateKey: evm.privateKey }, password, { scrypt: { N: s.N, r: s.r, p: s.p } });
  const ks: KeystoreFile = {
    version: 1,
    created_at: new Date().toISOString(),
    evm_address: evm.address,
    solana_address: sol.publicKey.toBase58(),
    evm: evmJson,
    solana: await sealSolana(sol.secretKey, password, s),
  };
  const tmp = f.keystore + ".tmp";
  writeFileSync(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
  renameSync(tmp, f.keystore);
  return { evm: ks.evm_address, solana: ks.solana_address };
}

export function readKeystore(dir?: string): KeystoreFile {
  const f = files(walletHome(dir));
  if (!existsSync(f.keystore)) throw new Error("No wallet yet. Run `tollkit-wallet init` first.");
  return JSON.parse(readFileSync(f.keystore, "utf8")) as KeystoreFile;
}

/** Public addresses only; no password needed. */
export function addresses(dir?: string) {
  const ks = readKeystore(dir);
  return { evm: ks.evm_address, solana: ks.solana_address };
}

/** Unlock both keys. Throws "wrong password" on a bad password. */
export async function unlock(password: string, dir?: string): Promise<Keys> {
  const ks = readKeystore(dir);
  let evm: Wallet | HDNodeWallet;
  try { evm = await Wallet.fromEncryptedJson(ks.evm, password); }
  catch { throw new Error("wrong password"); }
  const solana = await openSolana(ks.solana, password);
  if (evm.address !== ks.evm_address || solana.publicKey.toBase58() !== ks.solana_address) throw new Error("keystore addresses don't match its keys");
  return { evm, solana };
}
