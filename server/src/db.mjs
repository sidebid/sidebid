// One SQLite file. Two kinds of table:
//   cache (rebuilt from chain): listings, sales, events_seen, credits, and the indexer cursor
//   records the chain can't give back: x users, wallet links, sessions, mentions, replies, tx intents, flags, spend
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS x_users (x_id TEXT PRIMARY KEY, handle TEXT NOT NULL, avatar TEXT, x_created_at INTEGER, followers INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, x_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS privy_users (did TEXT PRIMARY KEY, account TEXT NOT NULL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_nonces (nonce TEXT PRIMARY KEY, x_id TEXT NOT NULL, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallet_links (x_id TEXT PRIMARY KEY, wallet TEXT NOT NULL UNIQUE, linked_at INTEGER NOT NULL, pending_wallet TEXT UNIQUE, pending_at INTEGER);
CREATE TABLE IF NOT EXISTS wallet_owners (wallet TEXT PRIMARY KEY, x_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reward_hours (hour INTEGER PRIMARY KEY, state TEXT NOT NULL, standings TEXT NOT NULL, carry_in TEXT NOT NULL, claim_state TEXT NOT NULL, claim_sig TEXT, claim_at INTEGER, claimed TEXT NOT NULL, claim_fee TEXT NOT NULL, claim_note TEXT,
  net TEXT, team TEXT, prize TEXT, carry_out TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS reward_payouts (hour INTEGER NOT NULL, slot TEXT NOT NULL, place INTEGER NOT NULL, wallet TEXT NOT NULL, lamports TEXT NOT NULL, status TEXT NOT NULL, sig TEXT, note TEXT, refusals INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour, slot));
CREATE TABLE IF NOT EXISTS admin_unlinks (wallet TEXT NOT NULL, x_id TEXT NOT NULL, was TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spend_hour (hour TEXT PRIMARY KEY, read_micro INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS mentions (tweet_id TEXT PRIMARY KEY, x_id TEXT NOT NULL, handle TEXT, avatar TEXT, x_created_at INTEGER, followers INTEGER, text TEXT NOT NULL, created_at INTEGER,
  state TEXT NOT NULL, reason TEXT, parsed TEXT, listing TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS mentions_state ON mentions(state, next_at);
CREATE TABLE IF NOT EXISTS tag_cards (listing TEXT PRIMARY KEY, tweet_id TEXT NOT NULL UNIQUE, x_id TEXT NOT NULL, handle TEXT, avatar TEXT, wallet TEXT NOT NULL, mint TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE INDEX IF NOT EXISTS tag_cards_x ON tag_cards(x_id, created_at);
CREATE TABLE IF NOT EXISTS replies (kind TEXT NOT NULL, tweet_id TEXT NOT NULL, x_id TEXT NOT NULL, listing TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, reply_id TEXT, err TEXT, updated_at INTEGER, PRIMARY KEY (kind, tweet_id));
CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, micro_usd INTEGER NOT NULL DEFAULT 0, read_micro INTEGER NOT NULL DEFAULT 0, reads INTEGER NOT NULL DEFAULT 0, posts INTEGER NOT NULL DEFAULT 0, signin_micro INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS keeper_spend (day TEXT PRIMARY KEY, lamports INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS tx_intents (key TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, status TEXT NOT NULL, sig TEXT NOT NULL, raw TEXT NOT NULL, lvbh INTEGER NOT NULL, err TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, updated_at INTEGER, PRIMARY KEY (key, attempt));
CREATE INDEX IF NOT EXISTS tx_intents_open ON tx_intents(status);
-- Block time of a confirmed transaction, read once from the chain for the public feed's Paid at
CREATE TABLE IF NOT EXISTS tx_times (sig TEXT PRIMARY KEY, block_time INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS pass_campaigns (campaign TEXT PRIMARY KEY, label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS passes_issued (campaign TEXT NOT NULL, x_hash TEXT NOT NULL, wallet TEXT NOT NULL, expiry INTEGER NOT NULL, issued_at INTEGER NOT NULL, PRIMARY KEY (campaign, x_hash));

-- The first hour dev drops (src/drops.mjs). A plan is fixed when started; each drop row records what was listed, sold or skipped
CREATE TABLE IF NOT EXISTS drop_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, token_program TEXT NOT NULL, decimals INTEGER NOT NULL, supply TEXT NOT NULL, total TEXT NOT NULL, seller TEXT NOT NULL,
  first_at INTEGER NOT NULL, every_ms INTEGER NOT NULL, length_s INTEGER NOT NULL, author TEXT, preview INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drops (plan INTEGER NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, price_num TEXT, price_den TEXT, price_source TEXT, min_bid TEXT,
  listing TEXT, list_sig TEXT, listed_at INTEGER, end_time INTEGER, cancel_sig TEXT, sale_sig TEXT, sold_lamports TEXT, winner TEXT,
  post_state TEXT, post_id TEXT, post_url TEXT, post_text TEXT, post_at INTEGER, post_err TEXT, post_media INTEGER, post_tries INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (plan, idx));
CREATE INDEX IF NOT EXISTS drops_listing ON drops(listing);

CREATE TABLE IF NOT EXISTS listings (pubkey TEXT PRIMARY KEY, seller TEXT, token_account TEXT, mint TEXT, token_program TEXT, amount TEXT, price TEXT, end_time INTEGER, top_bidder TEXT, top_bid TEXT, pass_signer TEXT, campaign TEXT,
  mode TEXT, state TEXT, decimals INTEGER, rent_payer TEXT, accept_window_secs INTEGER, hard_end_time INTEGER, delegate_set INTEGER, keeper_next_at INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, outcome TEXT, fillable INTEGER, cpi_guard INTEGER, token_checked_at INTEGER, chain_read_at INTEGER, first_seen_at INTEGER);
CREATE INDEX IF NOT EXISTS listings_live ON listings(closed, end_time);
CREATE INDEX IF NOT EXISTS listings_mint ON listings(mint);
CREATE INDEX IF NOT EXISTS listings_seller ON listings(seller);
CREATE TABLE IF NOT EXISTS sales (sig TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0, listing TEXT NOT NULL, kind TEXT NOT NULL, winner TEXT, seller TEXT, amount TEXT, price TEXT, mint TEXT, decimals INTEGER, at INTEGER, PRIMARY KEY (sig, idx));
CREATE INDEX IF NOT EXISTS sales_listing ON sales(listing);
CREATE TABLE IF NOT EXISTS events_seen (sig TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL, listing TEXT, data TEXT, at INTEGER, PRIMARY KEY (sig, idx));
CREATE INDEX IF NOT EXISTS events_listing ON events_seen(listing);
CREATE TABLE IF NOT EXISTS credits (listing TEXT NOT NULL, owner TEXT NOT NULL, lamports TEXT NOT NULL DEFAULT '0', checked_at INTEGER, PRIMARY KEY (listing, owner));
`

export const CACHE_TABLES = ['listings', 'sales', 'events_seen', 'credits']

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
  raw.exec(SCHEMA)
  // Columns added after the first deploy. A volume made earlier gets them in place, its rows kept.
  if (!raw.prepare('PRAGMA table_info(spend)').all().some((c) => c.name === 'signin_micro')) raw.exec('ALTER TABLE spend ADD COLUMN signin_micro INTEGER NOT NULL DEFAULT 0')
  const db = {
    raw,
    run: (sql, ...a) => raw.prepare(sql).run(...a),
    get: (sql, ...a) => raw.prepare(sql).get(...a),
    all: (sql, ...a) => raw.prepare(sql).all(...a),
    meta: (k) => raw.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null,
    setMeta: (k, v) => { if (v === null) raw.prepare('DELETE FROM meta WHERE k=?').run(k); else raw.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)) },
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE')
      try { const r = fn(); raw.exec('COMMIT'); return r } catch (e) { raw.exec('ROLLBACK'); throw e }
    },
    close: () => raw.close(),
  }
  return db
}
