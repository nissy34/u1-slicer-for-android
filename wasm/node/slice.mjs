#!/usr/bin/env node
// WASM spike CLI: slice a model with the wasm engine under Node.js.
//
//   node wasm/node/slice.mjs <model.stl|model.3mf> <out.gcode> [config.json] [--plate N]
//
// config.json uses the C++ sapil::SliceConfig field names (snake_case), e.g.
//   { "layer_height": 0.2, "fill_density": 0.15, "nozzle_temp": 220 }
// Fields left out keep the C++ defaults. The extra key "machine_start_gcode_file"
// / "machine_end_gcode_file" loads the template from a path on the host.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const modulePath = process.env.U1SLICER_WASM_JS ?? resolve(here, '../build/engine/u1slicer.js');

const args = process.argv.slice(2);
const plateIdx = args.indexOf('--plate');
const plate = plateIdx >= 0 ? Number(args.splice(plateIdx, 2)[1]) : 0;
const [modelArg, outArg, configArg] = args;
if (!modelArg || !outArg) {
  console.error('usage: slice.mjs <model> <out.gcode> [config.json] [--plate N]');
  process.exit(2);
}

const config = configArg ? JSON.parse(readFileSync(configArg, 'utf8')) : {};
for (const key of ['machine_start_gcode', 'machine_end_gcode', 'machine_change_filament_gcode']) {
  const file = config[`${key}_file`];
  if (file) {
    config[key] = readFileSync(resolve(dirname(configArg), file), 'utf8');
    delete config[`${key}_file`];
  }
}

const t0 = performance.now();
const createU1Slicer = require(modulePath);
const engine = await createU1Slicer();
const tInit = performance.now();

engine.FS.mkdirTree('/work');
const modelPath = `/work/${basename(modelArg)}`;
engine.FS.writeFile(modelPath, readFileSync(modelArg));

console.error(`core: ${engine.coreVersion()}`);
if (!engine.loadModel(modelPath, plate)) {
  console.error(`loadModel failed: ${modelPath}`);
  process.exit(1);
}
const tLoad = performance.now();
console.error(`model: ${engine.modelInfoJson()}`);

let lastStage = '';
const result = JSON.parse(engine.slice(JSON.stringify(config), (pct, stage) => {
  if (stage !== lastStage) {
    console.error(`  [${String(pct).padStart(3)}%] ${stage}`);
    lastStage = stage;
  }
}));
const tSlice = performance.now();

console.error(`result: ${JSON.stringify(result)}`);
if (!result.success) process.exit(1);

writeFileSync(outArg, engine.FS.readFile(result.gcodePath));
const mem = process.memoryUsage();
console.error(
  `timing: init ${(tInit - t0).toFixed(0)}ms, load ${(tLoad - tInit).toFixed(0)}ms, ` +
  `slice ${(tSlice - tLoad).toFixed(0)}ms; rss ${(mem.rss / 2 ** 20).toFixed(0)}MB`);
// Pthread workers keep the event loop alive; exit explicitly.
process.exit(0);
