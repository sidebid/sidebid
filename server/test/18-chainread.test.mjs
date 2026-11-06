import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ChainReads, TOKEN, TOKEN_2022, validKey, sortCoins, dasMeta } from '../src/chainread.mjs'
import { world } from './harness.mjs'
import { listen } from '../src/http.mjs'

const key = () => Keypair.generate().publicKey.toBase58()
/** A token account's bytes: mint, owner, amount, delegate tag. */
function tokenAcc(mint, owner, amount, delegated = false) {
  const b = Buffer.alloc(165)
  new PublicKey(mint).toBuffer().copy(b, 0); new PublicKey(owner).toBuffer().copy(b, 32)
  b.writeBigUInt64LE(BigInt(amount), 64); b.writeUInt32LE(delegated ? 1 : 0, 72)
  return b.toString('base64')
}
const ata = (mint, owner, program) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(program)).toBase58()

/** A mocked RPC: one wallet with a named priced coin, an unnamed coin, a Token 2022 coin, a stray non-ATA and an empty ATA. */
function chain() {
  const owner = key(), named = key(), plain = key(), t22 = key(), stray = key(), empty = key()
  const calls = []
  const accounts = {
    [TOKEN]: [
      { pubkey: ata(named, owner, TOKEN), account: { owner: TOKEN, data: [tokenAcc(named, owner, 5_000_000n), 'base64'] } },
      { pubkey: ata(plain, owner, TOKEN), account: { owner: TOKEN, data: [tokenAcc(plain, owner, 1_000_000_000_000n, true), 'base64'] } },
      { pubkey: key(), account: { owner: TOKEN, data: [tokenAcc(stray, owner, 9n), 'base64'] } },
      { pubkey: ata(empty, owner, TOKEN), account: { owner: TOKEN, data: [tokenAcc(empty, owner, 0n), 'base64'] } },
    ],
    [TOKEN_2022]: [{ pubkey: ata(t22, owner, TOKEN_2022), account: { owner: TOKEN_2022, data: [tokenAcc(t22, owner, 7_000_000_000n), 'base64'] } }],
  }
  const das = {
    items: [
      { id: named, interface: 'FungibleToken', content: { metadata: { name: 'Named Coin', symbol: '$NAMED' }, links: { image: 'https://img.example/n.png' } }, token_info: { balance: 5_000_000, decimals: 6, price_info: { price_per_token: 2.5 } } },
      { id: plain, interface: 'FungibleToken', content: { metadata: {}, links: {} }, token_info: { balance: 1_000_000_000_000, decimals: 6 } },
    ],
  }
  const call = async (method, params) => {
    calls.push(method)
    if (method === 'getTokenAccountsByOwner') {
      if (params[1].mint) return { value: Object.values(accounts).flat().filter((v) => Buffer.from(v.account.data[0], 'base64').subarray(0, 32).equals(new PublicKey(params[1].mint).toBuffer())) }
      return { value: accounts[params[1].programId] }
    }
    if (method === 'getAssetsByOwner') return das
    if (method === 'getAsset') return das.items.find((a) => a.id === params.id) ?? null
    if (method === 'getMultipleAccounts') {
      // t22 has no DAS entry: its decimals come from the mint (offset 44)
      return { value: params[0].map((k) => (k === t22 ? { owner: TOKEN_2022, data: [Buffer.from([9]).toString('base64'), 'base64'] } : null)) }
    }
    throw new Error('unexpected ' + method)
  }
  return { owner, named, plain, t22, stray, empty, calls, call }
}

test('chain reads: validation of base58 keys', async () => {
  assert.equal(validKey(key()), true)
  for (const bad of ['', 'abc', '0OIl' + 'x'.repeat(40), key() + 'x', 123, null, '../../etc']) assert.equal(validKey(bad), false)
  const r = new ChainReads({ call: async () => { throw new Error('no call expected') } })
  await assert.rejects(r.walletCoins('nope'), /bad_address/)
  await assert.rejects(r.walletCoins(key(), 'nope'), /bad_address/)
  await assert.rejects(r.holders('nope'), /bad_address/)
})

test('chain reads: wallet coins keep only non empty ATAs of both programs, merged with DAS, sorted by value then balance', async () => {
  const c = chain(), r = new ChainReads({ call: c.call })
  const coins = await r.walletCoins(c.owner)
  assert.deepEqual(coins.map((x) => x.mint), [c.named, c.plain, c.t22], 'priced coin first, then by whole token balance')
  const [n, p, t] = coins
  assert.deepEqual(Object.keys(n).sort(), ['amount', 'decimals', 'delegated', 'image', 'mint', 'name', 'symbol', 'tokenAccount', 'tokenProgram', 'usd'])
  assert.equal(n.name, 'Named Coin'); assert.equal(n.symbol, 'NAMED'); assert.equal(n.usd, 12.5); assert.equal(n.image, `/api/site/coinimg/${c.named}`, 'pictures go through our proxy')
  assert.equal(n.tokenAccount, ata(c.named, c.owner, TOKEN)); assert.equal(n.tokenProgram, TOKEN); assert.equal(n.amount, '5000000'); assert.equal(n.delegated, false)
  // A coin with no metadata still shows, with null names and no picture
  assert.equal(p.name, null); assert.equal(p.symbol, null); assert.equal(p.image, null); assert.equal(p.amount, '1000000000000'); assert.equal(p.delegated, true); assert.equal(p.decimals, 6)
  assert.equal(t.tokenProgram, TOKEN_2022); assert.equal(t.decimals, 9, 'decimals read from the mint when DAS has none')
})

test('chain reads: one coin by mint, and a DAS failure still lists balances', async () => {
  const c = chain(), r = new ChainReads({ call: c.call })
  const one = await r.walletCoins(c.owner, c.plain)
  assert.equal(one.length, 1); assert.equal(one[0].mint, c.plain)
  assert.deepEqual(await r.walletCoins(c.owner, key()), [])
  const down = new ChainReads({ call: async (m, p) => { if (m.startsWith('getAsset')) throw new Error('das down'); return c.call(m, p) } })
  const coins = await down.walletCoins(c.owner)
  assert.equal(coins.length, 3); assert.ok(coins.every((x) => x.name === null))
  assert.equal(down.stats.dasFailed, 1)
})

test('chain reads: cached 10 s per wallet and 60 s per coin, failures are not cached', async () => {
  let t = 1_000_000
  const c = chain(), r = new ChainReads({ call: c.call, now: () => t })
  await r.walletCoins(c.owner); const n = c.calls.length
  await r.walletCoins(c.owner); assert.equal(c.calls.length, n, 'second read inside 10 s is free')
  t += 10_001; await r.walletCoins(c.owner); assert.ok(c.calls.length > n, 'read again after 10 s')

  let calls = 0, fail = true
  const mint = key(), holderAcc = key(), holderOwner = key()
  const h = new ChainReads({ now: () => t, call: async (m, p) => {
    calls++
    if (fail) throw new Error('boom')
    if (m === 'getTokenLargestAccounts') return { value: [{ address: holderAcc, amount: '500' }, { address: key(), amount: '0' }] }
    if (m === 'getMultipleAccounts') { assert.deepEqual(p[0], [holderAcc]); return { value: [{ owner: TOKEN, data: [new PublicKey(holderOwner).toBuffer().toString('base64'), 'base64'] }] } }
  } })
  await assert.rejects(h.holders(mint)); fail = false
  assert.deepEqual(await h.holders(mint), [{ account: holderAcc, owner: holderOwner, amount: '500' }], 'a failure was not cached; zero balances dropped')
  const before = calls
  t += 59_000; await h.holders(mint); assert.equal(calls, before, 'inside 60 s is cached')
  t += 2_000; await h.holders(mint); assert.equal(calls, before + 2)
})

test('chain reads: waits for the shared read budget, then fails', async () => {
  let t = 0, tokens = 0
  const r = new ChainReads({ call: async () => ({ value: [] }), take: () => tokens-- > 0, now: () => t, sleep: async (ms) => { t += ms }, waitMs: 1000 })
  await assert.rejects(r.holders(key()), /budget/)
  tokens = 5
  assert.deepEqual(await r.holders(key()), [])
})

test('chain reads: sorting and DAS fields', () => {
  const s = sortCoins([{ mint: 'a', amount: '100', decimals: 0, usd: null }, { mint: 'b', amount: '5', decimals: 0, usd: 1 }, { mint: 'c', amount: '2000', decimals: 3, usd: null }])
  assert.deepEqual(s.map((x) => x.mint), ['b', 'a', 'c'])
  assert.equal(dasMeta({ id: 'x' }), null, 'not fungible')
  assert.equal(dasMeta({ id: 'x', content: { metadata: { name: 'a‮b'.repeat(50) } }, token_info: {} }).name.length, 64)
})

test('chain routes: shape, bad address, rate limit, nothing about our RPC leaks', async () => {
  const w = world(), c = chain()
  w.app.chainReads.rpcCall = c.call
  const server = await listen(w.app.handler, 0), base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await fetch(`${base}/api/chain/coins/${c.owner}`), j = await r.json()
    assert.equal(r.status, 200); assert.equal(j.items.length, 3); assert.equal(j.items[0].mint, c.named)
    assert.equal((await (await fetch(`${base}/api/chain/coins/${c.owner}?mint=${c.t22}`)).json()).items[0].mint, c.t22)
    assert.equal((await fetch(`${base}/api/chain/coins/${c.owner}?mint=bad`)).status, 400)
    assert.equal((await fetch(`${base}/api/chain/coins/1111111111111111111111111111111O`)).status, 404, 'not base58: no route')
    assert.equal((await fetch(`${base}/api/chain/holders/${'1'.repeat(44)}`)).status, 400, 'base58 but not a key')
    w.app.chainReads.rpcCall = async () => { throw new Error('getTokenLargestAccounts: http 500 https://secret.example/?api-key=abc') }
    const down = await fetch(`${base}/api/chain/holders/${key()}`), dj = await down.text()
    assert.equal(down.status, 503); assert.doesNotMatch(dj, /secret|api-key/)
    // 60 a minute per visitor; the three good reads above count, refusals for bad input do not
    let last
    for (let i = 0; i < 57; i++) last = await fetch(`${base}/api/chain/coins/${c.owner}`)
    assert.equal(last.status, 200)
    assert.equal((await fetch(`${base}/api/chain/coins/${c.owner}`)).status, 429)
    w.clock.skew += 61_000; w.app.chainReads.rpcCall = c.call
    assert.equal((await fetch(`${base}/api/chain/coins/${c.owner}`)).status, 200)
  } finally { server.closeAllConnections(); await new Promise((ok) => server.close(ok)) }
})
