// Mirrors app/src/test/java/com/u1/slicer/FilamentTypeWiringTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFilamentTypeForSingleColorLoad, resolveFilamentTypeLabelFromMapping } from '../pipeline/profile-overrides.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

const P = (index, materialType) => extruderPreset({ index, materialType });
const presets = [P(0, 'PLA'), P(1, 'PETG'), P(2, 'PETG'), P(3, 'ABS')];

test('single-color initial load uses E1 material', () =>
  assert.equal(resolveFilamentTypeForSingleColorLoad([P(0, 'PETG'), P(1, 'PLA')]), 'PETG'));
test('single-color initial load uses E1 even when other slots differ', () =>
  assert.equal(resolveFilamentTypeForSingleColorLoad(presets), 'PLA'));
test('single-color initial load falls back to PLA when presets empty', () =>
  assert.equal(resolveFilamentTypeForSingleColorLoad([]), 'PLA'));
test('multi-color mapping E1+E2 both PETG returns PETG', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([0, 1], [P(0, 'PETG'), P(1, 'PETG')]), 'PETG'));
test('multi-color mapping E1 PLA + E2 PETG returns Mixed', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([0, 1], presets), 'Mixed'));
test('multi-color mapping deduplicates slots before resolving', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([0, 0, 1, 1], presets), 'Mixed'));
test('multi-color mapping sorts slots before resolving', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([1, 0], presets), 'Mixed'));
test('multi-color mapping with single unique slot returns that material', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([2, 2, 2], presets), 'PETG'));
test('layer-tool single-slot mapping returns that material', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([0, 0], presets), 'PLA'));
test('layer-tool two-slot mapping with same material returns that material', () =>
  assert.equal(resolveFilamentTypeLabelFromMapping([0, 1], [0, 1, 2, 3].map((i) => P(i, 'PETG'))), 'PETG'));
