// Serves the built site from web/dist, its runtime config, and the read only routes the pages need (bid history,
// activity, the public transaction feed, stats, the change log, contract trust facts, coin pictures). Everything else
// goes to the API handler unchanged. Nothing here signs anything. The one write is the deploy slot the upgrade watcher
// last saw, kept in meta so an executed upgrade gets its own log entry even across restarts.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve, extname, sep } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { Limiter, clientAddress, ipKey } from './http.mjs'
import { listingShare, saleShare, siteCard } from './share.mjs'
import { TrustWatch } from './trust.mjs'
import { CoinImages, XAvatars, BUSY } from './coinimg.mjs'
import { fmtSol } from './x/replies.mjs'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIG = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/
const validKey = (s) => { try { return KEY.test(s) && new PublicKey(s).toBase58() === s } catch { return false } }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const okKey = (s) => (s && validKey(String(s)) ? String(s) : null)
const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(String(u ?? ''))
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g
const count = (n) => (Number.isInteger(n) && n >= 0 && n < 1e7 ? n : null)
export const TAGLINE = 'Sell your tokens, not the chart. List any amount in a live auction and the best bid takes it in one transaction.'
const PATH_ROUTES = { '/live': 'live', '/fixed': 'fixed', '/sell': 'sell', '/rewards': 'rewards', '/docs': 'docs', '/log': 'log', '/tx': 'tx' }
/** The page a path opens, or null: every view has its own address, and so does each listing, each coin and each docs section. */
export function pathRoute(p) {
  const q = p.length > 1 ? p.replace(/\/$/, '') : p
  if (q === '/' || q === '/index.html') return { route: 'home' }
  if (PATH_ROUTES[q]) return { route: PATH_ROUTES[q] }
  let m
  if ((m = /^\/lot\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(q)) && validKey(m[1])) return { route: 'lot', key: m[1] }
  if ((m = /^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(q)) && validKey(m[1])) return { route: 'coin', key: m[1] }
  if ((m = /^\/docs\/([a-z0-9-]{1,40})$/.exec(q))) return { route: 'docs', key: m[1] }
  return null
}
const PAGES = {
  home: { h: 'Sell your tokens. Not the chart.', d: () => TAGLINE },
  live: { t: 'Live auctions', h: 'Live auctions.', d: () => 'Every token listing on the board right now, read from chain. The top bid when the clock hits zero takes every token listed, in one transaction.' },
  fixed: { t: 'Fixed price', h: 'This price. First buyer.', d: () => 'Token listings at one fixed price. Sign once and SOL and tokens swap in that one transaction.' },
  sell: { t: 'Sell your tokens', h: 'Sell on the side. Not on the chart.', d: () => 'List any amount of a Solana token in a live auction or at a fixed price. Your tokens stay in your wallet until the sale completes.' },
  rewards: { t: 'Seller rewards', h: 'Sell more. Get paid hourly.', d: () => 'Every hour the creator fees are claimed and 90% goes to the top 3 sellers of the hour, split 50, 30 and 20. The claim and every payout are public transactions.' },
  docs: { t: 'Docs', h: 'How it works.', d: (n) => `How ${n} auctions, fixed price listings, bids, refunds and seller rewards work, with every number in one place.` },
  log: { t: 'Change log', h: 'What changed, dated.', d: () => 'Every change to the contract, the server and the site, every fix, and every upgrade proposal, newest first.' },
  tx: { t: 'Every transaction', h: 'Every transaction.', d: () => 'Every listing, bid, sale, refund, fee claim and payout on the contract, newest first, each linked to Solscan.' },
  notfound: { t: 'Page not found', h: 'Nothing at this address.', d: () => 'This page does not exist. Live auctions are one click away.' },
}
const NAV = [['/live', 'Live'], ['/fixed', 'Fixed price'], ['/rewards', 'Rewards'], ['/docs', 'Docs']]
const compact = (n) => (n >= 1e9 ? +(n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(+n.toPrecision(3)))
const shortK = (k) => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`
const FEED_KIND = { Listed: 'listed', BidPlaced: 'bid', Settled: 'sold', Accepted: 'accepted', Bought: 'bought', MarkedGone: 'refund', Cancelled: 'cancelled', CreditParked: 'credit' }
const LOG_KINDS = new Set(['build', 'fix', 'upgrade', 'incident', 'launch', 'note'])

/** Brand and chain values the pages read at run time. Edit the JSON file and the site follows without a rebuild. */
export function siteConfigReader({ config, env = process.env }) {
  const file = env.SITE_CONFIG || join(config.dataDir, 'site.json')
  let cached = null, mtime = -1
  const fromEnv = () => { try { return env.SITE_CONFIG_JSON ? JSON.parse(env.SITE_CONFIG_JSON) : {} } catch { return {} } }
  const raw = () => {
    let m = -2
    try { m = statSync(file).mtimeMs } catch {}
    if (m !== mtime) { mtime = m; try { cached = m >= 0 ? JSON.parse(readFileSync(file, 'utf8')) : fromEnv() } catch { cached = fromEnv() } }
    return cached ?? {}
  }
  const read = (flags) => {
    const c = raw(), b = c.brand ?? {}, ch = c.chain ?? {}, k = c.keys ?? {}, t = c.trust ?? {}, f = c.facts ?? {}, st = c.stats ?? {}
    const reveal = b.reveal === true
    // The server's own RPC URL may carry a paid key, so it is only ever reused when it points at this machine
    const rpc = ch.rpc || (isLocal(config.rpcUrl) ? config.rpcUrl : null)
    const name = String(b.name || 'Sidebid').replace(INVISIBLE, '').trim().slice(0, 40) || 'Sidebid'
    const ticker = String(b.ticker || 'SIDEBID').replace(/^\$/, '')
    return {
      brand: {
        name, ticker: /^[A-Za-z0-9]{1,10}$/.test(ticker) ? ticker : 'SIDEBID', logo: /^https:\/\/[^\s"'<>]+$/.test(b.logo ?? '') ? b.logo : null,
        domain: b.domain || new URL(config.publicUrl).host,
        // Hidden until the reveal flag is on: they are left out of the answer, not just hidden on the page
        reveal, ca: reveal ? okKey(b.ca) : null, github: reveal && /^https:\/\/[^\s"'<>]+$/.test(b.github ?? '') ? String(b.github).replace(/\/$/, '') : null,
        xHandle: reveal && /^[A-Za-z0-9_]{1,15}$/.test(b.xHandle ?? '') ? b.xHandle : null,
      },
      chain: {
        rpc, ws: ch.ws || null, cluster: ch.cluster || (isLocal(rpc) ? 'localnet' : 'mainnet-beta'),
        explorer: ch.explorer || 'https://solscan.io', programId: config.programId.toBase58(),
        priorityMicroLamports: Number(ch.priorityMicroLamports ?? 0) || 0,
      },
      keys: { upgradeAuthority: okKey(k.upgradeAuthority), passSigner: config.passKey?.publicKey.toBase58() ?? okKey(k.passSigner), devWallet: reveal ? okKey(k.devWallet) : null },
      trust: { squadsMultisig: okKey(t.squadsMultisig), commit: /^[0-9a-f]{40}$/i.test(t.commit ?? '') ? String(t.commit).toLowerCase() : null },
      facts: { contractTests: count(f.contractTests), serverTests: count(f.serverTests) },
      stats: { minSales: count(st.minSales) ?? 10 },
      drops: c.drops ?? null,
      priceFeed: c.priceFeed === true,
      live: { signin: !!flags?.signin, pass: !!flags?.pass },
      // Public by design: the app id is in every Privy page. Sign in goes through Privy unless only the X fallback is set.
      auth: { privy: config.privy?.appId ? { appId: config.privy.appId, clientId: config.privy.clientId || null } : null, xFallback: !!(config.x?.oauthFallback && config.x?.signinClientId) },
      now: Math.floor(Date.now() / 1000),
    }
  }
  return read
}

/** Which log rows a site shows: 'preview' on a test chain (the preview, local runs, tests), 'production' on the live site. */
export const logMode = (config, env = process.env) => (config?.production && env.PREVIEW_CHAIN !== '1' ? 'production' : 'preview')
/**
 * The change log: dataDir/log.json, else the one shipped with the site. Bad rows are dropped, strings capped. A row with
 * "env": "preview" or "production" shows only in that mode, so a line true only of a test chain never reaches the live site.
 */
export function readLog(files, mode = null) {
  for (const f of files) {
    let rows
    try { rows = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    if (!Array.isArray(rows)) continue
    return rows.filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.title === 'string' && r.title.trim())
      .filter((r) => r.env == null || r.env === 'all' || (mode !== null && r.env === mode))
      .slice(0, 500).map((r) => ({ date: r.date, title: r.title.trim().slice(0, 120), body: String(r.body ?? '').slice(0, 2000), kind: LOG_KINDS.has(r.kind) ? r.kind : 'note' }))
  }
  return []
}
const utcWhen = (s) => new Date(s * 1000).toISOString().replace('T', ' at ').slice(0, 19) + ' UTC'

export function withSite(app, config, { dist = process.env.WEB_DIST || resolve(new URL('../../web/dist', import.meta.url).pathname), env = process.env, now = Date.now, fetchImpl = fetch, lookup, logFile = resolve(new URL('../../web/log.json', import.meta.url).pathname), trust = null, images = null, pictures = null, picturesDir = env.PICTURES_DIR || (config.production || env.PREVIEW_CHAIN === '1' ? join(config.dataDir, 'pics') : null), prefetchMs = 20_000 } = {}) {
  const inner = app.handler, db = app.db
  const siteConfig = siteConfigReader({ config, env })
  const limiter = new Limiter(now)
  const ip = (req) => ipKey(clientAddress(req.headers, req.socket.remoteAddress, config.trustedHops))
  const root = resolve(dist)
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)) }
  const conn = app.rpc?.conn
  const coinImages = images ?? new CoinImages({ conn, fetchImpl, now, ...(lookup ? { lookup } : {}), dir: picturesDir ? join(picturesDir, 'coins') : null, seed: pictures?.coins })
  // X profile pictures by handle: the address stored at sign in, on a tagged post, or on a mention, newest first
  const findAvatar = (h) => (db.get('SELECT avatar FROM x_users WHERE lower(handle)=? AND avatar IS NOT NULL ORDER BY updated_at DESC LIMIT 1', h)
    ?? db.get('SELECT avatar FROM tag_cards WHERE lower(handle)=? AND avatar IS NOT NULL ORDER BY created_at DESC LIMIT 1', h)
    ?? db.get('SELECT avatar FROM mentions WHERE lower(handle)=? AND avatar IS NOT NULL ORDER BY created_at DESC LIMIT 1', h))?.avatar
    ?? (() => { try { const a = JSON.parse(db.get('SELECT author FROM drop_plans ORDER BY id DESC LIMIT 1')?.author ?? 'null'); return a?.handle?.toLowerCase() === h ? a.avatar ?? null : null } catch { return null } })()
  const avatars = new XAvatars({ images: coinImages, find: findAvatar, now, dir: picturesDir ? join(picturesDir, 'x') : null, seed: pictures?.avatars })
  // Every coin the indexer has seen gets its picture (and name) read and kept, a few at a time, so a page never waits on a host
  const prefetch = async () => {
    try {
      const mints = db.all(`SELECT mint FROM (SELECT mint, MAX(first_seen_at) t FROM listings WHERE mint IS NOT NULL GROUP BY mint UNION SELECT mint, MAX(at) * 1000 t FROM sales WHERE mint IS NOT NULL GROUP BY mint) GROUP BY mint ORDER BY MAX(t) DESC LIMIT 400`).map((r) => r.mint)
      let n = 0
      for (const m of mints) { if (n >= 12) break; if (!validKey(m) || (coinImages.has?.(m) && coinImages.info?.(m))) continue; n++; await coinImages.get(m).catch(() => null) }
      const handles = db.all(`SELECT DISTINCT lower(handle) h FROM x_users WHERE avatar IS NOT NULL UNION SELECT DISTINCT lower(handle) FROM tag_cards WHERE avatar IS NOT NULL LIMIT 400`).map((r) => r.h)
      n = 0
      for (const h of handles) { if (n >= 12) break; if (avatars.has(h)) continue; n++; await avatars.get(h).catch(() => null) }
    } catch {}
  }
  if (prefetchMs > 0 && conn) { const t = setInterval(prefetch, prefetchMs); t.unref?.(); setTimeout(prefetch, 1500).unref?.() }
  // The watcher follows the config: a new multisig or cluster in site.json starts a fresh one
  let watch = trust, watchKey = ''
  const trustWatch = () => {
    if (trust) return trust
    const c = siteConfig({}), key = `${c.trust.squadsMultisig}|${c.chain.cluster}`
    if (!watch || key !== watchKey) { watch = new TrustWatch({ conn, programId: config.programId, squads: c.trust.squadsMultisig ? { multisig: c.trust.squadsMultisig } : null, now, fetchImpl, cluster: c.chain.cluster }); watchKey = key }
    return watch
  }
  const trustBody = async () => {
    const c = siteConfig({}), t = await watched()
    const source = c.brand.github && c.trust.commit ? { github: c.brand.github, commit: c.trust.commit, url: `${c.brand.github}/commit/${c.trust.commit}` } : null
    return { ...t, source }
  }

  // ---- who a wallet is: the active link, or the X account that tagged a card for it
  const people = (wallets) => {
    const out = {}
    const list = [...new Set(wallets.filter(Boolean))].slice(0, 200)
    for (const w of list) {
      const r = db.get('SELECT NULLIF(u.handle, \'\') handle, u.avatar FROM wallet_links k JOIN x_users u ON u.x_id=k.x_id WHERE k.wallet=?', w) ?? db.get('SELECT handle, avatar FROM tag_cards WHERE wallet=? ORDER BY created_at DESC LIMIT 1', w)
      out[w] = { handle: r?.handle ?? null, avatar: r?.avatar ?? null }
    }
    return out
  }
  // ---- lot numbers: the order listings first appeared on chain
  let lots = { at: 0, map: new Map() }
  const lotMap = () => {
    if (now() - lots.at < 3000) return lots.map
    const map = new Map()
    db.all(`SELECT listing, at FROM events_seen WHERE name='Listed' ORDER BY at ASC, rowid ASC`).forEach((r) => { if (!map.has(r.listing)) map.set(r.listing, { lot: map.size + 1, listedAt: r.at }) })
    lots = { at: now(), map }
    return map
  }
  const eventRow = (e) => { let d = {}; try { d = JSON.parse(e.data) } catch {} return { sig: e.sig, name: e.name, listing: e.listing, at: e.at, data: d } }

  // ---- the public feed: every contract event plus fee claims and reward payouts, newest first
  const feed = (limit, before) => {
    const cut = before ?? 2 ** 40
    const ev = db.all(`SELECT e.sig, e.idx, e.name, e.listing, e.data, e.at, l.mint, l.decimals, l.mode FROM events_seen e LEFT JOIN listings l ON l.pubkey=e.listing WHERE COALESCE(e.at,0) < ? ORDER BY e.at DESC, e.rowid DESC LIMIT ?`, cut, limit).map((e) => {
      const d = eventRow(e).data, kind = FEED_KIND[e.name] ?? 'other'
      const sale = kind === 'sold' || kind === 'accepted' || kind === 'bought'
      // A listing row carries a price only when it is one: a fixed price, or a minimum above the 0.001 SOL floor
      const mode = d.mode ?? e.mode, fixed = mode === 'fixed', listPrice = kind === 'listed' && /^\d+$/.test(String(d.price)) && (fixed || BigInt(d.price) > 1_000_000n) ? String(d.price) : null
      return {
        kind, sig: e.sig, at: e.at, listing: e.listing, mint: e.mint ?? d.mint ?? null, decimals: e.decimals ?? null,
        amount: sale || kind === 'listed' ? (d.amount ?? null) : null,
        priceKind: listPrice ? (fixed ? 'fixed' : 'min') : null,
        lamports: kind === 'listed' ? listPrice : sale ? (d.price ?? null) : kind === 'bid' || kind === 'credit' ? (d.amount ?? null) : kind === 'refund' || kind === 'cancelled' ? (d.refunded ?? null) : null,
        wallets: [d.seller, d.bidder, d.winner, d.buyer, d.owner].filter(Boolean),
      }
    })
    const claims = db.all(`SELECT hour, claim_sig, claim_at, claimed FROM reward_hours WHERE claim_sig IS NOT NULL AND CAST(claimed AS INTEGER) > 0 AND COALESCE(claim_at, hour) / 1000 < ? ORDER BY claim_at DESC LIMIT ?`, cut, limit)
      .map((r) => ({ kind: 'fee_claim', sig: r.claim_sig, at: Math.floor((r.claim_at ?? r.hour) / 1000), listing: null, mint: null, decimals: null, amount: null, lamports: String(r.claimed), wallets: [] }))
    // Paid at: the block time of the confirmed payout transaction, read from the chain. Until it is known the row is placed by
    // when the sender saw it confirmed (or the hour's end) and claims no paid time.
    const pays = db.all(`SELECT p.hour, p.place, p.wallet, p.lamports, p.sig, h.claim_at, x.block_time, (SELECT MAX(t.updated_at) FROM tx_intents t WHERE t.sig=p.sig AND t.status='landed') AS seen_at FROM reward_payouts p LEFT JOIN reward_hours h ON h.hour=p.hour LEFT JOIN tx_times x ON x.sig=p.sig WHERE p.status='landed' AND p.sig IS NOT NULL ORDER BY p.hour DESC, p.place LIMIT ?`, limit)
      .map((r) => ({ kind: 'payout', sig: r.sig, at: r.block_time ?? Math.floor((r.seen_at ?? Math.max(r.hour + 3_600_000, r.claim_at ?? 0)) / 1000), paidAt: r.block_time ?? null, listing: null, mint: null, decimals: null, amount: null, lamports: String(r.lamports), wallets: [r.wallet], place: r.place }))
      .filter((r) => r.at < cut)
    const items = [...ev, ...claims, ...pays].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit)
    return { items, people: people(items.flatMap((i) => i.wallets)) }
  }
  // Block times for landed payouts, read in one batch at most every 15 seconds, only for the ones not yet known
  let timesAt = -Infinity, timing = null
  const payTimes = () => {
    if (timing) return timing
    if (!app.rpc?.transactions || now() - timesAt < 15_000) return null
    const sigs = db.all(`SELECT DISTINCT p.sig FROM reward_payouts p WHERE p.status='landed' AND p.sig IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tx_times x WHERE x.sig=p.sig) ORDER BY p.hour DESC LIMIT 50`).map((r) => r.sig)
    if (!sigs.length) return null
    timesAt = now()
    timing = app.rpc.transactions(sigs).then((txs) => {
      (txs ?? []).forEach((t, i) => { if (t && !t.meta?.err && Number.isSafeInteger(t.blockTime) && t.blockTime > 0) db.run('INSERT OR IGNORE INTO tx_times (sig, block_time) VALUES (?,?)', sigs[i], t.blockTime) })
    }).catch(() => {}).finally(() => { timing = null })
    return timing
  }
  const stats = () => {
    const s = db.get(`SELECT COUNT(*) n, COALESCE(SUM(CAST(price AS INTEGER)),0) paid, COUNT(DISTINCT seller) sellers FROM sales`)
    const held = db.get(`SELECT COALESCE(SUM(CAST(top_bid AS INTEGER)),0) n FROM listings WHERE closed=0 AND state='live'`).n
    const rw = db.get(`SELECT COALESCE(SUM(CAST(lamports AS INTEGER)),0) n FROM reward_payouts WHERE status='landed'`).n
    return { show: s.n >= siteConfig({}).stats.minSales, heldLamports: String(held), sold: s.n, paidLamports: String(s.paid), rewardsLamports: String(rw), sellers: s.sellers }
  }
  // ---- executed upgrades: the program data's deploy slot moves only when new code is deployed. The first slot seen is the
  // starting point; every later change is one dated entry. Kept in meta, newest first, at most 50.
  const deploys = () => { try { const r = JSON.parse(db.meta('site_deploys') ?? '[]'); return Array.isArray(r) ? r : [] } catch { return [] } }
  // Only a fresh confirmed read counts (a reading kept from before a failed read carries readAt), and only a slot strictly
  // newer than the last one: a lagging RPC node answering an older slot is not a deploy and is not remembered either.
  const noteDeploy = (u) => {
    const slot = u?.deploySlot
    if (!Number.isSafeInteger(slot) || slot < 0 || u.readAt != null) return
    const seen = db.meta('site_deploy_slot')
    if (seen !== null && /^\d+$/.test(seen) && Number(seen) >= slot) return
    db.tx(() => {
      if (seen !== null && /^\d+$/.test(seen)) db.setMeta('site_deploys', JSON.stringify([{ slot, prev: Number(seen), at: Math.floor(now() / 1000) }, ...deploys()].slice(0, 50)))
      db.setMeta('site_deploy_slot', String(slot))
    })
  }
  const watched = async () => { const t = await trustWatch().get(); try { noteDeploy(t.upgrade) } catch {} return t }
  const logItems = async () => {
    const base = readLog([join(config.dataDir, 'log.json'), logFile], logMode(config, env))
    let auto = []
    try {
      const t = await watched()
      auto = deploys().map((d) => ({
        date: new Date(d.at * 1000).toISOString().slice(0, 10), kind: 'upgrade', title: 'Upgrade executed',
        body: `New program code went live at slot ${d.slot.toLocaleString('en-US')}, replacing ${d.prev ? `the build deployed at slot ${d.prev.toLocaleString('en-US')}` : 'the build loaded when the chain started'}. Seen by the site on ${utcWhen(d.at)}. The Check it yourself strip shows whether the new build matches the source.`,
      }))
      auto.push(...t.upgrade.pending.map((p) => ({
        date: new Date((p.approvedAt ?? p.proposedAt ?? Math.floor(now() / 1000)) * 1000).toISOString().slice(0, 10), kind: 'upgrade',
        title: p.kind === 'program' ? 'Upgrade proposed' : p.kind === 'settings' ? 'Multisig settings change proposed' : 'Vault transaction proposed',
        body: `Proposal ${p.index} is waiting in the Squads vault that holds the upgrade key. ${p.executableAt ? `It can execute from ${utcWhen(p.executableAt)}.` : 'It still needs approval, and then waits out the time lock.'}`,
      })))
    } catch {}
    return [...auto, ...base].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }

  // ---- pages
  let index = null, indexAt = -1
  const indexHtml = () => {
    const f = join(root, 'index.html')
    let m = -1; try { m = statSync(f).mtimeMs } catch { return null }
    if (m !== indexAt) { index = readFileSync(f, 'utf8'); indexAt = m }
    return index
  }
  const origin = (u) => { try { return new URL(u).origin } catch { return null } }
  const csp = () => {
    const c = siteConfig({}), rpc = origin(c.chain.rpc), ws = c.chain.ws ? origin(c.chain.ws) : rpc ? rpc.replace(/^http/, 'ws') : null
    const connect = ["'self'", rpc, ws, ...(c.priceFeed ? ['https://api.dexscreener.com', 'https://api.geckoterminal.com'] : [])].filter(Boolean).join(' ')
    if (!config.privy?.appId) return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
    // Privy's sign in (docs.privy.io, Content Security Policy): its API and wallet iframe, WalletConnect for phone wallets,
    // Cloudflare Turnstile for its bot check, and X profile pictures in the modal
    const pc = `${connect} https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.org`
    const frames = 'https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com'
    return `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://auth.privy.io https://explorer-api.walletconnect.com https://pbs.twimg.com; connect-src ${pc}; child-src ${frames}; frame-src ${frames}; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
  }
  const https = /^https:/.test(config.publicUrl)
  // ---- the first paint: the real header, the page's heading, and the facts it shows, in the HTML itself. The script then
  // draws the live page over it. A link opened with scripts off, a share preview, or a page pasted elsewhere reads right.
  const lotFacts = (r) => {
    const c = coinImages.info?.(r.mint), t = c?.symbol ? '$' + c.symbol.toUpperCase() : shortK(r.mint)
    const amt = r.amount && r.decimals != null ? compact(Number(BigInt(r.amount)) / 10 ** r.decimals) : null
    const fx = r.mode === 'fixed', bid = r.top_bid && r.top_bid !== '0'
    const price = fx ? `${fmtSol(r.price ?? 0)} SOL, fixed price` : bid ? `top bid ${fmtSol(r.top_bid)} SOL` : BigInt(r.price ?? 0) > 1_000_000n ? `opens at ${fmtSol(r.price)} SOL` : 'open to any bid'
    return { t, name: c?.name ?? null, amt, price, fx }
  }
  const lotLi = (r) => { const f = lotFacts(r); return `<li><a href="/lot/${r.pubkey}"><b>${esc(f.t)}</b> ${f.amt ? esc(f.amt) + ' tokens, ' : ''}${esc(f.price)}</a></li>` }
  const liveRows = (mode) => db.all(`SELECT * FROM listings WHERE closed=0 AND state='live' ${mode === 'fixed' ? "AND mode='fixed'" : mode === 'bid' ? "AND mode<>'fixed'" : ''} AND (mode='fixed' OR end_time > ?) ORDER BY end_time ASC LIMIT 12`, Math.floor(now() / 1000))
  const firstPaint = (pg, body = '') => {
    const name = siteConfig({}).brand.name
    const nav = NAV.map(([h, n]) => `<a href="${h}">${n}</a>`).join('')
    return `<div class="fp"><header class="top"><div class="wrap top-in"><a class="brand" href="/" aria-label="${esc(name)} home"><img class="brand-logo" src="/brand/logo-48.png" srcset="/brand/logo-48.png 1x, /brand/logo-96.png 2x, /brand/logo-144.png 3x" alt="" width="61" height="48" decoding="async">${/^sidebid$/i.test(name) ? '<img class="brand-wm" src="/brand/wordmark-28.png" srcset="/brand/wordmark-28.png 1x, /brand/wordmark-56.png 2x, /brand/wordmark-84.png 3x" alt="Sidebid" width="114" height="28" decoding="async">' : `<b class="wm"><span>${esc(name)}</span></b>`}</a><nav class="nav" aria-label="Main">${nav}</nav><div class="top-r"><a class="btn hot" href="/sell">Sell tokens</a></div></div></header>
<main><section class="phead"><div class="wrap"><h1 class="mega sm">${esc(pg.h)}</h1><p class="lede">${esc(pg.d)}</p>${body}</div></section></main></div>`
  }
  const facts = (rows) => `<dl class="fp-dl">${rows.filter((r) => r[1]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`
  const list = (title, rows) => (rows.length ? `<h2 class="fp-h">${esc(title)}</h2><ul class="fp-list">${rows.map(lotLi).join('')}</ul>` : '')
  /** Title, description, share picture, canonical address, first paint and status for one path. */
  const describe = (pr) => {
    const name = siteConfig({}).brand.name, base = config.publicUrl
    const std = (k, extra = '') => { const P = PAGES[k], d = P.d(name); return { title: P.t ? `${P.t} | ${name}` : `${name}, live auctions for Solana tokens`, description: d, url: `${base}${k === 'home' ? '/' : '/' + k}`, paint: firstPaint({ h: P.h, d }, extra) } }
    if (!pr) return { ...std('notfound', '<p class="fp-more"><a class="btn hot" href="/live">See live auctions</a></p>'), status: 404, route: 'notfound', url: null }
    if (pr.route === 'home') { const live = liveRows('all'); return { ...std('home', list(live.length ? 'Live right now' : '', live)), route: 'home' } }
    if (pr.route === 'live' || pr.route === 'fixed') { const rows = liveRows(pr.route === 'fixed' ? 'fixed' : 'bid'); return { ...std(pr.route, rows.length ? list(`${rows.length} on the board`, rows) : '<p class="fp-more">The board is open. The first listing shows here live.</p>'), route: pr.route } }
    if (pr.route === 'docs') return { ...std('docs'), route: pr.key ? `docs/${pr.key}` : 'docs', url: `${base}/docs${pr.key ? '/' + pr.key : ''}` }
    if (pr.route === 'lot') {
      const r = db.get('SELECT * FROM listings WHERE pubkey=?', pr.key)
      if (!r) return { title: `Listing ${shortK(pr.key)} | ${name}`, description: TAGLINE, url: `${base}/lot/${pr.key}`, paint: firstPaint({ h: `Listing ${shortK(pr.key)}`, d: 'Reading this listing from chain.' }), route: `lot/${pr.key}` }
      const f = lotFacts(r), v = app.listings.view(r), sh = listingShare(v, base), kind = f.fx ? 'fixed price' : r.mode === 'accept' ? 'live auction, listed on X' : 'live auction'
      const head = `${f.t}${f.amt ? ', ' + f.amt + ' tokens' : ''}`
      const live = v.phase === 'live', ends = r.end_time && r.mode !== 'fixed' ? utcWhen(r.end_time).replace(' at ', ' ') : null
      const body = facts([['Coin', `${esc(f.t)}${f.name ? ' ' + esc(f.name) : ''}`], ['Contract address', `<span class="addr">${esc(r.mint)}</span>`], ['Amount', f.amt ? `${esc(f.amt)} tokens` : null], ['Price', esc(f.price)], ['Type', esc(kind)], ['State', esc(live ? 'Live' : String(v.phase).replace(/_/g, ' '))], [live ? 'Ends' : 'Ended', ends ? esc(ends) : null], ['Seller', esc(v.seller.handle ? '@' + v.seller.handle : shortK(v.seller.wallet))]])
      return { title: `${head}, ${kind} | ${name}`, description: sh.text, image: `${base}/og/listing/${r.pubkey}.png`, url: `${base}/lot/${r.pubkey}`, paint: firstPaint({ h: head, d: `${f.price[0].toUpperCase()}${f.price.slice(1)}. ${sh.text}` }, body), route: `lot/${r.pubkey}` }
    }
    if (pr.route === 'coin') {
      const rows = db.all('SELECT * FROM listings WHERE mint=? ORDER BY closed ASC, end_time DESC LIMIT 24', pr.key)
      const c = coinImages.info?.(pr.key), t = c?.symbol ? '$' + c.symbol.toUpperCase() : shortK(pr.key)
      const sold = db.get('SELECT COUNT(*) n FROM sales WHERE mint=?', pr.key).n
      const d = `${t}${c?.name ? ' ' + c.name : ''} on ${name}: ${rows.filter((r) => !r.closed).length} open listings, ${sold} sold. Contract address ${pr.key}.`
      return { title: `${t}${c?.name ? ' ' + c.name : ''} | ${name}`, description: d, url: `${base}/coin/${pr.key}`, paint: firstPaint({ h: t, d }, list('Listings', rows)), route: `coin/${pr.key}`, status: rows.length ? 200 : 404 }
    }
    return { ...std(pr.route), route: pr.route }
  }
  const page = (res, { route, title, description, image, url, paint, status = 200 } = {}) => {
    let html = indexHtml()
    if (!html) return json(res, 503, { error: 'site_not_built' })
    const name = siteConfig({}).brand.name
    const og = { title: title ?? name, description: description ?? TAGLINE, image: image ?? `${config.publicUrl}/og/site.png`, url: url ?? `${config.publicUrl}/${route && PATH_ROUTES['/' + route] ? route : ''}` }
    const tags = `<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(name)}"><meta property="og:title" content="${esc(og.title)}"><meta property="og:description" content="${esc(og.description)}"><meta property="og:image" content="${esc(og.image)}"><meta property="og:url" content="${esc(og.url)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(og.title)}"><meta name="twitter:description" content="${esc(og.description)}"><meta name="twitter:image" content="${esc(og.image)}">${status === 200 ? `<link rel="canonical" href="${esc(og.url)}">` : '<meta name="robots" content="noindex">'}`
    // A built page may already carry default tags; those are replaced so there is only ever one set
    html = html.replace(/<meta (property="og:[^"]*"|name="twitter:[^"]*") content="[^"]*">/g, '').replace(/<link rel="canonical"[^>]*>/g, '').replace('</head>', `${tags}</head>`)
    if (title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    if (description) html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    if (paint) html = html.replace(/<div id="app">(?:<div class="boot"><\/div>|<!--fp-->)?<\/div>/, `<div id="app">${paint}</div>`)
    if (route) html = html.replace('<body>', `<body data-route="${esc(route)}">`)
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': csp(), 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', ...(https ? { 'strict-transport-security': 'max-age=31536000' } : {}) })
    res.end(html)
  }
  const file = (res, p, req = null) => {
    const f = resolve(root, `.${p}`)
    if (f !== root && !f.startsWith(root + sep)) return false
    if (!existsSync(f) || !statSync(f).isFile()) return false
    // A hashed script the build also wrote gzipped (the Privy bundle) goes out compressed to a browser that takes it
    const gz = /\.[0-9a-f]{8}\.js$/.test(f) && /\bgzip\b/.test(String(req?.headers?.['accept-encoding'] ?? '')) && existsSync(f + '.gz')
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'cache-control': /\.[0-9a-f]{8}\./.test(f) ? 'public, max-age=31536000, immutable' : 'public, max-age=300', 'x-content-type-options': 'nosniff', vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}) })
    res.end(readFileSync(gz ? f + '.gz' : f))
    return true
  }
  let card = null
  const ogSite = async () => { const b = siteConfig({}).brand, k = `${b.name}|${b.ticker}`; if (!card || card.k !== k) card = { k, png: await siteCard(b) }; return card.png }

  return async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x'), p = u.pathname
      const get = req.method === 'GET' || req.method === 'HEAD'
      const site = p === '/api/config' || p.startsWith('/api/site/')
      if (site && get && !limiter.allow(`s:${ip(req)}`, 300, 60_000)) return json(res, 429, { error: 'slow_down' })
      if (p === '/api/config' && get) return json(res, 200, siteConfig({ signin: app.flags.signinOn && app.auth.ready(), pass: app.flags.passOn && app.pass.ready() }))
      let m
      if ((m = /^\/api\/site\/events\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)) && get) {
        const items = db.all('SELECT sig, idx, name, listing, data, at FROM events_seen WHERE listing=? ORDER BY at DESC, rowid DESC LIMIT 200', m[1]).map(eventRow)
        const who = people(items.flatMap((e) => [e.data.bidder, e.data.winner, e.data.buyer, e.data.seller]))
        return json(res, 200, { items, people: who, ...(lotMap().get(m[1]) ?? { lot: null, listedAt: null }) })
      }
      if (p === '/api/site/activity' && get) {
        const n = Math.min(Math.max(Number(u.searchParams.get('limit')) || 40, 1), 100)
        const items = db.all(`SELECT e.sig, e.idx, e.name, e.listing, e.data, e.at, l.mint, l.decimals, l.amount AS listingAmount FROM events_seen e LEFT JOIN listings l ON l.pubkey=e.listing WHERE e.name IN ('BidPlaced','Settled','Accepted','Bought','Listed','MarkedGone') ORDER BY e.at DESC, e.rowid DESC LIMIT ?`, n)
          .map((e) => ({ ...eventRow(e), mint: e.mint, decimals: e.decimals, listingAmount: e.listingAmount }))
        return json(res, 200, { items, people: people(items.flatMap((e) => [e.data.bidder, e.data.winner, e.data.buyer, e.data.seller])) })
      }
      if (p === '/api/site/feed' && get) {
        const n = Math.min(Math.max(Number(u.searchParams.get('limit')) || 40, 1), 100), b = Number(u.searchParams.get('before'))
        const fill = payTimes()
        if (fill) { let t; await Promise.race([fill, new Promise((ok) => { t = setTimeout(ok, 1500) })]); clearTimeout(t) }
        return json(res, 200, feed(n, Number.isInteger(b) && b > 0 ? b : null))
      }
      if (p === '/api/site/stats' && get) return json(res, 200, stats())
      if (p === '/api/site/log' && get) return json(res, 200, { items: await logItems() })
      if (p === '/api/site/trust' && get) return json(res, 200, await trustBody())
      if ((m = /^\/api\/site\/coinimg\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)) && get) {
        if (!validKey(m[1])) return json(res, 404, { error: 'not_found' })
        // A cached picture is free. Only one that needs an outbound fetch counts: 120 a minute per visitor, well over a page
        // of 50 new coins, and 600 a minute for everyone together
        if (!coinImages.has?.(m[1]) && (!limiter.allow(`img:${ip(req)}`, 120, 60_000) || !limiter.allow('img:all', 600, 60_000))) return json(res, 429, { error: 'slow_down' })
        let img
        try { img = await coinImages.get(m[1]) } catch (e) { if (e?.message === BUSY) { res.setHeader('retry-after', '5'); return json(res, 503, { error: 'busy' }) } img = null }
        if (!img) return json(res, 404, { error: 'no_image' })
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" })
        return res.end(req.method === 'HEAD' ? undefined : img.bytes)
      }
      if ((m = /^\/api\/site\/xavatar\/([A-Za-z0-9_]{1,15})$/.exec(p)) && get) {
        if (!avatars.has(m[1]) && (!limiter.allow(`img:${ip(req)}`, 120, 60_000) || !limiter.allow('img:all', 600, 60_000))) return json(res, 429, { error: 'slow_down' })
        let img
        try { img = await avatars.get(m[1]) } catch (e) { if (e?.message === BUSY) { res.setHeader('retry-after', '5'); return json(res, 503, { error: 'busy' }) } img = null }
        if (!img) return json(res, 404, { error: 'no_image' })
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" })
        return res.end(req.method === 'HEAD' ? undefined : img.bytes)
      }
      if (p === '/api/site/lots' && get) {
        const keys = [...new Set(String(u.searchParams.get('keys') ?? '').split(',').filter((k) => KEY.test(k)))].slice(0, 100)
        const map = lotMap(), out = {}, bids = new Map()
        if (keys.length) db.all(`SELECT listing, COUNT(*) n FROM events_seen WHERE name='BidPlaced' AND listing IN (${keys.map(() => '?').join(',')}) GROUP BY listing`, ...keys).forEach((r) => bids.set(r.listing, r.n))
        for (const k of keys) out[k] = { ...(map.get(k) ?? { lot: null, listedAt: null }), bids: bids.get(k) ?? 0 }
        return json(res, 200, out)
      }
      if ((m = /^\/api\/site\/seller\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p)) && get) {
        const x = db.get('SELECT NULLIF(u.handle, \'\') handle, u.avatar, u.x_created_at, u.followers FROM wallet_links k JOIN x_users u ON u.x_id=k.x_id WHERE k.wallet=?', m[1])
        const s = db.get('SELECT COUNT(*) n FROM sales WHERE seller=?', m[1])
        return json(res, 200, { wallet: m[1], handle: x?.handle ?? null, avatar: x?.avatar ?? null, xCreatedAt: x?.x_created_at ?? null, followers: x?.followers ?? null, sales: s.n })
      }
      if (!get) return inner(req, res)
      if (p === '/og/site.png') { const png = await ogSite(); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }); return res.end(png) }
      if (p === '/favicon.ico') {
        const f = join(root, 'brand/favicon-32.png')
        if (existsSync(f)) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }); return res.end(readFileSync(f)) }
        res.writeHead(204); return res.end()
      }
      // ---- shared links open the real page, with the card tags for X
      const cl = /^\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p), cs = /^\/s\/([1-9A-HJ-NP-Za-km-z]{32,88})$/.exec(p)
      if (cl || cs) {
        const name = siteConfig({}).brand.name
        if (cl) return page(res, { ...describe({ route: 'lot', key: cl[1] }), ...(db.get('SELECT 1 FROM listings WHERE pubkey=?', cl[1]) ? { url: listingShare(app.listings.view(db.get('SELECT * FROM listings WHERE pubkey=?', cl[1])), config.publicUrl).url } : {}) })
        const s = db.get('SELECT * FROM sales WHERE sig=?', cs[1])
        if (!s || !SIG.test(cs[1])) return page(res, describe({ route: 'home' }))
        const sh = saleShare(s, config.publicUrl), d = describe({ route: 'lot', key: s.listing })
        return page(res, { ...d, title: `${name}: ${sh.text}`, description: sh.text, image: `${config.publicUrl}/og/sale/${cs[1]}.png`, url: sh.url })
      }
      const pr = pathRoute(p)
      if (pr) return page(res, describe(pr))
      if (!p.startsWith('/api/') && !p.startsWith('/og/') && file(res, p, req)) return
      // Anything else that is not the API is a real 404 page, with the site around it
      if (!p.startsWith('/api/') && !p.startsWith('/og/') && !p.startsWith('/c/') && !p.startsWith('/s/') && (req.headers.accept ?? '').includes('text/html')) return page(res, describe(null))
      return inner(req, res)
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'server_error' }); else res.end()
    }
  }
}
