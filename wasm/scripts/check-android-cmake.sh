#!/usr/bin/env bash
# Guard for the shared app/src/main/cpp/CMakeLists.txt: configure it in Android
# mode (no NDK needed — configure only) for a base ref and for the working tree,
# and diff the generated build graph (sources, defines, include dirs, flags,
# link lines). Standalone/wasm-only branches must not change the Android graph.
#
#   wasm/scripts/check-android-cmake.sh [base-ref]   # default origin/main
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${1:-origin/main}"
TMP="$(mktemp -d)"
trap 'git -C "$REPO" worktree remove --force "$TMP/base" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

git -C "$REPO" worktree add -q "$TMP/base" "$BASE"
rmdir "$TMP/base/app/src/main/cpp/orcaslicer" 2>/dev/null || true
ln -s "$REPO/app/src/main/cpp/orcaslicer" "$TMP/base/app/src/main/cpp/orcaslicer"

graph() { # srcroot out
    local b="$TMP/cfg-$2"
    cmake -S "$1/app/src/main/cpp" -B "$b" -G Ninja -DSLICER_BACKEND=orca -DANDROID_ABI=arm64-v8a \
        -DEXTERN_DIR="$REPO/app/src/main/cpp/extern" -DCMAKE_BUILD_TYPE=Release -Dlog-lib=log >/dev/null
    # Normalise every absolute prefix the same way on both sides.
    sed "s#$b#BUILD#g; s#$TMP/base#ROOT#g; s#$REPO#ROOT#g" "$b/build.ninja" \
        | grep -E "^build |DEFINES|INCLUDES|FLAGS|LINK_LIBRARIES|LINK_FLAGS" > "$TMP/$2.txt"
}
graph "$TMP/base" base
graph "$REPO" head
n=$(grep -c '^build .*\.o:' "$TMP/head.txt")
if diff -q "$TMP/base.txt" "$TMP/head.txt" >/dev/null; then
    echo "OK: Android build graph identical to $BASE ($n objects)"
else
    diff "$TMP/base.txt" "$TMP/head.txt" | head -40 || true
    echo "DIFFERS from $BASE"; exit 1
fi
