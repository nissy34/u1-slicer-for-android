// Mirrors app/src/test/java/com/u1/slicer/data/SlicingOverridesTest.kt case by case.
//   cd wasm/web && node --test test/slicing-overrides.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OverrideMode, OVERRIDE_FIELDS, ORCA_DEFAULTS, SlicingOverrides, overrideValue as OV, slicingOverrides as S,
  layerAndInfillOverrideCount, supportOverrideCount, primeTowerOverrideCount, temperatureOverrideCount,
  otherOverrideCount, totalOverrideCount, resolveInto, resolvePrimeTower, toJson, formatFileValue,
} from '../pipeline/slicing-overrides.mjs';
import { sliceConfig as C } from '../pipeline/slice-config.mjs';
import { buildProfileOverridesImpl as impl, computeTogglePrimeTower } from '../pipeline/profile-overrides.mjs';

const { USE_FILE, ORCA_DEFAULT, OVERRIDE } = OverrideMode;
const fromJson = SlicingOverrides.fromJson;
const approx = (actual, expected, delta, msg) =>
  assert.ok(Math.abs(actual - expected) <= delta, msg ?? `expected ${expected} ±${delta}, got ${actual}`);
const has = (o, k) => Object.hasOwn(o, k);

// ---- F86: override counting helpers ----

test('f86 totalOverrideCount is zero for default overrides', () => {
  assert.equal(totalOverrideCount(S()), 0);
  assert.equal(layerAndInfillOverrideCount(S()), 0);
  assert.equal(supportOverrideCount(S()), 0);
  assert.equal(primeTowerOverrideCount(S()), 0);
  assert.equal(temperatureOverrideCount(S()), 0);
  assert.equal(otherOverrideCount(S()), 0);
});

test('f86 USE_FILE and ORCA_DEFAULT do not count as user overrides', () => {
  const ov = S({ layerHeight: OV(USE_FILE, 0.3), infillDensity: OV(ORCA_DEFAULT, 0.5) });
  assert.equal(totalOverrideCount(ov), 0);
});

test('f86 OVERRIDE in each section increments only that section', () => {
  const layer = S({ layerHeight: OV(OVERRIDE, 0.25) });
  assert.equal(layerAndInfillOverrideCount(layer), 1);
  assert.equal(supportOverrideCount(layer), 0);
  assert.equal(totalOverrideCount(layer), 1);

  const support = S({ supports: OV(OVERRIDE, true) });
  assert.equal(supportOverrideCount(support), 1);
  assert.equal(layerAndInfillOverrideCount(support), 0);

  assert.equal(primeTowerOverrideCount(S({ primeTower: OV(OVERRIDE, true) })), 1);
  assert.equal(temperatureOverrideCount(S({ bedTemp: OV(OVERRIDE, 65) })), 1);
  assert.equal(otherOverrideCount(S({ brimWidth: OV(OVERRIDE, 2) })), 1);
});

test('f86 totalOverrideCount sums across sections', () => {
  const ov = S({
    layerHeight: OV(OVERRIDE, 0.25),
    infillDensity: OV(OVERRIDE, 0.4),
    supports: OV(OVERRIDE, true),
    primeTower: OV(OVERRIDE, false),
    bedTemp: OV(OVERRIDE, 65),
    skirtLoops: OV(OVERRIDE, 3),
  });
  assert.equal(layerAndInfillOverrideCount(ov), 2);
  assert.equal(supportOverrideCount(ov), 1);
  assert.equal(primeTowerOverrideCount(ov), 1);
  assert.equal(temperatureOverrideCount(ov), 1);
  assert.equal(otherOverrideCount(ov), 1);
  assert.equal(totalOverrideCount(ov), 6);
});

test('f86 flowCalibration is excluded from override counts', () => {
  assert.equal(totalOverrideCount(S({ flowCalibration: false })), 0);
});

test('f86 every OverrideValue field is bucketed into exactly one section count', () => {
  // Reflective guard: every OverrideValue field of slicingOverrides() must be
  // counted by exactly one section counter.
  const fieldNames = Object.entries(S())
    .filter(([, v]) => v && typeof v === 'object' && 'mode' in v)
    .map(([k]) => k);
  assert.equal(fieldNames.length, OVERRIDE_FIELDS.length);
  const placeholder = { int: 1, float: 1, boolean: true, string: 'x' };
  const sections = [layerAndInfillOverrideCount, supportOverrideCount, primeTowerOverrideCount,
    temperatureOverrideCount, otherOverrideCount];
  const unbucketed = [];
  for (const [name, type] of OVERRIDE_FIELDS) {
    const mutated = S({ [name]: OV(OVERRIDE, placeholder[type]) });
    const counts = sections.map((fn) => fn(mutated));
    const hits = counts.filter((c) => c === 1).length;
    if (hits !== 1 || counts.reduce((a, b) => a + b, 0) !== 1) unbucketed.push(`${name} -> ${counts}`);
  }
  assert.ok(unbucketed.length === 0, `Fields not bucketed into exactly one section counter:\n${unbucketed.join('\n')}`);
});

test('f86 reset preserves flowCalibration but clears all override modes', () => {
  const customised = S({ layerHeight: OV(OVERRIDE, 0.25), bedTemp: OV(OVERRIDE, 65), flowCalibration: false });
  const reset = S({ flowCalibration: customised.flowCalibration });
  assert.equal(totalOverrideCount(reset), 0);
  assert.equal(reset.flowCalibration, false);
  assert.equal(reset.layerHeight.mode, USE_FILE);
  assert.equal(reset.bedTemp.mode, USE_FILE);
});

test('default overrides are all USE_FILE', () => {
  const o = S();
  for (const k of ['layerHeight', 'infillDensity', 'wallCount', 'infillPattern', 'reduceInfillRetraction',
    'wallGenerator', 'seamPosition', 'supports', 'brimWidth', 'skirtLoops', 'bedTemp', 'primeTower']) {
    assert.equal(o[k].mode, USE_FILE, k);
  }
  assert.ok(o.flowCalibration);
});

test('default overrides have null values', () => {
  const o = S();
  assert.equal(o.layerHeight.value, null);
  assert.equal(o.infillDensity.value, null);
  assert.equal(o.wallCount.value, null);
});

test('serialization round-trip preserves defaults', () => {
  const original = S();
  const restored = fromJson(toJson(original));
  assert.equal(restored.layerHeight.mode, original.layerHeight.mode);
  assert.equal(restored.infillDensity.mode, original.infillDensity.mode);
  assert.equal(restored.flowCalibration, original.flowCalibration);
});

test('serialization round-trip preserves OVERRIDE values', () => {
  const original = S({
    layerHeight: OV(OVERRIDE, 0.3),
    infillDensity: OV(OVERRIDE, 0.30),
    wallCount: OV(OVERRIDE, 4),
    infillPattern: OV(OVERRIDE, 'grid'),
    supports: OV(OVERRIDE, true),
    brimWidth: OV(OVERRIDE, 5.0),
    skirtLoops: OV(OVERRIDE, 3),
    bedTemp: OV(OVERRIDE, 80),
    primeTower: OV(OVERRIDE, true),
    flowCalibration: false,
  });
  const restored = fromJson(toJson(original));
  assert.equal(restored.layerHeight.mode, OVERRIDE);
  approx(restored.layerHeight.value, 0.3, 0.001);
  assert.equal(restored.infillDensity.mode, OVERRIDE);
  approx(restored.infillDensity.value, 0.30, 0.001);
  assert.equal(restored.wallCount.mode, OVERRIDE);
  assert.equal(restored.wallCount.value, 4);
  assert.equal(restored.infillPattern.mode, OVERRIDE);
  assert.equal(restored.infillPattern.value, 'grid');
  assert.equal(restored.supports.mode, OVERRIDE);
  assert.ok(restored.supports.value);
  assert.equal(restored.brimWidth.mode, OVERRIDE);
  approx(restored.brimWidth.value, 5.0, 0.001);
  assert.equal(restored.skirtLoops.mode, OVERRIDE);
  assert.equal(restored.skirtLoops.value, 3);
  assert.equal(restored.bedTemp.mode, OVERRIDE);
  assert.equal(restored.bedTemp.value, 80);
  assert.equal(restored.primeTower.mode, OVERRIDE);
  assert.ok(restored.primeTower.value);
  assert.equal(restored.flowCalibration, false);
});

test('serialization round-trip preserves ORCA_DEFAULT mode', () => {
  const restored = fromJson(toJson(S({ layerHeight: OV(ORCA_DEFAULT), wallCount: OV(ORCA_DEFAULT) })));
  assert.equal(restored.layerHeight.mode, ORCA_DEFAULT);
  assert.equal(restored.wallCount.mode, ORCA_DEFAULT);
});

test('fromJson handles empty string', () => {
  const restored = fromJson('');
  assert.equal(restored.layerHeight.mode, USE_FILE);
  assert.ok(restored.flowCalibration);
});

test('fromJson handles malformed JSON', () => {
  assert.equal(fromJson('{invalid json').layerHeight.mode, USE_FILE);
});

test('fromJson handles missing fields', () => {
  const restored = fromJson('{"flowCalibration": false}');
  assert.equal(restored.layerHeight.mode, USE_FILE);
  assert.equal(restored.flowCalibration, false);
});

test('fromJson handles unknown mode gracefully', () => {
  const restored = fromJson('{"layerHeight":{"mode":"UNKNOWN_MODE","value":0.3}}');
  assert.equal(restored.layerHeight.mode, USE_FILE);
});

test('ORCA_DEFAULTS contains expected keys', () => {
  const d = SlicingOverrides.ORCA_DEFAULTS;
  assert.equal(d.layerHeight, 0.2);
  assert.equal(d.infillDensity, 0.15);
  assert.equal(d.wallCount, 2);
  assert.equal(d.infillPattern, 'gyroid');
  assert.equal(d.reduceInfillRetraction, false);
  assert.equal(d.wallGenerator, 'arachne');
  assert.equal(d.seamPosition, 'aligned');
  assert.equal(d.supports, false);
  assert.equal(d.brimWidth, 0);
  assert.equal(d.skirtLoops, 0);
  assert.equal(d.bedTemp, 60);
  assert.equal(d.primeTower, false);
});

test('mixed modes serialize correctly', () => {
  const restored = fromJson(toJson(S({
    layerHeight: OV(USE_FILE), infillDensity: OV(ORCA_DEFAULT), wallCount: OV(OVERRIDE, 3),
  })));
  assert.equal(restored.layerHeight.mode, USE_FILE);
  assert.equal(restored.infillDensity.mode, ORCA_DEFAULT);
  assert.equal(restored.wallCount.mode, OVERRIDE);
  assert.equal(restored.wallCount.value, 3);
});

// --- resolveInto ---

test('resolveInto USE_FILE keeps base values', () => {
  const base = C({ layerHeight: 0.3, fillDensity: 0.20, perimeters: 3, supportEnabled: true, brimWidth: 5,
    skirtLoops: 2, bedTemp: 70, wipeTowerEnabled: true });
  const r = resolveInto(S(), base);
  approx(r.layerHeight, 0.3, 0.001);
  approx(r.fillDensity, 0.20, 0.001);
  assert.equal(r.perimeters, 3);
  assert.ok(r.supportEnabled);
  approx(r.brimWidth, 5, 0.001);
  assert.equal(r.skirtLoops, 2);
  assert.equal(r.bedTemp, 70);
  assert.ok(r.wipeTowerEnabled);
});

test('resolveInto ORCA_DEFAULT replaces with factory defaults', () => {
  const base = C({ layerHeight: 0.3, fillDensity: 0.40, perimeters: 5, fillPattern: 'grid', supportEnabled: true,
    brimWidth: 8, skirtLoops: 3, bedTemp: 90, wipeTowerEnabled: true });
  const ov = S({
    layerHeight: OV(ORCA_DEFAULT), infillDensity: OV(ORCA_DEFAULT), wallCount: OV(ORCA_DEFAULT),
    infillPattern: OV(ORCA_DEFAULT), supports: OV(ORCA_DEFAULT), brimWidth: OV(ORCA_DEFAULT),
    skirtLoops: OV(ORCA_DEFAULT), bedTemp: OV(ORCA_DEFAULT), primeTower: OV(ORCA_DEFAULT),
  });
  const r = resolveInto(ov, base);
  approx(r.layerHeight, 0.2, 0.001);
  approx(r.fillDensity, 0.15, 0.001);
  assert.equal(r.perimeters, 2);
  assert.equal(r.fillPattern, 'gyroid');
  assert.equal(r.supportEnabled, false);
  approx(r.brimWidth, 0, 0.001);
  assert.equal(r.skirtLoops, 0);
  assert.equal(r.bedTemp, 60);
  assert.equal(r.wipeTowerEnabled, false);
});

test('resolveInto OVERRIDE uses user value', () => {
  const base = C({ layerHeight: 0.2, fillDensity: 0.15, perimeters: 2, supportEnabled: false, brimWidth: 0,
    skirtLoops: 0, bedTemp: 60, wipeTowerEnabled: false });
  const ov = S({
    layerHeight: OV(OVERRIDE, 0.15), infillDensity: OV(OVERRIDE, 0.30), wallCount: OV(OVERRIDE, 4),
    supports: OV(OVERRIDE, true), brimWidth: OV(OVERRIDE, 6), skirtLoops: OV(OVERRIDE, 2),
    bedTemp: OV(OVERRIDE, 75), primeTower: OV(OVERRIDE, true),
  });
  const r = resolveInto(ov, base);
  approx(r.layerHeight, 0.15, 0.001);
  approx(r.fillDensity, 0.30, 0.001);
  assert.equal(r.perimeters, 4);
  assert.ok(r.supportEnabled);
  approx(r.brimWidth, 6, 0.001);
  assert.equal(r.skirtLoops, 2);
  assert.equal(r.bedTemp, 75);
  assert.ok(r.wipeTowerEnabled);
});

test('resolveInto OVERRIDE with null value falls back to base', () => {
  const base = C({ layerHeight: 0.25, perimeters: 3 });
  const r = resolveInto(S({ layerHeight: OV(OVERRIDE, null), wallCount: OV(OVERRIDE, null) }), base);
  approx(r.layerHeight, 0.25, 0.001);
  assert.equal(r.perimeters, 3);
});

test('resolveInto mixed modes', () => {
  const base = C({ layerHeight: 0.3, fillDensity: 0.20, perimeters: 3, supportEnabled: true });
  const r = resolveInto(S({
    layerHeight: OV(USE_FILE), infillDensity: OV(ORCA_DEFAULT), wallCount: OV(OVERRIDE, 5), supports: OV(ORCA_DEFAULT),
  }), base);
  approx(r.layerHeight, 0.3, 0.001);
  approx(r.fillDensity, 0.15, 0.001);
  assert.equal(r.perimeters, 5);
  assert.equal(r.supportEnabled, false);
});

// --- Multi-extruder wipe tower regression ---

test('resolveInto ORCA_DEFAULT primeTower preserves wipe tower for multi-extruder', () => {
  const r = resolveInto(S({ primeTower: OV(ORCA_DEFAULT) }), C({ wipeTowerEnabled: true, extruderCount: 2 }));
  assert.ok(r.wipeTowerEnabled, 'Multi-extruder slice must keep wipeTowerEnabled=true regardless of primeTower override');
});

test('resolveInto ORCA_DEFAULT primeTower disables wipe tower for single-extruder', () => {
  const r = resolveInto(S({ primeTower: OV(ORCA_DEFAULT) }), C({ wipeTowerEnabled: true, extruderCount: 1 }));
  assert.equal(r.wipeTowerEnabled, false, 'Single-extruder slice with ORCA_DEFAULT primeTower should disable wipe tower');
});

test('resolveInto OVERRIDE primeTower false is respected for multi-extruder', () => {
  const r = resolveInto(S({ primeTower: OV(OVERRIDE, false) }), C({ wipeTowerEnabled: true, extruderCount: 2 }));
  assert.equal(r.wipeTowerEnabled, false, 'Explicit OVERRIDE primeTower=false must be respected regardless of extruder count');
});

// --- resolvePrimeTower (profile-embed path) ---

test('resolvePrimeTower ORCA_DEFAULT preserves prime tower for multi-extruder', () => {
  assert.ok(resolvePrimeTower(S({ primeTower: OV(ORCA_DEFAULT) }), 2, true));
});

test('resolvePrimeTower USE_FILE with multi-extruder preserves prime tower', () => {
  assert.ok(resolvePrimeTower(S(), 2, true));
});

test('resolvePrimeTower ORCA_DEFAULT with single-extruder disables prime tower', () => {
  assert.equal(resolvePrimeTower(S({ primeTower: OV(ORCA_DEFAULT) }), 1, false), false);
});

test('resolvePrimeTower OVERRIDE false is respected for multi-extruder', () => {
  assert.equal(resolvePrimeTower(S({ primeTower: OV(OVERRIDE, false) }), 2, true), false);
});

test('resolvePrimeTower OVERRIDE true is returned for single-extruder', () => {
  assert.ok(resolvePrimeTower(S({ primeTower: OV(OVERRIDE, true) }), 1, false));
});

test('resolveInto does not modify base config', () => {
  const base = C({ layerHeight: 0.2, perimeters: 2 });
  resolveInto(S({ layerHeight: OV(OVERRIDE, 0.1), wallCount: OV(ORCA_DEFAULT) }), base);
  approx(base.layerHeight, 0.2, 0.001);
  assert.equal(base.perimeters, 2);
});

// --- resolveInto: B79 supportType and supportAngle ---

test('resolveInto OVERRIDE supportType passes value to SliceConfig', () => {
  const r = resolveInto(S({ supportType: OV(OVERRIDE, 'tree(auto)') }), C({ supportType: 'normal' }));
  assert.equal(r.supportType, 'tree(auto)');
});

test('resolveInto ORCA_DEFAULT supportType uses factory default', () => {
  const r = resolveInto(S({ supportType: OV(ORCA_DEFAULT) }), C({ supportType: 'tree(auto)' }));
  assert.equal(r.supportType, 'normal(auto)');
});

test('resolveInto USE_FILE supportType keeps base value', () => {
  assert.equal(resolveInto(S(), C({ supportType: 'tree(manual)' })).supportType, 'tree(manual)');
});

test('resolveInto OVERRIDE supportAngle passes value to SliceConfig', () => {
  approx(resolveInto(S({ supportAngle: OV(OVERRIDE, 30) }), C({ supportAngle: 45 })).supportAngle, 30, 0.001);
});

test('resolveInto ORCA_DEFAULT supportAngle uses factory default', () => {
  approx(resolveInto(S({ supportAngle: OV(ORCA_DEFAULT) }), C({ supportAngle: 45 })).supportAngle, 30, 0.001);
});

// --- buildProfileOverridesImpl tests (B10 support preservation) ---

test('buildProfileOverrides omits support keys for Bambu file with USE_FILE mode', () => {
  const r = impl(C({ supportEnabled: false }), S(), { slotCount: 1, hasSourceConfig: true });
  assert.ok(!has(r, 'enable_support'), 'enable_support should be omitted for Bambu USE_FILE');
  assert.ok(!has(r, 'support_threshold_angle'), 'support_threshold_angle should be omitted for Bambu USE_FILE');
});

test('buildProfileOverrides includes support keys for STL file with USE_FILE mode', () => {
  const r = impl(C({ supportEnabled: true, supportAngle: 45 }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.enable_support, '1');
  assert.equal(r.support_threshold_angle, '45');
});

test('buildProfileOverrides includes support keys when user sets OVERRIDE mode on Bambu file', () => {
  const r = impl(C({ supportEnabled: false }), S({ supports: OV(OVERRIDE, true) }), { slotCount: 1, hasSourceConfig: true });
  assert.equal(r.enable_support, '1');
});

test('buildProfileOverrides includes support keys when user sets ORCA_DEFAULT mode on Bambu file', () => {
  const r = impl(C({ supportEnabled: true }), S({ supports: OV(ORCA_DEFAULT, null) }), { slotCount: 1, hasSourceConfig: true });
  assert.ok(has(r, 'enable_support'), 'enable_support should be present for ORCA_DEFAULT');
});

test('buildProfileOverrides STL with support disabled emits 0', () => {
  const r = impl(C({ supportEnabled: false, supportAngle: 30 }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.enable_support, '0');
  assert.equal(r.support_threshold_angle, '30');
});

// --- B125 ---

test('B125 support_filament emitted for Bambu file when supportFilament is OVERRIDE', () => {
  const cfg = C({ supportFilament: 4, supportInterfaceFilament: 4 });
  const ov = S({ supports: OV(USE_FILE), supportFilament: OV(OVERRIDE, 4), supportInterfaceFilament: OV(OVERRIDE, 4) });
  const r = impl(cfg, ov, { slotCount: 4, hasSourceConfig: true });
  assert.equal(r.support_filament, '4', 'support_filament must be emitted when OVERRIDE');
  assert.equal(r.support_interface_filament, '4', 'support_interface_filament must be emitted when OVERRIDE');
  assert.ok(!has(r, 'enable_support'), 'enable_support should still be omitted');
});

test('B125 support_filament omitted for Bambu file when supportFilament is USE_FILE', () => {
  const r = impl(C({ supportFilament: 2 }), S({ supports: OV(USE_FILE), supportFilament: OV(USE_FILE) }),
    { slotCount: 2, hasSourceConfig: true });
  assert.ok(!has(r, 'support_filament'), 'support_filament should be omitted when USE_FILE + hasSourceConfig');
});

test('B125 support_filament emitted for STL file when OVERRIDE mode', () => {
  const r = impl(C(), S({ supports: OV(USE_FILE), supportFilament: OV(OVERRIDE, 3) }), { slotCount: 3, hasSourceConfig: false });
  assert.equal(r.support_filament, '3', 'support_filament must be emitted for STL when OVERRIDE');
});

test('B125 siblings support_type emitted for Bambu file when OVERRIDE even with supports USE_FILE', () => {
  const r = impl(C(), S({ supports: OV(USE_FILE), supportType: OV(OVERRIDE, 'tree(auto)') }), { slotCount: 4, hasSourceConfig: true });
  assert.equal(r.support_type, 'tree(auto)', 'B125 sibling: support_type must be emitted when OVERRIDE');
  assert.ok(!has(r, 'enable_support'), 'enable_support must remain omitted');
});

test('B125 siblings support_type omitted for Bambu file when USE_FILE and supports USE_FILE', () => {
  const r = impl(C(), S({ supports: OV(USE_FILE), supportType: OV(USE_FILE) }), { slotCount: 4, hasSourceConfig: true });
  assert.ok(!has(r, 'support_type'), 'B125 sibling: support_type must be omitted when both USE_FILE + hasSourceConfig');
});

test('B125 siblings supportSpeed emitted for Bambu file when OVERRIDE even with supports USE_FILE', () => {
  const r = impl(C(), S({ supports: OV(USE_FILE), supportSpeed: OV(OVERRIDE, 80) }), { slotCount: 4, hasSourceConfig: true });
  assert.equal(r.support_speed, '80', 'B125 sibling: support_speed must be emitted when OVERRIDE');
  assert.ok(!has(r, 'enable_support'), 'enable_support must remain omitted');
});

// --- B100: layer_height ---

test('buildProfileOverrides omits layer_height for USE_FILE mode so source 3MF value survives', () => {
  const r = impl(C({ layerHeight: 0.2 }), S(), { slotCount: 1, hasSourceConfig: true });
  assert.ok(!has(r, 'layer_height'), 'layer_height should be omitted for USE_FILE');
});

test('buildProfileOverrides includes layer_height for OVERRIDE mode', () => {
  const r = impl(C({ layerHeight: 0.2 }), S({ layerHeight: OV(OVERRIDE, 0.12) }), { slotCount: 1, hasSourceConfig: true });
  assert.equal(r.layer_height, '0.12');
});

test('buildProfileOverrides includes layer_height for ORCA_DEFAULT mode with default value', () => {
  const r = impl(C({ layerHeight: 0.3 }), S({ layerHeight: OV(ORCA_DEFAULT, null) }), { slotCount: 1, hasSourceConfig: true });
  assert.equal(r.layer_height, '0.2');
});

test('buildProfileOverrides omits layer_height for USE_FILE on STL file too', () => {
  const r = impl(C({ layerHeight: 0.2 }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.ok(!has(r, 'layer_height'), 'layer_height omitted for STL USE_FILE too — process profile provides it');
});

// --- F8: Support extruder override tests ---

test('default supportFilament and supportInterfaceFilament are USE_FILE', () => {
  assert.equal(S().supportFilament.mode, USE_FILE);
  assert.equal(S().supportInterfaceFilament.mode, USE_FILE);
});

test('serialization round-trip preserves support extruder overrides', () => {
  const restored = fromJson(toJson(S({ supportFilament: OV(OVERRIDE, 2), supportInterfaceFilament: OV(OVERRIDE, 3) })));
  assert.equal(restored.supportFilament.mode, OVERRIDE);
  assert.equal(restored.supportFilament.value, 2);
  assert.equal(restored.supportInterfaceFilament.mode, OVERRIDE);
  assert.equal(restored.supportInterfaceFilament.value, 3);
});

test('ORCA_DEFAULTS contains support extruder keys', () => {
  assert.equal(ORCA_DEFAULTS.supportFilament, 0);
  assert.equal(ORCA_DEFAULTS.supportInterfaceFilament, 0);
});

test('buildProfileOverrides includes support_filament when overridden to non-zero', () => {
  const r = impl(C(), S({
    supports: OV(OVERRIDE, true), supportFilament: OV(OVERRIDE, 2), supportInterfaceFilament: OV(OVERRIDE, 3),
  }), { slotCount: 4, hasSourceConfig: false });
  assert.equal(r.support_filament, '2');
  assert.equal(r.support_interface_filament, '3');
});

test('support filament override grows per-filament arrays to requested index', () => {
  const r = impl(C({ nozzleTemp: 225 }), S({ supports: OV(OVERRIDE, true), supportFilament: OV(OVERRIDE, 4) }), {
    slotCount: 1, filamentCount: 1, hasSourceConfig: false,
    filamentTypes: ['TPU'], nozzleTemps: [225], filamentColours: ['#112233'],
  });
  assert.equal(r.support_filament, '4');
  assert.deepEqual(r.filament_type, ['TPU', 'PLA', 'PLA', 'PLA']);
  assert.deepEqual(r.nozzle_temperature, ['225', '225', '225', '225']);
  assert.deepEqual(r.filament_colour, ['#112233', '#FFFFFF', '#FFFFFF', '#FFFFFF']);
});

test('support interface filament override grows per-filament arrays to requested index', () => {
  const r = impl(C({ nozzleTemp: 220 }), S({ supports: OV(OVERRIDE, true), supportInterfaceFilament: OV(OVERRIDE, 3) }), {
    slotCount: 1, filamentCount: 1, hasSourceConfig: false, filamentTypes: ['TPU'], nozzleTemps: [225],
  });
  assert.equal(r.support_interface_filament, '3');
  assert.deepEqual(r.filament_type, ['TPU', 'PLA', 'PLA']);
  assert.deepEqual(r.nozzle_temperature, ['225', '220', '220']);
});

test('buildProfileOverrides omits support_filament when default (0)', () => {
  const r = impl(C(), S({ supports: OV(OVERRIDE, true), supportFilament: OV(OVERRIDE, 0) }), { slotCount: 1, hasSourceConfig: false });
  assert.ok(!has(r, 'support_filament'), 'support_filament should be omitted when 0 (default)');
});

// --- B24 ---

test('resolveInto with extruderCount 1 and wipeTowerEnabled false stays false', () => {
  const r = resolveInto(S(), C({ extruderCount: 1, wipeTowerEnabled: false }));
  assert.equal(r.wipeTowerEnabled, false, 'Single-extruder model with wipeTowerEnabled=false must stay false');
});

test('buildProfileOverrides with stale wipeTowerEnabled produces correct prime tower flag', () => {
  const r = impl(C({ extruderCount: 1, wipeTowerEnabled: false }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.enable_prime_tower, '0', 'Single-extruder with wipeTowerEnabled=false should have enable_prime_tower=0');
});

test('buildProfileOverrides single-extruder with stale wipeTowerEnabled true still produces 1', () => {
  const r = impl(C({ extruderCount: 1, wipeTowerEnabled: true }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.enable_prime_tower, '1', 'USE_FILE passes through cfgWipeTower value');
});

// --- B17: skirt_height ---

test('buildProfileOverrides sets skirt_height 0 when skirt_loops is 0', () => {
  const r = impl(C({ skirtLoops: 0 }), S(), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.skirt_loops, '0');
  assert.equal(r.skirt_height, '0');
});

test('buildProfileOverrides sets skirt_height 1 when skirt_loops greater than 0', () => {
  const r = impl(C({ skirtLoops: 0 }), S({ skirtLoops: OV(OVERRIDE, 3) }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.skirt_loops, '3');
  assert.equal(r.skirt_height, '1');
});

test('buildProfileOverrides skirt_height 0 when ORCA_DEFAULT skirt_loops resolves to 0', () => {
  const r = impl(C({ skirtLoops: 2 }), S({ skirtLoops: OV(ORCA_DEFAULT) }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.skirt_loops, '0');
  assert.equal(r.skirt_height, '0');
});

// --- B31 ---

test('buildProfileOverrides emits no_brim when brim_width is 0', () => {
  const r = impl(C({ brimWidth: 0 }), S(), { slotCount: 1, hasSourceConfig: true });
  assert.equal(r.brim_type, 'no_brim');
  assert.equal(r.brim_width, '0.0');
});

test('buildProfileOverrides emits manual_brim when brim_width is positive', () => {
  const r = impl(C({ brimWidth: 0 }), S({ brimWidth: OV(OVERRIDE, 5) }), { slotCount: 1, hasSourceConfig: true });
  assert.equal(r.brim_type, 'manual_brim');
  assert.equal(r.brim_width, '5.0');
});

// --- F30/F31 ---

test('default new overrides are all USE_FILE', () => {
  const o = S();
  for (const k of ['topShellLayers', 'bottomShellLayers', 'topSurfacePattern', 'bottomSurfacePattern', 'sparseInfillSpeed',
    'supportXyDistance', 'supportInterfacePattern', 'supportInterfaceSpacing', 'supportSpeed', 'treeSupportBranchAngle',
    'treeSupportBranchDistance', 'treeSupportBranchDiameter']) {
    assert.equal(o[k].mode, USE_FILE, k);
  }
});

test('serialization round-trip preserves new override fields', () => {
  const restored = fromJson(toJson(S({
    topShellLayers: OV(OVERRIDE, 4),
    bottomShellLayers: OV(OVERRIDE, 3),
    topSurfacePattern: OV(OVERRIDE, 'monotonic'),
    bottomSurfacePattern: OV(OVERRIDE, 'rectilinear'),
    sparseInfillSpeed: OV(OVERRIDE, 150),
    supportXyDistance: OV(OVERRIDE, 0.3),
    supportInterfacePattern: OV(OVERRIDE, 'rectilinear'),
    supportInterfaceSpacing: OV(OVERRIDE, 0.2),
    supportSpeed: OV(OVERRIDE, 80),
    treeSupportBranchAngle: OV(OVERRIDE, 40),
    treeSupportBranchDistance: OV(OVERRIDE, 5.0),
    treeSupportBranchDiameter: OV(OVERRIDE, 2.0),
  })));
  assert.equal(restored.topShellLayers.mode, OVERRIDE);
  assert.equal(restored.topShellLayers.value, 4);
  assert.equal(restored.bottomShellLayers.mode, OVERRIDE);
  assert.equal(restored.bottomShellLayers.value, 3);
  assert.equal(restored.topSurfacePattern.value, 'monotonic');
  assert.equal(restored.bottomSurfacePattern.value, 'rectilinear');
  assert.equal(restored.sparseInfillSpeed.value, 150);
  approx(restored.supportXyDistance.value, 0.3, 0.001);
  assert.equal(restored.supportInterfacePattern.value, 'rectilinear');
  approx(restored.supportInterfaceSpacing.value, 0.2, 0.001);
  assert.equal(restored.supportSpeed.value, 80);
  assert.equal(restored.treeSupportBranchAngle.value, 40);
  approx(restored.treeSupportBranchDistance.value, 5.0, 0.001);
  approx(restored.treeSupportBranchDiameter.value, 2.0, 0.001);
});

test('buildProfileOverrides emits top and bottom shell layers when overridden', () => {
  const r = impl(C(), S({ topShellLayers: OV(OVERRIDE, 5), bottomShellLayers: OV(OVERRIDE, 4) }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.top_shell_layers, '5');
  assert.equal(r.bottom_shell_layers, '4');
});

test('buildProfileOverrides emits surface patterns when overridden', () => {
  const r = impl(C(), S({ topSurfacePattern: OV(OVERRIDE, 'concentric'), bottomSurfacePattern: OV(OVERRIDE, 'monotonic') }),
    { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.top_surface_pattern, 'concentric');
  assert.equal(r.bottom_surface_pattern, 'monotonic');
});

test('buildProfileOverrides emits sparse infill speed when overridden and nonzero', () => {
  const r = impl(C(), S({ sparseInfillSpeed: OV(OVERRIDE, 200) }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.sparse_infill_speed, '200');
});

test('buildProfileOverrides omits sparse infill speed when zero (auto)', () => {
  const r = impl(C(), S({ sparseInfillSpeed: OV(OVERRIDE, 0) }), { slotCount: 1, hasSourceConfig: false });
  assert.ok(!has(r, 'sparse_infill_speed'), 'sparse_infill_speed=0 means auto — must not be emitted');
});

test('buildProfileOverrides emits support detail keys when overridden', () => {
  const r = impl(C(), S({
    supportXyDistance: OV(OVERRIDE, 0.35), supportInterfacePattern: OV(OVERRIDE, 'rectilinear'),
    supportInterfaceSpacing: OV(OVERRIDE, 0.2), supportSpeed: OV(OVERRIDE, 60),
  }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.support_object_xy_distance, '0.35');
  assert.equal(r.support_interface_pattern, 'rectilinear');
  assert.equal(r.support_interface_spacing, '0.2');
  assert.equal(r.support_speed, '60');
});

test('buildProfileOverrides omits support speed when zero (auto)', () => {
  const r = impl(C(), S({ supportSpeed: OV(OVERRIDE, 0) }), { slotCount: 1, hasSourceConfig: false });
  assert.ok(!has(r, 'support_speed'), 'support_speed=0 means auto — must not be emitted');
});

test('buildProfileOverrides emits tree support params only when tree support is active', () => {
  const r = impl(C(), S({
    supports: OV(OVERRIDE, true), supportType: OV(OVERRIDE, 'tree(auto)'), treeSupportBranchAngle: OV(OVERRIDE, 45),
    treeSupportBranchDistance: OV(OVERRIDE, 6.0), treeSupportBranchDiameter: OV(OVERRIDE, 2.5),
  }), { slotCount: 1, hasSourceConfig: false });
  assert.equal(r.tree_support_branch_angle, '45');
  assert.equal(r.tree_support_branch_distance, '6.0');
  assert.equal(r.tree_support_branch_diameter, '2.5');
});

test('buildProfileOverrides omits tree support params when normal support is active', () => {
  const r = impl(C(), S({
    supports: OV(OVERRIDE, true), supportType: OV(OVERRIDE, 'normal(auto)'), treeSupportBranchAngle: OV(OVERRIDE, 45),
  }), { slotCount: 1, hasSourceConfig: false });
  assert.ok(!has(r, 'tree_support_branch_angle'), 'tree params must not appear for normal support');
});

test('F41 F42 serialization round-trip for new override fields', () => {
  const restored = fromJson(toJson(S({
    reduceInfillRetraction: OV(OVERRIDE, true), wallGenerator: OV(OVERRIDE, 'classic'), seamPosition: OV(OVERRIDE, 'back'),
  })));
  assert.equal(restored.reduceInfillRetraction.mode, OVERRIDE);
  assert.ok(restored.reduceInfillRetraction.value);
  assert.equal(restored.wallGenerator.mode, OVERRIDE);
  assert.equal(restored.wallGenerator.value, 'classic');
  assert.equal(restored.seamPosition.mode, OVERRIDE);
  assert.equal(restored.seamPosition.value, 'back');
});

test('F41 F42 buildProfileOverrides emits new keys', () => {
  const r = impl(C(), S({
    reduceInfillRetraction: OV(OVERRIDE, true), wallGenerator: OV(OVERRIDE, 'classic'), seamPosition: OV(OVERRIDE, 'back'),
  }), 1);
  assert.equal(r.reduce_infill_retraction, '1');
  assert.equal(r.wall_generator, 'classic');
  assert.equal(r.seam_position, 'back');
});

test('F41 reduceInfillRetraction defaults to false (0)', () => {
  assert.equal(impl(C(), S({ reduceInfillRetraction: OV(ORCA_DEFAULT) }), 1).reduce_infill_retraction, '0');
});

test('F42 wallGenerator defaults to arachne', () => {
  assert.equal(impl(C(), S({ wallGenerator: OV(ORCA_DEFAULT) }), 1).wall_generator, 'arachne');
});

test('F42 seamPosition defaults to aligned', () => {
  assert.equal(impl(C(), S({ seamPosition: OV(ORCA_DEFAULT) }), 1).seam_position, 'aligned');
});

test('formatFileValue boolean true shows on', () => assert.equal(formatFileValue(true), 'on'));
test('formatFileValue boolean false shows off', () => assert.equal(formatFileValue(false), 'off'));
test('formatFileValue string 1 shows on', () => assert.equal(formatFileValue('1'), 'on'));
test('formatFileValue string 0 shows off', () => assert.equal(formatFileValue('0'), 'off'));
test('formatFileValue percentage passes through', () => assert.equal(formatFileValue('15%'), '15%'));
test('formatFileValue enum with parens strips parens', () => assert.equal(formatFileValue('normal(auto)'), 'Normal'));

test('formatFileValue underscore enum title-cases', () => {
  assert.equal(formatFileValue('aligned_back'), 'Aligned Back');
  assert.equal(formatFileValue('arachne'), 'Arachne');
  assert.equal(formatFileValue('gyroid'), 'Gyroid');
});

test('formatFileValue number passes through', () => {
  assert.equal(formatFileValue(0.2), '0.2');
  assert.equal(formatFileValue(30), '30');
});

test('formatFileValue list takes first element', () => {
  assert.equal(formatFileValue(['1', '1']), 'on');
  assert.equal(formatFileValue([60, 60]), '60');
});

// --- B105 ---

test('B105 single-slot nozzle_temperature has exactly 1 element when slotCount is 1', () => {
  const r = impl(C({ nozzleTemp: 220 }), S(), { slotCount: 1, nozzleTemps: [220] });
  assert.equal(r.nozzle_temperature?.length, 1, 'B105: single-slot E3 must produce exactly 1 nozzle_temperature entry');
});

test('B105 single-slot filament_type has exactly 1 element when slotCount is 1', () => {
  const r = impl(C({ nozzleTemp: 220 }), S(), { slotCount: 1, filamentTypes: ['PLA'] });
  assert.equal(r.filament_type?.length, 1, 'B105: single-slot E3 must produce exactly 1 filament_type entry');
});

test('buildProfileOverrides nozzle_temperature length matches compact extruder count not raw slot list size', () => {
  const r = impl(C({ nozzleTemp: 220 }), S(), { slotCount: 3, hasSourceConfig: false });
  assert.equal(r.nozzle_temperature?.length, 3, 'nozzle_temperature should have 3 entries for 3-extruder SEMM job');
});

// --- primeTowerWidth and wipeTowerRotationAngle overrides ---

test('primeTowerWidth OVERRIDE resolves into wipeTowerWidth', () => {
  approx(resolveInto(S({ primeTowerWidth: OV(OVERRIDE, 20) }), C({ wipeTowerWidth: 60 })).wipeTowerWidth, 20, 0.001);
});

test('primeTowerWidth USE_FILE keeps base wipeTowerWidth', () => {
  approx(resolveInto(S({ primeTowerWidth: OV(USE_FILE) }), C({ wipeTowerWidth: 60 })).wipeTowerWidth, 60, 0.001);
});

test('primeTowerWidth ORCA_DEFAULT uses 35mm', () => {
  approx(resolveInto(S({ primeTowerWidth: OV(ORCA_DEFAULT) }), C({ wipeTowerWidth: 60 })).wipeTowerWidth, 35, 0.001);
});

test('wipeTowerRotationAngle round-trips through JSON', () => {
  const restored = fromJson(toJson(S({ wipeTowerRotationAngle: OV(OVERRIDE, 45) })));
  assert.equal(restored.wipeTowerRotationAngle.mode, OVERRIDE);
  approx(restored.wipeTowerRotationAngle.value, 45, 0.001);
});

test('primeTowerWidth round-trips through JSON', () => {
  const restored = fromJson(toJson(S({ primeTowerWidth: OV(OVERRIDE, 25) })));
  assert.equal(restored.primeTowerWidth.mode, OVERRIDE);
  approx(restored.primeTowerWidth.value, 25, 0.001);
});

test('wipeTowerRotationAngle OVERRIDE emitted in buildProfileOverrides', () => {
  const r = impl(C({ wipeTowerEnabled: true, extruderCount: 2 }), S({ wipeTowerRotationAngle: OV(OVERRIDE, 45) }), { slotCount: 2 });
  assert.equal(r.wipe_tower_rotation_angle, '45.0');
});

test('primeTowerWidth OVERRIDE emitted in buildProfileOverrides', () => {
  const r = impl(C({ wipeTowerEnabled: true, wipeTowerWidth: 60, extruderCount: 2 }), S({ primeTowerWidth: OV(OVERRIDE, 20) }), { slotCount: 2 });
  assert.equal(r.prime_tower_width, '20.0');
});

// --- computeTogglePrimeTower (B53) ---

test('computeTogglePrimeTower USE_FILE true cfg → OVERRIDE false', () => {
  const r = computeTogglePrimeTower(OV(USE_FILE), true);
  assert.equal(r.mode, OVERRIDE);
  assert.equal(r.value, false);
});

test('computeTogglePrimeTower USE_FILE false cfg → OVERRIDE true', () => {
  const r = computeTogglePrimeTower(OV(USE_FILE), false);
  assert.equal(r.mode, OVERRIDE);
  assert.equal(r.value, true);
});

test('computeTogglePrimeTower OVERRIDE true → OVERRIDE false', () => {
  const r = computeTogglePrimeTower(OV(OVERRIDE, true), false);
  assert.equal(r.mode, OVERRIDE);
  assert.equal(r.value, false);
});

test('computeTogglePrimeTower OVERRIDE false → OVERRIDE true', () => {
  const r = computeTogglePrimeTower(OV(OVERRIDE, false), true);
  assert.equal(r.mode, OVERRIDE);
  assert.equal(r.value, true);
});

test('buildProfileOverrides enable_prime_tower 0 when OVERRIDE false multi-extruder', () => {
  const r = impl(C({ wipeTowerEnabled: true }), S({ primeTower: OV(OVERRIDE, false) }), { slotCount: 2 });
  assert.equal(r.enable_prime_tower, '0', 'enable_prime_tower must be 0 for explicit OVERRIDE false');
});

// --- B63: filament_type ---

test('buildProfileOverrides emits filament_type from extruder presets', () => {
  const r = impl(C(), S(), { slotCount: 4, filamentTypes: ['PETG', 'ABS', 'TPU', 'PLA'] });
  assert.deepEqual(r.filament_type, ['PETG', 'ABS', 'TPU', 'PLA']);
});

test('buildProfileOverrides filament_type defaults to PLA when no types given', () => {
  assert.deepEqual(impl(C(), S(), { slotCount: 2 }).filament_type, ['PLA', 'PLA']);
});

test('buildProfileOverrides filament_type pads short list with PLA', () => {
  assert.deepEqual(impl(C(), S(), { slotCount: 4, filamentTypes: ['PETG'] }).filament_type, ['PETG', 'PLA', 'PLA', 'PLA']);
});

// --- Nozzle temp ---

test('nozzle_temperature uses extruderTemps when size matches slotCount', () => {
  assert.deepEqual(impl(C({ extruderTemps: [235, 210] }), S(), { slotCount: 2 }).nozzle_temperature, ['235', '210']);
});

test('nozzle_temperature falls back to nozzleTemp when extruderTemps empty', () => {
  assert.deepEqual(impl(C({ nozzleTemp: 210, extruderTemps: [] }), S(), { slotCount: 2 }).nozzle_temperature, ['210', '210']);
});

test('nozzle_temperature single-color PETG uses 235 when extruderTemps set', () => {
  assert.deepEqual(impl(C({ extruderTemps: [235] }), S(), { slotCount: 1 }).nozzle_temperature, ['235']);
});

test('nozzleTemps param overrides stale extruderTemps — profile linked after model load', () => {
  assert.deepEqual(impl(C({ extruderTemps: [210] }), S(), { slotCount: 1, nozzleTemps: [235] }).nozzle_temperature, ['235']);
});

test('nozzleTemps param overrides stale extruderTemps — multi-colour case', () => {
  assert.deepEqual(impl(C({ extruderTemps: [210, 210] }), S(), { slotCount: 2, nozzleTemps: [235, 270] }).nozzle_temperature, ['235', '270']);
});

test('resolveInto carries support filament choices into raw STL SliceConfig', () => {
  const r = resolveInto(S({
    supports: OV(OVERRIDE, true), supportFilament: OV(OVERRIDE, 3), supportInterfaceFilament: OV(OVERRIDE, 4),
  }), C({ extruderCount: 1 }));
  assert.equal(r.supportEnabled, true);
  assert.equal(r.supportFilament, 3);
  assert.equal(r.supportInterfaceFilament, 4);
});
