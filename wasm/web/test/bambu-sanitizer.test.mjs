// Mirrors app/src/test/java/com/u1/slicer/bambu/BambuSanitizerTest.kt case by case.
// Where the Kotlin test re-implements a private helper inline (it cannot reach
// BambuSanitizer's privates from the JVM), the JS test calls the real ported
// function instead and keeps the same assertions.
//   cd wasm/web && node --test test/bambu-sanitizer.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SANITIZER_CONSTANTS, parseIniConfigPublic, filterModelToPlate, stripNonPrintableBuildItems,
  stripAssembleSection, clampScalarPosition, filterCustomGcodePerLayer, sanitizeModelSettings, _internal,
} from '../pipeline/bambu-sanitizer.mjs';

const between = (s, a, b) => {
  const i = s.indexOf(a);
  const after = i < 0 ? s : s.slice(i + a.length);
  const j = after.indexOf(b);
  return j < 0 ? after : after.slice(0, j);
};

test('sanitizer drops known incompatible files', () => {
  const dropFiles = new Set([
    'Metadata/slice_info.config',
    'Metadata/cut_information.xml',
    'Metadata/filament_sequence.json',
    'Metadata/Slic3r_PE.config',
    'Metadata/Slic3r_PE_model.config',
  ]);
  assert.equal(dropFiles.size, 5);
  // The port exposes the real set: it must match the specification.
  assert.deepEqual([...SANITIZER_CONSTANTS.DROP_FILES].sort(), [...dropFiles].sort());
});

test('clamp rules have correct minimum values', () => {
  const clampRules = SANITIZER_CONSTANTS.CLAMP_RULES;
  // Filament indices should clamp to 1, not 0
  assert.equal(clampRules.get('solid_infill_filament'), 1);
  assert.equal(clampRules.get('wall_filament'), 1);
  // Dimensional values clamp to 0
  assert.equal(clampRules.get('prime_volume'), 0);
});

test('INI config parsing basic', () => {
  const content = [
    'layer_height = 0.2',
    'nozzle_temp = 210',
    '# comment line',
    '; another comment',
    '',
    'filament_colour = #FF0000;#00FF00;#0000FF',
  ].join('\n');
  const config = parseIniConfigPublic(content);
  assert.equal(config.layer_height, '0.2');
  assert.equal(config.nozzle_temp, '210');
  assert.ok(Array.isArray(config.filament_colour));
  const colors = config.filament_colour;
  assert.equal(colors.length, 3);
  assert.equal(colors[0], '#FF0000');
});

test('INI config ignores comments and blank lines', () => {
  const content = ['# Header comment', '; Another comment', '', 'key1 = value1', 'key2 = value2'].join('\n');
  const config = parseIniConfigPublic(content);
  assert.equal(Object.keys(config).length, 2);
  assert.equal(config.key1, 'value1');
});

test('nil replacement logic', () => {
  const config = { nozzle_temperature: ['210', 'nil', 'nil', '220'] };
  _internal.sanitizeNilValues(config);
  assert.deepEqual(config.nozzle_temperature, ['210', '210', '210', '220']);
});

test('nil replacement all nil removes key', () => {
  const list = ['nil', 'nil', 'nil'];
  assert.equal(list.find((it) => it !== 'nil'), undefined);
  const config = { k: list };
  _internal.sanitizeNilValues(config);
  assert.equal(config.k, undefined);
});

test('array normalization padding', () => {
  const config = { filament_type: ['a', 'b'] };
  _internal.normalizePerFilamentArrays(config, 4);
  assert.deepEqual(config.filament_type, ['a', 'b', 'b', 'b']);
});

test('array normalization truncation', () => {
  const config = { filament_type: ['a', 'b', 'c', 'd'] };
  _internal.normalizePerFilamentArrays(config, 2);
  assert.deepEqual(config.filament_type, ['a', 'b']);
});

test('flush matrix size is NxN', () => {
  const config = { flush_volumes_matrix: ['0', '100', '100', '100', '0', '100'] };
  _internal.normalizePerFilamentArrays(config, 3);
  assert.equal(config.flush_volumes_matrix.length, 9);
});

test('mmu_segmentation is renamed to paint_color for SEMM support', () => {
  const input = ' slic3rpe:mmu_segmentation="4"';
  const output = _internal.convertMmuSegmentation(input);
  assert.ok(!output.includes('mmu_segmentation'), 'slic3rpe:mmu_segmentation attribute name must be gone');
  assert.ok(output.includes('paint_color="4"'), 'must be renamed to paint_color=');
});

test('transform clamping for packed plates', () => {
  const bedCenter = 135;
  const packedThreshold = bedCenter * 2 + 100; // 370
  const tx = 500;
  assert.ok(Math.abs(tx) > packedThreshold);
  const clamped = Math.abs(tx) > packedThreshold ? bedCenter : tx;
  assert.ok(Math.abs(clamped - 135) <= 0.001);
  // Through the real sanitizeModelSettings: tx=500 is re-centred to (135, 135, 0).
  const out = sanitizeModelSettings('<assemble_item object_id="3" transform="1 0 0 0 1 0 0 0 1 500 20 5"/>');
  assert.ok(out.includes('135.000000 135.000000 0.000000'), out);
});

test('transform within threshold is not clamped', () => {
  const bedCenter = 135;
  const packedThreshold = bedCenter * 2 + 100;
  const tx = 150;
  assert.ok(!(Math.abs(tx) > packedThreshold));
  const xml = '<assemble_item object_id="3" transform="1 0 0 0 1 0 0 0 1 150 20 5"/>';
  assert.equal(sanitizeModelSettings(xml), xml);
});

test('filterModelToPlate logic - p_object_id plates', () => {
  const xml = `<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>
    <object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>
    <object id="3" type="model"><mesh><vertices/><triangles/></mesh></object>
  </resources>
  <build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" p:object_id="0"/>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0" p:object_id="0"/>
    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0" p:object_id="1"/>
  </build>
</model>`;
  const plate1 = filterModelToPlate(xml, 1);
  const plate2 = filterModelToPlate(xml, 2);
  assert.ok(plate1.includes('objectid="1"'), 'Plate1 should contain item 1');
  assert.ok(plate1.includes('objectid="2"'), 'Plate1 should contain item 2');
  assert.ok(!(plate1.includes('objectid="3"') && between(plate1, '<build', '</build>').includes('objectid="3"')),
    'Plate1 should not contain item 3');
  assert.ok(between(plate2, '<build', '</build>').includes('objectid="3"'), 'Plate2 should contain item 3');
  assert.ok(plate1.includes('id="1"'), 'Resources intact: object 1');
  assert.ok(plate1.includes('id="2"'), 'Resources intact: object 2');
  assert.ok(plate1.includes('id="3"'), 'Resources intact: object 3');
});

test('filterModelToPlate p_object_id - virtual positions group-recentred', () => {
  const xml = `<build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0" p:object_id="0"/>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 200 100 0" p:object_id="0"/>
    <item objectid="4" transform="1 0 0 0 1 0 0 0 1 400 100 0" p:object_id="1"/>
    <item objectid="5" transform="1 0 0 0 1 0 0 0 1 500 100 0" p:object_id="1"/>
</build>`;
  const b1 = between(filterModelToPlate(xml, 1), '<build>', '</build>');
  assert.ok(b1.includes('objectid="1"'), 'Plate1 obj1 present');
  assert.ok(b1.includes('objectid="2"'), 'Plate1 obj2 present');
  assert.ok(b1.includes('100 100 0'), 'Plate1 obj1 XY unchanged');
  assert.ok(b1.includes('200 100 0'), 'Plate1 obj2 XY unchanged');

  // bbox centre = (450, 100), offset = (-315, 35) -> obj4(85,135), obj5(185,135)
  const b2 = between(filterModelToPlate(xml, 2), '<build>', '</build>');
  assert.ok(b2.includes('objectid="4"'), 'Plate2 obj4 present');
  assert.ok(b2.includes('objectid="5"'), 'Plate2 obj5 present');
  assert.ok(!b2.includes('400 100 0'), 'Plate2: not at virtual positions');
  assert.ok(b2.includes('85 135 0'), 'Plate2 obj4 group-shifted to (85,135)');
  assert.ok(b2.includes('185 135 0'), 'Plate2 obj5 group-shifted to (185,135)');
  const txs = [...b2.matchAll(/transform="([^"]+)"/g)]
    .map((m) => Number(m[1].trim().split(/\s+/)[9] ?? 0)).sort((a, b) => a - b);
  assert.ok(Math.abs(txs[1] - txs[0] - 100) <= 0.5, 'Relative X gap preserved');
});

test('filterModelToPlate logic - no p_object_id single item returns unchanged', () => {
  const xml = `<build>
    <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
</build>`;
  const allItems = [...xml.matchAll(/<item\b[^>]*(?:\/>|>.*?<\/item>)/gs)].map((m) => m[0]);
  assert.equal(allItems.length, 1);
  assert.ok(!allItems.some((it) => /p:object_id="(\d+)"/.test(it)), 'No p:object_id present');
  assert.equal(filterModelToPlate(xml, 1), xml);
});

test('filterModelToPlate logic - no p_object_id multiple items selects by index and recenters XY', () => {
  const xml = `<?xml version="1.0"?>
<model>
  <resources>
    <object id="3" type="model"/>
    <object id="8" type="model"/>
    <object id="9" type="model"/>
  </resources>
  <build>
    <item objectid="3" transform="1 0 0 0 1 0 0 0 1 175 160 1.62" printable="1" />
    <item objectid="8" transform="1 0 0 0 1 0 0 0 1 1052 154 1.64" printable="1" />
    <item objectid="9" transform="1 0 0 0 1 0 0 0 1 175 -224 1.64" printable="1" />
  </build>
</model>`;
  const plate2 = filterModelToPlate(xml, 2, true);
  const buildSection1 = between(filterModelToPlate(xml, 1, true), '<build>', '</build>');
  const buildSection2 = between(plate2, '<build>', '</build>');
  const buildSection3 = between(filterModelToPlate(xml, 3, true), '<build>', '</build>');

  assert.ok(buildSection1.includes('objectid="3"'), 'Plate1 has item 3');
  assert.ok(!buildSection1.includes('objectid="8"'), 'Plate1 has no item 8');
  assert.ok(buildSection1.includes('135 135 1.62'), 'Plate1 XY re-centred');
  assert.ok(buildSection2.includes('objectid="8"'), 'Plate2 has item 8');
  assert.ok(!buildSection2.includes('objectid="3"'), 'Plate2 has no item 3');
  assert.ok(buildSection2.includes('135 135 1.64'), 'Plate2 XY re-centred');
  assert.ok(buildSection3.includes('objectid="9"'), 'Plate3 has item 9');
  assert.ok(buildSection3.includes('135 135 1.64'), 'Plate3 XY re-centred');
  assert.ok(plate2.includes('id="3"'), 'Resources: object 3');
  assert.ok(plate2.includes('id="8"'), 'Resources: object 8');
  assert.ok(plate2.includes('id="9"'), 'Resources: object 9');

  const virtualFormatXml = `<build>
    <item objectid="4" transform="1 0 0 0 1 0 0 0 1 128 128 10" printable="1"/>
    <item objectid="5" transform="1 0 0 0 1 0 0 0 1 435 128 10" printable="1"/>
    <item objectid="6" transform="1 0 0 0 1 0 0 0 1 128 -179 10" printable="1"/>
</build>`;
  const virtualBuild1 = between(filterModelToPlate(virtualFormatXml, 1, false), '<build>', '</build>');
  assert.ok(virtualBuild1.includes('objectid="4"'), 'Virtual: plate1 has item 4');
  assert.ok(!virtualBuild1.includes('objectid="5"'), 'Virtual: plate1 no item 5');
  assert.ok(!virtualBuild1.includes('objectid="6"'), 'Virtual: plate1 no item 6');
  assert.ok(virtualBuild1.includes('135 135 10'), 'Virtual: plate1 XY re-centred');
  const virtualBuild2 = between(filterModelToPlate(virtualFormatXml, 2, false), '<build>', '</build>');
  assert.ok(virtualBuild2.includes('objectid="5"'), 'Virtual: plate2 has item 5');
  assert.ok(!virtualBuild2.includes('objectid="4"'), 'Virtual: plate2 no item 4');

  const onBedXml = `<build>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 50 50 0" printable="1"/>
    <item objectid="11" transform="1 0 0 0 1 0 0 0 1 150 150 0" printable="1"/>
</build>`;
  const onBedBuild = between(filterModelToPlate(onBedXml, 1, false), '<build>', '</build>');
  assert.ok(onBedBuild.includes('objectid="10"'), 'On-bed: item 10 kept');
  assert.ok(onBedBuild.includes('objectid="11"'), 'On-bed: item 11 kept');

  // B13: no virtual positions, no config mapping — fallback keeps all items.
  const multiObjSinglePlateXml = `<build>
    <item objectid="20" transform="1 0 0 0 1 0 0 0 1 80 80 0" printable="1"/>
    <item objectid="21" transform="1 0 0 0 1 0 0 0 1 190 80 0" printable="1"/>
    <item objectid="22" transform="1 0 0 0 1 0 0 0 1 80 190 0" printable="1"/>
    <item objectid="23" transform="1 0 0 0 1 0 0 0 1 190 190 0" printable="1"/>
</build>`;
  const b13Build = between(filterModelToPlate(multiObjSinglePlateXml, 1, true), '<build>', '</build>');
  for (const id of ['20', '21', '22', '23']) assert.ok(b13Build.includes(`objectid="${id}"`), `B13: item ${id} kept`);
});

test('filterModelToPlate config-based - Sydney buttons multi-object multi-plate', () => {
  const xml = `<build>
    <item objectid="2" transform="-1 0 0 0 -1 0 0 0 1 142 116 1" printable="1"/>
    <item objectid="3" transform="-1 0 0 0 -1 0 0 0 1 208 116 1" printable="1"/>
    <item objectid="4" transform="-1 0 0 0 -1 0 0 0 1 142 203 1" printable="1"/>
    <item objectid="5" transform="-1 0 0 0 -1 0 0 0 1 208 203 1" printable="1"/>
    <item objectid="7" transform="1 0 0 0 1 0 0 0 1 475 180 1.5" printable="1"/>
    <item objectid="8" transform="1 0 0 0 1 0 0 0 1 627 186 1.5" printable="1"/>
    <item objectid="9" transform="1 0 0 0 1 0 0 0 1 477 28 1.5" printable="1"/>
    <item objectid="10" transform="1 0 0 0 1 0 0 0 1 628 31 1.5" printable="1"/>
    <item objectid="20" transform="1 0 0 0 1 0 0 0 1 84 -98 1.5" printable="1"/>
    <item objectid="21" transform="0 -1 0 1 0 0 0 0 1 290 -125 1.5" printable="1"/>
    <item objectid="22" transform="1 0 0 0 1 0 0 0 1 85 -251 1.5" printable="1"/>
    <item objectid="23" transform="-1 0 0 0 -1 0 0 0 1 268 -356 1.5" printable="1"/>
</build>`;
  const b1 = between(filterModelToPlate(xml, 1, true, new Set(['2', '3', '4', '5'])), '<build>', '</build>');
  for (const id of ['2', '3', '4', '5']) assert.ok(b1.includes(`objectid="${id}"`), `Plate1 has obj ${id}`);
  assert.ok(!b1.includes('objectid="7"'), 'Plate1 no obj 7');
  assert.ok(!b1.includes('objectid="20"'), 'Plate1 no obj 20');
  assert.ok(b1.includes('142 116 1'), 'Plate1 obj 2 XY preserved');

  const b2 = between(filterModelToPlate(xml, 2, true, new Set(['7', '8', '9', '10'])), '<build>', '</build>');
  for (const id of ['7', '8', '9', '10']) assert.ok(b2.includes(`objectid="${id}"`), `Plate2 has obj ${id}`);
  assert.ok(!b2.includes('objectid="2"'), 'Plate2 no obj 2');
  assert.ok(!b2.includes('135 135 1.5'), 'Plate2: objects must not all stack at (135,135)');
  assert.ok(b2.includes('58.5 208 1.5'), 'Plate2 obj7 group-shifted to (58.5,208)');
  assert.ok(b2.includes('210.5 214 1.5'), 'Plate2 obj8 group-shifted to (210.5,214)');
  assert.ok(b2.includes('60.5 56 1.5'), 'Plate2 obj9 group-shifted to (60.5,56)');
  assert.ok(b2.includes('211.5 59 1.5'), 'Plate2 obj10 group-shifted to (211.5,59)');

  const b3 = between(filterModelToPlate(xml, 3, true, new Set(['20', '21', '22', '23'])), '<build>', '</build>');
  for (const id of ['20', '21', '22', '23']) assert.ok(b3.includes(`objectid="${id}"`), `Plate3 has obj ${id}`);
  assert.ok(!b3.includes('objectid="2"'), 'Plate3 no obj 2');
  assert.ok(!b3.includes('135 135 1.5'), 'Plate3: objects must not all stack at (135,135)');
  assert.ok(b3.includes('32 264 1.5'), 'Plate3 obj20 group-shifted to (32,264)');
  assert.ok(b3.includes('238 237 1.5'), 'Plate3 obj21 group-shifted to (238,237)');
  assert.ok(b3.includes('33 111 1.5'), 'Plate3 obj22 group-shifted to (33,111)');
  assert.ok(b3.includes('216 6 1.5'), 'Plate3 obj23 group-shifted to (216,6)');
});

test('stripNonPrintableBuildItems - removes printable=0 items only from build', () => {
  const xml = `<?xml version="1.0"?>
<model>
  <resources>
    <object id="2" type="model"/>
    <object id="4" type="model"/>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 213 194 24" printable="0"/>
    <item objectid="4" transform="1 0 0 0 1 0 0 0 1 135 119 24" printable="1"/>
  </build>
</model>`;
  const result = stripNonPrintableBuildItems(xml);
  const buildSection = between(result, '<build>', '</build>');
  assert.ok(buildSection.includes('objectid="4"'), 'printable=1 item kept');
  assert.ok(!buildSection.includes('objectid="2"'), 'printable=0 item removed');
  assert.ok(result.includes('<object id="2"'), 'Resources: object 2 intact');
  assert.ok(result.includes('<object id="4"'), 'Resources: object 4 intact');
});

test('component file size guard - large files skip restructuring', () => {
  const threshold = 50_000_000;
  assert.ok(3 * 2_000_000 <= threshold, '6MB total should be safe to inline');
  assert.ok(20_000_000 <= threshold, '20MB total should be safe to inline (multi-color models)');
  assert.ok(!(7 * 10_000_000 <= threshold), '70MB total should skip inlining');
});

test('buildSlic3rModelConfig logic - per-part volumes when face counts known', () => {
  // The real builder writes ObjectParts.defaultExtruder as the object extruder; the
  // Kotlin simulation used max(part extruders), so defaultExtruder is set to that here.
  const objectParts = (id, parts) => new Map([[id, {
    defaultExtruder: Math.max(...parts.map((p) => p.extruder)),
    parts: parts.map(({ faceCount, extruder }) => ({ faceCount, extruder, meshObjectId: '', subtype: 'normal_part' })),
  }]]);
  const config = _internal.buildSlic3rModelConfig(objectParts('5', [{ faceCount: 500, extruder: 1 }, { faceCount: 300, extruder: 2 }]));
  assert.ok(config.includes('firstid="0" lastid="499"'), 'E1 volume starts at 0');
  assert.ok(config.includes('value="1"'), 'E1 volume uses extruder 1');
  assert.ok(config.includes('firstid="500" lastid="799"'), 'E2 volume starts at 500');
  assert.ok(config.includes('value="2"'), 'E2 volume uses extruder 2');
  assert.ok(config.includes('key="extruder" value="2"'), 'Object extruder is max');

  const singleConfig = _internal.buildSlic3rModelConfig(objectParts('3', [{ faceCount: 400, extruder: 1 }]));
  assert.ok(singleConfig.includes('firstid="0" lastid="399"'), 'Single volume from 0');

  const zeroConfig = _internal.buildSlic3rModelConfig(objectParts('7', [{ faceCount: 0, extruder: 1 }, { faceCount: 0, extruder: 2 }]));
  assert.ok(zeroConfig.includes('firstid="0"'), 'Zero face count falls back');
});

test('stripAssembleSection - removes assemble block from model_settings config', () => {
  const xml = `<?xml version="1.0"?>
<config>
  <object id="3">
    <metadata type="object" key="name" value="Object"/>
  </object>
  <assemble>
    <assemble_item object_id="3" instance_id="0" transform="1 0 0 0 1 0 0 0 1 135 135 0"/>
    <assemble_item object_id="8" instance_id="0" transform="1 0 0 0 1 0 0 0 1 1052 154 0"/>
    <assemble_item object_id="20" instance_id="0" transform="1 0 0 0 1 0 0 0 1 200 200 0"/>
  </assemble>
</config>`;
  const result = stripAssembleSection(xml);
  assert.ok(!result.includes('<assemble>'), 'assemble block removed');
  assert.ok(!result.includes('assemble_item'), 'assemble_item removed');
  assert.ok(result.includes('id="3"'), 'object id 3 still present');
  assert.ok(result.includes('key="name"'), 'metadata still present');
});

test('stripAssembleSection - no-op when no assemble block present', () => {
  const xml = `<?xml version="1.0"?>
<config>
  <object id="5">
    <metadata type="object" key="name" value="Cube"/>
  </object>
</config>`;
  assert.equal(stripAssembleSection(xml), xml, 'XML unchanged when no assemble block');
});

test('stripAssembleSection - preserves content before and after assemble block', () => {
  const xml = `<config>
  <object id="1"/>
  <assemble>
    <assemble_item object_id="1" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
    <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 1 1 1"/>
  </assemble>
  <object id="99"/>
</config>`;
  const result = stripAssembleSection(xml);
  assert.ok(!result.includes('<assemble>'), 'assemble removed');
  assert.ok(result.includes('id="1"'), 'object 1 before block intact');
  assert.ok(result.includes('id="99"'), 'object 99 after block intact');
});

test('clampScalarPosition - clamps list values not just scalars', () => {
  // b39: wipe_tower_y written as a per-extruder list must be clamped element-wise.
  const config = { wipe_tower_y: ['240.000', '240.000'] };
  clampScalarPosition(config, 'wipe_tower_y', 39, 231);
  const clamped = config.wipe_tower_y;
  assert.equal(clamped[0], '231.000', 'Both list elements clamped to maxPos');
  assert.equal(clamped[1], '231.000', 'Both list elements clamped to maxPos');
});

test('clampScalarPosition - scalar still clamped after list fix', () => {
  const config = { wipe_tower_y: '240.000' };
  clampScalarPosition(config, 'wipe_tower_y', 39, 231);
  assert.equal(config.wipe_tower_y, '231.000', 'Scalar value clamped');
});

test('filterCustomGcodePerLayer returns blank when target plate not in xml', () => {
  const xml = `<?xml version="1.0"?>
<custom_gcodes_per_layer>
  <plate>
    <plate_info id="1"/>
    <layer top_z="1.6" type="2" extruder="2" color="#AA0000"/>
  </plate>
  <plate>
    <plate_info id="2"/>
    <layer top_z="3.2" type="2" extruder="3" color="#00AA00"/>
  </plate>
</custom_gcodes_per_layer>`;
  assert.equal(filterCustomGcodePerLayer(xml, 99), '', 'missing target plate must return blank (fail-closed)');
});

test('filterCustomGcodePerLayer tolerates attribute-order and whitespace variants', () => {
  const variants = [
    '<plate_info id="1"/>',
    '<plate_info id="1" />',
    '<plate_info  id="1"/>',
    '<plate_info id="1" name="Plate 1"/>',
    '<plate_info name="Plate 1" id="1"/>',
  ];
  for (const variant of variants) {
    const xml = `<?xml version="1.0"?>
<custom_gcodes_per_layer>
  <plate>
    ${variant}
    <layer top_z="1.6" type="2" extruder="2" color="#AA0000"/>
  </plate>
  <plate>
    <plate_info id="2"/>
    <layer top_z="3.2" type="2" extruder="3" color="#00AA00"/>
  </plate>
</custom_gcodes_per_layer>`;
    const result = filterCustomGcodePerLayer(xml, 1);
    assert.ok(result.trim().length > 0, `variant '${variant}' should produce non-blank filtered output`);
    assert.ok(result.includes('top_z="1.6"'), `variant '${variant}' must keep plate 1's layer (top_z=1.6)`);
    assert.ok(!result.includes('top_z="3.2"'), `variant '${variant}' must NOT keep plate 2's layer (top_z=3.2)`);
  }
});
