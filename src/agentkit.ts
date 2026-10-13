/**
 * Coinbase AgentKit action provider.
 *
 *   import { AgentKit } from "@coinbase/agentkit";
 *   import { TollkitWallet } from "tollkit-wallet";
 *   import { tollkitWalletActionProvider } from "tollkit-wallet/agentkit";
 *   const w = await TollkitWallet.open(process.env.TOLLKIT_WALLET_PASSWORD!);
 *   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [tollkitWalletActionProvider(w)] });
 *
 * Trades and payments use the Tollkit wallet's own keys and limits, not the
 * AgentKit wallet provider, so they work the same whatever provider you use.
 * Actions are returned directly (no decorators), so no per-call analytics
 * events are sent from this provider.
 */
import { ActionProvider, type Action, type Network, type WalletProvider } from "@coinbase/agentkit";
import { ACTIONS } from "./actions.js";
import type { TollkitWallet } from "./wallet.js";

export class TollkitWalletActionProvider extends ActionProvider<WalletProvider> {
  constructor(private readonly wallet: TollkitWallet) { super("tollkit_wallet", []); }

  override getActions(_walletProvider: WalletProvider): Action[] {
    return ACTIONS.map((a) => ({
      name: `tollkit_${a.name}`,
      description: a.description,
      schema: a.schema as any,
      invoke: async (args: any) => {
        const parsed = a.schema.safeParse(args ?? {});
        if (!parsed.success) return JSON.stringify({ ok: false, refused: { code: "bad_request", reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
        return JSON.stringify(await (a.run as any)(this.wallet, parsed.data));
      },
    }));
  }

  /** Works on any network AgentKit is set to; the chain is chosen per action. */
  supportsNetwork(_network: Network): boolean { return true; }
}

export const tollkitWalletActionProvider = (wallet: TollkitWallet) => new TollkitWalletActionProvider(wallet);
