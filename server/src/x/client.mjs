// X API v2. Reading uses a read only app bearer. Posting uses the coin account's own OAuth 1.0a token.
// Every paid call reserves its worst case against the daily cap first. Past the cap, or out of credits, calls refuse
// without touching X, and nothing else on the site depends on them.
import { createHmac, randomBytes } from 'node:crypto'
import { HARD_X_SPEND_CEILING_USD } from '../config.mjs'

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const API = 'https://api.x.com/2'
const FIELDS = { expansions: 'author_id', 'tweet.fields': 'created_at,referenced_tweets,author_id,note_tweet', 'user.fields': 'created_at,public_metrics,username,profile_image_url' }
const micro = (usd) => Math.ceil(usd * 1e6)

export class XError extends Error { constructor(kind, message, extra = {}) { super(message); this.name = 'XError'; this.kind = kind; Object.assign(this, extra) } }

/**
 * The day's X bill, in one table. The daily cap is the whole bill. Sign ins have their own allowance inside it, kept for them
 * alone; mention reads, replies and reply checks share the rest, reads up to their share. A cap of 0 refuses everything.
 */
export class Spend {
  constructor({ db, capUsd, readShare = 1, readHourlyUsd = Infinity, signinUsd = 0, now = Date.now }) {
    this.db = db; this.capMicro = micro(Math.min(capUsd, HARD_X_SPEND_CEILING_USD))
    this.signinCapMicro = Math.min(micro(Math.max(signinUsd, 0)), this.capMicro)
    this.otherCapMicro = this.capMicro - this.signinCapMicro
    this.readCapMicro = Math.floor(this.otherCapMicro * readShare); this.readHourMicro = Number.isFinite(readHourlyUsd) ? micro(readHourlyUsd) : Infinity; this.now = now
  }
  hour() { return new Date(this.now()).toISOString().slice(0, 13) }
  readHourSpent() { return this.db.get('SELECT read_micro FROM spend_hour WHERE hour=?', this.hour())?.read_micro ?? 0 }
  day() { return new Date(this.now()).toISOString().slice(0, 10) }
  spent() { return this.db.get('SELECT micro_usd FROM spend WHERE day=?', this.day())?.micro_usd ?? 0 }
  readSpent() { return this.db.get('SELECT read_micro FROM spend WHERE day=?', this.day())?.read_micro ?? 0 }
  signinSpent() { return this.db.get('SELECT signin_micro FROM spend WHERE day=?', this.day())?.signin_micro ?? 0 }
  /** True when one more sign in fits today, without reserving it. A zero price never fits: a free call is not on X's list. */
  signinRoom(usd) { const m = micro(usd); return m > 0 && this.signinSpent() + m <= this.signinCapMicro && this.spent() + m <= this.capMicro }
  /**
   * All or nothing, in one database step. Mention reads stop at their share, so junk posts can't use up what replies need,
   * and nothing but a sign in can touch the sign in allowance.
   */
  reserve(usd, { read = false, signin = false } = {}) {
    const m = micro(usd), day = this.day(), r = read ? m : 0, si = signin ? m : 0
    return this.db.tx(() => {
      if (this.spent() + m > this.capMicro) return false
      if (signin) { if (m <= 0 || this.signinSpent() + m > this.signinCapMicro) return false }
      else if (this.spent() - this.signinSpent() + m > this.otherCapMicro) return false
      if (read && this.readSpent() + m > this.readCapMicro) return false
      if (read && this.readHourSpent() + m > this.readHourMicro) return false
      if (read) this.db.run('INSERT INTO spend_hour (hour,read_micro) VALUES (?,?) ON CONFLICT(hour) DO UPDATE SET read_micro=read_micro+excluded.read_micro', this.hour(), m)
      this.db.run('INSERT INTO spend (day,micro_usd,read_micro,signin_micro) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET micro_usd=micro_usd+excluded.micro_usd, read_micro=read_micro+excluded.read_micro, signin_micro=signin_micro+excluded.signin_micro', day, m, r, si)
      return true
    })
  }
  release(usd, { read = false, signin = false } = {}) {
    const m = micro(usd)
    if (m <= 0) return
    this.db.run('UPDATE spend SET micro_usd=MAX(0,micro_usd-?), read_micro=MAX(0,read_micro-?), signin_micro=MAX(0,signin_micro-?) WHERE day=?', m, read ? m : 0, signin ? m : 0, this.day())
    if (read) this.db.run('UPDATE spend_hour SET read_micro=MAX(0,read_micro-?) WHERE hour=?', m, this.hour())
  }
  status() { return { day: this.day(), spentUsd: this.spent() / 1e6, capUsd: this.capMicro / 1e6, readSpentUsd: this.readSpent() / 1e6, readCapUsd: this.readCapMicro / 1e6, readHourSpentUsd: this.readHourSpent() / 1e6, readHourCapUsd: this.readHourMicro / 1e6, signinSpentUsd: this.signinSpent() / 1e6, signinCapUsd: this.signinCapMicro / 1e6 } }
}

/** Any link or domain in a post's text: X bills it at the "with URL" price, and may turn a bare domain into a link. */
export const hasLink = (text) => /https?:\/\/|www\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]{1,62}\b/i.test(String(text ?? ''))

export class XClient {
  constructor({ config, db, fetchImpl = (...a) => fetch(...a), now = Date.now }) {
    Object.assign(this, { cfg: config.x, db, fetchImpl, now })
    this.spend = new Spend({ db, capUsd: this.cfg.dailyCapUsd, readShare: this.cfg.readShare, readHourlyUsd: this.cfg.readHourlyUsd ?? Infinity, signinUsd: this.cfg.signinCapUsd ?? 0, now })
  }
  canRead() { return !!(this.cfg.readBearer && this.cfg.accountId) }
  canPost() { return !!(this.cfg.postApiKey && this.cfg.postApiSecret && this.cfg.postToken && this.cfg.postTokenSecret) }
  creditsOutUntil() { return Number(this.db.meta('x_credits_out_until') ?? 0) }
  available() { return this.now() >= this.creditsOutUntil() }

  oauth1(method, url) {
    const o = { oauth_consumer_key: this.cfg.postApiKey, oauth_nonce: randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(this.now() / 1000)), oauth_token: this.cfg.postToken, oauth_version: '1.0' }
    const u = new URL(url), plain = `${u.origin}${u.pathname}`
    const params = [...Object.entries(o), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    const base = [method, enc(plain), enc(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&')
    o.oauth_signature = createHmac('sha1', `${enc(this.cfg.postApiSecret)}&${enc(this.cfg.postTokenSecret)}`).update(base).digest('base64')
    return `OAuth ${Object.entries(o).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ')}`
  }
  async call(method, url, { headers, body } = {}) {
    let r
    try { r = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(15_000) }) } catch (e) { throw new XError('network', `X ${e.message}`) }
    const j = await r.json().catch(() => ({}))
    if (r.ok) return j
    const said = JSON.stringify(j).slice(0, 300)
    const out = r.status === 402 || /credit|billing|usagecap|usage.cap|payment/i.test(said)
    if (out) {
      this.db.setMeta('x_credits_out_until', this.now() + this.cfg.creditsPauseMs)
      throw new XError('credits', `X credits: ${r.status}`)
    }
    if (r.status === 429) throw new XError('rate', 'X rate limit', { retryAt: Number(r.headers?.get?.('x-rate-limit-reset') || 0) * 1000 })
    if (/duplicate/i.test(said)) throw new XError('duplicate', 'X says duplicate')
    if (r.status >= 500) throw new XError('server', `X ${r.status}`)
    throw new XError('refused', `X ${r.status}: ${said.slice(0, 120)}`)
  }
  assertUsable() { if (!this.available()) throw new XError('credits', 'X credits out, waiting') }

  /** New mentions since the cursor, oldest first. Each page's worst case is reserved, and what X didn't return is given back. */
  async mentions(sinceId, { maxResults = this.cfg.pageSize ?? 20, maxPages = this.cfg.maxPages ?? 3 } = {}) {
    if (!this.canRead()) throw new XError('config', 'read credentials not set')
    this.assertUsable()
    const base = { max_results: String(maxResults), ...FIELDS }
    if (sinceId) base.since_id = sinceId
    const posts = [], users = new Map()
    // X bills each mention as an owned read and each author it expands as a user read. Worst case: a full page, every author new.
    const perPost = this.cfg.costPerOwnedReadUsd ?? this.cfg.costPerReadUsd, perUser = this.cfg.costPerUserUsd ?? this.cfg.costPerReadUsd
    const worst = (perPost + perUser) * maxResults
    let token = null
    for (let page = 0; page < maxPages; page++) {
      if (!this.spend.reserve(worst, { read: true })) { if (page === 0) throw new XError('cap', 'daily X spend cap reached'); break }
      let r
      try {
        const murl = `${API}/users/${this.cfg.accountId}/mentions?${new URLSearchParams(token ? { ...base, pagination_token: token } : base)}`
        r = await this.call('GET', murl, { headers: { authorization: this.cfg.readAsUser && this.canPost() ? this.oauth1('GET', murl) : `Bearer ${this.cfg.readBearer}` } })
      } catch (e) {
        this.spend.release(worst, { read: true })
        if (page === 0) throw e
        break
      }
      const billed = (r.data?.length ?? 0) + (r.includes?.users?.length ?? 0)
      this.spend.release(Math.max(0, worst - (r.data?.length ?? 0) * perPost - (r.includes?.users?.length ?? 0) * perUser), { read: true })
      this.db.run('UPDATE spend SET reads=reads+? WHERE day=?', billed, this.spend.day())
      posts.push(...(r.data ?? []))
      for (const u of r.includes?.users ?? []) users.set(u.id, u)
      token = r.meta?.next_token
      if (!token || !sinceId) break // on first start only the newest id matters
    }
    posts.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    return posts.map((t) => toMention(t, users))
  }
  postCost(text) { return hasLink(text) ? (this.cfg.costPerPostLinkUsd ?? 0.2) : this.cfg.costPerPostUsd }
  /** Sends one reply. Refused without calling X when the cap or the credits say no. */
  async reply(toId, text) {
    if (!this.canPost()) throw new XError('config', 'post credentials not set')
    this.assertUsable()
    // Priced from the words actually sent, so a link or a domain can never slip through at the plain post price
    const cost = this.postCost(text)
    if (!this.spend.reserve(cost)) throw new XError('cap', 'daily X spend cap reached')
    const url = `${API}/tweets`
    try {
      const r = await this.call('POST', url, { headers: { authorization: this.oauth1('POST', url), 'content-type': 'application/json' }, body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: toId } }) })
      this.db.run('UPDATE spend SET posts=posts+1 WHERE day=?', this.spend.day())
      return r.data?.id ?? null
    } catch (e) {
      if (e.kind === 'credits' || e.kind === 'rate' || e.kind === 'refused') this.spend.release(cost)
      throw e
    }
  }
  /**
   * A post of our own (not a reply), for the dev drops. With a PNG and media on, the picture is uploaded first; an upload that
   * fails for any reason but credits leaves the post as text only. Returns { id, media }.
   */
  async post(text, { png = null } = {}) {
    if (!this.canPost()) throw new XError('config', 'post credentials not set')
    this.assertUsable()
    let mediaId = null
    if (png && this.cfg.dropPostMedia) {
      try { mediaId = await this.uploadPng(png) } catch (e) { if (e.kind === 'credits') throw e; mediaId = null }
    }
    const cost = this.postCost(text)
    if (!this.spend.reserve(cost)) throw new XError('cap', 'daily X spend cap reached')
    const url = `${API}/tweets`
    try {
      const r = await this.call('POST', url, { headers: { authorization: this.oauth1('POST', url), 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }) })
      this.db.run('UPDATE spend SET posts=posts+1 WHERE day=?', this.spend.day())
      return { id: r.data?.id ?? null, media: !!mediaId }
    } catch (e) {
      if (e.kind === 'credits' || e.kind === 'rate' || e.kind === 'refused') this.spend.release(cost)
      throw e
    }
  }
  /** v2 media upload, multipart, OAuth 1.0a (the body is not part of the signature for multipart). Returns the media id. */
  async uploadPng(buf) {
    const cost = this.cfg.costPerMediaUsd ?? 0.015
    if (!this.spend.reserve(cost)) throw new XError('cap', 'daily X spend cap reached')
    const url = `${API}/media/upload`
    const form = new FormData()
    form.append('media', new Blob([buf], { type: 'image/png' }), 'drop.png')
    form.append('media_category', 'tweet_image'); form.append('media_type', 'image/png')
    try {
      const r = await this.call('POST', url, { headers: { authorization: this.oauth1('POST', url) }, body: form })
      const id = r.data?.id ?? r.media_id_string ?? null
      if (!id) throw new XError('refused', 'X media upload gave no id')
      return String(id)
    } catch (e) { if (e.kind !== 'network' && e.kind !== 'server') this.spend.release(cost); throw e }
  }
  /** Our own profile: name, handle, picture, verified. One user read. */
  async profile() {
    if (!this.canRead()) throw new XError('config', 'read credentials not set')
    this.assertUsable()
    const cost = this.cfg.costPerUserUsd ?? this.cfg.costPerReadUsd
    if (!this.spend.reserve(cost)) throw new XError('cap', 'daily X spend cap reached')
    let r
    try { r = await this.call('GET', `${API}/users/${this.cfg.accountId}?${new URLSearchParams({ 'user.fields': 'name,username,profile_image_url,verified,verified_type' })}`, { headers: { authorization: `Bearer ${this.cfg.readBearer}` } }) } catch (e) { this.spend.release(cost); throw e }
    const u = r.data ?? {}
    return { name: u.name ?? null, handle: u.username ?? null, avatar: u.profile_image_url ? String(u.profile_image_url).replace(/_normal(\.\w+)$/, '_200x200$1') : null, verified: !!u.verified || (u.verified_type && u.verified_type !== 'none') || false }
  }
  /**
   * The account's replies to this post made after it, as { id, text }. Used only after an unknown outcome. Throws if it can't tell.
   */
  async findReply(toId, { maxResults = 100 } = {}) {
    if (!this.canRead()) throw new XError('config', 'read credentials not set')
    this.assertUsable()
    const cost = this.cfg.costPerReadUsd * maxResults
    if (!this.spend.reserve(cost)) throw new XError('cap', 'daily X spend cap reached')
    // Only posts made after the one being answered, so a burst of replies since can't push ours out of the page
    const q = new URLSearchParams({ max_results: String(maxResults), since_id: toId, 'tweet.fields': 'referenced_tweets,text,note_tweet', exclude: 'retweets' })
    let r
    try { r = await this.call('GET', `${API}/users/${this.cfg.accountId}/tweets?${q}`, { headers: { authorization: `Bearer ${this.cfg.readBearer}` } }) } catch (e) { this.spend.release(cost); throw e }
    this.spend.release(Math.max(0, cost - (r.data?.length ?? 0) * this.cfg.costPerReadUsd))
    return (r.data ?? []).filter((t) => t.referenced_tweets?.some((x) => x.type === 'replied_to' && x.id === toId)).map((t) => ({ id: t.id, text: t.note_tweet?.text ?? t.text ?? '' }))
  }
}

export function toMention(t, users) {
  const u = users.get(t.author_id) ?? {}
  return {
    id: t.id, text: t.note_tweet?.text ?? t.text ?? '', createdAt: t.created_at ? Date.parse(t.created_at) : null, isRepost: !!t.referenced_tweets?.some((x) => x.type === 'retweeted'),
    author: { id: t.author_id, handle: u.username ?? null, avatar: u.profile_image_url ?? null, xCreatedAt: u.created_at ? Date.parse(u.created_at) : NaN, followers: Number(u.public_metrics?.followers_count ?? NaN) },
  }
}
