// Mirrors app/src/test/java/com/u1/slicer/FilamentTypeLabelTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFilamentTypeLabel } from '../pipeline/profile-overrides.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

const P = (index, materialType) => extruderPreset({ index, materialType });
const presets = [P(0, 'PLA'), P(1, 'PETG'), P(2, 'PETG'), P(3, 'ABS')];

test('single-color load on E1 PLA returns PLA', () => assert.equal(resolveFilamentTypeLabel([0], presets), 'PLA'));
test('single-color load on E2 PETG returns PETG', () => assert.equal(resolveFilamentTypeLabel([1], presets), 'PETG'));
test('single-color load on E4 ABS returns ABS', () => assert.equal(resolveFilamentTypeLabel([3], presets), 'ABS'));
test('multi-color E1+E2 both PLA returns PLA', () =>
  assert.equal(resolveFilamentTypeLabel([0, 1], [P(0, 'PLA'), P(1, 'PLA')]), 'PLA'));
test('multi-color E2+E3 both PETG returns PETG', () => assert.equal(resolveFilamentTypeLabel([1, 2], presets), 'PETG'));
test('multi-color E1 PLA + E2 PETG returns Mixed', () => assert.equal(resolveFilamentTypeLabel([0, 1], presets), 'Mixed'));
test('multi-color E1 PLA + E4 ABS returns Mixed', () => assert.equal(resolveFilamentTypeLabel([0, 3], presets), 'Mixed'));
test('four-color all different returns Mixed', () => assert.equal(resolveFilamentTypeLabel([0, 1, 2, 3], presets), 'Mixed'));
test('layer-tool with single slot E1 returns PLA', () => assert.equal(resolveFilamentTypeLabel([0], presets), 'PLA'));
test('unknown slot falls back to PLA', () => assert.equal(resolveFilamentTypeLabel([5], presets), 'PLA'));
test('empty slot list falls back to PLA', () => assert.equal(resolveFilamentTypeLabel([], presets), 'PLA'));
test('empty preset list falls back to PLA', () => assert.equal(resolveFilamentTypeLabel([0], []), 'PLA'));
