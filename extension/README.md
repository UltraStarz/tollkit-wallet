# Tollkit Wallet browser extension

Lets websites connect to the Tollkit Wallet on this computer, the way they connect to MetaMask or Phantom.

- Base and Ethereum: an EIP-1193 provider, announced with EIP-6963 (and as `window.ethereum` when no other wallet has set it).
- Solana: a Wallet Standard wallet (connect, sign transaction, sign and send, sign message).
- Keys stay in Tollkit. Connecting a site, signing and sending each wait for your OK in Tollkit's Approvals tab, which shows the site and what it asked for. Transactions are checked against the network first.
- Read-only calls (balances, block number, contract reads) go through Tollkit to the network without a prompt.

## Add it to Chrome, Brave or Edge

1. Run `tollkit-wallet extension` to see where the folder is.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick that folder.
3. Run `tollkit-wallet ui`, open **Settings**, click **Pair a browser**, and paste the code into the extension.

The extension talks only to `http://127.0.0.1` (the Tollkit dashboard). Tollkit has to be open for sites to use it.
