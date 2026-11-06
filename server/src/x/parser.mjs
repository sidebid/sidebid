// Reads one post to @sidebidsol. Pure and strict: anything it doesn't fully understand is ignored, because nothing is lost
// by asking someone to post again, and a wrong number would put a wrong card live.
//
//   @sidebidsol sell 1m <CA> min 0.5 sol 10m
//   @sidebidsol sell 50% <CA>
//   @sidebidsol <CA> all
//
// Exactly one amount and one CA, optional "min <sol>" and "<n>s|m|h". The amount is a number, an integer percent from 1% to
// 100% (worked out from the linked wallet's balance when the post is read), or all, everything or full. Every other word
// must be on a short list.
import { PublicKey } from '@solana/web3.js'

const MAX_LEN = 1000
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// Bidi controls, zero width characters, tag characters: they make a post read differently from what it says
const isHidden = (cp) => (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f) || cp === 0xad || cp === 0x61c || cp === 0x180e || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb) || (cp >= 0xe0000 && cp <= 0xe007f)
const hasHidden = (s) => { for (const ch of s) if (isHidden(ch.codePointAt(0))) return true; return false }
const FILLER = new Set(['sell', 'selling', 'list', 'listing', 'auction', 'my', 'the', 'of', 'a', 'this', 'token', 'tokens', 'coin', 'coins', 'please', 'pls', 'gm', 'for', 'amount', 'length', 'lasting', 'ca', 'mint', 'at', 'to', 'best', 'offer', 'bid', 'bids', 'bidding'])
const NEGATIVE = new Set(['not', 'never', 'dont', 'cancel', 'stop', 'unlist', 'delete', 'remove', 'scam', 'rug'])
const ALL_WORDS = new Set(['all', 'everything', 'full'])
const SUFFIX = { k: 3, m: 6, b: 9 }
const UNITS = { __proto__: null, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 }

const no = (reason) => ({ ok: false, reason })

/** "1,000,000.5" or "1.5" to a clean decimal string, or null. No exponents, signs, lone commas or leading zeros games. */
function cleanDecimal(s) {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replaceAll(',', '')
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null
  if (s.length > 40) return null
  return s.startsWith('.') ? `0${s}` : s
}
/** Decimal string times 10^scale as a BigInt. Null if it has more places than that. */
export function toBaseUnits(dec, scale) {
  const [w, f = ''] = dec.split('.')
  const frac = f.replace(/0+$/, '')
  if (frac.length > scale) return null
  return BigInt(w) * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0')
}
const U64_MAX = (1n << 64n) - 1n

export function parseMention(text, { handle = 'sidebidsol', defaultSeconds = 300, minSeconds = 60, maxSeconds = 86400 } = {}) {
  if (typeof text !== 'string' || !text) return no('empty')
  if (text.length > MAX_LEN) return no('too_long')
  if (hasHidden(text)) return no('hidden_characters')
  if (/^\s*RT\s+@/i.test(text)) return no('repost')
  if (text.includes('?')) return no('question')
  const mention = new RegExp(`(^|[^\\w])@${handle}(?![\\w])`, 'i')
  if (!mention.test(text)) return no('no_tag')
  const lines = text.replace(/https?:\/\/\S+/gi, ' ').replace(/(^|\s)@\w{1,15}(?=$|[\s,.:;!])/g, ' ').replace(/[\s,;:!()"'“”]+$/g, '')
  const tokens = lines.split(/\s+/).map((t) => t.replace(/^[(\["'“]+|[)\]"'”,;:!.]+$/g, '')).filter(Boolean)

  let ca = null, amount = null, all = false, pct = null, minSol = null, seconds = null
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i], t = raw.toLowerCase()
    if (/^\p{Nd}/u.test(raw) && !/^[0-9]/.test(raw)) return no('foreign_digits')
    if (B58.test(raw) && /[a-z]/i.test(raw) && raw.length >= 32) {
      let pk
      try { pk = new PublicKey(raw) } catch { return no('bad_ca') }
      if (pk.toBase58() !== raw) return no('bad_ca')
      if (ca && ca !== raw) return no('two_cas')
      ca = raw; continue
    }
    if (/^\$[a-z]\w*$/i.test(raw)) continue // a ticker tells us nothing: the CA decides
    if (raw.startsWith('$') || raw.startsWith('-') || raw.startsWith('+')) return no('bad_number')
    if (NEGATIVE.has(t.replace(/['’]/g, ''))) return no('negative')
    if (t === 'min' || t === 'minimum' || t === 'floor') {
      const next = cleanDecimal((tokens[i + 1] ?? '').toLowerCase().replace(/sol$/, ''))
      if (!next || minSol) return no('bad_min')
      minSol = next; i++
      if ((tokens[i + 1] ?? '').toLowerCase() === 'sol') i++
      continue
    }
    if (t === 'sol') return no('sol_without_min') // "0.5 sol" alone could be a price or an amount
    // length: 10m, 10 min. A bare "5m" is length; a size in millions needs a decimal or a word, see below
    const dur = /^(\d{1,6})(s|sec|secs|m|min|mins|h|hr|hrs)$/.exec(t)
    const spaced = /^\d{1,6}$/.test(t) && UNITS[(tokens[i + 1] ?? '').toLowerCase()] && !/^(m)$/.test((tokens[i + 1] ?? '').toLowerCase())
    // "1m" before a length or after an amount: the first m-number with no amount yet is the amount
    if (dur && dur[2] === 'm' && amount === null && !all && pct === null) { amount = String(BigInt(dur[1]) * 1_000_000n); continue }
    if (dur) { if (seconds !== null) return no('two_lengths'); seconds = Number(dur[1]) * UNITS[dur[2]]; continue }
    if (spaced) { if (seconds !== null) return no('two_lengths'); seconds = Number(t) * UNITS[tokens[i + 1].toLowerCase()]; i++; continue }
    if (ALL_WORDS.has(t)) { if (all || pct !== null || amount !== null) return no('two_amounts'); all = true; continue }
    // A percent of what the linked wallet holds: whole numbers only, 1% to 100%. 100% is the same as all
    if (t.includes('%')) {
      const m = /^(\d{1,3})%$/.exec(t)
      if (!m || /^0\d/.test(m[1])) return no('bad_percent')
      const n = Number(m[1])
      if (n < 1 || n > 100) return no('bad_percent')
      if (all || pct !== null || amount !== null) return no('two_amounts')
      if (n === 100) all = true
      else pct = n
      continue
    }
    const num = /^([0-9][0-9.,]*|\.[0-9]+)([kmb])?$/.exec(t)
    if (num) {
      const clean = cleanDecimal(num[1])
      if (!clean) return no('bad_number')
      if (amount !== null || all || pct !== null) return no('two_amounts')
      amount = shift(clean, SUFFIX[num[2]] ?? 0)
      continue
    }
    if (FILLER.has(t)) continue
    if (!/[\p{L}\p{N}]/u.test(raw)) continue // punctuation and emoji say nothing
    return no('unknown_word')
  }
  if (!ca) return no('no_ca')
  if (!all && pct === null && amount === null) return no('no_amount')
  if (amount !== null && /^0*\.?0*$/.test(amount)) return no('zero_amount')
  if (amount !== null && BigInt(amount.split('.')[0]) > U64_MAX) return no('too_big')
  const dur = seconds ?? defaultSeconds
  if (!Number.isInteger(dur) || dur < minSeconds || dur > maxSeconds) return no('bad_length')
  let minBid = null
  if (minSol) {
    minBid = toBaseUnits(minSol, 9)
    if (minBid === null) return no('bad_min')
    if (minBid < 1_000_000n || minBid > U64_MAX) return no('bad_min')
  }
  return { ok: true, ca, amount: all || pct !== null ? null : amount, all, pct, minBid: minBid === null ? null : minBid.toString(), seconds: dur }
}

/** Moves the decimal point right, on strings, so nothing passes through a float. */
function shift(dec, places) {
  if (!places) return dec
  const [w, f = ''] = dec.split('.')
  const padded = f.padEnd(places, '0')
  const whole = (w + padded.slice(0, places)).replace(/^0+(?=\d)/, '')
  const rest = padded.slice(places)
  return rest ? `${whole}.${rest}` : whole
}
