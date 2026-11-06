// Calls settle, refund and close when they fall due. All three are permissionless on chain: this wallet only pays network
// fees (and, if a winner has none, a token account). It reads fresh from chain before each decision, signs before sending
// and writes the signature down through Sender. A failed read means do nothing this tick, never "the seller left".
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { getAccountLen, createInitializeAccount3Instruction } from '@solana/spl-token'
import { canFill, createAssociatedTokenAccountIdempotentInstruction, delegateIsOurs, getAssociatedTokenAddressSync, programError, readTokenAccount, SETTLE_GRACE_SECS } from './chain/program.mjs'

const ATA_RENT = 2_039_280
const ERR_NOT_YET = programError('AuctionNotEnded', 'RefundNotAllowed', 'CloseNotAllowed') // the chain clock runs behind the wall clock: try again soon
const ALL_DONE = new RegExp(`${programError('NotLive').source}|AccountNotInitialized|0xbc4`, 'i')
const WAITS_FOR_SELLER = programError('DelegateStillSet')
const NO_SOL = /insufficient (funds|lamports)|attempt to debit an account/i
const PER_TICK = 25, PER_SELLER = 3, POOL = 6
const SELLER_WAIT_MS = 600_000, MAX_BACKOFF_MS = 60_000

/** The whole rule, as a pure function of chain facts. `view` is the seller's stored token account, undefined if unread. */
export function decide(l, view, nowS) {
  const closeOrWait = () => {
    if (l.mode === 'accept') return 'close' // accept mode never sets a delegate, so a hand approval can't hold the rent
    if (view === undefined) return null
    return delegateIsOurs(l, view) ? 'wait_for_seller' : 'close' // the contract refuses until the seller cancels
  }
  if (l.state !== 'live') return closeOrWait() // Gone or Ghosted: rent goes back to whoever paid it
  if (l.mode === 'fixed') return l.endTime !== 0 && nowS >= l.endTime ? closeOrWait() : null
  if (nowS < l.endTime) return null
  if (l.topBid === 0n) return closeOrWait()
  if (l.mode === 'accept') {
    // The seller may accept from any account they own, so an empty stored account during the window isn't final.
    return nowS >= l.endTime + l.acceptWindowSecs ? 'refund' : null
  }
  if (view === undefined) return null
  if (canFill(l, view)) return nowS >= l.endTime + SETTLE_GRACE_SECS ? 'settle_or_refund' : 'settle'
  return 'refund'
}

export class Keeper {
  constructor({ db, rpc, sender, indexer, config, flags, prog, now = Date.now, log = () => {} }) {
    Object.assign(this, { db, rpc, sender, indexer, config, flags, prog, now, log })
    this.key = config.keeperKey; this.tries = new Map(); this.running = false
    this.status = { lastTick: null, lastError: null, submitted: 0, outOfSol: false, waitingForSeller: 0 }
  }
  genKey(action, l) { return `${action}:${l.pubkey.toBase58()}:${l.endTime}:${l.topBid}:${l.topBidder.toBase58()}` }
  /**
   * What to look at this tick. A short batch, so a tick stays quick and anything new is sorted in on the next one. Each seller
   * gets a few places first, so one wallet's many listings can't push out anyone else's. Then the biggest bid, so jumping a real
   * settle needs more SOL locked per listing than it holds. Then end time, oldest first. Rows waiting out a retry or a seller are left out in the query, so they never take a place.
   */
  due(nowS, limit = PER_TICK) {
    return this.db.all(`SELECT pubkey FROM (
        SELECT pubkey, end_time, top_bid, ROW_NUMBER() OVER (PARTITION BY seller ORDER BY end_time) AS turn FROM listings
        WHERE closed=0 AND keeper_next_at<=? AND ((end_time>0 AND end_time<=?) OR state<>'live')
      ) ORDER BY turn>?, CAST(top_bid AS INTEGER) DESC, end_time, pubkey LIMIT ?`, this.now(), nowS, PER_SELLER, limit).map((r) => r.pubkey)
  }
  defer(pubkey, ms) { this.db.run('UPDATE listings SET keeper_next_at=? WHERE pubkey=?', this.now() + ms, String(pubkey)) }
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10) }
  hasBudget(lamports) { return (this.db.get('SELECT lamports FROM keeper_spend WHERE day=?', this.dayKey())?.lamports ?? 0) + lamports <= this.config.keeper.tokenAccountDailyLamports }
  charge(lamports) { this.db.run('INSERT INTO keeper_spend (day,lamports) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET lamports=lamports+excluded.lamports', this.dayKey(), lamports) }

  /**
   * Closing a tagged card brings the server's own rent back, so it always runs. Closing a seller's listing is a courtesy that
   * costs a fee: capped per day, counted only when one goes out, or anyone could make this wallet clean up thousands of listings.
   */
  closeIsServers(l) { return !!this.config.listingKey && l.rentPayer.equals(this.config.listingKey.publicKey) }
  courtesyKey() { return `keeper_closes:${this.dayKey()}` }
  mayClose(l) { return this.closeIsServers(l) || Number(this.db.meta(this.courtesyKey()) ?? 0) < this.config.keeper.courtesyClosesPerDay }
  countClose(l) { if (!this.closeIsServers(l)) this.db.setMeta(this.courtesyKey(), Number(this.db.meta(this.courtesyKey()) ?? 0) + 1) }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      // Switched off: still reads how open transactions ended, but sends nothing, not even a rebroadcast.
      if (!this.flags.keeperOn) { await this.sender.resolveOpen({ rebroadcast: false }); return }
      await this.sender.resolveOpen()
      const nowS = Math.floor(this.now() / 1000)
      const pubkeys = this.due(nowS)
      if (!pubkeys.length) return
      const fresh = await this.indexer.readListings(pubkeys)
      const ls = [...fresh.values()].filter(Boolean)
      const needView = ls.filter((l) => l.mode !== 'accept')
      const infos = needView.length ? await this.rpc.accounts(needView.map((l) => l.tokenAccount)) : []
      const views = new Map(needView.map((l, i) => [l.pubkey.toBase58(), readTokenAccount(infos[i], l.tokenProgram)]))
      const jobs = []
      for (const l of ls) {
        const action = decide(l, views.has(l.pubkey.toBase58()) ? views.get(l.pubkey.toBase58()) : (l.mode === 'accept' ? null : undefined), nowS)
        if (!action) { if (l.mode === 'accept' && l.endTime <= nowS) this.defer(l.pubkey, (l.endTime + l.acceptWindowSecs - nowS) * 1000); continue } // nothing to do until the window ends
        if (action === 'wait_for_seller') { this.status.waitingForSeller++; this.defer(l.pubkey, SELLER_WAIT_MS); continue }
        if (action === 'close' && !this.mayClose(l)) { this.defer(l.pubkey, 3_600_000); continue }
        jobs.push(() => this.act(action, l).catch((e) => { this.note(l, e.message); this.log('[keeper]', action, l.pubkey.toBase58().slice(0, 8), e.message) }))
      }
      // A few at once: one slow send can't hold up the rest. The sender's per key lock keeps each listing to one transaction.
      await Promise.all(Array.from({ length: Math.min(POOL, jobs.length) }, async () => { while (jobs.length) await jobs.shift()() }))
      this.status.lastTick = this.now(); this.status.lastError = null
    } catch (e) { this.status.lastError = e.message; this.log('[keeper]', e.message) } finally { this.running = false }
  }
  note(l, why) {
    const p = l.pubkey.toBase58()
    if (WAITS_FOR_SELLER.test(why)) { this.defer(p, SELLER_WAIT_MS); return }
    const ms = ERR_NOT_YET.test(why) ? 500 : Math.min((this.tries.get(p) ?? 500) * 2, MAX_BACKOFF_MS)
    this.tries.set(p, ms)
    this.defer(p, ms)
  }
  async act(action, l) {
    if (action === 'settle_or_refund') {
      // A day past the end and still here: settle has been failing. The refund is open to anyone by now.
      const last = this.sender.latest(this.genKey('settle', l))
      action = last && ['failed', 'rejected', 'dropped'].includes(last.status) ? 'refund' : 'settle'
    }
    const key = this.genKey(action, l)
    const prior = this.sender.latest(key)
    if (prior?.status === 'landed') { this.indexer.touch(l.pubkey); return }
    const tx = { rent: 0 }
    const row = await this.sender.submit(key, action, l.pubkey.toBase58(), () => this.build(action, l, tx))
    this.status.submitted++
    if (row.status !== 'rejected') {
      // A preflight refusal cost nothing, so only a transaction that went out counts against the budgets
      if (tx.rent) this.charge(tx.rent)
      if (action === 'close') this.countClose(l)
    }
    if (row.status === 'rejected' || row.status === 'failed') {
      if (NO_SOL.test(row.err ?? '')) {
        if (!this.status.outOfSol) this.log('[keeper] OUT OF SOL: settles and refunds cannot go out. Top up the keeper wallet.')
        this.status.outOfSol = true
      }
      if (ALL_DONE.test(row.err ?? '')) { this.indexer.touch(l.pubkey); return }
      this.note(l, row.err ?? '')
    } else if (row.status === 'signed' || row.status === 'landed') { this.status.outOfSol = false; this.indexer.touch(l.pubkey); this.tries.delete(l.pubkey.toBase58()) }
  }
  async build(action, l, tx = {}) {
    const payer = this.key
    if (action === 'refund') return { payer, instructions: [this.prog.ix.refund(l)] }
    if (action === 'close') return { payer, instructions: [this.prog.ix.close(l)] }
    const { pre, winnerToken, signers } = await this.winnerAccount(l, tx)
    return { payer, signers, instructions: [...pre, this.prog.ix.settle(l, winnerToken)] }
  }
  /**
   * Any token account the winner owns will do. If there is none, this wallet opens one so settle can't wait on the winner.
   * That spends rent, capped per day. Past the cap it throws, and the winner or anyone else can still settle, or refund after a day.
   */
  async winnerAccount(l, tx = {}) {
    const owner = l.topBidder
    const ata = getAssociatedTokenAddressSync(l.mint, owner, true, l.tokenProgram)
    const info = await this.rpc.account(ata)
    // SOL sent to the address makes a system account, which the idempotent create handles like no account at all
    if (info && !info.owner.equals(SystemProgram.programId)) {
      const v = readTokenAccount(info, l.tokenProgram)
      if (v && v.owner.equals(owner) && v.mint.equals(l.mint) && !v.frozen) return { pre: [], winnerToken: ata, signers: [] }
      const others = await this.rpc.tokenAccountsByOwner(owner, l.mint)
      const ok = others.find((a) => { const x = readTokenAccount(a.account, l.tokenProgram); return x && !x.frozen })
      if (ok) return { pre: [], winnerToken: ok.pubkey, signers: [] }
      // The ATA is broken and can't be replaced at that address, so open a plain token account for the winner.
      if (!this.hasBudget(ATA_RENT)) throw new Error('token account budget used up for today')
      tx.rent = ATA_RENT
      const k = Keypair.generate(), space = getAccountLen([])
      return {
        winnerToken: k.publicKey, signers: [k],
        pre: [SystemProgram.createAccount({ fromPubkey: this.key.publicKey, newAccountPubkey: k.publicKey, lamports: ATA_RENT, space, programId: l.tokenProgram }), createInitializeAccount3Instruction(k.publicKey, l.mint, owner, l.tokenProgram)],
      }
    }
    if (!this.hasBudget(ATA_RENT)) throw new Error('token account budget used up for today')
    tx.rent = ATA_RENT
    return { winnerToken: ata, signers: [], pre: [createAssociatedTokenAccountIdempotentInstruction(this.key.publicKey, ata, owner, l.mint, l.tokenProgram)] }
  }
}
