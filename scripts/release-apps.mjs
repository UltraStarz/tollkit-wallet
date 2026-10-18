#!/usr/bin/env node
// One command to get a new version of the Tollkit apps ready: the Chrome extension, Android and iPhone.
//
//   node scripts/release-apps.mjs 0.3.2              sync, set versions, test, build
//   node scripts/release-apps.mjs 0.3.2 --skip-tests same, without the tests
//   node scripts/release-apps.mjs --check            only show what's out of sync and each app's version
//
// Run it from tollkit-wallet. It expects the other two projects next to it:
//   ../tollkit-extension   (Chrome extension)
//   ../tollkit-mobile      (Android + iPhone, Capacitor)
//
// What it does, in order:
//   1. Copies the app's code from tollkit-wallet/src into the extension (appsrc/), then the extension's
//      appsrc/ and app/ into tollkit-mobile, so all three run the same code.
//   2. Sets the version everywhere: the extension's manifest and package.json, the phone app's package.json,
//      Android's versionName (and versionCode + 1), iPhone's MARKETING_VERSION (and build number + 1).
//   3. Runs the extension's and the phone app's tests.
//   4. Builds the extension zip (tollkit-extension/tollkit-wallet-extension-<version>.zip) and the phone app's
//      web files, copied into the Android and iPhone projects (npx cap sync).
//
// It does not upload anything. Each store takes its own upload and review:
//   Chrome Web Store: upload the zip in the developer dashboard.
//   Google Play: build a signed bundle in Android Studio (needs the Play upload key).
//   App Store: Product > Archive in Xcode (needs the Apple Developer account).
// The npm package (tollkit-wallet itself) keeps its own version and is published separately with npm publish.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const skipTests = args.includes("--skip-tests");
const version = args.find((a) => !a.startsWith("--"));

const WALLET = process.cwd();
const EXT = path.resolve(WALLET, process.env.TOLLKIT_EXTENSION_DIR ?? "../tollkit-extension");
const MOB = path.resolve(WALLET, process.env.TOLLKIT_MOBILE_DIR ?? "../tollkit-mobile");

const fail = (m) => { console.error(`\n✖ ${m}`); process.exit(1); };
const step = (m) => console.log(`\n▶ ${m}`);
const run = (cmd, argv, cwd, extraEnv = {}) => {
  console.log(`  $ ${[cmd, ...argv].join(" ")}   (in ${path.basename(cwd)})`);
  execFileSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
};

if (!existsSync(path.join(WALLET, "src/ui.ts"))) fail("Run this from the tollkit-wallet folder.");
if (!existsSync(path.join(EXT, "static/manifest.json"))) fail(`Extension not found at ${EXT}`);
if (!existsSync(path.join(MOB, "capacitor.config.json"))) fail(`Phone app not found at ${MOB}`);

// ---- what's in sync right now -------------------------------------------------------------------
const files = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(path.join(dir, f)).isFile()) : [];
function differences(a, b, ignore = []) {
  const out = [];
  const fa = new Set(files(a).filter((f) => !ignore.includes(f))), fb = new Set(files(b).filter((f) => !ignore.includes(f)));
  for (const f of fa) if (!fb.has(f)) out.push(`${f} (missing)`); else if (!readFileSync(path.join(a, f)).equals(readFileSync(path.join(b, f)))) out.push(f);
  for (const f of fb) if (!fa.has(f)) out.push(`${f} (extra)`);
  return out;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const gradle = path.join(MOB, "android/app/build.gradle");
const pbx = path.join(MOB, "ios/App/App.xcodeproj/project.pbxproj");
const versions = () => ({
  extension: readJson(path.join(EXT, "static/manifest.json")).version,
  phone: readJson(path.join(MOB, "package.json")).version,
  android: /versionName "([^"]+)"/.exec(readFileSync(gradle, "utf8"))?.[1] + ` (code ${/versionCode (\d+)/.exec(readFileSync(gradle, "utf8"))?.[1]})`,
  iphone: /MARKETING_VERSION = ([^;]+);/.exec(readFileSync(pbx, "utf8"))?.[1] + ` (build ${/CURRENT_PROJECT_VERSION = (\d+);/.exec(readFileSync(pbx, "utf8"))?.[1]})`,
  npmPackage: readJson(path.join(WALLET, "package.json")).version,
});
const report = () => {
  const d1 = differences(path.join(WALLET, "src"), path.join(EXT, "appsrc"));
  const d2 = differences(path.join(EXT, "appsrc"), path.join(MOB, "appsrc"));
  const d3 = differences(path.join(EXT, "app"), path.join(MOB, "app"), ["prelude-mobile.js"]);
  console.log(`  wallet src → extension appsrc: ${d1.length ? d1.length + " differ: " + d1.slice(0, 8).join(", ") : "same"}`);
  console.log(`  extension appsrc → phone appsrc: ${d2.length ? d2.length + " differ: " + d2.slice(0, 8).join(", ") : "same"}`);
  console.log(`  extension app → phone app: ${d3.length ? d3.length + " differ: " + d3.slice(0, 8).join(", ") : "same"}`);
  for (const [k, v] of Object.entries(versions())) console.log(`  ${k}: ${v}`);
};

if (checkOnly) { step("Current state"); report(); process.exit(0); }
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail("Give the new version, for example: node scripts/release-apps.mjs 0.3.2");
const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const extNow = readJson(path.join(EXT, "static/manifest.json")).version;
if (!newer(version, extNow)) fail(`${version} must be higher than the extension's current ${extNow} (the Chrome Web Store refuses lower or equal versions).`);

// ---- 1. sync ------------------------------------------------------------------------------------
step("1/4 Same code in all three");
run("node", ["scripts/sync-app.mjs", path.join(WALLET, "src")], EXT);
const keep = path.join(MOB, "app/prelude-mobile.js");
const preludeMobile = readFileSync(keep);
for (const dir of ["appsrc", "app"]) { rmSync(path.join(MOB, dir), { recursive: true, force: true }); cpSync(path.join(EXT, dir), path.join(MOB, dir), { recursive: true }); }
writeFileSync(keep, preludeMobile);
console.log("  tollkit-mobile/appsrc and app/ now match the extension (prelude-mobile.js kept).");

// ---- 2. versions --------------------------------------------------------------------------------
step(`2/4 Version ${version} everywhere`);
const setJsonVersion = (p) => { const s = readFileSync(p, "utf8"); writeFileSync(p, s.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`)); };
setJsonVersion(path.join(EXT, "static/manifest.json"));
setJsonVersion(path.join(EXT, "package.json"));
setJsonVersion(path.join(MOB, "package.json"));
let g = readFileSync(gradle, "utf8");
g = g.replace(/versionName "[^"]+"/, `versionName "${version}"`).replace(/versionCode (\d+)/, (_, n) => `versionCode ${Number(n) + 1}`);
writeFileSync(gradle, g);
let p = readFileSync(pbx, "utf8");
p = p.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = (\d+);/g, (_, n) => `CURRENT_PROJECT_VERSION = ${Number(n) + 1};`);
writeFileSync(pbx, p);
for (const [k, v] of Object.entries(versions())) console.log(`  ${k}: ${v}`);

// ---- 3. tests -----------------------------------------------------------------------------------
if (skipTests) step("3/4 Tests skipped (--skip-tests)");
else {
  step("3/4 Tests (a Chrome window opens for the extension's browser test)");
  run("npm", ["test"], EXT);
  run("npm", ["test"], MOB);
}

// ---- 4. builds ----------------------------------------------------------------------------------
step("4/4 Builds");
run("node", ["build.mjs"], EXT); // after the tests, so the zip has no test hooks
const zip = path.join(EXT, `tollkit-wallet-extension-${version}.zip`);
rmSync(zip, { force: true });
run("zip", ["-qr", "-X", zip, "."], path.join(EXT, "dist"));
const zipped = readJson(path.join(EXT, "dist/manifest.json")).version;
if (zipped !== version) fail(`The zip's manifest says ${zipped}, not ${version}.`);
console.log(`  ${path.relative(path.dirname(WALLET), zip)}`);
run("node", ["build.mjs"], MOB);
run("npx", ["cap", "sync"], MOB);

console.log(`
✔ Version ${version} is ready.

Next, by hand:
  • Chrome Web Store: upload tollkit-extension/tollkit-wallet-extension-${version}.zip (Package → Upload new package).
  • Google Play: open tollkit-mobile/android in Android Studio → Build → Generate Signed Bundle.
  • App Store: open tollkit-mobile/ios/App/App.xcodeproj in Xcode → Product → Archive.
  • Commit tollkit-wallet, tollkit-extension and tollkit-mobile.
`);
