/**
 * Website screenshots of TOLLkit Wallet with example numbers. Runs the real wallet page (tollkit-wallet's dashboard)
 * on a throwaway test wallet in a temp folder; balances and prices are made up (see DEMO below).
 * Run from ~/Code/tollkit-wallet:  npx tsx scripts/site-shots.mts [--probe]
 * Writes ../tollkit-dev/wallet/img/<name>.webp (400×820).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TollkitWallet } from "../src/wallet.js";
import { createKeystore } from "../src/keystore.js";
import { buildBot } from "../src/bots.js";
import { writeFileSync } from "node:fs";
import { startDashboard } from "../src/dashboard.js";
import { chromium } from "../../tollkit-extension/node_modules/playwright/index.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "tw-shots-"));
const PW = "example-screens-only-" + Math.random().toString(36).slice(2);
await createKeystore(PW, { dir, scrypt: { N: 1 << 10, r: 8, p: 1 } });
const w = await TollkitWallet.open(PW, { dir });
// Prices are today's from Coinbase (the bot charts show live candles); the day's change is made up.
const last = async (id: string) => Number((await (await fetch(`https://api.exchange.coinbase.com/products/${id}/stats`)).json()).last);
const ETH = await last("ETH-USD"), SOL = await last("SOL-USD");
// Example bots: two the owner runs, and two of Autopilot's strategies (one live, one on paper).
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const add = async (t: string, tok: string, chain: "base" | "solana", params: Record<string, unknown>, price: number, by: "owner" | "agent" = "owner") => {
  const b = buildBot(t, tok, chain, params, price); await w.rules().addBot(b.rules, by, true); return b.bot;
};
const dipBot = await add("dip", "ETH", "base", { amount_usd: 500, drop_pct: 5, profit_pct: 8 }, ETH);
const gridBot = await add("grid", "SOL", "solana", { amount_usd: 150, range_pct: 8, levels: 8 }, SOL);
const apLive = await add("dca", "ETH", "base", { amount_usd: 100, every: "day", times: 14 }, ETH, "agent");
const apPaper = await add("grid", "SOL", "solana", { amount_usd: 60, range_pct: 6, levels: 6 }, SOL, "agent");
const strat = (id: string, name: string, template: string, chain: string, token: string, bot: string, stage: string, h: number) =>
  ({ id, name, template, chain, token, params: {}, stage, bot, created_at: ago(h), stage_since: ago(h), history: [], prev_bots: [] });
writeFileSync(path.join(dir, "superbot.json"), JSON.stringify({
  enabled: true, since: ago(24 * 12),
  settings: { chains: ["base", "solana"], tokens: [{ chain: "base", token: "ETH" }, { chain: "solana", token: "SOL" }], sources: { news: true, farcaster: true, x: false },
    budget_usd: 2500, per_trade_usd: 100, max_token_pct: 25, daily_loss_pct: 5, weekly_loss_pct: 15, slippage_bps: 100, paper_days: 7, paper_trades: 20,
    rethink_minutes: 30, max_strategies: 4, always_on: true, daily_share_pct: 50, pace: "steady", think_24_7: true, active_mode: false },
  strategies: [strat("s1", "Steady buyer · ETH", "dca", "base", "ETH", apLive, "live", 24 * 9), strat("s2", "Grid trader · SOL", "grid", "solana", "SOL", apPaper, "paper", 24 * 4)],
  decisions: [], reports: [], paper_rules: w.rules().list().filter((r) => r.bot === apPaper).map((r) => r.id), halted: null, marks: null, sized: 1,
  stats: { cycles: 412, steps: 36, step_usd: 0, last_cycle: ago(0.2), last_step: ago(1), last_snapshot: ago(0.2), last_error: null, last_report: ago(20) },
}));
const dash = await startDashboard(w, PW, { port: 17499, watch: false, autopilot: false, ai: false, connectApps: false });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 820 }, colorScheme: "dark" });
// ---- example numbers ---------------------------------------------------------------------------------
const DEMO = {
  balances: { base: [{ token: "ETH", amount: "3.85" }, { token: "USDC", amount: "3180" }], solana: [{ token: "SOL", amount: "96.4" }, { token: "USDC", amount: "4200" }] },
  prices: { ETH: { usd: ETH, change_24h: 0.0286 }, SOL: { usd: SOL, change_24h: 0.0412 }, USDC: { usd: 1, change_24h: 0 } },
  // Autopilot: [result %, result $, trades] per strategy.
  strategies: { [apLive]: [12.4, 148.62, 14], [apPaper]: [8.7, 52.2, 18] } as Record<string, [number, number, number]>,
  // Bots: [result $, trades, trades today].
  bots: { [dipBot]: [214.35, 6, 2], [gridBot]: [172.05, 31, 4] } as Record<string, [number, number, number]>,
};
const OUT = path.resolve(import.meta.dirname, "../../tollkit-dev/wallet/img");
const SCRATCH = process.env.SHOTS_DIR ?? OUT;
await page.route("**/api/balances", (r) => r.fulfill({ json: DEMO.balances }));
await page.route("**/api/state", async (r) => {
  const st = await (await r.fetch()).json();
  st.prices = { prices: { ...DEMO.prices, WETH: DEMO.prices.ETH }, at: new Date().toISOString() };
  st.backup = { ...st.backup, done: true };
  // Stand-ins for the token-check and Connect your AI shots (the address is blurred in the picture).
  st.holdings = st.holdings ?? { hidden: 0 };
  st.connect = { ...(st.connect ?? {}), remote: { on: true, online: true, url: "https://tollkit.dev/c/example-private-connector-address-0000000000" } };
  st.devices = { ...(st.devices ?? {}), on: true, devices: [{ id: "d1", name: "Chrome" }, { id: "d2", name: "iPhone" }], last_sync: new Date().toISOString(), last_error: null };
  const apIds = new Set([apLive, apPaper]), liveIds = st.rules.filter((r: any) => r.bot === apLive).map((r: any) => r.id);
  st.autopilot = { ...st.autopilot, here: true, last_tick: new Date().toISOString() };
  st.rules = st.rules.map((r: any) => (apIds.has(r.bot) ? { ...r, by: "superbot" } : r));
  st.always = { ...(st.always ?? {}), config: { ...(st.always?.config ?? {}), enabled: true }, running: liveIds, rules: liveIds };
  st.superbot.totals.committed_usd = 1400;
  // Autopilot's own bots show on its screen, not under My bots; the owner's ETH bot would flag "you have a rule on it".
  st.bots = st.bots.filter((b: any) => !apIds.has(b.id)).map((b: any) => { const [usd, n, today] = DEMO.bots[b.id]; return { ...b, status: "running", result_usd: usd, earned_usd: Math.round(usd * 0.7 * 100) / 100, trades_ok: n, trades_today: today, last_trade: new Date(Date.now() - 40 * 60_000).toISOString() }; });
  st.rules = st.rules.filter((r: any) => r.bot !== dipBot);
  for (const x of st.superbot.strategies) { const [pct, usd, n] = DEMO.strategies[x.bot]; Object.assign(x, { result_pct: pct, result_usd: usd, earned_usd: Math.round(usd * 0.6 * 100) / 100, trades: n }); }
  st.superbot.totals.live_result_usd = DEMO.strategies[apLive][1];
  // 0.9.13: the Autopilot headline is money earned on what it sold.
  st.superbot.totals.live_earned_usd = Math.round(DEMO.strategies[apLive][1] * 0.6 * 100) / 100;
  await r.fulfill({ json: st });
});
async function shot(name: string, setup: () => Promise<void>) {
  await setup(); await page.waitForTimeout(1500);
  const png = await page.screenshot();
  if (process.env.SHOTS_DIR) { writeFileSync(path.join(SCRATCH, `${name}.png`), png); return; }
  // The site uses WebP; Chromium encodes it (no image tools needed).
  const enc = await browser.newPage();
  const b64 = await enc.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height;
    c.getContext("2d")!.drawImage(i, 0, 0); return c.toDataURL("image/webp", 0.86).split(",")[1]; }, "data:image/png;base64," + png.toString("base64"));
  await enc.close();
  writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(b64, "base64"));
}
// Today's change: the page compares with the price it saw first today (kept in the browser), so start the day there.
{ const base = (k: "ETH" | "SOL") => DEMO.prices[k].usd / (1 + DEMO.prices[k].change_24h);
  const p = { "base:ETH": base("ETH"), "solana:SOL": base("SOL"), "base:USDC": 1, "solana:USDC": 1 };
  // A string, not a function: tsx's helpers don't exist in the page.
  await page.addInitScript(`(()=>{const d=new Date();localStorage.setItem("tk_day",JSON.stringify({date:d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate(),since:new Date(new Date().setHours(0,0,0,0)).getTime(),p:${JSON.stringify(p)}}))})()`); }
await page.goto(dash.url);
await shot("home", async () => { await page.waitForSelector("#tot"); });
await shot("autopilot", async () => { await page.evaluate(() => (window as any).go("pilot")); });
await shot("bots", async () => { await page.evaluate(() => { (window as any).go("autopilot"); window.scrollTo(0, 0); }); await page.waitForTimeout(300); await page.evaluate(() => window.scrollTo(0, 0)); });
// Token check: a made-up token with two warnings, the way the check shows a risky one.
await shot("scamcheck", async () => {
  await page.evaluate(`go("home")`); await page.waitForTimeout(500);
  const fill = `(function(){ADDT=true;AT.chain="base";AT.q="0x1234567890123456789012345678901234567890";AT.confirm=false;
    AT.chk={chain:"base",address:"0x1234567890123456789012345678901234567890",symbol:"FAKE",name:"Fake USD",trust:"unknown",
      warnings:["No on-chain pool pairs this token with USDC, so it may be hard to sell.","The owner can create more tokens."],powers:[],facts:["Total supply 1,000,000,000.","Not on the wallet's token lists."]};
    render();var el=document.querySelector(".addt");if(el)el.scrollIntoView({block:"end"});return !!el})()`;
  console.log("token check card:", await page.evaluate(fill));
  await page.waitForTimeout(400); await page.evaluate(fill);
});
// Connect your AI: a stand-in address, blurred, like a private one would be.
await shot("connect", async () => {
  await page.evaluate(`(function(){ADDT=false;AT.chk=null;go("home");window.scrollTo(0,0)})()`); await page.waitForTimeout(400);
  const fill = `(function(){if(!AIO)openAI();else aiRender();
    if(!document.getElementById("blurai")){var st=document.createElement("style");st.id="blurai";st.textContent="#ai-url,[id^=ai-url]{filter:blur(6px)}";document.head.appendChild(st)}
    var a=document.activeElement;if(a&&a.blur)a.blur();var dl=document.querySelector(".aidlg");if(dl)dl.scrollTop=0;return !!document.querySelector("[id^=ai-url]")})()`;
  await page.evaluate(fill); await page.waitForTimeout(500);
  console.log("connector address shown:", await page.evaluate(fill));
});
if (process.argv.includes("--probe")) {
  const st = await (await page.request.get(dash.url.replace(/\/?(\?.*)?$/, "") + "/api/state", { headers: { "x-tw-token": new URL(dash.url).searchParams.get("t") ?? "" } })).json().catch((e) => String(e));
  console.log(dash.url, typeof st === "string" ? st : Object.keys(st));
}
await browser.close(); await dash.close(); process.exit(0);
