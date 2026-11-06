// The one file that knows the contract. Instruction names, account order, signer and writable flags, and discriminators
// all come from the IDL in server/idl, which a test holds byte for byte equal to program/idl. Argument bytes are written
// here and proven against the real program in the tests.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'

export const IDL = JSON.parse(readFileSync(new URL('../../idl/sidebid.json', import.meta.url)))
export const MIN_PRICE_LAMPORTS = 1_000_000n
export const SNIPE_WINDOW_SECS = 15
export const SETTLE_GRACE_SECS = 86_400
export const LISTING_SIZE = 317
export const MIN_AUCTION_SECS = 10
export const MAX_AUCTION_SECS = 3600
export const MIN_ACCEPT_WINDOW_SECS = 60
export const MAX_ACCEPT_WINDOW_SECS = 3600
const MIN_RAISE_LAMPORTS = 1_000_000n
const MODES = ['bidding', 'fixed', 'accept']
const STATES = ['live', 'gone', 'ghosted']
export const PASS_DOMAIN = Buffer.from('SIDEBID_PASS_V1\0')
const ZERO = PublicKey.default

const u64 = (v) => { const b = Buffer.alloc(8); const n = BigInt(v); if (n < 0n || n >= 1n << 64n) throw new RangeError('u64'); b.writeBigUInt64LE(n); return b }
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const LISTING_DISC = Buffer.from(IDL.accounts.find((a) => a.name === 'Listing').discriminator)
const EVENT_BY_DISC = new Map(IDL.events.map((e) => [Buffer.from(e.discriminator).toString('hex'), e.name]))

export function program(programId) {
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0]
  const listingPda = (tokenAccount) => pda(Buffer.from('listing'), tokenAccount.toBuffer())
  const acceptPda = (id) => pda(Buffer.from('accept'), id)
  const vaultPda = (listing) => pda(Buffer.from('vault'), listing.toBuffer())
  const creditPda = (listing, owner) => pda(Buffer.from('credit'), listing.toBuffer(), owner.toBuffer())
  const claimPda = (signer, campaign, hash) => pda(Buffer.from('claim'), signer.toBuffer(), campaign.toBuffer(), hash)

  /** Builds from the IDL. A required account left out throws, and an optional one is the program id, as Anchor expects. */
  function build(name, accounts, ...args) {
    const def = IDL.instructions.find((i) => i.name === name)
    if (!def) throw new Error(`no instruction ${name}`)
    const keys = def.accounts.map((a) => {
      if (a.name === 'system_program') return { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      if (a.name === 'instructions') return { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }
      const k = accounts[a.name]
      if (!k) {
        if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false }
        throw new Error(`${name}: missing ${a.name}`)
      }
      return { pubkey: k, isSigner: !!a.signer, isWritable: !!a.writable }
    })
    return new TransactionInstruction({ programId, keys, data: Buffer.concat([Buffer.from(def.discriminator), ...args]) })
  }

  const ix = {
    createAccept: ({ server, id, seller, tokenAccount, mint, tokenProgram, amount, minBid, duration, window }) => {
      const listing = acceptPda(id)
      return build('create_accept_listing', { server, listing, vault: vaultPda(listing), seller, seller_token_account: tokenAccount, mint, token_program: tokenProgram }, id, u64(amount), u64(minBid), u64(duration), u64(window))
    },
    settle: (l, winnerToken) => build('settle', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller: l.seller, seller_credit: creditPda(l.pubkey, l.seller), seller_token_account: l.tokenAccount, mint: l.mint, winner_token_account: winnerToken, token_program: l.tokenProgram }),
    refund: (l) => {
      const has = l.topBid > 0n
      return build('refund', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, top_bidder: has ? l.topBidder : null, top_bidder_credit: has ? creditPda(l.pubkey, l.topBidder) : null })
    },
    close: (l) => build('close_listing', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, rent_receiver: l.rentPayer, rent_receiver_credit: creditPda(l.pubkey, l.rentPayer) }),
    // For the site's client code. The server never signs these.
    accept: (l, sellerToken, winnerToken) => build('accept', { seller: l.seller, listing: l.pubkey, vault: vaultPda(l.pubkey), seller_credit: creditPda(l.pubkey, l.seller), seller_token_account: sellerToken, mint: l.mint, winner_token_account: winnerToken, rent_receiver: l.rentPayer, rent_receiver_credit: creditPda(l.pubkey, l.rentPayer), token_program: l.tokenProgram }, u64(l.amount), u64(l.topBid)),
    bid: (l, bidder, amount) => {
      const has = l.topBid > 0n
      return build('place_bid', { bidder, listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, prev_bidder: has ? l.topBidder : null, prev_bidder_credit: has ? creditPda(l.pubkey, l.topBidder) : null }, u64(amount), u64(l.amount), l.mint.toBuffer(), i64(l.hardEndTime))
    },
    buy: (l, buyer, buyerToken) => build('buy_fixed', { buyer, listing: l.pubkey, seller: l.seller, seller_credit: creditPda(l.pubkey, l.seller), seller_token_account: l.tokenAccount, mint: l.mint, buyer_token_account: buyerToken, token_program: l.tokenProgram }, u64(l.price), u64(l.amount)),
    buyWithPass: (l, buyer, buyerToken, hash, expiry) => build('buy_fixed_with_pass', { buyer, listing: l.pubkey, claim: claimPda(l.passSigner, l.campaign, hash), seller: l.seller, seller_credit: creditPda(l.pubkey, l.seller), seller_token_account: l.tokenAccount, mint: l.mint, buyer_token_account: buyerToken, token_program: l.tokenProgram }, hash, i64(expiry), u64(l.price), u64(l.amount)),
    claimCredit: (owner, listing, destination) => build('claim_credit', { owner, credit: creditPda(listing, owner), destination }, listing.toBuffer()),
    // Signed by the server only in src/drops.mjs, with the dev key, and only after checkDropIxs passes: a bidding listing
    // (the contract approves exactly `amount` inside it), and a cancel of that same listing once it ended with no bids.
    createBidding: ({ seller, tokenAccount, mint, tokenProgram, amount, minBid, duration }) => {
      const listing = listingPda(tokenAccount)
      return build('create_listing', { seller, listing, vault: vaultPda(listing), seller_token_account: tokenAccount, mint, token_program: tokenProgram }, Buffer.from([0]), u64(amount), u64(minBid), u64(duration), Buffer.from([0]))
    },
    cancelNoBids: ({ seller, tokenAccount, tokenProgram }) => {
      const listing = listingPda(tokenAccount)
      return build('cancel', { seller, listing, vault: vaultPda(listing), seller_credit: creditPda(listing, seller), seller_token_account: tokenAccount, top_bidder: null, top_bidder_credit: null, token_program: tokenProgram })
    },
  }

  const passMessage = (campaign, buyer, hash, expiry) => Buffer.concat([PASS_DOMAIN, programId.toBuffer(), campaign.toBuffer(), buyer.toBuffer(), hash, i64(expiry)])
  /** The only way to read a Listing: an account some other program owns is not one, whatever its bytes say. */
  const decode = (pubkey, info) => (info && info.owner.equals(programId) ? decodeListingBytes(pubkey, info.data) : null)
  return { programId, listingPda, acceptPda, vaultPda, creditPda, claimPda, ix, passMessage, decode }
}

/** The lowest bid the contract takes next: the price with no bids, then the top bid plus 2% rounded up or 0.001 SOL. */
export function minimumNextBid(topBid, price) {
  const top = BigInt(topBid)
  if (top === 0n) { const p = BigInt(price); return p > MIN_PRICE_LAMPORTS ? p : MIN_PRICE_LAMPORTS }
  const raise = (top + 49n) / 50n
  return top + (raise > MIN_RAISE_LAMPORTS ? raise : MIN_RAISE_LAMPORTS)
}

function decodeListingBytes(pubkey, data) {
  const b = Buffer.from(data)
  if (b.length < LISTING_SIZE || !b.subarray(0, 8).equals(LISTING_DISC)) return null
  const pk = (o) => new PublicKey(b.subarray(o, o + 32))
  const mode = MODES[b[264]], state = STATES[b[265]]
  if (!mode || !state) return null
  return {
    pubkey, seller: pk(8), tokenAccount: pk(40), mint: pk(72), tokenProgram: pk(104), amount: b.readBigUInt64LE(136), price: b.readBigUInt64LE(144), endTime: Number(b.readBigInt64LE(152)),
    topBidder: pk(160), topBid: b.readBigUInt64LE(192), passSigner: pk(200), campaign: pk(232), mode, state, decimals: b[266], rentPayer: pk(269), acceptWindowSecs: Number(b.readBigInt64LE(301)), hardEndTime: Number(b.readBigInt64LE(309)),
  }
}

const LAYOUT = {
  Listed: ['listing:pk', 'seller:pk', 'mint:pk', 'amount:u64', 'price:u64', 'endTime:i64', 'mode:mode'],
  BidPlaced: ['listing:pk', 'bidder:pk', 'amount:u64', 'endTime:i64'],
  Settled: ['listing:pk', 'winner:pk', 'seller:pk', 'amount:u64', 'price:u64'],
  Accepted: ['listing:pk', 'winner:pk', 'seller:pk', 'amount:u64', 'price:u64'],
  MarkedGone: ['listing:pk', 'bidder:pk', 'refunded:u64'],
  Cancelled: ['listing:pk', 'refunded:u64'],
  Bought: ['listing:pk', 'buyer:pk', 'seller:pk', 'amount:u64', 'price:u64'],
  CreditParked: ['listing:pk', 'owner:pk', 'amount:u64'],
}
function decodeEvent(bytes) {
  const name = EVENT_BY_DISC.get(bytes.subarray(0, 8).toString('hex'))
  if (!name) return null
  const out = { name }
  let o = 8
  try {
    for (const f of LAYOUT[name]) {
      const [k, t] = f.split(':')
      if (t === 'pk') { out[k] = new PublicKey(bytes.subarray(o, o + 32)).toBase58(); if (o + 32 > bytes.length) return null; o += 32 }
      else if (t === 'u64') { out[k] = bytes.readBigUInt64LE(o).toString(); o += 8 }
      else if (t === 'i64') { out[k] = Number(bytes.readBigInt64LE(o)); o += 8 }
      else if (t === 'mode') { out[k] = MODES[bytes[o]]; o += 1 }
    }
  } catch { return null }
  return out
}

/**
 * Events from a transaction's logs. Walks the invoke stack, so "Program data" printed by any other program in the same
 * transaction, or by a program this one calls, is not believed.
 */
export function parseEvents(logs, programId) {
  const me = programId.toBase58(), stack = [], events = []
  for (const line of logs ?? []) {
    let m
    if ((m = /^Program (\S+) invoke \[\d+\]$/.exec(line))) { stack.push(m[1]); continue }
    if (/^Program \S+ (success|failed: .*)$/.test(line)) { stack.pop(); continue }
    if ((m = /^Program data: (\S+)$/.exec(line)) && stack.at(-1) === me) {
      const e = decodeEvent(Buffer.from(m[1], 'base64'))
      if (e) events.push(e)
    }
  }
  return events
}

const TOKEN_ACCOUNT_LEN = 165
const CPI_GUARD_EXT = 11
/** Token account fields read by offset, the same way the program reads them. Null means not a usable token account. */
export function readTokenAccount(info, tokenProgram) {
  if (!info || !info.owner.equals(tokenProgram)) return null
  const d = Buffer.from(info.data)
  if (d.length < TOKEN_ACCOUNT_LEN) return null
  const st = d[108]
  if (st !== 1 && st !== 2) return null
  const view = {
    mint: new PublicKey(d.subarray(0, 32)), owner: new PublicKey(d.subarray(32, 64)), amount: d.readBigUInt64LE(64),
    delegate: d.readUInt32LE(72) === 1 ? new PublicKey(d.subarray(76, 108)) : null, frozen: st === 2, delegatedAmount: d.readBigUInt64LE(121), cpiGuard: false,
  }
  if (d.length > TOKEN_ACCOUNT_LEN + 1 && tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    for (let i = TOKEN_ACCOUNT_LEN + 1; i + 4 <= d.length;) {
      const kind = d.readUInt16LE(i), len = d.readUInt16LE(i + 2)
      if (kind === 0) break
      if (kind === CPI_GUARD_EXT && len >= 1 && i + 4 < d.length) view.cpiGuard = d[i + 4] === 1
      i += 4 + len
    }
  }
  return view
}

/** The contract's delegate_is_ours: close_listing is refused for bidding and fixed listings while this is true. */
export function delegateIsOurs(l, view) { return !!view && view.owner.equals(l.seller) && !view.frozen && !!view.delegate && view.delegate.equals(l.pubkey) }

/** The same test the program runs: can this listing still be filled from its stored token account? */
export function canFill(l, view) {
  if (!view || !view.mint.equals(l.mint) || !view.owner.equals(l.seller) || view.frozen || view.amount < l.amount) return false
  if (l.mode === 'accept') return true
  return !!view.delegate && view.delegate.equals(l.pubkey) && view.delegatedAmount >= l.amount
}

const ALLOWED_MINT_EXT = new Set([18, 19, 20, 21, 22, 23])
/** Mirror of the program's check, so a tag on a refused mint costs no transaction. Null if this isn't a mint. */
export function readMint(info) {
  if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) return null
  const d = Buffer.from(info.data)
  if (d.length < 82 || d[45] !== 1) return null
  let allowed = true
  if (d.length > 82) {
    if (d.length < 166) return null
    for (let i = 166; i + 4 <= d.length;) {
      const kind = d.readUInt16LE(i)
      if (kind === 0) break
      if (!ALLOWED_MINT_EXT.has(kind)) { allowed = false; break }
      i += 4 + d.readUInt16LE(i + 2)
    }
  }
  return { decimals: d[44], tokenProgram: info.owner, allowed }
}

/** Matches a program error in a send failure or a status, by name or by its hex code, using the IDL's numbers. */
export function programError(...names) {
  const parts = names.flatMap((n) => { const e = IDL.errors.find((x) => x.name === n); if (!e) throw new Error(`no error ${n}`); return [n, `0x${e.code.toString(16)}`, `"Custom":${e.code}`, `Custom\\(${e.code}\\)`] })
  return new RegExp(parts.join('|'), 'i')
}

export const tagListingId = (tweetId) => createHash('sha256').update(`sidebid-tag-v1:${tweetId}`).digest()
export const isZero = (k) => k.equals(ZERO)
export { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync }
