// Mirrors app/src/test/java/com/u1/slicer/data/PerFilamentResolverTest.kt case by case.
// Overrides: Map fileIndex -> [color, material] (Kotlin Pair).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FilamentSource, canonicalFilamentList as CFL, filamentEntry as FE, resolvePerFilamentTypeAndTemp,
} from '../pipeline/canonical-filament-list.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

const { FILE_COLOUR } = FilamentSource;
const hex6 = (n) => `#${n.toString(16).toUpperCase().padStart(6, '0')}`;
const P = (index, materialType, extra = {}) => extruderPreset({ index, materialType, ...extra });
const resolve = (canonical, overrides, colorMapping, presets, filamentLibrary = []) =>
  resolvePerFilamentTypeAndTemp({ canonical, overrides, colorMapping, presets, filamentLibrary });
const pla7 = () => CFL({ filaments: Array.from({ length: 7 }, (_, i) => FE(i, hex6(0xFF0000 + i * 0x10), 'PLA', FILE_COLOUR)) });
const fourPLAPresets = () => [0, 1, 2, 3].map((i) => P(i, 'PLA', { color: '#FF0000' }));
const h2cMapping = () => [0, 1, 2, 3, 0, 1, 2];
const petgAt = (i) => new Map([[i, [null, 'PETG']]]);
const customPla = () => [{ id: 42, name: 'Custom PLA', material: 'PLA', nozzleTemp: 215, bedTemp: 60, retractLength: 0.8, retractSpeed: 45 }];

test('overrideAtIndexZero_PETG_appearsOnlyAtIndexZero', () => {
  const [types, temps] = resolve(pla7(), petgAt(0), h2cMapping(), fourPLAPresets());
  assert.deepEqual(types, ['PETG', 'PLA', 'PLA', 'PLA', 'PLA', 'PLA', 'PLA']);
  assert.deepEqual(temps, [235, 220, 220, 220, 220, 220, 220]);
});

test('overrideAtIndexFour_PETG_appearsOnlyAtIndexFour', () => {
  const [types, temps] = resolve(pla7(), petgAt(4), h2cMapping(), fourPLAPresets());
  assert.deepEqual(types, ['PLA', 'PLA', 'PLA', 'PLA', 'PETG', 'PLA', 'PLA']);
  assert.deepEqual(temps, [220, 220, 220, 220, 235, 220, 220]);
});

test('overrideAtIndexFive_PETG_appearsOnlyAtIndexFive', () => {
  const [types, temps] = resolve(pla7(), petgAt(5), h2cMapping(), fourPLAPresets());
  assert.deepEqual(types, ['PLA', 'PLA', 'PLA', 'PLA', 'PLA', 'PETG', 'PLA']);
  assert.deepEqual(temps, [220, 220, 220, 220, 220, 235, 220]);
});

test('multipleOverrides_eachAppearsOnlyAtItsOwnIndex', () => {
  const overrides = new Map([[0, [null, 'PETG']], [3, [null, 'ABS']], [6, [null, 'TPU']]]);
  const [types, temps] = resolve(pla7(), overrides, h2cMapping(), fourPLAPresets());
  assert.deepEqual(types, ['PETG', 'PLA', 'PLA', 'ABS', 'PLA', 'PLA', 'TPU']);
  assert.deepEqual(temps, [235, 220, 220, 270, 220, 220, 225]);
});

test('noOverrides_declaredMultiColour_injectiveMapping_fileMaterialWins', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR), FE(1, '#00FF00', 'PETG', FILE_COLOUR), FE(2, '#0000FF', 'TPU', FILE_COLOUR)] });
  const presets = [P(0, 'PETG', { color: '#FF0000' }), P(1, 'ABS', { color: '#00FF00' }), P(2, 'PLA', { color: '#0000FF' })];
  const [types, temps] = resolve(canonical, new Map(), [0, 1, 2], presets);
  assert.deepEqual(types, ['PLA', 'PETG', 'TPU']);
  assert.deepEqual(temps, [220, 235, 225]);
});

test('noOverrides_declaredFileMaterialNull_fallsBackToSlotPreset', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PETG', FILE_COLOUR), FE(1, '#0000FF', null, FILE_COLOUR)] });
  const [types] = resolve(canonical, new Map(), [0, 1], [P(0, 'ABS'), P(1, 'PLA')]);
  assert.deepEqual(types, ['PETG', 'PLA']);
});

test('noOverrides_declaredFileMaterialMatchesSlot_keepsLinkedProfileTemp', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR), FE(1, '#00FF00', 'PETG', FILE_COLOUR)] });
  const presets = [P(0, 'PLA', { filamentProfileId: 42 }), P(1, 'PETG')];
  const [types, temps] = resolve(canonical, new Map(), [0, 1], presets, customPla());
  assert.deepEqual(types, ['PLA', 'PETG']);
  assert.deepEqual(temps, [215, 235]);
});

test('noOverrides_declaredButColourCollision_slotWinsForCollidingFilaments', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR), FE(1, '#00FF00', 'PETG', FILE_COLOUR), FE(2, '#0000FF', 'TPU', FILE_COLOUR)] });
  const [types] = resolve(canonical, new Map(), [0, 1, 1], [P(0, 'ABS'), P(1, 'ABS')]);
  assert.deepEqual(types, ['PLA', 'ABS', 'ABS']);
});

test('noOverrides_paintFoldFile_slotWinsEvenWhenInjective', () => {
  const canonical = CFL({
    filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR), FE(1, '#00FF00', 'PLA', FILE_COLOUR)],
    paintStateMap: new Map([[1, 0], [2, 1]]),
  });
  const [types] = resolve(canonical, new Map(), [0, 1], [P(0, 'PETG'), P(1, 'ABS')]);
  assert.deepEqual(types, ['PETG', 'ABS']);
});

test('noOverrides_singleColourDeclared_keepsSlotPresetMaterial_b118guard', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR)] });
  const [types, temps] = resolve(canonical, new Map(), [0], [P(0, 'PETG')]);
  assert.deepEqual(types, ['PETG']);
  assert.deepEqual(temps, [235]);
});

test('h2cSupportFilamentThree_usesMappedSlotPetgEvenWhenFileDeclaresPla', () => {
  const canonical = CFL({ filaments: Array.from({ length: 7 }, (_, i) => FE(i, hex6(0x0086D6 + i), 'PLA', FILE_COLOUR)) });
  const presets = [P(0, 'PLA', { color: '#0086D6' }), P(1, 'PLA', { color: '#FFFF00' }), P(2, 'PETG', { color: '#FFFFFF' }), P(3, 'PLA', { color: '#6A00D5' })];
  const [types, temps] = resolve(canonical, new Map(), [0, 1, 2, 3, 0, 1, 2], presets);
  assert.equal(types[2], 'PETG');
  assert.equal(temps[2], 235);
});

test('noOverrides_linkedFilamentProfileTemp_winsOverMaterialDefault', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', null, FILE_COLOUR)] });
  const [, temps] = resolve(canonical, new Map(), [0], [P(0, 'PLA', { filamentProfileId: 42 })], customPla());
  assert.deepEqual(temps, [215]);
});

test('overrideMaterial_bypassesLinkedFilamentProfileTemp', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR)] });
  const [types, temps] = resolve(canonical, petgAt(0), [0], [P(0, 'PLA', { filamentProfileId: 42 })], customPla());
  assert.deepEqual(types, ['PETG']);
  assert.deepEqual(temps, [235]);
});

test('nullColorMapping_defaultsEveryFilamentToSlotZero', () => {
  const [types, temps] = resolve(pla7(), petgAt(2), null, fourPLAPresets());
  assert.deepEqual(types, ['PLA', 'PLA', 'PETG', 'PLA', 'PLA', 'PLA', 'PLA']);
  assert.deepEqual(temps, [220, 220, 235, 220, 220, 220, 220]);
});

test('dc15_threeColourDeclaredFile_allFilamentsShowFileMaterial', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PETG', FILE_COLOUR), FE(1, '#00FF00', 'PLA', FILE_COLOUR), FE(2, '#0000FF', 'TPU', FILE_COLOUR)] });
  const presets = [0, 1, 2].map((i) => P(i, 'PLA', { color: '#FFFFFF' }));
  const [types, temps] = resolve(canonical, new Map(), [0, 1, 2], presets);
  assert.deepEqual(types, ['PETG', 'PLA', 'TPU'], 'DC15: all three declared materials must surface on Prepare');
  assert.deepEqual(temps, [235, 220, 225]);
});

test('dc15_blankSlotMaterialDoesNotLeakAsNoneLabel', () => {
  const canonical = CFL({ filaments: [FE(0, '#FF0000', 'PETG', FILE_COLOUR), FE(1, '#00FF00', null, FILE_COLOUR), FE(2, '#0000FF', null, FILE_COLOUR)] });
  const presets = [P(0, 'PLA', { color: '#FFFFFF' }), P(1, '', { color: '#FFFFFF' }), P(2, '', { color: '#FFFFFF' })];
  const [types] = resolve(canonical, new Map(), [0, 1, 2], presets);
  assert.deepEqual(types, ['PETG', 'PLA', 'PLA'],
    'DC15: blank slot materialType must not render as empty/none — resolver must fall through to file material or PLA.');
  assert.ok(types.every((t) => t.trim() !== ''), 'No row may be blank, even with corrupted preset materialType');
});
