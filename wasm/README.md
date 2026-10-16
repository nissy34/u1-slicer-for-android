# U1 Web Slicer — the app's slicing engine in a browser

The Android app's engine (Snapmaker Orca 2.2.4 `libslic3r` plus the `sapil` core in
`app/src/main/cpp`) compiled to WebAssembly, with a static web front end that slices
entirely in the browser tab: STL / 3MF / OBJ (STEP optional), U1 defaults and
start/end G-code, per-colour extruder mapping, a 3D model and G-code preview, G-code
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
   STEP-capable engine (one extra ~7 MB download). For multi-plate 3MFs,
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
   optional API key (`X-Api-Key`). Upload **never starts a print**: no `print=true` and
   no start call. Starting a print only happens from the Printer tab, behind a confirm
   dialog.

6. **Print…** opens the Printer tab's print screen for the sliced G-code (see below).

Printer upload from a browser has two constraints, both explained on the page when they
bite:

- **Mixed content.** An HTTPS page (Cloudflare) cannot call `http://<printer-ip>`. Use the
  LAN server above, host the site on the printer, or put TLS in front of Moonraker.
- **CORS.** Moonraker must allow the page's origin, e.g.
  `[authorization] cors_domains: http://localhost:* https://*.pages.dev`.

## Printer tab

A second tab (**Printer**, or `…/#printer`) mirrors the Android app's Printer screen, talking
to Moonraker directly from the browser. It has the same mixed-content and CORS constraints
as upload; the websocket has them too (`ws://` from an `https://` page is blocked, and
Moonraker checks the origin against `cors_domains`).

- **Connection.** Address (bare IP gets `http://` and `:7125`, like the app's `normalizeUrl`)
  and an optional API key, both remembered in this browser only. With a key, every HTTP
  request carries `X-Api-Key`; the websocket, which can't carry headers, uses a oneshot
  token from `/access/oneshot_token`. Camera snapshots get the key only when they're served
  by the printer's own host.
- **Live status.** Moonraker's websocket (`printer.objects.subscribe` on `print_stats`,
  `virtual_sdcard`, heaters, `extruder`…`extruder3`, `led cavity_led`, `print_task_config`,
  `display_status`, then `notify_status_update`). If the socket can't open or drops, the tab
  polls `/printer/objects/query` every 2 s (0.5 s for 30 s after a start) and keeps trying to
  reconnect. Shows state, progress (`virtual_sdcard.progress` first, B33), layer
  (`print_stats.info`), elapsed and remaining time (the file's slicer estimate scaled by
  progress), filament used, the four nozzles and the bed. Offline needs three failed polls
  (B39). State changes raise toasts, plus browser notifications if you allow them while the
  tab is hidden.
- **Camera.** The app's discovery: the first webcam's `snapshot_url` from
  `/server/webcams/list` (port stripped, then kept), then `/server/files/camera/monitor.jpg`,
  refreshed every 500 ms, with `camera.start_monitor` every 2 s as the app's keepalive.
  Optional MJPEG stream (`stream_url`). Because the page is cross-origin isolated (COEP, for
  the engine's threads), frames are fetched with CORS: the webcam server must send
  `Access-Control-Allow-Origin`, otherwise use "Open camera in a new tab".
- **Filaments.** Four slots (material, colour, name, nozzle/bed temperature), kept per
  browser. **Sync from printer** reads `print_task_config` (AFC lanes as a fallback), runs
  each loaded slot through the app's library matcher (same brand and material, ΔE76 ≤ 10),
  and shows a preview before applying colours and/or types. **Edit** a slot by hand or pick
  from the bundled OpenPrintTag library (`filament_library.json`, the app's asset: search,
  material chips, favourites, recents, import preview with midpoint temperatures). Edits can
  optionally be written back to the printer with `SET_PRINT_FILAMENT_CONFIG`.
- **Print screen** (for the slicer's result, a local `.gcode`, or a file already on the
  printer):
  - **Select a Plate to Print**: thumbnail, estimated time, total grams, nozzle diameter and
    one chip per filament, e.g. "PLA | 3.6g". These come from the G-code footer
    (`; filament used [g]`, `filament_type`, `filament_colour`).
  - **Confirm Printer**: hostname and an online dot.
  - **Configure Filaments**: one card per tool the G-code prints with, each with a tool-head
    choice. This is the app's Map & Print: the G-code is rewritten with `gcode-tool-remap.js`
    (T*n*, `M104/M109 T`, `SM_* EXTRUDER=/INDEX=`) before upload. The tab warns when a head
    holds a different material than the G-code was sliced for (B118), and when two
    filaments share a head.
  - **Print Preferences**: Extrusion Flow Calibration, Auto Leveling, Time-lapse Camera.
  - **Start Print** (after a confirm dialog) or **Upload only**.

### Print preferences: how the U1 takes them

The Android app doesn't send these. The Snapmaker app does, and its print dialog (the
Flutter bundle in Orca's `resources/web/flutter_web/main.dart.js`, `setPrePrintConfiguration`)
sends this through `/printer/gcode/script` right before starting:

```
SET_PRINT_PREFERENCES BED_LEVEL=<0|1> FLOW_CALIBRATE=<0|1> TIME_LAPSE_CAMERA=<0|1>
```

The firmware's `print_task_config` module keeps the values and reports them back as
`auto_bed_leveling`, `flow_calibrate` and `time_lapse_camera`, which the tab uses as the
toggles' defaults. The U1 start G-code always calls `BED_MESH_CALIBRATE`,
`SM_PRINT_FLOW_CALIBRATE` and `TIMELAPSE_START`. The firmware appears to honour the stored
preferences inside those macros: the paxx12 extended firmware's "force bed leveling" and
"force timelapse" overlays work by wrapping exactly these macros with
`SET_PRINT_PREFERENCES … FORCE=1`. This is inferred from that overlay, not from firmware
source, which isn't published. Stock firmware rejects the command while a print is running
or paused. The Snapmaker app also sends `SET_PRINT_EXTRUDER_MAP` and
`SET_PRINT_USED_EXTRUDERS` so the firmware remaps tools itself. The tab does what the app's
Map & Print does instead: it rewrites the G-code and starts it verbatim through the API.

### What each control sends

| Control | Request(s) | Confirm |
|---|---|---|
| Connect | `GET /server/info`, `/printer/info`, `/server/webcams/list`, `/server/files/list`, websocket subscribe | — (read-only) |
| Camera | `GET` snapshot URL (+`_cb`), websocket `camera.start_monitor` every 2 s | — |
| Light | `POST /printer/gcode/script` `SET_LED LED=cavity_led WHITE=1.0\|0 RED=0 GREEN=0 BLUE=0` | — (light only) |
| Sync from printer | `GET /printer/objects/query?print_task_config&filament_detect` (AFC: `/printer/objects/list` + query) | preview before applying (local only) |
| Slot edit, "also write to printer" | `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=i FILAMENT_TYPE='…' FILAMENT_SUBTYPE='…' FILAMENT_COLOR_RGBA='RRGGBBAA' SAVE=1 VENDOR='…'` | opt-in checkbox |
| Upload only | `POST /server/files/upload` (`root=gcodes`, no `print`) | — (never starts) |
| Start Print | upload (remapped G-code, `<model>_<millis>.gcode`) → `SET_PRINT_PREFERENCES …` → `POST /printer/print/start?filename=` | **yes** |
| Print… on a printer file | `SET_PRINT_PREFERENCES …` → `POST /printer/print/start?filename=` | **yes** |
| Pause / Resume / Stop print | `POST /printer/print/pause` / `resume` / `cancel` | **yes** |
| Cool down | `TURN_OFF_HEATERS` | **yes** |

### Safety model

- Opening the tab or connecting sends only reads, plus the camera keepalive.
- Anything that heats, moves, starts, pauses, resumes or cancels needs an explicit confirm
  dialog. Cancelling it sends nothing (the e2e test checks this).
- Upload only never sends `print=true` or a start call.
- If setting the preferences fails, for example because the printer is busy, the print is
  not started.
- Development and CI never touch a real printer. `test/mock-moonraker.mjs` is a fake
  Moonraker and U1 (CORS per `cors_domains`, API key and oneshot tokens, request log,
  simulated print). Run it by hand with `node wasm/web/test/mock-moonraker.mjs 7125
  [--api-key K] [--cors ORIGIN] [--no-ws]`.

### Tests

- `npm test` runs:
  - `test/printer-moonraker.test.mjs`: MoonrakerClientTest incl. API key, PrinterRepository
    notification/upload-name tests, PrintProgressNotifierTest, PrinterStatusBadgeTest
  - `test/printer-filament-library.test.mjs`: FilamentLibrary/Matcher/Recents/Import, the
    asset contract, SyncPreviewBuilderTest
  - `test/printer-gcode-summary.test.mjs`: footer parsing, cards, remap
  - `test/printer-mock.test.mjs`: the client against the mock, over HTTP and websocket
- `node printer-e2e.mjs [shots-dir] [--model m.stl]` drives the page in Chromium against the
  mock. It covers CORS and API-key errors, live status, camera, LED, sync, library, the slot
  write-back, the full print screen with remap and preferences, confirm/cancel, pause,
  resume, stop, upload only, printer-side files, the polling fallback and (with `--model`)
  slice → Print…. CI runs it with the tetrahedron.

### Known gaps

- **Upload only from the slicer card.** It uploads the slicer's already-remapped G-code. The
  app instead uploads the canonical body and lets the printer's Filament Setup map it.
- **Printer-side files** start exactly as uploaded. Re-mapping them would mean downloading
  and re-uploading the file.
- **Webcam without CORS.** Frames only show in the page when the webcam sends CORS headers.
  Otherwise use "Open camera in a new tab".
- **Tool map.** The tab sends no firmware tool map (`SET_PRINT_EXTRUDER_MAP`), matching the
  app's API-start path.
- **Not ported.** Skip objects, per-heater target editing, custom G-code and multiple saved
  printers (all in the app).
- **Local G-code files** from another slicer: if the footer has no per-filament data, cards
  fall back to the tools found in the body.

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
| `web/printer/` | Printer tab: `printer-tab.mjs` (UI), `moonraker.mjs` (client + websocket/polling), `filament-library.mjs`, `slots.mjs` (RFID sync), `gcode-summary.mjs` (print screen data), `printer.css` |
| `web/test/` | `npm test`: the remapper port and the printer modules, held to the Kotlin tests; `mock-moonraker.mjs` (fake printer) |
| `web/printer-e2e.mjs` | Playwright end to end of the Printer tab against the mock Moonraker |
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
