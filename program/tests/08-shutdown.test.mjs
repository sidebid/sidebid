// Rehearsal of the withdraw-only shutdown on LiteSVM, through the real upgradeable
// loader: deploy the normal build, fill it with listings in every state, upgrade in
// place to the withdraw-only build, drain everything with scripts/shutdown.mjs,
// check every lamport went home, then close the program and get the deposit back.
//
// Needs both test key builds (npm run build:test): target/test/sidebid.so (normal) and
// target/test/withdraw-only/sidebid.so (see README, "Withdraw-only shutdown").
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  assert, Env, IX, MIN, UNIT, SOL, SERVER, TOKEN, T22, here, SO, setup, setupAccept, makeExecutable,
  creditPda, vaultPda, listingPda, claimPda, passIx, xHash, Keypair, PublicKey, SystemProgram, PROGRAM_ID, spl,
  TransactionInstruction,
} from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import {
  drainListing, parseEvents, creditCandidates, check, scanHistory, LISTING_DISC, CLAIM_DISC, LOADER, programDataAddress,
} from "../scripts/shutdown.mjs";

const WO_SO = process.env.SIDEBID_WO_SO ?? join(here, "../target/test/withdraw-only/sidebid.so");
const missing = !existsSync(WO_SO);
if (missing && process.env.SIDEBID_REQUIRE_WO) throw new Error(`withdraw-only build missing at ${WO_SO}`);
const skip = missing && `withdraw-only build missing at ${WO_SO}; build it (README) or run npm run test:shutdown`;

const FEE = 5000n;
const ROUNDS = 3; // copies of every listing state
const PROGRAM_DATA = programDataAddress();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey) => ({ pubkey, isSigner: true, isWritable: false });
const sw = (pubkey) => ({ pubkey, isSigner: true, isWritable: true });
const loaderIx = (keys, data) => new TransactionInstruction({ programId: LOADER, keys, data });

/** Upgradeable loader v3, the same instructions `solana program deploy / close` send. */
class Loader {
  constructor(e, authority) { this.e = e; this.authority = authority; this.fees = 0n; }
  send(ixs, signers = []) {
    const res = this.e.ok(ixs, signers, { payer: this.authority });
    this.fees += FEE * BigInt(res.sigs);
    return res;
  }
  /** create buffer, InitializeBuffer, Write in 1000 byte chunks */
  writeBuffer(so) {
    const buffer = Keypair.generate();
    const space = 37 + so.length;
    this.send([
      SystemProgram.createAccount({ fromPubkey: this.authority.publicKey, newAccountPubkey: buffer.publicKey,
        lamports: Number(this.e.rent(space)), space, programId: LOADER }),
      loaderIx([w(buffer.publicKey), r(this.authority.publicKey)], u32(0)),
    ], [buffer]);
    for (let at = 0; at < so.length; at += 1000) {
      const chunk = so.subarray(at, at + 1000);
      this.send(loaderIx([w(buffer.publicKey), s(this.authority.publicKey)],
        Buffer.concat([u32(1), u32(at), u64(chunk.length), chunk])));
    }
    return buffer.publicKey;
  }
  deploy(so) {
    // The CLI creates the 36 byte program account with createAccount, signed by the
    // program keypair. That keypair stays out of tests: the authority pays the same
    // rent to the address, and the account is given the loader's empty layout.
    this.send(SystemProgram.transfer({ fromPubkey: this.authority.publicKey, toPubkey: PROGRAM_ID, lamports: Number(this.e.rent(36)) }));
    this.e.poke(PROGRAM_ID, { data: new Uint8Array(36), owner: LOADER });
    const buffer = this.writeBuffer(so);
    const a = this.authority.publicKey;
    this.send(loaderIx([sw(a), w(PROGRAM_DATA), w(PROGRAM_ID), w(buffer), r(SYSVAR_RENT_PUBKEY), r(SYSVAR_CLOCK_PUBKEY),
      r(SystemProgram.programId), s(a)], Buffer.concat([u32(2), u64(so.length)])));
    this.e.warp(1); // a deploy is visible from the next slot
  }
  upgrade(so) {
    const buffer = this.writeBuffer(so);
    const a = this.authority.publicKey;
    this.send(loaderIx([w(PROGRAM_DATA), w(PROGRAM_ID), w(buffer), w(a), r(SYSVAR_RENT_PUBKEY), r(SYSVAR_CLOCK_PUBKEY), s(a)], u32(3)));
    this.e.warp(1);
    return buffer;
  }
  close() {
    const a = this.authority.publicKey;
    this.send(loaderIx([w(PROGRAM_DATA), w(a), s(a), w(PROGRAM_ID)], u32(5)));
  }
}

test("withdraw-only shutdown: every listing state, upgrade in place, drain, every lamport home, close", { skip }, async (t) => {
  const normal = readFileSync(SO);
  const withdrawOnly = readFileSync(WO_SO);
  assert.ok(withdrawOnly.length <= normal.length, `withdraw-only (${withdrawOnly.length}) must fit the program data of the normal build (${normal.length})`);

  const e = new Env({ load: false });
  const logs = [];
  const txLogs = [];
  const send = e.send.bind(e);
  e.send = (...args) => {
    const res = send(...args);
    if (res.ok) { logs.push(...res.logs); txLogs.push(res.logs); }
    return res;
  };

  // 1. Deploy the normal build through the loader.
  const authority = e.wallet(20n * BigInt(SOL));
  const authorityStart = e.bal(authority.publicKey);
  const loader = new Loader(e, authority);
  loader.deploy(normal);
  const depositNormal = e.bal(PROGRAM_DATA);
  assert.equal(depositNormal, e.rent(45 + normal.length), "program data holds rent for the .so plus its 45 byte header");
  e.svm.airdrop(SERVER.publicKey.toBase58(), 10n * BigInt(SOL));

  // Everyone's balance at birth. Except where a sale completed, each must end exactly here.
  const start = new Map();
  const wallet = (lamports) => { const k = e.wallet(lamports); start.set(k.publicKey.toBase58(), lamports ?? 10n * BigInt(SOL)); return k; };
  start.set(SERVER.publicKey.toBase58(), e.bal(SERVER.publicKey));
  const expectDelta = new Map(); // owner -> lamports beyond the start, from completed sales and donations
  const addDelta = (k, d) => expectDelta.set(k.toBase58(), (expectDelta.get(k.toBase58()) ?? 0n) + d);
  const restore = []; // accounts turned unpayable on purpose, with what they held

  const all = []; // every listing created, with how it is drained
  const auction = (over = {}) => {
    const c = setup({ env: e, duration: 60n, ...over });
    // setup made its own seller; track it.
    start.set(c.seller.publicKey.toBase58(), e.bal(c.seller.publicKey) + e.bal(c.listing));
    all.push(c);
    return c;
  };
  const card = (over = {}) => {
    const c = setupAccept({ env: e, duration: 30n, ...over });
    start.set(c.seller.publicKey.toBase58(), e.bal(c.seller.publicKey));
    c.card = true;
    all.push(c);
    return c;
  };
  const bidder = () => wallet(5n * BigInt(SOL));

  // Phase A: listings that will be past their end at shutdown.
  const ended = [];
  for (let i = 0; i < ROUNDS; i++) {
    const endedBid = auction({ duration: 10n }); endedBid.bid(bidder(), 3n * MIN); endedBid.tag = "auction ended, bid unsettled";
    const expiredNoBid = auction({ duration: 10n }); expiredNoBid.tag = "auction expired, no bid, approval still set";
    const fixedExpired = auction({ mode: 1, duration: 10n, price: 5n * MIN }); fixedExpired.tag = "fixed expired, approval still set";
    const goneDelegate = auction({ duration: 10n }); goneDelegate.bid(bidder(), 2n * MIN); goneDelegate.tag = "Gone, approval still set";
    const goneRevoked = auction({ duration: 10n }); goneRevoked.bid(bidder(), 2n * MIN); goneRevoked.tag = "Gone, seller revoked";
    const cardStale = card({ duration: 10n, window: 60n }); cardStale.bid(bidder(), 4n * MIN); cardStale.tag = "card ended, window passed, bid";
    const cardInWindow = card({ duration: 10n, window: 3600n }); cardInWindow.bid(bidder(), 4n * MIN); cardInWindow.tag = "card in accept window, bid";
    const cardGhosted = card({ duration: 10n, window: 60n }); cardGhosted.bid(bidder(), 4n * MIN); cardGhosted.tag = "card Ghosted";
    const cardNoBid = card({ duration: 10n }); cardNoBid.tag = "card ended, no bid";
    const cancelLater = auction({ duration: 10n }); cancelLater.bid(bidder(), 2n * MIN); cancelLater.tag = "ended with bid, seller cancels";
    cancelLater.sellerCancels = true;
    ended.push({ goneDelegate, goneRevoked, cardGhosted });
  }
  e.warp(120);
  for (const { goneDelegate, goneRevoked, cardGhosted } of ended) {
    // Normal-build refunds: the seller moved the tokens (approval left set), or revoked.
    const other = e.ata(Keypair.generate().publicKey, goneDelegate.mint);
    e.ok(spl.createTransferInstruction(goneDelegate.tokenAccount, other, goneDelegate.seller.publicKey, goneDelegate.amount), [goneDelegate.seller]);
    e.ok(goneDelegate.refundIx(e.listing(goneDelegate.listing).topBidder));
    e.ok(spl.createRevokeInstruction(goneRevoked.tokenAccount, goneRevoked.seller.publicKey), [goneRevoked.seller]);
    e.ok(goneRevoked.refundIx(e.listing(goneRevoked.listing).topBidder));
    e.ok(cardGhosted.refundIx(e.listing(cardGhosted.listing).topBidder));
    assert.equal(e.listing(goneDelegate.listing).state, 1);
    assert.equal(e.token(goneDelegate.tokenAccount).delegate?.toBase58(), goneDelegate.listing.toBase58(), "Gone with the approval still set");
    assert.equal(e.listing(cardGhosted.listing).state, 2);
  }

  // Phase B: listings live at shutdown.
  const passKey = Keypair.generate();
  let creditToClaim, creditToPush;
  for (let i = 0; i < ROUNDS; i++) {
    const liveNoBid = auction({ duration: 3600n }); liveNoBid.tag = "auction live, no bid";
    const outbid = auction({ duration: 3600n });
    const b1 = bidder(), b2 = bidder(), b3 = bidder();
    outbid.bid(b1, 2n * MIN); outbid.bid(b2, 4n * MIN, b1); outbid.bid(b3, 6n * MIN, b2);
    outbid.tag = "auction live, outbid twice";
    const t22 = auction({ duration: 3600n, program: T22 }); t22.bid(bidder(), 3n * MIN); t22.tag = "Token 2022 auction live, bid";
    const fixedForever = auction({ mode: 1, duration: 0n, price: 7n * MIN }); fixedForever.tag = "fixed, no expiry";
    const fixedLong = auction({ mode: 1, duration: 30n * 86400n, price: 7n * MIN }); fixedLong.tag = "fixed, 30 days";
    const gated = auction({ mode: 1, duration: 0n, price: 2n * MIN, pass: { signer: passKey.publicKey } }); gated.tag = "fixed with pass, live";
    const cardLive = card({ duration: 3600n }); cardLive.bid(bidder(), 2n * MIN); cardLive.tag = "card live, bid";
    const cardLiveNoBid = card({ duration: 3600n }); cardLiveNoBid.tag = "card live, no bid";
    // Donations to vaults: they follow the bid, or the rent when there is no bid.
    const donatedNoBid = auction({ duration: 3600n }); donatedNoBid.tag = "auction live, no bid, vault donation";
    e.ok(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: donatedNoBid.vault, lamports: 2_000_000 }));
    addDelta(donatedNoBid.seller.publicKey, 2_000_000n);
    const donatedBid = auction({ duration: 3600n }); const db = bidder(); donatedBid.bid(db, 2n * MIN);
    e.ok(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: donatedBid.vault, lamports: 3_000_000 }));
    addDelta(db.publicKey, 3_000_000n); donatedBid.tag = "auction live, bid, vault donation";
    // A bidder who could not be paid when outbid: the repayment parked in a credit.
    const credited = auction({ duration: 3600n });
    const cb = bidder(); credited.bid(cb, 2n * MIN);
    restore.push({ k: cb.publicKey, lamports: e.bal(cb.publicKey) });
    makeExecutable(e, cb.publicKey);
    credited.bid(bidder(), 4n * MIN, cb);
    assert.equal(e.bal(creditPda(credited.listing, cb.publicKey)), 2n * MIN, "repayment parked in a credit");
    credited.tag = "auction live, outbid bidder credited";
    if (i === 0) creditToClaim = { listing: credited.listing, owner: cb };
    else creditToPush = creditToPush ?? { listing: credited.listing, owner: cb };
  }
  // Completed sale before shutdown: a pass buy. Its claim account is the one thing
  // shutdown cannot return, because nothing on chain records who paid for it.
  const sold = auction({ mode: 1, duration: 0n, price: 2n * MIN, pass: { signer: passKey.publicKey } });
  all.pop(); // closed by the sale
  const buyer = wallet();
  const expiry = e.now() + 600n;
  const hash = xHash("shutdown-buyer");
  e.ok([passIx(passKey, sold.listing, buyer.publicKey, hash, expiry), IX.buyPass({
    buyer: buyer.publicKey, listing: sold.listing, seller: sold.seller.publicKey, tokenAccount: sold.tokenAccount, mint: sold.mint,
    buyerToken: e.ata(buyer.publicKey, sold.mint), price: sold.price, amount: sold.amount, hash, expiry, signer: passKey.publicKey, campaign: sold.listing,
  })], [buyer]);
  const claim = claimPda(passKey.publicKey, sold.listing, hash);
  const claimRent = e.bal(claim);
  addDelta(sold.seller.publicKey, sold.price);
  addDelta(buyer.publicKey, -sold.price - claimRent);

  // The normal build refuses what the shutdown needs: early refunds and closes over an approval.
  const live = all.find((c) => c.tag === "auction live, outbid twice");
  e.fails(live.refundIx(e.listing(live.listing).topBidder), [], "RefundNotAllowed");
  const approved = all.find((c) => c.tag === "auction expired, no bid, approval still set");
  e.fails(approved.closeIx(), [], "DelegateStillSet");
  const ended0 = all.find((c) => c.tag === "ended with bid, seller cancels");
  e.fails(ended0.cancelIx(e.listing(ended0.listing).topBidder), [ended0.seller], "AuctionEnded");
  // The probe scripts/shutdown.mjs uses to tell the builds apart.
  const probe = () => IX.pushCredit({ owner: Keypair.generate().publicKey, listing: Keypair.generate().publicKey });
  e.fails(probe(), [], "InstructionFallbackNotFound");

  // Snapshot: what the program holds, and who it belongs to under the program's own rules.
  const held = { listings: 0n, vaults: 0n, credits: 0n };
  for (const c of all) {
    assert.ok(e.acct(c.listing), `${c.tag}: listing open at shutdown`);
    held.listings += e.bal(c.listing);
    held.vaults += e.bal(c.vault);
  }
  const parked = parseEvents(logs).parked;
  assert.equal(parked.length, ROUNDS, "every bidder credit is logged as CreditParked");
  for (const p of parked) held.credits += e.bal(creditPda(p.listing, p.owner));
  const states = new Set(all.map((c) => c.tag));
  assert.ok(all.length >= 15 * ROUNDS, `${all.length} listings across ${states.size} states`);

  // 2. Upgrade in place to the withdraw-only build. Same program id, same accounts.
  const authorityBeforeUpgrade = e.bal(authority.publicKey);
  const feesBeforeUpgrade = loader.fees;
  const buffer = loader.upgrade(withdrawOnly);
  assert.equal(e.acct(buffer), null, "the buffer is emptied into the spill account");
  const surplus = depositNormal - e.bal(PROGRAM_DATA);
  assert.equal(e.bal(authority.publicKey), authorityBeforeUpgrade - (loader.fees - feesBeforeUpgrade) + surplus,
    "the upgrade costs the authority only fees: buffer rent comes back to the spill account");
  assert.equal(e.acct(PROGRAM_DATA).data.length, 45 + normal.length, "program data keeps its size");

  e.fails(probe(), [], "NothingToClaim");
  // Everything that would take new money or complete a sale is now refused.
  const sellerB = e.wallet();
  const mintB = e.mint();
  const ataB = e.ata(sellerB.publicKey, mintB, 10n * UNIT);
  e.fails(IX.create({ seller: sellerB.publicKey, tokenAccount: ataB, mint: mintB, mode: 0, amount: UNIT, price: MIN, duration: 60n }), [sellerB], "WithdrawOnly");
  const id = createHash("sha256").update("shutdown-card").digest();
  e.fails(IX.createAccept({ server: SERVER.publicKey, id, seller: sellerB.publicKey, tokenAccount: ataB, mint: mintB, amount: UNIT }), [SERVER], "WithdrawOnly");
  const top = e.listing(live.listing);
  const late = e.wallet();
  e.fails(IX.bid({ bidder: late.publicKey, listing: live.listing, tokenAccount: live.tokenAccount, mint: live.mint, amount: 20n * MIN,
    expected: live.amount, prev: top.topBidder }), [late], "WithdrawOnly");
  const fixed = all.find((c) => c.tag === "fixed, no expiry");
  e.fails(fixed.buyIx(late), [late], "WithdrawOnly");
  const gatedLive = all.find((c) => c.tag === "fixed with pass, live");
  const hash2 = xHash("late-buyer");
  e.fails([passIx(passKey, gatedLive.listing, late.publicKey, hash2, e.now() + 600n), IX.buyPass({
    buyer: late.publicKey, listing: gatedLive.listing, seller: gatedLive.seller.publicKey, tokenAccount: gatedLive.tokenAccount, mint: gatedLive.mint,
    buyerToken: e.ata(late.publicKey, gatedLive.mint), price: gatedLive.price, amount: gatedLive.amount, hash: hash2, expiry: e.now() + 600n,
    signer: passKey.publicKey, campaign: gatedLive.listing })], [late], "WithdrawOnly");
  const unsettled = all.find((c) => c.tag === "auction ended, bid unsettled");
  e.fails(unsettled.settleIx(e.listing(unsettled.listing).topBidder), [], "WithdrawOnly");
  const inWindow = all.find((c) => c.tag === "card in accept window, bid");
  e.fails(inWindow.acceptIx(e.listing(inWindow.listing).topBidder, e.listing(inWindow.listing).topBid), [inWindow.seller], "WithdrawOnly");

  // Drain paths cannot be pointed anywhere else.
  const thief = e.wallet();
  const victim = e.listing(live.listing);
  e.fails(IX.refund({ listing: live.listing, tokenAccount: live.tokenAccount, topBidder: thief.publicKey }), [], "MissingPrevBidder");
  e.fails(IX.close({ listing: approved.listing, tokenAccount: approved.tokenAccount, seller: thief.publicKey }), [], "ConstraintAddress");
  e.fails(IX.close({ listing: live.listing, tokenAccount: live.tokenAccount, seller: live.seller.publicKey }), [], "CloseNotAllowed");
  e.fails(IX.cancel({ seller: thief.publicKey, listing: live.listing, tokenAccount: live.tokenAccount, topBidder: victim.topBidder }), [thief], "ConstraintAddress");
  e.fails(IX.pushCredit({ owner: thief.publicKey, listing: creditToPush.listing, credit: creditPda(creditToPush.listing, creditToPush.owner.publicKey) }), [], "ConstraintSeeds");
  e.fails(IX.pushCredit({ owner: creditToPush.owner.publicKey, listing: creditToPush.listing }), [], "OwnerCannotReceive");
  const cardAny = all.find((c) => c.card);
  e.fails(IX.cancel({ seller: cardAny.seller.publicKey, listing: cardAny.listing, tokenAccount: cardAny.tokenAccount }), [cardAny.seller], "WrongMode");

  // Before the drain, check refuses: open listings, and their funded vaults, block.
  const before = await check(rpcOver(e, txLogs, () => all.map((c) => c.listing)), [SERVER.publicKey], () => {});
  assert.equal(before.clean, false);
  assert.equal(before.listings.length, all.length);
  assert.ok(before.blocking.length >= 10 * ROUNDS, `${before.blocking.length} open vaults block`);
  assert.equal(before.stranded.length, 0);

  // 3. Drain. Sellers who show up cancel (which also removes their approval);
  // everything else is drained by a stranger who only pays fees.
  for (const c of all.filter((x) => x.sellerCancels)) {
    const l = e.listing(c.listing);
    e.ok(c.cancelIx(l.topBidder), [c.seller]);
    assert.equal(e.token(c.tokenAccount).delegate, null, "cancel removed the approval");
  }
  // Two owners can't receive at drain time: one top bidder, one rent payer. Their SOL parks in a credit.
  const unpayableBidder = all.find((c) => c.tag === "card live, bid");
  const ub = e.listing(unpayableBidder.listing).topBidder;
  restore.push({ k: ub, lamports: e.bal(ub) });
  makeExecutable(e, ub);
  const unpayableSeller = all.find((c) => c.tag === "fixed, 30 days");
  restore.push({ k: unpayableSeller.seller.publicKey, lamports: e.bal(unpayableSeller.seller.publicKey) });
  makeExecutable(e, unpayableSeller.seller.publicKey);

  const operator = e.wallet(BigInt(SOL));
  const operatorStart = e.bal(operator.publicKey);
  let operatorFees = 0n;
  const discovered = parseEvents(logs).listings.filter((k) => {
    const a = e.acct(k);
    return a && new PublicKey(a.programAddress).equals(PROGRAM_ID) && Buffer.from(a.data).subarray(0, 8).equals(LISTING_DISC);
  });
  assert.equal(discovered.length, all.filter((c) => !c.sellerCancels).length, "every open listing is found from the event logs");
  for (const k of discovered) {
    const res = e.ok(drainListing(k, e.acct(k).data), [], { payer: operator });
    operatorFees += FEE * BigInt(res.sigs);
  }
  for (const c of all) {
    assert.equal(e.acct(c.listing), null, `${c.tag}: listing closed`);
    assert.equal(e.bal(c.vault), 0n, `${c.tag}: vault empty`);
  }
  // Leftover approvals: the listings closed anyway; the seller removes them with a plain token Revoke.
  const leftover = all.filter((c) => {
    const t = e.token(c.tokenAccount, c.program ?? TOKEN);
    return t.delegate && t.delegate.equals(c.listing);
  });
  assert.ok(leftover.length >= 3 * ROUNDS, `${leftover.length} closed listings left an approval behind`);

  // Credits: owners who can receive again get them pushed by the stranger; one owner claims their own.
  for (const { k, lamports } of restore) e.poke(k, { lamports, data: new Uint8Array(0), owner: SystemProgram.programId, executable: false });
  // A rent credit emits no CreditParked event, so the drain checks every
  // (listing, seller / bidder / server) pair the events name.
  assert.equal(parseEvents(logs).parked.length, ROUNDS + 1, "the drain's bidder credit is logged, its rent credit is not");
  const credits = creditCandidates(parseEvents(logs), [SERVER.publicKey]);
  const funded = credits.filter((c) => e.bal(c.credit) > 0n);
  assert.equal(funded.length, ROUNDS + 2, "every credit is found: the parked bidders, the drain's bidder and its rent payer");
  e.ok(IX.claimCredit({ owner: creditToClaim.owner.publicKey, listing: creditToClaim.listing, destination: creditToClaim.owner.publicKey }), [creditToClaim.owner]);
  for (const c of credits) {
    if (e.bal(creditPda(c.listing, c.owner)) === 0n) continue;
    const res = e.ok(IX.pushCredit(c), [], { payer: operator });
    operatorFees += FEE * BigInt(res.sigs);
  }
  for (const c of credits) assert.equal(e.bal(creditPda(c.listing, c.owner)), 0n, "credit empty");

  // 4. Every lamport is home: each party ends exactly at its starting balance, plus
  // what completed sales and donations owed it. The stranger only paid fees.
  for (const [k, startBal] of start) {
    const want = startBal + (expectDelta.get(k) ?? 0n);
    assert.equal(e.bal(new PublicKey(k)), want, `${k} ends with exactly what it is owed`);
  }
  assert.equal(e.bal(operator.publicKey), operatorStart - operatorFees, "the drain operator received nothing");
  // scripts/shutdown.mjs check, run against this chain.
  const known = () => [...all.map((c) => c.listing), claim];
  const conn = rpcOver(e, txLogs, known);
  const noop = () => {};
  assert.equal((await check(conn, [SERVER.publicKey], noop)).clean, true, "check prints CLEAN after the drain");
  await assert.rejects(check(conn, [], noop), /server key is required/);
  // W1: SOL sent to the vault of a closed listing is stranded, and must not block the close.
  const dead = all[0];
  e.ok(SystemProgram.transfer({ fromPubkey: e.payer.publicKey, toPubkey: dead.vault, lamports: 1_000_000 }));
  e.fails(dead.closeIx(), [], "AccountNotInitialized");
  const afterGrief = await check(conn, [SERVER.publicKey], noop);
  assert.equal(afterGrief.clean, true, "a dead vault donation does not block");
  assert.equal(afterGrief.stranded.length, 1);
  assert.ok(afterGrief.stranded[0].vault.equals(dead.vault));
  // W2: a transaction the RPC can't return, or truncated logs, refuses CLEAN.
  await assert.rejects(check(rpcOver(e, [...txLogs, null], known), [SERVER.publicKey], noop), /no transaction data/);
  await assert.rejects(check(rpcOver(e, [...txLogs, ["Log truncated"]], known), [SERVER.publicKey], noop), /truncated logs/);
  await assert.rejects(scanHistory(rpcOver(e, [null], known), [SERVER.publicKey]), /full history/);

  const returned = held.listings + held.vaults + held.credits;
  assert.ok(returned > 0n);
  t.diagnostic(`${all.length} listings in ${states.size} states, ${start.size} wallets checked to the lamport`);
  t.diagnostic(`held at shutdown: listings ${held.listings}, vaults ${held.vaults}, credits ${held.credits} lamports; all returned`);
  t.diagnostic(`normal ${normal.length} bytes, withdraw-only ${withdrawOnly.length} bytes, deposit ${depositNormal} lamports`);

  // 5. Close the program: the deposit goes back to the authority.
  const pdLamports = e.bal(PROGRAM_DATA);
  const beforeClose = e.bal(authority.publicKey);
  const feesBeforeClose = loader.fees;
  loader.close();
  assert.equal(e.acct(PROGRAM_DATA), null, "program data is gone");
  assert.equal(e.bal(authority.publicKey), beforeClose + pdLamports - (loader.fees - feesBeforeClose), "deposit back to the authority");
  assert.equal(e.bal(authority.publicKey), authorityStart - loader.fees - e.rent(36),
    "over the whole life the authority lost only fees and the 36 byte program account");
  assert.equal(e.bal(PROGRAM_ID), e.rent(36), "the program account stays behind as a tombstone");
  e.warp(1);
  e.fails(IX.claimCredit({ owner: thief.publicKey, listing: thief.publicKey, destination: thief.publicKey }), [thief], "");

  // What stays behind: claim accounts, and the approvals sellers have not revoked yet.
  assert.equal(e.bal(claim), claimRent, "the claim keeps the buyer's rent: the documented loss");
  assert.ok(Buffer.from(e.acct(claim).data).subarray(0, 8).equals(CLAIM_DISC));
  for (const c of leftover) {
    e.ok(spl.createRevokeInstruction(c.tokenAccount, c.seller.publicKey, [], c.program ?? TOKEN), [c.seller]);
    assert.equal(e.token(c.tokenAccount, c.program ?? TOKEN).delegate, null, "a plain token Revoke still clears it after close");
  }
  void listingPda; void UNIT;
});

/** The few RPC calls scripts/shutdown.mjs makes, answered from LiteSVM. `txLogs`
 *  holds one log array per transaction, or null for one the RPC lost. */
function rpcOver(e, txLogs, known) {
  const sigs = txLogs.map((_, i) => ({ signature: `tx${i}`, err: null }));
  return {
    async getSignaturesForAddress(_pk, { before }) { return before ? [] : [...sigs].reverse(); },
    async getTransaction(sig) {
      const l = txLogs[Number(sig.slice(2))];
      return l === null ? null : { meta: { logMessages: l } };
    },
    async getBalance(pk) { return Number(e.bal(pk)); },
    async getAccountInfo(pk) { const a = e.acct(pk); return a ? { lamports: Number(a.lamports) } : null; },
    async getProgramAccounts() {
      return known().map((k) => ({ k, a: e.acct(k) }))
        .filter(({ a }) => a && new PublicKey(a.programAddress).equals(PROGRAM_ID))
        .map(({ k, a }) => ({ pubkey: k, account: { data: Buffer.from(a.data), lamports: Number(a.lamports) } }));
    },
  };
}

test("shutdown script refuses to run without --server", () => {
  const res = spawnSync(process.execPath, [join(here, "../scripts/shutdown.mjs"), "check", "http://127.0.0.1:9"], { encoding: "utf8" });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stdout, /--server/);
});
