// Mirrors app/src/test/java/com/u1/slicer/NozzleTempDefaultTest.kt
// (NozzleTempDefaultTest + ComputeFreshExtruderTempsTest) case by case.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { nozzleTempDefaultForMaterial, computeFreshSlotTemps } from '../pipeline/profile-overrides.mjs';
import { extruderPreset } from '../pipeline/extruder-preset.mjs';

describe('NozzleTempDefaultTest', () => {
  test('PLA returns 220', () => assert.equal(nozzleTempDefaultForMaterial('PLA'), 220));
  test('PETG returns 235', () => assert.equal(nozzleTempDefaultForMaterial('PETG'), 235));
  test('ABS returns 270', () => assert.equal(nozzleTempDefaultForMaterial('ABS'), 270));
  test('ASA returns 260', () => assert.equal(nozzleTempDefaultForMaterial('ASA'), 260));
  test('PA returns 260', () => assert.equal(nozzleTempDefaultForMaterial('PA'), 260));
  test('TPU returns 225', () => assert.equal(nozzleTempDefaultForMaterial('TPU'), 225));
  test('PVA returns 210', () => assert.equal(nozzleTempDefaultForMaterial('PVA'), 210));
  test('lowercase petg returns 235', () => assert.equal(nozzleTempDefaultForMaterial('petg'), 235));
  test('mixed-case Abs returns 270', () => assert.equal(nozzleTempDefaultForMaterial('Abs'), 270));
  test('unknown material falls back to 220', () => assert.equal(nozzleTempDefaultForMaterial('PC'), 220));
  test('empty string falls back to 220', () => assert.equal(nozzleTempDefaultForMaterial(''), 220));
});

describe('ComputeFreshExtruderTempsTest', () => {
  const preset = (index, material, profileId = null) =>
    extruderPreset({ index, materialType: material, filamentProfileId: profileId });
  const filament = (id, material, nozzleTemp) =>
    ({ id, name: material, material, nozzleTemp, bedTemp: 60, retractLength: 0.8, retractSpeed: 45 });

  test('single PLA slot returns 220', () => {
    assert.deepEqual(computeFreshSlotTemps(1, null, [preset(0, 'PLA')], []), [220]);
  });

  test('single PETG slot returns 235', () => {
    assert.deepEqual(computeFreshSlotTemps(1, null, [preset(0, 'PETG')], []), [235]);
  });

  test('linked filament profile nozzleTemp wins over materialType default', () => {
    assert.deepEqual(computeFreshSlotTemps(1, null, [preset(0, 'PETG', 7)], [filament(7, 'PETG', 245)]), [245]);
  });

  test('multi-colour four slots each get correct temp', () => {
    const presets = [preset(0, 'PLA'), preset(1, 'PETG'), preset(2, 'ABS'), preset(3, 'TPU')];
    assert.deepEqual(computeFreshSlotTemps(4, null, presets, []), [220, 235, 270, 225]);
  });

  test('usedSlots remapping resolves physical slot correctly', () => {
    assert.deepEqual(computeFreshSlotTemps(2, [0, 3], [preset(0, 'PLA'), preset(3, 'PETG')], []), [220, 235]);
  });

  test('missing preset falls back to PLA default', () => {
    assert.deepEqual(computeFreshSlotTemps(1, null, [], []), [220]);
  });

  test('stale-config regression - changing preset after load is reflected at slice time', () => {
    const atLoadTime = computeFreshSlotTemps(1, null, [preset(0, 'PLA')], []);
    const atSliceTime = computeFreshSlotTemps(1, null, [preset(0, 'PETG')], []);
    assert.deepEqual(atLoadTime, [220]);
    assert.deepEqual(atSliceTime, [235]);
  });
});
