#!/bin/sh
# One test environment for `npm test` and CI, so they cannot drift: no test reaches live GitHub,
# the live BB or a live service. Dropped tokens and an empty GH_CONFIG_DIR keep a real gh
# unauthenticated; the stand-ins in test/no-live-github and test/no-live-bb come first on PATH
# and refuse; test/no-live-bb.mjs keeps a test's bash from reading a ~/.bashrc that puts the
# real tools back in front; FM_NO_LIVE_NETWORK=1 keeps the live checks offline.
# Usage: sh scripts/run-tests.sh <test file>...
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd -- "$root" || exit 1
exec env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u BB_CLI \
  FM_NO_LIVE_NETWORK=1 GIT_ALLOW_PROTOCOL=file GH_CONFIG_DIR="$root/test/no-live-github/config" \
  PATH="$root/test/no-live-github:$root/test/no-live-bb:$PATH" \
  node --test --experimental-strip-types --import ./test/temp-cleanup.mjs --import ./test/no-live-bb.mjs \
  --test-global-setup=./test/temp-guard.mjs "$@"
