const main = document.getElementById("main");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ask = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
const short = (a) => (a && a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "");

function pairView(err) {
  main.innerHTML = `<p>Connect this browser to the Tollkit Wallet on this computer.</p>
<ol><li>Start Tollkit: <b>tollkit-wallet ui</b></li><li>In Tollkit, open <b>Settings</b> and click <b>Pair a browser</b>.</li><li>Paste the code here.</li></ol>
<input id="code" placeholder="Paste the code from Tollkit" autocomplete="off" spellcheck="false">
<button id="go">Pair</button>${err ? `<div class="msg err">${esc(err)}</div>` : ""}`;
  const go = async () => {
    const b = document.getElementById("go"); b.disabled = true; b.textContent = "Pairing…";
    const r = await ask({ type: "pair", code: document.getElementById("code").value });
    if (r && r.ok) render(); else pairView((r && r.error) || "Pairing failed.");
  };
  document.getElementById("go").onclick = go;
  document.getElementById("code").onkeydown = (e) => { if (e.key === "Enter") go(); };
  document.getElementById("code").focus();
}

async function render() {
  const s = await ask({ type: "state" });
  if (!s || !s.paired) return pairView();
  if (s.error) {
    main.innerHTML = `<div class="row"><span class="dot off"></span><div>Tollkit isn't answering<small>${esc(s.error)}</small></div></div>
<p style="margin-top:10px">Start it with <b>tollkit-wallet ui</b>, then reopen this.</p><button class="g" id="un">Unpair this browser</button>`;
  } else {
    const sites = (s.sites || []).map((x) => `<div class="row"><div style="min-width:0"><div>${esc(new URL(x.origin).host)}</div><small>${[x.evm ? "Base/Ethereum" : "", x.solana ? "Solana" : ""].filter(Boolean).join(" + ")}</small></div></div>`).join("");
    main.innerHTML = `<div class="row"><span class="dot"></span><div>Connected to Tollkit<small>127.0.0.1:${esc(s.port)}</small></div></div>
<h4>Your addresses</h4>
<div class="row"><div style="min-width:0"><small>Base / Ethereum</small><div class="addr" title="${esc(s.evm)}">${esc(short(s.evm))}</div></div></div>
<div class="row"><div style="min-width:0"><small>Solana</small><div class="addr" title="${esc(s.solana)}">${esc(short(s.solana))}</div></div></div>
<h4>Connected sites</h4>${sites || `<p style="margin-top:6px">None yet. When a site asks to connect, approve it in Tollkit's Approvals tab.</p>`}
<p style="margin-top:12px">Every connect, signature and transaction waits for your OK in Tollkit. Manage sites in Tollkit's Settings.</p>
<button class="g" id="un">Unpair this browser</button>`;
  }
  document.getElementById("un").onclick = async () => { await ask({ type: "unpair" }); pairView(); };
}
render();
