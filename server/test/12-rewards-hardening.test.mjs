// One regression test per past finding in the rewards code, named after them.
import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { world, seller, listingFixture, chainListing, Keypair, PublicKey, SOL, flagsOn } from './harness.mjs'
import { plan, standings, hourOf, PAYOUT_FEE_MAX } from '../src/rewards/rewards.mjs'
import { creatorVault } from '../src/rewards/claim.js'
import { loadConfig } from '../src/config.mjs'
import { listen } from '../src/http.mjs'

const HOUR = 3_600_000, TEAM = Keypair.generate().publicKey.toBase58(), FEES = 1_000_000_000n
function rw(over = {}) {
  const dev = over.dev ?? Keypair.generate()
  const w = world({ ...over, env: { DEV_SECRET: bs58.encode(dev.secretKey), REWARDS_TEAM_WALLET: TEAM, REWARDS_CLOSE_GRACE_S: '60', ...over.env } })
  w.conn.svm.airdrop(dev.publicKey.toBase58(), 2n * SOL); w.dev = dev
  w.db.setMeta('rewards_start_hour', hourOf(w.now())); flagsOn(w, 'rewardsLive')
  return w
}
const fundVault = (w, l) => w.conn.svm.airdrop(creatorVault(w.dev.publicKey).toBase58(), BigInt(l))
const buyIx = (w, s, price, buyer) => {
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: s.mint, mode: 1, amount: 10n, price, duration: 0n })
  return w.app.prog.ix.buy(chainListing(w, listing), buyer.publicKey, w.conn.ata(buyer.publicKey, s.mint))
}
const sale = (w, s, price, buyer = w.conn.wallet()) => w.conn.send(buyIx(w, s, price, buyer), buyer)
const sellers = (w, n) => Array.from({ length: n }, (_, i) => seller(w, { xId: `q${i}${Math.random()}`, username: `seller${i}` }))
const toNextHour = (w) => { const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)) }
async function closeHour(w, ticks = 10) { toNextHour(w); await w.app.indexer.tick(); for (let i = 0; i < ticks; i++) await w.app.rewards.tick() }
const hours = (w) => w.db.all('SELECT * FROM reward_hours ORDER BY hour')
const payouts = (w, h) => w.db.all('SELECT * FROM reward_payouts WHERE hour=? ORDER BY place', h)
const bal = (w, k) => w.conn.bal(new PublicKey(k))

test('1: two sales in one transaction are both credited, and both sellers are paid', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a, b] = sellers(w, 2), buyer = w.conn.wallet(20n)
  const sig = w.conn.send([buyIx(w, a, 30_000_000n, buyer), buyIx(w, b, 40_000_000n, buyer)], buyer)
  await w.app.indexer.tick()
  assert.deepEqual(w.db.all('SELECT idx, seller FROM sales WHERE sig=? ORDER BY idx', sig).map((r) => r.seller), [a.kp.publicKey.toBase58(), b.kp.publicKey.toBase58()])
  const st = standings(w.db, hourOf(w.now()), hourOf(w.now()) + HOUR)
  assert.deepEqual(st.map((x) => x.wallet), [b.kp.publicKey.toBase58(), a.kp.publicKey.toBase58()])
  await w.app.indexer.rebuild({ fresh: true })
  assert.equal(w.db.get('SELECT COUNT(*) n FROM sales WHERE sig=?', sig).n, 2, 'a rebuild credits each once')
  const server = await listen(w.app.handler, 0)
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/s/${sig}`)).status, 200, 'the sale page still works by signature')
  server.closeAllConnections(); server.close()
  const b0 = bal(w, b.kp.publicKey)
  await closeHour(w)
  assert.ok(bal(w, b.kp.publicKey) > b0)
})
test('2: a transient refusal is retried and the rightful winner is paid; only a permanent one, or too many, moves the share on', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a] = sellers(w, 1); await sale(w, a, 9_000_000n)
  const a0 = bal(w, a.kp.publicKey)
  let n = 0
  w.conn.inject('send', () => { if (++n === 3) throw new Error('Simulation failed. Message: Blockhash not found') }, 3)
  await closeHour(w)
  const p = payouts(w, hours(w)[0].hour).find((x) => x.slot === 'place1')
  assert.deepEqual([p.status, p.refusals], ['landed', 1])
  assert.equal(bal(w, a.kp.publicKey) - a0, BigInt(p.lamports), 'paid to the seller who earned it')
  // A refusal that never ends: bounded, then the share carries
  const w2 = rw(); fundVault(w2, 890_880n + FEES)
  const [c] = sellers(w2, 1); await sale(w2, c, 9_000_000n)
  const realSend = w2.conn.sendRawTransaction.bind(w2.conn), target = c.kp.publicKey.toBase58()
  const { Transaction } = await import('@solana/web3.js')
  w2.conn.sendRawTransaction = async (raw, o) => { if (Transaction.from(raw).compileMessage().accountKeys.some((k) => k.toBase58() === target)) throw new Error('Simulation failed. Message: insufficient funds'); return realSend(raw, o) }
  await closeHour(w2, 12)
  const q = payouts(w2, hours(w2)[0].hour).find((x) => x.slot === 'place1')
  assert.deepEqual([q.status, q.refusals], ['unpayable', 6]); assert.equal(hours(w2)[0].state, 'done')
})
test('2: a refusal no retry can fix ends at once', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  w.db.run(`INSERT INTO sales (sig,listing,kind,winner,seller,amount,price,at) VALUES ('x','L','Bought','w','SysvarC1ock11111111111111111111111111111111','1','9000000',?)`, Math.floor(w.now() / 1000))
  await closeHour(w)
  const p = payouts(w, hours(w)[0].hour).find((x) => x.slot === 'place1')
  assert.equal(p.status, 'unpayable'); assert.ok(p.refusals <= 6, `ended after ${p.refusals}`)
})
test('3: the claim counts the smaller of the vault drop and what the dev wallet gained', async () => {
  const w = rw(), r = w.app.rewards
  const vault = r.vaultAddress().toBase58(), dev = w.dev.publicKey.toBase58(), other = Keypair.generate().publicKey.toBase58(), fee = 8000
  const put = (sig, devPost, otherPost) => w.conn.txs.set(sig, { keys: [], logs: [], err: null, blockTime: w.conn.now(), accountKeys: [dev, vault, other], meta: { fee, preBalances: [2_000_000_000, 1_000_890_880, 0], postBalances: [devPost, 890_880, otherPost] } })
  put('split', 2_000_000_000 + 200_000_000 - fee, 800_000_000)
  assert.equal((await r.measure('split')).delta, 200_000_000, 'a fee split: only what reached the dev wallet')
  put('whole', 2_000_000_000 + 1_000_000_000 - fee, 0)
  assert.equal((await r.measure('whole')).delta, 1_000_000_000, 'the normal claim: both agree')
  w.conn.txs.set('nodev', { keys: [], logs: [], err: null, accountKeys: [other, vault], meta: { fee, preBalances: [1, 5], postBalances: [5, 1] } })
  assert.equal((await r.measure('nodev')).delta, 0, 'a transaction without the dev wallet credits nothing')
})
test('4: a backlog walked over several ticks can\'t close an hour without the sales that landed meanwhile', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a, b] = sellers(w, 2)
  await sale(w, a, 5_000_000n); await w.app.indexer.tick()
  w.app.indexer.pageSize = 1; w.config.indexer.maxPages = 1
  for (let i = 0; i < 3; i++) await sale(w, a, 1_000_000n)
  await w.app.indexer.tick()
  assert.ok(w.app.indexer.walk)
  await sale(w, b, 50_000_000n) // lands while the walk is under way
  toNextHour(w)
  for (let i = 0; i < 30 && hours(w).length === 0; i++) { await w.app.indexer.tick(); await w.app.rewards.tick() }
  const st = JSON.parse(hours(w)[0].standings)
  assert.equal(st[0].wallet, b.kp.publicKey.toBase58(), 'b, the top seller, is in the frozen standings')
})
test('5: a crash between marking a payout signed and writing its transaction does not hold it', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const ss = sellers(w, 3); for (const [i, s] of ss.entries()) await sale(w, s, BigInt(9 - i) * 1_000_000n)
  toNextHour(w); await w.app.indexer.tick()
  const r = w.app.rewards, realSubmit = r.sender.submit.bind(r.sender)
  let died = false
  r.sender.submit = async (key, ...rest) => { if (key.endsWith(':place3') && !died) { died = true; throw new Error('process died') } return realSubmit(key, ...rest) }
  await r.tick()
  for (let i = 0; i < 4; i++) await r.tick()
  const p3 = payouts(w, hours(w)[0].hour).find((p) => p.slot === 'place3')
  assert.equal(p3.status, 'landed')
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM tx_intents WHERE key LIKE '%place3'`).n, 1)
})
test('6: the kill switch stops the next payout in the same tick', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const ss = sellers(w, 3); for (const [i, s] of ss.entries()) await sale(w, s, BigInt(9 - i) * 1_000_000n)
  let n = 0
  w.conn.inject('send', () => { if (++n === 2) w.app.flags.set({ killRewards: true }) }, 2)
  await closeHour(w, 1)
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM tx_intents WHERE kind='reward'`).n, 1, 'only the payout already being sent')
  assert.equal(w.conn.counts.send, 2)
  w.app.flags.set({ killRewards: false })
  for (let i = 0; i < 4; i++) await w.app.rewards.tick()
  assert.ok(payouts(w, hours(w)[0].hour).every((p) => p.status === 'landed'), 'and the rest go once it is lifted')
})
test('7: no team wallet means paused and no pot, not a live pot that never pays', async () => {
  const dev = Keypair.generate()
  const w = world({ env: { DEV_SECRET: bs58.encode(dev.secretKey) } }); w.dev = dev
  flagsOn(w, 'rewardsLive'); fundVault(w, 890_880n + FEES)
  const v = await w.app.rewards.view()
  assert.deepEqual([v.paused, v.hour.potLamports], [true, null])
})
test('8: the arithmetic the docs now describe', () => {
  const W = [{ wallet: 'a' }, { wallet: 'b' }, { wallet: 'c' }], fee = BigInt(PAYOUT_FEE_MAX)
  const q = plan({ claimed: 1_000_000_000n, claimFee: 8_000n, carryIn: 0n, winners: W, teamBps: 1000, split: [5000, 3000, 2000], minPayout: 1_000_000, teamWallet: 'T' })
  assert.equal(q.team, ((1_000_000_000n - 8_000n - 4n * fee) * 1000n) / 10_000n, 'team: 10% of the claim after its fee and every payout\'s fee reserve')
  const small = plan({ claimed: 9_000_000n, claimFee: 8_000n, carryIn: 0n, winners: [W[0]], teamBps: 1000, split: [5000, 3000, 2000], minPayout: 1_000_000, teamWallet: 'T' })
  assert.equal(small.team, 0n); assert.equal(small.payouts[0].lamports, (9_000_000n - 8_000n - 2n * fee) * 5000n / 10_000n, 'a team share under the minimum goes into the sellers\' prize')
})
test('9: a minimum payout under the rent exempt minimum refuses to start', () => {
  assert.throws(() => loadConfig({ REWARDS_MIN_PAYOUT_LAMPORTS: '100000' }), /890880/)
  assert.equal(loadConfig({ REWARDS_MIN_PAYOUT_LAMPORTS: '890880' }).rewards.minPayoutLamports, 890_880)
})
test('note: claim errors are redacted before they are logged or stored', async () => {
  const lines = []
  const w = rw({ log: (...a) => lines.push(a.join(' ')) }); fundVault(w, 890_880n + FEES)
  w.conn.faults.claimFails = true
  const real = w.conn.sendTransaction.bind(w.conn)
  w.conn.sendTransaction = async () => { throw new Error('request to https://rpc.example.com/?api-key=SECRET123 failed') }
  await closeHour(w)
  assert.ok(!lines.join(' ').includes('SECRET123')); assert.ok(!JSON.stringify(hours(w)).includes('SECRET123'))
  w.conn.sendTransaction = real
})
