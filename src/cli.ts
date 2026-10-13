#!/usr/bin/env node
/**
 * tollkit-wallet: the owner's command line.
 *   init | address | balance | status | budget [key=value ...] | telegram <bot-token> <chat-id>
 *   quote <chain> <amount> <sell> <buy> | swap <chain> <amount> <sell> <buy> | pay <url>
 *   withdraw <chain> <amount> <token> <to> | receipts [--csv] [--since YYYY-MM-DD] | mcp | ui
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createKeystore, addresses } from "./keystore.js";
import { TollkitWallet, saveTelegram } from "./wallet.js";
import { PolicySchema, type Policy } from "./policy.js";
import { requestApproval } from "./telegram.js";
import { resolveToken, toAtomic } from "./tokens.js";
import { serveStdio, VERSION } from "./mcp.js";
import type { Chain } from "./chains.js";

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Ask for a password without echoing it. Uses the env var when set (scripts). */
async function askPassword(prompt = "Wallet password: "): Promise<string> {
  if (process.env.TOLLKIT_WALLET_PASSWORD) return process.env.TOLLKIT_WALLET_PASSWORD;
  let muted = false;
  const sink = new Writable({ write(chunk, _e, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  return new Promise((res) => {
    rl.question(prompt, (a) => { rl.close(); process.stdout.write("\n"); res(a); });
    muted = true;
  });
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

const open = async () => TollkitWallet.open(await askPassword());

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name); if (i < 0) return undefined;
  const v = args[i + 1]; args.splice(i, 2); return v;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "init": {
      const pw = await askPassword("Choose a password (12+ characters): ");
      const again = await askPassword("Type it again: ");
      if (pw !== again) throw new Error("The passwords don't match.");
      const a = await createKeystore(pw);
      await TollkitWallet.open(pw); // writes the default limits
      out(`Wallet created. Keys are encrypted on this computer only; Tollkit never sees them.\n  Base/Ethereum: ${a.evm}\n  Solana:        ${a.solana}\nWrite your password down. If you lose it, the funds can't be recovered.\nDefault limits: $50 per trade, $200 trades a day, $0.25 per payment, $5 payments a day. Base and Solana are on; Ethereum is off. Change them with \`tollkit-wallet budget\`.\nSave where you can withdraw to: \`tollkit-wallet addresses add base <your address> <label>\`.`);
      return;
    }
    case "address": out(addresses()); return;
    case "status": out((await open()).status()); return;
    case "balance": case "balances": out(await (await open()).balances()); return;
    case "budget": {
      const pw = await askPassword();
      const w = await TollkitWallet.open(pw);
      if (!args.length) { out(w.policy); out("Change with: tollkit-wallet budget per_trade_usd=100 daily_trades_usd=500 chains=base,solana"); return; }
      const next: any = { ...w.policy };
      for (const kv of args) {
        const [k, v] = kv.split("=");
        if (k === "withdraw_addresses") throw new Error("Use `tollkit-wallet addresses add|remove` for withdrawal addresses.");
        if (!k || v === undefined || !(k in next)) throw new Error(`Unknown setting "${kv}". Settings: ${Object.keys(next).join(", ")}`);
        next[k] = k === "chains" ? v.split(",") : k === "block_seller_warnings" ? v === "true" : Number(v);
      }
      const parsed = PolicySchema.safeParse(next);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      out(w.setPolicy(pw, parsed.data as Policy)); return;
    }
    case "telegram": {
      const [token, chat] = args;
      if (!token || !chat) throw new Error("Usage: tollkit-wallet telegram <bot-token from @BotFather> <your chat id>");
      const d = await requestApproval({ token, chat_id: chat }, "Tollkit Wallet: tap Approve to confirm approvals reach you.", { timeoutMs: 120_000 });
      if (d !== "approved") throw new Error(`Test message not approved (${d}); nothing saved.`);
      saveTelegram({ token, chat_id: chat });
      out("Telegram approvals are on."); return;
    }
    case "quote": case "swap": {
      const slip = flag(args, "--slippage");
      const [chain, amount, sellS, buyS] = args as [Chain, string, string, string];
      if (!chain || !amount || !sellS || !buyS) throw new Error(`Usage: tollkit-wallet ${cmd} <base|ethereum|solana> <amount> <sell> <buy> [--slippage bps]`);
      const w = await open();
      const [sell, buy] = await Promise.all([resolveToken(chain, sellS), resolveToken(chain, buyS)]);
      const req = { chain, sell_token: sell.address, buy_token: buy.address, sell_amount: toAtomic(amount, sell.decimals), slippage_bps: slip ? Number(slip) : Math.min(50, w.policy.max_slippage_bps) };
      const q = await w.quote(req);
      if (!q.ok || cmd === "quote") { out(q); return; }
      const qq = q.quote!;
      out(`Sell ${amount} ${sell.symbol} for at least ${Number(qq.min_buy_amount) / 10 ** buy.decimals} ${buy.symbol} (~$${qq.usd_value?.toFixed(2)}). Fee 0.5% ($${qq.fee_usd?.toFixed(2)})${qq.venue_fee_bps ? ` + venue ${qq.venue_fee_bps / 100}%` : ""}.`);
      if ((await ask("Trade? [y/N] ")).toLowerCase() !== "y") { out("Cancelled."); return; }
      out(await w.swap(req)); return;
    }
    case "addresses": {
      const [sub, chain, addr, ...label] = args as [string, Chain, string, ...string[]];
      const pw = await askPassword();
      const w = await TollkitWallet.open(pw);
      if (sub === "add" && chain && addr) { out((await w.saveWithdrawAddress(pw, chain, addr, label.join(" "))).withdraw_addresses); return; }
      if (sub === "remove" && chain && addr) { out(w.removeWithdrawAddress(pw, chain, addr).withdraw_addresses); return; }
      out(w.policy.withdraw_addresses.length ? w.policy.withdraw_addresses : "No saved withdrawal addresses. Add one: tollkit-wallet addresses add <chain> <address> <label>"); return;
    }
    case "withdraw": case "send": {
      const [chain, amount, tokenS, to] = args as [Chain, string, string, string];
      if (!chain || !amount || !tokenS || !to) throw new Error("Usage: tollkit-wallet withdraw <base|ethereum|solana> <amount> <token> <to-address>");
      const pw = await askPassword();
      const w = await TollkitWallet.open(pw);
      const token = await resolveToken(chain, tokenS);
      const atomic = toAtomic(amount, token.decimals);
      out(`Send ${amount} ${token.symbol} on ${chain} to ${to}. This can't be undone.`);
      if ((await ask("Send? [y/N] ")).toLowerCase() !== "y") { out("Cancelled."); return; }
      out(await w.withdraw(pw, chain, token, to, atomic)); return;
    }
    case "pay": {
      const data = flag(args, "--data"), method = flag(args, "--method")?.toUpperCase();
      const url = args[0]; if (!url) throw new Error("Usage: tollkit-wallet pay <url> [--data '{\"query\":\"...\"}'] [--method POST]");
      const init: RequestInit = data !== undefined
        ? { method: method ?? "POST", headers: { "content-type": "application/json" }, body: data }
        : { method: method ?? "GET" };
      const r = await (await open()).pay(url, init);
      out({ paid: r.paid, status: r.status, cost_usd: r.offer?.usd, tx: r.tx, refused: r.refused });
      if (r.response) out((await r.response.text()).slice(0, 4000)); return;
    }
    case "receipts": {
      const since = flag(args, "--since");
      const w = await open();
      if (args.includes("--csv")) process.stdout.write(w.receiptsCsv(since)); else out(w.receipts(since)); return;
    }
    case "mcp": await serveStdio(); return;
    case "ui": { const { serveDashboard } = await import("./dashboard.js"); await serveDashboard(await askPassword(), { port: Number(flag(args, "--port") ?? 7420) }); return; }
    case "version": case "--version": out(VERSION); return;
    default:
      out(`tollkit-wallet ${VERSION}
  init                              make a new wallet (keys stay on this computer)
  address | status | balance        addresses, limits and spend, balances
  budget [key=value ...]            show or change limits (needs your password)
  telegram <bot-token> <chat-id>    turn on approvals in Telegram
  quote|swap <chain> <amount> <sell> <buy> [--slippage bps]
  pay <url> [--data json] [--method M]   call a paid URL (x402 or MPP); --data sends a JSON POST
  addresses [add|remove <chain> <address> [label]]   your saved withdrawal addresses
  withdraw <chain> <amount> <token> <to>   send funds to a saved address
  receipts [--csv] [--since date]   trades and payments
  mcp                               run the MCP server for agents (stdio)
  ui [--port 7420]                  open the dashboard`);
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
