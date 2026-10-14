/**
 * Human approval over Telegram. The owner makes their own bot with
 * @BotFather and gives the wallet its token and their chat id; messages go
 * straight from the user's machine to Telegram. No Tollkit server is involved.
 * Anything but an explicit "Approve" (deny, timeout, error) means no.
 */
import { randomBytes } from "node:crypto";

export interface TelegramConfig { token: string; chat_id: string }
export type Decision = "approved" | "denied" | "timeout";
type Fetch = typeof fetch;

async function call(cfg: TelegramConfig, method: string, body: unknown, f: Fetch, timeoutMs = 35_000) {
  const r = await f(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method} failed: ${j.description ?? r.status}`);
  return j.result;
}

/** A plain message to the owner (no buttons). */
export async function notify(cfg: TelegramConfig, text: string, f: Fetch = fetch): Promise<void> {
  await call(cfg, "sendMessage", { chat_id: cfg.chat_id, text }, f, 15_000);
}

export async function requestApproval(cfg: TelegramConfig, text: string, opts: { timeoutMs?: number; fetch?: Fetch; signal?: AbortSignal } = {}): Promise<Decision> {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const nonce = randomBytes(6).toString("hex");
  // Skip anything already queued so an old tap can't approve this request.
  const pending: any[] = await call(cfg, "getUpdates", { timeout: 0, allowed_updates: ["callback_query"] }, f);
  let offset = pending.length ? pending[pending.length - 1].update_id + 1 : 0;
  const msg = await call(cfg, "sendMessage", {
    chat_id: cfg.chat_id,
    text,
    reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `tw:${nonce}:y` }, { text: "Deny", callback_data: `tw:${nonce}:n` }]] },
  }, f);
  const deadline = Date.now() + timeoutMs;
  let decision: Decision = "timeout";
  while (Date.now() < deadline && decision === "timeout" && !opts.signal?.aborted) {
    // Short polls when another channel may answer first, so we notice quickly.
    const wait = Math.max(1, Math.min(opts.signal ? 3 : 25, Math.floor((deadline - Date.now()) / 1000)));
    const ups: any[] = await call(cfg, "getUpdates", { offset, timeout: wait, allowed_updates: ["callback_query"] }, f, (wait + 10) * 1000);
    for (const u of ups) {
      offset = u.update_id + 1;
      const q = u.callback_query;
      if (!q || String(q.message?.chat?.id) !== String(cfg.chat_id)) continue;
      const [tag, n, yn] = String(q.data ?? "").split(":");
      if (tag !== "tw" || n !== nonce) continue;
      decision = yn === "y" ? "approved" : "denied";
      await call(cfg, "answerCallbackQuery", { callback_query_id: q.id, text: decision === "approved" ? "Approved" : "Denied" }, f).catch(() => {});
    }
  }
  await call(cfg, "editMessageText", {
    chat_id: cfg.chat_id, message_id: msg.message_id,
    text: `${text}\n\n${decision === "approved" ? "✅ Approved" : decision === "denied" ? "❌ Denied" : opts.signal?.aborted ? "Answered in the dashboard" : "⌛ Timed out (not approved)"}`,
  }, f).catch(() => {});
  if (offset) await call(cfg, "getUpdates", { offset, timeout: 0 }, f).catch(() => {}); // acknowledge
  return decision;
}
