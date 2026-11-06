// The plain pages around the app: /terms, /privacy, /.well-known/security.txt, /robots.txt and /sitemap.xml.
// The two legal pages are rendered here in full, inside the built site's head (fonts, stylesheet, icons) with their own
// title and share tags, and without the app script: they read the same with scripts off, and the app never redraws them.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const CONTACT = 'sidebid@outlook.com'
export const SOURCE = 'https://github.com/sidebid/sidebid'
// RFC 9116 wants a real date under a year out. Move it forward each year; tools/check.mjs warns 30 days before.
export const SECURITY_EXPIRES = '2027-11-06T00:00:00.000Z'
// Every address a visitor can open, for the sitemap. Listings and coins come and go, so they are not listed.
export const SITE_ROUTES = ['/', '/live', '/fixed', '/sell', '/rewards', '/docs', '/tx', '/log', '/terms', '/privacy']

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const NAV = [['/live', 'Live'], ['/fixed', 'Fixed price'], ['/rewards', 'Rewards'], ['/docs', 'Docs']]
const CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

const sec = (id, h, ...ps) => `<section class="doc-sec" id="${id}"><h2>${esc(h)}</h2>${ps.map((p) => `<p>${p}</p>`).join('')}</section>`
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`

/** Page copy. Short and plain on purpose: these are what the X app and Privy link to. */
export const LEGAL = {
  terms: {
    title: 'Terms of use',
    h: 'Terms of use.',
    d: (n) => `The terms for using ${n}: an interface to a Solana program where you sign every transaction yourself.`,
    updated: '6 November 2026',
    body: (n, t) => [
      sec('what', `What ${n} is`,
        `${esc(n)} is a website that helps you build and send transactions to a program on Solana. The program holds the rules for listings, bids, sales and refunds. ${esc(n)} is not custodial: it never holds your tokens, your SOL or your keys.`,
        'You sign every transaction yourself, in your own wallet. Read what your wallet shows before you approve it. A signed transaction on Solana is final, and nobody can reverse it for you.'),
      sec('risk', 'The risks',
        'Memecoins are very risky. Their price can drop to zero in minutes, and the market for them can disappear. Only use money you can afford to lose.',
        'Smart contracts and websites can have bugs. The network, your wallet, the RPC provider or this site can be slow or down at the moment you need them. A bid or a sale can fail or land later than you expect. You take these risks when you use the site.'),
      sec('advice', 'No advice',
        `Nothing on ${esc(n)}, on our X account or in our posts is investment, financial, legal or tax advice. Prices, rankings and rewards shown on the site are facts read from the chain, not a recommendation to buy or sell anything.`),
      sec('fees', 'Fees',
        `${esc(n)} takes no fee on sales. The seller receives the full winning bid or the full fixed price.`,
        'You pay normal Solana network fees. Each listing locks 0.0031 SOL of rent, which comes back when the listing closes. A one per X account claim costs the buyer about 0.00095 SOL of rent, which is kept.',
        `Seller rewards are paid from the creator fees of the $${esc(t)} coin, as the <a href="/docs/rewards">docs</a> explain. They are not a fee on your sale.`),
      sec('you', 'Your part',
        'You are responsible for your wallet, your keys and the transactions you sign. You must follow the laws where you live, and you must not use the site to break them.',
        'Do not try to attack, overload or trick the site, the program or other users. We may block access to the site for anyone who does. Blocking the site does not touch anything on chain: the program still works without it.'),
      sec('limits', 'No guarantee',
        `The site is provided as it is, with no promise that it will be available, correct or free of errors. To the extent the law allows, ${esc(n)} and the people behind it are not liable for any loss from using the site, the program or any coin listed on it.`),
      sec('changes', 'Changes',
        'We may update these terms. The date at the top shows the latest version. Using the site after an update means you accept it.'),
      sec('contact', 'Contact', `Questions about these terms: ${mail}.`),
    ].join(''),
  },
  privacy: {
    title: 'Privacy',
    h: 'Privacy.',
    d: (n) => `What ${n} stores about you, why, and who else sees it. Short and plain.`,
    updated: '6 November 2026',
    body: (n) => [
      sec('store', 'What we store',
        'When you sign in we keep your X handle, your X account id, the address of your X profile picture, your X account age and follower count, and the Privy id of your sign in. When you link a wallet we keep its address.',
        'We keep a session so you stay signed in. Your browser holds a random session cookie; we store only a hash of it, and it ends after 30 days or when you sign out.',
        `If you tag our X account to list tokens, we keep that post's id and text so we can open the listing and reply to it.`),
      sec('why', 'Why',
        'To show who is selling and bidding, to connect a listing made from X to your wallet, to keep one claim per X account where a drop asks for it, and to pay seller rewards to the right wallet. Nothing else.'),
      sec('login', 'Sign in through Privy',
        `Sign in is handled by Privy. Privy runs the X, wallet and email sign in and tells us who you are with a signed token. If you sign in with email, Privy keeps the email; ${esc(n)} does not store it. Privy's own privacy policy covers what it keeps.`),
      sec('public', 'Public by design',
        'Wallet addresses and every listing, bid, sale and payout are public on Solana for anyone to read. When your wallet is linked, the site shows your X handle and picture next to your wallet on listings, bids and sales.'),
      sec('others', 'Who else sees requests',
        'Your browser talks to a Solana RPC provider to read the chain and send your transactions. Fonts load from Google Fonts, and coin prices may load from DexScreener or GeckoTerminal. Our host keeps standard request logs. Your IP address is used in memory for rate limits and is not stored by us.'),
      sec('sell', 'No selling, no tracking',
        'We do not sell or rent your data. There are no ads and no tracking or analytics scripts on the site.'),
      sec('delete', 'Removing your data',
        `Sign out to end your session. To have your sign in and wallet link removed, email ${mail} from a way we can match to the account. What is on chain stays on chain; nobody can remove it.`),
      sec('contact', 'Contact', `Privacy questions: ${mail}.`),
    ].join(''),
  },
}

export function securityTxt(publicUrl) {
  return [
    `Contact: mailto:${CONTACT}`,
    `Expires: ${SECURITY_EXPIRES}`,
    `Policy: ${publicUrl}/docs`,
    `Preferred-Languages: en`,
    `Canonical: ${publicUrl}/.well-known/security.txt`,
    `# Source code: ${SOURCE}`,
    '',
  ].join('\n')
}
export const robotsTxt = (publicUrl) => `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${publicUrl}/sitemap.xml\n`
export const sitemapXml = (publicUrl) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${SITE_ROUTES.map((r) => `  <url><loc>${esc(publicUrl + r)}</loc></url>`).join('\n')}\n</urlset>\n`

const BARE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title><meta name="description" content="">
</head><body><div id="app"></div></body></html>`

/** The built site's head around a legal page: same fonts, stylesheet and icons, no app script. */
export function legalPages({ config, dist, brand = () => ({ name: 'Sidebid', ticker: 'SIDEBID' }) }) {
  let shell = null, shellAt = -2
  const base = () => {
    const f = join(dist, 'index.html')
    let m = -1; try { m = statSync(f).mtimeMs } catch {}
    if (m !== shellAt) { shellAt = m; try { shell = m >= 0 ? readFileSync(f, 'utf8') : BARE } catch { shell = BARE } }
    return shell
  }
  const render = (key) => {
    const P = LEGAL[key], b = brand(), name = b.name || 'Sidebid', url = `${config.publicUrl}/${key}`
    const title = `${P.title} | ${name}`, description = P.d(name)
    const nav = NAV.map(([h, n]) => `<a href="${h}">${n}</a>`).join('')
    const wordmark = /^sidebid$/i.test(name) ? '<img class="brand-wm" src="/brand/wordmark-28.png" srcset="/brand/wordmark-28.png 1x, /brand/wordmark-56.png 2x, /brand/wordmark-84.png 3x" alt="Sidebid" width="114" height="28" decoding="async">' : `<b class="wm"><span>${esc(name)}</span></b>`
    const body = `<div class="fp legal"><header class="top"><div class="wrap top-in"><a class="brand" href="/" aria-label="${esc(name)} home"><img class="brand-logo" src="/brand/logo-48.png" srcset="/brand/logo-48.png 1x, /brand/logo-96.png 2x, /brand/logo-144.png 3x" alt="" width="61" height="48" decoding="async">${wordmark}</a><nav class="nav" aria-label="Main">${nav}</nav><div class="top-r"><a class="btn hot" href="/sell">Sell tokens</a></div></div></header>
<main><section class="phead"><div class="wrap"><h1 class="mega sm">${esc(P.h)}</h1><p class="lede">${esc(description)}</p><p class="fp-h">Updated ${esc(P.updated)}</p></div></section>
<section class="docs"><div class="wrap"><div class="prose">${P.body(esc(name), b.ticker || 'SIDEBID')}</div></div></section></main>
<footer class="foot"><div class="wrap"><div class="foot-b"><span>Settled on Solana. Prices in SOL.</span><span><a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="mailto:${CONTACT}">Contact</a></span></div></div></footer></div>`
    const tags = `<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(name)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="${esc(config.publicUrl)}/og/site.png"><meta property="og:url" content="${esc(url)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(config.publicUrl)}/og/site.png"><link rel="canonical" href="${esc(url)}">`
    return base()
      .replace(/<meta (property="og:[^"]*"|name="twitter:[^"]*") content="[^"]*">/g, '').replace(/<link rel="canonical"[^>]*>/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link rel="modulepreload"[^>]*>/g, '')
      // The app swaps the fonts in from print; with no script here they load straight away
      .replace(/ media="print" data-fonts/g, '')
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
      .replace('</head>', `${tags}</head>`)
      .replace(/<body[^>]*>/, `<body data-route="${key}">`)
      .replace(/<div id="app">(?:<div class="boot"><\/div>|<!--fp-->)?<\/div>/, `<div id="app">${body}</div>`)
  }
  const https = /^https:/.test(config.publicUrl)
  const head = (type, cache) => ({ 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...(https ? { 'strict-transport-security': 'max-age=31536000' } : {}) })
  /** Answers one of the plain pages, or returns false. */
  return (req, res, p) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const q = p.length > 1 ? p.replace(/\/$/, '') : p
    const send = (code, headers, body) => { res.writeHead(code, headers); res.end(req.method === 'HEAD' ? undefined : body); return true }
    if (q === '/terms' || q === '/privacy') return send(200, { ...head('text/html; charset=utf-8', 'no-cache'), 'content-security-policy': CSP, 'x-frame-options': 'DENY' }, render(q.slice(1)))
    if (q === '/.well-known/security.txt' || q === '/security.txt') return send(200, head('text/plain; charset=utf-8', 'public, max-age=3600'), securityTxt(config.publicUrl))
    if (q === '/robots.txt') return send(200, head('text/plain; charset=utf-8', 'public, max-age=3600'), robotsTxt(config.publicUrl))
    if (q === '/sitemap.xml') return send(200, head('application/xml; charset=utf-8', 'public, max-age=3600'), sitemapXml(config.publicUrl))
    return false
  }
}
