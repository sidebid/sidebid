// Turns posts to the coin account into live cards. Nothing here can move tokens: a card is only an announcement until
// the seller signs Accept. A mention is written down with the cursor before anything happens to it, so a restart
// neither loses it nor makes a second card, and the card's address comes from the post id, so the chain refuses a repeat.
import { PublicKey } from '@solana/web3.js'
import { parseMention, toBaseUnits } from './parser.mjs'
import { cleanAvatar, cleanHandle } from '../auth.mjs'
import { cardWhere } from './replies.mjs'
import { getAssociatedTokenAddressSync, MIN_PRICE_LAMPORTS, programError, readMint, readTokenAccount, tagListingId } from '../chain/program.mjs'

const HOLD_ERR = programError('InsufficientTokens', 'TokenAccountFrozen')
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
/** Raw units as every digit, grouped: 150,000,000 or 1,250.5 */
export function exactTokens(raw, decimals) {
  const d = decimals ?? 0, s = BigInt(raw).toString().padStart(d + 1, '0'), w = d ? s.slice(0, -d) : s, f = d ? s.slice(-d).replace(/0+$/, '') : ''
  return w.replace(/\B(?=(\d{3})+$)/g, ',') + (f ? '.' + f : '')
}
/** "selling 150,000,000 of 300,000,000 tokens", the exact count the card was made with. */
export const amountLine = (p) => `selling ${exactTokens(p.amount, p.decimals)} of ${exactTokens(p.held ?? p.amount, p.decimals)} tokens`
export const TAG_RENT_LAMPORTS = 3_097_200 // 317 bytes, as measured on a validator. LiteSVM reports less

export class Reader {
  constructor({ db, config, flags, x, rpc, auth, sender, prog, replies, indexer = null, now = Date.now, log = () => {} }) { Object.assign(this, { db, config, flags, x, rpc, auth, sender, prog, replies, indexer, now, log }); this.lastPoll = 0; this.pauseUntil = 0; this.status = { lastPoll: null, lastError: null } }

  /** Costs nothing while off: no paid reads. */
  async tick() {
    if (!this.flags.readerOn) return
    if (this.now() >= this.pauseUntil && this.now() - this.lastPoll >= this.config.x.pollSeconds * 1000 * this.quietFactor()) {
      this.lastPoll = this.now()
      await this.poll()
    }
    await this.work()
  }

  /** Polls that brought only posts that aren't listings slow the next one, to 8 times the interval. A good tag resets it. */
  quietFactor() { return Math.min(2 ** (this.junkPolls ?? 0), 8) }

  async poll() {
    this.status.lastPoll = this.now()
    const since = this.db.meta('x_since_id'), first = !since
    let list
    try { list = await this.x.mentions(since) } catch (e) {
      this.status.lastError = e.kind ?? e.message
      if (e.kind === 'rate' && e.retryAt) this.pauseUntil = e.retryAt
      this.log('[reader] poll:', e.message)
      return 0
    }
    this.status.lastError = null
    if (list.some((m) => parseMention(m.text, { handle: this.config.x.handle, minSeconds: 0, maxSeconds: Infinity }).ok)) this.junkPolls = 0
    else if (list.length) this.junkPolls = (this.junkPolls ?? 0) + 1
    const startedAt = Number(this.db.meta('x_started_at') ?? this.now())
    if (first) this.db.setMeta('x_started_at', startedAt)
    this.db.tx(() => {
      for (const m of list) {
        // First start: posts from before now are history, never a backlog to act on
        const old = (first && (m.createdAt ?? 0) < startedAt) || !m.createdAt || this.now() - m.createdAt >= this.config.tag.mentionMaxAgeMs
        this.db.run(`INSERT OR IGNORE INTO mentions (tweet_id,x_id,handle,avatar,x_created_at,followers,text,created_at,state,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          m.id, String(m.author.id), cleanHandle(m.author.handle), cleanAvatar(m.author.avatar), m.author.xCreatedAt ?? null, m.author.followers ?? null, String(m.text).slice(0, 4000), m.createdAt, old ? 'ignored' : 'new', old ? 'too_old' : (m.isRepost ? 'repost' : null), this.now())
        if (m.isRepost && !old) this.db.run(`UPDATE mentions SET state='ignored' WHERE tweet_id=? AND state='new'`, m.id)
      }
      const newest = list.at(-1)?.id
      if (newest && (!since || BigInt(newest) > BigInt(since))) this.db.setMeta('x_since_id', newest)
    })
    return list.length
  }

  ignore(m, reason) { this.db.run(`UPDATE mentions SET state='ignored', reason=?, updated_at=? WHERE tweet_id=?`, reason, this.now(), m.tweet_id) }
  retry(m, reason) {
    // Past its age limit it stops, recorded as could not read, which is different from "does not hold".
    if (m.attempts >= RETRY_MS.length) return this.ignore(m, `gave_up:${reason}`)
    this.db.run(`UPDATE mentions SET state='retry', reason=?, attempts=attempts+1, next_at=?, updated_at=? WHERE tweet_id=?`, reason, this.now() + RETRY_MS[m.attempts], this.now(), m.tweet_id)
  }

  async work() {
    const due = this.db.all(`SELECT * FROM mentions WHERE state IN ('new','retry','creating') AND next_at<=? ORDER BY tweet_id LIMIT 25`, this.now())
    for (const m of due) {
      try { await (m.state === 'creating' ? this.finishCreate(m) : this.handle(m)) } catch (e) { this.log('[reader] mention', m.tweet_id, e.message); this.retry(m, 'error') }
    }
  }

  async handle(m) {
    if (!this.flags.taggingOn) return // stays queued until the flag opens or it ages out below
    if (this.now() - (m.created_at ?? 0) >= this.config.tag.mentionMaxAgeMs) return this.ignore(m, 'too_old')
    const { tag } = this.config
    const p = parseMention(m.text, { handle: this.config.x.handle, defaultSeconds: tag.defaultSeconds, minSeconds: tag.minSeconds, maxSeconds: tag.maxSeconds })
    if (!p.ok) return this.ignore(m, `parse:${p.reason}`)
    if (m.x_id === this.config.x.accountId) return this.ignore(m, 'own_post')
    const known = this.db.get('SELECT 1 FROM x_users WHERE x_id=?', m.x_id)
    if (!known) return this.ignore(m, 'not_signed_in')
    const wallet = this.auth.activeWallet(m.x_id)
    if (!wallet) return this.ignore(m, 'no_wallet')

    const mintKey = new PublicKey(p.ca), walletKey = new PublicKey(wallet)
    let mintInfo, ataInfo, mint, ata
    try {
      mintInfo = await this.rpc.account(mintKey)
      mint = readMint(mintInfo)
      if (!mint) return this.ignore(m, 'not_a_mint')
      if (!mint.allowed) return this.ignore(m, 'mint_refused')
      // The contract takes the associated token account only, so tokens held anywhere else can't back a card
      ata = getAssociatedTokenAddressSync(mintKey, walletKey, false, mint.tokenProgram)
      ataInfo = await this.rpc.account(ata)
    } catch { return this.retry(m, 'chain_read_failed') } // a failed read says nothing about what they hold
    let need = null
    if (!p.all && p.pct == null) { need = toBaseUnits(p.amount, mint.decimals); if (need === null || need === 0n || need >= 1n << 64n) return this.ignore(m, 'bad_amount') }
    const v = readTokenAccount(ataInfo, mint.tokenProgram)
    const best = v && !v.frozen && v.amount > 0n ? { pubkey: ata, v } : null
    // A percent is worked out here, from the balance this read saw, rounded down; the card carries that exact count
    const amount = p.all ? best?.v.amount : p.pct != null ? (best ? (best.v.amount * BigInt(p.pct)) / 100n : 0n) : need
    if (!best || !amount || best.v.amount < amount) return this.ignore(m, 'does_not_hold')
    const minBid = p.minBid ? BigInt(p.minBid) : MIN_PRICE_LAMPORTS

    const budget = this.reserveBudget(m, wallet, p.ca)
    if (budget) return this.ignore(m, budget)
    let bal
    try { bal = await this.rpc.balance(this.config.listingKey.publicKey) } catch { return this.retry(m, 'chain_read_failed') }
    if (bal < this.config.tag.minListingBalance) return this.ignore(m, 'budget:listing_key_low')

    const id = tagListingId(m.tweet_id), listing = this.prog.acceptPda(id).toBase58()
    const parsed = JSON.stringify({ wallet, mint: p.ca, tokenAccount: best.pubkey.toBase58(), amount: amount.toString(), held: best.v.amount.toString(), decimals: mint.decimals, minBid: minBid.toString(), seconds: p.seconds, cpiGuard: best.v.cpiGuard })
    this.db.run(`UPDATE mentions SET state='creating', parsed=?, listing=?, attempts=0, updated_at=? WHERE tweet_id=?`, parsed, listing, this.now(), m.tweet_id)
    await this.sendCreate(m.tweet_id, id, JSON.parse(parsed), mint)
    const row = this.db.get('SELECT * FROM mentions WHERE tweet_id=?', m.tweet_id)
    await this.finishCreate(row)
  }

  /** Spam can't drain the key: per account, per hour, and a ceiling on rent out at once. Returns a reason, or null. */
  reserveBudget(m, wallet, mint) {
    const { tag } = this.config
    const open = this.db.get(`SELECT COUNT(*) n FROM tag_cards WHERE closed_at IS NULL`).n + this.db.get(`SELECT COUNT(*) n FROM mentions WHERE state='creating'`).n
    if ((open + 1) * TAG_RENT_LAMPORTS > tag.rentBudgetLamports) return 'budget:rent'
    const since = this.now() - 86_400_000
    if (this.db.get(`SELECT COUNT(*) n FROM tag_cards WHERE x_id=? AND created_at>=?`, m.x_id, since).n >= tag.perAccountDay) return 'budget:account_day'
    if (this.db.get(`SELECT COUNT(*) n FROM tag_cards WHERE x_id=? AND closed_at IS NULL`, m.x_id).n >= tag.perAccountOpen) return 'budget:account_open'
    if (this.db.get(`SELECT COUNT(*) n FROM tag_cards WHERE created_at>=?`, this.now() - 3_600_000).n >= tag.globalPerHour) return 'budget:hour'
    if (this.db.get(`SELECT 1 FROM tag_cards WHERE wallet=? AND mint=? AND closed_at IS NULL`, wallet, mint)) return 'already_live'
    return null
  }

  async sendCreate(tweetId, id, p, mint) {
    const key = this.config.listingKey
    return this.sender.submit(`create:${tweetId}`, 'create_accept', tweetId, async () => ({
      payer: key,
      instructions: [this.prog.ix.createAccept({ server: key.publicKey, id, seller: new PublicKey(p.wallet), tokenAccount: new PublicKey(p.tokenAccount), mint: new PublicKey(p.mint), tokenProgram: mint?.tokenProgram ?? new PublicKey(p.tokenProgram), amount: p.amount, minBid: p.minBid, duration: p.seconds, window: this.config.tag.acceptWindowSeconds })],
    }))
  }

  async finishCreate(m) {
    const p = JSON.parse(m.parsed)
    const row = this.sender.latest(`create:${m.tweet_id}`)
    if (!row) { // crashed before signing
      const mintInfo = await this.rpc.account(new PublicKey(p.mint))
      return this.sendCreate(m.tweet_id, tagListingId(m.tweet_id), p, readMint(mintInfo))
    }
    if (row.status === 'signed') { await this.sender.resolve(row); if (row.status === 'signed') return this.db.run('UPDATE mentions SET next_at=? WHERE tweet_id=?', this.now() + 2000, m.tweet_id) }
    if (row.status === 'landed') return this.cardLive(m, p)
    if (row.status === 'dropped') return this.db.run(`UPDATE mentions SET state='retry', attempts=attempts+1, parsed=NULL, listing=NULL, next_at=?, updated_at=? WHERE tweet_id=?`, this.now(), this.now(), m.tweet_id)
    // Refused. If the card is on chain anyway (an earlier send we lost track of), it is live. Otherwise the program said no.
    let info
    try { info = await this.rpc.account(new PublicKey(m.listing)) } catch { return this.retry(m, 'chain_read_failed') }
    const l = this.prog.decode(new PublicKey(m.listing), info)
    if (l && l.seller.toBase58() === p.wallet) return this.cardLive(m, p)
    this.ignore(m, HOLD_ERR.test(row.err ?? '') ? 'does_not_hold' : 'create_failed')
  }

  cardLive(m, p) {
    const listing = m.listing
    const endsIn = Math.round(p.seconds / 60)
    const text = `Your card is live${p.decimals != null ? `: ${amountLine(p)}` : ''}. Bids close in ${endsIn} minute${endsIn === 1 ? '' : 's'}.${p.cpiGuard ? ' Your token account has CPI Guard on, turn it off before you accept.' : ''}\n${cardWhere(this.config, listing, 'Live now on our site, link on our profile.')}`
    this.db.tx(() => {
      this.db.run(`INSERT OR IGNORE INTO tag_cards (listing,tweet_id,x_id,handle,avatar,wallet,mint,created_at) VALUES (?,?,?,?,?,?,?,?)`, listing, m.tweet_id, m.x_id, m.handle, m.avatar, p.wallet, p.mint, this.now())
      this.db.run(`UPDATE mentions SET state='live', updated_at=? WHERE tweet_id=?`, this.now(), m.tweet_id)
      this.replies.enqueue({ kind: 'live', tweetId: m.tweet_id, xId: m.x_id, listing, text, expiresAt: this.now() + p.seconds * 1000 })
    })
    this.indexer?.touch?.(listing)
  }
}
