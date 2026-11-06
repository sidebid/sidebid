// Run after every deploy, from your own machine, before going live. It shows which address the server takes for you and
// whether a forged header can change it, and tells you the TRUSTED_HOPS that fits.
//   ADMIN_SECRET=<secret> node tools/deploy-ip-check.mjs https://<your domain> <your public IP>
// Find your public IP with your router or any "what is my IP" page.
const [base, myIp] = process.argv.slice(2)
if (!base || !myIp || !process.env.ADMIN_SECRET) { console.log('usage: ADMIN_SECRET=... node tools/deploy-ip-check.mjs <url> <your public ip>'); process.exit(2) }
const FORGED_FWD = '198.51.100.2', FORGED_REAL = '198.51.100.1'
const ask = async (headers) => {
  const r = await fetch(`${base.replace(/\/$/, '')}/api/admin/ip`, { headers: { 'x-admin-secret': process.env.ADMIN_SECRET, ...headers } })
  if (!r.ok) throw new Error(`server answered ${r.status}`)
  return r.json()
}
const plain = await ask({})
const forged = await ask({ 'x-forwarded-for': FORGED_FWD, 'x-real-ip': FORGED_REAL })
const hops = String(plain.xForwardedFor ?? '').split(',').map((h) => h.trim()).filter(Boolean)
const at = hops.lastIndexOf(myIp)
const fits = at < 0 ? null : hops.length - at
console.log(`server sees: socket ${plain.socket}, x-forwarded-for "${plain.xForwardedFor ?? ''}", x-real-ip "${plain.xRealIp ?? ''}"`)
console.log(`with TRUSTED_HOPS=${plain.trustedHops} it takes you as ${plain.derived}, and with forged headers as ${forged.derived}`)
console.log(fits ? `your address is entry ${fits} from the right: set TRUSTED_HOPS=${fits}` : 'your address is not in x-forwarded-for: check the IP you gave, or the platform adds no header (then TRUSTED_HOPS=0 and limits are per proxy)')
const ok = plain.derived === myIp && forged.derived === myIp && ![FORGED_FWD, FORGED_REAL].includes(forged.derived)
console.log(ok ? 'PASS: the server tells you apart and a forged header changes nothing' : 'FAIL: do not go live. Set TRUSTED_HOPS as above, redeploy, run again')
process.exit(ok ? 0 : 1)
