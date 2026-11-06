// Privy, loaded only when someone presses Sign in or Connect, comes back from X's sign in page, or comes back with a wallet
// Privy connected. A small React island: the rest of the site stays plain JS and talks to it through the bridge returned
// by start(). Privy proves who someone is (X, email or a wallet) and connects their wallet. No wallet is made for anyone
// unless they ask for one. Transactions are still built, checked and sent by the site.
import { createElement as h, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider, usePrivy, useLogin, useLogout, useConnectWallet, useModalStatus, useIdentityToken, getAccessToken, getIdentityToken } from '@privy-io/react-auth'
import { toSolanaWalletConnectors, useWallets, useSignTransaction, useSignMessage, useCreateWallet } from '@privy-io/react-auth/solana'
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'

const S = { ready: false, wReady: false, authenticated: false, wallets: [], identityToken: null, user: null, modalOpen: false, fns: {}, chosen: null, n: 0 }
const listeners = new Set(), loginListeners = new Set()
const changed = () => listeners.forEach((f) => { try { f() } catch {} })
/** Resolves when test() turns true, or with null after ms. */
const until = (test, ms) => new Promise((ok) => {
  const t0 = Date.now()
  const check = () => { const v = test(); if (v || Date.now() - t0 > ms) { listeners.delete(check); clearInterval(iv); ok(v || null) } }
  const iv = setInterval(check, 250)
  listeners.add(check); check()
})
/** The wallet the person just picked in Privy: a wallet sign in, a wallet connected, or the wallet they asked Privy to make. */
const choose = (address) => { if (typeof address === 'string' && address) { S.chosen = address; S.n++; changed() } }
// The open modal, one at a time: { ok, no, opened }. A modal closed with nothing done settles as null, never hangs.
let pending = null
const settle = (how, v) => { const p = pending; pending = null; if (p) p[how](v) }

function Bridge() {
  const { ready, authenticated, user } = usePrivy()
  const { wallets, ready: wReady } = useWallets()
  const { identityToken } = useIdentityToken()
  const { isOpen } = useModalStatus()
  const { signTransaction } = useSignTransaction()
  const { signMessage } = useSignMessage()
  const { createWallet } = useCreateWallet()
  const { logout } = useLogout()
  const { login } = useLogin({
    onComplete: ({ loginAccount, wasAlreadyAuthenticated }) => {
      if (loginAccount?.type === 'wallet' && (loginAccount.chainType ?? 'solana') === 'solana') choose(loginAccount.address)
      if (pending) return settle('ok', true)
      // Back from X's own page (Privy's redirect sign in): nobody is waiting on a modal, so the site is told instead
      if (!wasAlreadyAuthenticated) loginListeners.forEach((f) => { try { f() } catch {} })
    },
    onError: (e) => settle('no', Object.assign(new Error(String(e || 'cancelled')), { code: String(e || 'cancelled') })),
  })
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => { choose(wallet?.address); settle('ok', wallet?.address ?? null) },
    onError: (e) => settle('no', Object.assign(new Error(String(e || 'cancelled')), { code: String(e || 'cancelled') })),
  })
  Object.assign(S, { ready, wReady, authenticated, user, wallets, identityToken, modalOpen: isOpen, fns: { login, logout, connectWallet, createWallet, signTransaction, signMessage } })
  // A modal shut with nothing chosen: whoever opened it gets null
  useEffect(() => { if (isOpen && pending) pending.opened = true; else if (!isOpen && pending?.opened) { const p = pending; setTimeout(() => { if (pending === p) settle('ok', null) }, 600) } }, [isOpen])
  useEffect(changed)
  return null
}

/** Solana wallets Privy has on the person's account: the ones it verified, embedded or not. */
const linkedAccounts = () => (S.user?.linkedAccounts ?? []).filter((a) => a?.type === 'wallet' && a.chainType === 'solana' && typeof a.address === 'string')
const isEmbedded = (w) => w?.standardWallet?.name === 'Privy' || linkedAccounts().some((a) => a.address === w?.address && a.walletClientType === 'privy')
const view = (w) => ({ address: w.address, embedded: isEmbedded(w), name: isEmbedded(w) ? 'Privy wallet' : w.standardWallet?.name ?? 'Wallet', icon: w.standardWallet?.icon ?? null })
const find = (address) => S.wallets.find((w) => w.address === address)
const CHAINS = { 'mainnet-beta': 'solana:mainnet', devnet: 'solana:devnet', testnet: 'solana:testnet' }
const WALLETS = ['phantom', 'solflare', 'backpack', 'detected_solana_wallets']

export function start({ appId, clientId = null, rpc = null, ws = null, cluster = 'mainnet-beta', name = 'Sidebid', logo = null }) {
  const chain = CHAINS[cluster] ?? null
  const rpcs = chain && rpc ? { [chain]: { rpc: createSolanaRpc(rpc), rpcSubscriptions: createSolanaRpcSubscriptions(ws || rpc.replace(/^http/, 'ws')) } } : undefined
  const config = {
    loginMethods: ['twitter', 'wallet', 'email'],
    appearance: { walletChainType: 'solana-only', theme: 'dark', accentColor: '#FF5A0A', landingHeader: `Sign in to ${name}`, ...(logo ? { logo } : {}), showWalletLoginFirst: false, walletList: WALLETS },
    externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
    // Nobody gets a wallet they did not ask for: "Create a wallet for me" on the site calls createWallet() by hand
    embeddedWallets: { solana: { createOnLogin: 'off' }, ethereum: { createOnLogin: 'off' } },
    ...(rpcs ? { solana: { rpcs } } : {}),
  }
  const host = document.createElement('div')
  host.id = 'privy-island'
  document.body.append(host)
  createRoot(host).render(h(PrivyProvider, { appId, ...(clientId ? { clientId } : {}), config }, h(Bridge)))

  /** The tokens the server verifies. The identity token is read fresh, so a wallet linked a moment ago is in it. */
  const tokens = async () => {
    const accessToken = await getAccessToken()
    let identityToken = null
    try { identityToken = await getIdentityToken() } catch {}
    return { accessToken, identityToken: identityToken || S.identityToken }
  }
  const linked = () => linkedAccounts().map((a) => a.address)
  const avatar = () => S.user?.twitter?.profilePictureUrl ?? null
  const snapshot = async () => ({ ...(await tokens()), wallets: S.wallets.map(view), linked: linked(), chosen: S.chosen, avatar: avatar() })
  /** Opens one Privy modal and waits for its outcome; a second press while one is open waits on the same one. */
  const modal = (open) => {
    if (pending) return pending.promise
    let ok, no
    const promise = new Promise((a, b) => { ok = a; no = b })
    pending = { ok, no, promise, opened: false }
    try { open() } catch (e) { settle('no', e) }
    return promise
  }
  const notReady = () => Object.assign(new Error('privy_not_ready'), { code: 'not_ready' })
  return {
    ready: () => until(() => S.ready, 20_000).then(Boolean),
    authenticated: () => S.authenticated,
    walletsReady: () => S.wReady,
    /** Every Solana wallet Privy has connected in this browser, embedded or not. */
    wallets: () => S.wallets.map(view),
    /** Addresses Privy verified for this account: linking one needs no message to sign. */
    linked,
    avatar,
    /** The last wallet picked in Privy, with a counter so the site acts on each pick once. */
    chosen: () => (S.chosen ? { address: S.chosen, n: S.n } : null),
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f) },
    /** Called when a sign in finishes with no modal of ours open: the return from X's page. */
    onLogin: (f) => { loginListeners.add(f); return () => loginListeners.delete(f) },
    /** Opens Privy's sign in. Resolves once signed in; X may leave the page and come back, which onLogin then reports. */
    async login() {
      if (!(await until(() => S.ready, 20_000))) throw notReady()
      if (!S.authenticated) {
        S.chosen = null
        const r = await modal(() => S.fns.login())
        if (!r && !(await until(() => S.authenticated, 1500))) throw Object.assign(new Error('exited_auth_flow'), { code: 'exited_auth_flow' })
      }
      await until(() => S.wReady, 3000)
      return snapshot()
    },
    /** A visitor already signed in to Privy, with no modal. Null when not signed in. */
    async session() {
      if (!(await until(() => S.ready, 20_000)) || !S.authenticated) return null
      await until(() => S.wReady, 10_000)
      return snapshot()
    },
    /** Privy's own wallet list: Phantom, Solflare, Backpack and any wallet in the browser. Resolves with the address picked, or null. */
    async connect() {
      if (!(await until(() => S.ready, 20_000))) throw notReady()
      const a = await modal(() => S.fns.connectWallet({ walletChainType: 'solana-only', walletList: WALLETS }))
      if (a) await until(() => find(a), 5000)
      return a
    },
    /** A Privy wallet, made only because the person pressed "Create a wallet for me". */
    async create() {
      if (!S.authenticated) throw Object.assign(new Error('sign_in_first'), { code: 'sign_in_first' })
      const had = S.wallets.find(isEmbedded)
      const address = had?.address ?? (await S.fns.createWallet())?.wallet?.address
      if (!address) throw new Error('no_wallet')
      await until(() => find(address), 10_000)
      choose(address)
      return address
    },
    /** Disconnects an outside wallet from this site in Privy and in the wallet. An embedded wallet has nothing to disconnect. */
    async disconnect(address) {
      const w = find(address)
      if (S.chosen === address) S.chosen = null
      if (w && !isEmbedded(w)) { try { await w.disconnect() } catch {} }
      changed()
    },
    async signTransaction(address, bytes) {
      const wallet = find(address)
      if (!wallet) throw Object.assign(new Error('no_wallet'), { code: 'no_wallet' })
      const out = await S.fns.signTransaction({ transaction: bytes, wallet, ...(chain ? { chain } : {}) })
      return out.signedTransaction
    },
    async signMessage(address, bytes) {
      const wallet = find(address)
      if (!wallet) throw Object.assign(new Error('no_wallet'), { code: 'no_wallet' })
      return (await S.fns.signMessage({ message: bytes, wallet })).signature
    },
    async logout() { S.chosen = null; try { await S.fns.logout?.() } catch {} changed() },
  }
}
