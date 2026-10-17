// Mirrors app/src/androidTest/java/com/u1/slicer/slicing/SensoryTwistSupportsTest.kt
// on the wasm engine: B77 Sensory Twist Ball — paint_supports + per-object
// enable_support=1 must survive BambuSanitizer + ProfileEmbedder and emit
// Support features in the G-code even with global supports off.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { newEmbedder, processAuto, zipEntryText } from './app-helpers.mjs';
import { asset, engineAvailable } from './engine-helpers.mjs';
import { NativeLib } from './native-lib.mjs';

const makeConfig = (slotCount = 1) => ({
  layerHeight: 0.2, firstLayerHeight: 0.2, fillDensity: 0.05, perimeters: 2,
  supportEnabled: false, // global off; per-object override must turn it on
  extruderCount: slotCount, extruderTemps: Array(slotCount).fill(220), nozzleTemp: 220, bedTemp: 55, wipeTowerEnabled: false,
});

test('sensoryTwist_paintOnSupports_producesSupportGcode', { skip: engineAvailable ? false : 'wasm engine not built' }, async () => {
  const lib = await NativeLib.create();
  const embedder = newEmbedder();
  const name = 'SENSORY+TWIST+BALL+FIDGETS+optimised.3mf';
  const input = asset(name);
  const info = parse(input, { name });
  assert.ok(info.hasPaintSupports, 'Sensory Twist must be detected as hasPaintSupports');

  const sourceConfig = embedder.parseSourceConfig(input);
  const sanitized = processAuto(input, name, info.isBambu);
  const sanitizedModelSettings = zipEntryText(sanitized, 'Metadata/model_settings.config');
  assert.ok(sanitizedModelSettings != null, 'Sanitized output must retain model_settings.config');
  assert.ok(sanitizedModelSettings.includes('key="enable_support" value="1"'),
    'Sanitized model_settings.config must contain per-object enable_support=1');

  const config = embedder.buildConfig({ info, sourceConfig, targetExtruderCount: 1 });
  const embedded = embedder.embed(sanitized, config, info);
  const embeddedModelSettings = zipEntryText(embedded, 'Metadata/model_settings.config');
  assert.ok(embeddedModelSettings != null, 'Final embedded output must retain model_settings.config');
  assert.ok(embeddedModelSettings.includes('key="enable_support" value="1"'),
    'Final embedded model_settings.config must still contain enable_support=1');

  assert.ok(lib.loadModel(embedded), 'loadModel must succeed');
  const result = lib.slice(makeConfig(1));
  assert.ok(result, 'slice() must not return null');
  assert.ok(result.success, `Sensory Twist must slice successfully: ${result.errorMessage}`);
  const supportCount = result.gcode.split('\n').filter((l) => {
    const t = l.trim();
    return t === ';TYPE:Support' || t === ';TYPE:Support interface' || t === '; FEATURE: Support' || t === '; FEATURE: Support interface';
  }).length;
  assert.ok(supportCount > 0, 'Sensory Twist must emit >0 Support features ' +
    `(paint_supports + per-object enable_support=1). Got ${supportCount}.`);
  lib.clearModel();
});
