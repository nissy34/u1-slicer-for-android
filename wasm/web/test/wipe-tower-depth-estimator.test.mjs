// Mirrors app/src/test/java/com/u1/slicer/data/WipeTowerDepthEstimatorTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WipeTowerDepthEstimator } from '../pipeline/wipe-tower.mjs';

const near = (exp, act, d) => assert.ok(Math.abs(exp - act) <= d, `expected ${exp} got ${act}`);

test('below 100mm returns minimum 20mm', () => {
  near(20, WipeTowerDepthEstimator.estimateDepth(0), 0.01);
  near(20, WipeTowerDepthEstimator.estimateDepth(50), 0.01);
});
test('at 100mm returns 20mm', () => near(20, WipeTowerDepthEstimator.estimateDepth(100), 0.01));
test('at 175mm returns 30mm midpoint', () => near(30, WipeTowerDepthEstimator.estimateDepth(175), 0.01));
test('at 250mm returns 40mm', () => near(40, WipeTowerDepthEstimator.estimateDepth(250), 0.01));
test('above 250mm clamped to 40mm', () => {
  near(40, WipeTowerDepthEstimator.estimateDepth(300), 0.01);
  near(40, WipeTowerDepthEstimator.estimateDepth(1000), 0.01);
});
test('large primeVolume overrides height-based minimum', () => {
  near(80, WipeTowerDepthEstimator.estimateDepth(50, 80), 0.01);
});
test('height-based minimum wins over small primeVolume', () => {
  near(20, WipeTowerDepthEstimator.estimateDepth(50, 5), 0.01);
});
test('zero primeVolume behaves same as no primeVolume', () => {
  near(WipeTowerDepthEstimator.estimateDepth(175), WipeTowerDepthEstimator.estimateDepth(175, 0), 0.01);
});
