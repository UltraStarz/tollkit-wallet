/**
 * "Connect your AI": add this wallet's MCP server to AI apps on this computer.
 *
 * Every location and command below was checked against the app's docs, or by
 * running the app's own CLI, on 2026-10-14:
 *   Claude desktop  claude_desktop_config.json, "mcpServers"   (modelcontextprotocol.io, connect-local-servers)
 *   Cursor          ~/.cursor/mcp.json, "mcpServers"            (cursor.com/help/customization/mcp)
 *   Claude Code     claude mcp add|remove --scope user          (code.claude.com/docs/en/mcp; CLI writes ~/.claude.json)
 *   Codex           codex mcp add|remove                         (codex-cli 0.162.1 --help; writes ~/.codex/config.toml)
 *   Gemini CLI      gemini mcp add|remove -s user                (geminicli.com/docs/tools/mcp-server; writes ~/.gemini/settings.json)
 *   VS Code         vscode:mcp/install?{json} link               (code.visualstudio.com/api/extension-guides/ai/mcp)
 * Changes are made only when the owner clicks Add or Remove in the dashboard.
 * A JSON file is backed up next to itself before it's changed, and other entries are kept.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { passwordFile, customHome, walletHome } from "./paths.js";

export const SERVER_NAME = "tollkit-wallet";
export interface Launch { command: string; args: string[]; env: Record<string, string> }
export type AppId = "claude" | "claude-code" | "cursor" | "vscode" | "codex" | "gemini";
export interface AppStatus { id: AppId; found: boolean; added: boolean; current: boolean; how: "file" | "cli" | "link"; where?: string }

const home = () => os.homedir();
const isWin = process.platform === "win32";

/**
 * How an AI app should start the wallet. GUI apps often start without your shell's PATH,
 * so this uses absolute paths: this computer's node and this copy of the wallet. When the
 * wallet itself is running from npx's cache (which gets cleaned), it uses npx instead.
 */
export function launchConfig(dir?: string): Launch {
  const env: Record<string, string> = { TOLLKIT_WALLET_PASSWORD_FILE: passwordFile(dir) };
  if (customHome(dir)) env.TOLLKIT_WALLET_HOME = walletHome(dir);
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(cli) && !/[\\/]_npx[\\/]/.test(cli)) return { command: process.execPath, args: [cli, "mcp"], env };
  const npx = path.join(path.dirname(process.execPath), isWin ? "npx.cmd" : "npx");
  // npx is a node script, so the app also needs node on its PATH.
  if (!isWin && existsSync(npx)) return { command: npx, args: ["-y", "tollkit-wallet", "mcp"], env: { ...env, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":") } };
  return { command: "npx", args: ["-y", "tollkit-wallet", "mcp"], env };
}

function claudeDesktopFile(): string | null {
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (isWin && process.env.APPDATA) return path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  return null; // the docs give no Linux path
}
const cursorFile = () => path.join(home(), ".cursor", "mcp.json");

/** Finds a command on PATH without running a shell. */
export function which(cmd: string): string | null {
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) { const f = path.join(d, cmd + e); try { if (statSync(f).isFile()) return f; } catch { /* next */ } }
  }
  return null;
}

function readJson(file: string): any {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error(`${file} isn't plain JSON, so it wasn't changed. Use "Do it by hand" instead.`); }
}
const same = (a: any, b: Launch) => !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env);

function writeJsonEntry(file: string, entry: Launch | null) {
  const cfg = readJson(file);
  if (existsSync(file)) copyFileSync(file, `${file}.bak-tollkit`); // the last version before Tollkit changed it
  const servers = { ...(cfg.mcpServers ?? {}) };
  if (entry) servers[SERVER_NAME] = entry; else delete servers[SERVER_NAME];
  cfg.mcpServers = servers;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, file);
}

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: home(), shell: false });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("error", (e) => { clearTimeout(t); res({ code: -1, out: e.message }); });
    p.on("close", (code) => { clearTimeout(t); res({ code: code ?? -1, out: out.slice(-600) }); });
  });
}

function cliEntry(id: AppId): any {
  try {
    if (id === "claude-code") return readJson(path.join(home(), ".claude.json")).mcpServers?.[SERVER_NAME];
    if (id === "gemini") return readJson(path.join(home(), ".gemini", "settings.json")).mcpServers?.[SERVER_NAME];
    if (id === "codex") {
      const f = path.join(process.env.CODEX_HOME ?? path.join(home(), ".codex"), "config.toml");
      return existsSync(f) && readFileSync(f, "utf8").includes(`[mcp_servers.${SERVER_NAME}]`) ? { toml: true } : undefined;
    }
  } catch { return undefined; }
}

const CLI: Partial<Record<AppId, string>> = { "claude-code": "claude", codex: "codex", gemini: "gemini" };

export function appStatus(dir?: string): AppStatus[] {
  const want = launchConfig(dir);
  const out: AppStatus[] = [];
  const cd = claudeDesktopFile();
  { let e: any; try { e = cd ? readJson(cd).mcpServers?.[SERVER_NAME] : undefined; } catch { e = undefined; }
    out.push({ id: "claude", how: "file", where: cd ?? undefined, found: !!cd && existsSync(path.dirname(cd)), added: !!e, current: same(e, want) }); }
  for (const id of ["claude-code", "codex", "gemini"] as AppId[]) {
    const e = cliEntry(id);
    out.push({ id, how: "cli", found: !!which(CLI[id]!), added: !!e, current: e?.toml ? true : same(e, want) });
  }
  { let e: any; try { e = readJson(cursorFile()).mcpServers?.[SERVER_NAME]; } catch { e = undefined; }
    out.push({ id: "cursor", how: "file", where: cursorFile(), found: existsSync(path.dirname(cursorFile())), added: !!e, current: same(e, want) }); }
  out.push({ id: "vscode", how: "link", found: true, added: false, current: false });
  return out;
}

/** Saves the password for AI apps (owner-only file). The caller has already checked it. */
export function savePasswordFile(password: string, dir?: string): string {
  const f = passwordFile(dir);
  writeFileSync(f, password, { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

export async function addApp(id: AppId, dir?: string): Promise<string> {
  const l = launchConfig(dir);
  if (id === "claude") {
    const f = claudeDesktopFile();
    if (!f || !existsSync(path.dirname(f))) throw new Error("Claude desktop isn't installed on this computer.");
    writeJsonEntry(f, l);
    return "Added. Quit Claude completely and open it again.";
  }
  if (id === "cursor") {
    if (!existsSync(path.dirname(cursorFile()))) throw new Error("Cursor isn't installed on this computer.");
    writeJsonEntry(cursorFile(), l);
    return "Added. Restart Cursor.";
  }
  const bin = CLI[id];
  if (!bin) throw new Error("This app is added with its own link.");
  const exe = which(bin);
  if (!exe) throw new Error(`${bin} isn't on this computer's PATH.`);
  const envFlags = (flag: string) => Object.entries(l.env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  // Remove first so Add also updates an older entry. A "not found" here is fine.
  if (id === "claude-code") {
    await run(exe, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    const r = await run(exe, ["mcp", "add", ...envFlags("--env"), "--transport", "stdio", "--scope", "user", SERVER_NAME, "--", l.command, ...l.args]);
    if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.out.trim()}`);
    return "Added. Start a new Claude Code session.";
  }
  if (id === "codex") {
    await run(exe, ["mcp", "remove", SERVER_NAME]);
    const r = await run(exe, ["mcp", "add", SERVER_NAME, ...envFlags("--env"), "--", l.command, ...l.args]);
    if (r.code !== 0) throw new Error(`codex mcp add failed: ${r.out.trim()}`);
    return "Added. Start a new Codex session.";
  }
  await run(exe, ["mcp", "remove", "-s", "user", SERVER_NAME]);
  const r = await run(exe, ["mcp", "add", "-s", "user", ...envFlags("-e"), SERVER_NAME, l.command, "--", ...l.args]);
  if (r.code !== 0) throw new Error(`gemini mcp add failed: ${r.out.trim()}`);
  return "Added. Start a new Gemini CLI session.";
}

export async function removeApp(id: AppId): Promise<string> {
  if (id === "claude") { const f = claudeDesktopFile(); if (f && existsSync(f)) writeJsonEntry(f, null); return "Removed. Restart Claude."; }
  if (id === "cursor") { if (existsSync(cursorFile())) writeJsonEntry(cursorFile(), null); return "Removed. Restart Cursor."; }
  const exe = CLI[id] ? which(CLI[id]!) : null;
  if (!exe) throw new Error("Not found on this computer.");
  const args = id === "claude-code" ? ["mcp", "remove", "--scope", "user", SERVER_NAME] : id === "gemini" ? ["mcp", "remove", "-s", "user", SERVER_NAME] : ["mcp", "remove", SERVER_NAME];
  const r = await run(exe, args);
  if (r.code !== 0) throw new Error(r.out.trim() || "Couldn't remove it.");
  return "Removed.";
}

export function vscodeLink(dir?: string): string {
  return "vscode:mcp/install?" + encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "stdio", ...launchConfig(dir) }));
}
