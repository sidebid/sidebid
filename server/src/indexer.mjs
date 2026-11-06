// Chain is the truth, the database is a cache. Three jobs:
//   rebuild()  on start: every Listing account from getProgramAccounts, then every event since the saved cursor
//   tick()     new signatures for the program, their events, and a fresh read of each listing they touched
//   reconcile  on a timer: the same as rebuild, so anything missed heals. Also seller token accounts and credit balances
// A failed read changes nothing. Only a successful answer of "no account" marks a listing closed.
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { IDL, LISTING_SIZE, canFill, delegateIsOurs, parseEvents, readMint, readTokenAccount } from './chain/program.mjs'
import { CACHE_TABLES } from './db.mjs'

const LISTING_DISC = bs58.encode(Buffer.from(IDL.accounts.find((a) => a.name === 'Listing').discriminator))
const ZERO = '11111111111111111111111111111111'
const MISSING_TX_TRIES = 20
const TX_BATCH = 25
const OUTCOME = { Settled: 'sold', Accepted: 'sold', Bought: 'sold', Cancelled: 'cancelled' }

export class Indexer {
  constructor({ db, rpc, config, prog, now = Date.now, log = () => {} }) { Object.assign(this, { db, rpc, config, prog, now, log }); this.dirty = new Set(); this.missingTx = new Map(); this.lastReconcile = 0; this.status = { lastTick: null, lastError: null, rebuiltAt: null } }
  touch(pubkey) { this.dirty.add(String(pubkey)) }

  upsert(l) {
    this.db.run(`INSERT INTO listings (pubkey,seller,token_account,mint,token_program,amount,price,end_time,top_bidder,top_bid,pass_signer,campaign,mode,state,decimals,rent_payer,accept_window_secs,hard_end_time,closed,outcome,chain_read_at,first_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)
      ON CONFLICT(pubkey) DO UPDATE SET seller=excluded.seller,token_account=excluded.token_account,mint=excluded.mint,token_program=excluded.token_program,amount=excluded.amount,price=excluded.price,end_time=excluded.end_time,top_bidder=excluded.top_bidder,top_bid=excluded.top_bid,pass_signer=excluded.pass_signer,campaign=excluded.campaign,mode=excluded.mode,state=excluded.state,decimals=excluded.decimals,rent_payer=excluded.rent_payer,accept_window_secs=excluded.accept_window_secs,hard_end_time=excluded.hard_end_time,closed=0,keeper_next_at=CASE WHEN excluded.end_time<>listings.end_time OR excluded.top_bid<>listings.top_bid OR excluded.state<>listings.state THEN 0 ELSE listings.keeper_next_at END,chain_read_at=excluded.chain_read_at,
        outcome=CASE WHEN excluded.state='live' THEN NULL ELSE listings.outcome END`,
      l.pubkey.toBase58(), l.seller.toBase58(), l.tokenAccount.toBase58(), l.mint.toBase58(), l.tokenProgram.toBase58(), l.amount.toString(), l.price.toString(), l.endTime, l.topBidder.toBase58(), l.topBid.toString(), l.passSigner.toBase58(), l.campaign.toBase58(), l.mode, l.state, l.decimals, l.rentPayer.toBase58(), l.acceptWindowSecs, l.hardEndTime, this.now(), this.now())
    this.db.run('UPDATE tag_cards SET closed_at=NULL WHERE listing=? AND closed_at IS NOT NULL', l.pubkey.toBase58())
  }
  markClosed(pubkey) {
    this.db.run(`UPDATE listings SET closed=1, outcome=COALESCE(outcome, CASE WHEN state='gone' THEN 'gone' WHEN state='ghosted' THEN 'ghosted' ELSE 'closed' END), chain_read_at=? WHERE pubkey=? AND closed=0`, this.now(), pubkey)
    this.db.run(`UPDATE tag_cards SET closed_at=? WHERE listing=? AND closed_at IS NULL`, this.now(), pubkey)
  }

  /** Every Listing on chain. If the read fails nothing changes. */
  async reconcile() {
    const startedAt = this.now()
    const accounts = await this.rpc.programAccounts(this.prog.programId, [{ dataSize: LISTING_SIZE }, { memcmp: { offset: 0, bytes: LISTING_DISC } }])
    const seen = new Set(accounts.map((a) => a.pubkey.toBase58()))
    // A lagging node can answer short. Nothing goes closed on a list's say so: each missing one is asked about by address.
    const missing = this.db.all('SELECT pubkey FROM listings WHERE closed=0 AND chain_read_at<=?', startedAt).map((r) => r.pubkey).filter((p) => !seen.has(p))
    const answers = missing.length ? await this.rpc.accounts(missing.map((p) => new PublicKey(p))) : []
    seen.clear()
    this.db.tx(() => {
      for (const { pubkey, account } of accounts) {
        const l = this.prog.decode(pubkey, account)
        if (l) { this.upsert(l); seen.add(pubkey.toBase58()) }
      }
      // A card read fresher than this snapshot isn't missing: the snapshot is just older than it
      missing.forEach((p, i) => { const l = this.prog.decode(new PublicKey(p), answers[i]); if (l) this.upsert(l); else this.markClosed(p) })
    })
    this.lastReconcile = this.now()
    await this.refreshTokens().catch((e) => this.log('[index] tokens', e.message))
    await this.refreshCredits().catch((e) => this.log('[index] credits', e.message))
    await this.fillDecimals().catch((e) => this.log('[index] decimals', e.message))
    return accounts.length
  }

  /** On start. With fresh = true the cache is emptied first, which must always be safe. */
  async rebuild({ fresh = false } = {}) {
    if (fresh) this.db.tx(() => { for (const t of CACHE_TABLES) this.db.run(`DELETE FROM ${t}`); this.db.setMeta('index_cursor', null) })
    await this.catchUp()
    await this.reconcile()
    this.status.rebuiltAt = this.now()
  }

  /** New program transactions, oldest first. The cursor only moves past what was fully read. */
  async catchUp() {
    const until = this.db.meta('index_cursor') ?? undefined
    // A long backlog is walked over several ticks, and only processed whole, so the cursor can't jump past its oldest part
    // Stamped with when the walk began: anything confirmed while it ran is not in it, so the stamp can't claim it is
    if (!this.walk || this.walk.until !== until) this.walk = { until, sigs: [], before: undefined, startedAt: this.now() }
    const walk = this.walk
    let complete = false
    for (let page = 0; page < this.config.indexer.maxPages; page++) {
      const got = await this.rpc.signaturesFor(this.prog.programId, { limit: this.pageSize ?? 1000, until, before: walk.before })
      walk.sigs.push(...got)
      if (got.length < (this.pageSize ?? 1000)) { complete = true; break }
      walk.before = got.at(-1).signature
    }
    if (!complete) return 0
    this.walk = null
    const sigs = walk.sigs.reverse()
    const syncedAt = walk.startedAt
    let done = 0
    for (let i = 0; i < sigs.length; i += TX_BATCH) {
      const batch = sigs.slice(i, i + TX_BATCH)
      const txs = await this.rpc.transactions(batch.map((s) => s.signature))
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j], tx = txs[j]
        if (!tx) {
          // Usually just not visible yet. One that stays missing (pruned, or a bad provider) can't stop history for good.
          const n = (this.missingTx.get(s.signature) ?? 0) + 1
          this.missingTx.set(s.signature, n)
          if (n < MISSING_TX_TRIES) return done
          this.log('[index] skipping a transaction the RPC never returned', s.signature)
          this.status.skippedTxs = (this.status.skippedTxs ?? 0) + 1
          this.missingTx.delete(s.signature)
          this.db.setMeta('index_cursor', s.signature)
          this.needReconcile = true
          done++
          continue
        }
        this.db.tx(() => { if (!s.err && !tx.meta?.err) this.applyTx(s.signature, tx); this.db.setMeta('index_cursor', s.signature) })
        done++
      }
    }
    // Everything on chain up to the walk's start has been read: the rewards hour may close on it
    if (done === sigs.length) this.db.setMeta('index_synced_at', syncedAt)
    return done
  }

  applyTx(sig, tx) {
    const events = parseEvents(tx.meta?.logMessages, this.prog.programId), at = tx.blockTime ?? null
    // Solana cuts logs at 10 KB, which can hide an event. State still heals from accounts, so re-read every listing it touched.
    if (tx.meta?.logMessages?.some((l) => l.includes('Log truncated'))) {
      this.status.truncatedTxs = (this.status.truncatedTxs ?? 0) + 1
      const msg = tx.transaction?.message
      const keys = msg?.staticAccountKeys ?? msg?.accountKeys ?? []
      for (const k of keys) { const p = k.toBase58 ? k.toBase58() : String(k); if (this.db.get('SELECT 1 FROM listings WHERE pubkey=?', p)) this.touch(p) }
    }
    events.forEach((e, idx) => {
      this.db.run('INSERT OR IGNORE INTO events_seen (sig,idx,name,listing,data,at) VALUES (?,?,?,?,?,?)', sig, idx, e.name, e.listing, JSON.stringify(e), at)
      if (e.listing) this.touch(e.listing)
      if (e.name === 'Settled' || e.name === 'Accepted' || e.name === 'Bought') {
        const row = this.db.get('SELECT mint,decimals FROM listings WHERE pubkey=?', e.listing)
        // One row per sale event, keyed by its place in the transaction: several sales can share one signature
        this.db.run('INSERT OR IGNORE INTO sales (sig,idx,listing,kind,winner,seller,amount,price,mint,decimals,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', sig, idx, e.listing, e.name, e.winner ?? e.buyer, e.seller, e.amount, e.price, row?.mint ?? null, row?.decimals ?? null, at)
      }
      if (e.name === 'Listed') {
        // Closed cards have no account left, so history comes from here. The account read overwrites this for live ones.
        this.db.run(`INSERT INTO listings (pubkey,seller,mint,amount,price,end_time,top_bidder,top_bid,pass_signer,campaign,mode,state,closed,accept_window_secs,chain_read_at,first_seen_at) VALUES (?,?,?,?,?,?,?,'0',?,?,?,'live',1,0,0,?) ON CONFLICT(pubkey) DO UPDATE SET seller=excluded.seller,mint=excluded.mint,amount=excluded.amount,price=excluded.price,end_time=excluded.end_time,mode=excluded.mode,top_bid='0',outcome=NULL`, e.listing, e.seller, e.mint, e.amount, e.price, e.endTime, ZERO, ZERO, ZERO, e.mode, at)
      }
      if (e.name === 'BidPlaced') this.db.run('UPDATE listings SET top_bid=?, top_bidder=?, end_time=? WHERE pubkey=? AND closed=1', e.amount, e.bidder, e.endTime, e.listing)
      if (e.name === 'Settled' || e.name === 'Accepted' || e.name === 'Bought') this.db.run('UPDATE listings SET top_bid=?, top_bidder=? WHERE pubkey=? AND closed=1', e.price, e.winner ?? e.buyer, e.listing)
      if (OUTCOME[e.name]) this.db.run('UPDATE listings SET outcome=? WHERE pubkey=?', OUTCOME[e.name], e.listing)
      if (e.name === 'MarkedGone') this.db.run(`UPDATE listings SET outcome=CASE WHEN mode='accept' THEN 'ghosted' ELSE 'gone' END WHERE pubkey=?`, e.listing)
      if (e.name === 'CreditParked') this.db.run('INSERT INTO credits (listing,owner,lamports,checked_at) VALUES (?,?,?,?) ON CONFLICT(listing,owner) DO UPDATE SET lamports=excluded.lamports', e.listing, e.owner, e.amount, this.now())
    })
  }

  /** Fresh chain reads for these listings, in one batched call, and the cache updated. Returns decoded listings by key, or null for closed. */
  async readListings(pubkeys, rpc = this.rpc) {
    if (!pubkeys.length) return new Map()
    const keys = pubkeys.map((p) => new PublicKey(p))
    const infos = await rpc.accounts(keys)
    const out = new Map()
    this.db.tx(() => {
      keys.forEach((k, i) => {
        // A wrong owner counts the same as no account: nothing is stored for it, whatever its bytes say
        const l = this.prog.decode(k, infos[i])
        const p = k.toBase58()
        if (l) { this.upsert(l); out.set(p, l) } else { this.markClosed(p); out.set(p, null) }
      })
    })
    return out
  }

  noteToken(l, v) { this.db.run('UPDATE listings SET fillable=?, cpi_guard=?, delegate_set=?, token_checked_at=? WHERE pubkey=?', canFill(l, v) ? 1 : 0, v?.cpiGuard ? 1 : 0, delegateIsOurs(l, v) ? 1 : 0, this.now(), l.pubkey.toBase58()) }

  async refreshTokens() {
    const live = this.db.all(`SELECT pubkey FROM listings WHERE closed=0 AND state='live'`).map((r) => r.pubkey)
    const map = await this.readListings(live)
    const ls = [...map.values()].filter(Boolean)
    const infos = await this.rpc.accounts(ls.map((l) => l.tokenAccount))
    this.db.tx(() => ls.forEach((l, i) => {
      const v = readTokenAccount(infos[i], l.tokenProgram)
      this.noteToken(l, v)
    }))
  }

  /** One card's seller account, for a card page. Updates the same fields as the bulk read. */
  async refreshOne(pubkey, rpc = this.rpc) {
    const l = (await this.readListings([pubkey], rpc)).get(pubkey)
    if (!l) return
    this.noteToken(l, readTokenAccount(await rpc.account(l.tokenAccount), l.tokenProgram))
  }
  /** History rows rebuilt from events don't know decimals. Mints still exist, so ask them. */
  async fillDecimals() {
    const mints = this.db.all('SELECT DISTINCT mint FROM listings WHERE decimals IS NULL AND mint IS NOT NULL LIMIT 500').map((r) => r.mint)
    if (!mints.length) return
    const infos = await this.rpc.accounts(mints.map((m) => new PublicKey(m)))
    this.db.tx(() => mints.forEach((m, i) => { const d = readMint(infos[i]); if (d) { this.db.run('UPDATE listings SET decimals=? WHERE mint=? AND decimals IS NULL', d.decimals, m); this.db.run('UPDATE sales SET decimals=? WHERE mint=? AND decimals IS NULL', d.decimals, m) } }))
  }

  /** claim_credit emits no event, so the lamports themselves are the record. */
  async refreshCredits() {
    const rows = this.db.all(`SELECT * FROM credits WHERE lamports<>'0'`)
    if (!rows.length) return
    const infos = await this.rpc.accounts(rows.map((r) => this.prog.creditPda(new PublicKey(r.listing), new PublicKey(r.owner))))
    this.db.tx(() => rows.forEach((r, i) => this.db.run('UPDATE credits SET lamports=?, checked_at=? WHERE listing=? AND owner=?', String(infos[i]?.lamports ?? 0), this.now(), r.listing, r.owner)))
  }

  async tick() {
    try {
      await this.catchUp()
      const dirty = [...this.dirty]; this.dirty.clear()
      try { await this.readListings(dirty) } catch (e) { for (const d of dirty) this.dirty.add(d); throw e }
      if (this.needReconcile || this.now() - this.lastReconcile >= this.config.indexer.reconcileMs) { this.needReconcile = false; await this.reconcile() }
      else await this.refreshCredits()
      this.status.lastTick = this.now(); this.status.lastError = null
    } catch (e) { this.status.lastError = e.message; this.log('[index]', e.message) }
  }
}
