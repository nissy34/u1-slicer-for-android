// Mirrors app/src/test/java/com/u1/slicer/SingleColorExtruderConfigTest.kt case by case.
// The Kotlin test models updateSingleColorExtruder's config.copy() locally; same here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sliceConfig } from '../pipeline/slice-config.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

function applyExtruderSelection(config, index, presets) {
  const material = presets.find((p) => p.index === index)?.materialType ?? 'PLA';
  return { ...config, extruderCount: 1, wipeTowerEnabled: false, filamentType: material };
}

const P = (index, materialType) => extruderPreset({ index, materialType });
const presets = [P(0, 'PLA'), P(1, 'TPU'), P(2, 'PETG'), P(3, 'ABS')];

test('selecting E3 PETG updates filamentType from PLA to PETG', () => {
  assert.equal(applyExtruderSelection(sliceConfig(), 2, presets).filamentType, 'PETG', 'Selecting E3 (PETG) must update filamentType');
});

test('selecting E2 TPU updates filamentType from PLA to TPU', () => {
  assert.equal(applyExtruderSelection(sliceConfig(), 1, presets).filamentType, 'TPU');
});

test('selecting E4 ABS updates filamentType', () => {
  assert.equal(applyExtruderSelection(sliceConfig(), 3, presets).filamentType, 'ABS');
});

test('selecting E1 PLA keeps filamentType as PLA', () => {
  assert.equal(applyExtruderSelection(sliceConfig(), 0, presets).filamentType, 'PLA');
});

test('switching from E3 PETG back to E1 PLA restores filamentType', () => {
  const afterE3 = applyExtruderSelection(sliceConfig(), 2, presets);
  assert.equal(afterE3.filamentType, 'PETG');
  assert.equal(applyExtruderSelection(afterE3, 0, presets).filamentType, 'PLA');
});

test('missing extruder preset defaults to PLA', () => {
  assert.equal(applyExtruderSelection(sliceConfig(), 2, [P(0, 'PLA')]).filamentType, 'PLA');
});
