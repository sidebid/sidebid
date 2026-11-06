// The release build (target/deploy/sidebid.so, and the withdraw-only one if built)
// must never contain the public test key. The test builds must contain it, which
// shows the byte search works.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { releaseProblems, TEST_KEY } from "../scripts/check-release.mjs";

const at = (p) => new URL(p, import.meta.url);
const RELEASE = at("../target/deploy/sidebid.so");
const RELEASE_WO = at("../target/withdraw-only/sidebid.so");

test("release .so: real listing key, mainnet program id, no test key", () => {
  assert.ok(existsSync(RELEASE), "target/deploy/sidebid.so missing: run anchor build (no features)");
  assert.deepEqual(releaseProblems(readFileSync(RELEASE)), []);
});

test("release withdraw-only .so: no test key", { skip: !existsSync(RELEASE_WO) && "not built" }, () => {
  assert.deepEqual(releaseProblems(readFileSync(RELEASE_WO)), []);
});

test("test builds carry the test key, so the search is real", () => {
  for (const p of ["../target/test/sidebid.so", "../target/test/withdraw-only/sidebid.so"]) {
    if (!existsSync(at(p))) continue;
    assert.ok(readFileSync(at(p)).indexOf(TEST_KEY.toBuffer()) >= 0, p);
  }
});
