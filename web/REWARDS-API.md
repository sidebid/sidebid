# Rewards API: what the site reads

The interface between the site (`web/`) and the hourly rewards work in `server/`. The site is built to this shape. If anything here does not fit what the server can do, change this file and say so; the site will follow.

The site never computes payouts. It only shows what this route says. Until the route exists, or while it errors, the site works without it (see "When the route is missing").

## Route

    GET /api/rewards

Public, no session, no body. JSON. Same headers and rate limits as `/api/listings`. Optional query:

| Query | Meaning |
|---|---|
| `before=<unix seconds>` | Past hours whose `start` is earlier than this, for paging back. |
| `limit=<n>` | How many past hours, 1 to 48, default 24. |

All SOL amounts are lamports as decimal **strings**. All times are **unix seconds**. Wallets are base58.

## Response

```json
{
  "now": 1762434012,
  "split": [50, 30, 20],
  "sellerSharePct": 90,
  "teamSharePct": 10,
  "devWallet": "base58 or null",
  "hour": {
    "start": 1762430400,
    "end": 1762434000,
    "payoutAt": 1762434000,
    "potLamports": "3412000000",
    "potKind": "estimate",
    "standings": [
      {
        "rank": 1,
        "wallet": "base58",
        "handle": "x_handle or null",
        "avatar": "https://pbs.twimg.com/... or null",
        "receivedLamports": "18420000000",
        "sales": 3,
        "projectedLamports": "1706000000"
      }
    ]
  },
  "past": [
    {
      "start": 1762426800,
      "end": 1762430400,
      "status": "paid",
      "potLamports": "2871000000",
      "claimSig": "base58 signature or null",
      "sales": 14,
      "payouts": [
        { "rank": 1, "wallet": "base58", "handle": "x_handle or null", "avatar": null, "lamports": "1435500000", "sig": "base58 signature or null" }
      ]
    }
  ],
  "next": 1762416000
}
```

### Fields

- `hour`: the hour being counted now. `payoutAt` is when its payout runs (normally `end`).
- `hour.potAllLamports`: what the three places would share if the hour closed now with all three filled, so open places can show what each would get. `hour.feesLamports`: creator fees waiting in the vault above rent, unclaimed. Both `null` when unknown.
- `hour.potLamports`: the **seller pot**, meaning the 90% part only, not the team's 10%. `null` when the server cannot read it yet.
- `hour.potKind`: `"estimate"` while the fees are still unclaimed (read from the claimable balance), `"claimed"` once the claim for this hour has landed.
- `hour.standings`: every seller with at least one completed sale this hour, best first, ranked by SOL received from completed sales (`Settled`, `Accepted`, `Bought`). Ties: earlier first sale ranks higher. `projectedLamports` is that rank's share of the current pot, `"0"` outside the top 3. May be an empty array.
- `past`: finished hours, newest first. `status` is one of:
  - `paid`: claim and payouts landed. Every `sig` is set.
  - `paying`: claim or some payouts still in flight. Missing `sig`s are `null`.
  - `no_sales`: no completed sale that hour, nothing paid. `payouts` is empty and the pot rolls into the next hour.
  - `failed`: one or more payouts could not be sent and their share carried to the next hour. `payouts` lists what landed. *(Wording corrected by the server, 6 Nov.)*
  - `carried`: there were sales but nothing could be paid this hour (the claim failed, or the pot was under the minimum payout). The pot rolls into the next hour. `payouts` is empty. *(Added by the server, 6 Nov.)*
- `payouts`: up to 3 rows, rank 1 to 3. Fewer than 3 sellers means fewer rows. **The unpaid shares go into the next hour's pot.** So does any share under the minimum payout (0.001 SOL) or one the winner's account refused. Team payouts are not listed here.
- `next`: the `before` value for the next page, or `null`.

## What the site shows from it

| Site element | Field |
|---|---|
| Live seller pot | `hour.potLamports` (label says "so far" while `potKind` is `estimate`) |
| Payout countdown | `hour.payoutAt` against `now` (the site corrects its clock by `now`) |
| This hour's standings | `hour.standings` |
| Podium on the home page | top 3 of `hour.standings` |
| Past hours, each with tx links | `past[]`, `claimSig` and each `payouts[].sig` |
| Split text | `split`, `sellerSharePct`, `teamSharePct` |

## When the route is missing

A body with no `hour` (`{ "off": true }`), a `404`, a network error, a non JSON body or a `5xx` all mean "not available". The site then:

- builds this hour's standings itself from `GET /api/sales` (sum of `price` per `seller` for sales with `at` inside the current UTC hour), clearly as standings only, with no payout amounts;
- shows the pot as "Opens at launch" instead of a number, and the countdown to the next full UTC hour;
- shows no past hours section, and says the first payout appears there after the first paid hour;
- never shows a 0 or an empty table: with no sales this hour it shows the next scheduled drop instead.

## Contact points

- The site reads only `GET /api/rewards`. It sends nothing to it.
- Nothing in `web/` imports server code, and the rewards work needs nothing from `web/`.
- The only server files the site work adds or touches are `server/src/site.mjs` (new) and two lines in `server/src/index.mjs`. The rewards work can own every other server file.

## Server notes (6 Nov)

The server implements this shape at `GET /api/rewards` (`server/src/rewards/rewards.mjs`, `view`). Differences and additions, for the site to follow:

- `hour.payoutAt` is `end` plus the server's close margin (default 60 s), so the indexer can read the hour's last blocks first. The payout itself then takes a few seconds more.
- `hour.potKind` is always `"estimate"` for the hour being counted, because the claim runs after it ends. The claimed amount shows in `past[].potLamports`.
- `hour.potLamports` is the seller part of the claimable fees, after the team's 10% and the network fees reserved for the payouts, plus the carry from earlier hours. A failed vault read keeps the last good value for a minute, then `null`.
- Ties: earlier first sale ranks higher, then wallet address. The payout uses the same order.
- Extra fields the site may ignore: `name` and `ticker` (from config), and `paused`. `paused` is true while payouts are switched off or the server can't pay at all, for example with no team wallet set. `hour.potLamports` is then `null`.
- Several sales in one transaction each count, for standings and for `/api/sales`.
- `avatar` is the X profile picture saved at sign in, or `null`.
- Without a dev key configured, the route answers `200` with `{ "off": true }` and no `hour`. That is your "not available" case (a `404` is still read the same way).

## Test ports (site, 6 Nov)

The site's end to end test (`web/test/e2e.mjs`) runs its validator on RPC 38899, faucet 39900, gossip 38000, dynamic 38001 to 38040, and its server on 38790. `server/test/e2e/rewards-validator.test.mjs` uses 28899 and 28001 to 28030, which the site test used first; the two runs collided once, so the site moved.
