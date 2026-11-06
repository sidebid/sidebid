// The site's view of the world: everything comes from the server API, the chain, or the runtime config. Polls keep it
// fresh and tell the views what changed.
import { lam, units, short, clean } from './fmt.js'
import { coinInfo, connection } from './chain.js'
import { market } from './prices.js'

export const D = {
  cfg: null, skew: 0, lots: new Map(), board: [], sales: [], activity: [], people: {}, lotMeta: new Map(), events: new Map(),
  coins: new Map(), markets: new Map(), coinLots: new Map(), coinSales: new Map(), rewards: null, trust: null, deployAt: null, feed: [], feedOlder: [], feedEnd: false, dropPlan: null, stats: null, log: null, launchTest: null, rewardsTried: false, me: { signedIn: false }, credits: [], mine: [], sellers: new Map(), loaded: false,
}
export const now = () => Date.now() + D.skew
const listeners = new Set()
export const onData = (f) => listeners.add(f)
const emit = (what) => listeners.forEach((f) => { try { f(what) } catch (e) { console.error(e) } })

export async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } })
  const d = Date.parse(r.headers.get('date') ?? '')
  if (d && !opts.method) D.skew = D.skew * 0.8 + (d + 500 - Date.now()) * 0.2
  let body = null
  try { body = await r.json() } catch {}
  return { ok: r.ok, status: r.status, body }
}
export const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

/**
 * Whether the sell page may offer Sign. Both reads must be in: the coin's info (its decimals make the approval line match the
 * wallet) and a fresh RPC read of the listing address these tokens would use. Until then the button says what it waits for.
 */
export function sellGate(info, check, coinFailed = false) {
  if (!info) return coinFailed ? { ok: false, label: 'Coin read failed, try again', retry: true } : { ok: false, label: 'Reading the coin…' }
  if (!check || check.state === 'checking') return { ok: false, label: 'Checking the chain…' }
  if (check.state === 'error') return { ok: false, label: 'Chain check failed, try again', retry: true }
  if (check.state === 'listed') return { ok: false, label: 'Already listed', listed: true }
  return { ok: true }
}

// ---- coins, read from chain once and kept. A failed read is said so (the views offer Check again) and is asked again
// by itself only after a pause, so a page that redraws on every answer never loops on a bad RPC.
const asking = new Set(), failedAt = new Map()
const COIN_RETRY_MS = 15_000
export const coinFailed = (mint) => failedAt.has(mint)
export function retryCoin(mint) { failedAt.delete(mint); return coin(mint) }
export function coin(mint) {
  if (!mint) return null
  const c = D.coins.get(mint)
  if (c !== undefined) return c
  const f = failedAt.get(mint)
  if (f !== undefined && Date.now() - f < COIN_RETRY_MS) return null
  if (!asking.has(mint)) {
    asking.add(mint)
    coinInfo(mint).then((info) => { failedAt.delete(mint); D.coins.set(mint, info); emit('coin') }).catch(() => { asking.delete(mint); failedAt.set(mint, Date.now()); emit('coin') })
    if (D.cfg?.priceFeed) market(mint, true).then((m) => { D.markets.set(mint, m); if (m) emit('coin') })
  }
  return null
}
export const ticker = (mint) => { const c = coin(mint); const sym = clean(c?.symbol).trim(); return sym ? sym.toUpperCase().slice(0, 12) : short(mint).replace('…', '') }

/** A listing as the views use it. Derived on every call, so it is never stale against its view. */
export function lot(v) {
  const c = coin(v.mint), m = D.markets.get(v.mint) ?? null, meta = D.lotMeta.get(v.pubkey) ?? {}
  const dec = v.decimals ?? c?.decimals ?? 0
  const amt = units(v.amount, dec)
  const supply = c ? units(c.supply, c.decimals) : null
  const p = { wallet: v.seller.wallet, handle: v.seller.handle, avatar: v.seller.avatar }
  const startS = meta.listedAt ?? null, origEnd = v.mode === 'fixed' ? v.endTime : (v.hardEndTime ? v.hardEndTime - 300 : v.endTime)
  return {
    id: v.pubkey, v, mint: v.mint, t: ticker(v.mint), name: clean(c?.name).trim() || 'Unnamed coin', img: c?.image ?? null, coin: c,
    amt, pct: supply ? (amt / supply) * 100 : null, dec,
    mode: v.mode === 'fixed' ? 'fixed' : 'bid', tagged: v.mode === 'accept', onePer: !!v.pass, drop: v.drop ?? null,
    top: lam(v.topBid), min: BigInt(v.price ?? 0) > 1_000_000n && v.mode !== 'fixed' ? lam(v.price) : 0, price: lam(v.price),
    end: (v.endTime ?? 0) * 1000, len: startS && origEnd ? Math.max(10, origEnd - startS) : 300,
    seller: p, lotNo: meta.lot ?? null, listedAt: startS ? startS * 1000 : null, bidsN: meta.bids ?? (v.topBid !== '0' ? 1 : 0),
    chart: m ? m.priceSol * amt : null, pool: m?.poolSol ?? null, pair: m?.pair ?? null,
    auth: c ? { mint: !!c.mintAuthority, freeze: !!c.freezeAuthority } : null,
  }
}
/**
 * The bid stream on a live card. The listing account can show a top bid before its BidPlaced event is indexed, so the
 * card never says it waits for a first bid while it shows one: the top bid stands in as the first row.
 */
export function bidStream(l, bids) {
  const has = l.top > 0 && !!l.v?.topBidder
  const rows = bids.length || !has ? bids : [{ p: person(l.v.topBidder), sol: l.top, at: null, tx: null }]
  const n = Math.max(bids.length, l.bidsN ?? 0, has ? 1 : 0)
  return { n, rows }
}
export const lotById = (id) => { const v = D.lots.get(id); return v ? lot(v) : null }

// ---- people
export const person = (wallet) => ({ wallet, ...(D.people[wallet] ?? {}) })
export function sellerFacts(wallet) {
  const s = D.sellers.get(wallet)
  if (s !== undefined) return s
  D.sellers.set(wallet, null)
  api(`/api/site/seller/${wallet}`).then((r) => { if (r.ok) { D.sellers.set(wallet, r.body); emit('seller') } })
  return null
}

// ---- loads
export async function loadBoard() {
  const r = await api('/api/listings?live=true&limit=100')
  if (!r.ok) return false
  const items = r.body.items ?? []
  const before = new Map([...D.lots].map(([k, v]) => [k, v]))
  for (const v of items) D.lots.set(v.pubkey, v)
  D.board = items.map((v) => v.pubkey)
  const fresh = items.filter((v) => !D.lotMeta.has(v.pubkey) || (before.get(v.pubkey)?.topBid ?? v.topBid) !== v.topBid).map((v) => v.pubkey)
  if (fresh.length) await loadMeta(fresh)
  D.loaded = true
  emit({ kind: 'board', before })
  return true
}
export async function loadMeta(keys) {
  for (let i = 0; i < keys.length; i += 100) {
    const r = await api(`/api/site/lots?keys=${keys.slice(i, i + 100).join(',')}`)
    if (r.ok) for (const [k, m] of Object.entries(r.body)) D.lotMeta.set(k, m)
  }
}
export async function loadOne(pk) {
  const before = D.lots.get(pk)
  const [r, e] = await Promise.all([api(`/api/listings/${pk}`), api(`/api/site/events/${pk}`)])
  if (r.ok) D.lots.set(pk, r.body)
  if (e.ok) { D.events.set(pk, e.body.items); Object.assign(D.people, e.body.people); D.lotMeta.set(pk, { lot: e.body.lot, listedAt: e.body.listedAt, bids: e.body.items.filter((x) => x.name === 'BidPlaced').length }) }
  emit({ kind: 'one', pk, before })
  return r.ok ? r.body : r.status === 404 ? null : before ?? null
}
/** Every listing and sale of one coin, for its page. */
export async function loadCoin(mint) {
  const [l, s] = await Promise.all([api(`/api/listings?mint=${mint}&limit=100`), api(`/api/sales?mint=${mint}&limit=100`)])
  if (l.ok) { for (const v of l.body.items ?? []) D.lots.set(v.pubkey, v); D.coinLots.set(mint, (l.body.items ?? []).map((v) => v.pubkey)); const keys = (l.body.items ?? []).filter((v) => !D.lotMeta.has(v.pubkey)).map((v) => v.pubkey); if (keys.length) await loadMeta(keys) }
  if (s.ok) D.coinSales.set(mint, s.body.items ?? [])
  coin(mint)
  emit('coinpage')
}
export async function loadActivity() {
  const [a, s] = await Promise.all([api('/api/site/activity?limit=40'), api('/api/sales?limit=100')])
  if (a.ok) { D.activity = a.body.items; Object.assign(D.people, a.body.people) }
  if (s.ok) D.sales = s.body.items
  emit('activity')
}
export async function loadRewards() {
  const r = await api('/api/rewards').catch(() => ({ ok: false }))
  D.rewardsTried = true
  D.rewards = r.ok && r.body && r.body.hour ? r.body : null
  if (D.rewards) for (const s of [...(D.rewards.hour.standings ?? []), ...(D.rewards.past ?? []).flatMap((h) => h.payouts ?? [])]) if (s.wallet && s.handle) D.people[s.wallet] = { handle: s.handle, avatar: s.avatar ?? null }
  emit('rewards')
}
export async function loadMe() {
  const r = await api('/api/me')
  if (r.ok && r.body) D.me = r.body // a failed read keeps what we knew, it never signs anyone out
  emit('me')
}
export async function loadMine(wallet) {
  if (!wallet) { D.credits = []; D.mine = []; emit('mine'); return }
  const [c, m] = await Promise.all([api(`/api/credits/${wallet}`), api(`/api/listings?seller=${wallet}&limit=100`)])
  D.credits = c.ok ? c.body.items : []
  D.mine = m.ok ? m.body.items.filter((v) => !v.closed) : []
  for (const v of D.mine) D.lots.set(v.pubkey, v)
  emit('mine')
}

/** The public drop schedule from the runtime config: { at (ms), mode, amount, pct, note } or []. */
export function drops(n = 6) {
  const d = D.cfg?.drops
  if (!d || !d.every || !Array.isArray(d.pattern) || !d.pattern.length) return []
  const step = d.every * 1000, start = (d.start ?? 0) * 1000, until = d.until ? d.until * 1000 : Infinity, t = now()
  let k = Math.max(0, Math.ceil((t + 1000 - start) / step))
  const out = []
  while (out.length < n) {
    const at = start + k * step
    if (at > until) break
    const p = d.pattern[k % d.pattern.length]
    out.push({ at, mode: p.mode === 'fixed' ? 'Fixed price' : 'Live auction', amount: p.amount, pct: p.pct ?? '', note: p.note ?? '' })
    k++
  }
  return out
}

/** This hour, from the rewards API when it answers, else from completed sales. Never invents a payout. */
export function rewardsModel() {
  const H = 3_600_000, r = D.rewards
  // No route means rewards are not running yet; paused means the server stopped paying. Either way no countdown promise.
  const state = !r ? 'off' : r.paused === true ? 'paused' : 'on'
  if (r) {
    return {
      api: true, state, start: r.hour.start * 1000, end: r.hour.end * 1000, payoutAt: (r.hour.payoutAt ?? r.hour.end) * 1000, split: r.split ?? [50, 30, 20],
      pot: r.hour.potLamports != null ? lam(r.hour.potLamports) : null, potKind: r.hour.potKind ?? 'estimate', potAll: r.hour.potAllLamports != null ? lam(r.hour.potAllLamports) : null, fees: r.hour.feesLamports != null ? lam(r.hour.feesLamports) : null,
      standings: (r.hour.standings ?? []).map((s) => ({ p: person(s.wallet), sol: lam(s.receivedLamports), sales: s.sales, pay: s.projectedLamports != null ? lam(s.projectedLamports) : null })),
      past: (r.past ?? []).map((h) => ({ start: h.start * 1000, end: h.end * 1000, status: h.status, pot: h.potLamports != null ? lam(h.potLamports) : null, claim: h.claimSig, sales: h.sales, payouts: (h.payouts ?? []).map((p) => ({ rank: p.rank, p: person(p.wallet), pay: lam(p.lamports), sig: p.sig })) })),
    }
  }
  const start = Math.floor(now() / H) * H, m = {}
  for (const s of D.sales) {
    if (!s.at || s.at * 1000 < start || !s.seller) continue
    const x = m[s.seller] ?? (m[s.seller] = { p: person(s.seller), sol: 0, sales: 0, pay: null, first: s.at })
    x.sol += lam(s.price); x.sales++; x.first = Math.min(x.first, s.at)
  }
  return { api: false, state, start, end: start + H, payoutAt: start + H, split: [50, 30, 20], pot: null, potKind: null, standings: Object.values(m).sort((a, b) => b.sol - a.sol || a.first - b.first), past: [] }
}

// ---- trust, every transaction, stats, log
export async function loadTrust() {
  const r = await api('/api/site/trust').catch(() => ({ ok: false }))
  if (r.ok && r.body) { D.trust = r.body; emit('trust') }
  // The date of the last deploy, from the block time of the slot the program data names
  const slot = D.trust?.upgrade?.deploySlot
  if (slot && D.deployAt?.slot !== slot) {
    D.deployAt = { slot, t: null }
    connection()?.getBlockTime(slot).then((t) => { if (t && D.deployAt?.slot === slot) { D.deployAt = { slot, t }; emit('trust') } }).catch(() => {})
  }
}
/** One more page of the feed, older than what is shown. The cut is one second past the oldest row, so rows sharing
 * that second are fetched again rather than skipped; the view shows each row once. */
export async function loadFeedOlder() {
  const all = [...D.feed, ...D.feedOlder], last = all[all.length - 1]
  if (!last?.at) { D.feedEnd = true; emit('feed'); return }
  const r = await api(`/api/site/feed?limit=100&before=${last.at + 1}`).catch(() => ({ ok: false }))
  if (!r.ok || !r.body) return
  const items = r.body.items ?? [], key = (e) => `${e.kind}|${e.sig}|${e.listing ?? ''}|${e.place ?? ''}|${(e.wallets ?? []).join(',')}`, have = new Set(all.map(key))
  let fresh = items.filter((e) => !have.has(key(e)))
  if (!fresh.length && items.length) {
    const r2 = await api(`/api/site/feed?limit=100&before=${last.at}`).catch(() => ({ ok: false }))
    fresh = (r2.body?.items ?? []).filter((e) => !have.has(key(e)))
  }
  D.feedOlder.push(...fresh); Object.assign(D.people, r.body.people ?? {})
  if (!fresh.length) D.feedEnd = true
  emit('feed')
}
export async function loadFeed(limit = 40) {
  const r = await api(`/api/site/feed?limit=${limit}`).catch(() => ({ ok: false }))
  if (r.ok && r.body) { D.feed = r.body.items ?? []; Object.assign(D.people, r.body.people ?? {}); emit('feed') }
}
export async function loadStats() {
  const r = await api('/api/site/stats').catch(() => ({ ok: false }))
  if (r.ok && r.body) { D.stats = r.body; emit('stats') }
}
export async function loadLog() {
  const r = await api('/api/site/log').catch(() => ({ ok: false }))
  D.log = r.ok && r.body ? r.body.items ?? [] : []
  emit('log')
}
/** The pre-launch mainnet test: each step's transaction with its status read from chain. Empty until the test is run. */
/** The dev drops: the plan, each drop's outcome and its post on X. { plan: null } before the owner starts it. */
export async function loadDrops() {
  const r = await api('/api/site/drops').catch(() => ({ ok: false }))
  if (r.ok && r.body) { D.dropPlan = r.body.plan ? r.body : null; emit('drops') }
}
/** The next drop that has not listed yet, from the started plan: { n, of, at, amount, pct } or null. */
export function nextPlanDrop() {
  const p = D.dropPlan
  if (!p?.plan) return null
  return p.drops.find((d) => d.state === 'pending' && d.at > now() - 30_000) ?? null
}
export async function loadLaunchTest() {
  const r = await api('/api/site/launch-test').catch(() => ({ ok: false }))
  if (r.ok && r.body) { D.launchTest = Array.isArray(r.body.items) ? r.body.items.filter((x) => x && typeof x.sig === 'string' && typeof x.label === 'string') : []; emit('launchTest') }
}
