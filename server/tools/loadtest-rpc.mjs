// RPC load test, no money: reads many wallets' token balances the way a launch rush does, in batches of 100 accounts per
// call (getMultipleAccounts on each wallet's associated token account), and reports errors, 429s and latency.
//   RPC_URL=<Helius URL> node tools/loadtest-rpc.mjs --mint=<token mint> [--wallets=800] [--concurrency=4] [--rounds=3] [--file=wallets.json]
// Run it against the server RPC (RPC_URL) and again against the browser RPC (BROWSER_RPC_URL=... --browser).
// Wallets: --file (a JSON list of addresses, or Axiom's export of objects with an address field), else random ones.
// The pass mark is 0 errors and 0 429s. The RPC URL is never printed, only its host.
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'

const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const BATCH = 100

export const ata = (wallet, mint, program = TOKEN) => PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(), program.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58()
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null)

/** Addresses from a JSON file: a list of strings, or of objects with address / wallet / publicKey. */
export function walletsFrom(text) {
  const j = JSON.parse(text), list = Array.isArray(j) ? j : j.wallets ?? []
  return list.map((x) => (typeof x === 'string' ? x : x?.address ?? x?.wallet ?? x?.publicKey ?? x?.trackedWalletAddress)).filter((a) => { try { return !!a && new PublicKey(a) && true } catch { return false } })
}

export async function loadTest({ rpcUrl, mint, wallets, concurrency = 4, rounds = 1, fetchImpl = fetch }) {
  const info = await post(fetchImpl, rpcUrl, 'getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]).catch(() => null)
  const program = info?.result?.value?.owner ? new PublicKey(info.result.value.owner) : TOKEN
  const accounts = wallets.map((w) => ata(w, mint, program))
  const batches = []
  for (let r = 0; r < rounds; r++) for (let i = 0; i < accounts.length; i += BATCH) batches.push(accounts.slice(i, i + BATCH))
  const ms = [], stat = { calls: 0, ok: 0, errors: 0, http429: 0, holders: 0, accountsRead: 0, messages: {} }
  const t0 = performance.now()
  let next = 0
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++], t = performance.now()
      stat.calls++
      try {
        const j = await post(fetchImpl, rpcUrl, 'getMultipleAccounts', [b, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 64, length: 8 } }])
        if (j.status === 429) { stat.http429++; stat.errors++; continue }
        if (j.error) { stat.errors++; const m = String(j.error.message ?? j.error).slice(0, 80); stat.messages[m] = (stat.messages[m] ?? 0) + 1; if (/429|rate/i.test(m)) stat.http429++; continue }
        const v = j.result?.value
        if (!Array.isArray(v) || v.length !== b.length) { stat.errors++; stat.messages['short answer'] = (stat.messages['short answer'] ?? 0) + 1; continue }
        stat.ok++; stat.accountsRead += v.length; stat.holders += v.filter((a) => a && Buffer.from(a.data[0], 'base64').readBigUInt64LE(0) > 0n).length
        ms.push(performance.now() - t)
      } catch (e) { stat.errors++; const m = String(e.message).slice(0, 80); stat.messages[m] = (stat.messages[m] ?? 0) + 1 }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  const secs = (performance.now() - t0) / 1000
  return {
    wallets: wallets.length, rounds, batches: batches.length, perBatch: BATCH, concurrency, seconds: +secs.toFixed(1), callsPerSecond: +(stat.calls / secs).toFixed(1),
    calls: stat.calls, ok: stat.ok, errors: stat.errors, http429: stat.http429, accountsRead: stat.accountsRead, holdersSeen: Math.round(stat.holders / rounds),
    latencyMs: { p50: Math.round(pct(ms, 0.5) ?? 0), p95: Math.round(pct(ms, 0.95) ?? 0), max: Math.round(pct(ms, 1) ?? 0) }, errorMessages: stat.messages,
    pass: stat.errors === 0 && stat.http429 === 0,
  }
}
async function post(fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  if (r.status === 429) return { status: 429 }
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
  const browser = process.argv.includes('--browser')
  const rpcUrl = browser ? process.env.BROWSER_RPC_URL : process.env.RPC_URL
  const mint = arg('mint')
  if (!rpcUrl || !mint) { console.log('usage: RPC_URL=... node tools/loadtest-rpc.mjs --mint=<mint> [--wallets=800] [--concurrency=4] [--rounds=3] [--file=wallets.json] [--browser]'); process.exit(2) }
  const n = Number(arg('wallets', 800)), file = arg('file')
  let wallets = file ? walletsFrom(readFileSync(file, 'utf8')) : []
  while (wallets.length < n) wallets.push(Keypair.generate().publicKey.toBase58())
  wallets = wallets.slice(0, n)
  const r = await loadTest({ rpcUrl, mint, wallets, concurrency: Number(arg('concurrency', 4)), rounds: Number(arg('rounds', 1)) })
  console.log(JSON.stringify({ rpc: new URL(rpcUrl).host, ...r }, null, 1))
  console.log(r.pass ? 'PASS: 0 errors, 0 429s' : `FAIL: ${r.errors} errors, ${r.http429} 429s`)
  process.exit(r.pass ? 0 : 1)
}
