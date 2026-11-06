// The API on plain node:http. Browsing needs nothing. Anything that changes something must come from our own origin
// with a session cookie. Admin needs the secret. No route calls X except the X OAuth fallback (off by default), so the site
// works without X credits. A Privy sign in never calls X.
import { createServer } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { PublicKey } from '@solana/web3.js'
import { hasX } from './auth.mjs'
import { listingShare, listingCard, saleCard, saleShare, ogPage } from './share.mjs'

const SESSION = 'lb_s', STATE = 'lb_o'
const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
export const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => { const i = c.indexOf('='); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()] }))
const validKey = (s) => { try { return new PublicKey(s).toBase58() === s } catch { return false } }
const sameSecret = (a, b) => { const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y) }

/** The bucket an address counts in: IPv4 as is, mapped IPv6 as IPv4, other IPv6 by its /64. */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase().split('%')[0]
  if (s.startsWith('::ffff:') && isIP(s.slice(7)) === 4) return s.slice(7)
  if (isIP(s) !== 6) return s
  const [l, r] = s.split('::')
  const head = l ? l.split(':') : [], tail = r ? r.split(':') : []
  const g = s.includes('::') ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head
  return `${g.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(':')}::/64`
}

/**
 * Who is asking. With n trusted proxies in front, each appends the address it saw to x-forwarded-for, so the n-th entry from
 * the right was written by the outermost trusted proxy and is the visitor. Everything left of it came from the client and is
 * ignored, and so is x-real-ip, which nothing here can prove a proxy wrote. Too few entries means a request that skipped the
 * proxies, so it gets the socket address.
 */
export function clientAddress(headers, socketAddress, trustedHops = 0) {
  if (!trustedHops) return socketAddress
  const raw = headers['x-forwarded-for']
  const hops = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map((h) => h.trim()).filter(Boolean)
  if (hops.length < trustedHops) return socketAddress
  const ip = hops[hops.length - trustedHops].replace(/^\[|\]$/g, '')
  return isIP(ip.replace(/^::ffff:/, '')) ? ip : socketAddress
}

export class Limiter {
  constructor(now = Date.now, maxKeys = 50_000) { this.now = now; this.maxKeys = maxKeys; this.hits = new Map() }
  allow(key, max, windowMs) {
    const t = this.now(), list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs)
    this.hits.delete(key) // re-added last, so the oldest key is first
    // Full: the longest unseen keys go, not everyone's counts
    while (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value)
    if (list.length >= max) { this.hits.set(key, list); return false }
    list.push(t); this.hits.set(key, list); return true
  }
}

export function createApp(d) {
  const { config, auth, flags, listings, pass, rewards, chainReads, spend, status, now = Date.now, log = () => {} } = d
  const limiter = new Limiter(now)
  const origin = new URL(config.publicUrl).origin
  const clientIp = (req) => ipKey(clientAddress(req.headers, req.socket.remoteAddress, config.trustedHops))
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const go = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end() }
  const readBody = (req) => new Promise((ok, no) => {
    let n = 0; const parts = []
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { no(Object.assign(new Error('too big'), { code: 413 })); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { const j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); ok(j && typeof j === 'object' && !Array.isArray(j) ? j : {}) } catch { no(Object.assign(new Error('bad json'), { code: 400 })) } })
    req.on('error', no)
  })
  const fromUs = (req) => req.headers.origin === origin
  const me = (req) => auth.sessionUser(cookies(req)[SESSION])
  const cards = new Map(), rendering = new Map() // pictures cost CPU, and the facts on them are in the key
  /** Cached pictures are free. A new one is rendered once however many ask, limited per address and in total. */
  const cached = async (req, key, make) => {
    const hit = cards.get(key)
    if (hit) { cards.delete(key); cards.set(key, hit); return hit }
    if (rendering.has(key)) return rendering.get(key)
    if (!limiter.allow(`og:${clientIp(req)}`, 30, 60_000) || !limiter.allow('og:all', 120, 60_000)) return null
    const p = make().then((b) => { while (cards.size >= 500) cards.delete(cards.keys().next().value); cards.set(key, b); return b }).finally(() => rendering.delete(key))
    rendering.set(key, p)
    return p
  }
  const sendCard = (res, buf, closed) => { if (!buf) return json(res, 429, { error: 'slow_down' }); return png(res, buf, closed) }
  const png = (res, buf, closed = false) => { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': `public, max-age=${closed ? 86400 : 30}`, 'x-content-type-options': 'nosniff' }); res.end(buf) }

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname
    // Before any limit: a platform health check must never share a bucket with visitors, or a flood restarts the container
    if (p === '/api/health') return json(res, 200, { ok: true })
    if (!limiter.allow(`r:${clientIp(req)}`, 240, 60_000)) return json(res, 429, { error: 'slow_down' })

    // ---- browsing: nothing needed
    if (p === '/api/listings' && req.method === 'GET') {
      const r = listings.list(Object.fromEntries(u.searchParams))
      return r.error ? json(res, 400, r) : json(res, 200, r)
    }
    const one = /^\/api\/listings\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)
    if (one && req.method === 'GET') {
      if (!validKey(one[1])) return json(res, 400, { error: 'bad_address' })
      if (!limiter.allow(`c:${clientIp(req)}`, 120, 60_000)) return json(res, 429, { error: 'slow_down' })
      const v = await listings.one(one[1])
      if (!v) return json(res, 404, { error: 'not_found' })
      if (v.unknown) return json(res, 503, { error: 'chain_read_failed' })
      return json(res, 200, { ...v, share: listingShare(v, config.publicUrl) })
    }
    // ---- the wallet's coins and a coin's holders: indexed reads the free browser RPC refuses, on our own RPC, cached
    const wc = /^\/api\/chain\/coins\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p), ho = /^\/api\/chain\/holders\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)
    if ((wc || ho) && req.method === 'GET') {
      const mint = wc ? u.searchParams.get('mint') : null
      if (!validKey((wc ?? ho)[1]) || (mint !== null && !validKey(mint))) return json(res, 400, { error: 'bad_address' })
      if (!chainReads) return json(res, 503, { error: 'chain_read_failed' })
      if (!limiter.allow(`ch:${clientIp(req)}`, 60, 60_000)) return json(res, 429, { error: 'slow_down' })
      try { return json(res, 200, { items: wc ? await chainReads.walletCoins(wc[1], mint) : await chainReads.holders(ho[1]) }) }
      catch (e) { log('[chain]', e.message); return json(res, 503, { error: 'chain_read_failed' }) }
    }
    // Shape fixed with the site in web/REWARDS-API.md. Without a dev key it is a 404, which the site treats as "not available".
    if (p === '/api/rewards' && req.method === 'GET') return rewards?.dev ? json(res, 200, await rewards.view({ before: u.searchParams.get('before'), limit: u.searchParams.get('limit') })) : json(res, 200, { off: true }) // no dev key yet: idle, and a 200 with no hour keeps every page's console clean
    if (p === '/api/sales' && req.method === 'GET') return json(res, 200, { items: listings.sales(Object.fromEntries(u.searchParams)).map((s) => ({ ...s, share: saleShare(s, config.publicUrl) })) })
    const cr = /^\/api\/credits\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)
    if (cr && req.method === 'GET') return json(res, 200, { items: listings.creditsFor(cr[1]) })

    // ---- share cards
    const ogL = /^\/og\/listing\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png$/.exec(p)
    if (ogL) { const r = d.db.get('SELECT * FROM listings WHERE pubkey=?', ogL[1]); if (!r) return json(res, 404, { error: 'not_found' }); return sendCard(res, await cached(req, `l:${r.pubkey}:${r.top_bid}:${r.amount}:${r.seller}`, () => listingCard(listings.view(r), config.brand)), !!r.closed) }
    const ogS = /^\/og\/sale\/([1-9A-HJ-NP-Za-km-z]{32,88})\.png$/.exec(p)
    if (ogS) { const s = d.db.get('SELECT * FROM sales WHERE sig=? ORDER BY idx LIMIT 1', ogS[1]); if (!s) return json(res, 404, { error: 'not_found' }); return sendCard(res, await cached(req, `s:${s.sig}:${s.decimals}`, () => saleCard(s, config.brand)), true) }
    const pageL = /^\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)
    const pageS = /^\/s\/([1-9A-HJ-NP-Za-km-z]{32,88})$/.exec(p)
    if (pageL || pageS) {
      let html
      if (pageL) { const r = d.db.get('SELECT * FROM listings WHERE pubkey=?', pageL[1]); if (!r) return json(res, 404, { error: 'not_found' }); const v = listings.view(r), sh = listingShare(v, config.publicUrl); html = ogPage({ title: config.brand.name, description: sh.text, image: `${config.publicUrl}/og/listing/${pageL[1]}.png`, url: sh.url }) }
      else { const s = d.db.get('SELECT * FROM sales WHERE sig=? ORDER BY idx LIMIT 1', pageS[1]); if (!s) return json(res, 404, { error: 'not_found' }); const sh = saleShare(s, config.publicUrl); html = ogPage({ title: config.brand.name, description: sh.text, image: `${config.publicUrl}/og/sale/${pageS[1]}.png`, url: sh.url }) }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=30' }); return res.end(html)
    }

    // ---- sign in
    // Our own X OAuth: a fallback only, off unless X_OAUTH_FALLBACK is set. Privy sign in is below, with the posts.
    if (p === '/api/auth/x/start' && req.method === 'GET') {
      if (!flags.signinOn || !auth.xReady()) return json(res, 404, { error: 'signin_off' })
      // No room in today's X allowance: say so before sending anyone to X and back
      if (!auth.signinOpen()) return go(res, '/?signin=paused')
      const { url, state } = auth.startSignIn()
      return go(res, url, { 'set-cookie': auth.cookie(STATE, state, 600, '/api/auth') })
    }
    if (p === '/api/auth/x/callback' && req.method === 'GET') {
      if (!flags.signinOn || !auth.xReady()) return json(res, 404, { error: 'signin_off' })
      const clear = auth.cookie(STATE, '', 0, '/api/auth')
      const r = await auth.finishSignIn({ code: u.searchParams.get('code'), state: u.searchParams.get('state') ?? '', cookieState: cookies(req)[STATE] })
      if (!r.ok) return go(res, `/?signin=${r.why}`, { 'set-cookie': clear })
      return go(res, '/', { 'set-cookie': [clear, auth.cookie(SESSION, r.token, 30 * 86400)] })
    }
    if (p === '/api/me' && req.method === 'GET') {
      const user = me(req)
      if (!user) return json(res, 200, { signedIn: false })
      return json(res, 200, { signedIn: true, handle: user.handle || null, avatar: user.avatar, hasX: hasX(user.x_id), ...auth.linkState(user.x_id) })
    }

    if (p.startsWith('/api/admin/')) {
      // Wrong guesses share one bucket for the whole server, read from nothing a client can set. Over it, wrong guesses get 429
      // and stop being compared, but the right secret is always checked first and always works, so a flood of guesses can't lock
      // the owner out of the kill switches. The real protection is the secret's length, which config enforces.
      if (!config.adminSecret || !sameSecret(req.headers['x-admin-secret'] ?? '', config.adminSecret)) { if (!limiter.allow('bad-admin', 60, 3_600_000)) return json(res, 429, { error: 'slow_down' }); return json(res, 403, { error: 'no' }) }
      if (p === '/api/admin/ip' && req.method === 'GET') return json(res, 200, { socket: req.socket.remoteAddress, xForwardedFor: req.headers['x-forwarded-for'] ?? null, xRealIp: req.headers['x-real-ip'] ?? null, trustedHops: config.trustedHops, derived: clientAddress(req.headers, req.socket.remoteAddress, config.trustedHops) })
      if (p === '/api/admin/status' && req.method === 'GET') return json(res, 200, { flags: flags.all(), xSpend: spend.status(), ...(await status()) })
      if (req.method !== 'POST' || !['/api/admin/flags', '/api/admin/campaign', '/api/admin/unlink'].includes(p)) return json(res, 404, { error: 'not_found' })
      const b = await readBody(req)
      if (p === '/api/admin/flags') { const r = flags.set(b); return r ? json(res, 200, r) : json(res, 400, { error: 'unknown_flag' }) }
      if (p === '/api/admin/unlink') { const r = auth.adminUnlink(b.wallet, b.reason); log('[admin] unlink', JSON.stringify(r)); return json(res, r.ok ? 200 : 404, r) }
      if (!pass.ready()) return json(res, 503, { error: 'pass_off' })
      if (!validKey(b.campaign)) return json(res, 400, { error: 'bad_address' })
      return json(res, 200, pass.addCampaign(b.campaign, b.label))
    }
    // ---- everything below changes something
    if (req.method !== 'POST') return json(res, 404, { error: 'not_found' })
    if (!fromUs(req)) return json(res, 403, { error: 'not_from_this_site' })
    if (p === '/api/auth/logout') {
      const t = cookies(req)[SESSION]; if (t) auth.signOut(t)
      res.setHeader('set-cookie', auth.cookie(SESSION, '', 0)); return json(res, 200, { ok: true })
    }
    // Privy: the browser hands over the tokens Privy gave it; only Privy's signature on them is trusted. No X call.
    if (p === '/api/auth/privy') {
      if (!flags.signinOn || !auth.privyReady()) return json(res, 404, { error: 'signin_off' })
      if (!limiter.allow(`pv:${clientIp(req)}`, 30, 600_000)) return json(res, 429, { error: 'slow_down' })
      const b = await readBody(req)
      const r = await auth.privySignIn({ accessToken: b.accessToken, identityToken: b.identityToken, wallet: typeof b.wallet === 'string' ? b.wallet : null, avatar: typeof b.avatar === 'string' ? b.avatar.slice(0, 300) : null })
      if (!r.ok) { log('[privy] refused', r.why); return json(res, r.why === 'unknown_key' ? 503 : 401, { error: r.why }) }
      res.setHeader('set-cookie', auth.cookie(SESSION, r.token, 30 * 86400))
      return json(res, 200, { ok: true, signedIn: true, handle: r.user.handle || null, avatar: r.user.avatar, hasX: r.user.hasX, ...auth.linkState(r.user.xId) })
    }
    const user = me(req)
    if (!user) return json(res, 401, { error: 'sign_in_first' })
    if (p === '/api/wallet/link-privy') {
      if (!limiter.allow(`n:${user.x_id}`, 20, 3_600_000)) return json(res, 429, { error: 'slow_down' })
      const b = await readBody(req), r = await auth.privyLink(user.x_id, { identityToken: b.identityToken, wallet: b.wallet })
      return json(res, r.ok ? 200 : 400, r)
    }
    if (p === '/api/wallet/challenge') {
      if (!limiter.allow(`n:${user.x_id}`, 20, 3_600_000)) return json(res, 429, { error: 'slow_down' })
      const b = await readBody(req), r = auth.challenge(user.x_id, b.wallet)
      return json(res, r.ok ? 200 : 400, r)
    }
    if (p === '/api/wallet/link') {
      const b = await readBody(req), r = auth.link(user.x_id, { wallet: b.wallet, nonce: b.nonce, signature: b.signature })
      return json(res, r.ok ? 200 : 400, r)
    }
    if (p === '/api/wallet/cancel-change') { const r = auth.cancelChange(user.x_id); return json(res, r.ok ? 200 : 400, r) }
    if (p === '/api/pass') {
      if (!flags.passOn) return json(res, 404, { error: 'pass_off' })
      if (!limiter.allow(`p:${user.x_id}`, 30, 3_600_000)) return json(res, 429, { error: 'slow_down' })
      const b = await readBody(req), r = await pass.issue({ user, campaign: b.campaign, listing: b.listing, wallet: b.wallet })
      return json(res, r.ok ? 200 : r.code, r.ok ? r : { error: r.why })
    }
    return json(res, 404, { error: 'not_found' })
  }
  return async (req, res) => { try { await handler(req, res) } catch (e) { log('[http]', e.message); if (!res.headersSent) json(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code === 413 ? 'too_big' : e.code === 400 ? 'bad_json' : 'server_error' }); else res.end() } }
}
export const listen = (handler, port) => new Promise((ok) => { const s = createServer(handler); s.listen(port, () => ok(s)) })
