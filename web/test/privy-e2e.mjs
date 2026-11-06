// Privy sign in and wallet flows, end to end: the real server (Privy's keys replaced by a test key), the built site and
// the real privy-island.js, bundled against a stand-in for Privy's SDK (test/fake-privy-sdk.js) that draws a plain modal
// the test clicks. No chain is needed: nothing here sends a transaction.
//
//   npm run build && npm run test:privy
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { generateKeyPairSync, sign as ecSign } from 'node:crypto'
import { build } from 'esbuild'
import { Keypair } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'

const here = new URL('.', import.meta.url).pathname
const SERVER = process.env.SERVER_DIR ?? join(here, '../../server')
const { loadConfig } = await import(join(SERVER, 'src/config.mjs'))
const { buildApp } = await import(join(SERVER, 'src/app.mjs'))
const { openDb } = await import(join(SERVER, 'src/db.mjs'))
const { listen } = await import(join(SERVER, 'src/http.mjs'))
const { withSite } = await import(join(SERVER, 'src/site.mjs'))
const puppeteer = createRequire(process.env.PUPPETEER_CORE || import.meta.url)('puppeteer-core')

const PB = Number(process.env.PRIVY_E2E_PORT_BASE ?? 37500), PORT = PB + 90, BASE = `http://localhost:${PORT}`, RPC = `http://127.0.0.1:${PB + 99}` // nothing listens there
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const r = await Promise.resolve().then(fn).catch(() => null); if (r) return r; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(200) } }
const ok = (name, detail = '') => console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`)

// ---- the real island against the stand-in SDK
const FAKE = join(here, 'fake-privy-sdk.js')
const island = (await build({ entryPoints: [join(here, '../src/privy-island.js')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@privy-io/react-auth/solana': FAKE, '@privy-io/react-auth': FAKE, '@solana/kit': FAKE } })).outputFiles[0].text

// ---- server, with a test key standing in for Privy's
const APP = 'cmprivye2eapp000000000001', KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const privyFetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256', use: 'sig' }] }) })
const jwt = (claims) => { const a = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'e2e' })).toString('base64url'), b = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${a}.${b}.${ecSign('sha256', Buffer.from(`${a}.${b}`), { key: KEY.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}` }
const data = mkdtempSync(join(tmpdir(), 'sidebid-privy-e2e-'))
writeFileSync(join(data, 'site.json'), JSON.stringify({ brand: { name: 'Sidebid', ticker: 'SIDEBID', xHandle: 'sidebidsol', domain: 'localhost' }, chain: { rpc: RPC, cluster: 'localnet' } }))
const config = loadConfig({ PRIVY_APP_ID: APP, PUBLIC_URL: BASE, PORT: String(PORT), RPC_URL: RPC, PROGRAM_ID: Keypair.generate().publicKey.toBase58(), DATA_DIR: data, ADMIN_SECRET: 'privy-e2e-admin-secret-0123456789abcdef', TRUSTED_HOPS: '1' })
const db = openDb(join(data, 'sidebid.db'))
const app = buildApp({ config, db, privyFetch, fetchImpl: async () => { throw new Error('no outside call expected') }, log: () => {} })
app.flags.set({ signinLive: true })
// X pictures: the server fetches pbs.twimg.com itself; here it gets a 1 pixel PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const picFetches = []
const imgFetch = async (url) => { picFetches.push(url); return /^https:\/\/pbs\.twimg\.com\//.test(url) ? new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 }) }
const server = await listen(withSite(app, config, { fetchImpl: imgFetch, lookup: async () => [{ address: '151.101.0.1' }], prefetchMs: 3_600_000, picturesDir: null }), PORT)

// ---- people
const kp = () => Keypair.generate(), keys = new Map()
const addr = (k) => { const a = k.publicKey.toBase58(); keys.set(a, k); return a }
const PEOPLE = {
  // X sign in; the identity token carries no picture, Privy's user object does
  alex: { did: 'did:privy:cmalex00000000000000000001', x: { subject: '2001', username: 'alex_x', pfp: 'https://pbs.twimg.com/profile_images/1/alex_normal.png', pfpInToken: false }, wallets: { Phantom: addr(kp()), Solflare: addr(kp()) }, embedded: addr(kp()) },
  // X sign in, no wallet at all: the only one offered "Create a wallet for me"
  dana: { did: 'did:privy:cmdana00000000000000000001', x: { subject: '2002', username: 'dana_x', pfp: 'https://pbs.twimg.com/profile_images/2/dana_normal.jpg', pfpInToken: true }, wallets: {}, embedded: addr(kp()) },
  // Signs in with Phantom itself
  erin: { did: 'did:privy:cmerin00000000000000000001', x: null, wallets: { Phantom: addr(kp()) }, embedded: addr(kp()) },
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const errors = []
async function person(name) {
  const p = PEOPLE[name], ctx = await browser.createBrowserContext(), page = await ctx.newPage(), me = { name, p, page, msgs: 0 }
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  await page.evaluateOnNewDocument((persona) => { window.__fpPersona = persona }, p)
  await page.exposeFunction('__fpTokens', (json) => {
    const s = JSON.parse(json), t = Math.floor(Date.now() / 1000), base = { iss: 'privy.io', aud: APP, sub: s.did, iat: t, exp: t + 3600 }
    const accounts = [...(s.x ? [{ type: 'twitter_oauth', subject: s.x.subject, username: s.x.username, profile_picture_url: s.x.pfp }] : []),
      ...s.linked.map((l) => ({ type: 'wallet', address: l.address, chain_type: 'solana', wallet_client_type: l.embedded ? 'privy' : 'phantom', connector_type: l.embedded ? 'embedded' : 'solana_adapter', latest_verified_at: t }))]
    return JSON.stringify({ accessToken: jwt({ ...base, sid: 's-' + name }), identityToken: jwt({ ...base, linked_accounts: JSON.stringify(accounts) }) })
  })
  await page.exposeFunction('__fpSign', (address, kind, b64) => {
    if (kind !== 'msg') throw new Error('no transactions in this test')
    me.msgs++
    return Buffer.from(ed25519.sign(Buffer.from(b64, 'base64'), keys.get(address).secretKey.slice(0, 32))).toString('base64')
  })
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const u = r.url()
    if (u.startsWith(BASE) && /^\/privy\.[0-9a-f]{8}\.js$/.test(new URL(u).pathname)) return r.respond({ status: 200, contentType: 'text/javascript', body: island })
    if (u.startsWith(BASE) || /^(data:|about:)/.test(u)) return r.continue()
    return r.abort()
  })
  await page.setViewport({ width: 1440, height: 900 })
  return me
}
const goto = async (page, path = '/') => { await page.goto(BASE + path, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#view', { timeout: 30_000 }); await sleep(800) }
const click = async (page, sel) => { await page.waitForSelector(sel, { visible: true, timeout: 15_000 }); await page.click(sel) }
const me = (page) => page.evaluate(() => fetch('/api/me').then((r) => r.json()))
const fp = (page) => page.evaluate(() => window.__fp ?? {})
const active = (page) => page.evaluate(() => localStorage.getItem('ws.wallet'))
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '')

let failed = false
try {
  const A = await person('alex'), pa = PEOPLE.alex
  console.log('\n== sign in with X: one press, Privy finishes after X, picture shown, no wallet made')
  await goto(A.page)
  await click(A.page, 'header [data-conn]')
  await A.page.waitForSelector('#fp-modal[data-kind=login]', { visible: true, timeout: 15_000 })
  ok('Connect opens the Privy modal in one press')
  await click(A.page, '[data-fp=x]') // leaves for "X" and comes back with privy_oauth_* in the address
  await until(async () => (await me(A.page)).signedIn, 'signed in after coming back from X', 20_000)
  const m1 = await me(A.page)
  assert.equal(m1.handle, 'alex_x'); assert.equal(m1.wallet, null, 'no wallet linked by itself')
  assert.equal(m1.avatar, 'https://pbs.twimg.com/profile_images/1/alex_200x200.png', 'the picture from Privy\'s user object, X host only')
  assert.equal((await fp(A.page)).open_login, undefined, 'the modal was not needed a second time') // counters reset with the page; the first open was before X
  assert.doesNotMatch(A.page.url(), /privy_oauth/)
  // The wallet step opens by itself, with outside wallets first and "Create a wallet for me" as a choice
  await A.page.waitForSelector('.sheet [data-act=privyConnect]', { visible: true, timeout: 10_000 })
  assert.ok(await A.page.$('.sheet [data-act=privyCreate]'), 'Create a wallet for me offered to someone with no wallet')
  assert.equal(await A.page.evaluate(() => window.__fpConfig.embeddedWallets.solana.createOnLogin), 'off')
  assert.equal((await fp(A.page)).create, undefined, 'no embedded wallet made')
  await until(() => A.page.evaluate(() => { const i = document.querySelector('header [data-conn] img'); return i && i.complete && i.naturalWidth > 0 }), 'X picture in the header', 10_000)
  assert.match(await text(A.page, 'header [data-conn]'), /@alex_x/)
  assert.ok(picFetches.some((u) => /alex_200x200/.test(u)), 'picture fetched by our server, not the page')
  ok('X sign in finished with no second press', 'handle, picture through /api/site/xavatar, wallet step open, no embedded wallet')

  console.log('\n== connect an outside wallet: it becomes the site\'s wallet at once')
  await click(A.page, '.sheet [data-act=privyConnect]')
  await A.page.waitForSelector('#fp-modal[data-kind=connect]', { visible: true })
  await click(A.page, '[data-fp="pick:Phantom"]')
  await until(async () => (await me(A.page)).wallet === pa.wallets.Phantom, 'Phantom linked', 15_000)
  assert.equal(await active(A.page), 'privy:' + pa.wallets.Phantom)
  assert.equal(A.msgs, 1, 'one message signed to link a wallet Privy only connected')
  await until(async () => !(await A.page.$('.sheet')), 'sheet closes when ready')
  assert.ok(await A.page.$('header [data-conn].is-on'))
  ok('Phantom picked in Privy is the active wallet', 'linked with one signature, sheet closed')
  // A reload keeps it and asks nothing
  await goto(A.page)
  await until(async () => (await active(A.page)) === 'privy:' + pa.wallets.Phantom && (await A.page.$('header [data-conn].is-on')), 'Phantom back after a reload')
  await sleep(1500)
  assert.equal(A.msgs, 1); assert.equal(await A.page.$('.sheet'), null, 'no prompt after a reload')
  ok('reload: same wallet, no prompt')

  console.log('\n== switch wallets')
  await click(A.page, 'header [data-conn]')
  await click(A.page, '.sheet [data-act=privyConnect]')
  await click(A.page, '[data-fp="pick:Solflare"]')
  await until(async () => (await me(A.page)).wallet === pa.wallets.Solflare, 'switched to Solflare', 15_000)
  assert.equal(await active(A.page), 'privy:' + pa.wallets.Solflare)
  assert.equal((await me(A.page)).pendingWallet, null, 'Phantom was never used: no 48 hour wait')
  await A.page.keyboard.press('Escape'); await A.page.evaluate(() => document.querySelector('.sheetwrap')?.remove())
  await click(A.page, 'header [data-conn]')
  await click(A.page, `.sheet [data-act=pickPrivy][data-v="${pa.wallets.Phantom}"]`)
  await until(async () => (await me(A.page)).wallet === pa.wallets.Phantom, 'back to Phantom', 15_000)
  ok('switching between connected wallets', 'Phantom to Solflare and back, each linked at once while unused')
  // Once Phantom has bid, a switch no longer relinks by itself: the 48 hour rule stands, and the person decides
  db.run('INSERT INTO events_seen (sig,idx,name,listing,data,at) VALUES (?,?,?,?,?,?)', 'e2esig', 0, 'BidPlaced', 'L', JSON.stringify({ name: 'BidPlaced', bidder: pa.wallets.Phantom }), 1)
  const before = A.msgs
  await A.page.evaluate(() => document.querySelector('.sheetwrap')?.remove())
  await click(A.page, 'header [data-conn]')
  await click(A.page, `.sheet [data-act=pickPrivy][data-v="${pa.wallets.Solflare}"]`)
  await until(async () => /waits 48 hours/.test(await text(A.page, '.sheet')) && (await A.page.$('.sheet [data-act=linkWallet]')), 'the 48 hour note')
  await sleep(1000)
  assert.equal(A.msgs, before, 'nothing asked by itself'); assert.equal((await me(A.page)).wallet, pa.wallets.Phantom)
  await click(A.page, `.sheet [data-act=pickPrivy][data-v="${pa.wallets.Phantom}"]`)
  await until(async () => (await active(A.page)) === 'privy:' + pa.wallets.Phantom, 'back on the used wallet')
  ok('a used wallet keeps the 48 hour rule', 'switching shows the wait and asks nothing by itself')

  console.log('\n== disconnect and reconnect')
  await A.page.evaluate(() => document.querySelector('.sheetwrap')?.remove())
  await click(A.page, 'header [data-conn]')
  await click(A.page, '.sheet [data-act=disconnect]')
  await until(async () => !(await A.page.$('header [data-conn].is-on')), 'header shows no wallet')
  assert.equal(await active(A.page), null)
  assert.equal((await fp(A.page)).disconnect, 1, 'the wallet itself was disconnected through Privy')
  assert.match(await text(A.page, 'header [data-conn]'), /@alex_x/, 'still signed in')
  await goto(A.page); await sleep(1500)
  assert.equal(await active(A.page), null, 'no wallet comes back after a reload'); assert.equal(await A.page.$('.sheet'), null, 'and no prompt')
  ok('disconnect', 'wallet dropped, stays dropped after a reload, still signed in')
  const before2 = A.msgs
  await click(A.page, 'header [data-conn]')
  assert.equal(await A.page.$('#fp-modal[data-kind=login]'), null, 'signed in: no sign in modal again')
  await click(A.page, '.sheet [data-act=privyConnect]')
  await click(A.page, '[data-fp="pick:Phantom"]')
  await until(async () => (await active(A.page)) === 'privy:' + pa.wallets.Phantom && (await A.page.$('header [data-conn].is-on')), 'Phantom reconnected')
  await until(async () => !(await A.page.$('.sheet')), 'sheet closes')
  assert.equal(A.msgs, before2, 'already the account\'s wallet: nothing to sign')
  ok('reconnect', 'the linked wallet back with no extra prompt')

  console.log('\n== create a wallet, only when asked')
  const Dn = await person('dana'), pd = PEOPLE.dana
  await goto(Dn.page)
  await click(Dn.page, '.hero [data-act=signin]')
  await click(Dn.page, '[data-fp=x]')
  await until(async () => (await me(Dn.page)).signedIn, 'dana signed in', 20_000)
  assert.equal((await me(Dn.page)).avatar, 'https://pbs.twimg.com/profile_images/2/dana_200x200.jpg', 'picture from the identity token')
  await Dn.page.waitForSelector('.sheet [data-act=privyCreate]', { visible: true, timeout: 10_000 })
  assert.equal((await fp(Dn.page)).create, undefined)
  // Closing the step and trying to sell brings the same choice back
  await Dn.page.evaluate(() => document.querySelector('.sheetwrap')?.remove())
  await click(Dn.page, '.hero [data-act=connect]')
  await click(Dn.page, '.sheet [data-act=privyCreate]')
  await until(async () => (await me(Dn.page)).wallet === pd.embedded, 'embedded wallet linked', 15_000)
  assert.equal((await fp(Dn.page)).create, 1); assert.equal(Dn.msgs, 0, 'Privy verified it: nothing to sign')
  assert.equal(await active(Dn.page), 'privy:' + pd.embedded)
  ok('Create a wallet for me', 'made on request only, active and linked with no message')

  console.log('\n== sign in with a wallet')
  const E = await person('erin'), pe = PEOPLE.erin
  await goto(E.page)
  await click(E.page, 'header [data-conn]')
  await click(E.page, '[data-fp="wallet:Phantom"]')
  await until(async () => (await me(E.page)).wallet === pe.wallets.Phantom, 'erin linked', 15_000)
  assert.equal(await active(E.page), 'privy:' + pe.wallets.Phantom)
  assert.equal(E.msgs, 0); assert.equal((await fp(E.page)).open_login, 1, 'one modal'); assert.equal((await fp(E.page)).create, undefined)
  await until(async () => (await E.page.$('header [data-conn].is-on')), 'header shows the wallet')
  ok('Phantom sign in', 'signed in, active and linked in one modal, no embedded wallet')

  assert.deepEqual(errors, [], 'no page errors')
} catch (e) {
  failed = true
  console.log('\nFAIL', e?.message)
  console.log(' page errors:', errors.join(' | ').slice(0, 1500))
} finally {
  await browser.close().catch(() => {})
  server.close(); rmSync(data, { recursive: true, force: true })
}
console.log(failed ? '\nprivy e2e FAILED' : '\nprivy e2e passed')
process.exit(failed ? 1 : 0)
