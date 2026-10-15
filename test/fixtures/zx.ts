/** A real-shaped 0x AllowanceHolder.exec call (as decoded from a live Base quote, 2026-10-14), for test quote servers. */
import { AbiCoder, Interface } from "ethers";
export const SETTLER = "0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059";
const AH = new Interface(["function exec(address,address,uint256,address,bytes)"]);
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** Calldata for a quote URL's sellToken/sellAmount/taker/buyToken and the minimum the quote returns. */
export function zxData(url: URL, min: string): string {
  const sellTok = url.searchParams.get("sellToken")!;
  return AH.encodeFunctionData("exec", [SETTLER, sellTok.toLowerCase() === NATIVE ? "0x0000000000000000000000000000000000000000" : sellTok, url.searchParams.get("sellAmount")!, SETTLER,
    "0x1fff991f" + AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256"], [url.searchParams.get("taker")!, url.searchParams.get("buyToken")!, min]).slice(2) + "00".repeat(96)]);
}
