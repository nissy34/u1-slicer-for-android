// Mirrors app/src/test/java/com/u1/slicer/WipeTowerClampTest.kt case by case.
// SliceConfig / SlicingOverrides are plain objects with the same field shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WipeTowerDepthEstimator, resolveWipeTowerDepth, resolveWipeTowerWidth, wipeTowerClampBounds,
} from '../pipeline/wipe-tower.mjs';

const near = (exp, act, d) => assert.ok(Math.abs(exp - act) <= d, `expected ${exp} got ${act}`);
const coerceIn = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const SlicingOverrides = (o = {}) => ({
  primeVolume: { mode: 'USE_FILE', value: null },
  primeTowerWidth: { mode: 'USE_FILE', value: null },
  ...o,
});

test('maxY uses estimated depth not width for short model', () => {
  const bedSize = 270, towerWidth = 60;
  const estimatedDepth = WipeTowerDepthEstimator.estimateDepth(6);
  const [maxX, maxY] = wipeTowerClampBounds(bedSize, bedSize, towerWidth, estimatedDepth);
  near(bedSize - towerWidth, maxX, 0.01);
  near(bedSize - estimatedDepth, maxY, 0.01);
});

test('maxY uses estimated depth for tall model', () => {
  const bedSize = 270, towerWidth = 60;
  const estimatedDepth = WipeTowerDepthEstimator.estimateDepth(250);
  const [maxX, maxY] = wipeTowerClampBounds(bedSize, bedSize, towerWidth, estimatedDepth);
  near(bedSize - towerWidth, maxX, 0.01);
  near(bedSize - estimatedDepth, maxY, 0.01);
});

test('resolveWipeTowerWidth returns override width when override is active', () => {
  const config = { wipeTowerWidth: 60 };
  const overrides = SlicingOverrides({ primeTowerWidth: { mode: 'OVERRIDE', value: 45 } });
  near(45, resolveWipeTowerWidth(config, overrides), 0.01);
});

test('resolveWipeTowerWidth returns config width when override is USE_FILE', () => {
  const overrides = SlicingOverrides({ primeTowerWidth: { mode: 'USE_FILE', value: null } });
  near(60, resolveWipeTowerWidth({ wipeTowerWidth: 60 }, overrides), 0.01);
});

test('resolveWipeTowerWidth returns config width when override value is null', () => {
  near(60, resolveWipeTowerWidth({ wipeTowerWidth: 60 }, SlicingOverrides()), 0.01);
});

test('resolveWipeTowerDepth uses override prime volume when active', () => {
  const overrides = SlicingOverrides({ primeVolume: { mode: 'OVERRIDE', value: 80 } });
  near(80, resolveWipeTowerDepth(50, overrides), 0.01);
});

test('resolveWipeTowerDepth falls back to height-based estimate when USE_FILE', () => {
  const overrides = SlicingOverrides({ primeVolume: { mode: 'USE_FILE', value: null } });
  near(20, resolveWipeTowerDepth(50, overrides), 0.01);
});

test('clamp moves out-of-bounds tower inside bed', () => {
  const bounds = wipeTowerClampBounds(270, 270, 60, 20);
  near(210, coerceIn(300, 0, bounds[0]), 0.01);
  near(250, coerceIn(260, 0, bounds[1]), 0.01);
});
