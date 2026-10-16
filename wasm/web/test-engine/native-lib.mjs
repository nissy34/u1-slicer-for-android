// A NativeLibrary-shaped wrapper over the wasm engine for tests that drive the
// engine directly (the Kotlin instrumented tests call NativeLibrary.loadModel /
// slice / getModelInfo / getPreparePreviewMesh on files they built with the
// ported ThreeMfParser / BambuSanitizer / ProfileEmbedder). Files are written
// to the Emscripten FS; G-code is read back as text and the file removed.
import { sliceConfig, toNativeSliceConfig } from '../pipeline/slice-config.mjs';
import { engine } from './engine-helpers.mjs';

let serial = 0;

export class NativeLib {
  constructor(e) {
    this.e = e;
    e.FS.mkdirTree('/work');
  }

  static async create() {
    const lib = new NativeLib(await engine());
    lib.clearModel();
    return lib;
  }

  /** Write bytes to the wasm FS; the extension picks the importer like the app's cache file name. */
  write(bytes, name = 'model.3mf') {
    const path = `/work/lib${serial++}_${name.replace(/[^\w.+-]/g, '_')}`;
    this.e.FS.writeFile(path, bytes);
    return path;
  }

  /** NativeLibrary.loadModel(path) — all plates (plate_id 0). Accepts bytes or an FS path. */
  loadModel(bytesOrPath, name = 'model.3mf') {
    const path = typeof bytesOrPath === 'string' ? bytesOrPath : this.write(bytesOrPath, name);
    return this.e.loadModel(path, 0);
  }

  /** NativeLibrary.loadModelForPlate(path, plateIdx): plateIdx -1 = all, else plate_id = plateIdx + 1. */
  loadModelForPlate(bytesOrPath, plateIdx, name = 'model.3mf') {
    const path = typeof bytesOrPath === 'string' ? bytesOrPath : this.write(bytesOrPath, name);
    return this.e.loadModel(path, plateIdx >= 0 ? plateIdx + 1 : 0);
  }

  addModel(bytesOrPath, name = 'model.3mf') {
    const path = typeof bytesOrPath === 'string' ? bytesOrPath : this.write(bytesOrPath, name);
    return this.e.addModel(path, 0);
  }

  addModelForPlate(bytesOrPath, plateIdx, name = 'model.3mf') {
    const path = typeof bytesOrPath === 'string' ? bytesOrPath : this.write(bytesOrPath, name);
    return this.e.addModel(path, plateIdx >= 0 ? plateIdx + 1 : 0);
  }

  clearModel() { this.e.clearModel(); }

  getModelInfo() {
    const s = this.e.modelInfoJson();
    return s ? JSON.parse(s) : null;
  }

  getPreparePreviewMesh(maxTriangles = 0) { return this.e.previewMesh(maxTriangles); }

  setModelScale(x, y, z) { return this.e.setModelScale(x, y, z); }
  setModelRotation(x, y, z) { return this.e.setModelRotation(x, y, z); }
  setModelInstances(positions) { return this.e.setModelInstances(JSON.stringify([...positions])); }
  setObjectPositions(positions) { return this.e.setObjectPositions(JSON.stringify([...positions])); }
  objects() { return JSON.parse(this.e.objectsJson()); }
  getObjectBoundingBoxes() { return this.objects().flatMap((o) => o.size ?? []); }
  projectConfigValue(key) { return this.e.projectConfigValue(key); }

  /**
   * NativeLibrary.slice(SliceConfig): `cfg` is a camelCase Kotlin SliceConfig
   * (missing fields take the Kotlin defaults). Returns the SliceResult fields
   * plus `gcode` (text) when the slice succeeded.
   */
  slice(cfg) {
    const r = JSON.parse(this.e.slice(JSON.stringify(toNativeSliceConfig(sliceConfig(cfg))), null));
    const out = { ...r, errorMessage: r.error };
    if (r.success && r.gcodePath) {
      out.gcode = new TextDecoder().decode(this.e.FS.readFile(r.gcodePath));
      try { this.e.FS.unlink(r.gcodePath); } catch { /* already gone */ }
    }
    return out;
  }
}

/** The SliceConfig several Kotlin classes share (BambuPipelineIntegrationTest.BASE_CONFIG). */
export const BASE_CONFIG = Object.freeze({
  layerHeight: 0.2, firstLayerHeight: 0.2, perimeters: 2, topSolidLayers: 5, bottomSolidLayers: 4,
  fillDensity: 0.15, fillPattern: 'gyroid', printSpeed: 150, travelSpeed: 200, firstLayerSpeed: 50,
  nozzleTemp: 220, bedTemp: 65, nozzleDiameter: 0.4, filamentDiameter: 1.75, retractLength: 0.8,
  retractSpeed: 45, extruderCount: 1,
});
