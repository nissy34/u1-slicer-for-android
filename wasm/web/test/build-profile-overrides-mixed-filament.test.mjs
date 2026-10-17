// Mirrors app/src/test/java/com/u1/slicer/BuildProfileOverridesMixedFilamentTest.kt case by case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfileOverridesImpl } from '../pipeline/profile-overrides.mjs';
import { slicingOverrides } from '../pipeline/slicing-overrides.mjs';
import { sliceConfig } from '../pipeline/slice-config.mjs';

test('buildProfileOverrides emits mixed_filament_definitions when field is set', () => {
  const cfg = sliceConfig({ extruderCount: 2, mixedFilamentDefinitions: '1,2,1,50' });
  const overrides = buildProfileOverridesImpl(cfg, slicingOverrides(), { slotCount: 2 });
  assert.equal(overrides.mixed_filament_definitions, '1,2,1,50');
});

test('buildProfileOverrides omits mixed_filament_definitions when field is empty', () => {
  const overrides = buildProfileOverridesImpl(sliceConfig({ extruderCount: 2 }), slicingOverrides(), { slotCount: 2 });
  assert.ok(!Object.hasOwn(overrides, 'mixed_filament_definitions'),
    'mixed_filament_definitions must NOT be emitted when SliceConfig field is empty (lets embedded profile value win)');
});
