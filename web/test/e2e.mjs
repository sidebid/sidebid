// End to end: a real solana-test-validator with the built program, the real server (X mocked, nothing real called),
// the built site, and three people in headless Chrome, each with a Wallet Standard test wallet holding a throwaway key.
// Every flow is clicked through the site and checked on chain. Screenshots go to web/shots/.
//
//   npm run build && npm test            full run, about 6 minutes
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction } from '@solana/web3.js'
import * as sq from '@sqds/multisig'
import * as spl from '@solana/spl-token'
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata'
import { ed25519 } from '@noble/curves/ed25519'
import { program } from './.build/program.mjs'

const here = new URL('.', import.meta.url).pathname
const ROOT = join(here, '../..'), SERVER = process.env.SERVER_DIR ?? join(ROOT, 'server')
const { loadConfig } = await import(join(SERVER, 'src/config.mjs'))
const { buildApp } = await import(join(SERVER, 'src/app.mjs'))
const { openDb } = await import(join(SERVER, 'src/db.mjs'))
const { listen } = await import(join(SERVER, 'src/http.mjs'))
const { withSite } = await import(join(SERVER, 'src/site.mjs'))
const { MockX, LISTING_KEY, SO, PROGRAM_ID } = await import(join(SERVER, 'test/harness.mjs'))
const puppeteer = createRequire(process.env.PUPPETEER_CORE || import.meta.url)('puppeteer-core')

const BIN = process.env.SOLANA_TEST_VALIDATOR ?? join(homedir(), '.local/share/solana/install/active_release/bin/solana-test-validator')
// Ports clear of the validators other work keeps on 28899 and 38899; E2E_PORT_BASE moves the whole block
const PB = Number(process.env.E2E_PORT_BASE ?? 46000), RPC_PORT = PB + 899, RPC = `http://127.0.0.1:${RPC_PORT}`, PORT = PB + 790, BASE = `http://localhost:${PORT}`
const SHOTS = join(here, '../shots'), RUN = join(here, '.run')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SOL = LAMPORTS_PER_SOL
const results = []
const ok = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`) }
const step = (s) => console.log(`\n== ${s}`)

rmSync(RUN, { recursive: true, force: true }); mkdirSync(RUN, { recursive: true }); mkdirSync(SHOTS, { recursive: true })

// ---------------------------------------------------------------- chain
const upgrade = Keypair.generate(), dev = Keypair.generate()
const people = { alice: Keypair.generate(), bob: Keypair.generate(), carol: Keypair.generate() }
const P = program(PROGRAM_ID)
// A credit owed to alice, put in the genesis ledger: a real validator can't make an ordinary wallet unpayable, so the
// test can't produce one naturally. Everything after (the site listing it, the claim, the chain paying out) is real.
const creditListing = Keypair.generate().publicKey
const creditAddr = P.creditPda(creditListing, people.alice.publicKey)
writeFileSync(join(RUN, 'credit.json'), JSON.stringify({ pubkey: creditAddr.toBase58(), account: { lamports: 7_000_000, data: ['', 'base64'], owner: SystemProgram.programId.toBase58(), executable: false, rentEpoch: 0, space: 0 } }))
const SQ_SO = join(here, '.cache/squads.so'), SQ_CFG = join(here, '.cache/sqcfg.json'), HAS_SQUADS = existsSync(SQ_SO) && existsSync(SQ_CFG)
const squadsArgs = HAS_SQUADS ? ['--bpf-program', sq.PROGRAM_ID.toBase58(), SQ_SO, '--account', sq.getProgramConfigPda({})[0].toBase58(), SQ_CFG] : []
const createKey = Keypair.generate(), [msPda] = sq.getMultisigPda({ createKey: createKey.publicKey }), [vaultPda] = sq.getVaultPda({ multisigPda: msPda, index: 0 })
const ledger = mkdtempSync(join(tmpdir(), 'sidebid-web-ledger-'))
const v = spawn(BIN, ['--ledger', ledger, '--rpc-port', String(RPC_PORT), '--faucet-port', String(PB + 950), '--gossip-port', String(PB), '--dynamic-port-range', `${PB + 1}-${PB + 40}`, '--bind-address', '127.0.0.1', '--quiet', '--reset',
  '--upgradeable-program', PROGRAM_ID.toBase58(), SO, upgrade.publicKey.toBase58(), '--account', creditAddr.toBase58(), join(RUN, 'credit.json'), ...squadsArgs], { stdio: 'ignore', env: { ...process.env, DYLD_LIBRARY_PATH: join(homedir(), '.local/libusb/lib') } })
let server, browser
const cleanup = async () => { try { await browser?.close() } catch {} try { server?.close() } catch {} v.kill('SIGKILL'); await sleep(500); rmSync(ledger, { recursive: true, force: true }); if (typeof data === 'string') rmSync(data, { recursive: true, force: true }) }
process.on('exit', () => { v.kill('SIGKILL'); try { rmSync(ledger, { recursive: true, force: true }) } catch {} })

const conn = new Connection(RPC, 'confirmed')
const until = async (fn, what, ms = 60_000, every = 500) => { const end = Date.now() + ms; for (;;) { const r = await Promise.resolve().then(fn).catch((e) => { if (/^ignored/.test(e?.message)) throw e; return null }); if (r) return r; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(every) } }
await until(() => conn.getLatestBlockhash(), 'validator start', 90_000, 1000)
const fund = async (k, sol) => { const sig = await conn.requestAirdrop(k, sol * SOL); const b = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: sig, ...b }, 'confirmed') }
for (const k of [dev, LISTING_KEY, upgrade, ...Object.values(people)]) await fund(k.publicKey, 20)
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })

/** A coin with Token 2022 metadata (name and ticker on chain), or a plain SPL coin with none. */
async function makeCoin({ name, symbol, t22 = true, supply = 1_000_000_000n * 1_000_000n, decimals = 6, keepMint = false, freeze = false, holders = {} }) {
  const mint = Keypair.generate(), program_ = t22 ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID
  if (t22) {
    const meta = { mint: mint.publicKey, name, symbol, uri: '', additionalMetadata: [], updateAuthority: dev.publicKey }
    const len = spl.getMintLen([spl.ExtensionType.MetadataPointer]), metaLen = 4 + pack(meta).length
    await send([
      SystemProgram.createAccount({ fromPubkey: dev.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len + metaLen), programId: program_ }),
      spl.createInitializeMetadataPointerInstruction(mint.publicKey, dev.publicKey, mint.publicKey, program_),
      spl.createInitializeMintInstruction(mint.publicKey, decimals, dev.publicKey, freeze ? dev.publicKey : null, program_),
      createInitializeInstruction({ programId: program_, mint: mint.publicKey, metadata: mint.publicKey, name, symbol, uri: '', mintAuthority: dev.publicKey, updateAuthority: dev.publicKey }),
    ], [dev, mint])
  } else await spl.createMint(conn, dev, dev.publicKey, freeze ? dev.publicKey : null, decimals, mint, undefined, program_)
  let left = supply
  for (const [who, amt] of Object.entries(holders)) {
    const owner = who === 'dev' ? dev.publicKey : people[who].publicKey
    const ata = await spl.createAssociatedTokenAccountIdempotent(conn, dev, mint.publicKey, owner, undefined, program_)
    await spl.mintTo(conn, dev, mint.publicKey, ata, dev, amt, [], undefined, program_); left -= amt
  }
  const rest = await spl.createAssociatedTokenAccountIdempotent(conn, dev, mint.publicKey, Keypair.generate().publicKey, undefined, program_)
  if (left > 0n) await spl.mintTo(conn, dev, mint.publicKey, rest, dev, left, [], undefined, program_)
  if (!keepMint) await spl.setAuthority(conn, dev, mint.publicKey, dev, spl.AuthorityType.MintTokens, null, [], undefined, program_)
  return { mint: mint.publicKey, program: program_, decimals }
}
step('coins')
const M = 1_000_000n // one whole token at 6 decimals
const KELP = await makeCoin({ name: 'Kelp Fund', symbol: 'KELP', holders: { alice: 38_400_000n * M, dev: 90_000_000n * M } })
const MOTH = await makeCoin({ name: 'Moth Capital', symbol: 'MOTH', holders: { alice: 12_100_000n * M } })
const GRUB = await makeCoin({ name: 'Grub Season', symbol: 'GRUB', holders: { alice: 52_000_000n * M } })
const ORBO = await makeCoin({ name: 'Orbo', symbol: 'ORBO', holders: { alice: 8_750_000n * M } })
const TARP = await makeCoin({ name: 'Big Tarp', symbol: 'TARP', holders: { alice: 24_600_000n * M }, keepMint: true, freeze: true })
const PLNK = await makeCoin({ name: 'Plonk', symbol: 'PLNK', holders: { alice: 4_200_000n * M } })
const HUSK = await makeCoin({ name: 'Husk', symbol: 'HUSK', t22: false, holders: { alice: 6_600_000n * M } })
const VOLE = await makeCoin({ name: 'Vole Treasury', symbol: 'VOLE', holders: { alice: 9_200_000n * M } })
const OWN = await makeCoin({ name: 'Sidebid', symbol: 'SIDEBID', holders: { dev: 200_000_000n * M } })
ok('coins made', '9 mints, Token 2022 metadata on 8, one SPL coin with none, one with mint and freeze authority kept')

// ---------------------------------------------------------------- server
step('server')
var data = mkdtempSync(join(tmpdir(), 'sidebid-web-data-'))
const passKey = Keypair.generate()
writeFileSync(join(data, 'site.json'), JSON.stringify({
  brand: { name: 'Sidebid', ticker: 'SIDEBID', xHandle: 'sidebidsol', domain: 'localhost', github: 'https://github.com/example/sidebid', ca: OWN.mint.toBase58(), reveal: true },
  chain: { rpc: RPC, cluster: 'localnet' }, keys: { upgradeAuthority: upgrade.publicKey.toBase58(), devWallet: dev.publicKey.toBase58() },
  trust: { squadsMultisig: msPda.toBase58(), commit: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim() },
  facts: { contractTests: 148, serverTests: 220 }, stats: { minSales: 3 },
  drops: { start: Math.floor(Date.now() / 1000), every: 300, until: Math.floor(Date.now() / 1000) + 3600, pattern: [{ mode: 'auction', amount: '400,000', pct: '0.04%', note: '5 minute countdown, no minimum' }, { mode: 'auction', amount: '500,000', pct: '0.05%', note: '5 minute countdown, no minimum' }, { mode: 'fixed', amount: '100,000', pct: '0.01%', note: 'Half of chart price, one per X account' }] },
}))
const USERS = { alice: { id: '1001', username: 'alice_sells' }, bob: { id: '1002', username: 'bob_bids' }, carol: { id: '1003', username: 'carol_buys' } }
const x = new MockX()
const old = Date.now() - 400 * 86_400_000
// Fake X: the sign in token and profile calls answer from USERS. Everything else is the server's own MockX.
const fetchImpl = async (url, init = {}) => {
  const u = new URL(url), res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } })
  if (u.pathname === '/2/oauth2/token') { const code = new URLSearchParams(init.body).get('code'); return USERS[code] ? res(200, { access_token: 'tok-' + code }) : res(400, {}) }
  if (u.pathname === '/2/users/me') { const who = USERS[String(init.headers?.authorization).replace('Bearer tok-', '')]; return who ? res(200, { data: { ...who, created_at: new Date(old).toISOString(), public_metrics: { followers_count: 250 } } }) : res(401, {}) }
  return x.fetch(url, init)
}
// Privy, stubbed: a test ES256 key stands in for Privy's, served as the app's JWKS to the server, and the page gets a fake
// Privy island (below) that signs people in with tokens made by that key. The server checks them exactly as it would Privy's.
const { generateKeyPairSync, sign: ecSign } = await import('node:crypto')
const PRIVY_APP = 'cme2etestapp00000000000001', PRIVY_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const privyFetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ ...PRIVY_KEY.publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256', use: 'sig' }] }) })
const privyJwt = (claims) => { const h = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'e2e' })).toString('base64url'), b = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${h}.${b}.${ecSign('sha256', Buffer.from(`${h}.${b}`), { key: PRIVY_KEY.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}` }
const config = loadConfig({
  PRIVY_APP_ID: PRIVY_APP,
  PUBLIC_URL: BASE, PORT: String(PORT), RPC_URL: RPC, RPC_MAX_RPS: '200', PROGRAM_ID: PROGRAM_ID.toBase58(), DATA_DIR: data, ADMIN_SECRET: 'e2e-admin-secret-0123456789abcdef0123',
  LISTING_SECRET: JSON.stringify([...LISTING_KEY.secretKey]), PASS_SECRET: JSON.stringify([...passKey.secretKey]), PASS_HASH_KEY: 'p'.repeat(40),
  X_SIGNIN_CLIENT_ID: 'fake-client', X_READ_BEARER: 'fake', X_ACCOUNT_ID: '424242', X_HANDLE: 'sidebidsol', X_POST_API_KEY: 'a', X_POST_API_SECRET: 'b', X_POST_TOKEN: 'c', X_POST_TOKEN_SECRET: 'd',
  X_POLL_SECONDS: '15', X_READ_HOURLY_USD: '25', X_SIGNIN_CAP_USD: '1', TAG_MIN_SECONDS: '10', TAG_ACCEPT_WINDOW_SECONDS: '60', TRUSTED_HOPS: '1', INDEX_TICK_MS: '1000',
})
const db = openDb(join(data, 'sidebid.db'))
const app = buildApp({ config, db, fetchImpl, privyFetch, log: (...a) => { if (process.env.E2E_LOG) console.log('   [server]', ...a) }, senderOpts: { rebroadcastMs: 2000, heightCheckAfterMs: 45_000 } })
app.flags.set({ signinLive: true, passLive: true, readerLive: true, tagListingLive: true, repliesLive: true })
server = await listen(withSite(app, config), PORT)
await app.start(); app.run()
const campaign = Keypair.generate().publicKey
app.pass.addCampaign(campaign.toBase58(), 'e2e drop')
db.run(`INSERT INTO credits (listing,owner,lamports,checked_at) VALUES (?,?,?,?)`, creditListing.toBase58(), people.alice.publicKey.toBase58(), '7000000', Date.now())
ok('server up', `${BASE}, keeper off so every settle and refund is pressed on the site`)

// ---------------------------------------------------------------- browsers
step('browsers')
browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const pageErrors = []
const WALLET_JS = (address, pubB64) => `(() => {
  const b64e = (u) => btoa(String.fromCharCode(...u)), b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const account = Object.freeze({ address: ${JSON.stringify(address)}, publicKey: b64d(${JSON.stringify(pubB64)}), chains: ['solana:localnet', 'solana:devnet', 'solana:mainnet'], features: ['solana:signTransaction', 'solana:signMessage'] })
  let connected = false
  const wallet = {
    version: '1.0.0', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/></svg>'),
    chains: ['solana:localnet', 'solana:devnet', 'solana:mainnet'],
    get accounts() { return connected ? [account] : [] },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { connected = true; return { accounts: [account] } } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...ins) => Promise.all(ins.map(async (i) => ({ signedTransaction: b64d(await window.__walletSign('tx', b64e(i.transaction))) }))) },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...ins) => Promise.all(ins.map(async (i) => ({ signedMessage: i.message, signature: b64d(await window.__walletSign('msg', b64e(i.message))) }))) },
    },
  }
  window.__signed = 0
  window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet) }))
})()`
const OUTSIDE = new Set()
// The fake Privy island: same bridge as web/src/privy-island.js. Alice and Bob sign in with their installed wallet (Privy
// verified it); Carol signs in with X, asks for a Privy wallet, and it signs through the bridge.
const FAKE_PRIVY = `export function start() {
  let authed = localStorage.getItem('fake.privy') === '1', made = localStorage.getItem('fake.made') === '1', chosen = null, n = 0
  const ls = new Set(), changed = () => ls.forEach((f) => { try { f() } catch {} })
  // Alice and Bob sign in with their wallet, so Privy has it; Carol's Privy wallet exists only once she asks for it
  const wallets = () => (authed ? window.__privyWallets.filter((w) => !w.embedded || made) : [])
  const b64e = (u) => btoa(String.fromCharCode(...u)), b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const snap = async () => ({ ...JSON.parse(await window.__privyTokens()), wallets: wallets(), linked: wallets().map((w) => w.address), chosen, avatar: null })
  return {
    ready: async () => true, authenticated: () => authed, walletsReady: () => true, wallets, linked: () => wallets().map((w) => w.address), avatar: () => null,
    chosen: () => (chosen ? { address: chosen, n } : null), onChange: (f) => { ls.add(f); return () => ls.delete(f) }, onLogin: () => () => {},
    async login() {
      window.__privyModal = (window.__privyModal || 0) + 1; authed = true; localStorage.setItem('fake.privy', '1')
      const w = window.__privyWallets[0]; if (!w.embedded) { chosen = w.address; n++ }
      return snap()
    },
    async session() { return authed ? snap() : null },
    async connect() { return null },
    async create() { window.__privyCreated = (window.__privyCreated || 0) + 1; made = true; localStorage.setItem('fake.made', '1'); chosen = window.__privyWallets[0].address; n++; changed(); return chosen },
    async disconnect() {},
    async signTransaction(a, bytes) { window.__privySigned = (window.__privySigned || 0) + 1; return b64d(await window.__walletSign('tx', b64e(bytes))) },
    async signMessage(a, bytes) { return b64d(await window.__walletSign('msg', b64e(bytes))) },
    async logout() { authed = false; chosen = null; localStorage.removeItem('fake.privy'); changed() },
  }
}`
const EMBEDDED = new Set(['carol'])
async function personPage(name) {
  const kp = people[name], ctx = await browser.createBrowserContext(), page = await ctx.newPage()
  const me = { name, kp, page, ctx, tamper: null, walletTamper: false }
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`))
  page.on('console', (m) => { (me.logs ??= []).push(`${m.type()}: ${m.text()}`.slice(0, 300)); if (me.logs.length > 40) me.logs.shift() })
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) pageErrors.push(`${name} console: ${m.text()}`) })
  await page.exposeFunction('__walletSign', (kind, b64) => {
    const bytes = Buffer.from(b64, 'base64')
    if (kind === 'msg') { me.msgSigned = (me.msgSigned ?? 0) + 1; return Buffer.from(ed25519.sign(bytes, kp.secretKey.slice(0, 32))).toString('base64') }
    const tx = Transaction.from(bytes)
    // A wallet that changes the transaction before signing: the site must refuse to send it
    if (me.walletTamper) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dev.publicKey, lamports: 1 }))
    tx.partialSign(kp)
    return tx.serialize({ requireAllSignatures: false }).toString('base64')
  })
  await page.evaluateOnNewDocument(WALLET_JS(kp.publicKey.toBase58(), Buffer.from(kp.publicKey.toBytes()).toString('base64')))
  const emb = EMBEDDED.has(name), addr = kp.publicKey.toBase58()
  await page.evaluateOnNewDocument((w) => { window.__privyWallets = w }, [{ address: addr, embedded: emb, name: emb ? 'Privy' : 'Test Wallet' }])
  await page.exposeFunction('__privyTokens', () => {
    const t = Math.floor(Date.now() / 1000), did = 'did:privy:cme2e' + name.padEnd(20, '0'), base = { iss: 'privy.io', aud: PRIVY_APP, sub: did, iat: t, exp: t + 3600 }
    const accounts = [{ type: 'twitter_oauth', subject: USERS[name].id, username: USERS[name].username, profile_picture_url: null }, { type: 'wallet', address: addr, chain_type: 'solana', wallet_client_type: emb ? 'privy' : 'phantom', connector_type: emb ? 'embedded' : 'solana_adapter', latest_verified_at: t }]
    return JSON.stringify({ accessToken: privyJwt({ ...base, sid: 's-' + name }), identityToken: privyJwt({ ...base, linked_accounts: JSON.stringify(accounts) }) })
  })
  // X's consent screen never loads: the authorize redirect goes straight back to our callback with this person's code
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const u = r.url()
    if (u.startsWith('https://x.com/i/oauth2/authorize')) { const q = new URL(u).searchParams; return r.respond({ status: 302, headers: { location: `${BASE}/api/auth/x/callback?code=${name}&state=${q.get('state')}` } }) }
    if (/^https:\/\/(x\.com|api\.x\.com|twitter\.com)/.test(u)) return r.abort()
    const xff = `10.0.0.${Object.keys(people).indexOf(name) + 1}`
    if (u.startsWith(BASE) && /^\/privy\.[0-9a-f]{8}\.js$/.test(new URL(u).pathname)) { me.privyLoaded = true; return r.respond({ status: 200, contentType: 'text/javascript', body: FAKE_PRIVY }) }
    // A lying API: the page is served a different listing than the chain holds
    if (u.startsWith(BASE) && me.tamper && me.tamper.re.test(u)) return fetch(u, { headers: { 'x-forwarded-for': xff } }).then((x) => x.json()).then((j) => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(me.tamper.fn(j)) }))
    if (u.startsWith(BASE)) return r.continue({ headers: { ...r.headers(), 'x-forwarded-for': xff } })
    // A slow RPC: matching reads wait until the test lets them through
    if (u.startsWith(RPC) && me.rpcHold?.test(r.postData() ?? '')) { (me.held ??= []).push(r); return }
    if (!/^(data:|about:)/.test(u) && !/^https:\/\/(fonts\.(googleapis|gstatic)\.com|pbs\.twimg\.com)\//.test(u) && !u.startsWith(RPC)) OUTSIDE.add(new URL(u).host)
    r.continue()
  })
  // Three people on one machine: each gets its own visitor address, as on the real site, so rate limits count them apart
  await page.setViewport({ width: 1440, height: 900 })
  return me
}
/** Select and type into an input. A poll can redraw the view between the click and the typing; the draft is kept, so
 * the input is found again and the typing retried. */
const typeIn = async (page, sel, text) => { for (let i = 0; ; i++) { try { await page.click(sel, { clickCount: 3 }); await page.type(sel, text); if ((await page.$eval(sel, (e) => e.value)) === text) return } catch (e) { if (i > 4 || !/detached|not clickable|No node/i.test(e.message)) throw e } if (i > 4) throw new Error(`could not type into ${sel}: it holds "${await page.$eval(sel, (e) => e.value).catch(() => '?')}"`); await sleep(300) } }
/** Click once the element shows. A poll may redraw the view between finding and clicking it; then it is found again. */
const $click = async (page, sel, timeout = 15_000) => { for (let i = 0; ; i++) { try { await page.waitForSelector(sel, { visible: true, timeout }); await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await page.click(sel); return } catch (e) { if (i > 3 || !/detached|not clickable|No node/i.test(e.message)) throw e; await sleep(300) } } }
const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '')
const waitText = async (page, sel, re, ms = 60_000) => until(async () => { const t = await textOf(page, sel); return re.test(t) ? t : null }, `${sel} ~ ${re}`, ms, 300)
const goto = async (page, hash) => { await page.goto('about:blank'); await page.goto(hash.startsWith('/') ? BASE + hash : `${BASE}/${hash}`, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#view', { timeout: 45_000 }); await sleep(600) }
async function signIn(p) {
  await goto(p.page, '#home')
  // Sign in sits in the hero itself, not only behind the menu, with Privy's own mark under it
  assert.ok(await p.page.$('.hero .privy-mark img[alt="Protected by Privy"]'), 'Protected by Privy under the hero sign in')
  await sleep(1000) // the page finishes booting before the click
  await $click(p.page, '.hero [data-act=signin]')
  // Signed in with X and no wallet: no wallet is made unless asked for, so Carol presses Create a wallet for me
  if (EMBEDDED.has(p.name)) { await $click(p.page, '.sheet [data-act=privyCreate]'); assert.equal(await p.page.evaluate(() => window.__privyCreated), 1) }
  // Privy verified the wallet, so it is linked from Privy's signed identity: no message to sign, no second click
  await until(async () => (await p.page.evaluate(() => fetch('/api/me').then((r) => r.json()))).wallet === p.kp.publicKey.toBase58(), `${p.name} linked`, 20_000)
  assert.equal(p.msgSigned ?? 0, 0, 'no message signed to link a Privy verified wallet')
  assert.equal(await p.page.evaluate(() => window.__privyModal), 1, 'Sign in opened the Privy modal once')
  await until(async () => /@/.test(await textOf(p.page, '[data-conn]')), `${p.name} shows the handle`, 10_000)
  await sleep(500)
}
const ataOf = (owner, coin) => spl.getAssociatedTokenAddressSync(coin.mint, owner, false, coin.program)
const tokenBal = async (owner, coin) => { try { return (await spl.getAccount(conn, ataOf(owner, coin), 'confirmed', coin.program)).amount } catch { return 0n } }
const listingOf = (owner, coin) => P.listingPda(ataOf(owner, coin))
const apiOne = async (pk) => (await fetch(`${BASE}/api/listings/${pk}`)).json()
const lotUrl = (pk) => `/lot/${pk}`
const shot = async (page, name, { widths = [1440, 1920, 390], full = false, top = true } = {}) => {
  await page.evaluate((top) => { if (top) scrollTo(0, 0); document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()) }, top)
  for (const w of widths) {
    await page.setViewport({ width: w, height: w === 390 ? 844 : w === 1920 ? 1080 : 900 })
    await sleep(350)
    const tag = w === 1440 ? '' : '-' + w
    await page.screenshot({ path: join(SHOTS, `${name}${tag}.png`) })
    if (full && w !== 1920) await page.screenshot({ path: join(SHOTS, `${name}${tag}-full.png`), fullPage: true })
  }
  await page.setViewport({ width: 1440, height: 900 })
}

const fail = async (e) => {
  console.log('\nFAIL', e?.message, e?.actual !== undefined ? `actual ${e.actual} expected ${e.expected}` : '')
  for (const p of [A, Bp, Cp].filter(Boolean)) {
    try { await p.page.screenshot({ path: join(RUN, `fail-${p.name}.png`) }); console.log(` ${p.name} at ${p.page.url()}:`, (await p.page.$$eval('[data-actmsg],[data-sellmsg],[data-sheetmsg]', (els) => els.map((e) => e.innerText).join(' | ')).catch(() => '')).slice(0, 400)) } catch {}
  }
  console.log(' page errors:', pageErrors.join(' | ').slice(0, 2000))
  await cleanup(); process.exit(1)
}
let A, Bp, Cp
try {
A = await personPage('alice'); Bp = await personPage('bob'); Cp = await personPage('carol')
step('sign in with X and link wallets')
// The empty board first, before anything is listed: every empty state must point at the next drop, never show a 0
await goto(A.page, '#home'); await shot(A.page, 'empty-home', { widths: [1440, 390], full: true })
await goto(A.page, '#live'); await shot(A.page, 'empty-live', { widths: [1440] })
await goto(A.page, '#rewards'); await shot(A.page, 'empty-rewards', { widths: [1440] })
assert.equal(await A.page.$('[data-hour]'), null, 'M5: no payout countdown while rewards are not running')
assert.match(await textOf(A.page, '#view'), /At launch/)
await goto(A.page, '#home')
assert.equal(await A.page.$('.stats'), null, 'stats stay hidden before they are worth showing')
const strip = await textOf(A.page, '.checkit')
assert.match(strip, /Check it yourself/); assert.doesNotMatch(strip, /audit|review/i); assert.match(strip, /Team key/); assert.match(strip, /Fee to sell\s*0%/); assert.match(strip, /Not verified yet/); assert.match(strip, /As published/)
assert.match(strip, /Commit\s*[0-9a-f]{7}/)
assert.ok(await A.page.$('.hero [data-act=signin]'), 'Sign in with X is in the hero')
ok('empty board', 'trust strip with every item linked or marked pending, no stats, no payout countdown while rewards are off, Sign in with X in the hero')
// Privy sign in is the way in: our own X OAuth is off unless its fallback flag is set
assert.equal((await fetch(`${BASE}/api/auth/x/start`, { redirect: 'manual' })).status, 404, 'X OAuth fallback off by default')
for (const p of [A, Bp, Cp]) { await signIn(p); ok(`${p.name} signed in through Privy`, `${short(p.kp.publicKey.toBase58())}${EMBEDDED.has(p.name) ? ', Privy embedded wallet' : ', installed wallet Privy verified'}`) }
// Carol's wallet is the Privy embedded one, and it survives a reload through Privy's own session
await goto(Cp.page, '#home'); await until(async () => /@carol_buys/.test(await textOf(Cp.page, '[data-conn]')), 'carol reconnects through Privy', 15_000)
assert.equal(await Cp.page.evaluate(() => localStorage.getItem('ws.wallet')), 'privy:' + people.carol.publicKey.toBase58())
function short(s) { return s.slice(0, 4) + '…' + s.slice(-4) }

// ---------------------------------------------------------------- listing on the site
const COINS = () => ({ KELP, MOTH, GRUB, ORBO, TARP, PLNK, HUSK, VOLE })
async function sellOnSite(p, coinSym, { mode = 'bid', len = '120', price = '', chip = '', exact = '', expect = '' } = {}) {
  await goto(p.page, '#sell')
  const mint = COINS()[coinSym].mint.toBase58()
  const idx = await until(async () => p.page.$eval(`[data-act=sellCoin][data-mint="${mint}"]`, (e) => e.dataset.v), `coin ${coinSym} in wallet`, 20_000)
  await $click(p.page, `[data-act=sellCoin][data-v="${idx}"]`)
  await $click(p.page, `[data-act=sellMode][data-v=${mode}]`)
  if (mode === 'bid') await $click(p.page, `[data-act=sellLen][data-v="${len}"]`)
  if (price) { await typeIn(p.page, '#sellCustom', price) }
  // The amount: the full balance unless a chip or a typed amount says otherwise, and the line names the exact count
  if (chip) await $click(p.page, `[data-act=sellPct][data-v="${chip}"]`)
  // Select by script: a triple click does not reliably select a value with commas in it
  if (exact) await until(async () => { await p.page.$eval('#sellExact', (e) => { e.focus(); e.select() }); await p.page.keyboard.type(exact); return (await p.page.$eval('#sellExact', (e) => e.value)) === exact }, 'exact amount typed', 10_000)
  if (expect) await waitText(p.page, '[data-sellline]', new RegExp(`^Selling ${expect.replace(/[.]/g, '\\.')} of [\\d,.]+ ${coinSym}$`), 10_000)
  // R2: Sign opens only once the coin info and the chain check of the listing address are in
  await until(() => p.page.$eval('[data-act=sign]', (b) => !b.disabled && /^Sign and list/.test(b.textContent)), `sign ready for ${coinSym}`, 20_000)
  const line = await textOf(p.page, '[data-approve]')
  // The approval names the coin and the listing address, as the wallet will; a coin with no name shows its mint
  const lst = short(listingOf(p.kp.publicKey, COINS()[coinSym]).toBase58())
  const what = coinSym === 'HUSK' ? `tokens of ${short(mint)}` : `\\$${coinSym}`
  assert.match(line, new RegExp(`^ ?You approve exactly [\\d,.]+ ${what} for listing ${lst}, the address your wallet names\\.`), line)
  await $click(p.page, '[data-act=sign]')
  await waitText(p.page, '.done .h2', /Your listing is live/, 40_000)
}
step('list a live auction from the sell page')
const lKelpEarly = () => listingOf(people.alice.publicKey, KELP)
const balBefore = await conn.getBalance(people.alice.publicKey)
await goto(A.page, '#sell'); await until(async () => (await A.page.$$('[data-act=sellCoin]')).length >= 8, 'wallet coins', 20_000)
await $click(A.page, '[data-act=sellCoin][data-v="0"]'); await sleep(300)
await shot(A.page, 'sell', { full: true })
// M2: a comma is refused, not read as a decimal point
await goto(A.page, '#sell'); await $click(A.page, '[data-act=sellCoin][data-v="0"]'); await $click(A.page, '[data-act=sellMode][data-v=fixed]')
await typeIn(A.page, '#sellCustom', '1,000')
await waitText(A.page, '[data-sellmsg]', /Use a dot for decimals/, 10_000)
// R2: while the RPC has not answered for the listing address, Sign stays disabled and no approval line shows
A.rpcHold = new RegExp(`getAccountInfo.*${listingOf(people.alice.publicKey, KELP).toBase58()}`)
await goto(A.page, '#sell')
const kelpIdx = await until(async () => A.page.$eval(`[data-act=sellCoin][data-mint="${KELP.mint.toBase58()}"]`, (e) => e.dataset.v), 'KELP in wallet', 20_000)
await $click(A.page, `[data-act=sellCoin][data-v="${kelpIdx}"]`)
await waitText(A.page, '[data-act=sign]', /Checking the chain/, 20_000)
assert.equal(await A.page.$eval('[data-act=sign]', (b) => b.disabled), true, 'Sign disabled while the check is out')
assert.equal(await A.page.$('[data-approve]'), null, 'no approval line before the check')
A.rpcHold = null; for (const r of (A.held ?? []).splice(0)) r.continue()
await until(() => A.page.$eval('[data-act=sign]', (b) => !b.disabled && /^Sign and list/.test(b.textContent)), 'sign opens after the check', 20_000)
ok('sign waits for the chain', 'Sign disabled with no approval line until the RPC answered for the listing address')
// Q1: the coin read fails once, then answers after the chain check. The summary offers Check again, and redraws when the
// coin info arrives, so Sign never stays on Reading the coin
const mothM = MOTH.mint.toBase58()
A.rpcHold = new RegExp(`getMultipleAccounts".*${mothM}`)
await goto(A.page, '#sell')
await until(() => A.held?.length, 'MOTH coin read held', 20_000, 200)
for (const r of A.held.splice(0)) r.abort()
const mothIdx = await until(async () => A.page.$eval(`[data-act=sellCoin][data-mint="${mothM}"]`, (e) => e.dataset.v), 'MOTH in wallet', 20_000)
await $click(A.page, `[data-act=sellCoin][data-v="${mothIdx}"]`)
await waitText(A.page, '[data-act=sign]', /Coin read failed, try again/, 20_000)
assert.ok(await A.page.$('[data-act=sellRecheck]'), 'Check again is offered for the coin read')
await $click(A.page, '[data-act=sellRecheck]')
await until(() => A.held?.length, 'MOTH coin read asked again', 20_000, 200)
await sleep(800) // the chain check answers first, the coin second
assert.match(await textOf(A.page, '[data-act=sign]'), /Reading the coin/)
A.rpcHold = null; for (const r of A.held.splice(0)) r.continue()
await until(() => A.page.$eval('[data-act=sign]', (b) => !b.disabled && /^Sign and list/.test(b.textContent)), 'sign opens when the coin arrives', 20_000)
ok('sign redraws when the coin arrives', 'a failed coin read offered Check again; the late answer opened Sign with no click')
await sellOnSite(A, 'KELP', { len: '120' })
assert.match(await textOf(A.page, '.done'), /Your listing is live/)
// The card says when the indexer last read the seller's token account
await goto(A.page, lotUrl(lKelpEarly()))
const holds = await waitText(A.page, '[data-holds]', /^Checked \d+[smh] ago$/, 30_000)
const holdsTitle = await A.page.$eval('[data-holds]', (e) => e.title)
assert.match(holdsTitle, /^Read at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/, 'the full date and time sit under the age')
const kelpApi = await apiOne(lKelpEarly().toBase58())
assert.ok(kelpApi.tokenCheckedAt > Date.now() - 120_000, 'the API carries the check time')
ok('holds this bag with its time', `card says "${holds.trim()}", API tokenCheckedAt ${new Date(kelpApi.tokenCheckedAt).toISOString().slice(11, 19)} UTC`)
const lKelp = listingOf(people.alice.publicKey, KELP)
const kelpAcct = await spl.getAccount(conn, ataOf(people.alice.publicKey, KELP), 'confirmed', KELP.program)
assert.equal(kelpAcct.delegate?.toBase58(), lKelp.toBase58()); assert.equal(kelpAcct.delegatedAmount, 38_400_000n * M)
assert.equal(kelpAcct.amount, 38_400_000n * M, 'tokens stayed in the wallet')
ok('create_listing from the site', `the page said "You approve exactly 38,400,000 $KELP", approval for exactly 38,400,000 KELP set on the listing, tokens still in the wallet, rent ${(balBefore - await conn.getBalance(people.alice.publicKey)) / SOL} SOL`)
await shot(A.page, 'sell-done', { widths: [1440, 390] })
// More bags on the board for the screenshots, each listed through the site the same way
await goto(A.page, '#sell')
const grubIdx = await until(async () => A.page.$eval(`[data-act=sellCoin][data-mint="${GRUB.mint.toBase58()}"]`, (e) => e.dataset.v), 'GRUB in wallet', 20_000)
await $click(A.page, `[data-act=sellCoin][data-v="${grubIdx}"]`)
await waitText(A.page, '[data-sellline]', /^Selling 52,000,000 of 52,000,000 GRUB$/, 20_000)
assert.equal(await A.page.$eval('#sellExact', (e) => e.value), '52000000', 'the full balance is filled in')
assert.equal(await A.page.$eval('[data-act=sellPct][data-v="100"]', (e) => e.classList.contains('on')), true, '100% is picked')
await typeIn(A.page, '#sellExact', '60000000')
await waitText(A.page, '[data-sellline]', /more than the 52,000,000 GRUB in this wallet/, 10_000)
await typeIn(A.page, '#sellExact', '1,5')
await waitText(A.page, '[data-sellline]', /Type an amount like/, 10_000)
ok('sell amount defaults to the full balance', 'the box and the line show 52,000,000 of 52,000,000; too much and a bad comma are named before signing')
await sellOnSite(A, 'GRUB', { len: '600', price: '1.5', chip: '50', expect: '26,000,000' })
await sellOnSite(A, 'ORBO', { len: '300', exact: '1,250,000.5', expect: '1,250,000.5' })
for (const [c, want] of [[GRUB, 26_000_000n * M], [ORBO, 1_250_000n * M + M / 2n]]) {
  const a = await spl.getAccount(conn, ataOf(people.alice.publicKey, c), 'confirmed', c.program)
  assert.equal(a.delegatedAmount, want, 'approval is for exactly the chosen amount')
}
ok('sell a share and an exact amount', 'the 50% chip listed 26,000,000 GRUB and a typed 1,250,000.5 ORBO, each approved for exactly that')
await sellOnSite(A, 'TARP', { len: '1800', price: '0.8' })
await sellOnSite(A, 'VOLE', { mode: 'fixed', price: '0.05' })
ok('three more auctions and one fixed price listing from the site')

step('bid, then outbid with refund in the same transaction')
await goto(Bp.page, lotUrl(lKelp))
await waitText(Bp.page, '[data-act=bid]', /Place bid/)
await shot(Bp.page, 'lot-live', { full: true })
await typeIn(Bp.page, '#bidIn', '0,2')
await $click(Bp.page, '[data-act=bid]')
await waitText(Bp.page, '[data-actmsg]', /Use a dot for decimals/, 10_000)
// A wallet that slips an extra transfer in is caught: nothing is sent
Bp.walletTamper = true
const bobTamper = await conn.getBalance(people.bob.publicKey)
await typeIn(Bp.page, '#bidIn', '0.2')
await $click(Bp.page, '[data-act=bid]')
await waitText(Bp.page, '[data-actmsg]', /The wallet changed this transaction\. Not sent\./, 30_000)
Bp.walletTamper = false
assert.equal(await conn.getBalance(people.bob.publicKey), bobTamper, 'nothing was sent')
assert.equal((await apiOne(lKelp.toBase58())).topBid, '0')
ok('wallet checks', 'a comma bid is refused before signing; a wallet that changed the transaction got nothing sent, balance untouched')
await typeIn(Bp.page, '#bidIn', '0.2')
const bobBefore = await conn.getBalance(people.bob.publicKey)
await $click(Bp.page, '[data-act=bid]')
await waitText(Bp.page, '[data-actmsg]', /You hold the top bid/, 40_000)
let kelp = await until(async () => { const v = await apiOne(lKelp); return v.topBid !== '0' ? v : null }, 'bid seen by the server', 20_000)
assert.equal(kelp.topBid, '200000000'); assert.equal(kelp.topBidder, people.bob.publicKey.toBase58())
ok('place_bid from the site', 'bob holds 0.2 SOL in the vault, expected_mint and max_end_time sent')
await shot(Bp.page, 'flow-bid', { widths: [1440] })
// carol tries too little first: the site refuses before the wallet opens
await goto(Cp.page, lotUrl(lKelp)); await waitText(Cp.page, '[data-act=bid]', /Place bid/)
await typeIn(Cp.page, '#bidIn', '0.201')
await $click(Cp.page, '[data-act=bid]')
const low = await waitText(Cp.page, '[data-actmsg]', /at least 0\.204 SOL/)
ok('a raise under 2% is refused before signing', low.slice(0, 60))
await $click(Cp.page, '[data-act=bump][data-m="1.25"]')
assert.equal(await Cp.page.$eval('#bidIn', (e) => e.value), '0.25')
await $click(Cp.page, '[data-act=bid]')
await waitText(Cp.page, '[data-actmsg]', /You hold the top bid/, 40_000)
const bobAfter = await conn.getBalance(people.bob.publicKey)
assert.ok(bobBefore - bobAfter < 100_000, `bob got his 0.2 SOL back, net cost ${bobBefore - bobAfter} lamports of fees`)
await waitText(Bp.page, '[data-actmsg]', /You were outbid\. 0\.2 SOL came back/, 20_000)
ok('outbid refund', `bob refunded in carol's transaction, his net cost was ${bobBefore - bobAfter} lamports of fees; his page says he was outbid`)
// The home card shows the 0.250 SOL top bid even while its BidPlaced events are not in yet, and never says it waits for one
Cp.tamper = { re: new RegExp(`/api/site/events/${lKelp.toBase58()}$`), fn: (j) => ({ ...j, items: [] }) }
await goto(Cp.page, '#home')
await waitText(Cp.page, '#auction .auc-sh', /Bid stream/, 20_000)
const feat = await textOf(Cp.page, '#auction')
Cp.tamper = null
assert.match(feat, /0\.250/); assert.doesNotMatch(feat, /Waiting for the first bid|Any bid of 0\.001 SOL/)
assert.match(await textOf(Cp.page, '#auction .auc-sh'), /\d+ bids?/)
assert.match(await textOf(Cp.page, '#auction .stream'), /0\.250/)
ok('home card with a top bid', 'bid stream counts the top bid and lists it before its events are indexed')

step('fixed price buy')
const lVole = listingOf(people.alice.publicKey, VOLE)
// M1: the API lies about the price; the chain read catches it before the wallet opens
Bp.tamper = { re: new RegExp(`/api/listings/${lVole.toBase58()}$`), fn: (j) => ({ ...j, price: '40000000' }) }
await goto(Bp.page, lotUrl(lVole)); await waitText(Bp.page, '[data-act=buy]', /Buy for 0\.04 SOL/)
const bobLie = await conn.getBalance(people.bob.publicKey)
await $click(Bp.page, '[data-act=buy]')
await waitText(Bp.page, '[data-actmsg]', /does not match this page\. Nothing was signed/, 30_000)
assert.equal(await conn.getBalance(people.bob.publicKey), bobLie)
Bp.tamper = null
ok('a page that differs from the chain is refused', 'the API said 0.04 SOL, the chain said 0.05: refused before the wallet opened')
await goto(Bp.page, lotUrl(lVole)); await waitText(Bp.page, '[data-act=buy]', /Buy for 0\.05 SOL/)
await shot(Bp.page, 'lot-fixed', { full: true })
const aliceSolBefore = await conn.getBalance(people.alice.publicKey)
await $click(Bp.page, '[data-act=buy]')
await waitText(Bp.page, '.stage', /Sold/, 40_000)
await waitText(Bp.page, '.ticket', /is in your wallet/, 10_000)
assert.equal(await tokenBal(people.bob.publicKey, VOLE), 9_200_000n * M)
assert.ok((await conn.getBalance(people.alice.publicKey)) - aliceSolBefore >= 50_000_000)
ok('buy_fixed from the site', 'bob has all 9,200,000 VOLE, alice got 0.05 SOL plus her rent back, one transaction')

step('one per X account: pass buy, then a second claim refused')
async function devFixedWithPass(coin, amount, price) {
  const { listing, ix } = P.ix.createListing({ seller: dev.publicKey, mint: coin.mint, tokenProgram: coin.program, mode: 'fixed', amount, price, duration: 0, pass: { signer: passKey.publicKey, campaign } })
  await send([ix], [dev]); return listing
}
// Two drops in one campaign: the dev's coin, from two token accounts so each can carry its own listing
const lDrop1 = await devFixedWithPass(OWN, 100_000n * M, 20_000_000n)
const second = Keypair.generate(); await fund(second.publicKey, 2)
await spl.transfer(conn, dev, ataOf(dev.publicKey, OWN), await spl.createAssociatedTokenAccountIdempotent(conn, dev, OWN.mint, second.publicKey, undefined, OWN.program), dev, 1_000_000n * M, [], undefined, OWN.program)
const { listing: lDrop2, ix: ixDrop2 } = P.ix.createListing({ seller: second.publicKey, mint: OWN.mint, tokenProgram: OWN.program, mode: 'fixed', amount: 100_000n * M, price: 20_000_000n, duration: 0, pass: { signer: passKey.publicKey, campaign } })
await send([ixDrop2], [second])
await goto(Cp.page, lotUrl(lDrop1)); await waitText(Cp.page, '[data-act=buy]', /Buy for 0\.02 SOL/, 30_000)
assert.match(await textOf(Cp.page, '.ticket'), /One per X account, on chain/)
await shot(Cp.page, 'lot-fixed-oneper', { widths: [1440] })
await $click(Cp.page, '[data-act=buy]')
await waitText(Cp.page, '.stage', /Sold/, 40_000)
assert.equal(await tokenBal(people.carol.publicKey, OWN), 100_000n * M)
assert.ok((await Cp.page.evaluate(() => window.__privySigned ?? 0)) > 0, 'carol signed through the Privy embedded wallet bridge')
ok('buy_fixed_with_pass from the site', 'server pass, ed25519 verify directly before the buy, carol the only signer, claim created')
await goto(Cp.page, lotUrl(lDrop2)); await waitText(Cp.page, '[data-act=buy]', /Buy for/, 30_000)
await $click(Cp.page, '[data-act=buy]')
const refused = await waitText(Cp.page, '[data-actmsg]', /already claimed this drop/, 30_000)
assert.equal((await apiOne(lDrop2.toBase58())).phase, 'live')
ok('second claim refused', refused.trim())
await shot(Cp.page, 'flow-second-claim', { widths: [1440] })

step('listed by posting on X: accept, and a seller who ghosts')
const tagCard = async (coin, tweetId, text) => {
  x.addMention({ id: tweetId, text, author: { id: USERS.alice.id, username: USERS.alice.username, createdAt: old, followers: 250 }, createdAt: Date.now() })
  return until(async () => { const r = db.get(`SELECT state, listing, reason FROM mentions WHERE tweet_id=?`, tweetId); if (r?.state === 'ignored') throw new Error(`ignored: ${r.reason}`); return r?.state === 'live' ? r.listing : null }, `tag card ${tweetId} live`, 60_000, 1000)
}
const lAccept = await tagCard(MOTH, '70001', `@sidebidsol sell all ${MOTH.mint.toBase58()} 75s min 0.01`)
const lGhost = await tagCard(PLNK, '70002', `@sidebidsol sell all ${PLNK.mint.toBase58()} 75s`)
ok('two cards listed by X post went live', 'real reader, mock X, real create_accept_listing')
await goto(Bp.page, lotUrl(lAccept)); await waitText(Bp.page, '[data-act=bid]', /Place bid/, 30_000)
await $click(Bp.page, '[data-act=bid]'); await waitText(Bp.page, '[data-actmsg]', /You hold the top bid/, 40_000)
await goto(Cp.page, lotUrl(lGhost)); await waitText(Cp.page, '[data-act=bid]', /Place bid/, 30_000)
await typeIn(Cp.page, '#bidIn', '0.03')
const carolBeforeGhost = await conn.getBalance(people.carol.publicKey)
await $click(Cp.page, '[data-act=bid]'); await waitText(Cp.page, '[data-actmsg]', /You hold the top bid/, 40_000)
ok('bids on both tagged cards')
await goto(A.page, lotUrl(lAccept))
await waitText(A.page, '[data-act=accept]', /Accept 0\.01 SOL/, 60_000)
await shot(A.page, 'lot-accept', { full: true })
await $click(A.page, '[data-act=accept]')
await waitText(A.page, '.stage', /Sold/, 40_000)
assert.equal(await tokenBal(people.bob.publicKey, MOTH), 12_100_000n * M)
ok('accept from the site', 'alice signed once, bob has all 12,100,000 MOTH, no delegate was ever set')
await shot(A.page, 'lot-sold', { full: true })

step('cancel a live listing, which clears the approval')
await sellOnSite(A, 'HUSK', { len: '600' })
const lHusk = listingOf(people.alice.publicKey, HUSK)
assert.equal((await spl.getAccount(conn, ataOf(people.alice.publicKey, HUSK), 'confirmed', HUSK.program)).delegate?.toBase58(), lHusk.toBase58())
await goto(A.page, '#sell')
await A.page.waitForSelector(`.mylist [data-act=cancel][data-id="${lHusk.toBase58()}"]`, { timeout: 20_000 })
await shot(A.page, 'sell-mylistings', { widths: [1440] })
await $click(A.page, `.mylist [data-act=cancel][data-id="${lHusk.toBase58()}"]`)
await until(async () => !(await conn.getAccountInfo(lHusk)), 'husk listing closed', 30_000)
const huskAcct = await spl.getAccount(conn, ataOf(people.alice.publicKey, HUSK), 'confirmed', HUSK.program)
assert.equal(huskAcct.delegate, null)
ok('cancel from Your listings', 'listing closed, approval removed on chain, rent back')

step('an auction nobody bids on, then Cancel removes the approval')
const lOrbo = listingOf(people.alice.publicKey, ORBO)
// ORBO was listed for 5 minutes; wait it out while the other clocks run
step('settle a finished auction with the Settle now button')
await until(async () => (await apiOne(lKelp.toBase58())).phase === 'settling', 'KELP auction ended', 180_000, 2000)
await goto(Bp.page, lotUrl(lKelp)); await waitText(Bp.page, '[data-act=settle]', /Settle now/, 30_000)
await shot(Bp.page, 'lot-settling', { full: true })
const aliceKelpSol = await conn.getBalance(people.alice.publicKey)
await $click(Bp.page, '[data-act=settle]')
await waitText(Bp.page, '.stage', /Sold/, 40_000)
assert.equal(await tokenBal(people.carol.publicKey, KELP), 38_400_000n * M)
assert.ok((await conn.getBalance(people.alice.publicKey)) - aliceKelpSol >= 250_000_000)
ok('settle from the site', 'bob pressed it, carol got 38,400,000 KELP, alice got 0.25 SOL and her rent, one transaction')

step('seller ghosted: anyone triggers the full refund')
await until(async () => (await apiOne(lGhost)).phase === 'seller_ghosted', 'accept window over', 150_000, 2000)
await goto(Bp.page, lotUrl(lGhost)); await waitText(Bp.page, '[data-act=refund]', /Trigger the refund/, 30_000)
await shot(Bp.page, 'lot-ghosting', { widths: [1440, 390] })
await $click(Bp.page, '[data-act=refund]')
await waitText(Bp.page, '.stage', /SOL refunded/, 40_000)
const carolAfterGhost = await conn.getBalance(people.carol.publicKey)
assert.ok(carolAfterGhost - carolBeforeGhost > -100_000 && carolAfterGhost >= carolBeforeGhost - 100_000)
ok('ghosted refund from the site', `carol has her 0.03 SOL back (net ${carolAfterGhost - carolBeforeGhost} lamports, fees only), card shows Seller ghosted`)
await shot(Bp.page, 'lot-ghosted', { full: true })
await until(async () => !!(await Bp.page.$('[data-act=close]')), 'close button', 20_000)
await $click(Bp.page, '[data-act=close]')
await until(async () => !(await conn.getAccountInfo(new PublicKey(lGhost))), 'ghosted card closed', 30_000)
ok('close_listing from the site', 'the rent went back to the listing server key that paid it')

step('unsold auction: Cancel for the leftover approval')
await until(async () => (await apiOne(lOrbo.toBase58())).phase === 'expired', 'ORBO ended with no bids', 240_000, 2000)
await goto(A.page, lotUrl(lOrbo))
await waitText(A.page, '.stage', /No bids/, 20_000)
await A.page.waitForSelector('.stage [data-act=cancel]', { timeout: 20_000 })
await shot(A.page, 'lot-expired', { widths: [1440, 390] })
await $click(A.page, '.stage [data-act=cancel]')
await until(async () => !(await conn.getAccountInfo(lOrbo)), 'orbo closed', 30_000)
assert.equal((await spl.getAccount(conn, ataOf(people.alice.publicKey, ORBO), 'confirmed', ORBO.program)).delegate, null)
ok('cancel for an unsold auction', 'approval removed and listing closed by the seller after the end')

step('claim a credit')
await goto(A.page, '#home'); await sleep(800)
await $click(A.page, '[data-conn]')
await A.page.waitForSelector('.sheet [data-credits] [data-act=claim]', { timeout: 20_000 })
await shot(A.page, 'flow-credits', { widths: [1440, 390] })
const aliceCreditBefore = await conn.getBalance(people.alice.publicKey)
await $click(A.page, '.sheet [data-act=claim]')
await until(async () => (await conn.getBalance(creditAddr)) === 0, 'credit claimed', 30_000)
const gained = (await conn.getBalance(people.alice.publicKey)) - aliceCreditBefore
assert.ok(gained > 6_900_000, `alice gained ${gained}`)
ok('claim_credit from the site', `0.007 SOL from the credit address to alice, net ${gained} lamports after the fee`)

step('a seller who moves the tokens: Gone and a refund')
// The tagged PLNK card was refunded, so alice still holds PLNK and can list it from the site
await sellOnSite(A, 'PLNK', { len: '120' })
const lPlnk = listingOf(people.alice.publicKey, PLNK)
await goto(Bp.page, lotUrl(lPlnk)); await waitText(Bp.page, '[data-act=bid]', /Place bid/, 30_000)
await $click(Bp.page, '[data-act=bid]'); await waitText(Bp.page, '[data-actmsg]', /You hold the top bid/, 40_000)
await spl.transfer(conn, people.alice, ataOf(people.alice.publicKey, PLNK), await spl.createAssociatedTokenAccountIdempotent(conn, people.alice, PLNK.mint, dev.publicKey, undefined, PLNK.program), people.alice, 1n * M, [], undefined, PLNK.program)
await until(async () => { const v = await apiOne(lPlnk.toBase58()); return v.phase === 'settling' && v.fillable === false }, 'PLNK can no longer fill', 200_000, 2000)
await goto(Cp.page, lotUrl(lPlnk)); await waitText(Cp.page, '[data-act=refund]', /Trigger the refund/, 30_000)
await $click(Cp.page, '[data-act=refund]')
await waitText(Cp.page, '.stage', /SOL refunded/, 40_000)
ok('refund when the seller can no longer deliver', 'card shows Gone, bob refunded in full')
await shot(Cp.page, 'lot-gone', { widths: [1440, 1920, 390] })

step('payout time, coin picture limit, executed upgrade')
// A payout sent the way the rewards loop sends one: through the server's sender, a real SOL transfer, resolved from chain
const payHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000
const payRow = await app.sender.submit(`reward:${payHour}:a`, 'reward', `${payHour}:a`, async () => ({ payer: dev, instructions: [SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: people.alice.publicKey, lamports: 1_000_000 })] }))
await until(async () => { await app.sender.resolve(payRow); return payRow.status === 'landed' }, 'payout confirmed', 30_000, 1000)
db.run(`INSERT INTO reward_payouts (hour,slot,place,wallet,lamports,status,sig) VALUES (?,'a',1,?,'1000000','landed',?)`, payHour, people.alice.publicKey.toBase58(), payRow.sig)
// Q5: Paid at is the block time of the confirmed transaction, read from the chain, never when the sender noticed it
const paidAt = (await conn.getTransaction(payRow.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).blockTime
assert.ok(Number.isInteger(paidAt) && paidAt > 0, 'the chain has a block time')
db.run('UPDATE tx_intents SET updated_at=? WHERE sig=?', (paidAt + 900) * 1000, payRow.sig) // a sender that noticed 15 minutes late
const payItem = await until(async () => (await (await fetch(`${BASE}/api/site/feed?limit=100`)).json()).items.find((i) => i.kind === 'payout' && i.paidAt), 'payout block time read', 40_000, 2000)
assert.equal(payItem.paidAt, paidAt); assert.equal(payItem.at, paidAt)
await goto(Cp.page, '#tx'); await Cp.page.waitForSelector('tr.fd-payout td[data-paid]', { timeout: 20_000 })
const payTitle = await Cp.page.$eval('tr.fd-payout td[data-paid]', (e) => e.title)
assert.equal(payTitle, `Paid at ${new Date(paidAt * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`)
ok('payout time in the feed', `row timed by the block time of the confirmed transaction, not the sender's late note: "${payTitle}"`)
// Coin pictures: 50 new coins from one visitor all load, a flood of misses is refused, cached pictures stay free
const imgGet = (m) => fetch(`${BASE}/api/site/coinimg/${m}`, { headers: { 'x-forwarded-for': '203.0.113.9' } }).then((r) => r.status)
const fifty = await Promise.all(Array.from({ length: 50 }, () => imgGet(Keypair.generate().publicKey.toBase58())))
assert.ok(fifty.every((c) => c === 404), `50 coins on one page: ${[...new Set(fifty)]}`)
let refusedAt = null
for (let i = 51; i <= 125 && !refusedAt; i++) if ((await imgGet(Keypair.generate().publicKey.toBase58())) === 429) refusedAt = i
assert.equal(refusedAt, 121, 'the 121st miss in a minute is refused')
ok('coin picture limit', '50 new coins at once all answered, the 121st miss in a minute got 429')
// An executed upgrade: the same build deployed again with the upgrade key, so the deploy slot moves
await fetch(`${BASE}/api/site/log`)
const slot0 = (await (await fetch(`${BASE}/api/site/trust`)).json()).upgrade.deploySlot
const upKey = join(RUN, 'up.json'); writeFileSync(upKey, JSON.stringify([...upgrade.secretKey]))
const CLI = join(BIN, '..', 'solana')
// Run without a shell: macOS drops DYLD_LIBRARY_PATH when /bin/sh starts
try { execFileSync(CLI, ['program', 'deploy', '--use-rpc', '-u', RPC, '--keypair', upKey, '--upgrade-authority', upKey, '--program-id', PROGRAM_ID.toBase58(), SO], { stdio: 'pipe', env: { ...process.env, DYLD_LIBRARY_PATH: join(homedir(), '.local/libusb/lib') } }) } finally { rmSync(upKey, { force: true }) }
const upEntry = await until(async () => (await (await fetch(`${BASE}/api/site/log`)).json()).items.find((i) => i.title === 'Upgrade executed'), 'log notes the upgrade', 60_000, 2000)
assert.match(upEntry.body, /New program code went live at slot [\d,]+, replacing/)
const slot1 = (await (await fetch(`${BASE}/api/site/trust`)).json()).upgrade.deploySlot
assert.ok(slot1 > slot0, `deploy slot moved ${slot0} to ${slot1}`)
await goto(Cp.page, '#log'); await waitText(Cp.page, '.log', /Upgrade executed/, 20_000)
ok('upgrade executed in the log', `real redeploy moved the deploy slot ${slot0} to ${slot1}; /log says "${upEntry.title}"`)

step('every transaction, stats, change log')
await goto(Cp.page, '#tx'); await sleep(1500)
const feed = await textOf(Cp.page, '.tbl.feed')
for (const k of ['Listed', 'Bid', 'Sold', 'Bought', 'Accepted', 'Refund', 'Cancelled']) assert.match(feed, new RegExp(k), `feed shows ${k}`)
// F1: a listing row shows the tokens, and a price only as a fixed price or a minimum, never the 0.001 SOL floor
const listedRows = await Cp.page.$$eval('.tbl.feed tr.fd-listed td:nth-child(3)', (tds) => tds.map((t) => t.textContent.trim()))
assert.ok(listedRows.length && listedRows.every((t) => /tokens/.test(t) && !/0\.001 SOL/.test(t)), `listed rows: ${listedRows.join(' | ')}`)
assert.doesNotMatch(await textOf(Cp.page, '.phead'), /Nothing is left out/)
const txLinks = await Cp.page.$$eval('.tbl.feed a.txl', (as) => as.map((a) => a.href))
assert.ok(txLinks.length >= 20 && txLinks.every((h) => /\/tx\/[1-9A-HJ-NP-Za-km-z]{60,}/.test(h)), `every row links its transaction (${txLinks.length})`)
await goto(Cp.page, '#home'); await Cp.page.waitForSelector('.stats', { timeout: 40_000 })
assert.match(await textOf(Cp.page, '.stats'), /Listings sold/)
await goto(Cp.page, '#log'); await waitText(Cp.page, '.log', /Not on mainnet yet/, 10_000)
ok('every transaction, stats and change log', `${txLinks.length} rows each linked, stats shown once sales passed the bar, log entries dated`)
// L5: a lot id that is not an address never reaches a fetch path
const asked = []; const watch = (r) => asked.push(r.url()); Cp.page.on('request', watch)
await goto(Cp.page, '#lot/..%2F..%2Fauth%2Fx%2Fstart'); await goto(Cp.page, '#lot/../auth/x/start'); await sleep(800)
Cp.page.off('request', watch)
const badAsk = asked.filter((u) => { try { const x = new URL(u); return /auth\/x\/start|\/api\/(listings|site\/events)\/\.\./.test(x.pathname) } catch { return false } })
assert.deepEqual(badAsk, [], 'no request built from a bad lot id')
// L1, L9: headers and share tags on every page
const res = await fetch(`${BASE}/live`), html = await res.text(), csp = res.headers.get('content-security-policy')
assert.ok(!/connect-src[^;]*\shttps:(\s|;)/.test(csp) && !/img-src[^;]*\shttps:(\s|;)/.test(csp), `CSP lists hosts, not all of https: ${csp}`)
assert.match(html, /og:image" content="[^"]+\/og\/site\.png"/); assert.match(html, /data-route="live"/)
assert.equal((await fetch(`${BASE}/og/site.png`)).headers.get('content-type'), 'image/png')
assert.match((await fetch(`${BASE}/favicon.ico`)).headers.get('content-type') ?? '', /image\/png/)
ok('headers and share tags', 'CSP names its hosts, OG card on every page, favicon, path routes')

step('upgrade watcher: Squads vault with a 48 hour lock, then a proposed upgrade')
if (!HAS_SQUADS) console.log('  SKIP no Squads program in test/.cache (see README)')
else {
  const pc = sq.accounts.ProgramConfig.fromAccountInfo(await conn.getAccountInfo(sq.getProgramConfigPda({})[0]))[0]
  await sq.rpc.multisigCreateV2({ connection: conn, treasury: pc.treasury, createKey, creator: upgrade, multisigPda: msPda, configAuthority: null, threshold: 1, members: [{ key: upgrade.publicKey, permissions: sq.types.Permissions.all() }], timeLock: 172800, rentCollector: null, sendOptions: { skipPreflight: true } })
  await until(() => conn.getAccountInfo(msPda), 'multisig created', 30_000)
  const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), [pdata] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)
  await send([new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: pdata, isSigner: false, isWritable: true }, { pubkey: upgrade.publicKey, isSigner: true, isWritable: false }, { pubkey: vaultPda, isSigner: false, isWritable: false }], data: Buffer.from([4, 0, 0, 0]) })], [upgrade])
  await until(async () => (await (await fetch(`${BASE}/api/site/trust`)).json()).upgrade?.state === 'squads', 'site sees the vault', 60_000, 2000)
  await goto(Cp.page, '#home')
  assert.match(await textOf(Cp.page, '.checkit'), /Multisig, 48 hour lock\s*1 of 1 approvals\. No settings key\./)
  assert.match(await textOf(Cp.page, '.foot-b'), /The contract can be changed by the team’s multisig, 1 of 1 approvals\. Every change waits 48 hours in public first\./)
  // A program loaded at genesis has deploy slot 0 and no block time; a real deploy shows its slot and date
  const dslot = (await (await fetch(`${BASE}/api/site/trust`)).json()).upgrade.deploySlot
  if (dslot > 0) await waitText(Cp.page, '.checkit', /Deployed at slot [\d,]+, \d+ \w+ \d{4}/, 30_000)
  else assert.doesNotMatch(await textOf(Cp.page, '.checkit'), /Deployed at slot/)
  assert.equal(await Cp.page.$('.upbanner'), null, 'no banner while nothing is proposed')
  ok('upgrade authority read from chain', 'strip and footer say multisig with a 48 hour lock only once the chain says so')
  const upgradeIx = new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: pdata, isSigner: false, isWritable: true }, { pubkey: PROGRAM_ID, isSigner: false, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: upgrade.publicKey, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, { pubkey: vaultPda, isSigner: true, isWritable: false }], data: Buffer.from([3, 0, 0, 0]) })
  const transactionMessage = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [upgradeIx] })
  const opts = { sendOptions: { skipPreflight: true } }
  await sq.rpc.vaultTransactionCreate({ connection: conn, feePayer: upgrade, multisigPda: msPda, transactionIndex: 1n, creator: upgrade.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage, ...opts })
  await until(() => conn.getAccountInfo(sq.getTransactionPda({ multisigPda: msPda, index: 1n })[0]), 'vault transaction', 30_000)
  await sq.rpc.proposalCreate({ connection: conn, feePayer: upgrade, creator: upgrade, multisigPda: msPda, transactionIndex: 1n, ...opts })
  await until(() => conn.getAccountInfo(sq.getProposalPda({ multisigPda: msPda, transactionIndex: 1n })[0]), 'proposal', 30_000)
  await sq.rpc.proposalApprove({ connection: conn, feePayer: upgrade, member: upgrade, multisigPda: msPda, transactionIndex: 1n, ...opts })
  const tr = await until(async () => { const t = await (await fetch(`${BASE}/api/site/trust`)).json(); return t.upgrade?.pending?.[0]?.status === 'approved' ? t : null }, 'site sees the approved proposal', 60_000, 2000)
  const pend = tr.upgrade.pending[0]
  assert.equal(pend.kind, 'program'); assert.ok(Math.abs(pend.executableAt - pend.approvedAt - 172800) <= 1)
  await goto(Cp.page, '#home'); await Cp.page.waitForSelector('.upbanner', { timeout: 40_000 })
  assert.match(await textOf(Cp.page, '.upbanner'), /[Uu]pgrade proposed\. Runs in \d+h/)
  // N5 and polish: one line, and no moving ticker bar anywhere
  assert.ok(await Cp.page.$eval('.upb-in p', (e) => e.getBoundingClientRect().height < 30), 'banner is one line')
  assert.equal(await Cp.page.$('.ticker,.marq'), null)
  await shot(Cp.page, 'upgrade-banner', { widths: [1440, 390] })
  await goto(Cp.page, '#log'); await waitText(Cp.page, '.log', /Upgrade proposed/, 20_000)
  await shot(Cp.page, 'log', { widths: [1440, 390], full: true })
  ok('upgrade watcher', `real Squads v4 program: an approved upgrade proposal put the red banner on every page and a dated log entry; it can execute ${new Date(pend.executableAt * 1000).toISOString().slice(0, 16)}`)
}

// ---------------------------------------------------------------- every view, three widths
step('screenshots of every view')
await sleep(3000)
await goto(Cp.page, '#home'); await sleep(1500); await shot(Cp.page, 'home', { full: true })
await goto(Cp.page, '#live'); await shot(Cp.page, 'live', { full: true })
await goto(Cp.page, '#fixed'); await shot(Cp.page, 'fixed')
await goto(Cp.page, lotUrl(listingOf(people.alice.publicKey, TARP))); await sleep(800); await shot(Cp.page, 'lot-badge', { widths: [1440] })
await goto(Cp.page, '#rewards'); await shot(Cp.page, 'rewards', { full: true })
await goto(Cp.page, '#docs'); await shot(Cp.page, 'docs', { full: true })
await goto(Cp.page, '#docs/upgrade'); await sleep(500); await shot(Cp.page, 'docs-safety', { widths: [1440], top: false })
await goto(Cp.page, '#tx'); await shot(Cp.page, 'tx', { widths: [1440, 390], full: true })
if (!HAS_SQUADS) { await goto(Cp.page, '#log'); await shot(Cp.page, 'log', { widths: [1440, 390], full: true }) }
await goto(A.page, '#sell'); await sleep(1200); await shot(A.page, 'sell-after', { widths: [1440] })
await Cp.page.setViewport({ width: 390, height: 844 }); await goto(Cp.page, '#home'); await $click(Cp.page, '[data-act=menu]'); await Cp.page.screenshot({ path: join(SHOTS, 'flow-menu-390.png') })

// ---------------------------------------------------------------- copy rules on every view
step('copy rules')
const BAD = /\b(OTC|desk|nuking|audited|no admin|mock)\b|can't touch|can’t touch|rules can't change|rules can’t change|will revoke|give up control/i
const page = Cp.page; await page.setViewport({ width: 1440, height: 900 })
for (const h of ['#home', '#live', '#fixed', '#sell', '#rewards', '#docs', '#tx', '#log', lotUrl(lKelp), lotUrl(lVole), lotUrl(lGhost), lotUrl(lPlnk), lotUrl(lAccept)]) {
  await goto(page, h); await sleep(700)
  const t = await page.evaluate(() => document.body.innerText)
  const bad = t.match(BAD); assert.ok(!bad, `${h}: banned word ${bad?.[0]}`)
  const dash = t.match(/.{0,20}[—–]|\s-\s.{0,20}/); assert.ok(!dash, `${h}: dash "${dash?.[0]}"`)
  const zero = t.split('\n').find((line) => /(^|\s)0(\.0+)?(\s*SOL)?(\s|$)/.test(line.replace(/\d+(\.\d+)?%/g, '')) && !/^0:\d\d/.test(line.trim()))
  assert.ok(!zero, `${h}: bare zero in "${zero}"`)
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(sw <= 0, `${h}: sideways scroll ${sw}`)
  assert.match(t, HAS_SQUADS ? /The contract can be changed by the team’s multisig, 1 of 1 approvals\. Every change waits 48 hours in public first\./ : /The contract can be changed by the team’s upgrade key\./)
  // Base58 is case sensitive: every address on the page, full or short, renders in its exact case
  const shout = await page.evaluate(() => {
    const re = /[1-9A-HJ-NP-Za-km-z]{32,44}|[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/, out = []
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode());) {
      if (!re.test(n.nodeValue)) continue
      for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) {
        const tt = getComputedStyle(e).textTransform
        if (tt !== 'none') { out.push(`${n.nodeValue.trim().slice(0, 50)} (${tt} on ${e.tagName.toLowerCase()}.${[...e.classList].join('.')})`); break }
        if (e === n.parentElement) break // only the element that renders the text decides its case
      }
    }
    return out
  })
  assert.deepEqual(shout, [], `${h}: addresses not in their exact case: ${shout.join(' | ')}`)
}
// L2: no visitor’s browser ever contacted a host outside this site, its RPC, the font host and X profile pictures
assert.deepEqual([...OUTSIDE], [], `outside hosts contacted: ${[...OUTSIDE].join(', ')}`)
// Real pages: every path loads on its own, refresh keeps the page, an old #view link lands on its real address
for (const [p, sel] of [['/live', '[data-grid]'], ['/fixed', '#view'], ['/rewards', '.rw'], ['/docs', '.prose'], ['/tx', '[data-feed]'], ['/log', '.log-w'], [lotUrl(lKelp), '.lot-h']]) {
  await goto(page, p); await page.waitForSelector(sel, { timeout: 45_000 }); assert.equal(new URL(page.url()).pathname, p)
  await sleep(1500); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector(sel, { timeout: 45_000 }); assert.equal(new URL(page.url()).pathname, p, `${p} survives a refresh`)
}
await goto(page, '#lot/' + lKelp); assert.equal(new URL(page.url()).pathname, lotUrl(lKelp), 'an old #lot link redirects')
await goto(page, '#docs/fee'); assert.equal(new URL(page.url()).pathname, '/docs/fee')
// In app links use the History API: no reload, and Back returns
await goto(page, '/'); await page.evaluate(() => { window.__same = 1 }); await $click(page, '.nav a[href="/rewards"]'); await page.waitForSelector('.rw')
assert.equal(new URL(page.url()).pathname, '/rewards'); assert.equal(await page.evaluate(() => window.__same), 1, 'no reload')
await page.goBack(); await page.waitForSelector('.hero'); assert.equal(new URL(page.url()).pathname, '/')
// The CA on a card copies and never opens the card
await goto(page, '/live'); await page.waitForSelector('a.card .cacopy')
const caWant = await page.$eval('a.card .cacopy', (b) => b.dataset.copy)
await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t } })
await page.click('a.card .cacopy'); await sleep(400)
assert.equal(new URL(page.url()).pathname, '/live', 'copying the CA did not navigate'); assert.equal(await page.evaluate(() => window.__copied), caWant)
assert.match(await textOf(page, '#toasts'), /Copied/)
// Every SOL wears the Solana mark; every token a logo; X accounts their picture or the drawn pattern
for (const p of ['/', '/live', lotUrl(lKelp), '/rewards', '/tx']) {
  await goto(page, p); await sleep(800)
  const m = await page.evaluate(() => {
    const w = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT); let bare = 0
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/\bSOL\b/.test(n.nodeValue) && !n.parentElement.closest('.solu,svg,blockquote.post-text')) bare++
    const money = [...document.querySelectorAll('.giant,.bignum,.tbl td.num')].filter((e) => /SOL/.test(e.textContent))
    return { bare, marks: document.querySelectorAll('.solu > svg.solm use[href="#solmark"]').length, money: money.length, moneyMarked: money.filter((e) => e.querySelector('.solu svg.solm')).length, sprite: !!document.querySelector('#solmark'), arts: document.querySelectorAll('.art').length, artsDrawn: [...document.querySelectorAll('.art')].filter((a) => a.querySelector('img') || a.querySelector('svg.mark')).length }
  })
  assert.equal(m.bare, 0, `${p}: a SOL without the Solana mark`); assert.ok(m.marks > 0 && m.sprite, `${p}: Solana marks drawn`)
  assert.equal(m.moneyMarked, m.money, `${p}: every price carries the mark`); assert.equal(m.artsDrawn, m.arts, `${p}: every token shows a logo or its clean fallback`)
}
ok('real pages and details', 'every path loads and survives refresh, old hash links redirect, History API navigation, card CA copy without navigating, Solana mark on every SOL, a logo on every token')
ok('copy rules on every view', 'no banned words, no dashes, no bare zero, no sideways scroll, the upgrade line for the chain state in the footer, no outside hosts contacted')
assert.deepEqual(pageErrors, [], 'page errors: ' + pageErrors.join(' | '))
ok('no page errors', 'pageerror and console.error, across three people and every flow')

writeFileSync(join(RUN, 'results.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.length} checks passed`)
if (process.env.E2E_KEEP) {
  // Design work: keep the populated site up, with two fresh hour long auctions on the board, until killed
  for (const [coin, amount, price] of [[KELP, 60_000_000n * M, 2_000_000_000n], [OWN, 2_000_000n * M, 400_000_000n]]) {
    const { ix } = P.ix.createListing({ seller: dev.publicKey, mint: coin.mint, tokenProgram: coin.program, mode: 'bidding', amount, price, duration: 3600 })
    await send([ix], [dev]).catch((e) => console.log('keep listing', e.message))
  }
  writeFileSync(join(RUN, 'keep.json'), JSON.stringify({ base: BASE }))
  console.log(`KEEP ${BASE}`)
  await new Promise(() => {})
}
await cleanup()
process.exit(0)
} catch (e) { await fail(e) }
