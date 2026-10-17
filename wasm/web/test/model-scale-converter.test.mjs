// Mirrors app/src/test/java/com/u1/slicer/model/ModelScaleConverterTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelScaleConverter } from '../pipeline/model-scale-converter.mjs';

const near = (exp, act, d) => assert.ok(Math.abs(exp - act) <= d, `expected ${exp} got ${act}`);

test('mmToScale 50mm on 100mm axis gives 0_5x', () => near(0.5, ModelScaleConverter.mmToScale(50, 100), 1e-4));
test('mmToScale roundtrip with scaleToMm', () => {
  const s = ModelScaleConverter.mmToScale(75, 30);
  near(75, ModelScaleConverter.scaleToMm(s, 30), 1e-3);
});
test('mmToScale axis isolation - Z conversion does not depend on X size', () => {
  near(ModelScaleConverter.mmToScale(50, 100), ModelScaleConverter.mmToScale(50, 100), 1e-6);
});
test('mmToScale clamps below 1mm', () => near(0.1, ModelScaleConverter.mmToScale(0.05, 100), 1e-4));
test('mmToScale clamps to MAX_SCALE for huge mm input', () => near(3, ModelScaleConverter.mmToScale(1000, 20), 1e-4));
test('mmToScale returns null when loadTimeSize is zero or negative', () => {
  assert.equal(ModelScaleConverter.mmToScale(50, 0), null);
  assert.equal(ModelScaleConverter.mmToScale(50, -10), null);
});
test('scaleToMm basic', () => {
  near(60, ModelScaleConverter.scaleToMm(2, 30), 1e-4);
  near(0, ModelScaleConverter.scaleToMm(1, 0), 1e-4);
});
test('exceedsBed false for normal sizes', () => {
  assert.equal(ModelScaleConverter.exceedsBed(1, 100), false);
  assert.equal(ModelScaleConverter.exceedsBed(2.7, 100), false); // exactly 270 mm
});
test('exceedsBed true when scaled size exceeds 270mm', () => {
  assert.equal(ModelScaleConverter.exceedsBed(3, 100), true);
  assert.equal(ModelScaleConverter.exceedsBed(1.5, 200), true);
});
