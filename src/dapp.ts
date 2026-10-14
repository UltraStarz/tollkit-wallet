/**
 * Websites ("apps") talking to this wallet through the Tollkit browser extension.
 *
 * The extension forwards each request with the site's origin (taken by Chrome, not the page) to the dashboard
 * on this computer. Reading is answered directly; connecting, signing and sending wait for the owner to
 * approve in the dashboard's Approvals tab, showing which site asked and what it asked for. Keys never
 * leave this process. These requests don't use the agent spending limits: each one is approved by hand.
 *
 * Standards (checked 2026-10-14): EIP-1193 provider errors 4001/4100/4200/4900/4901 (eips.ethereum.org/EIPS/eip-1193),
 * EIP-1102 eth_requestAccounts, EIP-3326 wallet_switchEthereumChain, EIP-3085 wallet_addEthereumChain, EIP-2255
 * permissions, EIP-191 personal_sign, EIP-712 eth_signTypedData_v4; Solana Wallet Standard features
 * standard:connect, solana:signTransaction / signAndSendTransaction / signMessage (@solana/wallet-standard-features 1.5.0).
 */
import { createHash, createPrivateKey, randomBytes, randomUUID, sign as edSign, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Connection, PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { AbiCoder, Interface, JsonRpcProvider, MaxUint256, Transaction as EvmTx, formatEther, formatUnits, getAddress, getBytes, hexlify, isHexString, toQuantity, toUtf8String, type HDNodeWallet, type Wallet } from "ethers";
import { DEFAULT_RPC, EVM_CHAIN_ID, type Chain } from "./chains.js";
import { walletHome } from "./paths.js";
import { record } from "./ledger.js";
import type { Decision } from "./telegram.js";

type Keys = { evm: Wallet | HDNodeWallet; solana: Keypair };
export interface Site { origin: string; evm: boolean; solana: boolean; chain: "base" | "ethereum"; since: string }
interface ExtFile { tokens: { hash: string; origin: string; created: string }[]; sites: Site[] }
export class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
const rejected = () => new RpcError(4001, "You rejected this in Tollkit.");
const unauthorized = () => new RpcError(4100, "Connect this site to Tollkit first.");

const CHAIN_HEX: Record<"base" | "ethereum", string> = { base: "0x2105", ethereum: "0x1" };
const HEX_CHAIN: Record<string, "base" | "ethereum"> = { "0x2105": "base", "0x1": "ethereum" };
/** Read-only Ethereum JSON-RPC methods passed straight to the network. */
const READ = new Set(["eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getBalance", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_syncing", "web3_clientVersion"]);
/** Program names shown in approvals (each checked on mainnet as an executable account). */
const PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System", TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token", TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token", ComputeBudget111111111111111111111111111111: "Compute Budget", MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo", Stake11111111111111111111111111111111111111: "Stake",
};

const TOKEN_CALLS = new Interface(["function approve(address spender, uint256 amount)", "function transfer(address to, uint256 amount)", "function transferFrom(address from, address to, uint256 amount)", "function setApprovalForAll(address operator, bool approved)", "function increaseAllowance(address spender, uint256 addedValue)"]);
const SOL_MINTS: Record<string, string> = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };

/** Instructions that hand over control, which a balance check alone wouldn't show. */
export function solanaWarnings(vtx: VersionedTransaction): string[] {
  const keys = vtx.message.staticAccountKeys, out = new Set<string>();
  for (const ix of vtx.message.compiledInstructions) {
    const prog = keys[ix.programIdIndex]?.toBase58(), d = ix.data;
    if (prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
      if (d[0] === 4 || d[0] === 13) out.add("it lets another account spend your tokens later (token approval).");
      if (d[0] === 6) out.add("it changes who controls one of your token accounts.");
    }
    if (prog === "11111111111111111111111111111111" && d.length >= 4 && (d[0] === 1 || d[0] === 10) && d[1] === 0 && d[2] === 0 && d[3] === 0) out.add("it hands an account over to another program (Assign).");
  }
  return [...out];
}

export function normalOrigin(o: string): string {
  let u: URL;
  try { u = new URL(o); } catch { throw new RpcError(4100, "Unknown site."); }
  if (!/^[a-z0-9.-]+$/.test(u.hostname)) throw new RpcError(4100, "Unknown site.");
  if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return u.origin;
  throw new RpcError(4100, "Tollkit only connects to https sites.");
}
const shown = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + `\n…(cut here: ${s.length - n} more characters not shown)` : s);
function readable(bytes: Uint8Array): string {
  try { const t = toUtf8String(bytes); if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(t)) return t; } catch { /* not text */ }
  return hexlify(bytes);
}

export class DappBridge {
  private file: string;
  private codes = new Map<string, number>();
  private wrongCodes = 0;
  private jobs = new Map<string, { status: "pending" | "done" | "error"; result?: unknown; error?: { code: number; message: string }; at: number; origin?: string }>();
  constructor(private o: { evm: string; solana: string; keys: () => Keys; chains: () => Chain[]; dir?: string; rpc?: Partial<Record<Chain, string>>;
    approve: (text: string) => Promise<Decision>;
    /** Tests: replace network calls. */ evmRpc?: (chain: "base" | "ethereum", method: string, params: unknown[]) => Promise<unknown>;
    solConn?: Pick<Connection, "simulateTransaction" | "sendRawTransaction" | "getBalance" | "getParsedTokenAccountsByOwner">; sendEvm?: (chain: "base" | "ethereum", tx: EvmTx | Record<string, unknown>, keys: Keys) => Promise<string> }) {
    this.file = path.join(walletHome(o.dir), "extension.json");
  }

  private load(): ExtFile { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { tokens: [], sites: [] }; } catch { return { tokens: [], sites: [] }; } }
  private save(f: ExtFile) { writeFileSync(this.file, JSON.stringify(f, null, 2), { mode: 0o600 }); }

  // ---- pairing -------------------------------------------------------------------------------
  /** A one-time code the owner types into the extension (valid 5 minutes). */
  newCode(port: number): string {
    const raw = randomBytes(5).toString("hex").toUpperCase().replace(/(.{4})(.{4})(.{2})/, "$1-$2$3").slice(0, 9);
    this.codes.set(raw, Date.now() + 5 * 60_000);
    this.wrongCodes = 0;
    return `${port}-${raw}`;
  }
  pair(code: string, extOrigin: string): string {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extOrigin)) throw new Error("Pairing only works from the Tollkit extension.");
    if (this.wrongCodes >= 5) throw new Error("Too many wrong codes. Make a new one in Tollkit's Settings.");
    const c = String(code).trim().toUpperCase().replace(/^\d+-/, "");
    const exp = this.codes.get(c);
    if (!exp || exp < Date.now()) { this.wrongCodes++; throw new Error("That code is wrong or has expired."); }
    this.codes.delete(c);
    const token = randomBytes(32).toString("hex");
    const f = this.load();
    f.tokens.push({ hash: createHash("sha256").update(token).digest("hex"), origin: extOrigin, created: new Date().toISOString() });
    this.save(f);
    return token;
  }
  okToken(token: string | undefined, extOrigin: string): boolean {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const h = Buffer.from(createHash("sha256").update(token).digest("hex"));
    return this.load().tokens.some((t) => t.origin === extOrigin && t.hash.length === h.length && timingSafeEqual(Buffer.from(t.hash), h));
  }
  paired(): number { return this.load().tokens.length; }
  unpairAll() { const f = this.load(); f.tokens = []; this.save(f); }

  // ---- sites ---------------------------------------------------------------------------------
  /** Sites connected to the wallet (EVM, Solana or both). */
  sites(): Site[] { return this.load().sites.filter((s) => s.evm || s.solana); }
  site(origin: string): Site | undefined { return this.load().sites.find((s) => s.origin === origin); }
  private setSite(origin: string, patch: Partial<Site>) {
    const f = this.load();
    const cur = f.sites.find((s) => s.origin === origin);
    if (cur) Object.assign(cur, patch); else f.sites.push({ origin, evm: false, solana: false, chain: "base", since: new Date().toISOString(), ...patch });
    this.save(f);
  }
  disconnect(origin: string) { this.setSite(origin, { evm: false, solana: false }); }

  // ---- requests ------------------------------------------------------------------------------
  /** Start a request; quick ones answer at once, ones needing the owner return a job id to poll. */
  async submit(originRaw: string, method: string, params: unknown): Promise<{ result: unknown } | { id: string }> {
    const origin = normalOrigin(originRaw);
    const p = Array.isArray(params) ? params : params === undefined || params === null ? [] : [params];
    const quick = await this.quick(origin, method, p);
    if (quick.done) return { result: quick.result };
    const waiting = [...this.jobs.values()].filter((j) => j.status === "pending" && j.origin === origin).length;
    if (waiting >= 3) throw new RpcError(4001, "This site already has requests waiting in Tollkit. Answer those first.");
    if ([...this.jobs.values()].filter((j) => j.status === "pending").length >= 10) throw new RpcError(4001, "Too many requests are waiting in Tollkit. Answer those first.");
    const id = randomUUID();
    this.jobs.set(id, { status: "pending", at: Date.now(), origin });
    for (const [k, j] of this.jobs) if (Date.now() - j.at > 15 * 60_000) this.jobs.delete(k);
    void this.slow(origin, method, p).then(
      (result) => this.jobs.set(id, { status: "done", result, at: Date.now(), origin }),
      (e) => this.jobs.set(id, { status: "error", error: { code: e instanceof RpcError ? e.code : -32603, message: (e as Error).message.slice(0, 300) }, at: Date.now(), origin }),
    );
    return { id };
  }
  job(id: string) { const j = this.jobs.get(id); if (!j) throw new RpcError(-32603, "Unknown request."); return j; }

  private chainOf(origin: string): "base" | "ethereum" {
    const c = this.site(origin)?.chain ?? "base";
    const on = this.o.chains();
    return on.includes(c) ? c : on.includes("base") ? "base" : "ethereum";
  }
  private evmOk(): boolean { return this.o.chains().some((c) => c !== "solana"); }

  private async quick(origin: string, method: string, p: unknown[]): Promise<{ done: boolean; result?: unknown }> {
    const s = this.site(origin);
    const done = (result: unknown) => ({ done: true, result });
    switch (method) {
      case "eth_chainId": return done(CHAIN_HEX[this.chainOf(origin)]);
      case "net_version": return done(String(EVM_CHAIN_ID[this.chainOf(origin)]));
      case "eth_accounts": return done(s?.evm ? [this.o.evm] : []);
      case "eth_coinbase": return done(s?.evm ? this.o.evm : null);
      case "wallet_getPermissions": return done(s?.evm ? [{ parentCapability: "eth_accounts", invoker: origin }] : []);
      case "wallet_revokePermissions": this.setSite(origin, { evm: false }); return done(null);
      case "wallet_switchEthereumChain": case "wallet_addEthereumChain": {
        const want = String((p[0] as any)?.chainId ?? "").toLowerCase();
        const c = HEX_CHAIN[want];
        if (!c) throw new RpcError(4902, "Tollkit works with Base and Ethereum only.");
        if (!this.o.chains().includes(c)) throw new RpcError(4901, `${c === "base" ? "Base" : "Ethereum"} is turned off in Tollkit's settings.`);
        this.setSite(origin, { chain: c });
        return done(null);
      }
      case "eth_requestAccounts": case "wallet_requestPermissions":
        if (s?.evm) return done(method === "eth_requestAccounts" ? [this.o.evm] : [{ parentCapability: "eth_accounts", invoker: origin }]);
        return { done: false };
      case "sol_connect":
        if (s?.solana) return done(this.solAccount());
        if ((p[0] as any)?.silent) throw new RpcError(4001, "Not connected.");
        return { done: false };
      case "sol_disconnect": this.setSite(origin, { solana: false }); return done(null);
      case "eth_sign": throw new RpcError(4200, "Tollkit doesn't support eth_sign (it can sign anything). Use personal_sign.");
    }
    if (READ.has(method)) {
      if (!this.evmOk()) throw new RpcError(4900, "Base and Ethereum are turned off in Tollkit's settings.");
      return done(await this.rpc(this.chainOf(origin), method, p));
    }
    if (["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"].includes(method)) { if (!s?.evm) throw unauthorized(); return { done: false }; }
    if (["sol_signTransaction", "sol_signAndSendTransaction", "sol_signMessage"].includes(method)) { if (!s?.solana) throw unauthorized(); return { done: false }; }
    throw new RpcError(4200, `Tollkit doesn't support ${String(method).slice(0, 60)}.`);
  }

  private solAccount() { return { address: this.o.solana, publicKey: Buffer.from(new PublicKey(this.o.solana).toBytes()).toString("base64") }; }

  private rpc(chain: "base" | "ethereum", method: string, params: unknown[]): Promise<unknown> {
    if (this.o.evmRpc) return this.o.evmRpc(chain, method, params);
    return new JsonRpcProvider(this.o.rpc?.[chain] ?? DEFAULT_RPC[chain], EVM_CHAIN_ID[chain], { staticNetwork: true }).send(method, params);
  }
  private sol() { return this.o.solConn ?? new Connection(this.o.rpc?.solana ?? DEFAULT_RPC.solana, "confirmed"); }

  private meta = new Map<string, { symbol: string; decimals: number } | null>();
  private async tokenMeta(chain: "base" | "ethereum", token: string): Promise<{ symbol: string; decimals: number } | null> {
    const k = `${chain}:${token.toLowerCase()}`;
    if (this.meta.has(k)) return this.meta.get(k)!;
    let m: { symbol: string; decimals: number } | null = null;
    try {
      const [sym, dec] = await Promise.all([this.rpc(chain, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]), this.rpc(chain, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"])]);
      const symbol = String(AbiCoder.defaultAbiCoder().decode(["string"], String(sym))[0]).slice(0, 12);
      const decimals = Number(AbiCoder.defaultAbiCoder().decode(["uint8"], String(dec))[0]);
      if (/^[\w.$-]+$/.test(symbol)) m = { symbol, decimals };
    } catch { m = null; }
    this.meta.set(k, m);
    return m;
  }

  /** Plain words for the common token calls, so an approval or transfer isn't hidden behind "Calls 0x095ea7b3". */
  private async describeEvmCall(chain: "base" | "ethereum", to: string | null, data: string): Promise<string> {
    if (!data || data === "0x") return "No data (a plain ETH transfer).";
    let p: ReturnType<Interface["parseTransaction"]> = null;
    try { p = TOKEN_CALLS.parseTransaction({ data }); } catch { p = null; }
    const raw = `Calls ${data.slice(0, 10)} with ${(data.length - 2) / 2} bytes of data (not a standard token call; it does whatever the contract does).`;
    if (!p || !to) return raw;
    const m = await this.tokenMeta(chain, to);
    const tok = m ? m.symbol : `the token at ${to}`;
    const amt = (v: bigint) => (v >= MaxUint256 / 2n ? `UNLIMITED ${m?.symbol ?? "tokens"}` : m ? `${formatUnits(v, m.decimals)} ${m.symbol}` : `${v} units`);
    const a = p.args;
    switch (p.name) {
      case "approve": return `Approves ${a[0]} to spend ${amt(a[1])} of your ${tok}.${a[1] > 0n ? " Warning: that address can then move those tokens at any time without asking." : ""}`;
      case "increaseAllowance": return `Lets ${a[0]} spend ${amt(a[1])} more of your ${tok}. Warning: that address can then move those tokens without asking.`;
      case "transfer": return `Sends ${amt(a[1])} to ${a[0]}.`;
      case "transferFrom": return `Moves ${amt(a[2])} of ${tok} from ${a[0]} to ${a[1]}.`;
      case "setApprovalForAll": return a[1] ? `Gives ${a[0]} control of ALL your items in the collection at ${to}. Warning: it can move every one of them without asking.` : `Removes ${a[0]}'s control of your items in the collection at ${to}.`;
    }
    return raw;
  }

  /**
   * Simulate a Solana transaction and report what changes for this wallet: SOL, every token account of
   * this wallet that the transaction touches (plus USDC/USDT), and who controls them afterwards.
   * Inner instructions are covered because the result is read from the simulated accounts.
   */
  private async simulateSolana(vtx: VersionedTransaction, me: PublicKey): Promise<{ text: string; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const conn = this.sol();
      const held = new Map<string, { mint: string; amount: bigint; decimals: number; owner: string; delegate: string | null }>();
      for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
        const r = await conn.getParsedTokenAccountsByOwner(me, { programId: new PublicKey(prog) });
        for (const a of r.value) { const i = (a.account.data as any).parsed?.info; if (i) held.set(a.pubkey.toBase58(), { mint: i.mint, amount: BigInt(i.tokenAmount.amount), decimals: i.tokenAmount.decimals, owner: i.owner, delegate: i.delegate ?? null }); }
      }
      // Every account the transaction can touch, lookup tables included.
      const luts = [];
      for (const l of vtx.message.addressTableLookups ?? []) { const t = await (conn as any).getAddressLookupTable?.(l.accountKey); if (!t?.value) throw new Error("lookup table"); luts.push(t.value); }
      const keys = vtx.message.getAccountKeys({ addressLookupTableAccounts: luts });
      const touched = new Set<string>();
      for (let i = 0; i < keys.length; i++) { const k = keys.get(i)!.toBase58(); if (held.has(k) && vtx.message.isAccountWritable(i)) touched.add(k); }
      for (const [k, v] of held) if (SOL_MINTS[v.mint]) touched.add(k);
      const watch = [...touched].slice(0, 60);
      const before = await conn.getBalance(me);
      const r = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [me.toBase58(), ...watch] } });
      if (r.value.err) return { text: `Check: would fail (${JSON.stringify(r.value.err).slice(0, 120)}).`, warnings };
      const acc = r.value.accounts ?? [];
      const lines: string[] = [];
      const self = acc[0];
      if (self) {
        lines.push(`SOL ${((self.lamports - before) / 1e9).toFixed(6)}`);
        if (self.owner && self.owner !== "11111111111111111111111111111111") warnings.push("it hands your wallet account to another program.");
      }
      watch.forEach((addr, i) => {
        const w = held.get(addr)!, a = acc[i + 1];
        const name = SOL_MINTS[w.mint] ?? `token ${w.mint.slice(0, 4)}…${w.mint.slice(-4)}`;
        if (!a) { lines.push(`${name} -${formatUnits(w.amount, w.decimals)} (account closed)`); return; }
        const d = Buffer.from((a.data as any)[0] ?? "", "base64");
        if (d.length < 165) return;
        const now = d.readBigUInt64LE(64);
        if (now !== w.amount) lines.push(`${name} ${now > w.amount ? "+" : "-"}${formatUnits(now > w.amount ? now - w.amount : w.amount - now, w.decimals)}`);
        const owner = new PublicKey(d.subarray(32, 64)).toBase58();
        if (owner !== me.toBase58()) warnings.push(`it gives your ${name} account to ${owner}.`);
        const delegate = d.readUInt32LE(72) === 1 ? new PublicKey(d.subarray(76, 108)).toBase58() : null;
        if (delegate && delegate !== w.delegate) warnings.push(`it lets ${delegate} spend your ${name} later.`);
      });
      return { text: `Check: your balances change by ${lines.join(", ") || "nothing"}.`, warnings };
    } catch { return { text: "Check: couldn't simulate it, so the changes can't be shown. Only approve if you trust this site.", warnings }; }
  }

  private async ask(text: string) { if ((await this.o.approve(text)) !== "approved") throw rejected(); }

  private async slow(origin: string, method: string, p: unknown[]): Promise<unknown> {
    const host = new URL(origin).host;
    const keys = this.o.keys();
    switch (method) {
      case "eth_requestAccounts": case "wallet_requestPermissions":
        if (!this.evmOk()) throw new RpcError(4900, "Base and Ethereum are turned off in Tollkit's settings.");
        await this.ask(`${host} wants to connect to your wallet.\nIt will see your Base/Ethereum address ${this.o.evm} and can ask you to sign or send. Each request comes here for your OK.`);
        this.setSite(origin, { evm: true });
        return method === "eth_requestAccounts" ? [this.o.evm] : [{ parentCapability: "eth_accounts", invoker: origin }];
      case "sol_connect":
        if (!this.o.chains().includes("solana")) throw new RpcError(4900, "Solana is turned off in Tollkit's settings.");
        await this.ask(`${host} wants to connect to your wallet.\nIt will see your Solana address ${this.o.solana} and can ask you to sign or send. Each request comes here for your OK.`);
        this.setSite(origin, { solana: true });
        return this.solAccount();
      case "personal_sign": {
        const [data, addr] = p as [string, string];
        if (!isHexString(data) && typeof data !== "string") throw new RpcError(-32602, "Bad message.");
        if (addr && String(addr).toLowerCase() !== this.o.evm.toLowerCase()) throw unauthorized();
        const bytes = isHexString(data) ? getBytes(data) : new TextEncoder().encode(data);
        await this.ask(`${host} asks you to sign a message:\n\n${shown(readable(bytes))}`);
        return keys.evm.signMessage(bytes);
      }
      case "eth_signTypedData_v4": {
        const [addr, json] = p as [string, string | object];
        if (String(addr).toLowerCase() !== this.o.evm.toLowerCase()) throw unauthorized();
        let td: any;
        try { td = typeof json === "string" ? JSON.parse(json) : json; } catch { throw new RpcError(-32602, "Bad typed data."); }
        const { EIP712Domain: _d, ...types } = td?.types ?? {};
        const cid = td?.domain?.chainId !== undefined ? Number(td.domain.chainId) : null;
        const vc = td?.domain?.verifyingContract ? String(td.domain.verifyingContract) : null;
        const permit = /permit|order|approval/i.test(String(td?.primaryType ?? ""));
        await this.ask(`${host} asks you to sign data${td?.domain?.name ? ` for ${String(td.domain.name).slice(0, 60)}` : ""}:\nType: ${String(td?.primaryType ?? "").slice(0, 60)}${cid ? `\nChain: ${cid}` : ""}${vc ? `\nContract: ${vc}` : ""}\n\n${shown(JSON.stringify(td?.message ?? {}, null, 1), 4000)}${permit ? "\n\nWarning: signatures like this can let someone move your tokens without another prompt. Only approve if you started this." : ""}`);
        return keys.evm.signTypedData(td.domain ?? {}, types, td.message ?? {});
      }
      case "eth_sendTransaction": {
        const t = (p[0] ?? {}) as any;
        if (t.from && String(t.from).toLowerCase() !== this.o.evm.toLowerCase()) throw unauthorized();
        const chain = this.chainOf(origin);
        if (t.chainId !== undefined && Number(t.chainId) !== EVM_CHAIN_ID[chain]) throw new RpcError(4901, "The site asked for a different network than it's connected to.");
        const to = t.to ? getAddress(String(t.to).toLowerCase()) : null;
        const value = BigInt(t.value ?? 0), data = t.data ?? t.input ?? "0x";
        let sim = "";
        try { await this.rpc(chain, "eth_estimateGas", [{ from: this.o.evm, to, value: toQuantity(value), data }]); sim = "Check: should go through."; }
        catch (e) { sim = `Check: would fail (${(e as Error).message.slice(0, 120)}).`; }
        const what = await this.describeEvmCall(chain, to, String(data));
        await this.ask(`${host} asks you to send a transaction on ${chain === "base" ? "Base" : "Ethereum"}:\nTo ${to ?? "(new contract)"}\nValue ${formatEther(value)} ETH\n${what}\n${sim}`);
        const req: Record<string, unknown> = { to, value, data, chainId: EVM_CHAIN_ID[chain] };
        if (t.gas ?? t.gasLimit) req.gasLimit = BigInt(t.gas ?? t.gasLimit);
        const hash = this.o.sendEvm ? await this.o.sendEvm(chain, req, keys) : (await keys.evm.connect(new JsonRpcProvider(this.o.rpc?.[chain] ?? DEFAULT_RPC[chain], EVM_CHAIN_ID[chain], { staticNetwork: true })).sendTransaction(req)).hash;
        record({ id: randomUUID(), ts: new Date().toISOString(), kind: "dapp", status: "done", usd: 0, chain, seller: host, tool: "send", detail: `${formatEther(value)} ETH -> ${to ?? "new contract"} (from ${host})`, tx: hash }, this.o.dir);
        return hash;
      }
      case "sol_signTransaction": case "sol_signAndSendTransaction": {
        const b64 = String((p[0] as any)?.transaction ?? "");
        let vtx: VersionedTransaction;
        try { vtx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); } catch { throw new RpcError(-32602, "That isn't a Solana transaction."); }
        const me = new PublicKey(this.o.solana);
        const keysAll = vtx.message.staticAccountKeys;
        const signerIdx = keysAll.slice(0, vtx.message.header.numRequiredSignatures).findIndex((k) => k.equals(me));
        if (signerIdx < 0) throw new RpcError(-32602, "This transaction doesn't need this wallet's signature.");
        const progs = [...new Set(vtx.message.compiledInstructions.map((ix) => keysAll[ix.programIdIndex]?.toBase58() ?? "?"))].map((id) => PROGRAMS[id] ?? `${id.slice(0, 4)}…${id.slice(-4)}`);
        const simr = await this.simulateSolana(vtx, me);
        const sim = simr.text;
        const warn = [...new Set([...solanaWarnings(vtx), ...simr.warnings])];
        const send = method === "sol_signAndSendTransaction";
        await this.ask(`${host} asks you to ${send ? "sign and send" : "sign"} a Solana transaction:\n${vtx.message.compiledInstructions.length} instruction(s) using ${progs.join(", ")}\n${signerIdx === 0 ? "You pay the network fee." : "Another account pays the network fee."}\n${sim}${warn.length ? "\n\nWarning: " + warn.join(" ") : ""}`);
        vtx.sign([keys.solana]);
        if (!send) return { signedTransaction: Buffer.from(vtx.serialize()).toString("base64") };
        const sig = await this.sol().sendRawTransaction(vtx.serialize(), { skipPreflight: !!(p[0] as any)?.options?.skipPreflight, maxRetries: 3 });
        record({ id: randomUUID(), ts: new Date().toISOString(), kind: "dapp", status: "done", usd: 0, chain: "solana", seller: host, tool: "send", detail: `Solana transaction (from ${host})`, tx: sig }, this.o.dir);
        return { signature: Buffer.from(bs58decode(sig)).toString("base64") };
      }
      case "sol_signMessage": {
        const msg = Buffer.from(String((p[0] as any)?.message ?? ""), "base64");
        // Only readable text. Raw bytes could be a transaction in disguise (a transaction message starts with
        // a small signature count byte, or 0x80 for v0, which fail these checks).
        let text = "";
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(msg); } catch { text = "\u0000"; }
        if (!msg.length || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new RpcError(4200, "Tollkit only signs text messages on Solana.");
        await this.ask(`${host} asks you to sign a message with your Solana key:\n\n${shown(text, 2000)}`);
        const seed = Buffer.from(keys.solana.secretKey.slice(0, 32));
        const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
        return { signature: edSign(null, msg, key).toString("base64"), signedMessage: msg.toString("base64") };
      }
    }
    throw new RpcError(4200, "Unsupported.");
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
