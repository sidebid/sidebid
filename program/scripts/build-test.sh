#!/bin/sh
# Test builds only: the same program with the public test listing key
# (feature test-listing-key), into target/test/. Never deploy these.
#   target/test/sidebid.so                 normal build, used by npm test
#   target/test/withdraw-only/sidebid.so   shutdown build, used by 08-shutdown
# The normal one is also what server/test/harness.mjs and web/test/e2e.mjs load.
set -eu
cd "$(dirname "$0")/.."
cargo-build-sbf --manifest-path programs/sidebid/Cargo.toml --tools-version v1.57 --arch v3 \
  --features test-listing-key --sbf-out-dir target/test
cargo-build-sbf --manifest-path programs/sidebid/Cargo.toml --tools-version v1.57 --arch v3 \
  --features test-listing-key,withdraw-only --sbf-out-dir target/test/withdraw-only
# cargo-build-sbf writes random program keypairs next to the .so; they are not used.
rm -f target/test/sidebid-keypair.json target/test/withdraw-only/sidebid-keypair.json
ls -l target/test/sidebid.so target/test/withdraw-only/sidebid.so
