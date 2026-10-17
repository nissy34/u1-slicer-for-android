// Mirrors app/src/test/java/com/u1/slicer/model/CopyArrangeCalculatorTest.kt case by case.
// Kotlin named arguments become positional:
//   calculate(sizeX, sizeY, copyCount, bedSizeX, bedSizeY, margin)
//   computeWipeTowerPosition(positions, sizeX, sizeY, towerWidth, towerDepth, bedSizeX, bedSizeY)
//   autoArrange(boxes, reservedRect, incoming, bedSize, bedSizeY, margin)
import assert from 'node:assert/strict';
import test from 'node:test';
import { CopyArrangeCalculator as C } from '../pipeline/copy-arrange-calculator.mjs';

const near = (exp, act, d, msg) => assert.ok(Math.abs(exp - act) <= d, msg ?? `expected ${exp} got ${act}`);
const inRange = (v, lo, hi) => v >= lo && v <= hi;
const footprint = (sx, sy, sz, rx, ry, rz) => C.computeRotatedFootprint(sx, sy, sz, rx, ry, rz);
const sqrt2 = Math.sqrt(2.0);

test("a1 mini single copy and prime tower stay inside the 180mm bed", () => {
  const positions = C.calculate(40, 30, 1, 180, 180);
  near(70, positions[0], 0.01);
  near(75, positions[1], 0.01);
  const [towerX, towerY] = C.computeWipeTowerPosition(positions, 40, 30, 60, 60, 180, 180);
  assert.ok(towerX >= 0 && towerX + 60 <= 180, `towerX=${towerX}`);
  assert.ok(towerY >= 0 && towerY + 60 <= 180, `towerY=${towerY}`);
});

test("auto arrange respects a rectangular bed's shorter Y edge", () => {
  const result = C.autoArrange([60, 45, 10, 60, 45, 10], null, [0, 0, 0, 0], 180, 100);
  assert.equal(result.overflowCount, 0);
  for (let i = 0; i < result.positions.length; i += 2) {
    assert.ok(result.positions[i] >= 0 && result.positions[i] + 60 <= 180);
    assert.ok(result.positions[i + 1] >= 0 && result.positions[i + 1] + 45 <= 100);
  }
});

test('single copy returns centered position on bed', () => {
  const positions = C.calculate(20, 20, 1);
  assert.equal(positions.length, 2);
  near(125, positions[0], 0.01);
  near(125, positions[1], 0.01);
});

test('two copies are centered in the same row', () => {
  const positions = C.calculate(20, 20, 2);
  assert.equal(positions.length, 4);
  near(112.5, positions[0], 0.01);
  near(125, positions[1], 0.01);
  near(137.5, positions[2], 0.01);
  near(125, positions[3], 0.01);
});

test('grid wraps to next row centered', () => {
  const positions = C.calculate(20, 20, 12);
  near(0, positions[11 * 2], 0.01);
  near(137.5, positions[11 * 2 + 1], 0.01);
});

test('copies capped at bed capacity', () => assert.equal(C.calculate(250, 250, 10).length, 2));
test('maxCopies returns correct fit for 20mm object', () => assert.equal(C.maxCopies(20, 20), 121));
test('maxCopies for large object is 1', () => assert.equal(C.maxCopies(260, 260), 1));

test('all positions are within bed bounds', () => {
  const positions = C.calculate(30, 30, 50);
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i], y = positions[i + 1];
    assert.ok(x >= 0 && x + 30 <= 270, `x=${x} out of bounds`);
    assert.ok(y >= 0 && y + 30 <= 270, `y=${y} out of bounds`);
  }
});

test('copy count 1 always succeeds even for oversized object', () => assert.equal(C.calculate(300, 300, 1).length, 2));

test('single copy of oversized object positions at origin not negative', () => {
  const positions = C.calculate(300, 300, 1);
  near(0, positions[0], 0.01);
  near(0, positions[1], 0.01);
});

// --- computeWipeTowerPosition tests ---

test('tower avoids centered model - picks corner with most clearance', () => {
  const [tx, ty] = C.computeWipeTowerPosition([125, 125], 20, 20, 60);
  const overlapsX = tx < 145 && tx + 60 > 125;
  const overlapsY = ty < 145 && ty + 60 > 125;
  assert.equal(overlapsX && overlapsY, false, `Tower at (${tx},${ty}) overlaps model`);
});

test('tower avoids large centered model - picks edge midpoint', () => {
  const [tx, ty] = C.computeWipeTowerPosition([70, 80], 130, 120, 60);
  const overlapsX = tx < 200 && tx + 60 > 70;
  const overlapsY = ty < 200 && ty + 60 > 80;
  assert.equal(overlapsX && overlapsY, false, `Tower at (${tx},${ty}) overlaps 130x120mm model`);
});

test('tower position is within bed bounds', () => {
  const [tx, ty] = C.computeWipeTowerPosition([125, 125], 20, 20, 60);
  assert.ok(tx >= 0 && tx + 60 <= 270, `tx=${tx} out of bounds`);
  assert.ok(ty >= 0 && ty + 60 <= 270, `ty=${ty} out of bounds`);
});

test('tower avoids multiple grid copies', () => {
  const objPos = C.calculate(50, 50, 4);
  const [tx, ty] = C.computeWipeTowerPosition(objPos, 50, 50, 60);
  for (let i = 0; i < objPos.length / 2; i++) {
    const ox = objPos[i * 2], oy = objPos[i * 2 + 1];
    const overlapsX = tx < ox + 50 && tx + 60 > ox;
    const overlapsY = ty < oy + 50 && ty + 60 > oy;
    assert.equal(overlapsX && overlapsY, false, `Tower at (${tx},${ty}) overlaps copy ${i} at (${ox},${oy})`);
  }
});

test('grid is centered on bed for small objects', () => {
  const positions = C.calculate(50, 50, 4);
  assert.equal(positions.length, 8);
  near(27.5, positions[0], 0.01);
  near(110, positions[1], 0.01);
  near(82.5, positions[2], 0.01);
  near(110, positions[3], 0.01);
});

test('grid copies all within bed bounds', () => {
  const positions = C.calculate(50, 50, 9);
  for (let i = 0; i < positions.length; i += 2) {
    assert.ok(positions[i] >= 0);
    assert.ok(positions[i + 1] >= 0);
    assert.ok(positions[i] + 50 <= 270);
    assert.ok(positions[i + 1] + 50 <= 270);
  }
});

test('three copies in a row are centered', () => {
  const positions = C.calculate(80, 80, 3);
  assert.equal(positions.length, 6);
  near(10, positions[0], 0.01);
  near(95, positions[1], 0.01);
});

test('tower picks bottom-left when model is in top-right', () => {
  const [tx, ty] = C.computeWipeTowerPosition([200, 200], 50, 50, 60);
  near(10, tx, 0.01);
  near(10, ty, 0.01);
});

test('tower position leaves skirt clearance from bed edges for all model positions', () => {
  const skirtClearance = 9.5, towerWidth = 60, bedSize = 270;
  const testCases = [
    [[105, 105], [20, 20]],
    [[200, 200], [50, 50]],
    [[10, 10], [50, 50]],
    [[105, 10], [60, 60]],
    [[85, 91], [100, 88]],
  ];
  for (const [objPos, size] of testCases) {
    const [tx, ty] = C.computeWipeTowerPosition(objPos, size[0], size[1], towerWidth, undefined, bedSize, bedSize);
    assert.ok(tx >= skirtClearance, `Tower at (${tx},${ty}): left edge too close`);
    assert.ok(ty >= skirtClearance, `Tower at (${tx},${ty}): bottom edge too close`);
    assert.ok(tx + towerWidth <= bedSize - skirtClearance, `Tower at (${tx},${ty}): right edge too close`);
    assert.ok(ty + towerWidth <= bedSize - skirtClearance, `Tower at (${tx},${ty}): top edge too close`);
  }
});

test('auto-placement uses towerDepth for Y footprint not towerWidth', () => {
  const result = C.computeWipeTowerPosition([0, 0], 135, 270, 60, 20);
  assert.ok(result[0] >= 140, `Tower X should be right of model: ${result[0]}`);
});

// --- F75: Prime tower defaults to back of plate (GitHub #90) ---

test('f75 tower defaults to back half for centered small model', () => {
  const [, ty] = C.computeWipeTowerPosition([125, 125], 20, 20, 60, 60);
  assert.ok(ty >= 135, `F75: tower must default to back of plate, got ty=${ty}`);
});

test('f75 tower defaults to back of plate when no objects', () => {
  const [tx, ty] = C.computeWipeTowerPosition([], 0, 0, 60, 60);
  near(105, tx, 0.01);
  near(200, ty, 0.01);
});

test('f75 model at back forces tower to front - file-position-style intent preserved', () => {
  const [, ty] = C.computeWipeTowerPosition([110, 200], 50, 50, 60, 60);
  assert.ok(ty < 135, `Tower should prefer front when back is occupied, got ty=${ty}`);
});

test('computeWipeTowerPosition accepts separate towerDepth', () => {
  const resultSquare = C.computeWipeTowerPosition([105, 105], 60, 60, 60, 60);
  const resultRect = C.computeWipeTowerPosition([105, 105], 60, 60, 60, 20);
  assert.ok(resultSquare[0] >= 0 && resultSquare[0] <= 210);
  assert.ok(resultSquare[1] >= 0 && resultSquare[1] <= 210);
  assert.ok(resultRect[0] >= 0 && resultRect[0] <= 210);
  assert.ok(resultRect[1] >= 0 && resultRect[1] <= 240);
});

test('single copy position is min-corner not center - 10x10 model', () => {
  const positions = C.calculate(10, 10, 1);
  near(130, positions[0], 0.01);
  near(130, positions[1], 0.01);
  near(130, positions[0], 0.01);
  near(140, positions[0] + 10, 0.01);
  near(130, positions[1], 0.01);
  near(140, positions[1] + 10, 0.01);
});

// --- B109: computeRotatedFootprint tests ---

test('b109 zero rotation returns original size', () => {
  const [w, h] = footprint(200, 100, 50, 0, 0, 0);
  near(200, w, 0.01);
  near(100, h, 0.01);
});

test('b109 90deg z rotation swaps xy footprint', () => {
  const [w, h] = footprint(200, 100, 50, 0, 0, 90);
  near(100, w, 0.5);
  near(200, h, 0.5);
});

test('b109 45deg z rotation produces larger footprint', () => {
  const [w, h] = footprint(200, 100, 50, 0, 0, 45);
  const expected = Math.fround(((200 + 100) * sqrt2) / 2.0);
  near(expected, w, 1.0);
  near(expected, h, 1.0);
});

test('b109 symmetry plus and minus rotation same footprint', () => {
  const [w1, h1] = footprint(200, 100, 50, 0, 0, 45);
  const [w2, h2] = footprint(200, 100, 50, 0, 0, -45);
  near(w1, w2, 0.01);
  near(h1, h2, 0.01);
});

test('b109 180deg rotation returns original size', () => {
  const [w, h] = footprint(200, 100, 50, 0, 0, 180);
  near(200, w, 0.5);
  near(100, h, 0.5);
});

// --- B65: Copy bed warning tests ---

test('copyBedWarning returns null when copies fit on bed', () => assert.equal(C.copyBedWarning(20, 20, 9), null));

test('copyBedWarning returns warning when copies exceed bed capacity', () => {
  assert.notEqual(C.copyBedWarning(260, 260, 2), null, 'Should warn for 2 copies of 260mm object');
});

test('copyBedWarning returns null for single copy of any size', () => assert.equal(C.copyBedWarning(300, 300, 1), null));

test('copyBedWarning returns warning at boundary', () => {
  assert.notEqual(C.copyBedWarning(80, 80, 10), null, 'Should warn for 10 copies of 80mm object');
  assert.equal(C.copyBedWarning(80, 80, 9), null);
});

// --- B109 v2.2.6 review: effectivePlacementFootprint ---

test('effectivePlacementFootprint prefers mesh AABB when supplied', () => {
  const [w, h] = C.effectivePlacementFootprint([80, 60], 100, 50, 30, 1, 1, 0, 0, 45);
  near(80, w, 0.01);
  near(60, h, 0.01);
});

test('effectivePlacementFootprint scales mesh AABB', () => {
  const [w, h] = C.effectivePlacementFootprint([80, 60], 100, 50, 30, 2, 1.5, 0, 0, 45);
  near(160, w, 0.01);
  near(90, h, 0.01);
});

test('effectivePlacementFootprint falls back to box rotation when mesh null', () => {
  const [w, h] = C.effectivePlacementFootprint(null, 100, 50, 30, 1, 1, 0, 0, 90);
  near(50, w, 0.01);
  near(100, h, 0.01);
});

test('effectivePlacementFootprint fallback applies scale after rotation', () => {
  const [w, h] = C.effectivePlacementFootprint(null, 100, 50, 30, 2, 1, 0, 0, 90);
  near(100, w, 0.01);
  near(100, h, 0.01);
});

test('effectivePlacementFootprint with mesh null and zero rotation returns load time size', () => {
  const [w, h] = C.effectivePlacementFootprint(null, 100, 50, 30, 1, 1, 0, 0, 0);
  near(100, w, 0.01);
  near(50, h, 0.01);
});

test('effectivePlacementFootprint dragonScale45deg matches mesh AABB not box envelope', () => {
  const boxRotated = footprint(200, 80, 20, 0, 0, 45);
  const meshAabb = [160, 140];
  const [w, h] = C.effectivePlacementFootprint(meshAabb, 200, 80, 20, 1, 1, 0, 0, 45);
  near(meshAabb[0], w, 0.01);
  near(meshAabb[1], h, 0.01);
  assert.ok(boxRotated[0] > meshAabb[0], 'box-rotation envelope must exceed true mesh AABB');
});

// --- buildMultiObjectPositions ---

test('buildMultiObjectPositions empty input returns empty', () => {
  assert.equal(C.buildMultiObjectPositions([]).length, 0);
});

test('buildMultiObjectPositions single object placed at margin', () => {
  const positions = C.buildMultiObjectPositions([50, 40, 10]);
  assert.equal(positions.length, 2);
  near(5, positions[0], 0.01);
  near(5, positions[1], 0.01);
});

test('buildMultiObjectPositions two objects in same row', () => {
  const positions = C.buildMultiObjectPositions([60, 50, 10, 60, 50, 10]);
  assert.equal(positions.length, 4);
  near(5, positions[0], 0.01);
  near(5, positions[1], 0.01);
  near(70, positions[2], 0.01);
  near(5, positions[3], 0.01);
});

test('buildMultiObjectPositions wraps to next row when exceeding bed', () => {
  const positions = C.buildMultiObjectPositions([200, 50, 10, 200, 50, 10]);
  assert.equal(positions.length, 4);
  near(5, positions[0], 0.01);
  near(5, positions[1], 0.01);
  near(5, positions[2], 0.01);
  near(60, positions[3], 0.01);
});

test('buildMultiObjectPositions row height tracks tallest object', () => {
  const positions = C.buildMultiObjectPositions([100, 20, 10, 100, 80, 10, 250, 30, 10]);
  assert.equal(positions.length, 6);
  near(90, positions[5], 0.01);
});

// --- placeAdditionalObject ---

test('placeAdditionalObject single existing object places new one to the right', () => {
  const result = C.placeAdditionalObject([5, 5], [60, 50, 10, 40, 30, 10]);
  assert.equal(result.length, 4);
  near(5, result[0], 0.01);
  near(5, result[1], 0.01);
  near(70, result[2], 0.01);
  near(5, result[3], 0.01);
});

test('placeAdditionalObject falls below when no room to the right', () => {
  const result = C.placeAdditionalObject([5, 5], [220, 50, 10, 80, 40, 10]);
  assert.equal(result.length, 4);
  near(5, result[0], 0.01);
  near(5, result[1], 0.01);
  near(5, result[2], 0.01);
  near(60, result[3], 0.01);
});

test('placeAdditionalObject preserves all existing positions', () => {
  const result = C.placeAdditionalObject([5, 5, 70, 5], [60, 50, 10, 60, 50, 10, 40, 30, 10]);
  assert.equal(result.length, 6);
  near(5, result[0], 0.01);
  near(5, result[1], 0.01);
  near(70, result[2], 0.01);
  near(5, result[3], 0.01);
});

test('placeAdditionalObject new object stays within bed bounds', () => {
  const boxes = [60, 50, 10, 40, 30, 10];
  const result = C.placeAdditionalObject([5, 5], boxes);
  const newX = result[2], newY = result[3];
  assert.ok(newX + boxes[3] <= 270);
  assert.ok(newY + boxes[4] <= 270);
});

test('placeAdditionalObject with one object uses buildMultiObjectPositions', () => {
  const result = C.placeAdditionalObject([], [60, 50, 10]);
  assert.equal(result.length, 2);
  assert.ok(inRange(result[0], 0, 270), `x within bed: ${result[0]}`);
  assert.ok(inRange(result[1], 0, 270), `y within bed: ${result[1]}`);
});

// --- computeWipeTowerPositionForObjects ---

test('computeWipeTowerPositionForObjects avoids all objects', () => {
  const [tx, ty] = C.computeWipeTowerPositionForObjects([5, 5, 115, 5], [100, 80, 10, 100, 80, 10]);
  const tMaxX = tx + 60, tMaxY = ty + 60;
  assert.equal(tx < 105 && tMaxX > 5 && ty < 85 && tMaxY > 5, false, 'Tower must not overlap object 0');
  assert.equal(tx < 215 && tMaxX > 115 && ty < 85 && tMaxY > 5, false, 'Tower must not overlap object 1');
});

// --- F92: autoArrange ---

const overlaps = (ax, ay, asx, asy, bx, by, bsx, bsy) => ax < bx + bsx && ax + asx > bx && ay < by + bsy && ay + asy > by;

test('autoArrange two objects no tower places both on-bed without overlap', () => {
  const r = C.autoArrange([60, 50, 10, 60, 50, 10], null, [0, 0, 0, 0]);
  assert.equal(r.overflowCount, 0);
  assert.equal(r.positions.length, 4);
  for (let i = 0; i < 2; i++) {
    assert.ok(inRange(r.positions[i * 2], 0, 270));
    assert.ok(inRange(r.positions[i * 2 + 1], 0, 270));
    assert.ok(r.positions[i * 2] + 60 <= 270);
    assert.ok(r.positions[i * 2 + 1] + 50 <= 270);
  }
  assert.equal(overlaps(r.positions[0], r.positions[1], 60, 50, r.positions[2], r.positions[3], 60, 50), false);
});

test('autoArrange avoids the reserved wipe-tower rect', () => {
  const r = C.autoArrange([80, 80, 10, 80, 80, 10, 80, 80, 10], [105, 200, 165, 260], new Float32Array(6));
  assert.equal(r.overflowCount, 0);
  for (let i = 0; i < 3; i++) {
    const x = r.positions[i * 2], y = r.positions[i * 2 + 1];
    assert.equal(overlaps(x, y, 80, 80, 105, 200, 60, 60), false, `obj ${i} overlaps tower keep-out`);
    assert.ok(inRange(x, 0, 270) && inRange(y, 0, 270) && x + 80 <= 270 && y + 80 <= 270, `obj ${i} on bed`);
  }
});

test('autoArrange reports overflow and never places off-bed', () => {
  const boxes = Array.from({ length: 18 }, (_, idx) => (idx % 3 === 2 ? 10 : 120));
  const r = C.autoArrange(boxes, null, new Array(12).fill(7));
  assert.ok(r.overflowCount > 0, 'some objects must overflow');
  for (let i = 0; i < 6; i++) {
    assert.ok(inRange(r.positions[i * 2], 0, 270));
    assert.ok(inRange(r.positions[i * 2 + 1], 0, 270));
  }
});

test('autoArrange single object centers clear of reserved rect', () => {
  const r = C.autoArrange([40, 40, 10], [105, 200, 165, 260], [0, 0]);
  assert.equal(r.overflowCount, 0);
  assert.equal(r.positions.length, 2);
  assert.equal(overlaps(r.positions[0], r.positions[1], 40, 40, 105, 200, 60, 60), false);
  assert.ok(inRange(r.positions[0], 0, 230) && inRange(r.positions[1], 0, 230));
});

test('autoArrange wraps to next shelf when row is full', () => {
  const boxes = Array.from({ length: 12 }, (_, idx) => [100, 40, 10][idx % 3]);
  const r = C.autoArrange(boxes, null, new Float32Array(8));
  assert.equal(r.overflowCount, 0);
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      assert.equal(overlaps(r.positions[a * 2], r.positions[a * 2 + 1], 100, 40,
        r.positions[b * 2], r.positions[b * 2 + 1], 100, 40), false, `obj ${a} and ${b} overlap`);
    }
  }
});
