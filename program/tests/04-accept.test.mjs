import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, WINDOW, SERVER, makeExecutable, setupAccept, setup, acceptPda, listingPda, vaultPda, creditPda, spl, Keypair, PublicKey, SystemProgram, T22 } from "./helpers.mjs";
import { createHash } from "node:crypto";

const newId = () => createHash("sha256").update(Keypair.generate().publicKey.toBuffer()).digest();

test("accept: server creates with no seller signature and no delegate, tokens untouched", () => {
  const c = setupAccept({ amount: 400n * UNIT, held: 1000n * UNIT });
  const t = c.e.token(c.tokenAccount);
  assert.equal(t.delegate, null, "no delegate");
  assert.equal(t.amount, 1000n * UNIT);
  const l = c.e.listing(c.listing);
  assert.equal(l.mode, 2);
  assert.ok(l.seller.equals(c.seller.publicKey));
  assert.equal(l.acceptWindow, WINDOW, "window stored per listing");
  assert.ok(l.rentPayer.equals(SERVER.publicKey));
});

test("accept: bids behave as in bidding mode, outbid refunded, anti snipe applies", () => {
  const c = setupAccept({ duration: 100n });
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  const a0 = c.e.bal(a.publicKey);
  const end0 = c.e.listing(c.listing).endTime;
  c.bid(a, 2n * MIN);
  assert.equal(c.e.bal(c.vault), 2n * MIN);
  c.e.warp(90);
  c.bid(b, 3n * MIN, a);
  assert.equal(c.e.bal(a.publicKey), a0);
  assert.equal(c.e.bal(c.vault), 3n * MIN);
  assert.equal(c.e.listing(c.listing).endTime, end0 + 15n);
  c.e.fails(c.bidIx(a, 3n * MIN, b), [a], "BidNotAboveTop");
  c.e.fails(c.bidIx(a, 3n * MIN + 1n, b), [a], "RaiseTooSmall");
});

test("accept: seller signs after the end, swap in one transaction, seller gets SOL, server its rent", () => {
  const c = setupAccept({ amount: 400n * UNIT, held: 1000n * UNIT });
  const w = c.e.wallet();
  c.bid(w, 7n * MIN);
  c.e.warp(300);
  const [s0, srv0, rent] = [c.e.bal(c.seller.publicKey), c.e.bal(SERVER.publicKey), c.e.bal(c.listing)];
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.ok(c.acceptIx(w.publicKey, 7n * MIN), [c.seller]);
  assert.equal(c.e.token(wt).amount, 400n * UNIT);
  assert.equal(c.e.token(c.tokenAccount).amount, 600n * UNIT);
  assert.equal(c.e.bal(c.seller.publicKey), s0 + 7n * MIN);
  assert.equal(c.e.bal(SERVER.publicKey), srv0 + rent);
  assert.equal(c.e.bal(c.vault), 0n);
  assert.equal(c.e.acct(c.listing), null);
  c.e.fails(c.acceptIx(w.publicKey, 7n * MIN), [c.seller], "AccountNotInitialized");
});

test("accept: seller may spend from another token account they own", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const other = c.e.freshTokenAccount(c.seller.publicKey, c.mint);
  c.e.ok(spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, c.amount), [c.seller]);
  c.e.warp(300);
  c.e.ok(c.acceptIx(w.publicKey, 2n * MIN, { tokenAccount: other }), [c.seller]);
  assert.equal(c.e.token(c.e.ata(w.publicKey, c.mint)).amount, c.amount);
});

test("accept: works on a Token 2022 mint", () => {
  const c = setupAccept({ program: T22 });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  c.e.ok(c.acceptIx(w.publicKey, 2n * MIN), [c.seller]);
  assert.equal(c.e.token(c.e.ata(w.publicKey, c.mint, 0n, T22), T22).amount, c.amount);
});

test("accept: wrong wallet is refused, even with the seller's token account or its own tokens", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const thief = c.e.wallet();
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { seller: thief.publicKey, tokenAccount: c.tokenAccount }), [thief], "NotSeller");
  const own = c.e.ata(thief.publicKey, c.mint, c.amount);
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { seller: thief.publicKey, tokenAccount: own }), [thief], "NotSeller");
  // The winner cannot sign for the seller either.
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { seller: w.publicKey }), [w], "NotSeller");
  assert.equal(c.e.bal(c.vault), 2n * MIN);
});

test("accept: before the end fails", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(299);
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN), [c.seller], "AuctionNotEnded");
});

test("accept: last second of the window works, the next second fails", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300n + WINDOW - 1n);
  c.e.ok(c.acceptIx(w.publicKey, 2n * MIN), [c.seller]);
  const d = setupAccept();
  const x = d.e.wallet();
  d.bid(x, 2n * MIN);
  d.e.warp(300n + WINDOW);
  d.e.fails(d.acceptIx(x.publicKey, 2n * MIN), [d.seller], "AcceptWindowClosed");
  assert.equal(d.e.bal(d.vault), 2n * MIN);
});

test("accept: too few tokens fails with nothing moved, and then refund is open to anyone", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  const w0 = c.e.bal(w.publicKey);
  c.bid(w, 2n * MIN);
  const other = c.e.ata(c.e.wallet().publicKey, c.mint);
  c.e.ok(spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, 1n), [c.seller]);
  c.e.warp(300);
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN), [c.seller], "InsufficientTokens");
  assert.equal(c.e.bal(c.vault), 2n * MIN);
  c.e.ok(c.refundIx(w.publicKey));
  assert.equal(c.e.bal(w.publicKey), w0);
  assert.equal(c.e.listing(c.listing).state, 2, "Ghosted");
});

test("accept: a seller signature cannot be replayed onto a different deal", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  c.e.fails(c.acceptIx(w.publicKey, 3n * MIN), [c.seller], "ListingChanged");
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { amount: c.amount - 1n }), [c.seller], "ListingChanged");
});

test("accept: tokens can only go to the winner, SOL only to the seller, rent only to the payer", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const thief = c.e.wallet();
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { winnerToken: c.e.ata(thief.publicKey, c.mint) }), [c.seller], "ConstraintTokenOwner");
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { rentReceiver: thief.publicKey }), [c.seller], "ConstraintAddress");
});

// ---- creating ----

test("create: a non-server key is refused, including a seller listing for themselves", () => {
  const e = new Env();
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const fake = e.wallet();
  e.fails(IX.createAccept({ server: fake.publicKey, id: newId(), seller: seller.publicKey, tokenAccount, mint, amount: 100n }), [fake], "NotListingServer");
  e.fails(IX.createAccept({ server: seller.publicKey, id: newId(), seller: seller.publicKey, tokenAccount, mint, amount: 100n }), [seller], "NotListingServer");
  // Naming the server without its signature is refused by the runtime and Anchor.
  const ix = IX.createAccept({ server: SERVER.publicKey, id: newId(), seller: seller.publicKey, tokenAccount, mint, amount: 100n });
  ix.keys[0].isSigner = false;
  e.fails(ix, [], "");
});

test("create: refuses a wallet without the tokens, bad settings, and a repeated id", () => {
  const e = new Env();
  e.svm.airdrop(SERVER.publicKey.toBase58(), 1_000_000_000n);
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const base = { server: SERVER.publicKey, seller: seller.publicKey, tokenAccount, mint, amount: 100n };
  const go = (o, why) => e.fails(IX.createAccept({ ...base, id: newId(), ...o }), [SERVER], why);
  go({ amount: 101n }, "InsufficientTokens");
  go({ amount: 0n }, "ZeroAmount");
  go({ minBid: MIN - 1n }, "PriceTooLow");
  go({ duration: 1n }, "BadDuration");
  go({ duration: 2n ** 64n - 1n }, "BadDuration");
  go({ window: 59n }, "BadDuration");
  go({ window: 3601n }, "BadDuration");
  go({ duration: 3601n }, "BadDuration");
  go({ window: 2n ** 63n }, "BadDuration");
  const id = newId();
  e.ok(IX.createAccept({ ...base, id }), [SERVER]);
  e.fails(IX.createAccept({ ...base, id }), [SERVER], "already in use");
});

test("create: Token 2022 mints with dangerous extensions are refused here too", () => {
  const e = new Env();
  e.svm.airdrop(SERVER.publicKey.toBase58(), 1_000_000_000n);
  const seller = e.wallet();
  const mint = e.mint({ program: T22, extensions: [spl.ExtensionType.PermanentDelegate],
    extensionIxs: (m, auth) => [spl.createInitializePermanentDelegateInstruction(m, auth, T22)] });
  const tokenAccount = e.ata(seller.publicKey, mint, 100n, T22);
  e.fails(IX.createAccept({ server: SERVER.publicKey, id: newId(), seller: seller.publicKey, tokenAccount, mint, tokenProgram: T22, amount: 100n }), [SERVER], "UnsupportedMintExtension");
});

test("create: tagged cards never block the seller's own listing, and the reverse", () => {
  const c = setupAccept();
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n, price: MIN, duration: 60n }), [c.seller]);
  // Using the token account as the id lands in a separate address space.
  assert.ok(!acceptPda(c.tokenAccount.toBuffer()).equals(listingPda(c.tokenAccount)));
  c.e.ok(IX.createAccept({ server: SERVER.publicKey, id: c.tokenAccount.toBuffer(), seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n }), [SERVER]);
});

// ---- the server key cannot take anything ----

test("server key: every path to funds or tokens is refused", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const srv = SERVER;
  const srvToken = c.e.ata(srv.publicKey, c.mint);
  const vault0 = c.e.bal(c.vault);
  // Accept as the seller, before and during the window.
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { seller: srv.publicKey, tokenAccount: srvToken }), [srv], "NotSeller");
  c.e.warp(300);
  c.e.fails(c.acceptIx(w.publicKey, 2n * MIN, { seller: srv.publicKey, tokenAccount: srvToken }), [srv], "NotSeller");
  // Claim the bidder's or seller's credit.
  c.e.fails(IX.claimCredit({ owner: srv.publicKey, listing: c.listing, destination: srv.publicKey, credit: creditPda(c.listing, w.publicKey) }), [srv], "ConstraintSeeds");
  // Point settle, cancel and buy at the card.
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: c.e.ata(w.publicKey, c.mint) }), [srv], "WrongMode");
  c.e.fails(IX.settle({ listing: c.listing, seller: srv.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: c.e.ata(w.publicKey, c.mint) }), [srv], "ConstraintAddress");
  c.e.fails(IX.cancel({ seller: srv.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, topBidder: w.publicKey }), [srv], "ConstraintAddress");
  c.e.fails(IX.buy({ buyer: srv.publicKey, listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, buyerToken: srvToken, price: 1n, amount: c.amount }), [srv], "WrongMode");
  // Refund cannot send the bid anywhere but the bidder.
  c.e.fails(c.refundIx(srv.publicKey), [srv], "RefundNotAllowed");
  c.e.warp(WINDOW);
  c.e.fails(c.refundIx(srv.publicKey), [srv], "MissingPrevBidder");
  // Recreating at the same id while live fails.
  c.e.fails(IX.createAccept({ server: srv.publicKey, id: c.id, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n }), [srv], "already in use");
  // Close cannot take the bid: the listing must first be refunded.
  c.e.fails(c.closeIx(), [srv], "CloseNotAllowed");
  assert.equal(c.e.bal(c.vault), vault0);
  assert.equal(c.e.token(c.tokenAccount).amount, c.amount);
  assert.equal(c.e.token(srvToken).amount, 0n);
  // The bidder still gets every lamport.
  const w0 = c.e.bal(w.publicKey);
  c.e.ok(c.refundIx(w.publicKey));
  assert.equal(c.e.bal(w.publicKey), w0 + vault0);
});

test("server key: naming itself as the credit account of an unpayable bidder is refused", () => {
  const c = setupAccept();
  const w = c.e.wallet(5n * MIN);
  c.bid(w, 2n * MIN);
  makeExecutable(c.e, w.publicKey);
  c.e.warp(300n + WINDOW);
  c.e.fails(IX.refund({ listing: c.listing, tokenAccount: c.tokenAccount, topBidder: w.publicKey, credit: SERVER.publicKey }), [SERVER], "BadCreditAccount");
  assert.equal(c.e.bal(c.vault), 2n * MIN);
});

test("server key: can never appear as a token delegate, and pays its own way", () => {
  const c = setupAccept();
  assert.equal(c.e.token(c.tokenAccount).delegate, null);
  const before = c.e.bal(SERVER.publicKey);
  const d = setupAccept({ env: c.e });
  assert.equal(c.e.bal(SERVER.publicKey), before - c.e.bal(d.listing), "server only ever pays rent");
});

// ---- refund and ghosting ----

test("refund during the window while the seller still holds the tokens fails", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.fails(c.refundIx(w.publicKey), [], "RefundNotAllowed"); // before the end
  c.e.warp(300);
  c.e.fails(c.refundIx(w.publicKey), [w], "RefundNotAllowed"); // first second of the window
  c.e.warp(WINDOW - 1n);
  c.e.fails(c.refundIx(w.publicKey), [w], "RefundNotAllowed"); // last second of the window
  assert.equal(c.e.bal(c.vault), 2n * MIN);
});

test("attack: an empty account opened in the seller's name cannot fake a ghost", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const emptyInSellersName = c.e.freshTokenAccount(c.seller.publicKey, c.mint);
  c.e.fails(IX.refund({ listing: c.listing, tokenAccount: emptyInSellersName, topBidder: w.publicKey }), [w], "ConstraintAddress");
  c.e.ok(c.acceptIx(w.publicKey, 2n * MIN), [c.seller]);
});

test("refund after the window: anyone can call it, full bid back, Ghosted", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  const w0 = c.e.bal(w.publicKey);
  c.bid(w, 2n * MIN);
  c.e.warp(300n + WINDOW);
  c.e.ok(c.refundIx(w.publicKey));
  assert.equal(c.e.bal(w.publicKey), w0);
  assert.equal(c.e.bal(c.vault), 0n);
  assert.equal(c.e.listing(c.listing).state, 2);
  assert.equal(c.e.token(c.tokenAccount).amount, c.amount);
  c.e.fails(c.refundIx(w.publicKey), [], "NotLive");
  c.e.fails(c.acceptIx(w.publicKey, 0n), [c.seller], "ConstraintTokenOwner"); // top bidder cleared
  const [srv0, rent] = [c.e.bal(SERVER.publicKey), c.e.bal(c.listing)];
  c.e.ok(c.closeIx());
  assert.equal(c.e.bal(SERVER.publicKey), srv0 + rent);
});

const leaves = {
  "moves the tokens": (c) => c.e.ok(spl.createTransferInstruction(c.tokenAccount, c.e.ata(c.e.wallet().publicKey, c.mint), c.seller.publicKey, c.amount), [c.seller]),
  "closes the account": (c) => c.e.ok([
    spl.createTransferInstruction(c.tokenAccount, c.e.ata(c.e.wallet().publicKey, c.mint), c.seller.publicKey, c.amount),
    spl.createCloseAccountInstruction(c.tokenAccount, c.seller.publicKey, c.seller.publicKey)], [c.seller]),
  "gives the account away": (c) => c.e.ok(spl.createSetAuthorityInstruction(c.tokenAccount, c.seller.publicKey, spl.AuthorityType.AccountOwner, c.e.wallet().publicKey), [c.seller]),
};
for (const [name, leave] of Object.entries(leaves)) {
  for (const [when, wait] of [["before the end", 10], ["during the window", 310]]) {
    test(`seller ${name} ${when}: anyone refunds at once, Ghosted`, () => {
      const c = setupAccept();
      const w = c.e.wallet();
      const w0 = c.e.bal(w.publicKey);
      c.bid(w, 2n * MIN);
      c.e.warp(wait);
      leave(c);
      c.e.ok(c.refundIx(w.publicKey));
      assert.equal(c.e.bal(w.publicKey), w0);
      assert.equal(c.e.listing(c.listing).state, 2);
    });
  }
}

test("seller no longer holding: new bids are refused", () => {
  const c = setupAccept();
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  c.bid(a, 2n * MIN);
  leaves["moves the tokens"](c);
  c.e.fails(c.bidIx(b, 3n * MIN, a), [b], "SellerTokensUnavailable");
});

test("no bids: accept fails, refund does not mark it ghosted, anyone closes after the end, rent to server", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.e.warp(300);
  c.e.fails(c.acceptIx(PublicKey.default, 0n), [c.seller], "NoBids");
  c.e.fails(c.refundIx(), [], "NoBids");
  c.e.warp(WINDOW);
  c.e.fails(c.refundIx(), [], "NoBids");
  const [srv0, rent] = [c.e.bal(SERVER.publicKey), c.e.bal(c.listing)];
  c.e.ok(c.closeIx());
  assert.equal(c.e.bal(SERVER.publicKey), srv0 + rent);
  assert.equal(c.e.acct(c.listing), null);
});

test("no bids: closing before the end is refused", () => {
  const c = setupAccept();
  c.e.fails(c.closeIx(), [], "CloseNotAllowed");
});

test("cancel, settle and buy are not paths on an accept listing", () => {
  const c = setupAccept();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.fails(IX.cancel({ seller: c.seller.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, topBidder: w.publicKey }), [c.seller], "WrongMode");
  c.e.warp(300);
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: c.e.ata(w.publicKey, c.mint) }), [], "WrongMode");
});

// ---- a bidder cannot be stranded ----

const spoilers = {
  healthy: () => {},
  "wallet at zero": null, // handled by funding the bidder with exactly the bid
  "executable bidder": (e, k) => makeExecutable(e, k),
  "data bidder under rent": (e, k) => e.poke(k, { lamports: 1n, data: new Uint8Array(100_000) }),
};
const sellerMoves = {
  "seller does nothing": () => {},
  "seller closes the token account": leaves["closes the account"],
};

for (const [bk, spoil] of Object.entries(spoilers)) {
  for (const [sk, move] of Object.entries(sellerMoves)) {
    test(`not stranded: ${bk}, ${sk}: refund after the window pays out in full`, () => {
      const c = setupAccept();
      const bid = 2n * MIN;
      const w = bk === "wallet at zero" ? c.e.wallet(bid) : c.e.wallet(5n * MIN);
      c.bid(w, bid);
      spoil?.(c.e, w.publicKey);
      move(c);
      c.e.warp(300n + WINDOW);
      const [b0, cr0] = [c.e.bal(w.publicKey), c.e.bal(creditPda(c.listing, w.publicKey))];
      c.e.ok(c.refundIx(w.publicKey));
      const delta = c.e.bal(w.publicKey) - b0 + c.e.bal(creditPda(c.listing, w.publicKey)) - cr0;
      assert.equal(delta, bid, "bid is back, in the wallet or claimable");
      assert.equal(c.e.bal(c.vault), 0n);
      if (c.e.bal(creditPda(c.listing, w.publicKey)) > 0n) {
        const dest = c.e.wallet(0n).publicKey;
        c.e.ok(IX.claimCredit({ owner: w.publicKey, listing: c.listing, destination: dest }), [w]);
        assert.equal(c.e.bal(dest), bid);
      }
    });
  }
}

test("not stranded: a winner with a broken token account: fresh account lets the seller finish, else refund", () => {
  const e = new Env();
  const authority = e.wallet();
  const c = setupAccept({ env: e, mintOpts: { freezeAuthority: authority.publicKey } });
  const w = e.wallet();
  c.bid(w, 2n * MIN);
  const wt = e.ata(w.publicKey, c.mint);
  e.ok(spl.createFreezeAccountInstruction(wt, c.mint, authority.publicKey), [authority]);
  e.warp(300);
  e.fails(c.acceptIx(w.publicKey, 2n * MIN), [c.seller], "frozen");
  const fresh = e.freshTokenAccount(w.publicKey, c.mint);
  e.ok(c.acceptIx(w.publicKey, 2n * MIN, { winnerToken: fresh }), [c.seller]);
  assert.equal(e.token(fresh).amount, c.amount);

  const d = setupAccept({ env: e, mintOpts: { freezeAuthority: authority.publicKey } });
  const x = e.wallet();
  const x0 = e.bal(x.publicKey);
  d.bid(x, 2n * MIN);
  e.ok(spl.createFreezeAccountInstruction(d.tokenAccount, d.mint, authority.publicKey), [authority]);
  e.ok(d.refundIx(x.publicKey)); // frozen seller cannot accept: refund at once
  assert.equal(e.bal(x.publicKey), x0);
});

test("not stranded: exhaustive walk of states: every reachable state with a bid has an exit", () => {
  // At each moment a bid exists, either accept or refund succeeds in simulation.
  for (const [wait, holds] of [[0, true], [0, false], [299, true], [299, false], [300, true], [300, false], [899, true], [899, false], [900, true], [900, false], [100000, true], [100000, false]]) {
    const c = setupAccept();
    const w = c.e.wallet();
    c.bid(w, 2n * MIN);
    c.e.warp(wait);
    if (!holds) leaves["moves the tokens"](c);
    const s = c.e.send(c.acceptIx(w.publicKey, 2n * MIN), [c.seller]);
    const r = s.ok ? { ok: true } : c.e.send(c.refundIx(w.publicKey), []);
    const outbidOnly = wait < 300 && holds; // bidding is open: the exit is being outbid
    if (outbidOnly) {
      assert.ok(!s.ok && !r.ok, "no refund while the auction runs and the seller holds");
      const b = c.e.wallet();
      c.bid(b, 3n * MIN, w);
    } else {
      assert.ok(s.ok || r.ok, `wait=${wait} holds=${holds} has no exit: ${s.err} / ${r.err}`);
    }
  }
});
