# Sidebid program

Anchor program for Sidebid listings. Tokens stay in the seller's wallet until a sale. No instruction takes a fee, pauses anything or gives anyone admin rights, and there is no config account. **The upgrade authority is a separate power: read "Upgrade authority" below.**

## Instructions

| Instruction | Who signs | What it does | Compute (SPL / Token 2022) |
|---|---|---|---|
| `create_listing` | seller | Opens a bidding or fixed listing on the seller's associated token account and approves the listing's own address for exactly that amount. One per token account. | 35,599 / 35,408 |
| `create_accept_listing` | server listing key | Opens a tagged card for a wallet holding the tokens. No seller signature, no delegate. The server pays the rent and gets it back at close. | 30,961 / 37,260 |
| `place_bid` | bidder | Takes a new top bid into the vault and repays the last bidder in the same transaction. A bid in the last 15 seconds adds 15. | first 12,977, outbid 16,141, parking a credit up to 22,493 |
| `settle` | nobody needed | After the end: tokens to the winner, SOL and rent to the seller, in one transaction. | 18,913 / 21,091 |
| `accept` | seller stored on the listing | Accept mode, inside the window after the end: tokens to the winner, SOL to the seller. Server gets the rent back. | 20,526 / 22,948 |
| `refund` | nobody needed | Bidder gets all SOL back. Bidding: when the seller can no longer deliver, or 24 hours after the end. Listing becomes Gone. Accept: when the seller no longer holds the tokens or the window has passed. Listing becomes Ghosted. | 13,213 |
| `cancel` | seller | Before the end, or any time with no bids: repays the bidder, removes this listing's delegate, closes the listing. Not available in accept mode. | 16,453 / 17,197 |
| `buy_fixed` | buyer | First buyer takes a fixed listing: SOL to the seller, tokens to the buyer. | 17,377 / 19,555 |
| `buy_fixed_with_pass` | buyer | Same, with a server pass checked through the ed25519 instruction right before it. Creates the claim that blocks a second use of that X id. | 35,356 / 42,034 |
| `close_listing` | nobody needed | Closes a Gone or Ghosted listing, or an expired one with no bids. Refused while this listing's delegate is still set. Rent goes to whoever paid it. | 9,480 |
| `claim_credit` | credit owner | Pays out SOL parked for an account that could not be paid directly. | up to 11,035 |

Compute is the highest seen over 15 runs of `scripts/measure-cu.mjs`, and includes the ed25519 instruction where used. All are far under the default 200,000 limit.

## Rules worth knowing

- **Floor:** the lowest price or bid is 0.001 SOL, so a refund can always revive a closed wallet.
- **Lengths:** auctions and tagged cards run 10 seconds to 1 hour. A fixed listing runs up to 30 days, or has no expiry. The accept window is 60 seconds to 1 hour, and the server sets 600. The longest a bid can be held on a tagged card is about 2 hours 5 minutes.
- **Last second bids:** each adds 15 seconds, and the end can never pass `hard_end_time`, the original end plus 300 seconds.
- **Raises:** a new bid must beat the top bid by 2% (rounded up) or 0.001 SOL, whichever is larger.
- **Seller accounts:** `create_listing` and `create_accept_listing` take only the seller's associated token account, so the address fixes the coin.
- **Bids in flight:** `place_bid` carries the expected amount, mint and `max_end_time`. Clients pass the listing's `hard_end_time` as `max_end_time`. If the seller relisted a different deal, the bid fails and no SOL moves.
- **Leftover approvals:** `close_listing` is refused while this listing's delegate is still on the seller's account. Only the seller's `cancel` can remove it, because strangers can't revoke. Bidding and fixed listings in that state stay open until the seller acts, and their rent waits with them.
- **Credits:** if an account can't be paid directly, its SOL goes to a credit address only it can claim, so nobody can freeze an auction. The site must list and claim credits, or that SOL sits unseen. LiteSVM and the local validator both accepted credits to executable accounts. Mainnet may reject them, which has not been checked, so treat the credit path as live.
- **Token 2022:** only metadata and group extensions are accepted. Transfer fee, hook, permanent delegate, non-transferable, default state, pausable and all others are refused at listing.
- **Token accounts for the winner:** settle and accept take any token account the winner owns. The client creates it first. If the winner breaks their own account, anyone can open a fresh one for them.
- **Claims:** these are never closed, because closing one would allow a second use. The buyer pays about 0.00095 SOL.
- **Pass message:** `SIDEBID_PASS_V1\0` | program id | campaign | buyer | X id hash | expiry (i64 little endian). The verify instruction must sit directly before the buy, in the standard layout.

## Mainnet build

| | |
|---|---|
| Program id | `5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp` |
| Listing server key (compiled in) | `5uoQXnzrrrsrS5VoFKqnwVtBukrhbA4NuXNaJAPz5yTm` |
| `.so` size | 282,136 bytes |
| Executable hash (`solana-verify get-executable-hash`) | `dc668063ff260ebb22aca9292fb228bb09241e69c02a75d3b0f312791d0ab2bf` |
| Withdraw-only build, same key and id | 246,968 bytes, `7e00f36d89fbab882544665c7fdf0066e39ede3347218371425317c4ecacca62` |
| Built with | `anchor build` (Anchor 1.2.2, platform tools v1.57, SBPF v3), no features, no env |

**Mainnet runs SBPF v3.** Feature `enable_sbpf_v3_deployment_and_execution` (`5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC`) is active on mainnet since slot 428,976,000, so the release is built for v3. Agave 3.0 gated v3 under an older feature id that mainnet never activated, so a 3.0 validator refuses this build; a 4.1.2 local validator runs it.

**Reproduce it.** The Verified build workflow (`.github/workflows/verified-build.yml`) runs `solana-verify build --library-name sidebid --arch v3` (solana-verify 0.5.2) in the pinned image `solanafoundation/solana-verifiable-build:4.1.2` on GitHub's runners and prints the executable hash. Compare it with `solana-verify get-program-hash -u mainnet-beta 5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp`. If a Docker build ever differs from the `anchor build` hash above, the difference is the toolchain, not the source; trust the hash that matches the chain.

Deploy command (the upgrade authority stays with the deployer until it is revoked, see below):

    solana program deploy target/deploy/sidebid.so \
      --program-id <program keypair.json> \
      --keypair <payer.json> --upgrade-authority <authority.json> \
      --url <mainnet RPC> --with-compute-unit-price 10000 --max-sign-attempts 50 --use-rpc

## Size and deploy cost

Rent is `(bytes + 128) x lamports per byte`. Mainnet charges 5,080 lamports per byte today (checked with `solana rent 0`, which returns 650,240 = 128 x 5,080). A local validator still uses the old 6,960, so never take deploy cost from a local run.

Mainnet build above (`solana rent <n> --url mainnet-beta`):

- Program data (282,136 + 45 byte header): 1.43412972 SOL
- Program account (36 bytes): 0.00083312 SOL
- **Deposit: 1.43496284 SOL**, plus about 0.002 SOL of fees and priority fees at the price above

If the verified build has a different size, recompute with `solana rent <so bytes + 45> --url mainnet-beta` plus `solana rent 36`. The loader empties the buffer back to the payer before charging for program data, so the payer needs one deposit plus fees, not two. Rent for the program data stays locked, including after authority is revoked. A later upgrade to a bigger program costs more rent.

Each listing locks rent until it closes (0.0030972 SOL at the old local rate).

## security.txt

The `security_txt!` block in `programs/sidebid/src/lib.rs` (crate `solana-security-txt` 1.1.3) shows on Solana Explorer and Solscan:

| Field | Value |
|---|---|
| `name` | `Sidebid` |
| `project_url` | `https://sidebid.fun` |
| `contacts` | `email:sidebid@outlook.com` |
| `policy` | `https://sidebid.fun/docs` |
| `preferred_languages` | `en` |
| `source_code` | `https://github.com/sidebid/sidebid` |
| `auditors` | `None` |

No `source_revision`: the commit hash would have to be in the binary it describes. Changing any value changes the binary and its hash.

## Verified build (solana-verify)

`Cargo.toml` pins the build image with `[workspace.metadata.cli] solana = "4.1.2"`, which selects `solanafoundation/solana-verifiable-build:4.1.2` (about 1.3 GB compressed). The program is SBPF v3 (ELF `e_flags` 3), so every solana-verify call needs `--arch v3`. Tool: `cargo install solana-verify --version 0.5.2 --locked` (crates.io, Ellipsis Labs).

The listing server key and program id are literals in the source, so the Docker build and the OtterSec remote verifier reproduce them with no environment. The test key only enters with the Cargo feature `test-listing-key`, which is off by default.

### Steps, in order

1. Push the commit to `github.com/sidebid/sidebid`. Note the commit hash.
2. Build in Docker from that exact commit (GitHub Actions, or any clean checkout):

        solana-verify build --library-name sidebid --arch v3
        solana-verify get-executable-hash target/deploy/sidebid.so
        ls -l target/deploy/sidebid.so
        node scripts/check-release.mjs target/deploy/sidebid.so

   Write down the hash and size. Deposit = `solana rent <size + 45>` + `solana rent 36`, on mainnet.
3. Deploy **that** `.so` (command above).
4. Check that chain and build match:

        solana-verify get-program-hash -u mainnet-beta 5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp

   It must print the hash from step 2.
5. Upload the verification (writes a small PDA, under 0.01 SOL, signed by the upgrade authority), then ask OtterSec to verify:

        solana-verify verify-from-repo -u mainnet-beta --program-id 5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp \
          https://github.com/sidebid/sidebid --commit-hash <commit> \
          --library-name sidebid --arch v3 --mount-path program \
          --keypair <upgrade authority key>
        solana-verify remote submit-job --program-id 5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp \
          --uploader <upgrade authority address>

   Drop `--mount-path` if the public repo has the program at its root. Do this before revoking: the upload is signed by the upgrade authority.
6. Check `https://verify.osec.io/status/5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp`, then the Verified Build tab on Solana Explorer and Program Verification on Solscan.
7. Every upgrade un-verifies the program. Repeat after each one.

Clean up after a Docker build: `docker image rm solanafoundation/solana-verifiable-build:4.1.2` and `docker builder prune -f`.

## IDL

`idl/sidebid.json` (copied from `target/idl/sidebid.json` after the release build, so it names the real listing key). TypeScript types are generated at `target/types/sidebid.ts`.

## Build and test

Release build, the one that ships. No environment and no features:

    anchor build
    npm run check-release          # refuses a .so with the test key, or without the real key and program id
    npm run build:withdraw-only    # shutdown build with the real key, checked the same way

Tests run on separate builds with a public test listing key, compiled in only with the Cargo feature `test-listing-key` and written to `target/test/`, never to `target/deploy/`. The key is derived from a public phrase in `tests/fixtures/test-listing-key.mjs` (public key `9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91`). It is not secret and must never sign anything real.

    npm install
    npm run build:test     # target/test/sidebid.so and target/test/withdraw-only/sidebid.so (SBPF v3)
    npm test

The suite covers the normal build, the shutdown rehearsal, regression tests (`tests/07-regressions.test.mjs`) and `tests/00-release.test.mjs`, which fails if `target/deploy/sidebid.so` (or the release withdraw-only build) is missing the real key or program id or contains the test key bytes. The tests read the program id from `target/idl/sidebid.json` after a build, else from the committed `idl/sidebid.json`.

Against a real local `solana-test-validator`, with `target/test/sidebid.so` loaded at the program id:

    node scripts/smoke.mjs <rpc> <payer.json> --local

## Upgrade authority

Upgrade authority: check its live status on [Solscan](https://solscan.io/account/5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp). The project revokes the upgrade authority before launch; once revoked, the program can never be changed.

The holder of the upgrade key is the real admin, whatever the instructions above say. That key can deploy a version that:

- moves every lamport out of every vault and credit address
- uses the delegate on every live listing, and any left over, to take the approved tokens from sellers' wallets
- changes any rule

Keep it on a hardware wallet or a multisig, never on the server. Revoking is recommended anyway, since about 1.43 SOL at today's rent is small against that liability. Revoking gives up the deposit and freezes the server listing key in the binary for good, so a leak of that key would be permanent.

### Shutdown

Closing the program leaves nothing that can sign for its addresses, so any SOL still in a vault or credit is lost for good. Never close a live build. Upgrade to the withdraw-only build first, drain, check, then close. The full runbook is in "Withdraw-only shutdown" below.

## Withdraw-only shutdown

The Cargo feature `withdraw-only` builds a shutdown version of the same program: same program id, same account layouts, same instruction data, same error codes. Upgrade the live program to it in place, and every listing, vault and credit can be emptied to its owner, with no clocks to wait for and no signer needed except the fee payer.

| Instruction | Normal build | Withdraw-only build |
|---|---|---|
| `create_listing`, `create_accept_listing`, `place_bid`, `buy_fixed`, `buy_fixed_with_pass`, `settle`, `accept` | as above | always fail with `WithdrawOnly` (error 7000). No new SOL can come in and no sale can complete, so nothing can use a token approval any more. |
| `refund` | only when the seller can't deliver, or after a wait | anyone, any time there is a bid: the full vault goes to the top bidder (or their credit) |
| `cancel` | seller, before the end if there is a bid | seller, also after the end. Still refused on tagged cards, whose rent belongs to the server. |
| `close_listing` | Gone, Ghosted or expired with no bids, and no approval left | anyone, any listing with no bid, in any state, approval or not. Vault leftovers and rent go to the rent payer. A listing with a bid needs `refund` first, in the same transaction. |
| `claim_credit` | owner | unchanged |
| `push_credit(listing)` | not in this build | new, anyone: sends a credit to the address it was parked for and nowhere else. Fails with `OwnerCannotReceive` (7001) while that address still can't take SOL; then only the owner's `claim_credit` works. |

**Who gets what.** Bid SOL, plus anything donated to that vault, goes to the top bidder. A vault with no bid goes to the rent payer. Listing rent goes to the rent payer: the seller, or the listing server for a tagged card. A credit goes to its owner. Every address is pinned by the program (`address = listing.rent_payer`, the `top_bidder` check, credit seeds), so the fee payer can't point any of it elsewhere. The rehearsal checks each wallet to the lamport.

**Not recoverable, say so publicly** (the check lists these but does not block on them): claim accounts (about 0.00095 SOL each, paid by pass buyers; nothing on chain records the payer, and closing one early would allow a second use), SOL anyone sends straight to a vault after its listing closed (no record of the sender), and the 36 byte program account (0.00083 SOL) that stays as a tombstone.

**Size.** Withdraw-only is 246,960 bytes against 282,128 for the normal build (test key, platform tools v1.57), so it fits the existing program data. No `solana program extend` and no extra rent. The upgrade refunds nothing either, because program data keeps its size.

**Leftover approvals.** Closing a listing can't remove the seller's approval, because only the seller can revoke. The approval names the listing address, and nothing can use it: the withdraw-only build never moves tokens, and after the close no program can sign for that address. It is still worth removing, because wallets show it and the upgrade authority could in principle deploy at that id again. The seller does one of:

- `cancel` before the drain, which revokes and closes in one step;
- the site's "remove leftover approval" button, which sends a token `Revoke` signed by the seller;
- `spl-token revoke <TOKEN_ACCOUNT> --owner <seller keypair>`, adding `--program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` for a Token 2022 coin.

Revoke is a token program instruction, so it still works after the program is closed. The rehearsal revokes every leftover approval after the close.

**Credits are not all logged.** `CreditParked` is emitted for bidder and seller payments but not when listing rent lands in a credit. `scripts/shutdown.mjs` therefore checks every (listing, seller), (listing, bidder) and (listing, server key) credit address named in the program's events, not only the logged ones.

### Rehearsal

    npm run build:test
    npm run test:shutdown

`tests/08-shutdown.test.mjs` runs on LiteSVM through the real upgradeable loader (buffer, write, deploy, upgrade, close). It deploys the normal build, opens 63 listings in 21 states (live, ended, expired, Gone, Ghosted, fixed with and without expiry, passes, tagged cards in and after the window, Token 2022, vault donations, parked credits, a completed pass sale), upgrades in place, and drains. Sellers who show up cancel. A stranger who only pays fees drains the rest, and the credits are pushed or claimed. Then it checks that 111 wallets each end exactly where they started, plus what completed sales and donations owed them, and that the drain wallet got nothing. Last, it closes the program and checks that the authority's whole loss over the program's life is fees plus the 36 byte account. `npm test` includes it and skips it if `target/test/withdraw-only/sidebid.so` is missing. The only shortcut: the 36 byte program account is given its layout by direct account write, so the program keypair stays out of tests.

### Runbook

Values: `<ID>` the program id, `<AUTH>` the upgrade authority keypair, `<PAYER>` the fee payer, `<SERVER>` the listing server public key (required by the script: tagged card rent credits emit no event), `<RPC>` an RPC with full transaction history. The check walks every program transaction and refuses to print CLEAN if any transaction comes back empty or with truncated logs, since that one could name a funded credit; public RPCs prune, so use a full history provider. Mainnet commands take `--url mainnet-beta`.

**How much SOL the payer needs.** Step 5 creates the upload buffer from the payer: 37 + 246,960 bytes, about 1.255 SOL at 5,080 lamports per byte (`solana rent 246997`), plus fees, so hold about 1.28 SOL. The upgrade returns the buffer rent to the spill account (the payer on a direct upgrade, the wallet named in a Squads proposal). Steps 6 and 8 need only fees: about 0.02 SOL covers a few hundred listings.

1. **Announce.** Give a deadline. Say: bids are refunded, listings close, sellers should cancel or revoke their approval, claim rent is not returned. If the authority is a Squads vault with a time lock, the upgrade and the close each wait out the lock in public, so announce before proposing.
2. **Stop new business on the server, not the crank.** No new tagged cards and no new passes; the site stops offering new listings and bids, but keeps showing credits and the "remove leftover approval" button. **Keep the settle crank running until the upgrade is confirmed on chain.** With a Squads time lock that is the whole lock period.
3. **Required: finish every sale that can finish before the upgrade lands.** `settle` every ended auction with a bid (the crank does this; check by hand right before step 5), and tell tagged card sellers to accept before the deadline. Any ended sale still open at the upgrade is undone: the drain refunds the bidder in full and the seller keeps the tokens. No money is lost, but the winner loses the deal.
4. **Build the shutdown binary** from the live program's source, with the same `declare_id!` and listing key (never the test key build in `target/test/`), and `cargo` on PATH (`export PATH="$HOME/.cargo/bin:$PATH"`):

        npm run build:withdraw-only
        ls -l target/withdraw-only/sidebid.so
        solana program show <ID>

   The .so size must not exceed the `Data Length` that `show` prints. Rehearse from the same source with the test key builds: `npm run build:test && npm run test:shutdown` (the rehearsal signs tagged cards with the test key, so it can't run on the real key binaries).
5. **Upgrade in place:**

        solana program deploy target/withdraw-only/sidebid.so --program-id <ID> \
          --upgrade-authority <AUTH> --keypair <PAYER> --with-compute-unit-price <micro-lamports>

   With a Squads vault: `solana program write-buffer target/withdraw-only/sidebid.so`, then `solana program set-buffer-authority <BUFFER> --new-buffer-authority <VAULT>`, then propose the upgrade in the Squads app with your wallet as spill account, wait out the lock, and execute. If an upload breaks halfway, `solana program close --buffers --authority <AUTH> --recipient <WALLET>` returns the buffer rent.
6. **Drain:**

        node scripts/shutdown.mjs drain <RPC> <PAYER.json> --server <SERVER>

   It refuses to run unless the deployed code answers like the withdraw-only build (a simulated `push_credit` returns `NothingToClaim`; the normal build doesn't know the instruction). For every open listing it sends `refund` (if there is a bid) and `close_listing` in one transaction. Then it pushes every funded credit. A credit whose owner still can't receive is printed: that owner must sign `claim_credit`. Running it again is safe.
7. **Check, immediately before closing:**

        node scripts/shutdown.mjs check <RPC> --server <SERVER>

   It must end with `CLEAN` (exit code 0): no listing accounts, no vault of an open listing and no credit holding SOL, and no unknown program accounts. Claims are listed with their total rent; they stay. SOL someone sends to the vault of an already closed listing is listed as stranded and does not block: no build of this program can move it, so waiting would not help. Nothing recoverable can appear after a clean check, because the withdraw-only build takes no new money.
8. **Close and recover the deposit:**

        solana program close <ID> --bypass-warning --recipient <AUTHORITY WALLET> --authority <AUTH> --keypair <PAYER>

   Program data rent comes back to the recipient: about 1.434 SOL for the 282,128 byte build at today's 5,080 lamports per byte. With Squads, propose the loader `Close` with that recipient and wait out the lock.
9. **After.** `solana program show <ID>` reports the program closed. Remind sellers to revoke leftover approvals. Don't promise the id can never be used again: recent runtimes may let the same authority redeploy a closed program.

## Revoking upgrade authority

    solana program set-upgrade-authority <PROGRAM_ID> --final --url mainnet-beta --keypair <upgrade authority key>
    solana program show <PROGRAM_ID> --url mainnet-beta

`show` must print `Authority: none`. This can't be undone. Checked on a local validator: a later deploy fails with "no longer upgradeable". The server listing key can't be changed after this, so do it only once that key is final.

## Known limits and open design choices

**What users should know:**

- While the upgrade authority is kept, the rules above can be changed by its holder.
- Nothing is automatic: someone must call `settle` or `accept` after the end. On a tagged card the seller must sign too.
- The seller can walk away after the end, until settle lands. The bidder is then refunded in full.
- A bid can't be withdrawn. If nobody settles, it can wait until 24 hours after the end on an auction, or until the window closes on a tagged card.
- Tagged cards have no approval and can't be cancelled. If the seller does not accept, bidders are refunded after the window.
- Last second bids add 15 seconds each, capped at 300 seconds in total, with a minimum raise. Auctions and tagged cards last at most 1 hour.
- The pass claim seed is (campaign, X id hash, pass signer).
- Token 2022 is limited to metadata and group extensions.
- One live listing per associated token account. Tagged cards use separate addresses and can overlap.
- Closing the program after a drain recovers the deposit, but claim rent is lost.

**Site and operations:**

- Crank `settle` in the first slot after the end, and give the winner a one tap settle. Tell bidders the seller can pull out until settlement and that their SOL always comes back.
- List and claim credits on the site. Show a "remove leftover approval" button, and steer sellers to `cancel`.
- The pass hashes a public X id, so anyone can tell which X id claimed. Don't call it private, or use a keyed hash.
- Use a different pass signer and listing key on each cluster, because the program id is shared between devnet and mainnet.
- Badge any mint that still has a freeze or mint authority.
- Keep the server listing key in a KMS or hardware signer, and rate limit it. Don't reuse a `.so` built with the test key.

**Not built:**

- A seller bond paid to the winner when settle fails, the only on chain deterrent to a seller who backs out.
- A one time on chain wallet link, so no tagged card can name a wallet that never agreed. Today a compromised server key can name any holder, including a pool, and earn them a public "Seller ghosted" label. No funds are at risk.
