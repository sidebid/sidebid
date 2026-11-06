// Builds dist/: one hashed script, one hashed stylesheet, and index.html. Also a Node copy of the contract client
// for the end to end test. Run: npm run build
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const here = new URL('.', import.meta.url).pathname
const dist = here + 'dist/'
rmSync(dist, { recursive: true, force: true }); mkdirSync(dist, { recursive: true })
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)

// Privy's sign in, its own bundle, fetched only when someone signs in or comes back with a Privy wallet
const STUB = here + 'src/privy-stub.js'
const privy = await build({ entryPoints: [here + 'src/privy-island.js'], bundle: true, minify: true, format: 'esm', target: ['es2020', 'safari14'], platform: 'browser', write: false, legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"', 'process.env.NODE_DEBUG': 'false', global: 'globalThis' }, alias: { permissionless: STUB, '@farcaster/mini-app-solana': STUB, '@abstract-foundation/agw-client': STUB }, logLevel: 'error' })
const privyCode = privy.outputFiles[0].text, privyName = `privy.${hash(privyCode)}.js`
writeFileSync(dist + privyName, privyCode)
writeFileSync(dist + privyName + '.gz', gzipSync(privyCode, { level: 9 }))
const js = await build({ entryPoints: [here + 'src/app.js'], bundle: true, minify: true, format: 'esm', target: ['es2020', 'safari14'], platform: 'browser', write: false, legalComments: 'none', define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis', __PRIVY_JS__: JSON.stringify('/' + privyName) }, loader: { '.json': 'json' } })
const code = js.outputFiles[0].text
const css = readFileSync(here + 'src/d.css', 'utf8') + '\n' + readFileSync(here + 'src/web.css', 'utf8') + '\n' + readFileSync(here + 'src/polish.css', 'utf8') + '\n' + readFileSync(here + 'src/v2.css', 'utf8')
const jsName = `app.${hash(code)}.js`, cssName = `app.${hash(css)}.css`
writeFileSync(dist + jsName, code)
writeFileSync(dist + cssName, css)
// Hubot Sans Expanded for display, Albert Sans for text, Spline Sans Mono for figures
const FONTS = 'family=Hubot+Sans:wdth,wght@125,400..900&family=Albert+Sans:wght@400..700&family=Spline+Sans+Mono:wght@400..700'
writeFileSync(dist + 'index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sidebid, live auctions for Solana tokens</title><meta name="description" content="Sell your tokens, not the chart. List any amount of a Solana token in a live auction and the best bid takes it in one transaction.">
<meta name="theme-color" content="#060606"><link rel="icon" href="/brand/favicon-16.png" type="image/png" sizes="16x16"><link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32"><link rel="icon" href="/brand/favicon-64.png" type="image/png" sizes="64x64"><link rel="icon" href="/brand/icon-512.png" type="image/png" sizes="512x512"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180"><link rel="preload" href="/brand/logo-96.png" as="image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${FONTS}&display=swap" media="print" data-fonts>
<link rel="stylesheet" href="/${cssName}">
</head><body><div id="app"><!--fp--></div>
<script type="module" src="/${jsName}"></script>
</body></html>
`)
// The logo, the wordmark and the icons, cut from the brand art in brand/, served as is
cpSync(here + 'brand', dist + 'brand', { recursive: true })
// The same instruction builders for Node, so the test makes its fixtures with the code the site ships
mkdirSync(here + 'test/.build', { recursive: true })
await build({ entryPoints: [here + 'src/program.js'], bundle: true, format: 'esm', platform: 'node', outfile: here + 'test/.build/program.mjs', loader: { '.json': 'json' }, external: ['@solana/web3.js', '@solana/spl-token', 'buffer'] })
console.log('built', jsName, Math.round(code.length / 1024) + ' KB,', privyName, Math.round(privyCode.length / 1024) + ' KB,', cssName, Math.round(css.length / 1024) + ' KB')
