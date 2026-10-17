// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/GoatDedupeSemmTest.kt on
// the wasm engine: B76 — Goat ( Gray ).3mf with the user's dedupe mapping
// [0,1,2,2] must still embed 4 filaments (all of T0-T3 pre-remap) and the
// post-slice GcodeToolRemapper pass must fold T3 into T2.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { newEmbedder, processAuto } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import { exactToolCounts } from './gcode-validator.mjs';
import { NativeLib } from './native-lib.mjs';

const { remapGcode } = createRequire(import.meta.url)('../gcode-tool-remap.js');
const makeConfig = (slotCount) => ({
  layerHeight: 0.2, firstLayerHeight: 0.2, fillDensity: 0.15, perimeters: 2, supportEnabled: false,
  extruderCount: slotCount, extruderTemps: Array(slotCount).fill(220), nozzleTemp: 220, bedTemp: 55,
  wipeTowerEnabled: slotCount > 1, wipeTowerX: 170, wipeTowerY: 140, wipeTowerWidth: 60,
});

test('goat_dedupeMapping_preservesAllFourPaintStatesAndRemapsTo3Slots', { skip: engineAvailable ? false : 'wasm engine not built' }, async () => {
  const lib = await NativeLib.create();
  const embedder = newEmbedder();
  const name = 'Goat ( Gray ).3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(info.hasPaintData, 'Goat must be detected as hasPaintData');
  assert.equal(info.detectedColors.length, 4, 'Goat must have 4 detected colors');

  const colorMapping = [0, 1, 2, 2];
  const sourceConfig = embedder.parseSourceConfig(input);
  const sanitized = processAuto(input, name, info.isBambu);
  const config = embedder.buildConfig({ info, sourceConfig, targetExtruderCount: 4 });
  const embedded = embedder.embed(sanitized, config, info);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  const result = lib.slice(makeConfig(3));
  assert.ok(result, 'slice() must not return null');
  assert.ok(result.success, `Goat must slice successfully: ${result.errorMessage}`);

  const usageBefore = exactToolCounts(result.gcode, 4);
  assert.ok(usageBefore[0] > 0, 'T0 must be emitted (pre-remap) — colour 1 on E1');
  assert.ok(usageBefore[1] > 0, 'T1 must be emitted (pre-remap) — colour 2');
  assert.ok(usageBefore[2] > 0, 'T2 must be emitted (pre-remap) — colour 3');
  assert.ok(usageBefore[3] > 0, 'T3 must be emitted (pre-remap) — colour 4 (horns or similar); ' +
    'if this fails, computeEmbedTargetCount shrunk to 3 and dropped paint state 4');

  const usageAfter = exactToolCounts(remapGcode(result.gcode, colorMapping), 4);
  assert.equal(usageAfter[3], 0, 'T3 must disappear after dedupe remap');
  assert.equal(usageAfter[2], usageBefore[2] + usageBefore[3], "T2 must absorb T3's count (colour 3 + colour 4 combined onto E3)");
  assert.equal(usageAfter[0], usageBefore[0], 'T0 must be unchanged');
  assert.equal(usageAfter[1], usageBefore[1], 'T1 must be unchanged');
  lib.clearModel();
});
