// Tollkit Wallet provider, injected into pages. It holds no keys and no secrets: every call is
// passed to the Tollkit extension, which asks the Tollkit Wallet on this computer.
//   Ethereum (Base and Ethereum): EIP-1193 provider, announced with EIP-6963 (and window.ethereum if no other wallet set it).
//   Solana: registered with the Wallet Standard (wallet-standard:register-wallet / wallet-standard:app-ready).
(() => {
  if (window.__tollkitWallet) return;
  const TAG = "tollkit-wallet";
  const ICON = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="1.5" y="1.5" width="97" height="97" rx="20" fill="#0a0a0a" stroke="#2f3442" stroke-width="3"/><path d="M42 22h12v16h16v11H54v17c0 4.5 2 6.5 6.5 6.5H70V83H59C48 83 42 77.5 42 67V49h-9V38h9z" fill="#4a8eff"/></svg>');
  const pending = new Map();
  let n = 0;

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++n}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ [TAG]: "req", id, method, params }, window.location.origin);
    });
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== "res") return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) {
      const err = new Error(e.data.error.message || "Tollkit error");
      err.code = e.data.error.code;
      p.reject(err);
    } else p.resolve(e.data.result);
  });

  // ---- EIP-1193 ------------------------------------------------------------------------------
  const listeners = {};
  const emit = (ev, v) => (listeners[ev] || []).slice().forEach((f) => { try { f(v); } catch (x) { console.error(x); } });
  let chainId = null, accounts = [];
  const provider = {
    isTollkit: true,
    async request(args) {
      if (!args || typeof args !== "object" || typeof args.method !== "string") { const e = new Error("request() needs { method, params }"); e.code = -32602; throw e; }
      const { method, params } = args;
      const result = await call(method, params);
      if (method === "eth_chainId" && result !== chainId) { const first = chainId === null; chainId = result; if (!first) emit("chainChanged", result); }
      if ((method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") && result === null) {
        const next = String(params && params[0] && params[0].chainId).toLowerCase();
        if (next !== chainId) { chainId = next; emit("chainChanged", next); }
      }
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        const a = Array.isArray(result) ? result.map((x) => String(x).toLowerCase()) : [];
        if (a.join() !== accounts.join()) { const wasEmpty = !accounts.length; accounts = a; if (wasEmpty && a.length) emit("connect", { chainId: chainId || (await call("eth_chainId")) }); emit("accountsChanged", a); }
      }
      if (method === "wallet_revokePermissions") { accounts = []; emit("accountsChanged", []); }
      return result;
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
    off(ev, f) { return provider.removeListener(ev, f); },
    // Older apps
    enable() { return provider.request({ method: "eth_requestAccounts" }); },
  };
  Object.freeze(provider);
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: "Tollkit", icon: ICON, rdns: "dev.tollkit" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  if (!("ethereum" in window)) { try { Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false }); } catch { /* another wallet won */ } }

  // ---- Solana Wallet Standard -----------------------------------------------------------------
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const CHAINS = ["solana:mainnet"];
  const SOL_FEATURES = ["solana:signAndSendTransaction", "solana:signTransaction", "solana:signMessage"];
  let solAccounts = [];
  const solListeners = new Set();
  const changed = () => solListeners.forEach((f) => { try { f({ accounts: solAccounts }); } catch (x) { console.error(x); } });
  const makeAccount = (r) => Object.freeze({ address: r.address, publicKey: unb64(r.publicKey), chains: CHAINS, features: SOL_FEATURES, label: "Tollkit", icon: ICON });
  const mine = (acct) => { if (!acct || !solAccounts.some((a) => a.address === acct.address)) { const e = new Error("Connect this site to Tollkit first."); e.code = 4100; throw e; } };
  const wallet = {
    get version() { return "1.0.0"; },
    get name() { return "Tollkit"; },
    get icon() { return ICON; },
    get chains() { return CHAINS.slice(); },
    get accounts() { return solAccounts.slice(); },
    get features() {
      return {
        "standard:connect": { version: "1.0.0", connect: async (input) => {
          const r = await call("sol_connect", { silent: !!(input && input.silent) });
          solAccounts = [makeAccount(r)]; changed();
          return { accounts: solAccounts.slice() };
        } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { await call("sol_disconnect"); solAccounts = []; changed(); } },
        "standard:events": { version: "1.0.0", on: (ev, f) => { if (ev !== "change") return () => {}; solListeners.add(f); return () => solListeners.delete(f); } },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs) => {
          const out = [];
          for (const i of inputs) { mine(i.account); const r = await call("sol_signTransaction", { transaction: b64(i.transaction) }); out.push({ signedTransaction: unb64(r.signedTransaction) }); }
          return out;
        } },
        "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async (...inputs) => {
          const out = [];
          for (const i of inputs) {
            mine(i.account);
            if (i.chain && i.chain !== "solana:mainnet") { const e = new Error("Tollkit works on Solana mainnet only."); e.code = 4901; throw e; }
            const r = await call("sol_signAndSendTransaction", { transaction: b64(i.transaction), options: i.options ? { skipPreflight: !!i.options.skipPreflight } : undefined });
            out.push({ signature: unb64(r.signature) });
          }
          return out;
        } },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) => {
          const out = [];
          for (const i of inputs) { mine(i.account); const r = await call("sol_signMessage", { message: b64(i.message) }); out.push({ signedMessage: i.message, signature: unb64(r.signature), signatureType: "ed25519" }); }
          return out;
        } },
      };
    },
  };
  // Same registration as @wallet-standard/wallet's registerWallet (Apache-2.0).
  const callback = ({ register }) => register(wallet);
  class RegisterWalletEvent extends Event {
    #detail;
    get detail() { return this.#detail; }
    get type() { return "wallet-standard:register-wallet"; }
    constructor(cb) { super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false }); this.#detail = cb; }
    preventDefault() { throw new Error("preventDefault cannot be called"); }
    stopImmediatePropagation() { throw new Error("stopImmediatePropagation cannot be called"); }
    stopPropagation() { throw new Error("stopPropagation cannot be called"); }
  }
  try { window.dispatchEvent(new RegisterWalletEvent(callback)); } catch (x) { console.error("wallet-standard:register-wallet event could not be dispatched", x); }
  try { window.addEventListener("wallet-standard:app-ready", ({ detail: api }) => callback(api)); } catch (x) { console.error(x); }

  Object.defineProperty(window, "__tollkitWallet", { value: true });
})();
