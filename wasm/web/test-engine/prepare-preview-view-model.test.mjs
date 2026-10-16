// Mirrors app/src/androidTest/java/com/u1/slicer/PreparePreviewViewModelTest.kt on the
// wasm engine. The Kotlin test drives SlicerViewModel; here the same steps go through
// SlicerSession (pipeline/session.mjs), the web port of that ViewModel flow:
//   loadModelFromFile           -> s.loadModel(name, bytes) (needsPlateSelection = showPlateSelector)
//   selectPlate(n)              -> s.selectPlate(n)
//   threeMfInfo / colorMapping / activeExtruderColors / modelInfo / config
//                               -> s.threeMfInfo / s.colorMapping / s.activeExtruderColors / s.modelInfo / s.config
//   resolvedFilamentColors      -> s.threeMfInfo.detectedColors (no per-filament overrides set)
//   getCanonicalFilamentList()  -> s.canonical
//   NativeLibrary().getPreparePreviewMesh() -> s.previewMesh(0); MeshData.recolor is ported below
//   applyPlacementPositions     -> s.setPlacement
//   startSlicing + SliceComplete gcodePath -> await s.slice() (canonical tool-space G-code, as stored)
// Android-only cases (StateFlow emission order, content-URI import, the Compose preview
// cache, viewer-only colour code) are skipped with the reason.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExcludeObjects } from '../pipeline/exclude-object-parser.mjs';
import { defaultExtruderPresets, extruderPreset } from '../pipeline/extruder-preset.mjs';
import { OverrideMode, overrideValue, slicingOverrides } from '../pipeline/slicing-overrides.mjs';
import { asset, engineAvailable, session } from './engine-helpers.mjs';

const skip = engineAvailable ? false : 'wasm engine not built';
const f = Math.fround;

async function load(name) {
  const s = await session();
  const summary = s.loadModel(name, asset(name));
  return { s, summary };
}
const distinct = (a) => [...new Set(a)];

/** SlicerViewModel.staticHexColorToFloatArray (android.graphics.Color.parseColor for #RRGGBB / #AARRGGBB). */
function hexToRgba(hex) {
  if (!hex || !hex.trim()) return [f(0.7), f(0.7), f(0.7), 1];
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) return [f(0.91), f(0.48), 0, 1];
  const rgb = h.length === 8 ? h.slice(2) : h;
  return [0, 2, 4].map((i) => f(Number.parseInt(rgb.slice(i, i + 2), 16) / 255)).concat([1]);
}

const MODIFIER_PREVIEW_COLOR = [f(0.9), f(0.15), f(0.85), f(0.5)];
/** MeshData.recolor(palette): per-triangle RGBA from palette[min(idx, last)], modifier tail translucent. */
function recolor(preview, palette) {
  const last = palette.length - 1;
  const modStart = preview.modifierStart >= 0 ? preview.modifierStart : Infinity;
  return Array.from(preview.extruders, (idx, tri) => (tri >= modStart ? MODIFIER_PREVIEW_COLOR : palette[Math.min(idx, last)]));
}
const rgbKey = (c) => {
  const ch = (v) => Math.trunc(f(v * 255));
  return (ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2]);
};
/** Kotlin loop: distinct (r,g,b) ints over triangles, stopping once `cap` are found. */
function distinctRgb(colors, cap) {
  const out = new Set();
  for (const c of colors) { out.add(rgbKey(c)); if (out.size >= cap) break; }
  return out;
}

/** The Kotlin drag tests' maxX of non-wipe-tower print moves. */
function maxPrintX(gcode, moveRe) {
  let maxX = -Infinity;
  let currentX = 0;
  let inWipeTower = false;
  for (const raw of gcode.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('; FEATURE:')) {
      const l = line.toLowerCase();
      inWipeTower = l.includes('prime tower') || l.includes('wipe');
      continue;
    }
    if (!line.startsWith('G1')) continue;
    const m = moveRe.exec(line);
    if (!m) continue;
    const xStr = m[1] ?? '';
    if (xStr.trim() !== '') { const v = Number(xStr); currentX = Number.isNaN(v) ? currentX : f(v); }
    if (!inWipeTower && currentX > maxX) maxX = currentX;
  }
  return maxX;
}

test('dragonPlate3_selectPlate_keepsThreeVisiblePrepareColours_andSliceOutput', { skip }, async () => {
  const { s, summary } = await load('Dragon Scale infinity.3mf');
  assert.ok(summary.needsPlateSelection, 'plate selector visible');
  s.selectPlate(3);
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  assert.ok(info != null, 'Plate 3 info should be available after selection');
  assert.ok(mapping != null, 'Plate 3 color mapping should be available after selection');
  assert.ok(info.detectedColors.length >= 3, `Dragon plate 3 should keep at least 3 detected colors in Prepare state, got ${info.detectedColors}`);
  assert.ok(distinct(mapping).length >= 3, `Dragon plate 3 should keep at least 3 visible slots in Prepare state, got ${mapping}`);
  assert.ok(s.activeExtruderColors.filter((c) => c.trim()).length >= 3, `Expected at least 3 non-blank active extruder colors, got ${s.activeExtruderColors}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'Native prepare preview mesh should be available after Dragon plate 3 load');
  const idx = distinct(preview.extruders).sort((a, b) => a - b);
  assert.ok(idx.length >= 3, `Dragon plate 3 native preview indices should preserve at least 3 colors, got ${idx}`);
  assert.deepEqual(idx, idx.map((_, i) => i), `Dragon plate 3 native preview indices must be compact 0..N-1 for Android recolor, got ${idx}`);
  const { gcode } = await s.slice();
  const toolLines = [...gcode.matchAll(/^T([0-3])\b/gm)].map((m) => Number(m[1]));
  const usedTools = new Set(toolLines).size;
  assert.ok(usedTools >= 3, `Dragon plate 3 slice should keep at least 3 extruders/tools in output, got ${usedTools}`);
  assert.ok(toolLines.length > 0, `Dragon plate 3 slice should contain explicit tool change commands, got ${toolLines.slice(0, 12)}`);
});

test('slipSlidePlate3_selectPlate_keepsFourVisiblePrepareColours', { skip }, async () => {
  const { s, summary } = await load('slip slide spin fidget.3mf');
  assert.ok(summary.needsPlateSelection, 'plate selector visible');
  s.selectPlate(3);
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  assert.ok(info != null, 'Slip/slide plate 3 info should be available');
  assert.ok(mapping != null, 'Slip/slide plate 3 color mapping should be available');
  assert.ok(info.detectedColors.length >= 4, `Slip/slide plate 3 should keep at least 4 detected colours in Prepare state, got ${info.detectedColors}`);
  assert.ok(distinct(mapping).length >= 4, `Slip/slide plate 3 should keep at least 4 visible slots in Prepare state, got ${mapping}`);
  assert.ok(s.activeExtruderColors.filter((c) => c.trim()).length >= 4,
    `Slip/slide plate 3 should expose at least 4 non-blank active extruder colours, got ${s.activeExtruderColors}`);
});

test('sButtons_plate1_selectPlate_keepsFourVisiblePrepareColours', { skip }, async () => {
  const { s, summary } = await load('Button-for-S-trousers.3mf');
  assert.ok(summary.needsPlateSelection, 'S-Buttons plate selector visible');
  s.selectPlate(1);
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  assert.ok(info != null, 'Plate 1 info should be available after selection');
  assert.ok(mapping != null, 'Plate 1 color mapping should be available after selection');
  assert.ok(info.detectedColors.length >= 4, `S-Buttons plate 1 should detect at least 4 colours in Prepare state, got ${info.detectedColors}`);
  assert.ok(distinct(mapping).length >= 4, `S-Buttons plate 1 colorMapping should map to at least 4 distinct extruder slots, got ${mapping}`);
  assert.ok(s.activeExtruderColors.filter((c) => c.trim()).length >= 4,
    `S-Buttons plate 1 should expose at least 4 non-blank active extruder colours, got ${s.activeExtruderColors}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'Native prepare preview mesh should be available after S-Buttons plate 1 load');
  const nativeIdx = new Set(preview.extruders);
  assert.ok(nativeIdx.size >= 4, `Native mesh should have at least 4 distinct extruder indices for S-Buttons, got ${[...nativeIdx]}`);
  const resolved = info.detectedColors;
  assert.ok(resolved.length >= 4, `S-Buttons resolvedFilamentColors must have ≥4 entries, got ${resolved.length}`);
  const rgb = distinctRgb(recolor(preview, resolved.map(hexToRgba)), 4);
  assert.ok(rgb.size >= 4, `S-Buttons plate 1 recolored mesh should have at least 4 distinct RGBA values (file declares 4 colours), got ${rgb.size}`);
});

test('buttonForSTrousers_singleFile_hasMultipleDistinctObjectsFalse_withMultiVolumeBboxes', { skip }, async () => {
  const { s, summary } = await load('Button-for-S-trousers.3mf');
  assert.ok(summary.needsPlateSelection, 'S-Buttons plate selector visible');
  s.selectPlate(1);
  assert.ok(!s.multiObject, 'B124: hasMultipleDistinctObjects must be false for a single multi-volume 3MF. ' +
    'If true, InlineModelPreview passes objectBoundingBoxes as perObjectSizes and ModelRenderer enters multiObjectMode=true — drag has no visual effect.');
  const bboxCount = s.objects().flatMap((o) => o.size ?? []).length / 3;
  assert.ok(bboxCount > 1, 'B124: objectBoundingBoxes must have > 1 entry for Button-for-S-trousers ' +
    `(expected 40 volumes, got ${bboxCount}). Without the hasMultipleDistinctObjects gate this count alone would have triggered multiObjectMode.`);
});

test('sButtons_plate1_withUserLikePresetsWhiteE2PinkE4_showsFourDistinctColors', { skip }, async () => {
  const userPresets = [
    extruderPreset({ index: 0, color: '#FFD700' }),
    extruderPreset({ index: 1, color: '#FFFFFF' }),
    extruderPreset({ index: 2, color: '#0000FF' }),
    extruderPreset({ index: 3, color: '#FF69B4' }),
  ];
  const s = await session();
  s.setPresets(userPresets);
  const summary = s.loadModel('Button-for-S-trousers.3mf', asset('Button-for-S-trousers.3mf'));
  assert.ok(summary.needsPlateSelection, 'S-Buttons plate selector visible');
  s.selectPlate(1);
  assert.equal(s.presets.find((p) => p.index === 3)?.color, '#FF69B4', 'extruderPresets should have E4=pink from DataStore');
  const colors = s.activeExtruderColors;
  const mapping = s.colorMapping;
  const distinctColors = distinct(colors.filter((c) => c.trim()));
  assert.ok(distinctColors.length >= 4, 'B86: S-Buttons with user presets [yellow,white,blue,pink] must have 4 distinct ' +
    `active extruder colours, got colors=${colors} mapping=${mapping}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'Native prepare preview mesh should be available');
  const resolved = s.threeMfInfo.detectedColors;
  assert.ok(resolved.length >= 4, `B86: resolvedFilamentColors must have ≥4 entries from the file, got ${resolved.length}`);
  const rgb = distinctRgb(recolor(preview, resolved.map(hexToRgba)), 4);
  assert.ok(rgb.size >= 4, "B86: recolored mesh must show 4 distinct RGBA values from the file's canonical filament colours " +
    `(independent of the user's slot presets). resolved=${resolved} distinctRgba=${[...rgb]}`);
});

test('skywingDragon_selectPlate1_loadCompletes', { skip }, async () => {
  const { s, summary } = await load('skywing-seawing-silkwing.3mf');
  assert.ok(summary.needsPlateSelection, 'skywing should show plate selector');
  const start = Date.now();
  s.selectPlate(1);
  const elapsed = Date.now() - start;
  assert.ok(s.modelInfo != null, 'skywing plate 1 ModelLoaded');
  assert.ok(elapsed < 360_000, `skywing plate 1 must complete within 360s; took ${elapsed}ms`);
});

test('buzzLightyear_plateSwitch_preparePreviewReflectsCurrentPlatePalette', { skip }, async () => {
  const { s, summary } = await load('Buzz_Multipart_3MF_Bambu.3mf');
  assert.ok(summary.needsPlateSelection, 'buzz plate selector visible');
  s.selectPlate(1);
  assert.ok(s.colorMapping != null, 'buzz plate 1 loaded');
  const plate1Mapping = [...s.colorMapping];
  const plate1Colors = [...s.activeExtruderColors];
  const plate1DetectedColors = [...s.threeMfInfo.detectedColors];

  s.selectPlate(9);
  assert.ok(s.colorMapping != null, 'buzz plate 9 loaded');
  const plate9Info = s.threeMfInfo;
  const plate9Mapping = [...s.colorMapping];
  const plate9Colors = [...s.activeExtruderColors];
  const plate9DetectedColors = [...plate9Info.detectedColors];
  const diag = `B88 plate-switch state: plate1 detectedColors=${plate1DetectedColors} mapping=${plate1Mapping} colors=${plate1Colors}; ` +
    `plate9 detectedColors=${plate9DetectedColors} mapping=${plate9Mapping} colors=${plate9Colors} hasPaintData=${plate9Info.hasPaintData}`;

  assert.ok(plate9DetectedColors.length > 0, `plate 9 must expose detectedColors\n${diag}`);
  for (const c of ['#FFFFFF', '#8E9089']) {
    assert.ok(plate9DetectedColors.includes(c), 'plate 9 detectedColors must include both filament 10 (#FFFFFF white, ' +
      'object extruder) and filament 11 (#8E9089 peach, paint_color="8C" decoded as state 11 by PaintColorDecoder). ' +
      `Got ${plate9DetectedColors}\n${diag}`);
  }
  assert.equal(plate9Mapping.length, plate9DetectedColors.length, `plate 9 colorMapping size must match plate 9 detectedColors size\n${diag}`);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  assert.ok(!same(plate9DetectedColors, plate1DetectedColors) || !same(plate9Mapping, plate1Mapping) || !same(plate9Colors, plate1Colors),
    `plate 9 state must differ from plate 1 state — stale leak suspected\n${diag}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'plate 9 preview mesh required');
  const canonical = s.canonical;
  assert.ok(canonical != null, `plate 9 must have canonical filament list available\n${diag}`);
  const rgb = distinctRgb(recolor(preview, canonical.filaments.map((e) => hexToRgba(e.color))), 8);
  assert.equal(rgb.size, plate9DetectedColors.length, 'plate 9 preview mesh distinct RGBA count must match plate 9 ' +
    `detectedColors count (canonical-aligned recolor)\n${diag}\n  canonicalFilaments=${canonical.filaments.map((e) => e.color)}`);
});

test.skip('flippy_layerToolOnly_hasSegments_andRecolorByZBandsProducesMultipleColours',
  'asserts on MeshData.recolorByZBands (Android viewer Z-band recolouring of the Prepare mesh), which has no web port');

test.skip('multiColorFile_colorMapping_isSetBeforeStateBecomesModelLoaded',
  'Android-only: records the StateFlow emission order of SlicerViewModel.state vs colorMapping on Dispatchers.Unconfined; ' +
  'SlicerSession.loadModel is synchronous and has no observable state stream');

test.skip('dragonScale_importViaUri_matchesDirectFilePipelineArtifacts',
  'Android-only: compares loadModel(content:// Uri via ContentResolver) with loadModelFromFile; the web has a single bytes entry point');

test('h2cBenchy_fullPipeline_greenVisibleInPreview_andAllToolsInGcode', { skip }, async () => {
  const { s } = await load('3DBenchy-H2C-Multi-Color.3mf');
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  const colors = s.activeExtruderColors;
  assert.ok(info != null, 'threeMfInfo should be non-null after H2C benchy load');
  assert.ok(mapping != null, 'colorMapping should be non-null after H2C benchy load');
  assert.ok(info.hasPaintData, 'H2C benchy must have hasPaintData=true');
  assert.ok(info.detectedColors.length >= 7, `H2C benchy must detect 7 model colours, got ${info.detectedColors.length}`);
  assert.ok(mapping.length >= 7, `H2C benchy colorMapping must have 7 entries, got ${mapping.length}`);
  assert.ok(mapping.includes(1), `colorMapping must include slot 1 (green), got distinct=${distinct(mapping)}`);
  assert.ok(colors.length > 1 && colors[1].trim() !== '', `activeExtruderColors[1] must be non-blank (green), got ${colors}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'Native preview mesh should be available for H2C benchy');
  const canonical = s.canonical;
  assert.ok(canonical != null, 'H2C benchy must have canonical filament list');
  assert.ok(canonical.size >= 7, `H2C benchy canonical filament list must have 7 entries (one per file filament), got ${canonical.size}`);
  const palette = canonical.filaments.map((e) => hexToRgba(e.color));
  const recolored = recolor(preview, palette);
  const greenFileIndex = canonical.filaments.findIndex((e) => {
    const c = hexToRgba(e.color);
    return c[1] > c[0] && c[1] > c[2] && c[1] > f(0.4);
  });
  assert.ok(greenFileIndex >= 0, `H2C benchy canonical must contain a green-ish filament; got filaments=${canonical.filaments.map((e) => e.color)}`);
  const expectedGreen = hexToRgba(canonical.filaments[greenFileIndex].color);
  let greenFound = false;
  for (let tri = 0; tri < preview.extruders.length; tri++) {
    if (preview.extruders[tri] !== greenFileIndex) continue;
    const c = recolored[tri];
    if ([0, 1, 2].every((k) => Math.abs(c[k] - expectedGreen[k]) < 0.05)) { greenFound = true; break; }
  }
  assert.ok(greenFound, `H2C benchy Prepare preview must contain canonical green (${canonical.filaments[greenFileIndex].color}) at fileIndex ` +
    `${greenFileIndex} triangles after canonical recolor`);
  const { gcode } = await s.slice();
  const counts = new Map();
  for (const l of gcode.split('\n')) {
    const m = /^\s*T(\d+)\s*$/.exec(l);
    if (m) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  }
  assert.ok(counts.size >= 2, `H2C benchy G-code must have at least 2 tool changes (multi-colour); toolCounts=${JSON.stringify([...counts])}`);
});

test('b83_paintedFlippy_selectPlate5AfterPlate4_hasTwoChips', { skip }, async () => {
  const { s, summary } = await load('flippy+flappy+mini-with-plate-painted.3mf');
  assert.ok(summary.needsPlateSelection, 'plate selector visible');
  s.selectPlate(4);
  assert.ok(s.colorMapping != null, 'plate 4 loaded');
  const plate4Info = s.threeMfInfo;
  s.selectPlate(5);
  assert.ok(s.colorMapping != null && s.threeMfInfo !== plate4Info, 'plate 5 info loaded (threeMfInfo reference changed)');
  const info = s.threeMfInfo;
  assert.equal(info.detectedColors.length, 2, `B83: plate 5 after plate 4 switch must have 2 chips (SEMM paint), got ${info.detectedColors}`);
  assert.ok(info.hasPaintData, 'B83: plate 5 must have hasPaintData=true');
});

test('shashiboPlate5_selectPlate_appPathLoadsMultiExtruderPreparePreview', { skip }, async () => {
  const { s, summary } = await load('Shashibo-h2s-textured.3mf');
  assert.ok(summary.needsPlateSelection, 'Shashibo plate selector visible');
  assert.ok(s.multiPlatePlates.some((p) => p.plateId === 5), 'Shashibo must expose plate 5 in the app plate selector');
  s.selectPlate(5);
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  assert.ok(info != null, 'Shashibo plate 5 ThreeMfInfo should be available');
  assert.ok(mapping != null, 'Shashibo plate 5 color mapping should be available');
  assert.deepEqual(info.plates.map((p) => p.plateId), [5], 'Shashibo plate 5 selected app state should be narrowed to plate 5');
  assert.ok(info.detectedColors.length >= 2, `Shashibo plate 5 should keep at least two detected colours, got ${info.detectedColors}`);
  assert.ok(info.volumeExtruders.size >= 2 || info.usedExtruderIndices.size >= 2,
    `Shashibo plate 5 should keep multi-extruder volume state, got ${[...info.volumeExtruders]}`);
  assert.ok(distinct(mapping).length >= 2, `Shashibo plate 5 Prepare mapping should expose at least two slots, got ${mapping}`);
  const preview = s.previewMesh(0);
  assert.ok(preview != null, 'Shashibo plate 5 native Prepare preview should be available');
  assert.ok(preview.positions.length > 0, 'Shashibo plate 5 preview should contain triangles');
  assert.equal(preview.extruders.length * 9, preview.positions.length, 'Shashibo plate 5 preview extruder index count should match triangle positions');
  const idx = new Set(preview.extruders);
  assert.ok(idx.size >= 2, `Shashibo plate 5 preview should preserve at least two extruder indices, got ${[...idx]}`);
  const { gcode } = await s.slice();
  const usedTools = new Set(gcode.split('\n').map((l) => /^T([0-3])$/.exec(l.trim())?.[1]).filter((v) => v != null).map(Number));
  assert.ok(usedTools.size >= 2, `Shashibo plate 5 app-path slice should preserve at least two tools, got ${[...usedTools]}`);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < preview.positions.length; i += 3) {
    const x = preview.positions[i];
    const y = preview.positions[i + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(f(maxX - minX) < 110, `Shashibo plate 5 preview should preserve file scale on X (<110mm), got ${maxX - minX}`);
  assert.ok(f(maxY - minY) < 110, `Shashibo plate 5 preview should preserve file scale on Y (<110mm), got ${maxY - minY}`);
});

test.skip('f73_changePlate_multiPlatePlatesAvailableAndCacheInvalidated',
  'Android-only: asserts SlicerViewModel.cachedPrepareMesh (the Compose InlineModelPreview mesh cache) and reopenPlateSelector(); ' +
  'SlicerSession has no preview-mesh cache — previewMesh() always asks the engine');

test('spiderman_dragToRight_preservesPositionThroughSlice', { skip }, async () => {
  const { s, summary } = await load('spiderman-hanging-pre-cut.3mf');
  if (summary.needsPlateSelection) s.selectPlate(1);
  const modelInfo = s.modelInfo;
  assert.ok(modelInfo != null, 'lastModelInfo required for B94 test');
  const { sizeX, sizeY } = modelInfo;
  const defaultX = Math.max(0, f((270 - sizeX) / 2));
  const dragX = Math.max(f(270 - sizeX), f(defaultX + 50));
  const dragY = Math.max(0, f((270 - sizeY) / 2));
  assert.ok(dragX > defaultX + 20, `B94: dragX=${dragX} must sit to the right of the default placement X=${defaultX} (otherwise the assertion below is meaningless)`);
  const wipeTowerPos = [s.config.wipeTowerX, s.config.wipeTowerY];
  s.setPlacement([dragX, dragY], wipeTowerPos);
  const { gcode } = await s.slice();
  const maxX = maxPrintX(gcode, /^G1\s+(?:X([\d.]+))?.*?(?:Y([\d.]+))?.*?E/);
  const noDragRightEdge = f(defaultX + sizeX);
  const dragRightEdge = f(dragX + sizeX);
  const midpoint = f((noDragRightEdge + dragRightEdge) / 2);
  assert.ok(maxX >= midpoint, `B94: the sliced G-code must reflect the user's drag to X=${dragX} (right edge ~${dragRightEdge}). maxX of print moves ` +
    `should sit well above the no-drag midpoint ${midpoint}. Got maxX=${maxX}. B94 diag: sizeX=${sizeX} sizeY=${sizeY} defaultX=${defaultX} ` +
    `wipeTowerX=${wipeTowerPos[0]}`);
});

test('buzzLightyear_coldLoad_skipsFullFileEmbedOnMultiPlate', { skip }, async () => {
  const s = await session();
  const started = Date.now();
  const summary = s.loadModel('Buzz_Multipart_3MF_Bambu.3mf', asset('Buzz_Multipart_3MF_Bambu.3mf'));
  const elapsed = Date.now() - started;
  assert.ok(summary.needsPlateSelection, 'buzz plate selector visible');
  assert.ok(elapsed < 110_000, 'B93: Buzz cold load to plate selector must complete within 110s ' +
    `(observed ~93s on Pixel 8a as of 2026-05-17 across builds dating to pre-F54; see test KDoc), took ${elapsed}ms`);
  assert.ok(s.currentModelBytes != null, 'currentModelPath must be set after load');
  // Kotlin: currentModelPath's name must not be embedded_<input> (the full-file embed output);
  // the session's equivalent is that the current model is the sanitized pre-embed archive itself.
  assert.ok(s.currentModelBytes === s.sourceModelBytes, 'B93: multi-plate cold load must NOT produce an embedded full-file ' +
    'artifact (current model must be the sanitized pre-embed file).');
});

test.skip('buzzLightyear_plate8_prepareAndPreviewColoursAgreeByRegionSize',
  'compares the Prepare recolour with the post-slice G-code viewer palette (GcodeParser + SlicerViewModel.normalizeGcodePreviewColors / ' +
  'slicerColorOrder, Android viewer code) — no web port of that preview-palette path');

test.skip('buzzPlate8_parsedGcodeAndPalette_renderCanonicalRedAndWhite',
  'asserts on SlicerViewModel.parsedGcode (GcodeParser) and normalizeGcodePreviewColors — Android G-code viewer state with no web port');

test('b120_jonsBug_plate2_detectsBothFilaments_viewModelPath', { skip }, async () => {
  const { s, summary } = await load('jons-bug.3mf');
  assert.ok(summary.needsPlateSelection, 'jons-bug plate selector visible');
  s.selectPlate(2);
  const info = s.threeMfInfo;
  const mapping = s.colorMapping;
  assert.ok(info != null, 'B120: jons-bug plate 2 info should be available');
  assert.ok(mapping != null, 'B120: jons-bug plate 2 color mapping should be available');
  assert.equal(info.detectedColors.length, 2, 'B120: jons-bug plate 2 must detect 2 filaments (PETG + TPU). ' +
    `got detectedColors=${info.detectedColors}`);
  assert.equal(distinct(mapping).length, 2, `B120: jons-bug plate 2 colorMapping must reference 2 distinct slots. got mapping.distinct()=${distinct(mapping)}`);
});

test('buttonForSTrousers_dragToRight_preservesPositionThroughSlice', { skip }, async () => {
  const { s, summary } = await load('Button-for-S-trousers.3mf');
  assert.ok(summary.needsPlateSelection, 'Button plate selector visible');
  s.selectPlate(1);
  assert.ok(!s.multiObject, 'B124: hasMultipleDistinctObjects must be false for a single multi-volume 3MF');
  const modelInfo = s.modelInfo;
  assert.ok(modelInfo != null, 'modelInfo must be available after load');
  const { sizeX, sizeY } = modelInfo;
  const defaultX = Math.max(0, f((270 - sizeX) / 2));
  const dragX = Math.max(f(270 - sizeX), f(defaultX + 40));
  const dragY = Math.max(0, f((270 - sizeY) / 2));
  assert.ok(dragX > defaultX + 20, `B124: dragX=${dragX} must sit right of default X=${defaultX}`);
  s.setPlacement([dragX, dragY], [s.config.wipeTowerX, s.config.wipeTowerY]);
  const { gcode } = await s.slice();
  const maxX = maxPrintX(gcode, /^G1\s+(?:X([\d.]+))?.*?E/);
  const noDragRightEdge = f(defaultX + sizeX);
  const dragRightEdge = f(dragX + sizeX);
  const midpoint = f((noDragRightEdge + dragRightEdge) / 2);
  assert.ok(maxX >= midpoint, `B124: sliced G-code must reflect drag to X=${dragX} (right edge ~${dragRightEdge}). ` +
    `maxX should be above midpoint ${midpoint}. B124 diag: sizeX=${sizeX} defaultX=${defaultX} dragX=${dragX} maxX=${maxX}`);
});

test('h2cShoe_supportFilamentOverride_embedsCorrectExtruderCount_and_producesT1InGcode', { skip }, async () => {
  const { s, summary } = await load('1890038_xav01_H2C_279_104.3mf');
  assert.ok(summary.needsPlateSelection, 'H2C shoe plate selector visible');
  s.selectPlate(1);
  assert.ok(!(s.threeMfInfo?.hasPaintData ?? false), 'B125: H2C shoe must NOT have paint data (single-colour model)');
  s.overrides = slicingOverrides({
    supports: overrideValue(OverrideMode.OVERRIDE, true),
    supportType: overrideValue(OverrideMode.OVERRIDE, 'normal(auto)'),
    supportAngle: overrideValue(OverrideMode.OVERRIDE, 45),
    supportFilament: overrideValue(OverrideMode.OVERRIDE, 2),
    supportInterfaceFilament: overrideValue(OverrideMode.OVERRIDE, 2),
  });
  assert.equal(s.overrides.supportFilament.mode, OverrideMode.OVERRIDE, 'slicingOverrides updated with support override');
  s.setModelScale(0.2, 0.2, 0.2);
  const { gcode } = await s.slice();
  assert.ok(gcode.includes('support_filament = 2'), "B125: G-code header must contain 'support_filament = 2' — " +
    'if absent, the support_filament override was not embedded');
  const t1Count = gcode.split('\n').filter((l) => l.trim() === 'T1').length;
  assert.ok(t1Count > 0, 'B125: T1 (support on E2) must appear in G-code when supportFilament=OVERRIDE(2). ' +
    `Got T1=${t1Count} — if 0, embedProfile set extruder_count=1 and OrcaSlicer ignored support_filament=2.`);
});

test('f91_editLibraryFilamentAfterLoad_triggersReEmbedSoNewValuesReachGcode', { skip }, async () => {
  const { s } = await load('tetrahedron.stl');
  assert.ok(s.modelInfo != null, 'STL loaded');
  // Seeded Generic PLA (AppDatabase.seedDefaultFilaments), linked to slot 0 ...
  const pla = { id: 1, name: 'Generic PLA', material: 'PLA', nozzleTemp: 220, bedTemp: 55, retractLength: 0.8, retractSpeed: 45,
    color: '#4CAF50', density: 1.24, isDefault: true };
  s.filaments = [pla];
  s.presets = s.presets.map((p) => (p.index === 0 ? { ...p, filamentProfileId: pla.id, materialType: 'PLA' } : p));
  assert.equal(s.presets.find((p) => p.index === 0)?.filamentProfileId, pla.id, 'slot 0 linked to PLA profile');
  // ... then the library entry is edited after load (updateFilament).
  s.filaments = [{ ...pla, maxVolumetricSpeed: f(16), pressureAdvance: f(0.024), enablePressureAdvance: true }];
  assert.equal(s.filaments.find((x) => x.id === pla.id)?.maxVolumetricSpeed, 16, 'library reflects updated maxVolumetricSpeed');
  const { gcode } = await s.slice();
  const headerValue = (key) => {
    const line = gcode.split('\n').find((l) => l.startsWith(`; ${key} =`));
    return line == null ? null : line.slice(line.indexOf('=') + 1).trim();
  };
  const maxVol = headerValue('filament_max_volumetric_speed');
  assert.ok(maxVol != null, 'filament_max_volumetric_speed header missing');
  assert.ok(maxVol.includes('16'), `F91 regression: expected library value 16 to reach the G-code header, got: ${maxVol}. ` +
    "If 21, the re-embed didn't fire after the library mutation and the slicer used the bundled pla.json default.");
  assert.equal(headerValue('enable_pressure_advance'), '1', 'enable_pressure_advance should be 1 (library has it true)');
  const pa = headerValue('pressure_advance');
  assert.ok(pa != null, 'pressure_advance header missing');
  assert.ok(pa.includes('0.024'), `F91 regression: expected library PA value 0.024 in G-code header, got: ${pa}`);
});

test('autoArrangeAll_twoObjects_noOverlapAndOnBed', { skip }, async () => {
  const { s } = await load('tetrahedron.stl');
  assert.ok(s.modelInfo != null, 'first STL loaded');
  s.addModel('tetrahedron.stl', asset('tetrahedron.stl'));
  assert.ok(s.multiObject, 'second STL added to bed');
  s.autoArrange();
  const pos = s.customObjectPositions;
  assert.ok(pos != null, 'multiObjectPositions must be set after arrange');
  assert.equal(pos.length, 4, 'two objects → 4 floats');
  const boxes = s.objects().flatMap((o) => o.size);
  const [ax, ay, bx, by] = pos;
  const [asx, asy] = [boxes[0], boxes[1]];
  const [bsx, bsy] = [boxes[3], boxes[4]];
  const overlap = ax < bx + bsx && ax + asx > bx && ay < by + bsy && ay + asy > by;
  assert.ok(!overlap, 'arranged objects must not overlap');
  for (let i = 0; i < 2; i++) {
    assert.ok(pos[i * 2] >= 0 && pos[i * 2] <= 270, `obj ${i} on bed X`);
    assert.ok(pos[i * 2 + 1] >= 0 && pos[i * 2 + 1] <= 270, `obj ${i} on bed Y`);
  }
});

test('autoArrangeAll_singleFileMultiObject_doesNotEnterMultiObjectMode', { skip }, async () => {
  const { s, summary } = await load('Button-for-S-trousers.3mf');
  assert.ok(summary.needsPlateSelection, 'S-Buttons plate selector visible');
  s.selectPlate(1);
  assert.ok(!s.multiObject, 'precondition: single-file load must not be multi-object');
  const result = s.autoArrange();
  assert.ok(!s.multiObject, 'auto-arrange must not flip single-file model into multi-object mode');
  assert.equal(s.customObjectPositions, null, 'auto-arrange must not publish multi-object positions for a single-file model');
  assert.ok(result?.message?.includes('needs multiple objects'), `guard toast emitted (got ${JSON.stringify(result)})`);
});

test('orcaCubeV2_twoCopies_sliceProducesMoreFilamentThanSingleCopy', { skip }, async () => {
  const name = 'Cube+v2.3mf';
  async function sliceForCopies(copies) {
    const { s, summary } = await load(name);
    if (summary.needsPlateSelection) s.selectPlate(1);
    s.setCopyCount(copies);
    const positions = s.placementPositions();
    assert.equal(positions.length, copies * 2, `OrcaCube_v2 copyCount=${copies} should publish one [x,y] pair per copy`);
    const { gcode } = await s.slice();
    const usedLine = gcode.split('\n').find((l) => l.startsWith('; filament used [mm] = '));
    const filamentUsed = usedLine == null ? NaN : usedLine.slice(usedLine.indexOf('=') + 1).split(',')
      .map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)).reduce((a, b) => f(a + b), 0);
    const ex = parseExcludeObjects(gcode);
    const objectMarkerCount = ex.length;
    const distinctCenterCount = new Set(ex.map((o) => o.center.join(','))).size;
    assert.equal(objectMarkerCount, copies * 2, `Cube+v2 copyCount=${copies} should emit one object marker per original object per copy`);
    assert.equal(distinctCenterCount, copies * 2, `Cube+v2 copyCount=${copies} should preserve the two-object plate spacing across copies`);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const raw of gcode.split('\n')) {
      const line = raw.split(';')[0].trim();
      if (!line.startsWith('G0 ') && !line.startsWith('G1 ')) continue;
      let x = null, y = null;
      for (const token of line.split(/[ \t]/)) {
        if (token.length <= 1) continue;
        const v = Number(token.slice(1));
        if (token[0] === 'X') x = Number.isNaN(v) ? null : v;
        if (token[0] === 'Y') y = Number.isNaN(v) ? null : v;
      }
      if (x != null && x > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      if (y != null && y > 0) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    assert.ok(Number.isFinite(filamentUsed) && filamentUsed > 0, `Cube+v2 copyCount=${copies} slice must report filament usage in G-code`);
    return { filamentUsed, objectMarkerCount, distinctCenterCount, minX, maxX, minY, maxY };
  }
  const one = await sliceForCopies(1);
  const two = await sliceForCopies(2);
  assert.ok(two.filamentUsed > one.filamentUsed * 1.6, 'Cube+v2 should use substantially more filament for 2 copies than 1 copy. ' +
    `1-copy=${one.filamentUsed}mm, 2-copy=${two.filamentUsed}mm`);
  assert.equal(two.objectMarkerCount, 4, `Cube+v2 2-copy slice should emit four object markers, got ${two.objectMarkerCount}`);
  assert.equal(two.distinctCenterCount, 4, `Cube+v2 2-copy slice should preserve four unique object centers, got ${two.distinctCenterCount}`);
  assert.ok((two.maxX - two.minX) > (one.maxX - one.minX) + 10 || (two.maxY - two.minY) > (one.maxY - one.minY) + 10,
    'Cube+v2 2-copy toolpath should expand the footprint on at least one axis. ' +
    `1-copy spanX=${one.maxX - one.minX}mm spanY=${one.maxY - one.minY}mm, 2-copy spanX=${two.maxX - two.minX}mm spanY=${two.maxY - two.minY}mm`);
});
