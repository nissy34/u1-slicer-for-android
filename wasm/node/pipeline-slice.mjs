#!/usr/bin/env node
// Slice a model through the app's full model pipeline (wasm/web/pipeline/session.mjs:
// ThreeMfParser -> BambuSanitizer -> ProfileEmbedder -> engine -> header patches,
// layer-tool pauses, thumbnails -> PrintTimeRemap export), as the web page does.
//
//   node wasm/node/pipeline-slice.mjs <model> <out.gcode> [options.json] [--plate N] [--canonical]
//
// options.json (all optional):
//   { "presets": [{ "index": 0, "color": "#FF0000", "materialType": "PLA" }, ...],
//     "slotTemps": [220, null, 240, null],
//     "overrides": { "layerHeight": { "mode": "OVERRIDE", "value": 0.12 }, ... },   // SlicingOverrides
//     "config": { "bedTemp": 65 },                                                 // SliceConfig fields
//     "colorMapping": [0, 1, 2, 3], "selectedExtruder": 2, "copies": 2,
//     "scale": 0.5, "rotationZ": 45, "split": true, "autoArrange": true }
// --canonical writes the G-code in the engine's file-filament tool space (what
// the app stores) instead of the exported, slot-mapped file.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(import.meta.url);
const { SlicerSession } = await import('../web/pipeline/session.mjs');
const { slicingOverrides } = await import('../web/pipeline/slicing-overrides.mjs');
const { extruderPreset } = await import('../web/pipeline/extruder-preset.mjs');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; return args.splice(i, 2)[1]; };
const canonicalOut = flag('--canonical');
const plateArg = opt('--plate');
const [modelArg, outArg, optionsArg] = args;
if (!modelArg || !outArg) {
  console.error('usage: pipeline-slice.mjs <model> <out.gcode> [options.json] [--plate N] [--canonical]');
  process.exit(2);
}
const options = optionsArg ? JSON.parse(readFileSync(optionsArg, 'utf8')) : {};
const profile = (p) => JSON.parse(readFileSync(resolve(repo, 'app/src/main/assets/orca_profiles', p), 'utf8'));
const profiles = {
  printer: profile('printer/snapmaker_u1.json'),
  process: profile('process/standard_0.20mm.json'),
  filament: profile('filament/pla.json'),
};

const createU1Slicer = require(process.env.U1SLICER_WASM_JS ?? resolve(here, '../build/engine/u1slicer.js'));
const engine = await createU1Slicer({ printErr: () => {}, print: () => {} });
const session = new SlicerSession({ engine, profiles, log: (l) => console.error(l) });
if (options.presets) session.setPresets(options.presets.map((p) => extruderPreset(p)), options.slotTemps ?? []);
if (options.overrides) session.overrides = slicingOverrides(options.overrides);
if (options.config) session.config = { ...session.config, ...options.config };

const t0 = performance.now();
let summary = session.loadModel(basename(modelArg), readFileSync(modelArg));
if (summary.needsPlateSelection || plateArg) {
  const plateId = Number(plateArg ?? summary.plates[0].plateId);
  console.error(`plates: ${summary.plates.map((p) => p.plateId).join(', ')} -> selecting ${plateId}`);
  summary = session.selectPlate(plateId);
}
const tLoad = performance.now();
if (options.colorMapping) session.applyMultiColorAssignments(options.colorMapping);
if (options.selectedExtruder != null) session.setSelectedExtruder(options.selectedExtruder);
if (options.scale) session.setModelScale(options.scale, options.scale, options.scale);
if (options.rotationZ) session.setModelRotation(0, 0, options.rotationZ);
if (options.copies) session.setCopyCount(options.copies);
if (options.split) session.splitObject(0);
if (options.autoArrange) session.autoArrange();
summary = session.summary();
console.error(`model: ${JSON.stringify({ ...summary.model })}`);
console.error(`3mf: bambu=${summary.isBambu} colours=${JSON.stringify(summary.detectedColors)} paint=${summary.hasPaintData} ` +
  `layerTool=${summary.hasLayerToolChanges} mapping=${JSON.stringify(summary.colorMapping)} extruders=${summary.extruderCount} ` +
  `tower=${summary.wipeTowerEnabled}@${summary.wipeTower.x.toFixed(1)},${summary.wipeTower.y.toFixed(1)} objects=${summary.objects.length}`);

let last = '';
const out = await session.slice((pct, stage) => {
  if (stage !== last) { console.error(`  [${String(pct).padStart(3)}%] ${stage}`); last = stage; }
});
const gcode = canonicalOut ? out.gcode : session.exportGcode(out.gcode);
writeFileSync(outArg, gcode);
console.error(`result: ${JSON.stringify(out.result)} pauses=${out.layerToolPauses}`);
console.error(`export mapping: ${JSON.stringify(session.resolveExportMapping())}`);
console.error(`timing: load ${(tLoad - t0).toFixed(0)}ms, total ${(performance.now() - t0).toFixed(0)}ms; ` +
  `wasm heap ${(engine.heapBytes() / 2 ** 20).toFixed(0)}MB`);
process.exit(0);
