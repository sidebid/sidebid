// Coin pictures, fetched by the server so a visitor's browser never contacts the host the token creator chose.
// Metadata URI from chain, then its JSON, then the image: https only, public hosts only, size capped, sniffed by bytes.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const cstr = (b, o) => { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0/g, '').trim(), o + 4 + n] }
/** Name, ticker and metadata URI from the Metaplex account bytes, or null. */
export function metaplexMeta(data) { try { const b = Buffer.from(data); const [name, a] = cstr(b, 65); const [symbol, c] = cstr(b, a); return { name, symbol, uri: cstr(b, c)[0] } } catch { return null } }
function t22Meta(data) {
  const b = Buffer.from(data)
  for (let i = 166; i + 4 <= b.length;) {
    const kind = b.readUInt16LE(i), len = b.readUInt16LE(i + 2)
    if (kind === 0) break
    if (kind === 19) { try { const [name, a] = cstr(b, i + 4 + 64); const [symbol, c] = cstr(b, a); return { name, symbol, uri: cstr(b, c)[0] } } catch { return null } }
    i += 4 + len
  }
  return null
}
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
const tidy = (s, n) => String(s ?? '').replace(INVISIBLE, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, n)
export const NOMINT = Symbol('not a mint')
export const toHttps = (u) => { const s = String(u ?? '').trim(); if (/^ipfs:\/\/[\w/.-]+$/.test(s)) return `https://ipfs.io/ipfs/${s.slice(7)}`; return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null }

/** True for loopback, private, link local, CGNAT, multicast and other non public ranges, v4 and v6. */
export function privateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const s = ip.toLowerCase()
  if (s.startsWith('::ffff:')) return privateIp(s.slice(7))
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff')
}
export function sniff(b) {
  if (b.length >= 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** Thrown when too many pictures are already waiting: the route answers 503 and nothing is cached. */
export const BUSY = 'coinimg_busy'
const deadline = (p, ms) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error('timeout')), ms) })]).finally(() => clearTimeout(t)) }

export class CoinImages {
  constructor({ conn, fetchImpl = fetch, lookup = (h) => dnsLookup(h, { all: true }), now = Date.now, ttlMs = 3_600_000, max = 500, parallel = 24, perHost = 6, hostQueue = 64, maxQueue = 128, hostMs = 5000, rpcMs = 3000, slowAfter = 3, slowMs = 60_000, dir = null, seed = null }) {
    this.conn = conn; this.fetch = fetchImpl; this.lookup = lookup; this.now = now; this.ttl = ttlMs; this.max = max; this.cache = new Map(); this.inflight = new Map()
    // Pictures that loaded are also kept on disk, so a restart never asks a slow host again. A seed (the preview's own test
    // coins) answers before any of that.
    this.disk = dir ? new DiskPics(dir) : null; this.seed = seed ?? new Map()
    // Name and ticker from the same metadata read, for page titles and the first paint
    this.infos = new Map()
    // Keys that are not a mint on chain live in their own cache, so a flood of random keys never pushes out real coins
    this.nomint = new Map()
    this.parallel = parallel; this.running = 0; this.queue = []; this.maxQueue = maxQueue
    this.perHost = perHost; this.hostQueue = hostQueue; this.hosts = new Map(); this.hostMs = hostMs; this.rpcMs = rpcMs; this.slowAfter = slowAfter; this.slowMs = slowMs; this.slow = new Map()
  }
  /** True when a request for this mint costs no outbound fetch: a fresh answer is cached or one is already on its way. */
  has(mint) {
    if (this.seed.has(mint) || this.disk?.has(mint)) return true
    const hit = this.cache.get(mint) ?? this.nomint.get(mint)
    return (!!hit && this.now() - hit.at < this.ttl) || this.inflight.has(mint)
  }
  /** At most `parallel` outbound fetches at once. The rest wait their turn, so a page of 50 new coins still loads. */
  async slot(fn) {
    // A finished fetch hands its place straight to the next in line, so the count never goes past the cap
    if (this.running >= this.parallel) { if (this.queue.length >= this.maxQueue) throw new Error(BUSY); await new Promise((ok) => this.queue.push(ok)) } else this.running++
    try { return await fn() } finally { const next = this.queue.shift(); if (next) next(); else this.running-- }
  }
  /**
   * At most `perHost` fetches to one host at once, each with one deadline that covers DNS and every hop. A coin waiting on a
   * busy host holds no shared place, so a slow host only ever slows its own coins. A host that runs out of time a few times
   * in a row is skipped for a minute. A refusal for lack of room is BUSY, never a cached miss, so the coin is asked again later.
   */
  async hostSlot(host, fn) {
    const sl = this.slow.get(host)
    if (sl && sl.n >= this.slowAfter && this.now() - sl.at < this.slowMs) throw new Error(BUSY)
    let h = this.hosts.get(host)
    if (!h) this.hosts.set(host, (h = { running: 0, queue: [] }))
    if (h.running >= this.perHost) { if (h.queue.length >= this.hostQueue) throw new Error(BUSY); await new Promise((ok) => h.queue.push(ok)) } else h.running++
    try {
      return await this.slot(async () => {
        const ac = new AbortController()
        try { const v = await deadline(fn(ac.signal), this.hostMs); this.slow.delete(host); return v } catch (e) {
          if (e?.message !== 'timeout') return null
          ac.abort()
          const n = (this.slow.get(host)?.n ?? 0) + 1
          this.slow.delete(host); this.slow.set(host, { n, at: this.now() })
          while (this.slow.size > this.max) this.slow.delete(this.slow.keys().next().value)
          return null
        }
      })
    } finally {
      const next = h.queue.shift()
      if (next) next(); else if (--h.running === 0) this.hosts.delete(host)
    }
  }
  /** Bytes from a public https host, following at most two redirects on the same host. Null on any refusal. */
  async grab(url, cap) {
    let u
    try { u = new URL(url) } catch { return null }
    return this.hostSlot(u.hostname, (signal) => this.#grab(u, cap, signal))
  }
  async #grab(u, cap, signal) {
    const host = u.hostname
    for (let hop = 0; hop < 3; hop++) {
      if (u.protocol !== 'https:' || u.hostname !== host || u.username || u.password) return null
      const h = u.hostname.replace(/^\[|\]$/g, '')
      const addrs = isIP(h) ? [{ address: h }] : await this.lookup(h).catch(() => [])
      if (signal.aborted || !addrs.length || addrs.some((a) => privateIp(a.address))) return null
      const r = await this.fetch(u.toString(), { redirect: 'manual', signal, headers: { accept: '*/*' } }).catch(() => null)
      if (!r) return null
      if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (!loc) return null; try { u = new URL(loc, u) } catch { return null } continue }
      if (!r.ok) return null
      if (Number(r.headers.get('content-length') ?? 0) > cap) return null
      const chunks = []; let n = 0
      if (r.body?.getReader) {
        const rd = r.body.getReader()
        for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > cap) { rd.cancel().catch(() => {}); return null } chunks.push(Buffer.from(value)) }
        return Buffer.concat(chunks)
      }
      const b = Buffer.from(await r.arrayBuffer()); return b.length > cap ? null : b
    }
    return null
  }
  /** The metadata URI, null when the coin has none, or the NOMINT marker when the key is not an account on chain. */
  async uri(mint) {
    const m = new PublicKey(mint)
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), m.toBuffer()], METAPLEX)
    const [mi, md] = await deadline(this.conn.getMultipleAccountsInfo([m, pda], 'confirmed'), this.rpcMs)
    if (!mi) return NOMINT
    const meta = (md && md.owner.equals(METAPLEX) ? metaplexMeta(md.data) : null) ?? (mi.owner.toBase58() === T22 ? t22Meta(mi.data) : null)
    if (meta) this.note(mint, meta)
    return meta?.uri ?? null
  }
  note(mint, meta) {
    this.infos.delete(mint); this.infos.set(mint, { name: tidy(meta.name, 40) || null, symbol: tidy(meta.symbol, 12).replace(/^\$/, '') || null })
    while (this.infos.size > this.max * 4) this.infos.delete(this.infos.keys().next().value)
  }
  /** Name and ticker if a picture read has seen them, else null. Never reads the chain itself. */
  info(mint) { return this.infos.get(mint) ?? null }
  async load(mint) {
    const u = await this.uri(mint)
    if (u === NOMINT) return NOMINT
    const meta = toHttps(u)
    if (!meta) return null
    const raw = await this.grab(meta, 256 * 1024)
    let j = null
    try { j = raw ? JSON.parse(raw.toString('utf8')) : null } catch {}
    const img = toHttps(j?.image)
    if (!img) return null
    const bytes = await this.grab(img, 1024 * 1024)
    const type = bytes && sniff(bytes)
    return type ? { type, bytes } : null
  }
  /** { type, bytes } or null. Misses are cached too, so a dead host is asked once an hour. Rejects with BUSY when the line is full. */
  async get(mint) {
    const seeded = this.seed.get(mint)
    if (seeded) return seeded
    const kept = this.disk?.read(mint)
    if (kept) return kept
    const hit = this.cache.get(mint) ?? this.nomint.get(mint)
    if (hit && this.now() - hit.at < this.ttl) return hit.v
    if (this.inflight.has(mint)) return this.inflight.get(mint)
    const p = this.load(mint).catch((e) => (e?.message === BUSY ? BUSY : null)).then((v) => {
      if (v === BUSY) throw new Error(BUSY)
      const store = v === NOMINT ? this.nomint : this.cache, val = v === NOMINT ? null : v
      store.delete(mint); store.set(mint, { at: this.now(), v: val })
      if (val) this.disk?.write(mint, val)
      while (store.size > this.max) store.delete(store.keys().next().value)
      return val
    }).finally(() => this.inflight.delete(mint))
    this.inflight.set(mint, p)
    return p
  }
}

/** Pictures on disk: one file per key, its media type in the name. Written once, read on every restart. */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]))
export class DiskPics {
  constructor(dir) { this.dir = dir; this.names = new Map(); try { mkdirSync(dir, { recursive: true }); for (const f of readdirSync(dir)) { const m = /^([\w-]+)\.(png|jpg|gif|webp)$/.exec(f); if (m) this.names.set(m[1], f) } } catch { this.dir = null } }
  has(key) { return this.names.has(key) }
  read(key) {
    const f = this.names.get(key)
    if (!f || !this.dir) return null
    try { const bytes = readFileSync(join(this.dir, f)), type = sniff(bytes); return type ? { type, bytes } : null } catch { return null }
  }
  write(key, { type, bytes }) {
    if (!this.dir || !EXT[type] || !/^[\w-]{1,64}$/.test(key)) return
    const f = `${key}.${EXT[type]}`
    try { writeFileSync(join(this.dir, f), bytes); this.names.set(key, f) } catch {}
  }
}

/** True for an X profile picture address, the only host avatars are fetched from. */
export const xPicture = (u) => /^https:\/\/pbs\.twimg\.com\/[\w./-]+$/.test(String(u ?? ''))

/**
 * X profile pictures, fetched by the server and kept like coin pictures, so a page never loads anything from X itself.
 * `find(handle)` names the stored profile_image_url; only pbs.twimg.com is ever fetched. A seed answers first (the preview).
 */
export class XAvatars {
  constructor({ images, find, now = Date.now, ttlMs = 6 * 3_600_000, max = 1000, dir = null, seed = null }) {
    this.images = images; this.find = find; this.now = now; this.ttl = ttlMs; this.max = max; this.cache = new Map(); this.inflight = new Map()
    this.disk = dir ? new DiskPics(dir) : null; this.seed = seed ?? new Map()
  }
  key(handle) { return String(handle ?? '').toLowerCase() }
  has(handle) { const k = this.key(handle), hit = this.cache.get(k); return this.seed.has(k) || !!this.disk?.has(k) || (!!hit && this.now() - hit.at < this.ttl) || this.inflight.has(k) }
  async get(handle) {
    const k = this.key(handle)
    if (!/^[a-z0-9_]{1,15}$/.test(k)) return null
    const seeded = this.seed.get(k)
    if (seeded) return seeded
    const url = this.find(k)
    if (!xPicture(url)) return null
    // On disk under the handle and the picture's own address, so a new profile picture is fetched fresh
    const dk = `${k}-${createHash('sha256').update(url).digest('hex').slice(0, 10)}`, kept = this.disk?.read(dk)
    if (kept) return kept
    const hit = this.cache.get(k)
    if (hit && this.now() - hit.at < this.ttl) return hit.v
    if (this.inflight.has(k)) return this.inflight.get(k)
    const p = this.images.grab(url, 512 * 1024).catch((e) => (e?.message === BUSY ? BUSY : null)).then((bytes) => {
      if (bytes === BUSY) throw new Error(BUSY)
      const type = bytes && sniff(bytes), v = type ? { type, bytes } : null
      this.cache.delete(k); this.cache.set(k, { at: this.now(), v })
      while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value)
      if (v) this.disk?.write(dk, v)
      return v
    }).finally(() => this.inflight.delete(k))
    this.inflight.set(k, p)
    return p
  }
}
