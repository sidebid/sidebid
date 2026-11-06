// The listing server key used only by the tests. It is derived from a public
// phrase, so anyone can rebuild it and it must never sign anything real.
// Public key: 9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91
// Build the program for the tests with:
//   SIDEBID_LISTING_KEY=9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91
import { createHash } from "node:crypto";

export const TEST_LISTING_PUBKEY = "9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91";

/** 32 byte ed25519 seed. Use with Keypair.fromSeed. */
export const testListingSeed = () =>
  createHash("sha256").update("sidebid listing server key: TEST ONLY, public, never deploy").digest();
