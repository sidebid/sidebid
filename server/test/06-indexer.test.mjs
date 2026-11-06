import test from 'node:test'
import assert from 'node:assert/strict'
import { world, seller, tag, readerStep, flagsOn, bid, listingFixture, Keypair, spl, chainListing, SO } from './harness.mjs'
import { parseEvents, tagListingId, IDL } from '../src/chain/program.mjs'
import { readFileSync } from 'node:fs'

async function bidding(w, o = {}) {
  const s = seller(w, o)
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, amount: o.listAmount ?? 1_000_000n, duration: o.duration ?? 60n })
  return { s, listing }
}

test('the IDL is the contract\'s, byte for byte', () => {
  assert.deepEqual(readFileSync(new URL('../idl/sidebid.json', import.meta.url)), readFileSync(new URL('../../program/idl/sidebid.json', import.meta.url)))
})
test('event parser: only believes data printed by this program, at the right depth', () => {
  const me = IDL.address, other = 'Evi1111111111111111111111111111111111111111'
  const fake = Buffer.concat([Buffer.from(IDL.events.find((e) => e.name === 'Cancelled').discriminator), Keypair.generate().publicKey.toBuffer(), Buffer.alloc(8)]).toString('base64')
  const pid = { toBase58: () => me }
  assert.equal(parseEvents([`Program ${me} invoke [1]`, `Program data: ${fake}`, `Program ${me} success`], pid).length, 1)
  assert.equal(parseEvents([`Program ${other} invoke [1]`, `Program data: ${fake}`, `Program ${other} success`], pid).length, 0, 'another program')
  assert.equal(parseEvents([`Program ${me} invoke [1]`, `Program ${other} invoke [2]`, `Program data: ${fake}`, `Program ${other} success`, `Program ${me} success`], pid).length, 0, 'a called program')
  assert.equal(parseEvents([`Program ${other} invoke [1]`, `Program ${me} invoke [2]`, `Program ${me} success`, `Program data: ${fake}`, `Program ${other} success`], pid).length, 0, 'after we returned')
  assert.equal(parseEvents([`Program ${me} invoke [1]`, 'Program data: AAAA', 'Program data: !!!!', `Program ${me} success`], pid).length, 0, 'garbage')
  assert.deepEqual(parseEvents(null, pid), [])
})
test('finds listings and follows bids from events, with batched reads', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  const cached = () => w.db.get('SELECT * FROM listings WHERE pubkey=?', listing.toBase58())
  assert.equal(cached().mode, 'bidding'); assert.equal(cached().top_bid, '0'); assert.equal(cached().closed, 0)
  const b = w.conn.wallet()
  bid(w, listing, b, 5_000_000n)
  await w.app.indexer.tick()
  assert.equal(cached().top_bid, '5000000'); assert.equal(cached().top_bidder, b.publicKey.toBase58())
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n, 1)
  const calls = w.app.rpc.stats.calls.getSignaturesForAddress
  await w.app.indexer.tick()
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n, 1, 'cursor holds, nothing replayed')
  assert.equal(w.app.rpc.stats.calls.getSignaturesForAddress, calls + 1)
})
test('chain is the truth: a wrong cache row is overwritten, a phantom row is closed', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  w.db.run(`UPDATE listings SET top_bid='999999', amount='1' WHERE pubkey=?`, listing.toBase58())
  const phantom = Keypair.generate().publicKey.toBase58()
  w.db.run(`INSERT INTO listings (pubkey,mode,state,top_bid,end_time,closed,chain_read_at) VALUES ('${phantom}','bidding','live','0',0,0,0)`)
  await w.app.indexer.reconcile()
  const r = w.db.get('SELECT * FROM listings WHERE pubkey=?', listing.toBase58())
  assert.deepEqual([r.top_bid, r.amount], ['0', '1000000'])
  assert.equal(w.db.get('SELECT closed FROM listings WHERE pubkey=?', phantom).closed, 1)
})
test('rebuild from nothing on restart: live state, history and cursor all come back from chain', async () => {
  const w = world(); flagsOn(w, 'keeperLive')
  const a = await bidding(w); const b = await bidding(w, { xId: '2', username: 'two', duration: 3000n })
  const winner = w.conn.wallet()
  bid(w, a.listing, winner, 7_000_000n); bid(w, b.listing, w.conn.wallet(), 3_000_000n)
  await w.app.indexer.rebuild()
  w.conn.warp(61)
  await w.app.keeper.tick()
  await w.app.indexer.tick()
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM sales`).n, 1)
  const before = w.app.listings.list({}).items.map((v) => [v.pubkey, v.phase, v.topBid]).sort()
  await w.app.indexer.rebuild({ fresh: true })
  const after = w.app.listings.list({}).items.map((v) => [v.pubkey, v.phase, v.topBid]).sort()
  assert.deepEqual(after, before)
  const sale = w.db.get('SELECT * FROM sales')
  assert.equal(sale.winner, winner.publicKey.toBase58()); assert.equal(sale.price, '7000000'); assert.equal(sale.mint, a.s.mint.toBase58()); assert.equal(sale.decimals, 6)
  assert.equal(w.app.listings.list({ phase: 'sold' }).items[0].pubkey, a.listing.toBase58())
})
test('a failed read changes nothing: no listing goes closed on RPC errors', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  w.conn.inject('gpa', () => { throw new Error('503') })
  await assert.rejects(w.app.indexer.reconcile())
  w.conn.inject('accounts', () => { throw new Error('502') }); w.conn.inject('sigs', () => { throw new Error('502') })
  w.app.indexer.touch(listing)
  await w.app.indexer.tick()
  assert.ok(w.app.indexer.status.lastError)
  assert.equal(w.db.get('SELECT closed FROM listings WHERE pubkey=?', listing.toBase58()).closed, 0)
  w.clock.skew += 3000 // past the card's freshness window, so it must try the chain
  const card = await w.app.listings.one(listing.toBase58())
  assert.deepEqual([card.stale, card.closed, card.phase], [true, false, 'live'], 'the card still shows, marked stale')
  w.conn.clear('gpa'); w.conn.clear('accounts'); w.conn.clear('sigs')
  w.clock.skew += 3000
  await w.app.indexer.tick()
  assert.equal(w.app.indexer.status.lastError, null)
  assert.equal((await w.app.listings.one(listing.toBase58())).stale, false)
})
test('a transaction not visible yet holds the cursor there, and nothing is skipped', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.tick()
  const b = w.conn.wallet()
  bid(w, listing, b, 5_000_000n)
  const real = w.conn.getTransactions.bind(w.conn)
  w.conn.getTransactions = async () => [null]
  await w.app.indexer.catchUp()
  w.conn.getTransactions = real
  await w.app.indexer.catchUp()
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n, 1)
})
test('a snapshot older than a fresh read does not close a new card', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  const realGpa = w.conn.getProgramAccounts.bind(w.conn)
  w.conn.getProgramAccounts = async () => []
  w.clock.skew += 1000
  await w.app.indexer.readListings([listing.toBase58()]) // fresher
  w.db.run('UPDATE listings SET chain_read_at=? WHERE pubkey=?', w.now() + 5000, listing.toBase58())
  await w.app.indexer.reconcile()
  assert.equal(w.db.get('SELECT closed FROM listings WHERE pubkey=?', listing.toBase58()).closed, 0)
  w.conn.getProgramAccounts = realGpa
})
test('credits: parked SOL shows until the owner claims, read from lamports since a claim has no event', async () => {
  const w = world(); const { listing, s } = await bidding(w)
  await w.app.indexer.rebuild()
  const owner = w.conn.wallet(), credit = w.app.prog.creditPda(listing, owner.publicKey)
  w.conn.svm.airdrop(credit.toBase58(), 2_000_000n)
  // The contract only parks SOL for accounts it can't pay: exercised by its own tests. Here the row comes from the event.
  w.db.run(`INSERT INTO credits (listing,owner,lamports) VALUES (?,?,'2000000')`, listing.toBase58(), owner.publicKey.toBase58())
  await w.app.indexer.tick()
  assert.equal(w.app.listings.creditsFor(owner.publicKey.toBase58())[0].lamports, '2000000')
  assert.equal(w.app.listings.view(w.db.get('SELECT * FROM listings WHERE pubkey=?', listing.toBase58())).credits.length, 1)
  w.conn.send(w.app.prog.ix.claimCredit(owner.publicKey, listing, owner.publicKey), owner)
  await w.app.indexer.tick()
  assert.equal(w.app.listings.creditsFor(owner.publicKey.toBase58()).length, 0)
})
test('credits for real: an unpayable bidder gets a CreditParked event from the contract, and the API shows it until claimed', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  const stuck = w.conn.wallet()
  bid(w, listing, stuck, 2_000_000n)
  const set = (executable) => {
    const data = executable ? Uint8Array.from(readFileSync(SO)) : new Uint8Array(0)
    w.conn.svm.setAccount({ address: stuck.publicKey.toBase58(), lamports: 10_000_000_000n, data, programAddress: executable ? 'BPFLoader2111111111111111111111111111111111' : '11111111111111111111111111111111', executable, space: BigInt(data.length), rentEpoch: 0n })
  }
  set(true) // an account that can't be credited, which the contract handles by parking the SOL
  bid(w, listing, w.conn.wallet(), 4_000_000n)
  await w.app.indexer.tick()
  const seen = w.db.get(`SELECT * FROM events_seen WHERE name='CreditParked'`)
  assert.ok(seen, 'event read from real logs')
  assert.equal(w.app.listings.creditsFor(stuck.publicKey.toBase58())[0].lamports, '2000000')
  set(false)
  w.conn.send(w.app.prog.ix.claimCredit(stuck.publicKey, listing, stuck.publicKey), stuck)
  await w.app.indexer.tick()
  assert.equal(w.app.listings.creditsFor(stuck.publicKey.toBase58()).length, 0, 'gone once claimed')
})
test('single card: repeat reads inside the window use the cache, so a busy card costs one chain read', async () => {
  const w = world(); const { listing } = await bidding(w)
  await w.app.indexer.rebuild()
  await w.app.listings.one(listing.toBase58())
  const n = w.app.rpc.stats.accountsRead
  for (let i = 0; i < 20; i++) await w.app.listings.one(listing.toBase58())
  assert.equal(w.app.rpc.stats.accountsRead, n)
  w.clock.skew += 3000
  await w.app.listings.one(listing.toBase58())
  assert.ok(w.app.rpc.stats.accountsRead > n)
})
test('API filters and phases', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive')
  const a = await bidding(w)
  const s = seller(w, { xId: '9', username: 'tagger' })
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 2m`); await readerStep(w)
  await w.app.indexer.rebuild()
  const L = w.app.listings
  assert.equal(L.list({}).items.length, 2)
  assert.equal(L.list({ mode: 'accept' }).items.length, 1); assert.equal(L.list({ mode: 'bidding' }).items.length, 1)
  assert.equal(L.list({ mint: s.mint.toBase58() }).items.length, 1); assert.equal(L.list({ seller: a.s.kp.publicKey.toBase58() }).items.length, 1)
  assert.equal(L.list({ mode: 'nonsense' }).error, 'bad_mode')
  assert.equal(L.list({ limit: 1 }).items.length, 1); assert.equal(L.list({ limit: 1 }).next, 1); assert.equal(L.list({ limit: 1, cursor: 1 }).next, 2); assert.equal(L.list({ limit: 1, cursor: 2 }).items.length, 0)
  const v = L.list({ mint: s.mint.toBase58() }).items[0]
  assert.deepEqual([v.seller.handle, v.phase, v.mode, v.tagged.tweetId, v.expected.tokenAmount, v.expected.bid], ['tagger', 'live', 'accept', id, '1000000', '0'])
  const b = L.list({ mode: 'bidding' }).items[0]
  assert.equal(b.seller.handle, a.s.username, 'a site listing finds its seller through the linked wallet')
  bid(w, w.app.prog.acceptPda(tagListingId(id)), w.conn.wallet(), 2_000_000n)
  await w.app.indexer.tick()
  w.conn.warp(121)
  assert.equal(L.list({ phase: 'accept_window' }).items.length, 1)
  w.conn.warp(600)
  const g = L.list({ phase: 'seller_ghosted' }).items[0]
  assert.equal(g.status, 'Seller ghosted')
})
