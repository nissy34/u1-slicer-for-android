#!/usr/bin/env bash
# Restore prebuilt wasm deps + engine build tree into a checkout of
# nissy34/u1-slicer-for-android (branch claude/wasm-spike or descendants).
#
#   bash <(git -C /home/user/u1-slicer-for-android show origin/wasm-prebuilt-cache:restore.sh)
#
# Requirements for the engine build tree to be reused as-is (it records
# absolute paths): repo at /home/user/u1-slicer-for-android, emsdk 6.0.12 at
# /home/user/wasm/emsdk, orcaslicer submodule at the pinned SHA.
set -euo pipefail
REPO=${REPO:-/home/user/u1-slicer-for-android}
cd "$REPO"
git fetch -q origin wasm-prebuilt-cache
mkdir -p wasm/build
for f in deps.tgz engine.tgz; do git show "origin/wasm-prebuilt-cache:$f" | tar -xzf - -C wasm/build; done
# Fresh checkouts give every source a new mtime; make the restored outputs
# newer so ninja reuses them instead of recompiling everything.
find wasm/build/engine -type f -exec touch {} +
echo "restored: wasm/build/deps (no OCCT) and wasm/build/engine"
echo "next: source /home/user/wasm/emsdk/emsdk_env.sh && ninja -C wasm/build/engine -n | tail -1   # expect only a few steps"
