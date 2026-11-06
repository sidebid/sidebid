// Option D on real data. Views are strings, as in the approved prototype; data comes from data.js, every action that
// moves something is a real transaction through chain.js, signed only by the connected wallet.
import './polyfill.js'
import { xPostCard, xLink, badImg, icon, esc, short, sol, lam, big, full, pctS, clock, hhmm, holdsText, holdsGood, utcFull, agoS, pad2, parseSol, solIn, solX, solP, tokX, tokP, sellPick, hasComma, clean, avatar, sellerEl, whoText, coinColors, units, ltLabel, ltRows, utcWhen } from './fmt.js'
import { DIAGRAMS, WHY, PROOF, DOCS, steps, upgradeLine, lockText, chartMath } from './tech.js'
import * as W from './wallet.js'
import * as CH from './chain.js'
import { program, minimumNextBid } from './program.js'
import { lastHour } from './prices.js'
import { routeOf, fromHash } from './routes.js'
import { watchSol } from './solmark.js'
import { watchX } from './xname.js'
import { loadCoin, D, now, api, post, onData, coin, ticker, lot, lotById, person, sellerFacts, loadBoard, loadOne, loadActivity, loadRewards, loadMe, loadMine, loadMeta, drops, rewardsModel, loadTrust, loadFeed, loadFeedOlder, loadStats, loadLog, loadLaunchTest, loadDrops, nextPlanDrop, sellGate, coinFailed, retryCoin, bidStream } from './data.js'

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)]
let C = null, P = null, B = null
const S = { filter: 'All', sort: 'Ending soon', q: '', then: null, mine: {}, bidDraft: {}, msg: {}, busy: null, sell: { i: 0, pct: 100, exact: '', mode: 'bid', minKey: 'none', len: 300, custom: '', done: null, coins: null, check: {} }, seen: false }
const HOUR = 3_600_000, SPLIT = [50, 30, 20]

// ---------- small parts
const txUrl = (sig) => `${C.chain.explorer}/tx/${sig}${C.chain.cluster === 'mainnet-beta' ? '' : C.chain.cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(C.chain.rpc)}` : `?cluster=${C.chain.cluster}`}`
const acctUrl = (a) => `${C.chain.explorer}/account/${a}${C.chain.cluster === 'mainnet-beta' ? '' : C.chain.cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(C.chain.rpc)}` : `?cluster=${C.chain.cluster}`}`
const txLink = (sig, label) => sig ? `<a class="txl num" href="${txUrl(sig)}" target="_blank" rel="noopener">${label || short(sig)}${icon('ext')}</a>` : ''
const X_URL = () => (B.xHandle ? 'https://x.com/' + B.xHandle : null)
const xName = () => (B.xHandle ? '@' + B.xHandle : 'our X account')
const tag = (t, cls = '') => `<span class="tag ${cls}">${t}</span>`
const head = (n, k, h, aside = '') => `<header class="shead"><div><p class="eyebrow"><span>${n}</span>${k}</p><h2 class="h2">${h}</h2></div>${aside}</header>`
const leftS = (l) => (l.end - now()) / 1000
const art = (l, cls = '') => {
  const c = l.neutral ? { bg: '#2A2A2A', fg: '#ABA79F' } : l.mint && l.mint === B.ca ? { bg: '#FF5A0A', fg: '#0A0A0A' } : coinColors(l.mint), t = l.neutral ? '?' : l.t
  const src = l.img ?? (l.mint ? `/api/site/coinimg/${l.mint}` : null), img = src && !badImg.has(src) ? src : null
  const inner = (img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : '') + `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><text x="32" y="${t.length > 3 ? 39 : 42}" text-anchor="middle" font-size="${t.length > 4 ? 15 : t.length > 3 ? 18 : 24}" font-weight="800" fill="currentColor">${esc(t.slice(0, 5))}</text></svg>`
  return `<div class="art ${cls} ${img ? 'has-img' : ''}" style="--c:${c.bg};--f:${c.fg}">${inner}</div>`
}
const official = (mint) => !!B.ca && mint === B.ca
/** A coin that wears the brand ticker but is not the brand's CA says so, so a copy can't pass as the real one. */
const coinMark = (l) => official(l.mint) ? `<span class="okmark" title="The official $${esc(B.ticker)} contract address">${icon('check')}</span>` : l.t.toUpperCase() === B.ticker.toUpperCase() ? `<span class="tag warn sm" title="Same ticker as $${esc(B.ticker)}, different contract address">Not official</span>` : ''
const artMint = (mint, cls = '') => { const c = coin(mint); return art({ mint, t: ticker(mint), img: c?.image ?? null }, cls) }
const authBadge = (l, cls = '') => {
  if (!l.auth || (!l.auth.mint && !l.auth.freeze)) return ''
  const sm = cls.includes('sm'), t = l.auth.mint && l.auth.freeze ? (sm ? 'Mint, freeze' : 'Mint and freeze on') : l.auth.mint ? (sm ? 'Mint on' : 'Mint authority on') : sm ? 'Freeze on' : 'Freeze authority on'
  return `<span class="tag warn ${cls}" title="Read from chain: this coin can still ${l.auth.mint ? 'mint more tokens' : ''}${l.auth.mint && l.auth.freeze ? ' and ' : ''}${l.auth.freeze ? 'freeze holders' : ''}.">${icon('warn')}${t}</span>`
}
const liveDot = (l) => `<span class="live" data-status="${l.id}"><i></i>${leftS(l) < 60 ? 'Ending' : 'Live'}</span>`
const lotHref = (l) => '/lot/' + l.id
/** A dev drop says so: everyone may know these are the dev's own tokens. */
const dropTag = (l, cls = '') => (l.drop ? tag(`Dev drop ${l.drop.n} of ${l.drop.of}`, `drop ${cls}`) : '')
const dropBy = (l) => (l.drop?.author?.handle ? '@' + esc(l.drop.author.handle) : esc(xName()))
/** An address in HTML: base58 is case sensitive, so it never takes the uppercase of the text around it. */
const addrEl = (a) => `<span class="addr">${short(a)}</span>`
const lotNo = (l) => (l.lotNo ? 'Lot ' + String(l.lotNo).padStart(3, '0') : 'Listing ' + addrEl(l.id))
const hasBids = (l) => l.v.topBid !== '0'
const priceOf = (l) => (l.mode === 'fixed' ? l.price : hasBids(l) ? l.top : l.min || 0)
const nextBidL = (l) => lam(l.v.nextMinBid ?? minimumNextBid(l.v.topBid, l.v.price))
const vsTxt = (l) => {
  const v = priceOf(l)
  if (l.chart && v) { const d = Math.round((v / l.chart - 1) * 100); return d === 0 ? 'At chart price' : Math.abs(d) + '% ' + (d < 0 ? 'under' : 'over') + ' chart' }
  if (l.mode === 'fixed') return l.onePer ? 'One per X account' : 'First buyer takes it'
  return hasBids(l) ? `Next bid ${sol(nextBidL(l))} SOL` : 'Bidders set the price'
}
const topLabel = (l) => (l.mode === 'fixed' ? 'This price only' : hasBids(l) ? 'Top bid' : l.min ? 'Opens at' : 'Opening')
/** The headline price in lamports, for the exact figure on the lot page. */
const priceLam = (l) => (l.mode === 'fixed' ? l.v.price : hasBids(l) ? l.v.topBid : l.min ? l.v.price : 0)
const topInner = (l, exact = false) => (priceOf(l) ? `<span class="n">${exact ? solX(priceLam(l)) : sol(priceOf(l))}</span><small> SOL</small>` : '<span class="n">Any bid</span>')
const topNum = (l, t = 'b', cls = 'topnum', exact = false) => `<${t} class="${cls}" data-top="${l.id}">${topInner(l, exact)}</${t}>`
const cdEl = (l, cls = '') => `<span class="cd num ${cls} ${leftS(l) < 60 ? 'low' : ''}" data-cd="${l.id}" data-end="${l.end}">${clock(leftS(l))}</span>`
const barEl = (l, cls = '') => `<div class="tbar ${cls}" role="presentation"><i data-bar="${l.id}" data-end="${l.end}" data-len="${l.len}" style="transform:scaleX(${Math.max(0.02, Math.min(1, leftS(l) / l.len))})"></i></div>`
const bidsOf = (l) => (D.events.get(l.id) ?? []).filter((e) => e.name === 'BidPlaced').map((e) => ({ p: person(e.data.bidder), sol: lam(e.data.amount), at: (e.at ?? 0) * 1000, tx: e.sig }))
const bidCount = (n) => (n === 1 ? '1 bid' : n + ' bids')
const atEl = (ts) => `<span class="cd num" data-at="${ts}">${clock((ts - now()) / 1000)}</span>`
const segClock = (l, cls = '') => `<div class="segcd ${cls}">${cdEl(l)}</div>`
const meW = () => W.connectedWallet()?.address ?? null
const isSeller = (l) => !!meW() && meW() === l.v.seller.wallet
const statusOf = (l) => {
  const v = l.v, ph = v.phase
  if (v.mode === 'fixed') return ph === 'live' ? 'fixed' : ph
  if (ph === 'live') return leftS(l) < 60 ? 'ending' : 'live'
  if (ph === 'settling') return v.fillable === false ? 'unfillable' : 'settling'
  if (ph === 'accept_window') return 'accept'
  if (ph === 'seller_ghosted') return 'ghosting'
  return ph
}
/** The dev drops as they run: each one's time, size, outcome, and its post on X. */
const DROP_STATE = { live: 'Live now', listing: 'Listing', settling: 'Settling', ending: 'Ending' }
function planDrops() {
  const P = D.dropPlan, plan = P.plan, by = plan.author?.handle ? '@' + esc(plan.author.handle) : esc(xName())
  const mins = Math.round(plan.everyMs / 60000), len = plan.lengthS % 60 === 0 ? `${plan.lengthS / 60} minute` : `${plan.lengthS} second`
  const next = nextPlanDrop()
  const row = (d) => {
    const live = ['live', 'listing', 'settling', 'ending'].includes(d.state), l = d.listing && live ? `/lot/${d.listing}` : null
    const out = d.state === 'sold' ? `<small class="dr-ok">Sold for <span class="num">${solX(d.soldLamports)} SOL</span></small>${txLink(d.saleSig, 'Sale tx')}`
      : d.state === 'skipped' ? `<small>${d.skipped === 'no_bids' ? 'No bids. Skipped, the tokens stayed.' : 'Skipped, the tokens stayed.'}</small>`
        : live ? `<small class="dr-live">${DROP_STATE[d.state]}${d.minBid ? `, from ${solX(d.minBid)} SOL` : ''}</small>${l ? `<a class="linkb" href="${l}">Bid now</a>` : ''}`
          : `<small>Starts 15% under the chart</small><span class="dr-cd">${d === next ? 'Next in ' : 'In '}${atEl(d.at)}</span>`
    const post = d.post?.url && !d.post.preview ? `<a class="txl" href="${esc(d.post.url)}" target="_blank" rel="noopener">Post${icon('ext')}</a>` : d.post?.preview ? '<span class="dr-pv">Preview post</span>' : ''
    return `<li class="dr-${d.state}${d === next || live ? ' next' : ''}"><span class="dr-at num">${hhmm(d.at)}</span><b>${big(units(d.amount, plan.decimals))}</b><span>$${esc(B.ticker)}, ${esc(d.pct)}</span><em>Drop ${d.n} of ${d.of}</em>${out}${post}</li>`
  }
  const sold = P.drops.filter((d) => d.state === 'sold'), got = sold.reduce((a, d) => a + BigInt(d.soldLamports ?? 0), 0n)
  return `<section class="sec band" id="schedule"><div class="wrap">
      ${head('06', 'Dev drops', `The dev sells 5% of $${esc(B.ticker)} here, in public.`)}
      <p class="lede">12 live auctions from the dev wallet, one every ${mins === 1 ? 'minute' : mins + ' minutes'}, each ${len}s long and a little bigger than the last. Each opens 15% under the chart and ${by} posts it on X as it lists. A drop with no bids is skipped and its tokens stay put.${sold.length ? ` So far ${sold.length} sold for <b class="num">${solX(got)} SOL</b>.` : ''}</p>
      <ol class="drops dplan">${P.drops.map(row).join('')}</ol>
    </div></section>`
}
function dropChip() {
  const n = nextPlanDrop(), plan = D.dropPlan?.plan
  if (n && plan) return `drop ${n.n} of ${n.of}, ${big(units(n.amount, plan.decimals))} $${esc(B.ticker)}, in ${atEl(n.at)}`
  const d = drops(1)[0]
  if (d) return `${esc(d.amount)} $${esc(B.ticker)}, ${d.mode.toLowerCase()}, in ${atEl(d.at)}`
  return 'the board opens with the next listing. Be first: <a class="linkb" href="/sell">sell your tokens</a>'
}
const nextDropLine = () => `<p>Next drop: ${dropChip()}</p>`

// ---------- connect and account
const signedIn = () => !!D.me.signedIn
/** The name a signed in person goes by: their X handle, or "Signed in" for an email or wallet account with no X. */
const meName = () => (D.me.handle ? '@' + esc(D.me.handle) : 'Your account')
const privyOn = () => !!C.auth?.privy
/** Privy's own "Protected by Privy" lockup, from its SDK, shown wherever someone signs in or connects. */
const privyMark = () => (privyOn() ? '<p class="privy-mark"><img src="/brand/protected-by-privy.svg" alt="Protected by Privy" width="138" height="12" loading="lazy" decoding="async"></p>' : '')
const SIGNIN_SUB = () => (privyOn() ? 'X, a wallet or email' : 'Your handle and picture show on your cards')
const tradeReady = () => signedIn() && !!meW() && D.me.wallet === meW()
/** Wallets Privy has connected, as rows to pick from; the active one is ticked. */
const privyRows = () => privyWallets().map((x) => {
  const on = meW() === x.address
  const ic = x.icon && !x.embedded ? `<img class="srow-w" src="${esc(x.icon)}" alt="">` : '<span class="srow-dot"></span>'
  return `<button class="srow ${on ? 'on' : ''}" data-act="pickPrivy" data-v="${esc(x.address)}">${ic}<span class="srow-n"><b>${esc(x.name)}</b><small>${short(x.address)}${on ? ', in use' : x.embedded ? ', made for you by Privy' : ''}</small></span>${on ? icon('check', 'good') : icon('arrow')}</button>`
}).join('')
/** The link line under the wallets: only when the wallet in use is not the account's wallet yet. */
function privyLinkNote(me, w) {
  if (!me.signedIn || !w || me.wallet === w) return ''
  if (me.pendingWallet === w) return `<p class="sheet-p">This wallet takes over from ${short(me.wallet)} on ${new Date(me.pendingAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. <button class="linkb" data-act="cancelChange">Keep the old one</button></p>`
  if (me.wallet && me.changeWaits) return `<p class="sheet-p">This account trades with ${short(me.wallet)}. It has listed or bid, so a change waits 48 hours. Switch back to it, or <button class="linkb" data-act="linkWallet">change to this one</button>.</p>`
  return `<div class="linkbox"><p class="sheet-p">Link this wallet to ${meName()}${privyVerified(w) ? '. Privy already checked it is yours' : ' by signing a short message'}. It moves nothing and approves nothing.</p><button class="btn hot wide" data-act="linkWallet">Link wallet</button></div>`
}
function privyConnectSheet(need) {
  const me = D.me, w = meW(), live = C.live.signin, has = privyWallets().length > 0
  const xRow = need === 'wallet' ? '' : me.signedIn
    ? `<div class="srow on">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>${meName()}</b><small>Signed in</small></span>${icon('check', 'good')}</div>`
    : live ? `<button class="srow" data-act="signin">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>Sign in</b><small>${SIGNIN_SUB()}</small></span>${icon('arrow')}</button>`
      : `<div class="srow off">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>Sign in</b><small>Opens at launch. Browsing needs nothing.</small></span></div>`
  const connectRow = `<button class="srow" data-act="privyConnect"><span class="srow-dot"></span><span class="srow-n"><b>${has ? 'Connect another wallet' : 'Connect your wallet'}</b><small>Phantom, Solflare, Backpack or any Solana wallet</small></span>${icon('arrow')}</button>`
  // Only for someone signed in with no wallet at all, and only when they press it
  const create = me.signedIn && !has && !w ? `<button class="srow" data-act="privyCreate">${icon('plus', 'srow-i')}<span class="srow-n"><b>Create a wallet for me</b><small>No wallet yet? Privy makes one for this account</small></span>${icon('arrow')}</button>` : ''
  const title = need === 'wallet' ? 'Connect a wallet.' : !me.signedIn ? 'Sign in, once.' : w ? 'Your wallets.' : 'Now your wallet.'
  const intro = need === 'wallet' ? 'This needs a wallet to sign and pay the network fee. No X account needed.' : !me.signedIn ? 'Browsing needs nothing. Listing and bidding need you signed in with a wallet.' : 'Listing and bidding use the wallet you pick here.'
  return `<p class="sheet-k">Connect</p><h3 class="sheet-t">${title}</h3><p class="sheet-p">${intro}</p>
    ${xRow}<div class="wallet-opts">${privyRows()}${connectRow}${create}</div>${privyLinkNote(me, w)}<p class="sheet-msg" data-sheetmsg></p>${privyMark()}`
}
function connectSheet(need = 'trade') {
  if (privyOn()) return privyConnectSheet(need)
  const me = D.me, w = meW(), live = C.live.signin
  const xRow = me.signedIn
    ? `<div class="srow on">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>${meName()}</b><small>Signed in${me.hasX === false ? '. Link X in Sign in for one per X deals.' : ''}</small></span>${icon('check', 'good')}</div>`
    : live ? `<button class="srow" data-act="signin">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>${privyOn() ? 'Sign in' : 'Sign in with X'}</b><small>${SIGNIN_SUB()}</small></span>${icon('arrow')}</button>`
      : `<div class="srow off">${icon('xlogo', 'srow-i')}<span class="srow-n"><b>${privyOn() ? 'Sign in' : 'Sign in with X'}</b><small>Opens at launch. Browsing needs nothing.</small></span></div>`
  let linkNote = ''
  if (me.signedIn && w) {
    if (me.wallet && me.wallet !== w && me.pendingWallet !== w) linkNote = `<p class="sheet-p">This account is linked to ${short(me.wallet)}. Switch to that wallet, or <button class="linkb" data-act="linkWallet">link this one</button>. A change waits 48 hours.</p>`
    else if (me.pendingWallet === w) linkNote = `<p class="sheet-p">This wallet takes over from ${short(me.wallet)} on ${new Date(me.pendingAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. <button class="linkb" data-act="cancelChange">Keep the old one</button></p>`
    else if (!me.wallet) linkNote = `<div class="linkbox"><p class="sheet-p">Last step: link this wallet to ${meName()}${privyVerified(w) ? '. Privy already checked it is yours' : ' by signing a short message'}. It moves nothing and approves nothing.</p><button class="btn hot wide" data-act="linkWallet">Link wallet</button></div>`
  }
  const rows = W.walletChoices().map((r) => {
    const on = w && r.wallet && W.connectedWallet()?.wallet === r.wallet
    const ic = r.icon ? `<img class="srow-w" src="${esc(r.icon)}" alt="">` : '<span class="srow-dot"></span>'
    if (r.wallet) return `<button class="srow ${on ? 'on' : ''}" data-act="pickWallet" data-v="${esc(r.name)}">${ic}<span class="srow-n"><b>${esc(r.name)}</b><small>${on ? short(w) : 'Connect wallet'}</small></span>${on ? icon('check', 'good') : icon('arrow')}</button>`
    if (r.deep) return `<a class="srow" href="${esc(r.deep)}">${ic}<span class="srow-n"><b>${esc(r.name)}</b><small>Open this page in ${esc(r.name)}</small></span>${icon('ext')}</a>`
    return `<a class="srow" href="${esc(r.get)}" target="_blank" rel="noopener">${ic}<span class="srow-n"><b>${esc(r.name)}</b><small>Not installed</small></span>${icon('ext')}</a>`
  }).join('')
  const intro = need === 'wallet' ? 'This needs a wallet to sign and pay the network fee. No X account needed.' : privyOn() ? 'Browsing needs nothing. Listing and bidding need you signed in with a wallet. No wallet? Sign in by X or email and you get one.' : 'Browsing needs nothing. Listing and bidding need an X account and a wallet.'
  // Signed in through Privy with an embedded wallet: it is offered first, by address
  const emb = privyWallets().filter((x) => x.embedded).map((x) => { const on = w === x.address; return `<button class="srow ${on ? 'on' : ''}" data-act="pickPrivy" data-v="${esc(x.address)}"><span class="srow-dot"></span><span class="srow-n"><b>Privy wallet</b><small>${on ? short(x.address) : 'Made for you at sign in, ' + short(x.address)}</small></span>${on ? icon('check', 'good') : icon('arrow')}</button>` }).join('')
  return `<p class="sheet-k">Connect</p><h3 class="sheet-t">${need === 'wallet' ? 'Connect a wallet.' : privyOn() && !me.signedIn ? 'Sign in, once.' : 'Two steps, once.'}</h3><p class="sheet-p">${intro}</p>
    ${need === 'wallet' ? '' : xRow}<div class="wallet-opts">${emb}${rows}</div>${linkNote}<p class="sheet-msg" data-sheetmsg></p>${privyMark()}`
}
function accountSheet() {
  const w = meW(), me = D.me
  return `<p class="sheet-k">Account</p><h3 class="sheet-t sheet-who">${me.signedIn ? avatar({ wallet: me.wallet ?? w, handle: me.handle, avatar: me.avatar }, 'lg') + meName() : addrEl(w)}</h3>
    <div class="rows"><div><span>Wallet</span><b class="num">${short(w)}</b></div><div><span>X account</span><b>${me.signedIn ? (me.handle ? xLink({ handle: me.handle }) : 'Not linked') : 'Not signed in'}</b></div><div><span>Linked wallet</span><b class="num">${me.wallet ? short(me.wallet) : 'None yet'}</b></div></div>
    ${privyOn() ? `<div class="wallet-opts">${privyRows()}<button class="srow" data-act="privyConnect"><span class="srow-dot"></span><span class="srow-n"><b>Connect another wallet</b><small>Phantom, Solflare, Backpack or any Solana wallet</small></span>${icon('arrow')}</button></div>${privyLinkNote(me, w)}<p class="sheet-msg" data-sheetmsg></p>` : ''}
    ${creditsPanel()}${!privyOn() && me.signedIn && me.wallet !== w ? '<button class="btn hot wide" data-act="connect" data-force="1">Link this wallet</button>' : ''}
    <div class="stage-a"><button class="btn line" data-act="disconnect">Disconnect wallet</button>${me.signedIn ? `<button class="btn line" data-act="signout">${privyOn() ? 'Sign out' : 'Sign out of X'}</button>` : ''}</div>${privyMark()}`
}
function creditsPanel(listing = null) {
  const items = D.credits.filter((c) => !listing || c.listing === listing)
  if (!items.length) return ''
  const total = items.reduce((a, c) => a + lam(c.lamports), 0)
  return `<section class="box credits" data-credits><div class="box-h"><h3 class="box-t">Your credits</h3><span class="k">${sol(total)} SOL</span></div>
    <p class="fine">SOL the contract could not pay to your wallet directly, parked at an address only you can claim.</p>
    <ul class="credit-l">${items.map((c) => `<li><span class="num">${sol(lam(c.lamports))} SOL</span><a class="txl num" href="/lot/${c.listing}">${short(c.listing)}</a><button class="btn hot" data-act="claim" data-id="${c.listing}">Claim</button></li>`).join('')}</ul><p class="fine" data-claimmsg></p></section>`
}
/** One sheet at a time. `state` says what it is, so it can redraw itself; a plain sheet (share) has none. */
function sheet(html, state = null) { $('.sheetwrap')?.remove(); S.sheet = state; const d = document.createElement('div'); d.className = 'sheetwrap'; d.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button class="sheet-x" data-act="closeSheet" aria-label="Close">${icon('x')}</button>${html}</div>`; document.body.append(d) }
const closeSheet = () => { $('.sheetwrap')?.remove(); S.sheet = null }
const openSheet = (kind, need) => sheet(kind === 'account' ? accountSheet() : connectSheet(need), { kind, need })
const redrawSheet = () => { if (!S.sheet || !$('.sheetwrap')) return; const b = $('.sheet'); const x = b.querySelector('.sheet-x').outerHTML; b.innerHTML = x + (S.sheet.kind === 'account' ? accountSheet() : connectSheet(S.sheet.need)) }
const connLabel = () => (D.me.signedIn && (meW() || privyOn()) ? avatar({ wallet: D.me.wallet ?? meW(), handle: D.me.handle, avatar: D.me.avatar }, 'sm') + (D.me.handle ? '@' + esc(D.me.handle) : meW() ? short(meW()) : 'Account') : meW() ? short(meW()) : 'Connect')
const connectBtn = (c = 'btn') => `<button class="${c} conn ${meW() ? 'is-on' : ''}" data-act="connect" data-conn>${connLabel()}</button>`
function updateConn() { $$('[data-conn]').forEach((b) => { b.innerHTML = connLabel(); b.classList.toggle('is-on', !!meW()) }) }
/** Runs f once the visitor has what it needs; otherwise opens the connect sheet and runs it after. */
function need(kind, f) {
  if (kind === 'wallet' ? !!meW() : tradeReady()) return f()
  S.then = { kind, f }
  if (privyOn() && kind !== 'wallet' && !signedIn() && C.live.signin) return privySignIn()
  openSheet('connect', kind)
}
function resume() { if (!S.then) return; const t = S.then; if (t.kind === 'wallet' ? !!meW() : tradeReady()) { S.then = null; closeSheet(); t.f() } }

// ---------- sending
const STEP = { simulating: 'Checking it against the chain…', signing: 'Sign in your wallet…', sending: 'Sending…', confirming: 'Confirming…' }
async function run(msgSel, btn, label, build, ok, signNote = null) {
  if (S.busy) return
  const m = () => $(msgSel)
  const say = (h) => { const e = m(); if (e) e.innerHTML = h }
  S.busy = label
  if (btn) btn.disabled = true
  try {
    const instructions = await build()
    if (!instructions) return
    const sig = await CH.send({ payer: meW(), instructions, onStep: (s) => say(`<span class="busy">${STEP[s]}</span>${s === 'signing' && signNote ? ' ' + signNote() : ''}`) })
    await ok(sig, say)
  } catch (e) {
    say(`<span class="warnm">${esc(e instanceof CH.TxError ? e.message : e?.message || 'Something went wrong. Nothing moved.')}</span>${e?.sig ? ' ' + txLink(e.sig, 'View tx') : ''}`)
    if (!(e instanceof CH.TxError)) console.error(e)
  } finally { S.busy = null; if (btn && document.contains(btn)) btn.disabled = false }
}
const ataFor = (owner, l) => P.ix.ata(meW(), owner, l.mint, l.v.tokenProgram)
const fresh = async (l) => { const v = await loadOne(l.id); if (!v) throw new CH.TxError('This listing is no longer open.', { code: 'gone' }); return lot(v) }
/** The listing as the chain has it, refused if mint, amount or price differ from what this page showed. */
const onChain = (seen, fields) => CH.onChainListing(seen.pubkey, seen, fields)

// ---------- cards and lists
function card(l) {
  const fx = l.mode === 'fixed'
  return `<a class="card" href="${lotHref(l)}" data-card="${l.id}">
    <div class="card-top">${art(l, 'card-art')}<div class="card-id"><b>$${esc(l.t)}${coinMark(l)}</b><span>${esc(l.name)}</span>${caCopy(l.mint, 'sm')}</div>${fx ? tag('Fixed', 'fx') : liveDot(l)}</div>
    ${l.drop ? `<div class="card-drop">${dropTag(l, 'sm')}<span>Listed on X by ${dropBy(l)}</span></div>${xPostCard(l.drop.post, { compact: true, inLink: true })}` : ''}
    <div class="card-amt"><span>${big(l.amt)} tokens</span><span>${l.pct != null ? pctS(l.pct) + ' supply' : ''}</span></div>
    <div class="card-n"><span class="k" data-lbl="${l.id}">${topLabel(l)}</span>${topNum(l, 'b', 'bignum')}</div>
    <div class="card-m"><span data-vs="${l.id}">${vsTxt(l)}</span>${fx ? `<span>${l.onePer ? 'One per X' : 'First buyer'}</span>` : cdEl(l)}</div>
    ${fx ? '<div class="tbar full"><i></i></div>' : barEl(l)}
    <div class="card-f">${sellerEl(l.seller, '', true)}${authBadge(l, 'sm')}<span class="card-b">${fx ? 'Buy' : 'Bid'} ${icon('arrow')}</span></div></a>`
}
const liveLots = () => D.board.map(lotById).filter((l) => l && l.v.phase === 'live' && l.v.fillable !== false)
const match = (l) => { const q = S.q.trim().toLowerCase(); return !q || l.t.toLowerCase().includes(q) || l.name.toLowerCase().includes(q) || l.mint.toLowerCase().includes(q) || (l.seller.handle ?? '').toLowerCase().includes(q.replace(/^@/, '')) || l.seller.wallet.toLowerCase().includes(q) }
function liveList() {
  let r = liveLots().filter(match)
  const f = S.filter
  if (f === 'Fixed price') r = r.filter((l) => l.mode === 'fixed')
  else if (f !== 'All') r = r.filter((l) => l.mode === 'bid')
  if (f === 'Ending soon') r = r.filter((l) => leftS(l) < 300)
  if (f === 'Just listed') r = r.filter((l) => (l.listedAt && now() - l.listedAt < 120_000) || !hasBids(l))
  if (f === 'Listed on X') r = r.filter((l) => l.tagged || l.drop)
  const end = (l) => (l.mode === 'fixed' ? l.end || Infinity : l.end)
  const srt = { 'Ending soon': (a, b) => end(a) - end(b), Biggest: (a, b) => priceOf(b) - priceOf(a), Newest: (a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0) }[S.sort]
  return r.sort((a, b) => (a.mode === 'fixed') - (b.mode === 'fixed') || srt(a, b))
}
const featured = () => liveLots().filter((l) => l.mode === 'bid').sort((a, b) => b.top - a.top || a.end - b.end)[0] ?? null
const FILTERS = ['All', 'Ending soon', 'Just listed', 'Listed on X', 'Fixed price'], SORTS = ['Ending soon', 'Biggest', 'Newest']
const pills = () => `<div class="pills" role="group" aria-label="Filter">${FILTERS.map((f) => `<button class="pill ${S.filter === f ? 'on' : ''}" data-act="filter" data-v="${f}" aria-pressed="${S.filter === f}">${f}</button>`).join('')}</div>`
const sorts = () => `<div class="sorts" role="group" aria-label="Sort"><span>Sort by</span>${SORTS.map((f) => `<button class="${S.sort === f ? 'on' : ''}" data-act="sort" data-v="${f}" aria-pressed="${S.sort === f}">${f}</button>`).join('')}</div>`
const searchBox = (ph = 'Search coin, CA or seller') => `<label class="search">${icon('search')}<input data-search type="search" placeholder="${ph}" aria-label="Search coin, CA or seller" value="${esc(S.q)}"></label>`
const NAV = [['live', 'Live'], ['fixed', 'Fixed price'], ['rewards', 'Rewards'], ['docs', 'Docs']]
const navLinks = () => NAV.map(([h, n]) => `<a href="/${h}" data-nav="${h}">${n}</a>`).join('') + (B.github ? `<a href="${esc(B.github)}" target="_blank" rel="noopener">GitHub</a>` : '') + (X_URL() ? `<a href="${X_URL()}" target="_blank" rel="noopener">X</a>` : '')
const emptyBox = (title, extra = '') => `<div class="empty"><b>${title}</b>${nextDropLine()}${extra}</div>`

// ---------- sold tape: completed sales and refunds, newest first
function tape(n = 8) {
  const rows = [
    ...D.sales.map((s) => ({ kind: 'sold', at: s.at ?? 0, mint: s.mint, amt: s.mint && s.decimals != null ? units(s.amount, s.decimals) : null, sol: lam(s.price), seller: person(s.seller), winner: person(s.winner), sig: s.sig, listing: s.listing })),
    ...D.activity.filter((e) => e.name === 'MarkedGone').map((e) => { const v = D.lots.get(e.listing); return { kind: v?.mode === 'accept' ? 'ghosted' : 'gone', at: e.at ?? 0, mint: e.mint, amt: e.mint && e.decimals != null ? units(e.listingAmount, e.decimals) : null, sol: lam(e.data.refunded), seller: v ? person(v.seller.wallet) : null, sig: e.sig, listing: e.listing } }),
  ]
  return rows.sort((a, b) => b.at - a.at).slice(0, n)
}

// ---------- trust: check it yourself, stats, every transaction, upgrade banner
const FEEDK = { listed: 'Listed', bid: 'Bid', sold: 'Sold', accepted: 'Accepted', bought: 'Bought', refund: 'Refund', cancelled: 'Cancelled', credit: 'Credit', fee_claim: 'Fee claim', payout: 'Payout' }
function footUp() {
  const u = D.trust?.upgrade
  // Before the deploy there is nothing on chain to link to: the line says so, and names the key it will deploy with if one is set
  if (u?.state === 'undeployed') return `${upgradeLine(D.trust)}${C.keys?.upgradeAuthority ? ` Deploy key <a class="num addr-full" href="${acctUrl(C.keys.upgradeAuthority)}" target="_blank" rel="noopener">${C.keys.upgradeAuthority}</a>` : ''}`
  const who = u?.state === 'squads' ? u.multisig : u?.state === 'key' ? u.authority : u?.state === 'revoked' ? null : u?.authority ?? null
  return `${upgradeLine(D.trust)} ${who ? `<a class="num addr-full" href="${acctUrl(who)}" target="_blank" rel="noopener">${who}</a>` : u?.state === 'revoked' ? '' : `<a href="${acctUrl(C.chain.programId)}" target="_blank" rel="noopener">See it on the explorer</a>`}`
}
/** When the program data was last written, read from chain: slot and its block time. */
const deployedText = (u) => { const at = D.deployAt && u?.deploySlot && D.deployAt.slot === u.deploySlot ? D.deployAt.t : null; return u?.deploySlot ? `Deployed at slot <span class="num">${full(u.deploySlot)}</span>${at ? ', ' + new Date(at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}` : '' }
/** The multisig in a few words: approvals, the lock, and whether a settings key can change both at once. */
const approvals = (u) => (u.threshold && u.members ? `${u.threshold} of ${u.members} approvals` : 'Multisig approvals')
function trustStrip() {
  const T = D.trust, u = T?.upgrade, pid = C.chain.programId, pdata = u?.programData ?? null
  const ext = (h) => (h.startsWith('/') ? '' : ' target="_blank" rel="noopener"')
  const item = (k, v, href, st = '', sub = '') => { const inner = `<span class="k">${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}`; return href ? `<a class="ck ${st}" href="${esc(href)}"${ext(href)}>${inner}${icon(href.startsWith('/') ? 'arrow' : 'ext')}</a>` : `<div class="ck ${st}">${inner}</div>` }
  const ctl = u?.state === 'squads' && u.autonomous !== true
  const up = u?.state === 'undeployed' ? item('Upgrade authority', 'At deploy', null, 'pend', 'Read from chain once the program is deployed')
    : !u || u.state === 'unknown' ? item('Upgrade authority', 'Checking', acctUrl(pid), 'pend', 'Treat it as the team key until read')
    : u.state === 'revoked' ? item('Upgrade authority', 'Revoked', acctUrl(pdata ?? pid), 'ok', 'Nobody can upgrade it')
      : u.state === 'squads' ? (ctl ? item('Upgrade authority', 'Multisig, settings key', acctUrl(u.multisig), 'warn', `${approvals(u)}${lockText(u) ? ', ' + lockText(u) + ' lock' : ''}. The settings key can change both at once.`)
          : item('Upgrade authority', `Multisig, ${lockText(u) ? lockText(u) + ' lock' : 'no lock'}`, acctUrl(u.multisig), 'ok', `${approvals(u)}. No settings key.`))
        : item('Upgrade authority', 'Team key', acctUrl(u.authority), '', 'One key can upgrade it')
  const vb = T?.verified?.state === 'verified' ? item('Build', 'Verified', T.verified.url, 'ok', 'Matches the source')
    : T?.verified?.state === 'unverified' ? item('Build', 'Not verified', T.verified.url, 'bad', 'Does not match the source yet')
      : item('Build', 'Not verified yet', '/docs/verify', 'pend', 'How to verify it yourself')
  const src = T?.source?.url ? item('Source', `Commit <span class="num">${esc(T.source.commit.slice(0, 7))}</span>`, T.source.url, '', 'As published, not proof of the build') : item('Source', B.github ? 'Commit pending' : 'Published at launch', null, 'pend')
  return `<section class="checkit" aria-label="Check it yourself"><div class="checkit-h"><span class="k">Check it yourself</span><p>Every claim here links to its proof.</p></div><div class="ck-row">
    ${u?.state === 'undeployed' ? item('Program', 'Deploys at launch', null, 'pend', `Address <span class="num">${short(pid)}</span>`) : item('Program', `<span class="num">${short(pid)}</span>`, acctUrl(pdata ?? pid), '', deployedText(u))}${vb}${up}${item('Fee to sell', '0%', '/docs/fee', '', 'No instruction takes a fee')}${src}</div></section>`
}
/** Shown only when the numbers are worth showing, and never a zero. */
function statsStrip() {
  const st = D.stats
  if (!st?.show) return ''
  const rows = [['SOL held in live bids', lam(st.heldLamports), 'sol'], ['Listings sold', Number(st.sold), 'n'], ['Paid to sellers', lam(st.paidLamports), 'sol'], ['Paid to top sellers', lam(st.rewardsLamports), 'sol']].filter((r) => r[1] > 0)
  if (!rows.length) return ''
  return `<div class="stats">${rows.map(([k, v, t]) => `<a class="st" href="/tx"><b class="num">${t === 'sol' ? sol(v) + '<small> SOL</small>' : full(v)}</b><span class="k">${k}</span></a>`).join('')}</div>`
}
const bigOk = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
/** The latest rows from the poll, then any older pages the reader asked for, each row once. */
const feedRows = (n) => { const seen = new Set(), out = []; for (const e of [...D.feed.slice(0, n), ...(n > 40 ? D.feedOlder : [])]) { const k = `${e.kind}|${e.sig}|${e.listing ?? ''}|${e.place ?? ''}|${(e.wallets ?? []).join(',')}`; if (!seen.has(k)) { seen.add(k); out.push(e) } } return out }
/** Under the full table: how many rows show, and a button for older ones while there are more. */
const feedMore = () => { const n = feedRows(100).length; return n < 100 && !D.feedOlder.length ? '' : `<span class="k">${full(n)} rows shown</span>${D.feedEnd ? '<span class="k">That is every row</span>' : '<button class="btn line" data-act="feedMore">Load older</button>'}` }
function feedTable(n) {
  const items = feedRows(n)
  if (!items.length) return `<div class="empty"><b>The first transaction lands here.</b><p>Listings, bids, sales, refunds, fee claims and payouts, each linked to Solscan.</p>${nextDropLine()}</div>`
  return `<div class="scrollx"><table class="tbl feed"><thead><tr><th>What</th><th>Coin</th><th class="r">Amount</th><th>Who</th><th>When</th><th class="r">Tx</th></tr></thead><tbody>${items.map((e) => {
    const k = e.kind, who = (e.wallets ?? []).filter(Boolean).map((w) => sellerEl(person(w))).join(` ${icon('arrow')} `)
    const coinCell = e.mint ? `<a href="/lot/${esc(e.listing)}" class="fd-c">${artMint(e.mint, 'tiny')}<b>$${esc(ticker(e.mint))}</b></a>` : k === 'fee_claim' ? `<span class="fd-c"><b>$${esc(B.ticker)} creator fees</b></span>` : k === 'payout' ? '<span class="fd-c"><b>Top seller payout</b></span>' : '<span class="mut">None</span>'
    const toks = e.amount && e.decimals != null ? `${big(units(e.amount, e.decimals))} tokens` : '', lamp = bigOk(e.lamports) > 0n ? `${solX(e.lamports)} SOL` : ''
    const amt = k === 'listed' ? [toks, lamp ? (e.priceKind === 'min' ? 'min ' : 'at ') + lamp : ''].filter(Boolean).join(', ') : lamp || toks
    return `<tr class="fd-${esc(k)}"><td>${tag(FEEDK[k] ?? esc(k), k === 'sold' || k === 'accepted' || k === 'bought' ? 'hot' : k === 'payout' || k === 'fee_claim' ? 'fx' : '')}</td><td>${coinCell}</td><td class="r num">${amt}</td><td class="fd-w">${who}</td><td class="num mut" data-ago="${(e.at ?? 0) * 1000}"${k === 'payout' && e.paidAt ? ` title="Paid at ${utcFull(e.paidAt * 1000)}" data-paid="${e.paidAt}"` : ''}>${agoS((now() - (e.at ?? 0) * 1000) / 1000)}</td><td class="r">${txLink(e.sig)}</td></tr>`
  }).join('')}</tbody></table></div>`
}
/** Only a change that touches the upgrade raises the banner; any other multisig transaction is in the change log. */
const bannerItem = () => (D.trust?.upgrade?.pending ?? []).find((p) => p.kind === 'program' || p.kind === 'settings') ?? null
function upgradeBanner() {
  const p = bannerItem()
  document.body.classList.toggle('has-banner', !!p)
  if (!p) return ''
  const what = p.kind === 'program' ? '<span class="wide-only">Contract upgrade</span><span class="narrow-only">Upgrade</span> proposed.' : '<span class="wide-only">Multisig settings change</span><span class="narrow-only">Settings change</span> proposed.'
  const full_ = p.executableAt ? new Date(p.executableAt * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : ''
  const when = p.executableAt ? `Runs in <span class="cd num" data-at="${p.executableAt * 1000}">${clock(p.executableAt - now() / 1000)}</span>` : 'Waiting for approvals, then the time lock'
  return `<div class="upbanner" role="alert"><div class="wrap upb-in">${icon('warn')}<p title="${full_ ? 'Can run from ' + full_ + '. ' : ''}Bids and listings work as normal until then."><b>${what}</b> ${when}</p><a href="/log" aria-label="Details"><span class="wide-only">Details</span>${icon('arrow')}</a></div></div>`
}
function heroAuth() {
  const live = C.live.signin, me = D.me
  const label = privyOn() ? 'Sign in' : 'Sign in with X'
  const xBtn = !live ? `<button class="btn xbtn xl" disabled>${icon('xlogo')}${label}</button>` : me.signedIn ? '' : `<button class="btn xbtn xl" data-act="signin">${icon('xlogo')}${label}</button>`
  const meChip = me.signedIn ? `<span class="hero-me">${avatar({ wallet: me.wallet, handle: me.handle, avatar: me.avatar })}<span><b>${meName()}</b><small>${tradeReady() ? 'Signed in, wallet linked' : 'Signed in'}</small></span>${tradeReady() ? '' : '<button class="btn line" data-act="connect">Connect wallet</button>'}</span>` : ''
  return `${xBtn}${meChip}<a class="btn hot xl" href="/sell">Sell your tokens ${icon('arrow')}</a><a class="btn line xl" href="/live">Watch live bids</a>${!live ? '<p class="hero-note">Sign in opens at launch. Browsing needs nothing.</p>' : me.signedIn ? '' : `<p class="hero-note">${privyOn() ? 'Sign in with X, a wallet or email. With X, your handle and picture show on your cards.' : 'Your handle and picture show on your cards, so buyers know who they deal with.'}</p>`}${live && !me.signedIn ? privyMark() : ''}`
}

/** Sales and refunds as rows: logo, coin, price, who, when and the transaction. */
const tapeHtml = (rows) => `<div class="tape">${rows.map((r) => `<div class="tp ${r.kind !== 'sold' ? 'off' : ''}">${artMint(r.mint, 'tp-art')}<a class="tp-c" href="/lot/${r.listing}"><b>$${esc(ticker(r.mint))}</b><span>${r.amt != null ? big(r.amt) + ' tokens' : 'Full amount'}</span></a>
        <span class="tp-o">${r.kind === 'sold' ? `<b class="num">${sol(r.sol)} SOL</b><small>One transaction</small>` : `<b>${r.kind === 'ghosted' ? 'Seller ghosted' : 'Gone'}</b><small>${r.sol > 0 ? `${sol(r.sol)} SOL refunded` : 'Refunded'}</small>`}</span>
        <span class="tp-w">${r.kind === 'sold' ? `${sellerEl(r.seller)} ${icon('arrow')} ${sellerEl(r.winner)}` : sellerEl(r.seller)}</span><span class="tp-t" data-ago="${r.at * 1000}">${agoS((now() - r.at * 1000) / 1000)}</span>${txLink(r.sig, r.kind === 'sold' ? 'Swap tx' : 'Refund tx')}</div>`).join('')}</div>`

// ---------- brand, live facts, trust line, how to sell
const sellOnPage = () => !!document.getElementById('sellForm')
const LOGO = '<img class="brand-logo" src="/brand/logo-48.png" srcset="/brand/logo-48.png 1x, /brand/logo-96.png 2x, /brand/logo-144.png 3x" alt="" width="61" height="48" decoding="async">'
const WORDMARK = '<img class="brand-wm" src="/brand/wordmark-28.png" srcset="/brand/wordmark-28.png 1x, /brand/wordmark-56.png 2x, /brand/wordmark-84.png 3x" alt="Sidebid" width="114" height="28" decoding="async">'
/** The logo and the wordmark. Any other brand name is set in type beside the logo, or its own picture when the config gives one. */
function brandEl() {
  const n = String(B.name), own = /^sidebid$/i.test(n)
  const logo = B.logo ? `<img class="brand-logo" src="${esc(B.logo)}" alt="" width="61" height="48" decoding="async">` : LOGO
  return `<a class="brand" href="/" aria-label="${esc(n)} home">${logo}${own ? WORDMARK : `<b class="wm"><span>${esc(n)}</span></b>`}</a>`
}
/** A token's contract address, shortened, with a copy button. Inside a card it copies and never opens the card. */
const caCopy = (mint, cls = '') => `<button type="button" class="cacopy ${cls}" data-act="copy" data-copy="${esc(mint)}" aria-label="Copy contract address ${esc(mint)}" title="Copy contract address"><span class="num">${short(mint)}</span>${icon('copy')}</button>`
/**
 * Facts read live, each linking to its proof: source, upgrade authority, SOL held in bids, creator fees this hour and the next
 * seller payout. Shown on every empty page. Nothing here is an event, so none is made up.
 */
function liveFacts() {
  const out = [], u = D.trust?.upgrade, R = rewardsModel(), st = D.stats
  if (B.github) out.push({ id: 'src', k: 'Open source', v: 'Read the code', href: B.github, ext: true, blue: true })
  if (u?.state === 'revoked') out.push({ id: 'up', k: 'Upgrade authority', v: 'Revoked', href: u.revokeSig ? txUrl(u.revokeSig) : acctUrl(u.programData ?? C.chain.programId), ext: true, blue: true })
  else if (u?.state === 'undeployed') out.push({ id: 'up', k: 'Program', v: 'Deploys at launch', href: '/docs/upgrade' })
  else if (u && u.state !== 'unknown' && (u.multisig || u.authority)) { const who = u.state === 'squads' ? u.multisig : u.authority; out.push({ id: 'up', k: 'Upgrade authority', v: `${u.state === 'squads' ? 'Multisig ' : ''}<span class="addr">${short(who)}</span>`, href: acctUrl(who), ext: true }) }
  const held = st ? lam(st.heldLamports) : null
  out.push(u?.state === 'undeployed' ? { id: 'held', k: 'Bids held by the program', v: 'None yet', href: '/tx' } : { id: 'held', k: 'Bids held by the program', v: held ? `${sol(held)} SOL` : 'None live yet', href: acctUrl(C.chain.programId), ext: true })
  const fees = D.rewards?.hour?.feesLamports
  if (fees != null) out.push({ id: 'fees', k: 'Creator fees this hour', v: lam(fees) ? `${sol(lam(fees))} SOL` : 'None yet', href: '/rewards' })
  if (R.state === 'on') out.push({ id: 'pay', k: 'Next seller payout', v: `<span class="cd num" data-at="${R.payoutAt}">${clock((R.payoutAt - now()) / 1000)}</span>`, href: '/rewards' })
  return out
}
const factLink = (f, inner, cls) => `<a class="${cls} ${f.blue ? 'blue' : ''}" data-fact="${f.id}" href="${esc(f.href)}"${f.ext ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`
const factsGrid = () => `<div class="facts">${liveFacts().map((f) => factLink(f, `<span class="k">${f.k}</span><b>${f.v}</b>${icon(f.ext ? 'ext' : 'arrow')}`, 'fact')).join('')}</div>`
/** One quiet line: open source and the upgrade state, each a link to its proof. Only what is true right now. */
function trustLine(cls = '') {
  const u = D.trust?.upgrade, parts = []
  if (B.github) parts.push(`<a href="${esc(B.github)}" target="_blank" rel="noopener">${icon('gh')}Open source</a>`)
  if (u?.state === 'revoked') parts.push(`<a href="${esc(u.revokeSig ? txUrl(u.revokeSig) : acctUrl(u.programData ?? C.chain.programId))}" target="_blank" rel="noopener">${icon('check')}Upgrade authority revoked</a>`)
  else if (u?.state === 'squads') parts.push(`<a href="${esc(acctUrl(u.multisig))}" target="_blank" rel="noopener">${icon('check')}Upgrades need ${approvals(u).toLowerCase()}${lockText(u) ? ', ' + lockText(u) + ' lock' : ''}</a>`)
  else if (u?.state === 'key') parts.push(`<a href="${esc(acctUrl(u.authority))}" target="_blank" rel="noopener">${icon('warn')}Upgrade key held by the team</a>`)
  return parts.length ? `<p class="trustline ${cls}" data-trustline>${parts.join('<span class="sep" aria-hidden="true"></span>')}</p>` : `<p class="trustline ${cls}" data-trustline></p>`
}
const SELL_STEPS = [['Pick a coin and amount', 'Connect and pick a coin from your wallet. The full balance is filled in, or type any amount.'], ['Set a minimum and a length', 'No minimum lets bidders set the price. Auctions run 2 minutes to 1 hour.'], ['Sign once', 'One approval for exactly that amount. Your tokens stay in your wallet until a bid wins and the sale completes.']]
const FIXED_STEPS = [['Pick a coin and amount', 'Connect and pick a coin from your wallet, then switch to Fixed price.'], ['Set one price', 'In SOL. The first buyer pays exactly that, no more and no less.'], ['Sign once', 'Tokens stay in your wallet. When someone buys, SOL and tokens swap in that one transaction. Cancel any time before.']]
const xExample = () => `<div class="xpost">${avatar({ wallet: 'example' })}<div><b>Your post</b><p class="num">${esc(B.xHandle ? '@' + B.xHandle : '@us')} sell 40,000,000 &lt;CA&gt; min 5 sol 5 min</p></div></div>`
function sellHow(mode = 'bid') {
  return `<section class="sec how"><div class="wrap how-g">
    <div class="how-steps">${head('', mode === 'fixed' ? 'Fixed price' : 'Sell', mode === 'fixed' ? 'How fixed price works.' : 'How to sell, in three steps.')}${steps(mode === 'fixed' ? FIXED_STEPS : SELL_STEPS)}<a class="btn hot xl" href="/sell">Sell your tokens ${icon('arrow')}</a></div>
    <div class="how-x">${head('', 'List from X', 'Or just post it.')}<p class="lede sm">Post to ${esc(xName())} with the amount, the CA and your settings. If your linked wallet holds the tokens, the card goes live and we reply with its link.</p>${xExample()}<a class="more" href="/docs/post">How posting works ${icon('arrow')}</a></div>
  </div></section>`
}
/** The board with nothing live: a full panel with the live facts, never a small line. */
const emptyBoard = (title = 'No auction is live right now.') => `<div class="board-empty"><div class="be-l"><span class="live big"><i></i>Board open</span><h3 class="be-t">${title}</h3><p class="lede sm">The next listing shows here the moment it lands on chain. ${drops(1)[0] ? `Next drop: ${dropChip()}.` : 'List yours and it is the first one buyers see.'}</p><div class="be-a"><a class="btn hot xl" href="/sell">Sell your tokens ${icon('arrow')}</a><a class="btn line xl" href="/fixed">Fixed price</a></div></div><div class="be-r"><span class="k">Live from chain</span>${factsGrid()}</div></div>`

// ---------- the pre-launch mainnet test: one row per step, its transaction read from chain. Hidden while the list is empty.
const LT_STATUS = { finalized: ['Confirmed', 'ok'], confirmed: ['Confirmed', 'ok'], processed: ['Processing', 'pend'], failed: ['Failed', 'bad'], not_found: ['Not found yet', 'pend'], unknown: ['Checking', 'pend'] }
function launchTest() {
  const rows = ltRows(D.launchTest)
  if (!rows.length) return ''
  const main = C.chain.cluster === 'mainnet-beta', done = rows.filter((r) => LT_STATUS[r.status]?.[1] === 'ok').length
  return `<section class="lt" id="tested" aria-label="Tested on mainnet before launch"><header class="lt-h"><div><p class="eyebrow"><i class="pulse"></i>Launch test${main ? '' : '<span class="tag sm lt-tc">Test chain</span>'}</p><h2 class="lt-t">Tested on mainnet before launch.</h2>
      <p class="lt-p">${main ? 'Before launch each step ran once on mainnet with real SOL. Every row is that transaction, read from chain, with its Solscan link.' : 'On this preview each step ran on its own test chain with test SOL. On the live site these rows are the mainnet test, read from chain the same way.'}</p></div>
      <span class="k lt-c">${done} of ${rows.length} confirmed</span></header>
    <ol class="lt-l">${rows.map((r, i) => { const [st, cls] = LT_STATUS[r.status] ?? LT_STATUS.unknown; return `<li class="lt-r"><span class="lt-n num">${pad2(i + 1)}</span><div class="lt-w"><b>${esc(ltLabel(r.label))}</b>${r.note ? `<span>${esc(r.note)}</span>` : ''}</div>
      <span class="lt-s ${cls}">${cls === 'pend' ? '<i class="lt-dot" aria-hidden="true"></i>' : icon(cls === 'ok' ? 'check' : 'warn')}${st}</span><span class="lt-at num">${r.blockTime ? utcWhen(r.blockTime) : ''}</span><a class="txl num" href="${esc(txUrl(r.sig))}" target="_blank" rel="noopener" aria-label="${esc(ltLabel(r.label))} on Solscan, ${esc(r.sig)}" title="${esc(r.sig)}">Solscan<span class="lt-sig"> ${short(r.sig)}</span>${icon('ext')}</a></li>` }).join('')}</ol></section>`
}

// ---------- views
const UI = {
  shell: () => `<div data-banner>${upgradeBanner()}</div>
    <header class="top"><div class="wrap top-in">
      ${brandEl()}
      <nav class="nav" aria-label="Main">${navLinks()}<a class="m-only" href="/sell">Sell tokens</a></nav>
      <div class="top-r">${searchBox('Search coin or CA')}<a class="btn hot" href="/sell">Sell tokens</a>${connectBtn('btn line')}<button class="menu-b" data-act="menu" aria-label="Menu">${icon('menu')}</button></div>
    </div></header>
    <main id="view"></main>
    <footer class="foot"><div class="wrap">
      <div class="foot-g"><div>${/^sidebid$/i.test(String(B.name)) ? '<img class="foot-wm" src="/brand/wordmark-56.png" srcset="/brand/wordmark-56.png 1x, /brand/wordmark-84.png 1.5x, /brand/wordmark-160.png 3x" alt="Sidebid" width="228" height="56" loading="lazy" decoding="async">' : ''}<p class="foot-say">Sell your tokens.<br><span>Not the chart.</span></p>${trustLine('foot-trust')}${B.ca ? `<button class="capill" data-act="copy" data-copy="${B.ca}"><b>$${esc(B.ticker)} CA</b><span class="num">${short(B.ca)}</span>${icon('copy')}</button>` : ''}</div>
        <div class="foot-cols"><div><b>Trade</b><a href="/live">Live</a><a href="/fixed">Fixed price</a><a href="/#sold">Just sold</a>${drops(1).length ? '<a href="/#schedule">Drops</a>' : ''}</div><div><b>Sell</b><a href="/sell">Sell tokens</a><a href="/rewards">Rewards</a><a href="/docs/post">List from X</a></div><div><b>Check</b><a href="/tx">Every transaction</a><a href="/log">Change log</a><a href="/docs/upgrade">Safety</a><a href="/docs">Docs</a>${B.github ? `<a href="${esc(B.github)}" target="_blank" rel="noopener">GitHub</a>` : ''}${X_URL() ? `<a href="${X_URL()}" target="_blank" rel="noopener">X</a>` : ''}</div></div></div>
      <p class="foot-mark" aria-hidden="true">${esc(B.name)}</p>
      <div class="foot-b"><span>Settled on Solana. Prices in SOL.</span><span class="foot-up" data-upline>${footUp()}</span><span><a href="/terms" target="_self">Terms</a> · <a href="/privacy" target="_self">Privacy</a></span></div></div></footer>`,

  heroCard() {
    const l = featured()
    if (!l) {
      const d = drops(1)[0]
      return `<article class="auction" id="auction"><div class="auc-h"><span class="live big"><i></i>${d ? 'Next drop' : 'Open board'}</span><span class="mono">${d ? hhmm(d.at) : 'SOLANA'}</span></div>
        ${d ? `<div class="auc-coin"><div class="art auc-art" style="--c:#FF5A0A;--f:#0A0A0A"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><text x="32" y="40" text-anchor="middle" font-size="16" font-weight="800" fill="currentColor">$${esc(B.ticker.slice(0, 5))}</text></svg></div><div><h2>${esc(d.amount)}</h2><p>$${esc(B.ticker)}${d.pct ? ', ' + esc(d.pct) + ' of supply' : ''}</p><p class="mut">${esc(d.note)}</p></div></div>
          <div class="auc-n"><div><span class="k">Type</span><b class="giant sm">${d.mode === 'Fixed price' ? 'Fixed' : 'Auction'}</b><span class="sub">${d.mode}</span></div><div class="auc-cd"><span class="k">Starts in</span><div class="segcd">${atEl(d.at)}</div><span class="sub">Public schedule</span></div></div>`
        : `<div class="auc-coin"><div><h2>Be the first listing.</h2><p>Pick a coin from your wallet, set a minimum and a length, sign once. Bidders see it here live.</p></div></div>`}
        <a class="btn hot wide xl" href="/sell">Sell your tokens ${icon('arrow')}</a><p class="auc-f">Tokens stay in the seller’s wallet until a bid wins and the sale completes.</p></article>`
    }
    const bs = bidStream(l, bidsOf(l)), c = l.chart && l.pool ? chartMath(l.chart, l.pool) : null
    return `<article class="auction" id="auction" data-feat="${l.id}">
        <div class="auc-h"><span class="live big"><i></i>Live now</span><span class="mono">${lotNo(l)}</span></div>
        <div class="auc-coin">${art(l, 'auc-art')}<div><h2>$${esc(l.t)}${coinMark(l)}</h2><p>${esc(l.name)}, ${big(l.amt)} tokens${l.pct != null ? ', ' + pctS(l.pct) + ' of supply' : ''}</p><p class="mut">Seller ${sellerEl(l.seller)} ${authBadge(l, 'sm')}</p></div></div>
        <div class="auc-n"><div><span class="k" data-lbl="${l.id}">${topLabel(l)}</span>${topNum(l, 'b', 'giant')}<span class="sub" data-vs="${l.id}">${vsTxt(l)}</span></div>
          <div class="auc-cd"><span class="k">Ends in</span>${segClock(l)}<span class="sub">Late bids add 15s</span></div></div>
        ${barEl(l, 'thick')}
        <div class="auc-s"><div class="auc-sh"><span class="k">Bid stream</span><span class="k">${bs.n ? bidCount(bs.n) : 'Waiting for the first bid'}</span></div><ol class="stream" data-feed="${l.id}">${streamRows(bs.rows, 4) || `<li class="top stream-empty">${l.min ? `Opens at ${sol(l.min)} SOL` : 'Any bid of 0.001 SOL or more'}</li>`}</ol></div>
        <a class="btn hot wide xl" href="${lotHref(l)}">Bid on $${esc(l.t)} ${icon('arrow')}</a>
        <p class="auc-f">${c ? `Selling these tokens on the chart: about <b>${sol(c.get)} SOL</b>, price drops <b>${Math.round(c.drop) < 1 ? 'less than 1%' : Math.round(c.drop) + '%'}</b>.` : 'Tokens stay in the seller’s wallet until a bid wins and the sale completes.'}</p>
      </article>`
  },

  home() {
    const f = featured(), lots = liveList().filter((x) => x.id !== f?.id).slice(0, 8), R = rewardsModel(), last = R.past.find((h) => h.status === 'paid' || h.payouts.length)
    const sold = tape(8), ds = drops(6), plan = D.dropPlan?.plan ?? null
    return `
    <section class="hero"><div class="wrap hero-g">
      <div class="hero-l">
        <p class="eyebrow"><i class="pulse"></i>Live auctions for Solana tokens</p>
        <h1 class="mega"><span class="w"><span>Sell your tokens.</span></span><span class="w o"><span>Not the chart.</span></span></h1>
        <p class="lede hero-lede">Put up any amount of your tokens, all of it by default. Buyers bid in SOL against a countdown. When the clock hits zero, the top bid takes the tokens and you get the SOL, all in one transaction. No pool, no slippage, nothing on the chart.</p>
        <div class="hero-a" data-heroauth>${heroAuth()}</div>
        ${trustLine('hero-trust')}<ul class="hero-proof"><li>${icon('check')}No fee to sell</li><li>${icon('check')}Tokens stay in your wallet</li><li>${icon('check')}One transaction or nothing</li></ul>
      </div>
      <div data-hero>${UI.heroCard()}</div>
    </div>
    <div class="wrap">${trustStrip()}<div data-stats>${statsStrip()}</div><dl class="specbar">${[['Settle', '1 transaction', 'tokens and SOL, or nothing'], ['Late bid', '+15s', 'capped at 5 min extra'], ['Min raise', '2%', 'or 0.001 SOL'], ['Custody', 'Your wallet', 'tokens stay until the sale'], C.facts?.contractTests && C.facts?.serverTests ? ['Tests', String(C.facts.contractTests + C.facts.serverTests), `${C.facts.contractTests} contract, ${C.facts.serverTests} server`] : ['Bids', 'In the contract', 'refunded in the outbid transaction']].map(([a, b, c]) => `<div><dt>${a}</dt><dd>${b}</dd><span>${c}</span></div>`).join('')}</dl></div></section>
    ${D.launchTest?.length ? `<section class="sec tight lt-sec"><div class="wrap">${launchTest()}</div></section>` : ''}

    <section class="sec" id="lots"><div class="wrap">
      ${head('01', 'Live auctions', 'Bidding right now.', `<a class="more" href="/live">All live auctions ${icon('arrow')}</a>`)}
      <div class="grid">${!f && !lots.length ? emptyBoard() : lots.length ? lots.map(card).join('') + (lots.length < 4 ? `<a class="card slot" href="/sell"><span class="k">Open slot</span><b>Your tokens here.</b><p>Pick a coin and an amount, set a minimum, sign once. It shows up here live.</p><span class="more">Sell your tokens ${icon('arrow')}</span></a>` : '') : emptyBox(f ? 'One listing on the board right now.' : 'The board is open.', '<a class="btn hot" href="/sell">Sell your tokens</a>')}</div>
    </div></section>

    <section class="sec band" id="top3"><div class="wrap">
      ${head('02', 'Paid every hour', 'Top 3 sellers split the fees.', `<a class="more" href="/rewards">Leaderboard ${icon('arrow')}</a>`)}
      <div class="t3">
        <div class="t3-pot"><span class="k">Seller pot this hour</span>${potEl(R, 'giant')}<div class="t3-cd"><span class="k">${R.state === 'on' ? 'Payout in' : 'Payout'}</span><span class="segcd sm">${payoutCd(R)}</span></div>
          <p class="lede sm">Every hour the creator fees from $${esc(B.ticker)} are claimed. <b>90%</b> goes to the top 3 sellers by SOL received from completed sales, split <b>50 / 30 / 20</b>. The other 10% goes to the team.</p></div>
        <ol class="podium">${[1, 0, 2].map((i) => podium(R, i)).join('')}</ol>
      </div>
      ${last ? `<div class="paid"><span class="k">Last hour paid</span>${last.payouts.map((s) => `<span>#${s.rank} ${xLink(s.p)} ${sol(s.pay)} SOL ${txLink(s.sig)}</span>`).join('')}${last.claim ? `<span>Fee claim ${txLink(last.claim)}</span>` : ''}</div>` : R.state === 'on' ? `<div class="paid"><span class="k">First payout</span><span>Lands at ${hhmm(R.payoutAt)}, with every transaction linked on the Rewards page.</span></div>` : R.state === 'paused' ? `<div class="paid"><span class="k">Payouts paused</span><span>No payout is scheduled while payouts are paused. Sales still count toward the hour.</span></div>` : ''}
    </div></section>

    <section class="sec engine" id="engine"><div class="wrap">
      <header class="eng-h"><p class="eyebrow"><span>03</span>The engine</p><h2 class="mega2">Why it <span>wins.</span></h2>
        <p class="lede">Selling size used to mean dumping into a pool or trusting a stranger. ${esc(B.name)} is a Solana program that holds the bids, enforces every rule, and swaps both sides atomically. Seven parts, all on chain or checkable.</p></header>
      <div class="mods">${WHY(B).map((w, i) => `<article class="mod ${i === 0 || i === 6 ? 'wide' : ''}" id="w-${w.id}">
        <div class="mod-t"><span class="mod-n">${pad2(i + 1)}</span><p class="mod-k">${w.k}</p><h3>${w.h}</h3>${w.p.map((p) => `<p class="mod-p">${p}</p>`).join('')}
          <dl class="readout">${w.f.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl></div>
        <figure class="mod-fig"><div class="scrollx">${DIAGRAMS[w.d](B)}</div></figure></article>`).join('')}</div>
      <div class="proof">${PROOF(C.facts).map((p) => `<div class="pf"><b class="pf-n" data-count-to="${p.n}">${p.n}</b><span class="pf-k">${p.k}</span><p>${p.p}</p></div>`).join('')}
        ${B.github ? `<a class="pf src" href="${esc(B.github)}" target="_blank" rel="noopener">${icon('gh', 'pf-gh')}<span class="pf-k">Open source</span><p>Contract, server and site on GitHub. Read it, run the tests, build it.</p><span class="more">GitHub ${icon('ext')}</span></a>`
          : `<div class="pf src">${icon('gh', 'pf-gh')}<span class="pf-k">Open source</span><p>Contract, server and site on GitHub. The link goes up at launch.</p></div>`}</div>
    </div></section>

    <section class="sec" id="sold"><div class="wrap">
      ${head('04', 'Just sold', 'Every sale, on chain.')}
      ${sold.length ? tapeHtml(sold)
        : emptyBox('First sale lands here.', '<a class="btn line" href="/live">Watch live bids</a>')}
    </div></section>

    ${!f ? sellHow() : ''}
    <section class="sec" id="feed"><div class="wrap">
      ${head('05', 'Every transaction', 'Nothing off the record.', `<a class="more" href="/tx">All transactions ${icon('arrow')}</a>`)}
      <p class="lede sm feed-lede">Every listing, bid, sale, refund, fee claim and payout, read from chain, each with its Solscan link.</p>
      <div data-feed>${feedTable(10)}</div>
    </div></section>

    ${plan ? planDrops() : ds.length ? `<section class="sec band" id="schedule"><div class="wrap">
      ${head('06', 'Public drops', `$${esc(B.ticker)} drops on a public clock.`)}
      <p class="lede">For the first hour after launch, $${esc(B.ticker)} is sold right here on a public clock. Live auctions alternate with half price fixed lots, one per X account, and every sale is a public transaction.</p>
      <ol class="drops">${ds.map((d, i) => `<li class="${i === 0 ? 'next' : ''}"><span class="dr-at num">${hhmm(d.at)}</span><b>${esc(d.amount)}</b><span>$${esc(B.ticker)}${d.pct ? ', ' + esc(d.pct) : ''}</span><em>${d.mode}</em><small>${esc(d.note)}</small><span class="dr-cd">${i === 0 ? 'Next in ' : 'In '}${atEl(d.at)}</span></li>`).join('')}</ol>
    </div></section>` : ''}

    <section class="sec" id="promises"><div class="wrap">
      ${head(plan || ds.length ? '07' : '06', 'Seller promises', 'What every seller gets.')}
      <ol class="proms">${PROMISES.map((p, i) => `<li><span class="pr-i">${icon('check')}</span><b>${PROMISE_HEADS[i]}</b><p>${p}</p></li>`).join('')}</ol>
    </div></section>`
  },

  grid() { const r = liveList(); if (!r.length && !S.q && (S.filter === 'All' || S.filter === 'Fixed price')) return emptyBoard(S.filter === 'Fixed price' ? 'No fixed price listing right now.' : undefined); return r.length ? r.map(card).join('') : `<div class="empty"><b>${S.q || S.filter !== 'All' ? `No listing matches “${esc(S.q || S.filter)}”.` : 'The board is open.'}</b>${nextDropLine()}${S.q || S.filter !== 'All' ? '<button class="btn line" data-act="filter" data-v="All" data-clear="1">Show all listings</button>' : '<a class="btn hot" href="/sell">Sell your tokens</a>'}</div>` },
  live(r) {
    const fx = r.v === 'fixed', n = liveLots().filter((l) => (fx ? l.mode === 'fixed' : true)).length
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>${n ? `${n} ${fx ? (n === 1 ? 'fixed price listing' : 'fixed price listings') : n === 1 ? 'listing on the board' : 'listings on the board'}` : fx ? 'Fixed price' : 'The board is open'}</p><h1 class="mega sm">${fx ? 'This price.<br><span>First buyer.</span>' : 'Live <span>auctions.</span>'}</h1>
      <p class="lede">${fx ? 'One price, no less, no more. Sign once and SOL and tokens swap in that one transaction.' : 'Top bid when the clock hits zero takes every token listed. A bid in the last 15 seconds adds 15 seconds.'}</p></div></section>
      <section class="sec tight"><div class="wrap"><div class="bar">${pills()}<div class="bar-r">${searchBox()}${sorts()}</div></div>
      <div class="grid" data-grid>${UI.grid()}</div><p class="note"><i class="pulse"></i>Every listing here is read from chain. Cards whose seller no longer holds the tokens drop off.</p></div></section>${n || S.q ? '' : sellHow()}`
  },

  costPanel(l) {
    if (!l.chart || !l.pool) return ''
    const c = chartMath(l.chart, l.pool), here = priceOf(l) || l.chart * 0.7, max = Math.max(c.get, here)
    return `<section class="box cost" data-cost="${l.id}"><h3 class="box-t">Chart sale vs this sale</h3>
    <div class="cmp"><div class="cmp-r"><span>Dump on the chart</span><b class="num">${sol(c.get)} SOL</b><div class="cmp-b"><i style="width:${(c.get / max) * 100}%"></i></div><small>Price drops about ${Math.round(c.drop) < 1 ? 'less than 1%' : Math.round(c.drop) + '%'}</small></div>
    <div class="cmp-r hi"><span>${l.mode === 'fixed' ? 'This price' : 'Top bid here'}</span><b class="num">${sol(here)} SOL</b><div class="cmp-b"><i style="width:${(here / max) * 100}%"></i></div><small>${here - c.get > 0 ? '+' + sol(here - c.get) + ' SOL, chart flat' : 'Chart flat'}</small></div></div>
    <p class="fine">Estimate from a ${sol(l.pool)} SOL pool. Real pools vary.</p></section>`
  },
  bidList(l, st) {
    const bids = bidsOf(l)
    if (!bids.length) return `<div class="nobid"><b>${st === 'live' || st === 'ending' ? 'First bid sets the pace.' : 'No bids were placed.'}</b><p>${l.min ? `Minimum is ${sol(l.min)} SOL.` : 'Any bid of 0.001 SOL or more counts.'}</p></div>`
    const live = st === 'live' || st === 'ending' || st === 'accept' || st === 'settling'
    return `<div class="scrollx"><table class="tbl"><thead><tr><th>#</th><th>Bidder</th><th class="r">Bid</th><th>When</th><th>Status</th><th class="r">Tx</th></tr></thead><tbody>${bids.slice(0, 40).map((b, i) => `<tr class="${i === 0 ? 'top' : ''}"><td class="num mut">${pad2(bids.length - i)}</td><td>${sellerEl(b.p)}</td><td class="r num">${sol(b.sol)} SOL</td><td class="num mut" data-ago="${b.at}">${agoS((now() - b.at) / 1000)}</td><td>${i === 0 ? (live ? tag('Held', 'hot') : st === 'sold' ? tag('Won') : tag('Refunded')) : tag('Refunded')}</td><td class="r">${txLink(b.tx)}</td></tr>`).join('')}</tbody></table></div>`
  },

  lot(l) {
    const st = statusOf(l), fx = l.mode === 'fixed', v = l.v, ev = D.events.get(l.id) ?? [], mine = isSeller(l)
    const sale = D.sales.find((s) => s.listing === l.id) ?? ev.find((e) => ['Settled', 'Accepted', 'Bought'].includes(e.name))
    const saleSig = sale?.sig, refund = ev.find((e) => e.name === 'MarkedGone'), cancelled = ev.find((e) => e.name === 'Cancelled')
    const winner = person(sale?.winner ?? sale?.data?.winner ?? sale?.data?.buyer ?? v.topBidder)
    const refunded = refund ? lam(refund.data.refunded) : l.top
    const sellerTxt = xLink(l.seller)
    const closeBtn = !v.closed && !v.sellerMustCancel ? `<button class="btn line" data-act="close" data-id="${l.id}">Close and return the rent</button>` : ''
    const cancelBtn = (label = 'Cancel listing') => `<button class="btn line" data-act="cancel" data-id="${l.id}">${label}</button>`
    const approvalBtn = mine && v.sellerMustCancel ? `<button class="btn hot" data-act="cancel" data-id="${l.id}">Remove the approval</button>` : ''
    const doneBox = (h, p) => `<section class="box ticket"><h3 class="box-t">${h}</h3><p class="fine">${p} Next drop: ${dropChip()}</p><a class="btn hot wide" href="/live">See live auctions</a><a class="btn line wide" href="/sell">Sell your tokens</a></section>`
    let main, act
    if (fx && st === 'fixed') {
      main = `<div class="stage"><span class="k">This price only</span><b class="giant"><span class="n">${solX(v.price)}</span><small> SOL</small></b><span class="sub">${vsTxt(l)}</span></div>`
      act = mine ? `<section class="box ticket"><h3 class="box-t">Your listing</h3><div class="rows"><div><span>Price</span><b class="num">${solX(v.price)} SOL</b></div><div><span>Amount</span><b class="num">${tokX(v.amount, l.dec)} $${esc(l.t)}</b></div><div><span>Approval</span><b>Exactly this amount</b></div></div>${cancelBtn('Cancel and remove the approval')}<p class="fine" data-actmsg>Cancelling removes the approval in the same transaction. Your tokens never left your wallet.</p></section>`
        : `<section class="box ticket"><h3 class="box-t">Buy it now</h3><div class="rows"><div><span>You pay</span><b class="num">${solX(v.price)} SOL</b></div><div><span>You get</span><b class="num">${tokX(v.amount, l.dec)} $${esc(l.t)}</b></div><div><span>Limit</span><b>${l.onePer ? 'One per X account, on chain' : 'First buyer takes it'}</b></div></div>
        <button class="btn hot wide xl" data-act="buy" data-id="${l.id}">Buy for ${solX(v.price)} SOL</button><p class="fine" data-actmsg>${S.msg[l.id] ?? 'You sign alone. SOL and tokens swap in that one transaction.'}</p><p class="fine cost">${COST_LINE}</p></section>`
    } else if (st === 'sold') {
      main = `<div class="stage sold"><span class="stamp">Sold</span><b class="giant">${solX(sale?.price ?? sale?.data?.price ?? v.topBid)}<small> SOL</small></b><p class="sub">${xLink(winner)} bought ${full(l.amt)} $${esc(l.t)} from ${sellerTxt}. Tokens and SOL swapped in one transaction, and the chart did not move.</p><div class="stage-a">${txLink(saleSig, 'View swap tx')}<button class="btn line" data-act="share" data-id="${l.id}" data-sold="1">Share the sale</button></div></div>`
      act = doneBox('This listing is done', S.bought?.[l.id] ?? 'Sold in one transaction.')
    } else if (st === 'gone' || st === 'ghosted') {
      const gh = st === 'ghosted' || l.tagged
      main = `<div class="stage off"><span class="stamp ghost">${gh ? 'Seller ghosted' : 'Gone'}</span><b class="giant">${refunded > 0 ? `${sol(refunded)} SOL refunded` : 'Refunded'}</b><p class="sub">${gh ? 'The countdown ended and the seller did not accept within the window. Nothing moved, and the top bidder got every lamport back.' : 'The seller moved the tokens or removed the approval before the sale completed, so the sale could not go through. The top bidder got every lamport back.'}</p><div class="stage-a">${txLink(refund?.sig, 'View refund tx')}${approvalBtn}${mine ? '' : closeBtn}</div><p class="fine" data-actmsg></p></div>`
      act = doneBox('Nobody lost SOL', 'The bidder was refunded in full.')
    } else if (st === 'ghosting' || st === 'unfillable') {
      main = `<div class="stage off"><span class="stamp ghost">${st === 'ghosting' ? 'Seller ghosted' : 'Gone'}</span><b class="giant">${sol(l.top)} SOL</b><p class="sub">${st === 'ghosting' ? `The countdown ended and the seller did not accept within the ${Math.max(1, Math.round((v.acceptWindowSecs || 600) / 60))} minute window. Nothing moved. Anyone can trigger the full refund.` : 'The countdown ended but the seller no longer holds the tokens or removed the approval. Nothing moved. Anyone can trigger the full refund.'}</p><div class="stage-a"><button class="btn hot" data-act="refund" data-id="${l.id}">Trigger the refund</button></div><p class="fine" data-actmsg></p></div>`
      act = doneBox('Nobody loses SOL', 'The top bid goes back in full.')
    } else if (st === 'settling') {
      main = `<div class="stage acc"><span class="k"><i class="pulse"></i>Countdown over</span><b class="giant">${solX(v.topBid)}<small> SOL</small></b><p class="sub">${xLink(person(v.topBidder))} holds the winning bid. The sale bot settles it within a few seconds. Settle needs nobody’s signature, so anyone can press the button. Pressing it costs the network fee, plus about 0.002 SOL of rent if the winner has no account for this coin yet.</p><div class="stage-a"><button class="btn hot" data-act="settle" data-id="${l.id}">Settle now</button></div><p class="fine" data-actmsg></p></div>`
      act = `<section class="box ticket"><h3 class="box-t">Winning bid</h3><div class="rows"><div><span>Top bid</span><b class="num">${solX(v.topBid)} SOL</b></div><div><span>Winner gets</span><b class="num">${tokX(v.amount, l.dec)} $${esc(l.t)}</b></div></div><p class="fine">Tokens to the winner and SOL to the seller, in one transaction or not at all.</p></section>`
    } else if (st === 'accept') {
      const blocked = v.acceptBlocked
      main = `<div class="stage acc"><span class="k"><i class="pulse"></i>Accept window</span><div class="segcd xl"><span class="cd num" data-at="${(v.acceptClosesAt ?? 0) * 1000}">${clock(((v.acceptClosesAt ?? 0) * 1000 - now()) / 1000)}</span></div><p class="sub">The countdown ended. The seller listed by posting on X and now has until the window closes to accept the top bid by signing once. If they do not, every bid is refunded.</p></div>`
      act = mine ? `<section class="box ticket hotbox"><h3 class="box-t">You listed this by posting to ${esc(xName())}</h3><div class="rows"><div><span>Top bid</span><b class="num">${solX(v.topBid)} SOL</b></div><div><span>You sell</span><b class="num">${tokX(v.amount, l.dec)} $${esc(l.t)}</b></div></div>
        <button class="btn hot wide xl" data-act="accept" data-id="${l.id}" ${blocked ? 'disabled' : ''}>Accept ${solX(v.topBid)} SOL</button><p class="fine" data-actmsg>${blocked ? esc(blocked.message) : 'Sign once and the swap happens in that transaction. On a phone, open this page in Phantom, Solflare or Backpack.'}</p></section>`
        : `<section class="box ticket"><h3 class="box-t">Waiting for the seller</h3><div class="rows"><div><span>Top bid</span><b class="num">${sol(l.top)} SOL</b></div><div><span>Held for</span><b>${xLink(person(v.topBidder))}</b></div></div><p class="fine">If the seller does not accept in time, anyone can refund the top bid in full.</p></section>`
    } else if (st === 'expired') {
      main = `<div class="stage off"><span class="stamp ghost">Ended</span><b class="giant">No bids</b><p class="sub">${fx ? 'This fixed price listing expired before anyone bought it.' : 'The countdown ended with no bids. Nothing moved.'} ${v.sellerMustCancel ? 'The approval is still set on the seller’s wallet until the seller cancels.' : ''}</p><div class="stage-a">${approvalBtn}${mine && v.sellerMustCancel ? '' : closeBtn}</div><p class="fine" data-actmsg></p></div>`
      act = doneBox('This listing is done', mine && v.sellerMustCancel ? 'Remove the approval to close it and get the rent back.' : 'Nothing was sold.')
    } else if (st === 'cancelled' || st === 'closed') {
      main = `<div class="stage off"><span class="stamp ghost">${st === 'cancelled' ? 'Cancelled' : 'Ended'}</span><b class="giant">${st === 'cancelled' ? 'Seller cancelled' : 'Closed'}</b><p class="sub">${st === 'cancelled' ? `The seller cancelled before the sale completed. Any bid was refunded in the same transaction, and the approval was removed.` : 'This listing has closed and its rent went back to whoever paid it.'}</p><div class="stage-a">${txLink(cancelled?.sig, 'View cancel tx')}</div></div>`
      act = doneBox('This listing is done', 'Nothing was sold.')
    } else {
      const draft = S.bidDraft[l.id] ?? solP(BigInt(v.nextMinBid ?? minimumNextBid(v.topBid, v.price)))
      main = `<div class="stage"><div class="stage-g"><div><span class="k" data-lbl="${l.id}">${topLabel(l)}</span>${topNum(l, 'b', 'giant', true)}<span class="sub" data-vs="${l.id}">${vsTxt(l)}</span></div><div class="r"><span class="k">${liveDot(l)}</span>${segClock(l, 'lg')}<span class="sub">+15s per late bid, max +5 min</span></div></div>${barEl(l, 'thick')}</div>`
      act = mine && !l.tagged ? `<section class="box ticket"><h3 class="box-t">Your listing</h3><div class="rows"><div><span>${topLabel(l)}</span><b class="num">${priceOf(l) ? sol(priceOf(l)) + ' SOL' : 'Any bid'}</b></div><div><span>Amount</span><b class="num">${full(l.amt)} $${esc(l.t)}</b></div><div><span>Approval</span><b>Exactly this amount</b></div></div>${cancelBtn(hasBids(l) ? 'Cancel and refund the bidder' : 'Cancel and remove the approval')}<p class="fine" data-actmsg>Cancelling removes the approval${hasBids(l) ? ' and refunds the top bidder' : ''} in the same transaction.</p></section>`
        : `<section class="box ticket"><h3 class="box-t">Place a bid</h3><label class="field"><input id="bidIn" data-bid="${l.id}" inputmode="decimal" value="${esc(draft)}" aria-label="Your bid in SOL"><span>SOL</span></label>
        <div class="chips">${[['1', 'Min'], ['1.05', '+5%'], ['1.10', '+10%'], ['1.25', '+25%']].map(([m, n]) => `<button class="chip" data-act="bump" data-id="${l.id}" data-m="${m}">${n}</button>`).join('')}</div>
        <div class="rows"><div><span>Min next bid</span><b class="num" data-next-bid="${l.id}">${solX(v.nextMinBid ?? minimumNextBid(v.topBid, v.price))} SOL</b></div><div><span>You get</span><b class="num">${tokX(v.amount, l.dec)} $${esc(l.t)}</b></div><div><span>Fee</span><b>None</b></div></div>
        <button class="btn hot wide xl" data-act="bid" data-id="${l.id}">Place bid ${icon('arrow')}</button>
        <p class="fine" data-actmsg>${S.msg[l.id] ?? (S.mine[l.id] && v.topBidder === meW() ? '<span class="good">You hold the top bid.</span> Your SOL is in the contract.' : 'Bids can’t be withdrawn. Outbid? Your SOL comes back in the same transaction.')}</p><p class="fine cost">If you win and have no account for this coin yet, settling creates one for about 0.002 SOL of rent. Network fees are extra.</p></section>`
    }
    const facts = sellerFacts(l.seller.wallet), credits = creditsPanel(l.id)
    return `<section class="lot"><div class="wrap">
      <header class="lot-h">${art(l, 'lot-art')}<div class="lot-id"><p class="eyebrow">${lotNo(l)}${st === 'live' || st === 'ending' ? '' : ', ' + (fx && st === 'fixed' ? 'fixed price' : LABEL[st] ?? st)}${l.drop ? ' ' + dropTag(l, 'sm') : ''}</p><h1><a href="/coin/${l.mint}" title="Every listing of this coin">$${esc(l.t)}</a>${coinMark(l)}</h1><p>${esc(l.name)} <span>${tokX(l.v.amount, l.dec)} tokens${l.pct != null ? ', ' + pctS(l.pct) + ' of supply' : ''}</span><button class="cacopy full" data-act="copy" data-copy="${l.mint}" aria-label="Copy contract address"><span class="num addr-full">${l.mint}</span>${icon('copy')}</button>${authBadge(l)}</p></div>
        <div class="lot-meta">${st === 'live' || st === 'ending' ? liveDot(l) : fx && st === 'fixed' ? tag('Fixed price', 'fx') : tag(LABEL[st] ?? st, st === 'sold' || st === 'accept' || st === 'settling' ? 'hot' : '')}
          <dl><div><dt>Seller</dt><dd>${sellerEl(l.seller)}</dd></div><div><dt>${fx ? 'Type' : 'Bids'}</dt><dd class="num">${fx ? (l.onePer ? 'One per X account' : 'First buyer') : bidsOf(l).length ? bidCount(bidsOf(l).length) : 'None yet'}</dd></div><div><dt>Listed</dt><dd>${l.drop ? `On X by ${dropBy(l)}` : l.tagged ? 'By post on X' : l.listedAt ? `<span data-ago="${l.listedAt}">${agoS((now() - l.listedAt) / 1000)}</span>` : 'On this site'}</dd></div></dl></div></header>
      <div class="lot-g">
        <div class="lot-l">${main}
          <section class="box"><div class="box-h"><h3 class="box-t">All bids</h3>${bidsOf(l).length ? `<span class="k">${bidCount(bidsOf(l).length)}</span>` : ''}</div>${fx ? '<div class="nobid"><b>No bidding on fixed price.</b><p>The first buyer to sign takes every token listed.</p></div>' : `<div data-bids="${l.id}">${UI.bidList(l, st)}</div>`}</section>
          <div class="two">${holdersBox(l)}${chartOrChecks(l)}</div>
        </div>
        <aside class="lot-r">${credits}${l.drop ? `<section class="box xbox"><div class="box-h"><h3 class="box-t">Listed on X</h3>${dropTag(l, 'sm')}</div>${xPostCard(l.drop.post) || `<p class="fine">${dropBy(l)} posts each drop on X as it lists.</p>`}</section>` : ''}${act}${UI.costPanel(l)}
          <section class="box sellerp"><h3 class="box-t">Seller</h3><div class="sl-h">${avatar(l.seller, 'xl')}<div><b>${sellerTxt}</b><span>${facts && facts.xCreatedAt ? `${Math.max(1, Math.floor((now() - facts.xCreatedAt) / 31_557_600_000))}y on X, ${full(facts.followers ?? 0)} followers` : facts?.handle ? 'On X' : l.tagged ? 'Listed by X post' : 'No X account linked'}</span></div>${l.seller.handle ? `<a class="xlink" href="https://x.com/${esc(l.seller.handle)}" target="_blank" rel="noopener" aria-label="Open on X">${icon('xlogo')}</a>` : ''}</div>
            <div class="rows"><div><span>Past sales here</span><b class="num">${facts ? (facts.sales ? facts.sales : 'First sale') : 'Checking'}</b></div><div><span>Holds these tokens</span><b class="${holdsGood(v, now()) ? 'good' : v.stale ? 'warn-t' : ''}" data-holds="${l.id}"${v.tokenCheckedAt ? ` title="Read at ${utcFull(v.tokenCheckedAt)}"` : ''}>${holdsText(v, now())}</b></div><div><span>Listed via</span><b>${l.drop ? `Post by ${dropBy(l)}` : l.tagged ? `Post to ${esc(xName())}` : 'This site'}</b></div></div>
            <button class="btn line wide" data-act="share" data-id="${l.id}">Share this listing</button></section>
        </aside></div></div></section>`
  },

  sellForm() {
    const s = S.sell, coins = s.coins, w = meW()
    if (!w) return `<div class="step"><p class="step-k"><span>01</span>Pick the coin and amount</p><div class="nobid"><b>Connect to see your coins.</b><p>Your wallet’s coins load here. Nothing is signed until the last step.</p></div><button class="btn hot" data-act="connect">Connect</button></div>`
    if (coins === null) return `<div class="step"><p class="step-k"><span>01</span>Pick the coin and amount</p><div class="nobid"><b>Reading your wallet…</b><p>Coins in associated token accounts can be listed.</p></div></div>`
    if (!coins.length) return `<div class="step"><p class="step-k"><span>01</span>Pick the coin and amount</p><div class="nobid"><b>No coins found in this wallet.</b><p>Listing works for coins held in the wallet’s main token account for that coin.</p></div>${sellPasteBox()}</div>`
    const c = coins[Math.min(s.i, coins.length - 1)], cl = sellCoinLot(c), m = D.markets.get(c.mint)
    const keys = s.mode === 'bid' ? MIN_KEYS : PRICE_KEYS
    return `<div class="step"><p class="step-k"><span>01</span>Pick the coin and amount</p>
        <div class="wallet">${coins.map((w, i) => { const l = sellCoinLot(w); return `<button class="wrow ${i === s.i ? 'on' : ''}" data-act="sellCoin" data-v="${i}" data-mint="${w.mint}">${art(l, 'mini')}<span class="wrow-n"><b>${l.named ? '$' + esc(l.t) : 'Unknown token'}</b><small>${l.named ? esc(l.name) : `<span class="num">${short(l.mint)}</span>`}${w.listed ? ', listed' : ''}</small></span><span class="wrow-v"><b class="num">${big(l.amt)}</b><small>${l.pct != null ? pctS(l.pct) + ' supply' : ''}</small></span></button>` }).join('')}</div>${sellPasteBox()}
        <div class="lblrow"><span class="k">Amount</span><label class="custom amt"><input id="sellExact" inputmode="decimal" aria-label="Exact amount to sell" value="${esc(s.exact || (coin(c.mint) ? tokP(sellRaw(c), coin(c.mint).decimals) : ''))}"><span>${cl.named ? esc(cl.t) : 'tokens'}</span></label></div>${seg('sellPct', [[25, '25%'], [50, '50%'], [75, '75%'], [100, '100%']], s.exact ? '' : s.pct)}<p class="fine sell-line" data-sellline>${sellLine(c, cl)}</p></div>
      <div class="step"><p class="step-k"><span>02</span>Set the terms</p>${seg('sellMode', [['bid', 'Live auction'], ['fixed', 'Fixed price']], s.mode, 'big')}
        <div class="lblrow"><span class="k">${s.mode === 'bid' ? (m ? 'Minimum bid, share of chart value' : 'Minimum bid') : m ? 'Price, share of chart value' : 'Price'}</span><label class="custom"><input id="sellCustom" inputmode="decimal" placeholder="${s.mode === 'bid' ? 'None' : 'Price'}" value="${esc(s.custom)}"><span>SOL</span></label></div>
        ${m ? seg('sellMin', keys.map((k) => [k[0], k[1]]), curKey()) : ''}
        ${s.mode === 'bid' ? `<div class="lblrow"><span class="k">Length</span><span class="fine">late bids add up to 5 min</span></div>${seg('sellLen', LENGTHS, s.len)}` : '<p class="fine">First buyer takes it. No expiry. Cancel any time before someone buys.</p>'}</div>
      <div class="step"><p class="step-k"><span>03</span>Sign once</p><p class="mod-p">One approval for exactly this amount of this coin. Tokens stay in your wallet until the sale completes. ${s.mode === 'bid' ? 'Cancel any time before the countdown ends, or while there is no bid.' : 'Cancel any time before someone buys.'}</p></div>`
  },
  sellSummary() {
    const s = S.sell, coins = s.coins
    if (!meW() || !coins?.length) return `<div class="receive"><span class="k">You receive</span><b class="giant sm">${S.sell.mode === 'fixed' ? 'Your price' : 'Top bid'}</b><span class="sub">${S.sell.mode === 'fixed' ? 'Every lamport of your price. No fee to sell.' : 'The full winning bid. No fee to sell.'}</span></div><button class="btn hot wide xl" data-act="connect">${meW() ? 'Waiting for coins' : 'Connect, then sign'}</button><p class="fine">You approve exactly the amount you choose. Tokens stay in your wallet until the sale completes.</p>`
    const c = coins[Math.min(s.i, coins.length - 1)], l = sellCoinLot(c), v = sellValue(c), ch = sellChart(c), amt = sellAmt(c)
    const cm = ch && l.pool ? chartMath(ch, l.pool) : null, d = v && ch ? Math.round((v / ch - 1) * 100) : null
    // Sign waits for the coin's decimals and a fresh RPC read of the listing address, so the approval line is the wallet's
    const g = sellGate(coin(c.mint), sellCheck(c), coinFailed(c.mint)), listed = c.listed || !!g.listed
    return `<div class="sum-h">${art(l, 'sum-art')}<div><span class="k">You sell</span><b class="bignum">${big(amt)} <small>${l.named ? '$' + esc(l.t) : 'tokens'}</small></b><span class="sub">${l.pct != null ? pctS(l.pct * sellShare(c)) + ' of supply' : tokX(sellRaw(c), coin(c.mint)?.decimals ?? 0) + ' tokens'}</span></div></div>
      <div class="rows"><div><span>Type</span><b>${s.mode === 'bid' ? 'Live auction' : 'Fixed price'}</b></div>${s.mode === 'bid' ? `<div><span>Minimum</span><b class="num">${v ? sol(v) + ' SOL' : 'None'}</b></div><div><span>Length</span><b>${LENGTHS.find((k) => k[0] === s.len)[1]}</b></div>` : `<div><span>Price</span><b class="num">${v ? sol(v) + ' SOL' : 'Set a price'}</b></div>`}<div><span>${esc(B.name)} fee</span><b>None</b></div></div>
      <div class="receive"><span class="k">You receive</span><b class="giant sm">${s.mode === 'fixed' ? (v ? sol(v) + '<small> SOL</small>' : 'Your price') : v ? sol(v) + '<small> SOL+</small>' : 'Top bid'}</b><span class="sub">${d !== null && d !== 0 ? `${Math.abs(d)}% ${d < 0 ? 'under' : 'over'} chart value of ${sol(ch)} SOL` : ch ? `Chart value about ${sol(ch)} SOL` : 'The full winning bid goes to you.'}</span></div>
      ${cm ? `<div class="vsbox"><span class="k">Dump it on the chart instead</span><p>About <b class="num">${sol(cm.get)} SOL</b> and a price drop of <b class="num">${Math.round(cm.drop) < 1 ? 'less than 1%' : Math.round(cm.drop) + '%'}</b>. Here the chart stays flat.</p></div>` : ''}
      ${listed || !g.ok ? '' : approveLine(c, l)}
      ${g.retry && !c.listed ? '<button class="btn line wide" data-act="sellRecheck">Check again</button>' : ''}<button class="btn hot wide xl" data-act="sign" ${listed || (tradeReady() && !g.ok) ? 'disabled' : ''}>${listed ? 'Already listed' : !tradeReady() ? 'Connect, then sign' : g.ok ? `Sign and list ${big(amt)} ${coinName(l)}` : g.label}</button>
      <p class="fine" data-sellmsg>${listed ? 'This coin already has a live listing from this wallet. Cancel it first to list again.' : hasComma(s.custom) ? '<span class="warnm">Use a dot for decimals, like 1.5. Commas are not read.</span>' : `Tokens stay in your wallet until ${s.mode === 'bid' ? 'a bid wins and the sale completes' : 'someone buys'}.`}</p>`
  },
  myListings() {
    const mine = D.mine.map(lot).filter(Boolean)
    if (!mine.length) return ''
    return `<section class="box mylist"><div class="box-h"><h3 class="box-t">Your listings</h3><span class="k">${mine.length === 1 ? '1 open' : mine.length + ' open'}</span></div>
      <ul class="my-l">${mine.map((l) => { const st = statusOf(l), canCancel = !l.tagged && (['live', 'ending', 'fixed'].includes(st) || l.v.sellerMustCancel); return `<li>${art(l, 'tiny')}<a href="${lotHref(l)}"><b>$${esc(l.t)}</b><span>${big(l.amt)} tokens, ${LABEL[st] ?? st}</span></a><span class="num">${priceOf(l) ? sol(priceOf(l)) + ' SOL' : 'Any bid'}</span>${canCancel ? `<button class="btn line" data-act="cancel" data-id="${l.id}">${l.v.sellerMustCancel ? 'Remove approval' : 'Cancel'}</button>` : ''}</li>` }).join('')}</ul><p class="fine" data-actmsg></p></section>`
  },
  sell() {
    const done = S.sell.done ? lotById(S.sell.done) : null
    const body = done ? `<section class="box done"><span class="live big"><i></i>Live, ${lotNo(done)}</span><h2 class="h2">Your listing is live.</h2><p class="lede sm">Post it. A short post with the card link is what pulls bidders in.</p>
        <div class="sharecard">${art(done, 'mini')}<div><b>${big(done.amt)} $${esc(done.t)}</b><span>${done.mode === 'fixed' ? 'Fixed, ' + sol(done.price) + ' SOL' : 'Live auction, ' + (done.min ? 'min ' + sol(done.min) + ' SOL' : 'no minimum')}</span></div><span class="wm">${esc(B.name)}</span></div>
        <blockquote class="post-text">${esc(postText(done))}</blockquote>
        <div class="stage-a"><a class="btn hot" href="${tweet(postText(done))}" target="_blank" rel="noopener">Post on X</a><a class="btn line" href="${lotHref(done)}">Open your listing</a><button class="btn line" data-act="cancel" data-id="${done.id}" data-from="sell">Cancel listing</button><button class="btn line" data-act="sellAgain">List another</button></div><p class="fine" data-actmsg></p></section>`
      : S.sell.done ? `<section class="box done"><span class="live big"><i></i>Signed</span><h2 class="h2">Your listing is going live.</h2><p class="lede sm">The listing landed on chain. The card appears here as soon as the indexer reads it.</p></section>`
        : `<div class="sell-g"><section class="box form"><div id="sellForm">${UI.sellForm()}</div></section><aside class="box summary"><h2 class="box-t">Summary</h2><div id="sellSum">${UI.sellSummary()}</div></aside></div>`
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>Sell your tokens</p><h1 class="mega sm">Sell on the side.<br><span>Not on the chart.</span></h1><p class="lede">Your tokens stay in your wallet until a bid wins and the sale completes.</p></div></section>
      <section class="sec tight"><div class="wrap">${creditsPanel()}${UI.myListings()}${body}</div></section>
      <section class="sec engine"><div class="wrap byx"><div>${head('X', 'List from X', 'Or just post it.')}
        <p class="lede sm">Post to ${esc(xName())} with the amount, the CA and your settings. If your linked wallet holds those tokens on chain, the card goes live with no signature and we reply with the link. A post alone can never move tokens.</p>
        <div class="xpost">${avatar({ wallet: 'example' })}<div><b>Your post</b><p class="num">${esc(B.xHandle ? '@' + B.xHandle : '@us')} sell 40,000,000 &lt;CA&gt; min 5 sol 5 min</p></div></div>
        ${steps([['Link once', 'Sign in with X here and link a wallet. Changing it later waits 48 hours.'], ['Post amount, CA, settings', `If your wallet holds the tokens, the card goes live and ${esc(xName())} replies with its link.`], ['Accept within 10 minutes', 'When the countdown ends, sign once to accept the top bid. No accept means Seller ghosted and a full refund.']])}</div>
        <figure class="mod-fig"><div class="scrollx">${DIAGRAMS.post(B)}</div></figure></div></section>`
  },

  rewards() {
    const R = rewardsModel(), b = R.standings, pay = R.state === 'on'
    // Before payouts run the table is standings only: no payout column that can only say "not scheduled"
    const cap = pay ? '' : `<p class="fine rw-cap">Standings only. ${R.state === 'paused' ? 'Payouts are paused.' : 'Payouts start at launch.'}</p>`
    const table = b.length ? `${cap}<div class="scrollx"><table class="tbl board"><thead><tr><th>Rank</th><th>Seller</th><th class="r">SOL received</th><th class="r">Sales</th><th class="r">Share</th>${pay ? `<th class="r">${R.api ? 'Payout now' : 'Gap'}</th>` : ''}</tr></thead><tbody>${b.map((s, i) => `<tr class="${i < 3 ? 'top' : ''}"><td class="num"><span class="rank r${i}">${i + 1}</span></td><td>${sellerEl(s.p)}</td><td class="r num">${sol(s.sol)} SOL</td><td class="r num">${s.sales}</td><td class="r">${i < 3 ? tag(R.split[i] + '%', 'hot') : 'Outside top 3'}</td>${pay ? `<td class="r num">${i < 3 ? (s.pay ? sol(s.pay) + ' SOL' : 'At payout') : `${sol(b[2].sol - s.sol + 0.001)} SOL to #3`}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
      : `<div class="open3">${[0, 1, 2].map((i) => { const v = R.potAll != null ? (R.potAll * R.split[i]) / 100 : null; return `<div class="o3 p${i}"><span class="rank r${i}">${i + 1}</span><div class="o3-who"><b>Open place</b><span>${R.split[i]}% of the seller pot</span></div><div class="o3-v"><b class="num">${v ? sol(v) + '<small> SOL</small>' : R.state === 'on' ? 'Grows with fees' : R.state === 'paused' ? 'Paused' : 'At launch'}</b><span class="k">${v ? 'if the hour closed now' : 'this hour'}</span></div></div>` }).join('')}</div>
        <div class="o3-f"><p class="fine">Nobody has sold this hour yet. The first completed sale takes first place.</p><a class="btn hot" href="/sell">Sell your tokens ${icon('arrow')}</a></div>`
    const past = R.past.filter((h) => h.payouts.length || h.claim)
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>Seller rewards</p><h1 class="mega sm">Sell more.<br><span>Get paid hourly.</span></h1>
      <p class="lede">Every hour the creator fees from $${esc(B.ticker)} are claimed. 90% goes to the top 3 sellers of the hour, ranked by SOL received from completed sales, split 50 / 30 / 20. The other 10% goes to the team. The claim and every payout are public transactions.</p></div></section>
      <section class="sec tight"><div class="wrap">
        <div class="box rw"><div class="rw-h"><div><span class="k">This hour, ${hhmm(R.start)} to ${hhmm(R.end)}</span><b class="giant">${potEl(R)}</b><span class="sub">${R.pot == null ? 'Seller pot' : R.potKind === 'claimed' ? 'seller pot, claimed' : 'seller pot so far'}</span></div><div class="r"><span class="k">${R.state === 'on' ? 'Payout in' : 'Payout'}</span><span class="segcd lg">${payoutCd(R)}</span></div></div>
          ${table}</div>
        ${head('', 'History', 'Every payout, every tx.')}
        ${past.length ? `<div class="hours">${past.map((h) => `<article class="box hour"><header><b class="num">${hhmm(h.start)}<span> to ${hhmm(h.end)}</span></b><span class="k">${h.sales === 1 ? '1 sale' : h.sales ? h.sales + ' sales' : 'No sales'}</span><span class="pot num">${h.pot != null ? sol(h.pot) + ' SOL pot' : ''}</span></header>
          <ol>${h.payouts.map((s, i) => `<li><span class="rank r${i}">${s.rank ?? i + 1}</span>${sellerEl(s.p)}<b class="num">${sol(s.pay)} SOL</b>${txLink(s.sig) || '<span class="k">Sending</span>'}</li>`).join('')}</ol>${h.claim ? `<footer>Fee claim ${txLink(h.claim)}</footer>` : ''}</article>`).join('')}</div>`
          : `<div class="empty"><b>The first paid hour lands here.</b><p>${R.state === 'on' ? `Payout at ${hhmm(R.payoutAt)}: the` : R.state === 'paused' ? 'Payouts are paused. When they run, the' : 'Payouts start at launch. Each hour shows the'} fee claim and all three payouts, each with its transaction.</p>${nextDropLine()}</div>`}
      </div></section>`
  },

  tx() {
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>Read from chain</p><h1 class="mega sm">Every <span>transaction.</span></h1>
      <p class="lede">Every listing, bid, sale, refund and cancel on the contract, every hourly fee claim and every top seller payout. Newest first, 100 at a time. Each row links to Solscan.</p></div></section>
      <section class="sec tight"><div class="wrap">${trustStrip()}${launchTest()}<div data-feed>${feedTable(100)}</div><div class="feed-more" data-feedmore>${feedMore()}</div></div></section>`
  },
  log() {
    const items = D.log
    const body = items === null ? '<div class="empty"><b>Reading the log…</b></div>' : items.length ? `<ol class="log">${items.map((e) => `<li class="log-e ${e.kind === 'upgrade' ? 'up' : ''}"><time class="num">${esc(e.date)}</time><div><span class="tag ${e.kind === 'upgrade' ? 'red' : ''}">${esc(LOGKIND[e.kind] ?? e.kind ?? 'Note')}</span><h3>${esc(e.title)}</h3><p>${esc(e.body)}</p></div></li>`).join('')}</ol>` : '<div class="empty"><b>The first entry lands here.</b></div>'
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>Change log</p><h1 class="mega sm">What changed, <span>dated.</span></h1>
      <p class="lede">Every change to the contract, the server and this site, every bug and its fix, and every upgrade proposal the moment it is made. Newest first.</p></div></section>
      <section class="sec tight"><div class="wrap log-w">${body}</div></section>`
  },
  fixedEmpty() {
    if (!S.sell.touched) { S.sell.mode = 'fixed'; if (!S.sell.custom) S.sell.minKey = '80' }
    const sold = D.sales.filter((x) => x.kind === 'Bought').slice(0, 8).map((x) => ({ kind: 'sold', at: x.at ?? 0, mint: x.mint, amt: x.mint && x.decimals != null ? units(x.amount, x.decimals) : null, sol: lam(x.price), seller: person(x.seller), winner: person(x.winner), sig: x.sig, listing: x.listing }))
    return `<section class="phead"><div class="wrap"><p class="eyebrow"><i class="pulse"></i>Fixed price</p><h1 class="mega sm">This price.<br><span>First buyer.</span></h1>
      <p class="lede">No fixed price listing is up right now. Put one up here: pick a coin, set one price, sign once. The first buyer takes every token listed at exactly that price.</p></div></section>
      <section class="sec tight"><div class="wrap"><div class="sell-g"><section class="box form"><div id="sellForm">${UI.sellForm()}</div></section><aside class="box summary"><h2 class="box-t">Summary</h2><div id="sellSum">${UI.sellSummary()}</div></aside></div></div></section>
      ${sellHow('fixed')}
      ${sold.length ? `<section class="sec"><div class="wrap">${head('', 'Recently sold', 'Fixed price sales.')}${tapeHtml(sold)}</div></section>` : ''}`
  },
  notfound(t = 'Nothing at this address.', p = 'This page does not exist. Live auctions are one click away.') {
    return `<section class="phead nf"><div class="wrap"><p class="eyebrow"><span>404</span>Not found</p><h1 class="mega sm">${t}</h1><p class="lede">${p}</p><div class="be-a"><a class="btn hot xl" href="/live">See live auctions ${icon('arrow')}</a><a class="btn line xl" href="/">Home</a></div></div></section>
      <section class="sec tight"><div class="wrap"><span class="k facts-k">Live from chain</span>${factsGrid()}</div></section>`
  },
  coin(r) {
    const mint = r.a, c = coin(mint), keys = D.coinLots.get(mint), lots = (keys ?? []).map(lotById).filter(Boolean), sales = D.coinSales.get(mint) ?? []
    const live = lots.filter((l) => l.v.phase === 'live'), past = lots.filter((l) => l.v.phase !== 'live')
    const t = ticker(mint), L = { mint, t, img: c?.image ?? null }, name = clean(c?.name).trim()
    const rows = sales.map((x) => ({ kind: 'sold', at: x.at ?? 0, mint: x.mint, amt: x.decimals != null ? units(x.amount, x.decimals) : null, sol: lam(x.price), seller: person(x.seller), winner: person(x.winner), sig: x.sig, listing: x.listing }))
    return `<section class="lot coinp"><div class="wrap">
      <header class="lot-h">${art(L, 'lot-art')}<div class="lot-id"><p class="eyebrow">Coin</p><h1>${c?.symbol ? '$' + esc(t) : 'Unnamed coin'}${coinMark(L)}</h1><p>${name ? esc(name) + ' ' : ''}<button class="cacopy full" data-act="copy" data-copy="${mint}" aria-label="Copy contract address"><span class="num addr-full">${mint}</span>${icon('copy')}</button></p></div>
        <div class="lot-meta"><dl><div><dt>Live</dt><dd class="num">${keys ? (live.length || 'None now') : 'Reading'}</dd></div><div><dt>Sold here</dt><dd class="num">${keys ? (sales.length || 'None yet') : 'Reading'}</dd></div><div><dt>Supply</dt><dd class="num">${c ? big(units(c.supply, c.decimals)) : 'Reading'}</dd></div></dl></div></header>
      <div class="coin-b">${live.length ? `<div class="grid">${live.map(card).join('')}</div>` : emptyBoard(`No live listing of ${c?.symbol ? '$' + esc(t) : 'this coin'} right now.`)}</div>
      ${rows.length ? `<div class="coin-b">${head('', 'Sold here', 'Every sale of this coin.')}${tapeHtml(rows)}</div>` : ''}
      ${past.length ? `<div class="coin-b">${head('', 'Earlier listings', 'Closed, ended or cancelled.')}<ul class="my-l">${past.map((l) => `<li>${art(l, 'tiny')}<a href="${lotHref(l)}"><b>$${esc(l.t)}</b><span>${big(l.amt)} tokens, ${LABEL[statusOf(l)] ?? statusOf(l)}</span></a><span class="num">${priceOf(l) ? sol(priceOf(l)) + ' SOL' : ''}</span></li>`).join('')}</ul></div>` : ''}
    </div></section>`
  },
  docs() {
    const docs = DOCS(C, D.trust)
    return `<section class="docs"><div class="wrap docs-g">
      <nav class="rail" aria-label="Docs">${docs.map(([g, items], gi) => `<div class="rail-g"><b><span>${pad2(gi + 1)}</span>${g}</b>${items.map(([id, t]) => `<a href="/docs/${id}" data-act="docs" data-rail data-v="${id}">${t}</a>`).join('')}</div>`).join('')}</nav>
      <article class="prose"><p class="eyebrow"><span>Docs</span>Read before you bid</p><h1 class="mega sm">How it <span>works.</span></h1>
        ${docs.map(([g, items], gi) => `<div class="doc-g"><p class="doc-gh"><span>${pad2(gi + 1)}</span>${g}</p>${items.map(([id, t, html]) => `<section class="doc-sec" id="${id}"><h2>${t}</h2>${html}${id === 'contract' ? `<figure class="mod-fig"><div class="scrollx">${DIAGRAMS.atomic()}</div></figure>` : ''}${id === 'extra' ? `<figure class="mod-fig"><div class="scrollx">${DIAGRAMS.clock()}</div></figure>` : ''}${id === 'oneper' ? `<figure class="mod-fig"><div class="scrollx">${DIAGRAMS.pass()}</div></figure>` : ''}${id === 'bot' ? `<figure class="mod-fig"><div class="scrollx">${DIAGRAMS.bot()}</div></figure>` : ''}</section>`).join('')}</div>`).join('')}
      </article></div></section>`
  },
}
const LOGKIND = { upgrade: 'Upgrade', build: 'Build', fix: 'Fix', incident: 'Incident', launch: 'Launch', note: 'Note' }
const LABEL = { live: 'Live', ending: 'Ending', fixed: 'Fixed price', sold: 'Sold', gone: 'Gone', ghosted: 'Seller ghosted', ghosting: 'Seller ghosted', unfillable: 'Gone', settling: 'Settling', accept: 'Accept window', expired: 'Ended', cancelled: 'Cancelled', closed: 'Ended' }
const COST_LINE = 'Plus the network fee, and about 0.002 SOL of rent if you have no account for this coin yet.'
const PROMISES = [
  'Your tokens stay in your wallet until a bid wins and the sale completes.',
  'When a sale completes, tokens and SOL swap in one transaction, or nothing happens.',
  'We never hold your keys. You approve one amount of one coin. Cancel any time before the countdown ends, or while there is no bid. Cards listed by post cannot be cancelled.',
  'Bids sit in the contract until they win or get refunded.',
]
const PROMISE_HEADS = ['In your wallet', 'One transaction', 'Your keys', 'Where bids sit']
const streamRows = (bids, n = 5) => bids.slice(0, n).map((b, i) => `<li class="${i === 0 ? 'top' : ''}">${avatar(b.p)}<span>${xLink(b.p)}</span><b class="num">${sol(b.sol)} <small>SOL</small></b>${b.at ? `<em class="num" data-ago="${b.at}">${agoS((now() - b.at) / 1000)}</em>` : '<em class="num"></em>'}</li>`).join('')
function potEl(R, cls = '') {
  if (R.state === 'paused') return `<span class="num ${cls}" data-pot><span class="n pot-wait">Paused</span></span>`
  return R.pot ? `<span class="num ${cls}" data-pot><span class="n">${sol(R.pot)}</span><small> SOL</small></span>` : `<span class="num ${cls}" data-pot><span class="n pot-wait">${R.pot === 0 ? 'Nothing yet' : 'Opens at launch'}</span></span>`
}
/** Only a running payout gets a countdown. Off or paused, the site makes no promise about when. */
const payoutCd = (R) => R.state === 'on' ? `<span class="cd num" data-at="${R.payoutAt}" data-hour>${clock((R.payoutAt - now()) / 1000)}</span>` : `<span class="cd num off">${R.state === 'paused' ? 'Paused' : 'At launch'}</span>`
function podium(R, i) {
  const s = R.standings[i]
  if (!s) return `<li class="pod p${i} open"><div class="pod-who"><span class="av lg pod-open">${icon('plus')}</span><b>Open spot</b><span>Sell tokens to take it</span></div><div class="pod-bar"><span class="pod-rank">${i + 1}</span><b class="num">${R.split[i]}% of the pot</b><span class="pod-pct">${R.split[i]}%</span></div></li>`
  const share = R.pot != null ? sol((R.pot * R.split[i]) / 100) + ' SOL' : `${R.split[i]}% of the pot`
  return `<li class="pod p${i}"><div class="pod-who">${avatar(s.p, 'lg')}<b>${xLink(s.p)}</b><span>${sol(s.sol)} SOL sold</span></div><div class="pod-bar"><span class="pod-rank">${i + 1}</span><b class="num">${share}</b><span class="pod-pct">${R.split[i]}%</span></div></li>`
}

// ---------- sell helpers
const MIN_KEYS = [['none', 'None', 0], ['50', '50%', 0.5], ['70', '70%', 0.7], ['90', '90%', 0.9]]
const PRICE_KEYS = [['70', '70%', 0.7], ['80', '80%', 0.8], ['90', '90%', 0.9], ['100', '100%', 1]]
const LENGTHS = [[120, '2 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 hour']]
const seg = (act, opts, cur, cls = '') => `<div class="seg ${cls}">${opts.map(([v, n]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${n}</button>`).join('')}</div>`
const sellCoinLot = (c) => {
  const info = coin(c.mint), m = D.markets.get(c.mint), dec = info?.decimals ?? c.decimals ?? 0, amt = units(c.amount, dec), supply = info ? units(info.supply, info.decimals) : null
  // Chain metadata first, then what the server's indexer knows. A coin with neither still shows, as an unknown token.
  const sym = clean(info?.symbol).trim() || clean(c.symbol).trim(), name = clean(info?.name).trim() || clean(c.name).trim()
  const named = !!sym, img = c.image ?? (named ? info?.image ?? null : null)
  return { id: c.mint, mint: c.mint, t: named ? sym.toUpperCase().slice(0, 12) : ticker(c.mint), named, name: name || 'Unknown token', img, neutral: !named && !img, amt, pct: supply ? (amt / supply) * 100 : null, chart: m ? m.priceSol * amt : null, pool: m?.poolSol ?? null }
}
/** The box to pick a coin that is not in the list by its contract address. */
const sellPasteBox = () => `<div class="lblrow sellca"><span class="k">Not in the list?</span><label class="custom ca"><input id="sellCa" autocomplete="off" spellcheck="false" placeholder="Paste a token CA" aria-label="Paste a token CA" value="${esc(S.sell.ca ?? '')}"><button class="linkb" data-act="sellPaste">Find</button></label></div><p class="fine" data-pastemsg>${S.sell.caMsg ?? ''}</p>`
/** The line shown right before signing. The amount is every digit, as the wallet shows it. */
const coinName = (l) => (l.named ? '$' + esc(l.t) : `tokens of <span class="num">${short(l.mint)}</span>`)
const approveText = (c, l) => `You approve exactly <b class="num">${tokX(sellRaw(c), coin(c.mint)?.decimals ?? 0)}</b> ${coinName(l)} for listing <span class="num">${short(P.listingPda(c.tokenAccount).toBase58())}</span>, the address your wallet names. ${S.sell.mode === 'bid' ? 'You can cancel any time before the countdown ends, or while there is no bid.' : 'You can cancel any time before someone buys.'}`
const approveLine = (c, l) => `<p class="approve" data-approve>${icon('check')}<span>${approveText(c, l)}</span></p>`
/** Raw units the form lists, or null when the typed amount can't be read. */
const sellRawOk = (c) => sellPick(c.amount, S.sell.pct, S.sell.exact, coin(c.mint)?.decimals ?? 0)
const sellRaw = (c) => sellRawOk(c) ?? 0n
/** "Selling 150,000,000 of 300,000,000 TRUMP", or what is wrong with the typed amount. */
function sellLine(c, l) {
  if (!coin(c.mint)) return 'Reading the coin…'
  const dec = coin(c.mint).decimals, raw = sellRawOk(c), bal = BigInt(c.amount), name = l.named ? esc(l.t) : 'tokens'
  if (raw === null) return `<span class="warnm">Type an amount like 1500000 or 1.5, up to ${dec} decimals.</span>`
  if (raw > bal) return `<span class="warnm">That is more than the ${tokX(bal, dec)} ${name} in this wallet.</span>`
  if (raw <= 0n) return '<span class="warnm">Pick an amount above zero.</span>'
  return `Selling <b class="num">${tokX(raw, dec)}</b> of <b class="num">${tokX(bal, dec)}</b> ${name}`
}
const sellAmt = (c) => units(sellRaw(c), coin(c.mint)?.decimals ?? 0)
const sellShare = (c) => { const b = BigInt(c.amount); return b > 0n ? Number(sellRaw(c)) / Number(b) : 0 }
const sellChart = (c) => { const l = sellCoinLot(c); return l.chart ? l.chart * sellShare(c) : null }
function sellValue(c) {
  const s = S.sell
  if (s.custom) { const v = parseSol(s.custom); return v ? Number(v) / 1e9 : 0 }
  const ch = sellChart(c), keys = s.mode === 'bid' ? MIN_KEYS : PRICE_KEYS
  if (!ch) return 0
  const k = keys.find((x) => x[0] === s.minKey) ?? (s.mode === 'bid' ? MIN_KEYS[0] : PRICE_KEYS[1])
  return Math.round(k[2] * ch * 1000) / 1000
}
const curKey = () => { const s = S.sell, keys = s.mode === 'bid' ? MIN_KEYS : PRICE_KEYS; return s.custom ? '' : keys.some((k) => k[0] === s.minKey) ? s.minKey : s.mode === 'bid' ? 'none' : '80' }
const postText = (l) => { const url = l.v.share?.url ?? `${location.origin}/c/${l.id}`; return l.v.phase === 'sold' ? `Sold ${big(l.amt)} $${l.t} in one sale. ${sol(l.top)} SOL, one transaction, chart untouched. ${url}` : l.mode === 'fixed' ? `${big(l.amt)} $${l.t} for ${sol(l.price)} SOL. This price only. First buyer takes it. ${url}` : `${big(l.amt)} $${l.t} is up for bids on ${B.name}. Best bid takes all ${big(l.amt)}. ${url}` }
const tweet = (t) => 'https://x.com/intent/post?text=' + encodeURIComponent(t)
async function loadSellCoins() {
  const w = meW()
  if (!w) { S.sell.coins = null; return }
  try {
    const coins = await CH.walletCoins(w)
    const listed = new Set(D.mine.map((v) => v.tokenAccount))
    S.sell.coins = coins.map((c) => ({ ...c, listed: listed.has(c.tokenAccount) }))
    S.sell.ca = ''; S.sell.caMsg = ''
    S.sell.check = {}
    coins.forEach((c) => coin(c.mint))
  } catch { S.sell.coins = [] }
  if (sellOnPage()) refreshSell()
}
/** Picks a coin by pasted contract address: one already listed above is selected, any other is looked up for this wallet. */
async function sellPaste() {
  const w = meW(), mint = String($('#sellCa')?.value ?? '').trim()
  S.sell.ca = mint
  const say = (h) => { S.sell.caMsg = h; flash('[data-pastemsg]', h) }
  if (!w) return
  if (!CH.isKey(mint)) return say('<span class="warnm">That is not a token address. Paste the coin’s CA.</span>')
  const pick = () => { S.sell.i = S.sell.coins.findIndex((c) => c.mint === mint); S.sell.custom = ''; S.sell.pct = 100; S.sell.exact = ''; S.sell.caMsg = ''; refreshSell() }
  if (S.sell.coins?.some((c) => c.mint === mint)) return pick()
  say('<span class="busy">Looking it up…</span>')
  try {
    const [c] = await CH.walletCoins(w, mint)
    if (meW() !== w) return
    if (!c) return say('This wallet holds none of that token in its main token account.')
    const listed = new Set(D.mine.map((v) => v.tokenAccount))
    S.sell.coins = [...(S.sell.coins ?? []), { ...c, listed: listed.has(c.tokenAccount) }]
    coin(c.mint)
    pick()
  } catch { say('<span class="warnm">Could not read that token right now. Try again.</span>') }
}
/** The listing address these tokens would use, read from the RPC once per wallet read. An account there means a live listing. */
function sellCheck(c) {
  const k = c.tokenAccount, cur = S.sell.check[k]
  if (cur) return cur
  const mine = S.sell.check[k] = { state: 'checking' }
  CH.accountExists(P.listingPda(c.tokenAccount)).then((x) => { mine.state = x ? 'listed' : 'free'; mine.at = Date.now() }, () => { mine.state = 'error' })
    .finally(() => { if (S.sell.check[k] === mine && sellOnPage()) refreshSell() })
  return mine
}
function refreshSellSum() {
  const s = $('#sellSum'), c = S.sell.coins?.[S.sell.i], ln = $('[data-sellline]'), x = $('#sellExact')
  if (s) s.innerHTML = UI.sellSummary()
  if (c && ln) ln.innerHTML = sellLine(c, sellCoinLot(c))
  // The amount box follows the chips and a late coin read, but never rewrites what someone is typing
  if (c && x && !S.sell.exact && document.activeElement !== x) x.value = coin(c.mint) ? tokP(sellRaw(c), coin(c.mint).decimals) : ''
}
function refreshSell() { const f = $('#sellForm'), s = $('#sellSum'); if (f) f.innerHTML = UI.sellForm(); if (s) s.innerHTML = UI.sellSummary() }

// ---------- actions
const flash = (sel, h) => { const e = $(sel); if (e) e.innerHTML = h }
const ACT = {
  filter: (e) => { S.filter = e.dataset.v; if (e.dataset.clear) { S.q = ''; $$('[data-search]').forEach((i) => (i.value = '')) } if (route.v === 'fixed' && S.filter !== 'Fixed price') { nav('/live'); return } rerender() },
  sort: (e) => { S.sort = e.dataset.v; rerender() },
  feedMore: async (e) => { e.disabled = true; await loadFeedOlder(); const m = $('[data-feedmore]'); if (m) m.innerHTML = feedMore() },
  copy: (e) => { const v = e.dataset.copy; try { navigator.clipboard?.writeText(v).catch(() => {}) } catch {} toast('<b>Copied.</b>') },
  connect: (e) => {
    if (meW() && !e?.dataset?.force) return openSheet('account')
    // With Privy, Connect is Privy's modal in one press; signed in with no wallet, it is the wallet step
    if (privyOn() && !signedIn() && C.live.signin) return privySignIn()
    openSheet('connect', 'trade')
  },
  signin: () => {
    if (privyOn()) return privySignIn()
    try { sessionStorage.setItem('ws.back', location.pathname + location.hash); sessionStorage.setItem('ws.resume', '1') } catch {} location.href = '/api/auth/x/start'
  },
  pickPrivy: async (e) => { const x = privyWallets().find((v) => v.address === e.dataset.v); if (!x) return; if (meW() !== x.address) W.connectPrivy(x.address, x); await afterWallet({ link: true }) },
  privyConnect: () => privyConnectWallet(),
  privyCreate: () => privyCreateWallet(),
  pickWallet: async (e) => {
    const r = W.walletChoices().find((x) => x.name === e.dataset.v)
    if (!r?.wallet) return
    try { await W.connect(r.wallet); await afterWallet() } catch (err) { flash('[data-sheetmsg]', `<span class="warnm">${/reject|denied|cancel/i.test(String(err?.message)) ? 'You cancelled in your wallet.' : 'The wallet did not connect.'}</span>`) }
  },
  linkWallet: () => linkWallet(),
  cancelChange: async () => { await post('/api/wallet/cancel-change'); await loadMe(); redrawSheet() },
  disconnect: async () => { await W.disconnect(); closeSheet(); updateConn(); toast('<b>Disconnected.</b>'); rerender() },
  signout: async () => {
    await post('/api/auth/logout')
    if (privyApi) { if (W.connectedWallet()?.privy) W.forget(); await privyApi.logout() }
    await loadMe(); closeSheet(); updateConn(); toast(privyOn() ? '<b>Signed out.</b>' : '<b>Signed out of X.</b>'); rerender()
  },
  closeSheet,
  bump: (e) => {
    const l = lotById(e.dataset.id); if (!l) return
    const minL = BigInt(l.v.nextMinBid ?? minimumNextBid(l.v.topBid, l.v.price)), base = hasBids(l) ? BigInt(l.v.topBid) : minL
    const want = (base * BigInt(Math.round(Number(e.dataset.m) * 1000))) / 1000n
    const v = want > minL ? want : minL
    $('#bidIn').value = solP(v); S.bidDraft[l.id] = $('#bidIn').value
  },
  bid: (e) => need('trade', () => {
    const id = e.dataset.id, typed = $('#bidIn')?.value, raw = parseSol(typed), seen = lotById(id)?.v
    return run('[data-actmsg]', e, 'bid', async () => {
      if (hasComma(typed)) throw new CH.TxError('Use a dot for decimals, like 1.5. Commas are not read.')
      const l = await fresh(lotById(id))
      if (l.v.phase !== 'live') throw new CH.TxError('The countdown has ended. Nothing moved.')
      const c = await onChain(seen, ['mint', 'amount', 'seller'])
      const minL = minimumNextBid(c.topBid, c.price)
      if (!raw || raw < minL) throw new CH.TxError(`The next bid must be at least ${solX(minL)} SOL. Every raise beats the top bid by 2% or 0.001 SOL, whichever is larger.`)
      return [P.ix.bid(c, meW(), raw)]
    }, async (sig) => {
      S.mine[id] = raw; delete S.bidDraft[id]
      S.msg[id] = `<span class="good">You hold the top bid.</span> Your SOL is in the contract. ${txLink(sig, 'View tx')} <button class="linkb" data-act="share" data-id="${id}">Share it</button>`
      toast(`<b>Bid placed.</b> ${solX(raw)} SOL is held in the contract.`, 'ok')
      await loadOne(id); rerender()
    })
  }),
  buy: (e) => need('trade', () => {
    const id = e.dataset.id, seen = lotById(id)?.v
    return run('[data-actmsg]', e, 'buy', async () => {
      const l = await fresh(lotById(id))
      if (l.v.phase !== 'live') throw new CH.TxError('Someone else bought this first. Nothing moved.')
      const c = await onChain(seen, ['mint', 'amount', 'price', 'seller'])
      const { ata, ix } = ataFor(meW(), l)
      if (!l.onePer) return [ix, P.ix.buyFixed(c, meW(), ata)]
      flash('[data-actmsg]', '<span class="busy">Getting your one per account pass…</span>')
      const r = await post('/api/pass', { listing: l.id, wallet: meW() })
      if (!r.ok) throw new CH.TxError(PASS_WHY[r.body?.error] ?? 'The pass server said no. Nothing moved.', { code: r.body?.error })
      return [ix, ...P.ix.buyWithPass(c, meW(), ata, r.body)]
    }, async (sig) => {
      const l = lotById(id)
      S.bought = S.bought ?? {}; S.bought[id] = S.msg[id] = `<span class="good">Done.</span> ${full(l.amt)} $${esc(l.t)} is in your wallet. ${txLink(sig, 'View the swap')}`
      toast(`<b>Bought.</b> ${big(l.amt)} $${esc(l.t)} for ${solX(l.v.price)} SOL.`, 'ok')
      await Promise.all([loadOne(id), loadActivity()]); rerender()
      flash('[data-actmsg]', S.msg[id])
    })
  }),
  accept: (e) => need('wallet', () => {
    const id = e.dataset.id, seen = lotById(id)?.v
    return run('[data-actmsg]', e, 'accept', async () => {
      const l = await fresh(lotById(id))
      if (meW() !== l.v.seller.wallet) throw new CH.TxError('Only the wallet that listed this can accept. Connect that wallet.')
      const c = await onChain(seen, ['mint', 'amount', 'topBid', 'topBidder'])
      const { ata, ix } = ataFor(c.topBidder, l)
      return [ix, P.ix.accept(c, meW(), c.tokenAccount, ata)]
    }, async (sig) => { toast(`<b>Accepted.</b> Tokens and SOL swapped in one transaction. ${txLink(sig)}`, 'ok'); await Promise.all([loadOne(id), loadActivity()]); rerender() })
  }),
  settle: (e) => need('wallet', () => {
    const id = e.dataset.id
    return run('[data-actmsg]', e, 'settle', async () => {
      const l = await fresh(lotById(id))
      if (l.v.phase !== 'settling') { rerender(); return null }
      const { ata, ix } = ataFor(l.v.topBidder, l)
      return [ix, P.ix.settle(l.v, ata)]
    }, async (sig) => { toast(`<b>Settled.</b> Tokens to the winner, SOL to the seller. ${txLink(sig)}`, 'ok'); await Promise.all([loadOne(id), loadActivity()]); rerender() })
  }),
  refund: (e) => need('wallet', () => {
    const id = e.dataset.id
    return run('[data-actmsg]', e, 'refund', async () => { const l = await fresh(lotById(id)); return [P.ix.refund(l.v)] },
      async (sig) => { toast(`<b>Refund sent.</b> The bidder has every lamport back. ${txLink(sig)}`, 'ok'); await Promise.all([loadOne(id), loadActivity()]); rerender() })
  }),
  close: (e) => need('wallet', () => {
    const id = e.dataset.id
    return run('[data-actmsg]', e, 'close', async () => { const l = await fresh(lotById(id)); return [P.ix.close(l.v)] },
      async (sig) => { toast(`<b>Closed.</b> The rent went back to whoever paid it. ${txLink(sig)}`, 'ok'); await loadOne(id); rerender() })
  }),
  cancel: (e) => need('wallet', () => {
    const id = e.dataset.id
    return run('[data-actmsg]', e, 'cancel', async () => {
      const l = await fresh(lotById(id))
      if (meW() !== l.v.seller.wallet) throw new CH.TxError('Only the wallet that listed this can cancel it.')
      return [P.ix.cancel(l.v, meW())]
    }, async (sig) => {
      toast(`<b>Cancelled.</b> Nothing moved and the approval is removed. ${txLink(sig)}`, 'ok')
      if (e.dataset.from === 'sell') S.sell.done = null
      await Promise.all([loadOne(id), loadMine(meW())]); await loadSellCoins(); rerender()
    })
  }),
  claim: (e) => need('wallet', () => {
    const id = e.dataset.id
    return run('[data-claimmsg]', e, 'claim', async () => [P.ix.claimCredit(meW(), id, meW())],
      async (sig) => { toast(`<b>Claimed.</b> The credit is in your wallet. ${txLink(sig)}`, 'ok'); D.credits = D.credits.filter((c) => c.listing !== id); redrawSheet(); rerender(); setTimeout(() => loadMine(meW()), 4000) })
  }),
  share: (e) => { const l = lotById(e.dataset.id); if (!l) return; const text = postText(l); sheet(`<p class="sheet-k">Share</p><h3 class="sheet-t">${big(l.amt)} $${esc(l.t)}</h3><blockquote class="post-text">${esc(text)}</blockquote><a class="btn hot wide" href="${tweet(text)}" target="_blank" rel="noopener">Post on X</a>`) },
  sellPaste: () => sellPaste(),
  sellCoin: (e) => { S.sell.i = +e.dataset.v; S.sell.custom = ''; S.sell.pct = 100; S.sell.exact = ''; refreshSell() },
  sellPct: (e) => { S.sell.pct = +e.dataset.v; S.sell.exact = ''; refreshSell() },
  sellMode: (e) => { S.sell.touched = true; S.sell.mode = e.dataset.v; S.sell.custom = ''; S.sell.minKey = e.dataset.v === 'bid' ? 'none' : '80'; refreshSell() },
  sellMin: (e) => { S.sell.minKey = e.dataset.v; S.sell.custom = ''; refreshSell() },
  sellLen: (e) => { S.sell.len = +e.dataset.v; refreshSell() },
  sellAgain: () => { S.sell.done = null; rerender() },
  sellRecheck: () => { const c = S.sell.coins?.[S.sell.i]; if (c) { delete S.sell.check[c.tokenAccount]; if (coinFailed(c.mint)) retryCoin(c.mint) } refreshSell() },
  sign: (e) => need('trade', () => {
    const s = S.sell, c = s.coins?.[s.i]
    if (!c) return
    return run('[data-sellmsg]', e, 'sign', async () => {
      const raw = sellRaw(c)
      if (!sellGate(coin(c.mint), sellCheck(c), coinFailed(c.mint)).ok) throw new CH.TxError('Wait for the coin and the chain check to load.')
      // Read again right before the wallet opens: a listing made from another tab since the last check is caught here
      if (await CH.accountExists(P.listingPda(c.tokenAccount))) { S.sell.check[c.tokenAccount] = { state: 'listed', at: Date.now() }; refreshSell(); throw new CH.TxError('This coin already has a live listing from this wallet. Cancel it first to list again.') }
      if (sellRawOk(c) === null) throw new CH.TxError('Type an amount like 1500000 or 1.5.')
      if (raw > BigInt(c.amount)) throw new CH.TxError('That is more than this wallet holds.')
      if (raw <= 0n) throw new CH.TxError('Pick an amount above zero.')
      if (hasComma(s.custom)) throw new CH.TxError('Use a dot for decimals, like 1.5. Commas are not read.')
      const v = sellValue(c), lamports = v ? parseSol(String(v)) : null
      if (s.mode === 'fixed' && (!lamports || lamports < 1_000_000n)) throw new CH.TxError('Set a price of at least 0.001 SOL.')
      if (s.mode === 'bid' && lamports !== null && lamports > 0n && lamports < 1_000_000n) throw new CH.TxError('The lowest minimum is 0.001 SOL.')
      const price = lamports && lamports >= 1_000_000n ? lamports : 1_000_000n
      const out = P.ix.createListing({ seller: meW(), mint: c.mint, tokenProgram: c.tokenProgram, mode: s.mode === 'fixed' ? 'fixed' : 'bidding', amount: raw, price, duration: s.mode === 'fixed' ? 0 : s.len })
      s.pending = out.listing.toBase58()
      return [out.ix]
    }, async (sig) => {
      const pk = s.pending
      s.done = pk
      s.check[c.tokenAccount] = { state: 'listed', at: Date.now() }
      toast(`<b>Signed.</b> Your listing is live. ${txLink(sig)}`, 'ok')
      rerender()
      for (let i = 0; i < 20; i++) { const v = await loadOne(pk); if (v && !v.closed) break; await new Promise((r) => setTimeout(r, 1000)) }
      await loadMine(meW()); rerender()
    }, () => `<span class="approve-inline">${approveText(c, sellCoinLot(c))}</span>`)
  }),
  docs: (e) => { const id = e.dataset.v, t = document.getElementById(id); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '/docs/' + id); setRail(id) } },
  menu: () => document.body.classList.toggle('menu-open'),
}
const PASS_WHY = {
  already_claimed: 'One per X account. This account already claimed this drop, and the contract would refuse a second claim.',
  pass_live_for_another_wallet: 'A pass for this drop is already out for your other wallet. Wait two minutes or use that wallet.',
  no_wallet: 'Link a wallet to your X account first.', not_your_linked_wallet: 'Connect the wallet linked to your X account.',
  not_a_live_fixed_listing: 'This deal is no longer live.', unknown_campaign: 'This drop is not open for passes.', pass_off: 'One per account drops open at launch.',
  x_needed: 'One per X account: sign in again and link your X account to claim this.',
  sign_in_first: 'Sign in first.', chain_read_failed: 'The chain did not answer. Try again in a moment.', slow_down: 'Too many tries. Wait a minute.',
}
const linkRefused = new Set() // wallets whose automatic link was cancelled or refused: never asked again by itself
async function afterWallet({ link = false } = {}) {
  updateConn()
  await loadMe()
  const w = meW()
  // The wallet picked in Privy becomes the account's wallet with no extra press: at once when Privy verified it, else
  // with one message to sign. A cancelled or refused link is not asked for again by itself; the Link button stays.
  if (link && privyOn() && D.me.signedIn && w && D.me.wallet !== w && D.me.pendingWallet !== w && !(D.me.wallet && D.me.changeWaits) && !linkRefused.has(w)) { if (!(await linkWallet())) linkRefused.add(w) }
  await loadMine(w)
  if (D.credits.length) toast(`<b>You have a credit.</b> ${sol(D.credits.reduce((a, c) => a + lam(c.lamports), 0))} SOL to claim under your account.`)
  redrawSheet(); updateConn()
  loadSellCoins()
  resume()
  if (!S.then) { if (S.sheet?.kind === 'connect' && (S.sheet.need === 'wallet' || tradeReady())) { closeSheet(); toast(D.me.signedIn ? '<b>Connected.</b> Signed in and wallet linked.' : '<b>Wallet connected.</b>', 'ok') } rerender() }
}
// ---------- Privy sign in
let privyApi = null, privyLoading = null, privySeen = 0, privyBusy = false, privyGone = null
/** Loads Privy's island once, on first need. Its bundle is large, so it is never part of the first page load. */
function loadPrivy() {
  if (privyApi) return Promise.resolve(privyApi)
  privyLoading ??= import(/* @vite-ignore */ __PRIVY_JS__).then((m) => {
    privyApi = m.start({ appId: C.auth.privy.appId, clientId: C.auth.privy.clientId, rpc: C.chain.rpc, ws: C.chain.ws, cluster: C.chain.cluster, name: B.name, logo: `${location.origin}/brand/logo-96.png` })
    W.usePrivy(privyApi)
    privyApi.onChange(syncPrivy)
    // Back from X's own sign in page: Privy finishes by itself, and the site finishes with it, no second press
    privyApi.onLogin(() => { finishPrivy().catch(privyFailed) })
    return privyApi
  }).catch((e) => { privyLoading = null; throw e })
  return privyLoading
}
const privyWallets = () => (privyApi ? privyApi.wallets() : [])
/** True for a wallet Privy verified for this account: linking it needs no message. */
const privyVerified = (a) => !!privyApi && privyApi.linked().includes(a)
/**
 * Keeps the site's wallet the one picked in Privy. A wallet picked in Privy's modal takes over at once; a wallet Privy
 * no longer has (disconnected there, or signed out) is dropped, after a moment so a redraw inside Privy does not count.
 */
function syncPrivy() {
  if (!privyApi || privyBusy) return
  const c = privyApi.chosen(), list = privyApi.wallets()
  if (c && c.n !== privySeen) {
    const x = list.find((v) => v.address === c.address)
    if (x) { privySeen = c.n; if (meW() !== x.address) { W.connectPrivy(x.address, x); afterWallet({ link: true }) } return }
  }
  const cur = W.connectedWallet()
  if (cur?.privy && privyApi.walletsReady() && !list.some((v) => v.address === cur.address)) {
    privyGone ??= setTimeout(() => {
      privyGone = null
      const now = W.connectedWallet()
      if (now?.privy && now.address === cur.address && !privyApi.wallets().some((v) => v.address === cur.address)) { W.forget(); afterWallet(); toast('<b>Wallet disconnected.</b>') }
    }, 1500)
  }
}
const privyWhy = (code) => (/exited|cancel|closed/i.test(String(code)) ? 'Sign in was closed. Nothing changed.' : code === 'no_identity_token' ? 'Sign in is not fully set up yet (identity tokens are off). Try again later.' : code === 'slow_down' ? 'Too many tries. Wait a minute.' : 'Sign in did not finish. Try again.')
function privyFailed(e) {
  const code = e?.code ?? e?.message, why = privyWhy(code)
  flash('[data-sheetmsg]', `<span class="warnm">${why}</span>`)
  if (!$('[data-sheetmsg]')) toast(`<b>${why}</b>`)
  if (!/exited|cancel|closed/i.test(String(code))) console.error(e)
}
/** Privy's modal in one press, then our own session from Privy's signed tokens, then the wallet picked there. */
async function privySignIn() {
  if (S.busy) return
  S.busy = 'signin'
  flash('[data-sheetmsg]', '<span class="busy">Opening sign in…</span>')
  try {
    const api = await loadPrivy()
    // X signs in on its own page: this note brings the sign in back to finish when the page loads again
    try { sessionStorage.setItem('ws.privyLogin', String(Date.now())) } catch {}
    privyBusy = true
    const s = await api.login()
    privyBusy = false
    S.busy = null
    await finishPrivy(s)
  } catch (e) { privyFailed(e) } finally {
    privyBusy = false
    if (S.busy === 'signin') S.busy = null
    try { sessionStorage.removeItem('ws.privyLogin') } catch {}
  }
}
let finishing = null
const finishPrivy = (s = null) => (finishing ??= finishPrivyNow(s).finally(() => { finishing = null }))
async function finishPrivyNow(s) {
  const api = privyApi
  s ??= await api.session()
  if (!s) return
  // The wallet: the one picked in Privy's modal, else the one this browser already uses if Privy still has it. Never a
  // wallet nobody picked, and never one Privy made unless the person asked for it.
  const have = s.wallets.map((x) => x.address)
  const pick = [s.chosen, meW()].find((a) => a && have.includes(a)) ?? null
  if (pick && meW() !== pick) W.connectPrivy(pick, s.wallets.find((x) => x.address === pick))
  privySeen = api.chosen()?.n ?? privySeen
  const r = await post('/api/auth/privy', { accessToken: s.accessToken, identityToken: s.identityToken, wallet: pick && s.linked.includes(pick) ? pick : null, avatar: s.avatar })
  if (!r.ok) throw Object.assign(new Error(r.body?.error ?? 'signin'), { code: r.body?.error })
  flash('[data-sheetmsg]', '')
  await afterWallet({ link: true })
  updateConn()
  if (D.me.signedIn && !tradeReady()) { if (S.sheet?.kind !== 'connect') openSheet('connect', S.then?.kind ?? 'trade'); else redrawSheet() }
  else if (D.me.signedIn && !S.then) toast(`<b>Signed in.</b> ${meName()}`, 'ok')
}
/** Coming back from X's page after Privy's sign in: Privy is loaded at once and the sign in finishes by itself. */
async function resumePrivyLogin() {
  let at = 0
  try { at = Number(sessionStorage.getItem('ws.privyLogin') || 0) } catch {}
  const back = /[?&]privy_oauth_/.test(location.search)
  if (!back && !(at && Date.now() - at < 15 * 60_000)) return
  try { sessionStorage.removeItem('ws.privyLogin') } catch {}
  const api = await loadPrivy()
  if (!(await api.ready())) return
  for (let i = 0; i < 80 && !api.authenticated(); i++) await new Promise((r) => setTimeout(r, 250))
  if (api.authenticated()) await finishPrivy()
}
/** Privy's own wallet list. The wallet picked there is the site's wallet from then on. */
async function privyConnectWallet() {
  flash('[data-sheetmsg]', '<span class="busy">Opening your wallets…</span>')
  try {
    const api = await loadPrivy()
    privyBusy = true
    const a = await api.connect()
    privyBusy = false
    flash('[data-sheetmsg]', '')
    if (!a) return
    privySeen = api.chosen()?.n ?? privySeen
    W.connectPrivy(a, api.wallets().find((x) => x.address === a) ?? {})
    await afterWallet({ link: true })
  } catch (e) {
    privyBusy = false
    flash('[data-sheetmsg]', `<span class="warnm">${/reject|denied|cancel|exited|closed/i.test(String(e?.code ?? e?.message)) ? 'Nothing was connected.' : 'The wallet did not connect. Try again.'}</span>`)
  }
}
/** "Create a wallet for me": the only way a Privy wallet is ever made. */
async function privyCreateWallet() {
  flash('[data-sheetmsg]', '<span class="busy">Making your wallet…</span>')
  try {
    const api = await loadPrivy()
    privyBusy = true
    const a = await api.create()
    privyBusy = false
    privySeen = api.chosen()?.n ?? privySeen
    W.connectPrivy(a, { name: 'Privy wallet', embedded: true })
    flash('[data-sheetmsg]', '')
    await afterWallet({ link: true })
  } catch (e) { privyBusy = false; flash('[data-sheetmsg]', '<span class="warnm">The wallet was not made. Try again.</span>'); console.error(e) }
}
/** A wallet Privy verified for this person: linked with Privy's signed identity, no message to sign. */
async function linkPrivyWallet(w) {
  flash('[data-sheetmsg]', '<span class="busy">Linking…</span>')
  try {
    const s = await privyApi.session()
    if (!s) throw new Error('expired')
    let r = await post('/api/wallet/link-privy', { identityToken: s.identityToken, wallet: w })
    // A wallet made or linked a moment ago may not be in the identity token yet: one more read, then a message instead
    if (!r.ok && r.body?.why === 'not_your_privy_wallet') { await new Promise((ok) => setTimeout(ok, 1500)); const s2 = await privyApi.session(); r = s2 ? await post('/api/wallet/link-privy', { identityToken: s2.identityToken, wallet: w }) : r }
    if (!r.ok && r.body?.why === 'not_your_privy_wallet') return linkWallet({ byMessage: true })
    if (!r.ok) throw new Error(r.body?.why ?? 'link')
    await loadMe(); flash('[data-sheetmsg]', '')
    if (r.body.waiting) toast('<b>Change started.</b> This wallet takes over in 48 hours.')
    redrawSheet(); resume()
    if (!S.then && tradeReady() && S.sheet?.kind === 'connect') { closeSheet(); toast('<b>Ready.</b> Signed in and wallet linked.', 'ok'); rerender() }
    return true
  } catch (e) {
    const why = { wallet_taken: 'This wallet is linked to another account.', change_already_waiting: 'A wallet change is already waiting.', expired: 'Your sign in ran out. Sign in again.' }[e.message]
    flash('[data-sheetmsg]', `<span class="warnm">${why ?? 'The wallet was not linked. Try again.'}</span>`)
    return false
  }
}
async function linkWallet({ byMessage = false } = {}) {
  const w = meW()
  if (!w || !D.me.signedIn) return false
  if (!byMessage && privyVerified(w)) return linkPrivyWallet(w)
  flash('[data-sheetmsg]', '<span class="busy">Sign the link message in your wallet. It moves nothing.</span>')
  try {
    const c = await post('/api/wallet/challenge', { wallet: w })
    if (!c.ok) throw new Error(c.body?.why ?? 'challenge')
    // Only a link message for this wallet and this X account is ever signed, whatever the server sends
    const msg = String(c.body.message ?? '')
    const head = D.me.hasX === false ? `Link this wallet to ${B.name} account ` : `Link this wallet to X account @${D.me.handle} `
    if (!msg.startsWith(head) || !msg.includes(`\nWallet: ${w}\n`) || !/This does not approve any transaction or move any funds\.$/.test(msg)) throw new Error('bad_message')
    const sig = await W.signMessage(new TextEncoder().encode(msg))
    const r = await post('/api/wallet/link', { wallet: w, nonce: c.body.nonce, signature: btoa(String.fromCharCode(...sig)) })
    if (!r.ok) throw new Error(r.body?.why ?? 'link')
    await loadMe()
    flash('[data-sheetmsg]', '')
    if (r.body.waiting) toast(`<b>Change started.</b> This wallet takes over in 48 hours.`)
    redrawSheet(); resume()
    if (!S.then && tradeReady() && S.sheet?.kind === 'connect') { closeSheet(); toast('<b>Ready.</b> Signed in and wallet linked.', 'ok'); rerender() }
    return true
  } catch (e) {
    const why = { wallet_taken: 'This wallet is linked to another X account.', change_already_waiting: 'A wallet change is already waiting.', bad_signature: 'The signature did not check out.', bad_message: 'The link message was not the expected one, so nothing was signed.', expired: 'That took too long. Try again.' }[e.message]
    flash('[data-sheetmsg]', `<span class="warnm">${why ?? (/reject|denied|cancel/i.test(String(e?.message)) ? 'You cancelled in your wallet. Nothing was linked.' : 'The wallet was not linked. Try again.')}</span>`)
    return false
  }
}

// ---------- toasts
function toast(html, kind = '') {
  const box = $('#toasts'); if (!box) return
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.innerHTML = html; box.prepend(t)
  while (box.children.length > 3) box.lastChild.remove()
  setTimeout(() => t.classList.add('out'), 5400); setTimeout(() => t.remove(), 5900)
}

// ---------- router and rendering
let route = { v: 'home' }
function parseRoute() { return routeOf(location.pathname) }
const TITLES = { live: 'Live auctions', fixed: 'Fixed price', sell: 'Sell your tokens', rewards: 'Seller rewards', docs: 'Docs', tx: 'Every transaction', log: 'Change log', notfound: 'Page not found' }
function pageTitle() {
  const r = route
  if (r.v === 'lot') { const l = lotById(r.a); return l ? `$${l.t}, ${big(l.amt)} tokens, ${l.mode === 'fixed' ? 'fixed price' : 'live auction'} | ${B.name}` : `Listing ${short(r.a)} | ${B.name}` }
  if (r.v === 'coin') { const c = coin(r.a); return `${c?.symbol ? '$' + ticker(r.a) : short(r.a)}${c?.name ? ' ' + clean(c.name).trim() : ''} | ${B.name}` }
  return TITLES[r.v] ? `${TITLES[r.v]} | ${B.name}` : `${B.name}, live auctions for Solana tokens`
}
/** In app navigation: a new history entry and the view drawn, no reload. */
function nav(href, replace = false) {
  const u = new URL(href, location.href)
  if (u.origin !== location.origin) { location.href = href; return }
  const same = u.pathname === location.pathname
  history[replace ? 'replaceState' : 'pushState'](null, '', u.pathname + u.search + u.hash)
  if (same && u.hash) { document.getElementById(u.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
  go()
}
/** Links the router takes: same site, plain left click, a page path (not the API, a share card or a file). */
const routable = (a, e) => a && !a.target && !a.hasAttribute('download') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0 && a.origin === location.origin && !/^\/(api|og|c|s|brand)\//.test(a.pathname) && !/\.[a-z0-9]{2,5}$/i.test(a.pathname)
function draw() {
  const root = $('#view'), r = route
  document.body.dataset.view = r.v; document.body.classList.remove('menu-open')
  if (r.v === 'lot') {
    const l = lotById(r.a)
    root.innerHTML = l ? UI.lot(l) : D.loadingLot === r.a ? `<section class="lot"><div class="wrap"><div class="empty tall"><b>Reading the listing from chain…</b></div></div></section>` : UI.notfound('No listing at this address.', 'The listing may have closed long ago, or the address has a typo.')
  } else if (r.v === 'notfound') root.innerHTML = UI.notfound()
  else {
    if (r.v === 'fixed') S.filter = 'Fixed price'; else if (r.v === 'live' && S.filter === 'Fixed price' && !draw.keep) S.filter = 'All'
    root.innerHTML = r.v === 'fixed' && !S.q && !liveLots().some((l) => l.mode === 'fixed') ? UI.fixedEmpty() : UI[r.v === 'fixed' ? 'live' : r.v](r)
  }
  $$('[data-nav]').forEach((a) => { const on = a.dataset.nav === r.v; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current') })
  if (r.v === 'docs') railWatch()
  document.title = pageTitle()
  after()
  S.key = viewKey()
}
/** Redraws the view in place: keeps scroll, the focused input and what was typed, and skips entrance animations. */
function rerender() {
  const y = scrollY, a = document.activeElement, id = a?.id, val = a?.value, sel = [a?.selectionStart, a?.selectionEnd]
  S.seen = true; draw.keep = true; draw(); draw.keep = false; scrollTo(0, y)
  if (id) { const n = document.getElementById(id); if (n) { n.value = val; n.focus(); try { n.setSelectionRange(sel[0], sel[1]) } catch {} } }
  redrawSheet()
}
function go() {
  route = parseRoute(); S.seen = false
  if (route.v === 'lot' && route.a) { if (!D.lots.has(route.a)) D.loadingLot = route.a; loadOne(route.a).finally(() => { if (D.loadingLot === route.a) { D.loadingLot = null; rerender() } }) }
  if (route.v === 'coin') loadCoin(route.a).then(() => { if (route.v === 'coin') rerender() })
  if (route.v === 'sell' || route.v === 'fixed') loadSellCoins()
  draw()
  if (route.v === 'log') loadLog().then(() => rerender())
  if (route.v === 'tx' || route.v === 'home') { loadFeed(route.v === 'tx' ? 100 : 40); loadLaunchTest() }
  if (route.v === 'rewards' || route.v === 'home' || route.v === 'live' || route.v === 'fixed') loadRewards().catch(() => {})
  const sub = route.v === 'docs' ? route.a : location.hash.slice(1), t = sub && document.getElementById(sub)
  if (t) { t.scrollIntoView(); if (route.v === 'docs') setRail(sub) } else scrollTo(0, 0)
}
function setRail(id) { $$('[data-rail]').forEach((b) => b.classList.toggle('on', b.dataset.v === id)) }
let railObs
function railWatch() {
  railObs?.disconnect()
  railObs = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setRail(v.target.id) }, { rootMargin: '-100px 0px -70% 0px' })
  setRail(route.a || 'what')
  $$('.doc-sec').forEach((s) => railObs.observe(s))
}
function after() {
  if (S.seen) { $$('.mod,.pf,.card,.pod').forEach((e) => e.classList.add('in', 'still')); return }
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return
    e.target.classList.add('in'); io.unobserve(e.target)
    const n = e.target.querySelector('[data-count-to]')
    if (n) { const to = +n.dataset.countTo, t0 = performance.now(); const st = (t) => { const k = Math.min(1, (t - t0) / 1200); n.textContent = Math.max(1, Math.round(to * (0.5 + 0.5 * (1 - Math.pow(1 - k, 3))))); if (k < 1) requestAnimationFrame(st); else n.textContent = to }; requestAnimationFrame(st) }
  }), { threshold: 0.2 })
  $$('.mod,.pf,.card,.pod').forEach((e) => io.observe(e))
  if (route.v === 'lot') loadChart(route.a)
}
/** What the current view shows, so a poll only redraws when something on screen changed. */
function viewKey() {
  const r = route, k = (v) => v ? `${v.pubkey}:${v.phase}:${v.topBid}:${v.fillable}:${v.sellerMustCancel}:${v.closed}:${D.coins.has(v.mint)}:${D.lotMeta.get(v.pubkey)?.bids ?? ''}:${v.drop ? `${v.drop.n}:${v.drop.post?.at ?? ''}` : ''}` : ''
  const parts = [r.v, r.a, D.coins.size, meW(), D.me.signedIn, D.me.wallet, D.credits.length, D.mine.map((v) => v.pubkey + v.phase).join()]
  if (r.v === 'lot') { parts.push(k(D.lots.get(r.a)), (D.events.get(r.a) ?? []).length, D.sellers.has(D.lots.get(r.a)?.seller.wallet) && !!D.sellers.get(D.lots.get(r.a)?.seller.wallet), !!D.holders.get(D.lots.get(r.a)?.mint)) }
  else if (r.v === 'home' || r.v === 'live' || r.v === 'fixed') parts.push(D.board.map((p) => k(D.lots.get(p))).join('|'), D.sales.length, D.activity[0]?.sig, featured() && (D.events.get(featured().id) ?? []).length)
  if (r.v === 'home' || r.v === 'rewards') parts.push(JSON.stringify(rewardsModel()))
  if (r.v === 'home' || r.v === 'tx' || r.v === 'docs') parts.push(D.feed[0]?.sig, D.feed.length, D.feedOlder.length, D.feedEnd, D.deployAt?.t, JSON.stringify(D.trust?.upgrade ?? null), D.trust?.verified?.state, JSON.stringify(D.stats))
  if (r.v === 'home' || r.v === 'tx') parts.push(JSON.stringify(D.launchTest))
  if (r.v === 'home') parts.push((D.dropPlan?.drops ?? []).map((d) => d.state + (d.post ? 'p' : '')).join())
  if (r.v === 'log') parts.push(JSON.stringify(D.log))
  if (r.v === 'sell' || r.v === 'fixed') parts.push(S.sell.coins?.length, [...D.coins.keys()].length)
  if (r.v === 'coin') parts.push((D.coinLots.get(r.a) ?? []).map((x) => k(D.lots.get(x))).join('|'), (D.coinSales.get(r.a) ?? []).length)
  if (['home', 'live', 'fixed', 'rewards', 'notfound'].includes(r.v)) parts.push(JSON.stringify(liveFacts().map((f) => [f.id, f.v.replace(/data-at="\d+"|>[^<]*</g, '')])), D.rewards?.hour?.feesLamports)
  return parts.join('~')
}
const maybeRedraw = () => { if (S.busy) return; if (viewKey() !== S.key) rerender() }

// ---------- holders, coin checks, chart
D.holders = new Map()
function holdersBox(l) {
  const h = D.holders.get(l.mint)
  if (h === undefined) { D.holders.set(l.mint, null); CH.holders(l.mint).then((rows) => { D.holders.set(l.mint, rows); maybeRedraw() }).catch(() => D.holders.set(l.mint, [])) }
  const c = l.coin, supply = c ? Number(BigInt(c.supply)) : 0
  if (!h || !h.length || !supply) return `<section class="box"><div class="box-h"><h3 class="box-t">Holders</h3><span class="k">share of supply</span></div><div class="nobid"><b>${h === null || !c ? 'Reading holders…' : 'Holders unavailable'}</b><p>Largest token accounts, read from chain.</p></div></section>`
  const rows = h.map((x) => ({ n: x.owner === l.seller.wallet ? (l.seller.handle ? xLink(l.seller) : 'Seller') : esc(short(x.owner ?? x.account)), p: (Number(BigInt(x.amount)) / supply) * 100, me: x.owner === l.seller.wallet }))
  const mx = Math.max(...rows.map((r) => r.p))
  return `<section class="box"><div class="box-h"><h3 class="box-t">Holders</h3><span class="k">share of supply</span></div><div class="holders">${rows.map((r) => `<div class="hold ${r.me ? 'me' : ''}"><span class="num">${r.n}</span><span class="hold-b"><i style="width:${(r.p / mx) * 100}%"></i></span><b class="num">${pctS(r.p)}</b></div>`).join('')}</div></section>`
}
const CHARTS = new Map()
function loadChart(pk) {
  const l = lotById(pk)
  if (!l?.pair || CHARTS.has(l.pair)) return
  CHARTS.set(l.pair, null)
  lastHour(l.pair, C.priceFeed).then((pts) => { CHARTS.set(l.pair, pts); if (pts) rerender() })
}
function chartOrChecks(l) {
  const pts = l.pair ? CHARTS.get(l.pair) : null
  if (pts && pts.length > 4) {
    const lo = Math.min(...pts), hi = Math.max(...pts), W2 = 640, H2 = 160
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * W2).toFixed(1)} ${(H2 - 12 - ((p - lo) / (hi - lo || 1)) * (H2 - 24)).toFixed(1)}`).join('')
    return `<section class="box"><div class="box-h"><h3 class="box-t">Chart, 1h</h3><span class="k">untouched by this sale</span></div><svg class="chart" viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true"><path class="ch-fill" d="${d}L640 160L0 160Z"/><path class="ch-line" d="${d}" vector-effect="non-scaling-stroke"/></svg></section>`
  }
  const c = l.coin
  const row = (k, on, offTxt, onTxt) => `<div><span>${k}</span><b class="${on ? 'warn-t' : 'good'}">${on ? onTxt : offTxt}</b></div>`
  return `<section class="box checks"><div class="box-h"><h3 class="box-t">Coin checks</h3><span class="k">read from chain</span></div>${c ? `<div class="rows">
    ${row('Mint authority', !!c.mintAuthority, 'Revoked', 'Still on: more can be minted')}${row('Freeze authority', !!c.freezeAuthority, 'Revoked', 'Still on: holders can be frozen')}
    <div><span>Token program</span><b>${c.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'Token 2022' : 'SPL Token'}</b></div><div><span>Supply</span><b class="num">${big(units(c.supply, c.decimals))}</b></div></div>` : '<div class="nobid"><b>Reading the coin…</b></div>'}
    <p class="fine">A listing proves the seller holds the tokens. It says nothing about whether the coin is any good.</p></section>`
}

// ---------- clock
function tick() {
  const t = now()
  $$('[data-cd]').forEach((e) => { const s = (+e.dataset.end - t) / 1000; e.textContent = clock(s); e.classList.toggle('low', s < 60) })
  $$('[data-bar]').forEach((e) => { const s = (+e.dataset.end - t) / 1000; e.style.transform = `scaleX(${Math.max(0.02, Math.min(1, s / +e.dataset.len))})`; e.classList.toggle('low', s < 60) })
  $$('[data-status]').forEach((e) => { const l = lotById(e.dataset.status); if (!l) return; const end = leftS(l) < 60; e.lastChild.textContent = end ? 'Ending' : 'Live'; e.classList.toggle('s-ending', end) })
  $$('[data-at]').forEach((e) => { const d = (+e.dataset.at - t) / 1000; e.textContent = d > 0 ? clock(d) : 'now' })
  $$('[data-ago]').forEach((e) => { e.textContent = agoS((t - +e.dataset.ago) / 1000) })
  $$('[data-holds]').forEach((e) => { const v = D.lots.get(e.dataset.holds); if (!v) return; e.textContent = holdsText(v, t); e.classList.toggle('good', holdsGood(v, t)); e.classList.toggle('warn-t', !!v.stale) })
  // A countdown that just ended changes what the card can do, so read it again
  if (route.v === 'lot') { const l = lotById(route.a); if (l && l.v.phase === 'live' && l.mode === 'bid' && l.end <= t && !S.endRead) { S.endRead = true; setTimeout(() => { loadOne(l.id).finally(() => { S.endRead = false }) }, 1200) } }
}

// ---------- polls
function onChange(what) {
  if (what?.kind === 'board' || what?.kind === 'one') {
    const before = what.before, items = what.kind === 'one' ? [D.lots.get(what.pk)].filter(Boolean) : D.board.map((p) => D.lots.get(p))
    for (const v of items) {
      const was = before instanceof Map ? before.get(v.pubkey) : before
      if (!was || was.topBid === v.topBid) continue
      const l = lot(v), mine = S.mine[v.pubkey]
      if (mine && v.topBidder !== meW()) { delete S.mine[v.pubkey]; S.msg[v.pubkey] = `You were outbid. ${solX(mine)} SOL came back in the same transaction.`; toast(`<b>Outbid on $${esc(l.t)}.</b> ${solX(mine)} SOL refunded in the same transaction.`) }
      else if (v.topBidder !== meW() && !(route.v === 'lot' && route.a === v.pubkey)) toast(`${art(l, 'tiny')}<span><b>${xLink(person(v.topBidder))}</b> bid <b class="num">${sol(l.top)} SOL</b> on $${esc(l.t)}</span>`)
      $$(`[data-top="${v.pubkey}"]`).forEach((e) => { e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash') })
    }
  }
  // The coin info arriving (or failing) changes what Sign can do, so the sell summary is drawn again
  if (what === 'coin' && sellOnPage()) refreshSellSum()
  if (what === 'me' || what === 'mine') { updateConn(); const h = $('[data-heroauth]'); if (h) h.innerHTML = heroAuth() }
  if (what === 'trust') { const b = $('[data-banner]'); if (b) b.innerHTML = upgradeBanner(); $$('[data-upline]').forEach((e) => { e.innerHTML = footUp() }) }
  maybeRedraw()
}
async function poll() {
  const t = Date.now()
  try {
    const jobs = [loadBoard()]
    if (!poll.a || t - poll.a > 5000) { poll.a = t; jobs.push(loadActivity()) }
    if ((route.v === 'home' || route.v === 'rewards') && (!poll.r || t - poll.r > 15000)) { poll.r = t; jobs.push(loadRewards()) }
    if (meW() && (!poll.m || t - poll.m > 10000)) { poll.m = t; jobs.push(loadMine(meW())) }
    if (!poll.t || t - poll.t > 30000) { poll.t = t; jobs.push(loadTrust(), loadStats()) }
    if ((route.v === 'home' || route.v === 'tx') && (!poll.fd || t - poll.fd > 8000)) { poll.fd = t; jobs.push(loadFeed(route.v === 'tx' ? 100 : 40)) }
    if (route.v === 'log' && (!poll.lg || t - poll.lg > 60000)) { poll.lg = t; jobs.push(loadLog()) }
    if ((route.v === 'home' || route.v === 'tx') && (!poll.lt || t - poll.lt > 30000)) { poll.lt = t; jobs.push(loadLaunchTest()) }
    if (!poll.dr || t - poll.dr > 6000) { poll.dr = t; jobs.push(loadDrops()) }
    const f = featured(); if (route.v === 'home' && f && (!poll.f || t - poll.f > 4000)) { poll.f = t; jobs.push(loadOne(f.id)) }
    await Promise.all(jobs)
  } catch {}
}
async function pollLot() { if (route.v === 'lot' && route.a && !S.busy) await loadOne(route.a).catch(() => {}) }

// ---------- boot
async function boot() {
  // The font sheet loads without blocking the page; a slow font host never holds the site back
  const fonts = document.querySelector('link[data-fonts]'); if (fonts) fonts.media = 'all'
  // Settings first. A busy moment (429) or a restart (5xx) is waited out a few times before the page gives up
  let r = await api('/api/config').catch(() => ({ ok: false, status: 0 }))
  for (let i = 0; !r.ok && (r.status === 429 || r.status >= 500 || r.status === 0) && i < 4; i++) { await new Promise((ok) => setTimeout(ok, 1500 * 2 ** i)); r = await api('/api/config').catch(() => ({ ok: false, status: 0 })) }
  if (!r.ok) { document.getElementById('app').innerHTML = '<p style="padding:40px">The site could not load its settings. Refresh in a moment.</p>'; return }
  C = D.cfg = r.body; B = C.brand
  D.skew = (C.now * 1000) - Date.now()
  P = program(C.chain.programId)
  CH.useChain(C)
  document.title = `${B.name}, live auctions for Solana tokens`
  // Back from sign in: the page it started on. An old #view link becomes its real address. A share link (/c/, /s/) shows the
  // listing at its own address.
  try { const back = sessionStorage.getItem('ws.back'); if (back && back.startsWith('/')) { sessionStorage.removeItem('ws.back'); if (location.pathname === '/' && !location.hash) history.replaceState(null, '', back + location.search) } } catch {}
  const old = fromHash(location.hash); if (old) history.replaceState(null, '', old + location.search)
  const start = document.body.dataset.route; if (start?.startsWith('lot/') && /^\/[cs]\//.test(location.pathname)) history.replaceState(null, '', '/' + start + location.search)
  const q = new URLSearchParams(location.search)
  W.startWallets(); W.onWallets(() => { redrawSheet(); updateConn() })
  // Up to four seconds for the first data, so the page opens on real numbers; a slow read fills in when it lands
  await Promise.race([Promise.all([loadMe(), loadBoard().catch(() => {}), loadActivity().catch(() => {}), loadRewards().catch(() => {}), loadTrust(), loadStats(), loadFeed(), loadDrops()]), new Promise((r) => setTimeout(r, 4000))])
  watchSol(document.body); watchX(document.body)
  document.getElementById('app').innerHTML = UI.shell() + '<div id="toasts" aria-live="polite"></div>'
  addEventListener('popstate', go)
  // An old style #view link typed or pasted into the address bar while the page is open
  addEventListener('hashchange', () => { const to = fromHash(location.hash); if (to) nav(to, true) })
  // An @handle opens the X profile and never also opens the card or row around it
  const openX = (e) => {
    const el = e.target.closest?.('[data-xh],[data-xurl]'); if (!el) return false
    const url = el.dataset.xurl && /^https:\/\/x\.com\//.test(el.dataset.xurl) ? el.dataset.xurl : el.dataset.xh ? 'https://x.com/' + el.dataset.xh : null
    if (!url) return false
    e.preventDefault(); e.stopPropagation(); window.open(url, '_blank', 'noopener'); return true
  }
  document.addEventListener('click', (e) => { if (openX(e)) return; if (e.target.closest?.('a.xh')) e.stopPropagation() }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') openX(e) }, true)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')
    // An action inside a link (copy the CA on a card) does its job and never follows the link
    if (a && ACT[a.dataset.act]) { e.preventDefault(); e.stopPropagation(); ACT[a.dataset.act](a); return }
    if (e.target.classList?.contains('sheetwrap')) { closeSheet(); return }
    const l = e.target.closest('a[href]')
    if (routable(l, e)) { e.preventDefault(); closeSheet(); nav(l.getAttribute('href')) }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sellCa') { e.preventDefault(); sellPaste() } })
  // A picture that fails is dropped for good and the drawn fallback under it shows; it is not asked for again on redraw
  document.addEventListener('error', (e) => { const t = e.target; if (t?.tagName === 'IMG' && t.closest('.art,.av')) { badImg.add(t.getAttribute('src')); t.closest('.art')?.classList.remove('has-img'); t.remove() } }, true)
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-search]')) {
      S.q = e.target.value; $$('[data-search]').forEach((i) => { if (i !== e.target) i.value = S.q })
      if (!['live', 'fixed'].includes(route.v)) { nav('/live'); setTimeout(() => { const i = $('#view [data-search]') || $('[data-search]'); i?.focus() }, 0) }
      else { const g = $('[data-grid]'); if (g) g.innerHTML = UI.grid() }
    }
    if (e.target.id === 'bidIn') S.bidDraft[e.target.dataset.bid] = e.target.value
    if (e.target.id === 'sellExact') {
      S.sell.exact = e.target.value
      $$('[data-act=sellPct]').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false') })
      refreshSellSum()
    }
    if (e.target.id === 'sellCa') S.sell.ca = e.target.value
    if (e.target.id === 'sellCustom') { S.sell.custom = e.target.value; const s = $('#sellSum'); if (s) s.innerHTML = UI.sellSummary() }
  })
  onData(onChange)
  go()
  if (q.get('signin')) { toast(q.get('signin') === 'paused' ? '<b>Sign in is paused.</b> Try again later.' : '<b>Sign in did not finish.</b> Try again.'); history.replaceState(null, '', location.pathname + location.hash) }
  setInterval(tick, 250); setInterval(poll, 5000); setInterval(pollLot, 3000)
  if (privyOn()) resumePrivyLogin().catch(privyFailed)
  await W.reconnect(privyOn() ? loadPrivy : null, { privyOnly: privyOn() }).catch(() => null)
  if (meW()) await afterWallet()
  let resumeConnect = false
  try { resumeConnect = sessionStorage.getItem('ws.resume') === '1'; sessionStorage.removeItem('ws.resume') } catch {}
  if (resumeConnect && D.me.signedIn && !tradeReady()) openSheet('connect', 'trade')
  else if (resumeConnect && D.me.signedIn) toast(`<b>Signed in.</b> ${meName()}`, 'ok')
}
boot()
