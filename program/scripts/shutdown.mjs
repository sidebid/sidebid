// Withdraw-only shutdown tooling. Read "Withdraw-only shutdown" in README.md first.
//
//   node scripts/shutdown.mjs check <rpc-url>
//   node scripts/shutdown.mjs drain <rpc-url> <fee-payer.json>
//
// The fee payer only pays fees: every instruction sent here is permissionless and
// every lamport it moves goes to the address the program pins (top bidder, rent
// payer, credit owner). tests/08-shutdown.test.mjs runs the same functions on LiteSVM.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { IX, PROGRAM_ID, decodeListing, creditPda, vaultPda } from "../tests/helpers.mjs";

const disc = (kind, name) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
export const LISTING_DISC = disc("account", "Listing");
export const CLAIM_DISC = disc("account", "Claim");
const LISTED = disc("event", "Listed");
const BID_PLACED = disc("event", "BidPlaced");
const CREDIT_PARKED = disc("event", "CreditParked");
export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const programDataAddress = (programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER)[0];

/** The instructions that empty one listing to its owners, for one transaction:
 *  refund (bid and vault to the top bidder) when there is a bid, then close
 *  (vault leftovers and rent to whoever paid the rent). Withdraw-only build only. */
export function drainListing(key, data) {
  const l = decodeListing(data);
  const ixs = [];
  if (l.topBid > 0n) ixs.push(IX.refund({ listing: key, tokenAccount: l.tokenAccount, topBidder: l.topBidder }));
  ixs.push(IX.close({ listing: key, tokenAccount: l.tokenAccount, seller: l.rentPayer }));
  return ixs;
}

/** Listings, and every wallet that could own a credit on each, from this
 *  program's events in transaction logs. A credit can only be parked for a seller
 *  (Listed), a bidder (BidPlaced) or the rent payer, which is the seller or the
 *  listing server. Rent credits emit no CreditParked event, so `owners` is the
 *  list to check, not `parked`. */
export function parseEvents(logs) {
  const listings = [];
  const owners = [];
  const parked = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b = Buffer.from(line.slice("Program data: ".length), "base64");
    if (b.length < 72) continue;
    const d = b.subarray(0, 8);
    const entry = { listing: new PublicKey(b.subarray(8, 40)), owner: new PublicKey(b.subarray(40, 72)) };
    if (d.equals(LISTED)) { listings.push(entry.listing); owners.push(entry); }
    else if (d.equals(BID_PLACED)) owners.push(entry);
    else if (d.equals(CREDIT_PARKED)) { parked.push(entry); owners.push(entry); }
  }
  return { listings, owners, parked };
}

/** Every credit address that could hold SOL: each (listing, owner) seen in the
 *  events, plus each listing paired with `extraOwners` (the listing server key). */
export function creditCandidates({ listings, owners }, extraOwners = []) {
  const out = new Map();
  const add = (listing, owner) => {
    const credit = creditPda(listing, owner);
    out.set(credit.toBase58(), { listing, owner, credit });
  };
  for (const o of owners) add(o.listing, o.owner);
  for (const l of listings) for (const x of extraOwners) add(l, x);
  return [...out.values()];
}

/** Every listing and credit the program has ever named, from its full history.
 *  Refuses (throws) when any transaction can't be read in full: a missing or
 *  truncated one could hide the only event naming a funded credit. */
export async function scanHistory(conn, extraOwners) {
  const listings = new Map();
  const owners = [];
  let before;
  let txs = 0;
  for (;;) {
    const page = await conn.getSignaturesForAddress(PROGRAM_ID, { before, limit: 1000 }, "confirmed");
    if (!page.length) break;
    for (const s of page) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const logs = tx?.meta?.logMessages;
      if (!logs) throw new Error(`no transaction data for ${s.signature}: use an RPC with full history`);
      if (logs.some((l) => l.includes("Log truncated"))) {
        throw new Error(`truncated logs in ${s.signature}: find its events by hand before trusting a check`);
      }
      const ev = parseEvents(logs);
      for (const k of ev.listings) listings.set(k.toBase58(), k);
      owners.push(...ev.owners);
      txs++;
    }
    before = page.at(-1).signature;
  }
  const all = [...listings.values()];
  return { listings: all, credits: creditCandidates({ listings: all, owners }, extraOwners), txs };
}

export async function programAccounts(conn) {
  const all = await conn.getProgramAccounts(PROGRAM_ID, { commitment: "confirmed" });
  const of = (d) => all.filter((a) => Buffer.from(a.account.data).subarray(0, 8).equals(d));
  return {
    listings: of(LISTING_DISC),
    claims: of(CLAIM_DISC),
    other: all.filter((a) => {
      const d = Buffer.from(a.account.data).subarray(0, 8);
      return !d.equals(LISTING_DISC) && !d.equals(CLAIM_DISC);
    }),
  };
}

/** True only when the deployed code is the withdraw-only build: push_credit exists
 *  there and answers NothingToClaim for an empty credit; the normal build has no
 *  such instruction (InstructionFallbackNotFound). */
async function isWithdrawOnly(conn, payer) {
  const ix = IX.pushCredit({ owner: Keypair.generate().publicKey, listing: Keypair.generate().publicKey });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  const logs = (sim.value.logs ?? []).join("\n");
  return logs.includes("NothingToClaim");
}

/** Whether it is safe to close. A vault blocks only while its listing is open:
 *  SOL sent to the vault of a closed listing can never be moved by any build,
 *  so it is reported as stranded and does not block. */
export async function check(conn, extraOwners, log = console.log) {
  if (!extraOwners?.length) throw new Error("the listing server key is required: its rent credits emit no event");
  const accts = await programAccounts(conn);
  const open = new Set(accts.listings.map((a) => a.pubkey.toBase58()));
  const hist = await scanHistory(conn, extraOwners);
  const vaults = [];
  for (const l of hist.listings) {
    const v = vaultPda(l);
    const lamports = await conn.getBalance(v, "confirmed");
    if (lamports > 0) vaults.push({ listing: l, vault: v, lamports, open: open.has(l.toBase58()) });
  }
  const credits = [];
  for (const c of hist.credits) {
    const lamports = await conn.getBalance(c.credit, "confirmed");
    if (lamports > 0) credits.push({ ...c, lamports });
  }
  const pd = await conn.getAccountInfo(programDataAddress(), "confirmed");
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const blocking = vaults.filter((v) => v.open);
  const stranded = vaults.filter((v) => !v.open);
  log(`history: ${hist.txs} transactions, ${hist.listings.length} listings ever, ${hist.credits.length} credit addresses checked`);
  log(`listings still open: ${accts.listings.length}`);
  for (const a of accts.listings) log(`  ${a.pubkey.toBase58()}  ${a.account.lamports} lamports`);
  log(`vaults of open listings holding SOL: ${blocking.length}`);
  for (const v of blocking) log(`  vault ${v.vault.toBase58()} of ${v.listing.toBase58()}  ${v.lamports} lamports`);
  log(`vaults of closed listings holding SOL (sent after the close, unrecoverable, do not block): ${stranded.length}`);
  for (const v of stranded) log(`  vault ${v.vault.toBase58()} of ${v.listing.toBase58()}  ${v.lamports} lamports`);
  log(`credits holding SOL: ${credits.length}`);
  for (const c of credits) log(`  credit ${c.credit.toBase58()} owner ${c.owner.toBase58()}  ${c.lamports} lamports`);
  log(`claims (never closable, rent stays): ${accts.claims.length}, ${sum(accts.claims, (a) => a.account.lamports)} lamports`);
  if (accts.other.length) log(`UNKNOWN program accounts: ${accts.other.map((a) => a.pubkey.toBase58()).join(", ")}`);
  log(`program data: ${pd ? `${pd.lamports} lamports come back on close` : "gone (program closed)"}`);
  const clean = !accts.listings.length && !blocking.length && !credits.length && !accts.other.length;
  log(clean ? "CLEAN: safe to close the program" : "NOT CLEAN: do not close the program");
  return { clean, blocking, stranded, credits, listings: accts.listings };
}

async function drain(conn, payer, extraOwners) {
  if (!extraOwners?.length) throw new Error("the listing server key is required: its rent credits emit no event");
  if (!(await isWithdrawOnly(conn, payer.publicKey))) {
    throw new Error("the deployed program is not the withdraw-only build; upgrade first (README, Withdraw-only shutdown)");
  }
  const send = (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });
  const { listings } = await programAccounts(conn);
  let failed = 0;
  for (const a of listings) {
    try {
      console.log(`drained ${a.pubkey.toBase58()}  ${await send(drainListing(a.pubkey, a.account.data))}`);
    } catch (e) {
      failed++;
      console.log(`FAILED ${a.pubkey.toBase58()}: ${e.message}`);
    }
  }
  const hist = await scanHistory(conn, extraOwners);
  for (const c of hist.credits) {
    if ((await conn.getBalance(c.credit, "confirmed")) === 0) continue;
    try {
      console.log(`pushed credit ${c.credit.toBase58()} to ${c.owner.toBase58()}  ${await send([IX.pushCredit(c)])}`);
    } catch (e) {
      failed++;
      console.log(`credit ${c.credit.toBase58()} stays: its owner ${c.owner.toBase58()} must sign claim_credit (${e.message})`);
    }
  }
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--server");
  const server = at >= 0 ? [new PublicKey(args.splice(at, 2)[1])] : [];
  const [cmd, url, payerPath] = args;
  if (!url || !server.length || !["check", "drain"].includes(cmd) || (cmd === "drain" && !payerPath)) {
    console.log("usage: node scripts/shutdown.mjs check <rpc-url> --server <listing server pubkey>");
    console.log("       node scripts/shutdown.mjs drain <rpc-url> <fee-payer.json> --server <listing server pubkey>");
    process.exit(2);
  }
  const conn = new Connection(url, "confirmed");
  if (cmd === "drain") {
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath))));
    const failed = await drain(conn, payer, server);
    console.log(failed ? `${failed} items need attention` : "drain sent");
  }
  try {
    process.exit((await check(conn, server)).clean ? 0 : 1);
  } catch (e) {
    console.log(`NOT CLEAN: ${e.message}`);
    process.exit(1);
  }
}
