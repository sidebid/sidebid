import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, setup, creditPda, TOKEN, spl } from "./helpers.mjs";

const SOL1 = 1_000_000_000n;

test("create: exact delegate to the listing PDA, tokens stay with the seller", () => {
  const c = setup({ amount: 400n * UNIT, held: 1000n * UNIT });
  const t = c.e.token(c.tokenAccount);
  assert.equal(t.amount, 1000n * UNIT);
  assert.equal(t.delegatedAmount, 400n * UNIT);
  assert.ok(t.delegate.equals(c.listing));
  const l = c.e.listing(c.listing);
  assert.equal(l.amount, 400n * UNIT);
  assert.equal(l.state, 0);
  assert.equal(c.e.bal(c.vault), 0n);
});

test("bidding: outbid refund lands in the same transaction, vault only holds the top bid", () => {
  const c = setup();
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  const [a0, b0] = [c.e.bal(a.publicKey), c.e.bal(b.publicKey)];
  c.bid(a, 10n * MIN);
  assert.equal(c.e.bal(c.vault), 10n * MIN);
  assert.equal(c.e.bal(a.publicKey), a0 - 10n * MIN);
  c.bid(b, 25n * MIN, a);
  assert.equal(c.e.bal(a.publicKey), a0, "outbid bidder repaid in full");
  assert.equal(c.e.bal(b.publicKey), b0 - 25n * MIN);
  assert.equal(c.e.bal(c.vault), 25n * MIN);
  const l = c.e.listing(c.listing);
  assert.ok(l.topBidder.equals(b.publicKey));
  assert.equal(l.topBid, 25n * MIN);
});

test("a bidder can raise their own bid paying only the difference", () => {
  const c = setup();
  const a = c.e.wallet(21n * MIN);
  c.bid(a, 10n * MIN);
  c.bid(a, 20n * MIN, a);
  assert.equal(c.e.bal(a.publicKey), MIN);
  assert.equal(c.e.bal(c.vault), 20n * MIN);
});

test("settle after end: tokens to winner, SOL and rent to seller, anyone can call", () => {
  const c = setup({ amount: 400n * UNIT, held: 1000n * UNIT });
  const w = c.e.wallet();
  c.bid(w, SOL1);
  const seller0 = c.e.bal(c.seller.publicKey);
  const rent = c.e.bal(c.listing);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.warp(300);
  c.e.ok(c.settleIx(w.publicKey, wt)); // harness payer is the only signer: a stranger
  assert.equal(c.e.token(wt).amount, 400n * UNIT);
  assert.equal(c.e.token(c.tokenAccount).amount, 600n * UNIT);
  assert.equal(c.e.token(c.tokenAccount).delegatedAmount, 0n);
  assert.equal(c.e.bal(c.seller.publicKey), seller0 + SOL1 + rent);
  assert.equal(c.e.bal(c.vault), 0n);
  assert.equal(c.e.acct(c.listing), null, "listing closed");
});

test("fixed buy: buyer is the only signer, one transaction, listing closed", () => {
  const c = setup({ mode: 1, price: 50n * MIN, duration: 0n });
  const buyer = c.e.wallet();
  const bt = c.e.ata(buyer.publicKey, c.mint);
  const [s0, b0, rent] = [c.e.bal(c.seller.publicKey), c.e.bal(buyer.publicKey), c.e.bal(c.listing)];
  const r = c.e.send(c.buyIx(buyer, bt), [buyer], { payer: buyer });
  assert.ok(r.ok, r.err);
  assert.equal(c.e.token(bt).amount, c.amount);
  assert.equal(c.e.bal(c.seller.publicKey), s0 + 50n * MIN + rent);
  assert.equal(c.e.bal(buyer.publicKey), b0 - 50n * MIN - 5000n, "buyer paid price and one signature fee");
  assert.equal(c.e.acct(c.listing), null);
});

test("fixed buy: first buyer takes it, the second fails with no money moved", () => {
  const c = setup({ mode: 1, price: 2n * MIN, duration: 0n });
  const [x, y] = [c.e.wallet(), c.e.wallet()];
  c.e.ok(c.buyIx(x), [x]);
  const y0 = c.e.bal(y.publicKey);
  c.e.fails(c.buyIx(y), [y], "AccountNotInitialized");
  assert.equal(c.e.bal(y.publicKey), y0);
});

test("fixed buy with an expiry works before it and fails after it", () => {
  const c = setup({ mode: 1, duration: 60n });
  const b = c.e.wallet();
  c.e.warp(60);
  c.e.fails(c.buyIx(b), [b], "ListingExpired");
  const d = setup({ mode: 1, duration: 60n });
  const b2 = d.e.wallet();
  d.e.warp(59);
  d.e.ok(d.buyIx(b2), [b2]);
});

test("cancel by seller before end: bidder repaid, delegate removed, rent back", () => {
  const c = setup();
  const a = c.e.wallet();
  const a0 = c.e.bal(a.publicKey);
  c.bid(a, 10n * MIN);
  const [s0, rent] = [c.e.bal(c.seller.publicKey), c.e.bal(c.listing)];
  c.e.ok(c.cancelIx(a.publicKey), [c.seller]);
  assert.equal(c.e.bal(a.publicKey), a0);
  assert.equal(c.e.bal(c.vault), 0n);
  assert.equal(c.e.bal(c.seller.publicKey), s0 + rent);
  const t = c.e.token(c.tokenAccount);
  assert.equal(t.delegate, null);
  assert.equal(t.amount, c.amount);
  assert.equal(c.e.acct(c.listing), null);
});

test("cancel with no bids, and the seller can list again straight after", () => {
  const c = setup();
  c.e.ok(c.cancelIx(), [c.seller]);
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 7n, price: MIN, duration: 60n }), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegatedAmount, 7n);
});

test("anti snipe: a bid in the last 15 seconds adds 15, a bid before that does not", () => {
  const c = setup({ duration: 100n });
  const [a, b, d] = [c.e.wallet(), c.e.wallet(), c.e.wallet()];
  const end0 = c.e.listing(c.listing).endTime;
  c.e.warp(84); // 16 s left
  c.bid(a, 2n * MIN);
  assert.equal(c.e.listing(c.listing).endTime, end0);
  c.e.warp(1); // exactly 15 s left
  c.bid(b, 3n * MIN, a);
  assert.equal(c.e.listing(c.listing).endTime, end0 + 15n);
  c.e.warp(29); // 1 s left of the extended time
  c.bid(d, 4n * MIN, b);
  assert.equal(c.e.listing(c.listing).endTime, end0 + 30n);
  c.e.warp(16); // the extension is real: old end has long passed, still 0 to settle
  const wt = c.e.ata(d.publicKey, c.mint);
  c.e.ok(c.settleIx(d.publicKey, wt));
  assert.equal(c.e.token(wt).amount, c.amount);
});

test("expired listing with no bids and the delegate gone: anyone can close it, rent goes to the seller", () => {
  const c = setup({ duration: 60n });
  c.e.fails(c.closeIx(), [], "CloseNotAllowed");
  c.e.warp(60);
  c.e.fails(c.closeIx(), [], "DelegateStillSet");
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  const [s0, rent] = [c.e.bal(c.seller.publicKey), c.e.bal(c.listing)];
  c.e.ok(c.closeIx());
  assert.equal(c.e.bal(c.seller.publicKey), s0 + rent);
  assert.equal(c.e.acct(c.listing), null);
  assert.equal(c.e.token(c.tokenAccount).amount, c.amount, "tokens never left");
});

test("cancel after the end with no bids still removes the delegate", () => {
  const c = setup({ duration: 60n });
  c.e.warp(61);
  c.e.ok(c.cancelIx(), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegate, null);
});

test("two listings from two token accounts of one seller stay independent", () => {
  const e = new Env();
  const a = setup({ env: e, mode: 1, duration: 0n, price: 2n * MIN });
  const b = setup({ env: e, mode: 1, duration: 0n, price: 3n * MIN });
  const buyer = e.wallet();
  e.ok(a.buyIx(buyer), [buyer]);
  assert.ok(e.acct(b.listing));
  assert.equal(e.token(b.tokenAccount).delegatedAmount, b.amount);
});
