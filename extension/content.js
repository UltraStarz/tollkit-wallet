// Tollkit Wallet: relays requests between the page's provider (inpage.js) and the extension.
// Only messages from this same window with Tollkit's tag are passed on. The site's origin is
// added by Chrome on the extension side, never taken from the page.
(() => {
  const TAG = "tollkit-wallet";
  let port = null;
  const open = new Set();
  let ping = null;

  function connect() {
    port = chrome.runtime.connect({ name: "tollkit" });
    port.onMessage.addListener((m) => {
      if (!m || typeof m.id !== "string") return;
      open.delete(m.id);
      if (!open.size && ping) { clearInterval(ping); ping = null; }
      window.postMessage({ [TAG]: "res", id: m.id, result: m.result, error: m.error }, window.location.origin);
    });
    port.onDisconnect.addListener(() => {
      // The extension restarted: fail what was waiting so the site can retry.
      for (const id of open) window.postMessage({ [TAG]: "res", id, error: { code: 4900, message: "Tollkit restarted. Try again." } }, window.location.origin);
      open.clear();
      port = null;
    });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== "req" || typeof e.data.id !== "string" || typeof e.data.method !== "string") return;
    if (!port) connect();
    open.add(e.data.id);
    // Messages on the port keep the extension's service worker running while the owner decides.
    if (!ping) ping = setInterval(() => { try { port && port.postMessage({ type: "ping" }); } catch { /* reconnects on next request */ } }, 20000);
    port.postMessage({ id: e.data.id, method: e.data.method, params: e.data.params });
  });
})();
