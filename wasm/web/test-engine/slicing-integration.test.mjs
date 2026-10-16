// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/SlicingIntegrationTest.kt on
// the wasm engine: load a real model file straight into the engine (no embed), edit
// it through the engine API the way the test drives NativeLibrary, slice with a
// SliceConfig and check the G-code. One JS test per Kotlin @Test, same names and
// assertions. The three Kotlin tests that slice 3DBenchy.stl at its load position
// with DEFAULT_CONFIG share that one slice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mmToScale } from '../pipeline/model-scale-converter.mjs';
import { applyPrintTimeRemap } from '../pipeline/print-time-remap.mjs';
import { OverrideMode, overrideValue, resolveInto, slicingOverrides } from '../pipeline/slicing-overrides.mjs';
import { sliceConfig } from '../pipeline/slice-config.mjs';
import { once } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import * as V from './gcode-validator.mjs';
import { BASE_CONFIG, NativeLib } from './native-lib.mjs';

const skip = engineAvailable ? false : 'wasm engine not built';
const DEFAULT_CONFIG = BASE_CONFIG; // same field values as SlicingIntegrationTest.DEFAULT_CONFIG
const f = Math.fround;

let lib;
async function setup() {
  lib ??= await NativeLib.create();
  lib.clearModel();
  return lib;
}
const loadAsset = (name) => lib.loadModel(asset(name), name);
const instanceOffsets = () => JSON.parse(lib.e.instanceOffsetsJson());

/** sliceAsset(name, config) -> [success, gcode|errorMessage|null]. */
function sliceAsset(name, config = DEFAULT_CONFIG) {
  if (!loadAsset(name)) return [false, null];
  const r = lib.slice(config);
  if (!r) return [false, null];
  if (!r.success) return [false, r.errorMessage];
  return [true, r.gcode ?? ''];
}
const t = (name, fn) => test(name, { skip }, async () => {
  await setup();
  try { await fn(); } finally { lib.clearModel(); }
});

// ─── STL Tests ────────────────────────────────────────────────────────────

t('tetrahedron_stl_slicesSuccessfully', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success, 'Slice should succeed');
  assert.ok(gcode != null);
  assert.ok(gcode.length > 0, 'G-code should be non-empty');
});

t('tetrahedron_stl_gcodeHasNonZeroTemps', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success);
  assert.ok(V.hasNonZeroNozzleTemps(gcode), 'G-code must contain non-zero nozzle temps');
});

t('tetrahedron_stl_slicesSuccessfully_withRotation', () => {
  assert.ok(loadAsset('tetrahedron.stl'), 'Model should load');
  assert.ok(lib.setModelRotation(90, 0, 0), 'setModelRotation should succeed');
  const result = lib.slice(DEFAULT_CONFIG);
  assert.ok(result, 'Slice result should not be null');
  assert.ok(result.success, 'Slice should succeed after rotation');
  assert.ok(result.gcodePath.length > 0, 'G-code path should be non-empty');
  assert.ok(result.gcode.length > 0, 'G-code file should be non-empty');
});

t('setModelRotation_multiObject_preservesInterObjectDistances', () => {
  assert.ok(loadAsset('flippy+flappy+mini.3mf'), 'flippy+flappy+mini.3mf should load');
  const before = instanceOffsets();
  assert.ok(before.length >= 4, 'Expected at least 2 objects');
  assert.ok(lib.setModelRotation(0, 0, 45), 'setModelRotation should succeed');
  const after = instanceOffsets();
  assert.equal(after.length, before.length, 'Instance count must not change after rotation');
  const n = before.length / 2;
  const dist = (a, i, j) => f(Math.sqrt(f(f(a[i * 2] - a[j * 2]) ** 2 + f(a[i * 2 + 1] - a[j * 2 + 1]) ** 2)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const b = dist(before, i, j);
      const a = dist(after, i, j);
      assert.ok(Math.abs(b - a) <= 0.5, `Distance between objects ${i} and ${j} should be preserved after rotation: expected ${b} actual ${a}`);
    }
  }
});

t('setModelRotation_invalidatesPreviewMesh_soSubsequentFetchReturnsRotatedGeometry', () => {
  assert.ok(loadAsset('tetrahedron.stl'), 'Model should load');
  const meshBefore = lib.getPreparePreviewMesh();
  assert.ok(meshBefore != null, 'Initial preview mesh should not be null');
  assert.ok(lib.setModelRotation(90, 0, 0), 'setModelRotation should succeed');
  const meshAfter = lib.getPreparePreviewMesh();
  assert.ok(meshAfter != null, 'Post-rotation preview mesh should not be null');
  const before = meshBefore.positions;
  const after = meshAfter.positions;
  assert.equal(after.length, before.length, 'Triangle count must be the same after rotation');
  assert.ok(before.some((v, i) => v !== after[i]), 'Mesh vertex positions must change after 90° X rotation — confirms cache was invalidated');
});

t('setModelRotation_sameValueSkips_cacheNotInvalidated', () => {
  assert.ok(loadAsset('tetrahedron.stl'), 'Model should load');
  assert.ok(lib.setModelRotation(0, 0, 45), 'First rotation should succeed');
  const mesh1 = lib.getPreparePreviewMesh();
  assert.ok(mesh1 != null, 'Mesh after first rotation');
  assert.ok(lib.setModelRotation(0, 0, 45), 'Same rotation should succeed');
  const mesh2 = lib.getPreparePreviewMesh();
  assert.ok(mesh2 != null, 'Mesh after second (identical) rotation');
  assert.deepEqual(mesh2.positions, mesh1.positions, 'Identical rotation must return same cached mesh positions');
});

t('setModelRotation_preservesEmbedded3mfRotation', () => {
  assert.ok(loadAsset('calib-cube-10-dual-colour-merged.3mf'), 'Model should load');
  assert.ok(lib.getModelInfo() != null, 'ModelInfo should exist');
  assert.ok(lib.setModelRotation(0, 0, 0), 'setModelRotation(0,0,0) should succeed');
  const meshAfterZero = lib.getPreparePreviewMesh();
  assert.ok(meshAfterZero != null, 'Mesh after zero rotation');
  assert.ok(lib.setModelRotation(0, 0, 45), 'setModelRotation(0,0,45) should succeed');
  const meshAfter45 = lib.getPreparePreviewMesh();
  assert.ok(meshAfter45 != null, 'Mesh after 45° rotation');
  const before = meshAfterZero.positions;
  const after = meshAfter45.positions;
  assert.equal(after.length, before.length, 'Triangle count must match');
  assert.ok(before.some((v, i) => v !== after[i]), 'Adding 45° Z rotation on top of embedded rotation must change mesh');
});

t('tetrahedron_stl_singleExtruderHasNoToolChanges', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success);
  assert.ok(V.lacksToolChanges(gcode, 'T1', 'T2', 'T3'), 'No T1+ tool changes for single-extruder print');
});

/** benchy_stl_slicesSuccessfully / hasReasonableLayerCount / estimatedTimeIsReasonable: one identical slice. */
const benchyDefault = once(async () => {
  await setup();
  assert.ok(loadAsset('3DBenchy.stl'));
  const r = lib.slice(DEFAULT_CONFIG);
  lib.clearModel();
  return r;
});

t('benchy_stl_slicesSuccessfully', async () => {
  const r = await benchyDefault();
  assert.ok(r.success, '3DBenchy slice should succeed');
  assert.ok(r.gcode != null);
  assert.ok(r.gcode.length > 0);
});

t('benchy_stl_hasReasonableLayerCount', async () => {
  const r = await benchyDefault();
  assert.ok(r.success);
  assert.ok(r.totalLayers > 100, `Layer count should be >100, was ${r.totalLayers}`);
  assert.ok(r.totalLayers < 600, `Layer count should be <600, was ${r.totalLayers}`);
});

t('benchy_stl_estimatedTimeIsReasonable', async () => {
  const r = await benchyDefault();
  assert.ok(r.success);
  const minutes = r.estimatedTimeSeconds / 60;
  assert.ok(r.estimatedTimeSeconds > 300, `Estimated time should be > 5 min (was ${minutes}m)`);
  assert.ok(r.estimatedTimeSeconds < 7200, `Estimated time should be < 120 min (was ${minutes}m)`);
});

// ─── Single-colour 3MF Tests ──────────────────────────────────────────────

t('fanCover_3mf_slicesSuccessfully', () => {
  const [success, gcode] = sliceAsset('u1-auxiliary-fan-cover-hex_mw.3mf');
  assert.ok(success, 'Fan cover slice should succeed');
  assert.ok(gcode != null);
  assert.ok(gcode.length > 0);
});

t('fanCover_3mf_gcodeHasNonZeroTemps', () => {
  const [success, gcode] = sliceAsset('u1-auxiliary-fan-cover-hex_mw.3mf');
  assert.ok(success);
  assert.ok(V.hasNonZeroNozzleTemps(gcode));
});

t('buttonTrousers_3mf_slicesSuccessfully', () => {
  const [success, gcode] = sliceAsset('Button-for-S-trousers.3mf');
  assert.ok(success, 'Button-for-S-trousers slice should succeed');
  assert.ok(gcode != null);
  assert.ok(gcode.length > 0);
});

// ─── Toolchange retraction regression ──────────────────────────────────────

function assertToolchangeRetract(gcode) {
  const vals = V.extractToolchangeRetractLength(gcode);
  assert.ok(vals != null, 'retract_length_toolchange must be in G-code config');
  for (const v of vals) assert.ok(v <= 2.0, `retract_length_toolchange=${v} must be ≤ 2mm (direct drive), not bowden 10mm`);
}

t('singleExtruder_toolchangeRetractLength_notBowdenDefault', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success);
  assertToolchangeRetract(gcode);
});

t('singleExtruder_maxRetraction_notExcessive', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success);
  const m = V.maxRetractionMm(gcode);
  assert.ok(m <= 5.0, `Max retraction ${m}mm must be ≤ 5mm for direct drive`);
});

function dualTetra() {
  assert.ok(loadAsset('tetrahedron.stl'));
  const r = lib.slice({ ...DEFAULT_CONFIG, extruderCount: 2 });
  assert.ok(r);
  assert.ok(r.success, 'Dual-extruder slice should succeed');
  return r.gcode;
}

t('dualExtruder_toolchangeRetractLength_notBowdenDefault', () => assertToolchangeRetract(dualTetra()));

t('dualExtruder_maxRetraction_notExcessive', () => {
  const m = V.maxRetractionMm(dualTetra());
  assert.ok(m <= 5.0, `Max retraction ${m}mm must be ≤ 5mm for direct drive`);
});

t('dualExtruder_noBowdenUnloadSequence', () => {
  assert.ok(!V.hasBowdenUnloadSequence(dualTetra()), "G-code must NOT contain '; Retract(unload)' bowden sequence");
});

// ─── SliceResult metadata ─────────────────────────────────────────────────

t('sliceResult_filamentEstimateIsPositive', () => {
  assert.ok(loadAsset('tetrahedron.stl'));
  const r = lib.slice(DEFAULT_CONFIG);
  assert.ok(r.success);
  assert.ok(r.estimatedFilamentMm > 0, `Filament mm should be > 0, was ${r.estimatedFilamentMm}`);
});

t('sliceResult_gcodePathIsWritable', () => {
  assert.ok(loadAsset('tetrahedron.stl'));
  const r = lib.slice(DEFAULT_CONFIG);
  assert.ok(r.success);
  assert.ok(r.gcode != null, 'G-code file should exist');
  assert.ok(r.gcode.length > 0, 'G-code file should be > 0 bytes');
});

// ─── Bed bounds validation ─────────────────────────────────────────────────

function centreAndSlice(name, config) {
  assert.ok(loadAsset(name));
  const info = lib.getModelInfo();
  lib.setModelInstances([f((270 - info.sizeX) / 2), f((270 - info.sizeY) / 2)]);
  return lib.slice(config);
}

t('benchy_stl_gcodeWithinBedBounds', () => {
  const r = centreAndSlice('3DBenchy.stl', DEFAULT_CONFIG);
  assert.ok(r.success, 'Benchy should slice successfully');
  const b = V.checkBedBounds(r.gcode);
  assert.ok(b.withinBounds, `All X/Y coordinates must be within 0-270mm bed. X: ${b.minX}..${b.maxX}, Y: ${b.minY}..${b.maxY}. ` +
    `Violations: ${b.violatingLines.slice(0, 3)}`);
});

t('tetrahedron_stl_gcodeWithinBedBounds', () => {
  const r = centreAndSlice('tetrahedron.stl', DEFAULT_CONFIG);
  assert.ok(r.success, 'Tetrahedron should slice successfully');
  const b = V.checkBedBounds(r.gcode);
  assert.ok(b.withinBounds, `All X/Y must be within 0-270mm. X: ${b.minX}..${b.maxX}, Y: ${b.minY}..${b.maxY}`);
});

t('threeMf_gcodeWithinBedBounds', () => {
  const r = centreAndSlice('calib-cube-10-dual-colour-merged.3mf', { ...DEFAULT_CONFIG, extruderCount: 2 });
  assert.ok(r.success, '3MF should slice successfully');
  const b = V.checkBedBounds(r.gcode);
  assert.ok(b.withinBounds, `3MF G-code X/Y must be within 0-270mm. X: ${b.minX}..${b.maxX}, Y: ${b.minY}..${b.maxY}`);
});

t('f77_twoStls_placeAndSlice_gcodeWithinBedBounds', () => {
  const path = lib.write(asset('tetrahedron.stl'), 'tetrahedron.stl');
  assert.ok(lib.loadModel(path), 'First STL must load');
  assert.ok(lib.addModel(path), 'Second STL must add via addModel');
  assert.equal(lib.e.objectCount(), 2, 'Both STLs must appear as separate objects');
  assert.ok(lib.setObjectPositions([10, 10, 60, 10]), 'setObjectPositions must succeed for 2-object bed');
  const r = lib.slice(DEFAULT_CONFIG);
  assert.ok(r, 'Slice must return a result');
  assert.ok(r.success, `Slice must succeed for two-STL bed, got: ${r.errorMessage}`);
  const b = V.checkBedBounds(r.gcode);
  assert.ok(b.withinBounds, `All G-code X/Y moves must stay within the 270×270mm bed. X: ${b.minX}..${b.maxX}, Y: ${b.minY}..${b.maxY}. ` +
    `Violations: ${b.violatingLines.slice(0, 3)}`);
});

// ─── resolveInto / SlicingOverrides integration ───────────────────────────

const cfgOf = (c) => sliceConfig(c);

t('override_layerHeight_producesCorrectLayerCount', () => {
  loadAsset('tetrahedron.stl');
  const r02 = lib.slice(DEFAULT_CONFIG);
  assert.ok(r02.success, '0.2mm slice should succeed');
  lib.clearModel();
  loadAsset('tetrahedron.stl');
  const cfg03 = resolveInto(slicingOverrides({ layerHeight: overrideValue(OverrideMode.OVERRIDE, f(0.3)) }), cfgOf(DEFAULT_CONFIG));
  assert.ok(Math.abs(cfg03.layerHeight - 0.3) <= 0.001);
  const r03 = lib.slice(cfg03);
  assert.ok(r03.success, '0.3mm slice should succeed');
  assert.ok(r03.totalLayers < r02.totalLayers, `0.3mm should produce fewer layers than 0.2mm (got ${r03.totalLayers} vs ${r02.totalLayers})`);
});

t('orcaDefault_layerHeight_matchesFactoryDefault', () => {
  loadAsset('tetrahedron.stl');
  const rDirect = lib.slice({ ...DEFAULT_CONFIG, layerHeight: 0.2 });
  assert.ok(rDirect.success);
  lib.clearModel();
  loadAsset('tetrahedron.stl');
  const cfg = resolveInto(slicingOverrides({ layerHeight: overrideValue(OverrideMode.ORCA_DEFAULT) }), cfgOf({ ...DEFAULT_CONFIG, layerHeight: 0.4 }));
  assert.ok(Math.abs(cfg.layerHeight - 0.2) <= 0.001, 'ORCA_DEFAULT should resolve to 0.2');
  const rDefault = lib.slice(cfg);
  assert.ok(rDefault.success);
  assert.equal(rDefault.totalLayers, rDirect.totalLayers, 'ORCA_DEFAULT layer height should produce same layer count as explicit 0.2mm');
});

t('useFile_passthrough_keepsCfgLayerHeight', () => {
  loadAsset('tetrahedron.stl');
  const resolved = resolveInto(slicingOverrides(), cfgOf({ ...DEFAULT_CONFIG, layerHeight: 0.3 }));
  assert.ok(Math.abs(resolved.layerHeight - 0.3) <= 0.001);
  const r = lib.slice(resolved);
  assert.ok(r.success, 'USE_FILE passthrough should slice successfully');
  assert.ok(r.totalLayers > 0, 'Should produce layers');
});

t('override_infillDensity_affectsFilamentEstimate', () => {
  loadAsset('tetrahedron.stl');
  const rLow = lib.slice({ ...DEFAULT_CONFIG, fillDensity: 0.10 });
  assert.ok(rLow.success);
  lib.clearModel();
  loadAsset('tetrahedron.stl');
  const cfgHigh = resolveInto(slicingOverrides({ infillDensity: overrideValue(OverrideMode.OVERRIDE, f(0.5)) }), cfgOf(DEFAULT_CONFIG));
  assert.ok(Math.abs(cfgHigh.fillDensity - 0.5) <= 0.001);
  const rHigh = lib.slice(cfgHigh);
  assert.ok(rHigh.success);
  assert.ok(rHigh.estimatedFilamentMm > rLow.estimatedFilamentMm,
    `50% infill should use more filament than 10% (${rHigh.estimatedFilamentMm} vs ${rLow.estimatedFilamentMm})`);
});

t('override_supports_enabledAppearsInGcode', () => {
  loadAsset('tetrahedron.stl');
  const cfg = resolveInto(slicingOverrides({ supports: overrideValue(OverrideMode.OVERRIDE, true) }), cfgOf(DEFAULT_CONFIG));
  assert.ok(cfg.supportEnabled, 'Supports should be enabled');
  const r = lib.slice(cfg);
  assert.ok(r.success, 'Slice with support should succeed');
  const g = r.gcode.toLowerCase();
  assert.ok(g.includes('; support') || g.includes('support') || g.includes(';type:support'), 'G-code should contain support-related content');
});

t('orcaDefault_supports_disabledInGcode', () => {
  loadAsset('tetrahedron.stl');
  const cfg = resolveInto(slicingOverrides({ supports: overrideValue(OverrideMode.ORCA_DEFAULT) }), cfgOf({ ...DEFAULT_CONFIG, supportEnabled: true }));
  assert.ok(!cfg.supportEnabled, 'ORCA_DEFAULT support should be false');
  const r = lib.slice(cfg);
  assert.ok(r.success, 'Slice should succeed without support');
});

// ─── B79: STL UI settings passed to native slicer ─────────────────────────

t('benchy_stl_treeSupportType_producesTreeSupportInGcode', () => {
  assert.ok(loadAsset('3DBenchy.stl'));
  const r = lib.slice({ ...DEFAULT_CONFIG, supportEnabled: true, supportType: 'tree(auto)', supportAngle: 30 });
  assert.ok(r.success, 'Slice with tree support should succeed');
  assert.ok(r.gcode.includes('support_type = tree(auto)'), 'G-code config dump should record support_type = tree(auto)');
});

t('tetrahedron_stl_zeroBrimWidth_producesNoBrimType', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, brimWidth: 0 });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode.includes('brim_type = no_brim'), 'G-code config should record brim_type = no_brim when brim_width=0');
});

t('tetrahedron_stl_slicingOverrides_supportType_resolveIntoChain', () => {
  loadAsset('tetrahedron.stl');
  const cfg = resolveInto(slicingOverrides({
    supports: overrideValue(OverrideMode.OVERRIDE, true), supportType: overrideValue(OverrideMode.OVERRIDE, 'tree(auto)'),
  }), cfgOf(DEFAULT_CONFIG));
  assert.equal(cfg.supportType, 'tree(auto)', 'resolveInto must propagate tree(auto)');
  const r = lib.slice(cfg);
  assert.ok(r.success, 'Slice should succeed');
  assert.ok(r.gcode.includes('support_type = tree(auto)'), 'G-code config dump should record support_type = tree(auto) via resolveInto chain');
});

t('tetrahedron_stl_filamentType_petg_appearsInGcode', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, nozzleTemp: 235, filamentType: 'PETG' });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode.includes('filament_type = PETG'), 'G-code must report filament_type = PETG');
});

t('tetrahedron_stl_supportAndInterfaceFilaments_appearInGcode', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', {
    ...DEFAULT_CONFIG, supportEnabled: true, supportType: 'normal(auto)', extruderCount: 4,
    filamentTypes: ['PLA', 'PLA', 'PETG', 'PLA'], extruderTemps: [220, 220, 235, 220], supportFilament: 3, supportInterfaceFilament: 4,
  });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode.includes('support_filament = 3'), 'G-code must preserve support_filament = 3');
  assert.ok(gcode.includes('support_interface_filament = 4'), 'G-code must preserve support_interface_filament = 4');
  assert.ok(V.hasExactGcodeLine(gcode, '; nozzle_temperature = 220,220,235,220'), 'G-code must preserve PETG temp for physical slot E3');
});

const B99_PETG34 = {
  supportEnabled: true, supportType: 'normal(auto)', supportAngle: 45, extruderCount: 4,
  filamentTypes: ['PLA', 'PLA', 'PETG', 'PETG'], extruderTemps: [220, 220, 235, 235], supportFilament: 3, supportInterfaceFilament: 4,
  wipeTowerEnabled: true, wipeTowerWidth: 60,
};
function assertPetg34(gcode) {
  assert.ok(gcode.includes('support_filament = 3'), 'G-code must preserve support_filament = 3');
  assert.ok(gcode.includes('support_interface_filament = 4'), 'G-code must preserve support_interface_filament = 4');
  assert.ok(V.hasExactGcodeLine(gcode, '; nozzle_temperature = 220,220,235,235'), 'G-code must preserve PETG temps for physical slots E3/E4');
  assert.ok(V.hasExactGcodeLine(gcode, '; filament_type = PLA;PLA;PETG;PETG'), 'Native STL slicing must receive per-slot material types before slicing');
  const used = V.filamentUsedMm(gcode);
  assert.ok((used[2] ?? 0) > 0, `Support slot E3 must have extrusion, filament used = ${used}`);
}

t('benchy_stl_supportPetgE3_interfacePetgE4_slicesSuccessfully', () => {
  const [success, gcode] = sliceAsset('3DBenchy.stl', { ...DEFAULT_CONFIG, ...B99_PETG34, wipeTowerX: 170, wipeTowerY: 140 });
  assert.ok(success, 'Benchy with PETG support E3/interface E4 must slice');
  assertPetg34(gcode);
});

const APP_PLACED = { firstLayerHeight: 0.3, printSpeed: 60, travelSpeed: 150, firstLayerSpeed: 20, nozzleTemp: 220, bedTemp: 60 };

t('benchy_stl_appPlaced_supportPetgE3_interfacePetgE4_slicesSuccessfully', () => {
  assert.ok(loadAsset('3DBenchy.stl'), 'Model must load');
  assert.ok(lib.setModelInstances([f(104.999504), f(119.498)]), 'App-style single-copy placement must succeed');
  const r = lib.slice({ ...DEFAULT_CONFIG, ...APP_PLACED, ...B99_PETG34, wipeTowerX: 200, wipeTowerY: 10 });
  assert.ok(r, 'slice() must not return null');
  assert.ok(r.success, `App-placed Benchy with PETG support E3/interface E4 must slice: ${r.errorMessage}`);
  assertPetg34(r.gcode);
});

t('benchy_stl_appPlaced_supportPetgE2_interfacePetgE3_slicesSuccessfully', () => {
  assert.ok(loadAsset('3DBenchy.stl'), 'Model must load');
  assert.ok(lib.setModelInstances([f(104.999504), f(119.498)]), 'App-style single-copy placement must succeed');
  const r = lib.slice({ ...DEFAULT_CONFIG, ...APP_PLACED, supportEnabled: true, supportType: 'normal(auto)', supportAngle: 45,
    extruderCount: 4, filamentTypes: ['PLA', 'PETG', 'PETG', 'PLA'], extruderTemps: [220, 235, 235, 220], supportFilament: 2,
    supportInterfaceFilament: 3, wipeTowerEnabled: true, wipeTowerX: 200, wipeTowerY: 10, wipeTowerWidth: 60 });
  assert.ok(r, 'slice() must not return null');
  assert.ok(r.success, `App-placed Benchy with PETG support E2/interface PETG E3 must slice: ${r.errorMessage}`);
  const g = r.gcode;
  assert.ok(g.includes('support_filament = 2'), 'G-code must preserve support_filament = 2');
  assert.ok(g.includes('support_interface_filament = 3'), 'G-code must preserve support_interface_filament = 3');
  assert.ok(V.hasExactGcodeLine(g, '; nozzle_temperature = 220,235,235') || V.hasExactGcodeLine(g, '; nozzle_temperature = 220,235,235,220'),
    'G-code must preserve PETG temps for active E2/E3 support slots');
  assert.ok(V.hasExactGcodeLine(g, '; filament_type = PLA;PETG;PETG') || V.hasExactGcodeLine(g, '; filament_type = PLA;PETG;PETG;PLA'),
    'Native STL slicing must receive per-slot support/interface material types before slicing');
  const used = V.filamentUsedMm(g);
  assert.ok((used[1] ?? 0) > 0, `Support slot E2 must have extrusion, filament used = ${used}`);
  assert.ok((used[2] ?? 0) > 0, `Interface slot E3 must have extrusion, filament used = ${used}`);
});

test.skip('sliceCancelReturnsCancelledResult',
  'Android-only: cancels from a second thread while slice() blocks on a background thread; the wasm API exposes no cancelSlice ' +
  'and slice() runs synchronously on the calling (main) thread, so there is no way to signal it mid-slice');

// ─── B73: Scale-down correct bed placement ──────────────────────────────────

t('setModelInstances_withScale_placesInstanceAtCorrectOffset', () => {
  assert.ok(loadAsset('u1-auxiliary-fan-cover-hex_mw.3mf'), 'Fan cover should load');
  const info = lib.getModelInfo();
  const p1x = f((270 - info.sizeX) / 2);
  const p1y = f((270 - info.sizeY) / 2);
  lib.setModelInstances([p1x, p1y]);
  const offsets1 = instanceOffsets();
  assert.ok(offsets1.length >= 2, 'Model must produce at least one instance offset');
  const meshMinX = f(p1x - offsets1[0]);
  const meshMinY = f(p1y - offsets1[1]);
  lib.setModelScale(0.5, 0.5, 0.5);
  const scale = 0.5;
  const p2x = f((270 - f(info.sizeX * scale)) / 2);
  const p2y = f((270 - f(info.sizeY * scale)) / 2);
  lib.setModelInstances([p2x, p2y]);
  const offsets2 = instanceOffsets();
  const expX = f(p2x - f(scale * meshMinX));
  const expY = f(p2y - f(scale * meshMinY));
  assert.ok(Math.abs(expX - offsets2[0]) <= 0.5, `B73: instance offset X at scale=0.5 should be p2x - 0.5*meshMinX (expected ${expX}, got ${offsets2[0]}, ` +
    `p2x=${p2x}, meshMinX=${meshMinX}, p1x=${p1x}, offset1x=${offsets1[0]})`);
  assert.ok(Math.abs(expY - offsets2[1]) <= 0.5, `B73: instance offset Y at scale=0.5 should be p2y - 0.5*meshMinY (expected ${expY}, got ${offsets2[1]}, ` +
    `p2y=${p2y}, meshMinY=${meshMinY}, p1y=${p1y}, offset1y=${offsets1[1]})`);
});

// ─── B75 ─────────────────────────────────────────────────────────────────

t('dualExtruder_parkedExtruder_coolsToStandbyTemp', () => {
  const r = centreAndSlice('calib-cube-10-dual-colour-merged.3mf', { ...DEFAULT_CONFIG, extruderCount: 2 });
  assert.ok(r, 'Dual-colour slice must succeed');
  assert.ok(r.success, 'Dual-colour slice must succeed');
  assert.ok(r.gcode.includes(';cooldown'), "G-code must contain ';cooldown' M104 commands to park idle extruders at standby temp " +
    '(embedded profile has ooze_prevention=0 + SEMM=1 which must be overridden)');
});

// ─── Nozzle temperature JNI path ─────────────────────────────────────────

t('nozzleTemp_fromExtruderTemps_appearsInGcode_PLA', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, nozzleTemp: 220, extruderTemps: [220] });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode.includes('; nozzle_temperature = 220'), 'G-code must contain nozzle_temperature = 220');
});

t('nozzleTemp_fromExtruderTemps_appearsInGcode_PETG', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, nozzleTemp: 235, extruderTemps: [235], filamentType: 'PETG' });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode.includes('; nozzle_temperature = 235'), 'G-code must contain nozzle_temperature = 235 when PETG extruderTemps set');
});

t('tetrahedron_stl_sliced_gcodeContainsExcludeObjectDefine', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl');
  assert.ok(success, 'Slice should succeed');
  assert.ok(gcode != null);
  assert.ok(gcode.includes('EXCLUDE_OBJECT_DEFINE'), 'G-code must contain EXCLUDE_OBJECT_DEFINE — rebuild native with exclude_object=true');
});

t('mixedFilament_recipeFromSliceConfig_reachesEngineConfigInGcode', () => {
  const recipe = '1,2,1,50';
  const [okWith, gcodeWith] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, extruderCount: 2, mixedFilamentDefinitions: recipe });
  assert.ok(okWith, 'Slice with mixed-filament recipe must succeed');
  assert.ok(gcodeWith != null, 'G-code must be produced');
  assert.ok(gcodeWith.includes('mixed_filament_definitions') && gcodeWith.includes(recipe),
    `G-code must contain the mixed_filament_definitions key when SliceConfig sets it. Recipe '${recipe}' did not appear in G-code — the wiring is broken.`);
  lib.clearModel();
  const [okWithout, gcodeWithout] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, extruderCount: 2 });
  assert.ok(okWithout, 'Slice without recipe must succeed');
  assert.ok(gcodeWithout != null, 'G-code must be produced');
  assert.ok(!(gcodeWithout.includes(`mixed_filament_definitions = ${recipe}`) || gcodeWithout.includes('mixed_filament_definitions = 1,2,1,50')),
    'G-code must NOT contain a non-empty mixed_filament_definitions value when SliceConfig leaves the field empty.');
});

t('b107_stlSlice_bedTemp65_initialLayerNotBumped', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, bedTemp: 65 });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode != null);
  assert.ok(!gcode.includes('; bed_temperature_initial_layer = 70'), 'B107: first-layer bed temp must not be silently bumped to 70 when user set 65');
  assert.ok(gcode.includes('; hot_plate_temp = 65'), 'B107: hot_plate_temp header must reflect user setting of 65');
});

t('b106_stlSlice_machineStartGcodeInjected', () => {
  const [success, gcode] = sliceAsset('tetrahedron.stl', { ...DEFAULT_CONFIG, machineStartGcode: 'PRINT_START_SENTINEL' });
  assert.ok(success, 'Slice must succeed');
  assert.ok(gcode != null);
  assert.ok(gcode.includes('PRINT_START_SENTINEL'), 'B106: machine_start_gcode must appear in G-code when injected via SliceConfig');
});

t('b106_stlSlice_e3SendTimeRemap_rewritesT0ToT2', () => {
  assert.ok(loadAsset('tetrahedron.stl'), 'Model must load');
  const r = lib.slice({ ...DEFAULT_CONFIG, machineStartGcode: 'T0' });
  assert.ok(r?.success === true, 'Slice must succeed');
  assert.ok(r.gcode.includes('T0'), 'Source G-code must contain T0 from injected start gcode');
  const remapped = applyPrintTimeRemap({ gcodeText: r.gcode, colorMapping: [2] });
  assert.ok(!remapped.includes('\nT0\n'), 'B106: T0 must not remain after remap to E3');
  assert.ok(remapped.includes('T2'), 'B106: T2 must appear after remap to E3');
});

t('b108_articulatedFish_scaledTo60pct_slicesWithModelOnBed', () => {
  assert.ok(loadAsset('Articulated+Fish+(3).3mf'), 'B108: model must load');
  lib.setModelScale(0.6, 0.6, 0.6);
  const info = lib.getModelInfo();
  assert.ok(info != null, 'B108: model info must be available after load');
  const s = f(0.6);
  lib.setModelInstances([f((270 - f(info.sizeX * s)) / 2), f((270 - f(info.sizeY * s)) / 2)]);
  const r = lib.slice(DEFAULT_CONFIG);
  assert.ok(r, 'B108: slice at 60% must not crash — model may be floating above bed');
  assert.ok(r.success, `B108: scale-down must not produce empty initial layer (model must sit on bed); error: ${r.errorMessage}`);
});

t('f83_mmScalePath_producesExpectedSlicedHeight', () => {
  assert.ok(loadAsset('tetrahedron.stl'), 'F83: tetrahedron must load');
  const info = lib.getModelInfo();
  const targetMm = 30;
  const scaleZ = mmToScale(targetMm, info.sizeZ);
  lib.setModelScale(scaleZ, scaleZ, scaleZ);
  const centered = f((270 - f(info.sizeX * scaleZ)) / 2);
  lib.setModelInstances([centered, centered]);
  const r = lib.slice(DEFAULT_CONFIG);
  assert.ok(r.success, 'F83: mm-driven slice must succeed');
  const expectedLayers = Math.trunc(f(targetMm / f(DEFAULT_CONFIG.layerHeight)));
  const tolerance = Math.max(Math.trunc(f(expectedLayers * f(0.15))), 5);
  assert.ok(r.totalLayers >= expectedLayers - tolerance && r.totalLayers <= expectedLayers + tolerance,
    `F83: layer count for ${targetMm} mm tall print should be ~${expectedLayers} (±${tolerance}), got ${r.totalLayers}`);
});

test.skip('f77_multiStl_combinerProducesSliceableFile',
  'drives com.u1.slicer.model.MultiStlCombiner.combine (Kotlin STL combiner), which has no port in wasm/web/pipeline');

t('b108_skywingMultiObject_perInstanceZOffsets_bedSnappedAfterScale', () => {
  assert.ok(loadAsset('skywing-seawing-silkwing.3mf'), 'B108 multi-object: model must load');
  lib.setModelScale(0.8, 0.8, 0.8);
  const zMins = JSON.parse(lib.e.instanceWorldZMinsJson());
  assert.ok(zMins.length >= 2, `B108 multi-object: fixture must produce at least 2 instances (one per build item), got ${zMins.length}`);
  zMins.forEach((z, i) => assert.ok(Math.abs(z) <= 0.01,
    `B108 multi-object: instance ${i} must sit on the bed after scale (world min.z must be ~0); got worldZMins=${zMins}`));
});

t('f66_setVolumeExtruder_producesPerVolumeToolChangesInSlicedGcode', () => {
  assert.ok(loadAsset('Button-for-S-trousers.3mf'), 'Button-for-S-trousers should load');
  const objs = lib.objects();
  const objCount = lib.e.objectCount();
  assert.ok(objCount >= 1, `Button fixture must have ≥1 object, got ${objCount}`);
  assert.ok(objs[0].volumes.length >= 2, `Button object 0 must have ≥2 volumes, got ${objs[0].volumes.length}`);
  for (let o = 0; o < objCount; o++) {
    for (let v = 0; v < objs[o].volumes.length; v++) {
      assert.ok(lib.e.setVolumeExtruder(o, v, 1), `nativeSetVolumeExtruder(${o}, ${v}, 1) should succeed`);
    }
  }
  assert.ok(lib.e.setVolumeExtruder(0, 0, 3));
  assert.equal(lib.objects()[0].volumes[0].extruder, 3);
  const r = lib.slice({ ...DEFAULT_CONFIG, extruderCount: 4 });
  assert.ok(r, 'Slice should not be null');
  assert.ok(r.success, 'Slice should succeed');
  assert.ok(r.gcode.length > 0, 'G-code must be non-empty');
  const t2Count = r.gcode.split('\n').filter((l) => l.trim() === 'T2').length;
  assert.ok(t2Count > 0, 'After setVolumeExtruder(obj 0, vol 0, slot 3) the sliced G-code must contain at least one `T2` tool change ' +
    `line — proves the per-part extruder assignment reaches the slicer engine. Found T2=${t2Count}.`);
});
