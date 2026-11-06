// Wires the parts together. Loops never overlap with themselves, and a part with no credentials simply stays idle.
import { join } from 'node:path'
import { openDb } from './db.mjs'
import { Flags } from './flags.mjs'
import { connect, Rpc } from './chain/rpc.mjs'
import { program } from './chain/program.mjs'
import { Sender } from './chain/sender.mjs'
import { Auth } from './auth.mjs'
import { PrivyVerifier } from './privy.mjs'
import { XClient } from './x/client.mjs'
import { Replies } from './x/replies.mjs'
import { Reader } from './x/reader.mjs'
import { Indexer } from './indexer.mjs'
import { Listings } from './listings.mjs'
import { Keeper } from './keeper.mjs'
import { PassSigner } from './pass.mjs'
import { createApp } from './http.mjs'
import { Rewards } from './rewards/rewards.mjs'
import { Drops } from './drops.mjs'
import { listingCard } from './share.mjs'
import { ChainReads, jsonRpc } from './chainread.mjs'

// A data folder made before the rename keeps its old file name
const dbPath = (dir) => join(dir, 'sidebid.db')

export function buildApp({ config, db = null, conn = null, fetchImpl, privyFetch, now = Date.now, log = () => {}, senderOpts = {}, sleep, dropsOpts = {}, chainCall = null }) {
  db ??= openDb(dbPath(config.dataDir))
  const flags = new Flags(db)
  const prog = program(config.programId)
  const rpc = new Rpc({ conn: conn ?? connect(config.rpcUrl), maxRps: config.rpcMaxRps, now, ...(sleep ? { sleep } : {}) })
  const sender = new Sender({ db, rpc, now, log, ...senderOpts })
  const x = new XClient({ config, db, fetchImpl, now })
  // Privy's keys come over plain fetch, never through the X client: a Privy sign in costs no X call
  const privy = config.privy?.appId ? new PrivyVerifier({ appId: config.privy.appId, jwksUrl: config.privy.jwksUrl || null, now, ...(privyFetch ? { fetchImpl: privyFetch } : {}) }) : null
  const auth = new Auth({ db, config, spend: x.spend, privy, fetchImpl, now, log })
  const indexer = new Indexer({ db, rpc, config, prog, now, log })
  const replies = new Replies({ db, config, flags, x, rpc, prog, now, log })
  const reader = new Reader({ db, config, flags, x, rpc, auth, sender, prog, replies, indexer, now, log })
  const keeper = new Keeper({ db, rpc, sender, indexer, config, flags, prog, now, log })
  const pass = new PassSigner({ db, config, rpc, prog, auth, now })
  const listings = new Listings({ db, indexer, rpc, now })
  const rewards = new Rewards({ db, rpc, conn: rpc.conn, config, flags, now, log, senderOpts })
  const drops = new Drops({ db, config, flags, rpc, sender, prog, indexer, listings, x, card: listingCard, now, log, ...dropsOpts })
  const balance = async (k) => { if (!k) return null; try { return await rpc.balance(k.publicKey) } catch { return null } }
  const status = async () => ({ balances: { keeper: await balance(config.keeperKey), listing: await balance(config.listingKey), pass: await balance(config.passKey), dev: await balance(config.devKey) }, rpc: rpc.stats, indexer: indexer.status, keeper: keeper.status, reader: reader.status, xCreditsOutUntil: x.creditsOutUntil(), openIntents: sender.open().length, drops: drops.status().totals ?? null, dropsRunning: drops.status_, rewards: { ...rewards.status, ledger: Object.fromEntries(Object.entries(rewards.ledger()).map(([k, v]) => [k, String(v)])) }, openTagCards: db.get('SELECT COUNT(*) n FROM tag_cards WHERE closed_at IS NULL').n, queuedReplies: db.get(`SELECT COUNT(*) n FROM replies WHERE state IN ('pending','retry','unknown')`).n })
  // The wallet and holder reads the free browser RPC refuses, on our RPC and inside the public read budget
  const chainReads = new ChainReads({ call: chainCall ?? jsonRpc(config.rpcUrl), take: () => now() >= rpc.pauseUntil && rpc.takePublic(), now, ...(sleep ? { sleep } : {}) })
  const handler = createApp({ config, db, auth, flags, listings, pass, rewards, chainReads, spend: x.spend, status, now, log })
  const timers = []
  const loop = (ms, fn, name) => { let busy = false; const t = setInterval(() => { if (busy) return; busy = true; Promise.resolve().then(fn).catch((e) => log(`[${name}]`, e.message)).finally(() => { busy = false }) }, ms); t.unref?.(); timers.push(t) }
  return {
    db, flags, prog, rpc, sender, auth, privy, x, indexer, replies, reader, keeper, pass, listings, rewards, drops, chainReads, handler, status,
    /** Rebuild the cache from chain and resolve anything a restart caught mid-flight, before anything new is sent. */
    async start() {
      replies.recover(); drops.recover()
      await sender.resolveOpen().catch((e) => log('[start] intents', e.message))
      await indexer.rebuild().catch((e) => log('[start] rebuild', e.message))
    },
    run() {
      loop(config.indexer.tickMs, () => indexer.tick(), 'index')
      if (config.keeperKey) loop(config.keeper.tickMs, () => keeper.tick(), 'keeper')
      if (config.listingKey) loop(1000, () => reader.tick(), 'reader')
      loop(2000, () => replies.tick(), 'replies')
      if (config.devKey) loop(5000, () => rewards.tick(), 'rewards')
      if (config.devKey) loop(1000, () => drops.tick(), 'drops')
    },
    stop() { for (const t of timers) clearInterval(t) },
  }
}
