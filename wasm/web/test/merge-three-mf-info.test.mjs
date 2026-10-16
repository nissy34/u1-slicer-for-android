// Mirrors app/src/test/java/com/u1/slicer/MergeThreeMfInfoTest.kt case by case
// (mergeThreeMfInfo / mergeThreeMfInfoForPlate, preview-file helpers,
// isH2cSourceConfig, buildPreviewSlotColors, buildCompactExtruderRemap,
// computeEmbedTargetCount).
import assert from 'node:assert/strict';
import test from 'node:test';
import { threeMfInfo, threeMfPlate, layerToolSegment } from '../pipeline/three-mf-info.mjs';
import {
  mergeThreeMfInfo, mergeThreeMfInfoForPlate, shouldDeferPaintDetectionForImport,
  resolvePreviewModelFile, resolvePlateSelectionSourceFile, isH2cSourceConfig,
  buildPreviewSlotColors, EXTRUDER_PRESET_DEFAULT_COLORS,
} from '../pipeline/merge-three-mf-info.mjs';
import { buildCompactExtruderRemap, computeEmbedTargetCount } from '../pipeline/embed-target.mjs';

const S = (...v) => new Set(v);
const M = (...pairs) => new Map(pairs);
const info = (fields) => threeMfInfo({ objects: [], plates: [], ...fields });
const plate = (plateId, name, objectIds, extra = {}) => threeMfPlate({ plateId, name, objectIds, ...extra });
const MB = 1024 * 1024;
const preset = (index, color) => ({ index, color });
const embedCount = (colorMapping, hasPaintData, toolRemapSlots, fallbackExtCount, hasMultiExtruderAssignments = false) =>
  computeEmbedTargetCount({ colorMapping, hasPaintData, toolRemapSlots, fallbackExtCount, hasMultiExtruderAssignments });

test('shouldDeferPaintDetectionForImport only defers risky archives', () => {
  const risky = {
    largestComponentEntry: '3D/Objects/huge.model',
    largestComponentBytes: 300 * MB,
    totalComponentBytes: 420 * MB,
  };
  assert.equal(shouldDeferPaintDetectionForImport(risky), true);
  assert.equal(shouldDeferPaintDetectionForImport(null), false);
});

test('mergeThreeMfInfoForPlate prefers plate objectExtruderMap when non-empty', () => {
  const sourceInfo = info({
    isBambu: true, isMultiPlate: true,
    objectExtruderMap: M(['10', 1], ['11', 2], ['12', 3]), // old IDs
    detectedColors: ['#FF0000', '#00FF00', '#0000FF'],
    detectedExtruderCount: 3,
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    objectExtruderMap: M(['4', 1], ['5', 2], ['6', 3]), // new restructured IDs
    usedExtruderIndices: S(1, 2, 3),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo);
  assert.deepEqual(merged.objectExtruderMap, M(['4', 1], ['5', 2], ['6', 3]));
});

test('mergeThreeMfInfoForPlate falls back to source objectExtruderMap when plate is empty', () => {
  const sourceInfo = info({
    isBambu: true, isMultiPlate: true,
    objectExtruderMap: M(['10', 1], ['11', 2]),
    detectedColors: ['#FF0000', '#00FF00'],
    detectedExtruderCount: 2,
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    objectExtruderMap: M(),
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo);
  assert.deepEqual(merged.objectExtruderMap, M(['10', 1], ['11', 2]));
});

test('mergeThreeMfInfoForPlate uses selected source plate filament indices when extracted plate under-detects colours', () => {
  const sourceInfo = info({
    plates: [plate(3, '4 Colour', ['58'], { filamentIndices: S(1, 2), filamentMapSlots: S(1, 2) })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#101010', '#202020', '#303030', '#404040'],
    detectedExtruderCount: 4,
  });
  const plateInfo = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 3);
  assert.deepEqual(merged.detectedColors, ['#101010', '#202020']);
  assert.equal(merged.detectedExtruderCount, 2);
});

test('mergeThreeMfInfoForPlate keeps richer extracted plate colours when they exceed source filament maps', () => {
  const sourceInfo = info({
    plates: [plate(3, '4 Colour', ['58'], { filamentIndices: S(1, 2), filamentMapSlots: S(1, 2) })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#101010', '#202020', '#303030', '#404040'],
    detectedExtruderCount: 4,
  });
  const plateInfo = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3, 4) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 3);
  assert.deepEqual(merged.detectedColors, ['#101010', '#202020', '#303030', '#404040']);
  assert.equal(merged.detectedExtruderCount, 4);
});

test('mergeThreeMfInfoForPlate layer-tool models include base object colour from selected plate', () => {
  const sourceInfo = info({
    plates: [plate(4, 'Small - Dual Colour', ['5'], { filamentIndices: S() })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#161616', '#F4D976', '#368CF9'],
    detectedExtruderCount: 3,
    hasLayerToolChanges: true,
    objectExtruderMap: M(['5', 1]),
  });
  const plateInfo = info({
    isBambu: true, isMultiPlate: false,
    detectedColors: ['#F4D976'],
    detectedExtruderCount: 1,
    hasLayerToolChanges: true,
    usedExtruderIndices: S(2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 4);
  assert.deepEqual(merged.detectedColors, ['#161616', '#F4D976']);
  assert.equal(merged.detectedExtruderCount, 2);
  assert.deepEqual(merged.usedExtruderIndices, S(1, 2));
});

test('mergeThreeMfInfoForPlate with per-object assignments avoids full layer-tool palette', () => {
  const sourceInfo = info({
    plates: [plate(5, 'Textured', ['58'], { filamentIndices: S(1, 2), filamentMapSlots: S(1, 2) })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#C1', '#C2', '#C3', '#C4', '#C5'],
    detectedExtruderCount: 5,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2),
  });
  const plateInfo = info({
    isBambu: true, isMultiPlate: false,
    detectedColors: ['#C1', '#C2', '#C3', '#C4', '#C5'],
    detectedExtruderCount: 5,
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 5);
  assert.deepEqual(merged.detectedColors, ['#C1', '#C2']);
  assert.equal(merged.detectedExtruderCount, 2);
});

test('mergeThreeMfInfoForPlate prefers selected source plate indices over over-reported used extruders', () => {
  const sourceInfo = info({
    plates: [plate(5, 'Selected Plate', ['58'], { filamentIndices: S(1, 2), filamentMapSlots: S(1, 2) })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#A', '#B', '#C', '#D'],
    detectedExtruderCount: 4,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2),
  });
  const plateInfo = info({
    isBambu: true, isMultiPlate: false,
    // Extracted plate metadata can over-report here; should not drive colour count.
    usedExtruderIndices: S(1, 2, 3),
    detectedColors: ['#A', '#B', '#C', '#D'],
    detectedExtruderCount: 4,
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 5);
  assert.deepEqual(merged.detectedColors, ['#A', '#B']);
  assert.equal(merged.detectedExtruderCount, 2);
});

test('mergeThreeMfInfoForPlate layer-tool assignment fallback expands one reported source slot to stable dual slot', () => {
  const sourceInfo = info({
    plates: [plate(5, 'Selected Plate', ['58'], { filamentIndices: S(1), filamentMapSlots: S(1) })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#F4D976', '#EC008C', '#F7D959', '#F4EE2A'],
    detectedExtruderCount: 4,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2),
  });
  const plateInfo = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 5);
  assert.deepEqual(merged.detectedColors, ['#F4D976', '#EC008C']);
  assert.equal(merged.detectedExtruderCount, 2);
});

test('mergeThreeMfInfoForPlate non-layer-tool assignment keeps richer extracted used extruders', () => {
  const sourceInfo = info({
    plates: [plate(3, 'Dragon Plate 3', ['58'], { filamentIndices: S() })],
    isBambu: true, isMultiPlate: true,
    detectedColors: ['#F4EE2A', '#F4D976', '#EC008C'],
    detectedExtruderCount: 3,
    hasLayerToolChanges: false,
    volumeExtruders: S(1, 2),
    objectExtruderMap: M(['58', 1]),
  });
  const plateInfo = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 3);
  assert.deepEqual(merged.detectedColors, ['#F4EE2A', '#F4D976', '#EC008C']);
  assert.equal(merged.detectedExtruderCount, 3);
});

test('mergeThreeMfInfo prefers processed objectExtruderMap when available', () => {
  const origInfo = info({
    isBambu: true, isMultiPlate: false,
    objectExtruderMap: M(['3', 2]),
    detectedColors: ['#FF0000', '#00FF00', '#0000FF'],
    detectedExtruderCount: 3,
    usedExtruderIndices: S(1, 2, 3),
    hasPaintData: true,
  });
  const processedInfo = info({ isBambu: false, isMultiPlate: false, objectExtruderMap: M(['1', 1], ['2', 2]) });
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.deepEqual(merged.objectExtruderMap, M(['1', 1], ['2', 2]));
  assert.deepEqual(merged.usedExtruderIndices, S(1, 2, 3));
});

test('mergeThreeMfInfo falls back to orig objectExtruderMap when processed is empty', () => {
  const origInfo = info({
    isBambu: true, isMultiPlate: false,
    objectExtruderMap: M(['1', 1], ['2', 2]),
    detectedColors: ['#FF0000', '#00FF00'],
    detectedExtruderCount: 2,
    hasPaintData: true,
  });
  const processedInfo = info({ isBambu: false, isMultiPlate: false, objectExtruderMap: M() });
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.deepEqual(merged.objectExtruderMap, M(['1', 1], ['2', 2]));
});

test('mergeThreeMfInfo carries layerToolSegments from origInfo', () => {
  const segments = [layerToolSegment(1.0, 1), layerToolSegment(5.0, 2)];
  const origInfo = info({ isBambu: false, isMultiPlate: false, hasLayerToolChanges: true, layerToolSegments: segments });
  const processedInfo = info({ isBambu: false, isMultiPlate: false });
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.deepEqual(merged.layerToolSegments, segments);
});

test('mergeThreeMfInfoForPlate carries layerToolSegments from sourceInfo', () => {
  const segments = [layerToolSegment(2.0, 1), layerToolSegment(8.0, 2)];
  const sourceInfo = info({ isBambu: false, isMultiPlate: false, hasLayerToolChanges: true, layerToolSegments: segments });
  const plateInfo = info({ isBambu: false, isMultiPlate: false });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo);
  assert.deepEqual(merged.layerToolSegments, segments);
});

test('resolvePreviewModelFile prefers raw file for H2C source projects', () => {
  const raw = 'raw.3mf';
  const source = 'sanitized.3mf';
  const selected = resolvePreviewModelFile({
    rawInputFile: raw,
    sourceModelFile: source,
    currentModelFile: null,
    info: info({ isBambu: true, isMultiPlate: false }),
    originalSourceConfig: {
      filament_settings_id: ['Bambu PLA Basic @BBL H2C'],
      extruder_ams_count: ['1#1|4#0', '1#0|4#2'],
    },
  });
  assert.equal(selected, raw);
});

test('resolvePreviewModelFile keeps sanitized file for non-H2C Bambu previews', () => {
  const raw = 'raw.3mf';
  const source = 'sanitized.3mf';
  const selected = resolvePreviewModelFile({
    rawInputFile: raw,
    sourceModelFile: source,
    currentModelFile: null,
    info: info({ isBambu: true, isMultiPlate: false }),
    originalSourceConfig: { filament_colour: ['#FF0000', '#00FF00'] },
  });
  assert.equal(selected, source);
});

test('resolvePlateSelectionSourceFile prefers pre-embed source for multi-plate extraction', () => {
  const source = 'processed.3mf';
  const current = 'embedded_sanitized.3mf';
  assert.equal(resolvePlateSelectionSourceFile({ sourceModelFile: source, currentModelFile: current }), source);
});

test('resolvePlateSelectionSourceFile falls back to current model when source missing', () => {
  const current = 'embedded_sanitized.3mf';
  assert.equal(resolvePlateSelectionSourceFile({ sourceModelFile: null, currentModelFile: current }), current);
});

test('isH2cSourceConfig ignores generic machine compatibility markers', () => {
  const config = new Map([
    ['upward_compatible_machine', 'Bambu Lab H2C 0.4 nozzle'],
    ['extruder_ams_count', ['1#0|4#0', '']],
    ['physical_extruder_map', ['0']],
    ['filament_settings_id', ['Bambu PLA Basic @BBL A1M']],
  ]);
  assert.equal(isH2cSourceConfig(config), false);
});

test('buildCompactExtruderRemap compacts original extruders to chosen slot order', () => {
  const i = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3, 4, 5) });
  const remap = buildCompactExtruderRemap(i, [0, 0, 3, 3, 0]);
  assert.deepEqual(remap, M([1, 1], [2, 1], [3, 2], [4, 2], [5, 1]));
});

test('buildCompactExtruderRemap returns null without color mapping', () => {
  const i = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3) });
  assert.equal(buildCompactExtruderRemap(i, null), null);
  assert.equal(buildCompactExtruderRemap(i, []), null);
});

test('buildCompactExtruderRemap falls back to color row indices when source extruders are missing', () => {
  const i = info({ isBambu: true, isMultiPlate: false });
  const remap = buildCompactExtruderRemap(i, [0, 1, 3, 3]);
  assert.deepEqual(remap, M([1, 1], [2, 2], [3, 3], [4, 3]));
});

test('buildPreviewSlotColors uses slot colors instead of detected model colors', () => {
  const presets = [preset(0, '#112233'), preset(1, '#445566'), preset(2, '#778899'), preset(3, '#AABBCC')];
  const colors = buildPreviewSlotColors(presets, [3, 2, 1, 0]);
  assert.deepEqual(colors, ['#112233', '#445566', '#778899', '#AABBCC']);
});

test('buildPreviewSlotColors falls back to default slot colors when preset color is blank', () => {
  const presets = [preset(0, ''), preset(1, '#445566'), preset(2, ''), preset(3, '#AABBCC')];
  const colors = buildPreviewSlotColors(presets, [0, 1, 2, 3]);
  assert.deepEqual(colors, [EXTRUDER_PRESET_DEFAULT_COLORS[0], '#445566', EXTRUDER_PRESET_DEFAULT_COLORS[2], '#AABBCC']);
});

// ── Color bug fix (SEMM models) ──────────────────────────────────────────────

test('buildCompactExtruderRemap returns null for SEMM model (hasPaintData=true)', () => {
  // SEMM models: per-triangle paint states bypass extruder attribute remapping.
  const i = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3, 4), hasPaintData: true });
  assert.equal(buildCompactExtruderRemap(i, [2, 0, 3, 1]), null,
    'SEMM models must not produce an extruder remap (GcodeToolRemapper handles it)');
});

test('buildCompactExtruderRemap returns null for SEMM model even with identity colorMapping', () => {
  const i = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3, 4), hasPaintData: true });
  assert.equal(buildCompactExtruderRemap(i, [0, 1, 2, 3]), null);
});

test('buildCompactExtruderRemap still works for per-object models (hasPaintData=false)', () => {
  const i = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3, 4), hasPaintData: false });
  const remap = buildCompactExtruderRemap(i, [2, 0, 3, 1]);
  assert.notEqual(remap, null);
  // file extruder 1→slot2→compact3, 2→slot0→compact1, 3→slot3→compact4, 4→slot1→compact2
  assert.deepEqual(remap, M([1, 3], [2, 1], [3, 4], [4, 2]));
});

test('buildCompactExtruderRemap returns null for layer tool change models', () => {
  const i = info({ isBambu: true, isMultiPlate: false, hasLayerToolChanges: true, usedExtruderIndices: S(1, 2, 3) });
  assert.equal(buildCompactExtruderRemap(i, [0, 1, 2]), null,
    'Layer tool change models should stay single-filament at slice time');
});

// ── layerToolOnly single-colour plate colour chip tests ─────────────────────

test('mergeThreeMfInfoForPlate single-colour layerToolOnly plate shows 1 chip when sourcePlateObjectExtruders has 1 entry', () => {
  // flippy+flappy+mini plate 1: all objects on extruder 1, plateInfo over-reports [1,2].
  const sourceInfo = info({
    plates: [plate(1, 'Single Colour', ['obj1'])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(),
    hasPaintData: false,
    objectExtruderMap: M(['obj1', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 1);
  assert.equal(merged.detectedColors.length, 1,
    'Single-colour layerToolOnly plate must show 1 colour chip, not leak plateInfo extruder 2');
  assert.equal(merged.detectedColors[0], '#161616');
});

test('mergeThreeMfInfoForPlate dual-colour layerToolOnly plate shows 2 chips when sourcePlateObjectExtruders is empty', () => {
  // flippy+flappy+mini plate 4: Hueforge-style, no object extruder map.
  const sourceInfo = info({
    plates: [plate(4, 'Dual Colour', [])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(),
    hasPaintData: false,
    objectExtruderMap: M(),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 4);
  assert.equal(merged.detectedColors.length, 2,
    'Dual-colour layerToolOnly plate (no object extruder map) must show 2 colour chips');
});

// ── B81: non-painted plate in a file where other plates have paint data ─────

test('mergeThreeMfInfoForPlate single-colour layerToolOnly plate in painted file shows 1 chip', () => {
  const sourceInfo = info({
    plates: [plate(1, 'Plate 1', ['obj1'])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(),
    hasPaintData: true, // file has other plates with paint
    objectExtruderMap: M(['obj1', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    hasPaintData: false, // this plate has no paint
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 1);
  assert.equal(merged.detectedColors.length, 1,
    'Non-painted plate in painted file must use plate-level hasPaintData for layerToolOnly check');
  assert.equal(merged.detectedColors[0], '#161616');
});

test('mergeThreeMfInfoForPlate painted plate shows hasPaintData true', () => {
  const sourceInfo = info({
    plates: [plate(5, 'Plate 5', ['obj5'], { hasPaintData: true })],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    hasPaintData: true,
    objectExtruderMap: M(['obj5', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    hasPaintData: true, // legacy fallback; merge uses sourcePlate.hasPaintData first
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 5);
  assert.equal(merged.hasPaintData, true, 'Painted plate must produce hasPaintData=true in merged result');
});

// ── B82: per-plate layer-tool secondary colour matching ─────────────────────

test('mergeThreeMfInfoForPlate dual-colour plate with palette-matching layer-tool secondary shows 2 chips', () => {
  const sourceInfo = info({
    plates: [plate(2, 'Dual Colour', ['obj2'], {
      layerToolColors: ['#F4D976'], layerToolExtruders: S(2), hasLayerToolChanges: true,
    })],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(),
    hasPaintData: false,
    objectExtruderMap: M(['obj2', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 2);
  assert.equal(merged.detectedColors.length, 2,
    'Dual-colour plate with palette-matching layer-tool secondary must show 2 chips');
  assert.equal(merged.detectedColors[0], '#161616');
  assert.equal(merged.detectedColors[1], '#F4D976');
});

test('mergeThreeMfInfoForPlate single-colour plate with non-palette layer-tool secondary shows 1 chip', () => {
  const sourceInfo = info({
    plates: [plate(1, 'Single Colour', ['obj1'], {
      layerToolColors: ['#2323F7'], layerToolExtruders: S(2), hasLayerToolChanges: true,
    })],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(),
    hasPaintData: false,
    objectExtruderMap: M(['obj1', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 1);
  assert.equal(merged.detectedColors.length, 1,
    'Single-colour plate with non-palette layer-tool secondary must show 1 chip');
  assert.equal(merged.detectedColors[0], '#161616');
});

// ── isHueforgePlate classification tests ────────────────────────────────────

test('mergeThreeMfInfoForPlate is NOT Hueforge when objectExtruderMap has diverse extruders', () => {
  // Shashibo: layer-tool changes AND per-object extruder diversity.
  const sourceInfo = info({
    plates: [plate(5, 'Textured', ['5'], { filamentIndices: S(1), filamentMapSlots: S(1) })],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2),
    objectExtruderMap: M(['5', 1], ['1', 2], ['2', 1], ['3', 2], ['4', 1]),
    detectedColors: ['#F4D976', '#EC008C', '#F7D959', '#F4EE2A'],
    detectedExtruderCount: 4,
    layerToolSegments: [layerToolSegment(12.4, 2), layerToolSegment(24.8, 3)],
    usedExtruderIndices: S(1, 2, 3),
  });
  const plateInfo = info({ isBambu: true, isMultiPlate: false, usedExtruderIndices: S(1, 2, 3) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 5);
  assert.equal(merged.hasMultiExtruderAssignments, true,
    'Shashibo-like file with per-object extruder diversity must keep volumeExtruders = setOf(1, 2)');
  assert.equal(merged.hasLayerToolChanges, true, 'Layer tool changes should be preserved');
  assert.equal(merged.hasPaintData, false, 'Not a paint data file');
});

test('mergeThreeMfInfoForPlate IS Hueforge when objectExtruderMap has uniform extruder', () => {
  // Flippy plate 4: single object, all objectExtruderMap values = 1.
  const sourceInfo = info({
    plates: [plate(4, 'Dual Colour', ['5'])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2), // source-level flag may be true from other plates
    objectExtruderMap: M(['3', 1], ['4', 1], ['5', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    layerToolSegments: [layerToolSegment(1.2, 2), layerToolSegment(9.2, 2)],
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 4);
  assert.equal(merged.hasMultiExtruderAssignments, false,
    'Pure Hueforge plate (uniform objectExtruderMap) must have volumeExtruders = emptySet()');
  assert.equal(merged.hasLayerToolChanges, true, 'Layer tool changes should be preserved');
  assert.ok(merged.detectedExtruderCount >= 2, 'Hueforge plate needs extruderCount >= 2 for Z-band preview');
});

test('mergeThreeMfInfoForPlate is NOT Hueforge when plate has paint data', () => {
  const sourceInfo = info({
    plates: [plate(1, 'painted', ['1'], { hasPaintData: true })],
    isBambu: true, isMultiPlate: false,
    hasLayerToolChanges: true,
    hasPaintData: true,
    objectExtruderMap: M(['1', 1]), // single extruder but has paint
    detectedColors: ['#FF0000', '#00FF00'],
    detectedExtruderCount: 2,
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    hasPaintData: true, // legacy fallback; ignored when sourcePlate.hasPaintData is set
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 1);
  assert.equal(merged.hasPaintData, true, 'Paint data must be preserved from plate');
});

test('mergeThreeMfInfoForPlate IS Hueforge when plate has no paint but source does', () => {
  const sourceInfo = info({
    plates: [plate(4, 'Dual Colour', ['5'])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    hasPaintData: true, // source-level: another plate has paint
    objectExtruderMap: M(['5', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    layerToolSegments: [layerToolSegment(1.6, 2)],
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({
    isBambu: false, isMultiPlate: false,
    hasPaintData: false, // THIS plate's extracted file has no paint
    usedExtruderIndices: S(1, 2),
  });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 4);
  assert.equal(merged.hasPaintData, false, 'Plate without paint data should have hasPaintData=false even if source has paint');
  assert.equal(merged.hasMultiExtruderAssignments, false,
    'Layer-tool plate without paint should have volumeExtruders = emptySet() (Hueforge path)');
  assert.equal(merged.hasLayerToolChanges, true);
  assert.ok(merged.detectedExtruderCount >= 2, 'Hueforge plate needs extruderCount >= 2');
});

test('mergeThreeMfInfoForPlate clears hasMultiExtruderAssignments for single-object plate', () => {
  const sourceInfo = info({
    plates: [plate(1, 'plate1', ['3']), plate(2, 'plate2', ['4']), plate(3, 'plate3', ['2']), plate(4, 'plate4', ['5'])],
    isBambu: true, isMultiPlate: true,
    hasLayerToolChanges: true,
    volumeExtruders: S(1, 2),
    objectExtruderMap: M(['3', 1], ['4', 1], ['2', 1], ['5', 1]),
    detectedColors: ['#161616', '#F4D976'],
    detectedExtruderCount: 2,
    layerToolSegments: [layerToolSegment(1.2, 2), layerToolSegment(9.2, 2)],
    usedExtruderIndices: S(1, 2),
  });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, usedExtruderIndices: S(1, 2) });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo, 4);
  assert.equal(merged.hasMultiExtruderAssignments, false,
    'Plate 4 has single-object extruder assignment — hasMultiExtruderAssignments should be false');
  assert.equal(merged.hasLayerToolChanges, true, 'Layer tool changes should be preserved');
});

// ── computeEmbedTargetCount tests (B48) ─────────────────────────────────────

test('computeEmbedTargetCount uses full colorMapping size for H2C SEMM models', () => {
  // H2C benchy: 7 model colours → 4 distinct physical slots → virtual count 7.
  assert.equal(embedCount([2, 0, 3, 2, 0, 1, 0], true, null, 4), 7);
});

test('computeEmbedTargetCount uses distinct count for per-object models', () => {
  assert.equal(embedCount(null, false, [2, 3], 4), 2);
});

test('computeEmbedTargetCount falls back to slotCount when no remap slots', () => {
  assert.equal(embedCount(null, false, null, 4), 4);
  assert.equal(embedCount(null, true, null, 1), 1);
});

test('computeEmbedTargetCount handles 4-colour SEMM identity mapping', () => {
  assert.equal(embedCount([0, 1, 2, 3], true, null, 4), 4);
});

test('computeEmbedTargetCount pure-SEMM duplicate mapping uses distinct count', () => {
  assert.equal(embedCount([0, 0, 1, 1], true, null, 2), 2);
});

test('computeEmbedTargetCount old_3mf — 6 colours to 2 slots uses distinct', () => {
  assert.equal(embedCount([0, 2, 0, 2, 0, 2], true, null, 2), 2);
});

test('computeEmbedTargetCount Korok — 5 colours to 3 slots uses distinct', () => {
  assert.equal(embedCount([0, 0, 1, 1, 3], true, null, 3), 3);
});

test('computeEmbedTargetCount B76 Goat hybrid paint+per-object uses full size', () => {
  assert.equal(embedCount([0, 1, 2, 2], true, null, 3, true), 4);
});

test('computeEmbedTargetCount B76 Goat pure-paint variant stays distinct', () => {
  assert.equal(embedCount([0, 1, 2, 2], true, null, 3, false), 3);
});

test('mergeThreeMfInfo preserves hasPaintSupports from origInfo', () => {
  const origInfo = info({ isBambu: true, isMultiPlate: false, hasPaintSupports: true });
  const processedInfo = info({ isBambu: false, isMultiPlate: false, hasPaintSupports: false });
  const merged = mergeThreeMfInfo(processedInfo, origInfo);
  assert.equal(merged.hasPaintSupports, true, 'mergeThreeMfInfo must carry hasPaintSupports from origInfo');
});

test('mergeThreeMfInfoForPlate preserves hasPaintSupports from sourceInfo', () => {
  const sourceInfo = info({ isBambu: true, isMultiPlate: true, hasPaintSupports: true });
  const plateInfo = info({ isBambu: false, isMultiPlate: false, hasPaintSupports: false });
  const merged = mergeThreeMfInfoForPlate(plateInfo, sourceInfo);
  assert.equal(merged.hasPaintSupports, true, 'mergeThreeMfInfoForPlate must carry hasPaintSupports from sourceInfo');
});
