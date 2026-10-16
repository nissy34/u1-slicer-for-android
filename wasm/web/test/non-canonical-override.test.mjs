// Mirrors app/src/test/java/com/u1/slicer/NonCanonicalOverrideTest.kt case by case.
// SlicerViewModel.FilamentOverride -> { color?, materialType? }.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNonCanonicalOverride } from '../pipeline/profile-overrides.mjs';

test('nullOverride_returnsInputsUnchanged', () => {
  const [types, temps] = applyNonCanonicalOverride(['PLA'], [220], null);
  assert.deepEqual(types, ['PLA']);
  assert.deepEqual(temps, [220]);
});

test('overrideWithoutMaterialType_returnsInputsUnchanged', () => {
  const [types, temps] = applyNonCanonicalOverride(['PLA'], [220], { color: '#FF0000', materialType: null });
  assert.deepEqual(types, ['PLA']);
  assert.deepEqual(temps, [220]);
});

test('materialOverride_replacesFirstSlotTypeAndTemp', () => {
  const [types, temps] = applyNonCanonicalOverride(['PLA'], [220], { materialType: 'PETG' });
  assert.deepEqual(types, ['PETG']);
  assert.deepEqual(temps, [235]);
});

test('materialOverride_onMultiSlotArrays_replacesOnlyFirst', () => {
  const [types, temps] = applyNonCanonicalOverride(['PLA', 'PLA', 'ABS'], [220, 220, 250], { materialType: 'PETG' });
  assert.deepEqual(types, ['PETG', 'PLA', 'ABS']);
  assert.deepEqual(temps, [235, 220, 250]);
});

test('materialOverride_onEmptyArrays_isNoOp', () => {
  const [types, temps] = applyNonCanonicalOverride([], [], { materialType: 'PETG' });
  assert.deepEqual(types, []);
  assert.deepEqual(temps, []);
});

test('allMaterials_resolveToTheirDefaultTemps', () => {
  for (const [material, expectedTemp] of [['PLA', 220], ['PETG', 235], ['ABS', 270], ['TPU', 225], ['PA', 260], ['PVA', 210]]) {
    const [types, temps] = applyNonCanonicalOverride(['PLA'], [220], { materialType: material });
    assert.deepEqual(types, [material], `type for ${material}`);
    assert.deepEqual(temps, [expectedTemp], `temp for ${material}`);
  }
});

test('unknownMaterial_fallsBackToPlaDefault', () => {
  const [types, temps] = applyNonCanonicalOverride(['PLA'], [220], { materialType: 'NEVER_HEARD_OF_IT' });
  assert.deepEqual(types, ['NEVER_HEARD_OF_IT']);
  assert.deepEqual(temps, [220]);
});
