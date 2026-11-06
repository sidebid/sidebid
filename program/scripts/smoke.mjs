// End to end run against a real validator: node scripts/smoke.mjs <rpc-url> <payer.json> [--local]
// --local adds the real "bidder wallet turned into a program" case, which costs
// more SOL than a devnet faucet gives.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Connection, Transaction, Keypair, SystemProgram, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import nacl from "tweetnacl";
import { IX, listingPda, acceptPda, creditPda, vaultPda, passIx, passMessage, xHash, SERVER, PROGRAM_ID, SO, TOKEN } from "../tests/helpers.mjs";

const [url, payerPath, flag] = process.argv.slice(2);
const conn = new Connection(url, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const cus = {};
async function send(ixs, signers = []) {
  const tx = new Transaction().add(...[].concat(ixs));
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
  return sig;
}
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
async function refused(ixs, signers, reason) {
  try { await send(ixs, signers); } catch (e) {
    const text = `${e.message} ${(e.logs ?? []).join(" ")}`;
    if (reason && !text.includes(reason)) throw new Error(`refused for the wrong reason: ${text}`);
    return;
  }
  throw new Error("expected refusal, it landed");
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${a} != ${b}`); };
const bal = async (k) => BigInt(await conn.getBalance(k));
async function fund(lamports) {
  const k = Keypair.generate();
  await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: Number(lamports) }));
  return k;
}
const untilChainTime = async (t) => { for (;;) { const s = await conn.getSlot(); const n = await conn.getBlockTime(s); if (BigInt(n) >= t) return; await sleep(1000); } };

const mintK = Keypair.generate();
const rent = await conn.getMinimumBalanceForRentExemption(spl.MINT_SIZE);
await send([
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintK.publicKey, lamports: rent, space: spl.MINT_SIZE, programId: TOKEN }),
  spl.createInitializeMint2Instruction(mintK.publicKey, 6, payer.publicKey, null, TOKEN),
], [mintK]);
const mint = mintK.publicKey;
const tokenFor = async (owner, amount = 0n) => {
  const k = Keypair.generate();
  const r = await conn.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE);
  const ixs = [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: r, space: spl.ACCOUNT_SIZE, programId: TOKEN }),
    spl.createInitializeAccount3Instruction(k.publicKey, mint, owner, TOKEN),
  ];
  if (amount) ixs.push(spl.createMintToInstruction(mint, k.publicKey, payer.publicKey, amount));
  await send(ixs, [k]);
  return k.publicKey;
};
const MIN = 2_000_000n;
// Listings need an associated token account, so each one gets a fresh seller.
const lister = async (amount) => {
  const seller = await fund(30_000_000n);
  const t = spl.getAssociatedTokenAddressSync(mint, seller.publicKey);
  await send([
    spl.createAssociatedTokenAccountInstruction(payer.publicKey, t, seller.publicKey, mint),
    spl.createMintToInstruction(mint, t, payer.publicKey, amount),
  ]);
  return { seller, t };
};

await check("bidding: bid, outbid refund, settle after end", async () => {
  const { seller, t } = await lister(1000n);
  await send(IX.create({ seller: seller.publicKey, tokenAccount: t, mint, amount: 1000n, price: MIN, duration: 12n }), [seller]);
  const listing = listingPda(t);
  const [a, b] = [await fund(5n * MIN), await fund(5n * MIN)];
  await send(IX.bid({ bidder: a.publicKey, listing, tokenAccount: t, mint, amount: MIN, expected: 1000n }), [a]);
  const before = await bal(a.publicKey);
  await send(IX.bid({ bidder: b.publicKey, listing, tokenAccount: t, mint, amount: 2n * MIN, expected: 1000n, prev: a.publicKey }), [b]);
  eq(await bal(a.publicKey), before + MIN, "outbid refund");
  const wt = await tokenFor(b.publicKey);
  const data = (await conn.getAccountInfo(listing)).data;
  await untilChainTime(data.readBigInt64LE(152));
  await sleep(1500);
  const s0 = await bal(seller.publicKey);
  await send(IX.settle({ listing, seller: seller.publicKey, tokenAccount: t, mint, winnerToken: wt }));
  eq((await spl.getAccount(conn, wt)).amount, 1000n, "winner tokens");
  if ((await bal(seller.publicKey)) <= s0 + 2n * MIN - 1n) throw new Error("seller not paid");
  eq(await conn.getAccountInfo(listing), null, "closed");
});

await check("fixed buy", async () => {
  const { seller, t } = await lister(10n);
  await send(IX.create({ seller: seller.publicKey, tokenAccount: t, mint, mode: 1, amount: 10n, price: MIN, duration: 0n }), [seller]);
  const b = await fund(5n * MIN);
  const bt = await tokenFor(b.publicKey);
  await send(IX.buy({ buyer: b.publicKey, listing: listingPda(t), seller: seller.publicKey, tokenAccount: t, mint, buyerToken: bt, price: MIN, amount: 10n }), [b]);
  eq((await spl.getAccount(conn, bt)).amount, 10n, "buyer tokens");
});

await check("pass: valid buy, second claim refused, forged refused, on the real ed25519 program", async () => {
  const key = Keypair.generate();
  const campaign = Keypair.generate().publicKey;
  const mk = async () => {
    const { seller, t } = await lister(10n);
    await send(IX.create({ seller: seller.publicKey, tokenAccount: t, mint, mode: 1, amount: 10n, price: MIN, duration: 0n, pass: { signer: key.publicKey, campaign } }), [seller]);
    return { seller, t };
  };
  const [l1, l2] = [await mk(), await mk()];
  const b = await fund(10n * MIN);
  const bt = await tokenFor(b.publicKey);
  const hash = xHash("smoke");
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
  const buy = ({ seller, t }, h = hash) => IX.buyPass({ buyer: b.publicKey, listing: listingPda(t), seller: seller.publicKey, tokenAccount: t, mint, buyerToken: bt, price: MIN, amount: 10n, hash: h, expiry, signer: key.publicKey, campaign });
  const forged = passIx(key, campaign, b.publicKey, hash, expiry);
  forged.data[48] ^= 0xff;
  await refused([forged, buy(l1)], [b]);
  await refused([passIx(Keypair.generate(), campaign, b.publicKey, hash, expiry), buy(l1)], [b], "BadPass");
  await send([passIx(key, campaign, b.publicKey, hash, expiry), buy(l1)], [b]);
  await refused([passIx(key, campaign, b.publicKey, hash, expiry), buy(l2)], [b], "already in use");
});

await check("walk away: revoke, refund, Gone, close", async () => {
  const { seller, t } = await lister(10n);
  await send(IX.create({ seller: seller.publicKey, tokenAccount: t, mint, amount: 10n, price: MIN, duration: 60n }), [seller]);
  const listing = listingPda(t);
  const a = await fund(3n * MIN);
  await send(IX.bid({ bidder: a.publicKey, listing, tokenAccount: t, mint, amount: MIN, expected: 10n }), [a]);
  await send(spl.createRevokeInstruction(t, seller.publicKey), [seller]);
  const b0 = await bal(a.publicKey);
  await send(IX.refund({ listing, tokenAccount: t, topBidder: a.publicKey }));
  eq(await bal(a.publicKey), b0 + MIN, "refund");
  eq((await conn.getAccountInfo(listing)).data[265], 1, "Gone");
  await send(IX.close({ listing, tokenAccount: t, seller: seller.publicKey }));
});

await check("accept mode: non server refused; server creates; seller accepts", async () => {
  await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: SERVER.publicKey, lamports: 20_000_000 }));
  const { seller, t } = await lister(100n);
  const id = createHash("sha256").update(Keypair.generate().publicKey.toBuffer()).digest();
  const stranger = await fund(10_000_000n);
  await refused(IX.createAccept({ server: stranger.publicKey, id, seller: seller.publicKey, tokenAccount: t, mint, amount: 100n, minBid: MIN, duration: 12n, window: 600n }), [stranger], "NotListingServer");
  await send(IX.createAccept({ server: SERVER.publicKey, id, seller: seller.publicKey, tokenAccount: t, mint, amount: 100n, minBid: MIN, duration: 12n, window: 600n }), [SERVER]);
  const listing = acceptPda(id);
  const a = await fund(3n * MIN);
  await send(IX.bid({ bidder: a.publicKey, listing, tokenAccount: t, mint, amount: MIN, expected: 100n }), [a]);
  const wt = await tokenFor(a.publicKey);
  const ax = { seller: seller.publicKey, listing, tokenAccount: t, mint, winnerToken: wt, rentReceiver: SERVER.publicKey, amount: 100n, bid: MIN };
  await refused(IX.accept(ax), [seller], "AuctionNotEnded");
  await untilChainTime((await conn.getAccountInfo(listing)).data.readBigInt64LE(152));
  await sleep(1500);
  await refused(IX.refund({ listing, tokenAccount: t, topBidder: a.publicKey }), [], "RefundNotAllowed");
  await send(IX.accept(ax), [seller]);
  eq((await spl.getAccount(conn, wt)).amount, 100n, "winner tokens");
});

if (flag === "--local") {
  await check("real program deployed at a bidder's address: outbid still works, credit parks", async () => {
    const { seller, t } = await lister(10n);
    await send(IX.create({ seller: seller.publicKey, tokenAccount: t, mint, amount: 10n, price: MIN, duration: 600n }), [seller]);
    const listing = listingPda(t);
    const a = await fund(3n * MIN);
    await send(IX.bid({ bidder: a.publicKey, listing, tokenAccount: t, mint, amount: MIN, expected: 10n }), [a]);
    const dir = mkdtempSync(join(tmpdir(), "sidebid-"));
    const kp = join(dir, "bidder.json");
    writeFileSync(kp, JSON.stringify([...a.secretKey]));
    // The bidder's wallet account must be empty for the deploy to take over its address.
    await send(SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: payer.publicKey, lamports: Number(await bal(a.publicKey)) }), [a]);
    execFileSync("solana", ["program", "deploy", SO, "--program-id", kp, "--url", url, "--keypair", payerPath, "--use-rpc", "--commitment", "confirmed"], { stdio: "pipe" });
    const info = await conn.getAccountInfo(a.publicKey);
    eq(info.executable, true, "bidder address is now a program");
    const b = await fund(5n * MIN);
    await send(IX.bid({ bidder: b.publicKey, listing, tokenAccount: t, mint, amount: 2n * MIN, expected: 10n, prev: a.publicKey }), [b]);
    eq(await bal(creditPda(listing, a.publicKey)), MIN, "credit holds the refund");
    await send(IX.cancel({ seller: seller.publicKey, listing, tokenAccount: t, topBidder: b.publicKey }), [seller]);
    const dest = Keypair.generate().publicKey;
    await send(IX.claimCredit({ owner: a.publicKey, listing, destination: dest }), [a]);
    eq(await bal(dest), MIN, "claimed");
  });
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed (program ${PROGRAM_ID.toBase58()} on ${url})`);
process.exit(failed ? 1 : 0);
