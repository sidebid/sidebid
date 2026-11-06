// Share cards: a generated picture per listing and per sale, and a post that opens written with one tap.
// Only facts from the chain go on a card. Brand style: black, cream, orange for the action, a blue dot as the accent.
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas'
import { existsSync } from 'node:fs'
import { fmtSol } from './x/replies.mjs'

// The site's own type: Hubot Sans Expanded for display, Albert Sans for text, Spline Sans Mono for figures
const font = (f) => new URL(`./fonts/${f}.woff`, import.meta.url).pathname
GlobalFonts.registerFromPath(font('hubot-sans-expanded-800'), 'CardBold')
GlobalFonts.registerFromPath(font('albert-sans-500'), 'CardText')
GlobalFonts.registerFromPath(font('spline-sans-mono-600'), 'CardFig')
const W = 1200, H = 630
const C = { bg: '#060606', ink: '#F4F0E9', ink2: '#ABA79F', acc: '#FF5A0A', blue: '#1F3BFF' }
const fit = (ctx, text, max) => { let t = String(text); if (ctx.measureText(t).width <= max) return t; while (t && ctx.measureText(`${t}...`).width > max) t = t.slice(0, -1); return `${t.trimEnd()}...` }
const latin = (s) => /^[\x20-\x7e]*$/.test(String(s ?? '')) // the bundled font would print others as boxes
const short = (a) => `${String(a).slice(0, 4)}...${String(a).slice(-4)}`

export function tokenText(amount, decimals) {
  const s = BigInt(amount).toString().padStart((decimals ?? 0) + 1, '0')
  const d = decimals ?? 0, w = d ? s.slice(0, -d) : s, f = d ? s.slice(-d).replace(/0+$/, '').slice(0, 4) : ''
  return `${w.replace(/\B(?=(\d{3})+$)/g, ',')}${f ? `.${f}` : ''}`
}

/** The logo and the wordmark, cut from the brand art in web/brand. Without the files a card falls back to the name. */
const LOGO = new URL('../../web/brand/logo-400.png', import.meta.url).pathname
const WORD = new URL('../../web/brand/wordmark-160.png', import.meta.url).pathname
let art = null
const brandArt = async () => art ??= {
  logo: existsSync(LOGO) ? await loadImage(LOGO).catch(() => null) : null,
  word: existsSync(WORD) ? await loadImage(WORD).catch(() => null) : null,
}
/** Draws the logo at height h with the wordmark beside it; any other brand name is set in type. Returns the right edge. */
async function lockup(c, brand, x, y, h) {
  const { logo, word } = await brandArt(), own = /^sidebid$/i.test(String(brand?.name ?? 'Sidebid'))
  let r = x
  if (logo) { const w = Math.round((logo.width * h) / logo.height); c.drawImage(logo, x, y, w, h); r = x + w + Math.round(h * 0.3) }
  if (own && word) { const wh = Math.round(h * 0.74), ww = Math.round((word.width * wh) / word.height); c.drawImage(word, r, y + (h - wh) / 2 + h * 0.04, ww, wh); return r + ww }
  const name = brand?.name && latin(brand.name) ? brand.name : 'Sidebid'
  c.font = `${Math.round(h * 0.5)}px CardBold`; c.fillStyle = C.ink; c.textBaseline = 'middle'; c.fillText(fit(c, name, 700), r, y + h / 2)
  return r + c.measureText(name).width
}

const DEFAULT_BRAND = { name: 'Sidebid', tagline: 'Sell your tokens, not the chart. The best bid in a live auction takes them.' }
async function frame(draw, brand = DEFAULT_BRAND) {
  const cv = createCanvas(W, H), c = cv.getContext('2d')
  c.fillStyle = C.bg; c.fillRect(0, 0, W, H)
  await lockup(c, brand, 70, 52, 64)
  c.textBaseline = 'middle'
  await draw(c)
  c.font = '26px CardText'; c.fillStyle = C.ink2; c.fillText(fit(c, brand.tagline ?? DEFAULT_BRAND.tagline, 1040), 70, 570)
  return cv.encode('png') // on the thread pool: the keeper and everything else keep running
}
async function sellerLine(c, seller, y) {
  c.font = '32px CardText'; c.fillStyle = C.ink
  const h = seller?.handle && latin(seller.handle) ? `@${seller.handle}` : short(seller?.wallet ?? '')
  c.fillText(fit(c, h, 900), 70, y)
}
const amountLine = (c, text, y) => { c.font = '64px CardFig'; c.fillStyle = C.ink; c.fillText(fit(c, text, 1060), 70, y) }
const coinLine = (c, mint, y) => { c.font = '28px CardFig'; c.fillStyle = C.ink2; c.fillText(`Coin ${short(mint)}`, 70, y) }
const priceLine = (c, text, y) => { c.font = '60px CardFig'; c.fillStyle = C.acc; c.fillText(fit(c, text, 1060), 70, y) }

export const listingCard = (v, brand) => frame(async (c) => {
  await sellerLine(c, v.seller, 190)
  amountLine(c, `${tokenText(v.amount, v.decimals)} tokens`, 280)
  coinLine(c, v.mint, 352)
  priceLine(c, v.topBid !== '0' ? `Top bid ${fmtSol(v.topBid)} SOL` : v.mode === 'fixed' ? `${fmtSol(v.price)} SOL` : `From ${fmtSol(v.price)} SOL`, 450)
}, brand)
export const saleCard = (s, brand) => frame(async (c) => {
  c.font = '30px CardBold'; const tw = c.measureText('SOLD').width
  c.fillStyle = C.blue; c.beginPath(); c.roundRect(70, 166, tw + 44, 50, 25); c.fill()
  c.fillStyle = C.ink; c.fillText('SOLD', 92, 192)
  amountLine(c, `${tokenText(s.amount, s.decimals ?? 0)} tokens`, 280)
  coinLine(c, s.mint ?? '', 352)
  priceLine(c, `${fmtSol(s.price)} SOL`, 450)
}, brand)

/** The site's own share picture: the lockup and the line on the left, the auctioneer from the banner on the right. */
const STAGE = new URL('../../web/brand/og-stage.jpg', import.meta.url).pathname
let stage
export async function siteCard(brand = {}) {
  const cv = createCanvas(W, H), c = cv.getContext('2d')
  c.fillStyle = C.bg; c.fillRect(0, 0, W, H)
  stage ??= existsSync(STAGE) ? await loadImage(STAGE).catch(() => null) : null
  if (stage) {
    const sw = Math.round((stage.width * H) / stage.height), sx = W - sw + 70 // the curtain edge goes off the right
    c.drawImage(stage, sx, 0, sw, H)
    // a soft fade into the black on the left, so the art has no edge
    const g = c.createLinearGradient(sx, 0, sx + 330, 0)
    g.addColorStop(0, C.bg); g.addColorStop(0.4, 'rgba(6,6,6,.85)'); g.addColorStop(1, 'rgba(6,6,6,0)')
    c.fillStyle = g; c.fillRect(sx, 0, 330, H)
  }
  await lockup(c, brand, 72, 88, 104)
  c.textBaseline = 'alphabetic'
  c.font = '54px CardBold'; c.fillStyle = C.ink; c.fillText(fit(c, 'Sell your tokens,', 600), 72, 344)
  c.fillStyle = C.acc; c.fillText(fit(c, 'not the chart.', 600), 72, 414)
  c.fillStyle = C.blue; c.beginPath(); c.arc(82, 522, 8, 0, Math.PI * 2); c.fill()
  c.font = '26px CardText'; c.fillStyle = C.ink2; c.fillText('Live auctions for Solana tokens,', 104, 531); c.fillText('settled in one transaction.', 104, 567)
  return cv.encode('png')
}

const intent = (text, url) => `https://x.com/intent/post?${new URLSearchParams({ text, url })}`
export function listingShare(v, base) {
  const url = `${base}/c/${v.pubkey}`
  const text = v.mode === 'fixed' ? `Selling ${tokenText(v.amount, v.decimals)} tokens for ${fmtSol(v.price)} SOL. First buyer takes it.` : `Selling ${tokenText(v.amount, v.decimals)} tokens to the best offer. The chart never moves.`
  return { text, url, intent: intent(text, url) }
}
export function saleShare(s, base) {
  const url = `${base}/s/${s.sig}`
  const text = `Sold ${tokenText(s.amount, s.decimals ?? 0)} tokens for ${fmtSol(s.price)} SOL. The chart never moved.`
  return { text, url, intent: intent(text, url) }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** The page a shared link opens: tags for the card now. The real page replaces its body when the site exists. */
export function ogPage({ title, description, image, url }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="${esc(image)}"><meta property="og:url" content="${esc(url)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(image)}"></head><body><h1>${esc(title)}</h1><p>${esc(description)}</p></body></html>`
}
