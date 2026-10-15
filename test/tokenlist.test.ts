/** The wallet's token list, Jupiter data, listed balances and the token check. No network. */
import { AbiCoder, Interface } from "ethers";
import { checkToken, evmBalances, evmList, findListed, loadExtraLists, searchEvm, searchSolana, solanaInfo, MULTICALL3 } from "../src/tokenlist.js";

let pass = 0, fail = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { pass++; console.log("  ok  ", l); } else { fail++; console.log("  FAIL", l, d ?? ""); } };

const base = evmList("base"), eth = evmList("ethereum");
check(base.length > 200 && eth.length > 200, "hundreds of listed tokens on Base and Ethereum", [base.length, eth.length]);
check(base[0]!.trust === "core" && base.some((t) => t.symbol === "USDC" && t.trust === "core"), "core tokens first, marked core");
check(base.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address)) && new Set(base.map((t) => t.address.toLowerCase())).size === base.length, "addresses valid and unique");
check(base.filter((t) => t.trust === "listed").every((t) => !t.logo || t.logo.startsWith("https://")), "logos are https links");
const s1 = searchEvm("base", "usdc");
check(s1[0]?.symbol === "USDC" && s1[0]?.trust === "core", "search: an exact symbol ranks first", s1.slice(0, 3).map((t) => t.symbol));
const some = base.find((t) => t.trust === "listed")!;
check(searchEvm("base", some.address)[0]?.address === some.address && findListed("base", some.address.toLowerCase())?.symbol === some.symbol, "search and lookup by address");

// The Uniswap list adds Base-native tokens at run time
{
  const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  check(!findListed("base", AERO), "before: not on the bundled list");
  await loadExtraLists((async () => Response.json({ tokens: [{ chainId: 8453, address: AERO.toLowerCase(), symbol: "AERO", name: "Aerodrome", decimals: 18, logoURI: "https://x/a.png" }, { chainId: 8453, address: "bad", symbol: "X", decimals: 18 }, { chainId: 10, address: AERO, symbol: "OP-ONLY", decimals: 18 }] })) as any);
  check(findListed("base", AERO)?.symbol === "AERO" && searchEvm("base", "aero")[0]?.symbol === "AERO" && !evmList("base").some((t) => t.symbol === "OP-ONLY" || t.symbol === "X"), "after: AERO is listed and searchable; bad rows and other chains skipped");
}

// Jupiter (Solana)
const jup = (rows: any[]) => (async (u: string) => { seenUrl = u; return Response.json(rows); }) as unknown as typeof fetch;
let seenUrl = "";
const bonk = { id: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "Bonk", symbol: "Bonk", decimals: 5, icon: "https://arweave.net/x", isVerified: true, tags: ["verified", "strict"], organicScore: 87.3, organicScoreLabel: "high", audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30.4 } };
const scam = { id: "Scam111111111111111111111111111111111111111", name: "Bonk", symbol: "BONK", decimals: 6, icon: "javascript:alert(1)", isVerified: false, tags: [], organicScore: 2, organicScoreLabel: "low", audit: { isSus: true, topHoldersPercentage: 92 } };
const res = await searchSolana("bonk", jup([scam, bonk]));
check(res[0]?.address === bonk.id && res[0]?.trust === "listed" && res[1]?.trust === "unlisted", "Solana search: verified first; a look-alike marked unlisted", res.map((t) => [t.symbol, t.trust]));
check(res[1]?.logo === undefined && /search\?query=bonk/.test(seenUrl), "non-https icons dropped; query sent to Jupiter search");
const info = await solanaInfo([bonk.id, "Unknown11111111111111111111111111111111111"], jup([bonk]));
check(info.get(bonk.id)?.symbol === "Bonk" && info.get("Unknown11111111111111111111111111111111111") === null, "mint lookup: known and unknown");

// Listed balances through Multicall3
const MC = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);
let calls = 0;
const fakeCall = async (data: string) => {
  calls++;
  const [req] = MC.decodeFunctionData("aggregate3", data);
  const out = (req as any[]).map((_c, i) => (i === 1 ? [true, AbiCoder.defaultAbiCoder().encode(["uint256"], [1234n])] : i === 2 ? [false, "0x"] : [true, AbiCoder.defaultAbiCoder().encode(["uint256"], [0n])]));
  return MC.encodeFunctionResult("aggregate3", [out]);
};
const toks = base.slice(0, 5).map((t) => t.address);
const bals = await evmBalances("base", "0x1111111111111111111111111111111111111111", toks, undefined, fakeCall);
check(calls === 1 && bals.size === 1 && bals.get(toks[1]!) === 1234n, "one call for many tokens; zero and failed answers skipped");
check(MULTICALL3 === "0xcA11bde05977b3631167028862bE2a173976CA11", "Multicall3 address");

// The token check
const srv = (body: any, status = 200) => (async (u: string) => { seenUrl = u; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const c1 = await checkToken("base", usdc, { fetch: srv({ symbol: "USDC", name: "USD Coin", decimals: 6, price_usd: 1, warnings: [{ code: "can_pause", message: "Transfers can be paused by the owner." }, { code: "blacklist", message: "Can block addresses." }] }) });
check(c1.trust === "core" && c1.warnings.length === 0 && c1.powers.length === 2 && /token\/check\?chain=base&token=0x8335/.test(seenUrl), "USDC: issuer powers shown as facts, not warnings", c1);
const odd = "0x1234567890123456789012345678901234567890";
const c2 = await checkToken("base", odd, { fetch: srv({ symbol: "PEPE2", decimals: 18, warnings: [{ code: "can_pause", message: "Transfers can be paused." }, { code: "no_pool", message: "No pool." }] }) });
check(c2.trust === "unlisted" && c2.warnings.length === 2 && c2.facts.some((f) => /Not on the wallet's token lists/.test(f)), "an unknown token: every finding is a warning", c2);
let notTok = ""; try { await checkToken("base", "0x0000000000000000000000000000000000000002", { fetch: srv({ error: "not_a_contract", message: "0x… has no contract code on Base, so it isn't a token there." }, 422) }); } catch (e) { notTok = (e as Error).message; }
check(/isn't a token/.test(notTok), "not a token: a plain error");
const down = (async (u: string) => { if (u.includes("/token/check")) throw new Error("offline"); return Response.json([]); }) as unknown as typeof fetch;
const c3 = await checkToken("base", "0x2222222222222222222222222222222222222222", { fetch: down });
check(!c3.checked && c3.warnings.some((w) => /couldn't run/.test(w)), "check service down: says so, as a warning");
const c4 = await checkToken("solana", scam.id, { fetch: (async (u: string) => u.includes("jup.ag") ? Response.json([scam]) : Response.json({ symbol: "BONK", decimals: 6, mint_authority: "X", warnings: [{ code: "mint_authority_active", message: "X can create more of this token at any time." }] })) as unknown as typeof fetch });
check(c4.warnings.some((w) => /suspicious/.test(w)) && c4.warnings.some((w) => /92%/.test(w)) && c4.warnings.some((w) => /create more/.test(w)), "Solana look-alike: Jupiter's flags and the chain facts both warn", c4.warnings);

console.log(`\ntokenlist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
