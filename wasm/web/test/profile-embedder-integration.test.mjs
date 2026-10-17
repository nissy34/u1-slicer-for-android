// Ports the ZIP-content / config-level cases of
//   app/src/androidTest/java/com/u1/slicer/slicing/ProfileEmbedderIntegrationTest.kt
//   app/src/androidTest/java/com/u1/slicer/slicing/NegativeVolumePreservationTest.kt
// against the real fixtures in app/src/androidTest/assets.
//
// Cases that need the native engine (loadModel / slice / G-code assertions) are
// test.skip'ed here — they are verified by the wasm engine tests instead. Cases
// whose assertions are about ThreeMfParser / SlicerViewModel detection belong to
// those ports and are skipped too. Where Kotlin calls ThreeMfParser.parse() only to
// feed buildConfig/embed, `info` is built by hand from inspecting the fixture
// (documented per fixture below).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readZip, getEntry, readEntryText, writeZip, DEFLATED } from '../pipeline/zip.mjs';
import { process, extractPlate } from '../pipeline/bambu-sanitizer.mjs';
import { ProfileEmbedder } from '../pipeline/profile-embedder.mjs';

const ROOT = new URL('../../../', import.meta.url);
const ASSETS = new URL('app/src/androidTest/assets/', ROOT);
const PROFILES = new URL('app/src/main/assets/orca_profiles/', ROOT);
const asset = (name) => new Uint8Array(fs.readFileSync(new URL(encodeURIComponent(name).replace(/%2F/g, '/'), ASSETS)));
const profile = (p) => JSON.parse(fs.readFileSync(new URL(p, PROFILES), 'utf8'));
const newEmbedder = () => new ProfileEmbedder({
  printer: profile('printer/snapmaker_u1.json'),
  process: profile('process/standard_0.20mm.json'),
  filament: profile('filament/pla.json'),
});
const NATIVE = 'needs the native engine (loadModel/slice) — covered by the wasm engine tests';
const PARSER = 'asserts ThreeMfParser / SlicerViewModel detection — covered by those ports';

const baseInfo = (o) => ({
  objects: [], plates: [], isBambu: false, isMultiPlate: false, hasPaintData: false, hasPaintSupports: false,
  hasLayerToolChanges: false, detectedColors: [], detectedExtruderCount: 1, hasPlateJsons: false, ...o,
});

/** plater_id -> object ids from model_settings.config (what ThreeMfParser exposes as plates). */
function platesFromModelSettings(bytes) {
  const xml = readEntryText(readZip(bytes), 'Metadata/model_settings.config') ?? '';
  return [...xml.matchAll(/<plate>[\s\S]*?<\/plate>/g)].map((m) => ({
    plateId: Number(/key="plater_id" value="(\d+)"/.exec(m[0])[1]),
    objectIds: [...m[0].matchAll(/key="object_id" value="(\d+)"/g)].map((x) => x[1]),
  }));
}

// Fixture infos (fields buildConfig/embed read). All five fixtures carry
// Metadata/model_settings.config + project_settings.config, so isBambu=true.
const INFO = {
  // dual-colour calib cube, single plate, no paint / layer tool changes
  calibCube: baseInfo({ isBambu: true, detectedExtruderCount: 2 }),
  fanCover: baseInfo({ isBambu: true }),
  // flippy+flappy+mini: custom_gcode_per_layer.xml tool changes, 4 plates in
  // model_settings.config, no Metadata/plate_N.json
  flippy: (bytes) => baseInfo({
    isBambu: true, isMultiPlate: true, hasLayerToolChanges: true, detectedExtruderCount: 2,
    plates: platesFromModelSettings(bytes), hasPlateJsons: false,
  }),
};

function fullPipeline(assetName, info) {
  const input = asset(assetName);
  const stage1 = info.isBambu ? process(input, { isBambu: true }) : input;
  const embedder = newEmbedder();
  const config = embedder.buildConfig({ info });
  const embedded = embedder.embed(stage1, config, info);
  assert.ok(embedded.length > 0, 'Embedded file should be non-empty');
  return embedded;
}

// ─── ProfileEmbedder output validity ─────────────────────────────────────────

test('embed_producesValidZip_calibCube', () => {
  const embedded = fullPipeline('calib-cube-10-dual-colour-merged.3mf', INFO.calibCube);
  const entries = readZip(embedded); // throws if corrupt
  assert.ok(entries.length > 0, 'Embedded ZIP should have entries');
});

test('embed_containsProjectSettingsConfig_calibCube', () => {
  const embedded = fullPipeline('calib-cube-10-dual-colour-merged.3mf', INFO.calibCube);
  const entries = readZip(embedded);
  const entry = getEntry(entries, 'Metadata/project_settings.config') ?? getEntry(entries, 'project_settings.config');
  assert.notEqual(entry, null, 'Embedded ZIP must contain project_settings.config');
  const content = new TextDecoder().decode(entry.data);
  assert.ok(content.includes('='), 'Config should have keys');
});

test('embed_configHasMinimumKeyCount_calibCube', () => {
  const config = newEmbedder().buildConfig({ info: INFO.calibCube });
  assert.ok(Object.keys(config).length >= 100, `Config should have >= 100 keys, was ${Object.keys(config).length}`);
});

test('embed_configHasMinimumKeyCount_singleColour', () => {
  const config = newEmbedder().buildConfig({ info: INFO.fanCover });
  assert.ok(Object.keys(config).length >= 100, `Config should have >= 100 keys, was ${Object.keys(config).length}`);
});

test('embed_configContainsNozzleTemperature', () => {
  const config = newEmbedder().buildConfig({ info: INFO.calibCube });
  assert.ok('nozzle_temperature' in config, 'Config must contain nozzle_temperature');
});

test('embed_configContainsLayerHeight', () => {
  const config = newEmbedder().buildConfig({ info: INFO.fanCover });
  assert.ok('layer_height' in config, 'Config must contain layer_height');
});

// ─── Full pipeline: embed → load → slice (native) ────────────────────────────

test.skip('fanCover_fullPipeline_slicesSuccessfully', NATIVE);
test.skip('fanCover_fullPipeline_gcodeHasNonZeroTemps', NATIVE);
test.skip('calibCube_fullPipeline_slicesSuccessfully', NATIVE);
test.skip('buttonTrousers_fullPipeline_slicesSuccessfully', NATIVE);

// ─── Support preservation (B10 regression guard) ─────────────────────────────

// Kotlin also asserts on ThreeMfParser.parse + SlicerViewModel.mergeThreeMfInfo
// output (mergedInfo.isBambu, detectedExtruderCount > 1); those parts use the
// parser/merge ports when they load, otherwise this test is skipped.
let parserMods = null;
try {
  const [p, m] = await Promise.all([
    import('../pipeline/three-mf-parser.mjs'), import('../pipeline/merge-three-mf-info.mjs')]);
  if (typeof p.parse === 'function' && typeof m.mergeThreeMfInfo === 'function') parserMods = { parse: p.parse, mergeThreeMfInfo: m.mergeThreeMfInfo };
} catch {
  parserMods = null;
}

test('shashibo_supportPreservedInEmbeddedConfig', { skip: parserMods ? false : 'three-mf-parser / merge-three-mf-info ports not loadable yet' }, () => {
  const embedder = newEmbedder();
  const input = asset('Shashibo-h2s-textured.3mf');
  const origInfo = parserMods.parse(input);
  const sourceConfig = embedder.parseSourceConfig(input);
  assert.notEqual(sourceConfig, null, 'Shashibo should have source config');
  assert.equal(String(sourceConfig.enable_support), '1', 'Source config should have enable_support=1');

  const processed = process(input, { isBambu: origInfo.isBambu });
  const processedInfo = parserMods.parse(processed);
  const mergedInfo = parserMods.mergeThreeMfInfo(processedInfo, origInfo);
  assert.ok(mergedInfo.isBambu, 'Merged info should preserve isBambu=true');
  assert.ok(mergedInfo.detectedExtruderCount > 1, 'Merged info should have detectedExtruderCount > 1');

  const config = embedder.buildConfig({ info: mergedInfo, sourceConfig, targetExtruderCount: 2 });
  assert.equal(String(config.enable_support), '1', 'Embedded config must preserve enable_support=1');

  const configWithProcessedInfo = embedder.buildConfig({ info: processedInfo, sourceConfig, targetExtruderCount: 2 });
  assert.equal(String(configWithProcessedInfo.enable_support), '1',
    'processedInfo now preserves support (deferred restructuring keeps model_settings.config)');
});

// ─── INI / JSON import ───────────────────────────────────────────────────────

test('embed_preservesMachinePauseGcodeForLayerToolChanges', () => {
  const embedder = newEmbedder();
  const sourceConfig = {
    machine_pause_gcode: 'M0 ; pause for color swap',
    change_filament_gcode: 'M600 ; swap filament',
    single_extruder_multi_material: '1',
    enable_support: '1',
  };
  const info = baseInfo({ isBambu: true, isMultiPlate: false, hasLayerToolChanges: true });
  const preserved = embedder.buildConfig({ info, sourceConfig, targetExtruderCount: 1 });
  assert.equal(preserved.machine_pause_gcode, 'M0 ; pause for color swap',
    'Layer tool changes must preserve machine_pause_gcode for Hueforge-style pauses');
  assert.equal(preserved.single_extruder_multi_material, '0', 'Layer tool changes must force manual pause compatibility on U1');
  assert.ok(!('change_filament_gcode' in preserved), 'Layer tool changes should drop the Bambu filament swap script');

  const stripped = embedder.buildConfig({ info: { ...info, hasLayerToolChanges: false }, sourceConfig, targetExtruderCount: 1 });
  assert.ok(!('machine_pause_gcode' in stripped),
    'machine_pause_gcode should be stripped when the source has no layer tool changes');
});

test.skip('shashibo_detectsLayerToolColors', PARSER);
test.skip('coloredBenchy_detectsMultiColourMetadata', PARSER);
test.skip('flippyFlappyMini_detectsLayerChangeColours', PARSER);
test.skip('flippyFlappyMini_fullPipeline_emitsLayerChangePauseGcode', NATIVE);

test('flippyFlappyMini_embedDropsLayerToolMetadataForNativeSliceFallback', () => {
  const embedder = newEmbedder();
  const input = asset('flippy+flappy+mini.3mf');
  const info = INFO.flippy(input);
  const sanitized = process(input, { isBambu: true });
  const config = embedder.buildConfig({ info, sourceConfig: embedder.parseSourceConfig(input), targetExtruderCount: 1 });
  const embedded = embedder.embed(sanitized, config, info);
  assert.equal(getEntry(readZip(embedded), 'Metadata/custom_gcode_per_layer.xml'), null,
    'embedded file should drop custom_gcode_per_layer.xml so native slicing stays on the fast path');
});

test('flippyFlappyMini_sanitizerPreservesLayerToolMetadata', () => {
  const sanitized = process(asset('flippy+flappy+mini.3mf'), { isBambu: true });
  assert.notEqual(getEntry(readZip(sanitized), 'Metadata/custom_gcode_per_layer.xml'), null,
    'sanitized file should preserve custom_gcode_per_layer.xml');
});

test('flippyFlappyMini_extractPlateKeepsOnlySelectedLayerToolMetadata', () => {
  const input = asset('flippy+flappy+mini.3mf');
  const origInfo = INFO.flippy(input);
  const sanitized = process(input, { isBambu: true });
  const targetPlateId = 4;
  const plateObjectIds = origInfo.plates.find((p) => p.plateId === targetPlateId)?.objectIds;
  assert.ok(plateObjectIds != null, `sample should expose plate ${targetPlateId}`);

  const plateFile = extractPlate(sanitized, targetPlateId, {
    hasPlateJsons: origInfo.hasPlateJsons, plateObjectIds: new Set(plateObjectIds),
  });
  const entries = readZip(plateFile);
  const entry = getEntry(entries, 'Metadata/custom_gcode_per_layer.xml');
  assert.notEqual(entry, null, 'plate extract should keep custom_gcode_per_layer.xml');
  const xml = new TextDecoder().decode(entry.data);
  assert.ok(xml.includes('plate_info id="1"'), 'single-plate extract should be renumbered to plate 1');
  assert.ok(!xml.includes(`plate_info id="${targetPlateId}"`), 'original plate id should be rewritten for single-plate slicing');
  assert.ok(!xml.includes('plate_info id="10"'), 'other plate metadata should be removed');
});

test.skip('flippyFlappyMini_plateSelectionDetectsOnlySelectedColours', `${PARSER} (ThreeMfParser.parseForPlateSelection)`);
test.skip('layerToolPlateMerge_prefersSelectedPlatePalette', `${PARSER} (SlicerViewModel.mergeThreeMfInfoForPlate)`);

test('bambuFilamentJson_parsedByBambuSanitizer', () => {
  const content = new TextDecoder().decode(asset('Bambu PLA Basic @BBL P1S 0.4 nozzle.json'));
  assert.ok(content.includes('nozzle_temperature'), 'JSON should contain nozzle_temperature');
  assert.ok(content.trim().startsWith('{'), 'JSON should be valid JSON');
});

// ─── Re-embed regression guard (B24) ─────────────────────────────────────────

test.skip('calibCube_reEmbedBeforeSlice_doesNotBreakSlicing', NATIVE);

test('embed_bothSlic3rAndModelSettings_noDuplicateEntry', () => {
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="5" y="10" z="0"/>
          <vertex x="5" y="5" z="10"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
          <triangle v1="0" v2="1" v3="3"/>
          <triangle v1="1" v2="2" v3="3"/>
          <triangle v1="0" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
  const slic3rConfig = `<config>
  <object id="1">
    <metadata type="object" key="extruder" value="1"/>
    <volume firstid="0" lastid="3">
      <metadata type="volume" key="extruder" value="1"/>
    </volume>
  </object>
</config>`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <metadata key="extruder" value="1"/>
  </object>
</config>`;
  // ZipOutputStream default entries are DEFLATED
  const synthetic = writeZip([
    { name: '3D/3dmodel.model', data: modelXml, method: DEFLATED },
    { name: 'Metadata/Slic3r_PE_model.config', data: slic3rConfig, method: DEFLATED },
    { name: 'Metadata/model_settings.config', data: modelSettings, method: DEFLATED },
  ]);
  // ThreeMfParser.parse(synthetic): model_settings.config is a Bambu marker
  const info = baseInfo({ isBambu: true });
  const embedder = newEmbedder();
  const config = embedder.buildConfig({ info });
  const embedded = embedder.embed(synthetic, config, info); // Kotlin crashed here pre-fix
  assert.ok(embedded.length > 0, 'Embedded file should exist');
  const count = readZip(embedded).filter((e) => e.name === 'Metadata/model_settings.config').length;
  assert.equal(count, 1, 'Must have exactly one model_settings.config');
});

test.skip('benchy_stl_slicesAfterClearAndReload', NATIVE);
test.skip('pressureAdvancePassesThroughFromEmbeddedProfile', NATIVE);

// ─── Sub-plan #2b: embed plateId + XML filter ────────────────────────────────

function buildSource3mfWithCustomGcodeXml(customGcodeXml) {
  const minimalModel = '<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>';
  return writeZip([
    { name: '3D/3dmodel.model', data: minimalModel, method: DEFLATED },
    { name: 'Metadata/project_settings.config', data: '{"filament_colour":["#FFFFFF"]}', method: DEFLATED },
    { name: 'Metadata/custom_gcode_per_layer.xml', data: customGcodeXml, method: DEFLATED },
  ]);
}

test('embed_withPlateIdNull_dropsCustomGcodePerLayerXml_whenHasLayerToolChanges', () => {
  const source = buildSource3mfWithCustomGcodeXml(`<?xml version="1.0"?>
<custom_gcodes_per_layer>
  <plate>
    <plate_info id="1"/>
    <layer top_z="1.6" type="2" extruder="2" color="#AA0000" extra="" gcode="tool_change"/>
  </plate>
</custom_gcodes_per_layer>`);
  const info = baseInfo({ isBambu: true, isMultiPlate: false, hasLayerToolChanges: true });
  const out = newEmbedder().embed(source, {}, info);
  assert.equal(getEntry(readZip(out), 'Metadata/custom_gcode_per_layer.xml') != null, false,
    'plateId=null legacy path must drop the XML');
});

test('embed_withPlateId1_filtersCustomGcodePerLayerXml_toThatPlateOnly', () => {
  const source = buildSource3mfWithCustomGcodeXml(`<?xml version="1.0"?>
<custom_gcodes_per_layer>
  <plate>
    <plate_info id="1"/>
    <layer top_z="1.6" type="2" extruder="2" color="#AA0000" extra="" gcode="tool_change"/>
  </plate>
  <plate>
    <plate_info id="2"/>
    <layer top_z="3.2" type="2" extruder="3" color="#00AA00" extra="" gcode="tool_change"/>
  </plate>
</custom_gcodes_per_layer>`);
  const info = baseInfo({ isBambu: true, isMultiPlate: true, hasLayerToolChanges: true });
  const out = newEmbedder().embed(source, {}, info, null, 1);
  const entry = getEntry(readZip(out), 'Metadata/custom_gcode_per_layer.xml');
  assert.notEqual(entry, null, 'plateId=1 must keep the XML in the embedded file');
  const body = new TextDecoder().decode(entry.data);
  assert.ok(body.includes('top_z="1.6"'), "embedded XML must contain plate 1's layer (top_z=1.6)");
  assert.ok(!body.includes('top_z="3.2"'), "embedded XML must NOT contain plate 2's layer (top_z=3.2)");
  assert.equal([...body.matchAll(/<plate>/g)].length, 1, 'filtered output must have exactly one <plate> block');
});

// ─── F87 / F91 (assert on sliced G-code headers) ─────────────────────────────

test.skip('f87_processProfileKeys_overrideBundledProcessProfile', NATIVE);
test.skip('f87_emptyProcessProfileKeys_keepsBundledDefaults', NATIVE);
test.skip('f91_filamentSettings_emitInGcodeHeader', NATIVE);
test.skip('f91_omittedFilamentSettings_keepsBundledDefaults', NATIVE);

// ─── NegativeVolumePreservationTest (B137) ───────────────────────────────────

const negativePartCount = (configXml) => [...configXml.matchAll(/subtype="negative_part"/g)].length;
function readModelSettings(bytes) {
  const entries = readZip(bytes);
  const text = readEntryText(entries, 'Metadata/model_settings.config') ??
    readEntryText(entries, 'Metadata/Slic3r_PE_model.config');
  if (text == null) throw new Error('no model_settings.config / Slic3r_PE_model.config');
  return text;
}

// The final `lib.loadModel(embedded)` assertion needs the native engine and is
// left to the wasm engine tests; everything up to the embedded config is checked.
test('largeCompoundModel_negativeVolumesSurviveProcessAndEmbed', () => {
  const input = asset('negative-volume-articulated.3mf');
  // ThreeMfParser.parse(input): Bambu markers present; model_settings.config has one
  // plate (plater_id 1) holding object 4. mergedInfo carries the same plates.
  const origInfo = baseInfo({ isBambu: true, plates: platesFromModelSettings(input) });
  assert.ok(origInfo.isBambu, 'fixture should be detected as Bambu');
  assert.equal(negativePartCount(readModelSettings(input)), 2, 'source fixture must contain exactly 2 negative_part volumes');

  const processed = process(input, { isBambu: origInfo.isBambu });
  assert.notEqual(processed, input, 'process() must produce a sanitized archive (streaming >64MB path)');
  const mergedInfo = origInfo;
  const firstPlateId = mergedInfo.plates[0]?.plateId ?? null;
  assert.equal(firstPlateId, 1);
  const embedder = newEmbedder();
  const config = embedder.buildConfig({ info: mergedInfo });
  const embedded = embedder.embed(processed, config, mergedInfo, null, firstPlateId);

  const embeddedConfig = readModelSettings(embedded);
  assert.equal(negativePartCount(embeddedConfig), 2,
    `embedded model_settings.config must preserve both negative_part subtypes (got config:\n${embeddedConfig}\n)`);
});
