// Hourly creator fee rewards. Each UTC hour, once the indexer has read past the hour's end:
//   1. standings: SOL received by each seller from that hour's completed sales (settle, accept, fixed buy), frozen
//   2. claim:     the coin's creator fees, with the proven claimer in ./claim.js, unchanged
//   3. measure:   only the creator vault's own drop in that claim transaction counts, minus its fee
//   4. plan:      10% of the claim to the team, the rest plus last hour's carry to the top three, 50/30/20
//   5. pay:       through Sender, so each payout is signed and written down before it is sent and resolved from chain
// The dev wallet pays only out of what claims measured: a ledger check refuses anything past it. Its own SOL and its tokens
// are never in a transaction here, other than as the claim's fee payer, which the claimed amount repays.
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { Claimer, creatorVault } from './claim.js'
import { Sender } from '../chain/sender.mjs'
import { redact } from '../chain/rpc.mjs'

// Each payout's fee at the most an attempt can pay: 5,000 base + 5,000 CU at the 1,000,000 micro lamport ceiling
export const PAYOUT_CU = 5_000
export const PAYOUT_FEE_MAX = 5_000 + PAYOUT_CU
const HOUR_MS = 3_600_000
const CLAIM_LOST_MS = 10 * 60_000
const MAX_REFUSALS = 6
// Refusals that no retry can fix: the destination can't take lamports, or can't stay rent exempt
const PERMANENT = /InvalidWritableAccount|ReadonlyLamportChange|ExecutableLamportChange|InvalidAccountForFee|InsufficientFundsForRent|insufficient funds for rent|writable account that cannot be written|demoted|reserved account/i
const VAULT_RENT = 890_880n
const CLAIM_FEE_ESTIMATE = 8_000n // 5,000 base + 60,000 CU at 50,000 micro lamports, as the claimer sets them
const iso = (ms) => new Date(ms).toISOString()
export const hourOf = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS

/** Top sellers for [start, end): most SOL received first. A tie goes to the earlier first sale, then by address (web/REWARDS-API.md). */
export function standings(db, start, end) {
  return db.all(`SELECT seller AS wallet, SUM(CAST(price AS INTEGER)) AS received, COUNT(*) AS sales, MIN(at) AS first
    FROM sales WHERE at>=? AND at<? AND kind IN ('Settled','Accepted','Bought') AND seller IS NOT NULL
    GROUP BY seller ORDER BY received DESC, first ASC, wallet ASC`, Math.floor(start / 1000), Math.floor(end / 1000))
    .map((r) => ({ wallet: r.wallet, received: String(r.received), sales: r.sales, firstSaleAt: r.first }))
}

/**
 * The money for one hour, all in integer lamports. What the hour can spend is its carry plus the claim net of the claim's fee.
 * Each payout reserves its worst case fee out of that, so the dev wallet's own SOL ends where it began. Team gets its share of
 * the claim only. Everything not paid (empty places, shares under the minimum, rounding, unused fee reserve) is the carry,
 * which may be negative after a claim whose fee exceeded what it moved: the next hours repay that first.
 */
export function plan({ claimed, claimFee, carryIn, winners, teamBps, split, minPayout, teamWallet }) {
  const fee = BigInt(PAYOUT_FEE_MAX), min = BigInt(minPayout)
  const claimNet = BigInt(claimed) - BigInt(claimFee)
  const available = BigInt(carryIn) + claimNet
  const places = split.map((bps, i) => ({ place: i + 1, bps: BigInt(bps), wallet: winners[i]?.wallet ?? null }))
  // A team payout only exists when this hour claimed something: a carry already had its team share taken
  const transfers = BigInt((teamWallet && claimNet > 0n ? 1 : 0) + places.filter((p) => p.wallet).length)
  const base = available - fee * transfers
  const out = []
  let team = 0n, prize = 0n
  if (base > 0n) {
    const teamBase = claimNet - fee * transfers > 0n ? claimNet - fee * transfers : 0n
    team = teamWallet && claimNet > 0n ? (teamBase * BigInt(teamBps)) / 10_000n : 0n
    if (team > base) team = base
    prize = base - team
    if (team >= min && team > 0n) out.push({ slot: 'team', place: 0, wallet: teamWallet, lamports: team })
    else { prize += team; team = 0n }
    for (const p of places) {
      const amount = (prize * p.bps) / 10_000n
      if (p.wallet && amount >= min) out.push({ slot: `place${p.place}`, place: p.place, wallet: p.wallet, lamports: amount })
    }
  }
  const spent = out.reduce((a, x) => a + x.lamports + fee, 0n)
  return { available, team, prize, payouts: out, carryOut: available - spent }
}

export class Rewards {
  constructor({ db, rpc, conn, config, flags, now = Date.now, log = () => {}, claimer = null, sender = null, senderOpts = {} }) {
    Object.assign(this, { db, rpc, config, flags, now, log })
    this.cfg = config.rewards
    this.dev = config.devKey
    if (this.dev) this.claimer = claimer ?? new Claimer({ conn, creatorKeypair: this.dev, minClaimSol: this.cfg.minClaimSol, log: (...a) => log(...a.map((x) => redact(x))) })
    // Fixed small compute so every payout's fee fits its reserve, at whatever price an attempt pays
    this.sender = sender ?? new Sender({ db, rpc, now, log, ...senderOpts, cuLimit: PAYOUT_CU, cuPrice: 200_000 })
    this.status = { lastError: null, lastTick: null }
    this.vaultCache = { at: 0, lamports: null }
  }
  get on() { return this.flags.rewardsOn }
  ready() { return !!(this.dev && this.cfg.teamWallet) }
  hourRow(h) { return this.db.get('SELECT * FROM reward_hours WHERE hour=?', h) }
  setHour(h, fields) {
    const keys = Object.keys(fields)
    this.db.run(`UPDATE reward_hours SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE hour=?`, ...keys.map((k) => fields[k]), this.now(), h)
  }
  /** Claimed minus paid, since the start: the most the dev wallet may still pay out. Signed but unresolved payouts count as paid. */
  ledger() {
    const claimed = BigInt(this.db.get(`SELECT COALESCE(SUM(CAST(claimed AS INTEGER) - CAST(claim_fee AS INTEGER)),0) n FROM reward_hours WHERE claim_state='measured'`).n)
    const out = BigInt(this.db.get(`SELECT COALESCE(SUM(CASE WHEN status='failed' THEN ${PAYOUT_FEE_MAX} ELSE CAST(lamports AS INTEGER) + ${PAYOUT_FEE_MAX} END),0) n FROM reward_payouts r WHERE status IN ('landed','failed') OR (status='signed' AND EXISTS (SELECT 1 FROM tx_intents t WHERE t.key='reward:' || r.hour || ':' || r.slot))`).n)
    return { claimed, out, room: claimed - out }
  }

  /** One step of the hour machine. Each step is idempotent and written down, so a restart picks up where it stopped. */
  async tick() {
    if (!this.on || !this.ready()) return
    try {
      const h = this.nextHour()
      if (h === null) return
      let r = this.hourRow(h)
      if (!r) {
        if (!this.indexedPast(h + HOUR_MS)) return
        const st = standings(this.db, h, h + HOUR_MS)
        const prev = this.hourRow(h - HOUR_MS)
        this.db.run(`INSERT OR IGNORE INTO reward_hours (hour,state,standings,carry_in,claim_state,claimed,claim_fee,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, h, 'claiming', JSON.stringify(st), prev?.carry_out ?? this.db.meta('rewards_carry') ?? '0', 'pending', '0', '0', this.now(), this.now())
        r = this.hourRow(h)
      }
      if (r.state === 'claiming') await this.claimStep(r)
      r = this.hourRow(h)
      if (r.state === 'planning') this.planStep(r)
      r = this.hourRow(h)
      if (r.state === 'paying') await this.payStep(r)
      this.status.lastTick = this.now(); this.status.lastError = null
    } catch (e) { this.status.lastError = e.message; this.log('[rewards]', e.message) }
  }
  /** The oldest hour not done yet, once it has ended. Hours are paid strictly in order, because each carries into the next. */
  nextHour() {
    const open = this.db.get(`SELECT hour FROM reward_hours WHERE state<>'done' ORDER BY hour LIMIT 1`)
    if (open) return open.hour
    const last = this.db.get('SELECT MAX(hour) h FROM reward_hours').h
    const start = Number(this.db.meta('rewards_start_hour') ?? hourOf(this.now()))
    if (this.db.meta('rewards_start_hour') === null) this.db.setMeta('rewards_start_hour', start)
    const h = last === null ? start : last + HOUR_MS
    return h + HOUR_MS <= this.now() ? h : null
  }
  /** Sales are counted only once the indexer has read the chain past the hour's end, plus a margin for slow blocks. */
  indexedPast(end) { return Number(this.db.meta('index_synced_at') ?? 0) >= end + this.cfg.closeGraceMs }

  async claimStep(r) {
    if (r.claim_sig === null && r.claim_state === 'pending') {
      // Marked before the claim: a restart in the middle finds "started" and never claims for this hour again
      this.setHour(r.hour, { claim_state: 'started' })
      const res = await this.claimer.claim()
      const why = res.why ? redact(res.why) : null
      if (res.sig) this.setHour(r.hour, { claim_sig: res.sig, claim_state: 'sent', claim_note: why, claim_at: this.now() })
      else { this.setHour(r.hour, { claim_state: 'measured', claimed: '0', claim_fee: '0', claim_note: why ?? 'no claim', state: 'planning' }); return }
      r = this.hourRow(r.hour)
    }
    if (r.claim_state === 'started') {
      // Died between marking and recording a signature: whatever moved stays in the dev wallet, uncounted and never paid
      this.setHour(r.hour, { claim_state: 'measured', claimed: '0', claim_fee: '0', claim_note: 'restart during the claim: anything it moved is left uncounted', state: 'planning' })
      return
    }
    if (r.claim_state === 'sent') {
      const m = await this.measure(r.claim_sig)
      if (m === null) {
        if (this.now() - (r.claim_at ?? 0) > CLAIM_LOST_MS) this.setHour(r.hour, { claim_state: 'measured', claimed: '0', claim_fee: '0', claim_note: 'claim never seen on chain', state: 'planning' })
        return // not visible yet, or the read failed: neither is zero, so wait
      }
      this.setHour(r.hour, { claim_state: 'measured', claimed: String(m.delta), claim_fee: String(m.fee), claim_note: m.failed ? 'claim failed on chain' : null, state: 'planning' })
    }
  }
  /**
   * The vault's own drop in the claim transaction, read from the chain: balance before minus after, never a wallet balance
   * that other transfers could move. Null when the transaction can't be read yet. A failed claim measures 0 and its fee.
   */
  vaultAddress() { return creatorVault(this.dev.publicKey) }
  async measure(sig) {
    let tx
    try { tx = await this.rpc.call('getTransaction', (c) => c.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })) } catch { return null }
    if (!tx) return null
    const fee = tx.meta?.fee ?? 0
    if (tx.meta?.err) return { delta: 0, fee, failed: true }
    const msg = tx.transaction.message
    const keys = (msg.staticAccountKeys ?? msg.accountKeys).map((k) => (k.toBase58 ? k.toBase58() : String(k)))
    // Both sides: what left the vault, and what reached the dev wallet (its gain plus the fee it paid). The smaller one counts, so a
    // fee split, or any change to the instruction, can never make the ledger believe in SOL the dev wallet didn't get.
    const i = keys.indexOf(this.vaultAddress().toBase58()), j = keys.indexOf(this.dev.publicKey.toBase58())
    if (i < 0 || j < 0) return { delta: 0, fee }
    const drop = tx.meta.preBalances[i] - tx.meta.postBalances[i]
    const gain = tx.meta.postBalances[j] - tx.meta.preBalances[j] + fee
    return { delta: Math.max(0, Math.min(drop, gain)), fee, drop, gain }
  }

  planStep(r) {
    const winners = JSON.parse(r.standings).slice(0, this.cfg.split.length)
    const p = plan({ claimed: r.claimed, claimFee: r.claim_fee, carryIn: r.carry_in, winners, teamBps: this.cfg.teamBps, split: this.cfg.split, minPayout: this.cfg.minPayoutLamports, teamWallet: this.cfg.teamWallet })
    this.db.tx(() => {
      for (const x of p.payouts) this.db.run(`INSERT OR IGNORE INTO reward_payouts (hour,slot,place,wallet,lamports,status) VALUES (?,?,?,?,?,'planned')`, r.hour, x.slot, x.place, x.wallet, String(x.lamports))
      this.setHour(r.hour, { net: String(p.available), team: String(p.team), prize: String(p.prize), carry_out: String(p.carryOut), state: 'paying' })
    })
  }

  async payStep(r) {
    if (this.flags.raw('killRewards')) return
    const rows = this.db.all(`SELECT * FROM reward_payouts WHERE hour=? AND status IN ('planned','signed') ORDER BY place`, r.hour)
    for (const p of rows) {
      if (!this.flags.rewardsOn) return // read before every payout: a kill stops the next one, not the next hour
      const key = `reward:${r.hour}:${p.slot}`
      const prior = this.sender.latest(key)
      if (prior?.status === 'signed') { await this.sender.resolve(prior); this.note(p, prior); continue }
      if (prior?.status === 'landed') { this.note(p, prior); continue }
      // The ledger has to cover this payout and its worst fee, counting everything already signed
      const { room } = this.ledger()
      if (BigInt(p.lamports) + BigInt(PAYOUT_FEE_MAX) > room) { this.db.run(`UPDATE reward_payouts SET status='held', note='ledger would go past what claims measured' WHERE hour=? AND slot=?`, r.hour, p.slot); this.log('[rewards] HELD: a payout would spend past what claims measured'); continue }
      this.db.run(`UPDATE reward_payouts SET status='signed' WHERE hour=? AND slot=?`, r.hour, p.slot)
      const row = await this.sender.submit(key, 'reward', `${r.hour}:${p.slot}`, async () => ({ payer: this.dev, instructions: [SystemProgram.transfer({ fromPubkey: this.dev.publicKey, toPubkey: new PublicKey(p.wallet), lamports: BigInt(p.lamports) })] }))
      this.note(p, row)
    }
    const left = this.db.get(`SELECT COUNT(*) n FROM reward_payouts WHERE hour=? AND status IN ('planned','signed')`, r.hour).n
    if (left) return
    // Shares nobody could receive go on to the next hour instead of being lost
    // A refused send cost nothing, so its share and fee reserve come back. One that failed on chain paid its fee, so only the share does.
    const unpaid = BigInt(this.db.get(`SELECT COALESCE(SUM(CASE WHEN status='failed' THEN CAST(lamports AS INTEGER) ELSE CAST(lamports AS INTEGER) + ${PAYOUT_FEE_MAX} END),0) n FROM reward_payouts WHERE hour=? AND status IN ('unpayable','held','failed')`, r.hour).n)
    const carry = BigInt(r.carry_out) + unpaid
    this.db.tx(() => { this.setHour(r.hour, { carry_out: String(carry), state: 'done' }); this.db.setMeta('rewards_carry', String(carry)) })
  }
  /**
   * dropped: proven never landed, so planned again for a new attempt. failed: on chain, paid its fee. rejected: refused before
   * sending. A refusal is usually the network (a lagging node, a blockhash it hasn't seen, a balance it hasn't caught up on), so the
   * payout is tried again next tick. Only an account the runtime can never pay, or MAX_REFUSALS refusals in a row, ends it.
   */
  note(p, row) {
    const err = row.status === 'rejected' || row.status === 'failed' ? String(row.err ?? '').slice(0, 300) : null
    let status = { landed: 'landed', signed: 'signed', dropped: 'planned', failed: 'failed' }[row.status]
    if (row.status === 'rejected') {
      const refusals = (this.db.get('SELECT refusals FROM reward_payouts WHERE hour=? AND slot=?', p.hour, p.slot)?.refusals ?? 0) + 1
      this.db.run('UPDATE reward_payouts SET refusals=? WHERE hour=? AND slot=?', refusals, p.hour, p.slot)
      status = PERMANENT.test(err) || refusals >= MAX_REFUSALS ? 'unpayable' : 'planned'
    }
    this.db.run(`UPDATE reward_payouts SET status=?, sig=?, note=? WHERE hour=? AND slot=?`, status ?? 'unpayable', status === 'planned' ? null : row.sig, err, p.hour, p.slot)
  }

  // ---- the public view
  async vaultPending() {
    if (!this.dev) return null
    if (this.now() - this.vaultCache.at < 15_000) return this.vaultCache.lamports
    try {
      const [info] = await this.rpc.public.accounts([creatorVault(this.dev.publicKey)])
      this.vaultCache = { at: this.now(), lamports: String(info?.lamports ?? 0) }
    } catch {
      // A failed read is never zero: a recent good value stands for a minute, then the pot shows as unknown
      if (this.now() - this.vaultCache.at > 60_000) this.vaultCache = { at: this.vaultCache.at, lamports: null }
    }
    return this.vaultCache.lamports
  }
  who(wallet) { return this.db.get('SELECT NULLIF(u.handle, \'\') handle, u.avatar FROM wallet_links k JOIN x_users u ON u.x_id=k.x_id WHERE k.wallet=?', wallet) ?? { handle: null, avatar: null } }
  /** The seller pot of an hour still counting: carry plus what the vault holds above rent, less the team share and the fee reserve. */
  livePot(vault, carry, sellerCount) {
    if (vault === null) return null
    const above = BigInt(vault) - VAULT_RENT > 0n ? BigInt(vault) - VAULT_RENT : 0n
    const p = plan({ claimed: above, claimFee: CLAIM_FEE_ESTIMATE, carryIn: carry, winners: Array.from({ length: Math.min(sellerCount, this.cfg.split.length) }, () => ({ wallet: 'x' })), teamBps: this.cfg.teamBps, split: this.cfg.split, minPayout: 0, teamWallet: this.cfg.teamWallet })
    return p.prize > 0n ? p.prize : 0n
  }
  pastView(r) {
    const st = JSON.parse(r.standings)
    const rows = this.db.all(`SELECT * FROM reward_payouts WHERE hour=? AND slot<>'team' ORDER BY place`, r.hour)
    const bad = rows.some((p) => ['unpayable', 'held', 'failed'].includes(p.status))
    const status = r.state !== 'done' ? 'paying' : st.length === 0 ? 'no_sales' : bad ? 'failed' : rows.length === 0 ? 'carried' : 'paid'
    return {
      start: r.hour / 1000, end: (r.hour + HOUR_MS) / 1000, status, potLamports: r.prize ?? null, claimSig: r.claim_sig ?? null, sales: st.reduce((a, x) => a + x.sales, 0),
      payouts: rows.filter((p) => status !== 'failed' || p.status === 'landed').map((p) => ({ rank: p.place, wallet: p.wallet, ...this.who(p.wallet), lamports: p.lamports, sig: p.status === 'landed' ? p.sig : null })),
    }
  }
  /** GET /api/rewards, in the shape web/REWARDS-API.md fixes. */
  async view({ before = null, limit = 24 } = {}) {
    const start = hourOf(this.now()), end = start + HOUR_MS
    const carry = this.db.get(`SELECT carry_out FROM reward_hours WHERE state='done' ORDER BY hour DESC LIMIT 1`)?.carry_out ?? '0'
    const st = standings(this.db, start, end)
    const on = this.on && this.ready() // switched on and able to pay: otherwise there is no live pot to show
    const vault = on ? await this.vaultPending() : null
    const pot = on ? this.livePot(vault, carry, st.length) : null
    // What all three places would share right now, and the creator fees waiting in the vault: the site shows both while places are open
    const potAll = on ? this.livePot(vault, carry, this.cfg.split.length) : null
    const fees = vault === null ? null : BigInt(vault) - VAULT_RENT > 0n ? BigInt(vault) - VAULT_RENT : 0n
    const n = Math.min(Math.max(Number(limit) || 24, 1), 48)
    const b = Number(before)
    const rows = Number.isFinite(b) && b > 0 ? this.db.all('SELECT * FROM reward_hours WHERE hour<? ORDER BY hour DESC LIMIT ?', b * 1000, n + 1) : this.db.all('SELECT * FROM reward_hours ORDER BY hour DESC LIMIT ?', n + 1)
    const page = rows.slice(0, n)
    const team = this.cfg.teamWallet ? this.cfg.teamBps : 0
    return {
      now: Math.floor(this.now() / 1000), name: this.config.brand.name, ticker: this.config.brand.ticker, paused: !on,
      split: this.cfg.split.map((x) => x / 100), sellerSharePct: (10_000 - team) / 100, teamSharePct: team / 100,
      devWallet: this.dev ? this.dev.publicKey.toBase58() : null,
      hour: {
        start: start / 1000, end: end / 1000, payoutAt: (end + this.cfg.closeGraceMs) / 1000,
        potLamports: pot === null ? null : String(pot), potKind: 'estimate', potAllLamports: potAll === null ? null : String(potAll), feesLamports: fees === null ? null : String(fees),
        standings: st.map((x, i) => ({ rank: i + 1, wallet: x.wallet, ...this.who(x.wallet), receivedLamports: x.received, sales: x.sales, projectedLamports: pot !== null && i < this.cfg.split.length ? String((pot * BigInt(this.cfg.split[i])) / 10_000n) : '0' })),
      },
      past: page.map((r) => this.pastView(r)),
      next: rows.length > n ? page.at(-1).hour / 1000 : null,
    }
  }
}
