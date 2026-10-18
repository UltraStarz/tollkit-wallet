/**
 * MCP server (stdio) so any agent (Claude, Cursor, ElizaOS via MCP, etc.) can
 * use the wallet. The agent can quote, swap, pay and read receipts, always
 * within the owner's limits. It has no tool to change limits, approvals or
 * keys; those need the owner's password in the CLI or dashboard.
 *
 * Password: TOLLKIT_WALLET_PASSWORD, or a file named by TOLLKIT_WALLET_PASSWORD_FILE.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TollkitWallet } from "./wallet.js";
import { ACTIONS, SWAP_PROPOSE, proposeRules } from "./actions.js";

/** The only tools the wallet's built-in AI chat gets: read, look at prices, suggest rules for the owner to turn on, and suggest one-off swaps for the owner to approve. */
export const ADVISOR_TOOLS = ["wallet_status", "wallet_balances", "swap_quote", "receipts", "market_prices", "price_history", "autopilot_rules", "autopilot_propose", "swap_propose", "paper_status"];

export const VERSION = "0.5.2";

export function passwordFromEnv(): string {
  const file = process.env.TOLLKIT_WALLET_PASSWORD_FILE;
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  const pw = process.env.TOLLKIT_WALLET_PASSWORD;
  if (!pw) throw new Error("Set TOLLKIT_WALLET_PASSWORD or TOLLKIT_WALLET_PASSWORD_FILE so the wallet can unlock.");
  return pw;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function buildServer(w: TollkitWallet, o: { advisor?: boolean } = {}): McpServer {
  const s = new McpServer({ name: "tollkit-wallet", version: VERSION });
  for (const a of o.advisor ? [...ACTIONS, SWAP_PROPOSE] : ACTIONS) {
    if (o.advisor && !ADVISOR_TOOLS.includes(a.name)) continue;
    // In advisor mode suggestions always wait for the owner, whatever agent_rules says.
    const run = o.advisor && a.name === "autopilot_propose" ? (ww: TollkitWallet, args: any) => proposeRules(ww, args, { neverAuto: true }) : a.run;
    s.registerTool(a.name, {
      description: a.description,
      inputSchema: (a.schema as any).shape,
      annotations: a.spends ? { destructiveHint: true, openWorldHint: true, idempotentHint: false }
        : /^(autopilot_(propose|cancel)|swap_propose)$/.test(a.name) ? { readOnlyHint: false, destructiveHint: a.name === "autopilot_propose", openWorldHint: true }
        : { readOnlyHint: true, openWorldHint: !["wallet_status", "receipts", "autopilot_rules", "paper_status"].includes(a.name) },
    }, async (args: any) => json(await (run as any)(w, args ?? {})));
  }
  return s;
}

export async function serveStdio(o: { dir?: string; advisor?: boolean } = {}) {
  const w = await TollkitWallet.open(passwordFromEnv(), { dir: o.dir });
  await buildServer(w, { advisor: o.advisor }).connect(new StdioServerTransport());
}
