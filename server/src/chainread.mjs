// The indexed reads the browser needs and the free browser RPC refuses: a wallet's coins and a coin's top holders. They run
// on our own RPC (RPC_URL), whose address and key never leave the server. Only these fixed reads exist here, never a proxy.
// Answers are cached briefly (10 s per wallet, 60 s per coin) and share the public read budget, so no number of visitors
// can slow the keeper.
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { redact } from './chain/rpc.mjs'

export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A base58 public key written exactly as it decodes. */
export const validKey = (s) => { try { return typeof s === 'string' && KEY.test(s) && new PublicKey(s).toBase58() === s } catch { return false } }
const str = (s, n) => String(s ?? '').replace(/[\u0000-\u001f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, n)

/** JSON-RPC over fetch to our own RPC. Errors never carry the URL. */
export function jsonRpc(url, fetchImpl = fetch) {
  let id = 0
  return async (method, params) => {
    let r
    try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) }) }
    catch (e) { throw new Error(`${method}: ${redact(e?.message ?? e)}`) }
    if (!r.ok) throw new Error(`${method}: http ${r.status}`)
    const j = await r.json()
    if (j.error) throw new Error(`${method}: ${redact(j.error.message ?? 'rpc error')}`)
    return j.result
  }
}

export class ChainReads {
  /**
   * `call(method, params)` is a JSON-RPC call to our RPC. `take()` spends one unit of the public read budget (false when
   * none is left); a read waits up to `waitMs` for one, then fails.
   */
  constructor({ call, take = () => true, now = Date.now, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), waitMs = 5_000, ownerMs = 10_000, mintMs = 60_000, maxKeys = 5_000 }) {
    Object.assign(this, { rpcCall: call, take, now, sleep, waitMs, ownerMs, mintMs, maxKeys })
    this.cache = new Map()
    this.stats = { calls: 0, hits: 0, das: 0, dasFailed: 0 }
  }
  async call(method, params) {
    const until = this.now() + this.waitMs
    while (!this.take()) {
      if (this.now() >= until) throw new Error('read budget used')
      await this.sleep(100)
    }
    this.stats.calls++
    return this.rpcCall(method, params)
  }
  memo(key, ms, fn) {
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < ms) { this.stats.hits++; return hit.p }
    const p = fn()
    p.catch(() => { if (this.cache.get(key)?.p === p) this.cache.delete(key) })
    this.cache.delete(key)
    while (this.cache.size >= this.maxKeys) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(key, { at: this.now(), p })
    return p
  }

  /**
   * Every coin this wallet holds in its associated token account, both token programs, with name, ticker, picture and a
   * USD value when the indexer knows them. Coins with no metadata are kept, with null names. Sorted by USD value, then
   * by balance. With `mint`, only that coin (an empty list when the wallet holds none).
   */
  walletCoins(owner, mint = null) {
    if (!validKey(owner) || (mint !== null && !validKey(mint))) return Promise.reject(Object.assign(new Error('bad_address'), { code: 400 }))
    return this.memo(`o:${owner}:${mint ?? ''}`, this.ownerMs, async () => {
      const filters = mint ? [{ mint }] : [{ programId: TOKEN }, { programId: TOKEN_2022 }]
      const [lists, das] = await Promise.all([
        Promise.all(filters.map((f) => this.call('getTokenAccountsByOwner', [owner, f, { encoding: 'base64', commitment: 'confirmed' }]))),
        mint ? this.dasAsset(mint) : this.dasOwner(owner),
      ])
      const o = new PublicKey(owner), out = []
      for (const v of lists.flatMap((r) => r?.value ?? [])) {
        const program = v.account?.owner
        if (program !== TOKEN && program !== TOKEN_2022) continue
        const d = Buffer.from(v.account.data[0], 'base64')
        if (d.length < 165) continue
        const m = new PublicKey(d.subarray(0, 32)), amount = d.readBigUInt64LE(64)
        if (amount === 0n) continue
        // Only the associated account: the contract lists from nothing else
        if (!getAssociatedTokenAddressSync(m, o, false, new PublicKey(program)).equals(new PublicKey(v.pubkey))) continue
        const meta = das.get(m.toBase58()) ?? null
        out.push({ mint: m.toBase58(), tokenProgram: program, tokenAccount: v.pubkey, amount: amount.toString(), delegated: d.readUInt32LE(72) === 1, decimals: meta?.decimals ?? null, name: meta?.name ?? null, symbol: meta?.symbol ?? null, image: meta?.image ? `/api/site/coinimg/${m.toBase58()}` : null, usd: meta?.usd ?? null })
      }
      // Decimals the indexer did not give come from the mint accounts themselves
      const need = out.filter((c) => c.decimals === null)
      if (need.length) {
        const got = await this.call('getMultipleAccounts', [need.map((c) => c.mint), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 44, length: 1 } }]).catch(() => null)
        need.forEach((c, i) => { const a = got?.value?.[i]; if (a) c.decimals = Buffer.from(a.data[0], 'base64')[0] ?? null })
      }
      return sortCoins(out)
    })
  }
  /** Name, ticker, picture, decimals and USD price per mint from the DAS indexer. Empty when it fails: balances still show. */
  async dasOwner(owner) {
    const out = new Map()
    try {
      for (let page = 1; page <= 3; page++) {
        const r = await this.call('getAssetsByOwner', { ownerAddress: owner, page, limit: 1000, displayOptions: { showFungible: true, showZeroBalance: false, showNativeBalance: false } })
        this.stats.das++
        for (const a of r?.items ?? []) { const m = dasMeta(a); if (m) out.set(a.id, m) }
        if ((r?.items?.length ?? 0) < 1000) break
      }
    } catch { this.stats.dasFailed++ }
    return out
  }
  async dasAsset(mint) {
    const out = new Map()
    try { const a = await this.call('getAsset', { id: mint, displayOptions: { showFungible: true } }); this.stats.das++; const m = dasMeta(a); if (m) out.set(mint, m) } catch { this.stats.dasFailed++ }
    return out
  }

  /** The seven biggest holders with their owners. Owner is null when the account isn't a plain token account. */
  holders(mint) {
    if (!validKey(mint)) return Promise.reject(Object.assign(new Error('bad_address'), { code: 400 }))
    return this.memo(`m:${mint}`, this.mintMs, async () => {
      const big = await this.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }])
      const top = (big?.value ?? []).filter((a) => a.amount !== '0').slice(0, 7)
      if (!top.length) return []
      const infos = await this.call('getMultipleAccounts', [top.map((a) => a.address), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 32, length: 32 } }])
      return top.map((a, i) => {
        const v = infos?.value?.[i], b = v ? Buffer.from(v.data[0], 'base64') : null
        const owner = b && b.length === 32 && (v.owner === TOKEN || v.owner === TOKEN_2022) ? new PublicKey(b).toBase58() : null
        return { account: a.address, owner, amount: String(a.amount) }
      })
    })
  }
}

/** The fields we keep from one DAS asset, or null when it is not a fungible token. */
export function dasMeta(a) {
  if (!a?.id || !a.token_info) return null
  const md = a.content?.metadata ?? {}, ti = a.token_info
  const image = a.content?.links?.image || a.content?.files?.find?.((f) => /^image\//.test(f?.mime ?? ''))?.uri || null
  const price = Number(ti.price_info?.price_per_token), dec = Number.isInteger(ti.decimals) ? ti.decimals : null
  const usd = Number.isFinite(price) && price > 0 && dec !== null && ti.balance != null ? price * (Number(ti.balance) / 10 ** dec) : null
  return { name: str(md.name, 64) || null, symbol: str(md.symbol, 16).replace(/^\$/, '') || null, image: image ? String(image) : null, decimals: dec, usd: usd !== null && Number.isFinite(usd) ? Math.round(usd * 100) / 100 : null }
}
/** USD value first where known, then by balance in whole tokens. */
export function sortCoins(list) {
  const whole = (c) => Number(c.amount) / 10 ** (c.decimals ?? 0)
  return list.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || whole(b) - whole(a))
}
