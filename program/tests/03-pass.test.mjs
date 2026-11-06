import { test } from "node:test";
import { assert, Env, IX, MIN, UNIT, setup, xHash, passIx, passMessage, claimPda, Keypair, PublicKey, nacl, TransactionInstruction, Ed25519Program, spl } from "./helpers.mjs";

const ED = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Gated fixed listing whose campaign defaults to itself. */
function gated(over = {}) {
  const key = Keypair.generate();
  const c = setup({ mode: 1, duration: 0n, price: 2n * MIN, amount: 100n * UNIT, pass: { signer: key.publicKey, campaign: over.campaign }, ...over });
  const campaign = over.campaign ?? c.listing;
  const expiry = c.e.now() + 600n;
  const buyer = c.e.wallet();
  const hash = xHash("user-1");
  const buyIx = (o = {}) => IX.buyPass({
    buyer: (o.buyer ?? buyer).publicKey, listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint,
    buyerToken: c.e.ata((o.buyer ?? buyer).publicKey, c.mint), price: c.price, amount: c.amount,
    hash: o.hash ?? hash, expiry: o.expiry ?? expiry, signer: key.publicKey, campaign,
  });
  const verify = (o = {}) => passIx(o.key ?? key, o.campaign ?? campaign, (o.buyer ?? buyer).publicKey, o.hash ?? hash, o.expiry ?? expiry);
  return { ...c, key, campaign, expiry, buyer, hash, buyPassIx: buyIx, verify };
}

const untouched = (g) => {
  assert.ok(g.e.acct(g.listing), "listing still live");
  assert.equal(g.e.token(g.tokenAccount).amount, g.amount);
  assert.equal(g.e.acct(claimPda(g.key.publicKey, g.campaign, g.hash)), null, "no claim created");
};

test("pass: valid pass buys, buyer is the only transaction signer, claim is created", () => {
  const g = gated();
  const b0 = g.e.bal(g.buyer.publicKey);
  const r = g.e.send([g.verify(), g.buyPassIx()], [g.buyer], { payer: g.buyer });
  assert.ok(r.ok, r.err + (r.logs ?? []).join("\n"));
  assert.equal(g.e.token(g.e.ata(g.buyer.publicKey, g.mint)).amount, g.amount);
  const claim = claimPda(g.key.publicKey, g.campaign, g.hash);
  const claimRent = g.e.bal(claim);
  assert.ok(claimRent > 0n);
  assert.equal(g.e.bal(g.buyer.publicKey), b0 - 2n * MIN - claimRent - 2n * 5000n, "price + claim rent + fee with the precompile signature");
});

test("pass: second claim with the same X id hash fails, from any wallet, on any listing in the campaign", () => {
  const campaign = Keypair.generate().publicKey;
  const e = new Env();
  const key = Keypair.generate();
  const mk = () => setup({ env: e, mode: 1, duration: 0n, price: 2n * MIN, pass: { signer: key.publicKey, campaign } });
  const [a, b] = [mk(), mk()];
  const hash = xHash("same-x-account");
  const expiry = e.now() + 600n;
  const buy = (l, buyer) => [
    passIx(key, campaign, buyer.publicKey, hash, expiry),
    IX.buyPass({ buyer: buyer.publicKey, listing: l.listing, seller: l.seller.publicKey, tokenAccount: l.tokenAccount, mint: l.mint,
      buyerToken: e.ata(buyer.publicKey, l.mint), price: l.price, amount: l.amount, hash, expiry, signer: key.publicKey, campaign }),
  ];
  const [w1, w2] = [e.wallet(), e.wallet()];
  e.ok(buy(a, w1), [w1]);
  e.fails(buy(b, w2), [w2], "already in use"); // other wallet, same X id
  e.fails(buy(b, w1), [w1], "already in use"); // same wallet, same X id
  assert.ok(e.acct(b.listing), "second listing untouched");
  // A different X id is fine on the second listing.
  const h2 = xHash("other");
  e.ok([passIx(key, campaign, w2.publicKey, h2, expiry),
    IX.buyPass({ buyer: w2.publicKey, listing: b.listing, seller: b.seller.publicKey, tokenAccount: b.tokenAccount, mint: b.mint,
      buyerToken: e.ata(w2.publicKey, b.mint), price: b.price, amount: b.amount, hash: h2, expiry, signer: key.publicKey, campaign })], [w2]);
});

test("pass: pre-funding the claim address cannot block or poison it", () => {
  const g = gated();
  const claim = claimPda(g.key.publicKey, g.campaign, g.hash);
  g.e.poke(claim, { lamports: 5000n, owner: PublicKey.default });
  g.e.ok([g.verify(), g.buyPassIx()], [g.buyer]);
});

test("pass: forged signature is rejected by the precompile", () => {
  const g = gated();
  const v = g.verify();
  v.data[48] ^= 0xff; // first signature byte
  g.e.fails([v, g.buyPassIx()], [g.buyer]);
  untouched(g);
});

test("pass: expired", () => {
  const g = gated();
  const old = g.e.now() - 1n;
  g.e.fails([g.verify({ expiry: old }), g.buyPassIx({ expiry: old })], [g.buyer], "PassExpired");
  untouched(g);
});

test("pass: valid until the exact expiry second, not after", () => {
  const g = gated();
  g.e.warp(601);
  g.e.fails([g.verify(), g.buyPassIx()], [g.buyer], "PassExpired");
  const h = gated();
  h.e.warp(600);
  h.e.ok([h.verify(), h.buyPassIx()], [h.buyer]);
});

test("pass: claiming a later expiry than signed fails", () => {
  const g = gated();
  g.e.fails([g.verify(), g.buyPassIx({ expiry: g.expiry + 1n })], [g.buyer], "BadPass");
  untouched(g);
});

test("pass: wrong buyer: another wallet cannot use someone's pass", () => {
  const g = gated();
  const thief = g.e.wallet();
  g.e.fails([g.verify(), g.buyPassIx({ buyer: thief })], [thief], "BadPass");
  untouched(g);
});

test("pass: wrong listing: a pass for one listing fails on another", () => {
  const g = gated();
  const other = Keypair.generate().publicKey;
  g.e.fails([g.verify({ campaign: other }), g.buyPassIx()], [g.buyer], "BadPass");
  untouched(g);
});

test("pass: wrong X id hash: pass for one id cannot claim as another", () => {
  const g = gated();
  const h = xHash("someone-else");
  g.e.fails([g.verify(), g.buyPassIx({ hash: h })], [g.buyer], "BadPass");
});

test("pass: signed by the wrong key", () => {
  const g = gated();
  g.e.fails([g.verify({ key: Keypair.generate() }), g.buyPassIx()], [g.buyer], "BadPass");
  untouched(g);
});

test("pass: no ed25519 instruction at all", () => {
  const g = gated();
  g.e.fails(g.buyPassIx(), [g.buyer], "BadPass");
  untouched(g);
});

test("pass: verify instruction is not directly before the buy", () => {
  const g = gated();
  const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("x") });
  g.e.fails([g.verify(), memo, g.buyPassIx()], [g.buyer], "BadPass");
  untouched(g);
});

test("pass: verify instruction after the buy", () => {
  const g = gated();
  g.e.fails([g.buyPassIx(), g.verify()], [g.buyer], "BadPass");
  untouched(g);
});

/** Builds an ed25519 instruction by hand with chosen header fields. */
function rawEd25519(body, fields, num = 1) {
  const h = Buffer.alloc(16);
  h[0] = num;
  fields.forEach((v, i) => h.writeUInt16LE(v, 2 + i * 2));
  return new TransactionInstruction({ programId: ED, keys: [], data: Buffer.concat([h, body]) });
}

test("replay: ed25519 instruction points at another instruction's data", () => {
  const g = gated();
  const attacker = Keypair.generate();
  const message = passMessage(g.campaign, g.buyer.publicKey, g.hash, g.expiry);
  const sig = nacl.sign.detached(message, attacker.secretKey);
  // Instruction 0: a genuine verify by the attacker's key over the right message.
  const real = Ed25519Program.createInstructionWithPublicKey({ publicKey: attacker.publicKey.toBytes(), message, signature: sig });
  // Instruction 1: looks exactly like a pass (right key, right message in the
  // standard places), but every offset reads from instruction 0.
  const body = Buffer.concat([g.key.publicKey.toBuffer(), Buffer.alloc(64), message]);
  const fake = rawEd25519(body, [48, 0, 16, 0, 112, message.length, 0]);
  // Prove the precompile accepts this, so only the program's own check stands in the way.
  g.e.ok([real, fake], []);
  g.e.fails([real, fake, g.buyPassIx()], [g.buyer], "BadPass");
  untouched(g);
});

test("replay: pubkey offset points inside the message at a key the attacker controls", () => {
  const g = gated();
  const message = passMessage(g.campaign, g.buyer.publicKey, g.hash, g.expiry);
  const sig = nacl.sign.detached(message, g.buyer.secretKey); // signed by the buyer, not the pass key
  const body = Buffer.concat([g.key.publicKey.toBuffer(), Buffer.from(sig), message]);
  const buyerFieldAt = 112 + 16 + 32 + 32;
  const fake = rawEd25519(body, [48, 0xffff, buyerFieldAt, 0xffff, 112, message.length, 0xffff]);
  g.e.ok(fake, []); // the precompile is satisfied
  g.e.fails([fake, g.buyPassIx()], [g.buyer], "BadPass");
  untouched(g);
});

test("replay: signature offset and message offset moved within the instruction", () => {
  const g = gated();
  const attacker = Keypair.generate();
  const message = passMessage(g.campaign, g.buyer.publicKey, g.hash, g.expiry);
  const sig = nacl.sign.detached(message, attacker.secretKey);
  // Standard region holds the claim, real verified bytes sit after it.
  const tail = Buffer.concat([attacker.publicKey.toBuffer(), Buffer.from(sig), message]);
  const body = Buffer.concat([g.key.publicKey.toBuffer(), Buffer.alloc(64), message, tail]);
  const at = 16 + body.length - tail.length;
  const fake = rawEd25519(body, [at + 32, 0xffff, at, 0xffff, at + 96, message.length, 0xffff]);
  g.e.ok(fake, []);
  g.e.fails([fake, g.buyPassIx()], [g.buyer], "BadPass");
});

test("replay: two signatures in one verify instruction are refused", () => {
  const g = gated();
  const v = g.verify();
  const one = Buffer.from(v.data);
  // Same offsets twice, in the header area the second entry would use.
  const extra = one.subarray(2, 16);
  const data = Buffer.concat([Buffer.from([2, 0]), one.subarray(2, 16), extra, one.subarray(16)]);
  const shift = 14;
  for (const at of [2, 6, 10, 16, 20, 24]) data.writeUInt16LE(data.readUInt16LE(at) + shift, at);
  const fake = new TransactionInstruction({ programId: ED, keys: [], data });
  g.e.fails([fake, g.buyPassIx()], [g.buyer], "BadPass");
});

test("replay: a pass cannot be replayed in the same transaction", () => {
  const g = gated();
  g.e.fails([g.verify(), g.buyPassIx(), g.buyPassIx()], [g.buyer]);
  untouched(g);
});

test("a look-alike instruction from another program is not a verify", () => {
  const g = gated();
  const v = g.verify();
  const fake = new TransactionInstruction({ programId: MEMO, keys: [], data: v.data });
  g.e.fails([fake, g.buyPassIx()], [g.buyer]);
  untouched(g);
});

test("gated listing refuses the ungated buy, ungated listing refuses the gated buy", () => {
  const g = gated();
  g.e.fails(g.buyIx(g.buyer), [g.buyer], "PassRequired");
  const c = setup({ mode: 1, duration: 0n });
  const b = c.e.wallet();
  const key = Keypair.generate();
  const hash = xHash("u");
  const expiry = c.e.now() + 100n;
  c.e.fails([
    passIx(key, PublicKey.default, b.publicKey, hash, expiry),
    IX.buyPass({ buyer: b.publicKey, listing: c.listing, seller: c.seller.publicKey, tokenAccount: c.tokenAccount, mint: c.mint,
      buyerToken: c.e.ata(b.publicKey, c.mint), price: c.price, amount: c.amount, hash, expiry, signer: PublicKey.default, campaign: PublicKey.default }),
  ], [b], "PassNotUsed");
});

test("attack: a stranger's listing naming the same campaign cannot burn that campaign's claims", () => {
  const e = new Env();
  const serverKey = Keypair.generate();
  const campaign = Keypair.generate().publicKey;
  const official = setup({ env: e, mode: 1, duration: 0n, pass: { signer: serverKey.publicKey, campaign } });
  // Attacker's junk listing, same campaign id, attacker's own pass key.
  const attackerKey = Keypair.generate();
  const junk = setup({ env: e, mode: 1, duration: 0n, pass: { signer: attackerKey.publicKey, campaign } });
  const hash = xHash("victim");
  const expiry = e.now() + 600n;
  const attacker = e.wallet();
  e.ok([passIx(attackerKey, campaign, attacker.publicKey, hash, expiry),
    IX.buyPass({ buyer: attacker.publicKey, listing: junk.listing, seller: junk.seller.publicKey, tokenAccount: junk.tokenAccount, mint: junk.mint,
      buyerToken: e.ata(attacker.publicKey, junk.mint), price: junk.price, amount: junk.amount, hash, expiry, signer: attackerKey.publicKey, campaign })], [attacker]);
  // The real user with that X id still gets their deal.
  const victim = e.wallet();
  e.ok([passIx(serverKey, campaign, victim.publicKey, hash, expiry),
    IX.buyPass({ buyer: victim.publicKey, listing: official.listing, seller: official.seller.publicKey, tokenAccount: official.tokenAccount, mint: official.mint,
      buyerToken: e.ata(victim.publicKey, official.mint), price: official.price, amount: official.amount, hash, expiry, signer: serverKey.publicKey, campaign })], [victim]);
});

test("claim address derived with the wrong seeds is refused", () => {
  const g = gated();
  const wrongClaim = claimPda(g.key.publicKey, g.campaign, xHash("other"));
  const ix = IX.buyPass({ buyer: g.buyer.publicKey, listing: g.listing, seller: g.seller.publicKey, tokenAccount: g.tokenAccount, mint: g.mint,
    buyerToken: g.e.ata(g.buyer.publicKey, g.mint), price: g.price, amount: g.amount, hash: g.hash, expiry: g.expiry, signer: g.key.publicKey, campaign: g.campaign, claim: wrongClaim });
  g.e.fails([g.verify(), ix], [g.buyer], "ConstraintSeeds");
});

test("the pass key alone moves nothing: a pass still needs the buyer's signature and the buyer's SOL", () => {
  const g = gated();
  const ix = g.buyPassIx();
  ix.keys[0].isSigner = false;
  const b0 = g.e.bal(g.buyer.publicKey);
  g.e.fails([g.verify(), ix], []);
  assert.equal(g.e.bal(g.buyer.publicKey), b0);
  untouched(g);
  // The key holder naming themselves as buyer pays the full price from their own wallet.
  const holder = g.e.wallet();
  const h0 = g.e.bal(holder.publicKey);
  g.e.ok([g.verify({ buyer: holder }), g.buyPassIx({ buyer: holder })], [holder]);
  const rent = g.e.bal(claimPda(g.key.publicKey, g.campaign, g.hash));
  assert.equal(g.e.bal(holder.publicKey), h0 - g.price - rent);
});
