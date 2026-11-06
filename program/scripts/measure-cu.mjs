// Prints compute units per instruction, the highest seen over several runs,
// because PDA bumps vary. Usage: node scripts/measure-cu.mjs
import { Env, IX, MIN, UNIT, WINDOW, SERVER, T22, TOKEN, setup, setupAccept, passIx, xHash, makeExecutable, Keypair } from "../tests/helpers.mjs";
import { spl } from "../tests/helpers.mjs";

const RUNS = 15;
const max = {};
const note = (name, r) => {
  if (!r.ok) throw new Error(`${name}: ${r.err}`);
  max[name] = Math.max(max[name] ?? 0, r.cu);
};
for (let i = 0; i < RUNS; i++) {
  for (const [tag, program] of [["SPL", TOKEN], ["T22", T22]]) {
    const n = (s) => `${s} [${tag}]`;
    const e = new Env();
    const seller = e.wallet();
    const mint = e.mint({ program });
    const tokenAccount = e.ata(seller.publicKey, mint, 1000n, program);
    note(n("create_listing"), e.send(IX.create({ seller: seller.publicKey, tokenAccount, mint, tokenProgram: program, amount: 1000n, price: MIN, duration: 300n }), [seller]));
    const c = setup({ program, env: e });
    const [a, b] = [e.wallet(), e.wallet()];
    note(n("place_bid first"), e.send(IX.bid({ bidder: a.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 2n * MIN, expected: c.amount }), [a]));
    note(n("place_bid outbid"), e.send(IX.bid({ bidder: b.publicKey, listing: c.listing, tokenAccount: c.tokenAccount, mint: c.mint, amount: 3n * MIN, expected: c.amount, prev: a.publicKey }), [b]));
    const wt = e.ata(b.publicKey, c.mint, 0n, program);
    const r2 = setup({ program, env: e });
    const x = e.wallet();
    r2.bid(x, 2n * MIN);
    e.warp(300);
    note(n("settle"), e.send(c.settleIx(b.publicKey, wt)));
    e.ok(spl.createRevokeInstruction(r2.tokenAccount, r2.seller.publicKey, [], program), [r2.seller]);
    note(n("refund"), e.send(r2.refundIx(x.publicKey)));
    note(n("close_listing"), e.send(r2.closeIx()));
    const f = setup({ program, env: e, mode: 1, duration: 0n });
    const y = e.wallet();
    note(n("buy_fixed"), e.send(f.buyIx(y, e.ata(y.publicKey, f.mint, 0n, program)), [y]));
    const key = Keypair.generate();
    const g = setup({ program, env: e, mode: 1, duration: 0n, pass: { signer: key.publicKey } });
    const z = e.wallet();
    const hash = xHash("u" + i);
    const expiry = e.now() + 100n;
    const zt = e.ata(z.publicKey, g.mint, 0n, program);
    note(n("buy_fixed_with_pass"), e.send([passIx(key, g.listing, z.publicKey, hash, expiry),
      IX.buyPass({ buyer: z.publicKey, listing: g.listing, seller: g.seller.publicKey, tokenAccount: g.tokenAccount, mint: g.mint, tokenProgram: program,
        buyerToken: zt, price: g.price, amount: g.amount, hash, expiry, signer: key.publicKey, campaign: g.listing })], [z]));
    const h = setup({ program, env: e });
    const v = e.wallet();
    h.bid(v, 2n * MIN);
    note(n("cancel with bid"), e.send(h.cancelIx(v.publicKey), [h.seller]));
    // Slow path: credit parking, where a PDA search runs.
    const p = setup({ program, env: e });
    const u = e.wallet(5n * MIN);
    p.bid(u, 2n * MIN);
    makeExecutable(e, u.publicKey);
    const q = e.wallet();
    note(n("place_bid parking a credit"), e.send(IX.bid({ bidder: q.publicKey, listing: p.listing, tokenAccount: p.tokenAccount, mint: p.mint, amount: 3n * MIN, expected: p.amount, prev: u.publicKey }), [q]));
    note(n("claim_credit"), e.send(IX.claimCredit({ owner: u.publicKey, listing: p.listing, destination: e.wallet().publicKey }), [u]));
    const ac = setupAccept({ program, env: e });
    const av = e.wallet();
    ac.bid(av, 2n * MIN);
    e.warp(300);
    note(n("accept"), e.send(ac.acceptIx(av.publicKey, 2n * MIN), [ac.seller]));
    const cr = setupAccept({ program, env: e });
    const id = Keypair.generate().publicKey.toBuffer();
    note(n("create_accept_listing"), e.send(IX.createAccept({ server: SERVER.publicKey, id, seller: cr.seller.publicKey, tokenAccount: cr.tokenAccount, mint: cr.mint, tokenProgram: program, amount: 1n }), [SERVER]));
  }
}
for (const [k, v] of Object.entries(max).sort()) console.log(`${String(v).padStart(7)}  ${k}`);
