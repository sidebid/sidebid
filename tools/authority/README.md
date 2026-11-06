# Upgrade authority tool

A local page for controlling the Sidebid program's upgrade authority from your own wallet (Phantom, Solflare or Backpack). No CLI needed. It is not part of the public site and is never deployed.

One file, `index.html`, with no outside scripts. It talks only to the RPC URL you put in and to your wallet.

## Open it

Wallet extensions don't load into pages opened straight from a file, so serve the folder locally:

    cd tools/authority
    python3 -m http.server 64800 --bind 127.0.0.1

Then open http://127.0.0.1:64800 in the browser that has your wallet.

**RPC URL:** paste a mainnet RPC URL from your RPC provider. The public default (`api.mainnet-beta.solana.com`) often refuses browser requests with HTTP 403.

## What it shows

Press **Load from chain**:

- **Upgrade authority**: the wallet that controls the program, or "None: immutable forever"
- **Program data**: the account that holds the code and the deposit
- **Deposit**: the SOL locked in the program data
- **Last deploy slot**
- After a close: "Closed"

**Connect** your wallet. The page says whether it IS the upgrade authority. All three buttons stay off unless it is.

## The buttons

Each one first checks the chain again, then simulates the transaction. If the simulation fails, the wallet is never asked and nothing changes. Then your wallet asks you to approve. After it lands you get a Solscan link with a Copy button.

| Button | Type to enable | What it does |
|---|---|---|
| **Revoke forever** | `REVOKE` | Removes the upgrade authority for good. Nobody can change or close the program again, you included. The deposit stays locked forever. Share the Solscan link as public proof. |
| **Close program** | `CLOSE` | Shuts the program and sends the deposit to the address in the box (your wallet by default). The program stops working at once, any SOL still in its vaults or credits is lost, and the ID can never be used again. Drain first (program/README.md, "Withdraw-only shutdown"). |
| **Transfer authority** | `TRANSFER` | Hands full control to another address. The new address is not asked to sign, so a typo loses control for good. Check every character. |

Fee per action: about 0.000006 SOL.

## Tested

On a local validator: deploy a program, hand its authority to a test wallet, then drive this page headless with that wallet injected. Checked: transfer (chain shows the new authority), close (the deposit came back, less a 0.0000056 SOL fee, and the program data is gone), revoke in a separate run (`solana program show` prints `Authority: none`), the typed confirms, a wallet that is not the authority (buttons stay off), and a failed simulation (wallet never asked).
