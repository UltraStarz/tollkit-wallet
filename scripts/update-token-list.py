# Regenerates src/data/token-list.ts from the Superchain token list (MIT licence, see the file header).
# Usage: curl -s https://static.optimism.io/optimism.tokenlist.json -o /tmp/op.json && python3 scripts/update-token-list.py /tmp/op.json
import json, sys
d = json.load(open(sys.argv[1]))
P = "https://ethereum-optimism.github.io/data/"
rows = []
for x in d["tokens"]:
    if x["chainId"] not in (1, 8453): continue
    logo = x.get("logoURI", "")
    rows.append([x["chainId"], x["address"], x["symbol"], x["name"], x["decimals"], logo[len(P):] if logo.startswith(P) else logo, 1 if x.get("extensions", {}).get("opListId") == "default" else 0])
rows.sort(key=lambda r: (r[0], -r[6], r[2].lower()))
v = d["version"]
out = f'''/**
 * Popular tokens on Ethereum and Base, from the Superchain Token List (Base's reference list:
 * docs.base.org/tokens/list), version {v["major"]}.{v["minor"]}.{v["patch"]}, {d["timestamp"]}.
 * Source: https://static.optimism.io/optimism.tokenlist.json (github.com/ethereum-optimism/ethereum-optimism.github.io,
 * licence MIT per its package.json). The list's own note: tokens on it "are not reviewed for their quality", so
 * being listed is not a safety check; the wallet still runs its token check.
 * Logos stay on the list's own host. Regenerate with scripts/update-token-list.py.
 * Rows: [chainId, address, symbol, name, decimals, logo path under LOGO_BASE (or a full URL), 1 = the list's "default" tier].
 */
export const LOGO_BASE = "{P}";
export const LIST_VERSION = "{v["major"]}.{v["minor"]}.{v["patch"]}";
export const EVM_TOKENS: [number, string, string, string, number, string, number][] = {json.dumps(rows, ensure_ascii=False, separators=(",", ":"))};
'''
open("src/data/token-list.ts", "w").write(out)
print(len(rows), "tokens")
