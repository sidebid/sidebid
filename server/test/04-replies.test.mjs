import test from 'node:test'
import assert from 'node:assert/strict'
import { world, seller, tag, readerStep, flagsOn, bid, tweetId, SOL } from './harness.mjs'
import { tagListingId } from '../src/chain/program.mjs'
import { hasLink } from '../src/x/client.mjs'

const on = (over) => { const w = world(over); flagsOn(w, 'readerLive', 'tagListingLive', 'repliesLive'); return w }
async function live(w, seconds = '5m') { const s = seller(w); const id = tag(w, s, `@sidebidsol 1 ${s.mint.toBase58()} ${seconds}`); await readerStep(w); return { s, id, listing: w.app.prog.acceptPda(tagListingId(id)) } }
const row = (w, kind, id) => w.db.get('SELECT * FROM replies WHERE kind=? AND tweet_id=?', kind, id)

test('live reply: goes to the tagging post, once, no link by default and billed as a plain post, no dashes', async () => {
  const w = on(); const { id, listing } = await live(w)
  const before = w.app.x.spend.spent()
  await w.app.replies.tick(); await w.app.replies.tick()
  assert.equal(w.x.posts.length, 1)
  const p = w.x.posts[0]
  assert.equal(p.reply.in_reply_to_tweet_id, id)
  assert.ok(!hasLink(p.text), `no link or domain: ${p.text}`); assert.doesNotMatch(p.text, /sidebid\.test/)
  assert.match(p.text, /Live now on our site/)
  const k = listing.toBase58(); assert.ok(p.text.includes(`Card ${k.slice(0, 4)}…${k.slice(-4)}`), 'a card code keeps two replies from being the same words')
  assert.equal(w.app.x.spend.spent() - before, 15_000, 'Post: Create, $0.015')
  assert.doesNotMatch(p.text, /[-–—]\s|\sOTC|\bdesk\b/i)
  assert.match(w.x.calls.at(-1).headers.authorization, /^OAuth /, 'posts with the account credentials')
})
test('live reply with X_REPLY_LINKS on: the card link, billed at the with URL price', async () => {
  const w = on({ env: { X_REPLY_LINKS: '1' } }); const { listing } = await live(w)
  const before = w.app.x.spend.spent()
  await w.app.replies.tick()
  const p = w.x.posts[0]
  assert.ok(p.text.includes(`https://sidebid.test/c/${listing.toBase58()}`))
  assert.equal(w.app.x.spend.spent() - before, 200_000, 'Post: Create (with URL), $0.200')
})
test('any domain text prices a post as a link', () => {
  for (const t of ['see sidebid.fun', 'https://t.co/x', 'www.example', 'go to x.com now']) assert.ok(hasLink(t), t)
  for (const t of ['Top bid is 0.0025 SOL. You have 10 minutes to accept.', 'selling 1,000.5 of 2,000 tokens. Bids close in 5 minutes.', 'Card 7LmH…CV3p']) assert.ok(!hasLink(t), t)
})
test('accept window reply: after the end, with the top bid, only when there is one, once', async () => {
  const w = on(); const { id, listing } = await live(w)
  await w.app.replies.tick()
  bid(w, listing, w.conn.wallet(), 2_500_000n)
  await w.app.indexer.tick()
  await w.app.replies.tick()
  assert.equal(w.x.posts.length, 1, 'not before the end')
  w.conn.warp(300)
  await w.app.replies.tick(); await w.app.replies.tick()
  assert.equal(w.x.posts.length, 2)
  assert.match(w.x.posts[1].text, /0\.0025 SOL/); assert.match(w.x.posts[1].text, /10 minutes/)
  assert.equal(w.x.posts[1].reply.in_reply_to_tweet_id, id)
  const k = listing.toBase58(); assert.ok(w.x.posts[1].text.includes(`Card ${k.slice(0, 4)}…${k.slice(-4)}`)); assert.ok(!hasLink(w.x.posts[1].text))
})
test('accept window reply: no bids means no reply, and a late bid moves the moment', async () => {
  const w = on(); const a = await live(w)
  await w.app.indexer.tick(); w.conn.warp(301)
  await w.app.replies.tick()
  assert.equal(row(w, 'accept', a.id), undefined)
  const w2 = on(); const b = await live(w2)
  await w2.app.indexer.tick()
  w2.conn.warp(290)
  bid(w2, b.listing, w2.conn.wallet(), 2_000_000n) // inside the last 15 seconds: adds 15
  await w2.app.indexer.tick()
  w2.conn.warp(10) // past the original end, before the new one
  await w2.app.replies.tick()
  assert.equal(row(w2, 'accept', b.id), undefined)
  w2.conn.warp(16)
  await w2.app.replies.tick()
  assert.ok(row(w2, 'accept', b.id))
})
test('only to accounts that tagged us: the queue refuses anything else', async () => {
  const w = on(); const { id } = await live(w)
  assert.throws(() => w.app.replies.enqueue({ kind: 'live', tweetId: '123456', xId: '100', listing: 'x', text: 't', expiresAt: w.now() + 1000 }), /tagged us/)
  assert.throws(() => w.app.replies.enqueue({ kind: 'accept', tweetId: id, xId: 'someone else', listing: 'x', text: 't', expiresAt: w.now() + 1000 }), /tagged us/)
})
test('retries: a server error that did not post is found out and sent once', async () => {
  const w = on(); const { id } = await live(w)
  let n = 0
  w.x.postBehaviour = () => { n++; return n === 1 ? (r) => r(503, { title: 'unavailable' }) : undefined }
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'unknown')
  w.clock.skew += 11_000
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'sent')
  assert.equal(w.x.posts.length, 1)
  assert.ok(w.x.calls.some((c) => /\/users\/424242\/tweets$/.test(c.path)), 'looked at its own posts first')
})
test('no duplicates: a send that timed out but landed is found, not sent again', async () => {
  const w = on(); const { id } = await live(w)
  w.x.postBehaviour = () => 'landed-then-timeout'
  await w.app.replies.tick()
  w.x.postBehaviour = null
  assert.equal(row(w, 'live', id).state, 'unknown')
  w.clock.skew += 11_000
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'sent')
  assert.equal(w.x.posts.length, 1)
})
test('no duplicates: a crash mid send is treated as unknown after restart', async () => {
  const w = on(); const { id } = await live(w)
  await w.app.replies.tick()
  w.db.run(`UPDATE replies SET state='sending', reply_id=NULL WHERE tweet_id=?`, id) // as if the process died inside the call
  const w2 = world({ conn: w.conn, db: w.db, x: w.x, clock: w.clock, keeperKey: w.keeper })
  await w2.app.start()
  assert.equal(row(w, 'live', id).state, 'unknown')
  await w2.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'sent')
  assert.equal(w.x.posts.length, 1, 'found the earlier post')
})
test('no blind resend: if its own posts cannot be read, it waits', async () => {
  const w = on(); const { id } = await live(w)
  w.x.postBehaviour = () => 'timeout'
  await w.app.replies.tick()
  w.x.fail = { status: 500, body: {} }; w.clock.skew += 11_000
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'unknown')
  assert.equal(w.x.posts.length, 0)
  w.x.fail = null; w.x.postBehaviour = null; w.clock.skew += 31_000
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'sent'); assert.equal(w.x.posts.length, 1)
})
test('X saying duplicate counts as sent', async () => {
  const w = on(); const { id } = await live(w)
  w.x.postBehaviour = () => (r) => r(403, { detail: 'duplicate content' })
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'sent')
})
test('refused and rate limited replies back off; credits out stops the queue; the cap holds', async () => {
  const w = on(); const { id } = await live(w)
  w.x.postBehaviour = () => (r) => r(403, { title: 'Forbidden' })
  await w.app.replies.tick()
  assert.equal(row(w, 'live', id).state, 'retry')
  assert.equal(row(w, 'live', id).attempts, 1)
  const calls = w.x.calls.length
  await w.app.replies.tick()
  assert.equal(w.x.calls.length, calls, 'waits out the backoff')

  const w2 = on(); const b = await live(w2)
  w2.x.fail = { status: 402, body: { title: 'CreditsDepleted' } }
  await w2.app.replies.tick()
  const n = w2.x.calls.length
  assert.equal(row(w2, 'live', b.id).state, 'retry')
  await w2.app.replies.tick()
  assert.equal(w2.x.calls.length, n, 'no more calls')

  const w3 = on({ env: { X_DAILY_SPEND_CAP_USD: '1', X_COST_PER_POST_USD: '2' } }); const c = await live(w3)
  await w3.app.replies.tick()
  assert.equal(w3.x.posts.length, 0)
  assert.equal(row(w3, 'live', c.id).state, 'retry')
})
test('expired replies are dropped, not sent late', async () => {
  const w = on(); const { id } = await live(w, '1m')
  w.x.fail = { status: 500, body: {} }
  w.conn.warp(61)
  await w.app.replies.tick()
  w.x.fail = null
  assert.equal(row(w, 'live', id).state, 'expired')
  assert.equal(w.x.posts.length, 0)
})
test('replies flag off: queued, nothing posted, nothing lost', async () => {
  const w = world(); flagsOn(w, 'readerLive', 'tagListingLive')
  const { id } = await live(w)
  await w.app.replies.tick()
  assert.equal(w.x.posts.length, 0); assert.equal(row(w, 'live', id).state, 'pending')
  flagsOn(w, 'repliesLive'); await w.app.replies.tick()
  assert.equal(w.x.posts.length, 1)
})
test('credentials never appear in stored replies or errors', async () => {
  const w = on(); await live(w)
  w.x.fail = { status: 403, body: { title: 'nope' } }
  await w.app.replies.tick()
  const dump = JSON.stringify(w.db.all('SELECT * FROM replies'))
  for (const s of ['bearer', 'csecret']) assert.ok(!dump.includes(s))
})
