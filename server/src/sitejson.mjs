// Writes the production site.json at start, from the environment, before the first visitor can ask for /api/config.
// The browser's RPC is its own variable, BROWSER_RPC_URL: a public safe endpoint (a key locked to the domain, or a free
// public RPC). The server's RPC_URL carries a paid key and is never written here; a browser URL that shares its key is refused.
// Every other value already in the file (brand reveal, the CA, facts, drops) is kept, so editing it on the volume still works.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The secret parts of an RPC URL: long query values and long path segments (Helius ?api-key=, QuickNode /<token>/). */
const secretsOf = (raw) => {
  let u
  try { u = new URL(raw) } catch { return [] }
  return [...u.searchParams.values(), ...u.pathname.split('/'), u.username, u.password].filter((s) => s && s.length >= 16)
}
/** True when the browser URL would hand out the server's RPC key. */
export const leaksServerKey = (browserUrl, serverUrl) => {
  if (!browserUrl || !serverUrl) return false
  if (String(browserUrl).replace(/\/$/, '') === String(serverUrl).replace(/\/$/, '')) return true
  return secretsOf(serverUrl).some((s) => String(browserUrl).includes(s))
}

export function prepareSiteJson({ config, env = process.env }) {
  const file = env.SITE_CONFIG || join(config.dataDir, 'site.json')
  const browserRpc = (env.BROWSER_RPC_URL || '').trim()
  let cur = {}
  if (existsSync(file)) { try { cur = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON. Fix or delete it; the site reads its chain settings from it.`) } }
  else if (env.SITE_CONFIG_JSON) { try { cur = JSON.parse(env.SITE_CONFIG_JSON) } catch { throw new Error('SITE_CONFIG_JSON is not valid JSON') } }
  if (browserRpc) {
    if (!/^https:\/\/[^\s"'<>]+$/.test(browserRpc) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(browserRpc)) throw new Error('BROWSER_RPC_URL must be an https URL')
    if (leaksServerKey(browserRpc, config.rpcUrl)) throw new Error('BROWSER_RPC_URL shares the server RPC key. Every visitor would see it. Use a separate key locked to the domain, or a public RPC.')
  }
  const chain = { ...(cur.chain ?? {}) }
  if (browserRpc) chain.rpc = browserRpc
  if (env.SOLANA_CLUSTER) chain.cluster = env.SOLANA_CLUSTER
  else if (config.production && !chain.cluster) chain.cluster = 'mainnet-beta'
  // For whoever reads the file. The site itself always takes the program id from PROGRAM_ID.
  chain.programId = config.programId.toBase58()
  if (chain.rpc && leaksServerKey(chain.rpc, config.rpcUrl)) throw new Error(`${file} chain.rpc shares the server RPC key. Set BROWSER_RPC_URL to a public safe RPC.`)
  if (config.production && !chain.rpc) throw new Error('No browser RPC: set BROWSER_RPC_URL (a public safe RPC, never RPC_URL). Without it no page can read the chain or build a transaction.')
  const next = { ...cur, chain }
  if (env.UPGRADE_AUTHORITY) next.keys = { ...(cur.keys ?? {}), upgradeAuthority: env.UPGRADE_AUTHORITY }
  // The CA stays hidden until the owner turns the reveal on in the file
  next.brand = { reveal: false, ...(cur.brand ?? {}) }
  // Only written when the environment says something; otherwise the file (or SITE_CONFIG_JSON) is read as it is
  if (!browserRpc && !env.SOLANA_CLUSTER && !env.UPGRADE_AUTHORITY) return { file, wrote: false, config: next }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
  return { file, wrote: true, config: next }
}
