// Against a real solana-test-validator on localhost, with real JSON-RPC and fresh throwaway keys. X stays mocked. No mainnet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import { LISTING_KEY, MockX, SO, PROGRAM_ID } from '../harness.mjs'
import { loadConfig } from '../../src/config.mjs'
import { buildApp } from '../../src/app.mjs'
import { openDb } from '../../src/db.mjs'
import { tagListingId, programError } from '../../src/chain/program.mjs'

const BIN = process.env.SOLANA_TEST_VALIDATOR ?? join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator')
// E2E_PORT_BASE moves every port of this validator (default 18000)
const PB = Number(process.env.E2E_PORT_BASE ?? 18000), RPC = `http://127.0.0.1:${PB + 899}`
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

test('real validator: tag, card, bid, settle, accept, ghost, refund, rebuild', { skip: !existsSync(BIN) && 'no validator installed', timeout: 300_000 }, async (t) => {
  const busy = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }).then(() => true, () => false)
  assert.equal(busy, false, 'another validator already answers on this port: stop it first, its history would mix into this test')
  const ledger = mkdtempSync(join(tmpdir(), 'sidebid-ledger-'))
  const v = spawn(BIN, ['--ledger', ledger, '--rpc-port', String(PB + 899), '--faucet-port', String(PB + 950), '--gossip-port', String(PB), '--dynamic-port-range', `${PB + 1}-${PB + 30}`, '--bind-address', '127.0.0.1', '--quiet', '--reset', '--upgradeable-program', PROGRAM_ID.toBase58(), SO, 'none'], { stdio: 'ignore', env: { ...process.env, DYLD_LIBRARY_PATH: join(homedir(), '.local/libusb/lib') } })
  t.after(() => { v.kill('SIGKILL'); try { rmSync(ledger, { recursive: true, force: true }) } catch {} }) // the ledger is hundreds of MB
  const conn = new Connection(RPC, 'confirmed')
  let up = false
  for (let i = 0; i < 90 && !up; i++) { try { await conn.getLatestBlockhash(); up = true } catch { await sleep(1000) } }
  assert.ok(up, 'validator did not start')
  const fund = async (k, sol = 5) => { const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL); const b = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: sig, ...b }, 'confirmed') }
  const keeper = Keypair.generate(), pass = Keypair.generate()
  await fund(keeper); await fund(LISTING_KEY)
  const config = loadConfig({ PUBLIC_URL: 'https://sidebid.test', RPC_URL: RPC, RPC_MAX_RPS: '50', PROGRAM_ID: PROGRAM_ID.toBase58(), LISTING_SECRET: bs58.encode(LISTING_KEY.secretKey), KEEPER_SECRET: bs58.encode(keeper.secretKey), PASS_SECRET: bs58.encode(pass.secretKey), PASS_HASH_KEY: 'k'.repeat(40), X_READ_BEARER: 'b', X_ACCOUNT_ID: '424242', X_POST_API_KEY: 'a', X_POST_API_SECRET: 'b', X_POST_TOKEN: 'c', X_POST_TOKEN_SECRET: 'd', X_POLL_SECONDS: '15', TAG_MIN_SECONDS: '10', TAG_ACCEPT_WINDOW_SECONDS: '60', TRUSTED_HOPS: '0' })
  const x = new MockX(), db = openDb(':memory:')
  const app = buildApp({ config, db, fetchImpl: x.fetch, senderOpts: { rebroadcastMs: 2000, heightCheckAfterMs: 45_000 } })
  app.flags.set({ readerLive: true, tagListingLive: true, repliesLive: true, keeperLive: true })
  const mkSeller = async (xId, username, amount = 1_000_000_000n) => {
    const kp = Keypair.generate(); await fund(kp, 2)
    const mint = await spl.createMint(conn, kp, kp.publicKey, null, 6)
    const tokenAccount = await spl.createAssociatedTokenAccount(conn, kp, mint, kp.publicKey)
    await spl.mintTo(conn, kp, mint, tokenAccount, kp, amount)
    const createdAt = Date.now() - 400 * 86_400_000
    app.auth.upsertUser({ xId, handle: username, xCreatedAt: createdAt, followers: 100 })
    db.run('INSERT INTO wallet_links (x_id,wallet,linked_at) VALUES (?,?,?)', xId, kp.publicKey.toBase58(), Date.now()); db.run('INSERT INTO wallet_owners (wallet,x_id) VALUES (?,?)', kp.publicKey.toBase58(), xId)
    return { kp, mint, tokenAccount, author: { id: xId, username, createdAt, followers: 100 } }
  }
  const tagIt = async (s, id, text) => { x.addMention({ id, text, author: s.author, createdAt: Date.now() }); app.reader.lastPoll = 0; await app.reader.tick() }
  const until = async (fn, what, ms = 40_000) => { const end = Date.now() + ms; for (;;) { const r = await fn(); if (r) return r; if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(500) } }
  const read = async (k) => app.prog.decode(k, await conn.getAccountInfo(k, 'confirmed'))
  const sendBid = async (k, bidder, amount) => { const l = await read(k); await sendAndConfirmTransaction(conn, new Transaction().add(app.prog.ix.bid(l, bidder.publicKey, amount)), [bidder], { commitment: 'confirmed' }) }

  await app.reader.tick() // the first poll sets the start time: posts from before it are history
  await sleep(20)
  // ---- tagged card: real RPC read of the holding, real create
  const a = await mkSeller('11', 'alpha')
  await tagIt(a, '50001', `@sidebidsol all ${a.mint.toBase58()} 12s min 0.002`)
  await until(async () => { await app.reader.work(); const m = db.get(`SELECT state, reason FROM mentions WHERE tweet_id='50001'`); if (m.state === 'ignored') assert.fail(`ignored: ${m.reason}`); return m.state === 'live' }, 'card live')
  const cardA = app.prog.acceptPda(tagListingId('50001'))
  const onChain = await read(cardA)
  assert.deepEqual([onChain.mode, onChain.amount, onChain.price], ['accept', 1_000_000_000n, 2_000_000n])
  const rent = (await conn.getAccountInfo(cardA)).lamports
  console.log('rent for a tagged card on a real validator:', rent)
  await app.replies.tick()
  assert.equal(x.posts.length, 1)
  // ---- bid, indexer reads real logs through getSignaturesForAddress and getTransactions
  const bidder = Keypair.generate(); await fund(bidder, 2)
  await sendBid(cardA, bidder, 5_000_000n)
  await until(async () => { await app.indexer.tick(); return db.get(`SELECT top_bid FROM listings WHERE pubkey=?`, cardA.toBase58())?.top_bid === '5000000' }, 'indexer sees the bid')
  assert.ok(db.get(`SELECT 1 FROM events_seen WHERE name='BidPlaced'`), 'event parsed from real logs')
  // ---- a real preflight refusal, with the real error text, on a too early settle attempt
  const row = await app.sender.submit('early-refund', 'refund', 'x', async () => ({ payer: keeper, instructions: [app.prog.ix.refund(await read(cardA))] }))
  assert.equal(row.status, 'rejected')
  assert.match(row.err, programError('RefundNotAllowed'), 'real RPC error text is matched')
  // ---- the window opens: reply, then the seller accepts with the real instruction
  await until(async () => { const l = await read(cardA); const s = await conn.getBlockTime(await conn.getSlot()); return s >= l.endTime + 1 }, 'auction end', 40_000)
  await until(async () => { await app.replies.tick(); return x.posts.length === 2 }, 'accept reply')
  assert.match(x.posts[1].text, /0\.005 SOL/)
  const wt = await spl.createAssociatedTokenAccount(conn, bidder, a.mint, bidder.publicKey)
  await sendAndConfirmTransaction(conn, new Transaction().add(app.prog.ix.accept(await read(cardA), a.tokenAccount, wt)), [a.kp], { commitment: 'confirmed' })
  assert.equal((await spl.getAccount(conn, wt)).amount, 1_000_000_000n)
  await until(async () => { await app.indexer.tick(); return db.get(`SELECT kind FROM sales WHERE listing=?`, cardA.toBase58())?.kind === 'Accepted' }, 'sale indexed')
  // ---- site listing: keeper settles it as soon as the time comes, opens the winner's account
  const b = await mkSeller('12', 'beta')
  const lb = app.prog.listingPda(b.tokenAccount)
  const { createHash } = await import('node:crypto')
  const u64 = (v) => { const u = Buffer.alloc(8); u.writeBigUInt64LE(BigInt(v)); return u }
  const keys = [{ pubkey: b.kp.publicKey, isSigner: true, isWritable: true }, { pubkey: lb, isSigner: false, isWritable: true }, { pubkey: app.prog.vaultPda(lb), isSigner: false, isWritable: false }, { pubkey: b.tokenAccount, isSigner: false, isWritable: true }, { pubkey: b.mint, isSigner: false, isWritable: false }, { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }]
  const { TransactionInstruction } = await import('@solana/web3.js')
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([createHash('sha256').update('global:create_listing').digest().subarray(0, 8), Buffer.from([0]), u64(1_000_000n), u64(2_000_000n), u64(12), Buffer.from([0])]) })), [b.kp], { commitment: 'confirmed' })
  const b2 = Keypair.generate(); await fund(b2, 2)
  await sendBid(lb, b2, 3_000_000n)
  await until(async () => { await app.indexer.tick(); return db.get(`SELECT top_bid FROM listings WHERE pubkey=?`, lb.toBase58())?.top_bid === '3000000' }, 'indexer sees')
  const keeperLoop = setInterval(() => app.keeper.tick().catch(() => {}), 500)
  await until(async () => (await read(lb)) === null, 'keeper settled', 60_000)
  clearInterval(keeperLoop)
  await until(async () => { await app.sender.resolveOpen(); return !!db.get(`SELECT 1 FROM tx_intents WHERE kind='settle' AND status='landed'`) }, 'resolved landed')
  const attempts = db.all(`SELECT attempt, status FROM tx_intents WHERE kind='settle' ORDER BY attempt`)
  console.log('settle attempts:', JSON.stringify(attempts))
  assert.equal(attempts.filter((r) => r.status === 'landed').length, 1)
  assert.equal((await spl.getAccount(conn, spl.getAssociatedTokenAddressSync(b.mint, b2.publicKey))).amount, 1_000_000n)
  const started = (await read(lb)) === null
  assert.ok(started)
  // ---- a card nobody accepts: refund, Ghosted, close, rent home
  const c = await mkSeller('13', 'gamma')
  await tagIt(c, '50002', `@sidebidsol 1 ${c.mint.toBase58()} 10s`)
  await until(async () => { await app.reader.work(); return db.get(`SELECT state FROM mentions WHERE tweet_id='50002'`).state === 'live' }, 'second card')
  const cardC = app.prog.acceptPda(tagListingId('50002'))
  await sendBid(cardC, bidder, 2_000_000n)
  await until(async () => { await app.indexer.tick(); return db.get(`SELECT top_bid FROM listings WHERE pubkey=?`, cardC.toBase58())?.top_bid === '2000000' }, 'bid seen')
  const before = await conn.getBalance(bidder.publicKey)
  const loop2 = setInterval(() => { app.keeper.tick().catch(() => {}); app.indexer.tick().catch(() => {}) }, 1000)
  await until(async () => (await read(cardC)) === null, 'ghost refunded and closed', 110_000)
  clearInterval(loop2)
  assert.equal(await conn.getBalance(bidder.publicKey), before + 2_000_000)
  await until(async () => { await app.indexer.tick(); return db.get(`SELECT outcome FROM listings WHERE pubkey=?`, cardC.toBase58())?.outcome === 'ghosted' }, 'outcome')
  // ---- rebuild from nothing, from a real chain
  const snap = () => db.all('SELECT pubkey, outcome, closed FROM listings ORDER BY pubkey').map((r) => [r.pubkey, r.outcome, r.closed])
  const before2 = snap(), salesBefore = db.get('SELECT COUNT(*) n FROM sales').n
  await app.indexer.rebuild({ fresh: true })
  assert.deepEqual(snap(), before2)
  assert.equal(db.get('SELECT COUNT(*) n FROM sales').n, salesBefore)
  const r = await app.status()
  console.log('RPC calls for this whole run:', JSON.stringify(r.rpc))
  console.log('keeper balance left:', r.balances.keeper)
})
