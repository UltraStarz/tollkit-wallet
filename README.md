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
tollkit-wallet budget               # see limits; change with e.g. budget per_trade_usd=100 (or in the dashboard's Settings tab)
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

Tools: `wallet_status`, `wallet_balances`, `swap_quote`, `swap`, `pay_fetch`, `seller_check`, `receipts`, `market_prices`, `price_history`, `autopilot_propose`, `autopilot_rules`, `autopilot_cancel`, `paper_swap`, `paper_status`. There is no tool for changing limits, approvals or keys.

The easiest way: open the dashboard (`tollkit-wallet ui`), click **Connect your AI**, type your wallet password and click **Add** next to your app. It finds Claude desktop, Claude Code, Cursor, Codex and Gemini CLI on your computer and adds the wallet to their settings for you (keeping a backup of any file it changes); VS Code opens to confirm. Each app also has the steps to do it by hand.

The app needs to unlock the wallet on its own, so adding an app saves your password to `~/.tollkit-wallet/password`, readable only by your user account (or run `tollkit-wallet password-file` to do just that step). Anyone who can read that file and your wallet folder can spend within your limits, so keep both on this computer.

## Use with Coinbase AgentKit

```ts
import { AgentKit } from "@coinbase/agentkit";
import { TollkitWallet } from "tollkit-wallet";
import { tollkitWalletActionProvider } from "tollkit-wallet/agentkit";

const wallet = await TollkitWallet.open(process.env.TOLLKIT_WALLET_PASSWORD!);
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [tollkitWalletActionProvider(wallet)] });
```

This adds the same 14 tools as the MCP server, with a `tollkit_` prefix (`tollkit_swap`, `tollkit_pay_fetch`, `tollkit_autopilot_propose`, …). They use the Tollkit wallet's own keys and limits, whatever AgentKit wallet provider you use.

## Use with ElizaOS

```ts
import { tollkitWalletPlugin } from "tollkit-wallet/elizaos";
// in your character or project: plugins: [tollkitWalletPlugin]
```

Set `TOLLKIT_WALLET_PASSWORD` (or `TOLLKIT_WALLET_PASSWORD_FILE`) in the agent's settings or environment. The agent's model reads the request ("swap 25 USDC to SOL"), and the wallet checks it against your limits before anything is signed.

## Use with websites (browser extension)

The Tollkit extension for Chrome, Brave and Edge lets websites connect to this wallet the way they connect to MetaMask or Phantom: Base and Ethereum apps through the standard Ethereum provider (EIP-1193/EIP-6963), Solana apps through the Wallet Standard.

Keys stay in Tollkit. When a site asks to connect, sign or send, the request shows up in the dashboard's Approvals tab with the site's name and the details. Transactions are checked against the network first. Nothing happens until you approve. Read-only calls go straight through.

To add it: run `tollkit-wallet extension` for the folder and steps (Developer mode, then Load unpacked), then pair it from **Settings → Pair a browser**. Connected sites are listed in Settings, where you can disconnect them. The dashboard has to be open for sites to use the wallet.

## Use from code

```ts
import { TollkitWallet } from "tollkit-wallet";
const w = await TollkitWallet.open(process.env.TOLLKIT_WALLET_PASSWORD!);
const r = await w.pay("https://api.example.com/paid-endpoint");
```

## Backup and recovery

New wallets (0.2.2 and later) are made from a 12-word recovery phrase. It's shown once when you create the wallet, and you can see it again with `tollkit-wallet backup` or **Back up** in the dashboard (password needed). The dashboard asks you to confirm three of the words before it counts as backed up.

The phrase uses the same derivation paths as MetaMask and Phantom (Base/Ethereum `m/44'/60'/0'/0/0`, Solana `m/44'/501'/0'/0'`), so it restores the same addresses there too.

To restore: `tollkit-wallet restore` and type the phrase. Wallets made before 0.2.2 have no phrase; their backup is the two private keys (`tollkit-wallet backup` shows them), restored with `tollkit-wallet restore --keys`. Add `--replace` to restore over an existing wallet; its files are kept, renamed with `.replaced-<time>`.

## Tokens and price charts

The dashboard's Home tab lists every token the wallet holds that has a price, with its value and 24-hour change. Tap a token for a price chart (1D, 1W, 1M, 1Y). Prices and charts come from DefiLlama.

How tokens are found:
- Solana: every SPL and Token-2022 token account the address owns.
- Ethereum: Blockscout's public token list for the address.
- Base: tokens you've swapped into with this wallet, plus any you add with **Add a token** (paste the contract address). Base has no free public token index that works without a key, so the wallet doesn't scan for others.

Tokens with no price (most airdropped spam) are hidden and counted below the list. Added tokens are saved in `tokens.json` in the wallet folder.

## Buy crypto with a card

**Buy** on the Home tab opens Coinbase's checkout to buy USDC or ETH on Base or Ethereum, or USDC or SOL on Solana, sent straight to this wallet's address. The wallet asks Tollkit's server for a single-use Coinbase Onramp link; only your public address, the network, the coin and the amount are sent. Coinbase handles the payment and any ID checks, and its own fees and limits apply. Tick **Test purchase** to try it in Coinbase's sandbox with no real money.

## Cash out to your bank

**Sell** on the Home tab sells USDC, ETH or SOL through Coinbase to your bank or PayPal. You need a Coinbase account. The wallet opens Coinbase's sell page; you choose where the money goes and click **Cash out now**. Coinbase then gives an address to send the crypto to, and the dashboard shows it with the amount, Coinbase's fee and what you'll receive. Nothing is sent until you confirm with your password. Coinbase allows 30 minutes for the send. Only your public address, the network, the coin and the amount go to Tollkit's server.

## Move between networks

**Move** on the Home tab sends your own USDC between Base, Ethereum and Solana, or ETH between Base and Ethereum, to this wallet's address on the other network.

- USDC uses Circle's own transfer (CCTP): it's burned on one network and minted on the other by Circle, usually in 8 to 20 seconds. Circle's forwarding service pays the network fee on arrival, so you don't need gas there.
- ETH goes through Across, usually in under a minute.
- Tollkit's fee is 0.25%. Circle's or Across's fee, and the amount you'll receive at least, are shown before you confirm. Moves need your password and don't count against your spending limits.

## Stake SOL

**Stake** on the Home tab stakes SOL with a validator you pick from the ones currently voting, listed by how much SOL is staked with them, with their fee. The minimum is set by the network (1 SOL as of October 2026) and read live. Stakes start earning after the current epoch ends (about a day). Unstake any time; once the epoch ends, **Withdraw** returns the SOL to your wallet. The wallet keeps both stake and withdraw authority, and staking needs your password.

## Where things live

`~/.tollkit-wallet/` (or `TOLLKIT_WALLET_HOME`) holds:

- `keystore.json` (encrypted)
- `policy.json` (sealed with your password; editing it by hand pauses spending)
- `ledger.jsonl` (receipts)
- `telegram.json`
- the cached sanctions list

Swap quotes come through api.tollkit.dev. It holds the 0x and Jupiter API keys and adds the fee, and it only ever sees public data and signed transactions.

If you lose the password, the funds can't be recovered.


## Autopilot (limit orders, stop-loss, take-profit, trailing stops, recurring buys)

Tell the wallet what to do in plain English, check the summary, and turn it on:

```
tollkit-wallet rule add "buy $25 of SOL every Monday; sell half my ETH if it rises 10% and sell all ETH if it falls 8%"
tollkit-wallet rules                 # what's on, prices now, fills
tollkit-wallet rule pause <id>       # or: rule on <id>, rule cancel <id>
```

Or use the **Autopilot** tab in the dashboard (`tollkit-wallet ui`). Rule types: limit buy, limit sell, take-profit, stop-loss, trailing stop, and recurring buys (hourly, daily, weekly or a set weekday, with an optional count and maximum price). A take-profit and a stop-loss on the same token are linked: when one fills, the other cancels.

- Every fill goes through the same limits, approvals and receipts as any swap, and pays the same 0.5% fee.
- Rules an agent suggests (`autopilot_propose`) wait for you to turn them on, unless you tick "Let agents turn on autopilot rules without asking me" in Settings (or `budget agent_rules=auto`).
- The autopilot runs while the wallet runs: keep the dashboard open, or run `tollkit-wallet autopilot` on a computer or small server that stays on. Only one copy runs rules at a time.
- Limit orders fill only at their price or better (within 1% for fees and spread). Stops always sell. When selling all of a chain's coin, a little is kept for network fees.

### Chat with your AI on the Autopilot tab

If Claude Code is installed and signed in on this computer, the Autopilot tab is a chat. Say what you want in your own words ("protect my ETH if it drops hard", "buy SOL on dips, $20 at a time"); Claude checks your balances, live prices and recent price history, explains its thinking, and suggests rules as cards you turn on with one tap. It runs on your own Claude plan.

For these chats Claude Code runs with its own tools switched off and only the wallet's advisor tools available (`tollkit-wallet mcp --advisor`: balances, limits, receipts, prices, price history, your rules, and suggesting rules). It can't trade, pay, withdraw or change limits, and its suggestions always wait for you, even if you let other agents turn rules on.

**Check-ins:** pick every 1, 4, 12 or 24 hours and Claude reviews your rules against the market and what you've told it, then suggests changes (for example raising a stop-loss after a rise). A suggested change replaces the old rule only when you turn it on. If Telegram is set up, check-in suggestions also arrive there with Approve and Deny. Check-ins run while the dashboard is open.

## Paper trading

Practise with pretend money at real live prices, fees included, under the same limits:

```
tollkit-wallet paper reset 1000          # $1,000 pretend USDC on each chain
tollkit-wallet paper swap base 100 USDC ETH
tollkit-wallet autopilot --paper         # run your rules on pretend money
tollkit-wallet paper                     # balances, fills, fees
```

Agents get `paper_swap` and `paper_status`. Nothing is signed or sent.
