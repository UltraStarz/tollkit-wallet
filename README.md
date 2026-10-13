# Tollkit Wallet

A wallet for AI trading agents. It holds its keys on your computer, encrypted with your password, and lets an agent:

- swap tokens on Base and Ethereum (via 0x) and Solana (via Jupiter)
- pay for APIs that charge per call (x402 and MPP, in USDC or USDT)

All of it happens inside limits that you set and the agent can't change.

## What it checks before spending

- **Limits:** per trade, per day, per payment, and per seller per day. These are counted under a lock, so parallel calls can't overspend.
- **Approval:** anything over your threshold waits for you to tap Approve in Telegram. No answer means no.
- **Sanctions:** every payment recipient is screened against the OFAC list.
- **Seller check:** the seller's price and pay-to address are compared with its public listing (Tollkit Weigh Station).
- **Swap safety:** the fee must be no more than 0.5%, the only contract ever approved is 0x AllowanceHolder (for exact amounts), and a minimum output is always set.
- **Receipts:** every trade and payment is logged, and you can export them as CSV.

## Fees

Swaps cost a flat 0.5%, shown before every trade. On some Base and Ethereum pairs, 0x charges its own 0.15% on top, and this is shown separately. Payments for APIs carry no Tollkit fee.

## Setup

```
npm install -g tollkit-wallet
tollkit-wallet init                 # choose a password; prints your Base/Ethereum and Solana addresses
tollkit-wallet budget               # see limits; change with e.g. budget per_trade_usd=100
tollkit-wallet telegram <bot-token> <chat-id>   # optional: approvals in Telegram
```

Then fund the addresses. Base and Solana are on by default; turn Ethereum on with `tollkit-wallet budget chains=base,solana,ethereum` (its network fees are higher).

## Withdrawals

Funds can only be withdrawn to addresses you've saved, and saving one needs your password:

```
tollkit-wallet addresses add base 0xYourAddress "my coinbase"
tollkit-wallet withdraw base 25 USDC 0xYourAddress
```

The agent has no tool for this.

## Use with an agent (MCP)

```json
{
  "mcpServers": {
    "tollkit-wallet": {
      "command": "tollkit-wallet",
      "args": ["mcp"],
      "env": { "TOLLKIT_WALLET_PASSWORD_FILE": "/path/to/a/file/with/your/password" }
    }
  }
}
```

Tools: `wallet_status`, `wallet_balances`, `swap_quote`, `swap`, `pay_fetch`, `seller_check`, `receipts`. There is no tool for changing limits, approvals or keys.

## Use with Coinbase AgentKit

```ts
import { AgentKit } from "@coinbase/agentkit";
import { TollkitWallet } from "tollkit-wallet";
import { tollkitWalletActionProvider } from "tollkit-wallet/agentkit";

const wallet = await TollkitWallet.open(process.env.TOLLKIT_WALLET_PASSWORD!);
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [tollkitWalletActionProvider(wallet)] });
```

This adds `tollkit_swap`, `tollkit_swap_quote`, `tollkit_pay_fetch`, `tollkit_wallet_balances`, `tollkit_wallet_status`, `tollkit_seller_check` and `tollkit_receipts`. They use the Tollkit wallet's own keys and limits, whatever AgentKit wallet provider you use.

## Use with ElizaOS

```ts
import { tollkitWalletPlugin } from "tollkit-wallet/elizaos";
// in your character or project: plugins: [tollkitWalletPlugin]
```

Set `TOLLKIT_WALLET_PASSWORD` (or `TOLLKIT_WALLET_PASSWORD_FILE`) in the agent's settings or environment. The agent's model reads the request ("swap 25 USDC to SOL"), and the wallet checks it against your limits before anything is signed.

## Use from code

```ts
import { TollkitWallet } from "tollkit-wallet";
const w = await TollkitWallet.open(process.env.TOLLKIT_WALLET_PASSWORD!);
const r = await w.pay("https://api.example.com/paid-endpoint");
```

## Where things live

`~/.tollkit-wallet/` (or `TOLLKIT_WALLET_HOME`) holds:

- `keystore.json` (encrypted)
- `policy.json` (sealed with your password; editing it by hand pauses spending)
- `ledger.jsonl` (receipts)
- `telegram.json`
- the cached sanctions list

Swap quotes come through api.tollkit.dev. It holds the 0x and Jupiter API keys and adds the fee, and it only ever sees public data and signed transactions.

If you lose the password, the funds can't be recovered.
