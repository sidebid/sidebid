import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { world, seller, listingFixture, Keypair, PublicKey } from './harness.mjs'
import { listen } from '../src/http.mjs'
import { withSite, siteConfigReader, readLog, logMode } from '../src/site.mjs'
import { TrustWatch, SQUADS, LOADER, DISC, vaultPda, proposalPda, txPda, programDataPda } from '../src/trust.mjs'
import { CoinImages, privateIp, sniff, BUSY, NOMINT } from '../src/coinimg.mjs'

// ---- account bytes, built by hand from the Squads v4 and upgradeable loader layouts
const acct = (owner, data) => ({ owner: new PublicKey(owner), data: Buffer.from(data), lamports: 1, executable: false })
const programAcct = (pd) => acct(LOADER, Buffer.concat([u32(2), pd.toBuffer()]))
const programData = (slot, authority) => acct(LOADER, Buffer.concat([u32(3), u64(slot), authority ? Buffer.concat([Buffer.from([1]), new PublicKey(authority).toBuffer()]) : Buffer.from([0])]))
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const multisigAcct = ({ lock, txIndex, stale = 0, members = 2, threshold = 2, configAuthority = null }) => acct(SQUADS, Buffer.concat([DISC.multisig, Keypair.generate().publicKey.toBuffer(), configAuthority ? new PublicKey(configAuthority).toBuffer() : Buffer.alloc(32), u16(threshold), u32(lock), u64(txIndex), u64(stale), Buffer.from([0]), Buffer.from([255]), u32(members), ...Array.from({ length: members }, () => Buffer.concat([Keypair.generate().publicKey.toBuffer(), Buffer.from([7])]))]))
const proposalAcct = (ms, index, kind, at) => acct(SQUADS, Buffer.concat([DISC.proposal, ms.toBuffer(), u64(index), Buffer.from([kind]), kind === 4 ? Buffer.alloc(0) : i64(at), Buffer.from([255]), u32(0), u32(0), u32(0)]))
const vaultTxAcct = (ms, index, keys) => acct(SQUADS, Buffer.concat([DISC.vault, ms.toBuffer(), Keypair.generate().publicKey.toBuffer(), u64(index), Buffer.from([255, 0, 254]), u32(0), Buffer.from([1, 1, 2]), u32(keys.length), ...keys.map((k) => new PublicKey(k).toBuffer()), u32(0), u32(0)]))
const configTxAcct = (ms, index) => acct(SQUADS, Buffer.concat([DISC.config, ms.toBuffer(), Keypair.generate().publicKey.toBuffer(), u64(index), Buffer.from([255]), u32(0)]))
class FakeConn {
  constructor() { this.m = new Map(); this.reads = 0 }
  set(k, v) { this.m.set(new PublicKey(k).toBase58(), v) }
  async getAccountInfo(k) { this.reads++; return this.m.get(new PublicKey(k).toBase58()) ?? null }
  async getMultipleAccountsInfo(ks) { this.reads++; return ks.map((k) => this.m.get(new PublicKey(k).toBase58()) ?? null) }
}
const PROG = Keypair.generate().publicKey

test('trust: team key, revoked, and a Squads vault with an approved upgrade waiting out its lock', async () => {
  const conn = new FakeConn(), pd = programDataPda(PROG), team = Keypair.generate().publicKey
  conn.set(PROG, programAcct(pd)); conn.set(pd, programData(1234, team))
  let t = 1_000_000
  const w = new TrustWatch({ conn, programId: PROG, now: () => t, cluster: 'localnet' })
  const a = await w.get()
  assert.equal(a.upgrade.state, 'key'); assert.equal(a.upgrade.authority, team.toBase58()); assert.equal(a.upgrade.deploySlot, 1234)
  assert.deepEqual(a.verified, { state: 'pending', url: null })
  // cached for 20 s, one read in flight
  const reads = conn.reads; await Promise.all([w.get(), w.get()]); assert.equal(conn.reads, reads)
  conn.set(pd, programData(1300, null)); t += 21_000
  const [x, y] = await Promise.all([w.get(), w.get()]); assert.equal(x, y)
  assert.equal(x.upgrade.state, 'revoked'); assert.equal(x.upgrade.authority, null)

  const ms = Keypair.generate().publicKey, vault = vaultPda(ms)
  conn.set(pd, programData(1400, vault)); conn.set(ms, multisigAcct({ lock: 172_800, txIndex: 3, stale: 0 }))
  conn.set(proposalPda(ms, 1), proposalAcct(ms, 1, 5, 500)); conn.set(txPda(ms, 1), vaultTxAcct(ms, 1, [vault, LOADER, pd, PROG])) // executed: not shown
  conn.set(proposalPda(ms, 2), proposalAcct(ms, 2, 3, 2_000_000)); conn.set(txPda(ms, 2), vaultTxAcct(ms, 2, [vault, LOADER, pd, PROG]))
  conn.set(proposalPda(ms, 3), proposalAcct(ms, 3, 1, 2_000_100)); conn.set(txPda(ms, 3), configTxAcct(ms, 3))
  const s = await new TrustWatch({ conn, programId: PROG, squads: { multisig: ms.toBase58() }, now: () => t, cluster: 'localnet' }).get()
  assert.equal(s.upgrade.state, 'squads'); assert.equal(s.upgrade.lockSecs, 172_800); assert.equal(s.upgrade.threshold, 2); assert.equal(s.upgrade.members, 2); assert.equal(s.upgrade.autonomous, true)
  assert.deepEqual(s.upgrade.pending.map((p) => [p.index, p.kind, p.status, p.approvedAt, p.executableAt]), [[2, 'program', 'approved', 2_000_000, 2_172_800], [3, 'settings', 'active', null, null]])
  assert.equal(s.upgrade.pending[0].proposal, proposalPda(ms, 2).toBase58())
  // a vault that is not the configured multisig's reads as a plain key
  const other = await new TrustWatch({ conn, programId: PROG, squads: { multisig: Keypair.generate().publicKey.toBase58() }, now: () => t, cluster: 'localnet' }).get()
  assert.equal(other.upgrade.state, 'key')
  // No program account at all: not deployed yet (launch day), and the build verifier is not asked, so no red "Not verified"
  let asked = 0
  const none = await new TrustWatch({ conn: new FakeConn(), programId: PROG, cluster: 'mainnet-beta', fetchImpl: async () => { asked++; return new Response('{"is_verified":false}') } }).get()
  assert.equal(none.upgrade.state, 'undeployed'); assert.deepEqual(none.verified, { state: 'pending', url: null }); assert.equal(asked, 0)
  // A failed read is not "not deployed": it stays unknown
  const broken = new FakeConn(); broken.getAccountInfo = async () => { throw new Error('502') }
  assert.equal((await new TrustWatch({ conn: broken, programId: PROG, cluster: 'localnet' }).get()).upgrade.state, 'unknown')
})

test('trust N1: a controlled multisig (settings key set) is reported as controlled, with its key', async () => {
  const conn = new FakeConn(), pd = programDataPda(PROG), ms = Keypair.generate().publicKey, boss = Keypair.generate().publicKey
  conn.set(PROG, programAcct(pd)); conn.set(pd, programData(1400, vaultPda(ms)))
  conn.set(ms, multisigAcct({ lock: 172_800, txIndex: 0, members: 3, threshold: 2, configAuthority: boss }))
  const u = (await new TrustWatch({ conn, programId: PROG, squads: { multisig: ms.toBase58() }, cluster: 'localnet' }).get()).upgrade
  assert.equal(u.state, 'squads'); assert.equal(u.autonomous, false); assert.equal(u.configAuthority, boss.toBase58())
  assert.equal(u.threshold, 2); assert.equal(u.members, 3); assert.equal(u.lockSecs, 172_800); assert.equal(u.programData, pd.toBase58())
  // the same multisig without the key is autonomous
  conn.set(ms, multisigAcct({ lock: 172_800, txIndex: 0, members: 3, threshold: 2 }))
  const a = (await new TrustWatch({ conn, programId: PROG, squads: { multisig: ms.toBase58() }, cluster: 'localnet' }).get()).upgrade
  assert.equal(a.autonomous, true); assert.equal(a.configAuthority, null)
})

test('trust N2 to N5: every open index scanned in pages, any of vaults 0 to 3, stale rules, last good reading kept', async () => {
  const conn = new FakeConn(), pd = programDataPda(PROG), ms = Keypair.generate().publicKey, v2 = vaultPda(ms, 2)
  conn.set(PROG, programAcct(pd)); conn.set(pd, programData(1500, v2))
  // 130 transactions: an approved upgrade buried at index 3 under 127 newer ones, stale index 100
  conn.set(ms, multisigAcct({ lock: 3600, txIndex: 130, stale: 100 }))
  for (let i = 4; i <= 130; i++) { conn.set(proposalPda(ms, i), proposalAcct(ms, i, 5, 10)); conn.set(txPda(ms, i), vaultTxAcct(ms, i, [v2])) }
  conn.set(proposalPda(ms, 3), proposalAcct(ms, 3, 3, 5_000)); conn.set(txPda(ms, 3), vaultTxAcct(ms, 3, [v2, LOADER, pd, PROG])) // stale but approved: can still run
  conn.set(proposalPda(ms, 2), proposalAcct(ms, 2, 1, 4_000)); conn.set(txPda(ms, 2), vaultTxAcct(ms, 2, [v2, LOADER, pd, PROG])) // stale and active: can never pass
  conn.set(proposalPda(ms, 1), proposalAcct(ms, 1, 3, 3_000)); conn.set(txPda(ms, 1), configTxAcct(ms, 1)) // stale settings change: can never run
  let t = 1_000_000
  const w = new TrustWatch({ conn, programId: PROG, squads: { multisig: ms.toBase58() }, now: () => t, cluster: 'localnet' })
  const r1 = conn.reads, a = (await w.get()).upgrade
  assert.equal(a.state, 'squads'); assert.equal(a.vaultIndex, 2)
  assert.deepEqual(a.pending.map((p) => [p.index, p.kind, p.status, p.executableAt]), [[3, 'program', 'approved', 8_600]])
  assert.equal(conn.reads - r1, 3 + 3, 'program, program data, multisig, then 130 indices in three pages')
  // executed indices are settled for good and not read again
  t += 21_000; const r2 = conn.reads; await w.get(); assert.equal(conn.reads - r2, 3 + 1)
  // a vault transaction that does not name the program is pending but is not an upgrade
  conn.set(ms, multisigAcct({ lock: 3600, txIndex: 131, stale: 100 })); conn.set(proposalPda(ms, 131), proposalAcct(ms, 131, 1, 9_000)); conn.set(txPda(ms, 131), vaultTxAcct(ms, 131, [v2]))
  t += 21_000; const b = (await w.get()).upgrade
  assert.deepEqual(b.pending.map((p) => [p.index, p.kind, p.status, p.proposedAt]), [[3, 'program', 'approved', null], [131, 'other', 'active', 9_000]])
  // a failed read keeps the last good one for five minutes, then says unknown
  const real = conn.getAccountInfo.bind(conn); conn.getAccountInfo = async () => { throw new Error('rpc down') }
  t += 21_000; const c = (await w.get()).upgrade
  assert.equal(c.state, 'squads'); assert.equal(c.readAt, Math.floor((t - 21_000) / 1000))
  t += 300_000; assert.equal((await w.get()).upgrade.state, 'unknown')
  conn.getAccountInfo = real
  // vault 4 and up is not checked unless configured
  conn.set(pd, programData(1600, vaultPda(ms, 7))); t += 21_000
  assert.equal((await w.get()).upgrade.state, 'key')
  assert.equal((await new TrustWatch({ conn, programId: PROG, squads: { multisig: ms.toBase58(), vaultIndex: 7 }, cluster: 'localnet' }).get()).upgrade.vaultIndex, 7)
})

test('trust: verified build read from OtterSec on mainnet only', async () => {
  const conn = new FakeConn(), calls = [], pd = programDataPda(PROG)
  conn.set(PROG, programAcct(pd)); conn.set(pd, programData(1234, Keypair.generate().publicKey))
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, json: async () => ({ is_verified: true }) } }
  const v = await new TrustWatch({ conn, programId: PROG, fetchImpl, cluster: 'mainnet-beta' }).get()
  assert.deepEqual(v.verified, { state: 'verified', url: `https://verify.osec.io/status/${PROG.toBase58()}` })
  assert.equal(calls.length, 1)
})

// ---- the HTTP side
function dist() {
  const d = mkdtempSync(join(tmpdir(), 'site-dist-'))
  writeFileSync(join(d, 'index.html'), '<!doctype html><html><head><title>t</title><meta property="og:title" content="old"></head><body><div id="app"></div></body></html>')
  mkdirSync(join(d, 'brand')); writeFileSync(join(d, 'brand/favicon-32.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  return d
}
async function site(w, opts = {}) {
  const server = await listen(withSite(w.app, w.config, { dist: dist(), env: { SITE_CONFIG_JSON: JSON.stringify(opts.cfg ?? {}) }, logFile: opts.logFile ?? '/nonexistent/log.json', trust: opts.trust ?? { get: async () => ({ programId: 'p', cluster: 'localnet', checkedAt: 1, upgrade: { state: 'key', pending: [] }, verified: { state: 'pending', url: null } }) }, images: opts.images }), 0)
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, get: (p) => fetch(base + p), close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok) }) }
}

test('pages: CSP limited to known origins, HSTS on https, one set of OG tags, path routes, favicon, site card', async () => {
  const w = world(), s = await site(w, { cfg: { chain: { rpc: 'https://rpc.example.com/?k=1' }, priceFeed: false } })
  const r = await s.get('/'), html = await r.text(), csp = r.headers.get('content-security-policy')
  assert.match(csp, /connect-src 'self' https:\/\/rpc\.example\.com wss:\/\/rpc\.example\.com;/)
  assert.match(csp, /img-src 'self' data:;/, 'pictures, X avatars included, come only through this site')
  assert.doesNotMatch(csp, /dexscreener|https: |\*/)
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000')
  assert.equal(html.match(/og:title/g).length, 1); assert.match(html, /og:image" content="https:\/\/sidebid\.test\/og\/site\.png"/); assert.match(html, /twitter:card" content="summary_large_image"/)
  const lg = await (await s.get('/log')).text(); assert.match(lg, /<body data-route="log">/); assert.match(lg, /og:url" content="https:\/\/sidebid\.test\/log"/)
  assert.match(await (await s.get('/tx')).text(), /data-route="tx"/)
  const fav = await s.get('/favicon.ico'); assert.equal(fav.headers.get('content-type'), 'image/png')
  const png = Buffer.from(await (await s.get('/og/site.png')).arrayBuffer()); assert.equal(png.subarray(0, 4).toString('hex'), '89504e47')
  await s.close()
  const s2 = await site(w, { cfg: { chain: { rpc: 'https://rpc.example.com', ws: 'wss://ws.example.com' }, priceFeed: true } })
  const c2 = (await s2.get('/')).headers.get('content-security-policy')
  assert.match(c2, /connect-src 'self' https:\/\/rpc\.example\.com wss:\/\/ws\.example\.com https:\/\/api\.dexscreener\.com https:\/\/api\.geckoterminal\.com;/)
  await s2.close()
})

test('pages: a shared listing has its own card tags and no second set', async () => {
  const w = world(), sl = seller(w), l = listingFixture(w, { sellerKp: sl.kp, tokenAccount: sl.tokenAccount, mint: sl.mint, amount: 1_000_000n })
  await w.app.indexer.rebuild()
  const s = await site(w), html = await (await s.get(`/c/${l.toBase58()}`)).text()
  assert.equal(html.match(/property="og:title"/g).length, 1); assert.equal(html.match(/property="og:image"/g).length, 1)
  assert.match(html, new RegExp(`og/listing/${l.toBase58()}\\.png`))
  await s.close()
})

test('config: logo only over https, ticker shape, invisible characters stripped, trust facts and stats validated', () => {
  const w = world()
  const read = (cfg) => siteConfigReader({ config: w.config, env: { SITE_CONFIG: '/nonexistent', SITE_CONFIG_JSON: JSON.stringify(cfg) } })({})
  const a = read({ brand: { name: 'Si‮deb​id', ticker: '$WH<b>', logo: 'javascript:alert(1)' }, trust: { squadsMultisig: 'nope', commit: 'xyz' }, facts: { contractTests: '177', serverTests: 214 }, stats: { minSales: -1 } })
  assert.equal(a.brand.name, 'Sidebid'); assert.equal(a.brand.ticker, 'SIDEBID'); assert.equal(a.brand.logo, null)
  assert.deepEqual(a.trust, { squadsMultisig: null, commit: null }); assert.deepEqual(a.facts, { contractTests: null, serverTests: 214 }); assert.equal(a.stats.minSales, 10)
  const ms = Keypair.generate().publicKey.toBase58()
  const b = read({ brand: { ticker: 'BAG2', logo: 'https://cdn.example.com/l.png' }, trust: { squadsMultisig: ms, commit: 'A'.repeat(40) }, stats: { minSales: 3 } })
  assert.equal(b.brand.ticker, 'BAG2'); assert.equal(b.brand.logo, 'https://cdn.example.com/l.png'); assert.deepEqual(b.trust, { squadsMultisig: ms, commit: 'a'.repeat(40) }); assert.equal(b.stats.minSales, 3)
})

test('feed: contract events, fee claims and payouts in one list, newest first; stats appear only past the threshold; lots in one query', async () => {
  const w = world(), db = w.db
  const [sel, bidder, winner] = [0, 0, 0].map(() => Keypair.generate().publicKey.toBase58()), L = Keypair.generate().publicKey.toBase58()
  db.run(`INSERT INTO listings (pubkey,seller,mint,amount,price,decimals,top_bid,closed,state) VALUES (?,?,?,?,?,?,?,0,'live')`, L, sel, 'MintA', '5000', '1000000', 6, '300000000')
  const ev = (sig, name, data, at) => db.run('INSERT INTO events_seen (sig,idx,name,listing,data,at) VALUES (?,?,?,?,?,?)', sig, 0, name, L, JSON.stringify({ listing: L, ...data }), at)
  ev('s1', 'Listed', { seller: sel, mint: 'MintA', amount: '5000', price: '1000000' }, 100)
  ev('s2', 'BidPlaced', { bidder, amount: '200000000' }, 110)
  ev('s3', 'BidPlaced', { bidder: winner, amount: '300000000' }, 120)
  ev('s4', 'Settled', { winner, seller: sel, amount: '5000', price: '300000000' }, 130)
  db.run(`INSERT INTO sales (sig,idx,listing,kind,winner,seller,amount,price,mint,decimals,at) VALUES ('s4',0,?,'Settled',?,?,'5000','300000000','MintA',6,130)`, L, winner, sel)
  db.run(`INSERT INTO reward_hours (hour,state,standings,carry_in,claim_state,claim_sig,claim_at,claimed,claim_fee) VALUES (0,'done','[]','0','measured','c1',140000,'900000','5000')`)
  db.run(`INSERT INTO reward_payouts (hour,slot,place,wallet,lamports,status,sig) VALUES (0,'a',1,?,'400000','landed','p1')`, sel)
  db.run(`INSERT INTO reward_payouts (hour,slot,place,wallet,lamports,status,sig) VALUES (0,'b',2,?,'200000','failed','p2')`, winner)
  const s = await site(w, { cfg: { stats: { minSales: 2 } } })
  const f = await (await s.get('/api/site/feed?limit=10')).json()
  assert.deepEqual(f.items.map((i) => [i.kind, i.sig]), [['payout', 'p1'], ['fee_claim', 'c1'], ['sold', 's4'], ['bid', 's3'], ['bid', 's2'], ['listed', 's1']])
  // F1: a listing row carries the token amount, and a price only when it is a fixed price or a real minimum
  const listed = f.items.find((i) => i.kind === 'listed')
  assert.deepEqual([listed.amount, listed.lamports, listed.priceKind], ['5000', null, null])
  const sold = f.items.find((i) => i.kind === 'sold')
  assert.deepEqual([sold.amount, sold.lamports, sold.mint, sold.decimals, sold.wallets], ['5000', '300000000', 'MintA', 6, [sel, winner]])
  assert.equal(f.items.find((i) => i.sig === 's2').lamports, '200000000'); assert.ok(sel in f.people)
  assert.deepEqual((await (await s.get('/api/site/feed?limit=10&before=115')).json()).items.map((i) => i.sig), ['s2', 's1'])
  ev('s5', 'Listed', { seller: sel, mint: 'MintA', amount: '7', price: '2500000000', mode: 'fixed' }, 90)
  ev('s6', 'Listed', { seller: sel, mint: 'MintA', amount: '8', price: '1500000000', mode: 'bidding' }, 80)
  ev('s7', 'Listed', { seller: sel, mint: 'MintA', amount: '9', price: 'junk', mode: 'bidding' }, 70)
  const more = (await (await s.get('/api/site/feed?limit=10&before=95')).json()).items
  assert.deepEqual(more.map((i) => [i.sig, i.amount, i.lamports, i.priceKind]), [['s5', '7', '2500000000', 'fixed'], ['s6', '8', '1500000000', 'min'], ['s7', '9', null, null]])
  let st = await (await s.get('/api/site/stats')).json()
  assert.deepEqual(st, { show: false, heldLamports: '300000000', sold: 1, paidLamports: '300000000', rewardsLamports: '400000', sellers: 1 })
  db.run(`INSERT INTO sales (sig,idx,listing,kind,winner,seller,amount,price,at) VALUES ('s9',0,?,'Bought',?,?,'1','5',150)`, L, winner, sel)
  st = await (await s.get('/api/site/stats')).json(); assert.equal(st.show, true); assert.equal(st.paidLamports, '300000005')
  const lots = await (await s.get(`/api/site/lots?keys=${L},${L},${Keypair.generate().publicKey.toBase58()}`)).json()
  assert.equal(lots[L].bids, 2); assert.equal(lots[L].lot, 1); assert.equal(Object.keys(lots).length, 2)
  await s.close()
})

test('log: a row marked for one mode shows only there, and the shipped log says nothing of a test chain in production', () => {
  const d = mkdtempSync(join(tmpdir(), 'site-log-')), f = join(d, 'log.json')
  writeFileSync(f, JSON.stringify([{ date: '2026-11-06', title: 'Test chain', env: 'preview' }, { date: '2026-11-06', title: 'Live site', env: 'production' }, { date: '2026-11-05', title: 'Both' }, { date: '2026-11-05', title: 'Both too', env: 'all' }]))
  assert.deepEqual(readLog([f], 'preview').map((r) => r.title), ['Test chain', 'Both', 'Both too'])
  assert.deepEqual(readLog([f], 'production').map((r) => r.title), ['Live site', 'Both', 'Both too'])
  assert.equal(logMode({ production: true }, {}), 'production')
  assert.equal(logMode({ production: true }, { PREVIEW_CHAIN: '1' }), 'preview')
  assert.equal(logMode({ production: false }, {}), 'preview')
  const shipped = new URL('../../web/log.json', import.meta.url).pathname
  const prod = readLog([shipped], 'production'), prev = readLog([shipped], 'preview')
  assert.ok(prod.length > 0)
  for (const r of prod) assert.doesNotMatch(`${r.title} ${r.body}`, /test chain/i, r.title)
  assert.ok(prev.some((r) => /test chain/i.test(r.body)), 'the preview keeps its test chain note')
  for (const r of [...prod, ...prev]) assert.doesNotMatch(`${r.title} ${r.body}`, /[—–]| - |\baudit|\breview|\bAI\b|twitter/i, r.title)
})

test('log: shipped file when the data dir has none, bad rows dropped, pending proposals on top', async () => {
  const d = mkdtempSync(join(tmpdir(), 'site-log-')), f = join(d, 'log.json')
  writeFileSync(f, JSON.stringify([{ date: '2026-11-05', title: 'Contract built', body: 'Tests pass.', kind: 'build' }, { date: 'yesterday', title: 'bad' }, { date: '2026-11-06', title: 'Site live', kind: 'weird' }]))
  assert.deepEqual(readLog(['/nonexistent', f]).map((r) => [r.date, r.kind]), [['2026-11-05', 'build'], ['2026-11-06', 'note']])
  const w = world()
  const trust = { get: async () => ({ upgrade: { state: 'squads', pending: [{ index: 4, kind: 'program', status: 'approved', approvedAt: Date.UTC(2026, 10, 7) / 1000, executableAt: Date.UTC(2026, 10, 9) / 1000 }] }, verified: { state: 'pending' } }) }
  const s = await site(w, { logFile: f, trust })
  const items = (await (await s.get('/api/site/log')).json()).items
  assert.equal(items[0].kind, 'upgrade'); assert.equal(items[0].title, 'Upgrade proposed'); assert.equal(items[0].date, '2026-11-07')
  assert.match(items[0].body, /Proposal 4 .*2026-11-09 at 00:00 UTC/); assert.doesNotMatch(items[0].body, /[—–]| - /)
  assert.deepEqual(items.slice(1).map((i) => i.title), ['Site live', 'Contract built'])
  const t = await (await s.get('/api/site/trust')).json(); assert.equal(t.source, null)
  await s.close()
})

test('coin pictures: public hosts only, real image bytes only, misses cached, served with a locked down type', async () => {
  const mint = Keypair.generate().publicKey, T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
  const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)])
  const mintData = (uri) => Buffer.concat([Buffer.alloc(166), u16(19), u16(0), Buffer.alloc(64), str('Coin'), str('CN'), str(uri)])
  const conn = new FakeConn(); conn.set(mint, acct(T22, mintData('https://meta.example.com/c.json')))
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)])
  let hosts = { 'meta.example.com': '93.184.216.34', 'img.example.com': '93.184.216.35' }, body = { 'https://meta.example.com/c.json': JSON.stringify({ image: 'https://img.example.com/c.png' }), 'https://img.example.com/c.png': PNG }
  const fetched = []
  const fetchImpl = async (u) => { fetched.push(u); const b = body[u]; return b == null ? { ok: false, status: 404, headers: new Headers() } : new Response(b, { status: 200 }) }
  const lookup = async (h) => (hosts[h] ? [{ address: hosts[h] }] : [])
  let t = 0
  const img = new CoinImages({ conn, fetchImpl, lookup, now: () => t })
  assert.deepEqual(await img.get(mint.toBase58()), { type: 'image/png', bytes: PNG })
  // a host that resolves to a private address is never contacted
  const m2 = Keypair.generate().publicKey; conn.set(m2, acct(T22, mintData('https://inside.example.com/c.json'))); hosts['inside.example.com'] = '10.0.0.5'
  const n = fetched.length; assert.equal(await img.get(m2.toBase58()), null); assert.equal(fetched.length, n)
  // svg or html bytes are refused even with an image name
  const m3 = Keypair.generate().publicKey; conn.set(m3, acct(T22, mintData('https://meta.example.com/d.json')))
  body['https://meta.example.com/d.json'] = JSON.stringify({ image: 'https://img.example.com/d.png' }); body['https://img.example.com/d.png'] = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'
  assert.equal(await img.get(m3.toBase58()), null)
  const k = fetched.length; await img.get(m3.toBase58()); assert.equal(fetched.length, k, 'miss cached')
  assert.ok(privateIp('127.0.0.1') && privateIp('169.254.1.1') && privateIp('::1') && privateIp('fd00::1') && privateIp('::ffff:192.168.1.1') && !privateIp('8.8.8.8'))
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif'); assert.equal(sniff(Buffer.from('<svg')), null)

  const w = world(), s = await site(w, { images: img })
  const r = await s.get(`/api/site/coinimg/${mint.toBase58()}`)
  assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('content-security-policy'), "default-src 'none'"); assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await s.get(`/api/site/coinimg/${m3.toBase58()}`)).status, 404)
  await s.close()
})

test('holds this bag: the indexer stamps each token balance read, and the listing API returns the time', async () => {
  const w = world(), sl = seller(w), l = listingFixture(w, { sellerKp: sl.kp, tokenAccount: sl.tokenAccount, mint: sl.mint, amount: 1_000_000n })
  await w.app.indexer.rebuild()
  const first = w.db.get('SELECT token_checked_at FROM listings WHERE pubkey=?', l.toBase58()).token_checked_at
  assert.equal(first, w.now(), 'the reconcile read stamped the time')
  const a = await w.app.listings.one(l.toBase58())
  assert.equal(a.fillable, true); assert.equal(a.tokenCheckedAt, first)
  // a later read of the card moves the stamp to that read
  w.clock.skew += 5000
  const b = await w.app.listings.one(l.toBase58())
  assert.equal(b.tokenCheckedAt, w.now()); assert.ok(b.tokenCheckedAt > first)
  const listed = w.app.listings.list({}).items.find((i) => i.pubkey === l.toBase58())
  assert.equal(listed.tokenCheckedAt, b.tokenCheckedAt, 'the board carries it too')
})

test('log: an executed upgrade (deploy slot change) gets a dated entry, the first slot seen is only the start', async () => {
  const w = world()
  let slot = 1000, t = Date.UTC(2026, 10, 8, 12, 30) / 1000
  const trust = { get: async () => ({ checkedAt: t, upgrade: { state: 'key', deploySlot: slot, pending: [] }, verified: { state: 'pending' } }) }
  const s = await site(w, { trust })
  const titles = async () => (await (await s.get('/api/site/log')).json()).items.filter((i) => i.title === 'Upgrade executed')
  assert.deepEqual(await titles(), [], 'nothing to report on the first reading')
  assert.equal(w.db.meta('site_deploy_slot'), '1000')
  slot = 1500
  // the trust route alone is enough to notice it
  await s.get('/api/site/trust')
  let ex = await titles()
  assert.equal(ex.length, 1); assert.equal(ex[0].kind, 'upgrade')
  assert.equal(ex[0].date, new Date().toISOString().slice(0, 10))
  assert.match(ex[0].body, /slot 1,500, replacing the build deployed at slot 1,000\./); assert.doesNotMatch(ex[0].body, /[—–]| - |audited|can.t touch|no admin|OTC|desk/i)
  // the same slot again adds nothing; another upgrade adds a second entry, newest first
  await titles(); assert.equal((await titles()).length, 1)
  slot = 2000; ex = await titles()
  assert.equal(ex.length, 2); assert.match(ex[0].body, /slot 2,000, replacing the build deployed at slot 1,500/)
  await s.close()
  // kept across a restart: a new site on the same database remembers the slot and the entries
  const s2 = await site(w, { trust }), again = (await (await s2.get('/api/site/log')).json()).items.filter((i) => i.title === 'Upgrade executed')
  assert.equal(again.length, 2)
  // a reading with no slot (read failed) changes nothing
  slot = null; await s2.get('/api/site/log'); assert.equal(w.db.meta('site_deploy_slot'), '2000')
  await s2.close()
})

test('Q4: a lagging RPC answering an older deploy slot writes no Upgrade executed entry', async () => {
  const w = world()
  let up = { state: 'key', deploySlot: 1500, pending: [] }
  const trust = { get: async () => ({ checkedAt: 1, upgrade: up, verified: { state: 'pending' } }) }
  const s = await site(w, { trust })
  const titles = async () => (await (await s.get('/api/site/log')).json()).items.filter((i) => i.title === 'Upgrade executed')
  assert.deepEqual(await titles(), [])
  // one node behind: 1000, then the fresh node again with 1500
  up = { ...up, deploySlot: 1000 }; assert.deepEqual(await titles(), [], 'an older slot is not a deploy')
  assert.equal(w.db.meta('site_deploy_slot'), '1500', 'and is not remembered either')
  up = { ...up, deploySlot: 1500 }; assert.deepEqual(await titles(), [], 'back to the known slot: nothing new')
  // a reading kept from before a failed read is not a fresh confirmed read
  up = { ...up, deploySlot: 1800, readAt: 5 }; assert.deepEqual(await titles(), [])
  // only a strictly newer, fresh slot counts, once
  up = { state: 'key', deploySlot: 1800, pending: [] }
  const ex = await titles()
  assert.equal(ex.length, 1); assert.match(ex[0].body, /slot 1,800, replacing the build deployed at slot 1,500/)
  await s.close()
})

test('Q5: Paid at is the block time of the confirmed payout transaction, not when the sender noticed it', async () => {
  const w = world(), db = w.db, wal = Keypair.generate().publicKey.toBase58()
  db.run(`INSERT INTO reward_payouts (hour,slot,place,wallet,lamports,status,sig) VALUES (3600000,'a',1,?,'400000','landed','paysig1')`, wal)
  db.run(`INSERT INTO reward_payouts (hour,slot,place,wallet,lamports,status,sig) VALUES (3600000,'b',2,?,'200000','landed','paysig2')`, wal)
  // the sender noticed paysig1 at 7312 s, but the block that holds it closed at 7290 s
  db.run(`INSERT INTO tx_intents (key,attempt,kind,ref,status,sig,raw,lvbh,created_at,updated_at) VALUES ('reward:3600000:a',1,'reward','3600000:a','landed','paysig1','',0,7300000,7312345)`)
  w.conn.txs.set('paysig1', { keys: [], logs: [], err: null, blockTime: 7290 })
  const s = await site(w)
  const items = (await (await s.get('/api/site/feed?limit=10')).json()).items.filter((i) => i.kind === 'payout')
  const a = items.find((i) => i.sig === 'paysig1'), b = items.find((i) => i.sig === 'paysig2')
  assert.equal(a.paidAt, 7290, 'block time from the chain'); assert.equal(a.at, 7290)
  assert.equal(db.get('SELECT block_time FROM tx_times WHERE sig=?', 'paysig1').block_time, 7290, 'kept, so it is read once')
  assert.equal(b.paidAt, null, 'no block time known: no paid time claimed'); assert.equal(b.at, 7200)
  // a later feed read does not ask the chain again for a known time
  const before = w.conn.counts.txs
  assert.equal(before, 1)
  await s.get('/api/site/feed?limit=10')
  assert.equal(w.conn.counts.txs, before)
  await s.close()
})

test('coin pictures: misses are rate limited per visitor, a page of 50 coins is not, and cached pictures are free', async () => {
  const cached = new Set(), PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)])
  const images = { has: (m) => cached.has(m), get: async (m) => (cached.has(m) ? { type: 'image/png', bytes: PNG } : null) }
  const keep = Keypair.generate().publicKey.toBase58(); cached.add(keep)
  const w = world(), s = await site(w, { images })
  const mints = Array.from({ length: 121 }, () => Keypair.generate().publicKey.toBase58())
  // one page load: 50 new coins at once, none refused
  const page = await Promise.all(mints.slice(0, 50).map((m) => s.get(`/api/site/coinimg/${m}`)))
  assert.deepEqual([...new Set(page.map((r) => r.status))], [404])
  for (const m of mints.slice(50, 120)) assert.equal((await s.get(`/api/site/coinimg/${m}`)).status, 404)
  assert.equal((await s.get(`/api/site/coinimg/${mints[120]}`)).status, 429, 'the 121st miss in a minute is refused')
  assert.equal((await s.get(`/api/site/coinimg/${keep}`)).status, 200, 'a cached picture still loads')
  await s.close()
})

test('Q2: six slow hosts never stall a picture from another host; each host has a cap and a deadline', async () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)])
  const img = new CoinImages({ conn: null, lookup: async () => [{ address: '93.184.216.34' }], hostMs: 300, perHost: 2, parallel: 6, slowAfter: 2 })
  let live = 0, peak = 0
  img.fetch = async (u, { signal }) => {
    if (u.includes('slow.example')) {
      live++; peak = Math.max(peak, live)
      return new Promise((_, no) => signal.addEventListener('abort', () => { live--; no(new Error('aborted')) }))
    }
    return new Response(PNG, { status: 200 })
  }
  const t0 = Date.now()
  const slow = Array.from({ length: 6 }, (_, i) => img.grab(`https://${i % 2 ? 'a' : 'b'}.slow.example/x.png`, 1024))
  const fast = await img.grab('https://fast.example/x.png', 1024)
  assert.ok(fast && sniff(fast) === 'image/png'); assert.ok(Date.now() - t0 < 200, `fast host answered in ${Date.now() - t0} ms`)
  assert.equal(peak, 4, 'at most 2 at once per slow host')
  assert.deepEqual(await Promise.all(slow), Array(6).fill(null), 'each slow fetch ends at its deadline')
  assert.ok(Date.now() - t0 < 1500, `slow ones done in ${Date.now() - t0} ms`)
  // a host that keeps running out of time is skipped for a while: refused at once as busy, not cached as a miss
  await assert.rejects(img.grab('https://a.slow.example/y.png', 1024), new RegExp(BUSY))
  // the RPC read has its own deadline
  const hung = new CoinImages({ conn: { getMultipleAccountsInfo: () => new Promise(() => {}) }, rpcMs: 50 })
  assert.equal(await hung.get(Keypair.generate().publicKey.toBase58()), null)
})

test('Q2: keys that are not mints never push real coins out of the miss cache, and a full line answers 503', async () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)])
  const real = Keypair.generate().publicKey.toBase58()
  let loads = 0
  const img = new CoinImages({ conn: null, max: 5 })
  img.load = async (m) => { loads++; return m === real ? { type: 'image/png', bytes: PNG } : NOMINT }
  assert.ok(await img.get(real)); assert.equal(loads, 1)
  for (let i = 0; i < 50; i++) assert.equal(await img.get(Keypair.generate().publicKey.toBase58()), null)
  assert.ok(img.has(real), 'the real coin is still cached'); await img.get(real); assert.equal(loads, 51, 'and not fetched again')
  // a full line refuses, without caching a miss
  const busy = new CoinImages({ conn: null, parallel: 1, maxQueue: 0 })
  busy.load = async () => { throw new Error(BUSY) }
  const m = Keypair.generate().publicKey.toBase58()
  await assert.rejects(busy.get(m), new RegExp(BUSY)); assert.equal(busy.has(m), false)
  const w = world(), s = await site(w, { images: busy })
  const r = await s.get(`/api/site/coinimg/${m}`)
  assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '5')
  await s.close()
})

// ---- real pages: every path has its own title, share tags, first paint and status
test('routes: every page path, a listing and a coin page, a docs section, old paths and a real 404', async () => {
  const w = world(), sl = seller(w), l = listingFixture(w, { sellerKp: sl.kp, tokenAccount: sl.tokenAccount, mint: sl.mint, amount: 25_000_000n })
  await w.app.indexer.rebuild()
  const s = await site(w), html = (r) => r.text(), get = (p) => fetch(s.base + p, { headers: { accept: 'text/html' } })
  for (const [p, route, title] of [['/', 'home', /Sidebid, live auctions for Solana tokens/], ['/live', 'live', /Live auctions \| Sidebid/], ['/fixed', 'fixed', /Fixed price \| Sidebid/], ['/rewards', 'rewards', /Seller rewards \| Sidebid/], ['/docs', 'docs', /Docs \| Sidebid/], ['/log', 'log', /Change log \| Sidebid/], ['/tx', 'tx', /Every transaction \| Sidebid/], ['/sell', 'sell', /Sell your tokens \| Sidebid/], ['/docs/fee', 'docs/fee', /Docs \| Sidebid/], ['/live/', 'live', /Live auctions/]]) {
    const r = await get(p), h = await html(r)
    assert.equal(r.status, 200, p); assert.match(h, new RegExp(`<body data-route="${route}">`), p)
    assert.match(h, title, p); assert.equal(h.match(/<title>/g).length, 1, p)
    assert.match(h, /<div id="app"><div class="fp">/, `${p} has a first paint`); assert.match(h, /<h1 class="mega sm">/, p)
    assert.match(h, /<link rel="canonical" href="https:\/\/sidebid\.test\//, p)
  }
  // a listing has its own address, title, card and facts in the HTML
  const lr = await get(`/lot/${l.toBase58()}`), lh = await html(lr)
  assert.equal(lr.status, 200); assert.match(lh, new RegExp(`data-route="lot/${l.toBase58()}"`))
  assert.match(lh, /<title>[^<]*25 tokens[^<]*live auction \| Sidebid<\/title>/); assert.match(lh, new RegExp(`og/listing/${l.toBase58()}\\.png`))
  assert.match(lh, new RegExp(`<link rel="canonical" href="https://sidebid.test/lot/${l.toBase58()}">`)); assert.match(lh, new RegExp(sl.mint.toBase58()), 'the full CA is on the lot page')
  // the share link opens the same listing
  assert.match(await html(await get(`/c/${l.toBase58()}`)), new RegExp(`data-route="lot/${l.toBase58()}"`))
  // a coin with listings has a page; a key with none is a 404 that still draws the site
  const cr = await get(`/coin/${sl.mint.toBase58()}`); assert.equal(cr.status, 200); assert.match(await html(cr), new RegExp(`href="/lot/${l.toBase58()}"`))
  const none = await get(`/coin/${Keypair.generate().publicKey.toBase58()}`); assert.equal(none.status, 404); assert.match(await html(none), /data-route="coin\//)
  // anything else is a real 404 page, and the API keeps its own answers
  const nf = await get('/nowhere/at/all'), nh = await html(nf)
  assert.equal(nf.status, 404); assert.match(nh, /Page not found \| Sidebid/); assert.match(nh, /<meta name="robots" content="noindex">/); assert.match(nh, /href="\/live"/)
  assert.equal((await get('/lot/not-a-key')).status, 404)
  assert.match((await fetch(s.base + '/api/nothing')).headers.get('content-type'), /json/)
  await s.close()
})

test('pictures: X avatars through this site only, cached, seeded, with a clean 404 when there is none', async () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)])
  const w = world()
  w.app.auth.upsertUser({ xId: '1', handle: 'Has_Pic', avatar: 'https://pbs.twimg.com/profile_images/1/a_200x200.jpg', xCreatedAt: null, followers: null })
  w.app.auth.upsertUser({ xId: '2', handle: 'no_pic', avatar: null, xCreatedAt: null, followers: null })
  w.app.auth.upsertUser({ xId: '3', handle: 'elsewhere', avatar: 'https://evil.example.com/a.png', xCreatedAt: null, followers: null })
  const asked = []
  const images = new CoinImages({ conn: null, lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async (u) => { asked.push(u); return new Response(PNG, { status: 200 }) } })
  const s = await site(w, { images })
  const a = await s.get('/api/site/xavatar/has_pic')
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'image/png'); assert.equal(a.headers.get('content-security-policy'), "default-src 'none'")
  assert.deepEqual(asked, ['https://pbs.twimg.com/profile_images/1/a_200x200.jpg'])
  await s.get('/api/site/xavatar/HAS_PIC'); assert.equal(asked.length, 1, 'cached, and handles are not case sensitive')
  assert.equal((await s.get('/api/site/xavatar/no_pic')).status, 404)
  assert.equal((await s.get('/api/site/xavatar/elsewhere')).status, 404, 'only X picture hosts are fetched'); assert.equal(asked.length, 1)
  assert.equal((await s.get('/api/site/xavatar/nobody')).status, 404)
  assert.equal((await s.get('/api/site/xavatar/bad..name')).status, 404)
  await s.close()
  // the preview seeds faces and coin icons that answer through the same routes
  const mint = Keypair.generate().publicKey.toBase58()
  const s2 = await site(w, { images: new CoinImages({ conn: null, seed: new Map([[mint, { type: 'image/png', bytes: PNG }]]) }) })
  assert.equal((await s2.get(`/api/site/coinimg/${mint}`)).status, 200)
  await s2.close()
})

test('pictures: a picture that loaded is kept on disk and served after a restart without a fetch', async () => {
  const { DiskPics } = await import('../src/coinimg.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'pics-')), PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)])
  new DiskPics(dir).write('abc', { type: 'image/png', bytes: PNG })
  assert.deepEqual(new DiskPics(dir).read('abc'), { type: 'image/png', bytes: PNG })
  assert.equal(new DiskPics(dir).read('nope'), null)
  new DiskPics(dir).write('../x', { type: 'image/png', bytes: PNG }); assert.equal(new DiskPics(dir).has('../x'), false)
})

test('trust: an all zero authority reads as revoked, with the transaction that set it when the chain has one', async () => {
  const conn = new FakeConn(), pd = programDataPda(PROG)
  conn.set(PROG, programAcct(pd)); conn.set(pd, programData(99, '11111111111111111111111111111111'))
  conn.getSignaturesForAddress = async () => [{ signature: 'bad', err: { x: 1 } }, { signature: 'RevokeSig111', err: null }]
  const t = await new TrustWatch({ conn, programId: PROG, now: () => 1, cluster: 'localnet' }).get()
  assert.equal(t.upgrade.state, 'revoked'); assert.equal(t.upgrade.revokeSig, 'RevokeSig111'); assert.equal(t.upgrade.programData, pd.toBase58())
})
