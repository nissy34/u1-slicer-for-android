// Mirrors app/src/test/java/com/u1/slicer/bambu/ProfileEmbedderTest.kt:
// convertToModelSettings() — Slic3r_PE_model.config -> OrcaSlicer model_settings.config.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileEmbedder } from '../pipeline/profile-embedder.mjs';

const enc = (s) => new TextEncoder().encode(s);
const trimIndent = (s) => {
  const lines = s.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind)).join('\n');
};

test('single object single extruder', () => {
  const input = trimIndent(`
    <config>
      <object id="1">
        <metadata type="object" key="extruder" value="1"/>
        <volume firstid="0" lastid="999">
          <metadata type="volume" key="extruder" value="1"/>
        </volume>
      </object>
    </config>`);
  const result = ProfileEmbedder.convertToModelSettings(enc(input), null);
  assert.ok(result.includes('<object id="1">'), 'Must contain object id=1');
  assert.ok(result.includes('firstid="0" lastid="999"'), 'Must contain volume [0-999]');
  assert.ok(result.includes('<metadata type="object" key="extruder" value="1"/>'), 'Must preserve object metadata type');
  assert.ok(result.includes('<metadata type="volume" key="extruder" value="1"/>'), 'Must preserve volume metadata type');
});

test('dragon scale multi-volume preserves per-volume extruders', () => {
  const input = trimIndent(`
    <?xml version="1.0" encoding="UTF-8"?>
    <config>
      <object id="1">
        <metadata type="object" key="extruder" value="2"/>
        <volume firstid="0" lastid="181579">
          <metadata type="volume" key="extruder" value="1"/>
        </volume>
        <volume firstid="181580" lastid="207895">
          <metadata type="volume" key="extruder" value="2"/>
        </volume>
        <volume firstid="207896" lastid="260855">
          <metadata type="volume" key="extruder" value="2"/>
        </volume>
      </object>
    </config>`);
  const result = ProfileEmbedder.convertToModelSettings(enc(input), null);
  assert.ok(result.includes('<metadata type="object" key="extruder" value="2"/>'), 'Object must have extruder=2');
  assert.ok(result.includes('firstid="0" lastid="181579"'), 'Volume 0-181579 must exist');
  assert.ok(result.includes('firstid="181580" lastid="207895"'), 'Volume 181580-207895 must exist');
  assert.ok(result.includes('firstid="207896" lastid="260855"'), 'Volume 207896-260855 must exist');
  const vol1Match = /firstid="0" lastid="181579">\s*\n\s*<metadata type="volume" key="extruder" value="(\d+)"/.exec(result);
  assert.notEqual(vol1Match, null, 'Volume 0-181579 must have extruder metadata');
  assert.equal(vol1Match[1], '1', 'First volume must be extruder 1');
});

test('extruder remap applied to volumes', () => {
  const input = trimIndent(`
    <config>
      <object id="1">
        <metadata type="object" key="extruder" value="2"/>
        <volume firstid="0" lastid="100">
          <metadata type="volume" key="extruder" value="1"/>
        </volume>
        <volume firstid="101" lastid="200">
          <metadata type="volume" key="extruder" value="2"/>
        </volume>
      </object>
    </config>`);
  const remap = new Map([[1, 3], [2, 4]]);
  const result = ProfileEmbedder.convertToModelSettings(enc(input), remap);
  assert.ok(result.includes('<metadata type="object" key="extruder" value="4"/>'), 'Object extruder must be remapped to 4');
  const vol1Match = /firstid="0" lastid="100">\s*\n\s*<metadata type="volume" key="extruder" value="(\d+)"/.exec(result);
  assert.equal(vol1Match[1], '3', 'Volume 1 must be remapped 1→3');
  const vol2Match = /firstid="101" lastid="200">\s*\n\s*<metadata type="volume" key="extruder" value="(\d+)"/.exec(result);
  assert.equal(vol2Match[1], '4', 'Volume 2 must be remapped 2→4');
});

test('calib cube separate objects no volumes', () => {
  const input = trimIndent(`
    <config>
      <object id="100">
        <metadata type="object" key="extruder" value="1"/>
      </object>
      <object id="101">
        <metadata type="object" key="extruder" value="2"/>
      </object>
    </config>`);
  const result = ProfileEmbedder.convertToModelSettings(enc(input), null);
  assert.ok(result.includes('<object id="100">'), 'Object 100 must exist');
  assert.ok(result.includes('<object id="101">'), 'Object 101 must exist');
  assert.ok(!result.includes('firstid='), 'No volume elements for separate-object models');
});

test('value-before-key attribute order handled', () => {
  const input = trimIndent(`
    <config>
      <object id="1">
        <metadata type="object" value="2" key="extruder"/>
      </object>
    </config>`);
  const result = ProfileEmbedder.convertToModelSettings(enc(input), null);
  assert.ok(result.includes('value="2"'), 'Must extract extruder=2 regardless of attribute order');
});

test('extruderRemap collapses extruders when applied to per-object model', () => {
  const input = trimIndent(`
    <config>
      <object id="2">
        <metadata type="object" key="extruder" value="1"/>
      </object>
      <object id="3">
        <metadata type="object" key="extruder" value="2"/>
      </object>
      <object id="4">
        <metadata type="object" key="extruder" value="3"/>
      </object>
      <object id="5">
        <metadata type="object" key="extruder" value="4"/>
      </object>
    </config>`);
  const extruders = (xml) => new Set([...xml.matchAll(/key="extruder"\s+value="(\d+)"/g)].map((m) => Number(m[1])));
  const collapsing = new Map([[1, 1], [2, 2], [3, 1], [4, 2]]);
  assert.deepEqual(extruders(ProfileEmbedder.convertToModelSettings(enc(input), collapsing)), new Set([1, 2]),
    'Collapsing remap reduces 4 source extruders to 2 distinct values — this loses mesh diversity for the 3D Prepare body recolour');
  assert.deepEqual(extruders(ProfileEmbedder.convertToModelSettings(enc(input), null)), new Set([1, 2, 3, 4]),
    'extruderRemap=null preserves all 4 distinct source extruders so the Prepare preview mesh keeps its 4-distinct-colour layout');
});
