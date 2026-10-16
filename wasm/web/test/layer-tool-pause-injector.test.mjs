// Mirrors app/src/test/java/com/u1/slicer/gcode/LayerToolPauseInjectorTest.kt case by case.
// The JS injectFrom3mf takes (gcodeText, 3mfBytes, ...) and returns the new G-code text
// or null, so `assertTrue(inject(...)); gcode.readText()` becomes `text = inject(...)`
// asserted non-null, and `assertFalse(inject(...))` becomes an assert on null.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LayerToolPauseInjector } from '../pipeline/layer-tool-pause-injector.mjs';
import { writeZip, DEFLATED } from '../pipeline/zip.mjs';

const plateDataOf = (plateJson) => (plateIndex) => (plateIndex === 0 ? plateJson : null);
const plateJsonForColorChange = (topZ, extruder, color = '#F4D976') =>
  `{"customGcode":[{"printZ":${topZ},"type":"ColorChange","extruder":${extruder},"color":"${color}"}]}`;
const plateJsonForToolChange = (topZ, extruder, color = '#F4D976') =>
  `{"customGcode":[{"printZ":${topZ},"type":"ToolChange","extruder":${extruder},"color":"${color}"}]}`;
const model = (files) => writeZip(Object.entries(files).map(([name, data]) => ({ name, data, method: DEFLATED })));
const layerXml = (...layers) => `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
  <plate>
    <plate_info id="1"/>
${layers.map((l) => `    ${l}`).join('\n')}
  </plate>
</custom_gcodes_per_layer>`;
const inject = (gcode, m, json) => LayerToolPauseInjector.injectFrom3mf(gcode, m, 0, plateDataOf(json), { modelName: 'sample.3mf' });

test('injectFrom3mf inserts pause before first layer above target top_z', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="1.6" type="1" extruder="2" color="#F4D976" extra="" gcode="M601"/>', '<mode value="SingleExtruder"/>'),
    'Metadata/project_settings.config': '{"machine_pause_gcode":"M400 U1","nozzle_temperature":["220","230","220","220","220"]}',
  });
  const text = inject(';LAYER_CHANGE\n;Z:1.5\nG1 X1 Y1\n;LAYER_CHANGE\n;Z:1.7\nG1 X2 Y2\n', m, plateJsonForColorChange(1.6, 2));
  assert.notEqual(text, null);
  assert.ok(text.includes('; PAUSE_PRINT\nM400 U1\n'));
  assert.ok(text.includes('T1'), 'Bambu extruder 2 must map to T1 after pause');
  assert.ok(text.includes('M109 S230 T1'), 'nozzle_temperature[1] should follow T1 for filament 2');
  assert.ok(text.includes(';LAYER_CHANGE\n;Z:1.7'));
});

test('injectFrom3mf preserves nozzle_temperature array indexes with nil entries', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="1.6" type="1" extruder="2" color="#F4D976" extra="" gcode="M601"/>', '<mode value="SingleExtruder"/>'),
    'Metadata/project_settings.config': '{"machine_pause_gcode":"M400 U1","nozzle_temperature":["nil","220","230"]}',
  });
  const text = inject(';LAYER_CHANGE\n;Z:1.5\nG1 X1 Y1\n;LAYER_CHANGE\n;Z:1.7\nG1 X2 Y2\n', m, plateJsonForColorChange(1.6, 2));
  assert.notEqual(text, null);
  assert.ok(text.includes('; PAUSE_PRINT\nM400 U1\n'));
  assert.ok(text.includes('T1'));
  assert.ok(text.includes('M109 S220'), 'must use nozzle_temperature[1]=220 even when index 0 is nil');
  assert.ok(!text.includes('M109 S230'), 'must not use nozzle_temperature[2]=230 due to shifted indexes');
});

test('injectFrom3mf does nothing when no custom layer metadata exists', () => {
  const m = model({ 'Metadata/project_settings.config': '{"machine_pause_gcode":"M400 U1"}' });
  assert.equal(inject(';LAYER_CHANGE\n;Z:0.2\n', m, null), null);
});

test('injectFrom3mf falls back to default pause command when source has no project settings', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="0.4" type="2" extruder="2" color="#F4D976" extra="" gcode="tool_change"/>'),
  });
  const out = inject('M109 S215 T1\n;LAYER_CHANGE\n;Z:0.6\nG1 X2 Y2\n', m, plateJsonForToolChange(0.4, 2));
  assert.notEqual(out, null);
  assert.ok(out.includes('; PAUSE_PRINT\nM400 U1\n'));
  assert.ok(out.includes('T1'));
  assert.ok(out.includes('M109 S215 T1'), 'Fallback should reuse tool temp found in G-code prologue');
  assert.ok(out.includes(';LAYER_CHANGE'));
});

const extruder3Model = () => model({
  'Metadata/custom_gcode_per_layer.xml': layerXml(
    '<layer top_z="1.6" type="1" extruder="3" color="#AABBCC" extra="" gcode="tool_change"/>'),
});

test('injectFrom3mf uses gcode temp fallback when project settings missing', () => {
  const text = inject('M109 S225 T2\n;LAYER_CHANGE\n;Z:1.7\nG1 X10 Y10\n', extruder3Model(), plateJsonForColorChange(1.6, 3));
  assert.notEqual(text, null);
  assert.ok(text.includes('; PAUSE_PRINT\nM400 U1\n'));
  assert.ok(text.includes('T2'));
  assert.ok(text.includes('M109 S225 T2'), 'Missing project settings should still heat selected tool');
});

test('injectFrom3mf uses current tool for M109 without T when project settings missing', () => {
  const text = inject('T2\nM109 S225\n;LAYER_CHANGE\n;Z:1.7\nG1 X10 Y10\n', extruder3Model(), plateJsonForColorChange(1.6, 3));
  assert.notEqual(text, null);
  assert.ok(text.includes('; PAUSE_PRINT\nM400 U1\n'));
  assert.ok(text.includes('T2'));
  const count = [...text.matchAll(/\bM109\s+S225(?:\s+T2)?\b/g)].length;
  assert.equal(count, 2);
});

test('injectFrom3mf falls back to SM_PRINT_START_LINE target temp', () => {
  const text = inject(
    ';LAYER_CHANGE\n;Z:1.5\nG1 X0 Y0\nSM_PRINT_START_LINE INDEX=2 TARGET_TEMP=220\n;LAYER_CHANGE\n;Z:1.7\nG1 X10 Y10\n',
    extruder3Model(), plateJsonForColorChange(1.6, 3));
  assert.notEqual(text, null);
  assert.ok(text.includes('T2'));
  assert.ok(text.includes('M109 S220 T2'), 'SM target temp fallback should provide explicit wait-temp for switched tool');
});

test('injectFrom3mf falls back to last seen M109 temp when tool-specific missing', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="1.6" type="1" extruder="2" color="#AABBCC" extra="" gcode="tool_change"/>'),
  });
  const text = inject('M109 S220 T2\n;LAYER_CHANGE\n;Z:1.7\nG1 X10 Y10\n', m, plateJsonForColorChange(1.6, 2));
  assert.notEqual(text, null);
  assert.ok(text.includes('T1'));
  assert.ok(text.includes('M109 S220 T1'), 'If tool-specific lookup fails, injector should still set switched tool temp');
});

test('injectFrom3mf skips when native CP toolchange workflow already exists', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="1.6" type="1" extruder="2" color="#AABBCC" extra="" gcode="tool_change"/>'),
    'Metadata/project_settings.config': '{"machine_pause_gcode":"M400 U1","nozzle_temperature":["220","220","220","220"]}',
  });
  const gcode = '; CP TOOLCHANGE START\nT1\n; CP TOOLCHANGE END\n;LAYER_CHANGE\n;Z:1.7\nG1 X10 Y10\n';
  const result = inject(gcode, m, plateJsonForColorChange(1.6, 2));
  assert.equal(result, null);
  // The input text is untouched (JS strings are immutable; the Kotlin file stays unchanged).
  assert.ok(!gcode.includes('; PAUSE_PRINT'));
});

test('extractPauseTargetsFromNativeJson accepts ColorChange and ToolChange and drops other types', () => {
  const json = `{
  "customGcode": [
    {"printZ": 3.2, "type": "ColorChange", "extruder": 2, "color": "#AA0000"},
    {"printZ": 1.6, "type": "ToolChange",  "extruder": 3, "color": "#00AA00"},
    {"printZ": 2.0, "type": "PausePrint",  "extruder": 1, "color": "#000000"},
    {"printZ": 2.5, "type": "Template",    "extruder": 1, "color": ""},
    {"printZ": 4.0, "type": "Custom",      "extruder": 1, "color": ""},
    {"printZ": 5.0, "type": "1",           "extruder": 1, "color": ""},
    {"printZ": 6.0, "type": "2",           "extruder": 1, "color": ""}
  ]
}`;
  const targets = LayerToolPauseInjector.extractPauseTargetsFromNativeJsonForTest(json);
  assert.deepEqual(
    targets.map((t) => [t.topZ, t.extruderBambu]),
    [[Math.fround(1.6), 3], [Math.fround(3.2), 2]],
    'only ColorChange and ToolChange rows become targets, sorted ascending by topZ',
  );
});

test('extractPauseTargetsFromNativeJson tolerates empty, missing, and malformed input', () => {
  const f = LayerToolPauseInjector.extractPauseTargetsFromNativeJsonForTest;
  assert.deepEqual(f('{"customGcode": []}'), [], 'empty customGcode array → empty list');
  assert.deepEqual(f('{"plateIndex": 0}'), [], 'missing customGcode key → empty list');
  assert.deepEqual(f('not-a-json'), [], 'malformed JSON → empty list (never throws)');
});

// ---- B127: canonical fileIdx >= 4 must NOT be dropped ----

test('b127 injector writes T-line for toolIndex 4 5 6 (7-filament Hueforge)', () => {
  const m = model({
    'Metadata/custom_gcode_per_layer.xml': layerXml(
      '<layer top_z="1.0" type="2" extruder="5" color="" extra="" gcode=""/>',
      '<layer top_z="2.0" type="2" extruder="6" color="" extra="" gcode=""/>',
      '<layer top_z="3.0" type="2" extruder="7" color="" extra="" gcode=""/>'),
    'Metadata/project_settings.config':
      '{"machine_pause_gcode":"M400 U1","nozzle_temperature":["220","220","220","220","220","220","220"]}',
  });
  const gcode = ';LAYER_CHANGE\n;Z:0.5\nG1 X0 Y0\n;LAYER_CHANGE\n;Z:1.2\nG1 X10 Y10\n' +
    ';LAYER_CHANGE\n;Z:2.2\nG1 X20 Y20\n;LAYER_CHANGE\n;Z:3.2\nG1 X30 Y30\n';
  const plateJson = `{"customGcode":[
    {"printZ":1.0,"type":"ColorChange","extruder":5,"color":""},
    {"printZ":2.0,"type":"ColorChange","extruder":6,"color":""},
    {"printZ":3.0,"type":"ColorChange","extruder":7,"color":""}
  ]}`;
  const result = LayerToolPauseInjector.injectFrom3mf(gcode, m, 0, plateDataOf(plateJson), { modelName: 'hueforge7.3mf' });
  assert.notEqual(result, null, 'B127: injector must inject pauses for 7-filament Hueforge');
  assert.ok(/^T4$/m.test(result), 'B127: T4 line missing');
  assert.ok(/^T5$/m.test(result), 'B127: T5 line missing');
  assert.ok(/^T6$/m.test(result), 'B127: T6 line missing');
  assert.equal(result.split('\n').filter((l) => l.trim() === '; PAUSE_PRINT').length, 3);
  assert.ok(!/^T0$/m.test(result), 'T0 should be skipped by layer-tool injector (starting tool)');
});
