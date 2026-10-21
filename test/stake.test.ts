/** SOL staking with a fake Solana connection: status, listing, building stake/unstake/withdraw, wallet + dashboard. No network. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, StakeInstruction, StakeProgram, SystemInstruction, SystemProgram, type Transaction } from "@solana/web3.js";
import { stakeStatus, Staking } from "../src/stake.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const err = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };
const MAX = "18446744073709551615";

// status from epochs
check(stakeStatus("100", MAX, 100) === "activating" && stakeStatus("99", MAX, 100) === "active", "delegated this epoch: starting; earlier: earning");
check(stakeStatus("90", "100", 100) === "deactivating" && stakeStatus("90", "99", 100) === "inactive" && stakeStatus(null, null, 100) === "inactive", "unstaked this epoch: unstaking; earlier: ready to withdraw");
check(stakeStatus("100", "100", 100) === "inactive", "delegated and unstaked in the same epoch: free right away");

const PW = "pw-stake-123456";
const dir = mkdtempSync(path.join(os.tmpdir(), "twst-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const VOTE_A = Keypair.generate().publicKey.toBase58(), VOTE_B = Keypair.generate().publicKey.toBase58(), NODE_A = Keypair.generate().publicKey.toBase58();
const accounts = new Map<string, any>();
const parsed = (owner: string, lamports: number, deleg?: { voter: string; stake: number; act: string; de: string }) => ({
  lamports, owner: StakeProgram.programId, executable: false, rentEpoch: 0,
  data: { program: "stake", space: 200, parsed: { type: deleg ? "delegated" : "initialized", info: { meta: { authorized: { staker: owner, withdrawer: owner }, rentExemptReserve: "1666240" }, ...(deleg ? { stake: { delegation: { voter: deleg.voter, stake: String(deleg.stake), activationEpoch: deleg.act, deactivationEpoch: deleg.de } } } : {}) } } },
});
let balance = 5e9, filters: any[] = [];
const conn: any = {
  getEpochInfo: async () => ({ epoch: 100, slotIndex: 216000, slotsInEpoch: 432000 }),
  getStakeMinimumDelegation: async () => ({ context: { slot: 1 }, value: 1_000_000_000 }),
  getMinimumBalanceForRentExemption: async (n: number) => (n === 200 ? 1_666_240 : 0),
  getBalance: async () => balance,
  getVoteAccounts: async () => ({ current: [{ votePubkey: VOTE_A, nodePubkey: NODE_A, commission: 5, activatedStake: 9e15 }, { votePubkey: VOTE_B, nodePubkey: Keypair.generate().publicKey.toBase58(), commission: 0, activatedStake: 2e15 }], delinquent: [] }),
  getProgramAccounts: async () => [],
  getParsedProgramAccounts: async (_p: PublicKey, cfg: any) => { filters.push(cfg.filters); const want = cfg.filters[1].memcmp.bytes; return [...accounts].filter(([, a]) => a.data.parsed.info.meta.authorized.withdrawer === want).map(([k, a]) => ({ pubkey: new PublicKey(k), account: a })); },
};
const sent: Transaction[] = [];
const fakeSend = async (tx: Transaction, kp: Keypair) => { tx.feePayer = kp.publicKey; sent.push(tx); return "sig" + sent.length; };

const w = await TollkitWallet.open(PW, { dir, staking: { conn, send: fakeSend } });
const owner = w.addresses.solana;
const kpA = Keypair.generate().publicKey.toBase58(), kpB = Keypair.generate().publicKey.toBase58(), kpC = Keypair.generate().publicKey.toBase58();
accounts.set(kpA, parsed(owner, 2_001_666_240, { voter: VOTE_A, stake: 2e9, act: "90", de: MAX }));
accounts.set(kpB, parsed(owner, 1_501_666_240, { voter: VOTE_B, stake: 1.5e9, act: "80", de: "95" }));
accounts.set(kpC, parsed(owner, 1_201_666_240, { voter: VOTE_A, stake: 1.2e9, act: "99", de: "100" }));
accounts.set(Keypair.generate().publicKey.toBase58(), parsed(Keypair.generate().publicKey.toBase58(), 9e9, { voter: VOTE_A, stake: 9e9, act: "1", de: MAX }));

const st = w.staking();
const list = await st.list();
check(list.length === 3 && list.map((a) => a.status).join() === "active,deactivating,inactive", "lists only this wallet's stakes, earning first", list.map((a) => a.status));
check(filters.some((f) => f[1].memcmp.offset === 44) && filters.some((f) => f[1].memcmp.offset === 12) && filters.every((f) => f[0].dataSize === 200), "looks up by withdrawer (byte 44) and staker (byte 12)");
check(list[0]!.delegated === 2e9 && list[0]!.rent_reserve === 1666240 && list[0]!.voter === VOTE_A, "amount, rent and validator read from the account");
const ep = await st.epoch();
check(ep.epoch === 100 && ep.seconds_left > 40000 && ep.seconds_left < 50000, "time left in the epoch from slots", ep);
const vals = await st.validators();
check(vals[0]!.vote === VOTE_A && vals[0]!.commission === 5 && vals.length === 2, "validators largest first");

// stake: one transaction, create-with-seed from the owner + delegate
const kp = (w as any).keys.solana as Keypair;
const r = await st.stake(kp, 2e9, VOTE_A);
const tx = sent.at(-1)!;
const progs = tx.instructions.map((i) => i.programId.toBase58());
check(progs.join() === [SystemProgram.programId, StakeProgram.programId, StakeProgram.programId].map(String).join(), "stake = create account, initialize, delegate", progs);
const create = SystemInstruction.decodeCreateWithSeed(tx.instructions[0]!);
const init = StakeInstruction.decodeInitialize(tx.instructions[1]!);
const del = StakeInstruction.decodeDelegate(tx.instructions[2]!);
check(create.lamports === 2e9 + 1_666_240 && create.space === 200 && create.basePubkey.toBase58() === owner && create.fromPubkey.toBase58() === owner && create.newAccountPubkey.toBase58() === r.account, "funds the stake plus the rent reserve, from this wallet, seeded from its key", { lamports: create.lamports });
check(init.authorized.staker.toBase58() === owner && init.authorized.withdrawer.toBase58() === owner, "the wallet keeps both stake and withdraw authority");
check(del.votePubkey.toBase58() === VOTE_A && del.stakePubkey.toBase58() === r.account, "delegated to the chosen validator");
check(/smallest stake is 1 SOL/.test(await err(() => st.stake(kp, 5e8, VOTE_A))), "under the network minimum is refused");
check(/isn't voting/.test(await err(() => st.stake(kp, 2e9, Keypair.generate().publicKey.toBase58()))), "a validator that isn't voting is refused");
balance = 1.5e9;
check(/Not enough SOL/.test(await err(() => st.stake(kp, 1.5e9, VOTE_A))), "can't stake more than the wallet has (rent and fee included)");
balance = 5e9;
check(/wrong key/.test(await err(() => st.stake(Keypair.generate(), 2e9, VOTE_A))), "only the wallet's own key");

// unstake / withdraw
await st.unstake(kp, kpA);
check(StakeInstruction.decodeInstructionType(sent.at(-1)!.instructions[0]!) === "Deactivate", "unstake = deactivate");
check(/already unstaked/.test(await err(() => st.unstake(kp, kpB))), "can't unstake twice");
check(/after the current epoch/.test(await err(() => st.withdraw(kp, kpC))), "can't withdraw while unstaking");
check(/Unstake it first/.test(await err(() => st.withdraw(kp, kpA))), "can't withdraw a stake that's earning");
const wd = await st.withdraw(kp, kpB);
const wi = StakeInstruction.decodeWithdraw(sent.at(-1)!.instructions[0]!);
check(wi.lamports === 1_501_666_240 && wi.toPubkey.toBase58() === owner && wd.lamports === wi.lamports, "withdraw takes everything back to this wallet (closes the account)");
check(/isn't this wallet's/.test(await err(() => st.withdraw(kp, Keypair.generate().publicKey.toBase58()))), "other people's stake accounts are refused");

// wallet: password every time, receipts
check(/wrong password/.test(await err(() => w.stakeAction("nope", { action: "stake", sol: 2, vote: VOTE_A }))), "wallet: needs the password");
const n0 = sent.length;
await w.stakeAction(PW, { action: "stake", sol: 1.25, vote: VOTE_A });
const rec = w.receipts().at(-1)!;
check(sent.length === n0 + 1 && rec.kind === "stake" && rec.tool === "stake" && rec.usd === 0 && /Stake 1.25 SOL/.test(rec.detail ?? "") && rec.tx === "sig" + sent.length, "wallet: staking is recorded in Activity, not counted as spending", rec);
await err(() => w.stakeAction(PW, { action: "unstake", account: kpB }));
check(w.receipts().at(-1)!.status === "failed", "a refused unstake is recorded as failed");

// 0.9.1: staking is off the wallet's screens and API; the dashboard no longer answers for it.
const dash = await startDashboard(w, PW, { port: 17451, watch: false, autopilot: false, connectApps: false, ai: false, holdings: false });
const tok = new URL(dash.url).searchParams.get("t")!;
const call = async (p: string, body?: unknown) => { const res = await fetch(`http://127.0.0.1:17451${p}`, { method: body ? "POST" : "GET", headers: { "x-tw-token": tok, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status }; };
check((await call("/api/stake")).status >= 400 && (await call("/api/validators")).status >= 400 && (await call("/api/stake", { password: PW, action: "unstake", account: kpA })).status >= 400, "dashboard: no staking routes any more");
await dash.close();

console.log(`\nstake: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
