// Mirrors app/src/test/java/com/u1/slicer/bambu/ThreeMfParserTest.kt case by case
// (data-model defaults, multi-plate detection rules, archive sizing, paint summary).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  threeMfInfo, threeMfPlate, threeMfObject, copyThreeMfInfo,
} from '../pipeline/three-mf-info.mjs';
import { ThreeMfParser } from '../pipeline/three-mf-parser.mjs';

const MB = 1024 * 1024;
const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

test('ThreeMfInfo defaults', () => {
  const info = threeMfInfo({ objects: [], plates: [], isBambu: false, isMultiPlate: false });
  assert.equal(info.isBambu, false);
  assert.equal(info.isMultiPlate, false);
  assert.equal(info.hasPaintData, false);
  assert.equal(info.hasLayerToolChanges, false);
  assert.equal(info.detectedColors.length, 0);
  assert.equal(info.detectedExtruderCount, 1);
  assert.equal(info.hasPaintSupports, false);
});

test('ThreeMfInfo hasPaintSupports defaults to false', () => {
  const info = threeMfInfo({ objects: [], plates: [], isBambu: true, isMultiPlate: false });
  assert.equal(info.hasPaintSupports, false);
});

test('ThreeMfInfo hasPaintSupports=true is preserved', () => {
  const info = threeMfInfo({ objects: [], plates: [], isBambu: true, isMultiPlate: false, hasPaintSupports: true });
  assert.equal(info.hasPaintSupports, true);
  // copy() also preserves it
  assert.equal(copyThreeMfInfo(info).hasPaintSupports, true);
});

test('ThreeMfObject data class', () => {
  const obj = threeMfObject('1', 'Cube', 8, 12);
  assert.equal(obj.objectId, '1');
  assert.equal(obj.name, 'Cube');
  assert.equal(obj.vertices, 8);
  assert.equal(obj.triangles, 12);
});

test('ThreeMfPlate data class', () => {
  const plate = threeMfPlate({ plateId: 1, name: 'Main Plate', objectIds: ['1', '2'], printable: true, transform: identity() });
  assert.equal(plate.plateId, 1);
  assert.equal(plate.name, 'Main Plate');
  assert.equal(plate.objectIds.length, 2);
  assert.equal(plate.printable, true);
});

test('ThreeMfInfo with multicolor metadata', () => {
  const info = threeMfInfo({
    objects: [threeMfObject('1', 'Part', 100, 200)],
    plates: [threeMfPlate({ plateId: 1, name: 'Plate 1', objectIds: ['1'], printable: true, transform: identity() })],
    isBambu: true,
    isMultiPlate: false,
    hasPaintData: true,
    hasLayerToolChanges: true,
    detectedColors: ['#FF0000', '#00FF00', '#0000FF'],
    detectedExtruderCount: 3,
  });
  assert.equal(info.isBambu, true);
  assert.equal(info.hasPaintData, true);
  assert.equal(info.hasLayerToolChanges, true);
  assert.equal(info.detectedColors.length, 3);
  assert.equal(info.detectedExtruderCount, 3);
});

test('ThreeMfInfo multi-plate detection', () => {
  const info = threeMfInfo({
    objects: [threeMfObject('1', 'Part A', 50, 100), threeMfObject('2', 'Part B', 60, 120)],
    plates: [
      threeMfPlate({ plateId: 1, name: 'Plate 1', objectIds: ['1'], printable: true, transform: identity() }),
      threeMfPlate({ plateId: 2, name: 'Plate 2', objectIds: ['2'], printable: true, transform: identity() }),
    ],
    isBambu: true,
    isMultiPlate: true,
  });
  assert.equal(info.isMultiPlate, true);
  assert.equal(info.plates.length, 2);
});

test('isMultiPlate uses plate JSON count not build item count', () => {
  // New-format multi-plate: detected by plateJsonCount > 1 (same regex as the parser).
  const plateJsonRegex = /^Metadata\/plate_\d+\.json$/;
  const countPlateJsons = (entries) => [...entries].filter((e) => plateJsonRegex.test(e)).length;

  // Benchy-style: 1 plate JSON, 2 build items (one printable=0) → single-plate
  const benchyEntries = new Set(['Metadata/plate_1.json', '3D/3dmodel.model']);
  assert.equal(countPlateJsons(benchyEntries), 1);
  assert.equal(countPlateJsons(benchyEntries) > 1, false, '1 plate JSON → not multi-plate by JSON count');

  // Coaster-style: 5 plate JSONs, 7 build items → multi-plate
  const coasterEntries = new Set([...[2, 3, 4, 5, 6].map((i) => `Metadata/plate_${i}.json`), '3D/3dmodel.model']);
  assert.equal(countPlateJsons(coasterEntries), 5);
  assert.equal(countPlateJsons(coasterEntries) > 1, true, '5 plate JSONs → multi-plate');
});

test('isMultiPlate detects old Bambu format via virtual plate positions', () => {
  // Old Bambu format (Dragon Scale, Shashibo): any printable item with TX > 270 or
  // TY outside [0, 270] is on a virtual plate.
  const bedSize = 270;
  const hasVirtualPlateItems = (items) => items.some((item) => {
    if (!item.printable) return false;
    return item.tx > bedSize || item.ty < 0 || item.ty > bedSize;
  });

  const dragonItems = [
    { tx: 128, ty: 128, printable: true }, // plate 1 — on bed
    { tx: 435, ty: 128, printable: true }, // plate 2 — TX > 270
    { tx: 128, ty: -179, printable: true }, // plate 3 — TY < 0
  ];
  assert.equal(hasVirtualPlateItems(dragonItems), true, 'Dragon Scale should be multi-plate');

  const benchyItems = [
    { tx: 213, ty: 194, printable: false }, // printable=0 reference — ignored
    { tx: 135, ty: 119, printable: true }, // printable=1 — on bed
  ];
  assert.equal(hasVirtualPlateItems(benchyItems), false, 'Benchy should NOT be multi-plate');

  const dualColorItems = [{ tx: 135, ty: 135, printable: true }];
  assert.equal(hasVirtualPlateItems(dualColorItems), false, 'Single-plate dual-colour should NOT be multi-plate');
});

test('assessArchiveSizing ignores main model and safe component totals', () => {
  const risk = ThreeMfParser.assessArchiveSizing([
    ['3D/3dmodel.model', 300 * MB],
    ['3D/Objects/part_1.model', 120 * MB],
    ['3D/Objects/part_2.model', 120 * MB],
  ]);
  assert.equal(risk, null);
});

test('assessArchiveSizing flags oversized single component entry', () => {
  const risk = ThreeMfParser.assessArchiveSizing([
    ['3D/Objects/part_1.model', 300 * MB],
    ['3D/Objects/part_2.model', 20 * MB],
  ]);
  assert.notEqual(risk, null);
  assert.equal(risk?.largestComponentEntry, '3D/Objects/part_1.model');
  assert.equal(risk?.largestComponentBytes, 300 * MB);
});

test('summarizePaintDetection uses per-plate visuals and suppresses file-wide count on multi-plate files', () => {
  const summary = ThreeMfParser.summarizePaintDetection(true, new Map([
    [1, ThreeMfParser.plateVisualInfo({ count: 4, hasPaint: true, objectExtruders: new Set([1]), paintExtruderStates: new Set([1, 2]) })],
    [2, ThreeMfParser.plateVisualInfo({ count: 1, hasPaint: false, objectExtruders: new Set([1]), paintExtruderStates: new Set() })],
  ]));
  assert.equal(summary.hasPaintData, true);
  assert.equal(summary.paintStateCount, 0);
});

test('summarizePaintDetection returns the plate visual count for single-plate files', () => {
  const summary = ThreeMfParser.summarizePaintDetection(false, new Map([
    [1, ThreeMfParser.plateVisualInfo({ count: 4, hasPaint: true, objectExtruders: new Set([1]), paintExtruderStates: new Set([1, 2, 3]) })],
  ]));
  assert.equal(summary.hasPaintData, true);
  assert.equal(summary.paintStateCount, 4);
});

test('assessArchiveSizing flags oversized combined component total', () => {
  const risk = ThreeMfParser.assessArchiveSizing([
    ['3D/Objects/part_1.model', 200 * MB],
    ['3D/Objects/part_2.model', 190 * MB],
  ]);
  assert.notEqual(risk, null);
  assert.equal(risk?.totalComponentBytes, 390 * MB);
  assert.equal(risk?.largestComponentEntry, '3D/Objects/part_1.model');
});
