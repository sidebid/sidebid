// The first hour dev drops. The dev wallet (DEV_SECRET, the coin's creator) sells 5% of supply in 12 public auctions, one
// every 5 minutes, each 1.25 times the one before. Each is a normal bidding listing of 4 minutes with the usual anti-snipe
// rules, its minimum bid 15% under the live chart price when it lists. A drop nobody bids on is cancelled and its tokens
// stay in the dev wallet: no rollover, no relist. @sidebidsol posts each drop on X the moment it lists.
//
// What the dev key may sign here, and nothing else (checkDropIxs, read before every signature):
//   create_listing, bidding mode, seller = dev, its own associated token account of the configured mint, exactly this drop's
//     amount. The contract approves its listing for exactly that amount inside the same instruction.
//   cancel of that same listing with no top bidder, once it ended with no bids. It removes the approval and returns the rent.
// The keeper pays the network fees when it is set, so the dev wallet's SOL only lends the listing rent, which comes back on
// settle or cancel. The dev key never signs a transfer, a token instruction of its own, or anything for another mint.
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { IDL, MIN_PRICE_LAMPORTS, readMint, readTokenAccount } from './chain/program.mjs'
import { OPEN } from './chain/sender.mjs'
import { hasLink } from './x/client.mjs'
import { fmtSol } from './x/replies.mjs'

export const DROP_COUNT = 12
export const DROP_TOTAL_BPS = 500n // 5% of supply
export const DROP_DISCOUNT_BPS = 1500n // minimum bid 15% under the chart
const BPS = 10_000n
// 1.25 = 5/4, so drop i weighs 5^i * 4^(11-i) and the weights add up to 5^12 - 4^12, all exact integers
const WEIGHTS = Array.from({ length: DROP_COUNT }, (_, i) => 5n ** BigInt(i) * 4n ** BigInt(DROP_COUNT - 1 - i))
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0n)
const BID_STEP = 100_000n // starting bids are rounded down to 0.0001 SOL
const CANCEL_AFTER_END_S = 20 // the chain clock can run a little behind ours: no bid can land this long after the end
const MISSED_AFTER_SLOTS = 2 // a drop that could not list within two slots of its time (an outage) is skipped, not rushed
const PRICE_TRY_MS = 90_000
const LIST_RENT_RESERVE = 4_000_000 // listing rent is about 3.1 million lamports, returned on settle or cancel
export const FINAL = new Set(['sold', 'skipped'])
const BLOCKING = new Set(['pending', 'listing', 'live', 'ending'])

export class DropGuardError extends Error { constructor(reason) { super(`drop guard: ${reason}`); this.name = 'DropGuardError'; this.reason = reason } }

/** 5% of supply. */
export const dropTotal = (supply) => (BigInt(supply) * DROP_TOTAL_BPS) / BPS
/** The 12 amounts in base units, each 1.25x the last, adding up to exactly 5% of supply (rounding goes to the last). */
export function dropAmounts(supply) {
  const total = dropTotal(supply)
  const a = WEIGHTS.map((w) => (total * w) / WEIGHT_SUM)
  a[DROP_COUNT - 1] += total - a.reduce((x, y) => x + y, 0n)
  return a
}
/** Share of supply as text with 4 decimals, from exact integers: "0.0922%". */
export const pctText = (amount, supply) => { const p = (BigInt(amount) * 2_000_000n + BigInt(supply)) / (2n * BigInt(supply)); const s = p.toString().padStart(5, '0'); return `${s.slice(0, -4).replace(/^0+(?=\d)/, '')}.${s.slice(-4)}%` }

/** Minimum bid: amount times the price (lamports per base unit, num/den), 15% off, rounded down to 0.0001 SOL, at least 0.001. */
export function minBidFor(amount, price) {
  const raw = (BigInt(amount) * BigInt(price.num) * (BPS - DROP_DISCOUNT_BPS)) / (BigInt(price.den) * BPS)
  const r = (raw / BID_STEP) * BID_STEP
  return r > MIN_PRICE_LAMPORTS ? r : MIN_PRICE_LAMPORTS
}

// ---------------------------------------------------------------- the chart price
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
const CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]) // sha256("account:BondingCurve")[0..8]
const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const bondingCurvePda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0]
/** pump.fun's bonding curve account, read by offset. Null when it is not one. */
export function readCurve(info) {
  if (!info || !info.owner.equals(PUMP_PROGRAM)) return null
  const d = Buffer.from(info.data)
  if (d.length < 49 || !d.subarray(0, 8).equals(CURVE_DISC)) return null
  return { vtok: d.readBigUInt64LE(8), vsol: d.readBigUInt64LE(16), rtok: d.readBigUInt64LE(24), rsol: d.readBigUInt64LE(32), supply: d.readBigUInt64LE(40), complete: d[48] === 1 }
}
/** A float SOL per whole token as an exact ratio of lamports per base unit. */
const fromSolPerToken = (p, decimals) => ({ num: BigInt(Math.round(p * 1e18)), den: 10n ** 9n * 10n ** BigInt(decimals) })
const ratio = (a, b) => Number(BigInt(a.num) * BigInt(b.den)) / Number(BigInt(b.num) * BigInt(a.den))
export const close = (a, b, tol = 0.1) => { const r = ratio(a, b); return Number.isFinite(r) && r > 0 && Math.abs(r - 1) <= tol }
/** SOL per whole token, for people. */
export const solPerToken = (p, decimals) => (Number(p.num) / Number(p.den)) * 10 ** decimals / 1e9

/**
 * The live chart price. Before graduation it is pump.fun's bonding curve read from chain (the price is its virtual SOL over
 * virtual tokens). After it, or for a coin that is not on pump.fun, DexScreener's deepest SOL pool checked against Jupiter:
 * if both answer they must agree within 10%, if one answers it is used alone. Every price is read twice a few seconds apart
 * and the two must agree within 10%, so a single block's swing can't set a drop's floor. No price, no drop.
 */
export class PriceFeed {
  constructor({ rpc, fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stableMs = 3000, minPoolSol = 5 }) { Object.assign(this, { rpc, fetchImpl, sleep, stableMs, minPoolSol }) }
  async dex(mint, decimals) {
    const r = await this.fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const j = await r.json()
    const pairs = (j?.pairs ?? []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint && p.quoteToken?.address === SOL_MINT && Number(p.priceNative) > 0 && Number(p.liquidity?.quote) >= this.minPoolSol)
    pairs.sort((a, b) => Number(b.liquidity.quote) - Number(a.liquidity.quote))
    return pairs[0] ? fromSolPerToken(Number(pairs[0].priceNative), decimals) : null
  }
  async jup(mint, decimals) {
    const r = await this.fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${mint},${SOL_MINT}`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const j = await r.json(), t = Number(j?.[mint]?.usdPrice), s = Number(j?.[SOL_MINT]?.usdPrice)
    return t > 0 && s > 0 ? fromSolPerToken(t / s, decimals) : null
  }
  async quote(mint, decimals) {
    const c = readCurve(await this.rpc.account(bondingCurvePda(mint)))
    if (c && !c.complete) {
      // Fresh pump.fun curves start at 30 virtual SOL and only real SOL is added to that
      if (c.vtok === 0n || c.vsol < 1_000_000_000n || c.vtok > 10n ** 18n) throw new Error('curve_looks_wrong')
      return { num: c.vsol, den: c.vtok, source: 'pump.fun bonding curve' }
    }
    const [dx, jp] = await Promise.all([this.dex(mint, decimals).catch(() => null), this.jup(mint, decimals).catch(() => null)])
    if (dx && jp) { if (!close(dx, jp, 0.1)) throw new Error('price_sources_disagree'); return { ...dx, source: 'DexScreener, checked against Jupiter' } }
    if (dx) return { ...dx, source: 'DexScreener (Jupiter did not answer)' }
    if (jp) return { ...jp, source: 'Jupiter (DexScreener did not answer)' }
    throw new Error('no_price')
  }
  async read(mint, decimals) {
    const a = await this.quote(mint, decimals)
    if (this.stableMs) await this.sleep(this.stableMs)
    const b = await this.quote(mint, decimals)
    if (!close(a, b, 0.1)) throw new Error('price_moving')
    return { num: String(b.num), den: String(b.den), source: b.source }
  }
}

// ---------------------------------------------------------------- the guard
const disc = (name) => Buffer.from(IDL.instructions.find((i) => i.name === name).discriminator)
const LIST_DISC = disc('create_listing'), CANCEL_DISC = disc('cancel')
/**
 * Read before the dev key signs anything. One instruction, to our program, and only:
 *   list: create_listing, bidding, seller = dev, the dev's own token account of the plan's mint, exactly `amount`, which must
 *         be no more than the largest drop and fit in what is left of the 5%, the plan's length, no pass;
 *   cancel: cancel of the dev's listing for that token account, with no top bidder.
 * Throws DropGuardError naming what was wrong.
 */
export function checkDropIxs(ixs, g) {
  const no = (r) => { throw new DropGuardError(r) }
  if (!Array.isArray(ixs) || ixs.length !== 1) no('one_instruction_only')
  const ix = ixs[0]
  if (!ix.programId.equals(g.programId)) no('wrong_program')
  const k = (i) => ix.keys[i]?.pubkey
  const signers = ix.keys.filter((x) => x.isSigner)
  if (signers.length !== 1 || !signers[0].pubkey.equals(g.dev)) no('dev_must_be_the_only_signer')
  if (!k(0)?.equals(g.dev)) no('seller_not_dev')
  if (!g.mint || !g.configuredMint || !new PublicKey(g.mint).equals(new PublicKey(g.configuredMint))) no('mint_not_configured')
  const ata = getAssociatedTokenAddressSync(new PublicKey(g.mint), g.dev, false, new PublicKey(g.tokenProgram))
  const listing = PublicKey.findProgramAddressSync([Buffer.from('listing'), ata.toBuffer()], g.programId)[0]
  if (!k(1)?.equals(listing)) no('wrong_listing')
  const d = Buffer.from(ix.data)
  if (g.kind === 'list') {
    if (d.length !== 34 || !d.subarray(0, 8).equals(LIST_DISC)) no('not_create_listing')
    if (!k(3)?.equals(ata) || !k(4)?.equals(new PublicKey(g.mint)) || !k(5)?.equals(new PublicKey(g.tokenProgram))) no('wrong_token_account')
    const mode = d[8], amount = d.readBigUInt64LE(9), price = d.readBigUInt64LE(17), duration = d.readBigUInt64LE(25), pass = d[33]
    if (mode !== 0) no('not_bidding')
    if (pass !== 0) no('pass_not_allowed')
    if (amount !== BigInt(g.amount)) no('amount_not_this_drop')
    if (amount <= 0n || amount > BigInt(g.maxAmount)) no('amount_over_drop_cap')
    if (amount > BigInt(g.roomLeft)) no('amount_over_total_cap')
    if (price < MIN_PRICE_LAMPORTS) no('price_too_low')
    if (duration !== BigInt(g.lengthS)) no('wrong_length')
    return true
  }
  if (g.kind === 'cancel') {
    if (d.length !== 8 || !d.subarray(0, 8).equals(CANCEL_DISC)) no('not_cancel')
    if (!k(4)?.equals(ata)) no('wrong_token_account')
    if (!k(5)?.equals(g.programId) || !k(6)?.equals(g.programId)) no('cancel_with_bidder')
    return true
  }
  no('unknown_kind')
}

// ---------------------------------------------------------------- post text
const tokensText = (amount, decimals) => { const w = BigInt(amount) / 10n ** BigInt(decimals); return w.toString().replace(/\B(?=(\d{3})+$)/g, ',') }
export const lengthWords = (s) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`)
/** "Drop 3 of 12 is live: 1,441,300 $SIDEBID, starting bid 0.1234 SOL, ends in 4 minutes." With links on, the lot link after. */
export function dropPostText({ n, of = DROP_COUNT, amount, decimals, ticker, minBid, lengthS, link = null }) {
  const t = `Drop ${n} of ${of} is live: ${tokensText(amount, decimals)} $${ticker}, starting bid ${fmtSol(minBid)} SOL, ends in ${lengthWords(lengthS)}.`
  return link ? `${t}\n${link}` : t
}

const POST_RETRY = ['rate', 'network', 'server']

export class Drops {
  /**
   * poster: { post(text, { png }) -> { id, media, url?, preview? }, profile() -> author }. Defaults to the X client. The preview
   * passes its own, which never calls X.
   */
  constructor({ db, config, flags, rpc, sender, prog, indexer, listings = null, x = null, feed = null, poster = null, card = null, now = Date.now, log = () => {}, previewChain = process.env.PREVIEW_CHAIN === '1' }) {
    Object.assign(this, { db, config, flags, rpc, sender, prog, indexer, listings, x, now, log, previewChain })
    this.dev = config.devKey
    this.feed = feed ?? new PriceFeed({ rpc })
    this.card = card
    this.poster = poster ?? (x ? { post: (text, o) => x.post(text, o), profile: () => x.profile(), ready: () => x.canPost() } : null)
    this.running = false
    this.status_ = { lastTick: null, lastError: null }
  }
  plan() { return this.db.get('SELECT * FROM drop_plans ORDER BY id DESC LIMIT 1') ?? null }
  rows(planId) { return this.db.all('SELECT * FROM drops WHERE plan=? ORDER BY idx', planId) }
  set(r, fields) {
    const keys = Object.keys(fields)
    this.db.run(`UPDATE drops SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE plan=? AND idx=?`, ...keys.map((k) => fields[k]), this.now(), r.plan, r.idx)
    Object.assign(r, fields)
  }
  ata(plan) { return getAssociatedTokenAddressSync(new PublicKey(plan.mint), this.dev.publicKey, false, new PublicKey(plan.token_program)) }
  listingOf(plan) { return this.prog.listingPda(this.ata(plan)) }
  /** The mint drops may sell: DROPS_MINT when set, and always the plan's own; the plan's must equal DROPS_MINT if both exist. */
  configuredMint(plan) { return this.config.drops?.mint ?? plan.mint }
  /** Every drop of this mint ever listed from a launch plan, plus this plan's: the 5% can never be listed twice. */
  listedSoFar(plan, self = null) {
    const rows = (plan.preview ? this.db.all('SELECT plan, idx, amount FROM drops WHERE plan=? AND list_sig IS NOT NULL', plan.id)
      : this.db.all('SELECT d.plan, d.idx, d.amount FROM drops d JOIN drop_plans p ON p.id=d.plan WHERE p.mint=? AND p.preview=0 AND d.list_sig IS NOT NULL', plan.mint))
      .filter((x) => !self || x.plan !== self.plan || x.idx !== self.idx) // a retry of this same drop is not a second listing
    return rows.reduce((a, r) => a + BigInt(r.amount), 0n)
  }
  guardFor(plan, r, kind) {
    const amounts = dropAmounts(BigInt(plan.supply))
    return { programId: this.prog.programId, dev: this.dev.publicKey, mint: plan.mint, configuredMint: this.configuredMint(plan), tokenProgram: plan.token_program, kind, amount: r.amount, maxAmount: amounts[DROP_COUNT - 1], roomLeft: dropTotal(BigInt(plan.supply)) - this.listedSoFar(plan, r), lengthS: plan.length_s }
  }
  /** The one place the dev key signs. The guard and the kill switch are read inside the build, right before signing. */
  signAndSend(plan, r, kind, key, instructions) {
    return this.sender.submit(key, kind === 'list' ? 'drop_list' : 'drop_cancel', `${plan.id}:${r.idx}`, async () => {
      if (kind === 'list' && !this.flags.dropsOn) throw new DropGuardError('drops_paused')
      checkDropIxs(instructions, this.guardFor(plan, r, kind))
      const payer = this.config.keeperKey ?? this.dev
      return { instructions, payer, signers: payer === this.dev ? [] : [this.dev] }
    })
  }

  // ---------------------------------------------------------------- start
  /**
   * Fixes the plan: the mint (the revealed CA), its supply and the 12 amounts, the first drop's time and the clock. Refused
   * once any drop of an earlier plan for this mint was listed. `preview` plans exist only on the preview's test chain.
   */
  async start({ firstAt, ca, replace = false, preview = false, author = null }) {
    if (!this.dev) return { error: 'no_dev_key' }
    if (preview && !this.previewChain) return { error: 'preview_only' }
    if (!ca) return { error: 'not_revealed' }
    let mint
    try { mint = new PublicKey(ca) } catch { return { error: 'bad_address' } }
    if (this.config.drops?.mint && this.config.drops.mint !== mint.toBase58()) return { error: 'mint_not_configured' }
    const at = typeof firstAt === 'number' ? firstAt : Date.parse(firstAt)
    if (!Number.isFinite(at) || at < this.now() - 60_000 || at > this.now() + 86_400_000) return { error: 'bad_time', hint: 'firstAt: an ISO time or ms, from now to 24 hours ahead' }
    if (!this.flags.keeperOn) return { error: 'keeper_off', hint: 'Turn keeperLive on first: it settles every drop that gets a bid' }
    const prior = this.db.get('SELECT p.id FROM drop_plans p JOIN drops d ON d.plan=p.id WHERE p.mint=? AND p.preview=0 AND d.list_sig IS NOT NULL LIMIT 1', mint.toBase58())
    if (prior && !preview) return { error: 'already_started' }
    const cur = this.plan()
    if (cur && !replace && this.rows(cur.id).some((r) => !FINAL.has(r.state))) return { error: 'plan_running', hint: 'Send replace: true to replace a plan none of whose drops has listed' }
    if (cur && replace && !preview && this.rows(cur.id).some((r) => r.list_sig)) return { error: 'already_started' }
    let info, tok
    try { info = await this.rpc.account(mint) } catch { return { error: 'chain_read_failed' } }
    const m = readMint(info)
    if (!m) return { error: 'not_a_mint' }
    try { tok = await this.rpc.account(getAssociatedTokenAddressSync(mint, this.dev.publicKey, false, m.tokenProgram)) } catch { return { error: 'chain_read_failed' } }
    if (!m.allowed) return { error: 'mint_not_allowed_by_contract' }
    const supply = Buffer.from(info.data).readBigUInt64LE(36)
    const amounts = dropAmounts(supply), total = dropTotal(supply)
    const view = readTokenAccount(tok, m.tokenProgram)
    if (!view || !view.owner.equals(this.dev.publicKey)) return { error: 'dev_has_no_token_account' }
    if (view.amount < total) return { error: 'dev_tokens_short', has: view.amount.toString(), needs: total.toString() }
    if (!author) author = await this.author()
    const every = this.config.drops.everySeconds * 1000, len = this.config.drops.lengthSeconds
    this.db.tx(() => {
      if (cur && replace) { this.db.run(`UPDATE drops SET state='skipped', reason='replaced', updated_at=? WHERE plan=? AND state='pending'`, this.now(), cur.id) }
      const id = Number(this.db.run('INSERT INTO drop_plans (mint,token_program,decimals,supply,total,seller,first_at,every_ms,length_s,author,preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', mint.toBase58(), m.tokenProgram.toBase58(), m.decimals, supply.toString(), total.toString(), this.dev.publicKey.toBase58(), at, every, len, author ? JSON.stringify(author) : null, preview ? 1 : 0, this.now()).lastInsertRowid)
      amounts.forEach((a, i) => this.db.run(`INSERT INTO drops (plan,idx,at,amount,state,updated_at) VALUES (?,?,?,?,'pending',?)`, id, i, at + i * every, a.toString(), this.now()))
    })
    this.log('[drops] plan started', mint.toBase58(), new Date(at).toISOString())
    return this.status()
  }
  /** Name, handle, picture of the posting account: from X (one user read), else the account signed in on this site. */
  async author() {
    const handle = this.config.x?.handle ?? 'sidebidsol'
    try { const p = await this.poster?.profile?.(); if (p?.handle) return p } catch (e) { this.log('[drops] profile', e.message) }
    const u = this.db.get('SELECT handle, avatar FROM x_users WHERE lower(handle)=? ORDER BY updated_at DESC LIMIT 1', handle.toLowerCase())
    return { name: this.config.brand?.name ?? 'Sidebid', handle: u?.handle ?? handle, avatar: u?.avatar ?? null, verified: false }
  }

  // ---------------------------------------------------------------- the clock
  async tick() {
    if (this.running || !this.dev) return
    this.running = true
    try {
      const plan = this.plan()
      if (!plan) return
      const rows = this.rows(plan.id)
      for (const r of rows) if (r.state === 'closed') await this.resolveClosed(plan, r)
      for (const r of rows) if (r.state === 'live' && r.post_state === null) await this.postDrop(plan, r)
      for (const r of rows) if (r.state === 'live' && r.post_state === 'retry') await this.postDrop(plan, r)
      const cur = rows.find((r) => BLOCKING.has(r.state))
      if (cur && this.now() >= cur.next_at) await this.advance(plan, cur)
      this.status_.lastTick = this.now(); this.status_.lastError = null
    } catch (e) { this.status_.lastError = String(e.message).slice(0, 200); throw e } finally { this.running = false }
  }
  skip(r, reason, extra = {}) { this.set(r, { state: 'skipped', reason, ...extra }); this.log('[drops] skipped', r.idx + 1, reason) }
  async readListing(plan) { const k = this.listingOf(plan); return this.prog.decode(k, await this.rpc.account(k)) }

  async advance(plan, r) {
    const key = `drop:${plan.id}:${r.idx}`
    if (r.state === 'pending') {
      if (this.now() < r.at) return
      if (!this.flags.dropsOn) return this.skip(r, 'paused')
      if (this.now() > r.at + MISSED_AFTER_SLOTS * plan.every_ms) return this.skip(r, 'missed')
      // One live listing per token account: the last drop has to be settled or cancelled first
      const ata = this.ata(plan), lk = this.listingOf(plan)
      let infos
      try { infos = await this.rpc.accounts([lk, ata, this.dev.publicKey]) } catch { return this.set(r, { next_at: this.now() + 3000 }) }
      if (infos[0]) return this.set(r, { reason: 'waiting_for_last_drop', next_at: this.now() + 2000 })
      const view = readTokenAccount(infos[1], new PublicKey(plan.token_program))
      if (!view || view.amount < BigInt(r.amount)) return this.skip(r, 'dev_tokens_short')
      if ((infos[2]?.lamports ?? 0) < LIST_RENT_RESERVE) return this.skip(r, 'dev_sol_short')
      let price
      try { price = await this.feed.read(plan.mint, plan.decimals) } catch (e) {
        if (this.now() > r.at + PRICE_TRY_MS) return this.skip(r, 'no_price', { post_err: String(e.message).slice(0, 200) })
        return this.set(r, { reason: `price: ${String(e.message).slice(0, 60)}`, tries: r.tries + 1, next_at: this.now() + 5000 })
      }
      if (!this.flags.dropsOn) return this.skip(r, 'paused')
      const minBid = minBidFor(r.amount, price)
      const ix = this.prog.ix.createBidding({ seller: this.dev.publicKey, tokenAccount: ata, mint: new PublicKey(plan.mint), tokenProgram: new PublicKey(plan.token_program), amount: BigInt(r.amount), minBid, duration: plan.length_s })
      let row
      try { row = await this.signAndSend(plan, r, 'list', key, [ix]) } catch (e) {
        if (e instanceof DropGuardError) return this.skip(r, e.reason)
        return this.set(r, { reason: `send: ${String(e.message).slice(0, 60)}`, next_at: this.now() + 3000 })
      }
      if (row.status === OPEN) await this.sender.resolve(row, { rebroadcast: false }) // usually confirmed by now
      this.set(r, { state: 'listing', reason: null, price_num: price.num, price_den: price.den, price_source: price.source, min_bid: minBid.toString(), listing: lk.toBase58(), list_sig: row.sig })
      return this.afterList(plan, r, row)
    }
    if (r.state === 'listing') {
      const row = this.sender.latest(key)
      if (!row) return this.skip(r, 'list_lost')
      if (row.status === OPEN) await this.sender.resolve(row)
      return this.afterList(plan, r, row)
    }
    if (r.state === 'live') {
      let l
      try { l = await this.readListing(plan) } catch { return this.set(r, { next_at: this.now() + 3000 }) }
      const nowS = Math.floor(this.now() / 1000)
      if (!l) { this.indexer?.touch(r.listing); this.set(r, { state: 'closed' }); return this.resolveClosed(plan, r) }
      if (l.endTime !== r.end_time) this.set(r, { end_time: l.endTime })
      if (nowS < l.endTime) return this.set(r, { next_at: Math.min((l.endTime - 1) * 1000, this.now() + 5000) })
      if (l.topBid > 0n) return this.set(r, { reason: 'settling', next_at: this.now() + 2000 }) // the keeper settles it
      if (nowS < l.endTime + CANCEL_AFTER_END_S) return this.set(r, { next_at: (l.endTime + CANCEL_AFTER_END_S) * 1000 })
      // Ended with no bids: cancel, which removes the approval and returns the rent. The tokens never moved.
      const ix = this.prog.ix.cancelNoBids({ seller: this.dev.publicKey, tokenAccount: this.ata(plan), tokenProgram: new PublicKey(plan.token_program) })
      let row
      try { row = await this.signAndSend(plan, r, 'cancel', `${key}:cancel`, [ix]) } catch (e) { return this.set(r, { reason: `cancel: ${String(e.message).slice(0, 60)}`, next_at: this.now() + 5000 }) }
      if (row.status === OPEN) await this.sender.resolve(row, { rebroadcast: false })
      this.set(r, { state: 'ending', cancel_sig: row.sig })
      return this.afterCancel(plan, r, row)
    }
    if (r.state === 'ending') {
      const row = this.sender.latest(`${key}:cancel`)
      if (row?.status === OPEN) await this.sender.resolve(row)
      return this.afterCancel(plan, r, row)
    }
  }
  async afterList(plan, r, row) {
    if (row.status === 'landed') {
      let l
      try { l = await this.readListing(plan) } catch { return this.set(r, { next_at: this.now() + 1000 }) }
      if (!l) return this.set(r, { state: 'closed', listed_at: this.now() })
      this.set(r, { state: 'live', listed_at: this.now(), end_time: l.endTime, reason: null })
      this.indexer?.touch(r.listing)
      await this.indexer?.refreshOne?.(r.listing).catch(() => {})
      this.log('[drops] listed', r.idx + 1, r.listing)
      return this.postDrop(plan, r)
    }
    if (row.status === OPEN) return this.set(r, { next_at: this.now() + 1500 })
    // Refused in preflight or expired unsent: nothing landed, so it may try again from the top (fresh price) a few times
    // within its own slot. A transaction that landed and failed is not retried. Either way the tokens stay where they are.
    if ((row.status === 'rejected' || row.status === 'dropped') && r.tries < 3 && this.now() < r.at + plan.every_ms) return this.set(r, { state: 'pending', tries: r.tries + 1, reason: `list_${row.status}`, post_err: String(row.err ?? '').slice(0, 200), next_at: this.now() + 2000 })
    return this.skip(r, `list_${row.status}`, { post_err: String(row.err ?? '').slice(0, 200) })
  }
  async afterCancel(plan, r, row) {
    if (row?.status === 'landed') return this.skip(r, 'no_bids')
    if (row?.status === OPEN) return this.set(r, { next_at: this.now() + 1500 })
    // Refused: read again from the top, a bid may have landed against our clock
    return this.set(r, { state: 'live', reason: `cancel_${row?.status ?? 'lost'}`, next_at: this.now() + 3000 })
  }
  /** The listing account is gone. A Settled event means sold; a Cancelled event means the dev cancelled by hand. */
  async resolveClosed(plan, r) {
    const since = Math.floor((r.listed_at ?? r.at) / 1000) - 60
    const s = this.db.get(`SELECT sig, price, winner FROM sales WHERE listing=? AND kind='Settled' AND amount=? AND (at IS NULL OR at>=?) ORDER BY at LIMIT 1`, r.listing, r.amount, since)
    if (s) { this.set(r, { state: 'sold', reason: null, sale_sig: s.sig, sold_lamports: s.price, winner: s.winner }); this.log('[drops] sold', r.idx + 1, s.price); return }
    const c = this.db.get(`SELECT sig FROM events_seen WHERE listing=? AND name='Cancelled' AND (at IS NULL OR at>=?) ORDER BY at LIMIT 1`, r.listing, since)
    if (c) this.skip(r, 'cancelled', { cancel_sig: r.cancel_sig ?? c.sig })
  }

  // ---------------------------------------------------------------- the post
  async postDrop(plan, r) {
    if (!this.poster) return this.set(r, { post_state: 'off', post_err: 'no X client' })
    if (!this.flags.dropsOn) return this.set(r, { post_state: 'paused' })
    if (this.poster.ready && !this.poster.ready()) return this.set(r, { post_state: 'off', post_err: 'X post credentials not set' })
    // Only while the drop is still open: a post for a drop that already ended would send people to nothing
    if (r.end_time && this.now() >= r.end_time * 1000) return this.set(r, { post_state: 'late' })
    const links = !!this.config.x?.dropPostLinks
    const text = dropPostText({ n: r.idx + 1, amount: r.amount, decimals: plan.decimals, ticker: this.config.brand?.ticker ?? 'SIDEBID', minBid: r.min_bid, lengthS: plan.length_s, link: links ? `${this.config.publicUrl}/lot/${r.listing}` : null })
    if (!links && hasLink(text)) return this.set(r, { post_state: 'failed', post_err: 'text would bill as a link' })
    let png = null
    if (this.card && this.listings && this.config.x?.dropPostMedia !== false) {
      try { const lr = this.db.get('SELECT * FROM listings WHERE pubkey=?', r.listing); if (lr) png = await this.card(this.listings.view(lr), this.config.brand) } catch (e) { this.log('[drops] card', e.message) }
    }
    this.set(r, { post_state: 'posting', post_text: text, post_tries: r.post_tries + 1 })
    try {
      const out = await this.poster.post(text, { png })
      const author = JSON.parse(plan.author ?? 'null')
      const url = out.url !== undefined ? out.url : out.id ? `https://x.com/${author?.handle ?? this.config.x?.handle ?? 'sidebidsol'}/status/${out.id}` : null
      this.set(r, { post_state: out.preview ? 'preview' : 'posted', post_id: out.id ?? null, post_url: url, post_at: this.now(), post_media: out.media ? 1 : 0, post_err: null })
      this.log('[drops] posted', r.idx + 1, url ?? '')
    } catch (e) {
      if (e.kind === 'duplicate') return this.set(r, { post_state: 'posted', post_at: this.now(), post_err: 'X said duplicate: an earlier try went out' })
      if (POST_RETRY.includes(e.kind) && r.post_tries < 3) return this.set(r, { post_state: 'retry', post_err: String(e.message).slice(0, 200) })
      this.set(r, { post_state: 'failed', post_err: String(e.message).slice(0, 200) })
    }
  }
  /** Startup: a post caught mid-send may or may not have gone out, and is not sent again. */
  recover() { this.db.run(`UPDATE drops SET post_state='unknown' WHERE post_state='posting'`) }

  // ---------------------------------------------------------------- views
  postOf(plan, r) {
    if (!r.post_state || !['posted', 'preview'].includes(r.post_state)) return null
    const a = JSON.parse(plan.author ?? 'null') ?? {}
    return { id: r.post_id, url: r.post_url, text: r.post_text, at: r.post_at, media: !!r.post_media, preview: r.post_state === 'preview', author: { name: a.name ?? null, handle: a.handle ?? null, avatar: a.avatar ?? null, verified: !!a.verified } }
  }
  publicRow(plan, r) {
    return {
      n: r.idx + 1, of: DROP_COUNT, at: r.at, amount: r.amount, pct: pctText(r.amount, plan.supply), state: r.state === 'closed' ? 'settling' : r.state === 'live' && r.reason === 'settling' ? 'settling' : r.state,
      skipped: r.state === 'skipped' ? r.reason : null, listing: r.listing, minBid: r.min_bid, endTime: r.end_time, listSig: r.list_sig, cancelSig: r.cancel_sig, saleSig: r.sale_sig, soldLamports: r.sold_lamports, winner: r.winner,
      priceSource: r.price_source, post: this.postOf(plan, r),
    }
  }
  /** The site's view: the plan and every drop with its outcome and post. Nothing secret. */
  publicView() {
    const plan = this.plan()
    if (!plan) return { plan: null, drops: [] }
    const a = JSON.parse(plan.author ?? 'null')
    return { plan: { mint: plan.mint, seller: plan.seller, decimals: plan.decimals, supply: plan.supply, total: plan.total, firstAt: plan.first_at, everyMs: plan.every_ms, lengthS: plan.length_s, count: DROP_COUNT, author: a, preview: !!plan.preview }, drops: this.rows(plan.id).map((r) => this.publicRow(plan, r)) }
  }
  /** The admin view: the public one plus reasons, post errors and totals. */
  status() {
    const plan = this.plan(), v = this.publicView()
    if (!plan) return { ...v, paused: !this.flags.dropsOn, running: this.status_ }
    const rows = this.rows(plan.id)
    const sum = (f) => rows.filter(f).reduce((a, r) => a + BigInt(r.sold_lamports ?? 0), 0n)
    return {
      ...v, paused: !this.flags.dropsOn, running: this.status_,
      drops: rows.map((r) => ({ ...this.publicRow(plan, r), reason: r.reason, postState: r.post_state, postUrl: r.post_url, postErr: r.post_err })),
      totals: { listed: rows.filter((r) => r.list_sig).length, sold: rows.filter((r) => r.state === 'sold').length, skipped: rows.filter((r) => r.state === 'skipped').length, pending: rows.filter((r) => r.state === 'pending').length,
        solReceivedLamports: sum((r) => r.state === 'sold').toString(), tokensSold: rows.filter((r) => r.state === 'sold').reduce((a, r) => a + BigInt(r.amount), 0n).toString(), posts: rows.filter((r) => r.post_url).map((r) => r.post_url) },
    }
  }
}

/** For a listing card: the drop now occupying this listing address, if it is one. */
export function dropForListing(db, pubkey) {
  const r = db.get('SELECT d.*, p.author, p.supply, p.length_s FROM drops d JOIN drop_plans p ON p.id=d.plan WHERE d.listing=? AND d.listed_at IS NOT NULL ORDER BY d.plan DESC, d.idx DESC LIMIT 1', pubkey)
  if (!r) return null
  const a = JSON.parse(r.author ?? 'null') ?? {}
  const post = ['posted', 'preview'].includes(r.post_state) ? { id: r.post_id, url: r.post_url, text: r.post_text, at: r.post_at, preview: r.post_state === 'preview', author: { name: a.name ?? null, handle: a.handle ?? null, avatar: a.avatar ?? null, verified: !!a.verified } } : null
  return { n: r.idx + 1, of: DROP_COUNT, pct: pctText(r.amount, r.supply), author: { handle: a.handle ?? null, avatar: a.avatar ?? null, name: a.name ?? null }, post }
}
