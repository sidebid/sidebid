// Claiming pump.fun creator fees.
//
// Creator fees do not arrive in the dev wallet on their own. They accrue in a
// vault owned by the pump.fun program and only move when the creator signs a
// CollectCreatorFee instruction. A sweeper that only watches the dev wallet's
// balance sees nothing all night while the vault fills up behind it.
//
// Everything below was read off a real, successful claim on mainnet rather than
// from a specification, then checked by re-deriving it:
//
//   program            6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//   discriminator      1416567bc61cdb84
//   accounts           [0] creator          signer, writable
//                      [1] creator vault    writable   PDA ["creator-vault", creator]
//                      [2] system program   readonly
//                      [3] event authority  readonly   PDA ["__event_authority"]
//                      [4] pump program     readonly
//
// Both PDAs re-derive to the addresses the real transaction used, so this is
// the same instruction rather than a guess that happens to resemble one.

import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { sol, lamports } from "./keys.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const COLLECT_CREATOR_FEE = Buffer.from("1416567bc61cdb84", "hex");

export function creatorVault(creator) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), new PublicKey(creator).toBuffer()], PUMP_PROGRAM)[0];
}
export function eventAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM)[0];
}

export class Claimer {
  constructor({ conn, creatorKeypair, minClaimSol = 0.002, log = console.log }) {
    this.conn = conn;
    this.kp = creatorKeypair;
    this.min = lamports(minClaimSol);
    this.log = log;
    this.vault = creatorVault(this.kp.publicKey);
    this.claims = [];
    this.claimedSol = 0;
    this.vaultSol = 0;
    this.busy = false;
    this.lastError = null;
  }

  status() {
    return {
      vault: this.vault.toBase58(),
      vaultSol: +this.vaultSol.toFixed(6),
      claims: this.claims.length,
      claimedSol: +this.claimedSol.toFixed(6),
      lastError: this.lastError,
      recent: this.claims.slice(-5),
    };
  }

  // What is sitting in the vault waiting to be claimed. Read on every tick so
  // the watcher can show fees accruing even before the first claim.
  async pending() {
    try {
      const b = await this.conn.getBalance(this.vault, "confirmed");
      this.vaultSol = sol(b);
      return b;
    } catch (e) { this.lastError = e.message.slice(0, 120); return 0; }
  }

  // One claim. Returns the lamports moved, or 0 with a reason.
  // Never runs twice at once: a claim can take seconds to confirm and the tick
  // that follows would otherwise read the same vault balance and claim again.
  async claim() {
    if (this.busy) return { moved: 0, why: "a claim is already in flight" };
    const bal = await this.pending();
    // The vault is rent-exempt; only what is above that is really claimable.
    if (bal < this.min) return { moved: 0, why: "vault below MIN_CLAIM_SOL" };

    this.busy = true;
    let tx = null;
    try {
      const ix = new TransactionInstruction({
        programId: PUMP_PROGRAM,
        data: COLLECT_CREATOR_FEE,
        keys: [
          { pubkey: this.kp.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: this.vault,        isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: eventAuthority(),  isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM,      isSigner: false, isWritable: false },
        ],
      });
      // A launch is exactly when the network is busy and exactly when a dropped
      // claim costs the most, so pay for priority. It is fractions of a cent.
      tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
        .add(ix);

      const before = await this.conn.getBalance(this.kp.publicKey, "confirmed");
      const sig = await sendAndConfirmTransaction(this.conn, tx, [this.kp], { commitment: "confirmed" });
      const after = await this.conn.getBalance(this.kp.publicKey, "confirmed");
      const moved = Math.max(0, after - before);

      this.claimedSol += sol(moved);
      const entry = { at: new Date().toISOString(), sol: +sol(moved).toFixed(6), sig,
                      link: "https://solscan.io/tx/" + sig };
      this.claims.push(entry);
      if (this.claims.length > 40) this.claims.shift();
      this.lastError = null;
      this.log("[claim] " + entry.sol + " SOL out of the vault  " + sig.slice(0, 12));
      return { moved, sig, link: entry.link };
    } catch (e) {
      this.lastError = e.message.slice(0, 160);
      this.log("[claim] failed: " + this.lastError);
      // The signature exists once signed, even if confirmation timed out: the pot
      // resolves it from the chain later, so a claim that landed is still credited.
      const sig = tx && tx.signature ? bs58.encode(tx.signature) : null;
      return { moved: 0, why: this.lastError, sig };
    } finally {
      this.busy = false;
    }
  }
}
