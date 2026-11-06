import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { world, seller, listingFixture, bid, flagsOn, tag, readerStep, Keypair, chainListing } from './harness.mjs'
import { listen } from '../src/http.mjs'
import { listingCard, saleCard, listingShare, saleShare, tokenText, ogPage } from '../src/share.mjs'
import { loadConfig, HARD_X_SPEND_CEILING_USD } from '../src/config.mjs'
import { fmtSol } from '../src/x/replies.mjs'

async function site(w) {
  const server = await listen(w.app.handler, 0)
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, get: (p, h = {}) => fetch(base + p, { headers: h }), post: (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b ?? {}) }), close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }) }
}
const ADMIN = { 'x-admin-secret': 'admin-test-secret-0123456789abcdef' }
const isPng = (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
const size = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)]

async function withSale(w) {
  flagsOn(w, 'keeperLive')
  const s = seller(w, { username: 'bagholder' })
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, amount: 1_500_000n, duration: 60n })
  await w.app.indexer.rebuild()
  return { s, listing }
}

test('browse: nothing needed, list and single card, 404 and bad address', async () => {
  const w = world(); const { listing } = await withSale(w); const s = await site(w)
  const list = await (await s.get('/api/listings')).json()
  assert.equal(list.items[0].pubkey, listing.toBase58())
  const one = await (await s.get(`/api/listings/${listing.toBase58()}`)).json()
  assert.equal(one.phase, 'live'); assert.equal(one.fillable, true); assert.equal(one.stale, false)
  assert.equal(one.seller.handle, 'bagholder')
  assert.equal(typeof one.amount, 'string', 'u64 values travel as strings')
  assert.equal((await s.get(`/api/listings/${Keypair.generate().publicKey.toBase58()}`)).status, 404)
  assert.equal((await s.get('/api/listings/not-an-address')).status, 404)
  assert.equal((await s.get('/api/listings?mode=weird')).status, 400)
  await s.close()
})
test('single card with the RPC down: cached card marked stale; an unknown card is a 503, not a 404', async () => {
  const w = world(); const { listing } = await withSale(w); const s = await site(w)
  w.conn.inject('accounts', () => { throw new Error('502') })
  w.clock.skew += 3000
  const one = await (await s.get(`/api/listings/${listing.toBase58()}`)).json()
  assert.equal(one.stale, true); assert.equal(one.phase, 'live')
  assert.equal((await s.get(`/api/listings/${Keypair.generate().publicKey.toBase58()}`)).status, 503)
  await s.close()
})
test('site keeps working with X out of credits and with no X credentials at all', async () => {
  const w = world(); const { listing } = await withSale(w); const s = await site(w)
  w.x.fail = { status: 402, body: { title: 'CreditsDepleted' } }
  flagsOn(w, 'readerLive'); await w.app.reader.tick()
  assert.equal(w.app.x.available(), false)
  assert.equal((await s.get('/api/listings')).status, 200)
  const one = await (await s.get(`/api/listings/${listing.toBase58()}`)).json()
  assert.match(one.share.intent, /^https:\/\/x\.com\/intent\/post\?/)
  assert.equal((await s.get(`/og/listing/${listing.toBase58()}.png`)).status, 200)
  const calls = w.x.calls.length
  await s.get('/api/listings'); await s.get(`/c/${listing.toBase58()}`)
  assert.equal(w.x.calls.length, calls, 'browsing never touches X')
  const bare = world({ env: { X_READ_BEARER: '', X_POST_API_KEY: '', X_ACCOUNT_ID: '', X_SIGNIN_CLIENT_ID: '' } })
  flagsOn(bare, 'readerLive', 'repliesLive', 'signinLive')
  await bare.app.reader.tick(); await bare.app.replies.tick()
  assert.match(bare.app.reader.status.lastError, /config/)
  const s2 = await site(bare)
  assert.equal((await s2.get('/api/auth/x/start')).status, 404)
  await s.close(); await s2.close()
})
test('share cards: real PNGs at the OG size for a listing and a sale, with a page that points at them', async () => {
  const w = world(); const { s: sel, listing } = await withSale(w); const s = await site(w)
  const r = await s.get(`/og/listing/${listing.toBase58()}.png`)
  assert.equal(r.headers.get('content-type'), 'image/png')
  const b = Buffer.from(await r.arrayBuffer())
  assert.ok(isPng(b)); assert.deepEqual(size(b), [1200, 630]); assert.ok(b.length > 5000)
  const page = await (await s.get(`/c/${listing.toBase58()}`)).text()
  assert.ok(page.includes(`og:image" content="https://sidebid.test/og/listing/${listing.toBase58()}.png`))
  assert.match(page, /twitter:card" content="summary_large_image/)
  const bidder = w.conn.wallet(); bid(w, listing, bidder, 2_500_000n); await w.app.indexer.tick(); w.conn.warp(60); await w.app.keeper.tick(); await w.app.indexer.tick()
  const sale = (await (await s.get('/api/sales')).json()).items[0]
  assert.equal(sale.price, '2500000')
  assert.match(sale.share.intent, /chart\+never\+moved|chart%20never%20moved/)
  const sb = Buffer.from(await (await s.get(`/og/sale/${sale.sig}.png`)).arrayBuffer())
  assert.ok(isPng(sb)); assert.deepEqual(size(sb), [1200, 630])
  assert.ok((await (await s.get(`/s/${sale.sig}`)).text()).includes(`/og/sale/${sale.sig}.png`))
  assert.equal((await s.get('/og/sale/unknownsig1111111111111111111111111111111.png')).status, 404)
  assert.ok(sel)
  await s.close()
})
test('share cards handle hostile and non Latin seller names, and huge numbers', async () => {
  const v = { pubkey: 'x', mode: 'bidding', amount: (2n ** 64n - 1n).toString(), decimals: 0, price: (2n ** 64n - 1n).toString(), topBid: '0', mint: 'So11111111111111111111111111111111111111112', seller: { handle: '<img src=x onerror=1>日本語', wallet: 'So11111111111111111111111111111111111111112' } }
  assert.ok(isPng(await listingCard(v)))
  assert.ok(isPng(await saleCard({ amount: v.amount, decimals: 0, price: '1', mint: null })))
  assert.ok(!ogPage({ title: '<script>', description: '"><script>x', image: 'a', url: 'b' }).includes('<script>x'))
})
test('copy: written posts obey the brand rules', () => {
  const base = 'https://sidebid.test'
  const texts = [
    listingShare({ pubkey: 'p', mode: 'bidding', amount: '1000000', decimals: 6, price: '1000000', topBid: '0' }, base).text,
    listingShare({ pubkey: 'p', mode: 'fixed', amount: '1000000', decimals: 6, price: '1000000', topBid: '0' }, base).text,
    saleShare({ sig: 's', amount: '1000000', decimals: 6, price: '1500000000' }, base).text,
  ]
  for (const t of texts) { assert.doesNotMatch(t, /[-–—]/); assert.doesNotMatch(t, /\bOTC\b|\bdesk\b|nuking|audited/i) }
  assert.equal(tokenText('1500000', 6), '1.5'); assert.equal(tokenText('1234567000000', 6), '1,234,567'); assert.equal(tokenText('5', 0), '5')
  assert.equal(fmtSol('1500000000'), '1.5'); assert.equal(fmtSol('1000000'), '0.001'); assert.equal(fmtSol('0'), '0')
})
test('admin: secret required, flags change at runtime and survive a restart, unknown flags refused', async () => {
  const w = world(); const s = await site(w)
  assert.equal((await s.post('/api/admin/flags', { keeperLive: true })).status, 403)
  assert.equal((await s.post('/api/admin/flags', { keeperLive: true }, { 'x-admin-secret': 'wrong' })).status, 403)
  const r = await (await s.post('/api/admin/flags', { keeperLive: true, killReader: true }, ADMIN)).json()
  assert.deepEqual([r.keeperLive, r.killReader, r.readerLive], [true, true, false])
  assert.equal((await s.post('/api/admin/flags', { nope: true }, ADMIN)).status, 400)
  assert.equal((await s.post('/api/admin/flags', { keeperLive: 'yes' }, ADMIN)).status, 400)
  assert.equal(w.app.flags.keeperOn, true)
  const w2 = world({ conn: w.conn, db: w.db, keeperKey: w.keeper, clock: w.clock })
  assert.equal(w2.app.flags.keeperOn, true, 'survives a restart')
  assert.equal((await s.post('/api/admin/flags', { keeperLive: null }, ADMIN)).status, 200)
  assert.equal(w.app.flags.keeperOn, false, 'null clears it')
  const st = await (await s.get('/api/admin/status', ADMIN)).json()
  assert.ok(st.flags && st.rpc && st.xSpend)
  const raw = JSON.stringify(st)
  for (const secret of ['admin-test-secret-0123456789abcdef', w.env.KEEPER_SECRET, w.env.PASS_SECRET, w.env.LISTING_SECRET, 'bearer']) assert.ok(!raw.includes(secret), 'status has no secrets')
  assert.equal((await s.get('/api/admin/status')).status, 403)
  const noSecret = world({ env: { ADMIN_SECRET: '' } }); const s2 = await site(noSecret)
  assert.equal((await s2.get('/api/admin/status', { 'x-admin-secret': '' })).status, 403, 'an empty secret never matches')
  await s.close(); await s2.close()
})
test('API: rate limit, big body and bad JSON', async () => {
  const w = world(); const s = await site(w)
  assert.equal((await fetch(`${s.base}/api/admin/flags`, { method: 'POST', headers: ADMIN, body: '{' })).status, 400)
  assert.equal((await fetch(`${s.base}/api/admin/flags`, { method: 'POST', headers: ADMIN, body: 'x'.repeat(70_000) }).catch(() => ({ status: 413 }))).status, 413)
  let last = 200
  for (let i = 0; i < 250 && last === 200; i++) last = (await s.get('/api/listings')).status
  assert.equal(last, 429)
  await s.close()
})
test('pass API: off by default, needs a session and our origin', async () => {
  const w = world(); const s = await site(w)
  const o = { origin: 'https://sidebid.test' }
  assert.equal((await s.post('/api/pass', {}, o)).status, 401)
  w.app.auth.upsertUser({ xId: '1', handle: 'a', xCreatedAt: w.now() - 400 * 86400000, followers: 50 })
  w.db.run(`INSERT INTO sessions (token_hash,x_id,expires_at) VALUES (?,?,?)`, (await import('node:crypto')).createHash('sha256').update('tok').digest('hex'), '1', w.now() + 1e7)
  assert.equal((await s.post('/api/pass', {}, { ...o, cookie: 'lb_s=tok' })).status, 404, 'flag off')
  flagsOn(w, 'passLive')
  assert.equal((await s.post('/api/pass', { campaign: 'x', wallet: 'y' }, { ...o, cookie: 'lb_s=tok' })).status, 409, 'no wallet yet')
  await s.close()
})
test('neutral names: no file in server/ names an older project or account', () => {
  const banned = ['Y2Fub25wYWQ=', 'YW50aXZhbXA=', 'cHJpbWVwYWQ=', 'ZWxlY3Rpb24gcGFk', 'Y2Fub24gcGFk', 'cHJpbWUtc2k=', 'bGF1bmNoLWtpdA==', 'bGF1bmNoLTIwMjY=', 'aXNsZXM=', 'dHVtYmxl', 'JDc3Nw==', 'bGF1bmNoLXJlc3VsdHM=', 'bG93YmFsbC1yZXNlYXJjaA==', 'cHJvdmVuYW5jZQ=='].map((b) => Buffer.from(b, 'base64').toString()) // kept encoded, so this file passes its own test
  const root = new URL('..', import.meta.url).pathname, hits = []
  const walk = (d) => { for (const f of readdirSync(d)) { if (['node_modules', 'data', '.git'].includes(f)) continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { const t = readFileSync(p, 'utf8').toLowerCase(); for (const b of banned) if (t.includes(b)) hits.push(`${p}: ${b.length}`) } } }
  walk(root)
  assert.deepEqual(hits, [])
})
test('local env files cannot be committed', () => {
  assert.ok(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').includes('*.env'))
})
test('env var names are neutral and config has a hard ceiling', () => {
  const names = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split('\n').filter((l) => /^[A-Z]/.test(l)).map((l) => l.split('=')[0])
  assert.ok(names.includes('RPC_URL') && names.includes('X_READ_BEARER'))
  for (const line of readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split('\n')) if (/SECRET|BEARER|TOKEN|PASS_HASH/.test(line) && !line.startsWith('#') && !/PER_|DAILY/.test(line)) assert.match(line, /=$/, 'no values in the example')
  assert.equal(loadConfig({ X_DAILY_SPEND_CAP_USD: '1000' }).x.dailyCapUsd, HARD_X_SPEND_CEILING_USD)
})
test('end to end through the HTTP layer and the loops: a tag becomes a card, a bid, a window, an accept, a sale', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive', 'keeperLive'); const s = await site(w)
  const sel = seller(w, { username: 'endtoend' })
  tag(w, sel, `@sidebidsol all ${sel.mint.toBase58()} 2m min 0.002`)
  await readerStep(w); await w.app.indexer.tick(); await w.app.replies.tick()
  const card = (await (await s.get('/api/listings?mode=accept')).json()).items[0]
  assert.deepEqual([card.phase, card.seller.handle, card.price, card.amount], ['live', 'endtoend', '2000000', '1000000000'])
  assert.equal(w.x.posts.length, 1)
  const buyer = w.conn.wallet(); const pub = new (w.config.programId.constructor)(card.pubkey)
  bid(w, pub, buyer, 5_000_000n); await w.app.indexer.tick()
  w.conn.warp(120)
  await w.app.keeper.tick(); await w.app.replies.tick()
  assert.equal(w.x.posts.length, 2); assert.match(w.x.posts[1].text, /0\.005 SOL/)
  assert.equal((await (await s.get(`/api/listings/${card.pubkey}`)).json()).phase, 'accept_window')
  const wt = w.conn.ata(buyer.publicKey, sel.mint)
  w.conn.send(w.app.prog.ix.accept(chainListing(w, pub), sel.tokenAccount, wt), sel.kp)
  await w.app.indexer.tick()
  const done = await (await s.get(`/api/listings/${card.pubkey}`)).json()
  assert.deepEqual([done.phase, done.closed], ['sold', true])
  assert.equal(w.conn.tokenAmount(wt), 1_000_000_000n)
  assert.equal((await (await s.get('/api/sales')).json()).items.length, 1)
  await s.close()
})
