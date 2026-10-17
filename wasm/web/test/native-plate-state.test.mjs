// Mirrors app/src/test/java/com/u1/slicer/bambu/NativePlateStateTest.kt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildObjectExtruderMap, parseVolumeMapJson } from '../pipeline/native-plate-state.mjs';

const vol = (i, e, mm = false) => ({ volumeIndex: i, extruder: e, isMmPainted: mm, isSeamPainted: false });
const obj = (i, e, volumes) => ({ objectIndex: i, objectExtruder: e, volumes });
const J = (x) => JSON.stringify(x);

test('parseVolumeMapJson extracts extruders from single object', () => {
  const s = parseVolumeMapJson(J([obj(0, 1, [vol(0, 1), vol(1, 2)])]));
  assert.deepEqual(s.usedExtruders, new Set([1, 2]));
  assert.equal(s.hasPaintData, false);
  assert.equal(s.objects.length, 1);
  assert.equal(s.objects[0].volumes.length, 2);
});
test('parseVolumeMapJson detects paint data', () =>
  assert.equal(parseVolumeMapJson(J([obj(0, 1, [vol(0, 1, true)])])).hasPaintData, true));
test('parseVolumeMapJson handles compound object with three extruders', () => {
  const s = parseVolumeMapJson(J([obj(0, 1, [vol(0, 1), vol(1, 2), vol(2, 3)])]));
  assert.deepEqual(s.usedExtruders, new Set([1, 2, 3]));
  assert.equal(s.objects[0].volumes.length, 3);
});
test('parseVolumeMapJson inherits object extruder when volume is -1', () =>
  assert.deepEqual(parseVolumeMapJson(J([obj(0, 2, [vol(0, -1)])])).usedExtruders, new Set([2])));
test('parseVolumeMapJson returns empty state for null input', () => {
  const s = parseVolumeMapJson(null);
  assert.equal(s.usedExtruders.size, 0);
  assert.equal(s.hasPaintData, false);
  assert.equal(s.objects.length, 0);
});
test('parseVolumeMapJson handles multiple objects', () => {
  const s = parseVolumeMapJson(J([obj(0, 1, [vol(0, 1)]), obj(1, 3, [vol(0, 3)])]));
  assert.deepEqual(s.usedExtruders, new Set([1, 3]));
  assert.equal(s.objects.length, 2);
});
test('buildObjectExtruderMap produces per-object max extruder', () =>
  assert.deepEqual(buildObjectExtruderMap(parseVolumeMapJson(J([obj(0, 1, [vol(0, 1), vol(1, 3)])]))), new Map([['0', 3]])));
