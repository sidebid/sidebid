// Every RPC call goes through here: paced by one token bucket, batched at 100 accounts a call, counted per method so the
// real load can be measured at /api/admin/status. A failed read throws RpcError. It never comes back looking like "empty".
import { Connection } from '@solana/web3.js'

/** RPC URLs carry API keys in their query string, so no error text keeps one. */
export const redact = (s) => String(s).replace(/(https?:\/\/[^\s/?"']+)[^\s"']*/gi, '$1')

export class RpcError extends Error {
  constructor(method, cause, { rateLimited = false } = {}) {
    super(`rpc ${method}: ${redact(cause?.message ?? cause).slice(0, 160)}`)
    this.name = 'RpcError'; this.method = method; this.rateLimited = rateLimited
    this.detail = redact(`${cause?.message ?? cause} ${(cause?.logs ?? cause?.transactionLogs ?? []).join(' ')}`).slice(0, 4000)
  }
}
const is429 = (e) => /\b429\b|too many requests|rate limit/i.test(String(e?.message ?? e))
const realSleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const BATCH = 100

// The server does its own pacing: web3.js's silent 429 retries would stall the keeper for seconds.
export const connect = (url) => new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true })

export class Rpc {
  constructor({ conn, maxRps = 8, now = Date.now, sleep = realSleep, maxBackoffMs = 30_000 }) {
    Object.assign(this, { conn, maxRps, now, sleep, maxBackoffMs })
    // Public page views get their own quarter of the rate and never queue, so no number of them can slow the keeper.
    this.publicRps = Math.max(1, maxRps / 4); this.privateRps = Math.max(1, maxRps - this.publicRps)
    this.bucket = { t: now(), n: this.privateRps }; this.publicBucket = { t: now(), n: this.publicRps }
    this.pauseUntil = 0; this.backoff = 500
    this.stats = { calls: {}, errors: {}, rateLimited: 0, accountsRead: 0 }
  }
  take() {
    const t = this.now(), b = this.bucket
    b.n = Math.min(this.privateRps, b.n + (Math.max(0, t - b.t) / 1000) * this.privateRps); b.t = t
    if (b.n < 1) return false
    b.n -= 1; return true
  }
  takePublic() {
    const t = this.now(), b = this.publicBucket
    b.n = Math.min(this.publicRps, b.n + (Math.max(0, t - b.t) / 1000) * this.publicRps); b.t = t
    if (b.n < 1) return false
    b.n -= 1; return true
  }
  /** The same reads for public routes. Out of budget or during a pause it fails at once, and the caller serves the cache. */
  get public() {
    return (this._public ??= {
      accounts: async (keys, commitment = 'confirmed') => {
        const out = []
        for (let i = 0; i < keys.length; i += BATCH) {
          if (this.now() < this.pauseUntil || !this.takePublic()) { this.stats.publicRefused = (this.stats.publicRefused ?? 0) + 1; throw new RpcError('public', 'read budget used') }
          const chunk = keys.slice(i, i + BATCH)
          this.stats.calls.publicAccounts = (this.stats.calls.publicAccounts ?? 0) + 1
          let got
          try { got = await this.conn.getMultipleAccountsInfo(chunk, commitment) } catch (e) {
            if (is429(e)) { this.stats.rateLimited++; this.pauseUntil = this.now() + this.backoff; this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs); throw new RpcError('public', e, { rateLimited: true }) }
            throw new RpcError('public', e)
          }
          if (!Array.isArray(got) || got.length !== chunk.length) throw new RpcError('public', 'short answer')
          this.stats.accountsRead += chunk.length
          out.push(...got)
        }
        return out
      },
      account(key) { return this.accounts([key]).then((r) => r[0]) },
    })
  }
  async slot() {
    for (;;) {
      const wait = this.pauseUntil - this.now()
      if (wait > 0) { await this.sleep(Math.min(wait, 1000)); continue }
      if (this.take()) return
      await this.sleep(40)
    }
  }
  async call(method, fn) {
    await this.slot()
    this.stats.calls[method] = (this.stats.calls[method] ?? 0) + 1
    try {
      const r = await fn(this.conn)
      this.backoff = 500
      return r
    } catch (e) {
      this.stats.errors[method] = (this.stats.errors[method] ?? 0) + 1
      if (is429(e)) {
        this.stats.rateLimited++
        this.pauseUntil = this.now() + this.backoff
        this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs)
        throw new RpcError(method, e, { rateLimited: true })
      }
      throw new RpcError(method, e)
    }
  }
  /** Account infos in order, null only where the chain says there is no account. Throws if any part of the read failed. */
  async accounts(keys, commitment = 'confirmed') {
    const out = []
    for (let i = 0; i < keys.length; i += BATCH) {
      const chunk = keys.slice(i, i + BATCH)
      const got = await this.call('getMultipleAccountsInfo', (c) => c.getMultipleAccountsInfo(chunk, commitment))
      if (!Array.isArray(got) || got.length !== chunk.length) throw new RpcError('getMultipleAccountsInfo', 'short answer')
      this.stats.accountsRead += chunk.length
      out.push(...got)
    }
    return out
  }
  account(key) { return this.accounts([key]).then((r) => r[0]) }
  programAccounts(programId, filters) { return this.call('getProgramAccounts', (c) => c.getProgramAccounts(programId, { commitment: 'confirmed', filters })) }
  tokenAccountsByOwner(owner, mint) { return this.call('getTokenAccountsByOwner', (c) => c.getTokenAccountsByOwner(owner, { mint }, 'confirmed')).then((r) => r.value) }
  signaturesFor(address, opts) { return this.call('getSignaturesForAddress', (c) => c.getSignaturesForAddress(address, opts, 'confirmed')) }
  transactions(sigs) { return this.call('getTransactions', (c) => c.getTransactions(sigs, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })) }
  balance(key) { return this.call('getBalance', (c) => c.getBalance(key, 'confirmed')) }
  blockhash() { return this.call('getLatestBlockhash', (c) => c.getLatestBlockhash('confirmed')) }
  finalizedHeight() { return this.call('getBlockHeight', (c) => c.getBlockHeight('finalized')) }
  statuses(sigs) { return this.call('getSignatureStatuses', (c) => c.getSignatureStatuses(sigs, { searchTransactionHistory: true })).then((r) => r.value) }
  send(raw, opts) { return this.call('sendRawTransaction', (c) => c.sendRawTransaction(raw, opts)) }
}
