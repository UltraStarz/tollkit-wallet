/**
 * "Move between networks": USDC between Base, Ethereum and Solana with Circle's CCTP V2,
 * and ETH between Base and Ethereum with Across (through Tollkit's server, which holds the Across key).
 *
 * Checked against primary sources on 2026-10-14:
 *   CCTP domains Ethereum 0, Solana 5, Base 6 (developers.circle.com/cctp/concepts/supported-chains-and-domains)
 *   EVM TokenMessengerV2 0x28b5…cf5d (developers.circle.com/cctp/evm-smart-contracts);
 *     depositForBurnWithHook signature from Circle's own example (circlefin/solana-cctp-contracts examples/v2/evm.ts)
 *   Solana TokenMessengerMinterV2 CCTPV2vP…, MessageTransmitterV2 CCTPV2Sm… (that repo's README and IDL);
 *     deposit_for_burn_with_hook accounts, PDA seeds and discriminator from examples/target/idl/token_messenger_minter_v2.json
 *   Fees: GET iris-api.circle.com/v2/burn/USDC/fees/{src}/{dst}?forward=true (no key); Fast Transfer = finality 1000
 *   Forwarding Service: hookData "cctp-forward" (32 bytes; 65 with Solana token-account setup), Circle mints on the
 *     destination so no gas is needed there (developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service)
 *   Across SpokePoolPeriphery 0x97CC…fD4 on Base and Ethereum (docs.across.to/chains-and-contracts)
 * Tollkit's fee (0.25%) is sent as its own small USDC transfer for CCTP moves, and taken by Across as its app fee for ETH.
 * Moves stay inside this wallet (same owner on both networks), so they don't count against spending limits,
 * but they need the password every time and agents can't reach them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { sendAndConfirm } from "./solconfirm.js";
import { AbiCoder, Contract, Interface, JsonRpcProvider, ZeroAddress, ZeroHash, concat, getAddress, getBytes, hexlify, toUtf8Bytes, zeroPadBytes, zeroPadValue, type HDNodeWallet, type Wallet } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, type Chain } from "./chains.js";
import { walletHome } from "./paths.js";

type Fetch = typeof fetch;
type Keys = { evm: Wallet | HDNodeWallet; solana: Keypair };
export type MoveAsset = "USDC" | "ETH";

export const BRIDGE_FEE_BPS = 25;
export const IRIS = "https://iris-api.circle.com";
export const CCTP_DOMAIN: Record<Chain, number> = { ethereum: 0, solana: 5, base: 6 };
export const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const SOL_TMM = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
export const SOL_MT = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
export const ACROSS_PERIPHERY = "0x97CCDBea4632140639aD5eA9b944aa034eb15fD4";
export const USDC: Record<Chain, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Anchor discriminator for deposit_for_burn_with_hook, from the IDL. */
const DFB_HOOK_DISC = Uint8Array.from([111, 245, 62, 131, 204, 108, 223, 155]);
/** Seconds to arrive with Fast Transfer, by source (developers.circle.com/cctp/concepts/finality-and-block-confirmations). */
const FAST_ETA: Record<Chain, number> = { ethereum: 20, base: 8, solana: 8 };

/** The Forwarding Service hook: "cctp-forward" padded to 24 bytes, version 0, length 0 (32 bytes). */
export function forwardHook(solanaRecipientSetup?: PublicKey): Uint8Array {
  const head = getBytes(zeroPadBytes(toUtf8Bytes("cctp-forward"), 24));
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
  if (!solanaRecipientSetup) return getBytes(concat([head, u32(0), u32(0)]));
  // Extended form: create the recipient's USDC account on Solana (flag 1, then the wallet address).
  return getBytes(concat([head, u32(0), u32(33), Uint8Array.from([1]), solanaRecipientSetup.toBytes()]));
}

export const canMove = (asset: MoveAsset, from: Chain, to: Chain) =>
  from !== to && (asset === "USDC" || (asset === "ETH" && from !== "solana" && to !== "solana"));

export interface MoveQuote {
  asset: MoveAsset; from: Chain; to: Chain; via: "cctp" | "across";
  /** Everything in atomic units of the asset (USDC 6 decimals, ETH 18). */
  amount: string; tollkit_fee: string; bridge_fee_max: string; receive_min: string;
  eta_seconds: number;
  /** CCTP details. */
  burn?: string; max_fee?: string; hook?: string; mint_recipient?: string; recipient_setup?: boolean;
  /** Across transaction to sign (checked). */
  tx?: { to: string; data: string; value: string; chainId: number };
}

export interface MoveRecord { id: string; ts: string; asset: MoveAsset; from: Chain; to: Chain; amount: string; receive_min: string; via: "cctp" | "across"; tx: string; fee_tx?: string; state: "sent" | "arrived" | "failed"; dest_tx?: string; eta_seconds: number; checked?: string }

const decimals = (a: MoveAsset) => (a === "USDC" ? 6 : 18);
export const fmtAmount = (a: MoveAsset, atomic: string | bigint) => {
  const n = Number(BigInt(atomic)) / 10 ** decimals(a);
  return `${n.toLocaleString("en-US", { maximumFractionDigits: a === "USDC" ? 2 : 6 })} ${a}`;
};

interface Cfg { fee_bps: number; fee_recipient: { evm: string | null; solana: string | null }; across: boolean }

export type MoverOptions = ConstructorParameters<typeof Mover>[0];

export class Mover {
  private cfg: { at: number; v: Cfg } | null = null;
  private file: string;
  constructor(private o: { evm: string; solana: string; dir?: string; proxy: string; fetch?: Fetch; rpc?: Partial<Record<Chain, string>>;
    /** Tests: replace chain calls. */ sendEvm?: (from: Chain, tx: { to: string; data: string; value?: bigint }, keys: Keys) => Promise<string>;
    sendSolana?: (tx: Transaction, signers: Keypair[]) => Promise<string>; solConn?: Pick<Connection, "getAccountInfo" | "getParsedTokenAccountsByOwner" | "getBalance">;
    evmRead?: (from: Chain, what: "usdc" | "eth" | "allowance") => Promise<bigint> }) {
    this.file = path.join(walletHome(o.dir), "moves.json");
  }
  private get f(): Fetch { return this.o.fetch ?? fetch; }
  private rpc(c: Chain) { return this.o.rpc?.[c] ?? DEFAULT_RPC[c]; }
  private sol() { return this.o.solConn ?? new Connection(this.rpc("solana"), "confirmed"); }

  async config(): Promise<Cfg> {
    if (this.cfg && Date.now() - this.cfg.at < 600_000) return this.cfg.v;
    const r = await this.f(`${this.o.proxy}/bridge/config`, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) throw new Error("Moving between networks isn't available from Tollkit's server yet.");
    const j: any = await r.json();
    if (!r.ok) throw new Error(j?.message ?? `Tollkit's server answered HTTP ${r.status}.`);
    const fee = Number(j.fee_bps);
    if (!(fee >= 0 && fee <= BRIDGE_FEE_BPS)) throw new Error(`Tollkit's server asked for a ${fee / 100}% fee; the wallet allows at most ${BRIDGE_FEE_BPS / 100}%.`);
    const evm = typeof j.fee_recipient?.evm === "string" && /^0x[0-9a-fA-F]{40}$/.test(j.fee_recipient.evm) ? getAddress(j.fee_recipient.evm.toLowerCase()) : null;
    let solana: string | null = null;
    try { if (j.fee_recipient?.solana) solana = new PublicKey(j.fee_recipient.solana).toBase58(); } catch { solana = null; }
    const v = { fee_bps: fee, fee_recipient: { evm, solana }, across: !!j.across };
    this.cfg = { at: Date.now(), v };
    return v;
  }

  /** The owner's USDC token account on Solana, and whether it exists yet. */
  private async solUsdcAccount(owner: PublicKey): Promise<{ ata: PublicKey; exists: boolean }> {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC.solana), owner);
    return { ata, exists: !!(await this.sol().getAccountInfo(ata)) };
  }

  async quote(asset: MoveAsset, from: Chain, to: Chain, amountAtomic: string): Promise<MoveQuote> {
    if (!canMove(asset, from, to)) throw new Error(asset === "ETH" ? "ETH moves between Base and Ethereum only." : "Pick two different networks.");
    if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) throw new Error("Enter an amount.");
    const amount = BigInt(amountAtomic);
    const cfg = await this.config();
    return asset === "USDC" ? this.quoteCctp(from, to, amount, cfg) : this.quoteAcross(from, to, amount, cfg);
  }

  private async quoteCctp(from: Chain, to: Chain, amount: bigint, cfg: Cfg): Promise<MoveQuote> {
    if (!cfg.fee_recipient[from === "solana" ? "solana" : "evm"] && cfg.fee_bps > 0) throw new Error(`Moving from ${from} isn't set up on Tollkit's server yet.`);
    let setup = false, mintRecipient: string;
    if (to === "solana") {
      const { ata, exists } = await this.solUsdcAccount(new PublicKey(this.o.solana));
      setup = !exists;
      mintRecipient = hexlify(ata.toBytes());
    } else mintRecipient = zeroPadValue(this.o.evm, 32);
    const url = `${IRIS}/v2/burn/USDC/fees/${CCTP_DOMAIN[from]}/${CCTP_DOMAIN[to]}?forward=true${setup ? "&includeRecipientSetup=true" : ""}`;
    const r = await this.f(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Circle's fee service answered HTTP ${r.status}.`);
    const rows: any[] = await r.json();
    const fast = rows.find((x) => x.finalityThreshold === 1000);
    if (!fast) throw new Error("Circle didn't offer a fast transfer for this route.");
    const tollkit = (amount * BigInt(cfg.fee_bps)) / 10_000n;
    const burn = amount - tollkit;
    // minimumFee is in basis points and can be fractional (1.3); round up.
    const mf = BigInt(Math.round(Number(fast.minimumFee) * 1000));
    const protocol = (burn * mf + 10_000_000n - 1n) / 10_000_000n;
    const forward = BigInt(String(fast.forwardFee?.med ?? fast.forwardFee?.high ?? "0"));
    const maxFee = protocol + forward;
    const receive = burn - maxFee;
    if (receive <= 0n || (maxFee + tollkit) * 10n > amount) throw new Error(`That's too small to move: fees would be about ${fmtAmount("USDC", maxFee + tollkit)}. Try ${fmtAmount("USDC", (maxFee + tollkit) * 10n)} or more.`);
    return {
      asset: "USDC", from, to, via: "cctp", amount: amount.toString(), tollkit_fee: tollkit.toString(), bridge_fee_max: maxFee.toString(), receive_min: receive.toString(),
      eta_seconds: FAST_ETA[from], burn: burn.toString(), max_fee: maxFee.toString(), mint_recipient: mintRecipient, recipient_setup: setup,
      hook: hexlify(forwardHook(setup ? new PublicKey(this.o.solana) : undefined)),
    };
  }

  private async quoteAcross(from: Chain, to: Chain, amount: bigint, cfg: Cfg): Promise<MoveQuote> {
    if (!cfg.across || !cfg.fee_recipient.evm) throw new Error("Moving ETH isn't set up on Tollkit's server yet.");
    const q = new URLSearchParams({ from, to, amount: amount.toString(), address: this.o.evm });
    const r = await this.f(`${this.o.proxy}/bridge/across?${q}`, { signal: AbortSignal.timeout(25_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.message ?? `Tollkit's server answered HTTP ${r.status}.`);
    const tx = j.swapTx;
    if (!tx || !/^0x[0-9a-fA-F]{40}$/.test(String(tx.to)) || getAddress(String(tx.to).toLowerCase()) !== ACROSS_PERIPHERY) throw new Error("The ETH route isn't Across's contract, so it wasn't used.");
    if (Number(tx.chainId) !== EVM_CHAIN_ID[from as "base" | "ethereum"]) throw new Error("The ETH route is for the wrong network.");
    if (BigInt(tx.value ?? 0) !== amount) throw new Error("The ETH route doesn't match the amount.");
    if (Array.isArray(j.approvalTxns) && j.approvalTxns.length) throw new Error("The ETH route asked for a token approval, which ETH doesn't need.");
    // Everything shown and checked comes from the transaction itself, not from the server's numbers.
    const d = checkAcrossDeposit(String(tx.data), { from: from as "base" | "ethereum", to: to as "base" | "ethereum", amount, me: this.o.evm, feeRecipient: cfg.fee_recipient.evm, feeBps: cfg.fee_bps });
    if ((amount - d.receive) * 100n > amount * 3n) throw new Error(`Fees on this amount are over 3% (you'd get ${fmtAmount("ETH", d.receive)}). Try a larger amount.`);
    return {
      asset: "ETH", from, to, via: "across", amount: amount.toString(), tollkit_fee: d.fee.toString(),
      bridge_fee_max: (amount - d.output).toString(), receive_min: d.receive.toString(),
      eta_seconds: Number(j.expectedFillTime) || 10, tx: { to: ACROSS_PERIPHERY, data: String(tx.data), value: amount.toString(), chainId: Number(tx.chainId) },
    };
  }

  /** Sign and send. Returns the record that the dashboard tracks until it arrives. */
  async execute(q: MoveQuote, keys: Keys): Promise<MoveRecord> {
    const cfg = await this.config();
    const id = createHash("sha256").update(JSON.stringify(q) + Date.now()).digest("hex").slice(0, 12);
    let tx: string, feeTx: string | undefined;
    if (q.via === "across") {
      tx = await this.evmSend(q.from, { to: q.tx!.to, data: q.tx!.data, value: BigInt(q.tx!.value) }, keys);
    } else if (q.from === "solana") {
      tx = await this.burnFromSolana(q, keys, cfg);
    } else {
      const r = await this.burnFromEvm(q, keys, cfg); tx = r.tx; feeTx = r.feeTx;
    }
    const rec: MoveRecord = { id, ts: new Date().toISOString(), asset: q.asset, from: q.from, to: q.to, amount: q.amount, receive_min: q.receive_min, via: q.via, tx, ...(feeTx ? { fee_tx: feeTx } : {}), state: "sent", eta_seconds: q.eta_seconds };
    this.save([rec, ...this.list()].slice(0, 100));
    return rec;
  }

  private async evmSend(from: Chain, t: { to: string; data: string; value?: bigint }, keys: Keys): Promise<string> {
    if (this.o.sendEvm) return this.o.sendEvm(from, t, keys);
    const p = new JsonRpcProvider(this.rpc(from), EVM_CHAIN_ID[from as "base" | "ethereum"], { staticNetwork: true });
    const sent = await keys.evm.connect(p).sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0n });
    const rc = await sent.wait();
    if (!rc || rc.status !== 1) throw new Error(`Transaction ${sent.hash} failed.`);
    return sent.hash;
  }

  private async evmRead(from: Chain, what: "usdc" | "eth" | "allowance"): Promise<bigint> {
    if (this.o.evmRead) return this.o.evmRead(from, what);
    const p = new JsonRpcProvider(this.rpc(from), EVM_CHAIN_ID[from as "base" | "ethereum"], { staticNetwork: true });
    if (what === "eth") return p.getBalance(this.o.evm);
    const c = new Contract(USDC[from], ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], p) as any;
    return what === "usdc" ? c.balanceOf(this.o.evm) : c.allowance(this.o.evm, TOKEN_MESSENGER_V2);
  }

  private async burnFromEvm(q: MoveQuote, keys: Keys, cfg: Cfg): Promise<{ tx: string; feeTx?: string }> {
    const ERC20 = new Contract(USDC[q.from], ["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"]);
    const TM = new Contract(TOKEN_MESSENGER_V2, ["function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)"]);
    const amount = BigInt(q.amount), burn = BigInt(q.burn!), fee = BigInt(q.tollkit_fee);
    const have = await this.evmRead(q.from, "usdc");
    if (have < amount) throw new Error(`The wallet has ${fmtAmount("USDC", have)} on ${q.from}, less than ${fmtAmount("USDC", amount)}.`);
    if ((await this.evmRead(q.from, "eth")) === 0n) throw new Error(`Moving from ${q.from} needs a little ETH there for network fees.`);
    // Approve exactly the amount being burned, only to Circle's TokenMessengerV2.
    if ((await this.evmRead(q.from, "allowance")) < burn) await this.evmSend(q.from, { to: USDC[q.from], data: ERC20.interface.encodeFunctionData("approve", [TOKEN_MESSENGER_V2, burn]) }, keys);
    const tx = await this.evmSend(q.from, { to: TOKEN_MESSENGER_V2, data: TM.interface.encodeFunctionData("depositForBurnWithHook", [burn, CCTP_DOMAIN[q.to], q.mint_recipient, USDC[q.from], ZeroHash, BigInt(q.max_fee!), 1000, q.hook]) }, keys);
    let feeTx: string | undefined;
    if (fee > 0n && cfg.fee_recipient.evm) feeTx = await this.evmSend(q.from, { to: USDC[q.from], data: ERC20.interface.encodeFunctionData("transfer", [cfg.fee_recipient.evm, fee]) }, keys).catch(() => undefined);
    return { tx, feeTx };
  }

  /** One Solana transaction: Tollkit's fee transfer + CCTP deposit_for_burn_with_hook (all or nothing). */
  async solanaBurnTx(q: MoveQuote, owner: PublicKey, cfg: Cfg, event: Keypair, feeAtaExists = true): Promise<Transaction> {
    const spl = await import("@solana/spl-token");
    const mint = new PublicKey(USDC.solana);
    const ownerAta = spl.getAssociatedTokenAddressSync(mint, owner);
    const tx = new Transaction();
    const fee = BigInt(q.tollkit_fee);
    if (fee > 0n) {
      const feeOwner = new PublicKey(cfg.fee_recipient.solana!);
      const feeAta = spl.getAssociatedTokenAddressSync(mint, feeOwner);
      // Only pay into an account that already exists, so the owner never pays rent for Tollkit's account.
      if (feeAtaExists) tx.add(spl.createTransferCheckedInstruction(ownerAta, mint, feeAta, owner, fee, 6));
    }
    tx.add(depositForBurnWithHookIx({ owner, burnTokenAccount: ownerAta, mint, event: event.publicKey, amount: BigInt(q.burn!), destinationDomain: CCTP_DOMAIN[q.to], mintRecipient: getBytes(q.mint_recipient!), maxFee: BigInt(q.max_fee!), minFinality: 1000, hook: getBytes(q.hook!) }));
    return tx;
  }

  private async burnFromSolana(q: MoveQuote, keys: Keys, cfg: Cfg): Promise<string> {
    const owner = keys.solana.publicKey;
    const conn = this.sol();
    const accts = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC.solana) });
    const have = accts.value.reduce((s, x) => s + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
    if (have < BigInt(q.amount)) throw new Error(`The wallet has ${fmtAmount("USDC", have)} on Solana, less than ${fmtAmount("USDC", q.amount)}.`);
    if ((await conn.getBalance(owner)) < 10_000_000) throw new Error("Moving from Solana needs about 0.01 SOL for network fees and a small refundable deposit.");
    const event = Keypair.generate();
    const spl = await import("@solana/spl-token");
    const feeAta = cfg.fee_recipient.solana ? spl.getAssociatedTokenAddressSync(new PublicKey(USDC.solana), new PublicKey(cfg.fee_recipient.solana)) : null;
    const feeAtaExists = !!feeAta && !!(await conn.getAccountInfo(feeAta));
    const tx = await this.solanaBurnTx(q, owner, cfg, event, feeAtaExists);
    if (this.o.sendSolana) return this.o.sendSolana(tx, [keys.solana, event]);
    return sendAndConfirm(new Connection(this.rpc("solana"), "confirmed"), tx, [keys.solana, event]);
  }

  list(): MoveRecord[] {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : []; } catch { return []; }
  }
  private save(l: MoveRecord[]) { writeFileSync(this.file, JSON.stringify(l, null, 2), { mode: 0o600 }); }

  /** Check Circle's attestation service for USDC moves still on their way (at most every 10 s each). */
  async refresh(): Promise<MoveRecord[]> {
    const l = this.list();
    let changed = false;
    for (const m of l) {
      if (m.state !== "sent") continue;
      if (m.via === "across") { if (Date.now() - Date.parse(m.ts) > Math.max(120, m.eta_seconds * 6) * 1000) { m.state = "arrived"; changed = true; } continue; }
      if (m.checked && Date.now() - Date.parse(m.checked) < 10_000) continue;
      m.checked = new Date().toISOString(); changed = true;
      try {
        const r = await this.f(`${IRIS}/v2/messages/${CCTP_DOMAIN[m.from]}?transactionHash=${m.tx}`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) continue;
        const msg = ((await r.json()) as any)?.messages?.[0];
        if (msg?.forwardTxHash) { m.state = "arrived"; m.dest_tx = String(msg.forwardTxHash); }
      } catch { /* try again later */ }
    }
    if (changed) this.save(l);
    return l;
  }
}

/** deposit_for_burn_with_hook, encoded by hand from Circle's IDL (Anchor: 8-byte discriminator + Borsh params). */
export function depositForBurnWithHookIx(a: { owner: PublicKey; burnTokenAccount: PublicKey; mint: PublicKey; event: PublicKey; amount: bigint; destinationDomain: number; mintRecipient: Uint8Array; maxFee: bigint; minFinality: number; hook: Uint8Array }): TransactionInstruction {
  if (a.mintRecipient.length !== 32) throw new Error("mint recipient must be 32 bytes");
  const pda = (seeds: (Uint8Array | Buffer)[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds as Buffer[], prog)[0];
  const s = (x: string) => Buffer.from(x, "utf8");
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const data = Buffer.concat([
    Buffer.from(DFB_HOOK_DISC), u64(a.amount), u32(a.destinationDomain), Buffer.from(a.mintRecipient), Buffer.alloc(32) /* destination_caller: anyone */,
    u64(a.maxFee), u32(a.minFinality), u32(a.hook.length), Buffer.from(a.hook),
  ]);
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId: SOL_TMM,
    data,
    keys: [
      k(a.owner, false, true),
      k(a.owner, true, true), // event_rent_payer
      k(pda([s("sender_authority")], SOL_TMM)),
      k(a.burnTokenAccount, true),
      k(pda([s("denylist_account"), a.owner.toBuffer()], SOL_TMM)),
      k(pda([s("message_transmitter")], SOL_MT), true),
      k(pda([s("token_messenger")], SOL_TMM)),
      k(pda([s("remote_token_messenger"), s(String(a.destinationDomain))], SOL_TMM)),
      k(pda([s("token_minter")], SOL_TMM)),
      k(pda([s("local_token"), a.mint.toBuffer()], SOL_TMM), true),
      k(a.mint, true),
      k(a.event, true, true),
      k(SOL_MT),
      k(SOL_TMM),
      k(TOKEN_PROGRAM),
      k(SystemProgram.programId),
      k(pda([s("__event_authority")], SOL_TMM)),
      k(SOL_TMM), // program
    ],
  });
}

/** Across (docs.across.to/chains-and-contracts): SpokePool per network, MulticallHandler on both; WETH from tokens.ts. */
export const ACROSS_SPOKE: Record<"base" | "ethereum", string> = { base: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", ethereum: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5" };
export const ACROSS_MULTICALL = "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E";
const WETH: Record<"base" | "ethereum", string> = { base: "0x4200000000000000000000000000000000000006", ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" };
/** SpokePoolPeriphery.depositNative and MulticallHandler, from the ABIs in @across-protocol/contracts 5.0.27. */
const PERIPHERY = new Interface(["function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable"]);
const HANDLER = new Interface(["function makeCallWithBalance(address target, bytes callData, uint256 value, tuple(address token, uint256 offset)[] replacement)", "function drainLeftoverTokens(address token, address destination)"]);
const WETH_IFACE = new Interface(["function withdraw(uint256)"]);
const EMIT_DATA = "0xd836083e"; // AcrossEventEmitter.emitData(bytes): logs only, no value

/**
 * Decode and check an Across ETH deposit before signing: Across's SpokePool on this network, from this wallet,
 * ETH in for exactly the amount, ETH out on the other network to this wallet (directly, or through Across's
 * MulticallHandler whose only steps unwrap WETH, pay Tollkit's fee, and send everything left to this wallet).
 * Returns what's actually delivered, Tollkit's fee, and what this wallet receives at least.
 */
export function checkAcrossDeposit(data: string, o: { from: "base" | "ethereum"; to: "base" | "ethereum"; amount: bigint; me: string; feeRecipient: string; feeBps: number }): { output: bigint; fee: bigint; receive: bigint } {
  const bad = (why: string) => new Error(`The ETH route failed a safety check (${why}), so it wasn't used.`);
  let a: any;
  try { a = PERIPHERY.decodeFunctionData("depositNative", data); } catch { throw bad("not an Across ETH deposit"); }
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const b32 = (addr: string) => zeroPadValue(addr.toLowerCase(), 32);
  if (!eq(a.spokePool, ACROSS_SPOKE[o.from])) throw bad("wrong SpokePool");
  if (!eq(a.depositor, o.me)) throw bad("depositor isn't this wallet");
  if (!eq(a.inputToken, WETH[o.from]) || BigInt(a.inputAmount) !== o.amount) throw bad("input isn't this amount of ETH");
  if (!eq(a.outputToken, b32(WETH[o.to]))) throw bad("output isn't ETH");
  if (BigInt(a.destinationChainId) !== BigInt(EVM_CHAIN_ID[o.to])) throw bad("wrong destination network");
  const output = BigInt(a.outputAmount);
  if (output <= 0n || output > o.amount) throw bad("odd output amount");
  if (eq(a.recipient, b32(o.me))) {
    if (a.message !== "0x") throw bad("unexpected message");
    return { output, fee: 0n, receive: output };
  }
  if (!eq(a.recipient, b32(ACROSS_MULTICALL))) throw bad("recipient isn't this wallet");
  let ins: any;
  try { [ins] = AbiCoder.defaultAbiCoder().decode(["tuple(tuple(address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)"], a.message); } catch { throw bad("unreadable instructions"); }
  if (!(eq(ins.fallbackRecipient, ZeroAddress) || eq(ins.fallbackRecipient, o.me))) throw bad("leftovers go elsewhere");
  let fee = 0n, drainedEth = false, drainedWeth = false, unwrapped = false;
  for (const c of ins.calls as any[]) {
    const target = String(c.target), value = BigInt(c.value), cd = String(c.callData);
    if (eq(target, ACROSS_MULTICALL) && value === 0n) {
      let p: any;
      try { p = HANDLER.parseTransaction({ data: cd }); } catch { throw bad("unknown handler step"); }
      if (p?.name === "makeCallWithBalance" && !drainedEth) {
        // Unwrap all the WETH that arrived into ETH.
        if (!eq(p.args.target, WETH[o.to]) || BigInt(p.args.value) !== 0n) throw bad("unexpected call");
        try { WETH_IFACE.decodeFunctionData("withdraw", p.args.callData); } catch { throw bad("unexpected WETH call"); }
        // The handler writes its WETH balance into withdraw's amount, right after the 4-byte selector.
        if (p.args.replacement.length !== 1 || !eq(p.args.replacement[0].token, WETH[o.to]) || BigInt(p.args.replacement[0].offset) !== 4n) throw bad("unexpected WETH call");
        unwrapped = true; continue;
      }
      if (p?.name === "drainLeftoverTokens") {
        // Send everything left (ETH, then any WETH) to this wallet.
        if (!eq(p.args.destination, o.me)) throw bad("leftovers go elsewhere");
        if (!unwrapped) throw bad("leftovers sent before unwrapping");
        if (eq(p.args.token, ZeroAddress)) drainedEth = true; else if (eq(p.args.token, WETH[o.to])) drainedWeth = true; else throw bad("unexpected token");
        continue;
      }
      throw bad("unknown handler step");
    }
    // Tollkit's fee, paid in ETH before the rest goes to this wallet.
    if (eq(target, o.feeRecipient) && cd === "0x" && value > 0n && unwrapped && !drainedEth) { fee += value; continue; }
    // Across's event log after the payout: no value, nothing left to move.
    if (drainedEth && value === 0n && cd.slice(0, 10) === EMIT_DATA) continue;
    throw bad(`unexpected call to ${target}`);
  }
  if (!unwrapped || !drainedEth || !drainedWeth) throw bad("the ETH isn't sent to this wallet");
  // Tollkit's fee: at most fee_bps of what arrives (rounded up by 1 wei for Across's rounding).
  if (fee > (output * BigInt(o.feeBps)) / 10_000n + 1n) throw bad("fee is more than 0.25%");
  return { output, fee, receive: output - fee };
}
