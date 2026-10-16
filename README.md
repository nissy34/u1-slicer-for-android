# wasm-prebuilt-cache

Not code. Build cache for the WebAssembly slicer work on `claude/wasm-spike`
(see `wasm/README.md` there), so new sessions skip the ~40 min dependency build
and ~15 min engine compile.

- `deps.tgz` — `wasm/build/deps` from `wasm/scripts/build-deps.sh` (Emscripten
  6.0.12, -pthread -fwasm-exceptions), without OCCT.
- `engine.tgz` — `wasm/build/engine` (Release build tree incl. object files),
  built at commit of `claude/wasm-spike` from 2026-10-16.
- `restore.sh` — unpacks both and refreshes mtimes.

Safe to delete this branch at any time: `git push origin --delete wasm-prebuilt-cache`.
