// What a visitor can check about the contract itself: who can upgrade it (read from chain), any upgrade waiting in a
// Squads vault, and whether the build is verified. Read lazily, cached, one read in flight at a time.
// Squads v4 account layouts checked against @sqds/multisig 2.1.4 (generated beet structs).
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

export const SQUADS = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf')
export const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const disc = (n) => createHash('sha256').update(`account:${n}`).digest().subarray(0, 8)
export const DISC = { multisig: disc('Multisig'), proposal: disc('Proposal'), vault: disc('VaultTransaction'), config: disc('ConfigTransaction') }
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export const vaultPda = (ms, index = 0) => PublicKey.findProgramAddressSync([Buffer.from('multisig'), new PublicKey(ms).toBuffer(), Buffer.from('vault'), Buffer.from([index])], SQUADS)[0]
export const txPda = (ms, i) => PublicKey.findProgramAddressSync([Buffer.from('multisig'), new PublicKey(ms).toBuffer(), Buffer.from('transaction'), u64(i)], SQUADS)[0]
export const proposalPda = (ms, i) => PublicKey.findProgramAddressSync([Buffer.from('multisig'), new PublicKey(ms).toBuffer(), Buffer.from('transaction'), u64(i), Buffer.from('proposal')], SQUADS)[0]
export const programDataPda = (programId) => PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], LOADER)[0]

/** Multisig account: disc 8, create_key 32, config_authority 32, threshold u16, time_lock u32, tx index u64, stale u64, rent_collector Option, bump, members vec. */
export function decodeMultisig(data) {
  const b = Buffer.from(data)
  if (b.length < 94 || !b.subarray(0, 8).equals(DISC.multisig)) return null
  let o = 94
  if (b[o] === 1) o += 33; else o += 1
  o += 1 // bump
  const n = b.readUInt32LE(o); o += 4
  const members = []
  for (let i = 0; i < n && o + 33 <= b.length; i++, o += 33) members.push(new PublicKey(b.subarray(o, o + 32)).toBase58())
  const ca = b.subarray(40, 72), autonomous = ca.every((x) => x === 0)
  return {
    // A set config_authority can change members, threshold and the time lock at once, with no proposal and no wait
    autonomous, configAuthority: autonomous ? null : new PublicKey(ca).toBase58(), threshold: b.readUInt16LE(72), lockSecs: b.readUInt32LE(74),
    txIndex: b.readBigUInt64LE(78), staleIndex: b.readBigUInt64LE(86), members,
  }
}
const STATUS = ['draft', 'active', 'rejected', 'approved', 'executing', 'executed', 'cancelled']
/** Proposal: disc 8, multisig 32, transaction_index u64, status enum (u8, then i64 timestamp except Executing). */
export function decodeProposal(data) {
  const b = Buffer.from(data)
  if (b.length < 49 || !b.subarray(0, 8).equals(DISC.proposal)) return null
  const k = b[48], status = STATUS[k] ?? 'unknown'
  return { index: b.readBigUInt64LE(40), status, at: k !== 4 && b.length >= 57 ? Number(b.readBigInt64LE(49)) : null }
}
const TERMINAL = new Set(['rejected', 'executed', 'cancelled'])
const VAULTS = [0, 1, 2, 3]
const PAGE = 50, MAX_SCAN = 2000, KEEP_MS = 300_000
/** 'settings' for a config transaction, 'program' for a vault transaction whose keys name the program, else 'other'. */
export function txKind(data, programKeys) {
  if (!data) return 'other'
  const b = Buffer.from(data)
  if (b.subarray(0, 8).equals(DISC.config)) return 'settings'
  if (!b.subarray(0, 8).equals(DISC.vault)) return 'other'
  try {
    let o = 8 + 32 + 32 + 8 + 3
    o += 4 + b.readUInt32LE(o) // ephemeral_signer_bumps
    o += 3 // num_signers, num_writable_signers, num_writable_non_signers
    const n = b.readUInt32LE(o); o += 4
    for (let i = 0; i < n && o + 32 <= b.length; i++, o += 32) if (programKeys.has(new PublicKey(b.subarray(o, o + 32)).toBase58())) return 'program'
  } catch {}
  return 'other'
}

export class TrustWatch {
  constructor({ conn, programId, squads = null, now = Date.now, fetchImpl = fetch, cluster = 'mainnet-beta', ttlMs = 20_000 }) {
    this.conn = conn; this.programId = new PublicKey(programId); this.squads = squads?.multisig ? new PublicKey(squads.multisig) : null
    this.vaults = Number.isInteger(squads?.vaultIndex) && squads.vaultIndex >= 0 && squads.vaultIndex < 256 ? [...new Set([squads.vaultIndex, ...VAULTS])] : VAULTS
    this.done = new Set(); this.good = null; this.goodAt = -Infinity
    this.now = now; this.fetch = fetchImpl; this.cluster = cluster; this.ttl = ttlMs
    this.cache = null; this.at = -Infinity; this.inflight = null; this.verified = null; this.verifiedAt = -Infinity
  }
  async get() {
    if (this.cache && this.now() - this.at < this.ttl) return this.cache
    if (!this.inflight) this.inflight = this.read().then((r) => { this.cache = r; this.at = this.now(); return r }).finally(() => { this.inflight = null })
    return this.inflight
  }
  async read() {
    let upgrade = await this.upgrade().catch(() => ({ ...empty(), state: 'unknown' }))
    // Not on chain yet (before launch): there is no build to verify, so the verifier's answer means nothing and is not asked
    const verified = upgrade.state === 'undeployed' ? { state: 'pending', url: null } : await this.verify()
    // A failed read keeps the last good one for a few minutes rather than dropping to Checking
    if (upgrade.state !== 'unknown') { this.good = upgrade; this.goodAt = this.now() }
    else if (this.good && this.now() - this.goodAt < KEEP_MS) upgrade = { ...this.good, readAt: Math.floor(this.goodAt / 1000) }
    return { programId: this.programId.toBase58(), cluster: this.cluster, checkedAt: Math.floor(this.now() / 1000), upgrade, verified }
  }
  async upgrade() {
    const prog = await this.conn.getAccountInfo(this.programId, 'confirmed')
    // A read that worked and found no account: the program is not deployed yet. A failed read throws and stays unknown.
    if (!prog) return { ...empty(), state: 'undeployed' }
    if ( prog.data.length < 36 || Buffer.from(prog.data).readUInt32LE(0) !== 2) return { ...empty(), state: 'unknown' }
    const pdAddr = new PublicKey(Buffer.from(prog.data).subarray(4, 36))
    const pd = await this.conn.getAccountInfo(pdAddr, 'confirmed')
    if (!pd || pd.data.length < 13 || Buffer.from(pd.data).readUInt32LE(0) !== 3) return { ...empty(), state: 'unknown' }
    const d = Buffer.from(pd.data), deploySlot = Number(d.readBigUInt64LE(4))
    // No authority, or the all zero address nobody holds a key for (what a validator writes for an immutable genesis program): revoked
    if (d[12] !== 1 || d.subarray(13, 45).every((x) => x === 0)) return { ...empty(), state: 'revoked', deploySlot, programData: pdAddr.toBase58(), revokeSig: await this.revokeSig(pdAddr) }
    const authority = new PublicKey(d.subarray(13, 45)).toBase58()
    const vaultIndex = this.squads ? this.vaults.find((i) => vaultPda(this.squads, i).toBase58() === authority) : undefined
    if (vaultIndex === undefined) return { ...empty(), state: 'key', authority, deploySlot, programData: pdAddr.toBase58() }
    const msAcc = await this.conn.getAccountInfo(this.squads, 'confirmed')
    const ms = msAcc && msAcc.owner.equals(SQUADS) ? decodeMultisig(msAcc.data) : null
    if (!ms) return { ...empty(), state: 'unknown', authority, deploySlot, programData: pdAddr.toBase58(), multisig: this.squads.toBase58() }
    const out = { ...empty(), state: 'squads', authority, deploySlot, programData: pdAddr.toBase58(), multisig: this.squads.toBase58(), vaultIndex, lockSecs: ms.lockSecs, threshold: ms.threshold, members: ms.members.length, autonomous: ms.autonomous, configAuthority: ms.configAuthority }
    // Every index that is not settled for good, newest first, in pages of 50. An approved vault transaction can still run
    // after it goes stale, so stale indices are read too; a stale active proposal or settings change can no longer run.
    const idx = []
    for (let i = ms.txIndex; i > 0n && idx.length < MAX_SCAN; i--) if (!this.done.has(i)) idx.push(i)
    const ours = new Set([this.programId.toBase58(), pdAddr.toBase58()])
    for (let a = 0; a < idx.length; a += PAGE) {
      const part = idx.slice(a, a + PAGE)
      const keys = part.flatMap((i) => [proposalPda(this.squads, i), txPda(this.squads, i)])
      const infos = await this.conn.getMultipleAccountsInfo(keys, 'confirmed')
      part.forEach((i, n) => {
        const pi = infos[2 * n], ti = infos[2 * n + 1]
        const p = pi && pi.owner.equals(SQUADS) ? decodeProposal(pi.data) : null
        if (p && TERMINAL.has(p.status)) { this.done.add(i); return }
        if (!p || !['active', 'approved', 'executing'].includes(p.status)) return
        const kind = txKind(ti && ti.owner.equals(SQUADS) ? ti.data : null, ours)
        if (i <= ms.staleIndex && (p.status === 'active' || kind === 'settings')) return
        const approved = p.status !== 'active'
        out.pending.push({ index: Number(i), kind, status: approved ? 'approved' : 'active', proposedAt: approved ? null : p.at, approvedAt: approved ? p.at : null, executableAt: approved && p.at != null ? p.at + ms.lockSecs : null, proposal: keys[2 * n].toBase58() })
      })
    }
    out.pending.sort((x, y) => x.index - y.index)
    return out
  }
  /** The newest successful transaction that wrote the program data: once revoked, the one that set no authority. Read once. */
  async revokeSig(pd) {
    if (this.revoked !== undefined) return this.revoked
    if (typeof this.conn.getSignaturesForAddress !== 'function') return null
    try {
      const sigs = await this.conn.getSignaturesForAddress(pd, { limit: 10 }, 'confirmed')
      this.revoked = sigs.find((x) => !x.err)?.signature ?? null
    } catch { return null }
    return this.revoked
  }
  async verify() {
    if (this.cluster !== 'mainnet-beta') return { state: 'pending', url: null }
    const url = `https://verify.osec.io/status/${this.programId.toBase58()}`
    if (this.verified && this.now() - this.verifiedAt < 600_000) return this.verified
    try {
      const r = await this.fetch(url, { signal: AbortSignal.timeout(4000) })
      const j = r.ok ? await r.json() : null
      this.verified = { state: j?.is_verified === true ? 'verified' : j ? 'unverified' : 'pending', url }
    } catch { this.verified = { state: 'pending', url } }
    this.verifiedAt = this.now()
    return this.verified
  }
}
const empty = () => ({ state: 'unknown', revokeSig: null, authority: null, deploySlot: null, programData: null, multisig: null, vaultIndex: null, lockSecs: null, threshold: null, members: null, autonomous: null, configAuthority: null, pending: [] })
