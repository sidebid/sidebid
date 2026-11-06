// Chain reads and the one way the site sends a transaction: build, simulate, size the compute limit from the
// simulation, ask the wallet to sign, send, confirm. The connected wallet is the only signer and pays the fee.
import { Buffer } from 'buffer'
import bs58 from 'bs58'
import { Connection, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { errorName, IDL } from './program.js'
import { signTx } from './wallet.js'

let conn = null, cfg = null
export function useChain(config) { cfg = config; conn = new Connection(config.chain.rpc, { commitment: 'confirmed', wsEndpoint: config.chain.ws || undefined }) }
export const connection = () => conn

// ---- errors in plain words. Keys are the contract's error names.
const PLAIN = {
  ZeroAmount: 'The amount must be above zero.',
  PriceTooLow: 'The lowest price or bid is 0.001 SOL.',
  InsufficientTokens: 'The seller no longer holds that many tokens.',
  TokenAccountFrozen: 'That token account is frozen, so it cannot be listed.',
  BadDuration: 'That length is outside what the contract allows.',
  UnsupportedMintExtension: 'This coin uses a Token 2022 feature the contract does not accept.',
  BadMint: 'That is not a coin the contract can read.',
  NotLive: 'This listing is no longer live.',
  WrongMode: 'This listing does not take that action.',
  ListingChanged: 'The listing changed while you were signing. Nothing moved. Check it and try again.',
  AuctionEnded: 'The countdown has ended. Nothing moved.',
  AuctionNotEnded: 'The countdown has not ended yet.',
  SellerTokensUnavailable: 'The seller moved the tokens or removed the approval, so this cannot complete.',
  BidBelowMinimum: 'That bid is under the minimum.',
  BidNotAboveTop: 'Someone bid higher first. Nothing moved. Raise and try again.',
  MissingPrevBidder: 'The top bid changed while you were signing. Nothing moved. Try again.',
  NoBids: 'This auction has no bids.',
  RefundNotAllowed: 'A refund is not allowed yet. The seller can still deliver.',
  PassRequired: 'This deal is one per X account and needs a pass.',
  PassNotUsed: 'This listing does not take a pass.',
  PassExpired: 'Your pass expired. Press buy again for a fresh one.',
  BadPass: 'The pass did not check out. Press buy again.',
  ListingExpired: 'This fixed price listing has expired.',
  CloseNotAllowed: 'This listing cannot be closed yet.',
  BadCreditAccount: 'That credit address is wrong.',
  NothingToClaim: 'Nothing left to claim.',
  RaiseTooSmall: 'A raise must beat the top bid by 2% or 0.001 SOL, whichever is larger.',
  DelegateStillSet: 'The seller has to cancel to remove the approval first.',
  NotListingServer: 'Only the listing server can open that card.',
  NotSeller: 'Only the seller can do this, from the wallet that listed it.',
  AcceptWindowClosed: 'The accept window has closed.',
  Overflow: 'That number is too large.',
}
export class TxError extends Error {
  constructor(message, { code = 'tx', logs = null, sig = null } = {}) { super(message); this.code = code; this.logs = logs; this.sig = sig }
}
/** Turns a simulation or send error into words a person can act on. */
export function explain(err, logs = []) {
  const s = JSON.stringify(err ?? '') + ' ' + (logs ?? []).join('\n')
  const custom = /"Custom":(\d+)/.exec(s) ?? /custom program error: 0x([0-9a-f]+)/i.exec(s)
  if (custom) {
    const code = custom[0].includes('0x') ? parseInt(custom[1], 16) : Number(custom[1])
    const name = errorName(code)
    if (name) return new TxError(PLAIN[name] ?? name, { code: name, logs })
  }
  if (/already in use/i.test(s)) return new TxError('This token account already has a live listing. Cancel that one first.', { code: 'in_use', logs })
  if (/insufficient (funds|lamports)|InsufficientFundsForRent|AccountNotFound|Attempt to debit an account but found no record/i.test(s)) return new TxError('Not enough SOL in this wallet for this and the network fee.', { code: 'no_sol', logs })
  if (/blockhash not found|BlockhashNotFound/i.test(s)) return new TxError('The network moved on before this landed. Nothing moved. Try again.', { code: 'blockhash', logs })
  if (/ConstraintSeeds|AccountNotInitialized|"Custom":3012\b|0xbc4\b/.test(s)) return new TxError('Something on this listing changed. Refresh and try again.', { code: 'changed', logs })
  return new TxError('The network refused this transaction. Nothing moved.', { code: 'refused', logs })
}
const rejected = (e) => /reject|denied|cancel|declin|closed/i.test(String(e?.message ?? e)) || e?.code === 4001

const CB = ComputeBudgetProgram.programId.toBase58()
// Phantom appends Lighthouse assertion instructions (they only check balances and fail the transaction if they change). Allowed, nothing else is.
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
const walletOnly = (i) => { const p = i.programId.toBase58(); return p === CB || p === LIGHTHOUSE }
const ixKey = (ix) => `${ix.programId.toBase58()}|${ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`).join(',')}|${Buffer.from(ix.data).toString('hex')}`
/**
 * What the wallet hands back must be what was built: the same fee payer, one signer, our instructions unchanged and in
 * order, and a valid signature. A wallet may only touch the compute budget and add Lighthouse balance checks. Returns null when fine, else the reason.
 */
export function checkSigned(built, signed, payer) {
  if (!signed.feePayer?.equals(payer)) return 'The wallet changed who pays for this. Not sent.'
  const msg = signed.compileMessage()
  if (msg.header.numRequiredSignatures !== 1 || signed.signatures.length !== 1) return 'The wallet added another signer. Not sent.'
  // Both sides through the same compile and decompile: account flags become per transaction, as the wallet sees them
  const norm = Transaction.from(built.serialize({ requireAllSignatures: false, verifySignatures: false }))
  const ours = norm.instructions.filter((i) => i.programId.toBase58() !== CB).map(ixKey)
  const theirs = signed.instructions.filter((i) => !walletOnly(i)).map(ixKey)
  if (ours.length !== theirs.length || ours.some((k, i) => k !== theirs[i])) return 'The wallet changed this transaction. Not sent.'
  if (!signed.verifySignatures(true)) return 'The wallet signature did not check out. Not sent.'
  return null
}

/**
 * Builds, simulates and sends. `instructions` must not include compute budget ones. `onStep` hears
 * 'simulating' | 'signing' | 'sending' | 'confirming'. Returns the signature once confirmed.
 */
export async function send({ payer, instructions, onStep = () => {} }) {
  const feePayer = new PublicKey(payer)
  const price = Number(cfg.chain.priorityMicroLamports || 0)
  const budget = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...(price > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })] : [])]
  onStep('simulating')
  let bh = await conn.getLatestBlockhash('confirmed')
  const make = (units) => { const t = new Transaction({ feePayer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }); t.add(...budget(units), ...instructions); return t }
  // Simulate first with room to spare. A refusal here costs the person nothing and never opens the wallet.
  const sim = await conn.simulateTransaction(new VersionedTransaction(make(1_400_000).compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  if (sim.value.err) throw explain(sim.value.err, sim.value.logs)
  const used = Number(sim.value.unitsConsumed ?? 0)
  const units = Math.min(1_400_000, Math.max(20_000, Math.ceil(used * 1.15) + 2_000))
  bh = await conn.getLatestBlockhash('confirmed')
  const tx = make(units)
  // One signer, the person, before the wallet ever opens
  if (tx.compileMessage().header.numRequiredSignatures !== 1) throw new TxError('This transaction needs more than your signature. Not sent.', { code: 'signers' })
  onStep('signing')
  let out
  try { out = await signTx(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), cfg.chain.cluster) }
  catch (e) { if (rejected(e)) throw new TxError('You cancelled in your wallet. Nothing moved.', { code: 'rejected' }); throw new TxError('Your wallet could not sign this. Nothing moved.', { code: 'wallet' }) }
  let sig
  if (out.sent) sig = typeof out.sent === 'string' ? out.sent : bs58.encode(out.sent)
  else {
    const raw = out.signed instanceof Uint8Array ? out.signed : new Uint8Array(out.signed)
    // Checked against what was built, then sent byte for byte as signed: nothing changes after signing
    const why = checkSigned(tx, Transaction.from(Buffer.from(raw)), feePayer)
    if (why) throw new TxError(why, { code: 'wallet' })
    onStep('sending')
    try { sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }) }
    catch (e) { throw explain(e?.message ?? e, e?.logs ?? []) }
  }
  onStep('confirming')
  // Polled, not subscribed: no websocket to depend on, and a lost answer just means asking again. 90 seconds at most,
  // so a dead RPC can never leave every button locked.
  const deadline = Date.now() + 90_000
  for (;;) {
    if (Date.now() > deadline) throw new TxError('Could not confirm. Check the transaction link.', { code: 'unconfirmed', sig })
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: false }).catch(() => null))?.value?.[0]
    if (st?.err) {
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
      const e = explain(st.err, t?.meta?.logMessages ?? []); e.sig = sig; throw e
    }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
    // The current height is read off a fresh blockhash (its last valid height is 150 blocks on), not getBlockHeight: the
    // free browser RPC answers getBlockHeight with a commitment by giving the slot, which would end every wait at once.
    const height = await conn.getLatestBlockhash('confirmed').then((b) => b.lastValidBlockHeight - 150).catch(() => 0)
    if (height > bh.lastValidBlockHeight) {
      const again = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null))?.value?.[0]
      if (again && !again.err) break
      throw new TxError('This did not land in time. Nothing moved. Try again.', { code: 'expired', sig })
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return sig
}

// ---- the listing as the chain has it, read just before signing
const LISTING_DISC = Buffer.from(IDL.accounts.find((a) => a.name === 'Listing').discriminator)
/** Decodes a Listing account (layout from the IDL's Listing type). Null when it is not one. */
export function decodeListing(data) {
  const b = Buffer.from(data)
  if (b.length < 317 || !b.subarray(0, 8).equals(LISTING_DISC)) return null
  const key = (o) => new PublicKey(b.subarray(o, o + 32)).toBase58()
  return { seller: key(8), tokenAccount: key(40), mint: key(72), tokenProgram: key(104), amount: b.readBigUInt64LE(136).toString(), price: b.readBigUInt64LE(144).toString(), endTime: Number(b.readBigInt64LE(152)), topBidder: key(160), topBid: b.readBigUInt64LE(192).toString(), mode: b[264], state: b[265], decimals: b[266], rentPayer: key(269), acceptWindowSecs: Number(b.readBigInt64LE(301)), hardEndTime: Number(b.readBigInt64LE(309)) }
}
/** Which of `fields` differ between the chain copy and what the page shows. The seller may be a person object. */
export const mismatched = (c, shown, fields) => fields.filter((f) => String(c[f]) !== String(f === 'seller' ? shown.seller?.wallet ?? shown.seller : shown[f]))
/**
 * The listing read straight from the RPC, refused when it differs from what the page shows. `shown` is the listing
 * the person is looking at; `fields` are the ones that must match. Instructions are then built from the chain copy.
 */
export async function onChainListing(pubkey, shown, fields) {
  const info = await conn.getAccountInfo(new PublicKey(pubkey), 'confirmed')
  if (!info) throw new TxError('This listing is no longer open on chain. Nothing was signed.', { code: 'gone' })
  if (info.owner.toBase58() !== cfg.chain.programId) throw new TxError('That address is not a listing. Nothing was signed.', { code: 'mismatch' })
  const c = decodeListing(info.data)
  if (!c) throw new TxError('That address is not a listing. Nothing was signed.', { code: 'mismatch' })
  if (mismatched(c, shown, fields).length) throw new TxError('The listing on chain does not match this page. Nothing was signed. Refresh and check it again.', { code: 'mismatch' })
  return { ...shown, ...c, pubkey: String(pubkey) }
}

// ---- reads
const cache = new Map()
const memo = (key, ms, fn) => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.p
  const p = fn().catch((e) => { cache.delete(key); throw e })
  cache.set(key, { at: Date.now(), p })
  return p
}
export const forget = (key) => cache.delete(key)

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const cstr = (b, o) => { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0/g, '').trim(), o + 4 + n] }
function parseMetaplex(data) {
  try { const b = Buffer.from(data); let o = 65; const [name, a] = cstr(b, o); const [symbol, c] = cstr(b, a); const [uri] = cstr(b, c); return { name, symbol, uri } } catch { return null }
}
function parseT22Metadata(data) {
  // Token 2022 mint with the metadata extension (type 19): update authority, mint, then name, symbol, uri as u32 strings
  const b = Buffer.from(data)
  if (b.length <= 166) return null
  for (let i = 166; i + 4 <= b.length;) {
    const kind = b.readUInt16LE(i), len = b.readUInt16LE(i + 2)
    if (kind === 0) break
    if (kind === 19) { try { let o = i + 4 + 64; const [name, a] = cstr(b, o); const [symbol, c] = cstr(b, a); const [uri] = cstr(b, c); return { name, symbol, uri } } catch { return null } }
    i += 4 + len
  }
  return null
}

/** Name, ticker, picture, decimals, supply and the two authorities of a coin, read from chain. */
export function coinInfo(mint) {
  return memo(`coin:${mint}`, 5 * 60_000, async () => {
    const m = new PublicKey(mint)
    const [metaPda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), m.toBuffer()], METAPLEX)
    const [mi, md] = await conn.getMultipleAccountsInfo([m, metaPda], 'confirmed')
    if (!mi) return null
    const d = Buffer.from(mi.data)
    const out = {
      mint, tokenProgram: mi.owner.toBase58(), decimals: d[44],
      supply: d.readBigUInt64LE(36).toString(),
      mintAuthority: d.readUInt32LE(0) === 1 ? new PublicKey(d.subarray(4, 36)).toBase58() : null,
      freezeAuthority: d.readUInt32LE(46) === 1 ? new PublicKey(d.subarray(50, 82)).toBase58() : null,
      name: null, symbol: null, image: null,
    }
    const meta = (md && md.owner.equals(METAPLEX) ? parseMetaplex(md.data) : null) ?? (mi.owner.equals(TOKEN_2022_PROGRAM_ID) ? parseT22Metadata(mi.data) : null)
    if (meta) {
      out.name = meta.name || null; out.symbol = meta.symbol?.replace(/^\$/, '') || null
    }
    // The picture always comes through our own server, so the token creator never sees who opens the board. The server
    // answers 404 when the coin has none, and the drawn mark stays.
    out.image = `/api/site/coinimg/${mint}`
    return out
  })
}

// The free browser RPC refuses indexed reads (token accounts by owner, largest accounts), so these two come from our
// server, which reads them on its own RPC. The browser RPC is only the fallback when the server cannot answer.
const KEY58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A base58 address that decodes to exactly itself. */
export const isKey = (s) => { try { return KEY58.test(String(s ?? '').trim()) && new PublicKey(String(s).trim()).toBase58() === String(s).trim() } catch { return false } }
async function server(path) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`server ${r.status}`)
  const j = await r.json()
  if (!Array.isArray(j?.items)) throw new Error('server answer')
  return j.items
}

/** The seven biggest holders with their owners. Owner is null when the account isn't a plain token account. */
export function holders(mint) {
  return memo(`holders:${mint}`, 60_000, () => server(`/api/chain/holders/${new PublicKey(mint).toBase58()}`).catch(() => holdersRpc(mint)))
}
async function holdersRpc(mint) {
  const big = await conn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed')
  const top = big.value.filter((a) => a.amount !== '0').slice(0, 7)
  const infos = await conn.getMultipleAccountsInfo(top.map((a) => a.address), 'confirmed')
  return top.map((a, i) => ({ account: a.address.toBase58(), owner: infos[i] && infos[i].data.length >= 64 ? new PublicKey(Buffer.from(infos[i].data).subarray(32, 64)).toBase58() : null, amount: a.amount }))
}

/**
 * Coins this wallet holds in associated token accounts, the only accounts the contract lists from: mint, tokenProgram,
 * tokenAccount, amount, delegated, and from the server also name, symbol, image, decimals and usd (null when unknown).
 * With `mint`, only that coin. Sorted by value, then balance.
 */
export async function walletCoins(owner, mint = null) {
  const o = new PublicKey(owner).toBase58(), m = mint ? new PublicKey(mint).toBase58() : null
  try { return await server(`/api/chain/coins/${o}${m ? `?mint=${m}` : ''}`) } catch {}
  const all = await walletCoinsRpc(o)
  return m ? all.filter((c) => c.mint === m) : all
}
async function walletCoinsRpc(owner) {
  const o = new PublicKey(owner)
  const lists = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) => conn.getTokenAccountsByOwner(o, { programId: p }, 'confirmed').then((r) => r.value.map((v) => ({ ...v, program: p })))))
  const out = []
  for (const { pubkey, account, program } of lists.flat()) {
    const d = Buffer.from(account.data)
    const mint = new PublicKey(d.subarray(0, 32)), amount = d.readBigUInt64LE(64)
    if (amount === 0n) continue
    if (!getAssociatedTokenAddressSync(mint, o, false, program).equals(pubkey)) continue
    const delegated = d.readUInt32LE(72) === 1
    out.push({ mint: mint.toBase58(), tokenProgram: program.toBase58(), tokenAccount: pubkey.toBase58(), amount: amount.toString(), delegated, decimals: null, name: null, symbol: null, image: null, usd: null })
  }
  return out.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
}
export const balance = (k) => conn.getBalance(new PublicKey(k), 'confirmed')
export const accountExists = async (k) => !!(await conn.getAccountInfo(new PublicKey(k), 'confirmed'))
