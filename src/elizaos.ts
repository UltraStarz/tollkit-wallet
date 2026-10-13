/**
 * ElizaOS plugin (elizaOS 1.x). No dependency on @elizaos/core.
 *
 *   import { tollkitWalletPlugin } from "@tollkit/wallet/elizaos";
 *   // character / project: plugins: [tollkitWalletPlugin]
 *   // settings or env: TOLLKIT_WALLET_PASSWORD (or TOLLKIT_WALLET_PASSWORD_FILE), optional TOLLKIT_WALLET_HOME
 *
 * Each action reads what the user asked for, has the agent's model turn it
 * into the action's arguments (JSON), checks them against the same schema
 * the MCP server uses, and runs it through the wallet's limits and approvals.
 */
import { readFileSync } from "node:fs";
// The few elizaOS shapes this plugin uses, declared here so the plugin needs
// nothing from @elizaos/core at runtime (and so its published types, which
// don't resolve under NodeNext, aren't needed to build). They match
// @elizaos/core 1.7 (types/components.d.ts, types/plugin.d.ts, types/runtime.d.ts).
interface IAgentRuntime { getSetting(key: string): string | boolean | number | null; useModel(modelType: string, params: { prompt: string }): Promise<unknown> }
interface Memory { content?: { text?: string } }
interface State { text?: string; [k: string]: unknown }
type HandlerCallback = (response: { text?: string; actions?: string[] }) => Promise<unknown>;
interface ActionResult { success: boolean; text?: string; data?: Record<string, unknown>; error?: string | Error }
interface Action {
  name: string; similes?: string[]; description: string; examples?: unknown[][];
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
  handler: (runtime: IAgentRuntime, message: Memory, state?: State, options?: unknown, callback?: HandlerCallback) => Promise<ActionResult>;
}
export interface Plugin { name: string; description: string; actions?: Action[] }
const TEXT_SMALL = "TEXT_SMALL"; // ModelType.TEXT_SMALL in @elizaos/core

/** First JSON object in a model reply (fenced or bare). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(body.slice(start, end + 1)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}
import { ACTIONS, type WalletAction } from "./actions.js";
import { TollkitWallet, describeAmount } from "./wallet.js";

const wallets = new WeakMap<IAgentRuntime, Promise<TollkitWallet>>();

function setting(rt: IAgentRuntime, key: string): string | undefined {
  const v = rt.getSetting(key) ?? process.env[key];
  return v === null || v === undefined || v === "" ? undefined : String(v);
}

/** Give a runtime an already-open wallet (instead of unlocking from settings). */
export function useWallet(rt: IAgentRuntime, wallet: TollkitWallet) { wallets.set(rt, Promise.resolve(wallet)); }

function walletFor(rt: IAgentRuntime): Promise<TollkitWallet> {
  let p = wallets.get(rt);
  if (!p) {
    const file = setting(rt, "TOLLKIT_WALLET_PASSWORD_FILE");
    const pw = file ? readFileSync(file, "utf8").replace(/\r?\n$/, "") : setting(rt, "TOLLKIT_WALLET_PASSWORD");
    if (!pw) return Promise.reject(new Error("Set TOLLKIT_WALLET_PASSWORD (or TOLLKIT_WALLET_PASSWORD_FILE) for the Tollkit wallet."));
    p = TollkitWallet.open(pw, { dir: setting(rt, "TOLLKIT_WALLET_HOME") });
    p.catch(() => wallets.delete(rt));
    wallets.set(rt, p);
  }
  return p;
}

/** Fields of a zod object, for the extraction prompt. */
function fieldsOf(a: WalletAction): string {
  const shape = (a.schema as any).shape ?? {};
  return Object.entries(shape).map(([k, v]: [string, any]) => `- ${k}${v.isOptional?.() ? " (optional)" : ""}: ${v.description ?? v._def?.typeName ?? ""}`).join("\n") || "(no arguments)";
}

async function extractArgs(rt: IAgentRuntime, a: WalletAction, message: Memory, state?: State): Promise<unknown> {
  if (!Object.keys((a.schema as any).shape ?? {}).length) return {};
  const recent = typeof state?.text === "string" ? state.text.slice(-4000) : "";
  const prompt = `Extract the arguments for the "${a.name}" wallet action from the user's latest message.
Action: ${a.description}
Arguments:
${fieldsOf(a)}

Recent conversation:
${recent}

Latest message:
${message.content?.text ?? ""}

Reply with only a JSON object holding the arguments. Use null for anything the user did not say; never invent amounts or addresses.`;
  const out = await rt.useModel(TEXT_SMALL, { prompt });
  const obj = parseJsonObject(String(out)) ?? {};
  for (const k of Object.keys(obj)) if (obj[k] === null) delete obj[k];
  return obj;
}

const ELIZA_NAMES: Record<string, { name: string; similes: string[] }> = {
  wallet_status: { name: "TOLLKIT_WALLET_STATUS", similes: ["WALLET_LIMITS", "SPENDING_LIMITS", "WALLET_ADDRESS"] },
  wallet_balances: { name: "TOLLKIT_WALLET_BALANCES", similes: ["CHECK_BALANCE", "WALLET_BALANCE", "GET_BALANCE"] },
  swap_quote: { name: "TOLLKIT_SWAP_QUOTE", similes: ["QUOTE_SWAP", "PRICE_CHECK", "GET_QUOTE"] },
  swap: { name: "TOLLKIT_SWAP", similes: ["SWAP_TOKENS", "TRADE", "BUY_TOKEN", "SELL_TOKEN"] },
  pay_fetch: { name: "TOLLKIT_PAY_FETCH", similes: ["PAY_API", "X402_PAY", "BUY_API_CALL", "PAID_FETCH"] },
  seller_check: { name: "TOLLKIT_SELLER_CHECK", similes: ["CHECK_SELLER", "VERIFY_ENDPOINT"] },
  receipts: { name: "TOLLKIT_RECEIPTS", similes: ["TRANSACTION_HISTORY", "WALLET_HISTORY", "RECEIPTS"] },
};

function toElizaAction(a: WalletAction): Action {
  const n = ELIZA_NAMES[a.name]!;
  return {
    name: n.name,
    similes: n.similes,
    description: a.description,
    validate: async (rt: IAgentRuntime) => wallets.has(rt) || !!(setting(rt, "TOLLKIT_WALLET_PASSWORD") || setting(rt, "TOLLKIT_WALLET_PASSWORD_FILE")),
    handler: async (rt: IAgentRuntime, message: Memory, state?: State, _o?: unknown, callback?: HandlerCallback) => {
      try {
        const w = await walletFor(rt);
        const parsed = a.schema.safeParse(await extractArgs(rt, a, message, state));
        if (!parsed.success) {
          const text = `I need more detail for that: ${parsed.error.issues.map((i) => i.path.join(".") || "input").join(", ")}.`;
          await callback?.({ text, actions: [n.name] });
          return { success: false, text, error: "bad_request" };
        }
        const result: any = await (a.run as any)(w, parsed.data);
        const refused = result?.refused?.reason as string | undefined;
        const text = refused ? `Not done: ${refused}` : summary(a.name, result);
        await callback?.({ text, actions: [n.name] });
        return { success: !refused, text, data: { result } };
      } catch (e) {
        const text = `Tollkit wallet error: ${(e as Error).message}`;
        await callback?.({ text, actions: [n.name] });
        return { success: false, text, error: e as Error };
      }
    },
    examples: [],
  };
}

function summary(name: string, r: any): string {
  if (name === "swap" && r?.ok) return `Swapped. ${r.quote?.usd_value !== undefined ? `Value about $${Number(r.quote.usd_value).toFixed(2)}, fee $${Number(r.quote.fee_usd ?? 0).toFixed(2)}. ` : ""}Transaction ${r.tx}.`;
  if (name === "swap_quote" && r?.ok) return `Quote: about $${Number(r.quote.usd_value).toFixed(2)}, at least ${describeAmount(r.quote.chain, r.quote.buy_token, r.quote.min_buy_amount)}, fee $${Number(r.quote.fee_usd ?? 0).toFixed(2)}.${r.warning ? ` Note: ${r.warning}` : ""}`;
  if (name === "pay_fetch") return r?.paid ? `Paid $${r.cost_usd} (${r.protocol} on ${r.chain}). Response:\n${String(r.body ?? "").slice(0, 3000)}` : `Fetched (status ${r?.status}). Response:\n${String(r?.body ?? "").slice(0, 3000)}`;
  return "```json\n" + JSON.stringify(r, null, 2).slice(0, 3500) + "\n```";
}

export const tollkitWalletPlugin: Plugin = {
  name: "tollkit-wallet",
  description: "Non-custodial wallet for trading agents: spot swaps on Base, Ethereum and Solana; x402 and MPP payments; owner-set limits, approvals and receipts.",
  actions: ACTIONS.map((a) => toElizaAction(a as unknown as WalletAction)),
};

export default tollkitWalletPlugin;
