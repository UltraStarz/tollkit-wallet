/**
 * Permission slips ("delegations") for MetaMask's Delegation Framework v1.3.0, the audited contracts Tollkit uses
 * to let its server trade while the app is closed (src/alwayson.ts). The user's own address is upgraded with
 * EIP-7702 to EIP7702StatelessDeleGator, so it keeps its address and its key stays the only owner; each slip names
 * Tollkit's server key as the delegate and lists the rules ("caveats") the chain enforces on every trade.
 *
 * Encodings follow @metamask/delegation-core (checked byte-for-byte in test/alwayson.test.ts); contract addresses
 * are @metamask/delegation-deployments 1.3.0, the same on Ethereum, Base, Arbitrum One and Polygon
 * (github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md).
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, pad, toHex, type Hex } from "viem";
import type { Wallet, HDNodeWallet } from "ethers";

export const DF = {
  DelegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  EIP7702StatelessDeleGatorImpl: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
  AllowedTargetsEnforcer: "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB",
  AllowedMethodsEnforcer: "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5",
  ValueLteEnforcer: "0x92Bf12322527cAA612fd31a0e810472BBB106A8F",
  ERC20BalanceChangeEnforcer: "0xcdF6aB796408598Cea671d79506d7D48E97a5437",
  NativeBalanceChangeEnforcer: "0xbD7B277507723490Cd50b12EaaFe87C616be6880",
  TimestampEnforcer: "0x1046bb45C8d673d4ea75321280DB34899413c069",
  LimitedCallsEnforcer: "0x04658B29F6b82ed55274221a06Fc97D318E25416",
  ExactCalldataEnforcer: "0x99F2e9bF15ce5eC84685604836F71aB835DBBdED",
  NonceEnforcer: "0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f",
  AllowedCalldataEnforcer: "0xc2b0d624c1c4319760C96503BA27C347F3260f55",
} as const;
export const ROOT_AUTHORITY: Hex = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
/** ERC-7579 "single call, revert on failure" execution mode. */
export const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
/** 0x AllowanceHolder (the only contract a trade slip can call) and its `exec` selector. */
export const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
export const EXEC_SELECTOR: Hex = "0x2213bc0b";

export interface Caveat { enforcer: Hex; terms: Hex; args: Hex }
export interface Delegation { delegate: Hex; delegator: Hex; authority: Hex; caveats: Caveat[]; salt: bigint; signature: Hex }

const u = (v: bigint | number, bytes: number) => pad(toHex(BigInt(v)), { size: bytes });
const lc = (a: string) => getAddress(a).toLowerCase() as Hex;
const cav = (enforcer: string, terms: Hex): Caveat => ({ enforcer: getAddress(enforcer) as Hex, terms, args: "0x" });

/** The rule builders, one per enforcer (term layouts as in @metamask/delegation-core). */
export const C = {
  targets: (targets: string[]) => cav(DF.AllowedTargetsEnforcer, concatHex(targets.map((t) => getAddress(t) as Hex))),
  methods: (selectors: Hex[]) => cav(DF.AllowedMethodsEnforcer, concatHex(selectors)),
  valueLte: (max: bigint) => cav(DF.ValueLteEnforcer, u(max, 32)),
  /** change: 0 = must increase by at least `amount`, 1 = may decrease by at most `amount`. */
  erc20Change: (token: string, recipient: string, amount: bigint, change: 0 | 1) => cav(DF.ERC20BalanceChangeEnforcer, concatHex([u(change, 1), lc(token), lc(recipient), u(amount, 32)])),
  nativeChange: (recipient: string, amount: bigint, change: 0 | 1) => cav(DF.NativeBalanceChangeEnforcer, concatHex([u(change, 1), lc(recipient), u(amount, 32)])),
  /** Valid strictly after `after` and before `before` (unix seconds; 0 = no bound). */
  timestamp: (after: number, before: number) => cav(DF.TimestampEnforcer, concatHex([u(after, 16), u(before, 16)])),
  limitedCalls: (n: number) => cav(DF.LimitedCallsEnforcer, u(n, 32)),
  exactCalldata: (data: Hex) => cav(DF.ExactCalldataEnforcer, data),
  nonce: (n: bigint) => cav(DF.NonceEnforcer, u(n, 32)),
  /** These exact bytes at this calldata offset (e.g. pin exec's token and amount). */
  calldata: (startIndex: number, value: Hex) => cav(DF.AllowedCalldataEnforcer, concatHex([u(startIndex, 32), value])),
};
/**
 * AllowanceHolder.exec(operator, token, amount, target, data): pins `token` and `amount` (bytes 36-100), so a slip
 * can only ever lend 0x the one token and amount it was signed for (0x uses token 0x0 with msg.value for ETH).
 */
export const pinExec = (token: string, amount: bigint) => C.calldata(36, encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(token), amount]));

const DELEGATION_TUPLE = { type: "tuple[]", components: [
  { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
  { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
  { name: "salt", type: "uint256" }, { name: "signature", type: "bytes" },
] } as const;
/** The `permissionContext` the DelegationManager takes: abi.encode(Delegation[]). */
export const encodeDelegations = (ds: Delegation[]): Hex => encodeAbiParameters([DELEGATION_TUPLE], [ds as any]);
/** One ERC-7579 single execution: target ++ value ++ calldata. */
export const execution = (to: string, data: Hex, value = 0n): Hex => encodePacked(["address", "uint256", "bytes"], [getAddress(to), value, data]);

export const DM_ABI = [
  { type: "function", name: "redeemDelegations", stateMutability: "nonpayable", inputs: [{ name: "_permissionContexts", type: "bytes[]" }, { name: "_modes", type: "bytes32[]" }, { name: "_executionCallDatas", type: "bytes[]" }], outputs: [] },
] as const;
/** What the server sends to the DelegationManager to use one slip for one call. */
export const redeemCalldata = (d: Delegation, to: string, data: Hex, value = 0n): Hex =>
  encodeFunctionData({ abi: DM_ABI, functionName: "redeemDelegations", args: [[encodeDelegations([d])], [MODE_SINGLE], [execution(to, data, value)]] });

export const NONCE_ABI = [
  { type: "function", name: "currentNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "incrementNonce", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;
/** Calldata that kills every slip carrying the current nonce, when the user's account makes the call. */
export const bumpNonceCalldata = (): Hex => encodeFunctionData({ abi: NONCE_ABI, functionName: "incrementNonce", args: [DF.DelegationManager] });

const TYPES = {
  Delegation: [{ name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" }, { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" }],
  Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
};

/** The user's key signs a slip naming `delegate`; the stateless 7702 account accepts only its own key's signature. */
export async function signDelegation(key: Wallet | HDNodeWallet, chainId: number, delegate: string, caveats: Caveat[], salt: bigint = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))): Promise<Delegation> {
  const d: Delegation = { delegate: getAddress(delegate) as Hex, delegator: getAddress(key.address) as Hex, authority: ROOT_AUTHORITY, caveats, salt, signature: "0x" };
  d.signature = (await key.signTypedData(
    { name: "DelegationManager", version: "1", chainId, verifyingContract: DF.DelegationManager },
    TYPES,
    { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: caveats.map(({ enforcer, terms }) => ({ enforcer, terms })), salt: d.salt },
  )) as Hex;
  return d;
}

/** JSON-safe form (salt as a string) for sending slips to the server. */
export const slipJson = (d: Delegation) => ({ ...d, salt: d.salt.toString() });
export const slipFromJson = (j: any): Delegation => ({ ...j, salt: BigInt(j.salt) });
