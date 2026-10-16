// Mirrors app/src/test/java/com/u1/slicer/bambu/PrusaSlicerCanonicalListTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FilamentSource, buildFromPrusaConfig, parsePrusaIni } from '../pipeline/canonical-filament-list.mjs';

// Kotlin trimIndent() equivalent for the multi-line fixtures.
const trimIndent = (s) => {
  const lines = s.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
};

test('parsePrusaIni strips leading semicolon and whitespace', () => {
  const map = parsePrusaIni(trimIndent(`
    ; extruder_colour = #000000;#DB5182;#008000
    ; filament_type = PLA;PETG;PLA
    ; foo = bar
  `));
  assert.equal(map.get('extruder_colour'), '#000000;#DB5182;#008000');
  assert.equal(map.get('filament_type'), 'PLA;PETG;PLA');
  assert.equal(map.get('foo'), 'bar');
});

test('parsePrusaIni handles uncommented lines too', () => {
  const map = parsePrusaIni(trimIndent(`
    extruder_colour = #FF0000;#00FF00
    ; filament_colour = #FFFFFF
  `));
  assert.equal(map.get('extruder_colour'), '#FF0000;#00FF00');
  assert.equal(map.get('filament_colour'), '#FFFFFF');
});

test('parsePrusaIni ignores empty and malformed lines', () => {
  const map = parsePrusaIni(trimIndent(`
    ; valid = yes
    ;
    no equals here
    ; = empty key
  `));
  assert.equal(map.size, 1);
  assert.equal(map.get('valid'), 'yes');
});

test('buildFromPrusaConfig prefers extruder_colour over filament_colour', () => {
  const list = buildFromPrusaConfig(trimIndent(`
    ; extruder_colour = #000000;#DB5182;#008000;#00FF00;#FBEB7D
    ; filament_colour = #FF8000;#FF8000;#FF8000;#FF8000;#FF8000
    ; filament_type = PLA;PETG;PLA;PLA;PLA
  `));
  assert.ok(list);
  assert.equal(list.size, 5);
  assert.deepEqual(list.filaments.map((e) => e.color), ['#000000', '#DB5182', '#008000', '#00FF00', '#FBEB7D']);
  assert.equal(list.filaments[0].materialType, 'PLA');
  assert.equal(list.filaments[1].materialType, 'PETG');
  for (const e of list.filaments) assert.equal(e.source, FilamentSource.FILE_COLOUR);
});

test('buildFromPrusaConfig falls back to filament_colour when extruder_colour absent', () => {
  const list = buildFromPrusaConfig('; filament_colour = #FF0000;#00FF00');
  assert.ok(list);
  assert.equal(list.size, 2);
  assert.equal(list.filaments[0].color, '#FF0000');
  assert.equal(list.filaments[1].color, '#00FF00');
});

test('buildFromPrusaConfig truncates 8-char hex to 7-char', () => {
  const list = buildFromPrusaConfig('; extruder_colour = #FF0000FF;#00FF00FF');
  assert.equal(list.filaments[0].color, '#FF0000');
  assert.equal(list.filaments[1].color, '#00FF00');
});

test('buildFromPrusaConfig returns null when no colour key present', () => {
  assert.equal(buildFromPrusaConfig(trimIndent(`
    ; layer_height = 0.2
    ; nozzle_diameter = 0.4
  `)), null);
});

test('buildFromPrusaConfig returns null when colour value is blank', () => {
  assert.equal(buildFromPrusaConfig('; extruder_colour = '), null);
});

test('buildFromPrusaConfig fileIndex matches order', () => {
  buildFromPrusaConfig('; extruder_colour = #FF0000;#00FF00;#0000FF').filaments.forEach((e, i) => assert.equal(e.fileIndex, i));
});

test('buildFromPrusaConfig filaments are FILE_COLOUR', () => {
  assert.ok(buildFromPrusaConfig('; extruder_colour = #FF0000;#00FF00').filaments.every((e) => e.source === FilamentSource.FILE_COLOUR));
});
