// Wallets through the Wallet Standard, with no adapter library: the page announces itself, wallets register, and the
// site talks to them through their standard features. On a phone with no wallet in the page, the wallet rows open this
// same page inside the wallet's own browser instead.
const KNOWN = [
  { name: 'Phantom', browse: (u, r) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}`, get: 'https://phantom.com/download' },
  { name: 'Solflare', browse: (u, r) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}`, get: 'https://solflare.com/download' },
  { name: 'Backpack', browse: (u, r) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(r)}`, get: 'https://backpack.app/downloads' },
]
const wallets = new Set()
const listeners = new Set()
const changed = () => listeners.forEach((f) => { try { f() } catch {} })
const usable = (w) => !!w?.features?.['standard:connect'] && (w.chains ?? []).some((c) => String(c).startsWith('solana:')) && (!!w.features['solana:signTransaction'] || !!w.features['solana:signAndSendTransaction'])

export function startWallets() {
  const register = (...ws) => { for (const w of ws) if (usable(w)) wallets.add(w); changed(); return () => { ws.forEach((w) => wallets.delete(w)); changed() } }
  const api = Object.freeze({ register })
  // Wallets that loaded first answer this; wallets that load later announce themselves with the second event
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })) } catch {}
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(api) } catch {} })
}
export const onWallets = (f) => { listeners.add(f); return () => listeners.delete(f) }

export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))

/** The rows for the connect sheet: the three named wallets, installed or not, then any other standard wallet. */
export function walletChoices() {
  const found = [...wallets]
  const rows = KNOWN.map((k) => {
    const w = found.find((x) => x.name === k.name)
    if (w) return { name: k.name, wallet: w, icon: w.icon }
    if (isPhone()) return { name: k.name, deep: k.browse(location.href, location.origin) }
    return { name: k.name, get: k.get }
  })
  for (const w of found) if (!KNOWN.some((k) => w.name === k.name)) rows.push({ name: w.name, wallet: w, icon: w.icon })
  return rows
}

let current = null // { wallet, account, address }, or { privy: true, address, embedded } for a wallet connected through Privy
let privyApi = null
/** The Privy island's bridge, once loaded. Wallets connected through Privy sign through it. */
export const usePrivy = (api) => { privyApi = api }
let offChange = null
export const connectedWallet = () => current

export async function connect(wallet, { silent = false } = {}) {
  const r = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined)
  const account = (r?.accounts ?? wallet.accounts ?? []).find((a) => (a.chains ?? wallet.chains ?? []).some((c) => String(c).startsWith('solana:'))) ?? (r?.accounts ?? wallet.accounts)[0]
  if (!account) throw new Error('no_account')
  current = { wallet, account, address: account.address }
  offChange?.()
  offChange = wallet.features['standard:events']?.on('change', ({ accounts }) => {
    if (!accounts) return
    const a = accounts[0]
    current = a ? { wallet, account: a, address: a.address } : null
    changed()
  })
  try { localStorage.setItem('ws.wallet', wallet.name) } catch {}
  changed()
  return current
}
/** A wallet connected through Privy (outside or embedded), by address. Signing goes through Privy; everything else is unchanged. */
export function connectPrivy(address, { name = 'Wallet', embedded = false } = {}) {
  offChange?.(); offChange = null
  current = { privy: true, wallet: { name }, account: null, address, embedded }
  try { localStorage.setItem('ws.wallet', 'privy:' + address) } catch {}
  changed()
  return current
}
/** Drops the site's hold on the wallet without asking the wallet anything: Privy already reports it gone. */
export function forget() {
  current = null; offChange?.(); offChange = null
  try { localStorage.removeItem('ws.wallet') } catch {}
  changed()
}
export async function disconnect() {
  const c = current
  forget()
  if (c?.privy) { try { await privyApi?.disconnect(c.address) } catch {} return }
  try { await c?.wallet?.features?.['standard:disconnect']?.disconnect() } catch {}
}
/**
 * Reconnect quietly to the wallet used last time, if it is in the page and still trusts us. A wallet connected through
 * Privy needs Privy itself, so loadPrivy is only called for one, and it counts only if Privy still has it connected.
 */
export async function reconnect(loadPrivy = null, { privyOnly = false } = {}) {
  let name = null
  try { name = localStorage.getItem('ws.wallet') } catch {}
  if (!name || current) return null
  // With Privy on, every wallet comes through Privy; one remembered from before is not reconnected behind its back
  if (privyOnly && !name.startsWith('privy:')) { try { localStorage.removeItem('ws.wallet') } catch {} return null }
  if (name.startsWith('privy:')) {
    if (!loadPrivy) return null
    try {
      const api = await loadPrivy(), a = name.slice(6)
      if (!(await api.ready())) return null
      const t0 = Date.now()
      while (!api.walletsReady() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 250))
      // Privy's outside wallets come back a moment after its frame; give them that moment
      let w = null
      for (let i = 0; i < 12 && !(w = api.wallets().find((x) => x.address === a)); i++) await new Promise((r) => setTimeout(r, 250))
      if (current) return current
      return w ? connectPrivy(a, w) : (forget(), null)
    } catch { return null }
  }
  const w = [...wallets].find((x) => x.name === name)
  if (!w) return null
  try { return await connect(w, { silent: true }) } catch { return null }
}

const chainOf = (cluster) => (cluster === 'mainnet-beta' ? 'solana:mainnet' : cluster === 'devnet' ? 'solana:devnet' : cluster === 'testnet' ? 'solana:testnet' : 'solana:localnet')

export async function signMessage(bytes) {
  if (!current) throw new Error('no_wallet')
  if (current.privy) { if (!privyApi) throw new Error('no_wallet'); return privyApi.signMessage(current.address, bytes) }
  const f = current.wallet.features['solana:signMessage']
  if (!f) throw Object.assign(new Error('This wallet cannot sign messages.'), { code: 'no_sign_message' })
  const [out] = await f.signMessage({ account: current.account, message: bytes })
  return out.signature
}

/** Signs a serialized transaction. Returns the signed bytes, or { sent: signature } if the wallet can only sign and send. */
export async function signTx(bytes, cluster) {
  if (!current) throw new Error('no_wallet')
  // The same checks follow either way: chain.js compares what comes back with what was built before anything is sent
  if (current.privy) { if (!privyApi) throw new Error('no_wallet'); return { signed: await privyApi.signTransaction(current.address, bytes, cluster) } }
  const f = current.wallet.features
  if (f['solana:signTransaction']) {
    const [out] = await f['solana:signTransaction'].signTransaction({ account: current.account, transaction: bytes, chain: chainOf(cluster) })
    return { signed: out.signedTransaction }
  }
  const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: current.account, transaction: bytes, chain: chainOf(cluster) })
  return { sent: out.signature }
}
