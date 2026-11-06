# Sidebid backend

The Node server behind sidebid.fun: it indexes the program, runs the keeper that settles ended auctions, reads X posts that open tagged cards, signs fixed price passes, pays the hourly seller rewards and serves the site. It holds no user keys and no user funds.

## Parts

| Part | Where | What it does |
|---|---|---|
| Sign in through Privy (X, wallet, email) | `src/privy.mjs`, `src/auth.mjs` | Privy's modal. The server checks Privy's access and identity tokens against the app's public JWKS, with no app secret. Accounts are keyed by the X user id Privy signed for, else the Privy id. No X API call. A direct X OAuth path stays only behind `X_OAUTH_FALLBACK`, off by default |
| Session cookie | `src/auth.mjs` | Only a hash of the session is stored. Logout ends it on the server |
| Wallet link: nonce and signed message, one wallet per X account | `src/auth.mjs` | The nonce is used up in one database step. The message names the X handle and id, the domain, and says it moves no funds. Expired, replayed, wrong wallet, wrong account, bad signature and PDA addresses are refused |
| Wallet change waits 48 hours | `src/auth.mjs` | The old wallet stays active through the wait and alone carries the X name on cards |
| X API client | `src/x/client.mjs` | Bearer for reads, the coin account's OAuth 1.0a for posts. Errors sorted into credits, rate, duplicate and network |
| X reader: cursor, first start, age limit, marked before acting | `src/x/reader.mjs` | One database row per post. Polls that bring only junk slow down, up to 8 times |
| Post parser | `src/x/parser.mjs` | Strict: one amount, one CA, a short word list, hidden characters refused, no floats. Lengths up to 1 hour |
| On chain holding check | `src/x/reader.mjs` | Reads the wallet's associated token account only, as the program requires. A failed read retries and ends as `gave_up`, never `does_not_hold` |
| Card creation and rent budget | `src/x/reader.mjs` | The card address comes from the post id. Caps: rent out at once, per account per day, per account open, per hour, one per wallet and coin, key balance floor |
| Hard daily X spend cap | `src/x/client.mjs` | Reserves the worst case first. Mention reads stop at a share of the day's cap and at an hourly limit, so the rest is kept for replies. Every limit is config. $25 ceiling in code |
| Site works when X credits run out | `src/x/client.mjs` | Pauses X calls for an hour on a credits error. Browsing and share links never call X |
| Reply queue | `src/x/replies.mjs` | One row per post and kind, only for posts that tagged the account. An unknown outcome reads the account's own posts since that post and counts only one with the row's own words, so another reply can't stand in for it. Waits if it can't read |
| Listings API | `src/listings.mjs` | List, filter, single card. Shows next minimum bid, expected values, Seller ghosted, CPI Guard warning, credits, and when the seller must cancel |
| Indexer and rebuild | `src/indexer.mjs` | Accounts owned by this program only. Events from this program's own frames only. Long backlogs walked whole. A short answer from a node closes nothing until each missing listing is asked about |
| RPC pacing and batching | `src/chain/rpc.mjs` | One wrapper for every call. Public page reads get their own quarter of the rate, never queue, and fail over to the cache. A 429 pauses everything. URLs stripped from errors |
| Program adapter | `src/chain/program.mjs` | Names, account order and flags from the IDL. The only way to read a Listing checks the owner |
| Pass signer | `src/pass.mjs` | Exact program message. **Keyed hash of the X id, not plain.** Only campaigns the admin registered. Chain read first |
| Listing key | `src/config.mjs` | Only signs `create_accept_listing`. Separate from the other keys. The public test key is refused in production |
| Keeper | `src/keeper.mjs` | First tick at the end time. Settle, refund, close, stale after 24 hours. Won't try a close the program refuses. Batches give each seller three places, then go biggest bid first, then by end time. Several sends at once |
| Creator fee claim | `src/rewards/claim.js`, `keys.js` | Claims the coin's creator fees for the hourly rewards |
| Hourly rewards: standings, measure, plan, pay, carry, API | `src/rewards/rewards.mjs` | Built on the Sender and the indexer |
| Sign before send, resolve from chain | `src/chain/sender.mjs` | SQLite backed. Any instruction. Raw bytes stored so a restart resends the same signature. Each new attempt pays double, with a ceiling |
| Share card images | `src/share.mjs` | Layouts per listing and sale. Encoded off the event loop, rendered once per card, limited per address and in total |
| Prewritten post links and link page | `src/share.mjs` | A tap opens a written post |
| Go live flags | `src/flags.mjs` | Stored in the database. All start off, and the environment can't turn them on |
| Kill switches | `src/flags.mjs` | Beat the go live flags. A killed keeper sends nothing, not even a rebroadcast, and still reads outcomes |
| API hardening and visitor address | `src/http.mjs` | Security headers and per address buckets. Visitor address from `x-forwarded-for` by `TRUSTED_HOPS`, default 0, which trusts no header. `x-real-ip` is never used. Health check outside all limits. Wrong admin guesses share one server wide bucket. Admin can unlink a phished wallet |

## Hourly creator fee rewards

Every UTC hour, once the indexer has read past the hour's end plus a margin:

1. **Standings** are frozen: SOL received by each seller from that hour's completed sales (`Settled`, `Accepted`, `Bought` events), paid to the seller wallet on the sale. Every sale counts, including several in one transaction. A tie goes to the earlier first sale, then the address. Selling to your own second wallet counts. The hour closes only once the indexer has read past its end plus a margin, and a backlog read over several ticks counts as read only up to when that read began.
2. **Claim.** The coin's creator fees are claimed from the dev wallet (`src/rewards/claim.js` and `keys.js`, with a test holding their hash).
3. **Measure.** The claim counts as the smaller of two figures, both read from that claim transaction on the chain: the creator vault's drop, and what reached the dev wallet (its gain plus the fee it paid). The claim's fee then comes off. So a fee split, or any change to the instruction, can't make the server pay out SOL the dev wallet never got. A read that fails waits, it never counts as zero. A claim never seen on chain after 10 minutes counts as 0.
4. **Plan.** Each payout's worst case network fee (10,000 lamports) is reserved first, so the dev wallet's own SOL ends where it began. The team gets 10% of what is left of the claim after its own fee and those reserves. The rest, plus the carry, goes to the top three, split 50/30/20. A team share under the minimum payout goes into the sellers' prize. Places with nobody, seller shares under the minimum, rounding, and the fee reserve of places not paid all carry into the next hour. The fee reserve a landed payout didn't use, about 4,000 lamports, stays in the dev wallet and isn't paid out: about 0.0004 SOL a day, on the safe side. A carry already had its team share taken, so it pays sellers only.
5. **Pay** through the same Sender as the keeper: each payout is signed and written down before it is sent, and resolved from the chain. A refusal is usually the network, such as a lagging node or a blockhash it hasn't seen yet, so it is tried again on the next tick. Only an account the runtime can never pay, or six refusals in a row, ends it, and then its share and fee reserve carry on.

Safety:

- **Ledger guard.** All payouts ever, with their fee reserve, can't pass all claims ever measured. A payout that would is `held`, not sent.
- **Restarts.** A restart in the middle of the claim never claims that hour again. Whatever that claim moved stays in the dev wallet uncounted, so it is never paid out. A restart in the middle of the payouts resumes them, each exactly once.
- **The dev wallet** signs only the claim and system transfers of measured amounts. Its own tokens are never in a transaction, and a test checks every transaction it signed.
- **Kill switch.** `killRewards`, or `rewardsLive` off, stops claims and payouts. It is read before every payout, so it stops the next one even in the middle of an hour. A payout already signed can't be recalled: a restart resends those same bytes. Hours wait and are paid oldest first when it is turned back on, and the first of them claims everything that built up.
- **Readiness.** Without `REWARDS_TEAM_WALLET` nothing is paid, and the API says `paused` with no pot. `REWARDS_MIN_PAYOUT_LAMPORTS` below 890,880, the rent exempt minimum, refuses to start.
- **When the claim fails**, the hour pays from its carry alone and the fees stay in the vault for the next claim. **With no sales** the team still gets its share and the prize carries.

`GET /api/rewards` returns the live pot, standings, countdown and past hours with claim and payout signatures, in the shape described in `web/REWARDS-API.md`.

**The claim against the real fee program can't run on a local validator.** In tests a stand in program does what the claim instruction does, and on the validator the claim is a stand in transfer measured by the same code. Before going live, make one real claim on mainnet and check that the measured amount matches the vault's drop on an explorer.

**The dev wallet's key is on the server.** It has to be, to claim. It holds the coin's creator tokens, so a server compromise exposes those tokens, not just the fees. Keep only a small amount in that wallet if you can. Set `EXPECTED_DEV_PUBKEY` so a wrong key refuses to start.

Names: `BRAND_NAME`, `BRAND_TICKER` and `BRAND_TAGLINE` feed the share cards, link pages and the wallet link message. Two internal labels carry the name and are fixed from the first mainnet deploy on: the program's pass domain `SIDEBID_PASS_V1` and the X id hash label `sidebid-x-id-v1`. Changing either after launch would break passes already signed or let every X id claim again.

## First hour dev drops (`src/drops.mjs`)

The dev wallet (`DEV_SECRET`) sells 5% of supply in 12 bidding auctions, one every `DROPS_EVERY_SECONDS` (300), each `DROPS_LENGTH_SECONDS` (240) long. Drop i weighs 5^i x 4^(11-i), so each is exactly 1.25x the last and the 12 add up to exactly 5% (rounding goes to the last): 0.0922, 0.1153, 0.1441, 0.1802, 0.2252, 0.2815, 0.3519, 0.4398, 0.5498, 0.6872, 0.8590, 1.0738% of supply. Count, sizes, total and discount are constants in code.

- **Start:** `POST /api/admin/drops/start {firstAt, replace?}` after the CA is public. The mint is the revealed CA (and `DROPS_MINT` when set). Refused without the keeper on, with the dev holding under 5%, or once any drop of that mint has listed.
- **Price:** pump.fun's bonding curve read from chain (virtual SOL over virtual tokens) before graduation; after it DexScreener's deepest SOL pool (at least 5 SOL) checked against Jupiter, within 10%, or either alone when the other does not answer. Read twice 3 seconds apart, within 10%. No price within 90 seconds: skipped. Minimum bid: the chart value less 15%, rounded down to 0.0001 SOL, at least 0.001.
- **Listing:** one live listing per token account, so a drop waits for the last to settle or cancel. A drop not listed within two slots of its time is skipped (`missed`). The keeper settles drops with a bid. One with no bid is cancelled by the dev 20 seconds after its end (the chain clock can lag), which removes the approval and returns the rent; the tokens never moved. No rollover, no relist.
- **Guard (`checkDropIxs`), read inside the Sender's build right before the dev key signs:** one instruction, this program, the dev the only signer; `create_listing` in bidding mode, no pass, the dev's own associated token account of the configured mint, exactly that drop's amount, no more than the largest drop, inside what is left of the 5% across every plan for the mint, the plan's length; or `cancel` of that listing with no top bidder. `dropsPaused` is read there too. The keeper pays the network fee; the dev only lends the listing rent. Tests break each rule.
- **X:** `@sidebidsol` posts "Drop 3 of 12 is live: 1,441,300 $SIDEBID, starting bid 0.1234 SOL, ends in 4 minutes." through the same client and daily cap, with the listing's share card as a picture (`X_DROP_POST_MEDIA`, on; X's price list has no media line, so `X_COST_PER_MEDIA_USD` 0.015 is reserved per upload; a failed upload posts text only). `X_DROP_POST_LINKS` (off) adds the lot link at the $0.20 price. The post id and URL are stored with the drop. A post that fails never holds the drop up; a post caught mid send by a restart is not sent again. The author's name and picture are read once at start (one user read).
- **Site:** `GET /api/site/drops` (public) and `listing.drop` on each card: `{ n, of, pct, author, post }`. Cards and the lot page show the post as an X style card built from the stored post (not X's embed script), and a "Dev drop 3 of 12" tag. The dev is a seller like any other in the rewards.
- **Admin:** `GET /api/admin/drops`: every drop's state, reason, sale, SOL received and post links. Kill switch `dropsPaused`.

Tests: `test/17-drops.test.mjs` (schedule, floor, price sources, guard, start refusals, a sold and a skipped cycle on the real program in LiteSVM, pause, skips, X, routes) and `test/e2e/drops-validator.test.mjs` (one cycle on a real validator with a pump.fun curve account in genesis). The pump.fun curve layout is read by offset with its discriminator checked.

## What the server relies on in the program

| Program rule | What the server does |
|---|---|
| `place_bid` takes `expected_mint`, `max_end_time` | The builder passes the listing's mint and `hard_end_time`. The card returns them under `expected`. A changed deal is refused on chain |
| `close_listing` takes `seller_token_account` | The builder passes it. Account names come from the IDL |
| `create_accept_listing` takes `seller` | The reader passes the linked wallet |
| Associated token accounts only | The reader looks only there. Tokens held elsewhere count as not held |
| Minimum raise | `nextMinBid` on the card, tested at the exact edge against the program |
| `hard_end_time`, Listing is 317 bytes | Decoded and cached. Rent for a tagged card measured 3,097,200 lamports on a real validator |
| Close refused while the delegate is set | The keeper reads the seller's account first and parks the listing for 10 minutes, with no transaction. A new bid or end time wakes it. The card sets `sellerMustCancel` |
| 1 hour caps | Parser and config can't go past them. A window outside 60 to 3600 seconds refuses to start |

Also: settle at the end time, keyed X id hash, claim PDA with the signer, separate tagged card seeds, rent budget, CPI Guard shown on the card and in both replies, credits read from lamports because a claim emits no event, refund 24 hours after the end.

**Listing key.** The listing server public key is compiled into the program (see `program/README.md`). Set the same key on the server and check that a built `.so` carries it:

    LISTING_PUBKEY_EXPECTED=<listing public key> npm run check-so

It can't be changed once the upgrade authority is revoked.

## Before going live

The server can't do these itself.

1. **Visitor address check.** After every deploy, from your own machine:

       ADMIN_SECRET=<secret> node tools/deploy-ip-check.mjs https://<your domain> <your public IP>

   It asks `/api/admin/ip` once plainly and once with a forged `X-Forwarded-For` and `X-Real-IP`. It prints what the server saw and the `TRUSTED_HOPS` value that fits, then says PASS or FAIL. On Railway expect `TRUSTED_HOPS=1`. Set it, redeploy, and run it again until it says PASS. Then repeat from a second network, such as a phone hotspot, and check the second address is different. **Until it passes, treat the rate limits as absent.** The server refuses to start in production without `TRUSTED_HOPS`.
2. **X prices.** Recheck the table below against X's price list, then set `X_DAILY_SPEND_CAP_USD`, `X_SIGNIN_CAP_USD`, `X_READ_SHARE` and `X_READ_HOURLY_USD`. At the defaults, a busy day stops new tags within the first hour.
3. **`ADMIN_SECRET` of at least 32 random characters.** The server enforces the length. The guess limit is one server wide bucket that a wrong guess can never get past, but it doesn't stop a right one, so a flood of guesses can't lock you out of the kill switches. The secret's length is what makes guessing hopeless.
4. **A Cancel button on the site when `sellerMustCancel` is true**, and a Settle now button anyone can press.
5. **Run the site check:** `tools/check.mjs <site>` (see Tools below).

## X spend: prices and what the cap buys

Prices from X's pay per use list (docs.x.com/x-api/getting-started/pricing), checked November 2026. They are the code defaults.

| Call | X item | Price | Variable |
|---|---|---|---|
| A reply with no link and no domain (the default, `X_REPLY_LINKS` off) | Post: Create | $0.015 | `X_COST_PER_POST_USD` |
| A reply with the card link (`X_REPLY_LINKS=1`), or any text X could turn into a link, such as `sidebid.fun` | Post: Create (with URL) | $0.200 | `X_COST_PER_POST_LINK_USD` |
| Each mention of the account (an owned read) | Owned read | $0.001 | `X_COST_PER_OWNED_READ_USD` |
| Each mention's author, and the sign in profile read (`/2/users/me`) | User: Read | $0.010 | `X_COST_PER_USER_USD` |
| The account's own posts, read after a reply with an unknown outcome | Posts: Read | $0.005 | `X_COST_PER_READ_USD` |

The OAuth token exchange is not on the list. Every price must be above 0: a zero price passes any cap, so the server refuses it. The reply price is chosen from the words actually sent (`hasLink` in `x/client.mjs`), so a link can never be billed as a plain post. With links off, a reply ends with "Live now on our site, link on our profile." (or "Accept on our site…") and a short card code, so two sellers' replies are never the same words.

The ledger: `X_DAILY_SPEND_CAP_USD` is the whole day's bill. `X_SIGNIN_CAP_USD` (default 0) is set aside inside it for sign ins only. Mention reads, replies and reply checks share the rest, reads up to `X_READ_SHARE` of it. A cap of 0 refuses every call, sign in included; the site then says "Sign in is paused". To test sign in with replies off: `X_DAILY_SPEND_CAP_USD=0.5`, `X_SIGNIN_CAP_USD=0.5` leaves nothing for reads or replies, and 50 sign ins.

What $4 buys, with nothing set aside for sign in and `X_READ_SHARE=0` (all of it for replies): **266 replies without a link** ($0.015 each) or **20 with a link** ($0.20 each). At the default read share 0.6, $1.60 is left for replies: 106 without a link, 8 with. Each tagged card sends up to two replies.

| A busy day (40 tagged cards, 300 mentions with authors, 200 sign ins) | Links off | Links on |
|---|---|---|
| 80 replies | $1.20 | $16.00 |
| 300 mentions + 300 authors | $3.30 | $3.30 |
| 200 sign ins | $2.00 | $2.00 |
| Reply checks, a few pages | about $0.50 | about $0.50 |
| **Total** | **about $7** | **about $22** |

| Setting | Default | Suggested for a busy day |
|---|---|---|
| `X_DAILY_SPEND_CAP_USD` | 2 | 10 with links off, 25 (the ceiling in code) with links on |
| `X_SIGNIN_CAP_USD` | 0 | 2.50 (250 sign ins) |
| `X_READ_SHARE` | 0.6 of what sign in leaves | 0.5 |
| `X_READ_HOURLY_USD` | a third of the read share | 2 |
| `X_MENTION_PAGE_SIZE` | 20; a page's worst case, (0.001 + 0.010) per post, is reserved first | 50 if the hour allows it |
| `X_MENTION_MAX_PAGES` | 3 | 5 |
| `X_POLL_SECONDS` | 60 | 30 |

## Not covered by the offline tests

- **X itself.** The tests use a mock X. Real response shapes, the OAuth 1.0a signature, the OAuth 2.0 flow, real error bodies for credits running out (matched from X's docs), and how soon X's list of own posts shows a reply for the duplicate check.
- **X prices.** The `X_COST_*` defaults follow X's list; the first real bill is the check. The cap is only as true as these numbers.
- **Proxy headers.** How many `x-forwarded-for` entries your host adds. The visitor address check above finds out.
- **Mainnet behaviour.** Priority fees, batched `getTransactions` support on your RPC, the real 429 text, real clock lag, landing under load. A test validator has no congestion, so the lost send paths are tested with injected faults.
- **Load.** Counters are at `/api/admin/status`. `tools/loadtest-rpc.mjs` tests the RPC side.
- **Wallets** signing the link message and the pass buy.
- **Several processes.** The server is meant to run as one process with one SQLite file on a volume.

## Known limits

1. **Sign in is a site rule, not a chain rule.** Anyone calling the program directly skips it, including accounts below the minimum age. Only pass deals are gated on chain.
2. **One per X account deals can be farmed.** A cheap X account with few followers still counts, and the discount is free money.
3. **A bidder's win depends on someone settling in time.** Between the end and the settle, a seller can revoke and turn the sale into a refund. Bidders lose the win, not money. If the keeper is down or out of SOL, this window stays open. Watch `keeper.outOfSol` in status.
4. **Spam can still delay a settle, at a price.** To go ahead of a settle, every spam listing needs a bigger bid locked than that settle's. The keeper can't tell wash bids from real ones, so the bidder's protection must not rest on it alone: the site has a Settle now button anyone can press.
5. **Accept mode gives the seller a free option.** They can see the top bid and walk away, while the bidder's SOL sits locked for the length plus the window: about 2 hours 5 minutes at most on chain.
6. **A stolen listing key can't be replaced after revocation.** It can't move funds. It can spend its own SOL and open fake cards for any holder, so people could bid on a card the holder never asked for. Keep only small SOL on it.
7. **A wallet change has no alert.** The real owner has 48 hours to cancel but nothing tells them.
8. **Dev deal passes work on any listing naming the campaign.** A phishing page could spend someone's one claim on a bad deal. The price is in what they sign.
9. **A leaked pass key buys the whole discount schedule.** Anyone holding it can make up X id hashes and take every one per account deal in every campaign that names it, from one wallet. It moves no money by itself, but it controls the discounted deals. Keep it off the server if possible, and use a new campaign each day so a leak is bounded.
10. **Wash sales cost the keeper rent.** A winner with no token account costs about 0.002 SOL, more than the 0.001 SOL floor. The daily cap limits it. Past the cap such a winner waits for someone else to settle, which widens item 3.
11. **The X app is the account's own.** Use Sidebid's own X developer app, and fund the listing and keeper keys from fresh wallets.
12. **The program's own trust points.** `program/README.md` covers the upgrade authority: while it is kept, its holder can change any rule.

## Keys

| Key | Can do | Can't do |
|---|---|---|
| Listing (`LISTING_SECRET`) | Create tagged cards, pay their rent | Move tokens or bids. Tagged cards give no delegate |
| Pass (`PASS_SECRET`) | Allow a fixed buy, which covers every deal naming it (item 9) | Move money. Holds no SOL and signs no transaction |
| Keeper (`KEEPER_SECRET`) | Pay fees, and winner token account rent up to a daily cap | Move anything outside the program's rules |

Make each key with `solana-keygen new` and keep them separate. The server holds no user keys or funds. While the upgrade authority is kept, its holder can change everything, and that key must never be on the server.

## Run

    cp .env.example .env   # names only, fill on the host
    npm install
    npm test
    npm start

`TRUSTED_HOPS` is required in production or behind any proxy (on Railway expect 1, confirmed by `tools/deploy-ip-check.mjs`), and the server refuses to start without it. All flags start off. Change them with `POST /api/admin/flags` and the `x-admin-secret` header: `signinLive`, `readerLive`, `tagListingLive`, `repliesLive`, `keeperLive`, `passLive`, `killReader`, `killKeeper`, `dropsPaused`. Use a volume for `DATA_DIR`, because sign ins, links and open transactions can't be rebuilt from chain. On Railway `DATA_DIR` defaults to the volume's mount path (`RAILWAY_VOLUME_MOUNT_PATH`) and the server refuses a `DATA_DIR` that is not on it; elsewhere in production it must be set.

**Deploy.** Build the site (`npm run build` in `web/`), then run `node server/src/index.mjs` with the environment from `server/.env.example`. The server serves `web/dist` (or `WEB_DIST`). At start it writes `<DATA_DIR>/site.json` from `BROWSER_RPC_URL` (a public safe RPC: a key locked to the domain, never `RPC_URL`), `SOLANA_CLUSTER` (default `mainnet-beta`) and `UPGRADE_AUTHORITY`, keeping every other field already in the file. It refuses to start in production without a browser RPC, or when the browser RPC carries the server's RPC key. It also refuses to start when the test chain flag is set.

## Tests

- `npm test`: every unit and integration test, one file at a time, against the program built in `program/` and run in LiteSVM. `test/10-hardening.test.mjs` and `test/12-rewards-hardening.test.mjs` hold one regression test per fixed edge case; `test/11-rewards.test.mjs` covers the rest of the rewards.
- `npm run test:validator`: run alone. It refuses to start next to another validator, runs its files one at a time, and deletes each ledger after. It needs `solana-test-validator`, uses throwaway keys and mocks X. The rewards run there makes three real fixed price sales read by the real indexer, measures a claim from a real transaction, sends four real payouts, and kills the process inside the second payout; each payout must land exactly once.

## Privy sign in

Sign in opens Privy's modal ("Protected by Privy") with X, a wallet (Phantom, Solflare, Backpack) and email. Someone who signs in by X or email with no wallet gets a Privy embedded Solana wallet. The Privy bundle is loaded only when someone presses Sign in, or comes back with a Privy embedded wallet.

**Settings.** `PRIVY_APP_ID` (public, it is in every page; served to the site in `/api/config` as `auth.privy.appId`). Optional `PRIVY_CLIENT_ID` picks a Privy app client (for example a development one). No app secret: the server verifies tokens with the app's public keys at `https://auth.privy.io/api/v1/apps/<app id>/jwks.json` (ES256, issuer `privy.io`, audience the app id, expiry). `PRIVY_APP_SECRET` is not read anywhere. The keys are cached for an hour; an unknown key id refetches at most once a minute.

**Privy dashboard, all required:**

- Login methods: Email, X (with Sidebid's own X app credentials; X callback `https://auth.privy.io/api/v1/oauth/callback`), External wallets with Solana only.
- Embedded wallets: Solana on ("create for users without wallets"; the site also asks for it).
- **User management > Authentication > Advanced: "Return user data in an identity token" ON.** Without it the server has no signed X id, handle or wallet list, and refuses sign in (`no_identity_token`). This is what removes the need for an app secret.
- Allowed domains: sidebid.fun, plus any test domain you run.

**What the server does.** `POST /api/auth/privy` takes `{ accessToken, identityToken, wallet }` from the page. Both tokens must verify and name the same Privy user. The account is the X user id from the identity token's `twitter_oauth` account when X is linked, else `pv:<privy id>`. Handle and picture come from the same signed token. A first wallet is linked at once to one Privy verified wallet (the one the browser is using, else the newest outside wallet, else the embedded one). Any later change, through `POST /api/wallet/link-privy` (a Privy verified wallet) or the signed message (any other wallet), waits `WALLET_CHANGE_WAIT_HOURS` (48). Someone who signed in by email and links X later keeps their wallet: it moves to the X account.

**Rules.** One fixed price pass per X account is keyed by the X id in Privy's signed identity token (an account with no X gets `x_needed`). Handle and picture show on cards and rewards. No age or follower minimum.

**X cost.** A Privy sign in makes no call to X from this server and spends nothing from the X ledger. Privy itself reads the person's X profile once per X login with Sidebid's X app credentials, so X may bill that read to Sidebid's X developer account at the "User: Read" price; this server cannot cap it. The server's own `/2/users/me` call exists only in the X OAuth fallback (`X_OAUTH_FALLBACK=1`), and stays inside `X_SIGNIN_CAP_USD`.

**Signing.** The site builds every transaction, reads the listing again from RPC before signing, and checks what comes back against what was built before sending. An installed wallet Privy signed someone in with is then used directly through the Wallet Standard; a Privy embedded wallet signs through Privy's confirm screen. Both go through the same checks.

On a test chain a fresh Privy wallet has no SOL and test airdrops may be refused, so trades with a Privy wallet are best tried on mainnet.

## Site routes (`src/launch.mjs`, `src/legal.mjs`)

`withLaunch` wraps the site handler and passes everything else through unchanged.

**Plain pages.** `GET /terms` and `GET /privacy` are rendered whole on the server inside the built site's head (fonts, stylesheet, icons), with their own title, description, share tags and canonical link, and no app script (CSP `script-src 'none'`). The footer links to them with `target="_self"`, so the app does a full page load instead of routing. `GET /.well-known/security.txt` (and `/security.txt`): contact `mailto:sidebid@outlook.com`, `Expires` from `SECURITY_EXPIRES` in `legal.mjs` (move it forward each year; the site check fails 30 days before), policy `<PUBLIC_URL>/docs`, canonical, source repo. `GET /robots.txt` allows everything but `/api/` (share cards stay crawlable) and names the sitemap. `GET /sitemap.xml` lists `SITE_ROUTES`.

**Mainnet test record.** The transactions of a mainnet test run, for the section the site shows.

- `POST /api/admin/launch-test` with `x-admin-secret`. Body, one of:
  - `{ "items": [{ "sig": "<base58 signature>", "label": "Listing", "note": "optional" }, ...] }` replaces the list (at most 50, duplicates dropped);
  - `{ "add": { "sig", "label", "note" } }` appends one, or relabels it if the signature is already listed;
  - `{ "remove": "<sig>" }` drops one.
  A label is free text up to 40 characters, a note up to 140. Errors (400): `bad_signature`, `bad_label`, `bad_item`, `too_many`, `nothing_to_do`. Answers `{ items }`.
- `GET /api/admin/launch-test` answers `{ items, labels }`; `labels` is the usual set: Listing, Bid, Outbid refund, Settle, Fixed buy, Accept, Refund, Cancel, Payout, Fee claim.
- `GET /api/site/launch-test` is public (60 a minute per visitor):

  ```json
  { "items": [ { "sig": "…", "label": "Settle", "note": null, "status": "finalized", "err": null, "slot": 381234567, "blockTime": 1762450000, "url": "https://solscan.io/tx/…" } ], "checkedAt": 1762450100 }
  ```

  In the stored order. `status`: `finalized`, `confirmed`, `processed`, `failed` (landed with an error; `err` is the chain's error as JSON, at most 200 characters), `not_found` (the RPC does not know the signature), or `unknown` (the read failed; not a verdict). `blockTime` is unix seconds or null. Statuses come from `getSignatureStatuses` with history search and block times from `getBlockTime`. A finalized row with its block time is kept in the database and never read again; the rest are read again at most every 15 seconds for everyone together. `url` uses `chain.explorer` from `site.json`.

The site shows the list as Tested on mainnet before launch, below the hero on the home page and on /tx, in step order (Listing, Bid, Outbid refund, Settle, Fixed buy, Accept, Refund, Hourly payout; the label `Payout` reads Hourly payout), and hides the section while the list is empty.

**CA reveal.** `POST /api/admin/reveal` with `{ "ca": "<mint>", "xHandle": "sidebidsol" }` writes `brand.reveal: true`, `brand.ca` and `brand.xHandle` into `site.json` on the volume, keeping every other field; the site follows within a second. The CA must be a token mint on the server's chain (owned by SPL Token or Token 2022), else `not_a_mint`. `{ "reveal": false }` hides it again.

**Check facts.** `GET /api/admin/launch-check` answers what `tools/check.mjs` needs and nothing secret: production mode, whether the test chain flag is set, resolved `DATA_DIR`, the Railway volume and whether `DATA_DIR` is on it, program id, the server RPC's genesis hash, public keys of the keeper, listing, pass and dev wallets, the X cap settings, the rewards team wallet, and row counts.

**Tools.** `tools/check.mjs <site>` is the site check before going live (`ADMIN_SECRET` and `RPC_URL` from the environment; prints `ALL CLEAR` or each problem; exit 0 or 1). `tools/loadtest-rpc.mjs --mint=<mint>` reads 800 wallets' token accounts in batches of 100 per `getMultipleAccounts` and reports errors, 429s and latency. Both are tested against a mock RPC in `test/16-launch.test.mjs`.
