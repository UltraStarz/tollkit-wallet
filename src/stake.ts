/**
 * Native SOL staking: stake with a validator, unstake, and withdraw once it's free.
 *
 * Checked against primary sources on 2026-10-14:
 *   - @solana/web3.js 1.99 StakeProgram.createAccountWithSeed / delegate / deactivate / withdraw (lib/index.d.ts)
 *   - getStakeActivation was removed in Agave 2.0 (solana.com/docs/rpc/deprecated/getstakeactivation),
 *     so status is worked out here from the delegation's epochs and the current epoch
 *   - minimum delegation (getStakeMinimumDelegation) and the stake account's rent reserve
 *     (getMinimumBalanceForRentExemption(200)) are always read live, never hard-coded
 *   - stake accounts list by the withdraw authority at byte 44 and staker at byte 12 (checked on a live account)
 *   - validator names come from on-chain ValidatorInfo in the Config program
 * Stake accounts are made with a seed from the owner's key, so there's no extra key to keep.
 * Staking moves no money out of the wallet's control, so it isn't counted against spending limits,
 * but it needs the password every time and agents can't reach it.
 */
import { Authorized, Connection, Lockup, PublicKey, StakeProgram, Transaction, ValidatorInfo, type Keypair } from "@solana/web3.js";
import { sendAndConfirm } from "./solconfirm.js";

export const CONFIG_PROGRAM = new PublicKey("Config1111111111111111111111111111111111111");
const U64_MAX = "18446744073709551615";
const LAMPORTS = 1_000_000_000;

export type StakeStatus = "activating" | "active" | "deactivating" | "inactive";
export interface StakeAccount {
  address: string;
  lamports: number;
  /** Delegated amount (lamports); 0 if never delegated. */
  delegated: number;
  rent_reserve: number;
  status: StakeStatus;
  voter: string | null;
  validator: string | null;
  activation_epoch: number | null;
  deactivation_epoch: number | null;
}
export interface Validator { vote: string; name: string | null; commission: number; stake_sol: number }
export interface EpochNow { epoch: number; slot_index: number; slots_in_epoch: number; seconds_left: number }

/** Status from the delegation's epochs. Small stakes move in one epoch; very large network-wide moves can take longer. */
export function stakeStatus(activation: string | number | null, deactivation: string | number | null, epoch: number): StakeStatus {
  if (activation === null || activation === undefined) return "inactive";
  const act = Number(activation);
  if (String(deactivation) === U64_MAX || deactivation === null) return act >= epoch ? "activating" : "active";
  const de = Number(deactivation);
  if (de === act) return "inactive"; // deactivated in the same epoch it was delegated
  return de >= epoch ? "deactivating" : "inactive";
}

/** Slot time measured by the network is about 0.21 s (200 ms slots since epoch 1053). */
const SLOT_SECONDS = 0.21;

type Conn = Pick<Connection, "getEpochInfo" | "getParsedProgramAccounts" | "getStakeMinimumDelegation" | "getMinimumBalanceForRentExemption" | "getVoteAccounts" | "getProgramAccounts" | "getBalance">;

export interface StakingOptions { owner: string; rpc: string; conn?: Conn; send?: (tx: Transaction, kp: Keypair) => Promise<string> }

export class Staking {
  private conn: Conn;
  private names: { at: number; map: Map<string, string> } | null = null;
  private vals: { at: number; list: Validator[] } | null = null;
  constructor(private o: StakingOptions) {
    this.conn = o.conn ?? new Connection(o.rpc, "confirmed");
  }

  async epoch(): Promise<EpochNow> {
    const e = await this.conn.getEpochInfo();
    return { epoch: e.epoch, slot_index: e.slotIndex, slots_in_epoch: e.slotsInEpoch, seconds_left: Math.round((e.slotsInEpoch - e.slotIndex) * SLOT_SECONDS) };
  }

  /** Smallest stake (lamports) and the rent kept in each stake account. */
  async minimums(): Promise<{ min_delegation: number; rent_reserve: number }> {
    const [m, r] = await Promise.all([this.conn.getStakeMinimumDelegation(), this.conn.getMinimumBalanceForRentExemption(StakeProgram.space)]);
    return { min_delegation: Number(m.value), rent_reserve: r };
  }

  /** The owner's stake accounts (as staker or withdrawer), newest status first. */
  async list(epochNow?: number): Promise<StakeAccount[]> {
    const epoch = epochNow ?? (await this.epoch()).epoch;
    const seen = new Map<string, any>();
    for (const offset of [44, 12]) {
      const r = await this.conn.getParsedProgramAccounts(StakeProgram.programId, { filters: [{ dataSize: StakeProgram.space }, { memcmp: { offset, bytes: this.o.owner } }] });
      for (const a of r) seen.set(a.pubkey.toBase58(), a.account);
    }
    const byVote = new Map((await this.validators().catch(() => [] as Validator[])).map((v) => [v.vote, v.name]));
    const out: StakeAccount[] = [];
    for (const [address, acct] of seen) {
      const info = (acct.data as any)?.parsed?.info;
      if (!info?.meta) continue;
      const d = info.stake?.delegation;
      out.push({
        address,
        lamports: acct.lamports,
        delegated: d ? Number(d.stake) : 0,
        rent_reserve: Number(info.meta.rentExemptReserve),
        status: d ? stakeStatus(d.activationEpoch, d.deactivationEpoch, epoch) : "inactive",
        voter: d?.voter ?? null,
        validator: d ? byVote.get(d.voter) ?? null : null,
        activation_epoch: d ? Number(d.activationEpoch) : null,
        deactivation_epoch: d && d.deactivationEpoch !== U64_MAX ? Number(d.deactivationEpoch) : null,
      });
    }
    const order: StakeStatus[] = ["activating", "active", "deactivating", "inactive"];
    return out.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.lamports - a.lamports);
  }

  /** identity -> name, from ValidatorInfo published on-chain. Cached for an hour. */
  async validatorNames(): Promise<Map<string, string>> {
    if (this.names && Date.now() - this.names.at < 3600_000) return this.names.map;
    const map = new Map<string, string>();
    for (const a of await this.conn.getProgramAccounts(CONFIG_PROGRAM)) {
      try { const v = ValidatorInfo.fromConfigData(a.account.data); if (v?.info?.name) map.set(v.key.toBase58(), String(v.info.name).slice(0, 60)); } catch { /* not validator info */ }
    }
    this.names = { at: Date.now(), map };
    return map;
  }

  /** Validators that are voting now (delinquent ones left out), largest first. Cached for 10 minutes. */
  async validators(): Promise<Validator[]> {
    if (this.vals && Date.now() - this.vals.at < 600_000) return this.vals.list;
    const [va, names] = await Promise.all([this.conn.getVoteAccounts(), this.validatorNames().catch(() => new Map<string, string>())]);
    const list = va.current
      .map((v) => ({ vote: v.votePubkey, name: names.get(v.nodePubkey) ?? null, commission: v.commission, stake_sol: Math.round(v.activatedStake / LAMPORTS) }))
      .sort((a, b) => b.stake_sol - a.stake_sol);
    this.vals = { at: Date.now(), list };
    return list;
  }

  /** Create a stake account from the owner's SOL and delegate it, in one transaction. */
  async stake(kp: Keypair, lamports: number, vote: string): Promise<{ tx: string; account: string }> {
    const owner = kp.publicKey;
    if (owner.toBase58() !== this.o.owner) throw new Error("wrong key");
    const votePk = new PublicKey(vote);
    const vals = await this.validators();
    if (!vals.some((v) => v.vote === votePk.toBase58())) throw new Error("That validator isn't voting right now. Pick another.");
    const { min_delegation, rent_reserve } = await this.minimums();
    if (!Number.isSafeInteger(lamports) || lamports < min_delegation) throw new Error(`The smallest stake is ${min_delegation / LAMPORTS} SOL.`);
    const have = await this.conn.getBalance(owner);
    if (lamports + rent_reserve + 10_000 > have) throw new Error(`Not enough SOL: staking ${lamports / LAMPORTS} SOL needs ${(lamports + rent_reserve) / LAMPORTS} SOL plus a network fee, and the wallet has ${have / LAMPORTS}.`);
    const seed = `tk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const stakePk = await PublicKey.createWithSeed(owner, seed, StakeProgram.programId);
    const tx = new Transaction()
      .add(StakeProgram.createAccountWithSeed({ fromPubkey: owner, stakePubkey: stakePk, basePubkey: owner, seed, authorized: new Authorized(owner, owner), lockup: Lockup.default, lamports: lamports + rent_reserve }))
      .add(StakeProgram.delegate({ stakePubkey: stakePk, authorizedPubkey: owner, votePubkey: votePk }));
    return { tx: await this.send(tx, kp), account: stakePk.toBase58() };
  }

  async unstake(kp: Keypair, account: string): Promise<string> {
    const a = await this.mine(account);
    if (a.status === "inactive" || a.status === "deactivating") throw new Error("This stake is already unstaked.");
    return this.send(StakeProgram.deactivate({ stakePubkey: new PublicKey(account), authorizedPubkey: kp.publicKey }), kp);
  }

  /** Withdraw everything and close the stake account. Only when it's inactive. */
  async withdraw(kp: Keypair, account: string): Promise<{ tx: string; lamports: number }> {
    const a = await this.mine(account);
    if (a.status !== "inactive") throw new Error(a.status === "deactivating" ? "Still unstaking. It can be withdrawn after the current epoch ends." : "Unstake it first.");
    const tx = await this.send(StakeProgram.withdraw({ stakePubkey: new PublicKey(account), authorizedPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: a.lamports }), kp);
    return { tx, lamports: a.lamports };
  }

  private async mine(account: string): Promise<StakeAccount> {
    const a = (await this.list()).find((x) => x.address === account);
    if (!a) throw new Error("That stake account isn't this wallet's.");
    return a;
  }

  private send(tx: Transaction, kp: Keypair): Promise<string> {
    if (this.o.send) return this.o.send(tx, kp);
    return sendAndConfirm(new Connection(this.o.rpc, "confirmed"), tx, [kp]);
  }
}
