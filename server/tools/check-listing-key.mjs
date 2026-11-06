// Before deploying: does this build of the program contain this server's listing key? The key is compiled in. This shows the
// 32 bytes are somewhere in the binary, which is strong evidence and not proof. The real check is one tagged card on a test run.
//   LISTING_PUBKEY_EXPECTED=<public key> node tools/check-listing-key.mjs [path to sidebid.so]
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
const so = readFileSync(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? new URL('../../program/target/deploy/sidebid.so', import.meta.url))
const expected = process.env.LISTING_PUBKEY_EXPECTED
if (expected === '9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91' && !process.argv.includes('--allow-test-key')) { console.log('REFUSED: that is the public test key'); process.exit(1) }
const key = new PublicKey(expected).toBuffer()
const found = so.indexOf(key) >= 0
console.log(found ? 'ok: the build contains this listing key' : 'NOT FOUND: rebuild the program with this key, see BACKEND.md')
process.exit(found ? 0 : 1)
