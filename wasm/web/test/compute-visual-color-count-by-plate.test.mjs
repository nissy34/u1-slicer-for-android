// Mirrors app/src/test/java/com/u1/slicer/bambu/ComputeVisualColorCountByPlateTest.kt
// case by case: pin tests for the per-component-cache aggregator in
// computeVisualColorCountByPlate / computePaintPresenceByPlate, with an injected
// componentScanner instead of megabyte-scale fake .model payloads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readZip, writeZip } from '../pipeline/zip.mjs';
import { ThreeMfParser } from '../pipeline/three-mf-parser.mjs';

/** Tiny .3mf-shaped zip whose declared component paths exist as (empty) entries. */
const makeZipWithEntries = (...paths) => readZip(writeZip(paths.map((name) => ({ name, data: new Uint8Array(0) }))));

/** `specCount` distinct spec strings whose first hex char encodes `state`. */
function fakeComponentInfo(state, specCount) {
  assert.ok(state >= 1 && state <= 15, 'state must be 1..15 to encode as a single hex char');
  const hexChar = state.toString(16).toUpperCase();
  const specs = new Set(Array.from({ length: specCount }, (_, i) => `${hexChar}${i.toString(16).toUpperCase().padStart(4, '0')}`));
  return ThreeMfParser.componentPaintInfo({
    paintSpecs: specs,
    allPaintStates: new Set([state]),
    paintExtruderStates: new Set([state]),
  });
}

test('cap-divergence pin - 3 components with disjoint singleton state sets union to full set', () => {
  const pathA = '3D/Objects/a.model';
  const pathB = '3D/Objects/b.model';
  const pathC = '3D/Objects/c.model';
  const entries = makeZipWithEntries(pathA, pathB, pathC);
  const plateObjectMap = new Map([[1, ['10', '11', '12']]]);
  const componentPathsByObject = new Map([['10', [pathA]], ['11', [pathB]], ['12', [pathC]]]);
  const cannedScans = new Map([
    [pathA, fakeComponentInfo(1, 35)],
    [pathB, fakeComponentInfo(2, 35)],
    [pathC, fakeComponentInfo(3, 35)],
  ]);
  const pathSeen = [];
  const scanner = (path) => { pathSeen.push(path); return cannedScans.get(path); };

  const visual = ThreeMfParser.computeVisualColorCountByPlate({
    entries, modelEntry: null, plateObjectMap, componentPathsByObject,
    extruderAssignments: new Map(), componentScanner: scanner,
  });

  const plate = visual.get(1);
  assert.ok(plate != null, 'plate 1 must be present in result');
  assert.deepEqual(plate.paintExtruderStates, new Set([1, 2, 3]),
    'paintExtruderStates must union to full disjoint set, NOT truncate to 2');
  // 105 specs vs 3 states → complex-encoding path → count == paintExtruderStates.size.
  assert.equal(plate.count, 3);
  assert.equal(plate.hasPaint, true);
  assert.deepEqual(new Set(pathSeen), new Set([pathA, pathB, pathC]));
  assert.equal(pathSeen.length, 3);
});

test('B82 plate-1 invariant pin - empty plate stays unpainted while painted plate is painted', () => {
  const unpainted = '3D/Objects/unpainted.model';
  const painted = '3D/Objects/painted.model';
  const entries = makeZipWithEntries(unpainted, painted);
  const plateObjectMap = new Map([[1, ['100']], [5, ['500']]]);
  const componentPathsByObject = new Map([['100', [unpainted]], ['500', [painted]]]);
  const emptyInfo = ThreeMfParser.componentPaintInfo({
    paintSpecs: new Set(), allPaintStates: new Set(), paintExtruderStates: new Set(),
  });
  const cannedScans = new Map([[unpainted, emptyInfo], [painted, fakeComponentInfo(3, 50)]]);

  const visual = ThreeMfParser.computeVisualColorCountByPlate({
    entries, modelEntry: null, plateObjectMap, componentPathsByObject,
    extruderAssignments: new Map(), componentScanner: (path) => cannedScans.get(path),
  });

  const plate1 = visual.get(1);
  const plate5 = visual.get(5);
  assert.ok(plate1 != null); assert.ok(plate5 != null);
  assert.equal(plate1.hasPaint, false, 'plate 1 references only unpainted components — must NOT report hasPaint');
  assert.deepEqual(plate1.paintExtruderStates, new Set());
  assert.equal(plate5.hasPaint, true, 'plate 5 references a painted component — must report hasPaint');
  assert.deepEqual(plate5.paintExtruderStates, new Set([3]));
});

test('shared-component cross-plate pin - same path via different object IDs scans once', () => {
  const shared = '3D/Objects/shared.model';
  const entries = makeZipWithEntries(shared);
  const plateObjectMap = new Map([[1, ['A1']], [2, ['B1']]]);
  const componentPathsByObject = new Map([['A1', [shared]], ['B1', [shared]]]);
  const scanCalls = [];

  const visual = ThreeMfParser.computeVisualColorCountByPlate({
    entries, modelEntry: null, plateObjectMap, componentPathsByObject,
    extruderAssignments: new Map(),
    componentScanner: (path) => { scanCalls.push(path); return fakeComponentInfo(2, 40); },
  });

  assert.deepEqual(scanCalls, [shared], 'shared component must scan exactly once across plates');
  const plate1 = visual.get(1);
  const plate2 = visual.get(2);
  assert.ok(plate1 != null); assert.ok(plate2 != null);
  assert.deepEqual(plate1.paintExtruderStates, plate2.paintExtruderStates,
    'both plates referencing the same component must see the same paint states');
  assert.deepEqual(plate1.paintExtruderStates, new Set([2]));
});

test('computePaintPresenceByPlate deduplicates shared paths and preserves per-plate presence', () => {
  const shared = '3D/Objects/shared.model';
  const unpainted = '3D/Objects/unpainted.model';
  const entries = makeZipWithEntries(shared, unpainted);
  const plateObjectMap = new Map([[1, ['A1', 'A2']], [2, ['B1']]]);
  const componentPathsByObject = new Map([['A1', [shared]], ['A2', [shared]], ['B1', [unpainted]]]);
  const scanCalls = [];

  const presence = ThreeMfParser.computePaintPresenceByPlate({
    entries, modelEntry: null, plateObjectMap, componentPathsByObject,
    componentScanner: (path) => { scanCalls.push(path); return path === shared; },
  });

  assert.deepEqual([...scanCalls].sort(), [shared, unpainted],
    'shared component must scan once even when two objects reference it');
  assert.equal(presence.get(1), true);
  assert.equal(presence.get(2), false);
});
