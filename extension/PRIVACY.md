# Tollkit Wallet extension: privacy

The extension connects websites to the Tollkit Wallet app running on your own computer.

What it stores, in Chrome's local extension storage on this computer:
- the port of your Tollkit Wallet dashboard (for example 7420), and
- a pairing token that the wallet issued when you paired this browser.

What it sends, and where:
- When a website calls the wallet (for example to connect, read the chain, sign or send), the extension passes that request and the website's origin (for example `https://app.example.com`) to the Tollkit Wallet at `http://127.0.0.1` on your computer. Nothing else is sent.
- It sends nothing to Tollkit's servers or to anyone else. It has no analytics.

What it doesn't do:
- It doesn't read or collect pages, browsing history or form data. The script it adds to https pages only answers calls the page makes to the wallet.
- It holds no private keys or recovery phrase. Signing happens in the Tollkit Wallet, after you approve each request there.

Unpairing the browser (in the extension, or "Unpair all browsers" in Tollkit's Settings) removes the token.

Contact: Tollkit LLC, https://tollkit.dev
