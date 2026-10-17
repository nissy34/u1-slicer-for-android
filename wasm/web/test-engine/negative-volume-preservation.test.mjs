// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/NegativeVolumePreservationTest.kt
// on the wasm engine (the config-level half is also in test/profile-embedder-integration
// .test.mjs; this one adds the native loadModel step): B137 — the two negative_part
// cutters of a >64MB-main-model compound 3MF must survive process() + embed() and the
// embedded file must load in the engine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeThreeMfInfo } from '../pipeline/merge-three-mf-info.mjs';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { newEmbedder, processAuto, zipEntryText } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import { NativeLib } from './native-lib.mjs';

function readModelSettings(bytes) {
  const text = zipEntryText(bytes, 'Metadata/model_settings.config') ?? zipEntryText(bytes, 'Metadata/Slic3r_PE_model.config');
  if (text == null) throw new Error('no model_settings.config / Slic3r_PE_model.config');
  return text;
}
const negativePartCount = (xml) => [...xml.matchAll(/subtype="negative_part"/g)].length;

test('largeCompoundModel_negativeVolumesSurviveProcessAndEmbed', { skip: engineAvailable ? false : 'wasm engine not built' }, async () => {
  const lib = await NativeLib.create();
  const embedder = newEmbedder();
  const name = 'negative-volume-articulated.3mf';
  const input = asset(name);
  const origInfo = parse(input, { name });
  assert.ok(origInfo.isBambu, 'fixture should be detected as Bambu');
  assert.equal(negativePartCount(readModelSettings(input)), 2, 'source fixture must contain exactly 2 negative_part volumes');

  const processed = processAuto(input, name, origInfo.isBambu);
  const mergedInfo = mergeThreeMfInfo(parse(processed, { skipPaintDetection: true, name }), origInfo);
  const firstPlateId = mergedInfo.plates[0]?.plateId ?? null;
  const embedded = embedder.embed(processed, embedder.buildConfig({ info: mergedInfo }), mergedInfo, null, firstPlateId);
  const embeddedConfig = readModelSettings(embedded);
  assert.equal(negativePartCount(embeddedConfig), 2,
    `embedded model_settings.config must preserve both negative_part subtypes (got config:\n${embeddedConfig}\n)`);
  assert.ok(lib.loadModel(embedded), 'loadModel should succeed for the embedded file');
  lib.clearModel();
});
