import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, makeExecutable, PROGRAM_ID, TOKEN, T22, setup, creditPda, vaultPda, listingPda, spl, Keypair, PublicKey, SystemProgram, NONE, TransactionInstruction, IDL_PATH } from "./helpers.mjs";

const BPF = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const unpayable = (e, k) => makeExecutable(e, k);

// ---- stealing bid SOL ----

test("attack: settle pays only the stored seller", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 5n * MIN);
  c.e.warp(300);
  const thief = c.e.wallet();
  c.e.fails(IX.settle({ listing: c.listing, seller: thief.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: c.e.ata(w.publicKey, c.mint) }), [thief], "ConstraintAddress");
  assert.equal(c.e.bal(c.vault), 5n * MIN);
});

test("attack: credit routed to an attacker's address is refused when the seller is unpayable", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 5n * MIN);
  unpayable(c.e, c.seller.publicKey);
  c.e.warp(300);
  const thief = c.e.wallet();
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: wt, sellerCredit: thief.publicKey }), [], "BadCreditAccount");
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: wt, sellerCredit: creditPda(c.listing, thief.publicKey) }), [], "BadCreditAccount");
  assert.equal(c.e.bal(c.vault), 5n * MIN);
});

test("attack: outbid refund cannot be redirected, whatever the attacker passes", () => {
  const c = setup();
  const [a, thief] = [c.e.wallet(), c.e.wallet()];
  c.bid(a, 5n * MIN);
  const go = (o) => IX.bid({ bidder: thief.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 6n * MIN, expected: c.amount, ...o });
  c.e.fails(go({ prev: thief.publicKey }), [thief], "MissingPrevBidder");
  c.e.fails(go({}), [thief], "MissingPrevBidder"); // no previous bidder passed at all
  // Unpayable bidder: the credit address is enforced.
  unpayable(c.e, a.publicKey);
  c.e.fails(go({ prev: a.publicKey, prevCredit: thief.publicKey }), [thief], "BadCreditAccount");
  c.e.fails(go({ prev: a.publicKey, prevCredit: creditPda(c.listing, thief.publicKey) }), [thief], "BadCreditAccount");
  assert.equal(c.e.bal(c.vault), 5n * MIN);
});

test("attack: refund pays only the stored top bidder", () => {
  const c = setup();
  const [a, thief] = [c.e.wallet(), c.e.wallet()];
  c.bid(a, 5n * MIN);
  c.e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey), [c.seller]);
  c.e.fails(c.refundIx(thief.publicKey), [thief], "MissingPrevBidder");
  c.e.fails(c.refundIx(), [thief], "MissingPrevBidder");
  assert.equal(c.e.bal(c.vault), 5n * MIN);
});

test("attack: another listing's vault cannot be used", () => {
  const e = new Env();
  const [a, b] = [setup({ env: e }), setup({ env: e })];
  const w = e.wallet();
  b.bid(w, 9n * MIN);
  const x = e.wallet();
  a.bid(x, 2n * MIN);
  e.warp(300);
  e.fails(IX.settle({ listing: a.listing, vault: b.vault, seller: a.seller.publicKey, tokenAccount: a.tokenAccount, mint: a.mint, winnerToken: e.ata(x.publicKey, a.mint) }), [], "ConstraintSeeds");
  assert.equal(e.bal(b.vault), 9n * MIN);
});

test("attack: credits belong to their owner only", () => {
  const c = setup();
  const a = c.e.wallet(5n * MIN);
  const b = c.e.wallet();
  c.bid(a, 3n * MIN);
  unpayable(c.e, a.publicKey);
  c.bid(b, 4n * MIN, a);
  const credit = creditPda(c.listing, a.publicKey);
  c.e.fails(IX.claimCredit({ owner: b.publicKey, listing: c.listing, destination: b.publicKey, credit }), [b], "ConstraintSeeds");
  // Naming the owner without their signature.
  const ix = IX.claimCredit({ owner: a.publicKey, listing: c.listing, destination: b.publicKey });
  ix.keys[0].isSigner = false;
  c.e.fails(ix, []);
  assert.equal(c.e.bal(credit), 3n * MIN);
});

test("attack: a forged Listing owned by another program is refused", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 5n * MIN);
  const fake = Keypair.generate().publicKey;
  // Same bytes as the real listing, attacker named as seller, wrong owner.
  const data = Uint8Array.from(c.e.acct(c.listing).data);
  const thief = c.e.wallet();
  data.set(thief.publicKey.toBytes(), 8);
  c.e.poke(fake, { lamports: 5_000_000n, data, owner: thief.publicKey });
  c.e.warp(300);
  c.e.fails(IX.settle({ listing: fake, vault: c.vault, seller: thief.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: c.e.ata(w.publicKey, c.mint) }), [], "AccountOwnedByWrongProgram");
});

test("attack: a plain wallet account is not a listing", () => {
  const c = setup({ mode: 1, duration: 0n });
  const b = c.e.wallet();
  c.e.fails(IX.close({ listing: b.publicKey, tokenAccount: c.tokenAccount, seller: c.seller.publicKey }), []);
});

test("attack: donations to the vault break nothing and cannot strand anyone", () => {
  // Small donation during a live auction: a leftover below rent would fail settle if not swept.
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 5n * MIN);
  c.e.ok(SystemProgram.transfer({ fromPubkey: c.e.payer.publicKey, toPubkey: c.vault, lamports: 1 }));
  const b = c.e.wallet();
  c.bid(b, 6n * MIN, w);
  assert.equal(c.e.bal(c.vault), 6n * MIN + 1n, "outbid refund is the exact bid, not the vault balance");
  c.e.warp(300);
  const s0 = c.e.bal(c.seller.publicKey);
  const rent = c.e.bal(c.listing);
  c.e.ok(c.settleIx(b.publicKey));
  assert.equal(c.e.bal(c.vault), 0n);
  assert.equal(c.e.bal(c.seller.publicKey), s0 + rent + 6n * MIN + 1n);

  const d = setup();
  const x = d.e.wallet();
  d.bid(x, 5n * MIN);
  d.e.ok(SystemProgram.transfer({ fromPubkey: d.e.payer.publicKey, toPubkey: d.vault, lamports: 1 }));
  d.e.ok(spl.createRevokeInstruction(d.tokenAccount, d.seller.publicKey), [d.seller]);
  d.e.ok(d.refundIx(x.publicKey));
  assert.equal(d.e.bal(d.vault), 0n);

  const f = setup();
  const y = f.e.wallet();
  f.bid(y, 5n * MIN);
  f.e.ok(SystemProgram.transfer({ fromPubkey: f.e.payer.publicKey, toPubkey: f.vault, lamports: 1 }));
  f.e.ok(f.cancelIx(y.publicKey), [f.seller]);
  assert.equal(f.e.bal(f.vault), 0n);

  // Donation with no bids: swept to the seller on cancel and on close.
  const g = setup();
  const rent0 = g.e.rent(0);
  g.e.ok(SystemProgram.transfer({ fromPubkey: g.e.payer.publicKey, toPubkey: g.vault, lamports: Number(rent0) }));
  g.e.ok(g.cancelIx(), [g.seller]);
  assert.equal(g.e.bal(g.vault), 0n);
  const h = setup({ duration: 60n });
  h.e.ok(SystemProgram.transfer({ fromPubkey: h.e.payer.publicKey, toPubkey: h.vault, lamports: Number(rent0) }));
  h.e.warp(60);
  h.e.ok(spl.createRevokeInstruction(h.tokenAccount, h.seller.publicKey), [h.seller]);
  h.e.ok(h.closeIx());
  assert.equal(h.e.bal(h.vault), 0n);
});

test("attack: pre-funding a credit address changes nothing", () => {
  const c = setup();
  const a = c.e.wallet(5n * MIN);
  const b = c.e.wallet();
  c.bid(a, 3n * MIN);
  unpayable(c.e, a.publicKey);
  const credit = creditPda(c.listing, a.publicKey);
  c.e.ok(SystemProgram.transfer({ fromPubkey: c.e.payer.publicKey, toPubkey: credit, lamports: Number(c.e.rent(0)) }));
  c.bid(b, 4n * MIN, a);
  assert.equal(c.e.bal(credit), 3n * MIN + c.e.rent(0));
});

test("attack: seller cancels with a bid only by repaying it", () => {
  const c = setup();
  const a = c.e.wallet();
  c.bid(a, 3n * MIN);
  c.e.fails(c.cancelIx(), [c.seller], "MissingPrevBidder");
  c.e.fails(c.cancelIx(c.seller.publicKey), [c.seller], "MissingPrevBidder");
  assert.equal(c.e.bal(c.vault), 3n * MIN);
});

test("attack: stranger cannot cancel or close someone else's listing for profit", () => {
  const c = setup();
  const thief = c.e.wallet();
  c.e.fails(IX.cancel({ seller: thief.publicKey, listing: c.listing, tokenAccount: c.tokenAccount }), [thief], "ConstraintAddress");
  c.e.warp(300);
  c.e.fails(IX.close({ listing: c.listing, tokenAccount: c.tokenAccount, seller: thief.publicKey }), [thief], "ConstraintAddress");
});

test("attack: unsigned seller on cancel", () => {
  const c = setup();
  const ix = c.cancelIx();
  ix.keys[0].isSigner = false;
  c.e.fails(ix, []);
  assert.ok(c.e.acct(c.listing));
});

test("attack: bidder must sign and really pay", () => {
  const c = setup();
  const a = c.e.wallet(0n);
  const ix = IX.bid({ bidder: a.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: c.amount });
  c.e.fails(ix, [a], "insufficient lamports");
  const v = c.e.wallet();
  const unsigned = IX.bid({ bidder: v.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: c.amount });
  unsigned.keys[0].isSigner = false;
  c.e.fails(unsigned, []);
});

// ---- stealing a seller's tokens ----

test("attack: nobody can list a token account they do not own", () => {
  const e = new Env();
  const victim = e.wallet();
  const mint = e.mint();
  const victimToken = e.ata(victim.publicKey, mint, 1000n);
  const thief = e.wallet();
  e.fails(IX.create({ seller: thief.publicKey, tokenAccount: victimToken, mint, amount: 1000n, price: MIN, duration: 60n }), [thief], "ConstraintTokenOwner");
  // Naming the victim without their signature fails.
  const ix = IX.create({ seller: victim.publicKey, tokenAccount: victimToken, mint, amount: 1000n, price: MIN, duration: 60n });
  ix.keys[0].isSigner = false;
  e.fails(ix, []);
  assert.equal(e.token(victimToken).delegate, null);
});

test("attack: delegate only ever moves the listing's amount, even if the seller over-approved", () => {
  const c = setup({ amount: 100n * UNIT, held: 1000n * UNIT });
  c.e.ok(spl.createApproveInstruction(c.tokenAccount, c.listing, c.seller.publicKey, 1000n * UNIT), [c.seller]);
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.ok(c.settleIx(w.publicKey, wt));
  assert.equal(c.e.token(wt).amount, 100n * UNIT);
  assert.equal(c.e.token(c.tokenAccount).amount, 900n * UNIT);
  // 900 left approved to a PDA that no longer backs any listing. Nothing can spend it.
  assert.equal(c.e.token(c.tokenAccount).delegatedAmount, 900n * UNIT);
  const again = c.e.wallet();
  const at = c.e.ata(again.publicKey, c.mint);
  c.e.fails(c.settleIx(again.publicKey, at), [], "AccountNotInitialized");
  // A new listing overwrites the old approval with its own exact amount.
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n, price: MIN, duration: 60n }), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegatedAmount, 5n);
});

test("attack: a stale delegate from a Gone listing cannot be used", () => {
  const c = setup({ amount: 100n, held: 100n });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  // Seller moves one token out and leaves the delegate in place: Gone.
  const o = c.e.ata(c.e.wallet().publicKey, c.mint);
  c.e.ok(spl.createTransferInstruction(c.tokenAccount, o, c.seller.publicKey, 1n), [c.seller]);
  c.e.ok(c.refundIx(w.publicKey));
  assert.ok(c.e.token(c.tokenAccount).delegate.equals(c.listing), "delegate still set");
  // Tops back up: the delegate would work, the state must stop it.
  c.e.mintTo(c.mint, c.tokenAccount, 1n);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.warp(300);
  c.e.fails(c.settleIx(w.publicKey, wt), [], "ConstraintTokenOwner"); // top bidder cleared
  const def = c.e.ata(PublicKey.default, c.mint);
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: def }), [], "NotLive");
  const b = c.e.wallet();
  c.e.fails(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: c.amount }), [b], "NotLive");
  assert.equal(c.e.token(c.tokenAccount).amount, 100n);
});

test("attack: token account handed over: delegate is cleared and a re-approve by the new owner does not pay out their tokens", () => {
  const c = setup({ amount: 100n, held: 100n });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const newOwner = c.e.wallet();
  c.e.ok(spl.createSetAuthorityInstruction(c.tokenAccount, c.seller.publicKey, spl.AuthorityType.AccountOwner, newOwner.publicKey), [c.seller]);
  // Tricked or not, the new owner re-approves the listing PDA.
  c.e.ok(spl.createApproveInstruction(c.tokenAccount, c.listing, newOwner.publicKey, 100n), [newOwner]);
  c.e.warp(300);
  c.e.fails(c.settleIx(w.publicKey), [], "SellerTokensUnavailable");
  assert.equal(c.e.token(c.tokenAccount).amount, 100n);
});

test("attack: token account substitution in every instruction", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const wt = c.e.ata(w.publicKey, c.mint);
  // Another account of the same mint held by a victim.
  const victim = c.e.wallet();
  const victimToken = c.e.ata(victim.publicKey, c.mint, 500n);
  const base = { listing: c.listing, seller: c.seller.publicKey, mint: c.mint };
  c.e.fails(IX.settle({ ...base, tokenAccount: victimToken, winnerToken: wt }), [], "ConstraintAddress");
  c.e.fails(IX.refund({ listing: c.listing, tokenAccount: victimToken, topBidder: w.publicKey }), [], "ConstraintAddress");
  c.e.fails(IX.cancel({ seller: c.seller.publicKey, listing: c.listing, tokenAccount: victimToken, topBidder: w.publicKey }), [c.seller], "ConstraintAddress");
  // Winner's tokens must go to an account the winner owns, of this mint.
  const thief = c.e.wallet();
  c.e.fails(IX.settle({ ...base, tokenAccount: c.tokenAccount, winnerToken: c.e.ata(thief.publicKey, c.mint) }), [thief], "ConstraintTokenOwner");
  // The seller's own account is not the winner's.
  c.e.fails(IX.settle({ ...base, tokenAccount: c.tokenAccount, winnerToken: c.tokenAccount }), [], "ConstraintTokenOwner");
});

test("attack: wrong mint at every step", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const otherMint = c.e.mint();
  const wrong = c.e.ata(w.publicKey, otherMint);
  const wt = c.e.ata(w.publicKey, c.mint);
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: otherMint, winnerToken: wt }), [], "ConstraintAddress");
  c.e.fails(IX.settle({ listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: wrong }), [], "ConstraintTokenMint");
  // Create: token account of one mint with another mint named.
  const e = c.e;
  const s2 = e.wallet();
  const t2 = e.ata(s2.publicKey, otherMint, 10n);
  e.fails(IX.create({ seller: s2.publicKey, tokenAccount: t2, mint: c.mint, amount: 10n, price: MIN, duration: 60n }), [s2], "ConstraintAssociated");
});

test("attack: fake or mismatched token program", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const wt = c.e.ata(w.publicKey, c.mint);
  const fake = Keypair.generate().publicKey;
  const base = { listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, winnerToken: wt };
  c.e.fails(IX.settle({ ...base, tokenProgram: T22 }), []);
  c.e.fails(IX.settle({ ...base, tokenProgram: PROGRAM_ID }), []);
  c.e.fails(IX.settle({ ...base, tokenProgram: fake }), []);
  assert.equal(c.e.token(c.tokenAccount).amount, c.amount);
});

test("attack: relisting under a pending buy: expected price and amount stop the swap", () => {
  const c = setup({ mode: 1, duration: 0n, price: 2n * MIN, amount: 1000n });
  const buyer = c.e.wallet();
  const signedBuy = c.buyIx(buyer);
  // Before the buyer's transaction lands, the seller replaces the deal.
  c.e.ok(c.cancelIx(), [c.seller]);
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, mode: 1, amount: 1n, price: 500n * MIN, duration: 0n }), [c.seller]);
  const b0 = c.e.bal(buyer.publicKey);
  c.e.fails(signedBuy, [buyer], "ListingChanged");
  assert.equal(c.e.bal(buyer.publicKey), b0);
});

test("attack: relisting under a pending bid: expected amount stops the swap", () => {
  const c = setup({ amount: 1000n });
  const b = c.e.wallet();
  const signedBid = IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 5n * MIN, expected: 1000n });
  c.e.ok(c.cancelIx(), [c.seller]);
  c.e.ok(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 1n, price: MIN, duration: 60n }), [c.seller]);
  c.e.fails(signedBid, [b], "ListingChanged");
});

test("attack: closed listing cannot be revived inside one transaction", () => {
  const c = setup({ mode: 1, duration: 0n });
  const [x, y] = [c.e.wallet(), c.e.wallet()];
  c.e.fails([c.buyIx(x), c.buyIx(y)], [x, y]);
  assert.ok(c.e.acct(c.listing), "whole transaction rolled back");
});

test("attack: seller can list only once on the token account while a listing is live", () => {
  const c = setup({ amount: 10n, held: 100n });
  c.e.fails(IX.create({ seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint, amount: 100n, price: MIN, duration: 60n }), [c.seller]);
  assert.equal(c.e.token(c.tokenAccount).delegatedAmount, 10n, "approved amount cannot be raised through the program");
});

test("no admin: the program has no instruction outside the documented set", async () => {
  const { readFileSync } = await import("node:fs");
  const idl = JSON.parse(readFileSync(IDL_PATH));
  assert.deepEqual(idl.instructions.map((i) => i.name).sort(), [
    "accept", "buy_fixed", "buy_fixed_with_pass", "cancel", "claim_credit", "close_listing",
    "create_accept_listing", "create_listing", "place_bid", "refund", "settle",
  ]);
  const accounts = idl.accounts.map((a) => a.name).sort();
  assert.deepEqual(accounts, ["Claim", "Listing"], "no config or admin account exists");
  // Any instruction's non-signer path is pinned: only these take a signer that is
  // not the wallet spending its own money.
  const signers = Object.fromEntries(idl.instructions.map((i) => [i.name, i.accounts.filter((a) => a.signer).map((a) => a.name)]));
  assert.deepEqual(signers, {
    create_listing: ["seller"], create_accept_listing: ["server"], accept: ["seller"], place_bid: ["bidder"], settle: [], refund: [],
    cancel: ["seller"], buy_fixed: ["buyer"], buy_fixed_with_pass: ["buyer"], close_listing: [], claim_credit: ["owner"],
  });
});

test("IDL matches the hand written client's discriminators", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const idl = JSON.parse(readFileSync(IDL_PATH));
  for (const i of idl.instructions) {
    assert.deepEqual(i.discriminator, [...createHash("sha256").update(`global:${i.name}`).digest().subarray(0, 8)], i.name);
  }
});
