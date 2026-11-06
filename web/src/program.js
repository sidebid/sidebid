// Every contract instruction the site sends, built from the IDL: account order, signer and writable flags and
// discriminators come from program/idl/sidebid.json. Argument bytes are written here. Runs in the browser and in Node.
import { Buffer } from 'buffer'
import { PublicKey, SystemProgram, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import IDL from '../../program/idl/sidebid.json'

export { IDL, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID }
export const MIN_PRICE_LAMPORTS = 1_000_000n
const MIN_RAISE = 1_000_000n

const u8 = (v) => Buffer.from([v])
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k))

export function program(programId) {
  programId = pk(programId)
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0]
  const listingPda = (tokenAccount) => pda(Buffer.from('listing'), pk(tokenAccount).toBuffer())
  const vaultPda = (listing) => pda(Buffer.from('vault'), pk(listing).toBuffer())
  const creditPda = (listing, owner) => pda(Buffer.from('credit'), pk(listing).toBuffer(), pk(owner).toBuffer())
  const claimPda = (signer, campaign, hash) => pda(Buffer.from('claim'), pk(signer).toBuffer(), pk(campaign).toBuffer(), hash)

  /** A required account left out throws. A missing optional account is the program id, as Anchor expects. */
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
      return { pubkey: pk(k), isSigner: !!a.signer, isWritable: !!a.writable }
    })
    return new TransactionInstruction({ programId, keys, data: Buffer.concat([Buffer.from(def.discriminator), ...args]) })
  }

  // l is a listing read from chain just before signing (chain.onChainListing), matched against what the page shows.
  // The signed expected_* values are those same fields, never a separate copy from the server.
  const hasBid = (l) => BigInt(l.topBid ?? '0') > 0n
  const ix = {
    /** mode: 'bidding' | 'fixed'. Approves the listing for exactly `amount` inside the same instruction. */
    createListing({ seller, mint, tokenProgram, mode, amount, price, duration, pass = null }) {
      const tokenAccount = getAssociatedTokenAddressSync(pk(mint), pk(seller), false, pk(tokenProgram))
      const listing = listingPda(tokenAccount)
      const passBytes = pass ? Buffer.concat([u8(1), pk(pass.signer).toBuffer(), pk(pass.campaign).toBuffer()]) : u8(0)
      const data = Buffer.concat([u8(mode === 'fixed' ? 1 : 0), u64(amount), u64(price), u64(duration), passBytes])
      return { listing, tokenAccount, ix: build('create_listing', { seller, listing, vault: vaultPda(listing), seller_token_account: tokenAccount, mint, token_program: tokenProgram }, data) }
    },
    bid: (l, bidder, amount) => build('place_bid', { bidder, listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, prev_bidder: hasBid(l) ? l.topBidder : null, prev_bidder_credit: hasBid(l) ? creditPda(l.pubkey, l.topBidder) : null },
      u64(amount), u64(l.amount), pk(l.mint).toBuffer(), i64(l.hardEndTime)),
    settle: (l, winnerToken) => build('settle', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller: l.seller.wallet ?? l.seller, seller_credit: creditPda(l.pubkey, l.seller.wallet ?? l.seller), seller_token_account: l.tokenAccount, mint: l.mint, winner_token_account: winnerToken, token_program: l.tokenProgram }),
    accept: (l, seller, sellerToken, winnerToken) => build('accept', { seller, listing: l.pubkey, vault: vaultPda(l.pubkey), seller_credit: creditPda(l.pubkey, seller), seller_token_account: sellerToken, mint: l.mint, winner_token_account: winnerToken, rent_receiver: l.rentPayer, rent_receiver_credit: creditPda(l.pubkey, l.rentPayer), token_program: l.tokenProgram }, u64(l.amount), u64(l.topBid)),
    refund: (l) => build('refund', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, top_bidder: hasBid(l) ? l.topBidder : null, top_bidder_credit: hasBid(l) ? creditPda(l.pubkey, l.topBidder) : null }),
    cancel: (l, seller) => build('cancel', { seller, listing: l.pubkey, vault: vaultPda(l.pubkey), seller_credit: creditPda(l.pubkey, seller), seller_token_account: l.tokenAccount, top_bidder: hasBid(l) ? l.topBidder : null, top_bidder_credit: hasBid(l) ? creditPda(l.pubkey, l.topBidder) : null, token_program: l.tokenProgram }),
    close: (l) => build('close_listing', { listing: l.pubkey, vault: vaultPda(l.pubkey), seller_token_account: l.tokenAccount, rent_receiver: l.rentPayer, rent_receiver_credit: creditPda(l.pubkey, l.rentPayer) }),
    buyFixed: (l, buyer, buyerToken) => build('buy_fixed', { buyer, listing: l.pubkey, seller: l.seller.wallet ?? l.seller, seller_credit: creditPda(l.pubkey, l.seller.wallet ?? l.seller), seller_token_account: l.tokenAccount, mint: l.mint, buyer_token_account: buyerToken, token_program: l.tokenProgram }, u64(l.price), u64(l.amount)),
    /** pass is what POST /api/pass returns. The verify instruction must sit directly before the buy. */
    buyWithPass(l, buyer, buyerToken, pass) {
      const hash = Buffer.from(pass.xIdHash, 'hex')
      const verify = new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.from(pass.ed25519Data, 'base64') })
      const buy = build('buy_fixed_with_pass', { buyer, listing: l.pubkey, claim: claimPda(l.pass.signer, l.pass.campaign, hash), seller: l.seller.wallet ?? l.seller, seller_credit: creditPda(l.pubkey, l.seller.wallet ?? l.seller), seller_token_account: l.tokenAccount, mint: l.mint, buyer_token_account: buyerToken, token_program: l.tokenProgram },
        hash, i64(pass.expiry), u64(l.price), u64(l.amount))
      return [verify, buy]
    },
    claimCredit: (owner, listing, destination = owner) => build('claim_credit', { owner, credit: creditPda(listing, owner), destination }, pk(listing).toBuffer()),
    /** The winner's or buyer's token account, created if missing. Paid by whoever signs. */
    ata(payer, owner, mint, tokenProgram) {
      const ata = getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(tokenProgram))
      return { ata, ix: createAssociatedTokenAccountIdempotentInstruction(pk(payer), ata, pk(owner), pk(mint), pk(tokenProgram)) }
    },
  }
  return { programId, listingPda, vaultPda, creditPda, claimPda, ix }
}

/** The lowest bid the contract takes next. Same rule as the program and the server. */
export function minimumNextBid(topBid, price) {
  const top = BigInt(topBid ?? '0')
  if (top === 0n) { const p = BigInt(price ?? '0'); return p > MIN_PRICE_LAMPORTS ? p : MIN_PRICE_LAMPORTS }
  const raise = (top + 49n) / 50n
  return top + (raise > MIN_RAISE ? raise : MIN_RAISE)
}

/** Program error number to its IDL name, or null. */
export const errorName = (code) => IDL.errors.find((e) => e.code === code)?.name ?? null
