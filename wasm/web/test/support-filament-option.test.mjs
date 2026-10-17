// Mirrors app/src/test/java/com/u1/slicer/ui/SupportFilamentOptionTest.kt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';
import { buildSupportFilamentOptions } from '../settings-schema.mjs';

test('h2c mapping shows physical slots but writes mapped file filament values', () => {
  const options = buildSupportFilamentOptions({
    extruderPresets: [
      extruderPreset({ index: 0, color: '#0086D6', materialType: 'PLA' }),
      extruderPreset({ index: 1, color: '#FFFF00', materialType: 'PLA' }),
      extruderPreset({ index: 2, color: '#FFFFFF', materialType: 'PETG' }),
      extruderPreset({ index: 3, color: '#6A00D5', materialType: 'PLA' }),
    ],
    colorMapping: [0, 1, 2, 3, 0, 1, 2],
    filamentCount: 7,
  });
  assert.equal(options[2].configValue, 3);
  assert.ok(options[2].label.includes('E3'));
  assert.ok(options[2].label.includes('PETG'));
  assert.equal(options[3].configValue, 4);
});
test('missing mapped slot falls back to synthetic slot index', () => {
  const options = buildSupportFilamentOptions({ extruderPresets: [], colorMapping: [0, 1], filamentCount: 2 });
  assert.equal(options[3].configValue, 4);
});
test('sparse mapping gives unmapped physical slot synthetic value instead of another slot value', () => {
  const options = buildSupportFilamentOptions({ extruderPresets: [], colorMapping: [0, 2], filamentCount: 2 });
  assert.equal(options[0].configValue, 1);
  assert.equal(options[1].configValue, 3);
  assert.equal(options[2].configValue, 2);
});
test('stl without mapping can still choose E4 support filament', () => {
  const options = buildSupportFilamentOptions({
    extruderPresets: [extruderPreset({ index: 3, materialType: 'PETG' })], colorMapping: null, filamentCount: 1,
  });
  assert.equal(options[3].configValue, 4);
  assert.ok(options[3].label.includes('E4'));
  assert.ok(options[3].label.includes('PETG'));
});
test('non identity mapping translates physical slots to first matching file filament', () => {
  const options = buildSupportFilamentOptions({ extruderPresets: [], colorMapping: [2, 0, 1], filamentCount: 3 });
  assert.equal(options[0].configValue, 2);
  assert.equal(options[1].configValue, 3);
  assert.equal(options[2].configValue, 1);
});
