// The T-10 check: run from your own machine ten minutes before going live, and again after every switch.
//   ADMIN_SECRET=<secret> RPC_URL=<Helius URL> node tools/check.mjs https://sidebid.fun
// Options: --flags=signinLive,keeperLive (go-live switches that must be on), --min-x-cap=10 (USD), --min-keeper-sol=0.05,
// --authority=revoked|<key> (what the upgrade authority must be), --max-rpc-ms=1500.
// It prints ALL CLEAR, or every problem it found, and exits 0 or 1. Secrets are read from the environment and never printed:
// the RPC shows as its host only. Without RPC_URL the site's own browser RPC is used.
export const PROGRAM_ID = '5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp'
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const KILLS = ['killReader', 'killKeeper', 'killRewards']
const PREVIEW_BADGE = 'Preview on a test chain'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const host = (u) => { try { return new URL(u).host } catch { return 'the RPC' } }
const b58 = (bytes) => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b)
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s }
  return s
}

export async function runChecks({ base, rpcUrl = null, adminSecret = null, fetchImpl = fetch, now = Date.now, programId = PROGRAM_ID, flags = [], minXCapUsd = 0, minKeeperSol = 0.05, authority = null, maxRpcMs = 1500, timeoutMs = 10_000 }) {
  base = String(base).replace(/\/$/, '')
  const out = []
  const ok = (name, detail = '') => out.push({ name, ok: true, detail })
  const bad = (name, detail) => out.push({ name, ok: false, detail })
  const get = async (path, headers = {}) => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs)
    try { return await fetchImpl(path.startsWith('http') ? path : base + path, { headers, signal: ctl.signal }) } finally { clearTimeout(t) }
  }
  const getJson = async (path, headers) => { const r = await get(path, headers); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
  let rpcId = 0
  const rpc = async (method, params = []) => {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
    if (r.status === 429) throw new Error('rate limited (429)')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (j.error) throw new Error(j.error.message ?? 'rpc error')
    return j.result
  }
  const account = async (key) => { const r = await rpc('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed' }]); return r?.value ? { ...r.value, bytes: Buffer.from(r.value.data[0], 'base64') } : null }
  const step = async (name, fn) => { try { await fn() } catch (e) { bad(name, e.message) } }

  // ---- the site and its share card
  let html = ''
  await step('Site', async () => {
    const r = await get('/', { accept: 'text/html' })
    html = await r.text()
    if (r.status !== 200) return bad('Site', `home answered ${r.status}`)
    const title = /<meta property="og:title" content="([^"]+)"/.exec(html), img = /<meta property="og:image" content="([^"]+)"/.exec(html)
    if (!title || !img) return bad('Site', 'home has no og:title or og:image')
    ok('Site', `home up, og:title "${title[1]}"`)
    await step('Share card', async () => {
      const c = await get(img[1].replace(/&#38;/g, '&'))
      const type = c.headers.get('content-type') ?? '', size = (await c.arrayBuffer()).byteLength
      if (c.status !== 200 || !/^image\//.test(type) || size < 1000) return bad('Share card', `${img[1]} answered ${c.status} ${type} ${size} bytes`)
      ok('Share card', `${type}, ${Math.round(size / 1024)} KB`)
    })
  })
  for (const p of ['/terms', '/privacy']) await step(`Page ${p}`, async () => { const r = await get(p); if (r.status !== 200) return bad(`Page ${p}`, `answered ${r.status}`); ok(`Page ${p}`) })
  await step('security.txt', async () => {
    const r = await get('/.well-known/security.txt'), t = await r.text()
    const exp = /^Expires:\s*(.+)$/m.exec(t), contact = /^Contact:\s*mailto:/m.test(t)
    if (r.status !== 200 || !contact || !exp) return bad('security.txt', `answered ${r.status}, contact ${contact ? 'yes' : 'missing'}, expiry ${exp ? 'yes' : 'missing'}`)
    const days = (Date.parse(exp[1]) - now()) / 86_400_000
    if (!(days > 30)) return bad('security.txt', `Expires ${exp[1].trim()} is ${Math.floor(days)} days away: move SECURITY_EXPIRES in server/src/legal.mjs forward`)
    ok('security.txt', `expires in ${Math.floor(days)} days`)
  })

  // ---- the site's chain settings
  let cfg = null
  await step('site.json', async () => {
    cfg = await getJson('/api/config')
    const c = cfg.chain ?? {}
    const probs = []
    if (c.programId !== programId) probs.push(`program id is ${c.programId}, expected ${programId}`)
    if (c.cluster !== 'mainnet-beta') probs.push(`cluster is ${c.cluster}`)
    if (!c.rpc) probs.push('no browser RPC (BROWSER_RPC_URL)')
    else if (!/^https:\/\//.test(c.rpc) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(c.rpc)) probs.push('browser RPC is not https')
    else if (new URL(c.rpc).origin === new URL(base).origin) probs.push('browser RPC is the site itself (/rpc is the preview proxy)')
    if (probs.length) return bad('site.json', probs.join('; '))
    ok('site.json', `program ${programId}, mainnet-beta, browser RPC ${host(c.rpc)}, CA ${cfg.brand?.reveal ? `revealed (${cfg.brand.ca})` : 'hidden'}`)
  })
  if (!rpcUrl) rpcUrl = cfg?.chain?.rpc ?? null

  // ---- chain
  if (!rpcUrl) bad('RPC', 'no RPC: set RPC_URL')
  else {
    await step('RPC latency', async () => {
      const times = []
      for (let i = 0; i < 3; i++) { const t = performance.now(); await rpc('getSlot', [{ commitment: 'confirmed' }]); times.push(performance.now() - t) }
      const mid = Math.round(times.sort((a, b) => a - b)[1])
      if (mid > maxRpcMs) return bad('RPC latency', `${host(rpcUrl)} median ${mid} ms, over ${maxRpcMs} ms`)
      ok('RPC latency', `${host(rpcUrl)} median ${mid} ms`)
    })
    await step('RPC cluster', async () => { const g = await rpc('getGenesisHash'); if (g !== MAINNET_GENESIS) return bad('RPC cluster', `genesis ${g} is not mainnet`); ok('RPC cluster', 'mainnet') })
    await step('Program', async () => {
      const a = await account(programId)
      if (!a) return bad('Program', `${programId} does not exist on chain`)
      if (!a.executable || a.owner !== LOADER || a.bytes.length < 36 || a.bytes.readUInt32LE(0) !== 2) return bad('Program', `${programId} is not an upgradeable program`)
      const pd = b58(a.bytes.subarray(4, 36)), d = await account(pd)
      if (!d || d.bytes.length < 13 || d.bytes.readUInt32LE(0) !== 3) return bad('Program', `program data ${pd} unreadable`)
      const slot = Number(d.bytes.readBigUInt64LE(4)), auth = d.bytes[12] === 1 ? b58(d.bytes.subarray(13, 45)) : null
      const state = auth ? `upgrade authority ${auth}` : 'upgrade authority revoked'
      if (authority === 'revoked' && auth) return bad('Program', `${state}, expected revoked`)
      if (authority && authority !== 'revoked' && auth !== authority) return bad('Program', `${state}, expected ${authority}`)
      ok('Program', `deployed at slot ${slot}, ${state}`)
    })
  }

  // ---- the server's own state: needs the admin secret
  let facts = null
  if (!adminSecret) bad('Admin', 'ADMIN_SECRET not set: flags, X cap, keeper and DATA_DIR not checked')
  else {
    const h = { 'x-admin-secret': adminSecret }
    await step('Flags', async () => {
      const s = await getJson('/api/admin/status', h), f = s.flags ?? {}
      const kills = KILLS.filter((k) => f[k]), off = flags.filter((k) => !f[k])
      const on = Object.entries(f).filter(([k, v]) => v && !KILLS.includes(k)).map(([k]) => k)
      if (kills.length || off.length) bad('Flags', [kills.length ? `kill switch on: ${kills.join(', ')}` : '', off.length ? `should be on: ${off.join(', ')}` : ''].filter(Boolean).join('; '))
      else ok('Flags', on.length ? `on: ${on.join(', ')}` : 'all off')
      const cap = s.xSpend?.capUsd
      if (!(cap >= minXCapUsd)) bad('X spend cap', `cap is $${cap}, expected at least $${minXCapUsd}`)
      else ok('X spend cap', `$${cap} a day, $${s.xSpend.spentUsd ?? 0} spent today`)
      if (s.keeper?.outOfSol) bad('Keeper', 'the keeper reports out of SOL')
    })
    await step('Server', async () => {
      facts = await getJson('/api/admin/launch-check', h)
      const probs = []
      if (facts.previewChain) probs.push('PREVIEW_CHAIN=1 is set')
      if (!facts.production) probs.push('not in production mode')
      if (facts.volume && facts.onVolume !== true) probs.push(`DATA_DIR ${facts.dataDir} is not on the volume ${facts.volume}`)
      if (!facts.volume && facts.production) probs.push('no Railway volume reported')
      if (facts.programId !== programId) probs.push(`server PROGRAM_ID is ${facts.programId}`)
      if (facts.genesisHash && facts.genesisHash !== MAINNET_GENESIS) probs.push('the server RPC is not mainnet')
      if (!facts.genesisHash) probs.push('the server could not reach its RPC')
      if (probs.length) return bad('Server', probs.join('; '))
      ok('Server', `production, DATA_DIR ${facts.dataDir} on the volume, server RPC on mainnet`)
    })
    if (facts?.keys?.keeper && rpcUrl) await step('Keeper SOL', async () => {
      const r = await rpc('getBalance', [facts.keys.keeper, { commitment: 'confirmed' }]), sol = (r?.value ?? 0) / 1e9
      if (sol < minKeeperSol) return bad('Keeper SOL', `${facts.keys.keeper} holds ${sol} SOL, under ${minKeeperSol}`)
      ok('Keeper SOL', `${sol.toFixed(4)} SOL`)
    })
    else if (facts) bad('Keeper SOL', facts.keys?.keeper ? 'no RPC to read it' : 'no KEEPER_SECRET set: nothing settles auctions')
  }

  // ---- preview residue: the badge, a localnet config, or listings that are not on this chain
  await step('Preview residue', async () => {
    const probs = []
    if (html.includes(PREVIEW_BADGE)) probs.push('the preview badge is on the page')
    if (cfg?.chain?.cluster === 'localnet') probs.push('site.json says localnet')
    const r = await get('/rpc', { accept: 'application/json' })
    if (r.status === 405) probs.push('/rpc answers like the preview proxy')
    const l = await getJson('/api/listings?limit=100').catch(() => ({ items: [] }))
    const keys = (l.items ?? []).map((x) => x.pubkey).filter(Boolean)
    if (keys.length && rpcUrl) {
      const got = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }])
      const missing = keys.filter((k, i) => !got?.value?.[i] && !(l.items[i].closed))
      const foreign = keys.filter((k, i) => got?.value?.[i] && got.value[i].owner !== programId)
      if (missing.length) probs.push(`${missing.length} open listing(s) not on chain, e.g. ${missing[0]}: seeded or old data`)
      if (foreign.length) probs.push(`${foreign.length} listing(s) not owned by the program`)
    }
    if (probs.length) return bad('Preview residue', probs.join('; '))
    ok('Preview residue', `none (${keys.length} listing(s) checked against chain)`)
  })
  return out
}

export function report(results) {
  const lines = results.map((r) => `${r.ok ? ' ok ' : 'FAIL'}  ${r.name}${r.detail ? ': ' + r.detail : ''}`)
  const fails = results.filter((r) => !r.ok)
  lines.push('', fails.length ? `NOT CLEAR: ${fails.length} problem(s): ${fails.map((r) => r.name).join(', ')}` : 'ALL CLEAR')
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), base = args.find((a) => !a.startsWith('--'))
  const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  if (!base) { console.log('usage: ADMIN_SECRET=... RPC_URL=... node tools/check.mjs https://sidebid.fun [--flags=a,b] [--min-x-cap=10] [--min-keeper-sol=0.05] [--authority=revoked|<key>]'); process.exit(2) }
  const results = await runChecks({
    base, rpcUrl: process.env.RPC_URL || null, adminSecret: process.env.ADMIN_SECRET || null,
    flags: (opt('flags') ?? '').split(',').filter(Boolean), minXCapUsd: Number(opt('min-x-cap') ?? 0), minKeeperSol: Number(opt('min-keeper-sol') ?? 0.05),
    authority: opt('authority') ?? null, maxRpcMs: Number(opt('max-rpc-ms') ?? 1500),
  })
  console.log(report(results))
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}
