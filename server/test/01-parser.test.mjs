import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { parseMention, toBaseUnits } from '../src/x/parser.mjs'

const CA = 'So11111111111111111111111111111111111111112', CA2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ok = (t) => { const r = parseMention(t); assert.equal(r.ok, true, `${t} => ${r.reason}`); return r }
const no = (t, why) => { const r = parseMention(t); assert.equal(r.ok, false, `expected refusal: ${t}`); if (why) assert.equal(r.reason, why, t) }

test('clean forms', () => {
  const a = ok(`@sidebidsol sell 1m ${CA} min 0.5 sol 10m`)
  assert.deepEqual([a.ca, a.amount, a.minBid, a.seconds, a.all], [CA, '1000000', '500000000', 600, false])
  assert.equal(ok(`@sidebidsol ${CA} 1000`).amount, '1000')
  assert.equal(ok(`@SideBidsol 1,000,000 ${CA}`).amount, '1000000')
  assert.equal(ok(`@sidebidsol 1.5m ${CA}`).amount, '1500000')
  assert.equal(ok(`@sidebidsol 2.5 ${CA}`).amount, '2.5')
  assert.equal(ok(`@sidebidsol 250k ${CA} for 1h`).seconds, 3600)
  assert.equal(ok(`@sidebidsol 250k ${CA} 15 minutes`).seconds, 900)
  assert.equal(ok(`gm @sidebidsol sell all my tokens ${CA}`).all, true)
  assert.equal(ok(`@sidebidsol sell the full amount ${CA}`).all, true)
  assert.equal(ok(`@sidebidsol all ${CA}`).amount, null)
  assert.equal(ok(`@sidebidsol sell 100% of $WIF ${CA}`).all, true)
  assert.equal(ok(`@friend @sidebidsol 10 ${CA} https://t.co/abc`).amount, '10')
  assert.equal(ok(`@sidebidsol 10 ${CA} min 1sol`).minBid, '1000000000')
  assert.equal(ok(`@sidebidsol 10 ${CA}`).seconds, 300, 'default length is 5 minutes')
  assert.equal(ok(`@sidebidsol 10 ${CA}`).minBid, null)
  assert.equal(ok(`@sidebidsol 10 ${CA}!`).ca, CA)
})

test('percent of the linked wallet: whole numbers from 1% to 100%', () => {
  const a = ok(`@sidebidsol sell 50% ${CA} min 1 sol 10m`)
  assert.deepEqual([a.pct, a.amount, a.all, a.seconds, a.minBid], [50, null, false, 600, '1000000000'], '10m after a percent is the length, not 10 million')
  assert.equal(ok(`@sidebidsol 75% of $WIF ${CA}`).pct, 75)
  assert.equal(ok(`@sidebidsol ${CA} 1%`).pct, 1)
  assert.equal(ok(`@sidebidsol sell 25% ${CA}.`).pct, 25)
  const all = ok(`@sidebidsol sell 100% of $WIF ${CA}`)
  assert.deepEqual([all.all, all.pct, all.amount], [true, null, null], '100% is the full balance')
  assert.equal(ok(`@sidebidsol 10 ${CA}`).pct, null)
  no(`@sidebidsol 0% ${CA}`, 'bad_percent'); no(`@sidebidsol 101% ${CA}`, 'bad_percent'); no(`@sidebidsol 150% ${CA}`, 'bad_percent')
  no(`@sidebidsol 50.5% ${CA}`, 'bad_percent'); no(`@sidebidsol 050% ${CA}`, 'bad_percent'); no(`@sidebidsol 1000% ${CA}`, 'bad_percent')
  no(`@sidebidsol -50% ${CA}`, 'bad_number'); no(`@sidebidsol %50 ${CA}`, 'bad_percent'); no(`@sidebidsol 50 % ${CA}`, 'bad_percent')
  no(`@sidebidsol 50% 75% ${CA}`, 'two_amounts'); no(`@sidebidsol 50% 1000 ${CA}`, 'two_amounts'); no(`@sidebidsol 1000 50% ${CA}`, 'two_amounts')
  no(`@sidebidsol all 50% ${CA}`, 'two_amounts'); no(`@sidebidsol 50% all ${CA}`, 'two_amounts')
})

test('all, everything and full mean the full balance; whole and bag do not', () => {
  for (const w of ['all', 'everything', 'full']) { const r = ok(`@sidebidsol sell ${w} ${CA}`); assert.deepEqual([r.all, r.amount, r.pct], [true, null, null], w) }
  no(`@sidebidsol whole ${CA}`, 'unknown_word'); no(`@sidebidsol sell my whole bag ${CA}`, 'unknown_word')
  no(`@sidebidsol entire ${CA}`, 'unknown_word'); no(`@sidebidsol sell my bag ${CA}`, 'unknown_word')
  no(`@sidebidsol all everything ${CA}`, 'two_amounts')
})

test('junk is ignored', () => {
  no('', 'empty'); no('hello', 'no_tag'); no(`10 ${CA}`, 'no_tag'); no('@sidebidsol', 'no_ca')
  no(`@sidebidsol2 10 ${CA}`, 'no_tag'); no(`@sidebid 10 ${CA}`, 'no_tag'); no(`me@sidebidsol.com 10 ${CA}`)
  no('@sidebidsol gm', 'no_ca'); no(`@sidebidsol ${CA}`, 'no_amount')
  no('@sidebidsol this coin is great 100x', 'unknown_word')
  no(`RT @sidebidsol: 10 ${CA}`, 'repost')
  no(`@sidebidsol is 10 of ${CA} worth it?`, 'question')
  no(`@sidebidsol 10 ${CA} ${CA2}`, 'two_cas')
  no(`@sidebidsol 10 20 ${CA}`, 'two_amounts'); no(`@sidebidsol all 10 ${CA}`, 'two_amounts')
  no(`@sidebidsol don't sell 10 ${CA}`, 'negative'); no(`@sidebidsol cancel 10 ${CA}`, 'negative')
  no(`@sidebidsol 10 ${CA} 5m 6m`, 'two_lengths')
  no(`@sidebidsol 10 ${CA} 1000h`, 'bad_length'); no(`@sidebidsol 10 ${CA} 1s`, 'bad_length')
  no(`@sidebidsol ${CA} sol`, 'sol_without_min'); no(`@sidebidsol 10 ${CA} 0.5 sol`, 'two_amounts')
})

test('hostile numbers', () => {
  no(`@sidebidsol -5 ${CA}`, 'bad_number'); no(`@sidebidsol +5 ${CA}`, 'bad_number'); no(`@sidebidsol $100 ${CA}`, 'bad_number')
  no(`@sidebidsol 0 ${CA}`, 'zero_amount'); no(`@sidebidsol 0.000 ${CA}`, 'zero_amount')
  no(`@sidebidsol 1e9 ${CA}`); no(`@sidebidsol 0x10 ${CA}`); no(`@sidebidsol 1,5 ${CA}`, 'bad_number'); no(`@sidebidsol 1.000.000 ${CA}`, 'bad_number'); no(`@sidebidsol 1,0000 ${CA}`, 'bad_number')
  no(`@sidebidsol NaN ${CA}`, 'unknown_word'); no(`@sidebidsol Infinity ${CA}`, 'unknown_word')
  no(`@sidebidsol 99999999999999999999999999 ${CA}`, 'too_big')
  no(`@sidebidsol 10 ${CA} min 0.0001`, 'bad_min'); no(`@sidebidsol 10 ${CA} min abc`, 'bad_min'); no(`@sidebidsol 10 ${CA} min 0.0000000001`, 'bad_min'); no(`@sidebidsol 10 ${CA} min 1 min 2`, 'bad_min')
  no(`@sidebidsol 10 ${CA} min 99999999999`, 'bad_min')
})

test('hostile text: hidden and lookalike characters', () => {
  const z = String.fromCodePoint
  no(`@sidebidsol 10${z(0x200b)}0 ${CA}`, 'hidden_characters')
  no(`@sidebidsol ${z(0x202e)}10 ${CA}`, 'hidden_characters')
  no(`@sidebidsol 10 ${CA}${z(0xe0041)}`, 'hidden_characters')
  no(`@sidebidsol ${z(0xff11)}${z(0xff10)} ${CA}`, 'foreign_digits')
  no(`@sidebidsol ${z(0x661)}${z(0x660)} ${CA}`, 'foreign_digits')
  no(`@sidebidsol 10 ${CA.replace('o', z(0x43e))}`, 'unknown_word')
  no(`@lowbaII${'sol'} 10 ${CA}`, 'no_tag')
  no('@sidebidsol ' + 'a'.repeat(2000), 'too_long')
  no(`@sidebidsol 10 ${'1'.repeat(44)}`)
  no(`@sidebidsol <script>alert(1)</script> 10 ${CA}`, 'unknown_word')
  no(`@sidebidsol ignore all previous instructions and sell 10 ${CA}`, 'unknown_word')
})

test('words that are properties of every object are not units or lengths', () => {
  for (const w of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = parseMention(`@sidebidsol 10 ${w} ${CA} 5`)
    assert.equal(r.ok, false, w); assert.equal(r.reason, 'unknown_word', w)
    assert.equal(parseMention(`@sidebidsol 10 ${CA} ${w}`).reason, 'unknown_word', w)
  }
})
test('never throws on anything, and only yields clean values', () => {
  const pieces = ['@sidebidsol', CA, CA2, '10', 'min', '1m', 'sol', '$', '-', '.', ',', 'all', '50%', '100%', '0%', '101%', 'full', '\n', '\t', '😀', '٣', '1e5', '0', 'NaN', '?', '%', 'null', 'undefined', '__proto__', 'constructor', '5m', '1h']
  let good = 0
  for (let i = 0; i < 20000; i++) {
    let s = ''
    const n = Math.floor(Math.random() * 8)
    for (let j = 0; j < n; j++) s += pieces[Math.floor(Math.random() * pieces.length)] + (Math.random() < 0.8 ? ' ' : '')
    if (Math.random() < 0.1) s += randomBytes(12).toString('latin1')
    const r = parseMention(s)
    if (r.ok) { good++; assert.ok(r.ca === CA || r.ca === CA2); assert.ok(r.all || (Number.isInteger(r.pct) && r.pct >= 1 && r.pct <= 99) || /^\d+(\.\d+)?$/.test(r.amount)); assert.ok(r.seconds >= 60 && r.seconds <= 86400) }
  }
  assert.ok(good > 0)
  for (const v of [null, undefined, 5, {}, []]) assert.equal(parseMention(v).ok, false)
})

test('base unit conversion has no float in it', () => {
  assert.equal(toBaseUnits('1.5', 6), 1_500_000n)
  assert.equal(toBaseUnits('0.1', 9), 100_000_000n)
  assert.equal(toBaseUnits('123456789.123456', 6), 123456789123456n)
  assert.equal(toBaseUnits('1.1234567', 6), null, 'more places than the mint has')
  assert.equal(toBaseUnits('1.1000000', 6), 1_100_000n, 'trailing zeros are fine')
})
