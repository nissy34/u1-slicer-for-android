// Mirrors app/src/test/java/com/u1/slicer/data/SliceConfigTest.kt case by case.
// Kotlin `copy(...)` -> `{ ...cfg, ... }`. The last test checks toNativeSliceConfig
// (JS-only, no Kotlin counterpart) against sapil_config.cpp's field mapping.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sliceConfig as C, toNativeSliceConfig, NATIVE_FIELD_MAP, SLICE_CONFIG_DEFAULTS } from '../pipeline/slice-config.mjs';

const approx = (a, e, d) => assert.ok(Math.abs(a - e) <= d, `expected ${e} ±${d}, got ${a}`);

test('default values match Snapmaker U1 specs', () => {
  const c = C();
  approx(c.bedSizeX, 270, 0.001);
  approx(c.bedSizeY, 270, 0.001);
  approx(c.maxPrintHeight, 270, 0.001);
});
test('default nozzle diameter is 0_4mm', () => approx(C().nozzleDiameter, 0.4, 0.001));
test('default filament diameter is 1_75mm', () => approx(C().filamentDiameter, 1.75, 0.001));
test('default layer height is 0_2mm', () => {
  approx(C().layerHeight, 0.2, 0.001);
  approx(C().firstLayerHeight, 0.3, 0.001);
});
test('default temperatures are PLA-appropriate', () => {
  const c = C();
  assert.equal(c.nozzleTemp, 210);
  assert.equal(c.bedTemp, 60);
  assert.equal(c.filamentType, 'PLA');
});
test('default support is disabled', () => assert.equal(C().supportEnabled, false));

test('copy preserves scalar fields', () => {
  const config = C({ layerHeight: 0.1, nozzleTemp: 250, bedTemp: 100, supportEnabled: true, fillDensity: 0.5, fillPattern: 'cubic' });
  const copy = { ...config };
  approx(copy.layerHeight, config.layerHeight, 0.001);
  assert.equal(copy.nozzleTemp, config.nozzleTemp);
  assert.equal(copy.bedTemp, config.bedTemp);
  assert.equal(copy.supportEnabled, config.supportEnabled);
  approx(copy.fillDensity, config.fillDensity, 0.001);
  assert.equal(copy.fillPattern, config.fillPattern);
});

test('copy with modification changes only specified field', () => {
  const config = C();
  const modified = { ...config, nozzleTemp: 250 };
  assert.equal(modified.nozzleTemp, 250);
  assert.equal(modified.bedTemp, config.bedTemp);
  approx(modified.layerHeight, config.layerHeight, 0.001);
});

test('data class copy preserves values', () => {
  const a = C({ layerHeight: 0.1 });
  const b = { ...a };
  assert.equal(b.layerHeight, a.layerHeight);
  assert.equal(b.fillDensity, a.fillDensity);
  assert.equal(b.extruderCount, a.extruderCount);
});

test('data class inequality works', () => {
  assert.notDeepEqual(C({ layerHeight: 0.1 }), C({ layerHeight: 0.2 }));
});

test('default fill pattern is gyroid', () => assert.equal(C().fillPattern, 'gyroid'));
test('default fill density is 15 percent', () => approx(C().fillDensity, 0.15, 0.001));
test('default extruder count is 1', () => assert.equal(C().extruderCount, 1));
test('default wipe tower is disabled', () => assert.equal(C().wipeTowerEnabled, false));

test('default wipe tower position is within 270x270 bed', () => {
  const c = C();
  assert.ok(c.wipeTowerX < c.bedSizeX);
  assert.ok(c.wipeTowerY < c.bedSizeY);
  assert.ok(c.wipeTowerWidth > 0);
});

test('default extruder arrays are empty', () => {
  const c = C();
  assert.equal(c.extruderTemps.length, 0);
  assert.equal(c.extruderRetractLength.length, 0);
  assert.equal(c.extruderRetractSpeed.length, 0);
});

test('can set extruder count to 4', () => assert.equal(C({ extruderCount: 4 }).extruderCount, 4));

test('can set per-extruder temperatures', () => {
  const temps = [210, 220, 230, 240];
  assert.deepEqual(C({ extruderCount: 4, extruderTemps: temps }).extruderTemps, temps);
});

test('can set per-extruder retraction', () => {
  approx(C({ extruderCount: 4, extruderRetractLength: [0.8, 0.6, 0.8, 0.8] }).extruderRetractLength[1], 0.6, 0.001);
});

test('wipe tower can be enabled', () => {
  const c = C({ wipeTowerEnabled: true, wipeTowerWidth: 80 });
  assert.ok(c.wipeTowerEnabled);
  approx(c.wipeTowerWidth, 80, 0.001);
});

test('copy preserves extruder count', () => {
  const copy = { ...C({ extruderCount: 3, wipeTowerEnabled: true }) };
  assert.equal(copy.extruderCount, 3);
  assert.ok(copy.wipeTowerEnabled);
});

// --- Wipe tower bounds clamping (mirrors logic in SlicerViewModel.startSlicing) ---
const coerceIn = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function clampWipeTower(cfg) {
  if (!cfg.wipeTowerEnabled) return cfg;
  const maxX = Math.max(cfg.bedSizeX - cfg.wipeTowerWidth, 0);
  const maxY = Math.max(cfg.bedSizeY - cfg.wipeTowerWidth, 0);
  return { ...cfg, wipeTowerX: coerceIn(cfg.wipeTowerX, 0, maxX), wipeTowerY: coerceIn(cfg.wipeTowerY, 0, maxY) };
}

test('wipe tower at x=230 with width 60 is clamped to fit 270mm bed', () => {
  const clamped = clampWipeTower(C({ wipeTowerEnabled: true, wipeTowerX: 230, wipeTowerY: 10, wipeTowerWidth: 60 }));
  approx(clamped.wipeTowerX, 210, 0.001);
  approx(clamped.wipeTowerY, 10, 0.001);
  assert.ok(clamped.wipeTowerX + clamped.wipeTowerWidth <= clamped.bedSizeX);
});

test('wipe tower within bounds is not modified', () => {
  const clamped = clampWipeTower(C({ wipeTowerEnabled: true, wipeTowerX: 170, wipeTowerY: 140, wipeTowerWidth: 60 }));
  approx(clamped.wipeTowerX, 170, 0.001);
  approx(clamped.wipeTowerY, 140, 0.001);
});

test('wipe tower negative position is clamped to zero', () => {
  const clamped = clampWipeTower(C({ wipeTowerEnabled: true, wipeTowerX: -5, wipeTowerY: -10, wipeTowerWidth: 60 }));
  approx(clamped.wipeTowerX, 0, 0.001);
  approx(clamped.wipeTowerY, 0, 0.001);
});

test('wipe tower disabled is not clamped', () => {
  approx(clampWipeTower(C({ wipeTowerEnabled: false, wipeTowerX: 999, wipeTowerY: 999 })).wipeTowerX, 999, 0.001);
});

// JS-only: the JNI mapping covers every Kotlin field exactly once.
test('toNativeSliceConfig maps every SliceConfig field to its sapil field', () => {
  assert.deepEqual(NATIVE_FIELD_MAP.map(([k]) => k).sort(), Object.keys(SLICE_CONFIG_DEFAULTS).sort());
  const n = toNativeSliceConfig(C({ layerHeight: 0.25, perimeters: 3.7, supportEnabled: 1, extruderTemps: [210.9, 220],
    filamentTypes: ['PLA', null], fillPattern: null }));
  assert.equal(n.layer_height, 0.25);
  assert.equal(n.perimeters, 3);
  assert.equal(n.support_enabled, true);
  assert.deepEqual(n.extruder_temps, [210, 220]);
  assert.deepEqual(n.filament_types, ['PLA', '']);
  assert.equal(n.fill_pattern, '');
  assert.equal(n.machine_target, 'SNAPMAKER_U1');
  assert.equal(n.print_speed, 200);
  assert.equal(Object.keys(n).length, NATIVE_FIELD_MAP.length);
});
