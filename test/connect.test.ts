/** Connect your AI: JSON config merge (Cursor), CLI apps via fake binaries, password file. No real apps touched. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

const fakeHome = mkdtempSync(path.join(os.tmpdir(), "twc-home-"));
const wdir = path.join(fakeHome, ".tollkit-wallet");
const bin = path.join(fakeHome, "bin"); mkdirSync(bin);
process.env.HOME = fakeHome; process.env.USERPROFILE = fakeHome;
process.env.PATH = bin; // only our fake CLIs are found
const { addApp, appStatus, launchConfig, removeApp, savePasswordFile, which } = await import("../src/connect.js");

// launch config: absolute node + this wallet's cli, password file env, no custom home for the default folder
const l = launchConfig();
check(l.args.at(-1) === "mcp" && path.isAbsolute(l.command), "launch: absolute command, ends with mcp", l);
check(l.env.TOLLKIT_WALLET_PASSWORD_FILE === path.join(wdir, "password") && !("TOLLKIT_WALLET_HOME" in l.env), "launch: password file in the default folder", l.env);

// nothing installed
let st = appStatus();
check(st.length === 6 && st.filter((a) => a.found).map((a) => a.id).join() === "vscode", "nothing found except the VS Code link", st);
let err = ""; try { await addApp("cursor"); } catch (e) { err = (e as Error).message; }
check(/isn't installed/.test(err), "Cursor not installed: refused", err);

// Cursor: keeps other servers and keys, backs up, adds, then removes only ours
mkdirSync(path.join(fakeHome, ".cursor"));
const cf = path.join(fakeHome, ".cursor", "mcp.json");
writeFileSync(cf, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }));
const msg = await addApp("cursor");
const c1 = JSON.parse(readFileSync(cf, "utf8"));
check(/Restart Cursor/.test(msg) && c1.keep === 1 && c1.mcpServers.other.command === "x" && c1.mcpServers["tollkit-wallet"].args.at(-1) === "mcp", "Cursor: added, other entries kept", c1);
check(existsSync(cf + ".bak-tollkit") && JSON.parse(readFileSync(cf + ".bak-tollkit", "utf8")).mcpServers["tollkit-wallet"] === undefined, "Cursor: backup of the old file");
st = appStatus();
check(st.find((a) => a.id === "cursor")!.added && st.find((a) => a.id === "cursor")!.current, "Cursor shows connected and current");
await removeApp("cursor");
const c2 = JSON.parse(readFileSync(cf, "utf8"));
check(!c2.mcpServers["tollkit-wallet"] && c2.mcpServers.other, "Cursor: remove takes out only ours");
writeFileSync(cf, "{ not json");
err = ""; try { await addApp("cursor"); } catch (e) { err = (e as Error).message; }
check(/isn't plain JSON/.test(err) && readFileSync(cf, "utf8") === "{ not json", "broken JSON is left alone", err);

// CLI apps: fake claude/codex/gemini that log their arguments
const log = path.join(fakeHome, "calls.log");
for (const name of ["claude", "codex", "gemini"]) {
  const f = path.join(bin, name);
  writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`); chmodSync(f, 0o755);
}
check(which("claude") === path.join(bin, "claude"), "finds CLIs on PATH");
await addApp("claude-code"); await addApp("codex"); await addApp("gemini");
const calls = readFileSync(log, "utf8").trim().split("\n");
const p = path.join(wdir, "password");
const E = (f: string) => Object.entries(l.env).map(([k, v]) => `${f} ${k}=${v}`).join(" ");
check(l.env.TOLLKIT_WALLET_PASSWORD_FILE === p, "env carries the password file");
check(calls[0] === "claude mcp remove --scope user tollkit-wallet" && calls[1] === `claude mcp add ${E("--env")} --transport stdio --scope user tollkit-wallet -- ${l.command} ${l.args.join(" ")}`, "Claude Code: remove then add, documented syntax", calls.slice(0, 2));
check(calls[3] === `codex mcp add tollkit-wallet ${E("--env")} -- ${l.command} ${l.args.join(" ")}`, "Codex: documented syntax", calls[3]);
check(calls[5] === `gemini mcp add -s user ${E("-e")} tollkit-wallet ${l.command} -- ${l.args.join(" ")}`, "Gemini CLI: documented syntax", calls[5]);
const fail1 = path.join(bin, "codex"); writeFileSync(fail1, `#!/bin/sh\necho "boom" >&2\nexit 3\n`); chmodSync(fail1, 0o755);
err = ""; try { await addApp("codex"); } catch (e) { err = (e as Error).message; }
check(/codex mcp add failed: boom/.test(err), "a failing CLI is reported", err);

// password file: owner-only
const pf = savePasswordFile("pw-xyz");
check(readFileSync(pf, "utf8") === "pw-xyz" && (statSync(pf).mode & 0o777) === 0o600, "password file is 0600", (statSync(pf).mode & 0o777).toString(8));

console.log(`\nconnect: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
