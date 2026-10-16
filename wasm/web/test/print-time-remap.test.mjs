// Mirrors, case by case:
//   app/src/test/java/com/u1/slicer/gcode/PrintTimeRemapTest.kt
//   app/src/test/java/com/u1/slicer/gcode/CanonicalExportMappingTest.kt
//   app/src/test/java/com/u1/slicer/data/SliceJobMappingResolutionTest.kt
// against wasm/web/pipeline/print-time-remap.mjs (port of gcode/PrintTimeRemap.kt).
// File paths become strings: "source stays intact" = the input string is unchanged,
// "out.readText()" = the returned string.
//   cd wasm/web && node --test test/print-time-remap.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { toIntOrNull } from '../pipeline/kt.mjs';
import {
  GcodeToolSpace,
  applyPrintTimeRemap,
  gcodeToolSpaceFromDb,
  gcodeToolSpaceToDb,
  resolveCanonicalExportMapping,
  resolveExportMappingForToolSpace,
  sendRemapForAction,
} from '../pipeline/print-time-remap.mjs';

// ---------------- PrintTimeRemapTest.kt ----------------

test('simple T-line remap produces remapped output without modifying source', () => {
  const original = 'T0\nG1 X10\nT1\nG1 Y20\nT2';
  const src = original;
  // colorMapping = [3, 2, 1] — file's filament 0 → slot 3, 1 → 2, 2 → 1.
  const out = applyPrintTimeRemap({ gcodeText: src, colorMapping: [3, 2, 1] });
  assert.equal(src.trimEnd(), original);
  assert.equal(out.trimEnd(), 'T3\nG1 X10\nT2\nG1 Y20\nT1');
});

test('M104 and M109 with T parameter are remapped', () => {
  const out = applyPrintTimeRemap({
    gcodeText: 'M104 S210 T0\nM109 S210 T1\nM104 S0 T2',
    colorMapping: [2, 0, 1],
  });
  assert.equal(out.trimEnd(), 'M104 S210 T2\nM109 S210 T0\nM104 S0 T1');
});

test('SM_ commands with EXTRUDER and INDEX are remapped', () => {
  const out = applyPrintTimeRemap({
    gcodeText: 'SM_PRINT_AUTO_FEED EXTRUDER=0\nSM_PRINT_FLOW_CALIBRATE INDEX=1',
    colorMapping: [3, 2],
  });
  assert.equal(out.trimEnd(), 'SM_PRINT_AUTO_FEED EXTRUDER=3\nSM_PRINT_FLOW_CALIBRATE INDEX=2');
});

test('identity mapping leaves T-lines unchanged', () => {
  const original = 'T0\nT1\nT2\nT3';
  const out = applyPrintTimeRemap({ gcodeText: original, colorMapping: [0, 1, 2, 3] });
  assert.equal(out.trimEnd(), original);
});

test('empty mapping copies source verbatim', () => {
  const original = 'T0\nG1 X10\n; some comment';
  const out = applyPrintTimeRemap({ gcodeText: original, colorMapping: [] });
  assert.equal(out.trimEnd(), original);
});

test('repeated apply with different mappings always reads source not previous output', () => {
  const original = 'T0\nT1\nT2';
  const src = original;
  const out1 = applyPrintTimeRemap({ gcodeText: src, colorMapping: [2, 1, 0] });
  const out2 = applyPrintTimeRemap({ gcodeText: src, colorMapping: [3, 0, 1] });
  assert.equal(out1.trimEnd(), 'T2\nT1\nT0');
  assert.equal(out2.trimEnd(), 'T3\nT0\nT1');
  assert.equal(src.trimEnd(), original);
});

test('out-of-bounds T-index in source falls back to itself', () => {
  const text = applyPrintTimeRemap({ gcodeText: 'T0\nT5\nT1', colorMapping: [3, 2, 1] });
  assert.ok(text.includes('T3'), 'T0 must remap to T3');
  assert.ok(text.includes('T2'), 'T1 must remap to T2');
  assert.ok(text.includes('T5'), 'T5 stays as T5 when out of bounds');
});

test('comments after T-line are preserved', () => {
  const out = applyPrintTimeRemap({ gcodeText: 'T0 ; switch to red', colorMapping: [2] });
  assert.equal(out.trimEnd(), 'T2');
});

// ---------------- CanonicalExportMappingTest.kt ----------------

test('fullCanonicalMapping_returnedAsIs', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 4, confirmedMapping: [2, 0, 1, 3], selectedExtruder: 0,
  });
  assert.deepEqual(result, [2, 0, 1, 3]);
});

test('plateNarrowedMapping_expandsToCanonicalSizeWithModFourFallback', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 10, confirmedMapping: [0, 1], selectedExtruder: 0,
  });
  assert.deepEqual(result, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
});

test('singleColourSelectedSlot_mapsT0ToSelectedExtruder', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 1, confirmedMapping: null, selectedExtruder: 2,
  });
  assert.deepEqual(result, [2]);
});

test('singleColourDefaultE1_mapsT0ToSlot0', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 1, confirmedMapping: null, selectedExtruder: 0,
  });
  assert.deepEqual(result, [0]);
});

test('singleColourSelectedExtruderClampedToPhysicalRange', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 1, confirmedMapping: null, selectedExtruder: 99,
  });
  assert.deepEqual(result, [3]);
});

test('noCanonicalContext_returnsNullForIdentityCopy', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 0, confirmedMapping: null, selectedExtruder: 0,
  });
  assert.equal(result, null);
});

test('B106_stlNonCanonical_selectedE3_mapsT0ToE3', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 0, confirmedMapping: null, selectedExtruder: 2,
  });
  assert.deepEqual(result, [2], 'B106: T0 must remap to T2 for STL with E3 selected');
});

test('B106_stlNonCanonical_selectedE4_mapsT0ToE4', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 0, confirmedMapping: null, selectedExtruder: 3,
  });
  assert.deepEqual(result, [3]);
});

test('B106_stlNonCanonical_selectedE1_returnsNullIdentity', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 0, confirmedMapping: null, selectedExtruder: 0,
  });
  assert.equal(result, null, 'B106: E1 default on STL must stay null (identity)');
});

test('B106_stlNonCanonical_selectedE2_mapsT0ToE2', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 0, confirmedMapping: null, selectedExtruder: 1,
  });
  assert.deepEqual(result, [1]);
});

test('multiColourNoMappingYet_fallsBackToIdentityModFour', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 5, confirmedMapping: null, selectedExtruder: 0,
  });
  assert.deepEqual(result, [0, 1, 2, 3, 0]);
});

test('emptyConfirmedMapping_treatedAsAbsent', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 4, confirmedMapping: [], selectedExtruder: 0,
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
});

test('confirmedMappingLargerThanCanonical_truncatesToCanonical', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 3, confirmedMapping: [2, 0, 1, 3, 0], selectedExtruder: 0,
  });
  assert.deepEqual(result, [2, 0, 1]);
});

test('plateNarrowedMappingExactlyMatchesCanonical_returnedAsIs', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 4, confirmedMapping: [0, 1, 2, 3], selectedExtruder: 0,
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
});

test('plateNarrowedMappingWithFileIndexKeys_appliesAtCorrectCanonicalIndices', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 10,
    confirmedMapping: [1, 0],
    selectedExtruder: 0,
    confirmedMappingFileIndices: [7, 8], // plate uses canonical fileIdx 7 + 8
  });
  assert.equal(result?.[7], 1);
  assert.equal(result?.[8], 0);
  assert.equal(result?.[0], 0); // 0 % 4
  assert.equal(result?.[1], 1);
  assert.equal(result?.[2], 2);
  assert.equal(result?.[3], 3);
});

test('plateNarrowedMappingWithFileIndexKeys_outOfRangeFileIdxIgnored', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 4,
    confirmedMapping: [0, 1, 2],
    selectedExtruder: 0,
    confirmedMappingFileIndices: [0, 1, 99], // last entry out of range
  });
  assert.equal(result?.[0], 0);
  assert.equal(result?.[1], 1);
  assert.equal(result?.[2], 2);
});

test('confirmedMappingValuesClampedToPhysicalRange', () => {
  const result = resolveCanonicalExportMapping({
    canonicalSize: 3, confirmedMapping: [99, -5, 7], selectedExtruder: 0,
  });
  assert.deepEqual(result, [3, 0, 3]);
});

test('sendRemap_uploadOnly_returnsEmptyMappingForCanonicalBody', () => {
  const result = sendRemapForAction({ uploadOnly: true, physicalMapping: [1, 2, 3, 0] });
  assert.deepEqual(result, []);
});

test('sendRemap_printAndUpload_keepsPhysicalMapping', () => {
  const result = sendRemapForAction({ uploadOnly: false, physicalMapping: [1, 2, 3, 0] });
  assert.deepEqual(result, [1, 2, 3, 0]);
});

test('uploadOnly_emptyMapping_preservesCanonicalToolIndices', () => {
  const body = 'T0\nG1 X1\nM104 T1 S200\nT1\nSM_PRINT_AUTO_FEED EXTRUDER=0\n';
  const mapping = sendRemapForAction({ uploadOnly: true, physicalMapping: [1, 2, 3, 0] });
  const out = applyPrintTimeRemap({ gcodeText: body, colorMapping: mapping });
  assert.equal(out, body);
});

test('printAndUpload_physicalMapping_rewritesToolIndices', () => {
  const mapping = sendRemapForAction({ uploadOnly: false, physicalMapping: [1, 0] });
  const out = applyPrintTimeRemap({ gcodeText: 'T0\nT1\n', colorMapping: mapping });
  assert.equal(out, 'T1\nT0\n');
});

test('physicalToolSpaceExport_returnsNullSoSaveShareCopyVerbatim', () => {
  const result = resolveExportMappingForToolSpace({
    toolSpace: GcodeToolSpace.PHYSICAL,
    canonicalSize: 4,
    confirmedMapping: [3, 2, 1, 0],
    selectedExtruder: 0,
  });
  assert.equal(result, null);
});

test('canonicalToolSpaceExport_stillResolvesCanonicalMapping', () => {
  const result = resolveExportMappingForToolSpace({
    toolSpace: GcodeToolSpace.CANONICAL,
    canonicalSize: 4,
    confirmedMapping: [3, 2, 1, 0],
    selectedExtruder: 0,
  });
  assert.deepEqual(result, [3, 2, 1, 0]);
});

test('uploadOnly_physicalToolSpaceKeepsPhysicalMappingAvailable', () => {
  const result = sendRemapForAction({
    uploadOnly: true,
    physicalMapping: [0, 1, 2, 3],
    sourceToolSpace: GcodeToolSpace.PHYSICAL,
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
});

// ---------------- SliceJobMappingResolutionTest.kt ----------------
// Test-local port of the three tiny helpers from data/SliceJob.kt that the
// Kotlin test exercises (decodedColorMapping, storedGcodeIsPhysical,
// resolveExportMapping); the SliceJob Room entity becomes a plain object.

function decodedColorMapping(job) {
  const csv = job.colorMappingCsv;
  if (csv == null || csv.trim() === '') return null;
  const list = csv.split(',').map((s) => toIntOrNull(s.trim())).filter((v) => v != null);
  return list.length > 0 ? list : null;
}

function storedGcodeIsPhysical(job) {
  return gcodeToolSpaceFromDb(job.gcodeToolSpace) === GcodeToolSpace.PHYSICAL
    || (job.gcodeToolSpace == null && job.canonicalListSize == null);
}

function resolveExportMapping(job) {
  const toolSpace = storedGcodeIsPhysical(job) ? GcodeToolSpace.PHYSICAL : GcodeToolSpace.CANONICAL;
  return resolveExportMappingForToolSpace({
    toolSpace,
    canonicalSize: job.canonicalListSize ?? 0,
    confirmedMapping: decodedColorMapping(job),
    selectedExtruder: job.selectedExtruderAtSlice ?? 0,
  });
}

const resolveForJob = (job) => resolveExportMapping(job);

function jobOf({
  canonicalListSize = null,
  colorMappingCsv = null,
  selectedExtruderAtSlice = null,
  gcodeToolSpace = null,
} = {}) {
  return {
    modelName: 'fixture',
    gcodePath: '/tmp/x.gcode',
    totalLayers: 1,
    estimatedTimeSeconds: 1,
    estimatedFilamentMm: 1,
    layerHeight: 0.2,
    fillDensity: 20,
    nozzleTemp: 220,
    bedTemp: 60,
    supportEnabled: false,
    filamentType: 'PLA',
    canonicalListSize,
    colorMappingCsv,
    selectedExtruderAtSlice,
    gcodeToolSpace,
  };
}

test('preePhase2Job_noCanonicalSize_resolvesToNullForIdentityCopy', () => {
  const job = jobOf({ canonicalListSize: null });
  assert.equal(resolveForJob(job), null);
});

test('physicalToolSpaceJob_resolvesToNullForIdentityCopyEvenWithCanonicalMetadata', () => {
  const job = jobOf({
    canonicalListSize: 4,
    colorMappingCsv: '3,2,1,0',
    selectedExtruderAtSlice: 0,
    gcodeToolSpace: gcodeToolSpaceToDb(GcodeToolSpace.PHYSICAL),
  });
  assert.equal(resolveForJob(job), null);
});

test('canonicalToolSpaceJob_resolvesStoredCanonicalMapping', () => {
  const job = jobOf({
    canonicalListSize: 4,
    colorMappingCsv: '3,2,1,0',
    selectedExtruderAtSlice: 0,
    gcodeToolSpace: gcodeToolSpaceToDb(GcodeToolSpace.CANONICAL),
  });
  assert.deepEqual(resolveForJob(job), [3, 2, 1, 0]);
});

test('singleColourJob_e3SelectedAtSlice_remapsT0ToSlot2', () => {
  const job = jobOf({ canonicalListSize: 1, colorMappingCsv: null, selectedExtruderAtSlice: 2 });
  assert.deepEqual(resolveForJob(job), [2]);
});

test('singleColourJob_nullSelectedAtSlice_falsBackToSlot0', () => {
  const job = jobOf({ canonicalListSize: 1, colorMappingCsv: null, selectedExtruderAtSlice: null });
  assert.deepEqual(resolveForJob(job), [0]);
});

test('multiColourJob_canonicalWideCsv_returnedAsIs', () => {
  const job = jobOf({
    canonicalListSize: 13,
    colorMappingCsv: '0,1,2,3,1,1,2,0,3,1,2,3,0',
    selectedExtruderAtSlice: 0,
  });
  const mapping = resolveForJob(job);
  assert.equal(mapping?.length, 13);
  assert.equal(mapping?.[4], 1);
  assert.equal(mapping?.[7], 0);
  assert.equal(mapping?.[0], 0);
  assert.equal(mapping?.[1], 1);
  assert.equal(mapping?.[2], 2);
  assert.equal(mapping?.[3], 3);
});

test('multiColourJob_nullCsv_fallsBackToIdentityModFour', () => {
  const job = jobOf({ canonicalListSize: 5, colorMappingCsv: null, selectedExtruderAtSlice: null });
  assert.deepEqual(resolveForJob(job), [0, 1, 2, 3, 0]);
});

test('legacyPlateNarrowedCsv_smallerThanCanonical_documentsKnownLimitation', () => {
  const job = jobOf({ canonicalListSize: 13, colorMappingCsv: '0,1', selectedExtruderAtSlice: 0 });
  const mapping = resolveForJob(job);
  assert.equal(mapping?.length, 13);
  assert.equal(mapping?.[0], 0);
  assert.equal(mapping?.[1], 1);
  assert.equal(mapping?.[2], 2);
  assert.equal(mapping?.[3], 3);
});

test('multiColourJob_canonicalWideCsv_clampsOutOfRangeSlots', () => {
  const job = jobOf({ canonicalListSize: 4, colorMappingCsv: '99,-5,1,2', selectedExtruderAtSlice: 0 });
  assert.deepEqual(resolveForJob(job), [3, 0, 1, 2]);
});

test('multiColourJob_blankCsv_treatedAsAbsent', () => {
  const job = jobOf({ canonicalListSize: 3, colorMappingCsv: '', selectedExtruderAtSlice: 0 });
  assert.deepEqual(resolveForJob(job), [0, 1, 2]);
});
