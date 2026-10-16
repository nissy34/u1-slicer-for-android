# U1 Web Slicer — the app's slicing engine in a browser

The Android app's engine (Snapmaker Orca 2.2.4 `libslic3r` plus the `sapil` core in
`app/src/main/cpp`) compiled to WebAssembly, with a static web front end that slices
entirely in the browser tab, through **the app's own model pipeline** (3MF sanitizing,
profile embedding with the app's File/Orca/Override settings, per-slot materials and
temperatures, colour-change pauses, thumbnails, prime-tower placement and the Prepare
screen's move/rotate/scale/copies/arrange), a 3D model and G-code preview, G-code
download, and **Upload Only** to the printer over Moonraker.

- wasm module: 8.8 MB (2.8 MB gzipped). The optional STEP-capable module is 20.6 MB
  (6.9 MB gzipped) and is only downloaded when you open a `.step`/`.stp` file. The whole
  site with both is 30.4 MB (9.8 MB zipped).
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

1. **Model.** Choose an STL, 3MF, OBJ or STEP. Picking a STEP file switches to the
   STEP-capable engine (one extra ~7 MB download). Multi-plate 3MFs show a **Plate**
   picker, as the app's plate dialog does.
2. **Filament slots.** E1–E4 each have a colour, a material and a nozzle temperature
   (blank = the material's default, `nozzleTempDefaultForMaterial`). These are the
   app's printer slot presets; the build plate sets the bed temperature
   (`PlateType.bedTempFor` on the sliced material).
3. **Colours → extruders.**
   - Single-colour models get an E1–E4 picker.
   - Multi-colour files list each file colour, auto-mapped to the closest-coloured slot
     (`findClosestExtruder` + `ensureMultiSlotMapping`), with a per-colour material
     override: a 3MF's declared filament keeps its material unless overridden (B128).
   - Layer-colour-change files (Hueforge style) slice with one filament and get
     `PAUSE_PRINT` colour changes.
4. **Arrange.** Copies, scale, rotation, auto-arrange, auto-orient, split to objects,
   duplicate, and *Add to bed* for a second file. Drag the model, single objects (after a
   split or add) or the grey prime-tower box on the bed; everything is clamped to the bed.
   The tower is auto-placed next to the model, as in the app.
5. **Settings.** The app's Prepare-screen overrides, row for row: every setting is
   **File** (keep the 3MF's value, shown as "File: …"), **Orca** (Orca's default) or
   **Override** (your value). Settings, slots and overrides persist in the browser.
6. **Slice.** Shows stats and a 3D G-code preview, coloured by feature or by extruder,
   with a layer slider.
7. **Download G-code**, or **Upload only** to the printer: Moonraker address plus an
   optional API key (`X-Api-Key`). Upload **never starts a print**: no `print=true`,
   and there is no start-print call anywhere. The file is the app's exported form: tools
   remapped to the chosen slots (`PrintTimeRemap`), thumbnails included.

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
| `src/wasm_api.cpp` | embind API: `loadModel`, `modelInfoJson`, `previewMesh` (+ per-object triangle counts), `projectConfigValue`, `slice(configJson, onProgress)`, `heapBytes`, `clearModel`; Prepare editing (`addModel`, `objectsJson`, `setObjectPositions`, `setModelInstances`, `setModelScale/Rotation`, `setObjectRotation/Scale`, `duplicateObject`, `splitObject`, `autoOrientObject/All`, `setVolumeExtruder`); the app's plate-state JNI accessors (`plateDataJson`, `allVolumeExtrudersJson`, `paintStateCountsJson`) |
| `src/slice_config_json.hpp` | JSON → `sapil::SliceConfig`, keyed by the C++ field names |
| `src/host_cli.cpp` | Native CLI over the same engine (parity reference) |
| `patches/` | Engine fixes the wasm build needs, applied to build-tree copies. The submodule is never modified |
| `stubs/` | `openssl/md5.h` (on Boost's MD5) and `android/api-level.h` |
| `node/slice.mjs` | Node CLI, engine only: `slice.mjs model out.gcode [config.json] [--plate N] [--app-defaults]` |
| `node/pipeline-slice.mjs` | Node CLI through the full app pipeline (what the page runs): `pipeline-slice.mjs model out.gcode [options.json] [--plate N] [--canonical]` — options: slot presets/temps, overrides, colour mapping, copies, scale, rotation |
| `web/pipeline/` | The app's model pipeline ported to JS ES modules ([below](#the-apps-model-pipeline)); `session.mjs` chains them like `SlicerViewModel` |
| `web/` | The site. `index.html` / `app.mjs` (UI), `settings-schema.mjs` (the app's override rows), `slicer-worker.js` (engine + pipeline session in a Worker), `app-defaults.mjs` (materials, plates, the engine-only CLI's config), `gcode-tool-remap.js` (port of `GcodeToolRemapper.kt`, used by tests), `gcode-preview.js`, `preview3d.mjs` (three.js: per-object meshes, drag on bed, tower box), `printer.mjs` (Moonraker upload only), `site-files.mjs` (one file map for `serve.mjs` and `package.mjs`) |
| `web/test/` | `npm test`: unit tests of every ported module, each held to the Kotlin test file it mirrors (678 tests, 17 skipped with reasons) |
| `web/test-engine/` | `npm run test:engine`: the app's native-slicing instrumented tests on the wasm engine (needs `build/engine`) |
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

- **STEP engine** (OCCT 7.6, the version Orca pins):
  ```bash
  wasm/scripts/build-deps.sh occt
  emcmake cmake -S wasm -B wasm/build/engine-step -G Ninja -DCMAKE_BUILD_TYPE=Release -DU1SLICER_WITH_STEP=ON
  cmake --build wasm/build/engine-step
  ```
  `package.mjs` then ships it as `u1slicer-step.{js,wasm}` alongside the default engine.
  CI builds both.
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
| H2C shoe, one plate, full size | 212 × 214 × 254 mm, 1,271 layers | 394 s | 2.1 GB |
| H2C shoe, **all plates, full size** | 608 × 214 × 254 mm | — | **`bad_alloc` at 2.9 GB** |

Typical single-plate jobs stay under 1 GB; a full-height, full-bed plate like the shoe
needs about 2 GB. Only whole multi-plate projects approach the ceiling, and the page then
suggests picking one plate. `-sMEMORY64` (wasm64) would lift
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
9. **STEP import needed four more fixes** (STEP build only):
   - Orca's `Model::read_from_file` rejects STEP, which goes through
     `Model::read_from_step`; `loadModel` now routes `.step`/`.stp` there under
     `SAPIL_WITH_STEP`. This means STEP could never have worked through `loadModel`, on
     Android either.
   - OCCT forces Emscripten's JS exception model (`-fexceptions`) on top of
     `-fwasm-exceptions`, so the build strips it.
   - Emscripten 6's clang emits invalid wasm (`br_table: label arity inconsistent`) for
     exactly two of OCCT's 5,063 objects (`ShapeUpgrade_ShapeDivide::Perform`,
     `ShapeCustom_BSplineRestriction::ConvertSurface`), at every optimisation level. Found
     by validating every object on its own. Those two files are compiled with
     `-fignore-exceptions`, so their own `catch` handlers don't run and an OCCT failure
     inside them propagates instead.
   - OCCT's parallel mesher deadlocks in a browser (a blocked thread can't start the Web
     Worker for a new pthread). `patches/0002-…` meshes serially; the triangles are the
     same.
10. **Native reference CLI only:** `~Model` logging after Boost.Log's TLS teardown aborted
   at exit, so the CLI now `quick_exit`s.

Harmless log noise:

- `nozzle_info.json` parse errors (Orca's `resources/` isn't bundled; native logs the same)
- "Detected missing Voronoi vertex" on some painted models (native logs the same)

## The app's model pipeline

The Android app does a lot in Kotlin between "open file" and "slice", and a 3MF sliced
by the bare engine behaves differently from the same file in the app (it ignores the
file's own process settings, for one). That Kotlin is now ported, so the page slices a
file the way the app does.

**Approach: hand-ported JS modules, each held to its Kotlin unit tests.**
- *Kotlin Multiplatform* was ruled out. These classes depend on `java.util.zip`,
  `java.io.File`, `org.json`, `XmlPullParser`, `android.graphics` and the ViewModel's
  state. Making them common code would mean refactoring Android-shipped classes, and
  the Android build must not change.
- *C++ inside `wasm_api.cpp`* would put ~10k lines of text/XML/zip processing into a
  language where it is harder to write and test. It would also grow the engine, which
  every visitor downloads.
- *JS modules* run unchanged in the browser worker and in Node (tests, CLI). Each one is
  a close transliteration of its Kotlin class: same functions, branches, regexes and
  bug-fix comments, with Kotlin's float formatting (`kt.mjs`) so emitted configs match
  the app's strings. Every ported Kotlin unit test has a JS twin with the same name and
  assertions. Three small shims stand in for platform APIs: `zip.mjs` (fflate),
  `xml-pull.mjs` (an `XmlPullParser` stand-in; workers have no DOMParser) and
  `kt.mjs`.

| Module (`web/pipeline/`) | Kotlin source | Mirrored tests |
|---|---|---|
| `three-mf-parser.mjs`, `three-mf-info.mjs`, `paint-color-decoder.mjs`, `layer-tool-custom-gcode-xml.mjs` | `ThreeMfParser`, `ThreeMfInfo`, `PaintColorDecoder`, `LayerToolCustomGcodeXml` | `ThreeMfParserTest`, `PaintColorDecoderTest`, `ComputeVisualColorCountByPlateTest`, `LayerToolCustomGcodeXmlTest` + fixture facts from the instrumented tests |
| `merge-three-mf-info.mjs`, `embed-target.mjs`, `native-plate-state.mjs` | `SlicerViewModel` companion (`mergeThreeMfInfo…`, `computeEmbedTargetCount`, `buildThreeMfInfoFromNative`), `NativePlateState`, `BambuPlateStateEnrichment` | `MergeThreeMfInfoTest`, `NativePlateStateTest` |
| `bambu-sanitizer.mjs` | `BambuSanitizer` (incl. the >20/50/64 MB streaming branches) | `BambuSanitizerTest`, `BambuSanitizerMetadataPreservationTest` |
| `profile-embedder.mjs` | `ProfileEmbedder` (the bundled U1 printer/process/filament profiles are served from the app's assets) | `ProfileEmbedderTest` + the zip-level `ProfileEmbedderIntegrationTest` / `NegativeVolumePreservationTest` cases |
| `slicing-overrides.mjs`, `slice-config.mjs`, `profile-overrides.mjs`, `extruder-preset.mjs` | `SlicingOverrides`, `SliceConfig` (+ the JNI field mapping), `buildProfileOverrides(Impl)`, B63/B110 header patches, `computeFreshSlotTemps`, `ExtruderPreset` | `SlicingOverridesTest`, `NozzleTempDefaultTest`, `FilamentTypeHeaderPatchTest`, `FilamentTypeLabelTest`, `FilamentTypeWiringTest`, `SingleColorExtruderConfigTest`, `SliceConfigTest`, … |
| `canonical-filament-list.mjs`, `canonical-list-at-load.mjs` | `CanonicalFilamentList`, `PerFilamentResolver`, `BambuCanonicalList`, `PrusaSlicerCanonicalList`, `CanonicalListAtLoad` | `BambuCanonicalListTest`, `PrusaSlicerCanonicalListTest`, `CanonicalFilamentListTest`, `PerFilamentResolverTest`, `NonCanonicalOverrideTest` |
| `layer-tool-pause-injector.mjs` | `LayerToolPauseInjector` | `LayerToolPauseInjectorTest` |
| `gcode-thumbnail-injector.mjs` | `GcodeThumbnailInjector` | `GcodeThumbnailInjectorTest` (instrumented, run in Node) |
| `copy-arrange-calculator.mjs`, `wipe-tower.mjs`, `model-scale-converter.mjs`, `exclude-object-parser.mjs` | `CopyArrangeCalculator`, `WipeTowerDepthEstimator`, `wipeTowerClampBounds`, `ModelScaleConverter`, `ExcludeObjectParser` | `CopyArrangeCalculatorTest`, `WipeTowerDepthEstimatorTest`, `WipeTowerClampTest`, `ModelScaleConverterTest`, `ExcludeObjectParserTest` |
| `print-time-remap.mjs` | `PrintTimeRemap` (export mapping + tool remap) | `PrintTimeRemapTest`, `CanonicalExportMappingTest`, `SliceJobMappingResolutionTest` |
| `multi-color-mapping.mjs`, `../settings-schema.mjs` | `findClosestExtruder`, `ensureMultiSlotMapping`, `buildSupportFilamentOptions`, the override rows | `MultiColorMappingTest`, `MultiColorMappingMoreThan4Test`, `SupportFilamentOptionTest` |
| `session.mjs` | the `SlicerViewModel` flow that chains them (below) | `test-engine/` |

`session.mjs` follows the ViewModel's order:
- **Load:** parse → `BambuSanitizer.process` → `embedProfile` (`ProfileEmbedder.buildConfig`
  + `embed`, plate-filtered, B101/B104) → engine load → the B47 colour mapping,
  extruder count and auto-placed prime tower.
- **Plate selection:** embed that plate, load it, derive the plate state from the
  engine (`buildThreeMfInfoFromNative`).
- **Slice:**
  - Re-embed with the current settings and reload (B24), then replay edits (added files,
    splits, per-volume extruders, poses, duplicates) and placement.
  - Resolve `SlicingOverrides` into the `SliceConfig`, with the B100 layer-height
    sentinel, B106 machine G-code for plain models, and the clamped tower.
  - Slice, then the B63/B110 header patches, layer-tool pauses, thumbnails and the
    `PrintTimeRemap` export.

### Verification

- `npm test` runs the unit tests: every ported Kotlin unit test, 661 passing and 17
  skipped. The skipped cases need the native engine; their sliced equivalents are in
  `test-engine/`.
- `npm run test:engine` runs the app's native-slicing instrumented tests on the wasm
  engine, one JS test per Kotlin `@Test` with the same assertions and tolerances: 140
  tests, 132 passing, 8 skipped, 0 failing, about 55 min on 4 cores. Native calls go
  straight to the engine, ViewModel flows go through `session.mjs`.

  | Kotlin instrumented test | Ported / pass / skip |
  |---|---|
  | `BambuPipelineIntegrationTest` | 42 / 42 / 0 |
  | `SlicingIntegrationTest` | 54 / 52 / 2 |
  | `PreparePreviewViewModelTest` | 25 / 19 / 6 |
  | `ProfileEmbedderIntegrationTest` (engine cases) | 17 / 17 / 0 |
  | `SemmSlicingTest` | 12 / 12 / 0 |
  | `BambuFixtureHarnessTest` | 6 / 6 / 0 |
  | `BambuPlateStateRegressionTest` | 4 / 4 / 0 |
  | `SensoryTwistSupportsTest`, `NegativeVolumePreservationTest`, `GoatDedupeSemmTest` | 3 / 3 / 0 |

  - **All six fixture specs pass.** `fixture-harness.test.mjs` mirrors
    `BambuFixtureHarnessTest`: colored Benchy, Dragon Scale plate 3,
    Button-for-S-trousers, flippy-flappy plate 4, Shashibo plate 5 and slip-slide-spin
    plate 3. Each is checked for per-tool G-code counts within the app's tolerances,
    paint state, enriched extruder count and bed bounds.
  - **Skips, Android-only machinery:**
    - slice cancel from a second thread
    - StateFlow emission order
    - `content://` Uri import
    - the Compose mesh cache
  - **Skips, viewer code not ported:**
    - `MultiStlCombiner`
    - `recolorByZBands`
    - two Buzz G-code-viewer palette checks
  - **Bug found:** the suite found one bug in the session port, `autoArrange`, which is
    now fixed.

- Spot checks through `node/pipeline-slice.mjs`:
  - Colored Benchy keeps its own 0.10 mm layer height (preserve path), gets 48×48 and
    300×300 thumbnails, and its tool counts match the app's spec.
  - An STL on E3 set to PETG at 245 °C prints with `T2`, `M109 S245 T2` and
    `; filament_type = PETG`.
  - A dual-colour 3MF mapped to E3+E4 with PETG/ABS overrides gets `T2@235` / `T3@270`
    and no `T0`.
- `smoke-test.mjs` drives the page in Chromium, now also through the multi-plate picker
  (`SMOKE_PLATE`). CI runs it on an STL, a STEP file and Dragon Scale plate 3, plus a
  Node pipeline check and the quicker engine suites: fixture harness, Bambu pipeline,
  ProfileEmbedder integration and negative volume, about 13 min.

### Behaviour differences from the app

- **Thumbnails:**
  - Thumbnail PNGs are re-encoded by fflate (bilinear scaling in Node; the browser's
    canvas scaling in the page), so their bytes and lengths differ. The block format,
    sizes and placement are the same.
  - JPEG 3MF previews only embed in the browser.
  - STL thumbnails come from the app's GL capture, which the page doesn't do yet.
- **Filament library and mixes:**
  - Per-slot temperature overrides go through the app's filament-library path, as a
    one-field library entry per slot.
  - Mixed/blended filaments, Smart Paint and full filament profiles are not ported, so
    the mix tool space is always off.
- **Single vs multi-object mode:**
  - Model-level scale, rotation and copies act on the whole loaded model (the app's
    single-object mode).
  - Split, duplicate and add-to-bed switch to per-object mode, where objects are dragged
    and posed individually. Per-object rotation is around Z only in the UI.
  - The app's on-device rule that one-source multi-object files scale all objects
    together (v2.10.10) is the same.
- **Strict JSON:** `JSON.parse` rejects some malformed JSON that Android's lenient
  org.json accepts. Such a config is treated as absent.
- **Paint specs straddling buffers:** the paint-spec scan reads whole entries, so a spec
  that straddles one of Kotlin's 64 KB stream buffers is not dropped.
- **Bambu targets:** Bambu printers as slicing targets (`BambuImportedConfigComposer`,
  `BambuProjectWriter`, H2D) are not ported. The page slices for the U1 only.

## Not ported (yet)

- Filament library (OpenPrintTag catalogue, RFID sync), mixed/blended filaments, Smart
  Paint, process-profile import.
- Bambu printers as slicing targets, Bambu `.gcode.3mf` packaging.
- Session resume, slice history, MakerWorld import, the printer status/camera screens.
- Per-volume (part) extruder editing in the UI. The engine API and replay exist;
  there is no parts panel yet.
