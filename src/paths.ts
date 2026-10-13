/** Where the wallet keeps its files: ~/.tollkit-wallet unless TOLLKIT_WALLET_HOME is set. */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function walletHome(dir?: string): string {
  const d = dir ?? process.env.TOLLKIT_WALLET_HOME ?? path.join(os.homedir(), ".tollkit-wallet");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const files = (dir: string) => ({
  keystore: path.join(dir, "keystore.json"),
  policy: path.join(dir, "policy.json"),
  ledger: path.join(dir, "ledger.jsonl"),
  lock: path.join(dir, ".lock"),
  sanctions: path.join(dir, "sanctions.json"),
  telegram: path.join(dir, "telegram.json"),
});
