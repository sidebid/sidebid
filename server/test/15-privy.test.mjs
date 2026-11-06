import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { Keypair, world } from './harness.mjs'
import { listen } from '../src/http.mjs'
import { PrivyVerifier, identityOf, jwksUrlFor } from '../src/privy.mjs'

const APP = 'cmtestapp0000000000000001'
const HOUR = 3_600_000
const keyPair = () => { const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { privateKey, jwk: publicKey.export({ format: 'jwk' }) } }
const K1 = keyPair(), K2 = keyPair(), ROGUE = keyPair()
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
/** A Privy shaped ES256 token. */
function jwt(claims, { key = K1, kid = 'k1', alg = 'ES256' } = {}) {
  const head = b64u({ alg, typ: 'JWT', kid }), body = b64u(claims)
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${sig.toString('base64url')}`
}
/** A mocked JWKS endpoint that counts its calls. */
function jwksFetch(keys = [['k1', K1], ['k2', K2]]) {
  const f = async (url) => { f.calls.push(url); return f.down ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ keys: keys.map(([kid, k]) => ({ ...k.jwk, kid, alg: 'ES256', use: 'sig' })) }) } }
  f.calls = []
  return f
}
const DID = 'did:privy:cm0000000000000000000abcd'
const base = (now, o = {}) => ({ iss: 'privy.io', aud: APP, sub: DID, sid: 'sess1', iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 3600, ...o })
const W1 = Keypair.generate().publicKey.toBase58(), W2 = Keypair.generate().publicKey.toBase58(), EMB = Keypair.generate().publicKey.toBase58()
const twitter = (o = {}) => ({ type: 'twitter_oauth', subject: '4242', username: 'tester', name: 'T', profile_picture_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', ...o })
const wallet = (address, embedded = false, at = 1) => ({ type: 'wallet', address, chain_type: 'solana', wallet_client_type: embedded ? 'privy' : 'phantom', connector_type: embedded ? 'embedded' : 'solana_adapter', latest_verified_at: at })
const idClaims = (now, accounts, o = {}) => base(now, { linked_accounts: JSON.stringify(accounts), ...o })

test('verifier: valid, expired, wrong audience, wrong issuer, bad signature, wrong alg, unknown key', async () => {
  let t = Date.now()
  const f = jwksFetch(), v = new PrivyVerifier({ appId: APP, fetchImpl: f, now: () => t })
  assert.equal((await v.verify(jwt(base(t)))).ok, true)
  assert.equal(f.calls[0], jwksUrlFor(APP), 'keys come from the app JWKS, no secret involved')
  assert.equal((await v.verify(jwt(base(t), { key: K2, kid: 'k2' }))).ok, true, 'a second published key works')
  assert.equal((await v.verify(jwt(base(t, { exp: Math.floor(t / 1000) - 120 })))).why, 'expired')
  assert.equal((await v.verify(jwt(base(t, { aud: 'someone-else' })))).why, 'wrong_audience')
  assert.equal((await v.verify(jwt(base(t, { aud: [APP, 'x'] })))).ok, true, 'an audience list naming us is fine')
  assert.equal((await v.verify(jwt(base(t, { iss: 'evil.io' })))).why, 'wrong_issuer')
  assert.equal((await v.verify(jwt(base(t), { key: ROGUE, kid: 'k1' }))).why, 'bad_signature', 'signed by a key Privy never published')
  assert.equal((await v.verify(jwt(base(t), { alg: 'HS256' }))).why, 'bad_alg')
  assert.equal((await v.verify(jwt(base(t), { key: ROGUE, kid: 'nope' }))).why, 'unknown_key')
  const tok = jwt(base(t)), parts = tok.split('.')
  assert.equal((await v.verify(`${parts[0]}.${b64u({ ...base(t), sub: 'did:privy:cm0000000000000000000zzzz' })}.${parts[2]}`)).why, 'bad_signature', 'changed claims break the signature')
  assert.equal((await v.verify('not.a.jwt')).why, 'bad_token')
  assert.equal((await v.verify(jwt(base(t, { sub: 'someone' })))).why, 'bad_subject')
  // An unknown kid refetches, but at most once a minute
  const n = f.calls.length
  await v.verify(jwt(base(t), { key: ROGUE, kid: 'nope2' }))
  assert.equal(f.calls.length, n, 'no refetch inside the minute')
  t += 61_000; await v.verify(jwt(base(t), { key: ROGUE, kid: 'nope3' }))
  assert.equal(f.calls.length, n + 1)
  // Keys are cached for an hour; JWKS down after that keeps the old keys
  f.down = true; t += 2 * HOUR
  assert.equal((await v.verify(jwt(base(t)))).ok, true, 'a JWKS outage does not drop keys already known')
  assert.equal((await new PrivyVerifier({ appId: '', fetchImpl: f }).verify(jwt(base(t)))).why, 'privy_off')
})

test('identity: X subject, handle, picture and Solana wallets come from linked_accounts', () => {
  const now = Date.now()
  const id = identityOf(idClaims(now, [twitter(), wallet(W1), wallet(EMB, true), { type: 'wallet', address: '0xabc', chain_type: 'ethereum' }, { type: 'email', address: 'a@b.c' }]))
  assert.deepEqual(id.x, { subject: '4242', username: 'tester', avatar: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' })
  assert.deepEqual(id.wallets.map((w) => [w.address, w.embedded]), [[W1, false], [EMB, true]])
  assert.equal(id.did, DID)
  assert.equal(identityOf(idClaims(now, [twitter({ subject: 'not-a-number' })])).x, null, 'an X subject must be an X user id')
  assert.equal(identityOf({ sub: DID, linked_accounts: 'garbage' }).wallets.length, 0)
})

async function site(w) {
  const server = await listen(w.app.handler, 0)
  const base = `http://127.0.0.1:${server.address().port}`, origin = 'https://sidebid.test'
  return {
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }),
    get: (p, headers = {}) => fetch(base + p, { headers }),
    post: (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }),
  }
}
function privyWorld(env = {}) {
  const f = jwksFetch()
  const w = world({ env: { PRIVY_APP_ID: APP, X_OAUTH_FALLBACK: '', ...env } })
  w.app.privy.fetchImpl = f
  w.app.flags.set({ signinLive: true, passLive: true })
  const xCalls = []
  w.app.auth.fetchImpl = async (u) => { xCalls.push(u); throw new Error('no X call expected') }
  const origX = w.x.fetch
  w.x.fetch = async (...a) => { xCalls.push(a[0]); return origX(...a) }
  return { w, f, xCalls }
}
const signInBody = (w, accounts, o = {}) => ({ accessToken: jwt(base(w.now(), o.access ?? {})), identityToken: jwt(idClaims(w.now(), accounts, o.id ?? {})), ...(o.wallet ? { wallet: o.wallet } : {}) })
const cookieOf = (r) => r.headers.getSetCookie().find((c) => c.startsWith('lb_s='))?.split(';')[0]

test('session mapping: X login keyed by the X id, handle and picture shown, only the picked wallet linked, no X call', async () => {
  const { w, xCalls } = privyWorld(); const s = await site(w)
  const r = await s.post('/api/auth/privy', signInBody(w, [twitter(), wallet(EMB, true, 5), wallet(W1, false, 3)]))
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.deepEqual([body.handle, body.hasX, body.wallet], ['tester', true, null], 'no wallet picked, none linked: not the embedded one, not a guess')
  const me = await (await s.get('/api/me', { cookie: cookieOf(r) })).json()
  assert.deepEqual([me.signedIn, me.handle, me.wallet, me.hasX], [true, 'tester', null, true])
  assert.equal(w.db.get('SELECT x_id FROM sessions').x_id, '4242')
  assert.equal(w.db.get('SELECT avatar FROM x_users WHERE x_id=?', '4242').avatar, 'https://pbs.twimg.com/profile_images/1/a_200x200.jpg')
  assert.equal(xCalls.length, 0, 'a Privy sign in never calls X')
  assert.equal(w.app.x.spend.status().today?.signinUsd ?? 0, 0)
  // The wallet the person picked in Privy is linked, when Privy verified it
  const { w: w2 } = privyWorld(); const s2 = await site(w2)
  assert.equal((await (await s2.post('/api/auth/privy', signInBody(w2, [twitter(), wallet(W1), wallet(EMB, true)], { wallet: W1 }))).json()).wallet, W1)
  // Picking another wallet at the next sign in replaces one never used, at once
  assert.equal((await (await s2.post('/api/auth/privy', signInBody(w2, [twitter(), wallet(W1), wallet(EMB, true)], { wallet: EMB }))).json()).wallet, EMB)
  // A browser naming a wallet Privy never verified links nothing
  const { w: w3 } = privyWorld(); const s3 = await site(w3)
  assert.equal((await (await s3.post('/api/auth/privy', signInBody(w3, [twitter(), wallet(W1)], { wallet: W2 }))).json()).wallet, null)
  await Promise.all([s.close(), s2.close(), s3.close()])
})

test('picture: from the token, in its short form, or from Privy\'s user object when the token has none; X hosts only', async () => {
  const now = Date.now()
  assert.equal(identityOf(idClaims(now, [{ type: 'twitter_oauth', subject: '4242', username: 'tester', pfp: 'https://pbs.twimg.com/profile_images/1/b_normal.png' }])).x.avatar, 'https://pbs.twimg.com/profile_images/1/b_normal.png')
  const { w } = privyWorld(); const s = await site(w)
  const pic = 'https://pbs.twimg.com/profile_images/9/c_normal.jpg'
  const r = await (await s.post('/api/auth/privy', { ...signInBody(w, [twitter({ profile_picture_url: null })]), avatar: pic })).json()
  assert.equal(r.avatar, 'https://pbs.twimg.com/profile_images/9/c_200x200.jpg')
  const r2 = await (await s.post('/api/auth/privy', { ...signInBody(w, [twitter({ profile_picture_url: null })]), avatar: 'https://evil.test/a.jpg' })).json()
  assert.equal(r2.avatar, null, 'only pbs.twimg.com')
  const r3 = await (await s.post('/api/auth/privy', { ...signInBody(w, [twitter()]), avatar: pic })).json()
  assert.equal(r3.avatar, 'https://pbs.twimg.com/profile_images/1/a_200x200.jpg', 'the signed token wins')
  const r4 = await (await s.post('/api/auth/privy', { ...signInBody(w, [{ type: 'email', address: 'a@b.c' }], { access: { sub: 'did:privy:cm0000000000000000000mail' }, id: { sub: 'did:privy:cm0000000000000000000mail' } }), avatar: pic })).json()
  assert.equal(r4.avatar, null, 'no X account, no picture')
  await s.close()
})

test('session mapping: refusals for bad tokens, mismatched users, missing identity token, wrong origin, flag off', async () => {
  const { w } = privyWorld(); const s = await site(w)
  const good = signInBody(w, [twitter(), wallet(W1)])
  assert.equal((await s.post('/api/auth/privy', good, { origin: 'https://evil.test' })).status, 403)
  assert.equal((await (await s.post('/api/auth/privy', { ...good, identityToken: undefined })).json()).error, 'no_identity_token')
  assert.equal((await (await s.post('/api/auth/privy', { ...good, accessToken: jwt(base(w.now(), { exp: Math.floor(w.now() / 1000) - 100 })) })).json()).error, 'expired')
  assert.equal((await (await s.post('/api/auth/privy', { ...good, accessToken: jwt(base(w.now(), { aud: 'other-app' })) })).json()).error, 'wrong_audience')
  assert.equal((await (await s.post('/api/auth/privy', { ...good, identityToken: jwt(idClaims(w.now(), [twitter()], { sub: 'did:privy:cm0000000000000000000other' })) })).json()).error, 'mismatch', 'both tokens must be the same person')
  assert.equal((await (await s.post('/api/auth/privy', { ...good, identityToken: jwt(idClaims(w.now(), [twitter({ subject: '1' })]), { key: ROGUE }) })).json()).error, 'bad_signature', 'a forged identity cannot name an X account')
  assert.equal(w.db.get('SELECT COUNT(*) n FROM sessions').n, 0)
  w.app.flags.set({ signinLive: false })
  assert.equal((await s.post('/api/auth/privy', good)).status, 404)
  // The X OAuth path is off by default
  w.app.flags.set({ signinLive: true })
  assert.equal((await s.get('/api/auth/x/start')).status, 404)
  await s.close()
})

test('pass keying: one pass per X id from the verified identity; email accounts get none; a client can not name an X id', async () => {
  const { w } = privyWorld(); const s = await site(w)
  // Email only: signed in, wallet linked, no X
  const r = await s.post('/api/auth/privy', signInBody(w, [{ type: 'email', address: 'a@b.c' }, wallet(EMB, true)], { wallet: EMB }))
  const me = await r.json()
  assert.deepEqual([me.signedIn, me.handle, me.hasX, me.wallet], [true, null, false, EMB])
  const acct = w.db.get('SELECT x_id FROM sessions').x_id
  assert.match(acct, /^pv:/)
  const campaign = Keypair.generate().publicKey.toBase58(); w.app.pass.addCampaign(campaign)
  const p1 = await s.post('/api/pass', { campaign, wallet: EMB, xId: '4242' }, { cookie: cookieOf(r) })
  assert.deepEqual([p1.status, (await p1.json()).error], [409, 'x_needed'], 'no X linked, no pass, whatever the body says')
  // The same person links X in Privy: the account becomes the X id and keeps its wallet
  const r2 = await s.post('/api/auth/privy', signInBody(w, [{ type: 'email', address: 'a@b.c' }, twitter(), wallet(EMB, true)]))
  const me2 = await r2.json()
  assert.deepEqual([me2.handle, me2.hasX, me2.wallet], ['tester', true, EMB])
  assert.equal(w.db.get('SELECT x_id FROM wallet_links WHERE wallet=?', EMB).x_id, '4242')
  const p2 = await (await s.post('/api/pass', { campaign, wallet: EMB }, { cookie: cookieOf(r2) })).json()
  assert.equal(p2.xIdHash, w.app.pass.xHash('4242').toString('hex'), 'the pass is keyed by the X id Privy signed for')
  // The old session follows the move too
  assert.equal((await (await s.get('/api/me', { cookie: cookieOf(r) })).json()).handle, 'tester')
  await s.close()
})

test('wallet change through Privy: verified wallets only; at once while unused, the 48 hour wait once used', async () => {
  const { w } = privyWorld(); const s = await site(w)
  const r = await s.post('/api/auth/privy', signInBody(w, [twitter(), wallet(W1)], { wallet: W1 }))
  const cookie = cookieOf(r)
  const idTok = jwt(idClaims(w.now(), [twitter(), wallet(W1), wallet(W2)]))
  assert.equal((await (await s.post('/api/wallet/link-privy', { identityToken: jwt(idClaims(w.now(), [twitter(), wallet(W1)])), wallet: W2 }, { cookie })).json()).why, 'not_your_privy_wallet')
  assert.equal((await (await s.post('/api/wallet/link-privy', { identityToken: jwt(idClaims(w.now(), [twitter({ subject: '999' }), wallet(W2)])), wallet: W2 }, { cookie })).json()).why, 'mismatch', 'an identity for another account cannot link here')
  // W1 never listed, bid or took a pass: switching is immediate
  const sw = await (await s.post('/api/wallet/link-privy', { identityToken: idTok, wallet: W2 }, { cookie })).json()
  assert.deepEqual([sw.ok, sw.waiting, sw.wallet], [true, false, W2])
  assert.equal((await (await s.post('/api/wallet/link-privy', { identityToken: idTok, wallet: W1 }, { cookie })).json()).wallet, W1, 'and back')
  // Once W1 has bid, a change waits 48 hours
  w.db.run('INSERT INTO events_seen (sig,idx,name,listing,data,at) VALUES (?,?,?,?,?,?)', 'sig1', 0, 'BidPlaced', 'L', JSON.stringify({ name: 'BidPlaced', bidder: W1 }), 1)
  assert.equal((await (await s.get('/api/me', { cookie })).json()).changeWaits, true)
  const ch = await (await s.post('/api/wallet/link-privy', { identityToken: idTok, wallet: W2 }, { cookie })).json()
  assert.deepEqual([ch.ok, ch.waiting, ch.wallet, ch.pendingWallet], [true, true, W1, W2])
  assert.equal(ch.pendingAt - w.now(), 48 * HOUR)
  // A new sign in does not skip the wait, and never starts one by itself
  await s.post('/api/auth/privy', signInBody(w, [twitter(), wallet(W1), wallet(W2)], { wallet: W2 }))
  assert.equal(w.app.auth.activeWallet('4242'), W1)
  w.clock.skew += 48 * HOUR + 1000
  assert.equal(w.app.auth.activeWallet('4242'), W2)
  await s.close()
})

test('config: the app id is served to the page, no secret is read, CSP opens only Privy hosts', async () => {
  const { w } = privyWorld()
  const { withSite } = await import('../src/site.mjs')
  const { mkdtempSync, writeFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dist = mkdtempSync(join(tmpdir(), 'sb-dist-')); writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body><div id="app"><!--fp--></div></body></html>')
  const server = await listen(withSite(w.app, w.config, { dist, logFile: '/nonexistent' }), 0), b = `http://127.0.0.1:${server.address().port}`
  const cfg = await (await fetch(`${b}/api/config`)).json()
  assert.deepEqual(cfg.auth, { privy: { appId: APP, clientId: null }, xFallback: false })
  assert.equal(cfg.live.signin, true)
  const csp = (await fetch(`${b}/`)).headers.get('content-security-policy')
  assert.match(csp, /frame-src https:\/\/auth\.privy\.io/); assert.match(csp, /connect-src [^;]*https:\/\/auth\.privy\.io/)
  assert.ok(!('appSecret' in w.config.privy), 'no app secret in config')
  server.closeAllConnections(); server.close()
})
