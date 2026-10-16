# U1 Web Slicer — the app's slicing engine in a browser

The Android app's engine (Snapmaker Orca 2.2.4 `libslic3r` plus the `sapil` core in
`app/src/main/cpp`) compiled to WebAssembly, with a static web front end that slices
entirely in the browser tab: STL / 3MF / OBJ (STEP optional), U1 defaults and
start/end G-code, per-colour extruder mapping, a 3D model and G-code preview, G-code
download, and **Upload Only** to the printer over Moonraker.

- wasm module: 8.8 MB (2.8 MB gzipped); whole site 10.7 MB (3.2 MB zipped)
- about 1.3–1.6× slower than a native build of the same engine
- G-code matches a native 64-bit build of the same sources structurally ([Parity](#parity))

## Try it

**Hosted (Cloudflare Pages).** `.github/workflows/wasm-web.yml` builds and smoke-tests
the site on every push that touches `wasm/` or the engine. It deploys once two repository
secrets exist:

| Secret / variable | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with **Cloudflare Pages: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id (Cloudflare dashboard sidebar) |
| `CF_PAGES_PROJECT` (variable, optional) | Project name, default `u1-web-slicer` |

Without the secrets, each run still uploads a `u1-web-slicer-site` artifact (the site
zip). You can deploy that zip by hand: Cloudflare dashboard → Workers & Pages → Create →
Pages → **Upload assets**, then drop the zip or its folder. The included `_headers` file
sends the COOP/COEP headers the engine needs.

**Locally:**

```bash
node wasm/web/serve.mjs                 # http://localhost:8080/
node wasm/web/serve.mjs 8080 --host 0.0.0.0   # reachable from phones/tablets on the LAN
```

## Using the page

1. **Model.** Choose an STL, 3MF or OBJ (STEP in the STEP build). For multi-plate 3MFs,
   set the plate number (0 = all plates).
2. **Colours → extruders.**
   - Single-colour models get an E1–E4 picker.
   - Multi-colour files list each file colour with its hex value. The default mapping is
     identity up to 4 colours and `i % 4` beyond that, the app's H2C folding.
   - The engine slices with one tool per file colour; the G-code is then rewritten to the
     chosen U1 slots. This is the app's canonical-mapping + `GcodeToolRemapper` flow.
3. **Settings.**
   - Material and build plate set the default nozzle and bed temperatures, from the
     app's `nozzleTempDefaultForMaterial` and `PlateType.bedTempFor`.
   - Layer height "From file" keeps a 3MF's own layer height, falling back to 0.20 mm
     (the app's USE_FILE behaviour, B100).
   - Also: walls, infill, pattern, supports, brim, prime tower.
4. **Slice.** Shows stats and a 3D G-code preview, coloured by feature or by extruder,
   with a layer slider.
5. **Download G-code**, or **Upload only** to the printer: Moonraker address plus an
   optional API key (`X-Api-Key`). Upload **never starts a print**: no `print=true`,
   and there is no start-print call anywhere.

Printer upload from a browser has two constraints, both explained on the page when they
bite:

- **Mixed content.** An HTTPS page (Cloudflare) cannot call `http://<printer-ip>`. Use the
  LAN server above, host the site on the printer, or put TLS in front of Moonraker.
- **CORS.** Moonraker must allow the page's origin, e.g.
  `[authorization] cors_domains: http://localhost:* https://*.pages.dev`.

## Layout

| Path | What |
|---|---|
| `scripts/build-deps.sh` | Cross-compiles Boost 1.84, oneTBB 2022.0, GMP/MPFR, CGAL 5.6.2, NLopt, zlib, expat, libpng, libjpeg-turbo, Eigen, cereal, nlohmann-json; optionally OCCT 7.6 (`build-deps.sh occt`). Output goes to `build/deps/<dep>/{include,lib/wasm32}`, the same layout as the Android `extern/` bundle |
| `CMakeLists.txt` | Builds the engine through the **shared** `app/src/main/cpp/CMakeLists.txt`, with the same sources and defines as the `.so`. Emscripten produces `u1slicer.{js,wasm}`; a plain CMake configure produces the native reference CLI `u1slicer-host`. `-DU1SLICER_WITH_STEP=ON` adds STEP import |
| `src/wasm_api.cpp` | embind API: `loadModel`, `modelInfoJson`, `previewMesh`, `projectConfigValue`, `slice(configJson, onProgress)`, `heapBytes`, `clearModel` |
| `src/slice_config_json.hpp` | JSON → `sapil::SliceConfig`, keyed by the C++ field names |
| `src/host_cli.cpp` | Native CLI over the same engine (parity reference) |
| `patches/` | Engine fixes the wasm build needs, applied to build-tree copies. The submodule is never modified |
| `stubs/` | `openssl/md5.h` (on Boost's MD5) and `android/api-level.h` |
| `node/slice.mjs` | Node CLI: `slice.mjs model out.gcode [config.json] [--plate N] [--app-defaults]` |
| `web/` | The site. `index.html` / `app.mjs` (UI), `slicer-worker.js` (engine in a Worker), `app-defaults.mjs` (the app's plain-model slice config), `gcode-tool-remap.js` (port of `GcodeToolRemapper.kt`), `gcode-preview.js`, `preview3d.mjs` (three.js), `printer.mjs` (Moonraker upload only), `site-files.mjs` (one file map for `serve.mjs` and `package.mjs`) |
| `web/test/` | `npm test`: the remapper port, held to the Kotlin `GcodeToolRemapperTest` cases |
| `web/smoke-test.mjs` | Playwright end to end: load → map → slice → preview (+ `SMOKE_URL`, `SMOKE_SLOT`, `SMOKE_GCODE`) |
| `scripts/compare-gcode.py` | Structural G-code diff: layers, per-feature extrusion, tools, temperatures, objects |
| `scripts/check-android-cmake.sh` | Proves the shared CMakeLists still generates the identical Android build graph (no NDK needed). Runs in CI |

## Build

```bash
git clone https://github.com/emscripten-core/emsdk && emsdk/emsdk install 6.0.12 && emsdk/emsdk activate 6.0.12
source emsdk/emsdk_env.sh
git submodule update --init app/src/main/cpp/orcaslicer   # pinned Orca fork

wasm/scripts/build-deps.sh                     # ~40 min on 4 cores (~7 min on GitHub runners), once
emcmake cmake -S wasm -B wasm/build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build wasm/build/engine                # ~15 min on 4 cores
cd wasm/web && npm ci && npm test && node package.mjs   # -> wasm/build/site(.zip)
node smoke-test.mjs ../../app/src/androidTest/assets/3DBenchy.stl /tmp/shot.png
```

- **STEP build:**
  ```bash
  wasm/scripts/build-deps.sh occt
  emcmake cmake -S wasm -B wasm/build/engine-step -DU1SLICER_WITH_STEP=ON ...
  ```
  Then `U1SLICER_ENGINE_DIR=wasm/build/engine-step node wasm/web/package.mjs`.
- **Debug build:** `-DU1SLICER_WASM_DEBUG=ON` turns on assertions, symbolised stacks,
  `SAFE_HEAP` and stack checks.
- **Native reference:** install the Ubuntu packages `libboost-all-dev libtbb-dev
  libgmp-dev libmpfr-dev libcgal-dev libnlopt-cxx-dev libexpat1-dev libpng-dev
  libjpeg-dev libeigen3-dev nlohmann-json3-dev libcereal-dev`, then:
  ```bash
  cmake -S wasm -B wasm/build/host -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
  ```

## Results

Measured on 4 cores (2026-10-16), Node 22 for wasm, clang 18 + libstdc++ for native.
Heavy runs overlapped other builds, so their times are indicative.

**Speed and parity** (default config; multi-colour runs use 4 extruders + prime tower):

| Model | Layers | wasm | native | Parity |
|---|---|---|---|---|
| `3DBenchy.stl` (225k tris) | 239 | 11.1 s | 8.5 s | match, ≤0.008 % per feature |
| `colored_3DBenchy (1).3mf` | 240 | 18.7 s | 12.0 s | match, identical tool changes |
| `3DBenchy-H2C-Multi-Color.3mf`, 4 tools | 239 | 33.8 s | 24.8 s | identical tool changes |
| `3DBenchy-H2C-Multi-Color.3mf`, 7 tools (app canonical) | 239 | 44 s | 31 s | extrusion within 0.25 %; per-tool change counts differ by ≤3 (see below) |

**Heavy fixtures vs the 4 GB wasm32 heap** (peak heap after the slice):

| Model | Notes | Slice | Peak heap |
|---|---|---|---|
| F1 Calendar | 8.0 M tris | 148 s | 1.5 GB |
| Buzz, **all 8 plates at once** | 4.3 M tris, 99 parts, 1.1 m wide | 388 s | **3.2 GB** |
| Shashibo, **all plates** | 1.2 M tris, 0.8 m wide | 359 s | **2.7 GB** |
| Dragon Scale infinity | 0.8 M tris | 128 s | 0.7 GB |
| skywing-seawing-silkwing | | 120 s | 0.6 GB |
| Sensory Twist Ball | | 74 s | 0.6 GB |
| Flarewing Dragon / Spiderman | | 102 s / 98 s | 0.5 GB |
| GhostfacePokemoncard | 482 parts | 380 s | 0.4 GB |
| negative-volume-articulated | | 45 s | 0.4 GB |
| H2C shoe, **all plates, full size** | 608 × 214 × 254 mm | — | **`bad_alloc` at 2.9 GB** |

Single-plate jobs stay well under 1 GB. Only whole multi-plate projects approach the
ceiling, and the page then suggests picking one plate. `-sMEMORY64` (wasm64) would lift
the limit, at a speed cost and without Safari support.

**Browser:** headless Chromium slices 3DBenchy in 12–13 s through the page. The same
packaged site was verified under Cloudflare's runtime (`wrangler pages dev`): headers
applied, page cross-origin isolated, painted H2C Benchy sliced with 4 extruders.

### Parity

Line diffs between builds are meaningless (≈6 % of Benchy's lines differ through path
ordering), so `compare-gcode.py` compares what reaches the printer: layers and Z, filament
per feature, tool changes, temperatures and object definitions.

- **wasm vs native:** match on every single-, 4-tool and per-part model above.
- **7-tool painted H2C:** per-tool change counts differ slightly (e.g. T6 124 vs 127).
  Painted segmentation is known to be compiler-sensitive (CLAUDE.md's B62 note on NDK 25
  vs 26), and the native reference uses a different compiler and C++ library (clang 18 +
  libstdc++) from wasm (clang 22 + libc++). Only a comparison against the Android `.so`
  can say which matches the app.

**Comparing against the Android app** (needs a device):

1. In the app, slice a plain STL with default settings (Textured PEI, PLA, E1).
2. Save the G-code (Preview → Save) and copy it here.
3. Run
   `node wasm/node/slice.mjs model.stl web.gcode --app-defaults` and then
   `python3 wasm/scripts/compare-gcode.py app.gcode web.gcode`.
4. For multi-colour, map the same slots on both sides.

### Android build unchanged

`scripts/check-android-cmake.sh` configures the shared CMakeLists in Android mode, for
`origin/main` and for this branch, and diffs the generated build graph: 274 objects with
their sources, defines, include paths, flags and link lines. It is identical, and CI keeps
checking it.

Source-level changes that do reach Android:

- the `orca_stubs.cpp` return-type fix (below)
- JNI guards in `sapil.h` / `sapil_model.cpp` that are inert by default
- `SAPIL_WITH_STEP` guards in `android_compat.h` / `orca_stubs.cpp`, off on Android

## Findings

The first two affect the **Android build too**:

1. **`orca_stubs.cpp`'s `apply_fuzzy_skin(const Polygon&, …)` stub returned `void`**, but
   the real declaration returns `Polygon`. On ARM64 the caller reads an unwritten return
   slot (undefined behaviour); wasm traps on the mismatch. Fixed: the stub returns its
   input. It takes effect in the app at the next `.so` rebuild.
2. **The TBB serial shim was resolved through `EXTERN_DIR`.** A build pointing
   `EXTERN_DIR` at an external deps bundle silently used real `tbb::parallel_for`, the
   ARM64 data-race configuration the shim exists to prevent. Fixed: it's now resolved
   from the source tree.
3. **wasm32's 32-bit `size_t`.** Arachne's `interpolate()` did
   `coord_t i = vec.size() - 1` on a possibly empty vector, which is `+4294967295` instead
   of `-1`, and crashed every Benchy slice. Fixed in `patches/0001-…`, which is worth
   upstreaming.
4. **No FPU rounding-mode control in wasm.** CGAL's interval filters silently go unsound.
   Fixed with `CGAL_ALWAYS_ROUND_TO_NEAREST`.
5. **`GCode::process_layers` uses `tbb::parallel_pipeline`,** which the serial shim
   doesn't cover. So wasm needs pthreads (a COOP/COEP page), and JS callbacks must stay
   on the main thread.
6. **U1 engine patches are gated on `__ANDROID__`** (F71 object definitions, thread
   naming, FaceDetector). The wasm build defines it for exactly those three files; a
   `SLIC3R_U1_TARGET` macro in the fork would be cleaner.
7. **Without the app's start/end G-code, the engine emits Orca's generic start code.**
   `--app-defaults` and the page supply the B106 `PRINT_START`/`PRINT_END` templates
   from `snapmaker_u1.json`.
8. **Toolchain friction:**
   - newer clang needed CGAL 5.6.2 and one diagnostic downgrade
   - oneTBB 2022.0 for Emscripten support
   - Boost built via b2's `clang` toolset
   - git clones instead of Emscripten ports (the sandbox blocks GitHub archive downloads)
   - Emscripten 6 dropped `mainScriptUrlOrBlob`, so the worker script is pthread-aware
9. **Native reference CLI only:** `~Model` logging after Boost.Log's TLS teardown aborted
   at exit, so the CLI now `quick_exit`s.

Harmless log noise:

- `nozzle_info.json` parse errors (Orca's `resources/` isn't bundled; native logs the same)
- "Detected missing Voronoi vertex" on some painted models (native logs the same)

## Not ported (yet)

- **The rest of the app's 3MF pipeline:**
  - `BambuSanitizer` (fixes for malformed Bambu files)
  - `ProfileEmbedder` (merges U1 profile + user overrides into the 3MF, so the file's own
    process settings and the UI's interact exactly as in the app)
  - layer-tool pause injection
  - thumbnails
  - wipe-tower auto-placement

  The native importer already handles the files tested above, and colour mapping is
  ported. The rest is ~8k lines of Kotlin; Kotlin Multiplatform for the pure-logic
  classes is the likely route.
- **Per-slot materials/temperatures** (the page uses one material for all slots), filament
  library, mixed/blended filaments, Smart Paint.
- **Prepare-screen editing:** move/rotate/scale, copies, auto-arrange (the engine
  supports them via `setModelInstances` & co.; the UI doesn't yet).
