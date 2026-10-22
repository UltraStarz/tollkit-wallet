/**
 * Live view of the wallet: balances, money coming in, and confirmations for
 * money going out. Polls public RPCs (no explorer or Tollkit server).
 *
 * Confirmations, as the chains report them:
 *   Base / Ethereum: blocks on top of the transaction's block; "final" once the
 *     chain's `finalized` block (eth_getBlockByNumber("finalized")) reaches it.
 *     On Base that is roughly half an hour behind the newest block.
 *   Solana: getSignatureStatuses -> processed / confirmed / finalized.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { formatUnits } from "ethers";
import { DEFAULT_RPC, STABLES, type Chain, CHAIN_INFO, type EvmChain } from "./chains.js";
import { walletHome } from "./paths.js";
import type { TollkitWallet } from "./wallet.js";

export type LiveStatus = "pending" | "confirmed" | "final" | "failed";
export interface LiveEvent {
  id: string;
  chain: Chain;
  direction: "in" | "out";
  token: string;
  amount: string;        // human units
  tx?: string;
  block?: number;        // EVM block / Solana slot
  from?: string;
  first_seen: string;
  status: LiveStatus;
  confirmations: number | null; // EVM: blocks; Solana: as reported (null once finalized)
  label?: string;        // e.g. "Swap", "Withdrawal" for outgoing
}
export interface Balance { token: string; amount: string }

/** Public RPCs that serve eth_getLogs (mainnet.base.org answers "request limit reached"; polygon.drpc.org limits log ranges on its free plan). Checked 2026-10-18. */
export const LOGS_RPC: Record<EvmChain, string> = { base: "https://base-rpc.publicnode.com", ethereum: "https://ethereum-rpc.publicnode.com", arbitrum: "https://arb1.arbitrum.io/rpc", polygon: "https://polygon-bor-rpc.publicnode.com" };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Program IDs as defined in @solana/spl-token (lib/esm/constants.js: TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

interface ChainState { head: number; finalized: number; balances: Map<string, bigint>; seenSigs: Set<string>; primed: boolean }

export class Watcher {
  private state = new Map<Chain, ChainState>();
  private ev: LiveEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private listeners: ((e: LiveEvent) => void)[] = [];
  private receiptBlocks = new Map<string, number | "failed">();
  readonly file: string;

  constructor(private readonly w: TollkitWallet, private readonly o: { rpc?: Partial<Record<Chain, string>>; logsRpc?: Partial<Record<EvmChain, string>>; intervalMs?: number; fetch?: typeof fetch } = {}) {
    this.file = path.join(walletHome(w.dir), "live.json");
    if (existsSync(this.file)) { try { this.ev = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.ev = []; } }
    // 0.9.2: drop Solana "deposits" saved without a transaction (left by a failed balance read; they never confirm).
    this.ev = this.ev.filter((e) => !(e.chain === "solana" && e.direction === "in" && !e.tx));
  }

  onEvent(cb: (e: LiveEvent) => void) { this.listeners.push(cb); }
  events(): LiveEvent[] { return this.ev.slice(-100).reverse(); }
  balances(): Record<string, Balance[]> {
    const out: Record<string, Balance[]> = {};
    for (const [c, s] of this.state) {
      out[c] = [...s.balances.entries()].map(([k, v]) => ({ token: this.sym(c, k), amount: formatUnits(v, this.dec(c, k)) }));
    }
    return out;
  }
  heads(): Record<string, { head: number; finalized: number }> {
    return Object.fromEntries([...this.state].map(([c, s]) => [c, { head: s.head, finalized: s.finalized }]));
  }

  start() { if (!this.timer) { void this.poll(); this.timer = setInterval(() => void this.poll(), this.o.intervalMs ?? 6000); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private rpc(c: Chain) { return this.o.rpc?.[c] ?? DEFAULT_RPC[c]; }
  private sym(c: Chain, k: string) { return k === "native" ? CHAIN_INFO[c].native : (c === "solana" ? STABLES.solana[k]?.symbol : STABLES[c][k]?.symbol) ?? k.slice(0, 6); }
  private dec(c: Chain, k: string) { return k === "native" ? (c === "solana" ? 9 : 18) : ((c === "solana" ? STABLES.solana[k]?.decimals : STABLES[c][k]?.decimals) ?? 0); }
  /** Money that arrived as the output of the wallet's own swap isn't a deposit. */
  private ownSwap(c: Chain, tx?: string): boolean {
    const recent = this.w.receipts().filter((r) => r.kind === "trade" && r.chain === c && Date.now() - Date.parse(r.ts) < 5 * 60_000);
    return tx ? recent.some((r) => r.tx === tx) || this.w.receipts().some((r) => r.tx === tx) : recent.length > 0;
  }
  private save() { try { writeFileSync(this.file, JSON.stringify(this.ev.slice(-200)), { mode: 0o600 }); } catch { /* best effort */ } }
  private emit(e: LiveEvent) { this.ev.push(e); this.save(); for (const l of this.listeners) { try { l(e); } catch { /* listener error */ } } }

  async poll() {
    this.tick++;
    await Promise.all(this.w.policy.chains.map((c) => (c === "solana" ? this.pollSolana() : this.pollEvm(c)).catch(() => { /* RPC hiccup; next tick */ })));
    this.save();
  }

  private st(c: Chain): ChainState {
    let s = this.state.get(c);
    if (!s) { s = { head: 0, finalized: 0, balances: new Map(), seenSigs: new Set(), primed: false }; this.state.set(c, s); }
    return s;
  }

  /**
   * Plain JSON-RPC with a timeout. (ethers' provider retries rate-limited
   * eth_getLogs forever, which would stall the watcher.) mainnet.base.org
   * refuses eth_getLogs, so logs use publicnode for Base and Ethereum.
   */
  private async call(url: string, method: string, params: unknown[]): Promise<any> {
    const r = await (this.o.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message ?? j.error.code}`);
    return j.result;
  }

  private async pollEvm(c: Exclude<Chain, "solana">) {
    const url = this.rpc(c), logsUrl = this.o.logsRpc?.[c] ?? LOGS_RPC[c];
    const s = this.st(c), me = this.w.addresses.evm, meTopic = "0x" + me.slice(2).toLowerCase().padStart(64, "0");
    const prevHead = s.head;
    s.head = Number(await this.call(url, "eth_blockNumber", []));
    // The finalized block only matters while something is waiting to become final.
    const waiting = this.ev.some((e) => e.chain === c && e.status !== "final" && e.status !== "failed");
    if (waiting || this.tick % 5 === 1 || !s.finalized) { const f = await this.call(url, "eth_getBlockByNumber", ["finalized", false]); if (f?.number) s.finalized = Number(f.number); }
    const next = new Map<string, bigint>([["native", BigInt(await this.call(url, "eth_getBalance", [me, "latest"]))]]);
    for (const addr of Object.keys(STABLES[c])) next.set(addr, BigInt(await this.call(url, "eth_call", [{ to: addr, data: "0x70a08231" + meTopic.slice(2) }, "latest"])));
    if (s.primed) {
      for (const [k, v] of next) {
        const before = s.balances.get(k) ?? 0n;
        if (v <= before) continue;
        let tx: string | undefined, block = s.head, from: string | undefined;
        if (k !== "native") {
          try {
            const fromBlock = "0x" + Math.max(prevHead - 2, s.head - 200).toString(16);
            const logs: any[] = await this.call(logsUrl, "eth_getLogs", [{ address: k, topics: [TRANSFER, null, meTopic], fromBlock, toBlock: "latest" }]);
            const l = logs.reverse().find((x) => !this.ev.some((e) => e.tx === x.transactionHash));
            if (l) { tx = l.transactionHash; block = Number(l.blockNumber); from = "0x" + String(l.topics[1]).slice(26); }
          } catch { /* report the amount without the hash */ }
        }
        if (this.ownSwap(c, tx)) continue; // shows as the swap's confirmation instead
        this.emit({ id: `${c}:${tx ?? k + ":" + s.head}`, chain: c, direction: "in", token: this.sym(c, k), amount: formatUnits(v - before, this.dec(c, k)), tx, block, from, first_seen: new Date().toISOString(), status: "confirmed", confirmations: s.head - block + 1 });
      }
    }
    s.balances = next; s.primed = true;
    // Outgoing: transactions the wallet sent (from the receipts ledger)
    const since = Date.now() - 24 * 3600_000;
    for (const r of this.w.receipts()) {
      if (r.chain !== c || !r.tx || !/^0x[0-9a-fA-F]{64}$/.test(r.tx) || Date.parse(r.ts) < since || r.kind === "payment") continue;
      let e = this.ev.find((x) => x.tx === r.tx);
      if (!e) { e = { id: `${c}:${r.tx}`, chain: c, direction: "out", token: "", amount: r.detail ?? "", tx: r.tx, first_seen: new Date().toISOString(), status: "pending", confirmations: 0, label: r.kind === "trade" ? "Swap" : "Withdrawal" }; this.emit(e); }
      if (e.block === undefined && e.status !== "failed") {
        let b = this.receiptBlocks.get(r.tx);
        if (b === undefined) { const rc = await this.call(url, "eth_getTransactionReceipt", [r.tx]).catch(() => null); if (rc) { b = rc.status === "0x1" ? Number(rc.blockNumber) : "failed"; this.receiptBlocks.set(r.tx, b); } }
        if (b === "failed") e.status = "failed"; else if (typeof b === "number") e.block = b;
      }
    }
    // Confirmations for everything on this chain
    for (const e of this.ev) {
      if (e.chain !== c || e.status === "final" || e.status === "failed" || e.block === undefined) continue;
      e.confirmations = Math.max(0, s.head - e.block + 1);
      e.status = s.finalized >= e.block ? "final" : e.confirmations > 0 ? "confirmed" : "pending";
    }
  }

  private async pollSolana() {
    const conn = new Connection(this.rpc("solana"), "confirmed");
    const s = this.st("solana"), owner = new PublicKey(this.w.addresses.solana);
    s.head = await conn.getSlot("confirmed");
    if (this.tick % 5 === 1 || !s.finalized) s.finalized = await conn.getSlot("finalized");
    const next = new Map<string, bigint>([["native", BigInt(await conn.getBalance(owner, "confirmed"))]]);
    const accounts = new Map<string, PublicKey>([["native", owner]]);
    for (const mint of Object.keys(STABLES.solana)) {
      const ata = ataOf(owner, new PublicKey(mint)); accounts.set(mint, ata);
      // 0.9.2: a failed read keeps the last balance. Reading it as 0 made the next good read look like a deposit of everything.
      const b = await conn.getTokenAccountBalance(ata, "confirmed").then((x) => BigInt(x.value.amount), (e) => (/could not find account|Invalid param: not a Token account/i.test(String((e as Error)?.message ?? e)) ? 0n : null));
      next.set(mint, b ?? s.balances.get(mint) ?? 0n);
    }
    if (s.primed) {
      for (const [k, v] of next) {
        const before = s.balances.get(k) ?? 0n;
        if (v <= before) continue;
        const sigs = await conn.getSignaturesForAddress(accounts.get(k)!, { limit: 5 }, "confirmed").catch(() => []);
        const sig = sigs.find((x) => !x.err && !this.ev.some((e) => e.tx === x.signature));
        if (!sig) continue; // no transaction behind it: not shown as a deposit (it could never be confirmed)
        if (this.ownSwap("solana", sig?.signature)) continue;
        this.emit({ id: `solana:${sig?.signature ?? k + ":" + s.head}`, chain: "solana", direction: "in", token: this.sym("solana", k), amount: formatUnits(v - before, this.dec("solana", k)), tx: sig?.signature, block: sig?.slot ?? s.head, first_seen: new Date().toISOString(), status: "confirmed", confirmations: 0 });
      }
    }
    s.balances = next; s.primed = true;
    const since = Date.now() - 24 * 3600_000;
    for (const r of this.w.receipts()) {
      if (r.chain !== "solana" || !r.tx || Date.parse(r.ts) < since || r.kind === "payment" || this.ev.some((e) => e.tx === r.tx)) continue;
      this.emit({ id: `solana:${r.tx}`, chain: "solana", direction: "out", token: "", amount: r.detail ?? "", tx: r.tx, first_seen: new Date().toISOString(), status: "pending", confirmations: 0, label: r.kind === "trade" ? "Swap" : "Withdrawal" });
    }
    const open = this.ev.filter((e) => e.chain === "solana" && e.tx && e.status !== "final" && e.status !== "failed");
    if (open.length) {
      const st = await conn.getSignatureStatuses(open.map((e) => e.tx!), { searchTransactionHistory: true });
      st.value.forEach((v, i) => {
        const e = open[i]!; if (!v) return;
        if (v.err) e.status = "failed";
        else { e.block = v.slot; e.confirmations = v.confirmations; e.status = v.confirmationStatus === "finalized" ? "final" : v.confirmationStatus === "confirmed" ? "confirmed" : "pending"; }
      });
    }
  }
}
