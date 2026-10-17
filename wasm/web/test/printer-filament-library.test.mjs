// Mirrors FilamentLibraryTest, FilamentLibraryMatcherTest, FilamentLibraryRecentsTest,
// LibrarySlugListCodecTest, FilamentLibraryImportTest, FilamentLibraryAssetContractTest
// and printer/SyncPreviewBuilderTest (U1 cases) from app/src/test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  FUTURE_TRANSLUCENCY_NOTE, MAX_DELTA_E, MAX_RECENTS, buildImportPreview, decodeSlugList, deltaE76, displayName,
  encodeSlugList, hasImportableData, libraryEntryToSlot, makeLibrary, matchLibrary, parseLibrary, topMaterials, updateRecents,
} from '../printer/filament-library.mjs';
import { applySyncPreviewEntries, buildSyncPreviewEntries, defaultSlots, parseSlots, serializeSlots } from '../printer/slots.mjs';

const lib = () => parseLibrary(`
  {"schema":1,"source":"OpenPrintTag/openprinttag-database","commit":"abc1234","date":"2026-06-10","count":5,
   "entries":[
    {"s":"acme-pla-red","b":"Acme","n":"PLA Red","m":"PLA","h":"#FF0000","td":2.0,"d":1.24,"nl":205,"nh":225,"bl":40,"bh":60},
    {"s":"acme-pla-blue","b":"Acme","n":"PLA Blue","m":"PLA","h":"#0000FF"},
    {"s":"acme-petg-red","b":"Acme","n":"PETG Red","m":"PETG","h":"#EE0000"},
    {"s":"bolt-pa6-nat","b":"Bolt","n":"PA6 Natural","m":"PA","mr":"PA6","d":1.14},
    {"s":"bolt-pla-red","b":"Bolt","n":"PLA Cherry Red","m":"PLA","h":"#F10505","ri":1.46}
   ]}`);
const slugs = (r) => r.map((e) => e.slug);

test('parse exposes snapshot info and entries', () => {
  const l = lib();
  assert.equal(l.entries.length, 5);
  assert.deepEqual(l.snapshot, { commit: 'abc1234', date: '2026-06-10', count: 5 });
});
test('parse maps optional fields, nulls when absent', () => {
  const red = lib().entry('acme-pla-red');
  assert.equal(red.brand, 'Acme');
  assert.equal(red.hex, '#FF0000');
  assert.equal(red.td, 2.0);
  assert.deepEqual([red.minNozzle, red.maxNozzle, red.minBed, red.maxBed], [205, 225, 40, 60]);
  assert.equal(red.ri, null);
  const nat = lib().entry('bolt-pa6-nat');
  assert.equal(nat.hex, null);
  assert.equal(nat.material, 'PA');
  assert.equal(nat.materialRaw, 'PA6');
  assert.equal(nat.td, null);
  assert.equal(nat.minNozzle, null);
});
test('entry returns null for unknown slug', () => assert.equal(lib().entry('nope'), null));
test('blank query lists favourites then recents then rest alphabetical', () => {
  const res = lib().search('', { favourites: new Set(['bolt-pla-red']), recents: ['acme-petg-red', 'bolt-pla-red'] });
  assert.equal(res[0].slug, 'bolt-pla-red');
  assert.equal(res[1].slug, 'acme-petg-red');
  assert.deepEqual(slugs(res.slice(2)), ['acme-pla-blue', 'acme-pla-red', 'bolt-pa6-nat']);
});
test('query matches across brand name material, all tokens must match', () => {
  assert.deepEqual(new Set(slugs(lib().search('acme red'))), new Set(['acme-pla-red', 'acme-petg-red']));
  assert.deepEqual(slugs(lib().search('acme red petg')), ['acme-petg-red']);
});
test('query is case-insensitive', () => assert.deepEqual(slugs(lib().search('CHERRY')), ['bolt-pla-red']));
test('material filter applies to blank and non-blank queries', () => {
  assert.deepEqual(new Set(slugs(lib().search('', { material: 'PLA' }))), new Set(['acme-pla-red', 'acme-pla-blue', 'bolt-pla-red']));
  assert.deepEqual(slugs(lib().search('red', { material: 'PETG' })), ['acme-petg-red']);
});
test('favourites rank first on non-blank query', () => assert.equal(lib().search('red', { favourites: new Set(['bolt-pla-red']) })[0].slug, 'bolt-pla-red'));
test('limit caps results', () => assert.equal(lib().search('', { limit: 2 }).length, 2));
test('parse rejects malformed json', () => assert.throws(() => parseLibrary('{not json')));
test('displayName is brand plus name', () => assert.equal(displayName(lib().entry('acme-pla-red')), 'Acme PLA Red'));
test('topMaterials ranks by count', () => assert.deepEqual(topMaterials(lib(), 2), ['PLA', 'PETG']));

// ---- matcher -----------------------------------------------------------------------------------
const mlib = makeLibrary([
  { slug: 'prusament-pla-galaxy-black', brand: 'Prusament', name: 'PLA Prusa Galaxy Black', material: 'PLA', hex: '#3E413F' },
  { slug: 'prusament-pla-azure-blue', brand: 'Prusament', name: 'PLA Azure Blue', material: 'PLA', hex: '#008FBE' },
  { slug: 'prusament-petg-jet-black', brand: 'Prusament', name: 'PETG Jet Black', material: 'PETG', hex: '#000000' },
  { slug: 'bambulab-pla-black', brand: 'Bambu Lab', name: 'PLA Basic Black', material: 'PLA', hex: '#000000' },
  { slug: 'acme-pla-nocolour', brand: 'Acme', name: 'PLA Mystery', material: 'PLA', hex: null },
], { commit: 'test', date: '2026-06-10', count: 5 });
const match = (vendor, material, subType, hex) => matchLibrary(mlib, { vendor, material, subType, hex });

test('exact brand and colour match within threshold', () => {
  const m = match('Prusament', 'PLA', null, '#3E413F');
  assert.equal(m.entry.slug, 'prusament-pla-galaxy-black');
  assert.ok(m.deltaE < 1.0);
});
test('vendor normalisation is case and punctuation insensitive both ways', () => {
  assert.equal(match('bambu lab', 'PLA', null, '#000000').entry.slug, 'bambulab-pla-black');
  assert.equal(match('BambuLab', 'PLA', null, '#000000').entry.slug, 'bambulab-pla-black');
});
test('colour beyond deltaE threshold rejects', () => assert.equal(match('Prusament', 'PLA', null, '#FF0000'), null));
test('material mismatch rejects even with perfect colour', () => assert.equal(match('Prusament', 'ABS', null, '#3E413F'), null));
test('unknown vendor returns null - never guesses across brands', () => {
  assert.equal(match('Snapmaker', 'PLA', null, '#000000'), null);
  assert.equal(match('NoSuchVendor', 'PLA', null, '#3E413F'), null);
});
test('missing vendor or colour or material returns null', () => {
  assert.equal(match(null, 'PLA', null, '#3E413F'), null);
  assert.equal(match('', 'PLA', null, '#3E413F'), null);
  assert.equal(match('Prusament', 'PLA', null, null), null);
  assert.equal(match('Prusament', null, null, '#3E413F'), null);
});
test('subtype tokens break colour ties toward the named filament', () => {
  const withSub = match('Prusament', 'PLA', 'Galaxy', '#1F6880');
  if (withSub) assert.equal(withSub.entry.slug, 'prusament-pla-galaxy-black');
  else assert.equal(match('Prusament', 'PLA', 'Galaxy', '#37403E').entry.slug, 'prusament-pla-galaxy-black');
});
test('entries without colour are never matched', () => assert.equal(match('Acme', 'PLA', null, '#123456'), null));
test('threshold is pinned at 10', () => assert.equal(MAX_DELTA_E, 10.0));
test('deltaE76 is zero for identical colours and symmetric', () => {
  assert.equal(deltaE76('#123456', '#123456'), 0);
  assert.equal(deltaE76('#FF0000', '#00FF00'), deltaE76('#00FF00', '#FF0000'));
});

// ---- recents / codec ----------------------------------------------------------------------------
test('new slug goes first', () => assert.deepEqual(updateRecents(['a', 'b'], 'c'), ['c', 'a', 'b']));
test('existing slug moves to front without duplicate', () => assert.deepEqual(updateRecents(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']));
test('capped at MAX_RECENTS', () => {
  const full = Array.from({ length: MAX_RECENTS }, (_, i) => `s${i + 1}`);
  const out = updateRecents(full, 'new');
  assert.equal(out.length, MAX_RECENTS);
  assert.equal(out[0], 'new');
  assert.ok(!out.includes(`s${MAX_RECENTS}`));
});
test('slug list round trip preserves order and content', () => assert.deepEqual(decodeSlugList(encodeSlugList(['a-1', 'b-2', 'c-3'])), ['a-1', 'b-2', 'c-3']));
test('empty and blank decode to empty list', () => { assert.deepEqual(decodeSlugList(''), []); assert.deepEqual(decodeSlugList('   '), []); });
test('malformed json decodes to empty list', () => assert.deepEqual(decodeSlugList('{broken'), []));

// ---- import --------------------------------------------------------------------------------------
test('hasImportableData gate', () => {
  assert.ok(hasImportableData(lib().entry('acme-pla-red')));
  assert.ok(!hasImportableData(lib().entry('acme-pla-blue')));
});
test('import preview rows: en-dash ranges, density, TD/RI notes', () => {
  assert.deepEqual(buildImportPreview(lib().entry('acme-pla-red')), [
    { label: 'Nozzle temperature', value: '205–225 °C' }, { label: 'Bed temperature', value: '40–60 °C' },
    { label: 'Density', value: '1.24 g/cm³' }, { label: 'Transmission distance', value: '2', note: FUTURE_TRANSLUCENCY_NOTE }]);
  assert.deepEqual(buildImportPreview({ minNozzle: 210, maxNozzle: null }), [{ label: 'Nozzle temperature', value: '210 °C' }]);
  assert.deepEqual(buildImportPreview(lib().entry('acme-pla-blue')), []);
});
test('library entry to slot: midpoint temps, material defaults, colour, name', () => {
  const s = libraryEntryToSlot(lib().entry('acme-pla-red'), { index: 0 });
  assert.deepEqual([s.name, s.materialType, s.color, s.nozzleTemp, s.bedTemp, s.librarySlug], ['Acme PLA Red', 'PLA', '#FF0000', 215, 50, 'acme-pla-red']);
  const petg = libraryEntryToSlot(lib().entry('acme-petg-red'), { index: 1 });
  assert.deepEqual([petg.nozzleTemp, petg.bedTemp], [235, 70]);
});

// ---- bundled asset contract ------------------------------------------------------------------------
test('bundled asset: >10000 entries, >=100 brands, count matches, known Prusament entry', () => {
  const asset = parseLibrary(readFileSync(new URL('../../../app/src/main/assets/filament_library.json', import.meta.url), 'utf8'));
  assert.ok(asset.entries.length > 10000);
  assert.ok(new Set(asset.entries.map((e) => e.brand)).size >= 100);
  assert.equal(asset.snapshot.count, asset.entries.length);
  assert.ok(asset.snapshot.commit !== '?' && asset.snapshot.date !== '?');
  for (const e of asset.entries) if (e.hex != null) assert.match(e.hex, /^#[0-9A-Fa-f]{6}$/);
  const az = asset.entry('prusament-pla-azure-blue');
  assert.deepEqual([az.brand, az.material, az.hex], ['Prusament', 'PLA', '#008FBE']);
});

// ---- sync preview (SyncPreviewBuilderTest, U1 cases) ------------------------------------------------
const glib = makeLibrary([{ slug: 'prusament-pla-galaxy-black', brand: 'Prusament', name: 'PLA Prusa Galaxy Black', material: 'PLA', hex: '#3E413F' }], { commit: 't', date: 'd', count: 1 });
const presets = defaultSlots().map((s) => ({ ...s, color: '#111111', materialType: 'PLA' }));
const pslot = (i, vendor, type = 'PLA', hex = '#3E413F') => ({ index: i, label: `E${i + 1}`, color: hex, loaded: true, materialType: type, subType: '', manufacturer: vendor });

test('matched slot carries catalogue name colour material', () => {
  const e = buildSyncPreviewEntries(presets, [pslot(0, 'Prusament')], glib)[0];
  assert.equal(e.matchedName, 'Prusament PLA Prusa Galaxy Black');
  assert.equal(e.matchedSlug, 'prusament-pla-galaxy-black');
  assert.equal(e.newColor, '#3E413F');
  assert.equal(e.newType, 'PLA');
});
test('unmatched slot falls back to raw values exactly as before', () => {
  const e = buildSyncPreviewEntries(presets, [pslot(0, 'Snapmaker', 'PLA', '#FF0000')], glib)[0];
  assert.equal(e.matchedName, null);
  assert.equal(e.matchedSlug, null);
  assert.equal(e.newColor, '#FF0000');
  assert.equal(e.newType, 'PLA');
});
test('null library means no matching - raw behaviour', () => {
  const e = buildSyncPreviewEntries(presets, [pslot(0, 'Prusament')], null)[0];
  assert.equal(e.matchedName, null);
  assert.equal(e.newColor, '#3E413F');
});
test('missing printer slot yields null news', () => {
  const entries = buildSyncPreviewEntries(presets, [], glib);
  assert.equal(entries.length, 4);
  assert.equal(entries[2].newColor, null);
  assert.equal(entries[2].newType, null);
  assert.equal(entries[2].matchedName, null);
});
test('four entries always built with current preset values', () => {
  const entries = buildSyncPreviewEntries(presets, [pslot(1, 'Prusament')], glib);
  assert.deepEqual(entries.map((e) => e.label), ['E1', 'E2', 'E3', 'E4']);
  assert.equal(entries[0].currentColor, '#111111');
  assert.equal(entries[1].matchedName, 'Prusament PLA Prusa Galaxy Black');
});
test('unloaded slot is not library matched', () => {
  const e = buildSyncPreviewEntries(presets, [{ ...pslot(0, 'Prusament'), loaded: false }], glib)[0];
  assert.equal(e.matchedName, null);
});
test('applying sync updates colours/types selectively and resets temps on a type change', () => {
  const entries = buildSyncPreviewEntries(presets, [pslot(0, 'Prusament'), pslot(1, 'Acme', 'PETG', '#00FF00')], glib);
  const coloursOnly = applySyncPreviewEntries(presets, entries, { applyColors: true, applyTypes: false });
  assert.equal(coloursOnly[1].color, '#00FF00');
  assert.equal(coloursOnly[1].materialType, 'PLA');
  const both = applySyncPreviewEntries(presets, entries, { applyColors: true, applyTypes: true });
  assert.equal(both[1].materialType, 'PETG');
  assert.deepEqual([both[1].nozzleTemp, both[1].bedTemp], [235, 70]);
  assert.equal(both[0].name, 'Prusament PLA Prusa Galaxy Black');
  assert.equal(both[2].color, '#111111');
});
test('slots persist round trip and tolerate junk', () => {
  const s = defaultSlots();
  s[2] = { ...s[2], color: '#ABCDEF', materialType: 'PETG', name: 'X', nozzleTemp: 240 };
  assert.deepEqual(parseSlots(serializeSlots(s)), s);
  assert.deepEqual(parseSlots('{bad'), defaultSlots());
  assert.equal(parseSlots('[{"index":9},{"index":0,"color":"red"}]')[0].color, '#FF0000');
});
