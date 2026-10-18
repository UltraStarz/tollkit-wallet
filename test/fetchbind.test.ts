/**
 * Browsers and extension service workers throw "Illegal invocation" when the built-in fetch is called as a method
 * of another object (this.f(url) where f is the global fetch). Node doesn't, so this test makes fetch strict the
 * way Chrome is and checks every class that keeps a fetch calls it plainly.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Mover } from "../src/bridge.js";

let ok = 0, bad = 0;
const t = (name: string, cond: boolean) => { if (cond) { ok++; console.log("ok   " + name); } else { bad++; console.log("FAIL " + name); } };

async function main() {
const real = globalThis.fetch;
let calls = 0;
(globalThis as any).fetch = function (this: unknown, _i: any, _n?: any) {
  if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
  calls++;
  return Promise.resolve(new Response("{}", { status: 404 }));
};
try {
  const m = new Mover({ evm: "0x0000000000000000000000000000000000000001", solana: "11111111111111111111111111111111", proxy: "https://x.invalid" });
  const err = await m.config().then(() => null, (e: Error) => e);
  t("Move uses the built-in fetch without a wrong 'this'", !!err && !/Illegal invocation/.test(err.message) && calls === 1);
} finally { (globalThis as any).fetch = real; }

// No class may hand back the bare global fetch to be called as this.f(...).
const dir = path.resolve("src");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
  const s = readFileSync(path.join(dir, f), "utf8");
  t(`${f}: no getter returns the bare global fetch`, !/get f\(\)[^{]*\{\s*return [^;]*\?\? fetch;/.test(s));
  t(`${f}: no field defaults to the bare global fetch`, !/private (readonly )?\w+: (Fetch|typeof fetch) = fetch\b/.test(s));
}
console.log(`\n${ok} passed, ${bad} failed`);
if (bad) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
