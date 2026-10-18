#!/usr/bin/env node
/**
 * tollkit-wallet: the owner's command line.
 *   init | address | balance | status | budget [key=value ...] | telegram <bot-token> <chat-id>
 *   quote <chain> <amount> <sell> <buy> | swap <chain> <amount> <sell> <buy> | pay <url>
 *   withdraw <chain> <amount> <token> <to> | receipts [--csv] [--since YYYY-MM-DD] | mcp | ui
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createKeystore, addresses, revealBackup, markBackedUp } from "./keystore.js";
import { decodeBase58, getBytes, toBeArray } from "ethers";
import { TollkitWallet, saveTelegram } from "./wallet.js";
import { PolicySchema, type Policy } from "./policy.js";
import { requestApproval } from "./telegram.js";
import { resolveToken, toAtomic } from "./tokens.js";
import { serveStdio, VERSION } from "./mcp.js";
import { describeRule, type Rule } from "./rules.js";
import { parseStrategy } from "./parse.js";
import { PriceFeed } from "./prices.js";
import { Autopilot } from "./autopilot.js";
import type { Chain } from "./chains.js";
import { chmodSync, writeFileSync } from "node:fs";
import { passwordFile } from "./paths.js";

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Ask for a password without echoing it. Uses the env var when set (scripts). */
async function askPassword(prompt = "Wallet password: "): Promise<string> {
  if (process.env.TOLLKIT_WALLET_PASSWORD) return process.env.TOLLKIT_WALLET_PASSWORD;
  return askHidden(prompt);
}
/** A hidden prompt that never falls back to the password env var (phrases, keys). */
async function askHidden(prompt: string): Promise<string> {
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
      out(phraseBox(a.phrase!));
      if (process.stdin.isTTY && /^y/i.test(await ask("Have you written down all 12 words, in order? (y/N) "))) markBackedUp();
      else out("You can see the words again any time with `tollkit-wallet backup` (or Back up in the dashboard).");
      out(`Wallet created. Keys are encrypted on this computer only; Tollkit never sees them.\n  Base/Ethereum: ${a.evm}\n  Solana:        ${a.solana}\nThe recovery phrase restores this wallet here (\`tollkit-wallet restore\`) or in MetaMask and Phantom.\nDefault limits: $50 per trade, $200 trades a day, $0.25 per payment, $5 payments a day. Base and Solana are on; Ethereum is off. Change them with \`tollkit-wallet budget\`.\nSave where you can withdraw to: \`tollkit-wallet addresses add base <your address> <label>\`.`);
      return;
    }
    case "address": out(addresses()); return;
    case "backup": {
      const b = await revealBackup(await askPassword());
      if (b.kind === "phrase") out(phraseBox(b.phrase));
      else out(`This wallet was made before recovery phrases, so its backup is its two private keys. Keep them as safe as cash:\n  Base/Ethereum private key: ${b.evm_private_key}\n  Solana private key:        ${b.solana_secret_key}\nEither can be imported into another wallet ("Import private key"), or into this one with \`tollkit-wallet restore --keys\`.`);
      if (process.stdin.isTTY && /^y/i.test(await ask("Saved somewhere safe? (y/N) "))) markBackedUp();
      return;
    }
    case "restore": {
      const replace = args.includes("--replace");
      let opts: { phrase?: string; evmPrivateKey?: string; solanaSecretKey?: Uint8Array };
      if (args.includes("--keys")) {
        const evm = (await askHidden("Base/Ethereum private key (hidden): ")).trim();
        const sol = (await askHidden("Solana private key (hidden): ")).trim();
        opts = { evmPrivateKey: evm.startsWith("0x") ? evm : "0x" + evm, solanaSecretKey: solanaSecret(sol) };
      } else opts = { phrase: await askHidden("Recovery phrase, words separated by spaces (hidden): ") };
      const pw = await askPassword("New password for this wallet (12+ characters): ");
      if (pw !== (await askPassword("Type it again: "))) throw new Error("The passwords don't match.");
      const a = await createKeystore(pw, { ...opts, replace });
      await TollkitWallet.open(pw);
      markBackedUp();
      out(`Restored.\n  Base/Ethereum: ${a.evm}\n  Solana:        ${a.solana}${replace ? "\nThe previous wallet's files were kept next to the new ones with .replaced-<time> at the end. Your limits are back to the defaults; set them and your withdrawal addresses again." : ""}`);
      return;
    }
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
        next[k] = k === "chains" ? v.split(",") : k === "block_seller_warnings" ? v === "true" : k === "agent_rules" ? v : Number(v);
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
      if (!chain || !amount || !sellS || !buyS) throw new Error(`Usage: tollkit-wallet ${cmd} <base|ethereum|arbitrum|polygon|solana> <amount> <sell> <buy> [--slippage bps]`);
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
      if (!chain || !amount || !tokenS || !to) throw new Error("Usage: tollkit-wallet withdraw <base|ethereum|arbitrum|polygon|solana> <amount> <token> <to-address>");
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
    case "rules": {
      const w = await open();
      const rs = w.rules().list();
      if (!rs.length) { out("No autopilot rules yet. Add one: tollkit-wallet rule add \"buy $25 of SOL every Monday\""); return; }
      for (const r of rs) out(ruleLine(r));
      const st = Autopilot.status(w.dir);
      out(st.running ? `Autopilot is running (${st.mode}).` : "Autopilot is not running. Start it with `tollkit-wallet autopilot` or keep `tollkit-wallet ui` open.");
      return;
    }
    case "rule": {
      const [sub, ...rest] = args;
      const w = await open();
      if (sub === "add") {
        const text = rest.join(" ");
        if (!text) throw new Error('Usage: tollkit-wallet rule add "buy $25 of SOL every Monday; sell all ETH if it falls 8%"');
        const feed = new PriceFeed(); await feed.refresh();
        const pr = parseStrategy(text, (t) => feed.snapshot().prices[t.toUpperCase()]?.usd);
        if (pr.unparsed.length) out(`Not understood (ignored): ${pr.unparsed.map((u) => `"${u}"`).join(", ")}`);
        if (!pr.rules.length) throw new Error("No rules understood.");
        out("These rules will be turned on:");
        for (const r of pr.rules) out(`  • ${describeRule(r)}`);
        if ((await ask("Turn them on? [y/N] ")).toLowerCase() !== "y") { out("Cancelled."); return; }
        for (const r of pr.rules) out(ruleLine(await w.rules().add(r, "owner", false)));
        return;
      }
      if ((sub === "on" || sub === "pause" || sub === "cancel") && rest[0]) {
        out(ruleLine(await w.rules().setStatus(rest[0], sub === "on" ? "active" : sub === "pause" ? "paused" : "cancelled"))); return;
      }
      throw new Error('Usage: tollkit-wallet rule add "<plain English>" | rule on|pause|cancel <id>');
    }
    case "autopilot": {
      const paper = args.includes("--paper");
      const w = await open();
      const feed = new PriceFeed(); feed.start();
      const ap = new Autopilot(w.rules(), w.executor(paper ? "paper" : "live"), feed, { dir: w.dir, onEvent: (e) => out(`${new Date().toISOString()} ${e.type.toUpperCase()} ${describeRule(e.rule)}: ${e.detail}`) });
      ap.start();
      out(`Autopilot running${paper ? " in PAPER mode (pretend money)" : ""}. ${w.rules().list().filter((r) => r.status === "active").length} active rule(s). Ctrl-C to stop.`);
      await new Promise<void>((r) => process.once("SIGINT", () => { ap.stop(); feed.stop(); r(); }));
      return;
    }
    case "paper": {
      const [sub, ...rest] = args;
      const w = await open();
      if (sub === "reset") { out(w.paper().reset(rest[0] ? Number(rest[0]) : undefined)); return; }
      if (sub === "swap") {
        const [chain, amount, sellS, buyS] = rest as [Chain, string, string, string];
        if (!chain || !amount || !sellS || !buyS) throw new Error("Usage: tollkit-wallet paper swap <chain> <amount> <sell> <buy>");
        const [sell, buy] = await Promise.all([resolveToken(chain, sellS), resolveToken(chain, buyS)]);
        out(await w.paper().swap({ chain, sell_token: sell.address, buy_token: buy.address, sell_amount: toAtomic(amount, sell.decimals), slippage_bps: Math.min(50, w.policy.max_slippage_bps) })); return;
      }
      out(w.paper().summary()); return;
    }
    case "mcp": await serveStdio({ advisor: args.includes("--advisor") }); return;
    case "password-file": {
      // Lets an AI app (Claude, Cursor, …) start `tollkit-wallet mcp` without typing the password.
      const pw = await askPassword();
      await TollkitWallet.open(pw); // wrong password fails here, before anything is written
      const f = passwordFile();
      writeFileSync(f, pw, { mode: 0o600 });
      chmodSync(f, 0o600);
      out(`Saved. Only your user account can read ${f}.\nIn your AI app, set TOLLKIT_WALLET_PASSWORD_FILE=${f} (the dashboard's "Connect your AI" button fills it in).\nAnyone who can read this file and your wallet folder can spend within your limits, so keep both on this computer.`);
      return;
    }
    case "ui": { const { serveDashboard } = await import("./dashboard.js"); await serveDashboard(await askPassword(), { port: Number(flag(args, "--port") ?? 7420) }); return; }
    case "extension": {
      const dir = (await import("node:url")).fileURLToPath(new URL("../extension", import.meta.url));
      out(`The Tollkit browser extension is in:\n  ${dir}\n\nTo add it to Chrome (or Brave/Edge):\n  1. Open chrome://extensions and turn on Developer mode (top right).\n  2. Click "Load unpacked" and pick that folder.\n  3. Run \`tollkit-wallet ui\`, open Settings, click "Pair a browser", and paste the code into the extension.`);
      return;
    }
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
  backup                            show your recovery phrase (or, for older wallets, the private keys)
  restore [--keys] [--replace]      restore a wallet from its recovery phrase (or private keys)
  mcp                               run the MCP server for agents (stdio)
  password-file                     save your password so an AI app can start the MCP server
  ui [--port 7420]                  open the dashboard (runs the autopilot too)
  extension                         where the browser extension is, and how to add it to Chrome
  rules                             list autopilot rules
  rule add "<plain English>"        e.g. "buy $25 of SOL every Monday; sell all ETH if it falls 8%"
  rule on|pause|cancel <id>         turn a rule on (e.g. one an agent proposed), pause or cancel it
  autopilot [--paper]               run the autopilot without the dashboard (e.g. on a server)
  paper [reset <usd> | swap ...]    practice with pretend money at live prices`);
  }
}

function phraseBox(phrase: string): string {
  const w = phrase.split(" ");
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => { const i = r * 3 + c; return `${String(i + 1).padStart(2)}. ${w[i]!.padEnd(10)}`; }).join("  "));
  return `\nYour recovery phrase. Write these 12 words down, in order, and keep them offline.\nAnyone with them can take the funds; with them you can restore the wallet if this computer is lost.\n\n${rows.join("\n")}\n`;
}

/** Solana secret key as base58 (Phantom's export) or a JSON array of 64 numbers (Solana CLI file). */
function solanaSecret(s: string): Uint8Array {
  const b = s.startsWith("[") ? new Uint8Array(JSON.parse(s)) : getBytes(toBeArray(decodeBase58(s)));
  const full = s.startsWith("[") ? b : padLeadingZeros(s, b);
  if (full.length !== 64) throw new Error("A Solana private key is 64 bytes (base58 text or a [..] list of 64 numbers).");
  return full;
}
function padLeadingZeros(b58: string, bytes: Uint8Array): Uint8Array {
  const zeros = b58.match(/^1*/)![0].length; // each leading "1" is a 0x00 byte
  const out = new Uint8Array(zeros + bytes.length); out.set(bytes, zeros); return out;
}

function ruleLine(r: Rule): string {
  const fills = r.state.fills.filter((f) => f.ok).length;
  return `[${r.id}] ${r.status.toUpperCase()}${r.created_by === "agent" ? " (agent)" : ""}: ${describeRule(r)}${r.state.last_price ? ` · now $${r.state.last_price}` : ""}${fills ? ` · ${fills} fill(s)` : ""}${r.state.last_error ? ` · ${r.state.last_error}` : ""}`;
}

main(process.argv.slice(2)).catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
