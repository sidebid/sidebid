// Regression tests for past findings. Each is built from its proof.
import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, SERVER, WINDOW, setup, setupAccept, listingPda, acceptPda, spl, Keypair, SystemProgram, PublicKey, TOKEN } from "./helpers.mjs";

const SOL = 1_000_000_000n;

/** A keypair token account, the kind that can be closed and recreated for another mint. */
function keypairAccount(e, k, mint, owner) {
  const space = spl.getAccountLen([]);
  return [
    SystemProgram.createAccount({ fromPubkey: e.payer.publicKey, newAccountPubkey: k.publicKey, lamports: Number(e.rent(space)), space, programId: TOKEN }),
    spl.createInitializeAccount3Instruction(k.publicKey, mint, owner, TOKEN),
  ];
}

test("H1: the proof's first step is gone: a keypair token account cannot be listed", () => {
  const e = new Env();
  const seller = e.wallet();
  const mint = e.mint();
  const k = Keypair.generate();
  e.ok(keypairAccount(e, k, mint, seller.publicKey), [k]);
  e.mintTo(mint, k.publicKey, 1000n);
  e.fails(IX.create({ seller: seller.publicKey, tokenAccount: k.publicKey, mint, amount: 1000n, price: MIN, duration: 300n }), [seller], "ConstraintAssociated");
  // Nor as a tagged card.
  e.svm.airdrop(SERVER.publicKey.toBase58(), SOL);
  e.fails(IX.createAccept({ server: SERVER.publicKey, id: Keypair.generate().publicKey.toBuffer(), seller: seller.publicKey, tokenAccount: k.publicKey, mint, amount: 1000n }), [SERVER], "ConstraintAssociated");
  // An associated account of the wrong wallet or mint is refused too.
  const other = e.wallet();
  const otherAta = e.ata(other.publicKey, mint, 1000n);
  e.fails(IX.create({ seller: seller.publicKey, tokenAccount: otherAta, mint, amount: 1000n, price: MIN, duration: 300n }), [seller]);
});

test("H1: the swap from the proof: an in flight bid cannot land on another coin", () => {
  const e = new Env();
  const seller = e.wallet();
  const [good, scam] = [e.mint(), e.mint()];
  const ataGood = e.ata(seller.publicKey, good, 1000n * UNIT);
  e.ok(IX.create({ seller: seller.publicKey, tokenAccount: ataGood, mint: good, amount: 1000n * UNIT, price: 500n * MIN, duration: 300n }), [seller]);
  const listing = listingPda(ataGood);
  const victim = e.wallet(10n * SOL);
  const signedBid = IX.bid({ bidder: victim.publicKey, listing, tokenAccount: ataGood, mint: good, amount: 5n * SOL, expected: 1000n * UNIT });
  // Seller's flip, the proof's step 3: cancel, empty, close, recreate with the other mint.
  const sink = e.ata(e.wallet().publicKey, good);
  e.ok([
    IX.cancel({ seller: seller.publicKey, listing, tokenAccount: ataGood }),
    spl.createTransferInstruction(ataGood, sink, seller.publicKey, 1000n * UNIT),
    spl.createCloseAccountInstruction(ataGood, seller.publicKey, seller.publicKey),
  ], [seller]);
  const ataScam = e.ata(seller.publicKey, scam, 1000n * UNIT);
  assert.ok(!ataGood.equals(ataScam), "the address fixes the mint, so the listing cannot return at the same place");
  e.ok(IX.create({ seller: seller.publicKey, tokenAccount: ataScam, mint: scam, amount: 1000n * UNIT, price: MIN, duration: 10n }), [seller]);
  const v0 = e.bal(victim.publicKey);
  e.fails(signedBid, [victim], "AccountNotInitialized");
  assert.equal(e.bal(victim.publicKey), v0, "victim's SOL did not move");
  assert.equal(e.bal(listingPda(ataScam)) > 0n, true);
});

test("H1: expected_mint on its own refuses a bid signed for another mint", () => {
  const c = setup();
  const b = c.e.wallet();
  const other = c.e.mint();
  c.e.fails(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: other, amount: 5n * MIN, expected: c.amount }), [b], "ListingChanged");
  c.e.ok(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: c.amount }), [b]);
});

test("M1: hard_end_time is the original end plus 300, and extensions stop there", () => {
  const c = setup({ duration: 100n });
  const l0 = c.e.listing(c.listing);
  assert.equal(l0.hardEnd, l0.endTime + 300n);
  // The proof's attack: two wallets trading the lead every 14 seconds.
  const [a, b] = [c.e.wallet(100n * SOL), c.e.wallet(100n * SOL)];
  c.e.warp(90);
  let price = 2n * MIN, prev = null, cur = a, bids = 0;
  for (;;) {
    const r = c.e.send(IX.bid({ bidder: cur.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: price, expected: c.amount, prev: prev?.publicKey }), [cur]);
    if (!r.ok) { assert.match(r.logs.join("\n"), /AuctionEnded/); break; }
    bids++;
    assert.ok(c.e.listing(c.listing).endTime <= l0.hardEnd, "never past the hard end");
    [prev, cur] = [cur, cur === a ? b : a];
    price = price + price / 50n + MIN;
    c.e.warp(14);
    assert.ok(bids < 60, "the auction must end");
  }
  const end = c.e.listing(c.listing).endTime;
  assert.equal(end, l0.hardEnd, "ran to the cap and stopped");
  assert.ok(c.e.now() >= end);
  c.e.ok(c.settleIx(prev.publicKey));
});

test("M1: a bid right at the hard end leaves the end where it is, one second later bids stop", () => {
  const c = setup({ duration: 10n });
  const hard = c.e.listing(c.listing).hardEnd;
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  let prev = null, cur = a, price = 2n * MIN;
  while (c.e.listing(c.listing).endTime < hard) {
    const left = c.e.listing(c.listing).endTime - c.e.now();
    c.e.warp(left - 1n);
    c.bid(cur, price, prev);
    [prev, cur] = [cur, cur === a ? b : a];
    price += 2n * MIN;
  }
  assert.equal(c.e.listing(c.listing).endTime, hard);
  c.e.warp(hard - c.e.now() - 1n); // last valid second
  c.bid(cur, price, prev);
  assert.equal(c.e.listing(c.listing).endTime, hard, "no room left to extend");
  [prev, cur] = [cur, cur === a ? b : a];
  price += 2n * MIN;
  c.e.warp(1);
  c.e.fails(IX.bid({ bidder: cur.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: price, expected: c.amount, prev: prev.publicKey }), [cur], "AuctionEnded");
});

test("M1: accept mode cards store the same hard end", () => {
  const c = setupAccept({ duration: 10n });
  const l0 = c.e.listing(c.listing);
  assert.equal(l0.hardEnd, l0.endTime + 300n);
});

test("M1: minimum raise is the larger of 2% and 0.001 SOL, exact at both boundaries", () => {
  // Small bids: 0.001 SOL wins.
  const c = setup();
  const [a, b] = [c.e.wallet(100n * SOL), c.e.wallet(100n * SOL)];
  c.bid(a, 10n * MIN);
  const bid = (who, amount, prev) => IX.bid({ bidder: who.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount, expected: c.amount, prev: prev.publicKey });
  c.e.fails(bid(b, 11n * MIN - 1n, a), [b], "RaiseTooSmall");
  c.e.ok(bid(b, 11n * MIN, a), [b]);
  // Large bids: 2% wins. 1 SOL needs 1.02 SOL.
  const d = setup();
  const [x, y] = [d.e.wallet(100n * SOL), d.e.wallet(100n * SOL)];
  d.bid(x, SOL);
  const dbid = (amount) => IX.bid({ bidder: y.publicKey, listing: d.listing, tokenAccount: d.tokenAccount, mint: d.mint, amount, expected: d.amount, prev: x.publicKey });
  d.e.fails(dbid(SOL + SOL / 50n - 1n), [y], "RaiseTooSmall");
  d.e.ok(dbid(SOL + SOL / 50n), [y]);
  // 2% rounds up, so an odd top bid cannot shave a lamport.
  const f = setup();
  const [p, q] = [f.e.wallet(100n * SOL), f.e.wallet(100n * SOL)];
  f.bid(p, SOL + 1n);
  const fbid = (amount) => IX.bid({ bidder: q.publicKey, listing: f.listing, tokenAccount: f.tokenAccount, mint: f.mint, amount, expected: f.amount, prev: p.publicKey });
  f.e.fails(fbid(SOL + 1n + SOL / 50n), [q], "RaiseTooSmall");
  f.e.ok(fbid(SOL + 1n + SOL / 50n + 1n), [q]);
});

test("M1: the raise also binds a bidder raising themselves, and cannot overflow", () => {
  const c = setup();
  const a = c.e.wallet(10n * SOL);
  c.bid(a, 5n * MIN);
  c.e.fails(IX.bid({ bidder: a.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN + 1n, expected: c.amount, prev: a.publicKey }), [a], "RaiseTooSmall");
  const d = setup();
  const x = d.e.wallet();
  d.e.fails(IX.bid({ bidder: x.publicKey, listing: d.listing, tokenAccount: d.tokenAccount, mint: d.mint, amount: 2n ** 64n - 1n, expected: d.amount }), [x], "insufficient lamports");
});

test("M2: the proof's relist: a bid signed for a 5 minute auction cannot land on a longer one", () => {
  const c = setup({ amount: 1000n, duration: 300n });
  const hard = c.e.listing(c.listing).hardEnd;
  const b = c.e.wallet();
  const signed = IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: 1000n, maxEnd: hard });
  c.e.ok(c.cancelIx(), [c.seller]);
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1000n, price: MIN, duration: 3600n }), [c.seller]);
  const b0 = c.e.bal(b.publicKey);
  c.e.fails(signed, [b], "ListingChanged");
  assert.equal(c.e.bal(b.publicKey), b0);
});

test("M2: max_end_time equal to hard_end_time passes, one second less fails, also mid auction", () => {
  const c = setup({ duration: 300n });
  const hard = c.e.listing(c.listing).hardEnd;
  const [a, b] = [c.e.wallet(), c.e.wallet()];
  const bid = (who, amount, maxEnd, prev) => IX.bid({ bidder: who.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount, expected: c.amount, maxEnd, prev: prev?.publicKey });
  c.e.fails(bid(a, 2n * MIN, hard - 1n), [a], "ListingChanged");
  c.e.ok(bid(a, 2n * MIN, hard), [a]);
  c.e.warp(290); // an extension moves end_time, hard_end_time is unchanged
  c.e.ok(bid(b, 4n * MIN, hard, a), [b]);
  assert.equal(c.e.listing(c.listing).hardEnd, hard);
});

test("M2: listing lengths are capped: the 30 day relist cannot be created at all", () => {
  const e = new Env();
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const base = { seller: seller.publicKey, tokenAccount, mint, amount: 100n, price: MIN };
  e.fails(IX.create({ ...base, duration: 30n * 86400n }), [seller], "BadDuration");
  e.fails(IX.create({ ...base, duration: 3601n }), [seller], "BadDuration");
  e.ok(IX.create({ ...base, duration: 3600n }), [seller]);
});

test("M2/L2: the 31 day server key lock from the proof cannot be created, worst case is about 2 hours", () => {
  const e = new Env();
  e.svm.airdrop(SERVER.publicKey.toBase58(), SOL);
  const seller = e.wallet();
  const mint = e.mint();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n);
  const base = { server: SERVER.publicKey, seller: seller.publicKey, tokenAccount, mint, amount: 100n };
  const id = () => Keypair.generate().publicKey.toBuffer();
  e.fails(IX.createAccept({ ...base, id: id(), duration: 30n * 86400n, window: 86400n }), [SERVER], "BadDuration");
  e.fails(IX.createAccept({ ...base, id: id(), duration: 3600n, window: 86400n }), [SERVER], "BadDuration");
  e.fails(IX.createAccept({ ...base, id: id(), duration: 3601n, window: 3600n }), [SERVER], "BadDuration");
  // The longest card the key can make, and the longest a bidder can be held.
  const worst = id();
  e.ok(IX.createAccept({ ...base, id: worst, duration: 3600n, window: 3600n }), [SERVER]);
  const listing = acceptPda(worst);
  const w = e.wallet();
  const w0 = e.bal(w.publicKey);
  e.ok(IX.bid({ bidder: w.publicKey, listing, tokenAccount, mint, amount: 2n * MIN, expected: 100n }), [w]);
  e.warp(3600 + 300 + 3600);
  e.ok(IX.refund({ listing, tokenAccount, topBidder: w.publicKey }));
  assert.equal(e.bal(w.publicKey), w0);
});

test("L3: a stranger can no longer close over a live delegate, the seller's cancel removes it", () => {
  const c = setup({ duration: 60n, amount: 1000n });
  c.e.warp(61);
  const stranger = c.e.wallet();
  c.e.fails(c.closeIx(), [stranger], "DelegateStillSet");
  assert.ok(c.e.token(c.tokenAccount).delegate.equals(c.listing));
  c.e.ok(c.cancelIx(), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegate, null);
  assert.equal(c.e.acct(c.listing), null);
});

test("L3: a Gone listing keeping its delegate also waits for the seller", () => {
  const c = setup({ amount: 100n });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const o = c.e.ata(c.e.wallet().publicKey, c.mint);
  c.e.ok(spl.createTransferInstruction(c.tokenAccount, o, c.seller.publicKey, 1n), [c.seller]);
  c.e.ok(c.refundIx(w.publicKey));
  c.e.fails(c.closeIx(), [], "DelegateStillSet");
  c.e.ok(c.cancelIx(), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegate, null);
});

test("L3: closing still works when no delegate is left: closed token account, moved owner", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const o = c.e.ata(c.e.wallet().publicKey, c.mint);
  c.e.ok([
    spl.createTransferInstruction(c.tokenAccount, o, c.seller.publicKey, c.amount),
    spl.createCloseAccountInstruction(c.tokenAccount, c.seller.publicKey, c.seller.publicKey),
  ], [c.seller]);
  c.e.ok(c.refundIx(w.publicKey));
  c.e.ok(c.closeIx());
  assert.equal(c.e.acct(c.listing), null);
});

test("L3: in accept mode a seller approving the listing by hand cannot hold the server's rent", () => {
  const c = setupAccept();
  c.e.ok(spl.createApproveInstruction(c.tokenAccount, c.listing, c.seller.publicKey, 1n), [c.seller]);
  c.e.warp(300);
  c.e.ok(c.closeIx());
  assert.equal(c.e.acct(c.listing), null);
});

test("L1 is by design and still true: seller walking after the end refunds the bidder in full", () => {
  const c = setup();
  const w = c.e.wallet();
  const w0 = c.e.bal(w.publicKey);
  c.bid(w, 2n * MIN);
  c.e.warp(301);
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  c.e.fails(c.settleIx(w.publicKey), [], "SellerTokensUnavailable");
  c.e.ok(c.refundIx(w.publicKey));
  assert.equal(c.e.bal(w.publicKey), w0);
});
