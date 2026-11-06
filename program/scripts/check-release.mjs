// Release guard: fails if a .so meant for deploy carries the public test listing
// key, or lacks the real listing key or the program id from target/idl.
//   node scripts/check-release.mjs [path to sidebid.so ...]   (default target/deploy/sidebid.so)
// Also exported for tests/00-release.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

export const TEST_KEY = new PublicKey("9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91");
export const LISTING_KEY = new PublicKey("5uoQXnzrrrsrS5VoFKqnwVtBukrhbA4NuXNaJAPz5yTm");
export const PROGRAM_ID = new PublicKey("5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp");

/** Returns a list of problems; empty means the binary is fit to deploy. */
export function releaseProblems(so) {
  const problems = [];
  if (so.indexOf(TEST_KEY.toBuffer()) >= 0) problems.push("contains the public TEST listing key (built with feature test-listing-key)");
  if (so.indexOf(LISTING_KEY.toBuffer()) < 0) problems.push(`does not contain the listing key ${LISTING_KEY.toBase58()}`);
  if (so.indexOf(PROGRAM_ID.toBuffer()) < 0) problems.push(`does not contain the program id ${PROGRAM_ID.toBase58()}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) paths.push(fileURLToPath(new URL("../target/deploy/sidebid.so", import.meta.url)));
  let bad = 0;
  for (const p of paths) {
    const problems = releaseProblems(readFileSync(p));
    if (problems.length) { bad++; for (const m of problems) console.log(`REFUSED ${p}: ${m}`); }
    else console.log(`ok ${p}: real listing key and program id, no test key`);
  }
  process.exit(bad ? 1 : 0);
}
