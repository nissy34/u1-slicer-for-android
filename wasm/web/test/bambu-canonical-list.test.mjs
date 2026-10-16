// Mirrors app/src/test/java/com/u1/slicer/bambu/BambuCanonicalListTest.kt case by case.
// LayerToolCustomGcodeXmlInfo -> { hasToolChanges, colors, extruders: Set }.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FilamentSource, buildFromProjectSettings, canonicalFilamentList as CFL, extractPaintSpecs, filamentEntry as FE,
  mergeLayerToolData, mergePaintStates, parseLayerToolColourPairs, readFullSpectrumPhysicalCount,
} from '../pipeline/canonical-filament-list.mjs';

const { FILE_COLOUR, PAINT_DERIVED, LAYER_TOOL } = FilamentSource;
const hex6 = (n) => `#${n.toString(16).toUpperCase().padStart(6, '0')}`;
const trimIndent = (s) => {
  const lines = s.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
};
const info = (hasToolChanges, colors, extruders) => ({ hasToolChanges, colors, extruders: new Set(extruders) });

test('single-colour project settings produces one FILE_COLOUR entry', () => {
  const list = buildFromProjectSettings(`{
    "filament_colour": ["#A6A9AA"],
    "filament_type":   ["PLA"],
    "filament_settings_id": ["Bambu PLA Basic @BBL X1C"]
  }`);
  assert.ok(list);
  assert.equal(list.size, 1);
  assert.equal(list.isMultiColour, false);
  const only = list.filaments[0];
  assert.equal(only.fileIndex, 0);
  assert.equal(only.color, '#A6A9AA');
  assert.equal(only.materialType, 'PLA');
  assert.equal(only.source, FILE_COLOUR);
  assert.equal(list.paintStateMap.size, 0);
});

test('multi-colour project settings produces N FILE_COLOUR entries in order', () => {
  const list = buildFromProjectSettings(`{
    "filament_colour": ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"],
    "filament_type":   ["PLA",     "PETG",    "PLA",     "PLA"]
  }`);
  assert.ok(list);
  assert.equal(list.size, 4);
  assert.ok(list.isMultiColour);
  assert.equal(list.filaments[0].color, '#FF0000');
  assert.equal(list.filaments[0].materialType, 'PLA');
  assert.equal(list.filaments[1].color, '#00FF00');
  assert.equal(list.filaments[1].materialType, 'PETG');
  assert.equal(list.filaments[2].color, '#0000FF');
  assert.equal(list.filaments[3].color, '#FFFFFF');
  list.filaments.forEach((e, i) => {
    assert.equal(e.fileIndex, i);
    assert.equal(e.source, FILE_COLOUR);
  });
});

test('colour with alpha channel truncates to 7-char hex', () => {
  const list = buildFromProjectSettings('{ "filament_colour": ["#FF0000FF"] }');
  assert.ok(list);
  assert.equal(list.filaments[0].color, '#FF0000');
});

test('missing filament_type fields produce null materialType', () => {
  const list = buildFromProjectSettings('{ "filament_colour": ["#FF0000", "#00FF00"] }');
  assert.ok(list);
  assert.equal(list.size, 2);
  assert.equal(list.filaments[0].materialType, null);
  assert.equal(list.filaments[1].materialType, null);
});

test('partial filament_type list — entries without a matching type get null', () => {
  const list = buildFromProjectSettings(`{
    "filament_colour": ["#FF0000", "#00FF00", "#0000FF"],
    "filament_type":   ["PLA",     "PETG"]
  }`);
  assert.equal(list.filaments[0].materialType, 'PLA');
  assert.equal(list.filaments[1].materialType, 'PETG');
  assert.equal(list.filaments[2].materialType, null);
});

test('empty filament_colour returns null', () => assert.equal(buildFromProjectSettings('{ "filament_colour": [] }'), null));
test('missing filament_colour returns null', () => assert.equal(buildFromProjectSettings('{ "filament_type": ["PLA"] }'), null));

test('malformed JSON returns null', () => {
  assert.equal(buildFromProjectSettings('not json'), null);
  assert.equal(buildFromProjectSettings(''), null);
});

test('colours without hex prefix still parse if regex matches', () => {
  assert.equal(buildFromProjectSettings('{ "filament_colour": ["before#ABCDEFafter"] }').filaments[0].color, '#ABCDEF');
});

// ─── extractPaintSpecs ────────────────────────────────────────────────

test('extractPaintSpecs returns empty for line without paint attributes', () => {
  assert.equal(extractPaintSpecs('<vertex x="1" y="2"/>').length, 0);
  assert.equal(extractPaintSpecs('').length, 0);
});

test('extractPaintSpecs finds single paint_color value', () => {
  assert.deepEqual(extractPaintSpecs('<triangle v1="0" v2="1" v3="2" paint_color="4"/>'), ['4']);
});

test('extractPaintSpecs finds mmu_segmentation value', () => {
  assert.deepEqual(extractPaintSpecs('<triangle mmu_segmentation="8C"/>'), ['8C']);
});

test('extractPaintSpecs finds slic3rpe namespaced attribute', () => {
  assert.deepEqual(extractPaintSpecs('<triangle slic3rpe:mmu_segmentation="3C"/>'), ['3C']);
});

test('extractPaintSpecs returns multiple values from single line', () => {
  const specs = extractPaintSpecs('<t paint_color="4"/><t paint_color="8"/><t mmu_segmentation="C"/>');
  assert.equal(specs.length, 3);
  assert.deepEqual(specs, ['4', '8', 'C']);
});

test('extractPaintSpecs filters blank values', () => {
  assert.deepEqual(extractPaintSpecs('<t paint_color=""/><t paint_color="4"/>'), ['4']);
});

// ─── mergePaintStates ─────────────────────────────────────────────────

test('mergePaintStates with empty paintStates returns base unchanged', () => {
  const base = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FILE_COLOUR), FE(1, '#00FF00', 'PLA', FILE_COLOUR)] });
  const merged = mergePaintStates(base, new Set());
  assert.deepEqual(merged, base);
  assert.equal(merged.paintStateMap.size, 0);
});

test('mergePaintStates with paint states within bounds builds identity paintStateMap', () => {
  const base = CFL({ filaments: [0, 1, 2, 3].map((i) => FE(i, hex6(i * 0x404040), 'PLA', FILE_COLOUR)) });
  const merged = mergePaintStates(base, new Set([1, 2, 3, 4]));
  assert.equal(merged.size, 4);
  assert.equal(merged.paintStateMap.get(1), 0);
  assert.equal(merged.paintStateMap.get(2), 1);
  assert.equal(merged.paintStateMap.get(3), 2);
  assert.equal(merged.paintStateMap.get(4), 3);
  for (const e of merged.filaments) assert.equal(e.source, FILE_COLOUR);
});

// ─── parseLayerToolColourPairs + mergeLayerToolData ───────────────────

test('parseLayerToolColourPairs returns first colour seen per extruder', () => {
  const pairs = parseLayerToolColourPairs(trimIndent(`
    <layer top_z="0.4" type="1" extruder="2" color="#00FF00"/>
    <layer top_z="1.2" type="1" extruder="3" color="#0000FF"/>
    <layer top_z="2.4" type="1" extruder="2" color="#888888"/>
    <layer top_z="3.0" type="0" extruder="1" color="#FF0000"/>
  `));
  assert.equal(pairs.size, 2);
  assert.equal(pairs.get(2), '#00FF00');
  assert.equal(pairs.get(3), '#0000FF');
  assert.equal(pairs.get(1), undefined, 'type=0 layers ignored');
});

test('parseLayerToolColourPairs ignores layers without extruder or colour', () => {
  const pairs = parseLayerToolColourPairs(trimIndent(`
    <layer top_z="0.4" type="1"/>
    <layer top_z="1.2" type="1" extruder="2"/>
    <layer top_z="2.4" type="1" color="#FFFFFF"/>
    <layer top_z="3.0" type="2" extruder="3" color="#FF00FF"/>
  `));
  assert.equal(pairs.size, 1);
  assert.equal(pairs.get(3), '#FF00FF');
});

test('mergeLayerToolData with extruders within bounds is no-op', () => {
  const base = CFL({ filaments: [0, 1, 2, 3].map((i) => FE(i, hex6(i * 0x404040), 'PLA', FILE_COLOUR)) });
  const merged = mergeLayerToolData(base, info(true, ['#FF0000', '#00FF00', '#0000FF'], [1, 2, 3, 4]), new Map());
  assert.deepEqual(merged, base);
});

test('mergeLayerToolData expands list to cover high-index extruder', () => {
  const base = CFL({ filaments: [FE(0, '#000000', 'PLA', FILE_COLOUR)] });
  const pairs = new Map([[2, '#FF0000'], [3, '#00FF00'], [4, '#0000FF']]);
  const merged = mergeLayerToolData(base, info(true, ['#FF0000', '#00FF00', '#0000FF'], [1, 2, 3, 4]), pairs);
  assert.equal(merged.size, 4);
  assert.equal(merged.filaments[0].source, FILE_COLOUR);
  assert.equal(merged.filaments[0].color, '#000000');
  assert.equal(merged.filaments[1].source, LAYER_TOOL);
  assert.equal(merged.filaments[1].color, '#FF0000');
  assert.equal(merged.filaments[2].source, LAYER_TOOL);
  assert.equal(merged.filaments[2].color, '#00FF00');
  assert.equal(merged.filaments[3].source, LAYER_TOOL);
  assert.equal(merged.filaments[3].color, '#0000FF');
});

test('mergeLayerToolData uses grey placeholder when colour unknown', () => {
  const base = CFL({ filaments: [FE(0, '#000000', 'PLA', FILE_COLOUR)] });
  const merged = mergeLayerToolData(base, info(true, [], [1, 2, 3]), new Map());
  assert.equal(merged.size, 3);
  assert.equal(merged.filaments[1].color, '#808080');
  assert.equal(merged.filaments[2].color, '#808080');
  for (const e of merged.filaments.slice(1)) {
    assert.equal(e.source, LAYER_TOOL);
    assert.equal(e.materialType, null);
  }
});

test('mergeLayerToolData with empty extruders returns base', () => {
  const base = CFL({ filaments: [FE(0, '#000000', 'PLA', FILE_COLOUR)] });
  assert.deepEqual(mergeLayerToolData(base, info(false, [], []), new Map()), base);
});

test('mergePaintStates with high-index paint state expands list with PAINT_DERIVED', () => {
  const base = CFL({ filaments: [0, 1, 2, 3].map((i) => FE(i, hex6(i * 0x404040), 'PLA', FILE_COLOUR)) });
  const merged = mergePaintStates(base, new Set([6, 11]));
  assert.equal(merged.size, 11);
  for (let i = 0; i <= 3; i++) assert.equal(merged.filaments[i].source, FILE_COLOUR);
  for (let i = 4; i <= 10; i++) {
    assert.equal(merged.filaments[i].source, PAINT_DERIVED);
    assert.equal(merged.filaments[i].color, '#808080');
    assert.equal(merged.filaments[i].materialType, null);
    assert.equal(merged.filaments[i].fileIndex, i);
  }
  assert.equal(merged.paintStateMap.get(6), 5);
  assert.equal(merged.paintStateMap.get(11), 10);
});

// ── M3-B full-spectrum marker ────────────────────────────────────────────

test('readFullSpectrumPhysicalCount parses the string-form marker', () => {
  assert.equal(readFullSpectrumPhysicalCount(`{
    "filament_colour": ["#FF0000","#00FF00","#0000FF","#FFFF00"],
    "filament_count": "4",
    "full_spectrum_physical_count": "4"
  }`), 4);
});

test('readFullSpectrumPhysicalCount parses the numeric-form marker', () => {
  assert.equal(readFullSpectrumPhysicalCount('{ "filament_colour": ["#FF0000"], "full_spectrum_physical_count": 4 }'), 4);
});

test('readFullSpectrumPhysicalCount returns null when marker absent', () => {
  assert.equal(readFullSpectrumPhysicalCount('{ "filament_colour": ["#FF0000","#00FF00"] }'), null);
});

test('readFullSpectrumPhysicalCount returns null for zero or malformed', () => {
  assert.equal(readFullSpectrumPhysicalCount('{ "full_spectrum_physical_count": "0" }'), null);
  assert.equal(readFullSpectrumPhysicalCount('{ "full_spectrum_physical_count": "abc" }'), null);
  assert.equal(readFullSpectrumPhysicalCount('not json'), null);
});

test('mergePaintStates capped at physical count drops virtual mix states', () => {
  const base = CFL({ filaments: [0, 1, 2, 3].map((i) => FE(i, '#FF0000', 'PLA', FILE_COLOUR)) });
  const physicalOnly = new Set([...new Set([5])].filter((s) => s <= 4));
  const merged = mergePaintStates(base, physicalOnly);
  assert.equal(merged.size, 4, 'virtual mix state must not expand the canonical list');
  assert.ok(merged.filaments.every((e) => e.source === FILE_COLOUR));
});
