import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, GRACE, makeExecutable, setup, creditPda, spl, Keypair, PublicKey, SystemProgram, TOKEN, listingPda } from "./helpers.mjs";

/** Scenarios where the seller breaks delivery. Each runs against the same assertions. */
const walkAways = {
  "revokes the delegate": (c) => c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]),
  "moves every token away": (c) => {
    const other = c.e.ata(c.e.wallet().publicKey, c.mint);
    c.e.ok(spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, c.amount), [c.seller]);
  },
  "moves one base unit away": (c) => {
    const other = c.e.ata(c.e.wallet().publicKey, c.mint);
    c.e.ok(spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, 1n), [c.seller]);
  },
  "lowers the delegate amount": (c) => c.e.ok(spl.createApproveInstruction(c.tokenAccount, c.listing, c.seller.publicKey, c.amount - 1n), [c.seller]),
  "replaces the delegate": (c) => c.e.ok(spl.createApproveInstruction(c.tokenAccount, c.e.wallet().publicKey, c.seller.publicKey, c.amount), [c.seller]),
  "hands the token account to a new owner": (c) => c.e.ok(spl.createSetAuthorityInstruction(c.tokenAccount, c.seller.publicKey, spl.AuthorityType.AccountOwner, c.e.wallet().publicKey), [c.seller]),
  "empties and closes the token account": (c) => {
    const other = c.e.ata(c.e.wallet().publicKey, c.mint);
    c.e.ok([
      spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, c.amount),
      spl.createCloseAccountInstruction(c.tokenAccount, c.seller.publicKey, c.seller.publicKey),
    ], [c.seller]);
    assert.equal(c.e.acct(c.tokenAccount), null);
  },
};

for (const [name, walk] of Object.entries(walkAways)) {
  test(`seller ${name}: settle fails, refund returns all SOL, listing is Gone`, () => {
    const c = setup();
    const b = c.e.wallet();
    const b0 = c.e.bal(b.publicKey);
    c.bid(b, 40n * MIN);
    const wt = c.e.ata(b.publicKey, c.mint);
    walk(c);
    c.e.warp(300);
    c.e.fails(c.settleIx(b.publicKey, wt), [], "SellerTokensUnavailable");
    assert.equal(c.e.bal(b.publicKey), b0 - 40n * MIN, "settle moved no money");
    c.e.ok(c.refundIx(b.publicKey)); // a stranger calls it
    assert.equal(c.e.bal(b.publicKey), b0, "bidder whole");
    assert.equal(c.e.bal(c.vault), 0n);
    assert.equal(c.e.listing(c.listing).state, 1, "marked Gone");
    assert.equal(c.e.listing(c.listing).topBid, 0n);
    // Gone is final. top_bidder is cleared, so settle now fails on the winner account.
    c.e.fails(c.settleIx(b.publicKey, wt), [], "ConstraintTokenOwner");
    c.e.fails(c.refundIx(b.publicKey), [], "NotLive");
  });
}

test("seller walks away before the end: refund works at once, and new bids are refused", () => {
  const c = setup();
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  c.bid(a, 10n * MIN);
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  c.e.fails(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 20n * MIN, expected: c.amount, prev: a.publicKey }), [b], "SellerTokensUnavailable");
  c.e.ok(c.refundIx(a.publicKey));
  c.e.fails(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 20n * MIN, expected: c.amount }), [b], "NotLive");
});

test("frozen seller account: settle fails, refund works, seller can still cancel a no bid listing", () => {
  const e = new Env();
  const authority = e.wallet();
  const c = setup({ env: e, mintOpts: { freezeAuthority: authority.publicKey } });
  const b = e.wallet();
  c.bid(b, 3n * MIN);
  e.ok(spl.createFreezeAccountInstruction(c.tokenAccount, c.mint, authority.publicKey), [authority]);
  e.warp(300);
  e.fails(c.settleIx(b.publicKey), [], "SellerTokensUnavailable");
  e.ok(c.refundIx(b.publicKey));
  e.ok(c.cancelIx(), [c.seller]);
  assert.equal(e.acct(c.listing), null);
});

test("refund is refused while the seller can still deliver, so a winner cannot back out", () => {
  const c = setup();
  const b = c.e.wallet();
  c.bid(b, 3n * MIN);
  c.e.fails(c.refundIx(b.publicKey), [b], "RefundNotAllowed");
  c.e.warp(300);
  c.e.fails(c.refundIx(b.publicKey), [b], "RefundNotAllowed");
  c.e.warp(Number(GRACE) - 1);
  c.e.fails(c.refundIx(b.publicKey), [b], "RefundNotAllowed");
});

test("frozen winner account past the grace period: bid can go home, nothing stuck", () => {
  const e = new Env();
  const authority = e.wallet();
  const c = setup({ env: e, mintOpts: { freezeAuthority: authority.publicKey } });
  const b = e.wallet();
  const b0 = e.bal(b.publicKey);
  c.bid(b, 3n * MIN);
  const wt = e.ata(b.publicKey, c.mint);
  e.ok(spl.createFreezeAccountInstruction(wt, c.mint, authority.publicKey), [authority]);
  e.warp(300);
  e.fails(c.settleIx(b.publicKey, wt), [], "frozen");
  e.warp(Number(GRACE));
  e.ok(c.refundIx(b.publicKey));
  assert.equal(e.bal(b.publicKey), b0);
  assert.equal(e.token(c.tokenAccount).amount, c.amount);
});

test("refund with no bids marks a broken listing Gone without needing bidder accounts", () => {
  const c = setup();
  c.e.fails(c.refundIx(), [], "RefundNotAllowed");
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  c.e.ok(c.refundIx());
  assert.equal(c.e.listing(c.listing).state, 1);
});

test("settle before end fails, at the exact end works, bids at the exact end fail", () => {
  const c = setup({ duration: 100n });
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  c.bid(a, 2n * MIN);
  const wt = c.e.ata(a.publicKey, c.mint);
  c.e.warp(99);
  c.e.fails(c.settleIx(a.publicKey, wt), [], "AuctionNotEnded");
  c.e.warp(1);
  c.e.fails(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 3n * MIN, expected: c.amount, prev: a.publicKey }), [b], "AuctionEnded");
  c.e.ok(c.settleIx(a.publicKey, wt));
});

test("settling twice fails and pays nobody twice", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.warp(300);
  const ix = c.settleIx(w.publicKey, wt);
  c.e.ok(ix);
  const s1 = c.e.bal(c.seller.publicKey);
  c.e.fails(ix, [], "AccountNotInitialized");
  assert.equal(c.e.bal(c.seller.publicKey), s1);
  assert.equal(c.e.token(wt).amount, c.amount);
});

test("settling twice inside one transaction fails as a whole", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.warp(300);
  const ix = c.settleIx(w.publicKey, wt);
  c.e.fails([ix, ix]);
  assert.equal(c.e.token(wt).amount, 0n);
  assert.equal(c.e.bal(c.vault), 2n * MIN);
});

test("settle with no bids fails", () => {
  const c = setup();
  const w = c.e.wallet();
  c.e.warp(300);
  c.e.fails(c.settleIx(w.publicKey), [], "ConstraintTokenOwner");
  const def = c.e.ata(PublicKey.default, c.mint);
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: def }), [], "NoBids");
});

test("bids: below minimum, below floor, equal to the top, lower than the top all fail", () => {
  const c = setup({ price: 5n * MIN });
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  const bid = (bidder, amount, prev) => IX.bid({ bidder: bidder.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount, expected: c.amount, prev: prev?.publicKey });
  c.e.fails(bid(a, 5n * MIN - 1n), [a], "BidBelowMinimum");
  c.e.fails(bid(a, 0n), [a], "BidBelowMinimum");
  c.e.ok(bid(a, 5n * MIN), [a]);
  c.e.fails(bid(b, 5n * MIN, a), [b], "BidNotAboveTop");
  c.e.fails(bid(b, 4n * MIN, a), [b], "BelowMinimum");
  c.e.fails(bid(b, 5n * MIN + 1n, a), [b], "RaiseTooSmall");
  c.e.ok(bid(b, 6n * MIN, a), [b]);
  assert.equal(c.e.bal(c.vault), 6n * MIN);
});

test("create: rejects floor price, zero amount, more than held, bad lengths", () => {
  const e = new Env();
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const base = { seller: seller.publicKey, tokenAccount, mint, amount: 100n, price: MIN, duration: 300n };
  const go = (o, why) => e.fails(IX.create({ ...base, ...o }), [seller], why);
  go({ price: MIN - 1n }, "PriceTooLow");
  go({ amount: 0n }, "ZeroAmount");
  go({ amount: 101n }, "InsufficientTokens");
  go({ duration: 0n }, "BadDuration");
  go({ duration: 9n }, "BadDuration");
  go({ duration: 3601n }, "BadDuration");
  go({ mode: 1, duration: 30n * 86400n + 1n }, "BadDuration");
  go({ mode: 1, duration: 5n }, "BadDuration");
  go({ pass: { signer: e.wallet().publicKey } }, "PassOnBidding");
  go({ mode: 1, duration: 0n, pass: { signer: PublicKey.default } }, "BadPassConfig");
  e.ok(IX.create(base), [seller]);
});

test("overflow: huge values are refused cleanly and nothing wraps", () => {
  const e = new Env();
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const base = { seller: seller.publicKey, tokenAccount, mint, amount: 100n, price: MIN };
  const MAX = 2n ** 64n - 1n;
  for (const duration of [MAX, 2n ** 63n, 2n ** 63n - 1n]) {
    e.fails(IX.create({ ...base, duration }), [seller], "BadDuration");
    e.fails(IX.create({ ...base, mode: 1, duration }), [seller], "BadDuration");
  }
  e.fails(IX.create({ ...base, duration: 60n, amount: MAX }), [seller], "InsufficientTokens");
  // A u64::MAX price or bid cannot wrap: the buyer simply cannot pay it.
  const c = setup({ mode: 1, duration: 0n, price: MAX });
  const b = c.e.wallet();
  c.e.fails(c.buyIx(b), [b], "insufficient lamports");
  const d = setup();
  const x = d.e.wallet();
  d.e.fails(IX.bid({ bidder: x.publicKey, listing: d.listing, tokenAccount: d.tokenAccount, mint: d.mint, amount: MAX, expected: d.amount }), [x], "insufficient lamports");
  assert.equal(d.e.listing(d.listing).topBid, 0n);
});

test("wrong mode: bid on fixed, buy on bidding, settle on fixed", () => {
  const f = setup({ mode: 1, duration: 60n });
  const b = f.e.wallet();
  f.e.fails(IX.bid({ bidder: b.publicKey, listing: f.listing, tokenAccount: f.tokenAccount, mint: f.mint, amount: 5n * MIN, expected: f.amount }), [b], "WrongMode");
  f.e.warp(61);
  const def = f.e.ata(PublicKey.default, f.mint);
  f.e.fails(IX.settle({ listing: f.listing, seller: f.seller.publicKey, tokenAccount: f.tokenAccount, mint: f.mint, winnerToken: def }), [], "WrongMode");
  const g = setup();
  const x = g.e.wallet();
  g.e.fails(g.buyIx(x), [x], "WrongMode");
});

test("fixed buy after the seller walked away fails with no SOL moved, then refund marks it Gone", () => {
  const c = setup({ mode: 1, duration: 0n });
  const b = c.e.wallet();
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  const b0 = c.e.bal(b.publicKey);
  c.e.fails(c.buyIx(b), [b], "SellerTokensUnavailable");
  assert.equal(c.e.bal(b.publicKey), b0);
  c.e.ok(c.refundIx());
  c.e.ok(c.closeIx());
  assert.equal(c.e.acct(c.listing), null);
});

test("cancel survives a closed token account and pays the bidder", () => {
  const c = setup();
  const b = c.e.wallet();
  const b0 = c.e.bal(b.publicKey);
  c.bid(b, 2n * MIN);
  const other = c.e.ata(c.e.wallet().publicKey, c.mint);
  c.e.ok([
    spl.createTransferInstruction(c.tokenAccount, other, c.seller.publicKey, c.amount),
    spl.createCloseAccountInstruction(c.tokenAccount, c.seller.publicKey, c.seller.publicKey),
  ], [c.seller]);
  c.e.ok(c.cancelIx(b.publicKey), [c.seller]);
  assert.equal(c.e.bal(b.publicKey), b0);
  assert.equal(c.e.acct(c.listing), null);
});

test("cancel survives a frozen token account and pays the bidder", () => {
  const e = new Env();
  const authority = e.wallet();
  const c = setup({ env: e, mintOpts: { freezeAuthority: authority.publicKey } });
  const b = e.wallet();
  const b0 = e.bal(b.publicKey);
  c.bid(b, 2n * MIN);
  e.ok(spl.createFreezeAccountInstruction(c.tokenAccount, c.mint, authority.publicKey), [authority]);
  e.ok(c.cancelIx(b.publicKey), [c.seller]);
  assert.equal(e.bal(b.publicKey), b0);
  assert.equal(e.acct(c.listing), null);
});

test("cancel leaves a delegate the seller set for something else", () => {
  const c = setup();
  const other = c.e.wallet().publicKey;
  c.e.ok(spl.createApproveInstruction(c.tokenAccount, other, c.seller.publicKey, 5n), [c.seller]);
  c.e.ok(c.cancelIx(), [c.seller]);
  assert.ok(c.e.token(c.tokenAccount).delegate.equals(other));
});

test("cancel after the end with a bid is refused, settle stays available", () => {
  const c = setup();
  const b = c.e.wallet();
  c.bid(b, 2n * MIN);
  c.e.warp(300);
  c.e.fails(c.cancelIx(b.publicKey), [c.seller], "AuctionEnded");
  c.e.ok(c.settleIx(b.publicKey));
});

test("close: Gone closes with rent to the seller, re-listing then works, live does not close", () => {
  const c = setup();
  const b = c.e.wallet();
  c.bid(b, 2n * MIN);
  c.e.fails(c.closeIx(), [], "CloseNotAllowed");
  c.e.warp(300);
  c.e.fails(c.closeIx(), [], "CloseNotAllowed"); // ended with a bid: must settle
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  c.e.ok(c.refundIx(b.publicKey));
  const [s0, rent] = [c.e.bal(c.seller.publicKey), c.e.bal(c.listing)];
  assert.equal(rent, c.e.rent(8 + 309), "listing rent is what the layout says");
  const stranger = c.e.wallet();
  const st0 = c.e.bal(stranger.publicKey);
  c.e.ok(c.closeIx(), [stranger]);
  assert.equal(c.e.bal(c.seller.publicKey), s0 + rent);
  assert.equal(c.e.bal(stranger.publicKey), st0);
  assert.equal(c.e.acct(c.listing), null);
  c.e.fails(c.closeIx(), [], "AccountNotInitialized");
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n, price: MIN, duration: 60n }), [c.seller]);
});

test("one live listing per token account: a second create fails", () => {
  const c = setup();
  c.e.fails(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n, price: MIN, duration: 60n }), [c.seller], "already in use");
});

// ---- bidders and sellers who cannot receive SOL ----

test("control: a small credit to a closed wallet is rejected by the runtime, so the floor is needed", () => {
  const e = new Env();
  const dead = Keypair.generate().publicKey;
  e.fails(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: dead, lamports: 1000 }), [], "InsufficientFundsForRent");
});

test("control: this runtime accepts credits to executable and under rent accounts, the credit path is a safety margin", () => {
  // If a future runtime rejects these again, the program already routes around it.
  const e = new Env();
  const dataWallet = Keypair.generate().publicKey;
  e.poke(dataWallet, { lamports: 1n, data: new Uint8Array(10_000) });
  e.ok(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: dataWallet, lamports: 1000 }));
  const program = Keypair.generate().publicKey;
  makeExecutable(e, program);
  e.ok(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: program, lamports: 1000 }));
});

test("closed wallet: a bidder who spent down to zero does not block an outbid", () => {
  const c = setup();
  const a = c.e.wallet(MIN); // the bid is every lamport they own
  const b = c.e.wallet();
  c.bid(a, MIN);
  assert.equal(c.e.acct(a.publicKey), null, "wallet no longer exists");
  c.bid(b, 2n * MIN, a);
  assert.equal(c.e.bal(a.publicKey), MIN, "refund revived it, floor is above rent exempt");
  assert.ok(MIN >= c.e.rent(0), "floor is above the rent exempt minimum");
});

test("rent exempt wallet at exactly the minimum receives normally", () => {
  const c = setup();
  const rent = c.e.rent(0);
  const a = c.e.wallet(rent + MIN);
  const b = c.e.wallet();
  c.bid(a, MIN);
  assert.equal(c.e.bal(a.publicKey), rent);
  c.bid(b, 2n * MIN, a);
  assert.equal(c.e.bal(a.publicKey), rent + MIN);
});

const unpayable = {
  "executable": (e, k) => makeExecutable(e, k),
  "below rent with data": (e, k) => e.poke(k, { lamports: 1n, data: new Uint8Array(100_000) }),
};

for (const [kind, spoil] of Object.entries(unpayable)) {
  test(`bidder becomes ${kind}: outbid still works, refund parks in a credit they can claim`, () => {
    const c = setup();
    const a = c.e.wallet(5n * MIN);
    const b = c.e.wallet();
    c.bid(a, 3n * MIN);
    spoil(c.e, a.publicKey);
    const before = c.e.bal(a.publicKey);
    c.bid(b, 4n * MIN, a);
    assert.equal(c.e.listing(c.listing).topBid, 4n * MIN, "auction moved on");
    assert.equal(c.e.bal(a.publicKey), before);
    const credit = creditPda(c.listing, a.publicKey);
    assert.equal(c.e.bal(credit), 3n * MIN);
    assert.equal(c.e.bal(c.vault), 4n * MIN);
    // A stranger cannot take it, the bidder can, even after the listing is gone.
    const thief = c.e.wallet();
    c.e.fails(IX.claimCredit({ owner: thief.publicKey, listing: c.listing, destination: thief.publicKey, credit }), [thief], "ConstraintSeeds");
    c.e.warp(300);
    c.e.ok(c.settleIx(b.publicKey));
    const dest = c.e.wallet(0n).publicKey;
    c.e.ok(IX.claimCredit({ owner: a.publicKey, listing: c.listing, destination: dest }), [a]);
    assert.equal(c.e.bal(dest), 3n * MIN);
    assert.equal(c.e.bal(credit), 0n);
    c.e.fails(IX.claimCredit({ owner: a.publicKey, listing: c.listing, destination: dest }), [a], "NothingToClaim");
  });

  test(`top bidder becomes ${kind}: refund and cancel still complete`, () => {
    const c = setup();
    const a = c.e.wallet(5n * MIN);
    c.bid(a, 3n * MIN);
    spoil(c.e, a.publicKey);
    c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
    c.e.ok(c.refundIx(a.publicKey));
    assert.equal(c.e.bal(creditPda(c.listing, a.publicKey)), 3n * MIN);

    const d = setup();
    const x = d.e.wallet(5n * MIN);
    d.bid(x, 3n * MIN);
    spoil(d.e, x.publicKey);
    d.e.ok(d.cancelIx(x.publicKey), [d.seller]);
    assert.equal(d.e.bal(creditPda(d.listing, x.publicKey)), 3n * MIN);
  });

  test(`seller becomes ${kind}: settle and fixed buy still complete, SOL and rent in credit`, () => {
    const c = setup();
    const w = c.e.wallet();
    c.bid(w, 3n * MIN);
    const rent = c.e.bal(c.listing);
    spoil(c.e, c.seller.publicKey);
    const wt = c.e.ata(w.publicKey, c.mint);
    c.e.warp(300);
    c.e.ok(c.settleIx(w.publicKey, wt));
    assert.equal(c.e.token(wt).amount, c.amount);
    assert.equal(c.e.bal(creditPda(c.listing, c.seller.publicKey)), 3n * MIN + rent);

    const f = setup({ mode: 1, duration: 0n, price: 2n * MIN });
    const b = f.e.wallet();
    const frent = f.e.bal(f.listing);
    spoil(f.e, f.seller.publicKey);
    f.e.ok(f.buyIx(b), [b]);
    assert.equal(f.e.bal(creditPda(f.listing, f.seller.publicKey)), 2n * MIN + frent);
  });
}

test("seller with a closed wallet: settle and rent revive it", () => {
  const e = new Env();
  const c = setup({ env: e });
  const w = e.wallet();
  c.bid(w, MIN);
  e.ok(SystemProgram.transfer({ fromPubkey: c.seller.publicKey, toPubkey: e.payer.publicKey, lamports: e.bal(c.seller.publicKey) }), [c.seller]);
  assert.equal(e.acct(c.seller.publicKey), null);
  const rent = e.bal(c.listing);
  e.warp(300);
  e.ok(c.settleIx(w.publicKey));
  assert.equal(e.bal(c.seller.publicKey), MIN + rent);
});
