// A stand-in for @privy-io/react-auth and @privy-io/react-auth/solana, bundled into the real privy-island.js for the
// Privy end to end test (test/privy-e2e.mjs). It keeps Privy's hook shapes and draws a plain modal the test clicks:
// "Continue with X" leaves the page and comes back with privy_oauth_* in the address, as Privy's X sign in does.
// State lives in localStorage like Privy's own session. Tokens and signatures come from the test through window functions.
import { createElement as h, Fragment, useEffect, useRef, useSyncExternalStore } from 'react'

const KEY = 'fp.state'
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? null } catch { return null } }
const fresh = () => ({ authed: false, x: null, linked: [], connected: [] })
let st = load() ?? fresh(), ready = false, modal = null // modal: 'login' | 'connect'
const subs = new Set()
const emit = () => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch {} snap = { ...st, ready, modal }; subs.forEach((f) => f()) }
let snap = { ...st, ready, modal }
const useStore = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => snap)
const P = () => window.__fpPersona // { did, x: { subject, username, pfp, pfpInToken }, wallets: { Phantom: addr, ... }, embedded: addr }
const count = (k) => { window.__fp ??= {}; window.__fp[k] = (window.__fp[k] ?? 0) + 1 }
const nameOf = (a) => (a === P().embedded ? 'Privy' : Object.entries(P().wallets ?? {}).find(([, v]) => v === a)?.[0] ?? 'Wallet')
const b64e = (u) => btoa(String.fromCharCode(...u)), b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const cbs = { login: new Set(), connect: new Set() }
const fire = (kind, name, arg) => cbs[kind].forEach((r) => r.current?.[name]?.(arg))
const open = (kind) => { count('open_' + kind); modal = kind; emit() }
const close = () => { modal = null; emit() }
const connect = (a) => { if (!st.connected.includes(a)) st.connected = [...st.connected, a] }

function pick(choice) {
  if (choice === 'close') { const k = modal; close(); if (k === 'login') fire('login', 'onError', 'exited_auth_flow'); return }
  if (choice === 'x') {
    // Privy's X sign in leaves for x.com and comes back with a code in the address
    sessionStorage.setItem('fp.oauth', '1'); close()
    location.assign(location.pathname + '?privy_oauth_code=c0de&privy_oauth_state=s7a7e&privy_oauth_provider=twitter')
    return
  }
  const [kind, name] = choice.split(':'), a = P().wallets[name]
  if (kind === 'wallet') {
    // A wallet sign in: Privy verifies it with a signed message and it becomes the login account
    st.authed = true; if (!st.linked.some((l) => l.address === a)) st.linked = [...st.linked, { address: a, embedded: false }]; connect(a); close()
    fire('login', 'onComplete', { user: user(), isNewUser: false, wasAlreadyAuthenticated: false, loginMethod: 'siws', loginAccount: { type: 'wallet', address: a, chainType: 'solana' } })
    return
  }
  if (kind === 'pick') { connect(a); close(); fire('connect', 'onSuccess', { wallet: { address: a } }) }
}

const user = () => (st.authed ? { id: P().did, linkedAccounts: st.linked.map((l) => ({ type: 'wallet', address: l.address, chainType: 'solana', walletClientType: l.embedded ? 'privy' : 'phantom' })), ...(st.x ? { twitter: { subject: st.x.subject, username: st.x.username, profilePictureUrl: st.x.pfp } } : {}) } : null)

function Modal() {
  const s = useStore()
  if (!s.modal) return null
  const btn = (fp, label) => h('button', { 'data-fp': fp, onClick: () => pick(fp), style: { display: 'block', margin: '6px 0' } }, label)
  const ws = Object.keys(P().wallets ?? {})
  return h('div', { id: 'fp-modal', 'data-kind': s.modal, style: { position: 'fixed', inset: '20% 30%', background: '#fff', color: '#000', zIndex: 2147483647, padding: '16px' } },
    s.modal === 'login' ? h(Fragment, null, btn('x', 'Continue with X'), ...ws.map((n) => btn('wallet:' + n, n)), btn('close', 'Close'))
      : h(Fragment, null, ...ws.map((n) => btn('pick:' + n, n + (s.connected.includes(P().wallets[n]) ? ' ✓' : ''))), btn('close', 'Close')))
}

export function PrivyProvider({ config, children }) {
  window.__fpConfig = config
  useEffect(() => {
    const back = /[?&]privy_oauth_code=/.test(location.search) && sessionStorage.getItem('fp.oauth') === '1'
    setTimeout(() => {
      ready = true
      if (back) {
        sessionStorage.removeItem('fp.oauth'); history.replaceState(null, '', location.pathname + location.hash)
        st.authed = true; st.x = { subject: P().x.subject, username: P().x.username, pfp: P().x.pfp }
        emit()
        setTimeout(() => fire('login', 'onComplete', { user: user(), isNewUser: true, wasAlreadyAuthenticated: false, loginMethod: 'twitter', loginAccount: { type: 'twitter_oauth' } }), 50)
      } else emit()
    }, 200)
  }, [])
  return h(Fragment, null, children, h(Modal))
}
const useCallbacks = (kind, v) => { const r = useRef(v); r.current = v; useEffect(() => { cbs[kind].add(r); return () => cbs[kind].delete(r) }, []) }
export function usePrivy() { const s = useStore(); return { ready: s.ready, authenticated: s.ready && s.authed, user: s.ready ? user() : null } }
export function useLogin(c) { useCallbacks('login', c); return { login: () => open('login') } }
export function useConnectWallet(c) { useCallbacks('connect', c); return { connectWallet: () => open('connect') } }
export function useLogout() { return { logout: async () => { st = fresh(); emit() } } }
export function useModalStatus() { const s = useStore(); return { isOpen: !!s.modal } }
export function useIdentityToken() { return { identityToken: null } }
const tokens = async () => JSON.parse(await window.__fpTokens(JSON.stringify({ did: P().did, x: st.x ? { ...st.x, pfp: P().x.pfpInToken ? st.x.pfp : null } : null, linked: st.linked })))
export const getAccessToken = async () => (st.authed ? (await tokens()).accessToken : null)
export const getIdentityToken = async () => (st.authed ? (await tokens()).identityToken : null)
export const toSolanaWalletConnectors = () => ({})
export function useWallets() {
  const s = useStore()
  const wallets = s.ready ? s.connected.filter((a) => a !== P().embedded || s.authed).map((a) => ({ address: a, standardWallet: { name: nameOf(a), icon: null }, disconnect: async () => { count('disconnect'); st.connected = st.connected.filter((x) => x !== a); emit() } })) : []
  return { ready: s.ready, wallets }
}
export function useCreateWallet() {
  return { createWallet: async () => {
    count('create')
    const a = P().embedded
    if (st.linked.some((l) => l.embedded)) throw new Error('embedded_wallet_already_exists')
    st.linked = [...st.linked, { address: a, embedded: true }]; connect(a); emit()
    return { wallet: { address: a } }
  } }
}
export function useSignTransaction() { return { signTransaction: async ({ transaction, wallet }) => ({ signedTransaction: b64d(await window.__fpSign(wallet.address, 'tx', b64e(transaction))) }) } }
export function useSignMessage() { return { signMessage: async ({ message, wallet }) => ({ signature: b64d(await window.__fpSign(wallet.address, 'msg', b64e(message))) }) } }
// @solana/kit, only reached on a named cluster
export const createSolanaRpc = () => ({}), createSolanaRpcSubscriptions = () => ({})
