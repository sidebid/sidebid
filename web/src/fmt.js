// Formatting and small drawing helpers shared by every view.
const ICON = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', x: '<path d="M4 4l16 16M20 4L4 20"/>', copy: '<path d="M9 9h11v11H9zM5 15H4V4h11v1"/>',
  ext: '<path d="M7 17L17 7M9 7h8v8"/>', arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>', check: '<path d="M4 12.5l5 5L20 6.5"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  gh: '<path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 00-6 0C6.8 2.8 5.8 3.1 5.8 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004.4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  xlogo: '<path d="M4 4l6.6 8.6L4.3 20h1.5l5.5-6.4L16 20h4l-7-9.1L18.9 4h-1.5l-5 5.9L8 4z"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', warn: '<path d="M12 4l9 16H3zM12 10v4M12 17v.5"/>',
}
export const icon = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const short = (s) => (s ? String(s).slice(0, 4) + '…' + String(s).slice(-4) : '')
export const sol = (n) => (!n ? '0' : n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4).replace(/0$/, ''))
export const lam = (v) => Number(BigInt(v ?? 0)) / 1e9
export const big = (n) => (n >= 1e9 ? +(n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : n >= 1 ? '' + Math.round(n * 100) / 100 : '' + +n.toPrecision(3))
export const full = (n) => (n >= 1 ? Math.round(n).toLocaleString('en-US') : '' + +n.toPrecision(4))
export const pctS = (p) => (p < 0.01 ? 'under 0.01%' : p < 10 ? p.toFixed(2).replace(/\.?0+$/, '') + '%' : p.toFixed(1).replace(/\.0$/, '') + '%')
export const clock = (s) => { s = Math.max(0, Math.ceil(s)); return s < 60 ? '0:' + String(s).padStart(2, '0') : s >= 3600 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
export const hhmm = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
export const agoS = (sec) => (sec < 60 ? Math.max(2, sec | 0) + 's ago' : sec < 3600 ? Math.floor(sec / 60) + 'm ago' : sec < 86400 ? Math.floor(sec / 3600) + 'h ago' : Math.floor(sec / 86400) + 'd ago')
export const hhmmss = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
/** A moment as a full UTC date and time, the way Solscan shows it: 2026-11-06 14:03:22 UTC */
export const utcFull = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC' }
/** A token balance read older than this is not shown as a fresh yes. */
export const HOLDS_FRESH_MS = 10 * 60_000
/**
 * "Holds these tokens" on a card: the answer and how long ago the indexer last read the seller's token account. An age reads
 * right in any time zone and on any day. When the last read failed the card says so instead of a green yes.
 */
export const holdsText = (v, t = Date.now()) => {
  if (v.closed) return 'Listing closed'
  if (v.fillable === null || v.fillable === undefined) return v.stale ? 'Last read failed' : 'Checking'
  if (!v.tokenCheckedAt) return v.stale ? 'Last read failed' : v.fillable ? 'Yes' : 'Not right now'
  const age = `checked ${agoS(Math.max(0, t - v.tokenCheckedAt) / 1000)}`
  return v.stale ? `Last read failed, ${age}` : v.fillable ? age[0].toUpperCase() + age.slice(1) : `Not right now, ${age}`
}
/** True only for a fresh, successful read that found the tokens: the one case drawn in green. */
export const holdsGood = (v, t = Date.now()) => !v.closed && !!v.fillable && !v.stale && (!v.tokenCheckedAt || t - v.tokenCheckedAt < HOLDS_FRESH_MS)
export const pad2 = (n) => String(n).padStart(2, '0')
/** Whole token amount as a JS number, from raw units. */
export const units = (raw, dec) => Number(BigInt(raw ?? 0)) / 10 ** (dec ?? 0)
/** "1.5" SOL to lamports, exactly, or null. */
export function parseSol(s) {
  // A comma is refused, never read as a decimal point: "1,000" must not become 1 SOL
  if (/,/.test(String(s ?? ''))) return null
  const m = /^\s*(\d{0,12})(?:\.(\d{0,9}))?\s*$/.exec(String(s ?? ''))
  if (!m || (!m[1] && !m[2])) return null
  return BigInt(m[1] || '0') * 1_000_000_000n + BigInt((m[2] || '').padEnd(9, '0'))
}
/** True when the text has a comma, so the field can say "use a dot". */
export const hasComma = (s) => /,/.test(String(s ?? ''))
/** Lamports as SOL, every digit kept, trailing zeros trimmed. Anything about to be signed shows this. */
export function solX(lamports) {
  const v = BigInt(lamports ?? 0), w = v / 1_000_000_000n, f = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return w.toLocaleString('en-US') + (f ? '.' + f : '')
}
/** Raw token units as a whole amount with every digit, the way a wallet shows it: 38,400,000 or 1,250.5 */
export function tokX(raw, dec) {
  const d = dec ?? 0, s = BigInt(raw ?? 0).toString().padStart(d + 1, '0'), w = d ? s.slice(0, -d) : s, f = d ? s.slice(-d).replace(/0+$/, '') : ''
  return w.replace(/\B(?=(\d{3})+$)/g, ',') + (f ? '.' + f : '')
}
/** Raw token units for an input box: every digit, no grouping commas. */
export const tokP = (raw, dec) => tokX(raw, dec).replace(/,/g, '')
/** A typed token amount to raw units, exactly, or null. Grouping commas like 150,000,000 are fine; a comma anywhere else,
 *  or more decimals than the coin has, is refused. */
export function parseTok(s, dec) {
  let t = String(s ?? '').trim()
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) t = t.replace(/,/g, '')
  const m = /^(\d{0,20})(?:\.(\d*))?$/.exec(t)
  if (!m || (!m[1] && !m[2])) return null
  const d = dec ?? 0, f = (m[2] ?? '').replace(/0+$/, '')
  if (f.length > d) return null
  return BigInt(m[1] || '0') * 10n ** BigInt(d) + BigInt(f.padEnd(d, '0') || '0')
}
/** How many raw units the sell form lists: the typed amount when there is one, else a share of the balance (100 by default). */
export const sellPick = (balance, pct, exact, dec) => (String(exact ?? '').trim() ? parseTok(exact, dec) : (BigInt(balance ?? 0) * BigInt(pct ?? 100)) / 100n)
/** Bidi controls and zero width characters out of chain text before it is shown. */
export const clean = (s) => String(s ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
/** Exact SOL for an input box: no grouping commas, since the box refuses commas. */
export const solP = (lamports) => solX(lamports).replace(/,/g, '')
export const solIn = (lamports) => { const v = Number(lamports) / 1e9; return v >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toFixed(4).replace(/\.?0+$/, '') }

export function seeded(seed) { let h = 2166136261; for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => (h = Math.imul(h ^ (h >>> 13), 1274126177), (h >>> 0) / 4294967296) }
const AV = [['#2438E8', '#A9C4FF', '#F3F5FF'], ['#6A34E5', '#E4DBFF', '#1B1140'], ['#0E9FC4', '#0B3B52', '#E6F7FC'], ['#1B2230', '#8A97AE', '#EEF1F7'], ['#D23BC6', '#40103C', '#FBE6F9'], ['#3B4A66', '#CFE9F5', '#101828']]
/** Picture addresses that failed once in this page: never asked for again, the drawn fallback stays. */
export const badImg = new Set()
/** A person: their X picture (through our own server) when we have one, else a pattern from their wallet. */
export function avatar(p, cls = '') {
  const label = p?.handle ? '@' + p.handle : short(p?.wallet)
  const r = seeded(p?.wallet || p?.handle || 'x'), c = AV[r() * AV.length | 0], a = r() * 360 | 0, x = 8 + r() * 16 | 0, y = 6 + r() * 14 | 0
  const svg = `<svg viewBox="0 0 32 32" role="img" aria-label="${esc(label)}"><rect width="32" height="32" fill="${c[0]}"/><circle cx="${x}" cy="${y}" r="10" fill="${c[1]}"/><rect x="10" y="17" width="26" height="18" rx="4" fill="${c[2]}" transform="rotate(${a % 40 - 20} 16 16)"/></svg>`
  // The X picture sits over the pattern, so a picture that fails to load leaves the pattern, not a broken image
  const src = p?.handle && p?.avatar && /^[A-Za-z0-9_]{1,15}$/.test(p.handle) ? `/api/site/xavatar/${p.handle}` : null
  const img = src && !badImg.has(src) ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : ''
  return `<span class="av avs ${cls}">${svg}${img}</span>`
}
export const whoText = (p) => (p?.handle ? '@' + p.handle : short(p?.wallet))
const XH_RE = /^[A-Za-z0-9_]{1,15}$/
/** An @handle as a link to the X profile, new tab. Inside another link (a card) it is a span the page opens by hand, since links cannot nest. A wallet stays plain text. */
export const xLink = (p, inLink = false) => {
  const h = p?.handle
  if (!h || !XH_RE.test(h)) return esc(whoText(p))
  return inLink ? `<span class="xh" role="link" tabindex="0" data-xh="${h}">@${h}</span>` : `<a class="xh" href="https://x.com/${h}" target="_blank" rel="noopener">@${h}</a>`
}
export const sellerEl = (p, cls = '', inLink = false) => `<span class="seller ${cls}">${avatar(p)}<span>${xLink(p, inLink)}</span></span>`
const COIN_BG = ['#2438E8', '#5B4FB0', '#6A34E5', '#0E9FC4', '#2B3550', '#5C82E0', '#D23BC6', '#1C8FB0', '#3B4A66', '#4B23B8', '#1766D9', '#6F7C95']
export const coinColors = (mint) => { const r = seeded('coin' + mint); return { bg: COIN_BG[r() * COIN_BG.length | 0], fg: '#FFFFFF' } }

// ---- the pre-launch mainnet test
export const LT_ORDER = ['Listing', 'Bid', 'Outbid refund', 'Settle', 'Fixed buy', 'Accept', 'Refund', 'Hourly payout']
/** The step's name as shown: the server's usual "Payout" label reads Hourly payout. */
export const ltLabel = (l) => ({ payout: 'Hourly payout' })[String(l ?? '').trim().toLowerCase()] ?? String(l ?? '')
/** The rows in step order (Listing first, Hourly payout last), any other label after them in the order stored. */
export const ltRows = (items) => {
  const rank = (x) => { const i = LT_ORDER.indexOf(ltLabel(x.label)); return i < 0 ? LT_ORDER.length : i }
  return (Array.isArray(items) ? items : []).map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map(({ x }) => x)
}
/** A block time as "6 Nov 2026 18:02 UTC". */
export const utcWhen = (t) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).replace(',', '') + ' UTC'

// ---- X post card: a post from our own account, drawn from the stored post (never X's embed script), in X's layout
/** "7:02 PM · Nov 6, 2026", the way X dates a post. */
export const xTime = (ms) => {
  const d = new Date(ms)
  return `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}
/** Post text as X shows it: cashtags and links in blue, links shortened, line breaks kept. */
export const xText = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<span class="xc-l">${u.replace(/^https?:\/\//, '').slice(0, 30)}${u.replace(/^https?:\/\//, '').length > 30 ? '…' : ''}</span>`).replace(/(^|\s)(\$[A-Za-z][A-Za-z0-9]{0,11})\b/g, '$1<span class="xc-l">$2</span>').replace(/\n/g, '<br>')
const XC_LOGO = '<svg class="xc-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.36 5.77zm-1.08 16.18h1.7L7.4 4.73H5.58z" fill="currentColor"/></svg>'
const XC_TICK = '<svg class="xc-v" viewBox="0 0 22 22" aria-label="Verified account"><path d="M20.4 11c0-1.3-.8-2.4-1.9-2.9.4-1.2.2-2.6-.7-3.5-.9-.9-2.3-1.1-3.5-.7C13.8 2.8 12.6 2 11.3 2s-2.4.8-2.9 1.9c-1.2-.4-2.6-.2-3.5.7-.9.9-1.1 2.3-.7 3.5C3.1 8.6 2.3 9.7 2.3 11s.8 2.4 1.9 2.9c-.4 1.2-.2 2.6.7 3.5.9.9 2.3 1.1 3.5.7.5 1.1 1.6 1.9 2.9 1.9s2.4-.8 2.9-1.9c1.2.4 2.6.2 3.5-.7.9-.9 1.1-2.3.7-3.5 1.1-.5 1.9-1.6 1.9-2.9zm-11.1 4.2L5.9 11.8l1.3-1.3 2.1 2.1 4.8-5.2 1.4 1.3z" fill="currentColor"/></svg>'
/**
 * The card. `inLink`: it sits inside another link (a listing card), so the post opens through data-xurl rather than a nested
 * link. A preview post says so and links to nothing on X.
 */
export function xPostCard(post, { compact = false, inLink = false } = {}) {
  if (!post) return ''
  const a = post.author ?? {}, h = XH_RE.test(a.handle ?? '') ? a.handle : null
  const pic = h && a.avatar ? `/api/site/xavatar/${h}` : '/brand/logo-96.png'
  const href = !post.preview && post.url && /^https:\/\/x\.com\//.test(post.url) ? post.url : null
  const foot = `<span class="xc-f">${post.at ? `<time>${esc(xTime(post.at))}</time>` : ''}${href ? '<span class="xc-o">View on X</span>' : ''}</span>`
  const inner = `<span class="xc-h"><span class="xc-av"><img src="${pic}" alt="" loading="lazy" decoding="async"></span><span class="xc-n"><b>${esc(a.name || h || 'X')}${a.verified ? XC_TICK : ''}</b><span>${h ? '@' + h : ''}</span></span>${XC_LOGO}</span><span class="xc-t" data-nosol>${xText(post.text)}</span>${foot}${post.preview ? '<span class="xc-p">Preview post, not on X</span>' : ''}`
  const cls = `xcard${compact ? ' sm' : ''}${post.preview ? ' pv' : ''}`
  if (!href) return `<span class="${cls}">${inner}</span>`
  return inLink ? `<span class="${cls}" role="link" tabindex="0" data-xurl="${esc(href)}" aria-label="Open the post on X">${inner}</span>` : `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="Open the post on X">${inner}</a>`
}
