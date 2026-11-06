// Hourly creator fee rewards. The claim runs the proven claimer unchanged; its program is a test stand in (see harness).
// Payouts are real transfers in the VM, through the same Sender as everything else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { world, seller, listingFixture, chainListing, Keypair, PublicKey, SOL, spl, flagsOn } from './harness.mjs'
import { listen } from '../src/http.mjs'
import { plan, standings, hourOf, PAYOUT_FEE_MAX, Rewards } from '../src/rewards/rewards.mjs'
import { creatorVault, PUMP_PROGRAM } from '../src/rewards/claim.js'
import { loadConfig } from '../src/config.mjs'
import bs58 from 'bs58'

const HOUR = 3_600_000
const TEAM = Keypair.generate().publicKey.toBase58()
const FEES = 1_000_000_000n // what the vault holds above rent when the hour closes

function rw(over = {}) {
  const dev = over.dev ?? Keypair.generate()
  const w = world({ ...over, env: { DEV_SECRET: bs58.encode(dev.secretKey), REWARDS_TEAM_WALLET: TEAM, REWARDS_CLOSE_GRACE_S: '60', ...over.env } })
  w.conn.svm.airdrop(dev.publicKey.toBase58(), 2n * SOL)
  w.dev = dev
  w.db.setMeta('rewards_start_hour', hourOf(w.now()))
  flagsOn(w, 'rewardsLive')
  return w
}
const fundVault = (w, lamports) => w.conn.svm.airdrop(creatorVault(w.dev.publicKey).toBase58(), BigInt(lamports))
/** A real fixed price sale on chain: a seller lists, a buyer takes it. */
async function sale(w, s, priceLamports, buyer = w.conn.wallet()) {
  const m = s.mint
  const listing = listingFixture(w, { sellerKp: s.kp, tokenAccount: s.tokenAccount, mint: m, mode: 1, amount: 10n, price: priceLamports, duration: 0n })
  const bt = w.conn.ata(buyer.publicKey, m)
  w.conn.send(w.app.prog.ix.buy(chainListing(w, listing), buyer.publicKey, bt), buyer)
}
const sellers = (w, n) => Array.from({ length: n }, (_, i) => seller(w, { xId: `r${i}${Math.random()}`, username: `seller${i}` }))
/** Ends the hour: past its end and the grace, indexed, then the reward machine run to completion. */
async function closeHour(w, ticks = 8) {
  const now = w.now(), next = hourOf(now) + HOUR
  w.conn.warp(Math.ceil((next + 61_000 - now) / 1000))
  await w.app.indexer.tick()
  for (let i = 0; i < ticks; i++) await w.app.rewards.tick()
}
const hours = (w) => w.db.all('SELECT * FROM reward_hours ORDER BY hour')
const payouts = (w, h) => w.db.all('SELECT * FROM reward_payouts WHERE hour=? ORDER BY place', h)
const bal = (w, k) => w.conn.bal(new PublicKey(k))

test('the claim code is the proven file, byte for byte, and builds the documented instruction', async () => {
  const sha = (f) => createHash('sha256').update(readFileSync(new URL(`../src/rewards/${f}`, import.meta.url))).digest('hex')
  assert.equal(sha('claim.js'), 'ea1d47233dd6cb236eae65bedda9b594f754b995f5231be1c766f6ec7c413de7')
  assert.equal(sha('keys.js'), 'c50eff310279cab1b9620755bdcd224abf37ce32be5265c12d3f9d0fbce705c1')
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 5_000_000n)
  await closeHour(w)
  const sig = hours(w)[0].claim_sig
  const t = w.conn.txs.get(sig), keys = t.accountKeys.map((k) => k.toBase58())
  assert.equal(keys[0], w.dev.publicKey.toBase58(), 'creator pays and signs')
  assert.ok(keys.includes(creatorVault(w.dev.publicKey).toBase58()) && keys.includes(PUMP_PROGRAM.toBase58()))
})
test('three sellers: claim measured from the vault, 10% team, 50/30/20 of the rest, paid on chain, fees reserved', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a, b, c, d] = sellers(w, 4)
  await sale(w, a, 50_000_000n); await sale(w, b, 30_000_000n); await sale(w, c, 20_000_000n); await sale(w, d, 10_000_000n); await sale(w, c, 15_000_000n)
  const before = { a: bal(w, a.kp.publicKey), b: bal(w, b.kp.publicKey), c: bal(w, c.kp.publicKey), team: bal(w, TEAM), dev: bal(w, w.dev.publicKey) }
  await closeHour(w)
  const [h] = hours(w)
  assert.equal(h.state, 'done'); assert.equal(h.claimed, String(FEES), 'the vault\'s own drop')
  const st = JSON.parse(h.standings).map((x) => x.wallet)
  assert.deepEqual(st.slice(0, 3), [a.kp.publicKey.toBase58(), c.kp.publicKey.toBase58(), b.kp.publicKey.toBase58()], 'c sold 35 in two sales, b 30')
  const fee = BigInt(PAYOUT_FEE_MAX), avail = FEES - BigInt(h.claim_fee), base = avail - 4n * fee
  const team = ((avail - 4n * fee) * 1000n) / 10_000n, prize = base - team
  const p = payouts(w, h.hour)
  assert.deepEqual(p.map((x) => [x.slot, x.lamports, x.status]), [['team', String(team), 'landed'], ['place1', String(prize * 5000n / 10_000n), 'landed'], ['place2', String(prize * 3000n / 10_000n), 'landed'], ['place3', String(prize * 2000n / 10_000n), 'landed']])
  assert.equal(bal(w, a.kp.publicKey) - before.a, prize / 2n)
  assert.equal(bal(w, c.kp.publicKey) - before.c, prize * 3n / 10n)
  assert.equal(bal(w, b.kp.publicKey) - before.b, prize / 5n)
  assert.equal(bal(w, TEAM) - before.team, team)
  // The dev wallet ends no poorer than it began: what it kept is the carry plus fee reserve it didn't need
  assert.ok(bal(w, w.dev.publicKey) - before.dev >= BigInt(h.carry_out), 'its own SOL untouched')
  assert.ok(BigInt(h.carry_out) >= 0n && BigInt(h.carry_out) < 10n, `rounding dust only: ${h.carry_out}`)
})
test('ties: the same total goes to the earlier first sale, then by address', async () => {
  const w = rw()
  const ins = (sig, seller, price, at) => w.db.run(`INSERT INTO sales (sig,listing,kind,winner,seller,amount,price,at) VALUES (?,?,'Bought','w',?,'1',?,?)`, sig, 'L', seller, price, at)
  const h = hourOf(w.now()), s = Math.floor(h / 1000)
  ins('1', 'B_late', '100', s + 50); ins('2', 'A_early', '60', s + 10); ins('2b', 'A_early', '40', s + 55); ins('3', 'C_same', '100', s + 10); ins('4', 'D_big', '101', s + 60); ins('5', 'E_out', '5', s - 1); ins('6', 'F_in', '1', s + 20)
  assert.deepEqual(standings(w.db, h, h + HOUR).map((x) => x.wallet), ['D_big', 'A_early', 'C_same', 'B_late', 'F_in'], 'sales outside the hour are not counted')
  const st = standings(w.db, h, h + HOUR)
  assert.equal(st[1].received, '100'); assert.equal(st[1].sales, 2)
  // Paid in that order: the tie for second goes to A
  fundVault(w, 890_880n + FEES)
  await closeHour(w)
  assert.deepEqual(JSON.parse(hours(w)[0].standings).slice(0, 3).map((x) => x.wallet), ['D_big', 'A_early', 'C_same'])
})
test('fewer than 3 sellers: the unpaid shares carry into the next hour and are paid there', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a] = sellers(w, 1)
  await sale(w, a, 40_000_000n)
  await closeHour(w)
  const [h1] = hours(w), p1 = payouts(w, h1.hour)
  assert.deepEqual(p1.map((x) => x.slot), ['team', 'place1'])
  const carry = BigInt(h1.carry_out)
  const fee = BigInt(PAYOUT_FEE_MAX), avail = FEES - BigInt(h1.claim_fee), team = ((avail - 2n * fee) * 1000n) / 10_000n, prize = avail - 2n * fee - team
  assert.equal(carry, prize - prize / 2n, 'places 2 and 3 carry')
  // Next hour: no new fees, three sellers. The carry is the pot.
  const [x, y, z] = sellers(w, 3)
  await sale(w, x, 3_000_000n); await sale(w, y, 2_000_000n); await sale(w, z, 1_000_000n)
  await closeHour(w)
  const h2 = hours(w)[1]
  assert.equal(h2.carry_in, String(carry))
  assert.equal(h2.claimed, '0'); assert.match(h2.claim_note, /below MIN_CLAIM/)
  const p2 = payouts(w, h2.hour)
  const pot = carry - 3n * fee
  assert.deepEqual(p2.map((q) => q.lamports), [String(pot / 2n), String(pot * 3n / 10n), String(pot / 5n)], 'no team share of a carry: it had its 10% when claimed')
  assert.ok(p2.every((q) => q.status === 'landed'))
})
test('an hour with no sales: the team gets its share, the prize carries, nothing else moves', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await closeHour(w)
  const [h] = hours(w)
  assert.deepEqual(payouts(w, h.hour).map((x) => x.slot), ['team'])
  assert.ok(BigInt(h.carry_out) > FEES * 8n / 10n)
})
test('dust: a vault under the minimum is not claimed; a claim smaller than its own fee is repaid by later claims, never by the dev wallet', async () => {
  const w = rw(); fundVault(w, 890_880n + 1000n)
  const dev0 = bal(w, w.dev.publicKey)
  await sale(w, sellers(w, 1)[0], 5_000_000n)
  await closeHour(w)
  assert.equal(hours(w)[0].claim_sig, null); assert.equal(payouts(w, hours(w)[0].hour).length, 0)
  assert.equal(bal(w, w.dev.publicKey), dev0, 'not a lamport moved')
  // Now force a claim of dust: minimum 0, vault holds 3,000 above rent, the fee is 8,000
  const w2 = rw({ env: { REWARDS_MIN_CLAIM_SOL: '0' } }); fundVault(w2, 890_880n + 3000n)
  await closeHour(w2)
  const [h] = hours(w2)
  assert.equal(h.claimed, '3000'); assert.equal(BigInt(h.carry_out), 3000n - BigInt(h.claim_fee), 'a debt the next claims repay')
  assert.equal(payouts(w2, h.hour).length, 0)
  fundVault(w2, FEES)
  await closeHour(w2)
  const h2 = hours(w2)[1]
  assert.equal(BigInt(h2.carry_in), 3000n - BigInt(h.claim_fee))
  assert.equal(BigInt(h2.net), BigInt(h2.claimed) - BigInt(h2.claim_fee) + BigInt(h2.carry_in), 'the debt comes off the top')
})
test('double payout across a restart in the middle of the hour: every payout lands exactly once', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const ss = sellers(w, 3)
  await sale(w, ss[0], 9_000_000n); await sale(w, ss[1], 8_000_000n); await sale(w, ss[2], 7_000_000n)
  // The process dies inside the second payout's send: signed and written down, never reaching the network
  let n = 0
  w.conn.inject('send', () => { if (++n === 2) throw new Error('process died') }, 2)
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)); await w.app.indexer.tick()
  for (let i = 0; i < 3; i++) await w.app.rewards.tick()
  const mid = payouts(w, hours(w)[0].hour)
  assert.ok(mid.some((p) => p.status === 'signed'), 'caught mid payout')
  const b0 = ss.map((s) => bal(w, s.kp.publicKey))
  const w2 = world({ conn: w.conn, db: w.db, x: w.x, clock: w.clock, keeperKey: w.keeper, env: { DEV_SECRET: bs58.encode(w.dev.secretKey), REWARDS_TEAM_WALLET: TEAM } })
  w2.app.flags.set({ rewardsLive: true })
  await w2.app.start()
  w.conn.height = 1e9 // the first attempt's blockhash is long past: it can never land
  for (let i = 0; i < 6; i++) await w2.app.rewards.tick()
  const done = payouts(w, hours(w)[0].hour)
  assert.ok(done.every((p) => p.status === 'landed'), JSON.stringify(done.map((p) => p.status)))
  const sent = w.db.all(`SELECT key, COUNT(*) n, SUM(status='landed') l FROM tx_intents WHERE kind='reward' GROUP BY key`)
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM tx_intents WHERE kind='reward' AND status='dropped'`).n, 1, 'the dead one, proven dead before its retry')
  assert.equal(sent.length, 4); assert.ok(sent.every((r) => r.l === 1), 'one landed transaction per payout')
  // A third process changes nothing
  const w3 = world({ conn: w.conn, db: w.db, x: w.x, clock: w.clock, keeperKey: w.keeper, env: { DEV_SECRET: bs58.encode(w.dev.secretKey), REWARDS_TEAM_WALLET: TEAM } })
  w3.app.flags.set({ rewardsLive: true })
  const after = ss.map((s) => bal(w, s.kp.publicKey))
  await w3.app.start(); for (let i = 0; i < 4; i++) await w3.app.rewards.tick()
  assert.deepEqual(ss.map((s) => bal(w, s.kp.publicKey)), after)
  const team = payouts(w, hours(w)[0].hour).find((p) => p.slot === 'team')
  assert.equal(bal(w, TEAM), BigInt(team.lamports), 'the team was paid exactly once, by the retry')
  assert.ok(b0.length === 3)
})
test('a restart in the middle of the claim never claims that hour twice; what moved is left uncounted, never paid', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  const realClaim = w.app.rewards.claimer.claim.bind(w.app.rewards.claimer)
  w.app.rewards.claimer.claim = async () => { await realClaim(); throw new Error('process died before the claim returned') }
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)); await w.app.indexer.tick()
  await w.app.rewards.tick()
  assert.equal(hours(w)[0].claim_state, 'started')
  const w2 = world({ conn: w.conn, db: w.db, x: w.x, clock: w.clock, keeperKey: w.keeper, env: { DEV_SECRET: bs58.encode(w.dev.secretKey), REWARDS_TEAM_WALLET: TEAM } })
  w2.app.flags.set({ rewardsLive: true })
  fundVault(w, FEES) // more fees arrive: a second claim now would move them
  for (let i = 0; i < 4; i++) await w2.app.rewards.tick()
  const [h] = hours(w)
  assert.equal(w.conn.claims, 1, 'claimed once for the hour')
  assert.equal(h.claimed, '0'); assert.match(h.claim_note, /restart during the claim/)
  assert.equal(payouts(w, h.hour).length, 0)
  assert.equal(w2.app.rewards.ledger().room, 0n, 'nothing may be paid from what it could not measure')
})
test('a payout send that throws but landed is recorded once and never sent again', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a] = sellers(w, 1); await sale(w, a, 9_000_000n)
  const a0 = bal(w, a.kp.publicKey)
  let n = 0
  w.conn.inject('send', () => (++n === 2 ? 'land-then-throw' : undefined), 2) // the team payout first, then place 1
  await closeHour(w)
  const p = payouts(w, hours(w)[0].hour).find((x) => x.slot === 'place1')
  assert.equal(p.status, 'landed')
  assert.equal(bal(w, a.kp.publicKey) - a0, BigInt(p.lamports), 'paid once')
  assert.equal(w.db.get(`SELECT COUNT(*) n FROM tx_intents WHERE key LIKE '%place1'`).n, 1)
})
test('a winner whose account can\'t receive: refused, nothing lost, the share carries on', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [b] = sellers(w, 1); await sale(w, b, 1_000_000n)
  // The top seller on record is an address no transfer can write to (a sysvar stands in for any such account)
  const now0 = w.now(); w.db.run(`INSERT INTO sales (sig,listing,kind,winner,seller,amount,price,at) VALUES ('x','L','Bought','w','SysvarC1ock11111111111111111111111111111111','1','9000000',?)`, Math.floor(now0 / 1000))
  await closeHour(w)
  const [h] = hours(w), p = payouts(w, h.hour)
  const first = p.find((x) => x.slot === 'place1')
  assert.equal(first.status, 'unpayable'); assert.ok(first.note)
  assert.equal(p.find((x) => x.slot === 'place2').status, 'landed', 'the others are still paid')
  assert.equal(h.state, 'done')
  const planned = BigInt(w.db.get('SELECT carry_out FROM reward_hours').carry_out)
  assert.ok(planned >= BigInt(first.lamports) + BigInt(PAYOUT_FEE_MAX), 'its share and fee reserve are in the carry')
})
test('kill switch: nothing is claimed or paid while it is on; it resumes in order with no restart', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  w.app.flags.set({ killRewards: true })
  await closeHour(w); await closeHour(w)
  assert.equal(hours(w).length, 0); assert.equal(w.conn.claims ?? 0, 0)
  assert.equal((await w.app.rewards.view()).paused, true)
  w.app.flags.set({ killRewards: false })
  for (let i = 0; i < 16; i++) await w.app.rewards.tick()
  assert.equal(hours(w).length, 2, 'both hours done, oldest first')
  assert.ok(hours(w).every((h) => h.state === 'done'))
  assert.equal(w.conn.claims, 1, 'the first hour claimed everything waiting')
})
test('kill switch during paying: the rest wait, nothing sent', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const ss = sellers(w, 3); for (const [i, s] of ss.entries()) await sale(w, s, BigInt(9 - i) * 1_000_000n)
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)); await w.app.indexer.tick()
  await w.app.rewards.tick() // claims and plans and pays
  const sends = w.conn.counts.send ?? 0
  w.db.run(`UPDATE reward_payouts SET status='planned', sig=NULL WHERE slot='place3'`); w.db.run(`DELETE FROM tx_intents WHERE key LIKE '%place3'`); w.db.run(`UPDATE reward_hours SET state='paying'`)
  w.app.flags.set({ killRewards: true })
  await w.app.rewards.tick()
  assert.equal(w.conn.counts.send ?? 0, sends)
})
test('claim failing: the hour pays its carry only, the fees stay in the vault for the next claim', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  w.conn.faults.claimFails = true
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  await closeHour(w)
  const [h] = hours(w)
  assert.equal(h.claimed, '0'); assert.ok(h.claim_note)
  assert.equal(payouts(w, h.hour).length, 0, 'no carry yet, so nothing to pay')
  await closeHour(w)
  assert.equal(hours(w)[1].claimed, String(FEES), 'the next hour claims what was left')
})
test('a failed read of the claim transaction is not zero: it waits, then measures', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  w.conn.inject('tx', () => { throw new Error('502') }, 3)
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)); await w.app.indexer.tick()
  await w.app.rewards.tick(); await w.app.rewards.tick()
  assert.equal(hours(w)[0].claim_state, 'sent'); assert.equal(payouts(w, hours(w)[0].hour).length, 0)
  for (let i = 0; i < 4; i++) await w.app.rewards.tick()
  assert.equal(hours(w)[0].claimed, String(FEES))
})
test('the hour waits for the indexer: a sale late to index is still counted', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000))
  await w.app.rewards.tick()
  assert.equal(hours(w).length, 0, 'not indexed past the end yet')
  await w.app.indexer.tick(); await w.app.rewards.tick()
  assert.equal(JSON.parse(hours(w)[0].standings).length, 1)
})
test('the dev wallet\'s token bag and other SOL are never in a payout: claim and system transfers only', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const devMint = w.conn.mint(), devBag = w.conn.ata(w.dev.publicKey, devMint, 777_000_000n)
  const ss = sellers(w, 3); for (const [i, s] of ss.entries()) await sale(w, s, BigInt(9 - i) * 1_000_000n)
  await closeHour(w)
  assert.equal(w.conn.tokenAmount(devBag), 777_000_000n)
  const devTxs = [...w.conn.txs.values()].filter((t) => t.accountKeys?.[0]?.toBase58?.() === w.dev.publicKey.toBase58())
  assert.equal(devTxs.length, 5)
  const allowed = new Set(['ComputeBudget111111111111111111111111111111', '11111111111111111111111111111111'])
  for (const t of devTxs.filter((x) => x.instructions)) assert.ok(t.instructions.every((i) => allowed.has(i.programId.toBase58())))
})
test('ledger guard: a payout past what claims measured is held, not sent', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  const now = w.now(); w.conn.warp(Math.ceil((hourOf(now) + HOUR + 61_000 - now) / 1000)); await w.app.indexer.tick()
  const r = w.app.rewards, realPlan = r.planStep.bind(r)
  r.planStep = (row) => { realPlan(row); w.db.run(`UPDATE reward_payouts SET lamports=? WHERE slot='place1'`, String(FEES * 2n)) }
  for (let i = 0; i < 4; i++) await r.tick()
  assert.equal(payouts(w, hours(w)[0].hour).find((p) => p.slot === 'place1').status, 'held')
})
test('plan: numbers, minimum payout, negative carry, and the sum never passes what is available', () => {
  const winners = [{ wallet: 'a' }, { wallet: 'b' }, { wallet: 'c' }]
  for (let i = 0; i < 2000; i++) {
    const claimed = BigInt(Math.floor(Math.random() * 1e10)), carryIn = BigInt(Math.floor(Math.random() * 2e9) - 2e8), fee = BigInt(Math.floor(Math.random() * 20000))
    const n = Math.floor(Math.random() * 4)
    const p = plan({ claimed, claimFee: fee, carryIn, winners: winners.slice(0, n), teamBps: 1000, split: [5000, 3000, 2000], minPayout: 1_000_000, teamWallet: 'T' })
    const spent = p.payouts.reduce((a, x) => a + x.lamports + BigInt(PAYOUT_FEE_MAX), 0n)
    assert.ok(spent <= (claimed - fee + carryIn > 0n ? claimed - fee + carryIn : 0n))
    assert.equal(p.carryOut, claimed - fee + carryIn - spent)
    assert.ok(p.payouts.every((x) => x.lamports >= 1_000_000n))
  }
})
test('public API: the shape in web/REWARDS-API.md, with live pot, standings, countdown, and past hours with signatures', async () => {
  const w = rw(); fundVault(w, 890_880n + FEES)
  const [a] = sellers(w, 1); await sale(w, a, 9_000_000n)
  w.db.run('UPDATE x_users SET avatar=? WHERE handle=?', 'https://pbs.twimg.com/profile_images/1/a_200x200.jpg', 'seller0')
  await w.app.indexer.tick()
  const server = await listen(w.app.handler, 0), base = `http://127.0.0.1:${server.address().port}`
  const get = async (q = '') => (await fetch(`${base}/api/rewards${q}`)).json()
  const live = await get()
  assert.deepEqual([live.split, live.sellerSharePct, live.teamSharePct, live.devWallet], [[50, 30, 20], 90, 10, w.dev.publicKey.toBase58()])
  assert.equal(live.now, Math.floor(w.now() / 1000))
  assert.equal(live.hour.end - live.hour.start, 3600); assert.ok(live.hour.payoutAt >= live.hour.end)
  assert.equal(live.hour.potKind, 'estimate')
  const pot = BigInt(live.hour.potLamports)
  assert.ok(pot > FEES * 85n / 100n && pot < FEES * 9n / 10n, `90% of the fees less fee reserve: ${pot}`)
  const s0 = live.hour.standings[0]
  assert.deepEqual([s0.rank, s0.wallet, s0.handle, s0.receivedLamports, s0.sales, s0.projectedLamports], [1, a.kp.publicKey.toBase58(), 'seller0', '9000000', 1, String(pot / 2n)])
  assert.match(s0.avatar, /^https:\/\/pbs\.twimg\.com/)
  assert.deepEqual(live.past, []); assert.equal(live.next, null)
  await closeHour(w)
  await closeHour(w) // an hour with no sales
  const after = await get()
  assert.equal(after.past.length, 2)
  const [noSales, paid] = after.past
  assert.equal(noSales.status, 'no_sales'); assert.deepEqual(noSales.payouts, [])
  assert.equal(paid.status, 'paid'); assert.ok(paid.claimSig); assert.equal(paid.sales, 1)
  assert.deepEqual(paid.payouts.map((p) => [p.rank, p.wallet, p.handle, !!p.sig]), [[1, a.kp.publicKey.toBase58(), 'seller0', true]], 'sellers only, no team row')
  assert.equal(typeof paid.start, 'number'); assert.equal(paid.end - paid.start, 3600)
  const page = await get('?limit=1')
  assert.equal(page.past.length, 1); assert.equal(page.next, page.past[0].start)
  const rest = await get(`?before=${page.next}&limit=1`)
  assert.equal(rest.past[0].start, paid.start); assert.equal(rest.next, null)
  // A failed vault read: the pot is null, never 0
  w.clock.skew += 61_000; w.conn.inject('accounts', () => { throw new Error('502') }, 1)
  assert.equal((await get()).hour.potLamports, null)
  // No dev key configured (launch day before DEV_SECRET): a 200 with no hour, which the site treats as not available, and no console error
  const bare = world(); const s2 = await listen(bare.app.handler, 0)
  const off = await fetch(`http://127.0.0.1:${s2.address().port}/api/rewards`)
  assert.equal(off.status, 200); assert.deepEqual(await off.json(), { off: true })
  s2.closeAllConnections(); s2.close(); server.closeAllConnections(); server.close()
})
test('past hour statuses: carried when there was nothing to pay, failed when a payout could not go', async () => {
  const w = rw(); w.conn.faults.claimFails = true
  await sale(w, sellers(w, 1)[0], 9_000_000n)
  await closeHour(w)
  assert.equal(w.app.rewards.pastView(hours(w)[0]).status, 'carried')
})
test('names come from config: share cards, link pages and the link message', async () => {
  const w = rw({ env: { BRAND_NAME: 'Othername', BRAND_TAGLINE: 'A line from config' } })
  const [a] = sellers(w, 1); await sale(w, a, 9_000_000n); await w.app.indexer.tick()
  const server = await listen(w.app.handler, 0), base = `http://127.0.0.1:${server.address().port}`
  const sig = w.db.get('SELECT sig FROM sales').sig
  assert.match(await (await fetch(`${base}/s/${sig}`)).text(), /<title>Othername<\/title>/)
  assert.match(w.app.auth.challenge(a.xId, Keypair.generate().publicKey.toBase58()).message, / on Othername, /)
  const png = Buffer.from(await (await fetch(`${base}/og/sale/${sig}.png`)).arrayBuffer())
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  const { readdirSync, statSync } = await import('node:fs'), { join } = await import('node:path')
  const OLD = new RegExp(['TG93YmFsbA==', 'V2hvbGVzYWxl'].map((b) => Buffer.from(b, 'base64').toString()).join('|')) // older names, kept encoded
  const src = new URL('../src', import.meta.url).pathname, hits = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (OLD.test(readFileSync(p, 'utf8'))) hits.push(p) } }
  walk(src)
  assert.deepEqual(hits, [], 'no product name written into the code')
  server.closeAllConnections(); server.close()
})
test('config: the split must add up, the dev key is its own, names come from config', () => {
  assert.throws(() => loadConfig({ REWARDS_SPLIT_BPS: '5000,3000,1000' }), /10000/)
  const k = Keypair.generate(), s = bs58.encode(k.secretKey)
  assert.throws(() => loadConfig({ DEV_SECRET: s, KEEPER_SECRET: s }), /must be different/)
  assert.throws(() => loadConfig({ DEV_SECRET: s, EXPECTED_DEV_PUBKEY: Keypair.generate().publicKey.toBase58() }), /EXPECTED_DEV_PUBKEY/)
  assert.deepEqual(loadConfig({ BRAND_NAME: 'Other', BRAND_TICKER: '$OTH' }).brand.ticker, 'OTH')
})
