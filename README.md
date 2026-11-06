# Sidebid: on-chain auctions for Solana tokens

Sell your Solana tokens on the side, to the best bid, without selling into the pool and moving the chart. Sell your tokens, not the chart.

Your tokens stay in your own wallet until the moment of sale. The contract takes no fee, has no pause switch and no config account. Every sale either completes in one transaction (tokens to the buyer, SOL to the seller) or does not happen at all and every bidder gets their SOL back.

| | |
|---|---|
| Site | [sidebid.fun](https://sidebid.fun) |
| X | [@sidebidsol](https://x.com/sidebidsol) |
| Ticker | $SIDEBID |
| Program ID | `5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp` |
| Executable hash | `dc668063ff260ebb22aca9292fb228bb09241e69c02a75d3b0f312791d0ab2bf` |
| Upgrade authority | Check its live status on [Solscan](https://solscan.io/account/5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp) |
| Contact | sidebid@outlook.com |

The project revokes the upgrade authority before launch; once revoked, the program can never be changed.

## What is in this repository

| Folder | What it is |
|---|---|
| `program/` | The Anchor program (Rust), its IDL, tests and scripts. Its README has every rule, the compute costs, the verified build steps and the shutdown plan. |
| `server/` | The backend (Node). Indexes the program, runs the keeper that settles ended auctions, reads X posts that open tagged cards, signs fixed price passes and pays the hourly seller rewards. See `server/BACKEND.md`. |
| `web/` | The public site (plain JavaScript, no framework). Builds every transaction in the browser and signs only with your wallet. See `web/README.md`. |
| `tools/authority/` | A single page tool for checking and handing over the program's upgrade authority. |
| `.github/workflows/` | The verified build: rebuilds the program in Docker and prints its executable hash. |

## How a sale works

**Auction.**

1. The seller lists any amount of one coin from their own token account (the full balance by default, or 25%, 50%, 75% or an exact count), with a minimum and a length (10 seconds to 1 hour). Listing approves the listing's own address to move exactly that amount and nothing else. The tokens do not move.
2. Bidders bid in SOL. A bid goes into a vault owned by the program, and the bidder it beats is repaid in the same transaction. Each new bid must beat the last by 2% or 0.001 SOL, whichever is larger.
3. A bid in the last 15 seconds adds 15 seconds, up to 5 minutes past the original end.
4. After the end, anyone can call `settle`. In one transaction the tokens go to the winner and the SOL goes to the seller.
5. If the seller moved or sold the tokens in the meantime, the sale can't settle, and anyone can trigger a refund that returns the full bid to the bidder.

**Fixed price.** The seller sets one price. The first buyer takes it, paying the seller and receiving the tokens in one transaction. Some fixed listings need a pass from the server, one per X account.

**Tagged card.** A holder posts on X naming the coin and an amount: an exact number, a percent like 50% of the linked wallet's balance, or all. The reply and the card show the exact token count. The server opens a card for that wallet, with no approval and no tokens moved. People bid as in an auction, and when it ends the holder has a short window to accept. If they don't, every bidder is refunded.

**Credits.** If an account can't receive SOL directly, its SOL is parked at an address only that account can claim, so nobody can block an auction by refusing payment.

## Verify the build

You don't have to trust that the program on chain is the code in this repository. You can rebuild it and compare.

The program is built for SBPF v3 with platform tools v1.57, so every `solana-verify` command needs `--arch v3`. The build runs in the pinned Docker image `solanafoundation/solana-verifiable-build:4.1.2`, chosen by `[workspace.metadata.cli]` in `program/Cargo.toml`, so everyone gets the same bytes.

On your own machine, with Docker and `cargo install solana-verify --version 0.5.2 --locked`:

    git clone https://github.com/sidebid/sidebid
    cd sidebid/program
    solana-verify build --library-name sidebid --arch v3
    solana-verify get-executable-hash target/deploy/sidebid.so
    solana-verify get-program-hash -u mainnet-beta 5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp

The last two commands must print the same hash. If they do, the deployed program is exactly this source.

Without Docker: open the Actions tab of this repository and run the **Verified build** workflow. It runs the same `solana-verify build` on GitHub's runners, prints the hash in the run summary and attaches `sidebid.so` as a download.

The listing server public key and the program ID are literals in `program/programs/sidebid/src/lib.rs`, so the build needs no environment and no secrets. The public test key only enters with the Cargo feature `test-listing-key`, which is off by default, and `npm run check-release` in `program/` refuses any binary that contains it.

Solana Explorer and Solscan also show the verification status and the `security.txt` block for the program ID.

## Run it

You need Node 24, Rust, and the Solana tools with `cargo-build-sbf` (platform tools v1.57).

**Program tests** (LiteSVM, no validator needed). The tests use a public test listing key derived from a phrase in `program/tests/fixtures/test-listing-key.mjs`. It is not secret and must never be used for anything real.

    cd program
    npm install
    npm run build:test
    npm test

**Server tests** (they load the test build above):

    cd server
    npm install
    npm test

`npm run test:validator` in `server/` runs more tests against a local `solana-test-validator`, if one is installed.

**Site checks:**

    cd web
    npm install
    npm run unit

The full end to end test (`npm test` in `web/`) drives headless Chrome against a local validator and is described in `web/README.md`.

**Run the site and server locally:**

    cd web && npm run build && cd ..
    cp server/.env.example server/.env    # fill in the RPC and keys
    node server/src/index.mjs

The `Dockerfile` at the root builds the site and runs the server the same way for production. Every setting is documented in `server/.env.example` and `server/BACKEND.md`.

## Things to know

- **Upgrade authority.** While it exists, its holder can deploy a new version of the program and change any rule. Check its live status on [Solscan](https://solscan.io/account/5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp). The project revokes the upgrade authority before launch; once revoked, the program can never be changed.
- **Bids can't be withdrawn early.** If nobody settles, a bid waits until 24 hours after the end of an auction, or until the window closes on a tagged card, and then anyone can refund it.
- **The listing server key** can open tagged cards naming any holder. It cannot move funds.

Security reports: see `SECURITY.md`.

## License

MIT. See `LICENSE`.
