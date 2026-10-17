// Mirrors app/src/test/java/com/u1/slicer/ui/MultiColorMappingTest.kt and
// MultiColorMappingMoreThan4Test.kt (ensureMultiSlotMapping), plus
// findClosestExtruder / colorDistance behaviour from ui/MultiColorDialog.kt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { colorDistance, ensureMultiSlotMapping, findClosestExtruder } from '../pipeline/multi-color-mapping.mjs';

const distinct = (xs) => new Set(xs).size;

// MultiColorMappingTest
test('ensureMultiSlotMapping_allZero_twoColors_distributesToTwoSlots', () =>
  assert.ok(distinct(ensureMultiSlotMapping([0, 0], 2)) >= 2));
test('ensureMultiSlotMapping_allZero_fourColors_distributesToFourSlots', () =>
  assert.equal(distinct(ensureMultiSlotMapping([0, 0, 0, 0], 4)), 4));
test('ensureMultiSlotMapping_allZero_sixColors_distributesToAtLeastTwoSlots', () =>
  assert.ok(distinct(ensureMultiSlotMapping([0, 0, 0, 0, 0, 0], 6)) >= 2));
test('ensureMultiSlotMapping_singleColor_unchanged', () => assert.deepEqual(ensureMultiSlotMapping([0], 1), [0]));
test('ensureMultiSlotMapping_alreadyDistinct_unchanged', () => assert.deepEqual(ensureMultiSlotMapping([0, 1], 2), [0, 1]));
test('ensureMultiSlotMapping_fourColorsCollapsedToThree_distributesToFourSlots', () =>
  assert.deepEqual(ensureMultiSlotMapping([0, 1, 0, 2], 4), [0, 1, 2, 3]));
test('ensureMultiSlotMapping_threeColorsCollapsedToTwo_distributesToThreeSlots', () =>
  assert.equal(distinct(ensureMultiSlotMapping([0, 1, 1], 3)), 3));
test('ensureMultiSlotMapping_allSameNonZeroSlot_distributes', () =>
  assert.ok(distinct(ensureMultiSlotMapping([2, 2, 2], 3)) >= 2));
test('ensureMultiSlotMapping_fourColorsCollapsedToTwo_distributesToFourSlots', () =>
  assert.deepEqual(ensureMultiSlotMapping([0, 1, 0, 1], 4), [0, 1, 2, 3]));

// MultiColorMappingMoreThan4Test
test('f1Calendar_fiveColours_collapsedToTwoSlots_redistributesAcrossAllFour', () => {
  const r = ensureMultiSlotMapping([0, 0, 3, 3, 0], 5);
  assert.deepEqual(r, [0, 1, 3, 2, 0]);
  assert.deepEqual(new Set(r), new Set([0, 1, 2, 3]));
});
test('fiveColours_allCollapsedToOneSlot_redistributesWithSlotZeroHit', () => {
  const r = ensureMultiSlotMapping([2, 2, 2, 2, 2], 5);
  assert.deepEqual(r, [2, 0, 1, 3, 2]);
  assert.deepEqual(new Set(r), new Set([0, 1, 2, 3]));
});
test('sevenColours_alreadyUsesAllFourSlots_leftAlone', () => {
  const raw = [2, 0, 3, 2, 0, 1, 0];
  assert.deepEqual(ensureMultiSlotMapping(raw, 7), raw);
});
test('fiveColours_allFourSlotsAlreadyDistinct_leftAlone', () => {
  const raw = [0, 1, 2, 3, 0];
  assert.deepEqual(ensureMultiSlotMapping(raw, 5), raw);
});
test('sevenColours_collapsedToTwo_redistributesDuplicatesOnly', () => {
  const r = ensureMultiSlotMapping([0, 0, 0, 3, 3, 3, 0], 7);
  assert.deepEqual(r, [0, 1, 2, 3, 3, 3, 0]);
  for (const s of [0, 1, 2, 3]) assert.ok(r.includes(s));
});

// MultiColorDialog.kt helpers
test('colorDistance: identical 0, black-white sqrt(3*255^2), AARRGGBB accepted, garbage MAX_VALUE', () => {
  assert.equal(colorDistance('#FF0000', 'FF0000'), 0);
  assert.equal(colorDistance('#000000', '#FFFFFF'), Math.sqrt(3 * 255 * 255));
  assert.equal(colorDistance('#80FF0000', '#FF0000'), 0);
  assert.equal(colorDistance('#GG0000', '#FF0000'), Number.MAX_VALUE);
});
test('findClosestExtruder picks nearest preset colour, first on ties, null when empty', () => {
  const presets = [{ index: 0, color: '#FFFFFF' }, { index: 1, color: '#FF0000' }, { index: 2, color: '#FF0000' }];
  assert.equal(findClosestExtruder('#EE1111', presets).index, 1);
  assert.equal(findClosestExtruder('#F0F0F0', presets).index, 0);
  assert.equal(findClosestExtruder('#123456', []), null);
});
