#!/bin/sh
# Builds the withdraw-only shutdown program into target/withdraw-only/sidebid.so,
# with the real listing key compiled in (lib.rs). Use the same program id and
# platform tools (v1.57, as anchor build uses) as the live normal build.
# See README, "Withdraw-only shutdown". The test key variant is built by
# scripts/build-test.sh.
set -eu
cd "$(dirname "$0")/.."
cargo-build-sbf --manifest-path programs/sidebid/Cargo.toml --tools-version v1.57 --arch v3 \
  --features withdraw-only --sbf-out-dir target/withdraw-only
# cargo-build-sbf writes a random program keypair next to the .so; it is not ours.
rm -f target/withdraw-only/sidebid-keypair.json
ls -l target/withdraw-only/sidebid.so
node scripts/check-release.mjs target/withdraw-only/sidebid.so
