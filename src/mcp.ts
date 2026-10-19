/**
 * MCP server (stdio) so any agent (Claude, Cursor, ElizaOS via MCP, etc.) can
 * use the wallet. The agent can quote, swap, pay and read receipts, always
 * within the owner's limits, and (0.8.0) set up anything the owner can set up
 * in the app: bots, tokens, Keep running when closed. It has no tool to change
 * limits, move funds, connect apps or reveal keys; for those it files a setup
 * request that the owner applies in the app, password and all.
 *
 * Password: TOLLKIT_WALLET_PASSWORD, or a file named by TOLLKIT_WALLET_PASSWORD_FILE.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TollkitWallet } from "./wallet.js";
import { ACTIONS, SWAP_PROPOSE, type ActionCtx } from "./actions.js";
import { appName, noteAiUse } from "./aiuse.js";
import { describeTool, offeredTools, refreshCatalog, zodShape, TOOL_PREFIX } from "./tollkit-tools.js";

/** The `_meta` key Tollkit's relay uses to say which AI app sent a call that came in by the connector address. */
export const CLIENT_META = "dev.tollkit/client";

/**
 * The tools the wallet's built-in AI chat gets: read, look at prices, suggest rules and one-off swaps for the owner
 * to approve, and (0.8.0) the same setup tools a connected app has. It never trades or pays on its own.
 */
export const ADVISOR_TOOLS = ["wallet_status", "wallet_balances", "swap_quote", "receipts", "market_prices", "price_history", "autopilot_rules", "autopilot_propose", "swap_propose", "paper_status",
  "bot_templates", "bot_preview", "bot_start", "bots_status", "bot_control", "token_search", "token_check", "token_add", "token_hide", "always_on", "move_quote", "stake_info", "buy_link",
  "setup_request", "setup_requests", "setup_cancel"];

export const VERSION = "0.8.4";

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
    const sets = a.sets || /^(autopilot_(propose|cancel)|swap_propose)$/.test(a.name);
    s.registerTool(a.name, {
      description: a.description,
      inputSchema: (a.schema as any).shape,
      annotations: a.spends ? { destructiveHint: true, openWorldHint: true, idempotentHint: false }
        : sets ? { readOnlyHint: false, destructiveHint: /^(autopilot_propose|bot_start|bot_control|always_on|token_hide)$/.test(a.name), openWorldHint: true }
        : { readOnlyHint: true, openWorldHint: !["wallet_status", "receipts", "autopilot_rules", "paper_status", "bots_status", "bot_templates", "setup_requests"].includes(a.name) },
    }, async (args: any, extra: any) => {
      // Which app is asking: the relay says so for connector-address calls; a local app names itself when it connects.
      const app = o.advisor ? "Tollkit AI" : appName(extra?._meta?.[CLIENT_META] ?? s.server.getClientVersion()?.name);
      noteAiUse(w.dir, app, a.name);
      // The app's name travels with the call: receipts say "by Claude", and its weekly budget applies. In advisor
      // mode suggestions always wait for the owner, whatever agent_rules says.
      const ctx: ActionCtx = { app, advisor: !!o.advisor };
      return json(await (a.run as any)(w, args ?? {}, ctx));
    });
  }
  // 0.8.1: Tollkit's own paid tools, by name, for connected apps (src/tollkit-tools.ts). Not for the in-app chat:
  // the owner talks to it about their money, not the web. The catalog refreshes in the background for next time.
  if (!o.advisor) {
    void refreshCatalog(w.dir, (w as any).f);
    for (const t of offeredTools(w.dir)) {
      s.registerTool(TOOL_PREFIX + t.name, {
        title: t.title,
        description: describeTool(t),
        inputSchema: zodShape(t.input_schema),
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
      }, async (args: any, extra: any) => {
        const app = appName(extra?._meta?.[CLIENT_META] ?? s.server.getClientVersion()?.name);
        noteAiUse(w.dir, app, TOOL_PREFIX + t.name);
        const r = await w.pay(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}) }, { publicOnly: true, by: app });
        let result: unknown;
        if (r.response) { const text = await r.response.text(); try { result = JSON.parse(text); } catch { result = text.slice(0, 50_000); } }
        return json({ tool: t.name, paid: r.paid, cost_usd: r.offer?.usd ?? (r.paid ? t.price_usd : 0), status: r.status, receipt_id: r.receipt_id, tx: r.tx, refused: r.refused, result });
      });
    }
  }
  return s;
}

export async function serveStdio(o: { dir?: string; advisor?: boolean } = {}) {
  const w = await TollkitWallet.open(passwordFromEnv(), { dir: o.dir });
  await buildServer(w, { advisor: o.advisor }).connect(new StdioServerTransport());
}
