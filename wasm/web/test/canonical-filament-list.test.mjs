// Mirrors app/src/test/java/com/u1/slicer/data/CanonicalFilamentListTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FilamentSource, LayerToolMode, canonicalFilamentList as CFL, copyCanonicalFilamentList, filamentEntry as FE,
  stlCanonicalList,
} from '../pipeline/canonical-filament-list.mjs';

const hex6 = (n) => `#${n.toString(16).toUpperCase().padStart(6, '0')}`;

test('empty list reports size 0 and not multi-colour', () => {
  const list = CFL({ filaments: [] });
  assert.equal(list.size, 0);
  assert.equal(list.isMultiColour, false);
  assert.equal(list.paintStateMap.size, 0);
});

test('single-entry list reports size 1 and not multi-colour', () => {
  const list = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR)] });
  assert.equal(list.size, 1);
  assert.equal(list.isMultiColour, false);
});

test('multi-entry list reports size N and is multi-colour', () => {
  const list = CFL({ filaments: [0, 1, 2, 3].map((i) => FE(i, hex6(i * 0x111111), 'PLA', FilamentSource.FILE_COLOUR)) });
  assert.equal(list.size, 4);
  assert.ok(list.isMultiColour);
});

test('FilamentEntry preserves source provenance', () => {
  const list = CFL({
    filaments: [
      FE(0, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR),
      FE(1, '#00FF00', 'PLA', FilamentSource.PAINT_DERIVED),
      FE(2, '#0000FF', 'PETG', FilamentSource.OBJECT_DEFAULT),
      FE(3, '#FFFFFF', null, FilamentSource.LAYER_TOOL),
      FE(4, '#000000', 'PLA', FilamentSource.STL_DEFAULT),
    ],
  });
  assert.equal(list.filaments[0].source, FilamentSource.FILE_COLOUR);
  assert.equal(list.filaments[1].source, FilamentSource.PAINT_DERIVED);
  assert.equal(list.filaments[2].source, FilamentSource.OBJECT_DEFAULT);
  assert.equal(list.filaments[3].source, FilamentSource.LAYER_TOOL);
  assert.equal(list.filaments[4].source, FilamentSource.STL_DEFAULT);
});

test('FilamentEntry materialType may be null', () => {
  assert.equal(FE(0, '#FFFFFF', null, FilamentSource.LAYER_TOOL).materialType, null);
});

test('paintStateMap maps decoded paint state to fileIndex', () => {
  const list = CFL({
    filaments: Array.from({ length: 11 }, (_, i) => FE(i, hex6(i * 0x101010), 'PLA', FilamentSource.FILE_COLOUR)),
    paintStateMap: new Map([[6, 10], [11, 10]]),
  });
  assert.equal(list.paintStateMap.get(6), 10);
  assert.equal(list.paintStateMap.get(11), 10);
  assert.equal(list.size, 11);
});

test('fileIndex is the G-code identity', () => {
  const before = FE(3, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR);
  const afterRecolor = { ...before, color: '#0000FF' };
  assert.equal(afterRecolor.fileIndex, before.fileIndex);
});

test('stlCanonicalList synthesises a single STL_DEFAULT entry', () => {
  const list = stlCanonicalList('#FF0000', 'PLA');
  assert.equal(list.size, 1);
  assert.equal(list.isMultiColour, false);
  assert.equal(list.paintStateMap.size, 0);
  const only = list.filaments[0];
  assert.equal(only.fileIndex, 0);
  assert.equal(only.color, '#FF0000');
  assert.equal(only.materialType, 'PLA');
  assert.equal(only.source, FilamentSource.STL_DEFAULT);
});

test('stlCanonicalList passes nullable materialType through', () => {
  const list = stlCanonicalList('#FFFFFF', null);
  assert.equal(list.size, 1);
  assert.equal(list.filaments[0].materialType, null);
});

test('stlCanonicalList reflects different colours per call', () => {
  assert.equal(stlCanonicalList('#FF0000', 'PLA').filaments[0].color, '#FF0000');
  assert.equal(stlCanonicalList('#FFA500', 'PLA').filaments[0].color, '#FFA500');
});

test('layerToolMode defaults to MULTI_FILAMENT', () => {
  const list = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR)] });
  assert.equal(list.layerToolMode, LayerToolMode.MULTI_FILAMENT);
});

test('layerToolMode is preserved through copy', () => {
  const original = CFL({
    filaments: [0, 1, 2].map((i) => FE(i, hex6(i * 0x111111), 'PLA', FilamentSource.LAYER_TOOL)),
    layerToolMode: LayerToolMode.SINGLE_PAUSE,
  });
  const updated = copyCanonicalFilamentList(original, {
    filaments: [...original.filaments, FE(3, '#FFFFFF', 'PLA', FilamentSource.LAYER_TOOL)],
  });
  assert.equal(updated.layerToolMode, LayerToolMode.SINGLE_PAUSE);
  assert.equal(updated.size, 4);
});

test('isLayerTool is true when any entry is LAYER_TOOL source', () => {
  const list = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR), FE(1, '#00FF00', 'PLA', FilamentSource.LAYER_TOOL)] });
  assert.ok(list.isLayerTool);
});

test('isLayerTool is false when no entry is LAYER_TOOL source', () => {
  const list = CFL({ filaments: [FE(0, '#FF0000', 'PLA', FilamentSource.FILE_COLOUR), FE(1, '#00FF00', 'PLA', FilamentSource.PAINT_DERIVED)] });
  assert.equal(list.isLayerTool, false);
});
