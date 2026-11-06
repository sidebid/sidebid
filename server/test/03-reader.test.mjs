import test from 'node:test'
import assert from 'node:assert/strict'
import { world, seller, tag, readerStep, flagsOn, chainListing, Keypair, T22, tweetId, spl, SOL } from './harness.mjs'
import { tagListingId, MIN_PRICE_LAMPORTS } from '../src/chain/program.mjs'
import { TAG_RENT_LAMPORTS } from '../src/x/reader.mjs'
import { Spend } from '../src/x/client.mjs'

const on = (over) => { const w = world(over); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive'); return w }
const state = (w, id) => w.db.get('SELECT state, reason, listing FROM mentions WHERE tweet_id=?', id)
const pda = (w, id) => w.app.prog.acceptPda(tagListingId(id))

test('a good tag makes a real card on chain, for the linked wallet, moving nothing', async () => {
  const w = on(); const s = seller(w)
  const before = w.conn.tokenAmount(s.tokenAccount)
  const id = tag(w, s, `@sidebidsol sell 500 ${s.mint.toBase58()} min 0.5 sol 10m`)
  await readerStep(w)
  assert.equal(state(w, id).state, 'live')
  const l = chainListing(w, pda(w, id))
  assert.equal(l.mode, 'accept'); assert.equal(l.seller.toBase58(), s.kp.publicKey.toBase58())
  assert.equal(l.amount, 500_000_000n, 'in base units for 6 decimals'); assert.equal(l.price, 500_000_000n)
  assert.equal(l.acceptWindowSecs, 600); assert.equal(l.endTime, w.conn.now() + 600)
  assert.equal(l.rentPayer.toBase58(), w.config.listingKey.publicKey.toBase58())
  assert.equal(w.conn.tokenAmount(s.tokenAccount), before, 'tokens stayed')
  const acct = spl.unpackAccount(s.tokenAccount, w.conn.info(s.tokenAccount))
  assert.equal(acct.delegate, null, 'no permission given to anyone')
})
test('"all" sells the balance, no minimum means the contract floor, default length', async () => {
  const w = on(); const s = seller(w, { amount: 777n })
  const id = tag(w, s, `@sidebidsol sell all ${s.mint.toBase58()}`)
  await readerStep(w)
  const l = chainListing(w, pda(w, id))
  assert.deepEqual([l.amount, l.price, l.endTime], [777n, MIN_PRICE_LAMPORTS, w.conn.now() + 300])
})
test('a percent is worked out from the linked wallet when the post is read, and the reply states the exact count', async () => {
  const w = on(); const s = seller(w, { amount: 300_000_001n })
  const id = tag(w, s, `@sidebidsol sell 50% ${s.mint.toBase58()} 10m`)
  await readerStep(w)
  assert.equal(state(w, id).state, 'live')
  const l = chainListing(w, pda(w, id))
  assert.deepEqual([l.amount, l.endTime], [150_000_000n, w.conn.now() + 600], 'half, rounded down, and 10m is the length')
  const reply = w.db.get(`SELECT text FROM replies WHERE kind='live' AND tweet_id=?`, id)
  assert.match(reply.text, /^Your card is live: selling 150 of 300\.000001 tokens\. Bids close in 10 minutes\./)
  const t = tag(w, s, `@sidebidsol sell 1% ${s.mint.toBase58()}`)
  const tiny = seller(w, { xId: '120', username: 'tiny', amount: 50n })
  const z = tag(w, tiny, `@sidebidsol 1% ${tiny.mint.toBase58()}`); await readerStep(w)
  assert.equal(state(w, z).reason, 'does_not_hold', '1% of 50 base units rounds to nothing')
  assert.equal(state(w, t).reason, 'already_live', 'one live card per wallet and coin')
})
test('not holding, too little and junk: nothing happens on chain; new and small accounts are not refused', async () => {
  const w = on(); const s = seller(w, { amount: 10n })
  const cases = {
    does_not_hold: `@sidebidsol 1000000 ${s.mint.toBase58()}`,
    'parse:unknown_word': `@sidebidsol wen moon ${s.mint.toBase58()} 5`,
    'parse:no_ca': '@sidebidsol 500',
    not_a_mint: `@sidebidsol 5 ${Keypair.generate().publicKey.toBase58()}`,
  }
  for (const [why, text] of Object.entries(cases)) { const id = tag(w, s, text); await readerStep(w); assert.deepEqual([state(w, id).state, state(w, id).reason], ['ignored', why], text) }
  const young = seller(w, { xId: '101', username: 'young', ageDays: 3 })
  const y = tag(w, young, `@sidebidsol 1 ${young.mint.toBase58()}`); await readerStep(w); assert.notEqual(state(w, y).reason, 'not_eligible', 'no account age minimum')
  const few = seller(w, { xId: '102', username: 'few', followers: 2 })
  const f = tag(w, few, `@sidebidsol 1 ${few.mint.toBase58()}`); await readerStep(w); assert.notEqual(state(w, f).reason, 'not_eligible', 'no follower minimum')
  // Never signed in: the holder's post counts for nothing
  const stranger = { id: '103', username: 'stranger', createdAt: w.now() - 500 * 86400000, followers: 99 }
  const t = tweetId(); w.x.addMention({ id: t, text: `@sidebidsol 1 ${s.mint.toBase58()}`, author: stranger, createdAt: w.now() }); await readerStep(w); assert.equal(state(w, t).reason, 'not_signed_in')
  assert.deepEqual(w.db.all('SELECT handle FROM tag_cards ORDER BY handle').map((r) => r.handle), ['few', 'young'], 'only the new and the small account listed: no minimum, and nothing for the refused posts')
})
test('someone else tagging the same coin cannot list a holder', async () => {
  const w = on(); const victim = seller(w, { xId: '200', username: 'victim' })
  const other = seller(w, { xId: '201', username: 'other', amount: 0n, mint: victim.mint })
  const id = tag(w, other, `@sidebidsol 100 ${victim.mint.toBase58()}`); await readerStep(w)
  assert.equal(state(w, id).reason, 'does_not_hold')
  assert.equal(w.conn.info(pda(w, id)), null)
})
test('balance read failure is not "holds nothing": it retries and then works', async () => {
  const w = on(); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  let reads = 0 // the mint read works, the holding read fails
  w.conn.inject('accounts', () => { if (w.db.get(`SELECT 1 FROM mentions WHERE tweet_id=?`, id) && ++reads === 2) throw new Error('502 Bad Gateway') })
  await readerStep(w)
  assert.deepEqual([state(w, id).state, state(w, id).reason], ['retry', 'chain_read_failed'])
  assert.equal(w.conn.info(pda(w, id)), null)
  w.conn.clear('accounts'); w.clock.skew += 6000
  await w.app.reader.work()
  assert.equal(state(w, id).state, 'live')
})
test('mint read failure and RPC 429 are retries too; repeated failure ends as gave up, never as does not hold', async () => {
  const w = on(); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  w.conn.inject('accounts', () => { throw new Error('429 Too Many Requests') })
  await readerStep(w)
  assert.equal(state(w, id).state, 'retry')
  for (let i = 0; i < 8; i++) { w.clock.skew += 400_000 >> 2; await w.app.reader.work() }
  assert.notEqual(state(w, id).reason, 'does_not_hold')
  assert.match(state(w, id).reason, /gave_up:chain_read_failed|too_old|chain_read_failed/)
})
test('duplicates: same post twice from X, and a restart, make one card and one reply', async () => {
  const w = on(); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  await readerStep(w)
  w.db.setMeta('x_since_id', '1') // X gives it again
  w.conn.svm.expireBlockhash()
  await readerStep(w)
  await w.app.replies.tick()
  await w.app.replies.tick()
  assert.equal(w.db.get('SELECT COUNT(*) n FROM tag_cards').n, 1)
  assert.equal(w.db.get('SELECT COUNT(*) n FROM mentions WHERE tweet_id=?', id).n, 1)
  assert.equal(w.x.posts.length, 1)
})
test('restart between signing and knowing: the same signature is resolved, not a second card', async () => {
  const w = on(); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  w.conn.inject('send', () => 'land-then-throw', 1)
  await readerStep(w)
  assert.ok(w.conn.info(pda(w, id)), 'it landed although the send threw')
  // A new process on the same database
  const w2 = world({ conn: w.conn, db: w.db, x: w.x, clock: w.clock, keeperKey: w.keeper })
  await w2.app.reader.work()
  assert.equal(w.db.get('SELECT COUNT(*) n FROM tx_intents WHERE key=?', `create:${id}`).n, 1, 'one signature ever')
  assert.equal(state(w, id).state, 'live')
})
test('chain refusing the create after the read (tokens left meanwhile) ends the mention with no card', async () => {
  const w = on(); const s = seller(w)
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  // The read sees the bag, and then it moves before the transaction reaches the chain
  const real = w.conn.getMultipleAccountsInfo.bind(w.conn)
  w.conn.getMultipleAccountsInfo = async (keys) => {
    const seen = await real(keys)
    if (keys[0].equals(s.tokenAccount)) {
      const dest = w.conn.ata(w.conn.mintAuth.publicKey, s.mint)
      w.conn.send(spl.createTransferInstruction(s.tokenAccount, dest, s.kp.publicKey, 1_000_000_000n), s.kp)
      w.conn.getMultipleAccountsInfo = real
    }
    return seen
  }
  await readerStep(w)
  assert.deepEqual([state(w, id).state, state(w, id).reason], ['ignored', 'does_not_hold'])
  assert.equal(w.conn.info(pda(w, id)), null)
  assert.equal(w.db.get('SELECT COUNT(*) n FROM tag_cards').n, 0)
})
test('rent budget: spam cannot drain the listing key', async () => {
  const w = on({ env: { TAG_RENT_BUDGET_LAMPORTS: String(TAG_RENT_LAMPORTS * 2), TAG_PER_ACCOUNT_OPEN: '50', TAG_PER_ACCOUNT_DAY: '50' } })
  const start = w.conn.bal(w.config.listingKey.publicKey)
  const ids = []
  for (let i = 0; i < 4; i++) { const s = seller(w, { xId: String(300 + i), username: `s${i}` }); ids.push(tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)); await readerStep(w) }
  assert.deepEqual(ids.map((i) => state(w, i).state), ['live', 'live', 'ignored', 'ignored'])
  assert.equal(state(w, ids[3]).reason, 'budget:rent')
  const spent = start - w.conn.bal(w.config.listingKey.publicKey)
  assert.ok(spent < 2n * BigInt(TAG_RENT_LAMPORTS) + 100_000n, `spent ${spent}`)
})
test('per account open and per day limits, global hourly limit, one live card per wallet and coin', async () => {
  const w = on({ env: { TAG_PER_ACCOUNT_OPEN: '1', TAG_PER_ACCOUNT_DAY: '2' } })
  const s = seller(w); const m2 = w.conn.mint(); w.conn.ata(s.kp.publicKey, m2, 100_000_000n)
  const a = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`); await readerStep(w)
  const b = tag(w, s, `@sidebidsol 1 ${m2.toBase58()}`); await readerStep(w)
  assert.equal(state(w, a).state, 'live'); assert.equal(state(w, b).reason, 'budget:account_open')
  const w2 = on({ env: { TAG_PER_ACCOUNT_OPEN: '9' } })
  const t = seller(w2)
  tag(w2, t, `@sidebidsol 1 ${t.mint.toBase58()}`); await readerStep(w2)
  const dup = tag(w2, t, `@sidebidsol 2 ${t.mint.toBase58()}`); await readerStep(w2)
  assert.equal(state(w2, dup).reason, 'already_live')
  const w3 = on({ env: { TAG_GLOBAL_PER_HOUR: '1' } })
  const u = seller(w3), v = seller(w3, { xId: '401', username: 'v' })
  tag(w3, u, `@sidebidsol 1 ${u.mint.toBase58()}`); await readerStep(w3)
  const over = tag(w3, v, `@sidebidsol 1 ${v.mint.toBase58()}`); await readerStep(w3)
  assert.equal(state(w3, over).reason, 'budget:hour')
  const w4 = on({ env: { TAG_MIN_LISTING_BALANCE_LAMPORTS: String(100n * SOL) } })
  const x = seller(w4)
  const low = tag(w4, x, `@sidebidsol 1 ${x.mint.toBase58()}`); await readerStep(w4)
  assert.equal(state(w4, low).reason, 'budget:listing_key_low')
})
test('old posts: nothing from before first start, nothing older than the age limit', async () => {
  const w = on(); const s = seller(w)
  const id = tweetId(); w.x.addMention({ id, text: `@sidebidsol 1 ${s.mint.toBase58()}`, author: s.author, createdAt: w.now() - 3600_000 })
  await readerStep(w)
  assert.equal(state(w, id).reason, 'too_old')
  const later = tweetId(); w.x.addMention({ id: later, text: `@sidebidsol 1 ${s.mint.toBase58()}`, author: s.author, createdAt: w.now() - 31 * 60_000 })
  await readerStep(w)
  assert.equal(state(w, later).reason, 'too_old')
})
test('own posts and reposts are ignored', async () => {
  const w = on(); const s = seller(w, { xId: '424242', username: 'sidebidsol' })
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`); await readerStep(w)
  assert.equal(state(w, id).reason, 'own_post')
})
test('flags: off means no paid reads at all; kill switch beats the go-live flag', async () => {
  const w = world(); const s = seller(w)
  tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  await readerStep(w)
  assert.equal(w.x.calls.length, 0)
  flagsOn(w, 'readerLive', 'tagListingLive', 'killReader')
  await readerStep(w)
  assert.equal(w.x.calls.length, 0, 'killed')
  w.app.flags.set({ killReader: false }); await readerStep(w)
  assert.equal(w.x.calls.length, 1, 'no redeploy needed')
})
test('X credits run out: reader stops calling X, status says so, then recovers', async () => {
  const w = on(); const s = seller(w)
  w.x.fail = { status: 402, body: { title: 'CreditsDepleted', detail: 'no credits' } }
  await readerStep(w)
  const n = w.x.calls.length
  assert.equal(n, 1); assert.equal(w.app.x.available(), false)
  await readerStep(w); await readerStep(w)
  assert.equal(w.x.calls.length, n, 'no calls while out')
  w.x.fail = null; w.clock.skew += 3601_000
  const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()}`)
  await readerStep(w)
  assert.equal(state(w, id).state, 'live')
})
test('a 429 from X waits for its reset time', async () => {
  const w = on()
  const reset = Math.floor(w.now() / 1000) + 900
  w.x.fail = { status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(reset) } }
  await readerStep(w)
  const n = w.x.calls.length
  w.x.fail = null
  await readerStep(w)
  assert.equal(w.x.calls.length, n, 'held until the reset')
  w.clock.skew += 901_000
  await readerStep(w)
  assert.equal(w.x.calls.length, n + 1)
})
test('hard daily spend cap: no read is made that could cross it, and it resets the next day', async () => {
  const w = on({ env: { X_DAILY_SPEND_CAP_USD: '0.3', X_COST_PER_READ_USD: '0.005' } }) // one worst case page costs 20 x (0.001 + 0.010) = 0.22, over a read share of 0.12
  await readerStep(w)
  assert.equal(w.x.calls.length, 0, 'worst case is above the cap')
  assert.equal(w.app.reader.status.lastError, 'cap')
  const w2 = on({ env: { X_DAILY_SPEND_CAP_USD: '0.6', X_COST_PER_READ_USD: '0.005' } })
  const s = seller(w2)
  for (let i = 0; i < 5; i++) tag(w2, s, `@sidebidsol junk ${i}`)
  await readerStep(w2)
  const spent = w2.app.x.spend.status().spentUsd
  assert.ok(Math.abs(spent - 0.015) < 1e-9, `billed for 5 owned reads + 1 user read, got ${spent}`)
  const w3 = on({ env: { X_DAILY_SPEND_CAP_USD: '999' } })
  assert.equal(w3.app.x.spend.status().capUsd, 25, 'config cannot raise it past the ceiling in code')
})
test('spend ledger: reserve is all or nothing and survives a new process', () => {
  const w = world(); const sp = new Spend({ db: w.db, capUsd: 1, now: w.now })
  assert.equal(sp.reserve(0.7), true); assert.equal(sp.reserve(0.4), false); assert.equal(sp.reserve(0.3), true)
  assert.equal(new Spend({ db: w.db, capUsd: 1, now: w.now }).reserve(0.01), false)
  w.clock.skew += 86_400_000
  assert.equal(sp.reserve(1), true, 'new UTC day')
})
test('Token 2022 with CPI Guard: card goes live, reply says it', async () => {
  const w = on(); const mint = w.conn.mint({ program: T22 })
  const s = seller(w, { mint, program: T22, amount: 0n })
  // The ATA, grown to hold the guard, then enabled: the contract takes the ATA only
  w.conn.send(spl.createMintToInstruction(mint, s.tokenAccount, w.conn.mintAuth.publicKey, 100n, [], T22), w.conn.mintAuth)
  w.conn.send(spl.createReallocateInstruction(s.tokenAccount, s.kp.publicKey, [spl.ExtensionType.CpiGuard], s.kp.publicKey, [], T22), s.kp)
  w.conn.send(spl.createEnableCpiGuardInstruction(s.tokenAccount, s.kp.publicKey, [], T22), s.kp)
  const id = tag(w, s, `@sidebidsol all ${mint.toBase58()}`)
  await readerStep(w)
  assert.equal(state(w, id).state, 'live')
  await w.app.replies.tick()
  assert.match(w.x.posts[0].text, /CPI Guard is on|CPI Guard on/)
  const pub = pda(w, id).toBase58()
  const card = await w.app.listings.one(pub)
  assert.equal(card.acceptBlocked.reason, 'cpi_guard')
  assert.match(card.acceptBlocked.message, /CPI Guard/)
})
