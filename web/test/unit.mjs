// Fast checks of the pure parts of the site, one per past finding that can be shown without a browser.
// Each test is named after the finding it guards. Run: npm run unit
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js'

const here = new URL('.', import.meta.url).pathname
mkdirSync(here + '.build', { recursive: true })
await build({
  stdin: { contents: `export * as F from './src/fmt.js'; export * as CH from './src/chain.js'; export * as PR from './src/program.js'; export * as T from './src/tech.js'; export * as W from './src/wallet.js'; export * as DA from './src/data.js'; export * as RT from './src/routes.js'; export * as SM from './src/solmark.js'; export * as XN from './src/xname.js'`, resolveDir: here + '..', loader: 'js' },
  bundle: true, format: 'esm', platform: 'node', outfile: here + '.build/units.mjs', loader: { '.json': 'json' }, external: ['@solana/web3.js', '@solana/spl-token', 'buffer', 'bs58'], logLevel: 'error',
})
const { F, CH, PR, T, W, DA, RT, SM, XN } = await import(here + '.build/units.mjs')

test('M2: a comma is refused, never read as a decimal point', () => {
  assert.equal(F.parseSol('1,000'), null)
  assert.equal(F.parseSol('1,5'), null)
  assert.equal(F.hasComma('1,000'), true)
  assert.equal(F.parseSol('1.5'), 1_500_000_000n)
  assert.equal(F.parseSol('0.001'), 1_000_000n)
})

test('M3: prices about to be signed are exact', () => {
  assert.equal(F.solX(1_999_000_000n), '1.999')
  assert.equal(F.solX(149_990_000_000n), '149.99')
  assert.equal(F.solX(50_000_000n), '0.05')
  assert.equal(F.solX(1_000_000_000_001n), '1,000.000000001')
  assert.equal(F.solP(1_000_500_000_000n), '1000.5')
  assert.equal(F.parseSol(F.solP(1_000_500_000_000n)), 1_000_500_000_000n, 'the input box value parses back to the same lamports')
  assert.equal(F.tokX(38_400_000_000_000n, 6), '38,400,000')
  assert.equal(F.tokX(1_250_500_000n, 6), '1,250.5')
})

test('sell amount: the full balance by default, chips take a share, a typed amount is exact', () => {
  const bal = 300_000_000_000_000n // 300,000,000 at 6 decimals
  assert.equal(F.sellPick(bal, 100, '', 6), bal, 'the full balance when nothing is typed')
  assert.equal(F.sellPick(bal, 50, '', 6), 150_000_000_000_000n)
  assert.equal(F.sellPick(bal, 25, '  ', 6), 75_000_000_000_000n)
  assert.equal(F.sellPick(7n, 75, '', 0), 5n, 'a share rounds down, never up past the balance')
  assert.equal(F.sellPick(bal, 25, '150000000', 6), 150_000_000_000_000n, 'a typed amount beats the chip')
  assert.equal(F.parseTok('150,000,000', 6), 150_000_000_000_000n, 'grouping commas read')
  assert.equal(F.parseTok('1.5', 6), 1_500_000n)
  assert.equal(F.parseTok('.5', 6), 500_000n)
  assert.equal(F.parseTok('1.0000000', 6), 1_000_000n, 'trailing zeros are fine')
  for (const bad of ['1,5', '1.0000001', 'abc', '-1', '1e6', '', '.', '1.5.5', '15,00']) assert.equal(F.parseTok(bad, 6), null, bad)
  assert.equal(F.tokP(150_000_000_500_000n, 6), '150000000.5')
  assert.equal(F.tokX(F.parseTok(F.tokP(bal, 6), 6), 6), '300,000,000', 'the box value reads back to the same amount')
})

test('M1: instructions carry the chain fields, and a page that differs from the chain is refused', () => {
  const P = PR.program(new PublicKey('11111111111111111111111111111112'))
  const k = () => Keypair.generate().publicKey.toBase58()
  const chainCopy = { pubkey: k(), tokenAccount: k(), mint: k(), amount: '5', price: '5000000000', hardEndTime: 99, topBid: '0', seller: k() }
  // A server copy that says something else in a side field must not reach the instruction
  const lying = { ...chainCopy, expected: { tokenAmount: '1', mint: k(), price: '1', maxEndTime: 1 } }
  const ix = P.ix.bid(lying, k(), 2_000_000n)
  const d = Buffer.from(ix.data)
  assert.equal(d.readBigUInt64LE(16), 5n, 'expected_token_amount is the listing amount')
  assert.equal(new PublicKey(d.subarray(24, 56)).toBase58(), chainCopy.mint, 'expected_mint is the listing mint')
  assert.equal(d.readBigInt64LE(56), 99n, 'max_end_time is the listing hard end')
  const shown = { ...chainCopy, price: '500000000', seller: { wallet: chainCopy.seller, handle: 'x' } }
  assert.deepEqual(CH.mismatched(chainCopy, shown, ['mint', 'amount', 'price', 'seller']), ['price'])
  assert.deepEqual(CH.mismatched(chainCopy, { ...chainCopy, seller: { wallet: chainCopy.seller } }, ['mint', 'amount', 'price', 'seller']), [])
})

test('M1: a Listing account decodes at the IDL offsets', () => {
  const b = Buffer.alloc(317), key = Keypair.generate().publicKey
  b.set([218, 32, 50, 73, 43, 134, 26, 58], 0); b.set(key.toBytes(), 72)
  b.writeBigUInt64LE(123n, 136); b.writeBigUInt64LE(456n, 144); b.writeBigUInt64LE(789n, 192); b.writeBigInt64LE(1000n, 309)
  const c = CH.decodeListing(b)
  assert.equal(c.mint, key.toBase58()); assert.equal(c.amount, '123'); assert.equal(c.price, '456'); assert.equal(c.topBid, '789'); assert.equal(c.hardEndTime, 1000)
  b[0] = 0; assert.equal(CH.decodeListing(b), null, 'another account type is not a listing')
})

test('wallet checks: one signer, instructions unchanged, valid signature; only the compute budget may change', () => {
  const payer = Keypair.generate(), other = Keypair.generate(), bh = '11111111111111111111111111111111'
  const ixs = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 5 })]
  const make = (extra = [], cb = 200_000) => { const t = new Transaction({ feePayer: payer.publicKey, blockhash: bh, lastValidBlockHeight: 1 }); t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cb }), ...ixs, ...extra); return t }
  const built = make()
  const signedOk = make(); signedOk.sign(payer)
  assert.equal(CH.checkSigned(built, Transaction.from(signedOk.serialize()), payer.publicKey), null)
  const cbOnly = make([], 300_000); cbOnly.sign(payer)
  assert.equal(CH.checkSigned(built, Transaction.from(cbOnly.serialize()), payer.publicKey), null, 'a wallet may raise the compute limit')
  const added = make([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1 })]); added.sign(payer)
  assert.match(CH.checkSigned(built, Transaction.from(added.serialize()), payer.publicKey), /changed this transaction/)
  const two = make([SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: payer.publicKey, lamports: 1 })]); two.sign(payer, other)
  assert.match(CH.checkSigned(built, Transaction.from(two.serialize()), payer.publicKey), /another signer/)
  // An account read only in one instruction and writable in another (token account creation, then the buy) is not a change
  const shared = Keypair.generate().publicKey
  const mixed = () => { const t = new Transaction({ feePayer: payer.publicKey, blockhash: bh, lastValidBlockHeight: 1 }); t.add(new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: shared, isSigner: false, isWritable: false }], data: Buffer.from([1]) }), new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: shared, isSigner: false, isWritable: true }], data: Buffer.from([2]) })); return t }
  const m = mixed(); m.sign(payer)
  assert.equal(CH.checkSigned(mixed(), Transaction.from(m.serialize()), payer.publicKey), null)
  const forged = make(); forged.sign(payer); const raw = forged.serialize(); raw[raw.length - 1] ^= 1
  assert.match(CH.checkSigned(built, Transaction.from(raw), payer.publicKey) ?? '', /changed this transaction|did not check out/)
})

test('L6: "Something changed" only for the real 3012 error', () => {
  assert.equal(CH.explain({ InstructionError: [0, { Custom: 3012 }] }).code, 'changed')
  assert.notEqual(CH.explain('lamports 30120 left', ['Program log: 3012 lamports']).code, 'changed')
  assert.equal(CH.explain('x', ['custom program error: 0xbc4']).code, 'changed')
})

test('L8: test counts come from config, and none are shown without it', () => {
  assert.deepEqual(T.PROOF(null), [])
  assert.deepEqual(T.PROOF({ contractTests: 150, serverTests: 220 }).map((p) => p.n), ['150', '220'])
})

test('L16: zero is "0", and the formatter never prints 0.000', () => {
  assert.equal(F.sol(0), '0')
  assert.notEqual(F.sol(0.0001), '0.000')
})

test('L10: bidi and zero width characters are stripped from chain text', () => {
  assert.equal(F.clean('WH‮OLE​'), 'WHOLE')
})

test('upgrade wording says only the state read from chain', () => {
  assert.equal(T.upgradeLine({ upgrade: { state: 'key' } }), 'The contract can be changed by the team’s upgrade key.')
  assert.equal(T.upgradeLine({ upgrade: { state: 'squads', lockSecs: 172800, threshold: 2, members: 3, autonomous: true } }), 'The contract can be changed by the team’s multisig, 2 of 3 approvals. Every change waits 48 hours in public first.')
  assert.match(T.upgradeLine({ upgrade: { state: 'revoked' } }), /revoked/)
  assert.equal(T.upgradeLine({ upgrade: { state: 'undeployed' } }), 'Program deploys at launch. Who can upgrade it is read from chain from then.')
  // Nothing read yet: the team key sentence stays
  for (const t of [null, { upgrade: { state: 'unknown' } }]) assert.equal(T.upgradeLine(t), 'The contract can be changed by the team’s upgrade key. Its upgrade authority is shown on the explorer.')
})

test('N1: a multisig with a settings key never claims its lock makes a change wait', () => {
  const ctl = { upgrade: { state: 'squads', lockSecs: 172800, threshold: 2, members: 3, autonomous: false, configAuthority: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' } }
  const line = T.upgradeLine(ctl)
  assert.equal(line, 'The contract can be changed by the team’s multisig, 2 of 3 approvals. It has a 48 hour lock, but its settings key can change the members and the lock at once, so a change does not have to wait.')
  assert.doesNotMatch(line, /Every change waits/)
  // A reading that does not say autonomous is treated as controlled
  assert.doesNotMatch(T.upgradeLine({ upgrade: { ...ctl.upgrade, autonomous: null } }), /Every change waits/)
  // The Safety page shows the settings key itself, in its exact case
  const safety = T.DOCS({ brand: { name: 'W', ticker: 'W' }, keys: {}, chain: { programId: 'P' }, facts: {} }, ctl).find((g) => g[0] === 'Safety')[1].find((x) => x[0] === 'upgrade')[2]
  assert.match(safety, /Multisig settings key/); assert.match(safety, /9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin/); assert.match(safety, /no banner warns of it/)
})

test('M5: no rewards route means off, paused means paused; neither runs a payout countdown', () => {
  DA.D.rewards = null; DA.D.sales = []
  assert.equal(DA.rewardsModel().state, 'off')
  DA.D.rewards = { paused: true, hour: { start: 0, end: 3600, standings: [] }, past: [] }
  assert.equal(DA.rewardsModel().state, 'paused')
  DA.D.rewards = { hour: { start: 0, end: 3600, standings: [] }, past: [] }
  assert.equal(DA.rewardsModel().state, 'on')
})

test('L4: wallet rows match by exact name, so "Phantom Pro" never takes the Phantom row', () => {
  const evt = new EventTarget()
  globalThis.window = evt; Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', maxTouchPoints: 0 }, configurable: true }); globalThis.location = { href: 'https://x.test/', origin: 'https://x.test' }
  globalThis.CustomEvent = class extends Event { constructor(t, o) { super(t); this.detail = o?.detail } }
  W.startWallets()
  const fake = (name) => ({ name, icon: '', chains: ['solana:mainnet'], accounts: [], features: { 'standard:connect': {}, 'solana:signTransaction': {} } })
  evt.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(fake('Phantom Pro')) }))
  const rows = W.walletChoices()
  assert.equal(rows.find((r) => r.name === 'Phantom').wallet, undefined, 'Phantom row is not taken')
  assert.ok(rows.find((r) => r.name === 'Phantom Pro')?.wallet, 'the other wallet gets its own row')
})

test('M4 and L12 to L14, L18: copy', () => {
  const src = readFileSync(here + '../src/app.js', 'utf8') + readFileSync(here + '../src/tech.js', 'utf8')
  assert.ok(!/cancel before the sale completes|any time before the sale completes/.test(src), 'no promise to cancel after the end')
  assert.match(src, /Cards listed by post cannot be cancelled/)
  assert.ok(!/next slot|first slot/.test(src), 'no settle speed faster than the bot')
  assert.ok(!/None go to our own wallets/.test(src))
  assert.match(src, /the site offers 2 minutes to 1 hour; the contract allows 10 seconds to 1 hour/)
  assert.ok(!/'177'|'179'|'356'/.test(src), 'no hard coded test counts')
})

test('Q3: Holds these tokens says how old the last read is, with the UTC date under it, and a failed read shows', () => {
  const at = Date.UTC(2026, 10, 6, 9, 12, 40)
  assert.equal(F.holdsText({ fillable: true, tokenCheckedAt: at }, at + 12_000), 'Checked 12s ago')
  assert.equal(F.holdsText({ fillable: true, tokenCheckedAt: at }, at + 6 * 3_600_000), 'Checked 6h ago', 'hours later it reads as hours, not as a clock time')
  assert.equal(F.holdsText({ fillable: false, tokenCheckedAt: at }, at + 5 * 60_000), 'Not right now, checked 5m ago')
  assert.equal(F.holdsText({ fillable: true, tokenCheckedAt: at, stale: true }, at + 3 * 3_600_000), 'Last read failed, checked 3h ago')
  assert.equal(F.holdsText({ fillable: null, stale: true, unknown: true }), 'Last read failed')
  assert.equal(F.holdsText({ fillable: null, tokenCheckedAt: at }), 'Checking')
  assert.equal(F.holdsText({ fillable: true, tokenCheckedAt: null }), 'Yes')
  assert.equal(F.holdsText({ closed: true, fillable: true }), 'Listing closed')
  // green only for a fresh read that worked
  assert.equal(F.holdsGood({ fillable: true, tokenCheckedAt: at }, at + 60_000), true)
  assert.equal(F.holdsGood({ fillable: true, tokenCheckedAt: at, stale: true }, at + 60_000), false)
  assert.equal(F.holdsGood({ fillable: true, tokenCheckedAt: at }, at + 3_600_000), false)
  assert.equal(F.utcFull(at), '2026-11-06 09:12:40 UTC')
  for (const t of [F.holdsText({ fillable: true, tokenCheckedAt: at, stale: true }, at + 9e6), F.holdsText({ fillable: false, tokenCheckedAt: at }, at + 9e6)]) assert.doesNotMatch(t, /just now|[—–]| - /)
})

test('Q1: a failed coin read offers Check again instead of Reading the coin forever', () => {
  assert.deepEqual(DA.sellGate(null, { state: 'free' }, true), { ok: false, label: 'Coin read failed, try again', retry: true })
  assert.deepEqual(DA.sellGate(null, { state: 'free' }, false), { ok: false, label: 'Reading the coin…' })
  assert.equal(DA.coinFailed('NotAsked'), false)
  // the sell summary is drawn again when a coin answer arrives, and Check again asks the coin again
  const src = readFileSync(here + '../src/app.js', 'utf8')
  assert.match(src, /if \(what === 'coin' && sellOnPage\(\)\) refreshSellSum\(\)/)
  assert.match(src, /sellRecheck: [^\n]*retryCoin\(c\.mint\)/)
  assert.match(src, /sellGate\(coin\(c\.mint\), sellCheck\(c\), coinFailed\(c\.mint\)\)/)
})

test('Home card: a top bid shown means the stream never waits for a first bid', () => {
  const bidder = Keypair.generate().publicKey.toBase58()
  const l = { top: 0.25, bidsN: 0, v: { topBidder: bidder } }
  const s = DA.bidStream(l, [])
  assert.equal(s.n, 1); assert.equal(s.rows.length, 1); assert.equal(s.rows[0].sol, 0.25); assert.equal(s.rows[0].p.wallet, bidder)
  assert.deepEqual(DA.bidStream({ top: 0, bidsN: 0, v: { topBidder: null } }, []), { n: 0, rows: [] })
  const bids = [{ p: { wallet: bidder }, sol: 0.25, at: 1 }, { p: { wallet: 'x' }, sol: 0.2, at: 0 }]
  assert.equal(DA.bidStream({ ...l, bidsN: 3 }, bids).n, 3); assert.equal(DA.bidStream(l, bids).rows, bids)
})

test('R2: Sign waits for the coin info and a fresh RPC check of the listing address', () => {
  const info = { decimals: 6 }
  assert.deepEqual(DA.sellGate(null, { state: 'free' }), { ok: false, label: 'Reading the coin…' })
  assert.equal(DA.sellGate(info, undefined).ok, false)
  assert.equal(DA.sellGate(info, { state: 'checking' }).label, 'Checking the chain…')
  assert.equal(DA.sellGate(info, { state: 'error' }).retry, true)
  assert.deepEqual(DA.sellGate(info, { state: 'listed' }), { ok: false, label: 'Already listed', listed: true })
  assert.deepEqual(DA.sellGate(info, { state: 'free' }), { ok: true })
  for (const s of ['checking', 'error', 'listed']) assert.doesNotMatch(DA.sellGate(info, { state: s }).label, /[—–]| - /)
})

test('routes: every view has a real address, and old #view links map onto them', () => {
  const k = '5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp'
  assert.deepEqual(RT.routeOf('/'), { v: 'home' }); assert.deepEqual(RT.routeOf('/index.html'), { v: 'home' })
  for (const v of ['live', 'fixed', 'sell', 'rewards', 'docs', 'tx', 'log']) { assert.equal(RT.routeOf('/' + v).v, v); assert.equal(RT.routeOf('/' + v + '/').v, v) }
  assert.deepEqual(RT.routeOf('/lot/' + k), { v: 'lot', a: k }); assert.deepEqual(RT.routeOf('/coin/' + k), { v: 'coin', a: k })
  assert.deepEqual(RT.routeOf('/docs/fee'), { v: 'docs', a: 'fee' })
  assert.equal(RT.routeOf('/lot/../auth/x/start').v, 'notfound'); assert.equal(RT.routeOf('/lot/nope').v, 'notfound'); assert.equal(RT.routeOf('/home').v, 'notfound'); assert.equal(RT.routeOf('/whatever').v, 'notfound')
  assert.equal(RT.fromHash('#home'), '/'); assert.equal(RT.fromHash('#home/sold'), '/#sold'); assert.equal(RT.fromHash('#live'), '/live')
  assert.equal(RT.fromHash('#lot/' + k), '/lot/' + k); assert.equal(RT.fromHash('#docs/verify'), '/docs/verify')
  assert.equal(RT.fromHash('#sold'), null, 'a plain anchor stays an anchor'); assert.equal(RT.fromHash(''), null)
})

test('X pictures: through the site by handle, with the drawn pattern under it, and never asked for again after a failure', () => {
  const p = { wallet: '5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp', handle: 'kelp_whale', avatar: 'https://pbs.twimg.com/profile_images/1/a.jpg' }
  const h = F.avatar(p)
  assert.match(h, /<svg viewBox="0 0 32 32"/, 'the pattern is always there as the fallback')
  assert.match(h, /<img src="\/api\/site\/xavatar\/kelp_whale"/); assert.doesNotMatch(h, /pbs\.twimg\.com/, 'the browser never loads from X')
  assert.doesNotMatch(F.avatar({ wallet: p.wallet }), /<img/, 'a wallet with no X account: pattern only')
  assert.doesNotMatch(F.avatar({ wallet: p.wallet, handle: 'x', avatar: null }), /<img/, 'no stored picture: pattern only')
  assert.doesNotMatch(F.avatar({ ...p, handle: 'bad"name' }), /<img/)
  F.badImg.add('/api/site/xavatar/kelp_whale'); assert.doesNotMatch(F.avatar(p), /<img/, 'a failed picture is not asked for again'); F.badImg.clear()
})

test('coin pictures: every coin read asks the site picture route, whatever its metadata says', () => {
  const src = readFileSync(here + '../src/chain.js', 'utf8')
  assert.match(src, /out\.image = `\/api\/site\/coinimg\/\$\{mint\}`/)
  const app = readFileSync(here + '../src/app.js', 'utf8')
  assert.match(app, /const src = l\.img \?\? \(l\.mint \? `\/api\/site\/coinimg\/\$\{l\.mint\}` : null\), img = src && !badImg\.has\(src\)/, 'a logo for every token, and the drawn mark only when the picture fails')
})

test('Solana mark: every SOL is cut out for the mark, and only the word SOL', () => {
  assert.deepEqual(SM.solParts('Top bid 1.10 SOL'), ['Top bid 1.10 ', 'SOL', ''])
  assert.deepEqual(SM.solParts('1 SOL to 2 SOL'), ['1 ', 'SOL', ' to 2 ', 'SOL', ''])
  assert.equal(SM.solParts('SOLD for Solana').length, 1, 'SOLD and Solana are not SOL')
  assert.match(SM.SOL_SPRITE, /stop-color="#00FFA3"/); assert.match(SM.SOL_SPRITE, /stop-color="#DC1FFF"/); assert.match(SM.SOL_SPRITE, /<symbol id="solmark"/)
  assert.match(SM.SOL_ICON, /<use href="#solmark"\/>/); assert.match(SM.SOL_ICON, /aria-hidden="true"/)
})

test('no X account minimum anywhere in the copy', () => {
  for (const f of ['app.js', 'tech.js']) { const s = readFileSync(here + '../src/' + f, 'utf8'); assert.doesNotMatch(s, /minAccountAgeDays|minFollowers|days old with/, f) }
})

test('every @handle links to its X profile; inside a card it is a span the page opens; no copy cursor', () => {
  assert.equal(F.xLink({ handle: 'bob_bids' }), '<a class="xh" href="https://x.com/bob_bids" target="_blank" rel="noopener">@bob_bids</a>')
  assert.match(F.xLink({ handle: 'bob_bids' }, true), /^<span class="xh" role="link" tabindex="0" data-xh="bob_bids">@bob_bids<\/span>$/)
  assert.doesNotMatch(F.xLink({ handle: 'x"><img' }), /<img|href/)
  assert.doesNotMatch(F.xLink({ wallet: 'So11111111111111111111111111111111111111112' }), /<a/)
  assert.match(F.sellerEl({ handle: 'carol' }), /href="https:\/\/x.com\/carol"/)
  for (const f of ['v2.css', 'd.css', 'polish.css']) assert.doesNotMatch(readFileSync(here + '../src/' + f, 'utf8'), /cursor:\s*(copy|cell)/)
})

test('launch test: rows in step order, Payout reads Hourly payout, unknown labels after, empty stays empty', () => {
  const rows = F.ltRows([{ label: 'Payout', sig: 'p' }, { label: 'Settle', sig: 's' }, { label: 'Cancel', sig: 'c' }, { label: 'Listing', sig: 'l' }, { label: 'Bid', sig: 'b' }, { label: 'Outbid refund', sig: 'o' }])
  assert.deepEqual(rows.map((r) => r.sig), ['l', 'b', 'o', 's', 'p', 'c'])
  assert.equal(F.ltLabel('Payout'), 'Hourly payout'); assert.equal(F.ltLabel('Fixed buy'), 'Fixed buy')
  assert.deepEqual(F.ltRows([]), []); assert.deepEqual(F.ltRows(null), [])
  assert.equal(F.utcWhen(1762450000), '6 Nov 2025 17:26 UTC')
  assert.deepEqual(F.LT_ORDER, ['Listing', 'Bid', 'Outbid refund', 'Settle', 'Fixed buy', 'Accept', 'Refund', 'Hourly payout'])
})

test('upgrade key: the configured key only before the deploy, the chain after, nothing once revoked', () => {
  const K = { upgradeAuthority: 'OwnerKey' }
  assert.equal(T.upKey({ upgrade: { state: 'undeployed' } }, K), 'OwnerKey')
  assert.equal(T.upKey({ upgrade: { state: 'undeployed' } }, {}), null)
  assert.equal(T.upKey({ upgrade: { state: 'key', authority: 'ChainKey' } }, K), 'ChainKey')
  assert.equal(T.upKey({ upgrade: { state: 'revoked' } }, K), null)
  const C0 = { brand: { name: 'W', ticker: 'W' }, keys: {}, chain: { programId: 'P' }, facts: {} }
  const html = JSON.stringify(T.DOCS(C0, { upgrade: { state: 'undeployed' } }))
  assert.match(html, /Set when the program deploys/); assert.doesNotMatch(html, /[Ee]rror/)
  assert.match(JSON.stringify(T.DOCS({ ...C0, keys: K }, { upgrade: { state: 'revoked' } })), /Upgrade key.*Revoked/)
  assert.doesNotMatch(JSON.stringify(T.DOCS({ ...C0, keys: K }, { upgrade: { state: 'revoked' } })), /OwnerKey/)
})

test('copy: X, never Twitter; no audit or review talk anywhere in the docs', () => {
  assert.equal(XN.xLabel('Twitter'), 'X'); assert.equal(XN.xLabel('Continue with Twitter'), 'Continue with X'); assert.equal(XN.xLabel('Twitterverse'), 'Twitterverse')
  const C0 = { brand: { name: 'W', ticker: 'W' }, keys: {}, chain: { programId: 'P' }, facts: { contractTests: 182, serverTests: 265 } }
  for (const T0 of [null, { upgrade: { state: 'undeployed' } }, { upgrade: { state: 'revoked' } }]) {
    const all = JSON.stringify(T.DOCS(C0, T0)).replace(/<[^>]+>/g, ' ')
    assert.doesNotMatch(all, /\baudit|\breview|\bAI\b|twitter/i)
  }
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /Outside audit|docs\/audit/)
})

test('X post card: built from the stored post, links only to x.com, a preview post links nowhere', () => {
  const post = { id: '1', url: 'https://x.com/sidebidsol/status/1', text: 'Drop 3 of 12 is live: 1,441,300 $SIDEBID, starting bid 0.1234 SOL, ends in 4 minutes.<img>', at: Date.UTC(2026, 10, 6, 19, 2), author: { name: 'Sidebid', handle: 'sidebidsol', avatar: 'https://pbs.twimg.com/a.png', verified: true } }
  const full = F.xPostCard(post)
  assert.match(full, /^<a class="xcard" href="https:\/\/x\.com\/sidebidsol\/status\/1" target="_blank" rel="noopener"/)
  assert.match(full, /<span class="xc-l">\$SIDEBID<\/span>/, 'cashtag in X blue')
  assert.match(full, /@sidebidsol/); assert.match(full, /src="\/api\/site\/xavatar\/sidebidsol"/); assert.match(full, /aria-label="Verified account"/)
  assert.doesNotMatch(full, /<img>/, 'post text is escaped')
  const inCard = F.xPostCard(post, { compact: true, inLink: true })
  assert.match(inCard, /^<span class="xcard sm" role="link" tabindex="0" data-xurl="https:\/\/x\.com\/sidebidsol\/status\/1"/)
  assert.doesNotMatch(inCard, /<a /, 'no link inside the card link')
  const pv = F.xPostCard({ ...post, url: null, preview: true })
  assert.match(pv, /Preview post, not on X/); assert.doesNotMatch(pv, /href=|data-xurl/)
  assert.doesNotMatch(F.xPostCard({ ...post, url: 'https://evil.example/x' }), /evil/)
  assert.equal(F.xPostCard(null), '')
  assert.match(F.xTime(Date.UTC(2026, 10, 6, 19, 2)), /·.*Nov 6, 2026$/)
})

test('Wallet coins and holders come from our server, the browser RPC only when it fails', async () => {
  CH.useChain({ chain: { rpc: 'http://127.0.0.1:9', cluster: 'mainnet-beta' } })
  const owner = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58()
  const row = { mint, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', tokenAccount: Keypair.generate().publicKey.toBase58(), amount: '1000000000000', delegated: false, decimals: 6, name: null, symbol: null, image: null, usd: null }
  const asked = [], real = globalThis.fetch
  try {
    globalThis.fetch = async (u) => { asked.push(String(u)); return new Response(JSON.stringify({ items: [row] }), { status: 200 }) }
    assert.deepEqual(await CH.walletCoins(owner), [row])
    assert.deepEqual(await CH.walletCoins(owner, mint), [row])
    assert.deepEqual(asked, [`/api/chain/coins/${owner}`, `/api/chain/coins/${owner}?mint=${mint}`])
    await CH.holders(mint)
    assert.equal(asked.at(-1), `/api/chain/holders/${mint}`)
    // Server down: the browser RPC is asked instead
    globalThis.fetch = async () => new Response('{"error":"chain_read_failed"}', { status: 503 })
    let rpcAsked = 0
    CH.connection().getTokenAccountsByOwner = async () => { rpcAsked++; return { value: [] } }
    assert.deepEqual(await CH.walletCoins(owner), [])
    assert.equal(rpcAsked, 2, 'both token programs')
    await assert.rejects(CH.walletCoins('not a key'))
  } finally { globalThis.fetch = real }
  assert.equal(CH.isKey(mint), true); assert.equal(CH.isKey(` ${mint} `), true)
  for (const bad of ['', 'abc', mint + 'x', '1'.repeat(44), null]) assert.equal(CH.isKey(bad), false)
})

test('Confirm waits on the height read from a blockhash, never getBlockHeight (the free RPC gives the slot there)', () => {
  const src = readFileSync(here + '../src/chain.js', 'utf8')
  assert.doesNotMatch(src, /getBlockHeight\(/)
  assert.match(src, /lastValidBlockHeight - 150/)
})
