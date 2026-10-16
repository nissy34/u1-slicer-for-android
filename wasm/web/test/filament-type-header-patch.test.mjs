// Mirrors app/src/test/java/com/u1/slicer/FilamentTypeHeaderPatchTest.kt case by case.
// fixFilamentTypeHeader / fixNozzleTemperatureHeader take G-code text instead of
// a file path and return { changed, gcode } (Kotlin: Boolean + file rewritten in place).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fixFilamentTypeHeader, fixNozzleTemperatureHeader, resolveFilamentTypesForHeaderPatch,
  resolveNozzleTempsForHeaderPatch, resolveNonCanonicalHeaderPatchTypes, resolveNonCanonicalHeaderPatchTemps,
} from '../pipeline/profile-overrides.mjs';
import { FilamentSource, canonicalFilamentList as CFL, filamentEntry as FE } from '../pipeline/canonical-filament-list.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

const { FILE_COLOUR } = FilamentSource;
const gcode = (...lines) => `${lines.join('\n')}\n`;
const readLines = (text) => text.split('\n').filter((_, i, a) => !(i === a.length - 1 && a[i] === ''));
const P = (index, color, materialType, extra = {}) => extruderPreset({ index, color, materialType, ...extra });
const types = (canonical, overrides, colorMapping, presets, padTo) =>
  resolveFilamentTypesForHeaderPatch({ canonical, overrides, colorMapping, presets, filamentLibrary: [], ...(padTo != null ? { padTo } : {}) });
const temps = (canonical, overrides, colorMapping, presets, padTo) =>
  resolveNozzleTempsForHeaderPatch({ canonical, overrides, colorMapping, presets, filamentLibrary: [], ...(padTo != null ? { padTo } : {}) });
const allTo = (n, material) => new Map(Array.from({ length: n }, (_, i) => [i, [null, material]]));
const plaPresets4 = () => [P(0, '#FF0000', 'PLA'), P(1, '#00FF00', 'PLA'), P(2, '#0000FF', 'PLA'), P(3, '#FFFFFF', 'PLA')];

test('replaces PLA with PETG for single extruder', () => {
  const r = fixFilamentTypeHeader(gcode('; filament_type = PLA', 'G28'), ['PETG']);
  assert.ok(r.changed);
  const lines = readLines(r.gcode);
  assert.equal(lines[0], '; filament_type = PETG');
  assert.equal(lines[1], 'G28');
});

test('replaces with semicolon-joined list for 4 extruders', () => {
  const r = fixFilamentTypeHeader(gcode('; filament_colour = #FF0000;#00FF00;#0000FF;#FFFFFF', '; filament_type = PLA', 'G28'),
    ['PETG', 'ABS', 'TPU', 'PLA']);
  assert.ok(r.changed);
  const lines = readLines(r.gcode);
  assert.equal(lines[0], '; filament_colour = #FF0000;#00FF00;#0000FF;#FFFFFF');
  assert.equal(lines[1], '; filament_type = PETG;ABS;TPU;PLA');
  assert.equal(lines[2], 'G28');
});

test('header patch types use canonical mapping even when canonical size fits physical slots', () => {
  const canonical = CFL({ filaments: [FE(0, '#0086D6', 'PLA', FILE_COLOUR), FE(1, '#FFFF00', 'PLA', FILE_COLOUR), FE(2, '#FFFFFF', 'PETG', FILE_COLOUR)] });
  const presets = [P(0, '#0086D6', 'PLA'), P(1, '#FFFF00', 'PLA'), P(2, '#FFFFFF', 'ABS'), P(3, '#6A00D5', 'ABS')];
  assert.deepEqual(types(canonical, new Map(), [0, 1, 2], presets), ['PLA', 'PLA', 'PETG']);
});

test('header patch types keep explicit override above mapped slot material', () => {
  const canonical = CFL({ filaments: [FE(0, '#FFFFFF', 'PLA', FILE_COLOUR)] });
  assert.deepEqual(types(canonical, new Map([[0, [null, 'TPU']]]), [2], [P(2, '#FFFFFF', 'PETG')]), ['PLA', 'PLA', 'TPU']);
});

test('B102 sparse colorMapping produces physical-slot-indexed filament_type', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PETG', FILE_COLOUR), FE(1, '#0000FF', 'PETG', FILE_COLOUR)] });
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FFFFFF', 'PLA'), P(2, '#FF0000', 'PETG'), P(3, '#0000FF', 'PETG')];
  assert.deepEqual(types(canonical, new Map(), [2, 3], presets), ['PLA', 'PLA', 'PETG', 'PETG']);
});

test('header patch pads beyond canonical when support filament uses higher slot', () => {
  const canonical = CFL({ filaments: [FE(0, '#0086D6', 'PLA', FILE_COLOUR), FE(1, '#FFFF00', 'PLA', FILE_COLOUR)] });
  const presets = [P(0, '#0086D6', 'PLA'), P(1, '#FFFF00', 'PLA'), P(2, '#FFFFFF', 'PETG'), P(3, '#6A00D5', 'ABS')];
  assert.deepEqual(types(canonical, new Map(), [0, 1], presets, 4), ['PLA', 'PLA', 'PETG', 'ABS']);
});

test('Jon-bug 5 canonical collapse to 4 physical all PETG override produces no PLA padding', () => {
  const canonical = CFL({ filaments: Array.from({ length: 5 }, (_, i) => FE(i, '#FF0000', 'PLA', FILE_COLOUR)) });
  assert.deepEqual(types(canonical, allTo(5, 'PETG'), [0, 1, 2, 3, 0], plaPresets4(), 5),
    ['PETG', 'PETG', 'PETG', 'PETG', 'PETG'],
    "Jon's Discord report: padding position must inherit the user's PETG override at canonical idx 4, not fall back to a PLA default.");
});

test('H2C 7-canonical 4-physical all-PETG-override produces no PLA padding', () => {
  const canonical = CFL({ filaments: Array.from({ length: 7 }, (_, i) => FE(i, '#FF0000', 'PLA', FILE_COLOUR)) });
  assert.deepEqual(types(canonical, allTo(7, 'PETG'), [0, 1, 2, 3, 0, 1, 2], plaPresets4(), 7), Array(7).fill('PETG'));
});

test('B105 single-slot E3 produces one-element type list not four', () => {
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FFFFFF', 'PLA'), P(2, '#FF0000', 'PLA'), P(3, '#0000FF', 'PLA')];
  const t = resolveNonCanonicalHeaderPatchTypes([2], presets);
  assert.equal(t.length, 1, 'B105: single-slot E3 must produce exactly 1 type entry');
  assert.equal(t[0], 'PLA');
});

test('B105 single-slot E3 with PETG preset emits PETG', () => {
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FFFFFF', 'PLA'), P(2, '#FF0000', 'PETG'), P(3, '#0000FF', 'PLA')];
  const t = resolveNonCanonicalHeaderPatchTypes([2], presets);
  assert.equal(t.length, 1);
  assert.equal(t[0], 'PETG');
});

test('B105 two-slot E2 and E3 produces two-element type list', () => {
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FF0000', 'ABS'), P(2, '#00FF00', 'PETG'), P(3, '#0000FF', 'PLA')];
  assert.deepEqual(resolveNonCanonicalHeaderPatchTypes([1, 2], presets), ['ABS', 'PETG']);
});

test('B105 unknown slot falls back to PLA', () => {
  assert.deepEqual(resolveNonCanonicalHeaderPatchTypes([3], [P(0, '#FFFFFF', 'PLA')]), ['PLA']);
});

test('returns false and leaves file unchanged when header line absent', () => {
  const before = gcode('; filament_density = 1.24', 'G28');
  const r = fixFilamentTypeHeader(before, ['PETG']);
  assert.equal(r.changed, false);
  assert.equal(r.gcode, before);
});

test('returns false for empty filamentTypes list', () => {
  const r = fixFilamentTypeHeader(gcode('; filament_type = PLA'), []);
  assert.equal(r.changed, false);
  assert.equal(r.gcode, '; filament_type = PLA\n');
});

test('returns false for non-existent file', () => {
  assert.equal(fixFilamentTypeHeader(null, ['PETG']).changed, false);
});

test('only replaces first occurrence', () => {
  const r = fixFilamentTypeHeader(gcode('; filament_type = PLA', '; filament_type = ABS', 'G28'), ['PETG']);
  assert.ok(r.changed);
  const lines = readLines(r.gcode);
  assert.equal(lines[0], '; filament_type = PETG');
  assert.equal(lines[1], '; filament_type = ABS');
});

test('B110 nozzle temps header patch comma-joined for 4 extruders', () => {
  const r = fixNozzleTemperatureHeader(gcode('; nozzle_temperature = 200,200,200,200', 'G28'), [220, 235, 270, 225]);
  assert.ok(r.changed);
  const lines = readLines(r.gcode);
  assert.equal(lines[0], '; nozzle_temperature = 220,235,270,225');
  assert.equal(lines[1], 'G28');
});

test('B110 nozzle temps header patch also patches initial_layer variant', () => {
  const r = fixNozzleTemperatureHeader(gcode('; nozzle_temperature = 200,200,200,200',
    '; nozzle_temperature_initial_layer = 200,200,200,200', 'G28'), [220, 235, 270, 225]);
  assert.ok(r.changed);
  const lines = readLines(r.gcode);
  assert.equal(lines[0], '; nozzle_temperature = 220,235,270,225');
  assert.equal(lines[1], '; nozzle_temperature_initial_layer = 220,235,270,225');
  assert.equal(lines[2], 'G28');
});

test('B110 nozzle temps header patch returns false when no header line present', () => {
  const before = gcode('; filament_density = 1.24', 'G28');
  const r = fixNozzleTemperatureHeader(before, [220, 235]);
  assert.equal(r.changed, false);
  assert.equal(r.gcode, before);
});

test('B110 nozzle temps header patch returns false for empty temps list', () => {
  const r = fixNozzleTemperatureHeader(gcode('; nozzle_temperature = 220'), []);
  assert.equal(r.changed, false);
  assert.equal(r.gcode, '; nozzle_temperature = 220\n');
});

test('Jon-bug sibling nozzle_temperature padding inherits user override material temp', () => {
  const canonical = CFL({ filaments: Array.from({ length: 5 }, (_, i) => FE(i, '#FF0000', 'PLA', FILE_COLOUR)) });
  assert.deepEqual(temps(canonical, allTo(5, 'PETG'), [0, 1, 2, 3, 0], plaPresets4(), 5), [235, 235, 235, 235, 235]);
});

test('B110 resolveNozzleTempsForHeaderPatch produces physical-slot-indexed array', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PETG', FILE_COLOUR), FE(1, '#0000FF', 'PETG', FILE_COLOUR)] });
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FFFFFF', 'PLA'), P(2, '#FF0000', 'PETG'), P(3, '#0000FF', 'PETG')];
  assert.deepEqual(temps(canonical, new Map(), [2, 3], presets), [220, 220, 235, 235]);
});

test('B110 header patch filament_type and nozzle_temperature agree on PETG slot index after override', () => {
  const canonical = CFL({
    filaments: ['#0086D6', '#FFFF00', '#FFFFFF', '#6A00D5', '#FF6A13', '#00FF00', '#FF0000'].map((c, i) => FE(i, c, 'PLA', FILE_COLOUR)),
  });
  const presets = [P(0, '#0086D6', 'PLA'), P(1, '#FFFF00', 'PLA'), P(2, '#FFFFFF', 'PLA'), P(3, '#6A00D5', 'PLA')];
  const colorMapping = [0, 1, 2, 3, 0, 1, 2];
  const overrides = new Map([[0, [null, 'PETG']]]);
  const t = types(canonical, overrides, colorMapping, presets);
  const n = temps(canonical, overrides, colorMapping, presets);
  assert.equal(t.length, n.length, 'filament_type and nozzle_temperature arrays must have equal length');
  const petgIndex = t.indexOf('PETG');
  assert.ok(petgIndex >= 0, `Expected a PETG entry in filament_type, got ${t}`);
  assert.equal(n[petgIndex], 235);
  n.forEach((v, i) => { if (i !== petgIndex) assert.equal(v, 220, `Slot ${i} must remain PLA (220)`); });
});

test('B110 override on canonical fileIndex 0 with H2C-shaped mapping aligns both arrays', () => {
  const canonical = CFL({ filaments: Array.from({ length: 7 }, (_, i) => FE(i, '#FFFFFF', 'PLA', FILE_COLOUR)) });
  const presets = [0, 1, 2, 3].map((i) => P(i, '#FFFFFF', 'PLA'));
  const overrides = new Map([[0, [null, 'PETG']]]);
  assert.deepEqual(types(canonical, overrides, [0, 1, 2, 3, 0, 1, 2], presets), ['PETG', 'PLA', 'PLA', 'PLA', 'PLA', 'PLA', 'PLA']);
  assert.deepEqual(temps(canonical, overrides, [0, 1, 2, 3, 0, 1, 2], presets), [235, 220, 220, 220, 220, 220, 220]);
});

test('B110 resolveNonCanonicalHeaderPatchTemps derives temps from preset materialType', () => {
  const presets = [P(0, '#FFFFFF', 'PLA'), P(1, '#FF0000', 'PETG'), P(2, '#00FF00', 'ABS'), P(3, '#0000FF', 'TPU')];
  assert.deepEqual(resolveNonCanonicalHeaderPatchTemps([0, 1, 2, 3], presets, []), [220, 235, 270, 225]);
});

test('B110 resolveNonCanonicalHeaderPatchTemps prefers linked filament profile temp', () => {
  const library = [{ id: 99, name: 'My PETG @240', material: 'PETG', nozzleTemp: 240, bedTemp: 70, retractLength: 0.8, retractSpeed: 45, color: '#FF0000' }];
  const presets = [P(2, '#FF0000', 'PETG', { filamentProfileId: 99 })];
  assert.deepEqual(resolveNonCanonicalHeaderPatchTemps([2], presets, library), [240]);
});
