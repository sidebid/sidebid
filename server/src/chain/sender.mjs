// The one way the server sends a transaction. Sign first, write the signature and raw bytes to disk, then send, then
// resolve from the chain. A send that throws, a timeout, or a restart mid-send all resolve to one outcome, because the
// same signed bytes are rebroadcast and only a finalized height past the blockhash's last valid height proves a transaction
// can never land. Only then may the same key get a new attempt.
import { Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import bs58 from 'bs58'

const REJECTED = /simulation failed|preflight|blockhash not found|insufficient|custom program error|instructionerror/i
export const OPEN = 'signed'
const MAX_CU_PRICE = 1_000_000
/** Each new attempt pays double, so congestion can't keep dropping a settle at one price. Capped at 0.00012 SOL. */
export const priceFor = (base, attempt) => Math.min(base * 2 ** Math.min(attempt - 1, 10), MAX_CU_PRICE)

export class Sender {
  constructor({ db, rpc, now = Date.now, log = () => {}, rebroadcastMs = 4000, heightCheckAfterMs = 45_000, cuPrice = 50_000, cuLimit = 120_000 }) {
    Object.assign(this, { db, rpc, now, log, rebroadcastMs, heightCheckAfterMs, cuPrice, cuLimit })
    this.flight = new Map()
  }
  latest(key) { return this.db.get('SELECT * FROM tx_intents WHERE key=? ORDER BY attempt DESC LIMIT 1', key) ?? null }
  open() { return this.db.all('SELECT * FROM tx_intents WHERE status=?', OPEN) }
  set(row, status, err = null) { this.db.run('UPDATE tx_intents SET status=?, err=?, updated_at=? WHERE key=? AND attempt=?', status, err, this.now(), row.key, row.attempt); row.status = status; row.err = err }

  /**
   * At most one live transaction per key. build(): { instructions, payer, signers }.
   * Returns the row, with status signed, landed, failed, dropped or rejected.
   */
  submit(key, kind, ref, build) {
    if (this.flight.has(key)) return this.flight.get(key)
    const p = this.#submit(key, kind, ref, build).finally(() => this.flight.delete(key))
    this.flight.set(key, p)
    return p
  }
  async #submit(key, kind, ref, build) {
    const cur = this.latest(key)
    if (cur?.status === 'landed') return cur
    if (cur?.status === OPEN) {
      await this.resolve(cur)
      if (cur.status === OPEN || cur.status === 'landed') return cur
    }
    const { blockhash, lastValidBlockHeight } = await this.rpc.blockhash()
    const { instructions, payer, signers = [] } = await build()
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priceFor(this.cuPrice, (cur?.attempt ?? 0) + 1) }), ...instructions)
    tx.sign(payer, ...signers)
    const sig = bs58.encode(tx.signature)
    const raw = tx.serialize()
    const row = { key, attempt: (cur?.attempt ?? 0) + 1, kind, ref, status: OPEN, sig, raw: raw.toString('base64'), lvbh: lastValidBlockHeight, err: null, created_at: this.now() }
    this.db.run('INSERT INTO tx_intents (key,attempt,kind,ref,status,sig,raw,lvbh,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', key, row.attempt, kind, ref, OPEN, sig, row.raw, row.lvbh, row.created_at, row.created_at)
    this.db.run('UPDATE tx_intents SET sent_at=? WHERE key=? AND attempt=?', this.now(), key, row.attempt); row.sent_at = this.now()
    try {
      await this.rpc.send(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
    } catch (e) {
      // A refusal in preflight never went out. Anything else (timeout, 429, a dropped line) may have landed, so it stays open.
      const detail = e.detail ?? e.message
      if (REJECTED.test(detail) && !e.rateLimited) {
        await this.resolve(row, { rebroadcast: false })
        if (row.status === OPEN) this.set(row, 'rejected', String(detail).slice(0, 4000))
      } else this.log(`[send] ${kind} ${sig.slice(0, 8)} send threw, resolving from chain: ${String(e.message).slice(0, 100)}`)
    }
    return row
  }

  /** Decides a row from the chain. A failed read leaves it open and is never taken as "did not land". */
  async resolve(row, { rebroadcast = true } = {}) {
    let st
    try { [st] = await this.rpc.statuses([row.sig]) } catch { return row }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      if (st.err) this.set(row, 'failed', JSON.stringify(st.err).slice(0, 300)); else this.set(row, 'landed')
      return row
    }
    if (st) return row // processed: wait
    if (this.now() - row.created_at >= this.heightCheckAfterMs) {
      try { if ((await this.rpc.finalizedHeight()) > row.lvbh) { this.set(row, 'dropped'); return row } } catch { return row }
    }
    if (rebroadcast && this.now() - (row.sent_at ?? 0) >= this.rebroadcastMs) {
      this.db.run('UPDATE tx_intents SET sent_at=? WHERE key=? AND attempt=?', this.now(), row.key, row.attempt); row.sent_at = this.now()
      await this.rpc.send(Buffer.from(row.raw, 'base64'), { skipPreflight: true, maxRetries: 0 }).catch(() => {}) // same bytes, same signature
    }
    return row
  }
  async resolveOpen(opts) { for (const row of this.open()) await this.resolve(row, opts) }
}
