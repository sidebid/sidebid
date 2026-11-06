// Privy sign in, checked here with no app secret. Privy signs its access and identity tokens with ES256; the public keys
// are the app's JWKS (auth.privy.io/api/v1/apps/<app id>/jwks.json). The identity token carries the linked accounts, so
// the X account, its handle and picture, and the wallets come from Privy's signature, never from the browser.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

const SKEW_S = 30
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
export const jwksUrlFor = (appId) => `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`

export class PrivyVerifier {
  /** fetchImpl here is plain fetch: Privy is not X, so none of this touches the X client or its spend. */
  constructor({ appId, jwksUrl = null, fetchImpl = (...a) => fetch(...a), now = Date.now, cacheMs = 3_600_000, refetchMs = 60_000 }) {
    Object.assign(this, { appId, jwksUrl: jwksUrl || jwksUrlFor(appId), fetchImpl, now, cacheMs, refetchMs })
    this.keys = new Map(); this.fetchedAt = 0; this.triedAt = -Infinity; this.loading = null
  }
  ready() { return !!this.appId }
  async load() {
    if (this.loading) return this.loading
    this.triedAt = this.now()
    this.loading = (async () => {
      try {
        const r = await this.fetchImpl(this.jwksUrl, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) throw new Error(`jwks ${r.status}`)
        const body = await r.json(), next = new Map()
        for (const k of body?.keys ?? []) {
          if (k.kty !== 'EC' || k.crv !== 'P-256' || (k.alg && k.alg !== 'ES256') || (k.use && k.use !== 'sig') || !k.kid) continue
          try { next.set(k.kid, createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, format: 'jwk' })) } catch {}
        }
        if (next.size) { this.keys = next; this.fetchedAt = this.now() }
      } finally { this.loading = null }
    })()
    return this.loading
  }
  /** The key for a kid. An unknown kid refetches the set, at most once a minute, so a key rotation is picked up. */
  async key(kid) {
    const t = this.now(), stale = t - this.fetchedAt > this.cacheMs
    // A failed fetch is retried after 5 seconds, not on every sign in
    if ((stale && t - this.triedAt > 5000) || (!this.keys.has(kid) && t - this.triedAt > this.refetchMs)) await this.load().catch(() => {})
    return this.keys.get(kid) ?? null
  }
  /** Returns { ok: true, claims } or { ok: false, why }. Checks the signature, alg, issuer, audience and expiry. */
  async verify(token) {
    if (!this.appId) return { ok: false, why: 'privy_off' }
    if (typeof token !== 'string' || token.length > 16_384) return { ok: false, why: 'bad_token' }
    const parts = token.split('.')
    if (parts.length !== 3) return { ok: false, why: 'bad_token' }
    let head, claims
    try { head = b64json(parts[0]); claims = b64json(parts[1]) } catch { return { ok: false, why: 'bad_token' } }
    if (head?.alg !== 'ES256' || typeof head.kid !== 'string') return { ok: false, why: 'bad_alg' }
    const key = await this.key(head.kid)
    if (!key) return { ok: false, why: 'unknown_key' }
    let good = false
    try { good = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')) } catch {}
    if (!good) return { ok: false, why: 'bad_signature' }
    const t = Math.floor(this.now() / 1000)
    if (claims.iss !== 'privy.io') return { ok: false, why: 'wrong_issuer' }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(this.appId)) return { ok: false, why: 'wrong_audience' }
    if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < t) return { ok: false, why: 'expired' }
    if (Number.isFinite(claims.nbf) && claims.nbf - SKEW_S > t) return { ok: false, why: 'not_yet' }
    if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > t) return { ok: false, why: 'not_yet' }
    if (typeof claims.sub !== 'string' || !/^did:privy:[A-Za-z0-9]{8,64}$/.test(claims.sub)) return { ok: false, why: 'bad_subject' }
    return { ok: true, claims }
  }
}

/**
 * What the identity token says about the person: their Privy id, the X account linked to it (if any) and their Solana
 * wallets. linked_accounts is a JSON string in the token; both snake and camel keys are read, since Privy's SDKs use both.
 */
export function identityOf(claims) {
  let list = claims?.linked_accounts ?? claims?.linkedAccounts ?? []
  if (typeof list === 'string') { try { list = JSON.parse(list) } catch { list = [] } }
  if (!Array.isArray(list)) list = []
  const pick = (a, ...k) => { for (const x of k) if (a?.[x] != null) return a[x]; return null }
  const tw = list.find((a) => a?.type === 'twitter_oauth')
  const x = tw && /^\d{1,25}$/.test(String(pick(tw, 'subject') ?? '')) ? { subject: String(tw.subject), username: String(pick(tw, 'username') ?? ''), avatar: pick(tw, 'profile_picture_url', 'profilePictureUrl', 'pfp', 'profile_image_url') } : null
  const wallets = list.filter((a) => a?.type === 'wallet' && pick(a, 'chain_type', 'chainType') === 'solana' && typeof a.address === 'string')
    .map((a) => ({ address: a.address, embedded: pick(a, 'wallet_client_type', 'walletClientType') === 'privy' || pick(a, 'connector_type', 'connectorType') === 'embedded', verifiedAt: Number(pick(a, 'latest_verified_at', 'latestVerifiedAt', 'lv', 'verified_at', 'verifiedAt') ?? 0) || 0 }))
  const email = list.find((a) => a?.type === 'email')
  return { did: claims.sub, x, wallets, email: email ? String(pick(email, 'address') ?? '') : null }
}
