// Real addresses for every view, and the old #view links mapped onto them. No DOM here, so the unit test can load it.
export const VIEWS = ['home', 'live', 'fixed', 'lot', 'coin', 'sell', 'rewards', 'docs', 'tx', 'log']
const KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** Every view has a real address: /, /live, /fixed, /sell, /rewards, /docs and /docs/<section>, /tx, /log, /lot/<listing>, /coin/<mint>. */
export function routeOf(path) {
  const [v, a] = path.replace(/^\/+|\/+$/g, '').split('/')
  if (!v || v === 'index.html') return { v: 'home' }
  if (v === 'lot' || v === 'coin') return KEY_RE.test(a ?? '') ? { v, a } : { v: 'notfound' }
  if (v === 'docs') return { v, a: /^[a-z0-9-]{1,40}$/.test(a ?? '') ? a : undefined }
  if (VIEWS.includes(v) && v !== 'home' && a === undefined) return { v }
  return { v: 'notfound' }
}
/** An old #view/part link as its real address: #lot/X to /lot/X, #docs/fee to /docs/fee, #home/sold to /#sold. Null when it is a plain anchor. */
export function fromHash(hash) {
  const [v, a] = String(hash ?? '').replace(/^#/, '').split('/')
  if (!VIEWS.includes(v)) return null
  if (v === 'home') return a ? '/#' + a : '/'
  return '/' + v + (a ? '/' + a : '')
}
