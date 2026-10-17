// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/BambuPlateStateRegressionTest.kt
// on the wasm engine (Tier A plate-state regressions): embed (with the test's
// plate filter) + engine load, then the ENRICHED extruder set
// (BambuPlateStateEnrichment via native-plate-state.mjs enrichPlateState, with the
// test's 0-based plate index resolved like PlateStateEnrichment.kt), plus the H2C
// multi-tool slice and the Buzz cold-parse perf gate. As in Kotlin, the plateId
// argument is handed straight to embed().
import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichPlateState, parseVolumeMapJson } from '../pipeline/native-plate-state.mjs';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { newEmbedder, processAuto } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import { exactToolCounts } from './gcode-validator.mjs';
import { NativeLib } from './native-lib.mjs';

const skip = engineAvailable ? false : 'wasm engine not built';
const embedder = newEmbedder();
let lib;
async function setup() {
  lib ??= await NativeLib.create();
  lib.clearModel();
  return lib;
}

function embedAndLoad(name, plateId = null, { targetExtruderCountOverride = null, sourceConfigForEmbed = false } = {}) {
  const file = asset(name);
  const info = parse(file, { name });
  const target = targetExtruderCountOverride ?? Math.max(info.detectedExtruderCount, 1);
  const sourceConfig = sourceConfigForEmbed ? embedder.parseSourceConfig(file) : null;
  const config = embedder.buildConfig({ info, sourceConfig, targetExtruderCount: target });
  const sourceForEmbed = info.isMultiPlate ? file : info.isBambu ? processAuto(file, name) : file;
  const embedded = embedder.embed(sourceForEmbed, config, info, null, plateId);
  assert.ok(lib.loadModel(embedded), `loadModel must succeed for ${name} plate=${plateId}`);
  return { info, state: parseVolumeMapJson(lib.e.allVolumeExtrudersJson()) };
}

/** PlateStateEnrichment.kt enrichedUsedExtruders(lib, info, state, plateIndex0Based). */
function enrichedUsedExtruders(info, state, plateIndex0Based) {
  const sourcePlate = plateIndex0Based != null ? info.plates.find((p) => p.plateId === plateIndex0Based + 1) ?? null : null;
  return enrichPlateState(state, sourcePlate, info, lib.e);
}

test('bug1_dragon_scale_plate3_enriches_to_three_extruders', { skip }, async () => {
  await setup();
  const { info, state } = embedAndLoad('Dragon Scale infinity.3mf', 2);
  const enriched = enrichedUsedExtruders(info, state, 2);
  assert.ok(enriched.size >= 3, `Dragon Scale plate 3 must enrich to >= 3 extruders. native=${[...state.usedExtruders]}, enriched=${[...enriched]}`);
  lib.clearModel();
});

test('bug2_f1_calendar_plate1_exactly_three_extruders', { skip }, async () => {
  await setup();
  const { info, state } = embedAndLoad('2026+F1+CALENDAR+-+DATES+&+TRACK+NAMES+(P_X+SERIES).3mf', 0);
  const enriched = enrichedUsedExtruders(info, state, 0);
  assert.equal(enriched.size, 3, `F1 calendar plate 1 must enrich to exactly 3 extruders. native=${[...state.usedExtruders]}, enriched=${[...enriched]}`);
  lib.clearModel();
});

test('bug5_h2c_benchy_multi_tool_gcode', { skip }, async (t) => {
  await setup();
  const name = '3DBenchy-H2C-Multi-Color.3mf';
  const file = asset(name);
  const info = parse(file, { name });
  if (!info.hasPaintData) { t.skip('assumeTrue: H2C benchy must report paint data'); return; }
  const processed = processAuto(file, name);
  const sourceConfig = embedder.parseSourceConfig(file);
  const config = embedder.buildConfig({ info, sourceConfig, targetExtruderCount: Math.max(info.detectedColors.length, 2) });
  assert.ok(lib.loadModel(embedder.embed(processed, config, info)), 'loadModel must succeed');
  const result = lib.slice({ extruderCount: 4 });
  assert.ok(result, 'Slice must succeed');
  assert.ok(result.success, 'Slice success flag');
  const counts = exactToolCounts(result.gcode, 4);
  const active = counts.filter((c) => c > 0).length;
  assert.ok(active >= 2, `H2C benchy must produce >= 2 active tools, got ${active} (counts=${counts})`);
  lib.clearModel();
});

test('bug6_buzz_cold_load_under_threshold', () => {
  const name = 'Buzz_Multipart_3MF_Bambu.3mf';
  const file = asset(name);
  const start = Date.now();
  const info = parse(file, { name });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 60_000, `Buzz parse took ${elapsed}ms — expected < 60000ms (post-cache-refactor floor ~47s)`);
  assert.ok(info.isMultiPlate, 'Buzz must be detected as multi-plate');
});
