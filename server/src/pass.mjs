// One time pass for fixed deals with the one per X account rule. The message layout is the contract's:
//   SIDEBID_PASS_V1\0 | program id | campaign | buyer | X id hash | expiry (i64 LE)
// The pass key signs this and nothing else. It holds no SOL and signs no transaction. The X id is hashed with a key kept
// on the server, because X ids are public and few enough to try them all against a plain hash.
import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'
import { Ed25519Program, PublicKey } from '@solana/web3.js'
import { hasX } from './auth.mjs'

export class PassSigner {
  constructor({ db, config, rpc, prog, auth, now = Date.now }) { Object.assign(this, { db, config, rpc, prog, auth, now }); this.key = config.passKey }
  ready() { return !!(this.key && this.config.passHashKey) }
  xHash(xId) { return createHmac('sha256', this.config.passHashKey).update(`sidebid-x-id-v1:${xId}`) /* fixed domain label: changing it would let every X id claim again */.digest() }
  addCampaign(campaign, label) { new PublicKey(campaign); this.db.run('INSERT OR REPLACE INTO pass_campaigns (campaign,label,created_at) VALUES (?,?,?)', campaign, String(label ?? '').slice(0, 80), this.now()); return { ok: true, campaign } }

  /** Signing only. Nothing checks here, see issue(). */
  sign(campaign, buyer, hash, expiry) {
    const message = this.prog.passMessage(campaign, buyer, hash, expiry)
    return { message, signature: Buffer.from(nacl.sign.detached(message, this.key.secretKey)) }
  }

  /**
   * Issues a pass for a signed in X account's active wallet, for a campaign the admin registered, either directly
   * or through a listing that names it. The chain is read first: an X id that has already claimed gets no pass.
   */
  async issue({ user, campaign, listing, wallet }) {
    if (!this.ready()) return { ok: false, code: 503, why: 'pass_off' }
    // One per X account: keyed by the X user id Privy signed for, so an account with no X linked gets no pass
    if (!hasX(user.x_id)) return { ok: false, code: 409, why: 'x_needed' }
    const active = this.auth.activeWallet(user.x_id)
    if (!active) return { ok: false, code: 409, why: 'no_wallet' }
    if (wallet !== active) return { ok: false, code: 403, why: 'not_your_linked_wallet' }
    let campaignKey
    try {
      if (listing) {
        const k = new PublicKey(listing)
        const info = await this.rpc.account(k)
        const l = this.prog.decode(k, info)
        if (!l) return { ok: false, code: 404, why: 'no_listing' }
        if (l.mode !== 'fixed' || l.state !== 'live') return { ok: false, code: 409, why: 'not_a_live_fixed_listing' }
        if (!l.passSigner.equals(this.key.publicKey)) return { ok: false, code: 409, why: 'listing_uses_another_signer' }
        campaignKey = l.campaign
      } else campaignKey = new PublicKey(campaign)
    } catch (e) {
      if (e.name === 'RpcError') return { ok: false, code: 503, why: 'chain_read_failed' }
      return { ok: false, code: 400, why: 'bad_address' }
    }
    const c = campaignKey.toBase58()
    if (!this.db.get('SELECT 1 FROM pass_campaigns WHERE campaign=?', c)) return { ok: false, code: 403, why: 'unknown_campaign' }
    const hash = this.xHash(user.x_id), hex = hash.toString('hex')
    let claimed
    try { claimed = await this.rpc.account(this.prog.claimPda(this.key.publicKey, campaignKey, hash)) } catch { return { ok: false, code: 503, why: 'chain_read_failed' } }
    if (claimed) return { ok: false, code: 409, why: 'already_claimed' }
    const nowS = Math.floor(this.now() / 1000), expiry = nowS + this.config.passTtlSeconds
    // One live pass per X id per campaign, whichever wallet asked
    const out = this.db.tx(() => {
      const had = this.db.get('SELECT * FROM passes_issued WHERE campaign=? AND x_hash=?', c, hex)
      if (had && had.expiry > nowS && had.wallet !== wallet) return null
      this.db.run('INSERT OR REPLACE INTO passes_issued (campaign,x_hash,wallet,expiry,issued_at) VALUES (?,?,?,?,?)', c, hex, wallet, expiry, this.now())
      return true
    })
    if (!out) return { ok: false, code: 409, why: 'pass_live_for_another_wallet' }
    const buyer = new PublicKey(wallet)
    const { message, signature } = this.sign(campaignKey, buyer, hash, expiry)
    const ix = Ed25519Program.createInstructionWithPublicKey({ publicKey: this.key.publicKey.toBytes(), message, signature })
    return { ok: true, campaign: c, buyer: wallet, xIdHash: hex, expiry, signer: this.key.publicKey.toBase58(), message: message.toString('base64'), signature: signature.toString('base64'), ed25519Data: Buffer.from(ix.data).toString('base64') }
  }
}
