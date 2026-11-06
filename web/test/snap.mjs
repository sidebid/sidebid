// Screenshots of a running test site (E2E_KEEP=1 npm test) for design work. Anonymous visitor, no wallet.
//   node test/snap.mjs <outdir> '#home' '#live' ...   (default: every view at 1440)
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const puppeteer = createRequire(process.env.PUPPETEER_CORE || import.meta.url)('puppeteer-core')
const here = new URL('.', import.meta.url).pathname
const { base } = JSON.parse(readFileSync(join(here, '.run/keep.json'), 'utf8'))
const [out = join(here, '.run/snap'), ...hashes] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const widths = (process.env.W ?? '1440').split(',').map(Number), full = !!process.env.FULL
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
for (const h of hashes.length ? hashes : ['#home', '#live', '#rewards', '#docs', '#tx', '#log', '#sell']) {
  for (const w of widths) {
    await page.setViewport({ width: w, height: w <= 420 ? 844 : w >= 1900 ? 1080 : 900 })
    await page.goto('about:blank'); await page.goto(`${base}/${h}`, { waitUntil: 'networkidle2' }); await new Promise((r) => setTimeout(r, 1500))
    const name = h.replace(/[#/]/g, '_').replace(/^_/, '') + (w === 1440 ? '' : '-' + w)
    await page.screenshot({ path: join(out, name + '.png'), fullPage: full })
    console.log(join(out, name + '.png'))
  }
}
await browser.close()
