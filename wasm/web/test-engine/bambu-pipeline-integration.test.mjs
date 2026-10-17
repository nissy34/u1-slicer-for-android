// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/BambuPipelineIntegrationTest.kt
// on the wasm engine: ThreeMfParser -> BambuSanitizer.process / extractPlate /
// restructurePlateFile -> ProfileEmbedder -> engine loadModel -> slice -> G-code,
// through the ported pipeline modules exactly as the Kotlin test drives them.
// One JS test per Kotlin @Test, same names and assertions. Where several Kotlin
// tests slice the identical embedded file with the identical config, the slice is
// done once and shared (the assertions only read the output).
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlate, restructurePlateFile } from '../pipeline/bambu-sanitizer.mjs';
import { resolvePerFilamentTypeAndTemp } from '../pipeline/canonical-filament-list.mjs';
import { canonicalListAtLoad } from '../pipeline/canonical-list-at-load.mjs';
import { defaultExtruderPresets } from '../pipeline/extruder-preset.mjs';
import { mergeThreeMfInfo, mergeThreeMfInfoForPlate } from '../pipeline/merge-three-mf-info.mjs';
import { ensureMultiSlotMapping, findClosestExtruder } from '../pipeline/multi-color-mapping.mjs';
import { buildProfileOverridesImpl } from '../pipeline/profile-overrides.mjs';
import { sliceConfig } from '../pipeline/slice-config.mjs';
import { OverrideMode, overrideValue, slicingOverrides } from '../pipeline/slicing-overrides.mjs';
import { parse, parseForPlateSelection } from '../pipeline/three-mf-parser.mjs';
import { createRequire } from 'node:module';
import { between, computePlateFileIndices, fileText, newEmbedder, once, processAuto, zipEntryText } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import * as V from './gcode-validator.mjs';
import { BASE_CONFIG, NativeLib } from './native-lib.mjs';

const { remapGcode } = createRequire(import.meta.url)('../gcode-tool-remap.js');
const skip = engineAvailable ? false : 'wasm engine not built';
const dualConfig = () => ({ ...BASE_CONFIG, extruderCount: 2, extruderTemps: [220, 220], wipeTowerEnabled: true,
  wipeTowerX: 170, wipeTowerY: 140, wipeTowerWidth: 60 });
const compactFourColourConfig = dualConfig;

let lib;
async function setup() {
  lib ??= await NativeLib.create();
  lib.clearModel();
  return lib;
}
const parseA = (name) => parse(asset(name), { name });
const embedder = newEmbedder();

function assertGcodeWithinBedBounds(gcode, label = '') {
  const b = V.checkBedBounds(gcode);
  assert.ok(b.withinBounds, `${label}: G-code out of bed bounds — X=[${b.minX}, ${b.maxX}] Y=[${b.minY}, ${b.maxY}] ` +
    `violations=${b.violatingLines.slice(0, 3)}`);
}

function assertSliced(result, msg) {
  assert.ok(result, 'slice() returned null');
  assert.ok(result.success, `${msg}: ${result.errorMessage}`);
  return result.gcode;
}

/** extractPlateAndLoad (multi-plate: extractPlate + embed with the file's info). */
function extractPlateAndLoad(name, plateId = 1) {
  const input = asset(name);
  const info = parse(input, { name });
  const plateFile = extractPlate(input, plateId);
  assert.ok(plateFile.length > 0, 'extractPlate file should exist');
  const embedded = embedder.embed(plateFile, embedder.buildConfig({ info }), info);
  assert.ok(embedded.length > 0, 'Embedded file should exist');
  assert.ok(lib.loadModel(embedded), `loadModel should succeed for plate ${plateId} of ${name}`);
  return embedded;
}

function sanitizeAndSlice(name, config = BASE_CONFIG) {
  const sanitized = processAuto(asset(name), name);
  assert.ok(sanitized.length > 0, 'Sanitized file should be non-empty');
  assert.ok(lib.loadModel(sanitized), `loadModel should succeed for ${name}`);
  return assertSliced(lib.slice(config), `Slice should succeed for ${name}`);
}

const SUPPORT_OVERRIDES = (types, temps) => ({
  enable_support: '1', support_type: 'normal(auto)', support_threshold_angle: '45',
  support_interface_top_layers: '3', support_interface_bottom_layers: '0',
  support_filament: '3', support_interface_filament: '4',
  filament_type: types, nozzle_temperature: temps, nozzle_temperature_initial_layer: [...temps],
});

test('leoSupport_plate1_supportPetgE3_interfacePetgE4_slicesSuccessfully', { skip }, async () => {
  await setup();
  const input = asset('Leo_test_Supports.3mf');
  const info = parse(input, { name: 'Leo_test_Supports.3mf' });
  assert.ok(info.isBambu, 'Leo support fixture must be detected as Bambu');
  assert.ok(info.plates.length >= 2, 'Leo support fixture must expose multiple plates');
  assert.equal(info.plates.find((p) => p.plateId === 1).name, 'Print ME');

  const sourceConfig = embedder.parseSourceConfig(input);
  const embedConfig = embedder.buildConfig({
    info, sourceConfig,
    overrides: SUPPORT_OVERRIDES(['PLA', 'PLA', 'PETG', 'PETG'], ['220', '220', '235', '235']),
    targetExtruderCount: Math.max(info.detectedExtruderCount, 4),
  });
  const embedded = embedder.embed(input, embedConfig, info, null, 1);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed for Leo plate 1');

  const result = lib.slice({
    ...BASE_CONFIG, firstLayerHeight: 0.3, printSpeed: 60, travelSpeed: 150, firstLayerSpeed: 20, nozzleTemp: 220,
    bedTemp: 60, supportEnabled: true, supportType: 'normal(auto)', supportAngle: 45, extruderCount: 4,
    extruderTemps: [220, 220, 235, 235], supportFilament: 3, supportInterfaceFilament: 4, wipeTowerEnabled: true,
    wipeTowerX: 200, wipeTowerY: 10, wipeTowerWidth: 60,
  });
  const gcode = assertSliced(result, 'Leo plate 1 with PETG support E3/interface E4 must slice');
  assert.ok(gcode.includes('support_filament = 3'), 'G-code must preserve support_filament = 3');
  assert.ok(gcode.includes('support_interface_filament = 4'), 'G-code must preserve support_interface_filament = 4');
  assert.ok(V.hasExactGcodeLine(gcode, '; nozzle_temperature = 220,220,235,235'), 'G-code must preserve PETG temps for E3/E4');
  const used = V.filamentUsedMm(gcode);
  assert.ok((used[2] ?? 0) > 0, `Support slot E3 must have extrusion, filament used = ${used}`);
  lib.clearModel();
});

// ─── Multi-plate detection ────────────────────────────────────────────────

test('dragonScale_detectedAsMultiPlate', () => {
  const info = parseA('Dragon Scale infinity.3mf');
  assert.ok(info.isBambu, 'Dragon Scale should be Bambu');
  assert.ok(info.isMultiPlate, 'Dragon Scale should be multi-plate');
  assert.ok(info.plates.length > 0, 'Dragon Scale should have plates');
});

test('dragonScale2Colour_hasColorInfo', () => {
  const info = parseA('Dragon Scale infinity-1-plate-2-colours.3mf');
  assert.ok(info.isBambu);
  assert.ok(info.detectedColors.length >= 2, `Detected colors should be >= 2, was ${info.detectedColors.length}`);
});

test('dragonScaleNewPlate_isBambuFile', () => {
  const info = parseA('Dragon Scale infinity-1-plate-2-colours-new-plate.3mf');
  assert.ok(info.isBambu, 'Dragon Scale new-plate should be Bambu');
  assert.ok(info.plates.length > 0, 'Dragon Scale new-plate should have at least 1 plate');
});

// ─── Colour detection ────────────────────────────────────────────────────

test('calibCube_detectedAsDualColour', () => {
  assert.ok(parseA('calib-cube-10-dual-colour-merged.3mf').detectedColors.length >= 2, 'Calib cube should have >= 2 detected colors');
});

test('korokMask_detectedAsFourColour', () => {
  const info = parseA('PrusaSlicer-printables-Korok_mask_4colour.3mf');
  assert.ok(info.detectedColors.length >= 4, `Korok mask should have >= 4 detected colors, was ${info.detectedColors.length}`);
});

function origProcessed(name) {
  const input = asset(name);
  const origInfo = parse(input, { name });
  const processed = processAuto(input, name);
  return { input, origInfo, processed, processedInfo: parse(processed, { name }) };
}

test('process_stripsColorMetadata_origInfoPreservesColors_calibCube', () => {
  const { origInfo, processedInfo } = origProcessed('calib-cube-10-dual-colour-merged.3mf');
  assert.ok(origInfo.detectedColors.length >= 2, 'Original calib-cube should detect >= 2 colors');
  assert.ok(processedInfo.detectedColors.length >= 2, 'processedInfo should detect >= 2 extruder colors');
});

test('process_preservesPaintColors_coloredBenchy', () => {
  const { origInfo, processedInfo } = origProcessed('colored_3DBenchy (1).3mf');
  assert.ok(origInfo.detectedColors.length >= 2, 'colored_3DBenchy original should detect >= 2 colors');
  assert.ok(processedInfo.detectedColors.length >= 2, 'processedInfo should preserve paint-derived colors');
});

test('viewModelMergeThreeMfInfo_preservesOrigInfoColors_calibCube', () => {
  const { origInfo, processedInfo } = origProcessed('calib-cube-10-dual-colour-merged.3mf');
  assert.ok(processedInfo.detectedColors.length >= 2, 'processedInfo should detect >= 2 extruder colors');
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(merged.detectedColors.length >= 2, 'mergeThreeMfInfo should have >= 2 colors');
  assert.ok(merged.detectedExtruderCount >= 2, 'mergeThreeMfInfo extruderCount should be >= 2');
});

test('viewModelMergeThreeMfInfo_preservesOrigInfoColors_coloredBenchy', () => {
  const { origInfo, processedInfo } = origProcessed('colored_3DBenchy (1).3mf');
  assert.ok(processedInfo.detectedColors.length >= 2, 'processedInfo should preserve paint-derived colors');
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(merged.detectedColors.length >= 2, 'mergeThreeMfInfo should have >= 2 colors');
  assert.ok(merged.detectedExtruderCount >= 2, 'mergeThreeMfInfo extruderCount should be >= 2');
});

test('selectPlate_extractedPlateFromProcessedFile_hasColors_dragonScale', () => {
  const { origInfo, processed, processedInfo } = origProcessed('Dragon Scale infinity.3mf');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const plateFile = extractPlate(processed, 1, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const plateInfo = parse(plateFile, { name: 'plate1.3mf' });
  assert.ok(plateInfo.detectedColors.length > 0, 'plateInfo should have colors (model_settings.config preserved)');
});

test('selectPlateMerge_mergeThreeMfInfoForPlate_restoresColors_dragonScale', () => {
  const { origInfo, processed, processedInfo } = origProcessed('Dragon Scale infinity.3mf');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(origInfo.detectedColors.length >= 2, 'Dragon Scale should have >= 2 colors in origInfo');
  const plateFile = extractPlate(processed, 1, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const result = mergeThreeMfInfoForPlate(parse(plateFile, { name: 'plate1.3mf' }), mergedInfo);
  assert.ok(result.detectedColors.length >= 2, `After mergeThreeMfInfoForPlate, detectedColors must be >= 2 (was ${result.detectedColors.length})`);
  assert.ok(result.detectedExtruderCount >= 2, `After mergeThreeMfInfoForPlate, detectedExtruderCount must be >= 2 (was ${result.detectedExtruderCount})`);
});

test('selectPlateMerge_mergeThreeMfInfoForPlate_restoresColors_shashiboPlate5', () => {
  const { origInfo, processed, processedInfo } = origProcessed('Shashibo-h2s-textured.3mf');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(origInfo.detectedColors.length >= 2, 'Shashibo should have >= 2 colors in origInfo');
  const plateFile = extractPlate(processed, 5, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const result = mergeThreeMfInfoForPlate(parse(plateFile, { name: 'plate5.3mf' }), mergedInfo, 5);
  assert.ok(result.detectedColors.length >= 2, `After mergeThreeMfInfoForPlate, detectedColors must be >= 2 (was ${result.detectedColors.length})`);
  assert.ok(result.detectedExtruderCount >= 2, `After mergeThreeMfInfoForPlate, detectedExtruderCount must be >= 2 (was ${result.detectedExtruderCount})`);
  assert.ok(result.hasMultiExtruderAssignments, 'Shashibo plate 5 must have hasMultiExtruderAssignments=true (per-object extruder diversity)');
});

/** extractPlate with the plate's object ids + extruder map, restructure, parseForPlateSelection, merge. */
function plateSelectionMerge(processed, preSelectInfo, plateId, withSelectedPlateId) {
  const plateObjectIds = preSelectInfo.plates.find((p) => p.plateId === plateId)?.objectIds ?? null;
  const ids = plateObjectIds ? new Set(plateObjectIds) : null;
  const plateExtruderMap = new Map([...preSelectInfo.objectExtruderMap].filter(([k]) => ids?.has(k) === true));
  const rawPlateFile = extractPlate(processed, plateId, {
    hasPlateJsons: preSelectInfo.hasPlateJsons, plateObjectIds: ids, objectExtruderMap: plateExtruderMap,
  });
  const plateFile = restructurePlateFile(rawPlateFile);
  const plateInfo = parseForPlateSelection(plateFile);
  const merged = mergeThreeMfInfoForPlate(plateInfo, preSelectInfo, withSelectedPlateId ? plateId : null);
  return { plateInfo, merged };
}

test('selectPlateMerge_mergeThreeMfInfoForPlate_preservesThreeVisibleColours_dragonPlate3', () => {
  const { origInfo, processed, processedInfo } = origProcessed('Dragon Scale infinity.3mf');
  const preSelectInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const { plateInfo, merged } = plateSelectionMerge(processed, preSelectInfo, 3, false);
  assert.ok(plateInfo.usedExtruderIndices.size >= 3,
    `Dragon plate 3 should expose at least 3 used extruders after extraction, got ${[...plateInfo.usedExtruderIndices]}`);
  assert.ok(merged.detectedColors.length >= 3,
    `Dragon plate 3 should preserve at least 3 detected colors after merge, got ${merged.detectedColors}`);
  const presets = defaultExtruderPresets();
  const rawMapping = merged.detectedColors.map((c) => findClosestExtruder(c, presets)?.index ?? 0);
  const initialMapping = ensureMultiSlotMapping(rawMapping, merged.detectedColors.length);
  assert.ok(new Set(initialMapping).size >= 3,
    `Dragon plate 3 should auto-map to at least 3 visible slots, raw=${rawMapping} mapped=${initialMapping} colors=${merged.detectedColors}`);
});

test('shashibo_loadsAfterExtractAndEmbed', { skip }, async () => {
  await setup();
  extractPlateAndLoad('Shashibo-h2s-textured.3mf', 1);
  lib.clearModel();
});

// ─── selectPlate G-code multi-extruder regression ─────────────────────────

function assertShashiboPlate5Gcode(gcode, label, checkBounds) {
  assert.ok(gcode.split('\n').some((l) => l.trimStart().startsWith('T1')), `${label}: G-code should contain T1 — multi-extruder plate must have tool changes`);
  const cp = V.countLinesContaining(gcode, '; CP TOOLCHANGE');
  assert.ok(cp > 400, `${label}: Shashibo plate 5 should have CP TOOLCHANGE > 400 (was ${cp})`);
  const pauses = V.countLinesContaining(gcode, 'PAUSE_PRINT');
  assert.equal(pauses, 0, `${label}: Shashibo plate 5 must have PAUSE_PRINT=0 (was ${pauses})`);
  if (checkBounds) assertGcodeWithinBedBounds(gcode, label);
}

test('shashiboPlate5_selectPlateIdentityPath_gcodeHasToolChanges', { skip }, async () => {
  await setup();
  const { origInfo, processed, processedInfo } = origProcessed('Shashibo-h2s-textured.3mf');
  assert.ok(origInfo.detectedColors.length >= 2, 'Shashibo should have >= 2 colors');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const sanitized = embedder.embed(processed, embedder.buildConfig({ info: processedInfo }), processedInfo);
  const rawPlateFile = extractPlate(sanitized, 5, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const plateFile = restructurePlateFile(rawPlateFile);
  assert.ok(lib.loadModel(plateFile), 'loadModel should succeed');
  const gcode = assertSliced(lib.slice(dualConfig()), 'Shashibo plate 5 slice should succeed');
  assertShashiboPlate5Gcode(gcode, 'Shashibo plate 5 identity path', true);
  lib.clearModel();
});

test('shashiboPlate5_selectPlateReembedWithPlateInfo_gcodeHasToolChanges', { skip }, async () => {
  await setup();
  const { origInfo, processed, processedInfo } = origProcessed('Shashibo-h2s-textured.3mf');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const sanitized = embedder.embed(processed, embedder.buildConfig({ info: processedInfo }), processedInfo);
  const rawPlateFile = extractPlate(sanitized, 5, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const plateFile = restructurePlateFile(rawPlateFile);
  const plateInfo = parse(plateFile, { name: 'plate5.3mf' });
  const reembedded = embedder.embed(plateFile, embedder.buildConfig({ info: plateInfo, targetExtruderCount: 2 }), plateInfo);
  assert.ok(lib.loadModel(reembedded), 'loadModel should succeed');
  const gcode = assertSliced(lib.slice(dualConfig()), 'Re-embedded Shashibo plate 5 should slice');
  // Kotlin skips the bounds check on this non-canonical path (known garbage X coordinates).
  assertShashiboPlate5Gcode(gcode, 'Re-embedded', false);
  lib.clearModel();
});

test('shashiboPlate5_correctPipeline_gcodeHasToolChanges', { skip }, async () => {
  await setup();
  const { origInfo, processed, processedInfo } = origProcessed('Shashibo-h2s-textured.3mf');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const rawPlateFile = extractPlate(processed, 5, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const plateFile = restructurePlateFile(rawPlateFile);
  const plateMergedInfo = mergeThreeMfInfoForPlate(parse(plateFile, { name: 'plate5.3mf' }), mergedInfo);
  const embedded = embedder.embed(plateFile, embedder.buildConfig({ info: plateMergedInfo, targetExtruderCount: 2 }), plateMergedInfo);
  assert.ok(lib.loadModel(embedded), 'loadModel should succeed');
  const gcode = assertSliced(lib.slice(dualConfig()), 'Correct-pipeline Shashibo plate 5 should slice');
  assertShashiboPlate5Gcode(gcode, 'Shashibo plate 5 correct pipeline', true);
  lib.clearModel();
});

// ─── restructurePlateFile regression guard ─────────────────────────────────

test('restructurePlateFile_producesMultiExtruderConfig', () => {
  const { origInfo, processed, processedInfo } = origProcessed('Shashibo-h2s-textured.3mf');
  assert.ok(origInfo.detectedColors.length >= 2, 'Shashibo should have >= 2 colors');
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const rawPlateFile = extractPlate(processed, 5, { hasPlateJsons: mergedInfo.hasPlateJsons });
  const restructured = restructurePlateFile(rawPlateFile);
  assert.notEqual(restructured, rawPlateFile, 'restructurePlateFile should produce a new file');
  const configText = zipEntryText(restructured, 'Metadata/model_settings.config');
  assert.ok(configText != null, 'Restructured ZIP should have model_settings.config');
  const extruderValues = new Set([...configText.matchAll(/key="extruder"\s+value="(\d+)"/g)].map((m) => Number(m[1])));
  assert.ok(extruderValues.size >= 2, `Restructured config should have >= 2 different extruder values, got: ${[...extruderValues]}`);
});

// ─── 4-colour slicing ─────────────────────────────────────────────────────

test('korokMask_fourColour_slicesWithoutFlowError', { skip }, async () => {
  await setup();
  const name = 'PrusaSlicer-printables-Korok_mask_4colour.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  const sanitized = processAuto(input, name);
  const embedded = embedder.embed(sanitized, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded), 'loadModel should succeed');
  const gcode = assertSliced(lib.slice(compactFourColourConfig()), 'Korok mask 4-colour slice should succeed (was)');
  assert.ok(gcode.length > 0, 'G-code should be non-empty');
  assertGcodeWithinBedBounds(gcode, 'Korok mask 4-colour');
  lib.clearModel();
});

// ─── Multi-plate loading ──────────────────────────────────────────────────

test('dragonScale2Colour_plate1_loadsSuccessfully', { skip }, async () => {
  await setup();
  extractPlateAndLoad('Dragon Scale infinity-1-plate-2-colours.3mf', 1);
  assert.ok(lib.getModelInfo() != null, 'getModelInfo must return non-null for Dragon Scale 2-colour');
  lib.clearModel();
});

// ─── Paint data detection regression ──────────────────────────────────────

test('coloredBenchy_hasPaintData_detectedFromComponentModelFiles', () => {
  assert.ok(parseA('colored_3DBenchy (1).3mf').hasPaintData,
    'colored_3DBenchy paint_color is in component .model files — hasPaintData must be true');
});

test('coloredBenchy_detectedColors_exactlyFour', () => {
  const info = parseA('colored_3DBenchy (1).3mf');
  assert.equal(info.detectedColors.length, 4, 'colored_3DBenchy must detect exactly 4 colors (has 4 filament_colour + 4 paint states)');
  assert.ok(info.detectedExtruderCount >= 4, `detectedExtruderCount must be >= 4 (got ${info.detectedExtruderCount})`);
});

// ─── Toolchange retraction regression ─────────────────────────────────────

test('calibCube_dualColour_toolchangeRetraction_notBowdenDefault', { skip }, async () => {
  await setup();
  const gcode = sanitizeAndSlice('calib-cube-10-dual-colour-merged.3mf', dualConfig());
  const vals = V.extractToolchangeRetractLength(gcode);
  assert.ok(vals != null, 'retract_length_toolchange must be in G-code config');
  for (const v of vals) assert.ok(v <= 2.0, `retract_length_toolchange=${v} must be ≤ 2mm (direct drive), not bowden 10mm`);
  const maxRetract = V.maxRetractionMm(gcode);
  assert.ok(maxRetract <= 5.0, `Max retraction ${maxRetract}mm must be ≤ 5mm for direct drive`);
  lib.clearModel();
});

/** The three calib-cube tests below slice the identical embedded file with dualConfig(). */
const calibCubeEmbeddedSlice = once(async () => {
  await setup();
  const name = 'calib-cube-10-dual-colour-merged.3mf';
  const input = asset(name);
  const sanitized = processAuto(input, name);
  const info = parse(input, { name });
  const embedded = embedder.embed(sanitized, embedder.buildConfig({ info, targetExtruderCount: 2 }), info);
  assert.ok(embedded.length > 0, 'Embedded 3MF must exist');
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  const result = lib.slice(dualConfig());
  lib.clearModel();
  return result;
});

test('calibCube_dualColour_noBowdenUnloadSequence', { skip }, async () => {
  const gcode = assertSliced(await calibCubeEmbeddedSlice(), 'Slice must succeed');
  assert.ok(V.hasToolChanges(gcode, 'T0', 'T1'), 'Must have T0/T1 tool changes for this test to be meaningful');
  assert.ok(!V.hasBowdenUnloadSequence(gcode),
    "G-code must NOT contain bowden-style '; Retract(unload)' sequence — Snapmaker U1 has independent extruders, not SEMM bowden. " +
    'If this fails, single_extruder_multi_material is defaulting to true.');
  const maxRetract = V.maxRetractionMm(gcode);
  assert.ok(maxRetract <= 5.0, `Max retraction ${maxRetract}mm must be ≤ 5mm for direct drive`);
  assertGcodeWithinBedBounds(gcode, 'CalibCube dual-colour bowden check');
});

test('calibCube_dualColour_withExtruderRemap_usesT2andT3', { skip }, async () => {
  const rawGcode = assertSliced(await calibCubeEmbeddedSlice(), 'Slice must succeed');
  assert.ok(V.hasToolChanges(rawGcode, 'T0', 'T1'), 'Compact G-code must have T0/T1');
  assert.ok(V.hasNonZeroNozzleTemps(rawGcode), 'Active extruder slots must have non-zero temperatures');
  const remapped = remapGcode(rawGcode, [2, 3]);
  assert.ok(V.hasToolChanges(remapped, 'T2', 'T3'), 'Remapped G-code must contain T2/T3');
  assert.ok(V.lacksToolChanges(remapped, 'T0', 'T1'), 'Remapped G-code must not contain T0/T1');
  const execBlock = remapped.split('\n').filter((l) => !l.trimStart().startsWith(';')).join('\n');
  assert.ok(/SM_PRINT_AUTO_FEED\s+EXTRUDER=2/.test(execBlock), 'SM_PRINT_AUTO_FEED must use EXTRUDER=2');
  assert.ok(/SM_PRINT_AUTO_FEED\s+EXTRUDER=3/.test(execBlock), 'SM_PRINT_AUTO_FEED must use EXTRUDER=3');
  assert.ok(!/SM_PRINT_AUTO_FEED\s+EXTRUDER=0/.test(execBlock), 'SM_PRINT_AUTO_FEED must not use EXTRUDER=0');
  assert.ok(!/SM_PRINT_AUTO_FEED\s+EXTRUDER=1/.test(execBlock), 'SM_PRINT_AUTO_FEED must not use EXTRUDER=1');
  assertGcodeWithinBedBounds(remapped, 'CalibCube dual-colour extruder remap');
});

test('calibCube_dualColour_estimatedTimeComment_noBufferOverflow', { skip }, async () => {
  const gcode = assertSliced(await calibCubeEmbeddedSlice(), 'Slice must succeed');
  assert.ok(V.extractEstimatedTime(gcode) != null, 'G-code must contain estimated printing time comment (run_post_process survived)');
});

// ── Bug-fix regression: printable="0" + isMultiPlate detection ──────────────

test('coloredBenchy_printableZeroStripped_loadsSuccessfully', { skip }, async () => {
  await setup();
  const name = 'colored_3DBenchy (1).3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(!info.isMultiPlate, 'Colored Benchy should NOT be multi-plate');
  const sanitized = processAuto(input, name);
  const buildXml = between(fileText(sanitized), '<build', '</build>');
  assert.ok(!buildXml.includes('printable="0"'), 'printable=0 item must be stripped');
  assert.ok(buildXml.includes('printable="1"'), 'printable=1 item must be kept');
  const embedded = embedder.embed(sanitized, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed for stripped Benchy');
  const mi = lib.getModelInfo();
  assert.ok(mi != null, 'getModelInfo must return non-null');
  assert.ok(mi.sizeX > 0, 'Model must have positive sizeX after stripping');
  assert.ok(mi.sizeY > 0, 'Model must have positive sizeY after stripping');
  lib.clearModel();
});

test('fidgetCoaster_multiPlateWithoutPlateIds_extractsOneItemAtBedCentre', { skip }, async () => {
  await setup();
  const name = 'foldy+coaster (1).3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(info.isMultiPlate, 'Coaster should be multi-plate');
  assert.ok(info.plates.length > 1, 'Coaster should have multiple plates');
  const plateFile = extractPlate(input, 2);
  assert.ok(plateFile.length > 0, 'Plate file must exist');
  const buildSection = between(fileText(plateFile), '<build', '</build>');
  assert.equal([...buildSection.matchAll(/<item /g)].length, 1, 'Extracted plate must have exactly 1 build item');
  assert.ok(/transform="[^"]*135\s+135\s+\S+"/.test(buildSection), 'Item must be at bed-centre XY (135 135)');
  const sanitized = processAuto(input, name);
  const rawSanitizedPlate = extractPlate(sanitized, 2, { hasPlateJsons: info.hasPlateJsons });
  const sanitizedPlate = restructurePlateFile(rawSanitizedPlate);
  const embedded = embedder.embed(sanitizedPlate, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  assert.ok(lib.getModelInfo() != null, 'getModelInfo must return non-null for coaster plate 2');
  lib.clearModel();
});

test('dragonScale_fullViewModelPipeline_loadsSuccessfully', { skip }, async () => {
  await setup();
  const name = 'Dragon Scale infinity.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(info.isMultiPlate, 'Dragon Scale should be multi-plate');
  assert.ok(!info.hasPlateJsons, 'Dragon Scale should NOT have plate JSONs');
  const sanitized = processAuto(input, name);
  const rawPlateFile = extractPlate(sanitized, 1, { hasPlateJsons: info.hasPlateJsons });
  const plateFile = restructurePlateFile(rawPlateFile);
  const plateInfo = parse(plateFile, { name: 'plate1.3mf' });
  assert.ok(!plateInfo.isMultiPlate, 'Plate 1 should be single-plate after extraction');
  const embedded = embedder.embed(plateFile, embedder.buildConfig({ info: plateInfo }), plateInfo);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed for Dragon Scale plate 1');
  assert.ok(lib.getModelInfo() != null, 'getModelInfo must return non-null');
  lib.clearModel();
});

// ── B23: Per-object extruder indices survive restructure pipeline ──

function dragonPlate1Restructured() {
  const name = 'Dragon Scale infinity.3mf';
  const file = asset(name);
  const origInfo = parse(file, { name });
  const processed = processAuto(file, name, origInfo.isBambu);
  const rawPlateFile = extractPlate(processed, 1, { hasPlateJsons: origInfo.hasPlateJsons });
  return { origInfo, restructured: restructurePlateFile(rawPlateFile) };
}

test('dragonScale_multiPlate_restructuredPlate_parseForPlateSelectionReturnsExtruderMap', () => {
  const { origInfo, restructured } = dragonPlate1Restructured();
  assert.ok(origInfo.isMultiPlate, 'Dragon Scale should be multi-plate');
  const plateInfo = parseForPlateSelection(restructured);
  assert.ok(plateInfo.objectExtruderMap.size > 0, 'parseForPlateSelection should include objectExtruderMap from restructured file');
  const merged = mergeThreeMfInfoForPlate(plateInfo, origInfo);
  if (plateInfo.objectExtruderMap.size > 0) {
    assert.deepEqual(merged.objectExtruderMap, plateInfo.objectExtruderMap, "Merged objectExtruderMap should use plate's new IDs");
  }
});

test('parseForPlateSelection_includesObjectExtruderMap', () => {
  const { restructured } = dragonPlate1Restructured();
  const plateInfo = parseForPlateSelection(restructured);
  assert.ok(plateInfo.objectExtruderMap.size > 0, 'parseForPlateSelection should return non-empty objectExtruderMap from restructured file');
});

test('auxFan_modifierVolume_preservedAsModifierPart', { skip }, async () => {
  await setup();
  const name = 'u1-auxiliary-fan-cover-hex_mw.3mf';
  const file = asset(name);
  const origInfo = parse(file, { name });
  const processed = processAuto(file, name, origInfo.isBambu);
  const orcaConfig = zipEntryText(processed, 'Metadata/model_settings.config');
  const slic3rConfig = zipEntryText(processed, 'Metadata/Slic3r_PE_model.config');
  assert.ok(orcaConfig != null || slic3rConfig != null, 'Processed 3MF must contain model config (modifier volumes need subtype)');
  if (orcaConfig != null) {
    assert.ok(orcaConfig.includes('modifier_part'), `model_settings.config must preserve modifier_part subtype, got:\n${orcaConfig}`);
    assert.ok(orcaConfig.includes('normal_part'), 'model_settings.config must have normal_part for the model volume');
  }
  const info = parse(processed, { name });
  const embedded = embedder.embed(processed, embedder.buildConfig({ info }), info);
  assert.ok(lib.loadModel(embedded), 'embed() should succeed');
  const preview = lib.getPreparePreviewMesh(500_000);
  assert.ok(preview != null, 'Preview mesh should not be null');
  const triCount = preview.extruders.length;
  assert.ok(triCount <= 15650, `Preview should have ~15642 tris (model only), not ~15654 (model+modifier). Got ${triCount}`);
  lib.clearModel();
});

test('dragonScale_restructuredPlate_hasPerPartExtruderAssignments', () => {
  const { restructured } = dragonPlate1Restructured();
  const map = parseForPlateSelection(restructured).objectExtruderMap;
  assert.ok(map.size >= 3, 'Should have >=3 entries (per-part + parent)');
  const distinct = new Set(map.values());
  assert.ok(distinct.size >= 2, `Per-part extruders should have >=2 distinct values, got ${[...distinct]}`);
});

// ─── B67: Flarewing Dragon paint detection ──────────────────────────────

const FLAREWING = 'Flarewing-Dragon_100%_4FilamentMulticolor_v1.1.3mf';

test('b67_flarewingDragon_paintDetection', () => {
  const info = parseA(FLAREWING);
  assert.ok(info.isBambu, 'Flarewing Dragon must be detected as Bambu format');
  assert.ok(info.hasPaintData, 'Flarewing Dragon must have hasPaintData=true (295k paint_color attrs)');
  assert.equal(info.detectedColors.length, 4, 'Flarewing Dragon must detect 4 filament colours');
  assert.ok(info.detectedExtruderCount >= 4, 'Flarewing Dragon must have >=4 extruders');
});

// ─── B82: per-plate layer-tool chip count ─────────────────────────────────

function perPlateChips(name, expected) {
  const { origInfo, processed, processedInfo } = origProcessed(name);
  const preSelectInfo = mergeThreeMfInfo(processedInfo, origInfo);
  const results = new Map();
  for (const plateId of [...expected.keys()].sort((a, b) => a - b)) {
    results.set(plateId, plateSelectionMerge(processed, preSelectInfo, plateId, true).merged);
  }
  return results;
}

test('b82_flippyStandard_perPlateChipCount', () => {
  const expected = new Map([[1, 1], [2, 2], [3, 1], [4, 2]]);
  const merged = perPlateChips('flippy+flappy+mini.3mf', expected);
  for (const [plateId, n] of expected) {
    const m = merged.get(plateId);
    assert.equal(m.detectedColors.length, n, `Flippy plate ${plateId}: expected ${n} chip(s), got ${m.detectedColors.length} (${m.detectedColors})`);
  }
});

test('b82_flippyPainted_perPlateChipCount', () => {
  const expected = new Map([[1, 1], [2, 2], [3, 1], [4, 2], [5, 2]]);
  const merged = perPlateChips('flippy+flappy+mini-with-plate-painted.3mf', expected);
  for (const [plateId, n] of expected) {
    const m = merged.get(plateId);
    assert.equal(m.detectedColors.length, n, `Painted-flippy plate ${plateId}: expected ${n} chip(s), got ${m.detectedColors.length} (${m.detectedColors})`);
  }
  assert.ok(merged.get(5).hasPaintData, 'Painted-flippy plate 5 must have hasPaintData=true');
});

test('b67_flarewingDragon_mergedInfoPreservesPaintData', () => {
  const file = asset(FLAREWING);
  const origInfo = parse(file, { name: FLAREWING });
  const processed = processAuto(file, FLAREWING);
  const processedInfo = parse(processed, { skipPaintDetection: true, name: FLAREWING });
  const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(mergedInfo.hasPaintData, 'Merged info must preserve hasPaintData=true');
  assert.equal(mergedInfo.detectedColors.length, 4, 'Merged info must preserve 4 detected colours');
  assert.ok(mergedInfo.detectedExtruderCount >= 4, 'Merged info must have >=4 extruders');
  assert.ok(mergedInfo.detectedColors.some((c) => c.toUpperCase() === '#0056B8'), 'Merged colors must include #0056B8');
});

test('b100_layerHeight_sentinel_respectsEmbeddedProfile', { skip }, async () => {
  await setup();
  const name = 'die-single-colour.3mf';
  const threeMf = asset(name);
  const info = parse(threeMf, { name });
  const ovMap = buildProfileOverridesImpl(sliceConfig(BASE_CONFIG),
    slicingOverrides({ layerHeight: overrideValue(OverrideMode.OVERRIDE, Math.fround(0.12)) }),
    { slotCount: 1, hasSourceConfig: false });
  const embedded = embedder.embed(threeMf, embedder.buildConfig({ info, overrides: ovMap }), info);
  assert.ok(embedded.length > 0, 'Embedded file must exist');

  lib.clearModel();
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  const resultSentinel = lib.slice({ ...BASE_CONFIG, layerHeight: 0 });
  assert.ok(resultSentinel.success, 'Sentinel slice must succeed');

  lib.clearModel();
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed for second run');
  const resultExplicit = lib.slice({ ...BASE_CONFIG, layerHeight: 0.2 });
  assert.ok(resultExplicit.success, 'Explicit slice must succeed');

  assert.ok(resultSentinel.totalLayers > resultExplicit.totalLayers,
    `0.12mm sentinel should produce more layers than 0.2mm explicit (got sentinel=${resultSentinel.totalLayers} vs explicit=${resultExplicit.totalLayers})`);
  lib.clearModel();
});

test('b104_oreoProj_singlePlateBambu_withPlateFilter_slicesSuccessfully', { skip }, async () => {
  await setup();
  const name = 'Oreo+Proj+1.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(info.isBambu, 'Oreo+Proj+1 must be detected as Bambu format');
  assert.ok(info.plates.length > 0, 'Oreo+Proj+1 must have at least one plate');
  const firstPlateId = info.plates[0].plateId;
  const sanitized = processAuto(input, name);
  const embedded = embedder.embed(sanitized, embedder.buildConfig({ info }), info, null, firstPlateId);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed with plate filter');
  const result = lib.slice(BASE_CONFIG);
  assert.ok(result, 'slice() must not return null');
  assert.ok(result.success, 'Slice must succeed — plate filter must exclude off-plate garbage objects ' +
    `that would otherwise produce a 987×510mm bounding box: ${result.errorMessage}`);
  assert.ok(result.totalLayers > 0, 'Must have at least 1 layer');
  lib.clearModel();
});

// ─── B120: filament_maps same-slot parsing ────────────────────────────────

test('b120_jonsBug_plate2_detectsBothFilaments', () => {
  const info = parseA('jons-bug.3mf');
  assert.ok(info.isBambu, 'jons-bug.3mf must be detected as Bambu format');
  assert.ok(info.isMultiPlate, 'jons-bug.3mf must be multi-plate');
  const plate2 = info.plates.find((p) => p.plateId === 2) ?? null;
  assert.ok(plate2 != null, 'Plate 2 must be present in jons-bug.3mf');
  assert.ok(plate2.filamentIndices.has(1), `Plate 2 must include canonical index 0 (PETG, filamentIndices contains 1), got ${[...plate2.filamentIndices]}`);
  assert.ok(plate2.filamentIndices.has(2), `Plate 2 must include canonical index 1 (TPU, filamentIndices contains 2), got ${[...plate2.filamentIndices]}`);
  const canonical = computePlateFileIndices({ info, plateId: 2, canonicalSize: Math.max(info.detectedColors.length, 2) });
  assert.ok(canonical != null, 'computePlateFileIndices must not return null for plate 2');
  assert.ok([0, 1].every((i) => canonical.includes(i)), `computePlateFileIndices must include 0 (PETG) and 1 (TPU), got ${canonical}`);
});

test('b128_jonsBug_declaredFileMaterialsDriveResolvedTypes', () => {
  const canonical = canonicalListAtLoad(asset('jons-bug.3mf'), 'jons-bug.3mf');
  assert.ok(canonical != null, 'canonicalListAtLoad must build a list for jons-bug.3mf');
  assert.ok(canonical.size >= 2, `jons-bug declares >= 2 filaments, got ${canonical.size}`);
  const presets = defaultExtruderPresets();
  assert.ok(presets.every((p) => p.materialType === 'PLA'), 'default presets must all be PLA');
  const injectiveMapping = [...Array(canonical.size).keys()];
  const [types, temps] = resolvePerFilamentTypeAndTemp({
    canonical, overrides: new Map(), colorMapping: injectiveMapping, presets, filamentLibrary: [],
  });
  assert.equal(types[0], 'PETG', 'file declares PETG for filament 0');
  assert.equal(types[1], 'TPU', 'file declares TPU for filament 1');
  assert.equal(temps[0], 235, 'PETG temp for filament 0');
  assert.equal(temps[1], 225, 'TPU temp for filament 1');
  assert.ok(!types.slice(0, 2).every((t) => t === 'PLA'),
    `B128 regression: declared file materials must not collapse to all-PLA (the mapped slot presets), got ${types}`);
});
