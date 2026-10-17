// Mirrors app/src/test/java/com/u1/slicer/bambu/BambuSanitizerMetadataPreservationTest.kt.
// B77: BambuSanitizer.process must preserve per-object non-extruder metadata
// (enable_support, support_type, layer_height, seam_position, ...) from the source
// model_settings.config in its "no extruder rewrite needed" branch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipWriter, readZip, readEntryText } from '../pipeline/zip.mjs';
import { process } from '../pipeline/bambu-sanitizer.mjs';

/** Minimal Bambu 3MF (all entries STORED), like the Kotlin buildMinimalBambu3mf. */
function buildMinimalBambu3mf(modelSettingsXml, projectSettingsJson = '{"filament_colour":["#FFFFFF"]}') {
  const zip = new ZipWriter();
  const enc = (s) => new TextEncoder().encode(s);
  zip.stored('[Content_Types].xml', enc('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.stored('3D/3dmodel.model', enc('<?xml version="1.0"?><model xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><resources/></model>'));
  zip.stored('Metadata/project_settings.config', enc(projectSettingsJson));
  zip.stored('Metadata/model_settings.config', enc(modelSettingsXml));
  return zip.toBytes();
}

const readZipEntry = (bytes, name) => readEntryText(readZip(bytes), name);

test('preservesPerObjectEnableSupportMetadata', () => {
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="LOW POLY SENSORY TWIST BALL FIDGET.stl"/>
    <metadata key="enable_support" value="1"/>
    <metadata key="support_type" value="tree(manual)"/>
    <metadata key="support_on_build_plate_only" value="1"/>
    <metadata key="extruder" value="1"/>
  </object>
</config>`;
  const output = process(buildMinimalBambu3mf(modelSettings), { isBambu: true });
  const preserved = readZipEntry(output, 'Metadata/model_settings.config');
  assert.notEqual(preserved, null, 'Output must contain Metadata/model_settings.config');
  assert.ok(preserved.includes('key="enable_support" value="1"'),
    `Output model_settings.config must preserve per-object enable_support=1. Got:\n${preserved}`);
  assert.ok(preserved.includes('key="support_type" value="tree(manual)"'),
    `Output model_settings.config must preserve per-object support_type=tree(manual). Got:\n${preserved}`);
  assert.ok(preserved.includes('key="support_on_build_plate_only" value="1"'),
    `Output model_settings.config must preserve per-object support_on_build_plate_only=1. Got:\n${preserved}`);
});

test('preservesMetadataForSingleObjectSingleExtruder', () => {
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="test"/>
    <metadata key="seam_position" value="back"/>
    <metadata key="layer_height" value="0.12"/>
    <metadata key="extruder" value="1"/>
  </object>
</config>`;
  const output = process(buildMinimalBambu3mf(modelSettings), { isBambu: true });
  const preserved = readZipEntry(output, 'Metadata/model_settings.config');
  assert.notEqual(preserved, null, 'Output must retain model_settings.config');
  assert.ok(preserved.includes('key="seam_position" value="back"'), `seam_position override must survive. Got:\n${preserved}`);
  assert.ok(preserved.includes('key="layer_height" value="0.12"'), `layer_height override must survive. Got:\n${preserved}`);
});
