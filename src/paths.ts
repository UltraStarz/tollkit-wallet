/** Where the wallet keeps its files: ~/.tollkit-wallet unless TOLLKIT_WALLET_HOME is set. */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function walletHome(dir?: string): string {
  const d = dir ?? process.env.TOLLKIT_WALLET_HOME ?? path.join(os.homedir(), ".tollkit-wallet");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Where `tollkit-wallet password-file` saves the password so an AI app can start the MCP server. */
export const passwordFile = (dir?: string) => path.join(walletHome(dir), "password");
/** True when the wallet lives somewhere other than the default folder. */
export const customHome = (dir?: string) => path.resolve(walletHome(dir)) !== path.resolve(path.join(os.homedir(), ".tollkit-wallet"));

export const files = (dir: string) => ({
  keystore: path.join(dir, "keystore.json"),
  policy: path.join(dir, "policy.json"),
  ledger: path.join(dir, "ledger.jsonl"),
  lock: path.join(dir, ".lock"),
  sanctions: path.join(dir, "sanctions.json"),
  telegram: path.join(dir, "telegram.json"),
});
