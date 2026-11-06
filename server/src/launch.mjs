// Launch day additions around the site: the plain pages (legal.mjs), the record of the pre-launch mainnet test, and three
// admin routes for the day itself: the T-10 facts tools/check.mjs reads, the CA reveal, and the test record's list.
// It wraps the site handler and passes everything else through unchanged. Nothing here signs or sends a transaction.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { timingSafeEqual, createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { Limiter, clientAddress, ipKey } from './http.mjs'
import { siteConfigReader } from './site.mjs'
import { legalPages } from './legal.mjs'

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const TEST_LABELS = ['Listing', 'Bid', 'Outbid refund', 'Settle', 'Fixed buy', 'Accept', 'Refund', 'Cancel', 'Payout', 'Fee claim']
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])
const KEY = 'launch_test', SEEN = 'launch_test_seen', MAX_ITEMS = 50
const sameSecret = (a, b) => { const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y) }
const isSig = (s) => { try { return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s) && bs58.decode(s).length === 64 } catch { return false } }
const isKey = (s) => { try { return typeof s === 'string' && new PublicKey(s).toBase58() === s } catch { return false } }
const cleanText = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max) : '')

/**
 * The pre-launch mainnet test, shown on the site: a list of transaction signatures with a label each, kept in the database,
 * and each one's status and block time read from chain. A finalized answer is kept for good; anything else is read again,
 * at most every 15 seconds for everyone together.
 */
export class LaunchTest {
  constructor({ db, rpc, now = Date.now, refreshMs = 15_000 }) { Object.assign(this, { db, rpc, now, refreshMs }); this.cache = null; this.reading = null }
  list() { try { const r = JSON.parse(this.db.meta(KEY) ?? '[]'); return Array.isArray(r) ? r : [] } catch { return [] } }
  seen() { try { const r = JSON.parse(this.db.meta(SEEN) ?? '{}'); return r && typeof r === 'object' ? r : {} } catch { return {} } }
  /** One row as stored, or an error name. Labels are free text up to 40 characters; TEST_LABELS are the usual ones. */
  static clean(it) {
    if (!it || typeof it !== 'object') return { error: 'bad_item' }
    if (!isSig(it.sig)) return { error: 'bad_signature' }
    const label = cleanText(it.label, 40)
    if (!label) return { error: 'bad_label' }
    const note = cleanText(it.note, 140)
    return { sig: it.sig, label, ...(note ? { note } : {}) }
  }
  /** { items } replaces the list, { add } appends one (or updates its label), { remove: sig } drops one. */
  change(body) {
    let next = this.list()
    if (Array.isArray(body?.items)) {
      next = []
      for (const it of body.items) { const c = LaunchTest.clean(it); if (c.error) return c; if (!next.some((x) => x.sig === c.sig)) next.push(c) }
    } else if (body?.add) {
      const c = LaunchTest.clean(body.add); if (c.error) return c
      const i = next.findIndex((x) => x.sig === c.sig)
      if (i >= 0) next[i] = c; else next.push(c)
    } else if (typeof body?.remove === 'string') next = next.filter((x) => x.sig !== body.remove)
    else return { error: 'nothing_to_do' }
    if (next.length > MAX_ITEMS) return { error: 'too_many' }
    this.db.setMeta(KEY, JSON.stringify(next))
    this.cache = null
    return { items: next }
  }
  async read(list) {
    const seen = this.seen(), todo = list.filter((x) => !seen[x.sig]).map((x) => x.sig), fresh = {}
    if (todo.length) {
      let st = null
      try { st = await this.rpc.statuses(todo) } catch { st = null }
      for (let i = 0; i < todo.length; i++) {
        const s = st ? st[i] : undefined
        if (st === null) { fresh[todo[i]] = { status: 'unknown' }; continue }
        if (!s) { fresh[todo[i]] = { status: 'not_found' }; continue }
        const err = s.err ? JSON.stringify(s.err).slice(0, 200) : null
        let blockTime = null
        try { const t = await this.rpc.blockTime(s.slot); blockTime = Number.isSafeInteger(t) && t > 0 ? t : null } catch {}
        const row = { status: err ? 'failed' : s.confirmationStatus ?? 'processed', err, slot: s.slot ?? null, blockTime }
        // Final and complete: kept, never asked again
        if (s.confirmationStatus === 'finalized' && blockTime) seen[todo[i]] = row
        else fresh[todo[i]] = row
      }
      this.db.setMeta(SEEN, JSON.stringify(Object.fromEntries(Object.entries(seen).filter(([k]) => list.some((x) => x.sig === k)))))
    }
    return list.map((x) => ({ ...x, ...(seen[x.sig] ?? fresh[x.sig] ?? { status: 'unknown' }) }))
  }
  /** The public answer: every row with its status, slot, block time and explorer link. */
  async view(explorer = 'https://solscan.io') {
    const list = this.list(), key = JSON.stringify(list)
    if (this.cache && this.cache.key === key && this.now() - this.cache.at < this.refreshMs) return this.cache.body
    if (!this.reading) {
      this.reading = this.read(list).then((items) => {
        const body = { items: items.map((x) => ({ sig: x.sig, label: x.label, note: x.note ?? null, status: x.status, err: x.err ?? null, slot: x.slot ?? null, blockTime: x.blockTime ?? null, url: `${explorer}/tx/${x.sig}` })), checkedAt: Math.floor(this.now() / 1000) }
        this.cache = { key, at: this.now(), body }
        return body
      }).finally(() => { this.reading = null })
    }
    return this.reading
  }
}

/** Writes brand.reveal, brand.ca and brand.xHandle into site.json, keeping every other field. */
export function writeReveal({ config, env = process.env, reveal, ca, xHandle }) {
  const file = env.SITE_CONFIG || join(config.dataDir, 'site.json')
  let cur = {}
  if (existsSync(file)) cur = JSON.parse(readFileSync(file, 'utf8'))
  else if (env.SITE_CONFIG_JSON) { try { cur = JSON.parse(env.SITE_CONFIG_JSON) } catch { cur = {} } }
  const brand = { ...(cur.brand ?? {}), reveal: !!reveal }
  if (ca !== undefined) brand.ca = ca
  if (xHandle !== undefined) brand.xHandle = xHandle
  const next = { ...cur, brand }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n'); renameSync(`${file}.tmp`, file)
  return { reveal: brand.reveal, ca: brand.ca ?? null, xHandle: brand.xHandle ?? null }
}

/** What the T-10 check needs to know about this process. No secret, only public keys and settings. */
export async function launchFacts({ app, config, env = process.env }) {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH || null
  const dataDir = resolve(config.dataDir)
  let onVolume = null
  if (mount) { const rel = relative(resolve(mount), dataDir); onVolume = !rel.startsWith('..') && !isAbsolute(rel) }
  let genesisHash = null
  try { genesisHash = await app.rpc.call('getGenesisHash', (c) => c.getGenesisHash()) } catch {}
  const n = (sql) => { try { return app.db.get(sql).n } catch { return null } }
  const pk = (k) => k?.publicKey?.toBase58() ?? null
  return {
    production: !!config.production, previewChain: env.PREVIEW_CHAIN === '1', nodeEnv: env.NODE_ENV ?? null,
    dataDir, volume: mount, onVolume, programId: config.programId.toBase58(), publicUrl: config.publicUrl, genesisHash,
    keys: { keeper: pk(config.keeperKey), listing: pk(config.listingKey), pass: pk(config.passKey), dev: pk(config.devKey) },
    x: { dailyCapUsd: config.x.dailyCapUsd, signinCapUsd: config.x.signinCapUsd, readShare: config.x.readShare, replyLinks: !!config.x.replyLinks, costPerPostUsd: config.x.costPerPostUsd, costPerPostLinkUsd: config.x.costPerPostLinkUsd },
    rewardsTeamWallet: config.rewards?.teamWallet ?? null,
    counts: { listings: n('SELECT COUNT(*) n FROM listings'), sales: n('SELECT COUNT(*) n FROM sales'), events: n('SELECT COUNT(*) n FROM events_seen'), users: n('SELECT COUNT(*) n FROM x_users'), tagCards: n('SELECT COUNT(*) n FROM tag_cards') },
  }
}

export function withLaunch(site, app, config, { dist = process.env.WEB_DIST || resolve(new URL('../../web/dist', import.meta.url).pathname), env = process.env, now = Date.now, launchTest = null } = {}) {
  const siteConfig = siteConfigReader({ config, env })
  const pages = legalPages({ config, dist: resolve(dist), brand: () => siteConfig({}).brand })
  const rpc = app.rpc
  const test = launchTest ?? new LaunchTest({ db: app.db, rpc: { statuses: (s) => rpc.statuses(s), blockTime: (slot) => rpc.call('getBlockTime', (c) => c.getBlockTime(slot)) }, now })
  const limiter = new Limiter(now)
  const ip = (req) => ipKey(clientAddress(req.headers, req.socket.remoteAddress, config.trustedHops))
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }); res.end(JSON.stringify(body)) }
  const readBody = (req) => new Promise((ok, no) => {
    let n = 0; const parts = []
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { no(Object.assign(new Error('too big'), { code: 413 })); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { const j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); ok(j && typeof j === 'object' && !Array.isArray(j) ? j : {}) } catch { no(Object.assign(new Error('bad json'), { code: 400 })) } })
    req.on('error', no)
  })
  const MINE = new Set(['/api/admin/launch-test', '/api/admin/launch-check', '/api/admin/reveal', '/api/admin/drops', '/api/admin/drops/start'])

  return async (req, res) => {
    try {
      const p = new URL(req.url, 'http://x').pathname
      if (pages(req, res, p)) return
      if (p === '/api/site/launch-test' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!limiter.allow(`lt:${ip(req)}`, 60, 60_000)) return json(res, 429, { error: 'slow_down' })
        return json(res, 200, await test.view(siteConfig({}).chain.explorer))
      }
      // The dev drops: plan, outcomes and the X post of each, public (nothing secret in it)
      if (p === '/api/site/drops' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!limiter.allow(`dr:${ip(req)}`, 120, 60_000)) return json(res, 429, { error: 'slow_down' })
        return json(res, 200, app.drops ? app.drops.publicView() : { plan: null, drops: [] })
      }
      if (MINE.has(p)) {
        if (!config.adminSecret || !sameSecret(req.headers['x-admin-secret'] ?? '', config.adminSecret)) { if (!limiter.allow('bad-admin', 60, 3_600_000)) return json(res, 429, { error: 'slow_down' }); return json(res, 403, { error: 'no' }) }
        if (p === '/api/admin/launch-check' && req.method === 'GET') return json(res, 200, await launchFacts({ app, config, env }))
        if (p === '/api/admin/launch-test' && req.method === 'GET') return json(res, 200, { items: test.list(), labels: TEST_LABELS })
        if (p === '/api/admin/drops' && req.method === 'GET') return json(res, 200, app.drops.status())
        if (req.method !== 'POST') return json(res, 404, { error: 'not_found' })
        const b = await readBody(req)
        if (p === '/api/admin/launch-test') { const r = test.change(b); return json(res, r.error ? 400 : 200, r) }
        // Starts the drop clock. The mint is the revealed CA, never a value from the request.
        if (p === '/api/admin/drops/start') {
          const brand = siteConfig({}).brand
          if (!brand.reveal || !brand.ca) return json(res, 400, { error: 'not_revealed' })
          const r = await app.drops.start({ firstAt: b.firstAt, ca: brand.ca, replace: b.replace === true })
          return json(res, r.error ? (r.error === 'chain_read_failed' ? 503 : 400) : 200, r)
        }
        if (p === '/api/admin/drops') return json(res, 404, { error: 'not_found' })
        // The reveal: the CA must be a token mint on this chain, so a typo can never go on the site
        if (b.reveal === false) return json(res, 200, writeReveal({ config, env, reveal: false }))
        if (!isKey(b.ca)) return json(res, 400, { error: 'bad_address' })
        if (b.xHandle !== undefined && !/^[A-Za-z0-9_]{1,15}$/.test(String(b.xHandle).replace(/^@/, ''))) return json(res, 400, { error: 'bad_handle' })
        let acct
        try { acct = await rpc.account(new PublicKey(b.ca)) } catch { return json(res, 503, { error: 'chain_read_failed' }) }
        if (!acct || !TOKEN_PROGRAMS.has(acct.owner.toBase58()) || acct.data.length < 82) return json(res, 400, { error: 'not_a_mint' })
        return json(res, 200, writeReveal({ config, env, reveal: true, ca: b.ca, ...(b.xHandle !== undefined ? { xHandle: String(b.xHandle).replace(/^@/, '') } : {}) }))
      }
      return site(req, res)
    } catch (e) {
      if (!res.headersSent) json(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code === 413 ? 'too_big' : e.code === 400 ? 'bad_json' : 'server_error' }); else res.end()
    }
  }
}
