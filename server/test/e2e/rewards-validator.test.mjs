// Rewards against a real solana-test-validator on localhost, throwaway keys, X mocked. The fee program can't run offline, so
// the claim is a real transfer out of a stand in vault, and the server measures it from the real transaction exactly as it
// would a real claim. Sales are real fixed price buys read by the real indexer. Payouts are real transfers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import { LISTING_KEY, MockX, SO, PROGRAM_ID } from '../harness.mjs'
import { loadConfig } from '../../src/config.mjs'
import { buildApp } from '../../src/app.mjs'
import { openDb } from '../../src/db.mjs'
import { hourOf } from '../../src/rewards/rewards.mjs'

const BIN = process.env.SOLANA_TEST_VALIDATOR ?? join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator')
// E2E_PORT_BASE moves every port of this validator (default 28000)
const PB = Number(process.env.E2E_PORT_BASE ?? 28000), PORT = PB + 899, RPC = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

test('real validator: real sales, a measured claim, payouts landed once across a restart', { skip: !existsSync(BIN) && 'no validator installed', timeout: 300_000 }, async (t) => {
  const busy = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then(() => true, () => false)
  assert.equal(busy, false, 'another validator already answers on this port: stop it first, its history would mix into this test')
  const ledger = mkdtempSync(join(tmpdir(), 'sidebid-rw-'))
  const v = spawn(BIN, ['--ledger', ledger, '--rpc-port', String(PORT), '--faucet-port', String(PB + 950), '--gossip-port', String(PB), '--dynamic-port-range', `${PB + 1}-${PB + 30}`, '--bind-address', '127.0.0.1', '--quiet', '--reset', '--upgradeable-program', PROGRAM_ID.toBase58(), SO, 'none'], { stdio: 'ignore', env: { ...process.env, DYLD_LIBRARY_PATH: join(homedir(), '.local/libusb/lib') } })
  t.after(() => { v.kill('SIGKILL'); try { rmSync(ledger, { recursive: true, force: true }) } catch {} }) // the ledger is hundreds of MB
  const conn = new Connection(RPC, 'confirmed')
  let up = false
  for (let i = 0; i < 90 && !up; i++) { try { await conn.getLatestBlockhash(); up = true } catch { await sleep(1000) } }
  assert.ok(up, 'validator did not start')
  const fund = async (k, sol = 3) => { const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL); const b = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: sig, ...b }, 'confirmed') }
  const dev = Keypair.generate(), vault = Keypair.generate(), team = Keypair.generate().publicKey, keeper = Keypair.generate(), pass = Keypair.generate()
  await fund(dev); await fund(vault, 5); await fund(keeper)
  const env = { PUBLIC_URL: 'https://sidebid.test', RPC_URL: RPC, RPC_MAX_RPS: '50', PROGRAM_ID: PROGRAM_ID.toBase58(), TRUSTED_HOPS: '0', LISTING_SECRET: bs58.encode(LISTING_KEY.secretKey), KEEPER_SECRET: bs58.encode(keeper.secretKey), PASS_SECRET: bs58.encode(pass.secretKey), PASS_HASH_KEY: 'k'.repeat(40), DEV_SECRET: bs58.encode(dev.secretKey), REWARDS_TEAM_WALLET: team.toBase58(), REWARDS_CLOSE_GRACE_S: '0' }
  const db = openDb(':memory:'), x = new MockX()
  // The server's clock runs an hour ahead once the sales are in, so the hour closes without waiting an hour
  const clock = { skew: 0 }, now = () => Date.now() + clock.skew
  const CLAIMED = 1_234_567_890
  const makeApp = (wrapConn) => {
    const app = buildApp({ config: loadConfig(env), db, conn: wrapConn ?? new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true }), fetchImpl: x.fetch, now, senderOpts: { rebroadcastMs: 2000, heightCheckAfterMs: 45_000 } })
    // Stand in for the fee claim: a real transfer from a keypair vault, the dev wallet paying the fee as a real claim does, measured by the server from the real transaction
    app.rewards.vaultAddress = () => vault.publicKey
    app.rewards.claimer = { claim: async () => ({ sig: await sendAndConfirmTransaction(conn, Object.assign(new Transaction({ feePayer: dev.publicKey }).add(SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: dev.publicKey, lamports: CLAIMED }))), [dev, vault], { commitment: 'confirmed' }) }) }
    app.flags.set({ rewardsLive: true })
    return app
  }
  let app = makeApp()
  db.setMeta('rewards_start_hour', hourOf(now()))
  // ---- three real sales: list at a fixed price, then a buyer takes it
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const disc = createHash('sha256').update('global:create_listing').digest().subarray(0, 8)
  const sellers = []
  for (const price of [30_000_000, 20_000_000, 10_000_000]) {
    const s = Keypair.generate(); await fund(s, 2)
    const mint = await spl.createMint(conn, s, s.publicKey, null, 6)
    const ta = await spl.createAssociatedTokenAccount(conn, s, mint, s.publicKey)
    await spl.mintTo(conn, s, mint, ta, s, 1000n)
    const listing = app.prog.listingPda(ta)
    const keys = [{ pubkey: s.publicKey, isSigner: true, isWritable: true }, { pubkey: listing, isSigner: false, isWritable: true }, { pubkey: app.prog.vaultPda(listing), isSigner: false, isWritable: false }, { pubkey: ta, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }]
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc, Buffer.from([1]), u64(1000), u64(price), u64(0), Buffer.from([0])]) })), [s], { commitment: 'confirmed' })
    const buyer = Keypair.generate(); await fund(buyer, 2)
    const bt = await spl.createAssociatedTokenAccount(conn, buyer, mint, buyer.publicKey)
    const l = app.prog.decode(listing, await conn.getAccountInfo(listing))
    await sendAndConfirmTransaction(conn, new Transaction().add(app.prog.ix.buy(l, buyer.publicKey, bt)), [buyer], { commitment: 'confirmed' })
    sellers.push(s)
  }
  await app.indexer.rebuild()
  assert.equal(db.get(`SELECT COUNT(*) n FROM sales WHERE kind='Bought'`).n, 3, 'real Bought events indexed')
  clock.skew = 3_600_000 + 5_000
  await app.indexer.tick()
  const before = await Promise.all([team, ...sellers.map((s) => s.publicKey)].map((k) => conn.getBalance(k)))
  const devBefore = await conn.getBalance(dev.publicKey)
  // ---- the process dies inside the second payout: its transaction reached the network, the answer never came back
  let sends = 0
  const flaky = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true })
  const real = flaky.sendRawTransaction.bind(flaky)
  flaky.sendRawTransaction = async (raw, o) => { const sig = await real(raw, o); if (++sends === 2) throw new Error('socket hang up'); return sig }
  app = makeApp(flaky)
  for (let i = 0; i < 4; i++) await app.rewards.tick()
  const hour = db.get('SELECT * FROM reward_hours')
  assert.equal(hour.claimed, String(CLAIMED), 'measured from the real transaction\'s balances')
  // ---- a new process on the same database finishes the hour
  app = makeApp()
  await app.start()
  for (let i = 0; i < 30 && db.get('SELECT state FROM reward_hours').state !== 'done'; i++) { await app.rewards.tick(); await sleep(1000) }
  const pays = db.all('SELECT * FROM reward_payouts ORDER BY place')
  assert.deepEqual(pays.map((p) => p.status), ['landed', 'landed', 'landed', 'landed'])
  assert.equal(db.get(`SELECT COUNT(*) n FROM tx_intents WHERE kind='reward'`).n, 4, 'one signature per payout, the one that threw included')
  const after = await Promise.all([team, ...sellers.map((s) => s.publicKey)].map((k) => conn.getBalance(k)))
  pays.forEach((p, i) => assert.equal(after[i] - before[i], Number(p.lamports), `${p.slot} paid exactly once`))
  // Over the claim and the payouts the dev wallet keeps exactly the carry plus the fee reserve it didn't need: never less
  const kept = (await conn.getBalance(dev.publicKey)) - devBefore, carry = Number(db.get('SELECT carry_out FROM reward_hours').carry_out)
  assert.ok(kept >= carry && carry >= 0, `kept ${kept}, carry ${carry}`)
  console.log('payouts:', JSON.stringify(pays.map((p) => [p.slot, p.lamports, p.sig.slice(0, 8)])))
  console.log('dev wallet kept', kept, 'lamports of the claim: carry', carry, 'plus unused fee reserve')
})
