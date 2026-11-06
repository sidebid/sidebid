// The queue for @sidebidsol's replies. One row per (kind, post), so a duplicate can't be queued. A row is only ever made
// for a post whose author tagged the account. The text is fixed when queued. If a send ends with an unknown outcome
// (a crash, a timeout), the account's own recent posts are read before trying again, and if that can't be read it waits.
import { PublicKey } from '@solana/web3.js'
import { readTokenAccount } from '../chain/program.mjs'

const BACKOFF = [10_000, 30_000, 60_000, 180_000, 600_000]
/**
 * Where the reply sends the seller. With X_REPLY_LINKS on, the card link (billed by X at the "with URL" price). Off, no link
 * and no domain at all, at the plain post price, plus the card's short code so two sellers' replies are never the same words.
 */
export const cardWhere = (config, listing, line) => (config.x?.replyLinks ? `${config.publicUrl}/c/${listing}` : `${line} Card ${String(listing).slice(0, 4)}…${String(listing).slice(-4)}`)

/** X shortens every link to t.co, so two posts are the same when their words are, with links taken out. */
export const sameWords = (a, b) => { const w = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim(); return w(a) !== '' && w(a) === w(b) }
export const fmtSol = (lamports) => { const s = (BigInt(lamports).toString()).padStart(10, '0'); const w = s.slice(0, -9), f = s.slice(-9).replace(/0+$/, ''); return f ? `${w}.${f}` : w }

export class Replies {
  constructor({ db, config, flags, x, rpc = null, prog = null, now = Date.now, log = () => {} }) { Object.assign(this, { db, config, flags, x, rpc, prog, now, log }); this.pauseUntil = 0 }
  enqueue({ kind, tweetId, xId, listing, text, expiresAt }) {
    const tagged = this.db.get('SELECT x_id FROM mentions WHERE tweet_id=?', tweetId)
    if (!tagged || tagged.x_id !== xId) throw new Error('replies only go to posts that tagged us')
    return this.db.run(`INSERT OR IGNORE INTO replies (kind,tweet_id,x_id,listing,text,state,expires_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)`, kind, tweetId, xId, listing, text, expiresAt, this.now()).changes === 1
  }
  /** Startup: anything caught mid-send has an unknown outcome. */
  recover() { this.db.run(`UPDATE replies SET state='unknown' WHERE state='sending'`) }

  /** Queues the accept window reply once a fresh read proves the window opened with a bid to accept. */
  async scanAcceptWindows() {
    if (!this.rpc || !this.prog) return
    const nowS = Math.floor(this.now() / 1000)
    const cards = this.db.all(`SELECT c.*, l.end_time, l.accept_window_secs FROM tag_cards c JOIN listings l ON l.pubkey=c.listing WHERE c.closed_at IS NULL AND l.closed=0 AND l.mode='accept' AND l.top_bid<>'0' AND l.end_time<=? AND l.end_time+l.accept_window_secs>? AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.kind='accept' AND r.tweet_id=c.tweet_id) LIMIT 50`, nowS, nowS)
    if (!cards.length) return
    const keys = cards.map((c) => new PublicKey(c.listing))
    let infos
    try { infos = await this.rpc.accounts(keys) } catch { return }
    const tokenKeys = []; const decoded = cards.map((c, i) => { const l = this.prog.decode(keys[i], infos[i]); if (l) tokenKeys.push(l.tokenAccount); return l })
    let tokenInfos
    try { tokenInfos = await this.rpc.accounts(tokenKeys) } catch { return }
    let t = 0
    cards.forEach((c, i) => {
      const l = decoded[i]
      if (!l) return
      const view = readTokenAccount(tokenInfos[t++], l.tokenProgram)
      if (l.state !== 'live' || l.topBid === 0n || l.endTime > nowS || l.endTime + l.acceptWindowSecs <= nowS) return
      const mins = Math.round(l.acceptWindowSecs / 60)
      const text = `Top bid is ${fmtSol(l.topBid)} SOL. You have ${mins} minutes to accept.${view?.cpiGuard ? ' Your token account has CPI Guard on, turn it off first.' : ''}\n${cardWhere(this.config, c.listing, 'Accept on our site, link on our profile.')}`
      this.enqueue({ kind: 'accept', tweetId: c.tweet_id, xId: c.x_id, listing: c.listing, text, expiresAt: (l.endTime + l.acceptWindowSecs) * 1000 })
    })
  }

  async tick() {
    if (!this.flags.repliesOn) return
    await this.scanAcceptWindows()
    if (this.now() < this.pauseUntil || !this.x.available()) return
    const due = this.db.all(`SELECT * FROM replies WHERE state IN ('pending','unknown','retry') AND next_at<=? ORDER BY updated_at LIMIT 10`, this.now())
    for (const r of due) {
      if (this.now() >= r.expires_at) { this.db.run(`UPDATE replies SET state='expired', updated_at=? WHERE kind=? AND tweet_id=?`, this.now(), r.kind, r.tweet_id); continue }
      if (!(await this.sendOne(r))) break
    }
  }

  set(r, state, extra = {}) { this.db.run(`UPDATE replies SET state=?, attempts=?, next_at=?, reply_id=?, err=?, updated_at=? WHERE kind=? AND tweet_id=?`, state, extra.attempts ?? r.attempts, extra.nextAt ?? 0, extra.replyId ?? r.reply_id ?? null, extra.err ?? null, this.now(), r.kind, r.tweet_id) }

  /** Returns false when the whole queue should wait: cap, credits, rate limit. */
  async sendOne(r) {
    const later = (e, state = 'retry') => this.set(r, state, { attempts: r.attempts + 1, nextAt: this.now() + BACKOFF[Math.min(r.attempts, BACKOFF.length - 1)], err: String(e.message ?? e).slice(0, 200) })
    if (r.state === 'unknown') {
      // The earlier send may have gone through, so look first. Only a post with this row's own words counts: another kind of
      // reply to the same post, sent or expired or never recorded, can't stand in for it.
      let found
      try { found = await this.x.findReply(r.tweet_id) } catch (e) { later(e, 'unknown'); return !['cap', 'credits', 'rate'].includes(e.kind) }
      const mine = found.find((t) => sameWords(t.text, r.text))
      if (mine) { this.set(r, 'sent', { replyId: mine.id }); return true }
    }
    this.db.run(`UPDATE replies SET state='sending', updated_at=? WHERE kind=? AND tweet_id=?`, this.now(), r.kind, r.tweet_id)
    try {
      const id = await this.x.reply(r.tweet_id, r.text)
      this.set(r, 'sent', { replyId: id })
      return true
    } catch (e) {
      if (e.kind === 'duplicate') { this.set(r, 'sent'); return true } // X refusing the same text means an earlier try got through
      if (e.kind === 'network' || e.kind === 'server') { later(e, 'unknown'); return true } // may have gone through
      if (e.kind === 'rate' && e.retryAt) this.pauseUntil = e.retryAt
      later(e)
      return !['cap', 'credits', 'rate'].includes(e.kind)
    }
  }
}
