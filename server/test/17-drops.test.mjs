// The first hour dev drops: the schedule math, the price floor and its sources, the dev key guard, the kill switch, skips,
// one sold and one skipped cycle on the real contract (LiteSVM), the X post, and the admin and public routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { world, flagsOn, bid, chainListing, SOL, TOKEN, spl } from './harness.mjs'
import { dropAmounts, dropTotal, pctText, minBidFor, checkDropIxs, DropGuardError, PriceFeed, PUMP_PROGRAM, bondingCurvePda, readCurve, dropPostText, lengthWords, DROP_COUNT } from '../src/drops.mjs'
import { hasLink } from '../src/x/client.mjs'
import { listen } from '../src/http.mjs'
import { withLaunch } from '../src/launch.mjs'
import { MIN_PRICE_LAMPORTS } from '../src/chain/program.mjs'

const SUPPLY = 1_000_000_000n * 1_000_000n // pump.fun: one billion tokens, 6 decimals
const made = []
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d }
// A fixed chart price: 60 SOL of virtual SOL over 536 million virtual tokens, lamports per base unit
const PRICE = { num: '60000000000', den: '536000000000000', source: 'test curve' }

function dropWorld({ env = {}, devHolds = SUPPLY / 20n, feed = PRICE } = {}) {
  const dev = Keypair.generate()
  const w = world({ env: { DEV_SECRET: bs58.encode(dev.secretKey), X_DAILY_SPEND_CAP_USD: '5', ...env } })
  w.conn.svm.airdrop(dev.publicKey.toBase58(), 5n * SOL); w.conn.known.add(dev.publicKey.toBase58())
  const mint = w.conn.mint()
  const ata = w.conn.ata(dev.publicKey, mint, devHolds)
  const others = Keypair.generate(); w.conn.ata(others.publicKey, mint, SUPPLY - devHolds)
  flagsOn(w, 'keeperLive')
  w.app.drops.feed = { read: async () => (typeof feed === 'function' ? feed() : feed) }
  const step = async () => { await w.app.drops.tick(); await w.app.indexer.tick(); await w.app.keeper.tick(); await w.app.drops.tick() }
  const rows = () => w.db.all('SELECT * FROM drops ORDER BY plan, idx')
  const ownPosts = () => w.x.posts.filter((p) => !p.reply)
  return { w, dev, mint, ata, step, rows, ownPosts }
}
/** Every transaction the dev key signed, decoded from the bytes the Sender stored. */
const devSigned = (w, dev) => w.db.all('SELECT kind, raw FROM tx_intents').map((r) => ({ kind: r.kind, tx: Transaction.from(Buffer.from(r.raw, 'base64')) })).filter((r) => r.tx.signatures.some((s) => s.publicKey.equals(dev.publicKey)))

// ---------------------------------------------------------------- schedule math
test('schedule: 12 drops, each 1.25x the last, exactly 5% of supply in total', () => {
  for (const supply of [SUPPLY, 999_999_999_999_937n, 123_456_789n * 1_000_000n + 7n]) {
    const a = dropAmounts(supply)
    assert.equal(a.length, DROP_COUNT)
    assert.equal(a.reduce((x, y) => x + y, 0n), dropTotal(supply), 'adds up to exactly 5%')
    assert.equal(dropTotal(supply), (supply * 5n) / 100n)
    for (let i = 1; i < a.length; i++) { const r = Number(a[i]) / Number(a[i - 1]); assert.ok(Math.abs(r - 1.25) < 1e-6, `ratio ${i}: ${r}`) }
  }
  const pcts = dropAmounts(SUPPLY).map((x) => pctText(x, SUPPLY))
  assert.deepEqual(pcts, ['0.0922%', '0.1153%', '0.1441%', '0.1802%', '0.2252%', '0.2815%', '0.3519%', '0.4398%', '0.5498%', '0.6872%', '0.8590%', '1.0738%'])
  // The exact weights: drop 1 is 5% x 4^11 / (5^12 - 4^12)
  assert.equal(dropAmounts(SUPPLY)[0], (SUPPLY * 5n / 100n) * 4n ** 11n / (5n ** 12n - 4n ** 12n))
})

// ---------------------------------------------------------------- price floor
test('price floor: 15% under the chart, rounded down to 0.0001 SOL, never under 0.001 SOL', () => {
  const amt = 922_419_000_000n // about 922 thousand tokens
  const chart = (amt * 60_000_000_000n) / 536_000_000_000_000n // lamports at chart price
  const m = minBidFor(amt, PRICE)
  assert.ok(m <= (chart * 85n) / 100n, 'at least 15% under')
  assert.ok(m > (chart * 85n) / 100n - 100_000n, 'by no more than the rounding step')
  assert.equal(m % 100_000n, 0n)
  assert.equal(minBidFor(1n, PRICE), MIN_PRICE_LAMPORTS, 'tiny amounts open at the contract minimum')
})

test('price: pump.fun curve before graduation, else DexScreener checked against Jupiter, two reads that must agree', async () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const curve = (vsol, vtok, complete = 0) => { const d = Buffer.alloc(81); Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(d); d.writeBigUInt64LE(vtok, 8); d.writeBigUInt64LE(vsol, 16); d.writeBigUInt64LE(SUPPLY, 40); d[48] = complete; return { owner: PUMP_PROGRAM, data: d, lamports: 1 } }
  let acct = curve(60_000_000_000n, 536_000_000_000_000n)
  const rpc = { account: async (k) => { assert.ok(k.equals(bondingCurvePda(mint))); return acct } }
  const answers = { dex: null, jup: null }
  const fetchImpl = async (url) => {
    const j = /dexscreener/.test(url) ? answers.dex : answers.jup
    if (j === 'down') throw new Error('down')
    return { ok: !!j, json: async () => j }
  }
  const feed = new PriceFeed({ rpc, fetchImpl, stableMs: 0 })
  const p = await feed.read(mint, 6)
  assert.deepEqual([p.num, p.den, p.source], ['60000000000', '536000000000000', 'pump.fun bonding curve'])
  assert.equal(readCurve({ ...acct, owner: SystemProgram.programId }), null, 'only an account the pump program owns is a curve')
  // a curve that looks wrong is refused, not used
  acct = curve(100n, 536_000_000_000_000n)
  await assert.rejects(feed.read(mint, 6), /curve_looks_wrong/)
  // graduated: off chain sources
  acct = curve(60_000_000_000n, 536_000_000_000_000n, 1)
  const SOLM = 'So11111111111111111111111111111111111111112'
  const dex = (price, liq = 80) => ({ pairs: [{ chainId: 'solana', baseToken: { address: mint }, quoteToken: { address: SOLM }, priceNative: String(price), liquidity: { quote: liq } }] })
  const jup = (usd, solUsd = 150) => ({ [mint]: { usdPrice: usd }, [SOLM]: { usdPrice: solUsd } })
  answers.dex = dex(0.0000002); answers.jup = jup(0.0000002 * 150 * 1.03)
  let q = await feed.read(mint, 6)
  assert.equal(q.source, 'DexScreener, checked against Jupiter')
  assert.ok(Math.abs(Number(q.num) / Number(q.den) - 0.0000002 * 1e9 / 1e6) < 1e-9)
  answers.jup = jup(0.0000002 * 150 * 1.5)
  await assert.rejects(feed.read(mint, 6), /price_sources_disagree/, 'two sources 50% apart: no price')
  answers.jup = 'down'
  q = await feed.read(mint, 6)
  assert.equal(q.source, 'DexScreener (Jupiter did not answer)', 'fallback: one source alone')
  answers.dex = dex(0.0000002, 1); answers.jup = jup(0.0000003)
  q = await feed.read(mint, 6)
  assert.equal(q.source, 'Jupiter (DexScreener did not answer)', 'a pool under 5 SOL is not a price')
  answers.dex = null; answers.jup = null
  await assert.rejects(feed.read(mint, 6), /no_price/)
  // a price that moves more than 10% between the two reads is not used
  let n = 0
  const moving = new PriceFeed({ rpc: { account: async () => curve(n++ ? 90_000_000_000n : 60_000_000_000n, 536_000_000_000_000n) }, stableMs: 0 })
  await assert.rejects(moving.read(mint, 6), /price_moving/)
})

// ---------------------------------------------------------------- the guard
test('guard: the dev key signs only this drop, for exactly its amount, of the configured mint', () => {
  const { w, dev, mint, ata } = dropWorld()
  const P = w.app.prog, amounts = dropAmounts(SUPPLY)
  const g = { programId: P.programId, dev: dev.publicKey, mint: mint.toBase58(), configuredMint: mint.toBase58(), tokenProgram: TOKEN.toBase58(), kind: 'list', amount: amounts[2], maxAmount: amounts[11], roomLeft: dropTotal(SUPPLY), lengthS: 240 }
  const list = (o = {}) => P.ix.createBidding({ seller: dev.publicKey, tokenAccount: ata, mint, tokenProgram: TOKEN, amount: amounts[2], minBid: 50_000_000n, duration: 240, ...o })
  const refuses = (ixs, reason, over = {}) => assert.throws(() => checkDropIxs(ixs, { ...g, ...over }), (e) => e instanceof DropGuardError && e.reason === reason, reason)
  assert.equal(checkDropIxs([list()], g), true)
  refuses([list(), list()], 'one_instruction_only')
  refuses([SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })], 'wrong_program')
  refuses([spl.createTransferInstruction(ata, ata, dev.publicKey, 1n)], 'wrong_program')
  refuses([spl.createApproveInstruction(ata, Keypair.generate().publicKey, dev.publicKey, amounts[2])], 'wrong_program')
  refuses([list({ amount: amounts[2] + 1n })], 'amount_not_this_drop')
  refuses([list({ amount: amounts[11] + 1n })], 'amount_over_drop_cap', { amount: amounts[11] + 1n })
  refuses([list()], 'amount_over_total_cap', { roomLeft: amounts[2] - 1n })
  refuses([list({ duration: 3600 })], 'wrong_length')
  refuses([list()], 'mint_not_configured', { configuredMint: Keypair.generate().publicKey.toBase58() })
  // a fixed price listing has the same accounts: refused on its mode byte
  const fixed = list(); fixed.data = Buffer.from(fixed.data); fixed.data[8] = 1
  refuses([fixed], 'not_bidding')
  // another mint's account of the dev
  const other = w.conn.mint(), otherAta = w.conn.ata(dev.publicKey, other, 1000n)
  refuses([P.ix.createBidding({ seller: dev.publicKey, tokenAccount: otherAta, mint: other, tokenProgram: TOKEN, amount: amounts[2], minBid: 50_000_000n, duration: 240 })], 'wrong_listing')
  // someone else as seller
  const stranger = Keypair.generate()
  refuses([P.ix.createBidding({ seller: stranger.publicKey, tokenAccount: ata, mint, tokenProgram: TOKEN, amount: amounts[2], minBid: 50_000_000n, duration: 240 })], 'dev_must_be_the_only_signer')
  // cancel: only with no top bidder
  const cancel = P.ix.cancelNoBids({ seller: dev.publicKey, tokenAccount: ata, tokenProgram: TOKEN })
  assert.equal(checkDropIxs([cancel], { ...g, kind: 'cancel' }), true)
  const withBidder = new TransactionInstruction({ programId: cancel.programId, data: cancel.data, keys: cancel.keys.map((k, i) => (i === 5 || i === 6 ? { ...k, pubkey: Keypair.generate().publicKey } : k)) })
  refuses([withBidder], 'cancel_with_bidder', { kind: 'cancel' })
  refuses([list()], 'not_cancel', { kind: 'cancel' })
})

test('start: refused without the keeper, without enough tokens, for another mint, and a second time once anything listed', async () => {
  const short = dropWorld({ devHolds: SUPPLY / 20n - 1n })
  assert.equal((await short.w.app.drops.start({ firstAt: short.w.now(), ca: short.mint.toBase58() })).error, 'dev_tokens_short')
  const d = dropWorld({ env: { DROPS_MINT: Keypair.generate().publicKey.toBase58() } })
  assert.equal((await d.w.app.drops.start({ firstAt: d.w.now(), ca: d.mint.toBase58() })).error, 'mint_not_configured')
  const e = dropWorld()
  e.w.app.flags.set({ keeperLive: false })
  assert.equal((await e.w.app.drops.start({ firstAt: e.w.now(), ca: e.mint.toBase58() })).error, 'keeper_off')
  e.w.app.flags.set({ keeperLive: true })
  assert.equal((await e.w.app.drops.start({ firstAt: e.w.now() - 3_600_000, ca: e.mint.toBase58() })).error, 'bad_time')
  assert.equal((await e.w.app.drops.start({ firstAt: e.w.now(), ca: e.mint.toBase58(), preview: true })).error, 'preview_only')
  const ok = await e.w.app.drops.start({ firstAt: e.w.now(), ca: e.mint.toBase58() })
  assert.equal(ok.error, undefined)
  assert.equal(ok.drops.length, 12)
  assert.equal(ok.drops.reduce((a, r) => a + BigInt(r.amount), 0n), SUPPLY / 20n)
  assert.equal(ok.plan.author.handle, 'sidebidsol', 'the posting account read from X')
  assert.match(ok.plan.author.avatar, /_200x200\.png$/)
  assert.equal((await e.w.app.drops.start({ firstAt: e.w.now(), ca: e.mint.toBase58() })).error, 'plan_running')
  await e.step()
  assert.equal(e.rows()[0].state, 'live')
  assert.equal((await e.w.app.drops.start({ firstAt: e.w.now(), ca: e.mint.toBase58(), replace: true })).error, 'already_started', 'never a second 5%')
})

// ---------------------------------------------------------------- a sold drop and a skipped drop on the real contract
test('cycle: drop 1 lists and posts on X, a bid wins and settles; drop 2 gets no bid and is skipped, its tokens stay', async () => {
  const { w, dev, mint, ata, step, rows, ownPosts } = dropWorld()
  const P = w.app.prog, amounts = dropAmounts(SUPPLY)
  const start = await w.app.drops.start({ firstAt: w.now(), ca: mint.toBase58() })
  assert.equal(start.error, undefined)
  await step()
  let r = rows()[0]
  assert.equal(r.state, 'live', r.reason)
  const lk = P.listingPda(ata)
  const l = chainListing(w, lk)
  assert.deepEqual([l.mode, l.amount, l.price, l.seller.toBase58()], ['bidding', amounts[0], minBidFor(amounts[0], PRICE), dev.publicKey.toBase58()])
  assert.equal(l.hardEndTime - l.endTime, 300, 'the usual anti-snipe rules: up to 5 minutes more')
  // The contract approved exactly this drop's amount, nothing else
  const tok = spl.unpackAccount(ata, w.conn.info(ata), TOKEN)
  assert.equal(tok.delegatedAmount, amounts[0]); assert.ok(tok.delegate.equals(lk))
  // Posted at once, text only words, picture uploaded, id and link stored with the drop
  const posts = ownPosts()
  assert.equal(posts.length, 1)
  assert.match(posts[0].text, /^Drop 1 of 12 is live: 922,378 \$SIDEBID, starting bid 0\.\d{1,4} SOL, ends in 4 minutes\.$/)
  assert.equal(hasLink(posts[0].text), false, 'billed at the plain post price')
  assert.doesNotMatch(posts[0].text, /bag|[‐-―]| - /i)
  assert.deepEqual(posts[0].media?.media_ids, ['771'], 'the share card went in')
  r = rows()[0]
  assert.equal(r.post_url, `https://x.com/sidebidsol/status/${posts[0].id}`)
  // The listing card carries the drop and the post
  const card = await w.app.listings.one(lk.toBase58())
  assert.equal(card.drop.n, 1); assert.equal(card.drop.post.url, r.post_url); assert.equal(card.drop.post.author.handle, 'sidebidsol')
  assert.equal(card.seller.handle, 'sidebidsol', 'listed on X by the coin account')
  // A bid, the end, the keeper settles: sold
  const bidder = w.conn.wallet()
  bid(w, lk, bidder, l.price)
  w.conn.warp(241)
  for (let i = 0; i < 6 && rows()[0].state !== 'sold'; i++) { await step(); w.conn.warp(3) }
  r = rows()[0]
  assert.equal(r.state, 'sold', `${r.state} ${r.reason}`)
  assert.equal(r.sold_lamports, l.price.toString()); assert.equal(r.winner, bidder.publicKey.toBase58())
  assert.equal(w.conn.tokenAmount(spl.getAssociatedTokenAddressSync(mint, bidder.publicKey)), amounts[0])
  // Drop 2 waits for its time, then lists. Nobody bids: cancelled after the end, approval gone, tokens never moved.
  await step()
  assert.equal(rows()[1].state, 'pending')
  w.conn.warp(60)
  await step()
  assert.equal(rows()[1].state, 'live')
  const held = w.conn.tokenAmount(ata)
  w.conn.warp(241)
  await step()
  assert.equal(rows()[1].state, 'live', 'not cancelled right at the end: the chain clock may lag')
  w.conn.warp(21)
  for (let i = 0; i < 4 && rows()[1].state !== 'skipped'; i++) { await step(); w.conn.warp(2) }
  r = rows()[1]
  assert.deepEqual([r.state, r.reason], ['skipped', 'no_bids'])
  assert.equal(chainListing(w, lk), null, 'listing closed')
  const after = spl.unpackAccount(ata, w.conn.info(ata), TOKEN)
  assert.equal(after.amount, held, 'the tokens stayed in the dev wallet')
  assert.equal(after.delegate, null, 'and the approval is gone')
  // No rollover: drop 3 is its own amount, at its own time
  w.conn.warp(60)
  await step()
  assert.equal(rows()[2].state, 'live')
  assert.equal(chainListing(w, lk).amount, amounts[2])
  // Every transaction the dev key signed: compute budget plus one create_listing or cancel of our program, nothing else
  const signed = devSigned(w, dev)
  assert.equal(signed.length, 4)
  for (const { tx } of signed) {
    const own = tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId))
    assert.equal(own.length, 1); assert.ok(own[0].programId.equals(P.programId))
    assert.ok(tx.feePayer.equals(w.keeper.publicKey), 'the keeper pays the network fee')
  }
  // Status: what listed, sold or was skipped, SOL received, post links
  const st = w.app.drops.status()
  assert.deepEqual([st.totals.listed, st.totals.sold, st.totals.skipped], [3, 1, 1])
  assert.equal(st.totals.solReceivedLamports, l.price.toString())
  assert.equal(st.totals.posts.length, 3)
  // The dev counts in the rewards like any seller
  assert.ok(w.db.get('SELECT 1 FROM sales WHERE seller=?', dev.publicKey.toBase58()))
})

test('kill switch: dropsPaused skips the next drop and signs nothing; turning it back lets the next one list', async () => {
  const { w, dev, mint, step, rows, ownPosts } = dropWorld()
  await w.app.drops.start({ firstAt: w.now(), ca: mint.toBase58() })
  w.app.flags.set({ dropsPaused: true })
  await step()
  assert.deepEqual([rows()[0].state, rows()[0].reason], ['skipped', 'paused'])
  assert.equal(devSigned(w, dev).length, 0); assert.equal(ownPosts().length, 0)
  w.app.flags.set({ dropsPaused: false })
  w.conn.warp(300)
  await step()
  assert.equal(rows()[1].state, 'live')
})

test('skips: no price within 90 seconds, or a drop missed by an outage; never a rushed relist', async () => {
  let fail = true
  const { w, dev, mint, step, rows } = dropWorld({ feed: () => { if (fail) throw new Error('no_price'); return PRICE } })
  await w.app.drops.start({ firstAt: w.now(), ca: mint.toBase58() })
  await step()
  assert.equal(rows()[0].state, 'pending')
  w.conn.warp(91)
  await step()
  assert.deepEqual([rows()[0].state, rows()[0].reason], ['skipped', 'no_price'])
  fail = false
  w.conn.warp(3 * 300) // the server was away past drop 2's whole window
  await step()
  assert.deepEqual([rows()[1].state, rows()[1].reason], ['skipped', 'missed'])
  assert.equal(rows()[2].state, 'live', 'drop 3 is still inside its window, so it lists on its own')
  assert.equal(devSigned(w, dev).length, 1)
})

test('X: links only with X_DROP_POST_LINKS, a failed upload posts text only, a post never blocks the drop', async () => {
  const a = dropWorld({ env: { X_DROP_POST_LINKS: '1' } })
  a.w.x.mediaFail = 500
  await a.w.app.drops.start({ firstAt: a.w.now(), ca: a.mint.toBase58() })
  await a.step()
  const p = a.ownPosts()[0]
  assert.match(p.text, /\nhttps:\/\/sidebid\.test\/lot\/\w+$/)
  assert.equal(p.media, undefined, 'text only when the upload fails')
  assert.equal(a.w.app.x.postCost(p.text), 0.2)
  const b = dropWorld()
  await b.w.app.drops.start({ firstAt: b.w.now(), ca: b.mint.toBase58() })
  b.w.x.fail = { status: 402, body: { title: 'CreditsDepleted' } }
  await b.step()
  assert.equal(b.rows()[0].state, 'live')
  assert.equal(b.rows()[0].post_state, 'failed')
  assert.equal(dropPostText({ n: 3, amount: 1_441_300_000_000n, decimals: 6, ticker: 'SIDEBID', minBid: 123_400_000n, lengthS: 240 }), 'Drop 3 of 12 is live: 1,441,300 $SIDEBID, starting bid 0.1234 SOL, ends in 4 minutes.')
  assert.equal(lengthWords(45), '45 seconds'); assert.equal(lengthWords(60), '1 minute')
})

test('routes: start needs the reveal and the admin secret; status and the public view', async () => {
  const { w, mint } = dropWorld()
  const dir = tmp('sb-drops-'), file = join(dir, 'site.json'), dist = tmp('sb-dist-')
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>')
  writeFileSync(file, JSON.stringify({ brand: { reveal: false } }))
  const site = (req, res) => { res.writeHead(404); res.end('{}') }
  const server = await listen(withLaunch(site, w.app, w.config, { dist, env: { SITE_CONFIG: file } }), 0)
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (p, body, secret = w.env.ADMIN_SECRET) => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => [r.status, await r.json()])
  try {
    assert.equal((await call('/api/admin/drops/start', { firstAt: new Date(w.now()).toISOString() }, 'wrong'))[0], 403)
    assert.deepEqual(await call('/api/admin/drops/start', { firstAt: new Date(w.now()).toISOString() }), [400, { error: 'not_revealed' }])
    writeFileSync(file, JSON.stringify({ brand: { reveal: true, ca: mint.toBase58(), xHandle: 'sidebidsol' } }))
    await new Promise((ok) => setTimeout(ok, 20))
    const [code, body] = await call('/api/admin/drops/start', { firstAt: new Date(w.now() + 60_000).toISOString(), mint: Keypair.generate().publicKey.toBase58() })
    assert.equal(code, 200, JSON.stringify(body))
    assert.equal(body.plan.mint, mint.toBase58(), 'the mint is the revealed CA, never one from the request')
    const [, st] = await call('/api/admin/drops')
    assert.equal(st.drops.length, 12); assert.equal(st.totals.pending, 12); assert.equal(st.paused, false)
    const pub = await fetch(base + '/api/site/drops').then((r) => r.json())
    assert.equal(pub.drops.length, 12); assert.equal(pub.drops[0].reason, undefined, 'the public view has no internals')
    assert.equal((await call('/api/admin/flags', null))[0], 404)
  } finally { server.close() }
})
