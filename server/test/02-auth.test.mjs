import test from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { createHash } from 'node:crypto'
import { Keypair, MockX, world, SvmConn } from './harness.mjs'
import { listen, cookies } from '../src/http.mjs'

const sign = (kp, m) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey))
const HOUR = 3_600_000, DAY = 24 * HOUR

async function site(w) {
  const server = await listen(w.app.handler, 0)
  const base = `http://127.0.0.1:${server.address().port}`
  const origin = 'https://sidebid.test'
  return {
    base, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }),
    get: (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' }),
    post: (p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }),
  }
}
function xSignin(w, profile) {
  const orig = w.x.fetch, seen = []
  const fake = async (url, init = {}) => {
    const u = new URL(url); seen.push({ path: u.pathname, init, query: u.searchParams })
    if (u.pathname === '/2/oauth2/token') return profile.tokenFail ? { ok: false, status: 400, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ access_token: 'x-user-token-SHOULD-NOT-BE-KEPT' }) }
    if (u.pathname === '/2/users/me') return { ok: true, status: 200, json: async () => ({ data: profile }) }
    return orig(url, init)
  }
  w.app.auth.fetchImpl = fake
  return seen
}
const PROFILE = (w, o = {}) => ({ id: '4242', username: 'tester', created_at: new Date(w.now() - 400 * DAY).toISOString(), public_metrics: { followers_count: 50 }, profile_image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', ...o })

async function signIn(w, s, profile) {
  const seen = xSignin(w, profile)
  const start = await s.get('/api/auth/x/start')
  assert.equal(start.status, 302)
  const loc = new URL(start.headers.get('location')), state = loc.searchParams.get('state')
  const cookie = start.headers.get('set-cookie').split(';')[0]
  const back = await s.get(`/api/auth/x/callback?code=abc&state=${state}`, { cookie })
  return { start, loc, state, cookie, back, seen, session: back.headers.getSetCookie().find((c) => c.startsWith('lb_s='))?.split(';')[0] }
}

test('sign in: PKCE with the least scope, session cookie, no X token kept', async () => {
  const w = world(); w.app.flags.set({ signinLive: true }); const s = await site(w)
  const r = await signIn(w, s, PROFILE(w))
  assert.equal(r.loc.origin, 'https://x.com')
  assert.equal(r.loc.searchParams.get('scope'), 'tweet.read users.read')
  assert.equal(r.loc.searchParams.get('code_challenge_method'), 'S256')
  const verifier = new URLSearchParams(r.seen.find((c) => c.path === '/2/oauth2/token').init.body).get('code_verifier')
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), r.loc.searchParams.get('code_challenge'))
  assert.match(r.back.headers.getSetCookie().join(), /lb_s=.+HttpOnly; Secure; SameSite=Lax/)
  const me = await (await s.get('/api/me', { cookie: r.session })).json()
  assert.deepEqual([me.signedIn, me.handle, me.wallet], [true, 'tester', null])
  assert.ok(!JSON.stringify(w.db.all('SELECT * FROM sessions').concat(w.db.all('SELECT * FROM x_users'))).includes('SHOULD-NOT-BE-KEPT'))
  assert.ok(!JSON.stringify(w.db.all('SELECT * FROM sessions')).includes(r.session.split('=')[1]), 'only a hash of the session is stored')
  await s.close()
})

test('sign in: off until the flag, and without a client id', async () => {
  const w = world(); const s = await site(w)
  assert.equal((await s.get('/api/auth/x/start')).status, 404)
  await s.close()
})

test('sign in: state is one try, must match this browser, and expires', async () => {
  const w = world(); w.app.flags.set({ signinLive: true }); const s = await site(w)
  xSignin(w, PROFILE(w))
  const failed = (r) => /signin=expired/.test(r.headers.get('location'))
  const a = await s.get('/api/auth/x/start'), stateA = new URL(a.headers.get('location')).searchParams.get('state'), cookieA = a.headers.get('set-cookie').split(';')[0]
  assert.ok(failed(await s.get(`/api/auth/x/callback?code=c&state=${stateA}`)), 'no cookie')
  assert.ok(failed(await s.get(`/api/auth/x/callback?code=c&state=${stateA}`, { cookie: cookieA })), 'state already used')
  const b = await s.get('/api/auth/x/start'), stateB = new URL(b.headers.get('location')).searchParams.get('state')
  w.clock.skew += 11 * 60_000
  assert.ok(failed(await s.get(`/api/auth/x/callback?code=c&state=${stateB}`, { cookie: b.headers.get('set-cookie').split(';')[0] })), 'expired')
  await s.close()
})

test('sign in: any X account, with no age or follower minimum', async () => {
  const w = world({ env: { MIN_ACCOUNT_AGE_DAYS: '30', MIN_FOLLOWERS: '10' } }); w.app.flags.set({ signinLive: true }); const s = await site(w)
  assert.equal(w.config.minAccountAgeDays, undefined); assert.equal(w.config.minFollowers, undefined)
  const young = await signIn(w, s, PROFILE(w, { created_at: new Date(w.now() - 1 * DAY).toISOString(), public_metrics: { followers_count: 0 } }))
  assert.ok(young.session, 'a day old account with no followers signs in'); assert.doesNotMatch(young.back.headers.get('location'), /signin=/)
  const noData = await signIn(w, s, PROFILE(w, { id: '77', username: 'nodata', created_at: undefined, public_metrics: undefined }))
  assert.ok(noData.session, 'no age or follower count is fine too')
  const me = await (await s.get('/api/me', { cookie: young.session })).json()
  assert.equal(me.signedIn, true); assert.equal('eligible' in me, false)
  await s.close()
})

test('sign in: the profile read goes through the X spend ledger, in its own allowance', async () => {
  const w = world({ env: { X_DAILY_SPEND_CAP_USD: '1', X_SIGNIN_CAP_USD: '0.02' } }); w.app.flags.set({ signinLive: true }); const s = await site(w)
  const a = await signIn(w, s, PROFILE(w, { id: '1', username: 'one' }))
  assert.ok(a.session)
  assert.equal(w.app.x.spend.status().signinSpentUsd, 0.01, 'User: Read, $0.010')
  assert.equal(w.app.x.spend.status().spentUsd, 0.01, 'and in the day total')
  const b = await signIn(w, s, PROFILE(w, { id: '2', username: 'two' })); assert.ok(b.session)
  const seen = xSignin(w, PROFILE(w, { id: '3', username: 'three' }))
  assert.equal((await s.get('/api/auth/x/start')).headers.get('location'), '/?signin=paused', 'the allowance is used up: not sent to X at all')
  assert.equal(seen.length, 0)
  assert.equal(w.app.x.spend.reserve(0.98), true, 'replies and reads keep the rest of the cap')
  assert.equal(w.app.x.spend.reserve(0.01), false, 'and never the sign in allowance')
  await s.close()
})
test('sign in: X_DAILY_SPEND_CAP_USD=0 pauses it, with a message and no X call; the default allowance is 0', async () => {
  for (const env of [{ X_DAILY_SPEND_CAP_USD: '0', X_SIGNIN_CAP_USD: '1' }, { X_DAILY_SPEND_CAP_USD: '2', X_SIGNIN_CAP_USD: '' }]) {
    const w = world({ env }); w.app.flags.set({ signinLive: true }); const s = await site(w)
    const r = { seen: xSignin(w, PROFILE(w)) }, start = await s.get('/api/auth/x/start')
    assert.equal(start.status, 302); assert.equal(start.headers.get('location'), '/?signin=paused')
    // Even a callback with a valid state (started before the cap was hit) never reads the profile
    const { state } = w.app.auth.startSignIn()
    const back = await s.get(`/api/auth/x/callback?code=abc&state=${state}`, { cookie: `lb_o=${state}` })
    assert.equal(back.headers.get('location'), '/?signin=paused')
    assert.ok(!r.seen.some((x) => x.path === '/2/users/me'), 'no paid call')
    assert.equal(w.app.x.spend.status().spentUsd, 0)
    await s.close()
  }
})
test('sign in: a refused profile read is given back to the allowance', async () => {
  const w = world({ env: { X_SIGNIN_CAP_USD: '0.01' } }); w.app.flags.set({ signinLive: true }); const s = await site(w)
  const orig = w.x.fetch
  w.app.auth.fetchImpl = async (url, init) => { const u = new URL(url); if (u.pathname === '/2/oauth2/token') return { ok: true, status: 200, json: async () => ({ access_token: 't' }) }; if (u.pathname === '/2/users/me') return { ok: false, status: 503, json: async () => ({}) }; return orig(url, init) }
  const start = await s.get('/api/auth/x/start'); const state = new URL(start.headers.get('location')).searchParams.get('state')
  await s.get(`/api/auth/x/callback?code=abc&state=${state}`, { cookie: start.headers.get('set-cookie').split(';')[0] })
  assert.equal(w.app.x.spend.status().signinSpentUsd, 0)
  await s.close()
})
test('sign in: X refusing the code fails cleanly', async () => {
  const w = world(); w.app.flags.set({ signinLive: true }); const s = await site(w)
  const r = await signIn(w, s, { ...PROFILE(w), tokenFail: true })
  assert.match(r.back.headers.get('location'), /signin=x_refused/)
  await s.close()
})

test('logout ends the session on the server', async () => {
  const w = world(); w.app.flags.set({ signinLive: true }); const s = await site(w)
  const r = await signIn(w, s, PROFILE(w))
  assert.equal((await s.post('/api/auth/logout', {}, { cookie: r.session })).status, 200)
  assert.equal((await (await s.get('/api/me', { cookie: r.session })).json()).signedIn, false)
  await s.close()
})

function linkFix() {
  const w = world(); const a = w.app.auth
  a.upsertUser({ xId: '1', handle: 'one', xCreatedAt: w.now() - 400 * DAY, followers: 50 })
  a.upsertUser({ xId: '2', handle: 'two', xCreatedAt: w.now() - 400 * DAY, followers: 50 })
  return { w, a, k1: Keypair.generate(), k2: Keypair.generate() }
}
const doLink = (a, xId, kp) => { const c = a.challenge(xId, kp.publicKey.toBase58()); return a.link(xId, { wallet: kp.publicKey.toBase58(), nonce: c.nonce, signature: sign(kp, c.message) }) }
/** The wallet takes part (here a pass), so a later change waits. */
const used = (w, kp) => w.db.run('INSERT INTO passes_issued (campaign,x_hash,wallet,expiry,issued_at) VALUES (?,?,?,?,?)', 'c' + Math.random(), 'h' + Math.random(), kp.publicKey.toBase58(), 0, w.now())

test('wallet: right signature links, and the message says it moves nothing', () => {
  const { a, k1 } = linkFix()
  const c = a.challenge('1', k1.publicKey.toBase58())
  assert.match(c.message, /sidebid\.test/); assert.match(c.message, /@one \(id 1\)/); assert.match(c.message, /does not approve any transaction/)
  assert.equal(a.link('1', { wallet: k1.publicKey.toBase58(), nonce: c.nonce, signature: sign(k1, c.message) }).ok, true)
  assert.equal(a.activeWallet('1'), k1.publicKey.toBase58())
})
test('wallet: expired nonce', () => {
  const { w, a, k1 } = linkFix()
  const c = a.challenge('1', k1.publicKey.toBase58())
  w.clock.skew += 11 * 60_000
  assert.equal(a.link('1', { wallet: k1.publicKey.toBase58(), nonce: c.nonce, signature: sign(k1, c.message) }).why, 'expired')
  assert.equal(a.activeWallet('1'), null)
})
test('wallet: replayed nonce, including after a success and after a failed try', () => {
  const { a, k1, k2 } = linkFix()
  const c = a.challenge('1', k1.publicKey.toBase58()), sig = sign(k1, c.message), wallet = k1.publicKey.toBase58()
  assert.equal(a.link('1', { wallet, nonce: c.nonce, signature: sig }).ok, true)
  assert.equal(a.link('1', { wallet, nonce: c.nonce, signature: sig }).why, 'expired', 'replay after success')
  const d = a.challenge('2', k2.publicKey.toBase58())
  assert.equal(a.link('2', { wallet: k2.publicKey.toBase58(), nonce: d.nonce, signature: sign(Keypair.generate(), d.message) }).why, 'bad_signature')
  assert.equal(a.link('2', { wallet: k2.publicKey.toBase58(), nonce: d.nonce, signature: sign(k2, d.message) }).why, 'expired', 'one try, right or wrong')
})
test('wallet: nonce bound to the account and the wallet; bad signatures', () => {
  const { a, k1, k2 } = linkFix()
  const w1 = k1.publicKey.toBase58()
  let c = a.challenge('1', w1)
  assert.equal(a.link('2', { wallet: w1, nonce: c.nonce, signature: sign(k1, c.message) }).why, 'mismatch', 'another account')
  c = a.challenge('1', w1)
  assert.equal(a.link('1', { wallet: k2.publicKey.toBase58(), nonce: c.nonce, signature: sign(k2, c.message) }).why, 'mismatch', 'another wallet')
  c = a.challenge('1', w1)
  assert.equal(a.link('1', { wallet: w1, nonce: c.nonce, signature: sign(k1, `${c.message} `) }).why, 'bad_signature', 'different text')
  c = a.challenge('1', w1)
  assert.equal(a.link('1', { wallet: w1, nonce: c.nonce, signature: 'not a signature' }).why, 'unreadable_signature')
  assert.equal(a.challenge('1', 'So11111111111111111111111111111111111111112x').why, 'not_a_wallet')
})
test('wallet: off curve addresses are refused', () => {
  const { w, a } = linkFix()
  const pda = w.app.prog.listingPda(Keypair.generate().publicKey).toBase58()
  assert.equal(a.challenge('1', pda).why, 'not_a_wallet')
})
test('wallet: one wallet per account and one account per wallet', () => {
  const { a, k1 } = linkFix()
  assert.equal(doLink(a, '1', k1).ok, true)
  assert.equal(doLink(a, '2', k1).why, 'wallet_taken')
})
test('wallet: a wallet never used is replaced at once; the account keeps one wallet and the old one is free', () => {
  const { w, a, k1, k2 } = linkFix()
  const w1 = k1.publicKey.toBase58(), w2 = k2.publicKey.toBase58()
  doLink(a, '1', k1)
  assert.equal(a.linkState('1').changeWaits, false)
  const r = doLink(a, '1', k2)
  assert.deepEqual([r.ok, r.waiting, r.wallet, r.replaced], [true, false, w2, w1])
  assert.deepEqual(a.linkState('1'), { wallet: w2, pendingWallet: null, pendingAt: null, changeWaits: false })
  assert.equal(doLink(a, '2', k1).ok, true, 'the replaced wallet is free for another account')
  // Back to a used wallet rule: once the wallet has bid, listed or taken a pass, a change waits
  used(w, k2)
  assert.equal(a.linkState('1').changeWaits, true)
  assert.equal(doLink(a, '1', Keypair.generate()).waiting, true)
})
test('wallet: a change waits 48 hours, old wallet stays active through the wait', () => {
  const { w, a, k1, k2 } = linkFix()
  const w1 = k1.publicKey.toBase58(), w2 = k2.publicKey.toBase58()
  doLink(a, '1', k1); used(w, k1)
  const r = doLink(a, '1', k2)
  assert.deepEqual([r.ok, r.waiting, r.wallet, r.pendingWallet], [true, true, w1, w2])
  assert.equal(a.activeWallet('1'), w1, 'just after asking')
  w.clock.skew += 47 * HOUR + 59 * 60_000
  assert.equal(a.activeWallet('1'), w1, 'a minute before the end')
  assert.equal(a.linkState('1').pendingWallet, w2)
  w.clock.skew += 2 * 60_000
  assert.equal(a.activeWallet('1'), w2, 'after the wait')
  assert.equal(a.linkState('1').pendingWallet, null)
})
test('wallet: during the wait no second change, the waiting wallet is reserved, and it can be cancelled', () => {
  const { w, a, k1, k2 } = linkFix()
  doLink(a, '1', k1); used(w, k1); doLink(a, '1', k2)
  const k3 = Keypair.generate()
  assert.equal(doLink(a, '1', k3).why, 'change_already_waiting')
  assert.equal(doLink(a, '2', k2).why, 'wallet_taken', 'reserved for the account changing to it')
  assert.equal(a.cancelChange('1').ok, true)
  w.clock.skew += 49 * HOUR
  assert.equal(a.activeWallet('1'), k1.publicKey.toBase58(), 'cancelled, so it never takes over')
  assert.equal(doLink(a, '2', k2).ok, true, 'free again')
  assert.equal(a.cancelChange('1').why, 'nothing_waiting')
})
test('wallet: after the change the old wallet is free', () => {
  const { w, a, k1, k2 } = linkFix()
  doLink(a, '1', k1); used(w, k1); doLink(a, '1', k2)
  w.clock.skew += 49 * HOUR; a.activeWallet('1')
  assert.equal(doLink(a, '2', k1).ok, true)
})
test('API: writes need our origin and a session', async () => {
  const w = world(); const s = await site(w)
  const k = Keypair.generate().publicKey.toBase58()
  assert.equal((await s.post('/api/wallet/challenge', { wallet: k }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await s.post('/api/wallet/challenge', { wallet: k })).status, 401)
  const bad = await fetch(`${s.base}/api/wallet/challenge`, { method: 'POST', body: '{' , headers: { origin: 'https://sidebid.test' } })
  assert.equal(bad.status, 401, 'session check comes before the body')
  assert.deepEqual(cookies({ headers: { cookie: 'a=b; c=d=e' } }), { a: 'b', c: 'd=e' })
  await s.close()
})
