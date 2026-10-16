#!/usr/bin/env bash
# Restore prebuilt wasm deps + engine build tree into a checkout of
# nissy34/u1-slicer-for-android (branch claude/wasm-spike or descendants).
#
#   cd /home/user/u1-slicer-for-android && git fetch origin wasm-prebuilt-cache && bash <(git show FETCH_HEAD:restore.sh)
#
# Requirements for the engine build tree to be reused as-is (it records
# absolute paths): repo at /home/user/u1-slicer-for-android, emsdk 6.0.12 at
# /home/user/wasm/emsdk, orcaslicer submodule at the pinned SHA.
set -euo pipefail
REPO=${REPO:-/home/user/u1-slicer-for-android}
cd "$REPO"
git fetch -q origin wasm-prebuilt-cache
REV=$(git rev-parse FETCH_HEAD)   # works in single-branch clones too
mkdir -p wasm/build
for f in deps.tgz engine.tgz; do git show "$REV:$f" | tar -xzf - -C wasm/build; done
# Fresh checkouts (and a fresh emsdk install) give every input a new mtime.
# Make the INPUTS old rather than touching the outputs: ninja treats an output
# newer than its recorded deps as stale. Inputs = repo + submodule sources, the
# deps, and the Emscripten/clang system headers recorded in the depfiles.
OLD=2000-01-01
git ls-files -z | xargs -0 touch -h -d "$OLD" 2>/dev/null || true
(cd app/src/main/cpp/orcaslicer && git ls-files -z | xargs -0 touch -h -d "$OLD") 2>/dev/null || true
EMSDK_DIR=${EMSDK:-/home/user/wasm/emsdk}
for d in "$EMSDK_DIR/upstream/emscripten/cache/sysroot" "$EMSDK_DIR/upstream/lib/clang" "$EMSDK_DIR/upstream/emscripten/system"; do
  if [ -d "$d" ]; then find "$d" -exec touch -h -d "$OLD" {} + 2>/dev/null || true; fi
done
find wasm/build/deps -exec touch -h -d "$OLD" {} +
echo "restored: wasm/build/deps (no OCCT) and wasm/build/engine"
echo "next: source /home/user/wasm/emsdk/emsdk_env.sh && ninja -C wasm/build/engine -n | tail -1   # expect only a few steps"
