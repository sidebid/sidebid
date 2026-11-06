# Sidebid site

The public site: option D from `design3/`, on real data from the server API and the chain. No mock data. Desktop first (judged at 1440 and 1920), working at 390.

## Build

    cd web
    npm install
    npm run build        # dist/index.html, dist/app.<hash>.js, dist/app.<hash>.css

The server serves `web/dist` (or `WEB_DIST`) at `/`. Nothing else is needed to host it.

## What the server adds for the site

`server/src/site.mjs`, mounted in `server/src/index.mjs` (`listen(withSite(app, config), ...)`). It serves the built files and these read only routes, and passes everything else to the API unchanged. It writes nothing and signs nothing.

| Route | What |
|---|---|
| `GET /api/config` | Runtime config: brand, chain, keys, drop schedule, flags |
| `GET /api/site/events/<listing>` | That listing's events (bids, sale, refund, cancel) with X handles, its lot number |
| `GET /api/site/activity` | Recent bids, sales and refunds across all listings, for the ticker and Just sold |
| `GET /api/site/lots?keys=a,b` | Lot numbers, listing times and bid counts |
| `GET /api/site/seller/<wallet>` | X handle, picture and past sales of a seller |
| `GET /api/site/trust` | Upgrade authority read from chain (team key, Squads vault with its lock, or revoked), pending Squads proposals, verified build status (mainnet only), source commit |
| `GET /api/site/feed` | Every transaction: listings, bids, sales, refunds, cancels, credits, hourly fee claims and payouts, newest first |
| `GET /api/site/stats` | SOL in live bids, listings sold, SOL paid to sellers and to top sellers, with `show` once sales pass `stats.minSales` |
| `GET /api/site/log` | The change log: `<DATA_DIR>/log.json`, else `web/log.json`, with an entry added for every pending upgrade proposal. A row with `"env": "preview"` shows only on a test chain (`PREVIEW_CHAIN=1` or not production), `"env": "production"` only on the live site, no `env` on both |
| `GET /api/site/launch-test` | The pre-launch mainnet test (server/BACKEND.md). The home page and /tx show it as Tested on mainnet before launch, hidden while the list is empty |
| `GET /api/site/coinimg/<mint>` | The coin picture, fetched by the server (public https hosts only, image bytes checked, never svg) so visitors never contact the token creator's host. Every coin the indexer sees is read ahead and kept on disk (`DATA_DIR/pics`) |
| `GET /c/<listing>`, `/s/<sale sig>` | The site itself, with the share card tags for X, opened on that listing |
| `GET /`, `/live`, `/fixed`, `/sell`, `/rewards`, `/docs`, `/docs/<section>`, `/log`, `/tx` | Real pages: each served with its own title, description, canonical address, share tags and a first paint (header, heading, live listings) in the HTML. The site then draws over it and moves between pages with the History API. Old `#view` links redirect to these addresses |
| `GET /lot/<listing>`, `/coin/<mint>` | A page per listing (title with ticker, amount and kind, its share card, the facts and the full CA in the first paint) and per coin (every listing and sale of it; 404 when it has none) |
| `GET /api/site/xavatar/<handle>` | The X profile picture stored at sign in or from a tagged post, fetched from X's picture host only by the server and kept, so pages never contact X. 404 when there is none; the page then draws a pattern |
| Any other page path | A real 404 page with the site around it |

Headers: a CSP that names its hosts (the RPC and its websocket; DexScreener and GeckoTerminal only with the price feed on; pictures only from this site), HSTS on https, nosniff, no framing.

## Runtime config

Brand values live in one JSON file the server rereads when it changes, so a rename needs no rebuild and no restart: `SITE_CONFIG` or, by default, `<DATA_DIR>/site.json`. `SITE_CONFIG_JSON` (the same JSON in an environment variable) is used when there is no file.

```json
{
  "brand": { "name": "Sidebid", "ticker": "SIDEBID", "xHandle": "...", "domain": "...", "github": "https://github.com/...", "ca": "<mint>", "logo": null, "reveal": false },
  "chain": { "rpc": "https://<public rpc with a domain locked key>", "cluster": "mainnet-beta", "explorer": "https://solscan.io", "priorityMicroLamports": 20000 },
  "keys": { "upgradeAuthority": "<upgrade key address>", "devWallet": "<dev wallet>" },
  "drops": { "start": 1762430400, "every": 300, "until": 1762434000, "pattern": [ { "mode": "auction", "amount": "400,000", "pct": "0.04%", "note": "5 minute countdown, no minimum" }, { "mode": "fixed", "amount": "100,000", "pct": "0.01%", "note": "Half of chart price, one per X account" } ] },
  "priceFeed": false,
  "trust": { "squadsMultisig": "<Squads multisig address, once the upgrade authority moves there>", "commit": "<40 hex: the public commit of the deployed build>" },
  "facts": { "contractTests": 148, "serverTests": 220 },
  "stats": { "minSales": 10 }
}
```

- **`reveal`**: until it is `true`, the server leaves the CA, the GitHub link, the X handle and the dev wallet out of `/api/config` altogether, so they are not in the page at all. Copy then says "our X account".
- **`logo`**: an image URL. Empty shows the Sidebid tag logo from `brand/` (also the favicon and the share card).
- **`chain.rpc`**: the browser's RPC. Never the server's `RPC_URL` with its paid key; the server only reuses that when it points at localhost.
- **`drops`**: the public schedule. Every empty state (no live listings, no sales, nobody on the leaderboard) shows the next drop from it.
- **`priceFeed`**: `true` lets the browser read chart price and pool size from DexScreener and the 1 hour chart from GeckoTerminal. Off, the site shows no chart comparison rather than a guess, and the chart panel becomes coin checks.
- **`trust`**: the upgrade state is always read from chain, never from this file. `squadsMultisig` only tells the server which multisig's vault to recognise and watch for proposals; until the chain names that vault as the authority the site says "team key". Vaults 0 to 3 of that multisig are recognised. A multisig with a settings key (`config_authority`) is shown as such: the site never says a change waits out the lock, because that key can change the members and the lock at once. Revoked shows as revoked. `commit` with `brand.github` gives the Source link in Check it yourself; without it that item shows as pending.
- **`facts`**: test counts shown on the site. Missing, no count is shown. Update them with the suites.
- **`stats.minSales`**: the live stats strip stays hidden until this many sales, and never shows a zero.
- The program id and the pass signer come from the server's own config.

## Wallets and signing

- Wallet Standard, with no adapter library (`src/wallet.js`). Phantom, Solflare and Backpack are always listed: connected if installed, "Not installed" with a download link on desktop, and on a phone a link that opens the same page inside that wallet's browser. Any other standard wallet in the page is listed after them.
- Sign in with X uses the server's `/api/auth/x/start`. The page remembers where you were and reopens the connect sheet on return. The wallet link is the server's challenge, signed with `solana:signMessage`.
- Every transaction (`src/chain.js`): built from `program/idl/sidebid.json` (`src/program.js`), simulated with no signature first (a refusal never opens the wallet), compute limit set from the simulated units plus 15%, optional priority fee from config, one signer checked before the wallet opens, signed by the connected wallet as the only signer and fee payer. What the wallet returns is checked against what was built (same fee payer, one signer, our instructions unchanged and in order, valid signature; only the compute budget may differ) and sent byte for byte. Confirmed by polling, 90 seconds at most. Program errors are shown in plain words.
- Before a bid, buy or accept, the listing is read straight from the RPC and the transaction is refused if its mint, amount, price, seller or top bid differ from what the page shows. The signed `expected_*` values are those chain fields.
- Listing shows "You approve exactly N $COIN for this listing" right above the button and again while the wallet is open, N with every digit as the wallet shows it.
- Connecting a wallet never asks for a signature by itself. Linking is its own button, and the site signs only a link message naming this wallet and this X account.
- Instructions used: `create_listing` (its approval is inside it), `place_bid` with `expected_mint` and `max_end_time`, `buy_fixed`, `buy_fixed_with_pass` (server pass from `/api/pass`, ed25519 verify directly before it), `accept`, `cancel`, `refund`, `settle`, `close_listing`, `claim_credit`. The winner's or buyer's token account is created in the same transaction when missing.

## Features that were mocked in the prototype

- **Authority badge**: coins whose mint or freeze authority is still set, read from the mint account. On cards, the hero, the lot header, and in Coin checks on each lot.
- **Credits**: listed under your account (click your handle) and on the lot they came from, each with Claim. You also get a notice on connect.
- **Cancel your listing**: on your lot page and in Your listings on the sell page. Cancel removes the approval in the same transaction.
- **Unsold auctions**: when an auction ends with no bids and the approval is still set, the seller sees Remove the approval.
- **Settle now** for anyone after the end, **Trigger the refund** when the seller ghosted or can no longer deliver, **Close and return the rent** for finished listings.
- **Rewards**: reads `GET /api/rewards` (see `REWARDS-API.md`). Without it, standings come from completed sales this hour and the pot reads "Opens at launch".

## Test

End to end against a local validator, the real server and the built site, in headless Chrome. The browser tests (`test/e2e.mjs`, `test/privy-e2e.mjs`, `test/shots-pages.mjs`) need `puppeteer-core` and a local Chrome; set `PUPPETEER_CORE` to a `puppeteer-core` install if it is not in `node_modules`, and point it at your Chrome as puppeteer-core expects. The Solana tools must be on your `PATH`.

    npm run unit         # pure checks, a second
    npm run build
    npm test

The upgrade watcher step runs the real Squads v4 program. Put it in `test/.cache/` once (read only calls to mainnet):

    solana program dump -u <mainnet rpc> SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf test/.cache/squads.so
    solana account -u <mainnet rpc> BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr --output json-compact --output-file test/.cache/sqcfg.json

Without those files that step is skipped and says so.

It starts `solana-test-validator` on port 46899 (`E2E_PORT_BASE` moves every port) with the test key build `program/target/test/sidebid.so` at the real program id (feature `test-listing-key`, built by `program/scripts/build-test.sh` if missing; never the release .so; upgrade key: a throwaway), the server on port 46790 with throwaway keys and X mocked (no X call, no local env file read), and three people in separate browser contexts. Each has a Wallet Standard test wallet injected into the page that signs with its throwaway key. X's consent screen is skipped by answering the authorize redirect with the callback, so the server's real sign in code runs.

Flows, each clicked on the site and checked on chain: sign in from the hero and link by a click (no signature on connect), list (auctions and fixed), bid, too small a raise refused before signing, outbid with refund in the same transaction, fixed buy, pass buy and second claim refusal, two cards listed by X post, accept, Settle now, seller ghosted refund, close, cancel from Your listings, Remove the approval on an unsold auction, claim credit, and Gone after the seller moves the tokens. Refusals: a comma in a price, a wallet that changes the transaction, and an API that shows a different price than the chain. Then every transaction, stats and change log; the headers and share tags; and, with Squads, the upgrade authority moved to a vault with a 48 hour lock and an approved upgrade proposal putting the red banner on every page. Then screenshots of every view at 1440, 1920 and 390 into `shots/`, and on every view: no banned words, no dashes, no bare zero, no sideways scroll, the upgrade line for the chain state, no page errors, and no request from any page to a host other than the site, its RPC and the font host.

`SERVER_DIR=<path>` runs the test against another copy of `server/`. `E2E_LOG=1` prints the server log.

One fixture is not natural: alice's credit is put in the validator's genesis ledger, because a real validator cannot make an ordinary wallet unpayable. The claim itself, and the site finding it, are real.

## Files

- `src/app.js`: views and actions. `src/data.js`: API reads and polling. `src/chain.js`: sending and chain reads. `src/program.js`: instructions from the IDL. `src/wallet.js`: Wallet Standard. `src/tech.js`: diagrams, engine chapters, docs. `src/prices.js`: optional price feed. `src/d.css`: the base stylesheet. `src/web.css`: additions. `src/polish.css`: finishing styles and the trust pieces. `log.json`: the change log shipped with the site.
- `test/unit.mjs`: fast checks that need no browser.
- `REWARDS-API.md`: the rewards interface agreed with the server.
- `shots/`: screenshots from the last test run (not committed).
