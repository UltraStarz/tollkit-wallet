/** Moving between networks with fake Circle/Across/Tollkit responses and fake chains. No network. */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, hexlify, zeroPadValue } from "ethers";
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ACROSS_MULTICALL, ACROSS_PERIPHERY, ACROSS_SPOKE, CCTP_DOMAIN, checkAcrossDeposit, SOL_TMM, TOKEN_MESSENGER_V2, USDC, canMove, forwardHook } from "../src/bridge.js";
import { createKeystore } from "../src/keystore.js";
import { TollkitWallet } from "../src/wallet.js";
import { startDashboard } from "../src/dashboard.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };
const err = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

// Circle's documented static hook, and the Solana account-setup form
check(hexlify(forwardHook()) === "0x636374702d666f72776172640000000000000000000000000000000000000000", "forwarding hook matches Circle's documented 32 bytes");
const who = Keypair.generate().publicKey;
const ext = forwardHook(who);
check(ext.length === 65 && ext[27] === 0 && ext[31] === 33 && ext[32] === 1 && Buffer.from(ext.slice(33)).equals(who.toBuffer()), "account-setup hook: version 0, length 33, flag 1, wallet address");
check(canMove("USDC", "solana", "base") && canMove("ETH", "base", "ethereum") && !canMove("ETH", "base", "solana") && !canMove("USDC", "base", "base"), "routes: USDC anywhere, ETH Base<->Ethereum only");

const PW = "pw-move-1234567";
const dir = mkdtempSync(path.join(os.tmpdir(), "twmv-"));
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });

const FEE_EVM = "0x00000000000000000000000000000000000000fe", FEE_SOL = Keypair.generate().publicKey.toBase58();
let cfg: any = { fee_bps: 25, fee_recipient: { evm: FEE_EVM, solana: FEE_SOL }, across: true };
let across: any = null, irisMsg: any = { messages: [{ attestation: "PENDING" }] };
const urls: string[] = [];
const fakeFetch = (async (u: string) => {
  urls.push(String(u));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (/\/bridge\/config$/.test(u)) return json(cfg);
  if (/\/v2\/burn\/USDC\/fees\//.test(u)) return json([{ finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 1, med: 1_061_972, high: 2 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 1_061_972 } }]);
  if (/\/bridge\/across\?/.test(u)) return json(across);
  if (/\/v2\/messages\//.test(u)) return json(irisMsg);
  return json({}, 404);
}) as any;

const evmSent: { from: string; to: string; data: string; value?: bigint }[] = [];
let usdcBal = 500_000_000n, ethBal = 10n ** 16n, allowance = 0n, ataExists = true;
const solSent: { tx: Transaction; signers: Keypair[] }[] = [];
const solConn: any = {
  getAccountInfo: async () => (ataExists ? { lamports: 1, data: Buffer.alloc(0) } : null),
  getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(usdcBal) } } } } } }] }),
  getBalance: async () => 5e7,
};
const w = await TollkitWallet.open(PW, { dir, fetch: fakeFetch, proxy: "https://proxy.test/wallet", mover: {
  sendEvm: async (from, t) => { evmSent.push({ from, ...t }); return "0xtx" + evmSent.length; },
  evmRead: async (_from, what) => (what === "usdc" ? usdcBal : what === "eth" ? ethBal : allowance),
  sendSolana: async (tx, signers) => { solSent.push({ tx, signers }); return "soltx" + solSent.length; },
  solConn,
} });
await w.setPolicy(PW, { ...w.policy, chains: ["base", "solana", "ethereum"] });

// USDC Base -> Ethereum: fee math
const q = await w.moveQuote("USDC", "base", "ethereum", "100");
const burn = 100_000_000n - 250_000n, protocol = (burn * 1300n + 9_999_999n) / 10_000_000n, maxFee = protocol + 1_061_972n;
check(q.via === "cctp" && q.tollkit_fee === "250000" && q.burn === burn.toString() && q.max_fee === maxFee.toString() && q.receive_min === (burn - maxFee).toString(), "USDC quote: 0.25% Tollkit fee, Circle's fast fee rounded up plus forwarding", q);
check(q.mint_recipient === zeroPadValue(w.addresses.evm, 32) && q.hook === hexlify(forwardHook()) && q.eta_seconds === 8, "to an EVM network: this wallet's address, forwarding hook, ~8 s from Base");
check(urls.some((u) => /fees\/6\/0\?forward=true$/.test(u)), "asks Circle for Base(6) -> Ethereum(0) fees with forwarding");
check(/too small/.test(await err(() => w.moveQuote("USDC", "base", "ethereum", "5"))), "amounts where fees would be over 10% are refused");
check(/Base and Ethereum only/.test(await err(() => w.moveQuote("ETH", "base", "solana", "1"))), "ETH to Solana refused");

// To Solana: the USDC token account, set up by Circle if missing
ataExists = false;
const qs = await w.moveQuote("USDC", "ethereum", "solana", "50");
const ata = getAssociatedTokenAddressSync(new PublicKey(USDC.solana), new PublicKey(w.addresses.solana));
check(qs.mint_recipient === hexlify(ata.toBytes()) && qs.recipient_setup === true && getBytesLen(qs.hook!) === 65 && urls.some((u) => /fees\/0\/5\?forward=true&includeRecipientSetup=true/.test(u)), "to Solana: mints to this wallet's USDC account, asks Circle to create it when missing");
ataExists = true;
function getBytesLen(h: string) { return (h.length - 2) / 2; }

// Server can't raise the fee
cfg = { ...cfg, fee_bps: 100 }; (w.mover() as any).cfg = null;
check(/at most 0.25%/.test(await err(() => w.moveQuote("USDC", "base", "ethereum", "100"))), "a server asking for more than 0.25% is refused");
cfg = { ...cfg, fee_bps: 25 }; (w.mover() as any).cfg = null;

// Execute from Base: exact approve to Circle, burn, then the fee
check(/wrong password/.test(await err(() => w.move("nope", "USDC", "base", "ethereum", "100"))), "move needs the password");
const r = await w.move(PW, "USDC", "base", "ethereum", "100");
const erc = new Interface(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const tm = new Interface(["function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)"]);
const [ap, dep, fee] = evmSent;
const apd = erc.decodeFunctionData("approve", ap!.data), dd = tm.decodeFunctionData("depositForBurnWithHook", dep!.data), fd = erc.decodeFunctionData("transfer", fee!.data);
check(getAddress(ap!.to) === getAddress(USDC.base) && apd[0] === TOKEN_MESSENGER_V2 && apd[1] === burn, "approves exactly the burn amount, only to Circle's TokenMessengerV2");
check(dep!.to === TOKEN_MESSENGER_V2 && dd.amount === burn && Number(dd.destinationDomain) === CCTP_DOMAIN.ethereum && dd.mintRecipient === zeroPadValue(w.addresses.evm, 32) && getAddress(dd.burnToken) === getAddress(USDC.base) && BigInt(dd.destinationCaller) === 0n && dd.maxFee === maxFee && Number(dd.minFinalityThreshold) === 1000 && dd.hookData === hexlify(forwardHook()), "burn: right amount, domain, recipient, fee cap, fast, forwarding");
check(getAddress(fee!.to) === getAddress(USDC.base) && getAddress(fd[0]) === getAddress(FEE_EVM.toLowerCase()) && fd[1] === 250_000n, "Tollkit's 0.25% sent after the burn");
check(r.move.state === "sent" && w.receipts().at(-1)!.kind === "move" && w.receipts().at(-1)!.status === "done", "recorded in Activity and tracked");
allowance = 10n ** 12n; evmSent.length = 0;
await w.move(PW, "USDC", "base", "ethereum", "100");
check(evmSent.length === 2 && evmSent[0]!.to === TOKEN_MESSENGER_V2, "no new approval when one is already in place");
usdcBal = 1_000_000n;
check(/less than/.test(await err(() => w.move(PW, "USDC", "base", "ethereum", "100"))) && w.receipts().at(-1)!.status === "failed", "not enough USDC: refused before signing, recorded as failed");
usdcBal = 500_000_000n; ethBal = 0n;
check(/needs a little ETH/.test(await err(() => w.move(PW, "USDC", "base", "ethereum", "100"))), "no ETH for network fees: says so");
ethBal = 10n ** 16n;

// From Solana: fee transfer + CCTP burn in one transaction
await w.move(PW, "USDC", "solana", "base", "100");
const st = solSent.at(-1)!;
const progs = st.tx.instructions.map((i) => i.programId.toBase58());
const cctpIx = st.tx.instructions.at(-1)!;
check(progs.at(-1) === SOL_TMM.toBase58() && progs.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), "Solana: fee transfer and CCTP burn in the same transaction");
check(Buffer.from(cctpIx.data.subarray(0, 8)).equals(Buffer.from([111, 245, 62, 131, 204, 108, 223, 155])) && cctpIx.data.readUInt32LE(16) === CCTP_DOMAIN.base && st.signers.length === 2 && cctpIx.keys[11]!.pubkey.equals(st.signers[1]!.publicKey), "Solana burn: Circle's instruction, to Base, with a fresh event account signer");
check(cctpIx.data.readBigUInt64LE(8) === burn && cctpIx.keys[0]!.pubkey.toBase58() === w.addresses.solana && cctpIx.keys[3]!.pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(USDC.solana), new PublicKey(w.addresses.solana))), "burns the right amount from this wallet's own USDC account");

// ETH via Across: everything we sign is checked
// The real Across answer (0.1 ETH Base -> Ethereum) decodes to exactly what Across said you'd get.
const fx = JSON.parse(readFileSync(new URL("./fixtures/across-base-eth.json", import.meta.url), "utf8"));
const FXME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const real = checkAcrossDeposit(fx.swapTx.data, { from: "base", to: "ethereum", amount: BigInt(fx.inputAmount), me: FXME, feeRecipient: FXME, feeBps: 25 });
check(real.receive === BigInt(fx.minOutputAmount) && real.fee > 0n && real.fee * 10_000n <= real.output * 25n + 10_000n, "real Across calldata: decoded amount matches Across's own minimum; fee within 0.25%", real);

// Build deposits the way Across does (SpokePoolPeriphery.depositNative + MulticallHandler instructions).
const PERI = new Interface(["function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable"]);
const HND = new Interface(["function makeCallWithBalance(address target, bytes callData, uint256 value, tuple(address token, uint256 offset)[] replacement)", "function drainLeftoverTokens(address token, address destination)"]);
const WETH_B = "0x4200000000000000000000000000000000000006", WETH_E = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AMT = 50_000_000_000_000_000n, OUT = 49_950_000_000_000_000n, FEE = (OUT * 25n) / 10_000n;
const deposit = (o: { recipient?: string; out?: bigint; fee?: bigint; feeTo?: string; drainTo?: string; extra?: [string, string, bigint]; offset?: bigint; noWethDrain?: boolean } = {}) => {
  const me = w.addresses.evm;
  const calls: [string, string, bigint][] = [
    [ACROSS_MULTICALL, HND.encodeFunctionData("makeCallWithBalance", [WETH_E, new Interface(["function withdraw(uint256)"]).encodeFunctionData("withdraw", [0]), 0, [[WETH_E, o.offset ?? 4n]]]), 0n],
    [o.feeTo ?? FEE_EVM, "0x", o.fee ?? FEE],
    ...(o.extra ? [o.extra] : []),
    [ACROSS_MULTICALL, HND.encodeFunctionData("drainLeftoverTokens", [ZeroAddress, o.drainTo ?? me]), 0n],
    ...(o.noWethDrain ? [] : [[ACROSS_MULTICALL, HND.encodeFunctionData("drainLeftoverTokens", [WETH_E, o.drainTo ?? me]), 0n] as [string, string, bigint]]),
  ];
  const msg = AbiCoder.defaultAbiCoder().encode(["tuple(tuple(address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)"], [[calls, ZeroAddress]]);
  return PERI.encodeFunctionData("depositNative", [ACROSS_SPOKE.base, me, zeroPadValue((o.recipient ?? ACROSS_MULTICALL).toLowerCase(), 32), WETH_B, AMT, zeroPadValue(WETH_E.toLowerCase(), 32), o.out ?? OUT, 1, ZeroHash, 1, 2, 0, msg]);
};
const goodAcross = (data = deposit()) => ({ inputAmount: AMT.toString(), minOutputAmount: "1", expectedFillTime: 8, approvalTxns: null, swapTx: { to: ACROSS_PERIPHERY, chainId: 8453, value: AMT.toString(), data } });
across = goodAcross();
const qa = await w.moveQuote("ETH", "base", "ethereum", "0.05");
check(qa.via === "across" && qa.receive_min === (OUT - FEE).toString() && qa.tollkit_fee === FEE.toString() && qa.tx!.to === ACROSS_PERIPHERY, "ETH quote: amounts come from the decoded transaction, not the server's numbers", qa);
const ATTACKER = "0x00000000000000000000000000000000000000aa";
for (const [bad, why] of [
  [{ ...goodAcross(), swapTx: { ...goodAcross().swapTx, to: "0x000000000000000000000000000000000000dEaD" } }, "isn't Across's contract"],
  [{ ...goodAcross(), swapTx: { ...goodAcross().swapTx, value: "1" } }, "doesn't match the amount"],
  [{ ...goodAcross(), approvalTxns: [{}] }, "approval"],
  [{ ...goodAcross(), swapTx: { ...goodAcross().swapTx, chainId: 1 } }, "wrong network"],
  [goodAcross(deposit({ recipient: ATTACKER })), "recipient isn't this wallet"],
  [goodAcross(deposit({ drainTo: ATTACKER })), "leftovers go elsewhere"],
  [goodAcross(deposit({ feeTo: ATTACKER })), "unexpected call"],
  [goodAcross(deposit({ fee: FEE * 3n })), "more than 0.25%"],
  [goodAcross(deposit({ extra: [ATTACKER, "0x", 1n] })), "unexpected call"],
  [goodAcross(deposit({ out: 40_000_000_000_000_000n, fee: 1n })), "over 3%"],
  [goodAcross("0xabcdef"), "not an Across ETH deposit"],
  [goodAcross(deposit({ offset: 0n })), "unexpected WETH call"],
  [goodAcross(deposit({ noWethDrain: true })), "isn't sent to this wallet"],
] as const) {
  across = bad;
  check(new RegExp(why).test(await err(() => w.moveQuote("ETH", "base", "ethereum", "0.05"))), `Across route refused: ${why}`);
}
across = goodAcross(); evmSent.length = 0;
await w.move(PW, "ETH", "base", "ethereum", "0.05");
check(/price changed/.test(await err(() => w.move(PW, "ETH", "base", "ethereum", "0.05", (OUT - FEE + 1n).toString()))), "a fresh quote worse than the one shown is refused");
check(evmSent.length === 1 && evmSent[0]!.to === ACROSS_PERIPHERY && evmSent[0]!.value === AMT, "ETH move: one transaction to Across with exactly the amount");

// Tracking: Circle reports the mint on the destination
irisMsg = { messages: [{ attestation: "0x01", forwardTxHash: "0xdest" }] };
const after = await w.mover().refresh();
check(after.some((m) => m.via === "cctp" && m.state === "arrived" && m.dest_tx === "0xdest"), "USDC move marked arrived when Circle's forwarder has minted it");

// Dashboard
const dash = await startDashboard(w, PW, { port: 17452, watch: false, autopilot: false, connectApps: false, ai: false, holdings: false });
const tok = new URL(dash.url).searchParams.get("t")!;
const call = async (p: string, body?: unknown) => { const res = await fetch(`http://127.0.0.1:17452${p}`, { method: body ? "POST" : "GET", headers: { "x-tw-token": tok, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, j: await res.json() as any }; };
const gq = await call("/api/move/quote?asset=USDC&from=base&to=solana&amount=40");
check(gq.status === 200 && gq.j.via === "cctp" && gq.j.tollkit_fee === "100000", "dashboard: quote", gq.j);
check((await call("/api/moves")).j.moves.length >= 3, "dashboard: recent moves");
check((await call("/api/move", { password: "x", asset: "USDC", from: "base", to: "solana", amount: "40" })).status === 403, "dashboard: wrong password refused");
check((await call("/api/move", { password: PW, asset: "USDC", from: "base", to: "solana", amount: "40" })).status === 400, "dashboard: moving needs the quote the owner saw");
await dash.close();

console.log(`\nbridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
