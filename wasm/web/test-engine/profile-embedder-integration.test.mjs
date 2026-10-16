// Mirrors the cases of app/src/androidTest/java/com/u1/slicer/slicing/ProfileEmbedderIntegrationTest.kt
// that wasm/web/test/profile-embedder-integration.test.mjs skipped: the ones that
// need the native engine (loadModel / slice / G-code) and the ThreeMfParser /
// mergeThreeMfInfoForPlate detection cases (the parser port now exists). The
// ZIP/config-only cases stay in the unit test file and are not repeated here.
// Pipeline as in Kotlin fullPipeline(): ThreeMfParser.parse -> BambuSanitizer.process
// (Bambu only) -> ProfileEmbedder.buildConfig(info) + embed -> engine loadModel -> slice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlate, restructurePlateFile } from '../pipeline/bambu-sanitizer.mjs';
import { injectFrom3mf } from '../pipeline/layer-tool-pause-injector.mjs';
import { mergeThreeMfInfoForPlate } from '../pipeline/merge-three-mf-info.mjs';
import { threeMfInfo } from '../pipeline/three-mf-info.mjs';
import { parse, parseForPlateSelection } from '../pipeline/three-mf-parser.mjs';
import { readZip, writeZip, encodeText, decodeText, STORED } from '../pipeline/zip.mjs';
import { newEmbedder, processAuto } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import * as V from './gcode-validator.mjs';
import { BASE_CONFIG, NativeLib } from './native-lib.mjs';

const skip = engineAvailable ? false : 'wasm engine not built';
const embedder = newEmbedder();
const defaultSliceConfig = BASE_CONFIG; // identical field values to Kotlin's defaultSliceConfig
const dualConfig = () => ({ ...defaultSliceConfig, extruderCount: 2, extruderTemps: [220, 220], wipeTowerEnabled: true });

let lib;
async function setup() {
  lib ??= await NativeLib.create();
  lib.clearModel();
  return lib;
}

function fullPipeline(name) {
  const input = asset(name);
  const info = parse(input, { name });
  const stage1 = info.isBambu ? processAuto(input, name) : input;
  const embedded = embedder.embed(stage1, embedder.buildConfig({ info }), info);
  assert.ok(embedded.length > 0, 'Embedded file should be non-empty');
  return embedded;
}

const headerValue = (gcode, key) => {
  const line = gcode.split('\n').find((l) => l.startsWith(`; ${key} =`));
  return line == null ? null : line.slice(line.indexOf('=') + 1).trim();
};

test('fanCover_fullPipeline_slicesSuccessfully', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(fullPipeline('u1-auxiliary-fan-cover-hex_mw.3mf')));
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result.success, `Fan cover slice should succeed: ${result.errorMessage}`);
  assert.ok(result.totalLayers > 0, 'Layer count > 0');
  assert.ok(result.estimatedFilamentMm > 0, 'Filament estimate > 0');
  lib.clearModel();
});

test('fanCover_fullPipeline_gcodeHasNonZeroTemps', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(fullPipeline('u1-auxiliary-fan-cover-hex_mw.3mf')));
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result.success);
  assert.ok(V.hasNonZeroNozzleTemps(result.gcode), 'G-code must have non-zero nozzle temps');
  const b = V.checkBedBounds(result.gcode);
  assert.ok(b.withinBounds, `Fan cover G-code out of bed bounds: X=[${b.minX}, ${b.maxX}] Y=[${b.minY}, ${b.maxY}]`);
  lib.clearModel();
});

test('calibCube_fullPipeline_slicesSuccessfully', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(fullPipeline('calib-cube-10-dual-colour-merged.3mf')));
  const result = lib.slice(dualConfig());
  assert.ok(result.success, `Calib cube dual-colour slice should succeed: ${result.errorMessage}`);
  assert.ok(result.totalLayers > 0, 'Layer count > 0');
  lib.clearModel();
});

test('buttonTrousers_fullPipeline_slicesSuccessfully', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(fullPipeline('Button-for-S-trousers.3mf')));
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result.success, `Button-for-S-trousers should slice: ${result.errorMessage}`);
  lib.clearModel();
});

test('shashibo_detectsLayerToolColors', () => {
  const info = parse(asset('Shashibo-h2s-textured.3mf'), { name: 'Shashibo-h2s-textured.3mf' });
  assert.ok(info.isBambu, 'Shashibo should be recognized as Bambu');
  assert.ok(info.hasLayerToolChanges, 'layer tool changes should be detected');
  assert.ok(info.detectedColors.length > 1, 'layer tool colors should produce a multi-colour preview');
  assert.ok(info.detectedExtruderCount > 1, 'layer tool colors should produce a multi-extruder preview state');
});

test('coloredBenchy_detectsMultiColourMetadata', () => {
  const info = parse(asset('colored_3DBenchy (1).3mf'), { name: 'colored_3DBenchy (1).3mf' });
  assert.ok(info.isBambu, 'colored benchy should be recognized as Bambu');
  assert.ok(info.detectedColors.length > 1, 'project settings should produce a multi-colour preview');
  assert.ok(info.detectedExtruderCount > 1, 'project settings should produce a multi-extruder preview state');
});

test('flippyFlappyMini_detectsLayerChangeColours', () => {
  const info = parse(asset('flippy+flappy+mini.3mf'), { name: 'flippy+flappy+mini.3mf' });
  assert.ok(info.isBambu, 'flippy+flappy+mini should be recognized as Bambu');
  assert.ok(info.hasLayerToolChanges, 'layer-change tool changes should be detected');
  assert.ok(info.detectedColors.length > 1, 'layer-change colors should produce a multi-colour preview');
  assert.ok(info.detectedExtruderCount > 1, 'layer-change colors should produce a multi-extruder preview state');
});

test('flippyFlappyMini_fullPipeline_emitsLayerChangePauseGcode', { skip }, async () => {
  await setup();
  const sourceAsset = asset('flippy+flappy+mini.3mf');
  assert.ok(lib.loadModel(fullPipeline('flippy+flappy+mini.3mf')), 'embedded sample should load');
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result, 'slice should return a result');
  assert.ok(result.success, `layer-change sample should slice successfully: ${result.errorMessage}`);
  const injected = injectFrom3mf(result.gcode, sourceAsset, 0, (i) => lib.e.plateDataJson(i) || null,
    { modelName: 'flippy+flappy+mini.3mf' });
  assert.ok(injected != null, 'pause injector should run using source asset metadata');
  assert.ok(injected.includes('M400 U1') || injected.includes('; PAUSE_PRINT'), 'layer-change sample should emit pause/color-swap G-code');
  assert.ok(injected.includes('; layer_tool extruder 2'),
    'Bambu extruder 2 in custom_gcode_per_layer must emit T1 (or remapped after GcodeToolRemapper)');
  assert.ok(injected.includes('; single_extruder_multi_material = 0'), 'layer-change sample should stay in single-extruder pause mode');
  lib.clearModel();
});

test('flippyFlappyMini_plateSelectionDetectsOnlySelectedColours', () => {
  const input = asset('flippy+flappy+mini.3mf');
  const origInfo = parse(input, { name: 'flippy+flappy+mini.3mf' });
  const sanitized = processAuto(input, 'flippy+flappy+mini.3mf', true);
  const targetPlateId = 4;
  const ids = origInfo.plates.find((p) => p.plateId === targetPlateId)?.objectIds ?? null;
  assert.ok(ids != null, `sample should expose plate ${targetPlateId}`);
  const rawPlateFile = extractPlate(sanitized, targetPlateId, { hasPlateJsons: origInfo.hasPlateJsons, plateObjectIds: new Set(ids) });
  const plateInfo = parseForPlateSelection(restructurePlateFile(rawPlateFile));
  assert.ok(plateInfo.hasLayerToolChanges, 'selected plate should keep layer tool changes');
  assert.equal(plateInfo.detectedColors.length, 1, 'layer metadata hex for this plate extract');
  assert.equal(plateInfo.detectedColors[0], '#F4D976');
  assert.ok(plateInfo.detectedExtruderCount >= 1 && plateInfo.usedExtruderIndices.size > 0,
    'should report at least one extruder from layer metadata');
});

test('layerToolPlateMerge_prefersSelectedPlatePalette', () => {
  const sourceInfo = threeMfInfo({ objects: [], plates: [], isBambu: true, isMultiPlate: true,
    detectedColors: ['#111111', '#222222', '#333333'], detectedExtruderCount: 3, hasLayerToolChanges: true });
  const plateInfo = threeMfInfo({ objects: [], plates: [], isBambu: true, isMultiPlate: false,
    detectedColors: ['#111111', '#333333'], detectedExtruderCount: 2, hasLayerToolChanges: true });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 1);
  assert.deepEqual(merged.detectedColors, plateInfo.detectedColors, 'layer-tool plates should prefer the selected plate palette');
  assert.equal(merged.detectedExtruderCount, 2, 'layer-tool plates should keep the selected plate extruder count');
});

test('calibCube_reEmbedBeforeSlice_doesNotBreakSlicing', { skip }, async () => {
  await setup();
  const name = 'calib-cube-10-dual-colour-merged.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  const sanitized = processAuto(input, name, info.isBambu);
  const embedded1 = embedder.embed(sanitized, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded1), 'First loadModel must succeed');
  lib.clearModel();
  const embedded2 = embedder.embed(sanitized, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded2), 'Second loadModel must succeed');
  const result = lib.slice(dualConfig());
  assert.ok(result.success, `Slice after re-embed must succeed (B24 regression guard): ${result.errorMessage}`);
  assert.ok(result.totalLayers > 0, 'Layer count > 0 after re-embed slice');
  lib.clearModel();
});

test('benchy_stl_slicesAfterClearAndReload', { skip }, async () => {
  await setup();
  const path = lib.write(asset('3DBenchy.stl'), '3DBenchy.stl');
  assert.ok(lib.loadModel(path), 'First loadModel must succeed');
  lib.clearModel();
  assert.ok(lib.loadModel(path), 'Second loadModel must succeed');
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result.success, `STL slice after clear+reload must succeed: ${result.errorMessage}`);
  assert.ok(result.totalLayers > 0, 'Layer count > 0');
  lib.clearModel();
});

test('pressureAdvancePassesThroughFromEmbeddedProfile', { skip }, async () => {
  await setup();
  const embedded = fullPipeline('calib-cube-10-dual-colour-merged.3mf');
  const entries = readZip(embedded).map((e) => {
    if (e.name !== 'Metadata/project_settings.config') return { name: e.name, data: e.data, method: STORED };
    const json = JSON.parse(decodeText(e.data));
    json.enable_pressure_advance = ['1'];
    json.pressure_advance = ['0.04'];
    return { name: e.name, data: encodeText(JSON.stringify(json, null, 2)), method: STORED };
  });
  const modified = writeZip(entries);
  assert.ok(lib.loadModel(modified), 'Modified 3MF should load');
  const result = lib.slice(defaultSliceConfig);
  assert.ok(result, 'Slice must not return null');
  assert.ok(result.success, `Slice must succeed: ${result.errorMessage}`);
  assert.ok(result.gcode.includes('SET_PRESSURE_ADVANCE ADVANCE=0.04'),
    'Expected SET_PRESSURE_ADVANCE ADVANCE=0.04 in G-code.\nThis means enable_pressure_advance/pressure_advance are not in profile_keys[].\n' +
    `First 2000 chars of G-code:\n${result.gcode.slice(0, 2000)}`);
  lib.clearModel();
});

function dieEmbedded(extra) {
  const name = 'die-single-colour.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  const stage1 = info.isBambu ? processAuto(input, name) : input;
  const config = embedder.buildConfig({ info, targetExtruderCount: 1, ...extra });
  return embedder.embed(stage1, config, info);
}

test('f87_processProfileKeys_overrideBundledProcessProfile', { skip }, async () => {
  await setup();
  const embedded = dieEmbedded({ processProfileKeys: {
    layer_height: '0.16', sparse_infill_density: '25%', seam_position: 'back', top_surface_pattern: 'concentric',
    ironing_type: 'topmost', wall_loops: '5',
  } });
  assert.ok(embedded.length > 0);
  assert.ok(lib.loadModel(embedded), 'native load');
  const result = lib.slice({ ...defaultSliceConfig, layerHeight: 0, perimeters: 5 });
  assert.ok(result, 'slice produced a result');
  assert.ok(result.success, `slice succeeded: ${result.errorMessage}`);
  const g = result.gcode;
  assert.equal(headerValue(g, 'layer_height'), '0.16', 'layer_height should pick up process profile value');
  assert.equal(headerValue(g, 'sparse_infill_density'), '25%', 'sparse_infill_density (newly gated) → process profile wins');
  assert.equal(headerValue(g, 'seam_position'), 'back', 'seam_position (newly gated) → process profile wins');
  assert.equal(headerValue(g, 'top_surface_pattern'), 'concentric', 'top_surface_pattern → process profile wins');
  assert.equal(headerValue(g, 'ironing_type'), 'topmost', 'ironing_type → process profile wins');
  assert.equal(headerValue(g, 'wall_loops'), '5');
  lib.clearModel();
});

test('f87_emptyProcessProfileKeys_keepsBundledDefaults', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(dieEmbedded({ processProfileKeys: {} })));
  const result = lib.slice({ ...defaultSliceConfig, layerHeight: 0 });
  assert.ok(result?.success === true, 'slice succeeds with empty processProfileKeys');
  assert.ok(result.gcode.includes('; layer_height = 0.2'), 'bundled layer_height=0.2 survives');
  lib.clearModel();
});

test('f91_filamentSettings_emitInGcodeHeader', { skip }, async () => {
  await setup();
  const embedded = dieEmbedded({ filamentSettings: {
    filament_flow_ratio: ['0.97'], filament_max_volumetric_speed: ['12.5'], filament_cost: ['32.5'],
    fan_min_speed: ['60'], fan_max_speed: ['85'], overhang_fan_speed: ['75'], slow_down_layer_time: ['6'],
    slow_down_min_speed: ['18'], pressure_advance: ['0.055'], enable_pressure_advance: ['1'],
    filament_minimal_purge_on_wipe_tower: ['18'],
  } });
  assert.ok(lib.loadModel(embedded));
  const result = lib.slice({ ...defaultSliceConfig, layerHeight: 0 });
  assert.ok(result?.success === true, `slice succeeded: ${result?.errorMessage}`);
  const contains = (key, expected) => {
    const v = headerValue(result.gcode, key);
    assert.ok(v != null, `${key} header missing`);
    assert.ok(v.includes(expected), `${key} expected to contain ${expected}, got: ${v}`);
  };
  contains('filament_flow_ratio', '0.97');
  contains('filament_max_volumetric_speed', '12.5');
  contains('filament_cost', '32.5');
  contains('fan_min_speed', '60');
  contains('fan_max_speed', '85');
  contains('overhang_fan_speed', '75');
  contains('slow_down_layer_time', '6');
  contains('slow_down_min_speed', '18');
  contains('pressure_advance', '0.055');
  contains('filament_minimal_purge_on_wipe_tower', '18');
  lib.clearModel();
});

test('f91_omittedFilamentSettings_keepsBundledDefaults', { skip }, async () => {
  await setup();
  assert.ok(lib.loadModel(dieEmbedded({ filamentSettings: {} })));
  const result = lib.slice({ ...defaultSliceConfig, layerHeight: 0 });
  assert.ok(result?.success === true, 'slice succeeds with empty filamentSettings');
  assert.ok(result.gcode.includes('; filament_flow_ratio = 1'), 'bundled filament_flow_ratio=1 survives');
  assert.ok(result.gcode.includes('; filament_max_volumetric_speed = 21'), 'bundled filament_max_volumetric_speed=21 survives');
  lib.clearModel();
});
