// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/SemmSlicingTest.kt on the
// wasm engine: Bambu paint-based multi-colour (SEMM) slicing through the ported
// ThreeMfParser / BambuSanitizer / ProfileEmbedder and the engine, with the same
// G-code assertions. The two H2C tests that slice the identical embedded file
// with makeConfig(4) and only differ in post-slice header patching share one
// slice (the patches are applied to a copy of the text, as Kotlin applies them to
// its own fresh file).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { canonicalFilamentList, filamentEntry, FilamentSource } from '../pipeline/canonical-filament-list.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';
import {
  fixFilamentTypeHeader, fixNozzleTemperatureHeader, resolveFilamentTypesForHeaderPatch, resolveNozzleTempsForHeaderPatch,
} from '../pipeline/profile-overrides.mjs';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { newEmbedder, once, processAuto } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import * as V from './gcode-validator.mjs';
import { NativeLib } from './native-lib.mjs';

const { remapGcode } = createRequire(import.meta.url)('../gcode-tool-remap.js');
const skip = engineAvailable ? false : 'wasm engine not built';
const embedder = newEmbedder();

const makeConfig = (extruderCount) => ({
  layerHeight: 0.2, firstLayerHeight: 0.2, perimeters: 2, topSolidLayers: 5, bottomSolidLayers: 4, fillDensity: 0.15,
  fillPattern: 'gyroid', printSpeed: 150, travelSpeed: 200, firstLayerSpeed: 50, nozzleTemp: 220, bedTemp: 65,
  nozzleDiameter: 0.4, filamentDiameter: 1.75, retractLength: 0.8, retractSpeed: 45, extruderCount,
  extruderTemps: Array(extruderCount).fill(220), wipeTowerEnabled: true, wipeTowerX: 170, wipeTowerY: 140, wipeTowerWidth: 60,
});

let lib;
async function setup() {
  lib ??= await NativeLib.create();
  lib.clearModel();
  return lib;
}
function assertSliced(result, msg) {
  assert.ok(result, 'slice() must not return null');
  assert.ok(result.success, `${msg}: ${result.errorMessage}`);
  return result.gcode;
}
const load = (name) => {
  const input = asset(name);
  return { input, origInfo: parse(input, { name }) };
};

const BENCHY = 'colored_3DBenchy (1).3mf';
const H2C = '3DBenchy-H2C-Multi-Color.3mf';
const SHOE = '1890038_xav01_H2C_279_104.3mf';

test('coloredBenchy_semm_gcodeHasToolChanges', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(BENCHY);
  assert.ok(origInfo.hasPaintData, 'colored_3DBenchy must have hasPaintData=true');
  assert.ok(origInfo.detectedColors.length >= 2, 'colored_3DBenchy must have >= 2 detected colors');
  const processed = processAuto(input, BENCHY);
  const config = embedder.buildConfig({ info: origInfo, targetExtruderCount: 2 });
  assert.equal(config.single_extruder_multi_material, '0', "single_extruder_multi_material must be '0' (U1 has independent extruders)");
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const gcode = assertSliced(lib.slice(makeConfig(2)), 'Colored Benchy must slice successfully');
  const t1Count = V.countLinesStartingWith(gcode, 'T1');
  assert.ok(t1Count > 0, `Paint segmentation must produce T1 tool changes (got ${t1Count}). ` +
    'If 0, paint_color may be stripped or paint segmentation is not running.');
  const b = V.checkBedBounds(gcode);
  assert.ok(b.withinBounds, `SEMM Benchy G-code out of bed bounds: X=[${b.minX}, ${b.maxX}] Y=[${b.minY}, ${b.maxY}]`);
  lib.clearModel();
});

test('coloredBenchy_semm_maxExtruders_notCappedAtTwo', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(BENCHY);
  const nColors = origInfo.detectedColors.length;
  assert.equal(nColors, 4, 'colored_3DBenchy must detect exactly 4 colors');
  const slotCount = Math.min(Math.max(nColors, 2), 4);
  const processed = processAuto(input, BENCHY);
  const config = embedder.buildConfig({ info: origInfo, targetExtruderCount: slotCount });
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const gcode = assertSliced(lib.slice(makeConfig(slotCount)), `${slotCount}-extruder Benchy must slice`);
  const t1 = V.countLinesStartingWith(gcode, 'T1');
  assert.ok(t1 > 0, `${slotCount}-extruder SEMM must produce T1 tool changes (got ${t1})`);
  if (slotCount >= 3) {
    const t2 = V.countLinesStartingWith(gcode, 'T2');
    assert.ok(t2 > 0, `${slotCount}-extruder SEMM must produce T2 tool changes (got ${t2})`);
  }
  if (slotCount >= 4) {
    const autoFeed = new Set(gcode.split('\n').filter((l) => l.includes('SM_PRINT_AUTO_FEED'))
      .map((l) => /EXTRUDER=(\d+)/.exec(l)?.[1]).filter((v) => v != null).map(Number));
    assert.deepEqual(autoFeed, new Set([0, 1, 2, 3]),
      `4-extruder SEMM must use all 4 extruders (SM_PRINT_AUTO_FEED for 0,1,2,3), got ${[...autoFeed]}.`);
  }
  lib.clearModel();
});

const SUPPORT_OVERRIDES = (types, temps) => ({
  enable_support: '1', support_type: 'normal(auto)', support_threshold_angle: '45',
  support_interface_top_layers: '3', support_interface_bottom_layers: '0',
  support_filament: '3', support_interface_filament: '4',
  filament_type: types, nozzle_temperature: temps, nozzle_temperature_initial_layer: [...temps],
});
const supportSliceConfig = () => ({ ...makeConfig(4), supportEnabled: true, supportType: 'normal(auto)',
  supportFilament: 3, supportInterfaceFilament: 4, extruderTemps: [220, 220, 235, 235] });

test('coloredBenchy_supportPetgE3_interfacePetgE4_slicesSuccessfully', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(BENCHY);
  assert.ok(origInfo.hasPaintData, 'colored_3DBenchy must have hasPaintData=true');
  const processed = processAuto(input, BENCHY);
  const sourceConfig = embedder.parseSourceConfig(input);
  const config = embedder.buildConfig({ info: origInfo, sourceConfig,
    overrides: SUPPORT_OVERRIDES(['PLA', 'PLA', 'PETG', 'PETG'], ['220', '220', '235', '235']), targetExtruderCount: 4 });
  assert.equal(String(config.support_filament), '3');
  assert.equal(String(config.support_interface_filament), '4');
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const gcode = assertSliced(lib.slice(supportSliceConfig()), 'Colored Benchy with PETG support E3/interface E4 must slice');
  assert.ok(gcode.includes('support_filament = 3'), 'G-code must preserve support_filament = 3');
  assert.ok(gcode.includes('support_interface_filament = 4'), 'G-code must preserve support_interface_filament = 4');
  assert.ok(V.hasExactGcodeLine(gcode, '; nozzle_temperature = 220,220,235,235'), 'G-code must preserve PETG temps for E3/E4');
  const used = V.filamentUsedMm(gcode);
  assert.ok((used[2] ?? 0) > 0, `Support slot E3 must have extrusion, filament used = ${used}`);
  lib.clearModel();
});

test('h2cBenchy_supportPetgE3_interfacePetgE4_slicesSuccessfully', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(H2C);
  assert.ok(origInfo.hasPaintData, 'H2C benchy must have hasPaintData=true');
  assert.equal(origInfo.detectedColors.length, 7, 'H2C benchy must detect 7 model colours');
  const processed = processAuto(input, H2C);
  const sourceConfig = embedder.parseSourceConfig(input);
  const config = embedder.buildConfig({ info: origInfo, sourceConfig, targetExtruderCount: 7,
    overrides: SUPPORT_OVERRIDES(['PLA', 'PLA', 'PETG', 'PETG', 'PLA', 'PLA', 'PLA'],
      ['220', '220', '235', '235', '220', '220', '220']) });
  assert.equal(String(config.support_filament), '3');
  assert.equal(String(config.support_interface_filament), '4');
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const gcode = assertSliced(lib.slice(supportSliceConfig()), 'H2C Benchy with PETG support E3/interface E4 must slice');
  assert.ok(gcode.includes('filament_type = PLA;PLA;PETG;PETG;PLA;PLA;PLA'),
    'G-code must preserve seven canonical filament_type entries with PETG at E3/E4 indices');
  assert.ok(V.hasExactGcodeLine(gcode, '; nozzle_temperature = 220,220,235,235,220,220,220'),
    'G-code must preserve seven canonical nozzle temps with PETG E3/E4');
  assert.ok(gcode.includes('support_filament = 3'), 'G-code must preserve support_filament = 3');
  assert.ok(gcode.includes('support_interface_filament = 4'), 'G-code must preserve support_interface_filament = 4');
  const used = V.filamentUsedMm(gcode);
  assert.ok((used[2] ?? 0) > 0, `Support slot E3 must have extrusion, filament used = ${used}`);
  lib.clearModel();
});

/** H2C benchy, sourceConfig embedded with 7 virtual extruders, sliced with makeConfig(4). */
const h2cSevenSlice = once(async () => {
  await setup();
  const { input, origInfo } = load(H2C);
  const processed = processAuto(input, H2C);
  const sourceConfig = embedder.parseSourceConfig(input);
  const config = embedder.buildConfig({ info: origInfo, sourceConfig, targetExtruderCount: 7 });
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const result = lib.slice(makeConfig(4));
  lib.clearModel();
  return { origInfo, config, result };
});

test('h2cBenchy_semm_allFourToolsPresent_inSlicedGcode', { skip }, async () => {
  const { origInfo, config, result } = await h2cSevenSlice();
  assert.ok(origInfo.hasPaintData, 'H2C benchy must have hasPaintData=true');
  assert.equal(origInfo.detectedColors.length, 7, 'H2C benchy must detect 7 model colours');
  assert.equal(config.extruder_count, '7', 'extruder_count must be 7 for H2C with 7 model colours');
  assert.ok(Array.isArray(config.filament_colour), 'filament_colour must be a list in embedded config (B62)');
  assert.equal(config.filament_colour.length, 7, 'filament_colour must have 7 entries for H2C (B62)');
  const gcode = assertSliced(result, 'H2C benchy must slice successfully');
  const counts = V.exactToolCounts(gcode, 4);
  const total = counts.reduce((a, b) => a + b, 0);
  for (let t = 0; t < 4; t++) {
    assert.ok(counts[t] > 0, `H2C benchy must produce T${t} tool changes (got ${counts[t]}). ` +
      'If T1=0, B48 regression: paint states beyond filament_colour.size() are being dropped.');
  }
  assert.ok(total > 600, 'B62 regression: H2C benchy must produce >600 total tool changes with ' +
    `7-colour segmentation (got ${total}). If ~432, filament_colour is not reaching the native slicer with 7 entries.`);
});

function h2cHeaderPatch(origInfo, gcode0, overrides) {
  const canonical = canonicalFilamentList({
    filaments: origInfo.detectedColors.map((hex, idx) => filamentEntry(idx, hex, 'PLA', FilamentSource.FILE_COLOUR)),
  });
  const presets = [0, 1, 2, 3].map((index) => extruderPreset({ index, color: '#FFFFFF', materialType: 'PLA' }));
  const colorMapping = [0, 1, 2, 3, 0, 1, 2];
  const args = { canonical, overrides, colorMapping, presets, filamentLibrary: [], padTo: canonical.size };
  const ftTypes = resolveFilamentTypesForHeaderPatch(args);
  const ntTemps = resolveNozzleTempsForHeaderPatch(args);
  const ft = fixFilamentTypeHeader(gcode0, ftTypes);
  assert.ok(ft.changed, 'filament_type header patch must succeed');
  const nt = fixNozzleTemperatureHeader(ft.gcode, ntTemps);
  assert.ok(nt.changed, 'nozzle_temperature header patch must succeed');
  return { canonical, gcode: nt.gcode };
}

test('h2cBenchy_filament1PetgOverride_headerArraysAgreeOnPetgSlot', { skip }, async () => {
  const { origInfo, result } = await h2cSevenSlice();
  assert.ok(origInfo.hasPaintData, 'H2C benchy must have hasPaintData=true');
  assert.equal(origInfo.detectedColors.length, 7, 'H2C benchy must detect 7 model colours');
  const gcode0 = assertSliced(result, 'H2C benchy must slice successfully');
  const { gcode } = h2cHeaderPatch(origInfo, gcode0, new Map([[0, { color: null, materialType: 'PETG' }]]));
  const lines = gcode.split('\n');
  const filamentTypeLine = lines.find((l) => l.startsWith('; filament_type = '));
  const nozzleTempLine = lines.find((l) => l.startsWith('; nozzle_temperature = '));
  assert.ok(filamentTypeLine != null, 'G-code must contain `; filament_type = ...` header line');
  assert.ok(nozzleTempLine != null, 'G-code must contain `; nozzle_temperature = ...` header line');
  const types = filamentTypeLine.slice('; filament_type = '.length).split(';');
  const temps = nozzleTempLine.slice('; nozzle_temperature = '.length).split(',').map((s) => Number.parseInt(s.trim(), 10));
  assert.equal(types.length, temps.length, `B110: filament_type and nozzle_temperature header arrays must have equal length. types=${types} temps=${temps}`);
  const petgIndex = types.indexOf('PETG');
  assert.ok(petgIndex >= 0, `Expected a PETG entry in filament_type after Filament 1 PETG override, got ${types}`);
  assert.equal(temps[petgIndex], 235, `B110: nozzle_temperature must read 235°C at slot ${petgIndex} (the same slot where ` +
    `filament_type reads PETG). types=${types} temps=${temps}`);
  const temp235Slots = temps.map((t, i) => (t === 235 ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(temp235Slots, [petgIndex], `B110: only the PETG slot (${petgIndex}) should read 235°C. temps=${temps}`);
});

test('h2cBenchy_allFilamentsPetgOverride_savedGcodeHasZeroPlaPadding', { skip }, async () => {
  const { origInfo, result } = await h2cSevenSlice();
  const gcode0 = assertSliced(result, 'slice must succeed');
  const overrides = new Map(origInfo.detectedColors.map((_, i) => [i, { color: null, materialType: 'PETG' }]));
  const { gcode } = h2cHeaderPatch(origInfo, gcode0, overrides);
  const lines = gcode.split('\n');
  const types = lines.find((l) => l.startsWith('; filament_type = ')).slice('; filament_type = '.length).split(';');
  const temps = lines.find((l) => l.startsWith('; nozzle_temperature = ')).slice('; nozzle_temperature = '.length)
    .split(',').map((s) => Number.parseInt(s.trim(), 10));
  assert.equal(types.filter((t) => t === 'PLA').length, 0, 'Jon-bug: filament_type must contain ZERO PLA entries when every ' +
    `filament is overridden to PETG. Got ${types}. Pre-fix bug surfaced 3+ PLA at canonical-overflow positions 4/5/6.`);
  assert.ok(types.every((t) => t === 'PETG'), `Jon-bug: every filament_type entry must be PETG. Got ${types}.`);
  assert.ok(temps.every((t) => t === 235), `Jon-bug: every nozzle_temperature entry must be PETG's 235°C. Got ${temps}.`);
  assert.equal(types.length, temps.length, `B110: filament_type and nozzle_temperature must agree on length. types=${types} temps=${temps}`);
});

test('flarewingDragon_semmPermutation_remapsGcodeToolIndices', { skip }, async () => {
  await setup();
  const name = 'Flarewing-Dragon_100%_4FilamentMulticolor_v1.1.3mf';
  const { input, origInfo } = load(name);
  assert.ok(origInfo.hasPaintData, 'Flarewing Dragon must have hasPaintData=true');
  assert.equal(origInfo.detectedColors.length, 4, 'Flarewing Dragon must have 4 detected colors');
  const processed = processAuto(input, name);
  const config = embedder.buildConfig({ info: origInfo, targetExtruderCount: 4 });
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const before = assertSliced(lib.slice(makeConfig(4)), 'Flarewing Dragon must slice successfully');
  const usageBefore = V.exactToolCounts(before, 4);
  for (let t = 0; t < 4; t++) assert.ok(usageBefore[t] > 0, `T${t} must have tool changes before remap, got ${usageBefore}`);
  const after = remapGcode(before, [3, 0, 2, 1]);
  const usageAfter = V.exactToolCounts(after, 4);
  assert.equal(usageAfter[3], usageBefore[0], 'T3 after remap must equal T0 before remap');
  assert.equal(usageAfter[0], usageBefore[1], 'T0 after remap must equal T1 before remap');
  assert.equal(usageAfter[2], usageBefore[2], 'T2 must be unchanged (identity in this permutation)');
  assert.equal(usageAfter[1], usageBefore[3], 'T1 after remap must equal T3 before remap');
  lib.clearModel();
});

test('h2cBenchy_semm_toolRemapMustNotScrambleGcode', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(H2C);
  const processed = processAuto(input, H2C);
  const config = embedder.buildConfig({ info: origInfo, targetExtruderCount: 7 });
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  let gcode = assertSliced(lib.slice(makeConfig(4)), 'Slice must succeed');
  const colorMapping = [2, 0, 3, 2, 0, 1, 0];
  const hasPaintData = origInfo.hasPaintData;
  assert.ok(hasPaintData, 'H2C benchy must have paint data');
  const toolRemapSlots = hasPaintData ? null : colorMapping;
  if (toolRemapSlots != null) gcode = remapGcode(gcode, toolRemapSlots);
  const counts = V.exactToolCounts(gcode, 4);
  for (let t = 0; t < 4; t++) {
    assert.ok(counts[t] > 0, `After post-processing, T${t} must still be present (got ${counts[t]}). ` +
      'If T1=0, GcodeToolRemapper scrambled SEMM tool indices.');
  }
  lib.clearModel();
});

function shoeEmbedded(origInfo, input) {
  const plateId = origInfo.plates[0]?.plateId ?? 1;
  const processed = processAuto(input, SHOE);
  const sourceConfig = embedder.parseSourceConfig(input);
  const config = embedder.buildConfig({ info: origInfo, sourceConfig, targetExtruderCount: 2, overrides: {
    enable_support: '1', support_type: 'normal(auto)', support_threshold_angle: '45',
    support_interface_top_layers: '3', support_interface_bottom_layers: '0',
    support_filament: '2', support_interface_filament: '2',
    filament_type: ['TPU', 'PLA'], nozzle_temperature: ['230', '220'], nozzle_temperature_initial_layer: ['230', '220'],
  } });
  return { config, embedded: embedder.embed(processed, config, origInfo, null, plateId) };
}
const shoeSliceConfig = () => ({ ...makeConfig(2), supportEnabled: true, supportType: 'normal(auto)',
  supportFilament: 2, supportInterfaceFilament: 2, extruderTemps: [230, 220] });

test('h2cShoe_tpuModelPlaSupportFilament_slicesWithoutCrash', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(SHOE);
  assert.ok(!origInfo.hasPaintData, 'H2C printer shoe must NOT have hasPaintData (single-colour model)');
  assert.ok(origInfo.plates.length > 0, 'Shoe must have at least one plate');
  const { config, embedded } = shoeEmbedded(origInfo, input);
  assert.equal(String(config.support_filament), '2');
  assert.equal(String(config.support_interface_filament), '2');
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  lib.setModelScale(0.2, 0.2, 0.2);
  const result = lib.slice(shoeSliceConfig());
  assert.ok(result != null, 'slice() must not return null — SIGKILL means OOM crash still present');
  if (result.success) {
    assert.ok(result.gcode.includes('support_filament = 2'), 'support_filament=2 in G-code');
    assert.ok(result.gcode.includes('support_interface_filament = 2'), 'support_interface_filament=2 in G-code');
  } else {
    assert.ok(result.errorMessage, 'slice() returned failure with null errorMessage');
  }
  lib.clearModel();
});

test('h2cShoe_30PercentScale_tpuModelPlaSupportFilament_doesNotCrash', { skip }, async () => {
  await setup();
  const { input, origInfo } = load(SHOE);
  assert.ok(!origInfo.hasPaintData, 'H2C printer shoe must NOT have hasPaintData');
  const { embedded } = shoeEmbedded(origInfo, input);
  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  lib.setModelScale(0.3, 0.3, 0.3);
  const result = lib.slice(shoeSliceConfig());
  assert.ok(result != null, 'slice() must not return null at 30% scale — SIGKILL = OOM crash');
  if (result.success) {
    assert.ok(result.gcode.includes('support_filament = 2'), 'support_filament=2 header present');
  } else {
    assert.ok(result.errorMessage, 'slice() returned failure with null errorMessage');
  }
  lib.clearModel();
});

test('skywingSeawingDragon_sliceProducesMultipleToolChanges', { skip }, async () => {
  await setup();
  const name = 'skywing-seawing-silkwing.3mf';
  const { input, origInfo } = load(name);
  assert.ok(origInfo.hasPaintData, 'skywing dragon must have hasPaintData=true');
  const nColors = origInfo.detectedColors.length;
  assert.ok(nColors >= 3, `skywing dragon must declare at least 3 filament colours, got ${origInfo.detectedColors}`);
  const slotCount = Math.min(Math.max(nColors, 2), 4);
  const processed = processAuto(input, name);
  const config = embedder.buildConfig({ info: origInfo, targetExtruderCount: slotCount });
  assert.ok(lib.loadModel(embedder.embed(processed, config, origInfo)), 'loadModel must succeed');
  const gcode = assertSliced(lib.slice(makeConfig(slotCount)), 'skywing dragon must slice successfully');
  const lines = gcode.split('\n');
  const counts = V.exactToolCounts(gcode, 4);
  const toolsPresent = counts.filter((c) => c > 0).length;
  assert.ok(toolsPresent >= 2, 'B87: skywing dragon has 3 paint states (0, 4, 8) over 3 declared filaments ' +
    `— slice output should use >= 2 distinct tools, got ${toolsPresent} (counts=${counts}).`);
  const layerChanges = lines.map((l, i) => {
    const t = l.trim();
    return t.startsWith(';LAYER_CHANGE') || t.startsWith('; CHANGE_LAYER') ? i : -1;
  }).filter((i) => i >= 0);
  const layer3Index = layerChanges[3] ?? lines.length;
  const bottomTools = new Set(lines.slice(0, layer3Index).map((l) => /^T([0-3])\b/.exec(l.trim())?.[1])
    .filter((v) => v != null).map(Number));
  assert.ok([...bottomTools].some((t) => t > 0), 'B87: the first 3 printed layers must include at least one painted tool change ' +
    `(user reports the 'black' bottom layers disappear in the sliced output). bottomTools=${[...bottomTools]}`);
  lib.clearModel();
});
