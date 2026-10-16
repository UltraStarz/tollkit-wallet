/** How the owner wants to trade, picked once on first run: with AI (chat and connected AI apps) or with their own Python bots. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { walletHome } from "./paths.js";

export type TradeMode = "ai" | "python";
const file = (dir?: string) => path.join(walletHome(dir), "trade-mode.json");

export function tradeMode(dir?: string): TradeMode | null {
  try { if (existsSync(file(dir))) { const m = JSON.parse(readFileSync(file(dir), "utf8")).mode; if (m === "ai" || m === "python") return m; } } catch { /* unset */ }
  return null;
}
export function setTradeMode(mode: unknown, dir?: string): TradeMode {
  if (mode !== "ai" && mode !== "python") throw new Error("mode must be ai or python");
  writeFileSync(file(dir), JSON.stringify({ mode, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return mode;
}
