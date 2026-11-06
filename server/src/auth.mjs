// Sign in through Privy (X, a wallet or email), server side sessions, and wallet linking: by Privy's signed identity token
// for a wallet Privy verified, or by a signed one time message for any other wallet. Our own Sign in with X (OAuth 2.0
// PKCE) stays only as a fallback behind X_OAUTH_FALLBACK, off by default.
// An account is keyed by the X user id when an X account is linked in Privy, else by the Privy id ("pv:..."), so the one
// per X account rules, tagging and the pass keep working on the X id, and only Privy's signature can name it.
import { createHash, randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { identityOf as identityOfClaims } from './privy.mjs'

const SESSION_MS = 30 * 86_400_000, STATE_MS = 10 * 60_000, NONCE_MS = 10 * 60_000
const SCOPES = 'tweet.read users.read'
const hash = (t) => createHash('sha256').update(String(t)).digest('hex')
const b64u = (n) => randomBytes(n).toString('base64url')

/** A real wallet address: base58, canonical, and on curve, because nobody can sign for a PDA. */
export const validWallet = (a) => { try { if (typeof a !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false; const k = new PublicKey(a); return k.toBase58() === a && PublicKey.isOnCurve(k.toBytes()) } catch { return false } }
const decodeSig = (s) => {
  if (typeof s !== 'string') return null
  try { const b = bs58.decode(s); if (b.length === 64) return b } catch {}
  try { const b = Buffer.from(s, 'base64'); if (b.length === 64) return new Uint8Array(b) } catch {}
  return null
}
export const cleanHandle = (h) => String(h ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15)
/** True for an account keyed by a real X user id; false for a Privy account with no X linked. */
export const hasX = (id) => !!id && !String(id).startsWith('pv:')
const pvId = (did) => 'pv:' + String(did).replace(/^did:privy:/, '')
export const cleanAvatar = (u) => (/^https:\/\/pbs\.twimg\.com\/[\w./-]+$/.test(String(u ?? '')) ? String(u).replace('_normal.', '_200x200.') : null)

export class Auth {
  constructor({ db, config, spend = null, privy = null, fetchImpl = (...a) => fetch(...a), now = Date.now, log = () => {} }) { Object.assign(this, { db, config, spend, privy, fetchImpl, now, log }); this.secure = /^https:/i.test(config.publicUrl) }
  /** X bills the profile read at "User: Read". It comes out of the sign in allowance in the same ledger as every other X call. */
  signinCost() { return this.config.x.costPerUserUsd ?? 0.01 }
  /** False when today's sign in allowance (or the whole daily cap) has no room for one more profile read. */
  signinOpen() { return !!this.spend?.signinRoom(this.signinCost()) }
  redirectUri() { return `${this.config.publicUrl}/api/auth/x/callback` }
  cookie(name, value, maxAge, path = '/') { return `${name}=${value}; HttpOnly;${this.secure ? ' Secure;' : ''} SameSite=Lax; Path=${path}; Max-Age=${maxAge}` }
  /** Our own X OAuth: only with X_OAUTH_FALLBACK on and a client id. */
  xReady() { return !!(this.config.x.oauthFallback && this.config.x.signinClientId) }
  privyReady() { return !!this.privy?.ready() }
  ready() { return this.privyReady() || this.xReady() }

  // ---- Privy
  /** The account an identity maps to: the X user id when X is linked, else the Privy id. */
  accountOf(identity) { return identity.x ? identity.x.subject : pvId(identity.did) }
  /**
   * Both tokens must verify and name the same Privy user. No X call is made: the handle and picture are the ones Privy
   * read when the person linked X. `avatar` is the picture Privy's user object holds, used only when the token carries
   * none, only for an X account, and only from pbs.twimg.com. `wallet` is the one the person picked in Privy: it is linked
   * when Privy verified it, at once if the account has no wallet yet or its wallet was never used. Nothing else is linked,
   * so a wallet Privy made or one the person did not pick never takes the account.
   */
  async privySignIn({ accessToken, identityToken, wallet = null, avatar = null }) {
    if (!this.privyReady()) return { ok: false, why: 'privy_off' }
    const a = await this.privy.verify(accessToken)
    if (!a.ok) return { ok: false, why: a.why }
    if (!identityToken) return { ok: false, why: 'no_identity_token' }
    const i = await this.privy.verify(identityToken)
    if (!i.ok) return { ok: false, why: i.why }
    if (i.claims.sub !== a.claims.sub) return { ok: false, why: 'mismatch' }
    const id = identityOfClaims(i.claims), account = this.accountOf(id)
    const user = id.x
      ? { xId: account, handle: cleanHandle(id.x.username), avatar: cleanAvatar(id.x.avatar) ?? cleanAvatar(avatar), xCreatedAt: null, followers: null }
      : { xId: account, handle: '', avatar: null, xCreatedAt: null, followers: null }
    const session = b64u(32)
    this.db.tx(() => {
      const had = this.db.get('SELECT account FROM privy_users WHERE did=?', id.did)
      this.upsertUser(user, { keepStats: true })
      // Someone who signed in without X and links it later keeps their wallet: it moves to the X account
      if (had && had.account !== account && !hasX(had.account) && hasX(account)) this.moveAccount(had.account, account)
      this.db.run('INSERT INTO privy_users (did,account,updated_at) VALUES (?,?,?) ON CONFLICT(did) DO UPDATE SET account=excluded.account, updated_at=excluded.updated_at', id.did, account, this.now())
      this.db.run('DELETE FROM sessions WHERE expires_at < ?', this.now())
      this.db.run('INSERT INTO sessions (token_hash,x_id,expires_at) VALUES (?,?,?)', hash(session), account, this.now() + SESSION_MS)
    })
    // The picked wallet, if Privy verified it. A change that would have to wait is never started here, only by the person
    if (validWallet(wallet) && id.wallets.some((w) => w.address === wallet)) this.applyLink(account, wallet, { noWait: true })
    return { ok: true, token: session, user: { ...user, hasX: !!id.x }, wallets: id.wallets.map((w) => w.address) }
  }
  /** Links a wallet the identity token says Privy verified for this same account. Same wait as any other change. */
  async privyLink(xId, { identityToken, wallet }) {
    if (!this.privyReady()) return { ok: false, why: 'privy_off' }
    const i = await this.privy.verify(identityToken)
    if (!i.ok) return { ok: false, why: i.why }
    const id = identityOfClaims(i.claims)
    if (this.accountOf(id) !== xId) return { ok: false, why: 'mismatch' }
    if (!validWallet(wallet) || !id.wallets.some((w) => w.address === wallet)) return { ok: false, why: 'not_your_privy_wallet' }
    return this.applyLink(xId, wallet)
  }
  moveAccount(from, to) {
    const src = this.db.get('SELECT * FROM wallet_links WHERE x_id=?', from)
    if (src) {
      if (this.db.get('SELECT 1 FROM wallet_links WHERE x_id=?', to)) {
        // The X account already has its own wallet: the old one is freed, not merged
        this.db.run('DELETE FROM wallet_owners WHERE x_id=?', from)
        this.db.run('DELETE FROM wallet_links WHERE x_id=?', from)
      } else {
        this.db.run('UPDATE wallet_links SET x_id=? WHERE x_id=?', to, from)
        this.db.run('UPDATE wallet_owners SET x_id=? WHERE x_id=?', to, from)
      }
    }
    this.db.run('UPDATE sessions SET x_id=? WHERE x_id=?', to, from)
  }

  startSignIn() {
    this.db.run('DELETE FROM oauth_states WHERE expires_at < ?', this.now())
    const state = b64u(24), verifier = b64u(48)
    this.db.run('INSERT INTO oauth_states (state,verifier,expires_at) VALUES (?,?,?)', state, verifier, this.now() + STATE_MS)
    const q = new URLSearchParams({ response_type: 'code', client_id: this.config.x.signinClientId, redirect_uri: this.redirectUri(), scope: SCOPES, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
    return { url: `https://x.com/i/oauth2/authorize?${q}`, state }
  }
  /** Returns { ok, token, user } or { ok: false, why }. The state is one try, right or wrong, and must match this browser's cookie. */
  async finishSignIn({ code, state, cookieState }) {
    const row = this.db.get('SELECT * FROM oauth_states WHERE state=?', String(state))
    this.db.run('DELETE FROM oauth_states WHERE state=?', String(state))
    if (!code || !row || row.expires_at < this.now() || !cookieState || cookieState !== state) return { ok: false, why: 'expired' }
    const { signinClientId: id, signinClientSecret: secret } = this.config.x
    const headers = { 'content-type': 'application/x-www-form-urlencoded' }
    if (secret) headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
    try {
      const t = await this.fetchImpl('https://api.x.com/2/oauth2/token', { method: 'POST', headers, signal: AbortSignal.timeout(10_000), body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: this.redirectUri(), code_verifier: row.verifier, client_id: id }) })
      const token = t.ok ? (await t.json()).access_token : null
      if (!token) return { ok: false, why: 'x_refused' }
      // The one paid call. Past the allowance it is never made: the visitor is told sign in is paused.
      const cost = this.signinCost()
      if (!this.spend?.reserve(cost, { signin: true })) return { ok: false, why: 'paused' }
      const r = await this.fetchImpl('https://api.x.com/2/users/me?user.fields=created_at,public_metrics,profile_image_url', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) this.spend.release(cost, { signin: true }) // a refused call is not billed
      const who = r.ok ? (await r.json()).data : null
      if (!who?.id || !who?.username) return { ok: false, why: 'x_refused' }
      const user = { xId: String(who.id), handle: cleanHandle(who.username), avatar: cleanAvatar(who.profile_image_url), xCreatedAt: Number.isFinite(Date.parse(who.created_at)) ? Date.parse(who.created_at) : null, followers: Number.isFinite(Number(who.public_metrics?.followers_count)) ? Number(who.public_metrics.followers_count) : null }
      this.upsertUser(user)
      const session = b64u(32)
      this.db.run('DELETE FROM sessions WHERE expires_at < ?', this.now())
      this.db.run('INSERT INTO sessions (token_hash,x_id,expires_at) VALUES (?,?,?)', hash(session), user.xId, this.now() + SESSION_MS)
      return { ok: true, token: session, user }
    } catch (e) { this.log('[signin]', e.message); return { ok: false, why: 'x_refused' } }
  }
  /** keepStats: Privy gives no account age or followers, so ones read earlier are kept rather than wiped. */
  upsertUser({ xId, handle, avatar, xCreatedAt, followers }, { keepStats = false } = {}) {
    const stats = keepStats ? 'x_created_at=COALESCE(excluded.x_created_at, x_users.x_created_at), followers=COALESCE(excluded.followers, x_users.followers)' : 'x_created_at=excluded.x_created_at, followers=excluded.followers'
    this.db.run(`INSERT INTO x_users (x_id,handle,avatar,x_created_at,followers,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(x_id) DO UPDATE SET handle=excluded.handle, avatar=excluded.avatar, ${stats}, updated_at=excluded.updated_at`, xId, handle, avatar ?? null, xCreatedAt ?? null, followers ?? null, this.now())
  }
  sessionUser(token) {
    if (!token) return null
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash=?', hash(token))
    if (!s || s.expires_at <= this.now()) return null
    return this.db.get('SELECT * FROM x_users WHERE x_id=?', s.x_id) ?? null
  }
  signOut(token) { this.db.run('DELETE FROM sessions WHERE token_hash=?', hash(token)) }

  // ---- wallet linking
  /** The wallet cards and passes use right now. A change takes over only after its wait. */
  activeWallet(xId) {
    const w = this.db.get('SELECT * FROM wallet_links WHERE x_id=?', xId)
    if (!w) return null
    if (w.pending_wallet && w.pending_at <= this.now()) {
      this.db.tx(() => {
        this.db.run('DELETE FROM wallet_owners WHERE wallet=?', w.wallet)
        this.db.run('UPDATE wallet_links SET wallet=?, linked_at=?, pending_wallet=NULL, pending_at=NULL WHERE x_id=?', w.pending_wallet, this.now(), xId)
      })
      return w.pending_wallet
    }
    return w.wallet
  }
  /**
   * changeWaits: true once the linked wallet has listed, bid or taken a pass. Until then a different wallet replaces it at
   * once, so a wallet linked by mistake (or made by Privy) never traps a new account behind the wait.
   */
  linkState(xId) {
    const wallet = this.activeWallet(xId)
    const w = this.db.get('SELECT * FROM wallet_links WHERE x_id=?', xId)
    return { wallet, pendingWallet: w?.pending_wallet ?? null, pendingAt: w?.pending_at ?? null, changeWaits: !!wallet && this.walletUsed(wallet) }
  }
  /** True once a wallet has listed, bid, bought, sold or taken a pass on the site: from then on a change waits. */
  walletUsed(wallet) {
    return !!this.db.get(`SELECT 1 FROM passes_issued WHERE wallet=?1 UNION ALL SELECT 1 FROM tag_cards WHERE wallet=?1
      UNION ALL SELECT 1 FROM listings WHERE seller=?1 OR top_bidder=?1 UNION ALL SELECT 1 FROM sales WHERE seller=?1 OR winner=?1
      UNION ALL SELECT 1 FROM events_seen WHERE name='BidPlaced' AND json_extract(data, '$.bidder')=?1 LIMIT 1`, wallet)
  }
  challenge(xId, wallet) {
    if (!validWallet(wallet)) return { ok: false, why: 'not_a_wallet' }
    this.db.run('DELETE FROM link_nonces WHERE expires_at < ?', this.now())
    const user = this.db.get('SELECT handle FROM x_users WHERE x_id=?', xId)
    if (!user) return { ok: false, why: 'unknown_account' }
    const nonce = b64u(16), domain = new URL(this.config.publicUrl).host
    // Names who gets the wallet, so a signature asked for by a stranger reads as what it is.
    const brand = this.config.brand?.name ?? 'Sidebid'
    const message = hasX(xId)
      ? `Link this wallet to X account @${user.handle} (id ${xId}) on ${brand}, ${domain}\nOnly sign if @${user.handle} is your own account.\nWallet: ${wallet}\nCode: ${nonce}\nThis does not approve any transaction or move any funds.`
      : `Link this wallet to ${brand} account ${xId} on ${domain}\nOnly sign if you signed in to ${domain} yourself.\nWallet: ${wallet}\nCode: ${nonce}\nThis does not approve any transaction or move any funds.`
    this.db.run('INSERT INTO link_nonces (nonce,x_id,wallet,message,expires_at) VALUES (?,?,?,?,?)', nonce, xId, wallet, message, this.now() + NONCE_MS)
    return { ok: true, nonce, message }
  }
  /** Links a first wallet at once. A different wallet starts the wait. The nonce is one try, right or wrong. */
  link(xId, { wallet, nonce, signature }) {
    const n = this.db.get('SELECT * FROM link_nonces WHERE nonce=?', String(nonce))
    const used = this.db.run('DELETE FROM link_nonces WHERE nonce=?', String(nonce))
    if (!n || !used.changes || n.expires_at < this.now()) return { ok: false, why: 'expired' }
    if (n.x_id !== xId || n.wallet !== wallet) return { ok: false, why: 'mismatch' }
    const sig = decodeSig(signature)
    if (!sig) return { ok: false, why: 'unreadable_signature' }
    let good = false
    try { good = nacl.sign.detached.verify(new TextEncoder().encode(n.message), sig, new PublicKey(wallet).toBytes()) } catch {}
    if (!good) return { ok: false, why: 'bad_signature' }
    return this.applyLink(xId, wallet)
  }
  /**
   * The link itself, once ownership of the wallet is proven: a first wallet at once; a different one at once while the
   * linked wallet was never used, else after the wait. noWait: never start a wait, report it instead (sign in uses this).
   */
  applyLink(xId, wallet, { noWait = false } = {}) {
    return this.db.tx(() => {
      const owner = this.db.get('SELECT x_id FROM wallet_owners WHERE wallet=?', wallet)
      if (owner && owner.x_id !== xId) return { ok: false, why: 'wallet_taken' }
      const cur = this.db.get('SELECT * FROM wallet_links WHERE x_id=?', xId)
      if (!cur) {
        this.db.run('INSERT INTO wallet_links (x_id,wallet,linked_at) VALUES (?,?,?)', xId, wallet, this.now())
        this.db.run('INSERT INTO wallet_owners (wallet,x_id) VALUES (?,?)', wallet, xId)
        return { ok: true, wallet, waiting: false }
      }
      if (cur.wallet === wallet) return { ok: true, wallet, waiting: false }
      if (!this.walletUsed(cur.wallet)) {
        // Never used: the new wallet replaces it now, and a change that was waiting is dropped with it
        this.db.run('DELETE FROM wallet_owners WHERE wallet=? OR wallet=?', cur.wallet, cur.pending_wallet ?? '')
        this.db.run('UPDATE wallet_links SET wallet=?, linked_at=?, pending_wallet=NULL, pending_at=NULL WHERE x_id=?', wallet, this.now(), xId)
        this.db.run('INSERT INTO wallet_owners (wallet,x_id) VALUES (?,?)', wallet, xId)
        return { ok: true, wallet, waiting: false, replaced: cur.wallet }
      }
      if (noWait) return { ok: false, why: 'change_waits' }
      if (cur.pending_wallet) return { ok: false, why: 'change_already_waiting', pendingAt: cur.pending_at }
      const at = this.now() + this.config.walletChangeWaitMs
      this.db.run('UPDATE wallet_links SET pending_wallet=?, pending_at=? WHERE x_id=?', wallet, at, xId)
      this.db.run('INSERT INTO wallet_owners (wallet,x_id) VALUES (?,?)', wallet, xId)
      return { ok: true, wallet: cur.wallet, waiting: true, pendingWallet: wallet, pendingAt: at }
    })
  }
  /**
   * Support only, for a wallet linked to the wrong X account (a phished signature). Frees the wallet whether it is an active link
   * or a waiting change. Nothing on chain changes: a tagged card already made for it still names that wallet as seller, and
   * only that wallet can accept it. Every unlink is kept in admin_unlinks.
   */
  adminUnlink(wallet, reason = '') {
    if (!validWallet(wallet)) return { ok: false, why: 'not_a_wallet' }
    return this.db.tx(() => {
      const active = this.db.get('SELECT * FROM wallet_links WHERE wallet=?', wallet)
      const pending = this.db.get('SELECT * FROM wallet_links WHERE pending_wallet=?', wallet)
      if (!active && !pending) return { ok: false, why: 'not_linked' }
      if (active) {
        this.db.run('DELETE FROM wallet_owners WHERE wallet=?', wallet)
        if (active.pending_wallet) this.db.run('DELETE FROM wallet_owners WHERE wallet=?', active.pending_wallet)
        this.db.run('DELETE FROM wallet_links WHERE x_id=?', active.x_id)
      } else {
        this.db.run('DELETE FROM wallet_owners WHERE wallet=?', wallet)
        this.db.run('UPDATE wallet_links SET pending_wallet=NULL, pending_at=NULL WHERE x_id=?', pending.x_id)
      }
      const xId = (active ?? pending).x_id
      this.db.run('INSERT INTO admin_unlinks (wallet,x_id,was,reason,at) VALUES (?,?,?,?,?)', wallet, xId, active ? 'active' : 'pending', String(reason ?? '').slice(0, 200), this.now())
      return { ok: true, wallet, xId, was: active ? 'active' : 'pending' }
    })
  }
  cancelChange(xId) {
    return this.db.tx(() => {
      const cur = this.db.get('SELECT * FROM wallet_links WHERE x_id=?', xId)
      if (!cur?.pending_wallet) return { ok: false, why: 'nothing_waiting' }
      this.db.run('DELETE FROM wallet_owners WHERE wallet=?', cur.pending_wallet)
      this.db.run('UPDATE wallet_links SET pending_wallet=NULL, pending_at=NULL WHERE x_id=?', xId)
      return { ok: true, wallet: cur.wallet }
    })
  }
}
