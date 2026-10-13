/**
 * Spending rules the agent can't change through the wallet's tools. The file
 * is sealed with an HMAC keyed from the owner's password, so an edited file is
 * refused (the wallet then stops spending until the owner re-saves it).
 * Limits are in US dollars; token amounts are priced before checking.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { files, walletHome } from "./paths.js";

export const PolicySchema = z.object({
  per_trade_usd: z.number().positive(),
  daily_trades_usd: z.number().positive(),
  per_payment_usd: z.number().positive(),
  daily_payments_usd: z.number().positive(),
  per_seller_daily_usd: z.number().positive(),
  approval_above_usd: z.number().nonnegative(),
  max_slippage_bps: z.number().int().min(1).max(1000),
  chains: z.array(z.enum(["base", "ethereum", "solana"])).min(1),
  block_seller_warnings: z.boolean(),
  /** Autopilot rules an agent proposes: "propose" waits for the owner to turn each on; "auto" turns them on at once (limits still apply). */
  agent_rules: z.enum(["propose", "auto"]).default("propose"),
  /** The only places the owner can withdraw to. Sealed with the rest, so adding one needs the password. */
  withdraw_addresses: z.array(z.object({
    chain: z.enum(["base", "ethereum", "solana"]),
    address: z.string().min(32),
    label: z.string().max(40).default(""),
  })).max(20).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  per_trade_usd: 50,
  daily_trades_usd: 200,
  per_payment_usd: 0.25,
  daily_payments_usd: 5,
  per_seller_daily_usd: 2,
  approval_above_usd: 25,
  max_slippage_bps: 100,
  // Ethereum is off until the owner turns it on: its network fees can eat small trades.
  chains: ["base", "solana"],
  block_seller_warnings: true,
  agent_rules: "propose",
  withdraw_addresses: [],
};

interface PolicyFile { version: 1; salt: string; policy: Policy; mac: string }

/** The HMAC key for policy.json, derived from the owner's password. */
export function policyKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, Buffer.concat([Buffer.from("tollkit-wallet/policy/"), salt]), 32, { N: 1 << 14, r: 8, p: 1 });
}

const macOf = (key: Buffer, policy: Policy) => createHmac("sha256", key).update(JSON.stringify(policy)).digest("hex");

export function savePolicy(password: string, policy: Policy, dir?: string): Policy {
  const p = PolicySchema.parse(policy);
  const f = files(walletHome(dir));
  const salt = existsSync(f.policy) ? Buffer.from((JSON.parse(readFileSync(f.policy, "utf8")) as PolicyFile).salt, "hex") : randomBytes(16);
  const file: PolicyFile = { version: 1, salt: salt.toString("hex"), policy: p, mac: macOf(policyKey(password, salt), p) };
  const tmp = f.policy + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, f.policy);
  return p;
}

/** Load and verify. Throws if the file was edited outside `savePolicy`. */
export function loadPolicy(password: string, dir?: string): Policy {
  const f = files(walletHome(dir));
  if (!existsSync(f.policy)) return savePolicy(password, DEFAULT_POLICY, dir);
  const file = JSON.parse(readFileSync(f.policy, "utf8")) as PolicyFile;
  const expect = Buffer.from(macOf(policyKey(password, Buffer.from(file.salt, "hex")), file.policy), "hex");
  const got = Buffer.from(file.mac ?? "", "hex");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    throw new Error("policy.json was changed outside the wallet; spending is paused. Re-save it with `tollkit-wallet budget`.");
  }
  return PolicySchema.parse(file.policy);
}
