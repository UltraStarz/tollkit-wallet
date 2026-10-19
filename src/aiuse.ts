/**
 * Which AI apps are using the wallet, and when. The MCP server (src/mcp.ts) notes every tool call here with the
 * app's name, which the app sends when it connects (MCP `clientInfo`), or which Tollkit's relay passes along for
 * apps that reach the wallet by its connector address. The dashboard shows it at the top ("Claude · active now")
 * and on each receipt the app made.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { walletHome } from "./paths.js";

export interface AiUse { app: string; last: string; calls: number; last_tool: string }

/** A readable name for the name an AI app reports about itself. Unknown names are kept, just tidied. */
export function appName(raw?: string | null): string {
  const s = String(raw ?? "").trim();
  if (!s) return "An AI app";
  const known: [RegExp, string][] = [
    [/tollkit[-_ ]extension[-_ ]relay/i, "An AI app"],
    [/claude[-_ ]?code/i, "Claude Code"], [/claude|anthropic/i, "Claude"], [/chatgpt|openai(?!.*codex)/i, "ChatGPT"],
    [/codex/i, "Codex"], [/cursor/i, "Cursor"], [/gemini/i, "Gemini"], [/copilot|visual studio code|vscode/i, "VS Code"],
    [/windsurf|codeium/i, "Windsurf"], [/cline/i, "Cline"], [/zed/i, "Zed"], [/tollkit[-_ ]?ai|advisor/i, "Tollkit AI"],
  ];
  for (const [re, name] of known) if (re.test(s)) return name;
  return s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").slice(0, 32);
}

const fileOf = (dir?: string) => path.join(walletHome(dir), "ai-use.json");

export function readAiUse(dir?: string): AiUse[] {
  try {
    const f = fileOf(dir);
    if (!existsSync(f)) return [];
    const v = JSON.parse(readFileSync(f, "utf8"));
    return (Array.isArray(v) ? v : []).filter((x: any) => x && typeof x.app === "string" && typeof x.last === "string").sort((a: AiUse, b: AiUse) => b.last.localeCompare(a.last));
  } catch { return []; }
}

/** Notes one tool call by `app`. Display only: a failure here never stops the call. */
export function noteAiUse(dir: string | undefined, app: string, tool: string, now = new Date()): void {
  try {
    const all = readAiUse(dir), prev = all.find((x) => x.app === app);
    const list = all.filter((x) => x.app !== app);
    list.unshift({ app, last: now.toISOString(), calls: (prev?.calls ?? 0) + 1, last_tool: tool });
    writeFileSync(fileOf(dir), JSON.stringify(list.slice(0, 20)), { mode: 0o600 });
  } catch { /* display only */ }
}
