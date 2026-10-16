# WebAssembly spike — the slicing engine in a browser

**Question:** can the app's native engine (Snapmaker Orca 2.2.4 `libslic3r` plus the
`sapil` core in `app/src/main/cpp`) run in a browser?

**Answer: yes.** The unmodified engine sources compile to an 8.8 MB wasm module
(2.8 MB gzipped). It slices STL and 3MF files, including painted multi-colour 3MFs, in
Node.js and in headless Chromium. Its G-code matches a native 64-bit build of the same
sources structurally (see [Parity](#parity)). It runs about 1.3–1.6× slower than native.

This is a spike, not a product. Only the engine is ported. None of the app's Kotlin
pipeline is (3MF sanitising and profile embedding, colour mapping, printer upload).

## Layout

| Path | What |
|---|---|
| `scripts/build-deps.sh` | Cross-compiles Boost 1.84, oneTBB 2022.0, GMP/MPFR, CGAL 5.6.2, NLopt, zlib, expat, libpng, libjpeg-turbo, Eigen, cereal and nlohmann-json with Emscripten into `build/deps/<dep>/{include,lib/wasm32}`, the same layout as the Android `extern/` bundle |
| `CMakeLists.txt` | Builds the engine through the **shared** `app/src/main/cpp/CMakeLists.txt` (same source list and defines as the `.so`). Emscripten produces `u1slicer.{js,wasm}`; a plain CMake configure produces the native reference CLI `u1slicer-host` |
| `src/wasm_api.cpp` | embind API: `loadModel`, `modelInfoJson`, `setModelInstances`, `slice(configJson, onProgress)`, `clearModel` |
| `src/slice_config_json.hpp` | JSON → `sapil::SliceConfig`. Keys are the C++ field names (`layer_height`, `fill_density`, `extruder_count`, …) |
| `src/host_cli.cpp` | Native CLI over the same engine, used as the parity reference |
| `patches/` | Engine fixes the wasm build needs, applied to build-tree copies. The submodule is never modified |
| `stubs/` | `openssl/md5.h` (on top of Boost's MD5) and `android/api-level.h` |
| `node/slice.mjs` | Node CLI: `node wasm/node/slice.mjs model.stl out.gcode [config.json] [--plate N]` |
| `web/` | Browser demo: `slicer-worker.js` (engine in a Worker), `index.html` (settings, stats, 2D layer viewer, G-code download), `serve.mjs` (dev server with COOP/COEP), `smoke-test.mjs` (Playwright end-to-end) |
| `scripts/compare-gcode.py` | Structural G-code diff: layers, per-feature extrusion, tool changes, temperatures, objects |

## Build and run

```bash
# one-time: Emscripten SDK (this spike used emsdk "latest" = emcc 6.0.12)
git clone https://github.com/emscripten-core/emsdk && emsdk/emsdk install latest && emsdk/emsdk activate latest
source emsdk/emsdk_env.sh
git submodule update --init app/src/main/cpp/orcaslicer   # pinned Orca fork

wasm/scripts/build-deps.sh                                  # ~40 min on 4 cores, once
emcmake cmake -S wasm -B wasm/build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build wasm/build/engine                             # ~15 min on 4 cores

node wasm/node/slice.mjs app/src/androidTest/assets/3DBenchy.stl /tmp/benchy.gcode
node wasm/web/serve.mjs            # then open http://localhost:8080/
node wasm/web/smoke-test.mjs app/src/androidTest/assets/3DBenchy.stl /tmp/demo.png
```

`-DU1SLICER_WASM_DEBUG=ON` turns on runtime assertions, function names in stack traces,
`SAFE_HEAP` and stack-overflow checks.

The native reference build needs Ubuntu packages: `libboost-all-dev libtbb-dev libgmp-dev
libmpfr-dev libcgal-dev libnlopt-cxx-dev libexpat1-dev libpng-dev libjpeg-dev
libeigen3-dev nlohmann-json3-dev libcereal-dev`. Then:

```bash
cmake -S wasm -B wasm/build/host -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
cmake --build wasm/build/host && wasm/build/host/u1slicer-host model.stl out.gcode [config.json]
```

## Results

All runs used default `SliceConfig`. Multi-colour runs added
`{"extruder_count": 4, "wipe_tower_enabled": true}`. Measured on 4 cores (2026-10-16):
Node 22 for wasm, clang 18 with libstdc++ for native.

| Model | Layers | wasm slice | native slice | wasm / native | Parity |
|---|---|---|---|---|---|
| `tetrahedron.stl` | 49 | 0.57 s | 0.06 s | — | match |
| `3DBenchy.stl` (225k tris) | 239 | 11.1 s | 8.5 s | 1.3× | match (≤0.008 % per feature) |
| `colored_3DBenchy (1).3mf`, 4 ext | 240 | 18.7 s | 12.0 s | 1.6× | match, identical tool changes |
| `3DBenchy-H2C-Multi-Color.3mf` (painted), 4 ext | 239 | 33.8 s | 24.8 s | 1.4× | identical tool changes (T0 120, T1 239, T2 121, T3 238) |
| `Cube+v2.3mf` (14 volumes) | 173 | 16.9 s | — | — | slices |
| `OrcaCube_v2.3mf`, `die-single-colour.3mf` | 149 / 79 | 11.1 s / 2.4 s | — | — | slice |

- **Browser:** headless Chromium (Playwright) slices 3DBenchy in 11.9 s through the demo
  page, with no page errors.
- **Startup:** the module instantiates in 0.1–0.3 s.
- **Memory:** Node RSS during a slice was 0.55–0.9 GB (release build), which includes
  the runtime.
- **G-code output:** carries the U1-specific engine behaviour, e.g. `EXCLUDE_OBJECT_DEFINE`
  for every object (F71).

### Parity

Line diffs between builds are meaningless (about 6 % of Benchy's lines differ), so
`compare-gcode.py` compares what reaches the printer:

- layer count and Z list
- filament per `;TYPE:` feature
- the full lists of tool changes, temperatures and Klipper object definitions

wasm vs native matched on every model above. The remaining differences are path ordering
and travel/`M73` placement. These are expected because the native reference uses
libstdc++ while wasm (and Android) use libc++, so unordered-container iteration order and
unstable-sort tie-breaking differ.

**Not yet done:** parity against the Android `.so` itself. The same script will do it:
run it on G-code from the app and from `node/slice.mjs`, with the same `SliceConfig`
values.

## What it took (findings)

Apart from one 32-bit fix (item 3), the engine compiled unchanged. The work was
dependency plumbing, plus these issues. The first two affect the **Android build too**:

1. **`orca_stubs.cpp` stub had the wrong return type** (fixed in this branch). The stub
   for `Feature::FuzzySkin::apply_fuzzy_skin(const Polygon&, …)` returned `void`, but the
   real declaration returns `Polygon`. On ARM64 the caller then reads an unwritten return
   slot, which is undefined behaviour whenever that path runs. wasm turned it into a
   signature-mismatch trap. The stub now returns the polygon unchanged. The shipped `.so`
   only picks this up at the next native rebuild.
2. **The TBB serial shim was resolved through `EXTERN_DIR`** (fixed). The shim lives in
   git under `extern/tbb_serial`. Any build that points `EXTERN_DIR` at an external deps
   bundle silently compiled against real `tbb::parallel_for`. That is the ARM64 data-race
   configuration the shim exists to prevent.
3. **wasm32 has a 32-bit `size_t`.** Arachne's
   `SkeletalTrapezoidation::interpolate` did `coord_t i = vec.size() - 1` on a possibly
   empty vector. That gives `-1` on 64-bit but `+4294967295` on wasm32, and the
   out-of-bounds read crashed every Benchy slice.
   - Fixed by `patches/0001-…`, a candidate for upstreaming to the Orca fork.
   - A scan found no other `size()`-to-int64 cases, but other 32-bit assumptions may still
     exist in code paths these models don't reach.
   - Another option is `-sMEMORY64` (wasm64). It removes this whole class of bug and the
     4 GB heap cap, at some speed cost, and Safari doesn't support it yet.
4. **No FPU rounding-mode control in wasm.** CGAL's interval arithmetic (behind every
   filtered exact predicate) assumes rounding control, and silently produces unsound
   bounds without it. CGAL's own self-check fails as soon as assertions are on. The build
   sets `CGAL_ALWAYS_ROUND_TO_NEAREST`, CGAL's supported fallback.
5. **Not every engine parallel loop is serialised.** The serial shim covers only
   `parallel_for`/`reduce`/`sort`/`invoke`/`for_each`. `GCode::process_layers` runs a
   real `tbb::parallel_pipeline`, so wasm needs pthreads (SharedArrayBuffer, i.e. a
   cross-origin-isolated page). The progress callback must also stay on the main thread
   (`wasm_api.cpp`).
6. **Engine behaviour gated on `__ANDROID__`.** Three Orca translation units have U1
   patches behind `#ifdef __ANDROID__`: F71 object definitions, serial-safe thread naming
   and the FaceDetector skip. The wasm build defines `__ANDROID__` for exactly those files.
   A dedicated macro in the fork (e.g. `SLIC3R_U1_TARGET`) would be cleaner.
7. **Toolchain friction:**
   - Emscripten's clang is far newer than NDK 26's clang 17, which needed CGAL 5.6.2 and
     one diagnostic downgrade.
   - oneTBB needed 2022.0 for Emscripten support.
   - Boost's `emscripten` b2 toolset is broken on current emcc, so Boost is built through
     the `clang` toolset.
   - The sandbox's network policy blocked GitHub archive downloads, so libpng and
     libjpeg are built from git clones instead of Emscripten ports.

Harmless noise: `get_hrc_by_nozzle_type: parse info/nozzle_info.json` errors because
Orca's `resources/` directory isn't bundled. The native build logs the same message.

## Limitations / next steps

- **App pipeline:** the Kotlin pre-processing that makes Bambu/multi-plate 3MFs slice
  correctly isn't ported: `BambuSanitizer`, `ProfileEmbedder`, colour mapping, wipe-tower
  placement, the B106 start G-code assets. The fastest path is probably Kotlin
  Multiplatform for those pure-logic classes, or a port to TypeScript.
- **Memory:** wasm32 caps the heap at 4 GB. The heaviest app fixtures (and B131-class
  models) should be tested next. wasm64 is the escape hatch.
- **Hosting:** the page needs COOP/COEP headers. Moonraker uploads from a browser also
  need CORS (`cors_domains`) and hit mixed-content blocking from an HTTPS origin.
  Serving the page from the printer host avoids both.
- **Preview:** the Prepare 3D preview and G-code preview are not ported. The demo's 2D
  layer viewer is a placeholder.
- **STEP import:** needs OCCT, which also builds for wasm but is large. It is excluded
  here, as it is on Android.
