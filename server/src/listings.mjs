import { minimumNextBid } from './chain/program.mjs'
import { dropForListing } from './drops.mjs'

// What the API says about a listing, from the cache. A single card read tries the chain first and falls back to the
// cache marked stale, so a bad RPC minute never reads as "gone".
const FRESH_MS = 2000, CLOSED_FRESH_MS = 30_000, NEGATIVE_MS = 30_000, NEGATIVE_MAX = 5000
const NOW_S = (now) => Math.floor(now() / 1000)
const MODES = new Set(['bidding', 'fixed', 'accept'])

export function phase(r, nowS) {
  if (r.closed) return r.outcome ?? 'closed'
  if (r.state === 'gone') return 'gone'
  if (r.state === 'ghosted') return 'ghosted'
  if (r.mode === 'fixed') return r.end_time && r.end_time <= nowS ? 'expired' : 'live'
  if (r.end_time > nowS) return 'live'
  if (r.top_bid === '0') return 'expired'
  if (r.mode === 'accept') return r.end_time + r.accept_window_secs > nowS ? 'accept_window' : 'seller_ghosted'
  return 'settling'
}
const ZERO_KEY = '11111111111111111111111111111111'

export class Listings {
  constructor({ db, indexer, rpc, now = Date.now }) { Object.assign(this, { db, indexer, rpc, now }); this.flight = new Map(); this.absent = new Map() }
  view(r) {
    const nowS = NOW_S(this.now)
    const tag = this.db.get('SELECT handle, avatar, tweet_id FROM tag_cards WHERE listing=?', r.pubkey)
    // The active link only: a wallet still in its 48 hour wait doesn't carry the X name yet
    const drop = r.mode === 'bidding' ? dropForListing(this.db, r.pubkey) : null
    // A dev drop is listed on X by the coin's own account: its name stands in when the dev wallet has no X link of its own
    const seller = tag ?? this.db.get('SELECT NULLIF(u.handle, \'\') handle, u.avatar FROM wallet_links k JOIN x_users u ON u.x_id=k.x_id WHERE k.wallet=?', r.seller) ?? (drop?.author.handle ? drop.author : null)
    const credits = this.db.all(`SELECT owner, lamports FROM credits WHERE listing=? AND lamports<>'0'`, r.pubkey)
    const p = phase(r, nowS)
    return {
      pubkey: r.pubkey, mode: r.mode, phase: p, status: p === 'seller_ghosted' || p === 'ghosted' ? 'Seller ghosted' : null,
      seller: { wallet: r.seller, handle: seller?.handle ?? null, avatar: seller?.avatar ?? null },
      mint: r.mint, tokenProgram: r.token_program, tokenAccount: r.token_account, decimals: r.decimals,
      amount: r.amount, price: r.price, topBid: r.top_bid, topBidder: r.top_bid === '0' ? null : r.top_bidder, endTime: r.end_time, hardEndTime: r.hard_end_time, acceptWindowSecs: r.accept_window_secs,
      nextMinBid: r.mode === 'fixed' ? null : minimumNextBid(r.top_bid ?? '0', r.price ?? '0').toString(),
      acceptClosesAt: r.mode === 'accept' ? r.end_time + r.accept_window_secs : null,
      // The contract refuses a transaction whose expected values no longer match, so the page sends these back.
      expected: { tokenAmount: r.amount, price: r.price, bid: r.top_bid, mint: r.mint, maxEndTime: r.hard_end_time },
      // Only the seller's cancel can remove the approval. Until then the listing stays open and its rent waits.
      sellerMustCancel: !r.closed && !!r.delegate_set && (p === 'expired' || p === 'gone'),
      pass: r.pass_signer === ZERO_KEY ? null : { signer: r.pass_signer, campaign: r.campaign },
      // null means the last read failed or hasn't happened. It is not "no".
      fillable: r.fillable === null ? null : !!r.fillable,
      // When the indexer last read the seller's token account, in ms. The card shows it next to "Holds these tokens".
      tokenCheckedAt: r.token_checked_at ?? null,
      acceptBlocked: r.mode === 'accept' && r.cpi_guard ? { reason: 'cpi_guard', message: 'CPI Guard is on for this token account, so Accept will fail. Turn it off in your wallet first.' } : null,
      credits, rentPayer: r.rent_payer, tagged: tag ? { tweetId: tag.tweet_id } : null, drop, closed: !!r.closed, chainReadAt: r.chain_read_at,
    }
  }
  /** Filters: mode, phase, mint, seller, sort (ending, newest). Cursor is an offset in the sorted list. */
  list({ mode, phase: wanted, mint, seller, live, limit = 50, cursor = 0 } = {}) {
    const where = [], args = []
    if (mode) { if (!MODES.has(mode)) return { error: 'bad_mode' }; where.push('mode=?'); args.push(mode) }
    if (mint) { where.push('mint=?'); args.push(String(mint)) }
    if (seller) { where.push('seller=?'); args.push(String(seller)) }
    if (live === 'true') where.push('closed=0')
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100), off = Math.max(Number(cursor) || 0, 0)
    // Phase depends on the clock, so it's filtered after reading, over a bounded window, before any per row query runs
    const rows = this.db.all(`SELECT * FROM listings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY closed ASC, end_time ASC, pubkey ASC LIMIT ? OFFSET ?`, ...args, wanted ? 2000 : n, wanted ? 0 : off)
    if (wanted) { const nowS = NOW_S(this.now), f = rows.filter((r) => phase(r, nowS) === wanted); return { items: f.slice(off, off + n).map((r) => this.view(r)), next: off + n < f.length ? off + n : null } }
    return { items: rows.map((r) => this.view(r)), next: rows.length === n ? off + n : null }
  }
  /**
   * One card. A public route, so a read goes through the public budget, once per key per window however many ask, and an
   * address the chain says isn't a listing is remembered for a while. Out of budget or RPC down: the cached card, marked stale.
   */
  async one(pubkey) {
    let stale = false
    const had = this.db.get('SELECT chain_read_at, token_checked_at, closed FROM listings WHERE pubkey=?', pubkey)
    const age = (t) => this.now() - (t ?? 0)
    const fresh = had ? (had.closed ? age(had.chain_read_at) < CLOSED_FRESH_MS : age(had.chain_read_at) < FRESH_MS && age(had.token_checked_at) < FRESH_MS) : age(this.absent.get(pubkey)) < NEGATIVE_MS
    if (!fresh) {
      let p = this.flight.get(pubkey)
      if (!p) { p = this.indexer.refreshOne(pubkey, this.rpc?.public).finally(() => this.flight.delete(pubkey)); this.flight.set(pubkey, p) }
      try { await p } catch { stale = true }
    }
    const r = this.db.get('SELECT * FROM listings WHERE pubkey=?', pubkey)
    if (r) return { ...this.view(r), stale }
    if (stale) return { stale: true, unknown: true }
    if (this.absent.size >= NEGATIVE_MAX) this.absent.delete(this.absent.keys().next().value)
    if (!fresh) this.absent.set(pubkey, this.now())
    return null
  }
  sales({ listing, mint, limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 100)
    if (mint && !listing) return this.db.all('SELECT * FROM sales WHERE mint=? ORDER BY at DESC LIMIT ?', String(mint), n)
    return listing ? this.db.all('SELECT * FROM sales WHERE listing=? ORDER BY at DESC LIMIT ?', String(listing), n) : this.db.all('SELECT * FROM sales ORDER BY at DESC LIMIT ?', n)
  }
  creditsFor(owner) { return this.db.all(`SELECT listing, lamports FROM credits WHERE owner=? AND lamports<>'0'`, String(owner)) }
}
