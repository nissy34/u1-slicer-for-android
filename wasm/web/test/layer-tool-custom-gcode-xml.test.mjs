// Mirrors app/src/test/java/com/u1/slicer/bambu/LayerToolCustomGcodeXmlTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLayerToolCustomGcodeXml, parseLayerToolCustomGcodeXmlPerPlate,
} from '../pipeline/layer-tool-custom-gcode-xml.mjs';

test('type 1 layers contribute colours and extruders like type 2', () => {
  const xml = `<custom_gcodes_per_layer>
    <layer top_z="0.4" type="1" extruder="2" color="#F4D976" extra="" gcode="M601"/>
    <layer top_z="1.6" type="2" extruder="3" color="#368CF9" extra="" gcode="tool_change"/>
</custom_gcodes_per_layer>`;
  const info = parseLayerToolCustomGcodeXml(xml);
  assert.equal(info.hasToolChanges, true);
  assert.deepEqual(info.colors, ['#F4D976', '#368CF9']);
  assert.deepEqual(info.extruders, new Set([2, 3]));
});

test('parseLayerToolCustomGcodeXmlPerPlate returns per-plate info keyed by plate id', () => {
  const xml = `<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
<layer top_z="9.2" type="2" extruder="2" color="#2323F7" extra="" gcode="tool_change"/>
<mode value="MultiAsSingle"/>
</plate>
<plate>
<plate_info id="2"/>
<layer top_z="1.4" type="2" extruder="2" color="#F4D976" extra="" gcode="tool_change"/>
<mode value="MultiAsSingle"/>
</plate>
<plate>
<plate_info id="3"/>
<mode value="MultiAsSingle"/>
</plate>
</custom_gcodes_per_layer>`;
  const perPlate = parseLayerToolCustomGcodeXmlPerPlate(xml);

  // Plate 1: tool change with off-palette colour
  assert.equal(perPlate.get(1).hasToolChanges, true);
  assert.deepEqual(perPlate.get(1).colors, ['#2323F7']);
  assert.deepEqual(perPlate.get(1).extruders, new Set([2]));

  // Plate 2: tool change with real palette colour
  assert.equal(perPlate.get(2).hasToolChanges, true);
  assert.deepEqual(perPlate.get(2).colors, ['#F4D976']);
  assert.deepEqual(perPlate.get(2).extruders, new Set([2]));

  // Plate 3: no tool changes
  assert.equal(perPlate.get(3).hasToolChanges, false);
  assert.equal(perPlate.get(3).colors.length, 0);
  assert.equal(perPlate.get(3).extruders.size, 0);
});

test('type 2 only still parses', () => {
  const xml = `<custom_gcodes_per_layer>
    <layer top_z="0.4" type="2" extruder="2" color="#F4D976" extra="" gcode="tool_change"/>
</custom_gcodes_per_layer>`;
  const info = parseLayerToolCustomGcodeXml(xml);
  assert.equal(info.hasToolChanges, true);
  assert.deepEqual(info.colors, ['#F4D976']);
  assert.deepEqual(info.extruders, new Set([2]));
});
