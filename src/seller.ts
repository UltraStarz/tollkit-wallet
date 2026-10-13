/**
 * Seller check before paying, using Weigh Station (api.tollkit.dev/check):
 * is the endpoint up, does its live quote match its Coinbase listing, and
 * does the pay-to address we are about to pay match what it quotes.
 * "warning" signals block (or need approval, per policy); "caution" passes.
 */
type Fetch = typeof fetch;
export interface SellerSignal { code: string; level: "info" | "caution" | "warning"; detail: string }
export interface SellerVerdict { ok: boolean; warnings: SellerSignal[]; cautions: SellerSignal[]; quoted_pay_to: string[]; checked: boolean }

export async function checkSeller(url: string, payTo: string, f: Fetch = fetch, base = "https://api.tollkit.dev"): Promise<SellerVerdict> {
  let d: any;
  try {
    const r = await f(`${base}/check?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch {
    // The check is advisory; if Weigh Station is down we say so and don't block.
    return { ok: true, warnings: [], cautions: [{ code: "check_unavailable", level: "caution", detail: "Seller check could not run." }], quoted_pay_to: [], checked: false };
  }
  const signals: SellerSignal[] = Array.isArray(d?.signals) ? d.signals : [];
  const warnings = signals.filter((s) => s.level === "warning");
  const quoted = (Array.isArray(d?.offers) ? d.offers : []).map((o: any) => String(o.pay_to ?? "")).filter(Boolean);
  if (payTo && quoted.length && !quoted.some((p: string) => p.toLowerCase() === payTo.toLowerCase())) {
    warnings.push({ code: "pay_to_mismatch", level: "warning", detail: `The payment asks to pay ${payTo}, but the seller's own quote names ${quoted.join(", ")}.` });
  }
  return { ok: warnings.length === 0, warnings, cautions: signals.filter((s) => s.level === "caution"), quoted_pay_to: quoted, checked: true };
}
