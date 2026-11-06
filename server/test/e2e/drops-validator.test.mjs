// One dev drop cycle against a real solana-test-validator: real JSON-RPC, the real program, a pump.fun bonding curve
// account written into the genesis ledger for the price, and X mocked. Drop 1 gets a bid and the keeper settles it; drop 2
// gets none and is cancelled with its tokens left in the dev wallet. Fresh throwaway keys, no mainnet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import { MockX, SO, PROGRAM_ID } from '../harness.mjs'
import { loadConfig } from '../../src/config.mjs'
import { buildApp } from '../../src/app.mjs'
import { openDb } from '../../src/db.mjs'
import { PUMP_PROGRAM, bondingCurvePda, dropAmounts, minBidFor } from '../../src/drops.mjs'

const BIN = process.env.SOLANA_TEST_VALIDATOR ?? join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator')
const PB = Number(process.env.E2E_PORT_BASE ?? 18000), RPC = `http://127.0.0.1:${PB + 899}`
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const SUPPLY = 1_000_000_000n * 1_000_000n

test('real validator: a drop lists, posts, sells and settles; the next gets no bid and is skipped', { skip: !existsSync(BIN) && 'no validator installed', timeout: 240_000 }, async (t) => {
  const busy = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then(() => true, () => false)
  assert.equal(busy, false, 'another validator already answers on this port: stop it first')
  const ledger = mkdtempSync(join(tmpdir(), 'sidebid-drops-'))
  // The coin's pump.fun curve, before graduation: 60 virtual SOL over 536 million virtual tokens
  const mintKp = Keypair.generate(), curve = Buffer.alloc(81)
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve); curve.writeBigUInt64LE(536_000_000_000_000n, 8); curve.writeBigUInt64LE(60_000_000_000n, 16); curve.writeBigUInt64LE(SUPPLY, 40)
  const curveFile = join(ledger, 'curve.json')
  writeFileSync(curveFile, JSON.stringify({ pubkey: bondingCurvePda(mintKp.publicKey).toBase58(), account: { lamports: 2_000_000, data: [curve.toString('base64'), 'base64'], owner: PUMP_PROGRAM.toBase58(), executable: false, rentEpoch: 0, space: curve.length } }))
  const v = spawn(BIN, ['--ledger', join(ledger, 'l'), '--rpc-port', String(PB + 899), '--faucet-port', String(PB + 950), '--gossip-port', String(PB), '--dynamic-port-range', `${PB + 1}-${PB + 30}`, '--bind-address', '127.0.0.1', '--quiet', '--reset', '--upgradeable-program', PROGRAM_ID.toBase58(), SO, 'none', '--account', bondingCurvePda(mintKp.publicKey).toBase58(), curveFile], { stdio: 'ignore', env: { ...process.env, DYLD_LIBRARY_PATH: join(homedir(), '.local/libusb/lib') } })
  t.after(() => { v.kill('SIGKILL'); try { rmSync(ledger, { recursive: true, force: true }) } catch {} })
  const conn = new Connection(RPC, 'confirmed')
  let up = false
  for (let i = 0; i < 90 && !up; i++) { try { await conn.getLatestBlockhash(); up = true } catch { await sleep(1000) } }
  assert.ok(up, 'validator did not start')
  const fund = async (k, sol = 5) => { const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL); const b = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: sig, ...b }, 'confirmed') }
  const keeper = Keypair.generate(), dev = Keypair.generate(), bidder = Keypair.generate()
  await fund(keeper); await fund(dev); await fund(bidder, 20)
  // The coin: the dev holds 5% plus a little, everyone else the rest
  await spl.createMint(conn, dev, dev.publicKey, null, 6, mintKp)
  const ata = await spl.createAssociatedTokenAccount(conn, dev, mintKp.publicKey, dev.publicKey)
  await spl.mintTo(conn, dev, mintKp.publicKey, ata, dev, SUPPLY / 20n + 1_000n)
  const rest = await spl.createAssociatedTokenAccount(conn, dev, mintKp.publicKey, bidder.publicKey)
  await spl.mintTo(conn, dev, mintKp.publicKey, rest, dev, SUPPLY - SUPPLY / 20n - 1_000n)

  const config = loadConfig({ PUBLIC_URL: 'https://sidebid.test', RPC_URL: RPC, RPC_MAX_RPS: '50', PROGRAM_ID: PROGRAM_ID.toBase58(), KEEPER_SECRET: bs58.encode(keeper.secretKey), DEV_SECRET: bs58.encode(dev.secretKey), X_READ_BEARER: 'b', X_ACCOUNT_ID: '424242', X_POST_API_KEY: 'a', X_POST_API_SECRET: 'b', X_POST_TOKEN: 'c', X_POST_TOKEN_SECRET: 'd', X_DAILY_SPEND_CAP_USD: '2', TRUSTED_HOPS: '0', DROPS_EVERY_SECONDS: '30', DROPS_LENGTH_SECONDS: '12' })
  const x = new MockX(), db = openDb(':memory:')
  const app = buildApp({ config, db, fetchImpl: x.fetch, senderOpts: { rebroadcastMs: 2000 } })
  app.drops.feed.stableMs = 500
  app.flags.set({ keeperLive: true })
  const r0 = await app.drops.start({ firstAt: Date.now(), ca: mintKp.publicKey.toBase58() })
  assert.equal(r0.error, undefined, JSON.stringify(r0))
  const loop = setInterval(() => { app.drops.tick().catch(() => {}); app.indexer.tick().catch(() => {}); app.keeper.tick().catch(() => {}) }, 700)
  t.after(() => clearInterval(loop))
  const rows = () => db.all('SELECT * FROM drops ORDER BY idx')
  const until = async (fn, what, ms = 60_000) => { const end = Date.now() + ms; for (;;) { const r = await fn(); if (r) return r; if (Date.now() > end) assert.fail(`timed out: ${what} (${JSON.stringify(rows().slice(0, 2).map((r) => [r.state, r.reason]))})`); await sleep(400) } }
  const lk = app.prog.listingPda(ata)
  const amounts = dropAmounts(SUPPLY)

  await until(() => rows()[0].state === 'live', 'drop 1 live')
  const l = app.prog.decode(lk, await conn.getAccountInfo(lk, 'confirmed'))
  assert.equal(l.amount, amounts[0])
  assert.equal(l.price, minBidFor(amounts[0], { num: 60_000_000_000n, den: 536_000_000_000_000n }), 'floor from the real curve account')
  assert.equal(rows()[0].price_source, 'pump.fun bonding curve')
  await until(() => x.posts.some((p) => !p.reply), 'posted')
  const post = x.posts.find((p) => !p.reply)
  assert.match(post.text, /^Drop 1 of 12 is live: 922,378 \$SIDEBID, starting bid 0\.\d+ SOL, ends in 12 seconds\.$/)
  assert.equal(rows()[0].post_url, `https://x.com/sidebidsol/status/${post.id}`)
  // a bid at the floor, through the real program
  await sendAndConfirmTransaction(conn, new Transaction().add(app.prog.ix.bid(l, bidder.publicKey, l.price)), [bidder], { commitment: 'confirmed' })
  await until(() => rows()[0].state === 'sold', 'drop 1 settled and sold', 90_000)
  assert.equal(rows()[0].sold_lamports, l.price.toString())
  // drop 2: nobody bids, cancelled after the end, the tokens stay and the approval is gone
  const before = (await spl.getAccount(conn, ata)).amount
  await until(() => rows()[1].state === 'live', 'drop 2 live', 60_000)
  await until(() => rows()[1].state === 'skipped', 'drop 2 skipped', 90_000)
  assert.equal(rows()[1].reason, 'no_bids')
  const acct = await spl.getAccount(conn, ata)
  assert.equal(acct.amount, before)
  assert.equal(acct.delegate, null)
  assert.equal(await conn.getAccountInfo(lk), null)
  const st = app.drops.status()
  console.log('drops status:', JSON.stringify(st.totals))
  assert.equal(st.totals.sold, 1); assert.equal(st.totals.skipped, 1)
  clearInterval(loop)
})
