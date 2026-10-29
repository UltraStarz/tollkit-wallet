/**
 * 0.9.1: what alert rules watch (src/rules.ts kind "alert"). Alerts only notify; they never trade.
 *
 * Hourly closes come from the same free sources the wallet already uses: Coinbase's public candles for ETH, SOL and
 * POL (src/botviz.ts), and DefiLlama's hourly chart for any other token (checked live on 2026-10-21: span=72,
 * period=1h answers 72 points for ETH and for JUP). RSI is Wilder's 14-period RSI; the average is a plain 50-hour
 * simple moving average.
 */
import type { Chain } from "./chains.js";
import type { Token } from "./tokens.js";
import { coinbaseProduct, hourlyCandles } from "./botviz.js";
import { coinId } from "./holdings.js";
import type { AlertType, Rule, Signal } from "./rules.js";

export const RSI_PERIOD = 14;
export const MA_HOURS = 50;
const HOURS = 200; // 0.9.9: enough for a 4-hour MACD (35 four-hour closes) and breakouts; DefiLlama answered 186 points for span=200 on 2026-10-29

/** Wilder's RSI over closes (oldest first). Null until there are period + 1 closes. */
export function rsi(closes: number[], period = RSI_PERIOD): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]! - closes[i - 1]!; if (d > 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Simple average of the last n closes, or null with fewer. */
export function sma(closes: number[], n = MA_HOURS): number | null {
  if (closes.length < n) return null;
  let s = 0; for (let i = closes.length - n; i < closes.length; i++) s += closes[i]!;
  return s / n;
}

type Fetch = typeof fetch;
const cache = new Map<string, { at: number; closes: number[] }>();

/** Hourly closes for a token, oldest first (about 80 hours). Cached 10 minutes. */
export async function hourlyCloses(chain: Chain, t: Token, f: Fetch = fetch, now = Date.now()): Promise<number[]> {
  const key = `${chain}:${t.address.toLowerCase()}`, hit = cache.get(key);
  if (hit && now - hit.at < 10 * 60_000) return hit.closes;
  let closes: number[];
  const product = coinbaseProduct(t.symbol);
  if (product) closes = (await hourlyCandles(product, HOURS, f, now)).map((c) => c.c);
  else {
    const coin = coinId(chain, t.address);
    const r = await f(`https://coins.llama.fi/chart/${coin}?span=${HOURS}&period=1h`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`Price history isn't available right now (HTTP ${r.status}).`);
    const c = (await r.json())?.coins?.[coin];
    closes = (c?.prices ?? []).map((x: any) => Number(x.price)).filter((p: number) => p > 0);
  }
  if (!closes.length) throw new Error("No price history came back.");
  cache.set(key, { at: now, closes });
  return closes;
}

export interface AlertCheck { hit: boolean; clear: boolean; now: string; detail: string }

/**
 * Whether an alert's condition holds at price p. `clear` says the condition has gone away again (so the alert can
 * fire next time), with a little slack so a price sitting on the line doesn't fire over and over.
 */
export function checkAlert(r: Pick<Rule, "alert" | "alert_value" | "trigger_price">, p: number, closes: number[] | null): AlertCheck {
  const a = r.alert as AlertType, $ = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
  switch (a) {
    case "above": return { hit: p >= r.trigger_price!, clear: p < r.trigger_price! * 0.995, now: `Now ${$(p)}`, detail: `is at ${$(p)}, above your ${$(r.trigger_price!)}` };
    case "below": return { hit: p <= r.trigger_price!, clear: p > r.trigger_price! * 1.005, now: `Now ${$(p)}`, detail: `is at ${$(p)}, below your ${$(r.trigger_price!)}` };
    case "move": {
      if (!closes || closes.length < 25) return { hit: false, clear: false, now: "Waiting for price history", detail: "" };
      const was = closes[closes.length - 25]!, pct = ((p - was) / was) * 100, lvl = r.alert_value!;
      return { hit: Math.abs(pct) >= lvl, clear: Math.abs(pct) < lvl * 0.8, now: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% in 24h`, detail: `moved ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% in 24 hours (now ${$(p)})` };
    }
    case "rsi_high": case "rsi_low": {
      const v = closes ? rsi([...closes, p]) : null;
      if (v === null) return { hit: false, clear: false, now: "Waiting for price history", detail: "" };
      const lvl = r.alert_value ?? (a === "rsi_high" ? 70 : 30);
      return a === "rsi_high"
        ? { hit: v >= lvl, clear: v < lvl - 5, now: `RSI ${v.toFixed(0)}`, detail: `looks overbought: hourly RSI is ${v.toFixed(0)} (above ${lvl}), price ${$(p)}` }
        : { hit: v <= lvl, clear: v > lvl + 5, now: `RSI ${v.toFixed(0)}`, detail: `looks oversold: hourly RSI is ${v.toFixed(0)} (below ${lvl}), price ${$(p)}` };
    }
    case "ma_up": case "ma_down": {
      const m = closes ? sma(closes) : null;
      if (m === null) return { hit: false, clear: false, now: "Waiting for price history", detail: "" };
      const above = p > m, gap = ((p - m) / m) * 100;
      const now = `${Math.abs(gap).toFixed(1)}% ${above ? "above" : "below"} its 50h average`;
      return a === "ma_up"
        ? { hit: above, clear: p < m * 0.998, now, detail: `crossed above its 50-hour average (${$(m)}), now ${$(p)}` }
        : { hit: !above, clear: p > m * 1.002, now, detail: `crossed below its 50-hour average (${$(m)}), now ${$(p)}` };
    }
    default: return { hit: false, clear: false, now: "", detail: "" };
  }
}

// ── 0.9.9: momentum signals for signal_buy / signal_sell rules ───────────────────────────────────────────────────
// Formulas from StockCharts ChartSchool (checked 2026-10-29): EMA multiplier 2 / (n + 1), seeded with an n-period
// simple average; MACD = EMA(12) − EMA(26), signal = EMA(9) of MACD, histogram = MACD − signal; RSI is Wilder's (rsi()).
// A breakout compares the price with the highest (or lowest) close of the previous n candles (a Donchian channel on
// closes, since the free hourly sources give closes for every coin).

/** EMA series over closes (oldest first); entries before the seed are null. */
export function ema(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length < n) return out;
  let e = closes.slice(0, n).reduce((a, b) => a + b, 0) / n, k = 2 / (n + 1);
  out[n - 1] = e;
  for (let i = n; i < closes.length; i++) { e = (closes[i]! - e) * k + e; out[i] = e; }
  return out;
}

/** MACD histogram (MACD − signal) for the last two points, or null without enough closes (26 + 9 − 1). */
export function macdHist(closes: number[], fast = 12, slow = 26, sig = 9): { prev: number; now: number } | null {
  if (closes.length < slow + sig) return null;
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null)).filter((x): x is number => x !== null);
  const sl = ema(line, sig);
  const h = line.map((m, i) => (sl[i] !== null ? m - sl[i]! : null)).filter((x): x is number => x !== null);
  return h.length >= 2 ? { prev: h[h.length - 2]!, now: h[h.length - 1]! } : null;
}

/** Hourly closes grouped into 4-hour closes (each 4th hour's close, ending with the latest). */
export function fourHour(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = closes.length - 1; i >= 0; i -= 4) out.unshift(closes[i]!);
  return out;
}

export interface SignalCheck { hit: boolean; clear: boolean; now: string; detail: string }

/**
 * Whether a momentum signal holds at price p. closes are hourly, oldest first; the current price is taken as the
 * newest close. `clear` says the condition has gone away again, so a rule that repeats only fires once per signal.
 */
export function checkSignal(w: { signal: Signal; tf?: "1h" | "4h"; value?: number }, p: number, hourly: number[] | null): SignalCheck {
  const wait = { hit: false, clear: false, now: "Waiting for price history", detail: "" };
  if (!hourly || !hourly.length) return wait;
  const c = [...(w.tf === "4h" ? fourHour(hourly) : hourly), p], tf = w.tf === "4h" ? "4-hour" : "hourly", $ = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
  switch (w.signal) {
    case "rsi_below": case "rsi_above": {
      const v = rsi(c); if (v === null) return wait;
      const lvl = w.value ?? (w.signal === "rsi_below" ? 30 : 70);
      return w.signal === "rsi_below"
        ? { hit: v <= lvl, clear: v > lvl + 5, now: `RSI ${v.toFixed(0)}`, detail: `${tf} RSI is ${v.toFixed(0)}, below ${lvl}` }
        : { hit: v >= lvl, clear: v < lvl - 5, now: `RSI ${v.toFixed(0)}`, detail: `${tf} RSI is ${v.toFixed(0)}, above ${lvl}` };
    }
    case "macd_up": case "macd_down": {
      const h = macdHist(c); if (!h) return wait;
      const up = w.signal === "macd_up";
      return up
        ? { hit: h.prev <= 0 && h.now > 0, clear: h.now < 0, now: `MACD ${h.now >= 0 ? "above" : "below"} signal`, detail: `${tf} MACD crossed above its signal line` }
        : { hit: h.prev >= 0 && h.now < 0, clear: h.now > 0, now: `MACD ${h.now >= 0 ? "above" : "below"} signal`, detail: `${tf} MACD crossed below its signal line` };
    }
    case "breakout_up": case "breakout_down": {
      const n = w.value ?? 20; if (c.length < n + 1) return wait;
      const prior = c.slice(-n - 1, -1), hi = Math.max(...prior), lo = Math.min(...prior);
      return w.signal === "breakout_up"
        ? { hit: p > hi, clear: p < hi * 0.995, now: `${$(hi)} to break`, detail: `broke above ${$(hi)}, its highest ${tf} close of the last ${n}` }
        : { hit: p < lo, clear: p > lo * 1.005, now: `${$(lo)} to break`, detail: `broke below ${$(lo)}, its lowest ${tf} close of the last ${n}` };
    }
  }
}
