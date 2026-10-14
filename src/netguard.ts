/** Keeping agent-driven requests on the public internet. */

/** This computer and private networks (so an agent can't reach the local dashboard or devices). */
export function isLocalUrl(u: string): boolean {
  let h: string;
  try { h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return true; }
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (h.includes(":")) return /^(fe80|fc|fd)/.test(h) || h.startsWith("::ffff:");
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * fetch that refuses this computer and private networks, on the first URL and on every redirect
 * (Node's fetch would otherwise follow a redirect to 127.0.0.1 with the same method and headers).
 */
export function publicFetch(f: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let opts: RequestInit = { ...init };
    for (let hop = 0; hop <= 5; hop++) {
      if (isLocalUrl(url)) throw new Error("Refused: that address is on this computer or a private network.");
      const r = await f(url, { ...opts, redirect: "manual" });
      const loc = r.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(r.status) || !loc) return r;
      url = new URL(loc, url).href;
      const m = String(opts.method ?? "GET").toUpperCase();
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === "POST")) opts = { ...opts, method: "GET", body: undefined };
    }
    throw new Error("Too many redirects.");
  }) as typeof fetch;
}
