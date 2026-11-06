import test from 'node:test'
import assert from 'node:assert/strict'
import { world, Keypair, SystemProgram, SvmConn, SOL } from './harness.mjs'
import { Rpc, RpcError } from '../src/chain/rpc.mjs'
import { Sender } from '../src/chain/sender.mjs'
import { openDb } from '../src/db.mjs'

function kit() {
  const conn = new SvmConn(), db = openDb(':memory:'), clock = { t: 1_000_000 }, now = () => clock.t
  const rpc = new Rpc({ conn, maxRps: 1e6, now, sleep: async (ms) => { clock.t += ms } })
  const sender = new Sender({ db, rpc, now, heightCheckAfterMs: 45_000, rebroadcastMs: 4000 })
  const payer = conn.wallet(), dest = Keypair.generate().publicKey
  const build = async () => ({ payer, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1_000_000 })] })
  return { conn, db, clock, rpc, sender, payer, dest, build }
}
const landedCount = (k) => k.conn.bal(k.dest) / 1_000_000n

test('signature is on disk before the send', async () => {
  const k = kit(); let atSend = null
  const real = k.conn.sendRawTransaction.bind(k.conn)
  k.conn.sendRawTransaction = async (...a) => { atSend = k.db.get('SELECT * FROM tx_intents'); return real(...a) }
  const row = await k.sender.submit('a', 't', 'r', k.build)
  assert.ok(atSend, 'row exists when send is called'); assert.equal(atSend.sig, row.sig); assert.equal(atSend.status, 'signed')
  await k.sender.resolve(row); assert.equal(row.status, 'landed')
})
test('a send that throws but landed: one transfer, no new attempt', async () => {
  const k = kit()
  k.conn.inject('send', () => 'land-then-throw', 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(row.status, 'signed', 'unknown, so still open')
  const again = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(again.status, 'landed'); assert.equal(again.sig, row.sig)
  assert.equal(landedCount(k), 1n)
  assert.equal(k.db.get('SELECT COUNT(*) n FROM tx_intents').n, 1)
  await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(landedCount(k), 1n, 'landed stays landed')
})
test('a send lost in the network: same bytes rebroadcast, never a second signature, until the blockhash proves it dead', async () => {
  const k = kit()
  k.conn.inject('send', () => 'drop', 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(landedCount(k), 0n)
  // Before the rebroadcast time: nothing
  await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(k.conn.counts.send, 1)
  k.clock.t += 5000
  await k.sender.resolve(row)
  assert.equal(k.conn.counts.send, 2)
  assert.equal(landedCount(k), 1n)
  await k.sender.resolve(row); assert.equal(row.status, 'landed')
  assert.equal(k.db.get('SELECT COUNT(DISTINCT sig) n FROM tx_intents').n, 1)
})
test('dropped only after a finalized height past the last valid height, then one new attempt', async () => {
  const k = kit()
  k.conn.inject('send', () => 'drop')
  const row = await k.sender.submit('a', 't', 'r', k.build)
  k.clock.t += 46_000
  await k.sender.resolve(row)
  assert.equal(row.status, 'signed', 'height not past yet')
  k.conn.height = row.lvbh // exactly at the limit is still alive
  await k.sender.resolve(row)
  assert.equal(row.status, 'signed')
  k.conn.height = row.lvbh + 1
  await k.sender.resolve(row)
  assert.equal(row.status, 'dropped')
  k.conn.clear('send')
  k.conn.svm.expireBlockhash()
  const next = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(next.attempt, 2); assert.notEqual(next.sig, row.sig)
  await k.sender.resolve(next); assert.equal(next.status, 'landed'); assert.equal(landedCount(k), 1n)
})
test('height read failing does not count as expired; status read failing does not count as anything', async () => {
  const k = kit()
  k.conn.inject('send', () => 'drop')
  const row = await k.sender.submit('a', 't', 'r', k.build)
  k.clock.t += 46_000; k.conn.height = row.lvbh + 100
  k.conn.inject('height', () => { throw new Error('502') })
  await k.sender.resolve(row); assert.equal(row.status, 'signed')
  k.conn.clear('height')
  k.conn.inject('status', () => { throw new Error('502') })
  await k.sender.resolve(row); assert.equal(row.status, 'signed')
})
test('restart in the middle: a new Sender on the same database resolves the old signature', async () => {
  const k = kit()
  k.conn.inject('send', () => 'land-then-throw', 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  const fresh = new Sender({ db: k.db, rpc: k.rpc, now: () => k.clock.t })
  await fresh.resolveOpen()
  assert.equal(fresh.latest('a').status, 'landed'); assert.equal(fresh.latest('a').sig, row.sig)
  const after = await fresh.submit('a', 't', 'r', k.build)
  assert.equal(after.attempt, 1); assert.equal(landedCount(k), 1n)
})
test('restart with the send never made: same bytes go out', async () => {
  const k = kit()
  k.conn.inject('send', () => { throw new Error('connection refused') }, 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(landedCount(k), 0n)
  k.clock.t += 5000
  const fresh = new Sender({ db: k.db, rpc: k.rpc, now: () => k.clock.t, rebroadcastMs: 4000 })
  await fresh.resolveOpen()
  assert.equal(landedCount(k), 1n)
  await fresh.resolveOpen()
  assert.equal(fresh.latest('a').sig, row.sig); assert.equal(fresh.latest('a').status, 'landed')
})
test('preflight refusal is final for that attempt and needs no waiting', async () => {
  const k = kit()
  const bad = async () => ({ payer: k.payer, instructions: [SystemProgram.transfer({ fromPubkey: k.payer.publicKey, toPubkey: k.dest, lamports: Number(100n * SOL) })] })
  const row = await k.sender.submit('a', 't', 'r', bad)
  assert.equal(row.status, 'rejected'); assert.ok(row.err)
  const next = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(next.attempt, 2); assert.equal(next.status, 'signed')
})
test('a 429 on send is not a refusal: it may have reached the network', async () => {
  const k = kit()
  k.conn.inject('send', () => { throw new Error('429 Too Many Requests') }, 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  assert.equal(row.status, 'signed')
})
test('two at once for one key make one transaction', async () => {
  const k = kit()
  const [a, b] = await Promise.all([k.sender.submit('a', 't', 'r', k.build), k.sender.submit('a', 't', 'r', k.build)])
  assert.equal(a.sig, b.sig); assert.equal(k.conn.counts.send, 1)
})
test('rebroadcast off sends nothing', async () => {
  const k = kit()
  k.conn.inject('send', () => 'drop', 1)
  const row = await k.sender.submit('a', 't', 'r', k.build)
  k.clock.t += 5000
  await k.sender.resolveOpen({ rebroadcast: false })
  assert.equal(k.conn.counts.send, 1); assert.equal(row.status, 'signed')
})

test('RPC: 429 pauses everyone with growing backoff, then recovers; never looks like empty', async () => {
  const conn = new SvmConn(), clock = { t: 0 }, slept = []
  const rpc = new Rpc({ conn, maxRps: 1e6, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms } })
  const k = Keypair.generate().publicKey
  conn.inject('accounts', () => { throw new Error('429 Too Many Requests') }, 2)
  await assert.rejects(rpc.accounts([k]), (e) => e instanceof RpcError && e.rateLimited)
  await assert.rejects(rpc.accounts([k]), (e) => e.rateLimited)
  assert.equal(rpc.stats.rateLimited, 2)
  assert.ok(slept.reduce((a, b) => a + b, 0) >= 500, 'second call waited out the first backoff')
  assert.deepEqual(await rpc.accounts([k]), [null], 'a successful read says null only when the chain does')
})
test('RPC: batches at 100 accounts, one failed batch fails the whole read', async () => {
  const conn = new SvmConn(), rpc = new Rpc({ conn, maxRps: 1e6 })
  const keys = Array.from({ length: 250 }, () => Keypair.generate().publicKey)
  const r = await rpc.accounts(keys)
  assert.equal(r.length, 250); assert.equal(rpc.stats.calls.getMultipleAccountsInfo, 3); assert.equal(rpc.stats.accountsRead, 250)
  let n = 0
  conn.inject('accounts', () => { if (++n === 2) throw new Error('500') })
  await assert.rejects(rpc.accounts(keys), RpcError)
  conn.getMultipleAccountsInfo = async () => [null]
  await assert.rejects(rpc.accounts(keys.slice(0, 5)), /short answer/, 'a short answer is a failure')
})
test('RPC: the bucket holds the rate', async () => {
  const conn = new SvmConn(), clock = { t: 0 }
  const rpc = new Rpc({ conn, maxRps: 5, now: () => clock.t, sleep: async (ms) => { clock.t += ms } })
  for (let i = 0; i < 25; i++) await rpc.account(Keypair.generate().publicKey)
  assert.ok(clock.t >= 3900, `25 calls at 5 a second took ${clock.t} ms`)
})
