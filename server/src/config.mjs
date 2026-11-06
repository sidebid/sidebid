// Every setting, read once from the environment. Secrets are parsed here and never logged.
import { resolve, relative, isAbsolute } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { MAX_ACCEPT_WINDOW_SECS, MAX_AUCTION_SECS, MIN_ACCEPT_WINDOW_SECS, MIN_AUCTION_SECS } from './chain/program.mjs'

// The contract's own test only listing key. It is public in git, so it must never run for real.
const TEST_LISTING_KEY = '9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91'

// The X spend cap can be lowered by config, never raised past this.
export const HARD_X_SPEND_CEILING_USD = 25

const num = (env, k, d) => { const v = env[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} is not a number`); return n }

/** Accepts base58 or a JSON byte array. The error names the variable and never the value. */
export function keypairFrom(name, raw) {
  if (!raw) return null
  try {
    const s = String(raw).trim()
    const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)
    if (bytes.length !== 64) throw new Error('length')
    return Keypair.fromSecretKey(bytes)
  } catch { throw new Error(`${name} is not a usable secret key`) }
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT
  const https = /^https:/i.test(String(env.PUBLIC_URL ?? ''))
  // How many proxies stand in front of this process, each appending one x-forwarded-for entry. 0 trusts no header at all.
  // Set from the deploy test in BACKEND.md, never guessed. A wrong number either merges visitors or lets them pick their address.
  const hops = env.TRUSTED_HOPS
  if ((production || https) && (hops === undefined || hops === '')) {
    throw new Error('TRUSTED_HOPS must be set. Run the deploy test in BACKEND.md to find the number of proxies in front of this server (on Railway expect 1), then set TRUSTED_HOPS to it. Until then rate limits cannot tell visitors apart.')
  }
  if (hops !== undefined && hops !== '' && !/^\d$/.test(hops)) throw new Error('TRUSTED_HOPS must be a whole number from 0 to 9')
  if (env.RAILWAY_ENVIRONMENT && !env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('No Railway volume attached. Sign ins, wallet links and open transactions would be lost on every deploy.')
  const c = {
    publicUrl: String(env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
    port: num(env, 'PORT', 8080),
    // On Railway the volume's own mount path, unless DATA_DIR names a folder on it (checked below)
    dataDir: env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data',
    rpcUrl: env.RPC_URL || '',
    rpcMaxRps: num(env, 'RPC_MAX_RPS', 8),
    programId: new PublicKey(env.PROGRAM_ID || '5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp'),
    adminSecret: env.ADMIN_SECRET || '',
    production, trustedHops: Number(env.TRUSTED_HOPS || 0),
    listingKey: keypairFrom('LISTING_SECRET', env.LISTING_SECRET),
    listingPubkeyExpected: env.LISTING_PUBKEY_EXPECTED || null,
    keeperKey: keypairFrom('KEEPER_SECRET', env.KEEPER_SECRET),
    passKey: keypairFrom('PASS_SECRET', env.PASS_SECRET),
    passHashKey: env.PASS_HASH_KEY || '',
    passTtlSeconds: num(env, 'PASS_TTL_SECONDS', 120),
    // Privy sign in. The app id is public (it is in every page); tokens are checked against the app's public keys, so no
    // app secret is needed or read. PRIVY_CLIENT_ID picks an app client (a dev one for the preview), also public.
    privy: { appId: String(env.PRIVY_APP_ID || '').trim(), clientId: String(env.PRIVY_CLIENT_ID || '').trim(), jwksUrl: env.PRIVY_JWKS_URL || '' },
    x: {
      // Our own Sign in with X, kept only as a fallback. Off unless X_OAUTH_FALLBACK is on.
      oauthFallback: /^(1|true|on|yes)$/i.test(String(env.X_OAUTH_FALLBACK ?? '')),
      signinClientId: env.X_SIGNIN_CLIENT_ID || '', signinClientSecret: env.X_SIGNIN_CLIENT_SECRET || '',
      readBearer: env.X_READ_BEARER || '',
      postApiKey: env.X_POST_API_KEY || '', postApiSecret: env.X_POST_API_SECRET || '', postToken: env.X_POST_TOKEN || '', postTokenSecret: env.X_POST_TOKEN_SECRET || '',
      readAsUser: env.X_READ_AS_USER === '1',
      accountId: env.X_ACCOUNT_ID || '', handle: String(env.X_HANDLE || 'sidebidsol').replace(/^@/, ''),
      dailyCapUsd: Math.min(num(env, 'X_DAILY_SPEND_CAP_USD', 2), HARD_X_SPEND_CEILING_USD),
      // X pay per use prices (docs.x.com/x-api/getting-started/pricing, checked 6 Nov 2026). A post with any link in it is a
      // "Post: Create (with URL)" at 0.20; a bare domain may be turned into a link by X, so it counts as one too (hasLink).
      costPerReadUsd: num(env, 'X_COST_PER_READ_USD', 0.005), costPerOwnedReadUsd: num(env, 'X_COST_PER_OWNED_READ_USD', 0.001), costPerUserUsd: num(env, 'X_COST_PER_USER_USD', 0.01),
      costPerPostUsd: num(env, 'X_COST_PER_POST_USD', 0.015), costPerPostLinkUsd: num(env, 'X_COST_PER_POST_LINK_USD', 0.2),
      // Off: replies carry no link and no domain, so each bills at the plain post price. On: the card link, at the URL price.
      replyLinks: /^(1|true|on|yes)$/i.test(String(env.X_REPLY_LINKS ?? '')),
      // Sign ins' own allowance inside the daily cap, for the one profile read each costs. 0 keeps sign in paused.
      signinCapUsd: Math.max(num(env, 'X_SIGNIN_CAP_USD', 0), 0),
      pollSeconds: Math.max(num(env, 'X_POLL_SECONDS', 60), 15), readShare: Math.min(Math.max(num(env, 'X_READ_SHARE', 0.6), 0), 1),
      // A launch hour's burst should cost that hour, not the rest of the day. Default: a third of the day's read share.
      readHourlyUsd: num(env, 'X_READ_HOURLY_USD', null), pageSize: Math.min(Math.max(num(env, 'X_MENTION_PAGE_SIZE', 20), 5), 100), maxPages: Math.min(Math.max(num(env, 'X_MENTION_MAX_PAGES', 3), 1), 10),
      creditsPauseMs: num(env, 'X_CREDITS_PAUSE_MS', 3600_000),
      // Dev drop posts from @sidebidsol. Off: no link and no domain, at the plain post price. On: the lot link, at the URL price.
      dropPostLinks: /^(1|true|on|yes)$/i.test(String(env.X_DROP_POST_LINKS ?? '')),
      // The drop's share card goes in as a picture. X's price list has no line for media upload; this is reserved per upload.
      dropPostMedia: !/^(0|false|off|no)$/i.test(String(env.X_DROP_POST_MEDIA ?? '')),
      costPerMediaUsd: num(env, 'X_COST_PER_MEDIA_USD', 0.015),
    },
    // The first hour dev drops. Count, sizes, 5% total and the 15% discount are fixed in src/drops.mjs; only the clock is here.
    drops: {
      mint: env.DROPS_MINT || null,
      everySeconds: num(env, 'DROPS_EVERY_SECONDS', 300), lengthSeconds: num(env, 'DROPS_LENGTH_SECONDS', 240),
    },
    walletChangeWaitMs: num(env, 'WALLET_CHANGE_WAIT_HOURS', 48) * 3600_000,
    tag: {
      rentBudgetLamports: num(env, 'TAG_RENT_BUDGET_LAMPORTS', 100_000_000),
      perAccountDay: num(env, 'TAG_PER_ACCOUNT_DAY', 5), perAccountOpen: num(env, 'TAG_PER_ACCOUNT_OPEN', 2), globalPerHour: num(env, 'TAG_GLOBAL_PER_HOUR', 30),
      minListingBalance: num(env, 'TAG_MIN_LISTING_BALANCE_LAMPORTS', 20_000_000),
      defaultSeconds: num(env, 'TAG_DEFAULT_SECONDS', 300), minSeconds: Math.max(num(env, 'TAG_MIN_SECONDS', 60), MIN_AUCTION_SECS), maxSeconds: Math.min(num(env, 'TAG_MAX_SECONDS', MAX_AUCTION_SECS), MAX_AUCTION_SECS),
      acceptWindowSeconds: num(env, 'TAG_ACCEPT_WINDOW_SECONDS', 600),
      mentionMaxAgeMs: num(env, 'TAG_MENTION_MAX_AGE_MIN', 30) * 60_000,
    },
    brand: { name: env.BRAND_NAME || 'Sidebid', ticker: String(env.BRAND_TICKER || 'SIDEBID').replace(/^\$/, ''), tagline: env.BRAND_TAGLINE || 'Sell your tokens, not the chart. The best bid in a live auction takes them.' },
    devKey: keypairFrom('DEV_SECRET', env.DEV_SECRET),
    rewards: {
      teamWallet: env.REWARDS_TEAM_WALLET || null,
      teamBps: num(env, 'REWARDS_TEAM_BPS', 1000),
      split: String(env.REWARDS_SPLIT_BPS || '5000,3000,2000').split(',').map((x) => Number(x.trim())),
      minClaimSol: num(env, 'REWARDS_MIN_CLAIM_SOL', 0.002),
      minPayoutLamports: num(env, 'REWARDS_MIN_PAYOUT_LAMPORTS', 1_000_000),
      closeGraceMs: num(env, 'REWARDS_CLOSE_GRACE_S', 60) * 1000,
    },
    keeper: { tickMs: num(env, 'KEEPER_TICK_MS', 1000), courtesyClosesPerDay: num(env, 'KEEPER_COURTESY_CLOSES_PER_DAY', 200), tokenAccountDailyLamports: num(env, 'KEEPER_TOKEN_ACCOUNT_DAILY_LAMPORTS', 50_000_000) },
    indexer: { tickMs: num(env, 'INDEX_TICK_MS', 3000), reconcileMs: num(env, 'INDEX_RECONCILE_MS', 300_000), maxPages: num(env, 'INDEX_MAX_PAGES', 50) },
  }
  // A zero price passes any cap, so a cost set to 0 would turn the cap off for that call
  for (const k of ['costPerReadUsd', 'costPerOwnedReadUsd', 'costPerUserUsd', 'costPerPostUsd', 'costPerPostLinkUsd', 'costPerMediaUsd']) if (!(c.x[k] > 0)) throw new Error(`X_COST_* must be above 0 (${k}): a zero price would pass any cap`)
  // The database holds sessions, wallet links, open transactions and the X spend ledger. Off the volume, a redeploy wipes them.
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH
  if (mount) {
    const rel = relative(resolve(mount), resolve(c.dataDir))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`DATA_DIR (${c.dataDir}) is not on the Railway volume mounted at ${mount}. Unset DATA_DIR to use the volume, or point it inside ${mount}.`)
  } else if (production && !env.DATA_DIR) throw new Error('DATA_DIR must be set in production, to a folder on a persistent volume. Sign ins, wallet links, open transactions and the X spend ledger live there.')
  if (c.x.readHourlyUsd === null) c.x.readHourlyUsd = (Math.max(c.x.dailyCapUsd - c.x.signinCapUsd, 0) * c.x.readShare) / 3
  if (c.adminSecret && c.adminSecret.length < 32) throw new Error('ADMIN_SECRET must be at least 32 random characters: the secret is the protection, a guess limit only slows noise')
  if (c.tag.acceptWindowSeconds < MIN_ACCEPT_WINDOW_SECS || c.tag.acceptWindowSeconds > MAX_ACCEPT_WINDOW_SECS) throw new Error(`TAG_ACCEPT_WINDOW_SECONDS must be ${MIN_ACCEPT_WINDOW_SECS} to ${MAX_ACCEPT_WINDOW_SECS}, the contract's limits`)
  if (production && c.listingKey?.publicKey.toBase58() === TEST_LISTING_KEY) throw new Error('LISTING_SECRET is the public test key. Make a real key and rebuild the program with it.')
  const r = c.rewards
  if (r.teamWallet) { try { new PublicKey(r.teamWallet) } catch { throw new Error('REWARDS_TEAM_WALLET is not an address') } }
  if (!(r.teamBps >= 0 && r.teamBps <= 10_000) || !r.split.every((b) => Number.isInteger(b) && b >= 0) || r.split.reduce((a, b) => a + b, 0) !== 10_000) throw new Error('REWARDS_SPLIT_BPS must add up to 10000 and REWARDS_TEAM_BPS be 0 to 10000')
  if (r.minPayoutLamports < 890_880) throw new Error('REWARDS_MIN_PAYOUT_LAMPORTS must be at least 890880, the rent exempt minimum, or a payout to an empty wallet is refused by the network')
  if (env.EXPECTED_DEV_PUBKEY && c.devKey && c.devKey.publicKey.toBase58() !== env.EXPECTED_DEV_PUBKEY) throw new Error('DEV_SECRET does not match EXPECTED_DEV_PUBKEY')
  const keys = [['LISTING_SECRET', c.listingKey], ['KEEPER_SECRET', c.keeperKey], ['PASS_SECRET', c.passKey], ['DEV_SECRET', c.devKey]].filter(([, k]) => k)
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if (keys[i][1].publicKey.equals(keys[j][1].publicKey)) throw new Error(`${keys[i][0]} and ${keys[j][0]} must be different keys`)
  }
  if (c.listingKey && c.listingPubkeyExpected && c.listingKey.publicKey.toBase58() !== c.listingPubkeyExpected) throw new Error('LISTING_SECRET does not match LISTING_PUBKEY_EXPECTED')
  if (c.privy.appId && !/^[a-z0-9]{10,40}$/i.test(c.privy.appId)) throw new Error('PRIVY_APP_ID does not look like a Privy app id')
  if (c.privy.clientId && !/^client-[A-Za-z0-9]{10,80}$/.test(c.privy.clientId)) throw new Error('PRIVY_CLIENT_ID does not look like a Privy app client id')
  if (c.privy.jwksUrl && !/^https:\/\/auth\.privy\.io\//.test(c.privy.jwksUrl) && production) throw new Error('PRIVY_JWKS_URL must be on auth.privy.io in production')
  const dr = c.drops
  if (dr.mint) { try { new PublicKey(dr.mint) } catch { throw new Error('DROPS_MINT is not an address') } }
  if (!(dr.lengthSeconds >= MIN_AUCTION_SECS && dr.lengthSeconds <= MAX_AUCTION_SECS) || !(dr.everySeconds >= dr.lengthSeconds + 10 && dr.everySeconds <= 3600)) throw new Error('DROPS_LENGTH_SECONDS must be 10 to 3600 and DROPS_EVERY_SECONDS at least 10 more, at most 3600')
  if (c.passKey && c.passHashKey.length < 32) throw new Error('PASS_HASH_KEY must be at least 32 characters')
  return c
}
