// Shared LiteSVM harness and a hand written client. Instructions are encoded
// here, not from the IDL, so a mismatch shows up as a failing test.
import { testListingSeed } from "./fixtures/test-listing-key.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import {
  Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import nacl from "tweetnacl";
import assert from "node:assert/strict";

export const here = dirname(fileURLToPath(import.meta.url));
export const SO = process.env.SIDEBID_SO ?? join(here, "../target/test/sidebid.so");
// The IDL from the last anchor build, else the committed copy (the same program id).
export const IDL_PATH = existsSync(join(here, "../target/idl/sidebid.json"))
  ? join(here, "../target/idl/sidebid.json") : join(here, "../idl/sidebid.json");
export const PROGRAM_ID = new PublicKey(JSON.parse(readFileSync(IDL_PATH)).address);
export const TOKEN = spl.TOKEN_PROGRAM_ID;
export const T22 = spl.TOKEN_2022_PROGRAM_ID;
export const SOL = LAMPORTS_PER_SOL;
export const MIN = 1_000_000n;
export const UNIT = 1_000_000n; // one token at 6 decimals
export const NONE = PROGRAM_ID; // Anchor encodes an absent optional account as the program id
export const GRACE = 86400n;
export const WINDOW = 600n;
export const SERVER = Keypair.fromSeed(testListingSeed());
export { Keypair, PublicKey, SystemProgram, spl, nacl, assert, TransactionInstruction, Ed25519Program };

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const sw = (pubkey) => ({ pubkey, isSigner: true, isWritable: true });
const s = (pubkey) => ({ pubkey, isSigner: true, isWritable: false });
const opt = (k, writable = true) => ({ pubkey: k ?? NONE, isSigner: false, isWritable: k ? writable : false });

export const listingPda = (tokenAccount) =>
  PublicKey.findProgramAddressSync([Buffer.from("listing"), tokenAccount.toBuffer()], PROGRAM_ID)[0];
export const vaultPda = (listing) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), listing.toBuffer()], PROGRAM_ID)[0];
export const creditPda = (listing, owner) =>
  PublicKey.findProgramAddressSync([Buffer.from("credit"), listing.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
export const acceptPda = (id) =>
  PublicKey.findProgramAddressSync([Buffer.from("accept"), id], PROGRAM_ID)[0];
export const claimPda = (signer, campaign, hash) =>
  PublicKey.findProgramAddressSync([Buffer.from("claim"), signer.toBuffer(), campaign.toBuffer(), hash], PROGRAM_ID)[0];

const Sys = SystemProgram.programId;
const ix = (keys, data) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

export const IX = {
  create({ seller, tokenAccount, mint, tokenProgram = TOKEN, mode = 0, amount, price, duration, pass }) {
    const listing = listingPda(tokenAccount);
    const passBytes = pass
      ? Buffer.concat([Buffer.from([1]), pass.signer.toBuffer(), (pass.campaign ?? PublicKey.default).toBuffer()])
      : Buffer.from([0]);
    return ix(
      [sw(seller), w(listing), r(vaultPda(listing)), w(tokenAccount), r(mint), r(tokenProgram), r(Sys)],
      Buffer.concat([disc("create_listing"), Buffer.from([mode]), u64(amount), u64(price), u64(duration), passBytes]));
  },
  createAccept({ server, id, seller, tokenAccount, mint, tokenProgram = TOKEN, amount, minBid = 1_000_000n, duration = 300n, window = 600n }) {
    const listing = acceptPda(id);
    return ix(
      [sw(server), w(listing), r(vaultPda(listing)), r(seller), r(tokenAccount), r(mint), r(tokenProgram), r(Sys)],
      Buffer.concat([disc("create_accept_listing"), id, u64(amount), u64(minBid), u64(duration), u64(window)]));
  },
  accept({ seller, listing, tokenAccount, mint, winnerToken, rentReceiver, amount, bid, tokenProgram = TOKEN, vault }) {
    return ix(
      [sw(seller), w(listing), w(vault ?? vaultPda(listing)), w(creditPda(listing, seller)), w(tokenAccount), r(mint),
        w(winnerToken), w(rentReceiver), w(creditPda(listing, rentReceiver)), r(tokenProgram), r(Sys)],
      Buffer.concat([disc("accept"), u64(amount), u64(bid)]));
  },
  // maxEnd defaults to no limit for tests about other things. Real clients pass the listing's hard_end_time.
  bid({ bidder, listing, tokenAccount, amount, expected, mint, maxEnd = 2n ** 63n - 1n, prev, prevCredit }) {
    return ix(
      [sw(bidder), w(listing), w(vaultPda(listing)), r(tokenAccount), opt(prev),
        opt(prevCredit ?? (prev ? creditPda(listing, prev) : null)), r(Sys)],
      Buffer.concat([disc("place_bid"), u64(amount), u64(expected), mint.toBuffer(), i64(maxEnd)]));
  },
  settle({ listing, seller, tokenAccount, mint, winnerToken, tokenProgram = TOKEN, vault, sellerCredit }) {
    return ix(
      [w(listing), w(vault ?? vaultPda(listing)), w(seller), w(sellerCredit ?? creditPda(listing, seller)),
        w(tokenAccount), r(mint), w(winnerToken), r(tokenProgram), r(Sys)],
      disc("settle"));
  },
  refund({ listing, tokenAccount, topBidder, credit, vault }) {
    return ix(
      [w(listing), w(vault ?? vaultPda(listing)), r(tokenAccount), opt(topBidder),
        opt(credit ?? (topBidder ? creditPda(listing, topBidder) : null)), r(Sys)],
      disc("refund"));
  },
  cancel({ seller, listing, tokenAccount, topBidder, credit, tokenProgram = TOKEN, sellerCredit }) {
    return ix(
      [sw(seller), w(listing), w(vaultPda(listing)), w(sellerCredit ?? creditPda(listing, seller)), w(tokenAccount),
        opt(topBidder), opt(credit ?? (topBidder ? creditPda(listing, topBidder) : null)), r(tokenProgram), r(Sys)],
      disc("cancel"));
  },
  buy({ buyer, listing, seller, tokenAccount, mint, buyerToken, price, amount, tokenProgram = TOKEN, sellerCredit }) {
    return ix(
      [sw(buyer), w(listing), w(seller), w(sellerCredit ?? creditPda(listing, seller)), w(tokenAccount), r(mint),
        w(buyerToken), r(tokenProgram), r(Sys)],
      Buffer.concat([disc("buy_fixed"), u64(price), u64(amount)]));
  },
  buyPass({ buyer, listing, seller, tokenAccount, mint, buyerToken, price, amount, tokenProgram = TOKEN,
    hash, expiry, signer, campaign, claim }) {
    return ix(
      [sw(buyer), w(listing), w(claim ?? claimPda(signer, campaign, hash)), r(SYSVAR_INSTRUCTIONS_PUBKEY), w(seller),
        w(creditPda(listing, seller)), w(tokenAccount), r(mint), w(buyerToken), r(tokenProgram), r(Sys)],
      Buffer.concat([disc("buy_fixed_with_pass"), hash, i64(expiry), u64(price), u64(amount)]));
  },
  close({ listing, tokenAccount, seller, sellerCredit }) {
    return ix([w(listing), w(vaultPda(listing)), r(tokenAccount), w(seller), w(sellerCredit ?? creditPda(listing, seller)), r(Sys)],
      disc("close_listing"));
  },
  claimCredit({ owner, listing, destination, credit }) {
    return ix([s(owner), w(credit ?? creditPda(listing, owner)), w(destination), r(Sys)],
      Buffer.concat([disc("claim_credit"), listing.toBuffer()]));
  },
  // Withdraw-only build only. No signer: the credit can only go to its owner.
  pushCredit({ owner, listing, credit }) {
    return ix([w(owner), w(credit ?? creditPda(listing, owner)), r(Sys)],
      Buffer.concat([disc("push_credit"), listing.toBuffer()]));
  },
};

export function passMessage(campaign, buyer, hash, expiry) {
  return Buffer.concat([Buffer.from("SIDEBID_PASS_V1\0"), PROGRAM_ID.toBuffer(), campaign.toBuffer(), buyer.toBuffer(), hash, i64(expiry)]);
}

/** The standard ed25519 verify instruction for a pass. */
export function passIx(key, campaign, buyer, hash, expiry) {
  const message = passMessage(campaign, buyer, hash, expiry);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: key.publicKey.toBytes(), message, signature: nacl.sign.detached(message, key.secretKey),
  });
}

/** Turns an address into a real executable program account, as a deployed program would be. */
export function makeExecutable(e, pk) {
  const data = Uint8Array.from(readFileSync(SO));
  e.poke(pk, { lamports: e.rent(data.length), data, owner: new PublicKey("BPFLoader2111111111111111111111111111111111"), executable: true });
}

export const xHash = (id) => createHash("sha256").update(`x:${id}`).digest();

/** Reads Listing fields out of the raw account. */
export function decodeListing(data) {
  const b = Buffer.from(data);
  const pk = (o) => new PublicKey(b.subarray(o, o + 32));
  return {
    seller: pk(8), tokenAccount: pk(40), mint: pk(72), tokenProgram: pk(104),
    amount: b.readBigUInt64LE(136), price: b.readBigUInt64LE(144), endTime: b.readBigInt64LE(152),
    topBidder: pk(160), topBid: b.readBigUInt64LE(192), passSigner: pk(200), campaign: pk(232),
    mode: b[264], state: b[265], decimals: b[266], rentPayer: pk(269), acceptWindow: b.readBigInt64LE(301), hardEnd: b.readBigInt64LE(309),
  };
}

export class Env {
  /** `load: false` starts with no program, for tests that deploy it through the loader. */
  constructor({ load = true } = {}) {
    this.svm = new LiteSVM();
    if (load) this.svm.addProgramFromFile(PROGRAM_ID.toBase58(), SO);
    this.payer = this.wallet(100n * BigInt(SOL));
  }
  wallet(lamports = 10n * BigInt(SOL)) {
    const k = Keypair.generate();
    if (lamports > 0n) this.svm.airdrop(k.publicKey.toBase58(), lamports);
    return k;
  }
  /** Sends a transaction paid by the harness payer, so balances under test stay exact. */
  send(ixs, signers = [], { payer } = {}) {
    const fee = payer ?? this.payer;
    const tx = new Transaction({ recentBlockhash: this.svm.latestBlockhash(), feePayer: fee.publicKey }).add(...[].concat(ixs));
    // Only sign where the instruction asks for it: an extra signer proves nothing.
    const wanted = new Set(tx.instructions.flatMap((i) => i.keys.filter((m) => m.isSigner).map((m) => m.pubkey.toBase58())));
    tx.sign(fee, ...signers.filter((k) => !k.publicKey.equals(fee.publicKey) && wanted.has(k.publicKey.toBase58())));
    const kitTx = {
      messageBytes: tx.serializeMessage(),
      signatures: Object.fromEntries(tx.signatures.map((x) => [x.publicKey.toBase58(), x.signature])),
    };
    const res = this.svm.sendTransaction(kitTx);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) {
      return { ok: false, err: res.toString(), logs: res.meta().logs(), cu: Number(res.meta().computeUnitsConsumed()), sigs: tx.signatures.length };
    }
    return { ok: true, logs: res.logs(), cu: Number(res.computeUnitsConsumed()), sigs: tx.signatures.length };
  }
  ok(ixs, signers, opts) {
    const r = this.send(ixs, signers, opts);
    assert.ok(r.ok, `expected success, got ${r.err}\n${(r.logs ?? []).join("\n")}`);
    return r;
  }
  /** Asserts failure and that `reason` shows up in the logs or the error. */
  fails(ixs, signers, reason, opts) {
    const r = this.send(ixs, signers, opts);
    assert.ok(!r.ok, `expected failure (${reason}) but the transaction succeeded`);
    if (reason) {
      const text = `${r.err}\n${r.logs.join("\n")}`;
      assert.ok(text.includes(reason), `expected "${reason}", got:\n${text}`);
    }
    return r;
  }
  bal(pk) { return BigInt(this.svm.getBalance(pk.toBase58()) ?? 0n); }
  acct(pk) { const a = this.svm.getAccount(pk.toBase58()); return a && a.exists ? a : null; }
  listing(pk) { return decodeListing(this.acct(pk).data); }
  token(pk, program = TOKEN) { return spl.unpackAccount(pk, this.web3Acct(pk), program); }
  web3Acct(pk) {
    const a = this.acct(pk);
    return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.programAddress) };
  }
  rent(len) { return this.svm.minimumBalanceForRentExemption(BigInt(len)); }
  now() { return this.svm.getClock().unixTimestamp; }
  warp(secs) {
    const c = this.svm.getClock();
    this.svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(secs)));
  }
  /** Overwrites an account: only for states tests cannot reach by transaction. */
  poke(pk, { lamports, data, owner, executable }) {
    const cur = this.acct(pk);
    this.svm.setAccount({
      address: pk.toBase58(),
      lamports: BigInt(lamports ?? cur?.lamports ?? 0n),
      data: data ?? cur?.data ?? new Uint8Array(0),
      programAddress: (owner ?? new PublicKey(cur?.programAddress ?? Sys)).toBase58(),
      executable: executable ?? cur?.executable ?? false,
      space: BigInt((data ?? cur?.data ?? new Uint8Array(0)).length),
      rentEpoch: 0n,
    });
  }
  mint({ program = TOKEN, decimals = 6, freezeAuthority = null, extensionIxs = null, extensions = [], metadataLen = 0 } = {}) {
    const auth = this.mintAuth ?? (this.mintAuth = this.wallet());
    const k = Keypair.generate();
    const space = extensions.length ? spl.getMintLen(extensions) : spl.MINT_SIZE;
    const lamports = Number(this.rent(space + metadataLen));
    const ixs = [SystemProgram.createAccount({ fromPubkey: this.payer.publicKey, newAccountPubkey: k.publicKey, lamports, space, programId: program })];
    if (extensionIxs) ixs.push(...extensionIxs(k.publicKey, auth.publicKey));
    ixs.push(spl.createInitializeMint2Instruction(k.publicKey, decimals, auth.publicKey, freezeAuthority, program));
    this.ok(ixs, [k]);
    return k.publicKey;
  }
  /** Associated token account for `owner`, minted `amount`. */
  ata(owner, mint, amount = 0n, program = TOKEN) {
    const a = spl.getAssociatedTokenAddressSync(mint, owner, true, program);
    if (!this.acct(a)) {
      this.ok(spl.createAssociatedTokenAccountInstruction(this.payer.publicKey, a, owner, mint, program));
    }
    if (amount > 0n) this.mintTo(mint, a, amount, program);
    return a;
  }
  /** A plain keypair token account anyone can open for `owner`. */
  freshTokenAccount(owner, mint, program = TOKEN, extensions = []) {
    const k = Keypair.generate();
    const space = spl.getAccountLen(extensions);
    this.ok([
      SystemProgram.createAccount({ fromPubkey: this.payer.publicKey, newAccountPubkey: k.publicKey, lamports: Number(this.rent(space)), space, programId: program }),
      spl.createInitializeAccount3Instruction(k.publicKey, mint, owner, program),
    ], [k]);
    return k.publicKey;
  }
  mintTo(mint, to, amount, program = TOKEN) {
    this.ok(spl.createMintToInstruction(mint, to, this.mintAuth.publicKey, amount, [], program), [this.mintAuth]);
  }
}

/** One live accept mode listing created by the server key. */
export function setupAccept({ amount = 1000n * UNIT, held, minBid = MIN, duration = 300n, window = WINDOW, program = TOKEN, env, mintOpts = {} } = {}) {
  const e = env ?? new Env();
  if (!e.bal(SERVER.publicKey)) e.svm.airdrop(SERVER.publicKey.toBase58(), 10n * BigInt(SOL));
  const seller = e.wallet();
  const mint = e.mint({ program, ...mintOpts });
  const tokenAccount = e.ata(seller.publicKey, mint, held ?? amount, program);
  const id = createHash("sha256").update(Keypair.generate().publicKey.toBuffer()).digest();
  const listing = acceptPda(id);
  e.ok(IX.createAccept({ server: SERVER.publicKey, id, seller: seller.publicKey, tokenAccount, mint, tokenProgram: program, amount, minBid, duration, window }), [SERVER]);
  return {
    e, seller, mint, tokenAccount, listing, id, vault: vaultPda(listing), amount, program,
    bid(bidder, lamports, prev) {
      return e.ok(IX.bid({ bidder: bidder.publicKey, listing, tokenAccount, mint, amount: lamports, expected: amount, prev: prev?.publicKey }), [bidder]);
    },
    bidIx(bidder, lamports, prev) {
      return IX.bid({ bidder: bidder.publicKey, listing, tokenAccount, mint, amount: lamports, expected: amount, prev: prev?.publicKey });
    },
    acceptIx(winner, bid, over = {}) {
      return IX.accept({ seller: seller.publicKey, listing, tokenAccount, mint, tokenProgram: program, rentReceiver: SERVER.publicKey,
        winnerToken: e.ata(winner, mint, 0n, program), amount, bid, ...over });
    },
    refundIx(topBidder) { return IX.refund({ listing, tokenAccount, topBidder }); },
    closeIx() { return IX.close({ listing, tokenAccount, seller: SERVER.publicKey }); },
  };
}

/** One live listing, ready to use. */
export function setup({ mode = 0, amount = 1000n * UNIT, price = MIN, duration = 300n, pass, program = TOKEN,
  held, mintOpts = {}, env } = {}) {
  const e = env ?? new Env();
  const seller = e.wallet();
  const mint = mintOpts.existing ?? e.mint({ program, ...mintOpts });
  const tokenAccount = e.ata(seller.publicKey, mint, held ?? amount, program);
  e.ok(IX.create({ seller: seller.publicKey, tokenAccount, mint, tokenProgram: program, mode, amount, price, duration, pass }), [seller]);
  const listing = listingPda(tokenAccount);
  const base = { e, seller, mint, tokenAccount, listing, vault: vaultPda(listing), amount, price, program };
  return {
    ...base,
    bid(bidder, lamports, prev, expected = amount) {
      return e.ok(IX.bid({ bidder: bidder.publicKey, listing, tokenAccount, mint, amount: lamports, expected, prev: prev?.publicKey ?? prev }), [bidder]);
    },
    settleIx(winner, winnerToken) {
      return IX.settle({ listing, seller: seller.publicKey, tokenAccount, mint, tokenProgram: program,
        winnerToken: winnerToken ?? e.ata(winner, mint, 0n, program) });
    },
    refundIx(topBidder) { return IX.refund({ listing, tokenAccount, topBidder }); },
    cancelIx(topBidder) { return IX.cancel({ seller: seller.publicKey, listing, tokenAccount, topBidder, tokenProgram: program }); },
    closeIx() { return IX.close({ listing, tokenAccount, seller: seller.publicKey }); },
    buyIx(buyer, buyerToken, over = {}) {
      return IX.buy({ buyer: buyer.publicKey, listing, seller: seller.publicKey, tokenAccount, mint, tokenProgram: program,
        buyerToken: buyerToken ?? e.ata(buyer.publicKey, mint, 0n, program), price, amount, ...over });
    },
  };
}
