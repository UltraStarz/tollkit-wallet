/**
 * The in-app chat's paid tools (Nov 12; Joe: "it needs to use any tollkit tool"): tollkit_tools lists Tollkit's tools
 * with prices and tollkit_call runs one. Each call is an ordinary x402 payment by "Tollkit AI": the owner's payment
 * limits, its weekly budget, the seller check and the receipt all apply; hidden tools are never offered.
 *
 * Nov 16 (App Review, guideline 5.6): this whole file is left out of the iPhone app. Its build swaps it for
 * paid-tools-none.ts, so none of this code or wording ships there (tollkit-mobile/build.mjs --ios).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TollkitWallet } from "./wallet.js";
import { offeredTools, refreshCatalog, TOOL_PREFIX } from "./tollkit-tools.js";
import { noteAiUse } from "./aiuse.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

/** What the chat is told about them (a line of its instructions, and what it may pay for). */
export const PAID_PROMPT_LINE = "- use any Tollkit tool (tollkit_tools lists them with prices; tollkit_call runs one): token info, price and a safety check for any token by address, someone else's wallet, a transaction, a web page or search, company and SEC data, and more. Each call is paid from this wallet inside the owner's limits (usually $0.001 to $0.02); use held_tokens first for coins they hold, call a paid tool only when it adds something, and say what it cost\n";
export const PAID_PROMPT_CLAUSE = ", and the only payments you make are Tollkit tool calls,";

export function registerPaidTools(s: McpServer, w: TollkitWallet) {
  void refreshCatalog(w.dir, (w as any).f);
  s.registerTool("tollkit_tools", {
    title: "Tollkit tools",
    description: "List Tollkit's paid tools you can call with tollkit_call: token info, prices and safety checks for any token, wallet portfolios, transaction lookups, web pages and search, company and SEC data, weather, exchange rates and more. Each has a price in USD (usually $0.001 to $0.02), paid from this wallet inside the owner's limits.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json({ tools: offeredTools(w.dir).map((t) => ({ name: t.name, title: t.title, price_usd: t.price_usd, description: t.description.slice(0, 220), input_schema: t.input_schema })) }));
  s.registerTool("tollkit_call", {
    title: "Call a Tollkit tool",
    description: "Run one of Tollkit's paid tools by name (see tollkit_tools) with its input. Pays the tool's price from this wallet, inside the owner's limits; a failed call is never charged. Tell the owner what it cost.",
    inputSchema: { tool: z.string().describe("The tool's name from tollkit_tools, e.g. token_info"), input: z.record(z.string(), z.unknown()).optional().describe("The tool's input, matching its input_schema") },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  }, async (args: any) => {
    const name = String(args?.tool ?? "").replace(new RegExp("^" + TOOL_PREFIX), "");
    const t = offeredTools(w.dir).find((x) => x.name === name);
    if (!t) return json({ ok: false, refused: { code: "unknown_tool", reason: `No Tollkit tool called "${name}". Call tollkit_tools for the list.` } });
    noteAiUse(w.dir, "Tollkit AI", TOOL_PREFIX + t.name);
    const r = await w.pay(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args?.input ?? {}) }, { publicOnly: true, by: "Tollkit AI" });
    let result: unknown;
    if (r.response) { const text = await r.response.text(); try { result = JSON.parse(text); } catch { result = text.slice(0, 50_000); } }
    return json({ tool: t.name, paid: r.paid, cost_usd: r.offer?.usd ?? (r.paid ? t.price_usd : 0), status: r.status, receipt_id: r.receipt_id, refused: r.refused, result });
  });
}
