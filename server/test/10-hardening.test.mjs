// One regression test per past finding and per contract change, named after them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { world, seller, tag, readerStep, flagsOn, bid, listingFixture, chainListing, Keypair, PublicKey, spl, SvmConn, LISTING_KEY, tweetId, T22, SO } from './harness.mjs'
import { listen, clientAddress, Limiter } from '../src/http.mjs'
import { loadConfig } from '../src/config.mjs'
import { Rpc, RpcError, redact } from '../src/chain/rpc.mjs'
import { priceFor } from '../src/chain/sender.mjs'
import { listingCard } from '../src/share.mjs'
import { minimumNextBid, tagListingId, LISTING_SIZE, readMint } from '../src/chain/program.mjs'
import { Flags } from '../src/flags.mjs'
import { openDb } from '../src/db.mjs'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { readFileSync } from 'node:fs'

const on = (over) => { const w = world(over); flagsOn(w, 'keeperLive'); return w }
async function site(w) {
  const server = await listen(w.app.handler, 0), base = `http://127.0.0.1:${server.address().port}`
  return { base, get: (p, h = {}) => fetch(base + p, { headers: h }), close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }) }
}
async function auction(w, o = {}) {
  const s = seller(w, o)
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, amount: 1_000_000n, duration: o.duration ?? 60n })
  await w.app.indexer.rebuild()
  return { s, listing }
}
/** An account owned by some other program whose bytes are a perfect Listing naming the victim. */
function fakeListing(w, realListing) {
  const data = Uint8Array.from(w.conn.info(realListing).data), fake = Keypair.generate().publicKey
  w.conn.svm.setAccount({ address: fake.toBase58(), lamports: 5_000_000n, data, programAddress: Keypair.generate().publicKey.toBase58(), executable: false, space: BigInt(data.length), rentEpoch: 0n })
  w.conn.known.add(fake.toBase58())
  return fake
}
const rowInsert = (w, o) => w.db.run(`INSERT INTO listings (pubkey,seller,mint,token_program,amount,price,end_time,top_bidder,top_bid,mode,state,decimals,accept_window_secs,closed,chain_read_at,keeper_next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,6,0,0,?,?)`,
  o.pubkey ?? Keypair.generate().publicKey.toBase58(), o.seller ?? 'spammer', Keypair.generate().publicKey.toBase58(), spl.TOKEN_PROGRAM_ID.toBase58(), '1', '1000000', o.end, Keypair.generate().publicKey.toBase58(), o.bid ?? '1000000', 'bidding', 'live', w.now(), o.next ?? 0)

// ---------- contract changes
test('contract: IDL matches, Listing is 317 bytes, hard_end_time decoded and cached', async () => {
  const w = world(); const { listing } = await auction(w)
  assert.equal(LISTING_SIZE, 317); assert.equal(w.conn.info(listing).data.length, 317)
  const l = chainListing(w, listing)
  assert.equal(l.hardEndTime, l.endTime + 300)
  assert.equal(w.db.get('SELECT hard_end_time h FROM listings').h, l.hardEndTime)
  const card = (await w.app.listings.one(listing.toBase58()))
  assert.equal(card.expected.maxEndTime, l.hardEndTime); assert.equal(card.expected.mint, l.mint.toBase58())
})
test('contract: place_bid carries mint and max end, a changed deal is refused, the raise is enforced where the card says', async () => {
  const w = world(); const { listing } = await auction(w)
  const a = w.conn.wallet(), b = w.conn.wallet()
  bid(w, listing, a, 100_000_000n)
  const next = minimumNextBid(100_000_000n, 2_000_000n)
  assert.equal(next, 102_000_000n, '2% beats the floor')
  assert.equal(minimumNextBid(2_000_000n, 2_000_000n), 3_000_000n, 'the floor beats 2%')
  assert.equal(minimumNextBid(0n, 5_000_000n), 5_000_000n, 'no bids: the price')
  assert.throws(() => bid(w, listing, b, next - 1n), (e) => /RaiseTooSmall/.test((e.logs ?? []).join(' ')))
  bid(w, listing, b, next)
  await w.app.indexer.tick()
  assert.equal((await w.app.listings.list({}).items[0]).nextMinBid, minimumNextBid(next, 2_000_000n).toString())
  const l = chainListing(w, listing), c = w.conn.wallet()
  const stale = { ...l, hardEndTime: l.hardEndTime - 1 }
  assert.throws(() => w.conn.send(w.app.prog.ix.bid(stale, c.publicKey, 500_000_000n), c), (e) => /ListingChanged/.test((e.logs ?? []).join(' ')))
  const otherMint = { ...l, mint: Keypair.generate().publicKey }
  assert.throws(() => w.conn.send(w.app.prog.ix.bid(otherMint, c.publicKey, 500_000_000n), c), (e) => /ListingChanged/.test((e.logs ?? []).join(' ')))
})
test('contract: tokens outside the associated account cannot back a tagged card', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive')
  const s = seller(w, { amount: 0n })
  const k = Keypair.generate(), { SystemProgram } = await import('@solana/web3.js')
  w.conn.send([SystemProgram.createAccount({ fromPubkey: s.kp.publicKey, newAccountPubkey: k.publicKey, lamports: 3_000_000, space: 165, programId: spl.TOKEN_PROGRAM_ID }), spl.createInitializeAccount3Instruction(k.publicKey, s.mint, s.kp.publicKey)], s.kp, [k])
  w.conn.send(spl.createMintToInstruction(s.mint, k.publicKey, w.conn.mintAuth.publicKey, 5_000_000n), w.conn.mintAuth)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`); await readerStep(w)
  assert.equal(w.db.get('SELECT reason FROM mentions WHERE tweet_id=?', id).reason, 'does_not_hold')
  assert.equal(w.db.get('SELECT COUNT(*) n FROM tx_intents').n, 0)
})
test('contract: caps of 1 hour are enforced before any transaction', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive'); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 61m`); await readerStep(w)
  assert.equal(w.db.get('SELECT reason FROM mentions WHERE tweet_id=?', id).reason, 'parse:bad_length')
  const ok = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 1h`); await readerStep(w)
  assert.equal(w.db.get('SELECT state FROM mentions WHERE tweet_id=?', ok).state, 'live')
  assert.equal(loadConfig({ TAG_MAX_SECONDS: '86400' }).tag.maxSeconds, 3600, 'config cannot go past the contract')
  assert.throws(() => loadConfig({ TAG_ACCEPT_WINDOW_SECONDS: '7200' }), /contract/)
  assert.throws(() => loadConfig({ TAG_ACCEPT_WINDOW_SECONDS: '30' }), /contract/)
})

// ---------- H1
test('H1: an account owned by another program is never believed, on any route', async () => {
  const w = world(); flagsOn(w, 'passLive'); const { listing, s } = await auction(w, { username: 'big_whale' })
  const fake = fakeListing(w, listing), site1 = await site(w), f = fake.toBase58()
  assert.equal((await site1.get(`/api/listings/${f}`)).status, 404, 'no card')
  assert.equal(w.db.get('SELECT COUNT(*) n FROM listings WHERE pubkey=?', f).n, 0, 'nothing cached')
  assert.equal((await site1.get(`/og/listing/${f}.png`)).status, 404); assert.equal((await site1.get(`/c/${f}`)).status, 404)
  await w.app.indexer.reconcile()
  assert.equal(w.db.get('SELECT COUNT(*) n FROM listings WHERE pubkey=?', f).n, 0, 'reconcile drops it too')
  assert.equal(w.app.prog.decode(fake, w.conn.info(fake)), null)
  assert.ok(w.app.prog.decode(listing, w.conn.info(listing)))
  const user = w.db.get('SELECT * FROM x_users WHERE x_id=?', s.xId)
  assert.equal((await w.app.pass.issue({ user, listing: f, wallet: s.kp.publicKey.toBase58() })).why, 'no_listing')
  await site1.close()
})
test('H1: a cached row whose account stops being ours is closed, not served', async () => {
  const w = world(); const { listing } = await auction(w)
  const i = w.conn.info(listing), p = listing.toBase58()
  w.conn.svm.setAccount({ address: p, lamports: BigInt(i.lamports), data: Uint8Array.from(i.data), programAddress: Keypair.generate().publicKey.toBase58(), executable: false, space: BigInt(i.data.length), rentEpoch: 0n })
  await w.app.indexer.readListings([p])
  assert.equal(w.db.get('SELECT closed FROM listings WHERE pubkey=?', p).closed, 1)
})
test('H1: a mint read checks the owner too', () => {
  const data = Buffer.alloc(82); data[45] = 1; data[44] = 6
  assert.equal(readMint({ owner: Keypair.generate().publicKey, data }), null)
  assert.equal(readMint({ owner: spl.TOKEN_PROGRAM_ID, data }).decimals, 6)
})
test('H1: a fake tagged card is ignored by the reply scan', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive')
  const s = seller(w); const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 1m`); await readerStep(w)
  const pub = w.app.prog.acceptPda(tagListingId(id)); bid(w, pub, w.conn.wallet(), 5_000_000n); await w.app.indexer.tick()
  w.conn.warp(60)
  const i = w.conn.info(pub)
  w.conn.svm.setAccount({ address: pub.toBase58(), lamports: BigInt(i.lamports), data: Uint8Array.from(i.data), programAddress: Keypair.generate().publicKey.toBase58(), executable: false, space: BigInt(i.data.length), rentEpoch: 0n })
  await w.app.replies.scanAcceptWindows()
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM replies WHERE kind='accept'`).n, 0)
})

// ---------- H2
test('H2: refuses to start without TRUSTED_HOPS in production, with a message saying what to do', () => {
  for (const env of [{ NODE_ENV: 'production' }, { RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, { PUBLIC_URL: 'https://sidebid.example' }]) assert.throws(() => loadConfig(env), /TRUSTED_HOPS must be set\. Run the deploy test/)
  assert.throws(() => loadConfig({ TRUSTED_HOPS: 'yes' }), /whole number/)
  assert.equal(loadConfig({ NODE_ENV: 'production', TRUSTED_HOPS: '1', DATA_DIR: '/data' }).trustedHops, 1)
  assert.equal(loadConfig({ NODE_ENV: 'production', TRUSTED_HOPS: '0', DATA_DIR: '/data' }).trustedHops, 0, 'an explicit 0 is allowed: no proxy, trust nothing')
  assert.equal(loadConfig({}).trustedHops, 0, 'local development: trust no header')
})
test('H2: the real entry point exits with that message and does not start', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], { env: { PATH: process.env.PATH, NODE_ENV: 'production', RPC_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 1); assert.match(r.stderr, /Not starting: TRUSTED_HOPS must be set/)
})
test('H2: who is asking: only the entry the trusted proxies wrote, never x-real-ip', () => {
  const C = (h, hops = 1) => clientAddress(h, '100.64.0.9', hops)
  assert.equal(C({ 'x-real-ip': '8.8.8.8' }), '100.64.0.9', 'x-real-ip is never believed')
  assert.equal(C({ 'x-forwarded-for': '6.6.6.6, 8.8.8.8' }), '8.8.8.8', 'one proxy: the rightmost entry')
  assert.equal(C({ 'x-forwarded-for': '6.6.6.6, 8.8.8.8, 10.0.0.1' }, 2), '8.8.8.8', 'two proxies: second from the right')
  assert.equal(C({ 'x-forwarded-for': '8.8.8.8' }, 2), '100.64.0.9', 'fewer entries than proxies: skipped them, so the socket')
  assert.equal(C({ 'x-forwarded-for': 'garbage' }), '100.64.0.9')
  assert.equal(C({ 'x-forwarded-for': ['1.1.1.1', '8.8.8.8'] }), '8.8.8.8', 'repeated headers joined, rightmost wins')
  assert.equal(C({ 'x-forwarded-for': '1.1.1.1, 8.8.8.8' }, 0), '100.64.0.9', '0: no header means anything')
})
test('H2 recheck R2: with no proxy configured, rotating x-real-ip or x-forwarded-for gets 600 requests nowhere', async () => {
  const w = world(), s = await site(w)
  let limited = 0
  for (let i = 0; i < 600; i++) { const r = await s.get('/api/listings', { 'x-real-ip': `9.9.${i >> 8}.${i & 255}`, 'x-forwarded-for': `7.7.${i >> 8}.${i & 255}` }); if (r.status === 429) limited++ }
  assert.ok(limited >= 360, `limited ${limited} of 600`)
  await s.close()
})
test('H2: behind one proxy, visitors have their own buckets, and a client written entry does not help', async () => {
  const w = world({ env: { TRUSTED_HOPS: '1' } }), s = await site(w)
  let last
  for (let i = 0; i < 241; i++) last = await s.get('/api/listings', { 'x-forwarded-for': `9.9.${i}.1, 8.8.8.8` })
  assert.equal(last.status, 429, 'the flooder is limited, whatever it writes on the left')
  assert.equal((await s.get('/api/listings', { 'x-forwarded-for': '4.4.4.4' })).status, 200, 'someone else is not')
  await s.close()
})
test('H2 recheck R2: admin guesses are limited however the headers rotate, and the right secret still works when they are', async () => {
  const w = world({ env: { TRUSTED_HOPS: '1' } }), s = await site(w)
  const codes = []
  for (let i = 0; i < 70; i++) codes.push((await s.get('/api/admin/status', { 'x-admin-secret': `guess-${i}`, 'x-forwarded-for': `5.5.${i}.1`, 'x-real-ip': `6.6.${i}.1` })).status)
  assert.equal(codes.filter((c) => c === 403).length, 60); assert.equal(codes.filter((c) => c === 429).length, 10)
  assert.equal((await s.get('/api/admin/status', { 'x-admin-secret': 'admin-test-secret-0123456789abcdef' })).status, 200, 'a flood cannot lock the owner out of the kill switches')
  assert.throws(() => world({ env: { ADMIN_SECRET: 'short' } }), /at least 32/)
  await s.close()
})
test('H2: the deploy test tool reads what the server sees, and says which TRUSTED_HOPS fits', async () => {
  const w = world({ env: { TRUSTED_HOPS: '1' } }), s = await site(w)
  const http = await import('node:http')
  // A stand in for the platform's edge: appends the address it saw, as a real proxy does
  const edge = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: new URL(s.base).port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': [req.headers['x-forwarded-for'], '203.0.113.7'].filter(Boolean).join(', ') } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    req.pipe(up)
  })
  await new Promise((ok) => edge.listen(0, ok))
  const url = `http://127.0.0.1:${edge.address().port}`
  const tool = fileURLToPath(new URL('../tools/deploy-ip-check.mjs', import.meta.url))
  // Run as a separate process without blocking, since this process is also the server it talks to
  const { execFile } = await import('node:child_process')
  const run = (ip) => new Promise((ok) => execFile(process.execPath, [tool, url, ip], { env: { PATH: process.env.PATH, ADMIN_SECRET: 'admin-test-secret-0123456789abcdef' }, timeout: 20_000 }, (e, stdout, stderr) => ok({ status: e ? e.code : 0, stdout, stderr })))
  const r = await run('203.0.113.7')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS/); assert.match(r.stdout, /TRUSTED_HOPS=1/)
  const bad = await run('198.51.100.99')
  assert.equal(bad.status, 1); assert.match(bad.stdout, /FAIL/)
  edge.closeAllConnections(); edge.close(); await s.close()
})
test('H2: the health check stays up when the shared bucket is full', async () => {
  const w = world(), s = await site(w)
  let last
  for (let i = 0; i < 245; i++) last = (await s.get('/api/listings')).status
  assert.equal(last, 429)
  assert.equal((await s.get('/api/health')).status, 200)
  await s.close()
})

// ---------- M1
test('M1: 200 listings from one seller, ending earlier, do not push out a real one', async () => {
  const w = on(); const nowS = w.conn.now()
  for (let i = 0; i < 200; i++) rowInsert(w, { end: nowS - 10 })
  const real = Keypair.generate().publicKey.toBase58()
  rowInsert(w, { pubkey: real, seller: 'someone', end: nowS - 1, bid: '50000000' })
  const due = w.app.keeper.due(nowS)
  assert.equal(due[0], real, 'first in the batch')
  assert.ok(due.length <= 25)
  // Same small bid as the spam: the seller's fair share alone has to get it in
  const w2 = on(), small = Keypair.generate().publicKey.toBase58()
  for (let i = 0; i < 200; i++) rowInsert(w2, { end: nowS - 10 })
  rowInsert(w2, { pubkey: small, seller: 'someone', end: nowS - 1 })
  assert.ok(w2.app.keeper.due(nowS).indexOf(small) === 3, 'right after the spammer\'s three places')
})
test('M1 recheck R5: 200 fresh seller wallets with 0.01 SOL wash bids, ending earlier, do not hold back a 5 SOL settle', () => {
  const w = on(); const nowS = w.conn.now()
  for (let i = 0; i < 200; i++) rowInsert(w, { seller: `fresh${i}`, end: nowS - 10, bid: '10000000' })
  const real = Keypair.generate().publicKey.toBase58()
  rowInsert(w, { pubkey: real, seller: 'honest', end: nowS - 1, bid: '5000000000' })
  assert.equal(w.app.keeper.due(nowS)[0], real, 'first, not eight batches later')
  // To go ahead of it, each spam listing needs a bigger bid locked than the real one
  const w2 = on()
  for (let i = 0; i < 30; i++) rowInsert(w2, { seller: `rich${i}`, end: nowS - 10, bid: '5000000001' })
  rowInsert(w2, { pubkey: real, seller: 'honest', end: nowS - 1, bid: '5000000000' })
  assert.equal(w2.app.keeper.due(nowS).includes(real), false, 'only bids above it come first, which costs real capital')
})
test('M1: many small sellers ending earlier: the bigger bid still goes first; end time decides among equals', () => {
  const w = on(); const nowS = w.conn.now()
  for (let i = 0; i < 200; i++) rowInsert(w, { seller: `s${i}`, end: nowS - 10 })
  const real = Keypair.generate().publicKey.toBase58()
  rowInsert(w, { pubkey: real, seller: 'someone', end: nowS - 1, bid: '50000000' })
  assert.equal(w.app.keeper.due(nowS)[0], real)
  const w2 = on(); const t = w2.conn.now()
  const late = Keypair.generate().publicKey.toBase58(), early = Keypair.generate().publicKey.toBase58()
  rowInsert(w2, { pubkey: late, seller: 'a', end: t - 1, bid: '50000000' }); rowInsert(w2, { pubkey: early, seller: 'b', end: t - 9, bid: '50000000' })
  assert.deepEqual(w2.app.keeper.due(t), [early, late])
})
test('M1: rows waiting out a retry take no place in the batch', () => {
  const w = on(); const nowS = w.conn.now()
  for (let i = 0; i < 200; i++) rowInsert(w, { seller: `s${i}`, end: nowS - 10, next: w.now() + 60_000 })
  const real = Keypair.generate().publicKey.toBase58()
  rowInsert(w, { pubkey: real, seller: 'x', end: nowS - 1 })
  assert.deepEqual(w.app.keeper.due(nowS), [real])
})
test('M1: a real settle lands in the first tick with spam already due, and spam can\'t make it wait on a slow send', async () => {
  const w = on(); const a = await auction(w, { xId: '1', username: 'a' }), b = await auction(w, { xId: '2', username: 'b' })
  bid(w, a.listing, w.conn.wallet(), 2_000_000n); bid(w, b.listing, w.conn.wallet(), 3_000_000n)
  await w.app.indexer.tick(); w.conn.warp(60)
  const real = w.conn.sendRawTransaction.bind(w.conn); let n = 0, release
  const gate = new Promise((ok) => { release = ok })
  w.conn.sendRawTransaction = async (raw, o) => { if (++n === 1) { await gate } else release(); return real(raw, o) }
  await w.app.keeper.tick() // would hang forever if sends ran one at a time
  assert.equal(n, 2)
  // The VM retires a blockhash on every transaction, so the held send may be refused here and need one more go. A real chain keeps it.
  w.conn.sendRawTransaction = real; w.clock.skew += 5000
  await w.app.keeper.tick()
  assert.equal(w.conn.info(a.listing), null); assert.equal(w.conn.info(b.listing), null)
})

// ---------- M2
test('M2: public card reads have their own budget: a flood is refused at once and internal reads never wait', async () => {
  const conn = new SvmConn(); const clock = { t: 1000 }, slept = []
  const rpc = new Rpc({ conn, maxRps: 8, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms } })
  const k = Keypair.generate().publicKey
  let ok = 0, refused = 0
  for (let i = 0; i < 200; i++) await rpc.public.accounts([Keypair.generate().publicKey]).then(() => ok++, (e) => { assert.ok(e instanceof RpcError); refused++ })
  assert.equal(ok, 2, 'a quarter of 8 a second'); assert.equal(refused, 198)
  assert.equal(slept.length, 0, 'public reads never queue')
  for (let i = 0; i < 6; i++) await rpc.accounts([k])
  assert.equal(slept.length, 0, 'the internal budget is untouched')
})
test('M2: one read per key per window however many ask at once; unknown addresses are remembered', async () => {
  const w = world(); const { listing } = await auction(w)
  w.clock.skew += 3000
  const before = w.app.rpc.stats.calls.publicAccounts ?? 0
  await Promise.all(Array.from({ length: 20 }, () => w.app.listings.one(listing.toBase58())))
  const used = (w.app.rpc.stats.calls.publicAccounts ?? 0) - before
  assert.ok(used <= 2, `listing and its token account, once: ${used}`)
  const unknown = Keypair.generate().publicKey.toBase58(), n = w.app.rpc.stats.calls.publicAccounts
  assert.equal(await w.app.listings.one(unknown), null); assert.equal(await w.app.listings.one(unknown), null)
  assert.equal(w.app.rpc.stats.calls.publicAccounts, n + 1)
})
test('M2: out of public budget, a known card is served from the cache, marked stale', async () => {
  const w = world({ env: { RPC_MAX_RPS: '4' } }); const { listing } = await auction(w)
  w.app.rpc.publicBucket.n = 0; w.app.rpc.publicBucket.t = w.now()
  w.clock.skew += 3000; w.app.rpc.publicBucket.t = w.now()
  const card = await w.app.listings.one(listing.toBase58())
  assert.deepEqual([card.stale, card.phase], [true, 'live'])
  assert.ok(w.app.rpc.stats.publicRefused >= 1)
})

// ---------- M3
test('M3: rendering leaves the event loop free', async () => {
  const v = { pubkey: 'x', mode: 'bidding', amount: '1000000', decimals: 6, price: '1000000', topBid: '0', mint: 'So11111111111111111111111111111111111111112', seller: { handle: 'a', wallet: 'So11111111111111111111111111111111111111112' } }
  // Deterministic: a synchronous encode finishes with nothing but microtasks, so a queued immediate could not run first
  let turned = false
  setImmediate(() => { turned = true })
  const png = await listingCard(v)
  assert.equal(turned, true, 'the event loop got a turn before the render finished')
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
})
test('M3: same card at once renders once; new renders are limited per address; cached ones are not', async () => {
  const w = world(); const { listing } = await auction(w), s = await site(w)
  const url = `/og/listing/${listing.toBase58()}.png`
  const many = await Promise.all(Array.from({ length: 40 }, () => s.get(url)))
  assert.ok(many.every((r) => r.status === 200), '40 at once share one render and use one place in the limit')
  for (let i = 0; i < 40; i++) rowInsert(w, { seller: `s${i}`, end: w.conn.now() + 100, pubkey: undefined })
  const rows = w.db.all(`SELECT pubkey FROM listings WHERE pubkey<>?`, listing.toBase58())
  const statuses = []
  for (const r of rows) statuses.push((await s.get(`/og/listing/${r.pubkey}.png`)).status)
  assert.equal(statuses.filter((c) => c === 200).length, 29, 'the 30 a minute limit, one already used')
  assert.ok(statuses.includes(429))
  assert.equal((await s.get(url)).status, 200, 'a cached card still serves')
  await s.close()
})
test('M3: a closed listing can be cached for long, a live one not', async () => {
  const w = world(); const { listing } = await auction(w), s = await site(w)
  assert.match((await s.get(`/og/listing/${listing.toBase58()}.png`)).headers.get('cache-control'), /max-age=30\b/)
  w.db.run('UPDATE listings SET closed=1 WHERE pubkey=?', listing.toBase58())
  assert.match((await s.get(`/og/listing/${listing.toBase58()}.png`)).headers.get('cache-control'), /max-age=86400/)
  await s.close()
})

// ---------- M4
test('M4: a flood of junk mentions stops at the read share, and replies to real cards still go out', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive')
  const s = seller(w); await readerStep(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`); await readerStep(w)
  assert.equal(w.db.get('SELECT state FROM mentions WHERE tweet_id=?', id).state, 'live')
  const junk = { id: '9', username: 'junk', createdAt: w.now() - 400 * 86400000, followers: 1 }
  for (let round = 0; round < 40; round++) { for (let i = 0; i < 20; i++) w.x.addMention({ id: tweetId(), text: '@sidebidsol gm', author: junk, createdAt: w.now() }); await readerStep(w) }
  const st = w.app.x.spend.status()
  assert.ok(st.readSpentUsd <= st.readCapUsd, JSON.stringify(st))
  assert.equal(w.app.reader.status.lastError, 'cap', 'reads have stopped for the day')
  await w.app.replies.tick()
  assert.equal(w.x.posts.length, 1, 'the card\'s reply still went out')
  assert.ok(w.app.x.spend.status().spentUsd > st.readSpentUsd)
})
test('M4: pages ask for 20, and polls bringing only junk slow down until a good tag', async () => {
  const w = world({ env: { X_POLL_SECONDS: '60' } }); flagsOn(w, 'readerLive', 'tagListingLive')
  const s = seller(w)
  await w.app.reader.tick()
  assert.equal(w.x.calls[0].query.max_results, '20')
  const r = w.app.reader
  assert.equal(r.quietFactor(), 1)
  const poll = async (text) => { w.x.addMention({ id: tweetId(), text, author: s.author, createdAt: w.now() }); r.lastPoll = 0; await r.tick() }
  await poll('@sidebidsol gm'); assert.equal(r.quietFactor(), 2)
  await poll('@sidebidsol gm'); await poll('@sidebidsol gm'); await poll('@sidebidsol gm'); assert.equal(r.quietFactor(), 8, 'capped')
  const calls = w.x.calls.length
  r.lastPoll = w.now(); w.clock.skew += 61_000; await r.tick()
  assert.equal(w.x.calls.length, calls, 'one normal interval is not enough now')
  w.clock.skew += 8 * 60_000; await r.tick()
  assert.equal(w.x.calls.length, calls + 1)
  await poll(`@sidebidsol 1 ${s.mint.toBase58()}`); assert.equal(r.quietFactor(), 1, 'a real tag resets it')
})
test('M4: a reply\'s look at its own posts reads only what came after, and is billed for what it read', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive')
  const s = seller(w); await readerStep(w); const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`); await readerStep(w)
  w.x.postBehaviour = () => 'landed-then-timeout'
  await w.app.replies.tick(); w.x.postBehaviour = null; w.clock.skew += 11_000
  const before = w.app.x.spend.spent()
  await w.app.replies.tick()
  const look = w.x.calls.find((c) => /\/tweets$/.test(c.path) && c.method === 'GET')
  assert.equal(look.query.since_id, id); assert.equal(look.query.max_results, '100')
  assert.ok(w.app.x.spend.spent() - before < 100_000, 'the unused part of the worst case came back')
})

// ---------- M5
test('M5: the link message names the X account that gets the wallet', () => {
  const w = world(); w.app.auth.upsertUser({ xId: '55', handle: 'attacker', xCreatedAt: w.now() - 400 * 86400000, followers: 50 })
  const k = Keypair.generate(), c = w.app.auth.challenge('55', k.publicKey.toBase58())
  assert.match(c.message, /X account @attacker \(id 55\)/); assert.match(c.message, /Only sign if @attacker is your own account/)
  assert.ok(w.app.auth.link('55', { wallet: k.publicKey.toBase58(), nonce: c.nonce, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.message), k.secretKey)) }).ok)
  assert.equal(w.app.auth.challenge('no such account', k.publicKey.toBase58()).why, 'unknown_account')
})

// ---------- L1
test('L1: a wallet in its 48 hour wait does not carry the X name on cards', async () => {
  const w = world(); const { listing, s } = await auction(w, { username: 'honest' })
  const a = w.app.auth, k = w.conn.wallet(), c = a.challenge(s.xId, k.publicKey.toBase58())
  a.link(s.xId, { wallet: k.publicKey.toBase58(), nonce: c.nonce, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(c.message), k.secretKey)) })
  const m = w.conn.mint(), ta = w.conn.ata(k.publicKey, m, 5_000_000n)
  const other = listingFixture(w, { sellerKp: k, tokenAccount: ta, mint: m, amount: 1n, duration: 3000n })
  await w.app.indexer.reconcile()
  const view = (l) => w.app.listings.view(w.db.get('SELECT * FROM listings WHERE pubkey=?', l.toBase58())).seller.handle
  assert.equal(view(other), null, 'still waiting')
  assert.equal(view(listing), 'honest', 'the active wallet still does')
  w.clock.skew += 49 * 3600_000; a.activeWallet(s.xId)
  assert.equal(view(other), 'honest', 'after the wait')
})

// ---------- L3
test('L3: a transaction the RPC never returns stops holding history after enough tries', async () => {
  const w = world(); const { listing } = await auction(w)
  await w.app.indexer.tick()
  bid(w, listing, w.conn.wallet(), 5_000_000n)
  const missing = w.conn.order.at(-1), real = w.conn.getTransactions.bind(w.conn)
  w.conn.getTransactions = async (sigs) => { const r = await real(sigs); return r.map((t, i) => (sigs[i] === missing ? null : t)) }
  bid(w, listing, w.conn.wallet(), 9_000_000n)
  for (let i = 0; i < 19; i++) await w.app.indexer.catchUp()
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n, 0, 'waits: it is usually just late')
  await w.app.indexer.catchUp()
  assert.equal(w.app.indexer.status.skippedTxs, 1)
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n, 1, 'and the next one is read')
})
test('L3: a backlog bigger than one walk is finished over several ticks, nothing lost', async () => {
  const w = world({ env: { INDEX_MAX_PAGES: '1' } }); const { listing } = await auction(w)
  await w.app.indexer.catchUp()
  w.app.indexer.pageSize = 2
  let amount = 2_000_000n
  for (let i = 0; i < 7; i++) { amount += 2_000_000n; bid(w, listing, w.conn.wallet(), amount) }
  const count = () => w.db.get(`SELECT COUNT(*) n FROM events_seen WHERE name='BidPlaced'`).n
  await w.app.indexer.catchUp()
  assert.equal(count(), 0, 'not processed in part')
  for (let i = 0; i < 5; i++) await w.app.indexer.catchUp()
  assert.equal(count(), 7, 'every bid, oldest included')
})
test('L3: a short list from a lagging node closes nothing that still exists', async () => {
  const w = world(); const { listing } = await auction(w)
  w.conn.getProgramAccounts = async () => []
  w.clock.skew += 1000
  await w.app.indexer.reconcile()
  assert.equal(w.db.get('SELECT closed FROM listings WHERE pubkey=?', listing.toBase58()).closed, 0)
})
test('L3: truncated logs: the listings a transaction touched are read again', async () => {
  const w = world(); const { listing } = await auction(w)
  w.app.indexer.dirty.clear()
  w.app.indexer.applyTx('sig', { meta: { logMessages: ['Log truncated'] }, transaction: { message: { accountKeys: [listing, Keypair.generate().publicKey] } } })
  assert.deepEqual([...w.app.indexer.dirty], [listing.toBase58()])
  assert.equal(w.app.indexer.status.truncatedTxs, 1)
})
test('L3: a closed row is not fresh forever: a relist at the same address shows', async () => {
  const w = on(); const { s, listing } = await auction(w)
  w.conn.send(spl.createRevokeInstruction(s.tokenAccount, s.kp.publicKey), s.kp)
  w.conn.warp(60); await w.app.keeper.tick()
  assert.equal(w.conn.info(listing), null)
  await w.app.indexer.tick()
  assert.equal((await w.app.listings.one(listing.toBase58())).closed, true)
  listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, amount: 1_000_000n, duration: 600n })
  w.clock.skew += 31_000
  const again = await w.app.listings.one(listing.toBase58())
  assert.deepEqual([again.closed, again.phase], [false, 'live'])
})

// ---------- L4
test('L4: each attempt pays more, up to a ceiling', async () => {
  assert.deepEqual([priceFor(50_000, 1), priceFor(50_000, 2), priceFor(50_000, 3), priceFor(50_000, 9), priceFor(50_000, 50)], [50_000, 100_000, 200_000, 1_000_000, 1_000_000])
})
test('L4: the keeper running out of SOL is a flag and a loud log, once', async () => {
  const lines = []; const w = on({ log: (...a) => lines.push(a.join(' ')) }); const { listing, s } = await auction(w)
  bid(w, listing, w.conn.wallet(), 3_000_000n); w.conn.ata(w.conn.wallet().publicKey, s.mint)
  await w.app.indexer.tick(); w.conn.warp(60)
  w.conn.svm.setAccount({ address: w.keeper.publicKey.toBase58(), lamports: 1n, data: new Uint8Array(0), programAddress: '11111111111111111111111111111111', executable: false, space: 0n, rentEpoch: 0n })
  w.conn.apply = ((real) => (raw, o) => { try { return real(raw, o) } catch (e) { throw new Error(`Simulation failed. Message: Attempt to debit an account but found no record of a prior credit. ${e.message}`) } })(w.conn.apply.bind(w.conn))
  await w.app.keeper.tick()
  assert.equal(w.app.keeper.status.outOfSol, true)
  w.clock.skew += 5000; await w.app.keeper.tick()
  assert.equal(lines.filter((l) => l.includes('OUT OF SOL')).length, 1)
  assert.equal((await w.app.status()).keeper.outOfSol, true)
})
test('L4: a refused close does not use up a courtesy place', async () => {
  const w = on({ env: { KEEPER_COURTESY_CLOSES_PER_DAY: '1' } }); const { listing } = await auction(w)
  w.conn.warp(60)
  await w.app.keeper.act('close', chainListing(w, listing)) // refused: the delegate is still set
  assert.equal(w.db.meta(w.app.keeper.courtesyKey()), null)
})
test('L4: one lamport sent to a winner\'s ATA address: the normal create is used, not a stray account', async () => {
  const w = on(); const { s, listing } = await auction(w)
  const b = w.conn.wallet(); bid(w, listing, b, 3_000_000n)
  const ata = spl.getAssociatedTokenAddressSync(s.mint, b.publicKey)
  const { SystemProgram } = await import('@solana/web3.js')
  w.conn.send(SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: ata, lamports: 1_000_000 }), b)
  await w.app.indexer.tick(); w.conn.warp(60)
  await w.app.keeper.tick()
  assert.equal(w.conn.info(listing), null)
  assert.equal(w.conn.tokenAmount(ata), 1_000_000n, 'tokens are in the ATA')
})

// ---------- L5
test('L5: a reply of unknown outcome with no read credentials ends at its expiry, sending nothing', async () => {
  const w = world({ env: { X_READ_BEARER: '' } }); flagsOn(w, 'repliesLive')
  w.db.run(`INSERT INTO mentions (tweet_id,x_id,text,state) VALUES ('5','1','t','live')`)
  w.app.replies.enqueue({ kind: 'live', tweetId: '5', xId: '1', listing: 'x', text: 'hello', expiresAt: w.now() + 60_000 })
  w.db.run(`UPDATE replies SET state='unknown'`)
  await w.app.replies.tick()
  assert.equal(w.x.posts.length, 0)
  w.clock.skew += 61_000; await w.app.replies.tick()
  assert.equal(w.db.get('SELECT state FROM replies').state, 'expired')
})

// ---------- L6, L7
test('L6: on Railway without a volume it refuses to start', () => {
  assert.throws(() => loadConfig({ RAILWAY_ENVIRONMENT: 'production', TRUSTED_HOPS: '1' }), /volume/)
})
test('L7: the public test listing key cannot run in production, and the build check refuses it', () => {
  const secret = bs58.encode(LISTING_KEY.secretKey)
  assert.throws(() => loadConfig({ NODE_ENV: 'production', TRUSTED_HOPS: '1', DATA_DIR: '/data', LISTING_SECRET: secret }), /public test key/)
  const tool = fileURLToPath(new URL('../tools/check-listing-key.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [tool], { env: { PATH: process.env.PATH, LISTING_PUBKEY_EXPECTED: LISTING_KEY.publicKey.toBase58() }, encoding: 'utf8' })
  assert.equal(r.status, 1); assert.match(r.stdout, /REFUSED/)
  // The test key is only in the test build; the release .so (the tool's default) must not carry it
  assert.equal(spawnSync(process.execPath, [tool, '--allow-test-key'], { env: { PATH: process.env.PATH, LISTING_PUBKEY_EXPECTED: LISTING_KEY.publicKey.toBase58() } }).status, 1)
  assert.equal(spawnSync(process.execPath, [tool, SO, '--allow-test-key'], { env: { PATH: process.env.PATH, LISTING_PUBKEY_EXPECTED: LISTING_KEY.publicKey.toBase58() } }).status, 0)
})
test('L7: flags cannot be switched on from the environment', () => {
  process.env.FLAG_KEEPERLIVE = '1'
  try { const f = new Flags(openDb(':memory:')); assert.equal(f.keeperOn, false) } finally { delete process.env.FLAG_KEEPERLIVE }
})
test('L7: a full limiter drops the longest unseen keys, not everyone\'s counts', () => {
  const l = new Limiter(() => 1000, 3)
  assert.ok(l.allow('a', 1, 1000)); assert.ok(l.allow('b', 1, 1000)); assert.ok(l.allow('c', 1, 1000))
  assert.equal(l.allow('c', 1, 1000), false)
  assert.ok(l.allow('d', 1, 1000))
  assert.equal(l.allow('c', 1, 1000), false, 'c kept its count')
  assert.equal(l.hits.size, 3)
})
test('L7: a phase filter runs no per row queries on rows it drops', () => {
  const w = world(); const nowS = w.conn.now()
  for (let i = 0; i < 50; i++) rowInsert(w, { end: nowS + 100, bid: '0' })
  let views = 0; const real = w.app.listings.view.bind(w.app.listings)
  w.app.listings.view = (r) => { views++; return real(r) }
  assert.equal(w.app.listings.list({ phase: 'sold' }).items.length, 0)
  assert.equal(views, 0)
  assert.equal(w.app.listings.list({ phase: 'live', limit: 5 }).items.length, 5)
  assert.equal(views, 5)
})
test('L7: an RPC URL with its key never reaches an error, a stored row or a log', async () => {
  assert.equal(redact('failed to reach https://rpc.example.com/?api-key=SECRET123 now'), 'failed to reach https://rpc.example.com now')
  const w = on(); const { listing } = await auction(w)
  bid(w, listing, w.conn.wallet(), 3_000_000n); await w.app.indexer.tick(); w.conn.warp(60)
  w.conn.inject('accounts', () => { throw new Error('fetch to https://rpc.example.com/?api-key=SECRET123 failed') }, 1)
  await w.app.keeper.tick()
  assert.ok(!String(w.app.keeper.status.lastError).includes('SECRET123'))
  assert.ok(w.app.keeper.status.lastError.includes('rpc.example.com'))
  const e = new RpcError('x', new Error('Simulation failed https://r.example/?api-key=SECRET123'))
  assert.ok(!e.detail.includes('SECRET123') && !e.message.includes('SECRET123'))
})

// ---------- recheck R7: L5
test('L5 recheck R7: an expired reply that landed is never credited to the later accept reply', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive')
  const s = seller(w); await readerStep(w); const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} 1m`); await readerStep(w)
  const pub = w.app.prog.acceptPda(tagListingId(id))
  // The live reply lands on X but times out, and then expires before it is ever confirmed
  w.x.postBehaviour = () => 'landed-then-timeout'
  await w.app.replies.tick(); w.x.postBehaviour = null
  w.db.run(`UPDATE replies SET state='expired' WHERE kind='live'`)
  // The accept reply goes unknown too, with nothing of its own on X
  bid(w, pub, w.conn.wallet(), 5_000_000n); await w.app.indexer.tick(); w.conn.warp(60)
  w.x.postBehaviour = () => 'timeout'
  await w.app.replies.tick(); w.x.postBehaviour = null
  assert.equal(w.db.get(`SELECT state FROM replies WHERE kind='accept'`).state, 'unknown')
  w.clock.skew += 11_000
  await w.app.replies.tick()
  assert.equal(w.x.posts.length, 2, 'the accept reply was really sent')
  assert.match(w.x.posts[1].text, /You have 10 minutes to accept/)
  const accept = w.db.get(`SELECT * FROM replies WHERE kind='accept'`)
  assert.equal(accept.reply_id, w.x.posts[1].id, 'its own post, not the old live one')
})
test('L5: a reply found on X matches by its words, with X\'s shortened links', async () => {
  const { sameWords } = await import('../src/x/replies.mjs')
  assert.ok(sameWords('Your card is live.\nhttps://sidebid.test/c/abc', 'Your card is live. https://t.co/xyz'))
  assert.ok(!sameWords('Top bid is 1 SOL.\nhttps://sidebid.test/c/abc', 'Your card is live. https://t.co/xyz'))
  assert.ok(!sameWords('https://a', 'https://b'), 'a link alone matches nothing')
})

// ---------- X read budget
test('X budget: an hourly read window, so a burst costs an hour, not the day; all limits are config', async () => {
  const w = world({ env: { X_DAILY_SPEND_CAP_USD: '10', X_READ_SHARE: '0.6', X_READ_HOURLY_USD: '0.6', X_MENTION_PAGE_SIZE: '50', X_MENTION_MAX_PAGES: '2' } }); flagsOn(w, 'readerLive', 'tagListingLive')
  const c = w.config.x
  assert.deepEqual([c.dailyCapUsd, c.readShare, c.readHourlyUsd, c.pageSize, c.maxPages], [10, 0.6, 0.6, 50, 2])
  assert.equal(loadConfig({ X_DAILY_SPEND_CAP_USD: '6', X_READ_SHARE: '0.5' }).x.readHourlyUsd, 1, 'default: a third of the read share')
  // A worst case page of 50: each mention an owned read at 0.001, each author a user read at 0.010
  await w.app.reader.tick()
  assert.equal(w.x.calls[0].query.max_results, '50')
  const sp = w.app.x.spend
  assert.equal(sp.reserve(0.55, { read: true }), true)
  assert.equal(sp.reserve(0.1, { read: true }), false, 'the hour is full')
  assert.equal(sp.reserve(0.1), true, 'replies are not in the hourly window')
  w.clock.skew += 3600_000
  assert.equal(sp.reserve(0.55, { read: true }), true, 'the next hour has its own')
  assert.equal(sp.status().readHourCapUsd, 0.6)
})

// ---------- admin unlink
test('Admin unlink: frees a phished wallet, active or waiting, needs the secret, and is recorded', async () => {
  const w = world(), s = await site(w)
  const a = w.app.auth; a.upsertUser({ xId: '66', handle: 'attacker', xCreatedAt: w.now() - 400 * 86400000, followers: 50 }); a.upsertUser({ xId: '67', handle: 'owner', xCreatedAt: w.now() - 400 * 86400000, followers: 50 })
  const sign = (k, m) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), k.secretKey))
  const link = (x, k) => { const c = a.challenge(x, k.publicKey.toBase58()); return a.link(x, { wallet: k.publicKey.toBase58(), nonce: c.nonce, signature: sign(k, c.message) }) }
  const victim = Keypair.generate()
  link('66', victim)
  assert.equal(link('67', victim).why, 'wallet_taken')
  const post = (body, secret = 'admin-test-secret-0123456789abcdef') => fetch(`${s.base}/api/admin/unlink`, { method: 'POST', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ wallet: victim.publicKey.toBase58() }, 'wrong')).status, 403)
  const r = await (await post({ wallet: victim.publicKey.toBase58(), reason: 'phished, support case 1' })).json()
  assert.deepEqual([r.ok, r.was, r.xId], [true, 'active', '66'])
  assert.equal(a.activeWallet('66'), null)
  assert.equal(link('67', victim).ok, true, 'the owner can link it now')
  assert.equal(w.db.get('SELECT reason FROM admin_unlinks').reason, 'phished, support case 1')
  // A waiting change to a phished wallet
  const old = Keypair.generate(), next = Keypair.generate()
  a.upsertUser({ xId: '68', handle: 'x68', xCreatedAt: w.now() - 400 * 86400000, followers: 50 })
  link('68', old)
  w.db.run('INSERT INTO passes_issued (campaign,x_hash,wallet,expiry,issued_at) VALUES (?,?,?,?,?)', 'c68', 'h68', old.publicKey.toBase58(), 0, w.now()) // used, so the change waits
  link('68', next)
  const p = await (await post({ wallet: next.publicKey.toBase58() })).json()
  assert.equal(p.was, 'pending')
  w.clock.skew += 49 * 3600_000
  assert.equal(a.activeWallet('68'), old.publicKey.toBase58(), 'the change never takes over')
  assert.equal((await post({ wallet: Keypair.generate().publicKey.toBase58() })).status, 404)
  assert.equal((await post({ wallet: 'nope' })).status, 404)
  await s.close()
})
