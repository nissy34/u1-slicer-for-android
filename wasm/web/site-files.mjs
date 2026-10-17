// The published site, as { published path: source file }. Shared by the dev
// server (serve.mjs) and the deploy packager (package.mjs) so local testing
// serves exactly what Cloudflare will.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = dirname(fileURLToPath(import.meta.url));
const repo = join(web, '../..');
const engine = process.env.U1SLICER_ENGINE_DIR ?? join(web, '../build/engine');
const three = join(web, 'node_modules/three');
// Optional STEP-capable engine (wasm/CMakeLists.txt -DU1SLICER_WITH_STEP=ON).
const engineStep = process.env.U1SLICER_ENGINE_STEP_DIR ?? join(web, '../build/engine-step');

export const SITE_FILES = {
  'index.html': join(web, 'index.html'),
  'app.mjs': join(web, 'app.mjs'),
  'app-defaults.mjs': join(web, 'app-defaults.mjs'),
  'settings-schema.mjs': join(web, 'settings-schema.mjs'),
  'preview3d.mjs': join(web, 'preview3d.mjs'),
  'printer.mjs': join(web, 'printer.mjs'),
  // Printer tab (wasm/web/printer/).
  'printer/printer-tab.mjs': join(web, 'printer/printer-tab.mjs'),
  'printer/moonraker.mjs': join(web, 'printer/moonraker.mjs'),
  'printer/filament-library.mjs': join(web, 'printer/filament-library.mjs'),
  'printer/slots.mjs': join(web, 'printer/slots.mjs'),
  'printer/gcode-summary.mjs': join(web, 'printer/gcode-summary.mjs'),
  'printer/printer.css': join(web, 'printer/printer.css'),
  // The app's bundled OpenPrintTag filament library (F96) and its licence notice.
  'filament_library.json': join(repo, 'app/src/main/assets/filament_library.json'),
  'filament_library.NOTICE.txt': join(repo, 'app/src/main/assets/filament_library.NOTICE.txt'),
  'gcode-preview.js': join(web, 'gcode-preview.js'),
  // GcodeToolRemapper port; the Printer tab's Map & Print remap imports it.
  'gcode-tool-remap.js': join(web, 'gcode-tool-remap.js'),
  'slicer-worker.js': join(web, 'slicer-worker.js'),
  'u1slicer.js': join(engine, 'u1slicer.js'),
  'u1slicer.wasm': join(engine, 'u1slicer.wasm'),
  ...(existsSync(join(engineStep, 'u1slicer.wasm')) ? {
    'u1slicer-step.js': join(engineStep, 'u1slicer.js'),
    'u1slicer-step.wasm': join(engineStep, 'u1slicer.wasm'),
  } : {}),
  // The app's 3MF / model pipeline, ported module by module (pipeline/session.mjs).
  ...Object.fromEntries(readdirSync(join(web, 'pipeline')).filter((f) => f.endsWith('.mjs'))
    .map((f) => [`pipeline/${f}`, join(web, 'pipeline', f)])),
  'vendor/fflate.mjs': join(web, 'node_modules/fflate/esm/browser.js'),
  'vendor/fflate.LICENSE': join(web, 'node_modules/fflate/LICENSE'),
  // The U1 profiles ProfileEmbedder merges, single source of truth shared with the app
  // (printer also carries the B106 machine start/end G-code).
  'profiles/printer/snapmaker_u1.json': join(repo, 'app/src/main/assets/orca_profiles/printer/snapmaker_u1.json'),
  'profiles/process/standard_0.20mm.json': join(repo, 'app/src/main/assets/orca_profiles/process/standard_0.20mm.json'),
  'profiles/filament/pla.json': join(repo, 'app/src/main/assets/orca_profiles/filament/pla.json'),
  'vendor/three/three.module.js': join(three, 'build/three.module.js'),
  'vendor/three/three.core.js': join(three, 'build/three.core.js'),
  'vendor/three/addons/controls/OrbitControls.js': join(three, 'examples/jsm/controls/OrbitControls.js'),
  'vendor/three/LICENSE': join(three, 'LICENSE'),
};

// Every response needs COOP/COEP: the engine's pthreads use SharedArrayBuffer,
// which browsers only enable on cross-origin-isolated pages.
export const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '': 'text/plain; charset=utf-8',
};
