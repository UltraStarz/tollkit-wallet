// Tollkit Wallet extension service worker: forwards site requests to the Tollkit dashboard running
// on this computer (http://127.0.0.1:<port>), with the site's origin as Chrome reports it.
// It holds no keys; the wallet answers, and asks the owner first for anything that signs or connects.

// Keep the pairing token away from content scripts (storage.local is visible to them by default).
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

const NOT_PAIRED = { code: 4900, message: "Tollkit isn't set up in this browser. Click the Tollkit extension icon to pair it with your wallet." };
const NOT_RUNNING = { code: 4900, message: "Tollkit Wallet isn't open. Start it with: tollkit-wallet ui" };

async function cfg() {
  const c = await chrome.storage.local.get(["port", "token"]);
  return c.port && c.token ? c : null;
}

// Always POST: Chrome adds the extension's Origin header to POSTs, which the wallet checks.
async function call(c, path, body) {
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tw-ext": c.token },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error(j.error || NOT_PAIRED.message), { rpc: NOT_PAIRED });
  if (!r.ok) throw Object.assign(new Error(j.error || `Tollkit answered ${r.status}`), { rpc: { code: -32603, message: j.error || `Tollkit answered ${r.status}` } });
  return j;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(origin, method, params) {
  const c = await cfg();
  if (!c) return { error: NOT_PAIRED };
  let r;
  try { r = await call(c, "/api/ext/request", { origin, method, params }); }
  catch (e) { return { error: e.rpc || NOT_RUNNING }; }
  if (r.error) return { error: r.error };
  if ("result" in r) return { result: r.result };
  // Waiting for the owner: poll the result (approvals expire after 5 minutes).
  for (let i = 0; i < 400; i++) {
    await sleep(i < 20 ? 500 : 1000);
    let j;
    try { j = await call(c, "/api/ext/result", { id: r.id }); } catch (e) { return { error: e.rpc || NOT_RUNNING }; }
    if (j.error && !j.status) return { error: j.error };
    if (j.status === "done") return { result: j.result };
    if (j.status === "error") return { error: j.error };
  }
  return { error: { code: 4001, message: "No answer in Tollkit in time." } };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tollkit") return;
  const origin = port.sender && port.sender.origin;
  port.onMessage.addListener(async (m) => {
    if (!m || m.type === "ping" || typeof m.id !== "string") return;
    const out = origin ? await handle(origin, String(m.method), m.params) : { error: { code: 4100, message: "Unknown site." } };
    try { port.postMessage({ id: m.id, ...out }); } catch { /* the tab closed */ }
  });
});

// The popup pairs and reads state through here so the token stays in the service worker's storage.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only this extension's own pages (the popup), never content scripts in websites.
  if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return;
  (async () => {
    if (m.type === "pair") {
      const code = String(m.code || "").trim().toUpperCase();
      const port = Number((/^(\d{2,5})-/.exec(code) || [])[1]);
      if (!port) return reply({ error: "Paste the whole code shown in Tollkit's Settings (numbers, then two groups of four)." });
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/ext/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.token) return reply({ error: j.error || "Pairing failed." });
        await chrome.storage.local.set({ port, token: j.token });
        return reply({ ok: true });
      } catch { return reply({ error: NOT_RUNNING.message }); }
    }
    if (m.type === "state") {
      const c = await cfg();
      if (!c) return reply({ paired: false });
      try { return reply({ paired: true, port: c.port, ...(await call(c, "/api/ext/state", {})) }); }
      catch (e) { return reply({ paired: true, port: c.port, error: (e.rpc || NOT_RUNNING).message }); }
    }
    if (m.type === "unpair") { await chrome.storage.local.remove(["port", "token"]); return reply({ ok: true }); }
    reply({ error: "unknown" });
  })();
  return true;
});
