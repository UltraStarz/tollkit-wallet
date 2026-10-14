/**
 * Keys live only on the user's machine, encrypted with their password.
 * EVM: the standard Ethereum JSON keystore (ethers v6, scrypt + AES-128-CTR).
 * Solana: the 64-byte secret key, scrypt-derived key + AES-256-GCM.
 * Tollkit never sees either key or the password.
 *
 * New wallets come from a 12-word BIP-39 recovery phrase, derived the way
 * MetaMask and Phantom do it, so the same phrase restores the same addresses
 * there too (checked 2026-10-14):
 *   EVM    m/44'/60'/0'/0/0  (MetaMask: "default BIP-44 derivation path (m/44'/60'/0'/0)";
 *                             Phantom default bip44Change "m/44'/60'/0'/0/${index}")
 *   Solana m/44'/501'/0'/0'  (Phantom default bip44Change "m/44'/501'/${index}'/0'"),
 *          ed25519 via SLIP-0010 (hardened only).
 * The phrase is kept encrypted like the keys so the owner can view it again with the password.
 */
import { Keypair } from "@solana/web3.js";
import { Wallet, HDNodeWallet, Mnemonic, encryptKeystoreJson, computeHmac, getBytes, concat, toBeArray, zeroPadValue, encodeBase58, randomBytes as ethersRandom } from "ethers";

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { files, walletHome } from "./paths.js";
import path from "node:path";

export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

export interface KeystoreFile {
  version: 1;
  created_at: string;
  evm_address: string;
  solana_address: string;
  evm: string; // Ethereum JSON keystore
  solana: Sealed;
  /** The recovery phrase, sealed like the Solana key. Absent on wallets made before 0.2.2 (keys only). */
  phrase?: Sealed;
}
type Sealed = { kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string };

export const EVM_PATH = "m/44'/60'/0'/0/0";
export const SOLANA_PATH = "m/44'/501'/0'/0'";

/** SLIP-0010 ed25519 private key for a hardened-only path, from a BIP-39 seed. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  if (!/^m(\/\d+')*$/.test(path)) throw new Error("ed25519 paths must be fully hardened, e.g. m/44'/501'/0'/0'");
  let I = getBytes(computeHmac("sha512", new TextEncoder().encode("ed25519 seed"), seed));
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const seg of path.split("/").slice(1)) {
    const index = (Number(seg.slice(0, -1)) + 0x80000000) >>> 0;
    const data = concat([new Uint8Array([0]), key, zeroPadValue(toBeArray(index), 4)]);
    I = getBytes(computeHmac("sha512", chain, data));
    key = I.slice(0, 32); chain = I.slice(32);
  }
  return key;
}

/** Both keys from a recovery phrase. Throws on an invalid phrase. */
export function keysFromPhrase(phrase: string): { evm: HDNodeWallet; solana: Keypair; phrase: string } {
  const clean = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  let m: Mnemonic;
  try { m = Mnemonic.fromPhrase(clean); } catch { throw new Error("That recovery phrase isn't valid. Check the words and their order."); }
  const evm = HDNodeWallet.fromMnemonic(m, EVM_PATH);
  const solana = Keypair.fromSeed(slip10Ed25519(getBytes(m.computeSeed()), SOLANA_PATH));
  return { evm, solana, phrase: m.phrase };
}

export function newPhrase(): string { return Mnemonic.fromEntropy(ethersRandom(16)).phrase; }

export interface Keys { evm: Wallet | HDNodeWallet; solana: Keypair }

const scrypt = (pw: string, salt: Buffer, s: ScryptParams) =>
  new Promise<Buffer>((res, rej) =>
    scryptCb(pw, salt, 32, { N: s.N, r: s.r, p: s.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function seal(secret: Uint8Array, pw: string, s: ScryptParams): Promise<Sealed> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(pw, salt, s);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return { kdf: "scrypt" as const, ...s, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

async function openSealed(box: Sealed, pw: string): Promise<Buffer> {
  const key = await scrypt(pw, Buffer.from(box.salt, "hex"), { N: box.N, r: box.r, p: box.p });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "hex"));
  d.setAuthTag(Buffer.from(box.tag, "hex"));
  let secret: Buffer;
  try { secret = Buffer.concat([d.update(Buffer.from(box.ct, "hex")), d.final()]); }
  catch { throw new Error("wrong password"); }
  return secret;
}
const openSolana = async (box: Sealed, pw: string) => Keypair.fromSecretKey(new Uint8Array(await openSealed(box, pw)));

function checkPassword(pw: string) {
  if (typeof pw !== "string" || pw.length < 12) throw new Error("Use a password of at least 12 characters.");
}

/**
 * Make a new wallet from a fresh recovery phrase, restore one from a phrase, or import raw keys.
 * Refuses to overwrite an existing wallet unless `replace` is set, which keeps the old file as keystore.json.replaced-<time>.
 */
export async function createKeystore(password: string, opts: { dir?: string; phrase?: string; evmPrivateKey?: string; solanaSecretKey?: Uint8Array; scrypt?: ScryptParams; replace?: boolean } = {}) {
  checkPassword(password);
  const f = files(walletHome(opts.dir));
  if (existsSync(f.keystore)) {
    if (!opts.replace) throw new Error(`A wallet already exists at ${f.keystore}. Back it up and remove it first if you want a new one.`);
    // Keep the old wallet's files (renamed, never deleted). Its limits and saved password were sealed with the old password.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const old of [f.keystore, f.policy, f.backup, path.join(walletHome(opts.dir), "password")]) if (existsSync(old)) renameSync(old, `${old}.replaced-${stamp}`);
  }
  const s = opts.scrypt ?? DEFAULT_SCRYPT;
  const importing = !!(opts.evmPrivateKey || opts.solanaSecretKey);
  if (importing && opts.phrase) throw new Error("Give a recovery phrase or keys, not both.");
  if (importing && !(opts.evmPrivateKey && opts.solanaSecretKey)) throw new Error("Importing keys needs both the EVM private key and the Solana secret key.");
  const fromPhrase = importing ? null : keysFromPhrase(opts.phrase ?? newPhrase());
  const evm = fromPhrase ? fromPhrase.evm : new Wallet(opts.evmPrivateKey!);
  const sol = fromPhrase ? fromPhrase.solana : Keypair.fromSecretKey(opts.solanaSecretKey!);
  const evmJson = await encryptKeystoreJson({ address: evm.address, privateKey: evm.privateKey }, password, { scrypt: { N: s.N, r: s.r, p: s.p } });
  const ks: KeystoreFile = {
    version: 1,
    created_at: new Date().toISOString(),
    evm_address: evm.address,
    solana_address: sol.publicKey.toBase58(),
    evm: evmJson,
    solana: await seal(sol.secretKey, password, s),
    ...(fromPhrase ? { phrase: await seal(new TextEncoder().encode(fromPhrase.phrase), password, s) } : {}),
  };
  const tmp = f.keystore + ".tmp";
  writeFileSync(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
  renameSync(tmp, f.keystore);
  return { evm: ks.evm_address, solana: ks.solana_address, phrase: fromPhrase?.phrase };
}

/** Whether the owner has confirmed they wrote the backup down. */
export function backupDone(dir?: string): boolean { return existsSync(files(walletHome(dir)).backup); }
export function markBackedUp(dir?: string) { writeFileSync(files(walletHome(dir)).backup, JSON.stringify({ confirmed_at: new Date().toISOString() }) + "\n", { mode: 0o600 }); }

/** Is there a recovery phrase, or only keys (wallets made before 0.2.2)? */
export function backupKind(dir?: string): "phrase" | "keys" { return readKeystore(dir).phrase ? "phrase" : "keys"; }

/**
 * What the owner writes down to restore the wallet: the phrase, or for older wallets
 * the two private keys (EVM hex, Solana base58, the formats other wallets import).
 */
export async function revealBackup(password: string, dir?: string): Promise<{ kind: "phrase"; phrase: string } | { kind: "keys"; evm_private_key: string; solana_secret_key: string }> {
  const ks = readKeystore(dir);
  if (ks.phrase) return { kind: "phrase", phrase: new TextDecoder().decode(await openSealed(ks.phrase, password)) };
  const k = await unlock(password, dir);
  return { kind: "keys", evm_private_key: k.evm.privateKey, solana_secret_key: encodeBase58(k.solana.secretKey) };
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
