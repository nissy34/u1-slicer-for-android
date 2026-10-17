// Smoke test: parses real fixtures from app/src/androidTest/assets with the JS
// ThreeMfParser port and checks the facts the Android instrumented tests assert
// about ThreeMfParser.parse() on the same files (test names cite the source test),
// plus a few per-plate facts documented in the B81/B82 comments.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse, parseForPlateSelection, inspectArchiveSizing } from '../pipeline/three-mf-parser.mjs';

const ASSETS = new URL('../../../app/src/androidTest/assets/', import.meta.url);
const asset = (name) => new Uint8Array(readFileSync(new URL(encodeURIComponent(name), ASSETS)));
const parseAsset = (name) => parse(asset(name));

test('colored_3DBenchy: Bambu, painted, exactly 4 colours (SemmSlicingTest B44, ProfileEmbedderIntegrationTest)', () => {
  const info = parseAsset('colored_3DBenchy (1).3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.hasPaintData, true);
  assert.equal(info.detectedColors.length, 4);
  assert.ok(info.detectedExtruderCount > 1);
  assert.equal(info.isMultiPlate, false);
  assert.equal(info.plates.length, 1);
  assert.equal(info.plates[0].hasPaintData, true);
});

test('3DBenchy-H2C-Multi-Color: painted, 7 model colours (SemmSlicingTest / Phase2AlignmentTest)', () => {
  const info = parseAsset('3DBenchy-H2C-Multi-Color.3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.hasPaintData, true);
  assert.equal(info.detectedColors.length, 7);
  assert.equal(info.isMultiPlate, false);
});

test('Dragon Scale infinity: Bambu multi-plate, 3 plates via virtual positions (BambuPipelineIntegrationTest)', () => {
  const info = parseAsset('Dragon Scale infinity.3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.isMultiPlate, true);
  assert.ok(info.plates.length > 0);
  assert.equal(info.hasPlateJsons, false); // old format: no plate_N.json
  assert.deepEqual(info.plates.map((p) => p.name), ['Dual Colour', 'Single Colour', 'Tri-Colour']);
  assert.equal(info.hasPaintData, false);
});

test('Dragon Scale 2-colour variant has >= 2 colours (BambuPipelineIntegrationTest)', () => {
  const info = parseAsset('Dragon Scale infinity-1-plate-2-colours.3mf');
  assert.equal(info.isBambu, true);
  assert.ok(info.detectedColors.length >= 2);
});

test('Korok mask (PrusaSlicer) has >= 4 colours (BambuPipelineIntegrationTest)', () => {
  const info = parseAsset('PrusaSlicer-printables-Korok_mask_4colour.3mf');
  assert.equal(info.isBambu, false);
  assert.ok(info.detectedColors.length >= 4, `was ${info.detectedColors.length}`);
  assert.equal(info.hasPaintData, true);
});

test('calib cube dual-colour has >= 2 colours (BambuPipelineIntegrationTest)', () => {
  const info = parseAsset('calib-cube-10-dual-colour-merged.3mf');
  assert.ok(info.detectedColors.length >= 2);
});

test('die-single-colour: Bambu single colour, no paint', () => {
  const info = parseAsset('die-single-colour.3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.isMultiPlate, false);
  assert.equal(info.hasPaintData, false);
  assert.equal(info.detectedColors.length, 1);
  assert.equal(info.detectedExtruderCount, 1);
  assert.equal(info.plates.length, 1);
});

test('Shashibo: layer tool changes give multi-colour state (ProfileEmbedderIntegrationTest)', () => {
  const info = parseAsset('Shashibo-h2s-textured.3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.hasLayerToolChanges, true);
  assert.ok(info.detectedColors.length > 1);
  assert.ok(info.detectedExtruderCount > 1);
  assert.equal(info.isMultiPlate, true);
});

test('flippy+flappy+mini: layer-change colours + segments, per-plate B82 colours (ProfileEmbedderIntegrationTest, NativePreparePreviewTest F46)', () => {
  const info = parseAsset('flippy+flappy+mini.3mf');
  assert.equal(info.isBambu, true);
  assert.equal(info.hasLayerToolChanges, true);
  assert.ok(info.detectedColors.length > 1);
  assert.ok(info.detectedExtruderCount > 1);
  assert.ok(info.layerToolSegments != null && info.layerToolSegments.length > 0, 'layerToolSegments populated (F46)');
  const byId = new Map(info.plates.map((p) => [p.plateId, p]));
  // B82: plate 1's layer-tool entry uses the off-palette #2323F7, plate 2's is #F4D976.
  assert.deepEqual(byId.get(1).layerToolColors, ['#2323F7']);
  assert.deepEqual(byId.get(2).layerToolColors, ['#F4D976']);
});

test('flippy painted variant: only the painted plate reports hasPaintData (B81)', () => {
  const info = parseAsset('flippy+flappy+mini-with-plate-painted.3mf');
  assert.equal(info.hasPaintData, true);
  assert.deepEqual(info.plates.map((p) => [p.plateId, p.hasPaintData]),
    [[1, false], [2, false], [3, false], [4, false], [5, true]]);
});

test('Goat: painted with 4 colours (GoatDedupeSemmTest)', () => {
  const info = parseAsset('Goat ( Gray ).3mf');
  assert.equal(info.hasPaintData, true);
  assert.equal(info.detectedColors.length, 4);
});

test('Flarewing Dragon: painted with 4 colours (SemmSlicingTest)', () => {
  const info = parseAsset('Flarewing-Dragon_100%_4FilamentMulticolor_v1.1.3mf');
  assert.equal(info.hasPaintData, true);
  assert.equal(info.detectedColors.length, 4);
});

test('Leo support fixture: Bambu, >= 2 plates, plate 1 named "Print ME" (BambuPipelineIntegrationTest B99)', () => {
  const info = parseAsset('Leo_test_Supports.3mf');
  assert.equal(info.isBambu, true);
  assert.ok(info.plates.length >= 2);
  assert.equal(info.plates.find((p) => p.plateId === 1).name, 'Print ME');
});

test('Sensory Twist: hasPaintSupports (SensoryTwistSupportsTest B57)', () => {
  assert.equal(parseAsset('SENSORY+TWIST+BALL+FIDGETS+optimised.3mf').hasPaintSupports, true);
});

test('H2C shoe: no paint data, has plates (SemmSlicingTest B122)', () => {
  const info = parseAsset('1890038_xav01_H2C_279_104.3mf');
  assert.equal(info.hasPaintData, false);
  assert.ok(info.plates.length > 0);
});

test('skywing dragon: painted, >= 3 colours (SemmSlicingTest)', () => {
  const info = parseAsset('skywing-seawing-silkwing.3mf');
  assert.equal(info.hasPaintData, true);
  assert.ok(info.detectedColors.length >= 3);
});

test('Buzz Lightyear: multi-plate (BambuPlateStateRegressionTest bug6) and parses well under 60 s', () => {
  const bytes = asset('Buzz_Multipart_3MF_Bambu.3mf');
  const start = Date.now();
  const info = parse(bytes);
  assert.ok(Date.now() - start < 60_000);
  assert.equal(info.isMultiPlate, true);
  assert.equal(info.plates.length, 10);
});

test('slip slide: parseForPlateSelection marks painted plates and keeps the 4-colour range (B84)', () => {
  const info = parseForPlateSelection(asset('slip slide spin fidget.3mf'));
  assert.deepEqual(info.plates.map((p) => [p.plateId, p.hasPaintData]), [[1, false], [2, true], [3, true]]);
  assert.equal(info.hasPaintData, true);
  assert.deepEqual(info.usedExtruderIndices, new Set([1, 2, 3, 4]));
  assert.equal(info.detectedColors.length, 4);
});

test('inspectArchiveSizing: ordinary fixtures are not flagged; non-.3mf names are ignored', () => {
  const bytes = asset('die-single-colour.3mf');
  assert.equal(inspectArchiveSizing(bytes), null);
  assert.equal(inspectArchiveSizing(bytes, { name: 'die.stl' }), null);
});

test('parse returns the empty non-Bambu info for garbage bytes or a non-3mf name', () => {
  const bad = parse(new Uint8Array([1, 2, 3, 4]));
  assert.equal(bad.isBambu, false);
  assert.equal(bad.plates.length, 0);
  const stl = parse(asset('die-single-colour.3mf'), { name: 'die.stl' });
  assert.equal(stl.isBambu, false);
});
