// The launch day pieces: legal pages, security.txt, robots and sitemap, the launch test record, the CA reveal, the admin
// facts, the T-10 check and the RPC load test. Chain answers come from a mock RPC; nothing here touches a real network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { loadConfig } from '../src/config.mjs'
import { openDb } from '../src/db.mjs'
import { listen } from '../src/http.mjs'
import { siteConfigReader } from '../src/site.mjs'
import { withLaunch, LaunchTest, MAINNET_GENESIS } from '../src/launch.mjs'
import { LEGAL, SITE_ROUTES, SECURITY_EXPIRES, CONTACT } from '../src/legal.mjs'
import { runChecks, report, PROGRAM_ID } from '../tools/check.mjs'
import { loadTest, walletsFrom, ata, BATCH } from '../tools/loadtest-rpc.mjs'

const ADMIN = 'a'.repeat(40)
// Every folder a test makes is removed at the end
const made = []
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d }
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const sig = () => bs58.encode(Keypair.generate().secretKey) // 64 random bytes, shaped like a signature
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }

function dist() {
  const d = tmp('sb-dist-')
  writeFileSync(join(d, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sidebid, live auctions for Solana tokens</title><meta name="description" content="x">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hubot+Sans" media="print" data-fonts>
<link rel="stylesheet" href="/app.12345678.css">
</head><body><div id="app"><!--fp--></div>
<script type="module" src="/app.12345678.js"></script>
</body></html>`)
  return d
}

/** A server with the launch wrapper around a stub site, a fresh database and a fake chain. */
async function setup({ env = {}, cfgEnv = {}, rpc = {}, siteJson = null } = {}) {
  const dataDir = tmp('sb-data-')
  if (siteJson) writeFileSync(join(dataDir, 'site.json'), JSON.stringify(siteJson))
  const config = loadConfig({ PUBLIC_URL: 'http://127.0.0.1:1', DATA_DIR: dataDir, ADMIN_SECRET: ADMIN, ...cfgEnv })
  const db = openDb(join(dataDir, 'sidebid.db'))
  const fake = { calls: {}, ...rpc }
  const app = {
    db,
    rpc: {
      statuses: async (s) => { fake.calls.statuses = (fake.calls.statuses ?? 0) + 1; return fake.statuses(s) },
      call: async (m, fn) => fn(fake.conn ?? {}),
      account: async (k) => (fake.account ? fake.account(k) : null),
    },
  }
  fake.conn ??= { getGenesisHash: async () => MAINNET_GENESIS, getBlockTime: async (slot) => (fake.blockTime ? fake.blockTime(slot) : 1_700_000_000 + slot) }
  const site = (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"from_site"}') }
  const handler = withLaunch(site, app, config, { dist: dist(), env: { ...env, SITE_CONFIG: join(dataDir, 'site.json') } })
  const server = await listen(handler, 0)
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, server, db, fake, dataDir, config, close: () => server.close() }
}

const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#\d+;|&middot;/g, ' ')

test('legal pages: own title and share tags, no app script, fonts load, footer links', async () => {
  const s = await setup()
  try {
    for (const k of ['terms', 'privacy']) {
      const r = await fetch(`${s.base}/${k}`), h = await r.text()
      assert.equal(r.status, 200)
      assert.match(r.headers.get('content-type'), /text\/html/)
      assert.match(r.headers.get('content-security-policy'), /script-src 'none'/)
      assert.match(h, new RegExp(`<title>${LEGAL[k].title} \\| Sidebid</title>`))
      assert.match(h, new RegExp(`<meta property="og:url" content="http://127.0.0.1:1/${k}">`))
      assert.match(h, /<meta property="og:image" content="http:\/\/127.0.0.1:1\/og\/site.png">/)
      assert.match(h, new RegExp(`<link rel="canonical" href="http://127.0.0.1:1/${k}">`))
      assert.equal((h.match(/property="og:title"/g) ?? []).length, 1)
      assert.doesNotMatch(h, /<script/)
      assert.doesNotMatch(h, /media="print"/)
      assert.match(h, /href="\/app.12345678.css"/)
      assert.match(h, /href="\/terms"/); assert.match(h, /href="\/privacy"/)
      assert.match(h, new RegExp(`mailto:${CONTACT}`))
      const head = await fetch(`${s.base}/${k}/`, { method: 'HEAD' })
      assert.equal(head.status, 200)
    }
    // Anything else, and any other method, goes to the site unchanged
    assert.equal((await (await fetch(`${s.base}/terms`, { method: 'POST' })).json()).error, 'from_site')
    assert.equal((await (await fetch(`${s.base}/live`)).json()).error, 'from_site')
  } finally { s.close() }
})

test('legal copy: the required facts, and none of the banned words or dashes', async () => {
  const s = await setup()
  try {
    const terms = text(await (await fetch(`${s.base}/terms`)).text()), privacy = text(await (await fetch(`${s.base}/privacy`)).text())
    assert.match(terms, /not custodial/); assert.match(terms, /sign every transaction yourself/); assert.match(terms, /Memecoins/)
    assert.match(terms, /Smart contracts/); assert.match(terms, /No advice/); assert.match(terms, /takes no fee on sales/); assert.match(terms, /0\.0031 SOL/)
    for (const w of ['X handle', 'X account id', 'profile picture', 'wallet', 'session', 'Privy', 'do not sell', CONTACT]) assert.ok(privacy.includes(w), w)
    for (const [name, t] of [['terms', terms], ['privacy', privacy]]) {
      // Copy only: the page around it carries class names and a date, so the dash check runs on the page's own words
      const words = t.toLowerCase()
      for (const bad of ['audited', "can't touch", 'cannot touch', "rules can't change", 'no admin', 'otc', 'desk', 'bag']) assert.ok(!new RegExp(`\\b${bad}\\b`).test(words), `${name}: ${bad}`)
      assert.ok(!/[‒-―−]/.test(t), `${name}: long dash`)
      assert.ok(!/\w-\w|\s-\s/.test(t.replace(/sidebid@outlook\.com|https?:\/\/\S+/g, '')), `${name}: hyphen or dash`)
    }
  } finally { s.close() }
})

test('security.txt, robots.txt and sitemap.xml', async () => {
  const s = await setup()
  try {
    for (const p of ['/.well-known/security.txt', '/security.txt']) {
      const r = await fetch(s.base + p), t = await r.text()
      assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/plain/)
      assert.match(t, /^Contact: mailto:sidebid@outlook\.com$/m)
      assert.match(t, new RegExp(`^Expires: ${SECURITY_EXPIRES.replace(/\./g, '\\.')}$`, 'm'))
      assert.match(t, /^Policy: http:\/\/127\.0\.0\.1:1\/docs$/m)
      assert.match(t, /^Canonical: http:\/\/127\.0\.0\.1:1\/\.well-known\/security\.txt$/m)
      assert.match(t, /github\.com\/sidebid\/sidebid/)
    }
    // About a year out, and never already past
    const days = (Date.parse(SECURITY_EXPIRES) - Date.parse('2026-11-06T00:00:00Z')) / 86_400_000
    assert.ok(days >= 300 && days <= 366, String(days))
    const robots = await (await fetch(`${s.base}/robots.txt`)).text()
    assert.match(robots, /Disallow: \/api\//); assert.doesNotMatch(robots, /Disallow: \/og/); assert.match(robots, /Sitemap: http:\/\/127\.0\.0\.1:1\/sitemap\.xml/)
    const r = await fetch(`${s.base}/sitemap.xml`), x = await r.text()
    assert.match(r.headers.get('content-type'), /xml/)
    for (const route of SITE_ROUTES) assert.ok(x.includes(`<loc>http://127.0.0.1:1${route}</loc>`), route)
  } finally { s.close() }
})

test('launch test record: admin only, validated, statuses and block times from chain, finalized kept', async () => {
  const [a, b, c, d] = [sig(), sig(), sig(), sig()]
  let answer = { [a]: { slot: 10, confirmationStatus: 'finalized', err: null }, [b]: { slot: 11, confirmationStatus: 'confirmed', err: null }, [c]: { slot: 12, confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 6001 }] } } }
  const s = await setup({ rpc: { statuses: async (sigs) => sigs.map((x) => answer[x] ?? null) } })
  try {
    const post = (body, secret = ADMIN) => fetch(`${s.base}/api/admin/launch-test`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) }, body: JSON.stringify(body) })
    assert.equal((await post({ items: [] }, null)).status, 403)
    assert.equal((await post({ items: [] }, 'b'.repeat(40))).status, 403)
    assert.equal((await (await post({ items: [{ sig: 'nope', label: 'Bid' }] })).json()).error, 'bad_signature')
    assert.equal((await (await post({ items: [{ sig: a, label: '' }] })).json()).error, 'bad_label')
    let r = await post({ items: [{ sig: a, label: 'Listing' }, { sig: b, label: 'Bid' }, { sig: c, label: 'Settle' }] })
    assert.equal(r.status, 200)
    r = await post({ add: { sig: d, label: 'Outbid refund', note: 'first bidder paid back' } })
    assert.equal((await r.json()).items.length, 4)
    const listed = await (await fetch(`${s.base}/api/admin/launch-test`, { headers: { 'x-admin-secret': ADMIN } })).json()
    assert.deepEqual(listed.items.map((x) => x.label), ['Listing', 'Bid', 'Settle', 'Outbid refund'])
    assert.ok(listed.labels.includes('Fixed buy') && listed.labels.includes('Payout'))

    const view = await (await fetch(`${s.base}/api/site/launch-test`)).json()
    const by = Object.fromEntries(view.items.map((x) => [x.label, x]))
    assert.equal(by.Listing.status, 'finalized'); assert.equal(by.Listing.blockTime, 1_700_000_010); assert.equal(by.Listing.url, `https://solscan.io/tx/${a}`)
    assert.equal(by.Bid.status, 'confirmed'); assert.equal(by.Bid.slot, 11)
    assert.equal(by.Settle.status, 'failed'); assert.match(by.Settle.err, /6001/)
    assert.equal(by['Outbid refund'].status, 'not_found'); assert.equal(by['Outbid refund'].note, 'first bidder paid back')
    assert.ok(view.checkedAt > 0)
    // Kept: the finalized ones are never asked again
    const seen = JSON.parse(s.db.meta('launch_test_seen'))
    assert.ok(seen[a] && seen[c]); assert.ok(!seen[b] && !seen[d])

    // Remove one, and a failed read says unknown rather than guessing
    await post({ remove: d })
    answer = null
    s.fake.statuses = async () => { throw new Error('down') }
    const lt = new LaunchTest({ db: s.db, rpc: { statuses: s.fake.statuses, blockTime: async () => 1 } })
    const v2 = await lt.view()
    assert.deepEqual(v2.items.map((x) => x.status), ['finalized', 'unknown', 'failed'])
  } finally { s.close() }
})

test('reveal: admin writes the CA into site.json only for a real mint; hiding keeps the rest of the file', async () => {
  const mint = Keypair.generate().publicKey.toBase58(), notMint = Keypair.generate().publicKey.toBase58()
  const accounts = { [mint]: { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: Buffer.alloc(82) }, [notMint]: { owner: new PublicKey('11111111111111111111111111111111'), data: Buffer.alloc(0) } }
  const s = await setup({ rpc: { account: async (k) => accounts[k.toBase58()] ?? null }, siteJson: { chain: { rpc: 'https://rpc.example', cluster: 'mainnet-beta' }, brand: { reveal: false }, stats: { minSales: 5 } } })
  try {
    const post = (body) => fetch(`${s.base}/api/admin/reveal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))
    assert.equal((await post({ ca: 'x' })).body.error, 'bad_address')
    assert.equal((await post({ ca: notMint })).body.error, 'not_a_mint')
    assert.equal((await post({ ca: mint, xHandle: 'bad handle!' })).body.error, 'bad_handle')
    const r = await post({ ca: mint, xHandle: '@sidebidsol' })
    assert.equal(r.status, 200); assert.deepEqual(r.body, { reveal: true, ca: mint, xHandle: 'sidebidsol' })
    const file = JSON.parse(readFileSync(join(s.dataDir, 'site.json'), 'utf8'))
    assert.equal(file.chain.rpc, 'https://rpc.example'); assert.equal(file.stats.minSales, 5)
    const read = siteConfigReader({ config: s.config, env: { SITE_CONFIG: join(s.dataDir, 'site.json') } })({})
    assert.equal(read.brand.ca, mint); assert.equal(read.brand.xHandle, 'sidebidsol')
    assert.equal((await post({ reveal: false })).body.reveal, false)
    assert.equal(siteConfigReader({ config: s.config, env: { SITE_CONFIG: join(s.dataDir, 'site.json') } })({}).brand.ca, null)
    assert.equal((await fetch(`${s.base}/api/admin/reveal`, { method: 'POST', body: '{}' })).status, 403)
  } finally { s.close() }
})

test('launch-check facts: volume, preview variable, keys, no secrets', async () => {
  const keeper = Keypair.generate()
  const vol = tmp('sb-vol-'), dataDir = join(vol, 'data'); mkdirSync(dataDir)
  const s = await setup({ env: { RAILWAY_VOLUME_MOUNT_PATH: vol, PREVIEW_CHAIN: '1' }, cfgEnv: { KEEPER_SECRET: bs58.encode(keeper.secretKey), DATA_DIR: dataDir } })
  try {
    const r = await fetch(`${s.base}/api/admin/launch-check`, { headers: { 'x-admin-secret': ADMIN } }), f = await r.json()
    assert.equal(f.onVolume, true); assert.equal(f.previewChain, true); assert.equal(f.genesisHash, MAINNET_GENESIS)
    assert.equal(f.keys.keeper, keeper.publicKey.toBase58()); assert.equal(f.programId, PROGRAM_ID)
    assert.equal(f.counts.listings, 0)
    const raw = JSON.stringify(f)
    assert.ok(!raw.includes(ADMIN) && !raw.includes(bs58.encode(keeper.secretKey)))
    assert.equal((await fetch(`${s.base}/api/admin/launch-check`)).status, 403)
  } finally { s.close() }
})

// ---- the T-10 check against a stub site and a mock RPC
function mockRpc({ authority = null, keeperLamports = 2e9, genesis = MAINNET_GENESIS, listings = {} } = {}) {
  const pd = Keypair.generate().publicKey
  const programData = Buffer.concat([u32(3), u64(1234), authority ? Buffer.concat([Buffer.from([1]), new PublicKey(authority).toBuffer()]) : Buffer.from([0])])
  const accts = { [PROGRAM_ID]: { executable: true, owner: LOADER, data: [Buffer.concat([u32(2), pd.toBuffer()]).toString('base64'), 'base64'], lamports: 1 }, [pd.toBase58()]: { executable: false, owner: LOADER, data: [programData.toString('base64'), 'base64'], lamports: 1 }, ...listings }
  const calls = []
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body); calls.push(method)
      const result = method === 'getSlot' ? 1 : method === 'getGenesisHash' ? genesis : method === 'getBalance' ? { context: { slot: 1 }, value: keeperLamports }
        : method === 'getAccountInfo' ? { context: { slot: 1 }, value: accts[params[0]] ?? null }
        : method === 'getMultipleAccounts' ? { context: { slot: 1 }, value: params[0].map((k) => accts[k] ?? null) } : null
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })
  })
  return { server, calls }
}

async function checkWorld({ rpcOpts = {}, siteOpts = {}, env = {} } = {}) {
  const rpc = mockRpc(rpcOpts)
  await new Promise((ok) => rpc.server.listen(0, '127.0.0.1', ok))
  const rpcUrl = `http://127.0.0.1:${rpc.server.address().port}`
  const keeper = Keypair.generate()
  const vol = tmp('sb-vol-')
  const config = loadConfig({ PUBLIC_URL: 'http://127.0.0.1:1', DATA_DIR: vol, ADMIN_SECRET: ADMIN, KEEPER_SECRET: bs58.encode(keeper.secretKey), NODE_ENV: 'production', TRUSTED_HOPS: '0' })
  const db = openDb(join(vol, 'sidebid.db'))
  const o = { programId: PROGRAM_ID, cluster: 'mainnet-beta', flags: { signinLive: true, keeperLive: true }, cap: 10, badge: false, listings: [], ...siteOpts }
  let base = ''
  const site = (req, res) => {
    const p = new URL(req.url, 'http://x').pathname, j = (b, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><head><meta property="og:title" content="Sidebid"><meta property="og:image" content="${base}/og/site.png"></head><body>${o.badge ? '<div>Preview on a test chain</div>' : ''}</body></html>`) }
    if (p === '/og/site.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(5000)) }
    if (p === '/api/config') return j({ chain: { programId: o.programId, cluster: o.cluster, rpc: rpcUrl }, brand: { reveal: false } })
    if (p === '/api/admin/status') return req.headers['x-admin-secret'] === ADMIN ? j({ flags: o.flags, xSpend: { capUsd: o.cap, spentUsd: 0.5 }, keeper: {} }) : j({ error: 'no' }, 403)
    if (p === '/api/listings') return j({ items: o.listings })
    if (p === '/rpc') return j({ error: 'not_found' }, o.badge ? 405 : 404)
    j({ error: 'not_found' }, 404)
  }
  const app = { db, rpc: { statuses: async () => [], account: async () => null, call: async (m, fn) => fn({ getGenesisHash: async () => rpcOpts.genesis ?? MAINNET_GENESIS }) } }
  const server = await listen(withLaunch(site, app, config, { dist: dist(), env: { RAILWAY_VOLUME_MOUNT_PATH: vol, ...env } }), 0)
  base = `http://127.0.0.1:${server.address().port}`
  return { base, rpcUrl, keeper, calls: rpc.calls, close: () => { server.close(); rpc.server.close() } }
}

test('check: ALL CLEAR on a healthy launch, with authority and keeper read from chain', async () => {
  const w = await checkWorld({ rpcOpts: { authority: null } })
  try {
    const r = await runChecks({ base: w.base, rpcUrl: w.rpcUrl, adminSecret: ADMIN, flags: ['signinLive', 'keeperLive'], minXCapUsd: 4, authority: 'revoked' })
    const out = report(r)
    assert.ok(r.every((x) => x.ok), out)
    assert.match(out, /ALL CLEAR$/)
    assert.match(out, /upgrade authority revoked/)
    assert.match(out, /Keeper SOL: 2\.0000 SOL/)
    assert.ok(!out.includes(ADMIN))
    for (const m of ['getSlot', 'getGenesisHash', 'getAccountInfo', 'getBalance']) assert.ok(w.calls.includes(m), m)
  } finally { w.close() }
})

test('check: names every problem, and says NOT CLEAR', async () => {
  const team = Keypair.generate().publicKey.toBase58(), ghost = Keypair.generate().publicKey.toBase58()
  const w = await checkWorld({
    rpcOpts: { authority: team, keeperLamports: 1e6 },
    siteOpts: { programId: Keypair.generate().publicKey.toBase58(), flags: { signinLive: true, killKeeper: true }, cap: 0, badge: true, listings: [{ pubkey: ghost, closed: false }] },
    env: { PREVIEW_CHAIN: '1' },
  })
  try {
    const r = await runChecks({ base: w.base, rpcUrl: w.rpcUrl, adminSecret: ADMIN, flags: ['keeperLive'], minXCapUsd: 4, authority: 'revoked' })
    const out = report(r), failed = r.filter((x) => !x.ok).map((x) => x.name)
    for (const n of ['site.json', 'Program', 'Flags', 'X spend cap', 'Server', 'Keeper SOL', 'Preview residue']) assert.ok(failed.includes(n), `${n} should fail\n${out}`)
    assert.match(out, /kill switch on: killKeeper/); assert.match(out, /should be on: keeperLive/)
    assert.match(out, /PREVIEW_CHAIN=1/); assert.match(out, /preview badge/); assert.match(out, /not on chain/)
    assert.match(out, new RegExp(`upgrade authority ${team}, expected revoked`))
    assert.match(out, /NOT CLEAR/)
  } finally { w.close() }
})

test('check: without the admin secret it says so instead of passing', async () => {
  const w = await checkWorld()
  try {
    const r = await runChecks({ base: w.base, rpcUrl: w.rpcUrl })
    assert.ok(r.some((x) => x.name === 'Admin' && !x.ok))
    assert.match(report(r), /NOT CLEAR/)
  } finally { w.close() }
})

test('loadtest: 800 wallets in batches of 100, counting 429s and errors', async () => {
  const mint = Keypair.generate().publicKey.toBase58()
  let n = 0
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body)
      if (method === 'getAccountInfo') { res.writeHead(200); return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: ['', 'base64'] } } })) }
      n++
      assert.ok(params[0].length <= BATCH)
      if (n === 3) { res.writeHead(429); return res.end('') }
      if (n === 5) { res.writeHead(200); return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'Node is behind' } })) }
      const value = params[0].map((k, i) => (i === 0 ? { data: [u64(5).toString('base64'), 'base64'] } : null))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } }))
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  try {
    const wallets = Array.from({ length: 800 }, () => Keypair.generate().publicKey.toBase58())
    const r = await loadTest({ rpcUrl: `http://127.0.0.1:${server.address().port}`, mint, wallets, concurrency: 4 })
    assert.equal(r.batches, 8); assert.equal(r.calls, 8); assert.equal(r.http429, 1); assert.equal(r.errors, 2); assert.equal(r.ok, 6)
    assert.equal(r.accountsRead, 600); assert.equal(r.holdersSeen, 6); assert.equal(r.pass, false)
    assert.equal(r.errorMessages['Node is behind'], 1)
    assert.equal(ata(wallets[0], mint), PublicKey.findProgramAddressSync([new PublicKey(wallets[0]).toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58())
    assert.deepEqual(walletsFrom(JSON.stringify([wallets[0], { address: wallets[1] }, { trackedWalletAddress: wallets[2] }, 'junk'])), wallets.slice(0, 3))
  } finally { server.close() }
})
