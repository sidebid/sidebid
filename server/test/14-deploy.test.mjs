// Production deploy guards: the data folder on the volume, the browser's site.json from the environment, X prices.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { prepareSiteJson, leaksServerKey } from '../src/sitejson.mjs'

const RW = { RAILWAY_ENVIRONMENT: 'production', TRUSTED_HOPS: '1' }
const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=0123456789abcdef0123456789abcdef'

test('DATA_DIR: on Railway it defaults to the volume, and a folder off the volume is refused', () => {
  assert.equal(loadConfig({ ...RW, RAILWAY_VOLUME_MOUNT_PATH: '/data' }).dataDir, '/data')
  assert.equal(loadConfig({ ...RW, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/data/sidebid' }).dataDir, '/data/sidebid')
  for (const d of ['./data', '/app/data', '/data2', '/data/../etc']) assert.throws(() => loadConfig({ ...RW, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: d }), /not on the Railway volume/, d)
  assert.throws(() => loadConfig({ ...RW }), /No Railway volume/)
  assert.throws(() => loadConfig({ NODE_ENV: 'production', TRUSTED_HOPS: '1' }), /DATA_DIR must be set in production/)
  assert.equal(loadConfig({}).dataDir, './data', 'local development keeps ./data')
})

test('X prices: the defaults are the pay per use list, a zero price is refused, links are off by default', () => {
  const x = loadConfig({}).x
  assert.deepEqual([x.costPerPostUsd, x.costPerPostLinkUsd, x.costPerUserUsd, x.costPerOwnedReadUsd, x.costPerReadUsd], [0.015, 0.2, 0.01, 0.001, 0.005])
  assert.equal(x.replyLinks, false); assert.equal(x.signinCapUsd, 0)
  assert.equal(loadConfig({ X_REPLY_LINKS: '1' }).x.replyLinks, true)
  for (const k of ['X_COST_PER_POST_USD', 'X_COST_PER_POST_LINK_USD', 'X_COST_PER_USER_USD', 'X_COST_PER_OWNED_READ_USD', 'X_COST_PER_READ_USD']) assert.throws(() => loadConfig({ [k]: '0' }), /above 0/, k)
})

test('site.json: written at start from BROWSER_RPC_URL, other fields kept, never the server RPC key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-site-')), file = join(dir, 'site.json')
  const cfg = loadConfig({ NODE_ENV: 'production', TRUSTED_HOPS: '1', DATA_DIR: dir, RPC_URL: HELIUS })
  assert.throws(() => prepareSiteJson({ config: cfg, env: {} }), /No browser RPC/)
  assert.throws(() => prepareSiteJson({ config: cfg, env: { BROWSER_RPC_URL: HELIUS } }), /shares the server RPC key/)
  assert.throws(() => prepareSiteJson({ config: cfg, env: { BROWSER_RPC_URL: 'https://other.example/rpc?k=0123456789abcdef0123456789abcdef' } }), /shares the server RPC key/)
  assert.throws(() => prepareSiteJson({ config: cfg, env: { BROWSER_RPC_URL: 'http://rpc.example' } }), /https/)
  writeFileSync(file, JSON.stringify({ brand: { reveal: true, ca: 'X' }, facts: { contractTests: 179 } }))
  const r = prepareSiteJson({ config: cfg, env: { BROWSER_RPC_URL: 'https://api.mainnet-beta.solana.com', UPGRADE_AUTHORITY: '11111111111111111111111111111111' } })
  assert.equal(r.wrote, true)
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(j.chain.rpc, 'https://api.mainnet-beta.solana.com'); assert.equal(j.chain.cluster, 'mainnet-beta')
  assert.equal(j.chain.programId, cfg.programId.toBase58()); assert.equal(j.keys.upgradeAuthority, '11111111111111111111111111111111')
  assert.deepEqual([j.brand.reveal, j.brand.ca, j.facts.contractTests], [true, 'X', 179], 'the owner\'s edits survive a restart')
  assert.ok(!readFileSync(file, 'utf8').includes('0123456789abcdef'))
  // A restart with no variables reads the file as it is
  assert.equal(prepareSiteJson({ config: cfg, env: {} }).wrote, false)
  // A file edited by hand to the server's key is refused at start
  writeFileSync(file, JSON.stringify({ chain: { rpc: HELIUS } }))
  assert.throws(() => prepareSiteJson({ config: cfg, env: {} }), /shares the server RPC key/)
  assert.ok(!leaksServerKey('https://api.mainnet-beta.solana.com', HELIUS))
})

test('site.json: local development writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-site-'))
  const r = prepareSiteJson({ config: loadConfig({ DATA_DIR: dir }), env: {} })
  assert.equal(r.wrote, false); assert.ok(!existsSync(join(dir, 'site.json')))
})

test('the entry point refuses PREVIEW_CHAIN=1 and a missing browser RPC', () => {
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url)), dir = mkdtempSync(join(tmpdir(), 'sb-entry-'))
  const base = { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', TRUSTED_HOPS: '1', DATA_DIR: dir, RPC_URL: 'http://127.0.0.1:1' }
  let r = spawnSync(process.execPath, [entry], { env: { ...base, PREVIEW_CHAIN: '1' }, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 1); assert.match(r.stderr, /PREVIEW_CHAIN=1 belongs to the preview/)
  r = spawnSync(process.execPath, [entry], { env: base, encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 1); assert.match(r.stderr, /Not starting: No browser RPC/)
})

test('Dockerfile: builds the site, runs the server, and carries no preview, validator or test key', () => {
  const d = readFileSync(fileURLToPath(new URL('../../Dockerfile', import.meta.url)), 'utf8')
  const code = d.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  assert.match(code, /npm run build/); assert.match(code, /CMD \["node", "server\/src\/index\.mjs"\]/)
  assert.doesNotMatch(code, /preview|PREVIEW_CHAIN|solana-test-validator|agave|TEST-ONLY|fixtures/i)
})
