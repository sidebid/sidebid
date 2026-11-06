# Security

## Reporting a problem

Please report anything that could lose or lock someone's SOL or tokens privately, before posting it anywhere: email sidebid@outlook.com. The same address is in the program's `security.txt` block (shown on Solana Explorer and Solscan for the program ID) and on [sidebid.fun](https://sidebid.fun). Include the program ID, the steps or a transaction, and what you expected to happen. We will reply, fix what is real, and credit you if you want.

Please don't test against other people's live listings. A local validator or LiteSVM, as in `program/tests/`, reproduces almost everything.

## What is in scope

- `program/`: the on chain program, ID `5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp`. Anything that moves SOL or tokens outside the rules in `program/README.md`, locks them for good, or lets one user act for another.
- `server/`: the keeper, indexer, pass signer, X reader and rewards. Its keys can't move user funds, so the worst cases are spending its own SOL, opening fake tagged cards, misusing the pass key, or paying rewards wrongly.
- `web/`: the site. Anything that makes a wallet sign something other than what the page shows.

## Trust you must place

- **The upgrade authority.** Upgrade authority: check its live status on [Solscan](https://solscan.io/account/5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp). While it exists, its holder can deploy a new program and change every rule, including taking bids held in vaults and using live token approvals. The project revokes the upgrade authority before launch; once revoked, the program can never be changed.
- **The listing server key** can open tagged cards naming any holder. It cannot move funds.
- **The build.** Don't take the binary on trust: rebuild it and compare hashes as described in `README.md` ("Verify the build").

## Tests

Every rule in the program has a test in `program/tests/`, including attack cases (`05-attacks.test.mjs`), regressions for past findings (`07-regressions.test.mjs`) and a full shutdown rehearsal (`08-shutdown.test.mjs`). The server's hardening tests are in `server/test/10-hardening.test.mjs` and `server/test/12-rewards-hardening.test.mjs`, and the site's fast checks in `web/test/unit.mjs`.

Known limits and open design choices are listed in `program/README.md` and `server/BACKEND.md`.
