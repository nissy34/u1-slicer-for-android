// Mirrors app/src/test/java/com/u1/slicer/bambu/PaintColorDecoderTest.kt case by case.
// Expected states come from tracing OrcaSlicer's TriangleSelector::serialize() for
// single-leaf and split-tree triangles (see the Kotlin file for the derivations).
import assert from 'node:assert/strict';
import test from 'node:test';
import { PaintColorDecoder } from '../pipeline/paint-color-decoder.mjs';

const set = (...v) => new Set(v);

test('emptyInput_returnsEmptySet', () => assert.deepEqual(PaintColorDecoder.decodeStates(''), set()));

test('malformedChar_returnsEmptySet', () => {
  assert.deepEqual(PaintColorDecoder.decodeStates('Z'), set());
  assert.deepEqual(PaintColorDecoder.decodeStates('8Z'), set());
});

test('state0_excludedFromResult', () => assert.deepEqual(PaintColorDecoder.decodeStates('0'), set()));
test('state1_singleLeaf', () => assert.deepEqual(PaintColorDecoder.decodeStates('4'), set(1)));
test('state2_singleLeaf', () => assert.deepEqual(PaintColorDecoder.decodeStates('8'), set(2)));
test('state3_extendedSingleLeaf', () => assert.deepEqual(PaintColorDecoder.decodeStates('0C'), set(3)));
test('state4_extendedSingleLeaf', () => assert.deepEqual(PaintColorDecoder.decodeStates('1C'), set(4)));
test('state6_extendedSingleLeaf_b95Plate9', () => assert.deepEqual(PaintColorDecoder.decodeStates('3C'), set(6)));
test('state8_extendedSingleLeaf', () => assert.deepEqual(PaintColorDecoder.decodeStates('5C'), set(8)));
test('state11_extendedSingleLeaf_b95Plate9', () => assert.deepEqual(PaintColorDecoder.decodeStates('8C'), set(11)));
test('state16_extendedSingleLeaf_maxEncodableByOrca', () => assert.deepEqual(PaintColorDecoder.decodeStates('DC'), set(16)));

test('extendedMarkerWithoutContinuation_returnsEmptySet', () =>
  assert.deepEqual(PaintColorDecoder.decodeStates('C'), set()));

test('lowercaseHex_acceptedSameAsUppercase', () => {
  assert.deepEqual(PaintColorDecoder.decodeStates('8c'), set(11));
  assert.deepEqual(PaintColorDecoder.decodeStates('3c'), set(6));
});

test('rootSplit_twoLeavesBothState1_dedupedToSingleState', () =>
  assert.deepEqual(PaintColorDecoder.decodeStates('441'), set(1)));

test('rootSplit_twoLeavesStates1And2_returnsBoth', () =>
  assert.deepEqual(PaintColorDecoder.decodeStates('481'), set(1, 2)));

test('rootSplit_threeLeavesAllDistinct_returnsAllThree', () =>
  assert.deepEqual(PaintColorDecoder.decodeStates('480C2'), set(1, 2, 3)));

test('nestedSplit_returnsAllLeafStates', () =>
  assert.deepEqual(PaintColorDecoder.decodeStates('84411'), set(1, 2)));

test('hasAnyNonZeroState_trueWhenStateGreaterThanZero', () => {
  assert.equal(PaintColorDecoder.hasAnyNonZeroState('4'), true);
  assert.equal(PaintColorDecoder.hasAnyNonZeroState('8C'), true);
});

test('hasAnyNonZeroState_falseForEmptyOrZero', () => {
  assert.equal(PaintColorDecoder.hasAnyNonZeroState(''), false);
  assert.equal(PaintColorDecoder.hasAnyNonZeroState('0'), false);
});

test('maxState_returnsHighestStateAcrossAttributes', () => {
  // 4→1, 8C→11, 3C→6, 8→2 → max = 11
  assert.equal(PaintColorDecoder.maxState(['4', '8C', '3C', '8']), 11);
});

test('maxState_returnsZeroForAllEmpty', () => assert.equal(PaintColorDecoder.maxState(['', '0']), 0));
test('maxState_handlesEmptyIterable', () => assert.equal(PaintColorDecoder.maxState([]), 0));
