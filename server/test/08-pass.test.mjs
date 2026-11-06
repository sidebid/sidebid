import test from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import { createHash } from 'node:crypto'
import { Ed25519Program, Transaction, PublicKey } from '@solana/web3.js'
import { world, seller, listingFixture, Keypair, chainListing, flagsOn, tag, readerStep, bid, spl } from './harness.mjs'
import { tagListingId } from '../src/chain/program.mjs'

/** A fixed deal naming the server's pass key, its campaign registered by the admin, and a buyer with a linked wallet. */
function deal(w, { xId = '50', username = 'buyer', sharedCampaign = null, register = true } = {}) {
  const s = seller(w, { xId: `s${Math.random()}`, username: 'dev' })
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, mode: 1, amount: 100_000n, price: 2_000_000n, duration: 0n, pass: { signer: w.config.passKey.publicKey, campaign: sharedCampaign } })
  const l = chainListing(w, listing)
  if (register) w.app.pass.addCampaign(l.campaign.toBase58(), 'test')
  const buyer = seller(w, { xId, username, mint: s.mint, amount: 0n })
  const user = w.db.get('SELECT * FROM x_users WHERE x_id=?', xId)
  return { s, listing, l, buyer, user }
}
function buyTx(w, d, pass, buyerKp = d.buyer.kp) {
  const l = chainListing(w, d.listing)
  const verify = Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(pass.signer).toBytes(), message: Buffer.from(pass.message, 'base64'), signature: Buffer.from(pass.signature, 'base64') })
  assert.equal(Buffer.from(verify.data).toString('base64'), pass.ed25519Data, 'server built the verify data the same way')
  const buyerToken = d.buyer.tokenAccount
  return [verify, w.app.prog.ix.buyWithPass(l, buyerKp.publicKey, buyerToken, Buffer.from(pass.xIdHash, 'hex'), pass.expiry)]
}
const failsWith = (fn, word) => { try { fn() } catch (e) { const t = `${e.message} ${(e.logs ?? []).join(' ')}`; assert.ok(t.includes(word), `wanted ${word}, got ${t.slice(0, 400)}`); return } assert.fail(`expected refusal: ${word}`) }
const issue = (w, d, o = {}) => w.app.pass.issue({ user: d.user, listing: d.listing.toBase58(), wallet: d.buyer.kp.publicKey.toBase58(), ...o })

test('message layout is the contract\'s, and a real buy lands with the buyer as the only signer', async () => {
  const w = world(); const d = deal(w)
  const p = await issue(w, d)
  assert.equal(p.ok, true)
  const m = Buffer.from(p.message, 'base64')
  assert.equal(m.length, 152)
  assert.equal(m.subarray(0, 16).toString(), 'SIDEBID_PASS_V1\0')
  assert.ok(m.subarray(16, 48).equals(w.config.programId.toBuffer()))
  assert.ok(m.subarray(48, 80).equals(d.l.campaign.toBuffer()))
  assert.ok(m.subarray(80, 112).equals(d.buyer.kp.publicKey.toBuffer()))
  assert.equal(m.subarray(112, 144).toString('hex'), p.xIdHash)
  assert.equal(m.readBigInt64LE(144), BigInt(p.expiry))
  assert.ok(nacl.sign.detached.verify(m, Buffer.from(p.signature, 'base64'), w.config.passKey.publicKey.toBytes()))
  const sellerBefore = w.conn.bal(d.s.kp.publicKey)
  const tx = new Transaction({ recentBlockhash: w.conn.svm.latestBlockhash(), feePayer: d.buyer.kp.publicKey }).add(...buyTx(w, d, p))
  tx.sign(d.buyer.kp)
  assert.equal(tx.signatures.length, 1, 'buyer is the only signer')
  w.conn.apply(tx.serialize())
  assert.equal(w.conn.tokenAmount(d.buyer.tokenAccount), 100_000n)
  assert.ok(w.conn.bal(d.s.kp.publicKey) >= sellerBefore + 2_000_000n)
  assert.equal(w.conn.info(d.listing), null)
})
test('the X id hash is keyed: a plain hash and another key give something else, same input is stable', () => {
  const w = world(); const h = w.app.pass.xHash('12345')
  assert.notEqual(h.toString('hex'), createHash('sha256').update('x:12345').digest('hex'))
  assert.notEqual(h.toString('hex'), createHash('sha256').update('12345').digest('hex'))
  const w2 = world({ env: { PASS_HASH_KEY: 'z'.repeat(40) } })
  assert.notEqual(h.toString('hex'), w2.app.pass.xHash('12345').toString('hex'))
  assert.equal(h.toString('hex'), w.app.pass.xHash('12345').toString('hex'))
  assert.equal(h.length, 32)
})
test('pass replay: the same pass twice fails on chain', async () => {
  const w = world(); const shared = Keypair.generate().publicKey
  const d = deal(w, { sharedCampaign: shared })
  const p = await issue(w, d)
  w.conn.send(buyTx(w, d, p), d.buyer.kp)
  // A second listing in the same campaign: same X id, same pass
  const d2s = seller(w, { xId: 's2', username: 'dev2' })
  const l2 = listingFixture(w, { sellerKp: d2s.kp, tokenAccount: d2s.tokenAccount, mint: d2s.mint, mode: 1, amount: 100_000n, price: 2_000_000n, duration: 0n, pass: { signer: w.config.passKey.publicKey, campaign: shared } })
  const buyerToken2 = w.conn.ata(d.buyer.kp.publicKey, d2s.mint)
  const replay = () => { const l = chainListing(w, l2); w.conn.svm.expireBlockhash(); w.conn.send([Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(p.signer).toBytes(), message: Buffer.from(p.message, 'base64'), signature: Buffer.from(p.signature, 'base64') }), w.app.prog.ix.buyWithPass(l, d.buyer.kp.publicKey, buyerToken2, Buffer.from(p.xIdHash, 'hex'), p.expiry)], d.buyer.kp) }
  failsWith(replay, 'already in use')
  assert.ok(w.conn.info(l2), 'second listing untouched')
})
test('one per X account: a second wallet of the same X id fails on chain, and the server refuses first', async () => {
  const w = world(); const shared = Keypair.generate().publicKey
  const d = deal(w, { sharedCampaign: shared })
  const p = await issue(w, d)
  assert.equal((await issue(w, d)).ok, true, 'the same wallet may ask again before it is used')
  w.conn.send(buyTx(w, d, p), d.buyer.kp)
  const already = await w.app.pass.issue({ user: d.user, campaign: shared.toBase58(), wallet: d.buyer.kp.publicKey.toBase58() })
  assert.deepEqual([already.ok, already.why], [false, 'already_claimed'])
  // Say the X account changed wallet, or the server was fooled: a validly signed pass for a new wallet with the same X id
  const other = seller(w, { xId: 's9', username: 'dev9' })
  const l2 = listingFixture(w, { sellerKp: other.kp, tokenAccount: other.tokenAccount, mint: other.mint, mode: 1, amount: 5n, price: 2_000_000n, duration: 0n, pass: { signer: w.config.passKey.publicKey, campaign: shared } })
  const wallet2 = w.conn.wallet(), token2 = w.conn.ata(wallet2.publicKey, other.mint), hash = w.app.pass.xHash(d.user.x_id), expiry = w.conn.now() + 60
  const { message, signature } = w.app.pass.sign(shared, wallet2.publicKey, hash, expiry)
  failsWith(() => w.conn.send([Ed25519Program.createInstructionWithPublicKey({ publicKey: w.config.passKey.publicKey.toBytes(), message, signature }), w.app.prog.ix.buyWithPass(chainListing(w, l2), wallet2.publicKey, token2, hash, expiry)], wallet2), 'already in use')
  // A different X id in the same campaign is fine
  const d3 = seller(w, { xId: '53', username: 'b4', mint: other.mint, amount: 0n })
  const p3 = await w.app.pass.issue({ user: w.db.get('SELECT * FROM x_users WHERE x_id=?', '53'), campaign: shared.toBase58(), wallet: d3.kp.publicKey.toBase58() })
  assert.equal(p3.ok, true)
  w.conn.send([Ed25519Program.createInstructionWithPublicKey({ publicKey: w.config.passKey.publicKey.toBytes(), message: Buffer.from(p3.message, 'base64'), signature: Buffer.from(p3.signature, 'base64') }), w.app.prog.ix.buyWithPass(chainListing(w, l2), d3.kp.publicKey, d3.tokenAccount, Buffer.from(p3.xIdHash, 'hex'), p3.expiry)], d3.kp)
  assert.equal(w.conn.tokenAmount(d3.tokenAccount), 5n)
})
test('a server pass only works where the listing named the server key; a forged signer fails', async () => {
  const w = world(); const d = deal(w)
  const fake = Keypair.generate(), hash = w.app.pass.xHash('50'), expiry = w.conn.now() + 60
  const message = w.app.prog.passMessage(d.l.campaign, d.buyer.kp.publicKey, hash, expiry)
  const verify = Ed25519Program.createInstructionWithPublicKey({ publicKey: fake.publicKey.toBytes(), message, signature: nacl.sign.detached(message, fake.secretKey) })
  failsWith(() => w.conn.send([verify, w.app.prog.ix.buyWithPass(d.l, d.buyer.kp.publicKey, d.buyer.tokenAccount, hash, expiry)], d.buyer.kp), 'BadPass')
})
test('pass bound to its buyer: another wallet using it fails on chain', async () => {
  const w = world(); const d = deal(w); const p = await issue(w, d)
  const thief = w.conn.wallet(), thiefToken = w.conn.ata(thief.publicKey, d.s.mint)
  const l = chainListing(w, d.listing)
  const verify = Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(p.signer).toBytes(), message: Buffer.from(p.message, 'base64'), signature: Buffer.from(p.signature, 'base64') })
  failsWith(() => w.conn.send([verify, w.app.prog.ix.buyWithPass(l, thief.publicKey, thiefToken, Buffer.from(p.xIdHash, 'hex'), p.expiry)], thief), 'BadPass')
  assert.ok(w.conn.info(d.listing))
})
test('expired pass fails on chain', async () => {
  const w = world(); const d = deal(w); const p = await issue(w, d)
  w.conn.warp(w.config.passTtlSeconds + 1)
  failsWith(() => w.conn.send(buyTx(w, d, p), d.buyer.kp), 'PassExpired')
  assert.ok(w.conn.info(d.listing))
})
test('server refusals: unknown campaign, wrong signer, wrong wallet, no wallet, failed read; no follower minimum', async () => {
  const w = world(); const d = deal(w, { register: false })
  assert.equal((await issue(w, d)).why, 'unknown_campaign')
  w.app.pass.addCampaign(d.l.campaign.toBase58())
  assert.equal((await issue(w, d, { wallet: Keypair.generate().publicKey.toBase58() })).why, 'not_your_linked_wallet')
  w.db.run('UPDATE x_users SET followers=0 WHERE x_id=?', d.user.x_id)
  assert.notEqual((await issue(w, d, { user: w.db.get('SELECT * FROM x_users WHERE x_id=?', d.user.x_id) })).why, 'not_eligible', 'no follower minimum on passes')
  w.db.run('UPDATE x_users SET followers=99 WHERE x_id=?', d.user.x_id)
  w.app.auth.upsertUser({ xId: 'nowallet', handle: 'n', xCreatedAt: w.now() - 400 * 86400000, followers: 50 })
  assert.equal((await issue(w, d, { user: w.db.get('SELECT * FROM x_users WHERE x_id=?', 'nowallet') })).why, 'no_wallet')
  assert.equal((await issue(w, d, { listing: Keypair.generate().publicKey.toBase58() })).why, 'no_listing')
  assert.equal((await issue(w, d, { listing: 'not an address' })).why, 'bad_address')
  const other = seller(w, { xId: 'o', username: 'o' })
  const foreign = listingFixture(w, { sellerKp: other.kp, tokenAccount: other.tokenAccount, mint: other.mint, mode: 1, amount: 1n, price: 2_000_000n, duration: 0n, pass: { signer: Keypair.generate().publicKey } })
  assert.equal((await issue(w, d, { listing: foreign.toBase58() })).why, 'listing_uses_another_signer')
  w.conn.inject('accounts', () => { throw new Error('502') })
  assert.deepEqual([(await issue(w, d)).why, (await issue(w, d)).code], ['chain_read_failed', 503], 'a failed read issues nothing')
  w.conn.clear('accounts')
})
test('the pass key cannot move anything: unfunded, never a transaction signer, and every money path refuses it', async () => {
  const w = world(); const d = deal(w); const k = w.config.passKey
  assert.equal(w.conn.bal(k.publicKey), 0n, 'holds no SOL')
  w.conn.svm.airdrop(k.publicKey.toBase58(), 1_000_000_000n) // even if someone funds it
  const l = chainListing(w, d.listing)
  failsWith(() => w.conn.send(w.app.prog.ix.accept({ ...l, seller: k.publicKey, topBid: 0n, topBidder: k.publicKey }, d.s.tokenAccount, d.buyer.tokenAccount), k), 'Simulation failed')
  failsWith(() => w.conn.send(spl.createTransferInstruction(d.s.tokenAccount, d.buyer.tokenAccount, k.publicKey, 1n), k), 'Simulation failed')
  assert.equal(w.conn.tokenAmount(d.s.tokenAccount), 1_000_000_000n, 'untouched')
})
test('the listing key cannot move anything: a real card made with it gives no way to take tokens or bids', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive')
  const s = seller(w), key = w.config.listingKey
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 1m`); await readerStep(w)
  const pub = w.app.prog.acceptPda(tagListingId(id)), bidder = w.conn.wallet()
  bid(w, pub, bidder, 3_000_000n); w.conn.warp(60)
  const l = chainListing(w, pub), own = w.conn.ata(key.publicKey, s.mint)
  failsWith(() => w.conn.send(w.app.prog.ix.accept({ ...l, seller: key.publicKey }, s.tokenAccount, own), key), 'NotSeller')
  failsWith(() => w.conn.send(spl.createTransferInstruction(s.tokenAccount, own, key.publicKey, 1n), key), 'Simulation failed')
  assert.equal(spl.unpackAccount(s.tokenAccount, w.conn.info(s.tokenAccount)).delegate, null, 'a tagged card gives no delegate')
  assert.equal(w.conn.tokenAmount(own), 0n)
  // The contract's suite tests/04-accept walks every other path ("server key: every path to funds or tokens is refused")
})
test('config refuses the same key for two jobs, a short hash key, and a listing key that does not match', () => {
  const w = world()
  const base = { ...w.env }
  assert.throws(() => world({ env: { KEEPER_SECRET: base.LISTING_SECRET } }), /must be different/)
  assert.throws(() => world({ env: { PASS_HASH_KEY: 'short' } }), /PASS_HASH_KEY/)
  assert.throws(() => world({ env: { LISTING_PUBKEY_EXPECTED: Keypair.generate().publicKey.toBase58() } }), /does not match/)
  assert.throws(() => world({ env: { KEEPER_SECRET: 'not a key!!' } }), (e) => /KEEPER_SECRET/.test(e.message) && !e.message.includes('not a key'))
})
