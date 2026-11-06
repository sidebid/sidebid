// Test kit: a Connection backed by LiteSVM running the real compiled program, with fault injection, plus a mock X.
// The fixture key is the contract's own test only listing key. It is throwaway and is never printed.
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm'
import { Keypair, PublicKey, Transaction, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import * as spl from '@solana/spl-token'
import bs58 from 'bs58'
import { loadConfig } from '../src/config.mjs'
import { buildApp } from '../src/app.mjs'
import { openDb } from '../src/db.mjs'
import { PUMP_PROGRAM, creatorVault } from '../src/rewards/claim.js'

const here = new URL('.', import.meta.url).pathname
// The test key build (feature test-listing-key) at the real program id, never the release .so: that one carries the real
// listing key, so the fixture key below could not list on it. Built on first use by program/scripts/build-test.sh.
export const SO = process.env.SIDEBID_SO ?? join(here, '../../program/target/test/sidebid.so')
if (!existsSync(SO)) execFileSync('sh', [join(here, '../../program/scripts/build-test.sh')], { stdio: 'inherit' })
export const PROGRAM_ID = new PublicKey('5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp')
export const LISTING_KEY = Keypair.fromSeed((await import('../../program/tests/fixtures/test-listing-key.mjs')).testListingSeed())
export const TOKEN = spl.TOKEN_PROGRAM_ID, T22 = spl.TOKEN_2022_PROGRAM_ID
export const SOL = 1_000_000_000n
export { spl, Keypair, PublicKey, SystemProgram, Transaction }

/** The network as the server sees it. faults.<method> = throwing function, or a queue; see `inject`. */
export class SvmConn {
  constructor() {
    this.svm = new LiteSVM()
    this.svm.addProgramFromFile(PROGRAM_ID.toBase58(), SO)
    this.warp(Math.floor(Date.now() / 1000) - this.now()) // the VM starts at time zero
    this.known = new Set(); this.txs = new Map(); this.order = []; this.faults = {}; this.counts = {}; this.height = 1000; this.landed = []
  }
  inject(method, fn, times = Infinity) { this.faults[method] = { fn, times } }
  clear(method) { delete this.faults[method] }
  hit(method) {
    this.counts[method] = (this.counts[method] ?? 0) + 1
    const f = this.faults[method]
    if (f && f.times > 0) { f.times--; const r = f.fn(); if (r === 'land-then-throw') return r; }
  }
  now() { return Number(this.svm.getClock().unixTimestamp) }
  warp(secs) { const c = this.svm.getClock(); this.svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(secs))) }
  info(pk) {
    const a = this.svm.getAccount(pk.toBase58())
    if (!a || !a.exists) return null
    if (a.lamports === 0n) return null
    return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.programAddress), rentEpoch: 0 }
  }
  async getMultipleAccountsInfo(keys) { this.hit('accounts'); return keys.map((k) => this.info(k)) }
  async getAccountInfo(k) { this.hit('accounts'); return this.info(k) }
  async getBalance(k) { this.hit('balance'); return Number(this.svm.getBalance(k.toBase58()) ?? 0n) }
  async getProgramAccounts(pid, opts) {
    this.hit('gpa')
    const out = []
    for (const s of this.known) { const pk = new PublicKey(s), i = this.info(pk); if (i && i.owner.equals(pid) && (!opts?.filters?.some((f) => f.dataSize && f.dataSize !== i.data.length))) out.push({ pubkey: pk, account: i }) }
    return out
  }
  async getTokenAccountsByOwner(owner, { mint }) {
    this.hit('tokens')
    const value = []
    for (const s of this.known) { const pk = new PublicKey(s), i = this.info(pk); if (i && (i.owner.equals(TOKEN) || i.owner.equals(T22)) && i.data.length >= 165 && new PublicKey(i.data.subarray(32, 64)).equals(owner) && new PublicKey(i.data.subarray(0, 32)).equals(mint)) value.push({ pubkey: pk, account: i }) }
    return { value }
  }
  async getSignaturesForAddress(addr, opts = {}) {
    this.hit('sigs')
    let list = [...this.order].reverse().filter((s) => this.txs.get(s).keys.includes(addr.toBase58()))
    if (opts.before) list = list.slice(list.indexOf(opts.before) + 1)
    if (opts.until) { const i = list.indexOf(opts.until); if (i >= 0) list = list.slice(0, i) }
    return list.slice(0, opts.limit ?? 1000).map((signature) => ({ signature, err: this.txs.get(signature).err ?? null, blockTime: this.txs.get(signature).blockTime }))
  }
  async getTransaction(sig) { this.hit('tx'); const t = this.txs.get(sig); return t ? { blockTime: t.blockTime, meta: { err: t.err ?? null, logMessages: t.logs, fee: t.meta?.fee ?? 5000, preBalances: t.meta?.preBalances ?? [], postBalances: t.meta?.postBalances ?? [] }, transaction: { message: { accountKeys: t.accountKeys ?? [] } } } : null }
  // What web3's sendAndConfirmTransaction calls
  async sendTransaction(tx, signers) { tx.recentBlockhash = this.svm.latestBlockhash(); tx.feePayer ??= signers[0].publicKey; tx.sign(...signers); return this.sendRawTransaction(tx.serialize()) }
  async confirmTransaction(arg) { const sig = typeof arg === 'string' ? arg : arg.signature; const t = this.txs.get(sig); if (!t) throw new Error('confirmation timed out'); return { context: { slot: 1 }, value: { err: t.err ?? null } } }
  async getTransactions(sigs) { this.hit('txs'); return sigs.map((s) => { const t = this.txs.get(s); return t ? { blockTime: t.blockTime, meta: { err: t.err ?? null, logMessages: t.logs } } : null }) }
  async getLatestBlockhash() { this.hit('blockhash'); return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: this.height + 150 } }
  async getBlockHeight() { this.hit('height'); return this.height }
  async getSignatureStatuses(sigs) { this.hit('status'); return { value: sigs.map((s) => { const t = this.txs.get(s); return t ? { confirmationStatus: 'confirmed', err: t.err ?? null } : null }) } }
  /**
   * Test only stand in for the coin's creator fee program, which can't run offline: for its CollectCreatorFee instruction it
   * checks the creator signed and the vault is theirs, then moves the vault's lamports above rent to the creator and charges
   * the fee, recording balances before and after as a real transaction's meta does.
   */
  pumpClaim(tx, sig) {
    const msg = tx.compileMessage(), keys = msg.accountKeys.map((k) => k.toBase58())
    const ix = tx.instructions.find((i) => i.programId.equals(PUMP_PROGRAM))
    const creator = ix.keys[0].pubkey, vault = ix.keys[1].pubkey
    if (!tx.verifySignatures() || !tx.signatures.some((x) => x.publicKey.equals(creator))) throw new Error('Simulation failed. Message: missing creator signature')
    if (!vault.equals(creatorVault(creator)) || ix.data.toString('hex') !== '1416567bc61cdb84') throw new Error('Simulation failed. Message: custom program error: 0x7d6')
    if (this.faults.claimFails) { this.faults.claimFails = false; throw new Error('Simulation failed. Message: custom program error: 0x1') }
    const pre = keys.map((k) => Number(this.svm.getBalance(k) ?? 0n))
    const set = (k, lamports) => { const a = this.svm.getAccount(k); this.svm.setAccount({ address: k, lamports: BigInt(lamports), data: a?.exists ? a.data : new Uint8Array(0), programAddress: a?.exists ? a.programAddress : '11111111111111111111111111111111', executable: false, space: BigInt(a?.exists ? a.data.length : 0), rentEpoch: 0n }) }
    const rent = 890_880, vb = Number(this.svm.getBalance(vault.toBase58()) ?? 0n), moved = Math.max(0, vb - rent)
    const fee = 5000 + Math.ceil(60_000 * 50_000 / 1e6)
    set(vault.toBase58(), vb - moved)
    set(creator.toBase58(), Number(this.svm.getBalance(creator.toBase58())) + moved - fee)
    const post = keys.map((k) => Number(this.svm.getBalance(k) ?? 0n))
    this.txs.set(sig, { keys, logs: [], err: null, blockTime: this.now(), meta: { fee, preBalances: pre, postBalances: post }, accountKeys: msg.accountKeys })
    this.order.push(sig); this.claims = (this.claims ?? 0) + 1
    return sig
  }
  /** Applies a signed transaction to the VM. `sim` = refused like preflight when it would fail. */
  apply(raw, { sim = true } = {}) {
    const tx = Transaction.from(raw), sig = bs58.encode(tx.signature)
    if (tx.instructions.some((i) => i.programId.equals(PUMP_PROGRAM))) { if (this.txs.has(sig)) throw new Error('Simulation failed. Message: already processed'); return this.pumpClaim(tx, sig) }
    if (this.txs.has(sig)) { const e = new Error('Simulation failed. Message: Transaction simulation failed: This transaction has already been processed'); throw e }
    const kit = { messageBytes: tx.serializeMessage(), signatures: Object.fromEntries(tx.signatures.map((x) => [x.publicKey.toBase58(), x.signature])) }
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58())
    keys.forEach((k) => this.known.add(k))
    if (sim) {
      const s = this.svm.simulateTransaction(kit)
      if (s instanceof FailedTransactionMetadata) { const logs = s.meta().logs(); const e = new Error(`Simulation failed. Message: ${s.toString()}`); e.logs = logs; throw e }
    }
    const pre = keys.map((k) => Number(this.svm.getBalance(k) ?? 0n))
    const res = this.svm.sendTransaction(kit)
    // A transaction with an expired blockhash never lands on a real chain: it is not a failed transaction, it is nothing
    if (res instanceof FailedTransactionMetadata && /BlockhashNotFound/.test(res.toString())) throw new Error('Blockhash not found')
    this.svm.expireBlockhash()
    const failed = res instanceof FailedTransactionMetadata
    const logs = failed ? res.meta().logs() : res.logs()
    const post = keys.map((k) => Number(this.svm.getBalance(k) ?? 0n))
    this.txs.set(sig, { keys, logs, err: failed ? { InstructionError: [0, res.toString()] } : null, blockTime: this.now(), meta: { fee: pre[0] - post[0], preBalances: pre, postBalances: post }, accountKeys: tx.compileMessage().accountKeys, instructions: tx.instructions })
    this.order.push(sig)
    return sig
  }
  async sendRawTransaction(raw, opts = {}) {
    this.counts.send = (this.counts.send ?? 0) + 1
    const f = this.faults.send
    if (f && f.times > 0) {
      f.times--
      const r = f.fn()
      if (r === 'land-then-throw') { this.apply(Buffer.from(raw), { sim: false }); throw new Error('fetch failed: socket hang up') }
      if (r === 'drop') return bs58.encode(Transaction.from(Buffer.from(raw)).signature) // accepted, then lost in the network
    }
    return this.apply(Buffer.from(raw), { sim: !opts.skipPreflight })
  }
  // ---- direct setup, with no server involved
  send(ixs, payer, signers = []) {
    const tx = new Transaction({ recentBlockhash: this.svm.latestBlockhash(), feePayer: payer.publicKey }).add(...[].concat(ixs))
    tx.sign(payer, ...signers)
    return this.apply(tx.serialize())
  }
  wallet(sol = 10n) { const k = Keypair.generate(); this.svm.airdrop(k.publicKey.toBase58(), sol * SOL); this.known.add(k.publicKey.toBase58()); return k }
  mint({ program = TOKEN, decimals = 6 } = {}) {
    const auth = (this.mintAuth ??= this.wallet()), k = Keypair.generate()
    this.send([SystemProgram.createAccount({ fromPubkey: auth.publicKey, newAccountPubkey: k.publicKey, lamports: Number(this.svm.minimumBalanceForRentExemption(BigInt(spl.MINT_SIZE))), space: spl.MINT_SIZE, programId: program }), spl.createInitializeMint2Instruction(k.publicKey, decimals, auth.publicKey, null, program)], auth, [k])
    return k.publicKey
  }
  ata(owner, mint, amount = 0n, program = TOKEN) {
    const a = spl.getAssociatedTokenAddressSync(mint, owner, true, program)
    if (!this.info(a)) this.send(spl.createAssociatedTokenAccountInstruction(this.mintAuth.publicKey, a, owner, mint, program), this.mintAuth)
    if (amount > 0n) this.send(spl.createMintToInstruction(mint, a, this.mintAuth.publicKey, amount, [], program), this.mintAuth)
    return a
  }
  bal(pk) { return BigInt(this.svm.getBalance(pk.toBase58()) ?? 0n) }
  tokenAmount(pk, program = TOKEN) { const i = this.info(pk); return i ? spl.unpackAccount(pk, i, program).amount : null }
}

/** As X does: every link comes back shortened. */
const tco = (t) => String(t).replace(/https?:\/\/\S+/g, () => `https://t.co/${randomBytes(5).toString('hex')}`)

/** Mock X: records calls. Set `mentions`, or `fail` to a status and body to refuse. */
export class MockX {
  constructor() { this.mentions = []; this.users = new Map(); this.posts = []; this.calls = []; this.fail = null; this.ownTweets = []; this.postBehaviour = null; this.nextId = 9000 }
  addMention({ id, text, author, createdAt }) { this.mentions.push({ id: String(id), text, author_id: author.id, created_at: new Date(createdAt).toISOString() }); this.users.set(author.id, { id: author.id, username: author.username, created_at: new Date(author.createdAt).toISOString(), public_metrics: { followers_count: author.followers }, profile_image_url: 'https://pbs.twimg.com/a/b_normal.jpg' }) }
  fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET'
    this.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body })
    const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (k) => headers[k] ?? null } })
    if (this.fail) { const f = this.fail; return res(f.status, f.body ?? {}, f.headers ?? {}) }
    if (u.pathname.endsWith('/mentions')) {
      const since = u.searchParams.get('since_id')
      const list = this.mentions.filter((m) => !since || BigInt(m.id) > BigInt(since))
      return res(200, { data: list, includes: { users: [...this.users.values()] }, meta: {} })
    }
    if (u.pathname === '/2/media/upload' && method === 'POST') { this.media = (this.media ?? 0) + 1; if (this.mediaFail) return res(this.mediaFail, {}); return res(200, { data: { id: `77${this.media}`, media_key: `3_77${this.media}` } }) }
    if (/^\/2\/users\/\d+$/.test(u.pathname) && method === 'GET') return res(200, { data: { id: u.pathname.split('/').pop(), name: 'Sidebid', username: 'sidebidsol', profile_image_url: 'https://pbs.twimg.com/profile_images/1/sb_normal.png', verified: false, verified_type: 'blue' } })
    if (u.pathname === '/2/tweets' && method === 'POST' && !JSON.parse(init.body).reply) {
      const b = JSON.parse(init.body)
      if (this.postBehaviour) { const r = this.postBehaviour(b); if (r !== undefined) { if (r === 'timeout') throw new Error('timeout'); return r(res) } }
      if (this.posts.some((p) => !p.reply && p.text === b.text)) return res(403, { detail: 'You are not allowed to create a Tweet with duplicate content.' })
      const id = String(this.nextId++)
      this.posts.push({ ...b, id }); this.ownTweets.push({ id, text: tco(b.text) })
      return res(201, { data: { id, text: b.text } })
    }
    if (u.pathname === '/2/tweets' && method === 'POST') {
      const b = JSON.parse(init.body)
      if (this.postBehaviour) { const r = this.postBehaviour(b); if (r !== undefined) { if (r === 'landed-then-timeout') { const id = String(this.nextId++); this.posts.push({ ...b, id }); this.ownTweets.push({ id, text: tco(b.text), referenced_tweets: [{ type: 'replied_to', id: b.reply.in_reply_to_tweet_id }] }); throw new Error('timeout') } if (r === 'timeout') throw new Error('timeout'); return r(res) } }
      if (this.posts.some((p) => p.text === b.text && p.reply?.in_reply_to_tweet_id === b.reply.in_reply_to_tweet_id)) return res(403, { detail: 'You are not allowed to create a Tweet with duplicate content.' })
      const id = String(this.nextId++)
      this.posts.push({ ...b, id }); this.ownTweets.push({ id, text: tco(b.text), referenced_tweets: [{ type: 'replied_to', id: b.reply.in_reply_to_tweet_id }] })
      return res(201, { data: { id, text: b.text } })
    }
    if (/\/users\/\d+\/tweets$/.test(u.pathname)) return res(200, { data: this.ownTweets })
    return res(404, { title: 'mock has no such route' })
  }
}

export const OLD_ENOUGH = () => Date.now() - 400 * 86_400_000

/** A whole server on an in memory database, a VM, and a mock X. Keys are generated fresh per test. */
export function world(over = {}) {
  const conn = over.conn ?? new SvmConn()
  const keeper = over.keeperKey ?? Keypair.generate(), pass = Keypair.generate()
  conn.svm.airdrop(keeper.publicKey.toBase58(), 5n * SOL); conn.svm.airdrop(LISTING_KEY.publicKey.toBase58(), 5n * SOL)
  const env = {
    PUBLIC_URL: 'https://sidebid.test', RPC_URL: 'mock', ADMIN_SECRET: 'admin-test-secret-0123456789abcdef', PROGRAM_ID: PROGRAM_ID.toBase58(), RPC_MAX_RPS: '100000',
    LISTING_SECRET: bs58.encode(LISTING_KEY.secretKey), KEEPER_SECRET: bs58.encode(keeper.secretKey), PASS_SECRET: bs58.encode(pass.secretKey), PASS_HASH_KEY: 'k'.repeat(40),
    X_OAUTH_FALLBACK: '1', X_SIGNIN_CLIENT_ID: 'cid', X_SIGNIN_CLIENT_SECRET: 'csecret', X_READ_BEARER: 'bearer', X_ACCOUNT_ID: '424242', X_HANDLE: 'sidebidsol', X_POST_API_KEY: 'a', X_POST_API_SECRET: 'b', X_POST_TOKEN: 'c', X_POST_TOKEN_SECRET: 'd',
    X_POLL_SECONDS: '15', TAG_MIN_SECONDS: '10', TRUSTED_HOPS: '0', X_READ_HOURLY_USD: '25', X_SIGNIN_CAP_USD: '0.1', ...over.env,
  }
  const config = loadConfig(env)
  const x = over.x ?? new MockX()
  const db = over.db ?? openDb(':memory:')
  // Server clock follows the VM clock, in ms, plus anything a test adds
  const clock = over.clock ?? { skew: 0 }
  const now = () => conn.now() * 1000 + clock.skew
  const log = over.log ?? (() => {})
  const app = buildApp({ config, db, conn, fetchImpl: x.fetch, now, log, sleep: async (ms) => { clock.skew += ms }, senderOpts: { heightCheckAfterMs: 0, rebroadcastMs: 0, ...over.senderOpts } })
  return { conn, x, db, config, app, keeper, pass, clock, now, env }
}

/** A signed in, eligible X account with a linked wallet, and tokens. */
export function seller(w, { xId = '100', username = 'seller_one', mint, amount = 1_000_000_000n, program = TOKEN, ageDays = 400, followers = 500 } = {}) {
  const kp = w.conn.wallet()
  const m = mint ?? w.conn.mint({ program })
  const tokenAccount = w.conn.ata(kp.publicKey, m, amount, program)
  const createdAt = w.now() - ageDays * 86_400_000
  w.app.auth.upsertUser({ xId, handle: username, avatar: null, xCreatedAt: createdAt, followers })
  w.db.run('INSERT INTO wallet_links (x_id,wallet,linked_at) VALUES (?,?,?)', xId, kp.publicKey.toBase58(), w.now())
  w.db.run('INSERT INTO wallet_owners (wallet,x_id) VALUES (?,?)', kp.publicKey.toBase58(), xId)
  return { kp, mint: m, tokenAccount, xId, username, author: { id: xId, username, createdAt, followers } }
}
let tweetSeq = 1000n
export const tweetId = () => String(++tweetSeq)
export const tag = (w, s, text, id = tweetId()) => { w.x.addMention({ id, text, author: s.author, createdAt: w.now() }); return id }
/** Runs the reader's next poll, regardless of its timer. */
export async function readerStep(w) { w.app.reader.lastPoll = 0; await w.app.reader.tick() }
export const flagsOn = (w, ...names) => w.app.flags.set(Object.fromEntries(names.map((n) => [n, true])))
export const bid = (w, lPub, bidder, amount) => {
  const info = w.conn.info(lPub), l = decodeForTest(w, lPub, info)
  return w.conn.send(w.app.prog.ix.bid(l, bidder.publicKey, amount), bidder)
}
const decodeForTest = (w, k, info) => w.app.prog.decode(k, info)
export const chainListing = (w, k) => w.app.prog.decode(k, w.conn.info(k))
export const listingFixture = (w, { sellerKp, tokenAccount, mint, program = TOKEN, mode = 0, amount, price = 2_000_000n, duration = 300n, pass = null }) => {
  const prog = w.app.prog, listing = prog.listingPda(tokenAccount)
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
  const passBytes = pass ? Buffer.concat([Buffer.from([1]), pass.signer.toBuffer(), (pass.campaign ?? PublicKey.default).toBuffer()]) : Buffer.from([0])
  const disc = createHash('sha256').update('global:create_listing').digest().subarray(0, 8)
  const keys = [{ pubkey: sellerKp.publicKey, isSigner: true, isWritable: true }, { pubkey: listing, isSigner: false, isWritable: true }, { pubkey: prog.vaultPda(listing), isSigner: false, isWritable: false }, { pubkey: tokenAccount, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }]
  w.conn.send(new (Object.getPrototypeOf(prog.ix.claimCredit(sellerKp.publicKey, listing, listing)).constructor)({ programId: prog.programId, keys, data: Buffer.concat([disc, Buffer.from([mode]), u64(amount), u64(price), u64(duration), passBytes]) }), sellerKp)
  return listing
}
export const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'sidebid-')), 'test.db')
