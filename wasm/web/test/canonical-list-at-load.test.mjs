// JS-only smoke tests for pipeline/canonical-list-at-load.mjs (the Kotlin
// file-reading entry points are only covered by instrumented tests on-device).
// Also covers the ViewModel-state-free buildProfileOverrides and the
// ExtruderPreset / filament-library helpers in profile-overrides.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeZip } from '../pipeline/zip.mjs';
import { bambuCanonicalList, canonicalListAtLoad, prusaSlicerCanonicalList, collectPaintSpecs } from '../pipeline/canonical-list-at-load.mjs';
import { FilamentSource, bambuFileColourList, stlCanonicalList } from '../pipeline/canonical-filament-list.mjs';
import { buildProfileOverrides, buildFilamentLibraryArrays, buildFilamentLibrarySettings } from '../pipeline/profile-overrides.mjs';
import { slicingOverrides } from '../pipeline/slicing-overrides.mjs';
import { sliceConfig } from '../pipeline/slice-config.mjs';
import { defaultExtruderPresets, extruderPreset, parseExtruderPresets, serializeExtruderPresets } from '../pipeline/extruder-preset.mjs';

const model = '<mesh><triangle v1="0" paint_color="4"/>\n<triangle mmu_segmentation="8C"/><triangle paint_color=""/></mesh>';

test('bambuCanonicalList folds paint states and layer-tool entries into the FILE_COLOUR list', () => {
  const bytes = writeZip([
    { name: 'Metadata/project_settings.config', data: '{"filament_colour":["#FF0000","#00FF00"],"filament_type":["PLA","PETG"]}' },
    { name: '3D/Objects/object_1.model', data: model },
  ]);
  const list = bambuCanonicalList(bytes);
  assert.equal(list.size, 11); // "8C" -> state 11 (B95)
  assert.equal(list.filaments[1].materialType, 'PETG');
  assert.equal(list.filaments[10].source, FilamentSource.PAINT_DERIVED);
  assert.deepEqual([...list.paintStateMap.keys()].sort((a, b) => a - b), [1, 11]);
  assert.equal(bambuFileColourList(bytes).size, 2);
  assert.equal(canonicalListAtLoad(bytes, 'X.3MF').size, 11);
  assert.equal(canonicalListAtLoad(bytes, 'x.stl'), null);
});

test('bambuCanonicalList drops virtual mix states above full_spectrum_physical_count and merges layer tools', () => {
  const bytes = writeZip([
    { name: 'Metadata/project_settings.config', data: '{"filament_colour":["#FF0000","#00FF00"],"full_spectrum_physical_count":"2"}' },
    { name: '3D/3dmodel.model', data: model },
    { name: 'Metadata/custom_gcode_per_layer.xml', data: '<layer top_z="1" type="2" extruder="4" color="#0000FFFF"/>' },
  ]);
  const list = bambuCanonicalList(bytes);
  assert.equal(list.size, 4);
  assert.equal(list.filaments[2].color, '#808080');
  assert.equal(list.filaments[3].color, '#0000FF');
  assert.equal(list.filaments[3].source, FilamentSource.LAYER_TOOL);
});

test('prusaSlicerCanonicalList reads Slic3r_PE.config and returns null for non-3MF bytes', () => {
  const bytes = writeZip([
    { name: 'Metadata/Slic3r_PE.config', data: '; extruder_colour = #000000;#DB5182\n; filament_type = PLA;PETG\n' },
    { name: '3D/3dmodel.model', data: '<t slic3rpe:mmu_segmentation="8"/>' },
  ]);
  const list = prusaSlicerCanonicalList(bytes);
  assert.equal(list.size, 2);
  assert.equal(list.paintStateMap.get(2), 1);
  assert.equal(bambuCanonicalList(bytes), null);
  assert.equal(canonicalListAtLoad(bytes, 'a.3mf').size, 2);
  assert.equal(bambuCanonicalList(new Uint8Array([1, 2, 3])), null);
});

test('collectPaintSpecs scans either attribute in file order and skips blanks', () => {
  const specs = [];
  collectPaintSpecs(new TextEncoder().encode('<a mmu_segmentation="C"/><b paint_color=" "/><c paint_color="4"/><d paint_color="9'), (s) => specs.push(s));
  assert.deepEqual(specs, ['C', '4']);
});

test('buildProfileOverrides (pure) uses canonical types/temps and colour overrides', () => {
  const canonical = { ...stlCanonicalList('#112233', 'PLA') };
  const presets = defaultExtruderPresets();
  const r = buildProfileOverrides({
    cfg: sliceConfig(), overrides: slicingOverrides(), slotCount: 1, usedSlots: [0], canonical: stlCanonicalList('#112233', 'PLA'),
    presets, filamentOverrides: new Map([[0, { color: '#ABCDEF', materialType: 'PETG' }]]), colorMapping: [0],
  });
  assert.ok(canonical);
  assert.deepEqual(r.filament_type, ['PETG']);
  assert.deepEqual(r.nozzle_temperature, ['235']);
  assert.deepEqual(r.filament_colour, ['#ABCDEF']);
});

test('buildProfileOverrides (pure) non-canonical STL applies the fileIndex 0 override (B117) to the used slot', () => {
  const presets = [0, 1, 2, 3].map((i) => extruderPreset({ index: i, materialType: i === 2 ? 'ABS' : 'PLA' }));
  const r = buildProfileOverrides({
    cfg: sliceConfig(), overrides: slicingOverrides(), slotCount: 1, usedSlots: [2], presets,
    filamentOverrides: { 0: { materialType: 'PETG' } },
  });
  assert.deepEqual(r.filament_type, ['PETG']);
  assert.deepEqual(r.nozzle_temperature, ['235']);
  assert.ok(!Object.hasOwn(r, 'filament_colour'));
  const plain = buildProfileOverrides({ cfg: sliceConfig(), overrides: slicingOverrides(), slotCount: 1, usedSlots: [2], presets });
  assert.deepEqual(plain.filament_type, ['ABS']);
  assert.deepEqual(plain.nozzle_temperature, ['270']);
});

test('filament library arrays/settings forward-back-fill per slot', () => {
  const presets = [extruderPreset({ index: 0 }), extruderPreset({ index: 1, filamentProfileId: 5 })];
  const filaments = [{ id: 5, nozzleTemp: 230, flowRatio: 0.95, fanMaxSpeed: 80, enablePressureAdvance: true }];
  const arrays = buildFilamentLibraryArrays(2, null, presets, filaments);
  assert.deepEqual(arrays.flowRatios, [Math.fround(0.95), Math.fround(0.95)]);
  assert.deepEqual(arrays.fanMaxSpeeds, [80, 80]);
  assert.deepEqual(arrays.enablePressureAdvance, [1, 1]);
  assert.deepEqual(arrays.costs, []);
  const settings = buildFilamentLibrarySettings(2, null, presets, filaments);
  assert.deepEqual(Object.keys(settings), ['filament_flow_ratio', 'fan_max_speed', 'enable_pressure_advance']);
  assert.deepEqual(settings.filament_flow_ratio, ['0.95', '0.95']);
});

test('extruder presets serialize / parse like the DataStore JSON', () => {
  const presets = defaultExtruderPresets();
  assert.deepEqual(presets.map((p) => p.color), ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF']);
  const json = serializeExtruderPresets([{ ...presets[1], filamentProfileId: 3 }]);
  assert.equal(json, '[{"index":1,"color":"#00FF00","materialType":"PLA","filamentProfileId":3}]');
  const parsed = parseExtruderPresets(json);
  assert.deepEqual(parsed.map((p) => [p.index, p.color, p.filamentProfileId]),
    [[0, '#FF0000', null], [1, '#00FF00', 3], [2, '#FF0000', null], [3, '#FF0000', null]]);
  assert.deepEqual(parseExtruderPresets('garbage'), defaultExtruderPresets());
  assert.deepEqual(parseExtruderPresets(''), defaultExtruderPresets());
});
