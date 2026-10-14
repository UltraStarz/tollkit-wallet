/** Recovery phrase: SLIP-0010 vectors, MetaMask/Phantom paths, create/restore/replace, key backups for older wallets, dashboard endpoints. */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBytes, hexlify, encodeBase58, Wallet } from "ethers";
import { Keypair } from "@solana/web3.js";
import { slip10Ed25519, keysFromPhrase, newPhrase, createKeystore, unlock, revealBackup, backupKind, backupDone, markBackedUp, addresses } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "twb-"));
const FAST = { N: 1 << 10, r: 8, p: 1 };
const err = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

// SLIP-0010 ed25519 test vectors 1 and 2, copied from satoshilabs/slips slip-0010.md
const vec = JSON.parse(readFileSync(new URL("./fixtures/slip10-ed25519.json", import.meta.url), "utf8")) as { seed: string; path: string; private: string }[];
check(vec.length === 12 && vec.every((v) => hexlify(slip10Ed25519(getBytes("0x" + v.seed), v.path)).slice(2) === v.private), "SLIP-0010 ed25519: all 12 official test vectors");
check(/hardened/.test(await err(async () => slip10Ed25519(new Uint8Array(16), "m/44'/501'/0/0"))), "ed25519 refuses non-hardened paths");

// Standard BIP-39 test phrases. EVM m/44'/60'/0'/0/0; Solana m/44'/501'/0'/0' (cross-checked with ed25519-hd-key + bip39)
const ABOUT = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const k1 = keysFromPhrase(ABOUT);
check(k1.evm.address === "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" && k1.solana.publicKey.toBase58() === "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", "test phrase gives the MetaMask/Phantom-path addresses", [k1.evm.address, k1.solana.publicKey.toBase58()]);
const k2 = keysFromPhrase("  Legal winner THANK year wave sausage worth useful legal winner thank yellow ");
check(k2.evm.address === "0x58A57ed9d8d624cBD12e2C467D34787555bB1b25" && k2.solana.publicKey.toBase58() === "BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX", "spacing and capitals don't matter");
check(/isn't valid/.test(await err(async () => keysFromPhrase(ABOUT.replace("about", "abandon")))), "a wrong word (bad checksum) is refused");
const np = newPhrase();
check(np.split(" ").length === 12 && keysFromPhrase(np).phrase === np, "new phrases are 12 valid words");

// create -> phrase is stored sealed, reveal needs the password, restore gives the same addresses
const d1 = tmp(), PW = "correct horse battery";
const made = await createKeystore(PW, { dir: d1, scrypt: FAST });
const ks = JSON.parse(readFileSync(path.join(d1, "keystore.json"), "utf8"));
check(!!made.phrase && !!ks.phrase && !JSON.stringify(ks).includes(made.phrase.split(" ")[0]! + " " + made.phrase.split(" ")[1]!), "new wallet has a phrase, stored encrypted (not readable in the file)");
check(backupKind(d1) === "phrase" && !backupDone(d1), "backup: phrase kind, not yet confirmed");
check(/wrong password/.test(await err(() => revealBackup("nope-nope-nope", d1))), "reveal needs the right password");
const rv = await revealBackup(PW, d1);
check(rv.kind === "phrase" && rv.phrase === made.phrase, "reveal returns the same phrase");
const keys = await unlock(PW, d1), fromP = keysFromPhrase(made.phrase!);
check(keys.evm.address === fromP.evm.address && keys.solana.publicKey.equals(fromP.solana.publicKey), "the wallet's keys are the phrase's keys");
markBackedUp(d1);
check(backupDone(d1), "confirmed after the owner checks their copy");

const d2 = tmp();
const r = await createKeystore("another password!", { dir: d2, phrase: made.phrase!, scrypt: FAST });
check(r.evm === made.evm && r.solana === made.solana, "restore from the phrase: same addresses");

// replace keeps the old files
await TollkitWallet.open("another password!", { dir: d2 });
check(/already exists/.test(await err(() => createKeystore("third password!!", { dir: d2, phrase: ABOUT, scrypt: FAST }))), "won't overwrite a wallet without --replace");
await createKeystore("third password!!", { dir: d2, phrase: ABOUT, scrypt: FAST, replace: true });
const left = readdirSync(d2);
check(addresses(d2).evm === k1.evm.address && left.some((f) => f.startsWith("keystore.json.replaced-")) && left.some((f) => f.startsWith("policy.json.replaced-")) && !existsSync(path.join(d2, "policy.json")), "--replace keeps the old keystore and limits (renamed); new limits start fresh", left);
const w2 = await TollkitWallet.open("third password!!", { dir: d2 });
check(w2.policy.per_trade_usd > 0, "the restored wallet opens with default limits");

// older wallets: keys only; backup shows importable keys, and they restore
const d3 = tmp(), evmOld = Wallet.createRandom(), solOld = Keypair.generate();
await createKeystore(PW, { dir: d3, evmPrivateKey: evmOld.privateKey, solanaSecretKey: solOld.secretKey, scrypt: FAST });
check(backupKind(d3) === "keys", "imported/older wallet: keys kind");
const kb = await revealBackup(PW, d3);
check(kb.kind === "keys" && kb.evm_private_key === evmOld.privateKey && kb.solana_secret_key === encodeBase58(solOld.secretKey), "keys backup: EVM hex and Solana base58", kb.kind);
const d4 = tmp();
const rk = await createKeystore(PW, { dir: d4, evmPrivateKey: (kb as any).evm_private_key, solanaSecretKey: solOld.secretKey, scrypt: FAST });
check(rk.evm === evmOld.address && rk.solana === solOld.publicKey.toBase58() && rk.phrase === undefined, "restore --keys gives the same addresses");
check(/both/.test(await err(() => createKeystore(PW, { dir: tmp(), evmPrivateKey: evmOld.privateKey, scrypt: FAST }))), "importing needs both keys");

// dashboard: state, reveal behind the password, confirm
const w = await TollkitWallet.open(PW, { dir: d1 });
(w.sanctions as any).isSanctioned = async () => false;
const dir5 = tmp();
await createKeystore(PW, { dir: dir5, scrypt: FAST });
const w5 = await TollkitWallet.open(PW, { dir: dir5 });
const dash = await startDashboard(w5, PW, { port: 17441, watch: false, autopilot: false, connectApps: false, ai: false });
const tok = new URL(dash.url).searchParams.get("t")!;
const call = async (p: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:17441${p}`, { method: body ? "POST" : "GET", headers: { "x-tw-token": tok, "content-type": "application/json", host: "127.0.0.1:17441" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() as any }; };
const st = await call("/api/state");
check(st.j.backup?.kind === "phrase" && st.j.backup.done === false && !JSON.stringify(st.j).includes((await revealBackup(PW, dir5) as any).phrase), "state says a backup is due and never carries the phrase");
check((await call("/api/backup/reveal", { password: "wrong" })).status === 403, "reveal: wrong password refused");
const ok = await call("/api/backup/reveal", { password: PW });
check(ok.status === 200 && ok.j.kind === "phrase" && ok.j.phrase.split(" ").length === 12, "reveal: right password shows the phrase");
check((await call("/api/backup/done", {})).status === 200 && (await call("/api/state")).j.backup.done === true, "confirming marks it backed up");
await dash.close();

console.log(`\nbackup: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
