// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/BambuFixtureHarnessTest.kt
// on the wasm engine, through the ported modules and the harness's exact path:
// ThreeMfParser.parse -> ProfileEmbedder.buildConfig(targetExtruderCount = detected)
// -> BambuSanitizer.process (single-plate Bambu only) -> embed(plateId) -> loadModel
// -> slice(SliceConfig(extruderCount)), checking each approved spec in
// app/src/androidTest/assets/fixture-specs for enriched extruder count, paint
// state, per-tool G-code counts (± tolerance) and the bed bounding box. As in the
// harness, plateIndex is passed straight through as the plate id.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { process as sanitize } from '../pipeline/bambu-sanitizer.mjs';
import { enrichPlateState, parseVolumeMapJson } from '../pipeline/native-plate-state.mjs';
import { ProfileEmbedder } from '../pipeline/profile-embedder.mjs';
import { sliceConfig, toNativeSliceConfig } from '../pipeline/slice-config.mjs';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { ASSETS, asset, engine, engineAvailable, gcodeExtents, PROFILES, toolCounts } from './engine-helpers.mjs';

const specs = readdirSync(join(ASSETS, 'fixture-specs')).filter((f) => f.endsWith('.json')).sort();
const testName = { 'button-for-s-trousers': 'fixture_button_for_s_trousers', 'colored-benchy': 'fixture_colored_benchy',
  'dragon-scale-plate3': 'fixture_dragon_scale_plate3', 'flippy-flappy-plate4': 'fixture_flippy_flappy_plate4',
  'shashibo-plate5': 'fixture_shashibo_plate5', 'slip-slide-spin-plate3': 'fixture_slip_slide_spin_plate3' };

async function embedAndLoadForPlate(e, name, plateId) {
  const file = asset(name);
  const info = parse(file, { name });
  const target = Math.max(info.detectedExtruderCount, 1);
  const embedder = new ProfileEmbedder({ ...PROFILES });
  const config = embedder.buildConfig({ info, targetExtruderCount: target });
  const source = info.isMultiPlate ? file : info.isBambu ? sanitize(file, { isBambu: true }) : file;
  const embedded = embedder.embed(source, config, info, null, plateId);
  e.FS.mkdirTree('/work');
  e.FS.writeFile('/work/harness.3mf', embedded);
  e.clearModel();
  assert.ok(e.loadModel('/work/harness.3mf', 0), `loadModel must succeed for ${name} plate=${plateId}`);
  return { info, state: parseVolumeMapJson(e.allVolumeExtrudersJson()) };
}

for (const specFile of specs) {
  const key = specFile.replace(/\.json$/, '');
  const spec = JSON.parse(readFileSync(join(ASSETS, 'fixture-specs', specFile), 'utf8'));
  test(testName[key] ?? `fixture_${key}`, { skip: !engineAvailable ? 'wasm engine not built' : !spec.approved }, async () => {
    const e = await engine();
    const failures = [];
    for (const plate of spec.plates) {
      const tag = `${spec.file} plate ${plate.plateIndex}`;
      const legacyPlateId = plate.plateIndex >= 0 ? plate.plateIndex : null;
      const { info, state } = await embedAndLoadForPlate(e, spec.file, legacyPlateId);
      const sourcePlate = legacyPlateId != null ? info.plates.find((p) => p.plateId === legacyPlateId + 1) ?? null : null;
      const enriched = enrichPlateState(state, sourcePlate, info, e);
      if (enriched.size !== plate.expectedExtruderCount) {
        failures.push(`${tag}: extruder count ${enriched.size} != ${plate.expectedExtruderCount} (native=${[...state.usedExtruders]}, enriched=${[...enriched]})`);
      }
      if (state.hasPaintData !== plate.hasPaintData) failures.push(`${tag}: hasPaintData ${state.hasPaintData} != ${plate.hasPaintData}`);
      if (Object.keys(plate.expectedToolCounts).length) {
        const expectedToolExtruderCount = Math.max(...Object.keys(plate.expectedToolCounts).map((t) => Number(t.slice(1)))) + 1;
        const n = Math.max(plate.expectedExtruderCount, expectedToolExtruderCount, enriched.size ? Math.max(...enriched) : 1, 1);
        const result = JSON.parse(e.slice(JSON.stringify(toNativeSliceConfig(sliceConfig({ extruderCount: n }))), null));
        assert.ok(result.success, `${tag}: slice failed: ${result.error}`);
        const gcode = new TextDecoder().decode(e.FS.readFile(result.gcodePath));
        const counts = toolCounts(gcode, 4);
        for (const [tool, expected] of Object.entries(plate.expectedToolCounts)) {
          const actual = counts[Number(tool.slice(1))] ?? 0;
          if (expected > 0 && actual === 0) failures.push(`${tag}: ${tool} expected non-zero tool use near ${expected} but was 0`);
          if (Math.abs(actual - expected) > plate.toolCountTolerance) {
            failures.push(`${tag}: ${tool} count ${actual} not within ±${plate.toolCountTolerance} of ${expected} (all ${counts})`);
          }
        }
        const ext = gcodeExtents(gcode);
        if (ext.width > plate.maxBoundingBoxMm[0]) failures.push(`${tag}: G-code width ${ext.width}mm > ${plate.maxBoundingBoxMm[0]}mm`);
        if (ext.height > plate.maxBoundingBoxMm[1]) failures.push(`${tag}: G-code height ${ext.height}mm > ${plate.maxBoundingBoxMm[1]}mm`);
      }
    }
    assert.deepEqual(failures, [], `Fixture harness failures:\n${failures.join('\n')}`);
  });
}
