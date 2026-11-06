// Chart price and pool size, only when the runtime config turns the price feed on. Without it the site shows no chart
// comparison at all rather than a guess. Public endpoints, no key, read from the visitor's browser.
const memo = new Map()
const once = (k, ms, fn) => { const h = memo.get(k); if (h && Date.now() - h.at < ms) return h.p; const p = fn().catch(() => null); memo.set(k, { at: Date.now(), p }); return p }
const SOL = 'So11111111111111111111111111111111111111112'

/** { priceSol: SOL per whole token, poolSol, pair } for the deepest SOL pool, or null. */
export function market(mint, on) {
  if (!on) return Promise.resolve(null)
  return once(`m:${mint}`, 30_000, async () => {
    const j = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null))
    const pairs = (j?.pairs ?? []).filter((p) => p.chainId === 'solana' && p.quoteToken?.address === SOL && Number(p.priceNative) > 0 && Number(p.liquidity?.quote) > 0)
    pairs.sort((a, b) => Number(b.liquidity.quote) - Number(a.liquidity.quote))
    const p = pairs[0]
    return p ? { priceSol: Number(p.priceNative), poolSol: Number(p.liquidity.quote), pair: p.pairAddress } : null
  })
}

/** Closing prices for the last hour, one a minute, oldest first, or null. */
export function lastHour(pair, on) {
  if (!on || !pair) return Promise.resolve(null)
  return once(`c:${pair}`, 60_000, async () => {
    const j = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}/ohlcv/minute?aggregate=1&limit=60`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null))
    const rows = j?.data?.attributes?.ohlcv_list
    return Array.isArray(rows) && rows.length > 4 ? rows.map((r) => Number(r[4])).reverse() : null
  })
}
