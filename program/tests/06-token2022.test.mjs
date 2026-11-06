import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, T22, TOKEN, SERVER, acceptPda, listingPda, setup, spl, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "./helpers.mjs";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";

test("Token 2022 numbering: the allow list means what the comments say", () => {
  const E = spl.ExtensionType;
  assert.deepEqual([E.MetadataPointer, E.TokenMetadata, E.GroupPointer, E.TokenGroup, E.GroupMemberPointer, E.TokenGroupMember], [18, 19, 20, 21, 22, 23]);
});

test("Token 2022 plain mint: bidding, settle, fixed buy, cancel, refund all work", () => {
  const c = setup({ program: T22 });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  c.e.warp(300);
  const wt = c.e.ata(w.publicKey, c.mint, 0n, T22);
  c.e.ok(c.settleIx(w.publicKey, wt));
  assert.equal(c.e.token(wt, T22).amount, c.amount);

  const f = setup({ program: T22, mode: 1, duration: 0n });
  const b = f.e.wallet();
  f.e.ok(f.buyIx(b), [b]);

  const g = setup({ program: T22 });
  const x = g.e.wallet();
  g.bid(x, 2n * MIN);
  g.e.ok(g.cancelIx(x.publicKey), [g.seller]);
  assert.equal(g.e.token(g.tokenAccount, T22).delegate, null);

  const h = setup({ program: T22 });
  const y = h.e.wallet();
  h.bid(y, 2n * MIN);
  h.e.ok(spl.createRevokeInstruction(h.tokenAccount, h.seller.publicKey, [], T22), [h.seller]);
  h.e.ok(h.refundIx(y.publicKey));
  assert.equal(h.e.listing(h.listing).state, 1);
});

test("Token 2022 mint with metadata pointer and metadata (how pump.fun coins are made) works", () => {
  const e = new Env();
  const k = Keypair.generate();
  const auth = e.mintAuth = e.wallet();
  const meta = { mint: k.publicKey, name: "Test", symbol: "TST", uri: "https://example.com/a.json", additionalMetadata: [], updateAuthority: auth.publicKey };
  const space = spl.getMintLen([spl.ExtensionType.MetadataPointer]);
  const metaLen = spl.TYPE_SIZE + spl.LENGTH_SIZE + pack(meta).length;
  e.ok([
    SystemProgram.createAccount({ fromPubkey: e.payer.publicKey, newAccountPubkey: k.publicKey, lamports: Number(e.rent(space + metaLen)), space, programId: T22 }),
    spl.createInitializeMetadataPointerInstruction(k.publicKey, auth.publicKey, k.publicKey, T22),
    spl.createInitializeMint2Instruction(k.publicKey, 6, auth.publicKey, null, T22),
    createInitializeInstruction({ programId: T22, metadata: k.publicKey, updateAuthority: auth.publicKey, mint: k.publicKey, mintAuthority: auth.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri }),
  ], [k, auth]);
  const c = setup({ env: e, program: T22, mintOpts: { existing: k.publicKey } });
  const w = e.wallet();
  c.bid(w, 2n * MIN);
  e.warp(300);
  const wt = e.ata(w.publicKey, c.mint, 0n, T22);
  e.ok(c.settleIx(w.publicKey, wt));
  assert.equal(e.token(wt, T22).amount, c.amount);
});

const E = spl.ExtensionType;
const bad = {
  "transfer fee": [[E.TransferFeeConfig], (m, a) => [spl.createInitializeTransferFeeConfigInstruction(m, a, a, 100, 1000n, T22)]],
  "transfer hook": [[E.TransferHook], (m, a) => [spl.createInitializeTransferHookInstruction(m, a, Keypair.generate().publicKey, T22)]],
  "permanent delegate": [[E.PermanentDelegate], (m, a) => [spl.createInitializePermanentDelegateInstruction(m, a, T22)]],
  "non transferable": [[E.NonTransferable], (m) => [spl.createInitializeNonTransferableMintInstruction(m, T22)]],
  "mint close authority": [[E.MintCloseAuthority], (m, a) => [spl.createInitializeMintCloseAuthorityInstruction(m, a, T22)]],
  "interest bearing": [[E.InterestBearingConfig], (m, a) => [spl.createInitializeInterestBearingMintInstruction(m, a, 10, T22)]],
  "default frozen": [[E.DefaultAccountState], (m) => [spl.createInitializeDefaultAccountStateInstruction(m, spl.AccountState.Frozen, T22)]],
  "default initialized (still refused, can be switched)": [[E.DefaultAccountState], (m) => [spl.createInitializeDefaultAccountStateInstruction(m, spl.AccountState.Initialized, T22)]],
  "pausable": [[E.PausableConfig ?? E.Pausable], (m, a) => [spl.createInitializePausableConfigInstruction(m, a, T22)]],
};

for (const [name, [extensions, extensionIxs]] of Object.entries(bad)) {
  test(`Token 2022 mint with ${name} is refused at listing`, () => {
    const e = new Env();
    const seller = e.wallet();
    const mint = e.mint({ program: T22, extensions, extensionIxs, freezeAuthority: name.startsWith("default") ? e.wallet().publicKey : null });
    // Open the account directly: a default frozen account cannot receive mints here, and the check comes first anyway.
    const tokenAccount = e.ata(seller.publicKey, mint, 0n, T22);
    let held = 100n;
    if (name === "default frozen") held = 0n;
    else e.mintTo(mint, tokenAccount, 100n, T22);
    const r = e.send(IX.create({ seller: seller.publicKey, tokenAccount, mint, tokenProgram: T22, amount: 100n, price: MIN, duration: 60n }), [seller]);
    assert.ok(!r.ok);
    const text = r.logs.join("\n");
    assert.ok(text.includes(held ? "UnsupportedMintExtension" : "InsufficientTokens"), text);
  });
}

test("token program mismatch: classic mint named with Token 2022 and the reverse", () => {
  const e = new Env();
  const seller = e.wallet();
  const classic = e.mint();
  const t = e.ata(seller.publicKey, classic, 10n);
  e.fails(IX.create({ seller: seller.publicKey, tokenAccount: t, mint: classic, tokenProgram: T22, amount: 10n, price: MIN, duration: 60n }), [seller]);
  const m22 = e.mint({ program: T22 });
  const t22 = e.ata(seller.publicKey, m22, 10n, T22);
  e.fails(IX.create({ seller: seller.publicKey, tokenAccount: t22, mint: m22, tokenProgram: TOKEN, amount: 10n, price: MIN, duration: 60n }), [seller]);
});

function withMemoRequired(e, owner, mint) {
  const account = e.freshTokenAccount(owner.publicKey, mint, T22, [E.MemoTransfer]);
  e.ok(spl.createEnableRequiredMemoTransfersInstruction(account, owner.publicKey, [], T22), [owner]);
  return account;
}

test("winner blocks their own account with required memos: a fresh account finishes the sale", () => {
  const c = setup({ program: T22 });
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const blocked = withMemoRequired(c.e, w, c.mint);
  c.e.warp(300);
  c.e.fails(c.settleIx(w.publicKey, blocked), []);
  const fresh = c.e.freshTokenAccount(w.publicKey, c.mint, T22); // anyone can open this, no winner signature
  c.e.ok(c.settleIx(w.publicKey, fresh));
  assert.equal(c.e.token(fresh, T22).amount, c.amount);
});

test("winner hands their ATA to someone else: a fresh account finishes the sale", () => {
  const c = setup();
  const w = c.e.wallet();
  c.bid(w, 2n * MIN);
  const ata = c.e.ata(w.publicKey, c.mint);
  c.e.ok(spl.createSetAuthorityInstruction(ata, w.publicKey, spl.AuthorityType.AccountOwner, c.e.wallet().publicKey), [w]);
  c.e.warp(300);
  c.e.fails(c.settleIx(w.publicKey, ata), [], "ConstraintTokenOwner");
  const fresh = c.e.freshTokenAccount(w.publicKey, c.mint);
  c.e.ok(c.settleIx(w.publicKey, fresh));
});

/** A seller's associated token account with CPI guard space added, the way a wallet would. */
function guardedAta(e, mint) {
  const seller = e.wallet();
  const tokenAccount = e.ata(seller.publicKey, mint, 100n, T22);
  e.ok(spl.createReallocateInstruction(tokenAccount, e.payer.publicKey, [E.CpiGuard], seller.publicKey, [], T22), [seller]);
  return { seller, tokenAccount, listing: listingPda(tokenAccount) };
}

test("seller turns on CPI guard after listing: delegate settle and cancel still work", () => {
  const e = new Env();
  e.mintAuth = e.wallet();
  const mint = e.mint({ program: T22 });
  const mk = () => {
    const g = guardedAta(e, mint);
    e.ok(IX.create({ seller: g.seller.publicKey, tokenAccount: g.tokenAccount, mint, tokenProgram: T22, amount: 100n, price: MIN, duration: 60n }), [g.seller]);
    e.ok(spl.createEnableCpiGuardInstruction(g.tokenAccount, g.seller.publicKey, [], T22), [g.seller]);
    return g;
  };
  const a = mk();
  const w = e.wallet();
  e.ok(IX.bid({ bidder: w.publicKey, listing: a.listing, tokenAccount: a.tokenAccount, mint, amount: 2n * MIN, expected: 100n }), [w]);
  const b = mk();
  e.ok(IX.cancel({ seller: b.seller.publicKey, listing: b.listing, tokenAccount: b.tokenAccount, tokenProgram: T22 }), [b.seller]);
  assert.equal(e.token(b.tokenAccount, T22).delegate, null);
  // With the guard already on, listing fails cleanly: approve is not allowed in a CPI.
  e.fails(IX.create({ seller: b.seller.publicKey, tokenAccount: b.tokenAccount, mint, tokenProgram: T22, amount: 100n, price: MIN, duration: 60n }), [b.seller], "CPI");
  e.warp(60);
  const wt = e.ata(w.publicKey, mint, 0n, T22);
  e.ok(IX.settle({ listing: a.listing, seller: a.seller.publicKey, tokenAccount: a.tokenAccount, mint, winnerToken: wt, tokenProgram: T22 }));
  assert.equal(e.token(wt, T22).amount, 100n);
});

test("accept mode with CPI guard on the seller's account: accept is blocked, refund after the window still pays", () => {
  const e = new Env();
  e.svm.airdrop(SERVER.publicKey.toBase58(), 1_000_000_000n);
  const mint = e.mint({ program: T22 });
  const { seller, tokenAccount } = guardedAta(e, mint);
  e.ok(spl.createEnableCpiGuardInstruction(tokenAccount, seller.publicKey, [], T22), [seller]);
  const id = Keypair.generate().publicKey.toBuffer();
  e.ok(IX.createAccept({ server: SERVER.publicKey, id, seller: seller.publicKey, tokenAccount, mint, tokenProgram: T22, amount: 100n }), [SERVER]);
  const listing = acceptPda(id);
  const w = e.wallet();
  const w0 = e.bal(w.publicKey);
  e.ok(IX.bid({ bidder: w.publicKey, listing, tokenAccount, mint, amount: 2n * MIN, expected: 100n }), [w]);
  e.warp(300);
  const wt = e.ata(w.publicKey, mint, 0n, T22);
  e.fails(IX.accept({ seller: seller.publicKey, listing, tokenAccount, mint, winnerToken: wt, rentReceiver: SERVER.publicKey, amount: 100n, bid: 2n * MIN, tokenProgram: T22 }), [seller], "CPI");
  e.warp(600);
  e.ok(IX.refund({ listing, tokenAccount, topBidder: w.publicKey }));
  assert.equal(e.bal(w.publicKey), w0);
});
