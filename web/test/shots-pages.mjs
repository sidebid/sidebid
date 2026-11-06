// Screenshots of every page at 1440 and 390 against a running site (a local test chain run, or a deployed URL), plus the
// checks a person would make looking at them: no page errors, no sideways scroll, nothing clipped off the right edge,
// a logo on every token, a picture on every X account, and the Solana mark on every SOL.
//
//   node test/shots-pages.mjs <base url> <out dir> [tag]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const puppeteer = createRequire(process.env.PUPPETEER_CORE || import.meta.url)('puppeteer-core')

const [base, out, tag = 'busy'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`${page.url()} ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.setViewport({ width: 1440, height: 900 })
await page.goto(base + '/live', { waitUntil: 'networkidle2' }); await sleep(1500)
const lot = await page.$eval('a.card[href^="/lot/"]', (a) => a.getAttribute('href')).catch(() => null)
const mint = lot ? await page.$eval('a.card .cacopy', (b) => b.dataset.copy).catch(() => null) : null
const paths = ['/', '/live', '/fixed', '/sell', '/rewards', '/docs', '/tx', '/log', ...(lot ? [lot] : []), ...(mint ? ['/coin/' + mint] : []), '/no-such-page']
const report = []
for (const w of [1440, 390]) {
  await page.setViewport({ width: w, height: w === 390 ? 844 : 900, deviceScaleFactor: 1 })
  for (const p of paths) {
    await page.goto(base + p, { waitUntil: 'networkidle2' }); await sleep(1200)
    const name = (p === '/' ? 'home' : p.slice(1).replace(/\//g, '-').slice(0, 24)) + `-${tag}-${w}`
    await page.screenshot({ path: join(out, name + '.png'), fullPage: true })
    const facts = await page.evaluate(() => {
      const wide = document.documentElement.scrollWidth > innerWidth + 1
      const over = [...document.querySelectorAll('#view *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('.scrollx') }).slice(0, 5).map((e) => e.className || e.tagName)
      const arts = [...document.querySelectorAll('.art')], noLogo = arts.filter((a) => !a.querySelector('img')).length
      const avs = [...document.querySelectorAll('.av')].filter((a) => !a.closest('.xpost')), noPic = avs.filter((a) => !a.querySelector('img')).length
      const w = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT)
      let bare = 0; for (let n = w.nextNode(); n; n = w.nextNode()) if (/\bSOL\b/.test(n.nodeValue) && !n.parentElement.closest('.solu,svg,blockquote.post-text')) bare++
      return { wide, over, arts: arts.length, noLogo, avs: avs.length, noPic, marks: document.querySelectorAll('.solu .solm').length, bare, title: document.title }
    })
    report.push({ p, w, ...facts })
  }
}
console.log(JSON.stringify({ errors, report }, null, 1))
await browser.close()
