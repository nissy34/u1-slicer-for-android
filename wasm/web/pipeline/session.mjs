// The app's model pipeline, driven against the wasm engine: the parts of
// SlicerViewModel.kt that chain the ported classes together, kept in the same
// order and with the same state so a file behaves as it does in the app.
//
//   loadModel(name, bytes)            loadModelFromFile + prepareImportedModelArtifacts
//                                     (ThreeMfParser -> BambuSanitizer -> embedProfile
//                                     [ProfileEmbedder]) + loadNativeModel
//   selectPlate(plateId)              selectPlate (multi-plate 3MFs)
//   setColorMapping / setSelectedExtruder   applyMultiColorAssignments / updateSingleColorExtruder
//   setModelScale / setModelRotation / setCopyCount / setPlacement / autoArrange /
//   splitObject / duplicateObject / setObjectRotation / setObjectScale / addModel
//                                     Prepare-screen editing (F66/F77/F92)
//   slice(onProgress)                 startSlicing: re-embed + reload + replay edits,
//                                     placement, SliceConfig resolution, native slice,
//                                     B63/B110 header patches, layer-tool pauses,
//                                     thumbnails; then exportGcode() applies the
//                                     canonical -> physical slot mapping (PrintTimeRemap)
//
// Runs wherever the engine runs (browser worker, Node). `engine` is the
// Emscripten module (wasm/src/wasm_api.cpp); `profiles` are the parsed
// orca_profiles printer/process/filament JSONs ProfileEmbedder loads from assets.
import { process as sanitize } from './bambu-sanitizer.mjs';
import { bambuFileColourList, FilamentSource } from './canonical-filament-list.mjs';
import { bambuCanonicalList, canonicalListAtLoad } from './canonical-list-at-load.mjs';
import * as Arrange from './copy-arrange-calculator.mjs';
import { computeEmbedTargetCount } from './embed-target.mjs';
import { defaultExtruderPresets, nozzleTempDefaultForMaterial } from './extruder-preset.mjs';
import { inject as injectThumbnails } from './gcode-thumbnail-injector.mjs';
import { injectFrom3mf } from './layer-tool-pause-injector.mjs';
import { buildPreviewSlotColors, mergeThreeMfInfo } from './merge-three-mf-info.mjs';
import { ensureMultiSlotMapping, findClosestExtruder } from './multi-color-mapping.mjs';
import { buildThreeMfInfoFromNative, readPlateStateFromNative } from './native-plate-state.mjs';
import { applyPrintTimeRemap, GcodeToolSpace, resolveExportMappingForToolSpace } from './print-time-remap.mjs';
import { ProfileEmbedder } from './profile-embedder.mjs';
import {
  applyNonCanonicalOverride, buildFilamentLibraryArrays, buildFilamentLibrarySettings, buildProfileOverrides,
  computeFreshSlotTemps, fixFilamentTypeHeader, fixNozzleTemperatureHeader, resolveFilamentTypeForSingleColorLoad,
  resolveFilamentTypeLabelFromMapping, resolveFilamentTypesForHeaderPatch, resolveNonCanonicalHeaderPatchTemps,
  resolveNonCanonicalHeaderPatchTypes, resolveNozzleTempsForHeaderPatch,
} from './profile-overrides.mjs';
import { sliceConfig, toNativeSliceConfig } from './slice-config.mjs';
import { OverrideMode, resolveInto, resolvePrimeTower, slicingOverrides } from './slicing-overrides.mjs';
import { inspectArchiveSizing, parse as parseThreeMf } from './three-mf-parser.mjs';
import { copyThreeMfInfo } from './three-mf-info.mjs';
import { estimateDepth, resolveWipeTowerDepth, resolveWipeTowerWidth, wipeTowerClampBounds } from './wipe-tower.mjs';
import { readZip } from './zip.mjs';

const TARGET_SLOTS = 4; // SegmentationCascade.TARGET_SLOTS — U1 physical extruders
const WORK = '/work';

const sanitizeName = (name) => name.replace(/[^\w.+-]/g, '_');
const isThreeMf = (name) => /\.3mf$/i.test(name);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class SlicerSession {
  /**
   * @param {object} o
   * @param {object} o.engine     Emscripten module from createU1Slicer()
   * @param {{printer, process, filament}} o.profiles  parsed orca_profiles JSONs
   * @param {(line: string) => void} [o.log]
   */
  constructor({ engine, profiles, log = () => {} }) {
    this.engine = engine;
    this.profiles = profiles;
    this.log = log;
    this.embedder = new ProfileEmbedder({ ...profiles });
    engine.FS.mkdirTree(WORK);
    // ---- user settings (persisted by the page) ----
    this.presets = defaultExtruderPresets();      // extruderPresets
    this.filaments = [];                          // filament library (per-slot temp overrides only)
    this.config = sliceConfig();                  // _config
    this.overrides = slicingOverrides();          // slicingOverrides
    this.filamentOverrides = new Map();           // _filamentOverrides (fileIndex -> {color, materialType})
    this.thumbnailCodec = undefined;              // GcodeThumbnailInjector codec (default auto)
    this.#resetModelState();
  }

  #resetModelState() {
    this.rawName = null;
    this.rawBytes = null;               // rawInputFile
    this.sourceModelBytes = null;       // sourceModelFile (sanitized 3MF) — null for STL/OBJ/STEP
    this.sourceModelInfo = null;
    this.currentModelBytes = null;      // currentModelFile (what the engine loaded)
    this.threeMfInfo = null;            // _threeMfInfo (plate-narrowed)
    this.fileThreeMfInfo = null;        // _fileThreeMfInfo
    this.sourceConfig = null;           // _sourceConfig
    this.canonical = null;              // _canonicalFilamentList
    this.multiPlatePlates = [];
    this.currentPlateId = -1;           // recoveryPlateId / _currentPlateId
    this.colorMapping = null;           // _colorMapping
    this.selectedExtruder = 0;          // _selectedExtruder
    this.toolRemapSlots = null;
    this.activeExtruderColors = [];
    this.layerToolOnly = false;
    this.modelInfo = null;              // lastModelInfo
    this.filamentOverrides = new Map();
    // Prepare-screen edits (replayed after every re-embed reload, like the app)
    this.copyCount = 1;
    this.modelScale = { x: 1, y: 1, z: 1 };
    this.modelRotation = { x: 0, y: 0, z: 0 };
    this.customObjectPositions = null;  // Float32Array [x0,y0,...] lower-left per object / copy
    this.customWipeTowerPos = null;
    this.multiObject = false;           // hasMultipleDistinctObjectsVar
    this.perObjectPoses = new Map();    // objIdx -> {rot:[x,y,z], scale:[x,y,z]}
    this.splitObjectOps = [];
    this.duplicateOps = [];
    this.additionalFiles = [];          // [{path, plateIdx}]
    this.perVolumeExtruders = new Map(); // "o:v" -> 1-based slot
    this.sliceSerial = 0;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /** Per-slot nozzle-temperature overrides go through the app's filament-library path. */
  setPresets(presets, slotTemps = []) {
    this.filaments = [];
    this.presets = presets.map((p) => {
      const t = slotTemps[p.index];
      if (t == null || t === nozzleTempDefaultForMaterial(p.materialType)) return { ...p, filamentProfileId: null };
      const id = 1000 + p.index;
      this.filaments.push({ id, name: `E${p.index + 1}`, material: p.materialType, nozzleTemp: Math.trunc(t) });
      return { ...p, filamentProfileId: id };
    });
    if (this.modelInfo) this.#refreshSlotState();
  }

  #refreshSlotState() {
    if (this.colorMapping) this.applyMultiColorAssignments(this.colorMapping);
    else this.#updateSingleColorExtruder(this.selectedExtruder);
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  /**
   * loadModelFromFile. Returns the load summary; `needsPlateSelection` means the
   * caller must pick one of `plates` with selectPlate(plateId).
   */
  loadModel(name, bytes) {
    this.#resetModelState();
    this.engine.clearModel();
    this.rawName = name;
    this.rawBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let firstBambuPlateId = null;
    let fileToLoad;
    if (isThreeMf(name)) {
      let entries;
      try { entries = readZip(this.rawBytes); } catch (e) { throw new Error(`3MF file is corrupt: ${e.message}`); }
      if (!entries.length) throw new Error('3MF file is empty or invalid');
      const prepared = this.#prepareImportedModelArtifacts();
      if (prepared.requiresPlateSelection) {
        this.currentModelBytes = prepared.embedded;
        return { ...this.summary(), needsPlateSelection: true };
      }
      if (prepared.origInfo.isBambu && prepared.mergedInfo.plates.length) firstBambuPlateId = prepared.mergedInfo.plates[0].plateId;
      fileToLoad = prepared.embedded;
    } else {
      fileToLoad = this.rawBytes;
    }
    this.currentModelBytes = fileToLoad;
    this.#loadNativeModel(fileToLoad, name);
    if (firstBambuPlateId != null) this.currentPlateId = firstBambuPlateId;
    return { ...this.summary(), needsPlateSelection: false };
  }

  #prepareImportedModelArtifacts() {
    const raw = this.rawBytes;
    const name = this.rawName;
    const archiveSizingRisk = inspectArchiveSizing(raw, { name });
    let origInfo;
    if (archiveSizingRisk != null) {
      const probe = parseThreeMf(raw, { skipPaintDetection: true, name });
      origInfo = copyThreeMfInfo(probe, { hasPaintData: probe.detectedColors.length > 1 || probe.hasLayerToolChanges });
    } else {
      origInfo = parseThreeMf(raw, { name });
    }
    this.sourceConfig = origInfo.isBambu ? this.embedder.parseSourceConfig(raw) : null;
    const processed = sanitize(raw, { isBambu: !!origInfo.isBambu });
    const processedInfo = parseThreeMf(processed, { skipPaintDetection: true, name });
    const mergedInfo = mergeThreeMfInfo(processedInfo, origInfo);
    this.threeMfInfo = mergedInfo;
    this.fileThreeMfInfo = mergedInfo;
    this.multiPlatePlates = origInfo.isMultiPlate ? mergedInfo.plates : [];
    this.sourceModelBytes = processed;
    this.sourceModelInfo = processedInfo;
    this.#resetToolRemapState();
    this.canonical = this.#loadCanonical();
    const canonicalForEmbed = origInfo.isBambu && archiveSizingRisk != null ? bambuFileColourList(raw) : null;
    // B93: multi-plate files embed only after a plate is picked.
    const requiresPlateSelection = !!origInfo.isMultiPlate && mergedInfo.plates.length > 1;
    const embedded = requiresPlateSelection ? processed : this.#embedProfile(processed, mergedInfo, {
      // B101: single-plate Bambu files are filtered to their plate.
      plateId: origInfo.isBambu && mergedInfo.plates.length ? mergedInfo.plates[0].plateId : null,
      canonicalForEmbed,
    });
    return { origInfo, mergedInfo, embedded, requiresPlateSelection };
  }

  /** refreshCanonicalFilamentList / getCanonicalFilamentList (from the raw input, which keeps project_settings). */
  #loadCanonical() {
    try {
      return bambuCanonicalList(this.rawBytes) ?? canonicalListAtLoad(this.rawBytes, this.rawName);
    } catch (e) {
      this.log(`canonicalListAtLoad failed: ${e.message}`);
      return null;
    }
  }

  /** selectPlate: embed only that plate, load it, derive plate state from the engine. */
  selectPlate(plateId) {
    if (!this.sourceModelBytes) throw new Error('No multi-plate model loaded');
    this.currentPlateId = plateId;
    this.copyCount = 1;
    this.customObjectPositions = null;
    this.customWipeTowerPos = null;
    this.multiObject = false;
    this.perObjectPoses = new Map();
    this.splitObjectOps = [];
    this.duplicateOps = [];
    this.additionalFiles = [];
    this.perVolumeExtruders = new Map();
    this.modelScale = { x: 1, y: 1, z: 1 };
    this.modelRotation = { x: 0, y: 0, z: 0 };
    const fileInfo = this.fileThreeMfInfo ?? this.threeMfInfo;
    this.#resetToolRemapState();
    const embedded = this.#embedProfile(this.sourceModelBytes, fileInfo, { plateId });
    this.currentModelBytes = embedded;
    this.#loadNativeModel(embedded, this.rawName, () => {
      const nativeState = readPlateStateFromNative(this.engine);
      this.threeMfInfo = buildThreeMfInfoFromNative(fileInfo, nativeState, plateId, this.canonical);
    });
    return { ...this.summary(), needsPlateSelection: false };
  }

  #writeWork(name, bytes) {
    const path = `${WORK}/${sanitizeName(name)}`;
    this.engine.FS.writeFile(path, bytes);
    return path;
  }

  /** loadNativeModel: engine load, then the B47 colour-mapping / extruder-count setup. */
  #loadNativeModel(bytes, name, postLoadStateProvider = null) {
    this.engine.clearModel();
    const path = this.#writeWork(`model_${name}`, bytes);
    if (!this.engine.loadModel(path, 0)) throw new Error(`Failed to load model ${name}`);
    postLoadStateProvider?.();
    const info = JSON.parse(this.engine.modelInfoJson());
    this.modelInfo = info;
    this.modelScale = { x: 1, y: 1, z: 1 };
    this.modelRotation = { x: 0, y: 0, z: 0 };
    const mf = this.threeMfInfo;
    const fullSpectrumPhysical = mf?.fullSpectrumPhysicalCount;
    if (mf && fullSpectrumPhysical != null && fullSpectrumPhysical > 1) {
      // M3-B full-spectrum: identity mapping over the declared physical filaments.
      const slotCount = Math.min(Math.max(fullSpectrumPhysical, 1), 4);
      const identity = range(slotCount);
      this.colorMapping = identity;
      this.layerToolOnly = false;
      this.#autoPlaceTower(info, slotCount);
      this.applyMultiColorAssignments(identity);
    } else if (mf && mf.detectedExtruderCount > 1) {
      const layerToolOnly = mf.hasLayerToolChanges && !mf.hasPaintData && !mf.hasMultiExtruderAssignments;
      const raw = mf.detectedColors.map((c) => findClosestExtruder(c, this.presets)?.index ?? 0);
      const initialMapping = ensureMultiSlotMapping(raw, mf.detectedColors.length);
      if (layerToolOnly) {
        // Hueforge-style layer-change files slice single-filament; colour swaps become pauses.
        this.colorMapping = initialMapping;
        const previewSlots = [...new Set(initialMapping)].sort((a, b) => a - b);
        this.activeExtruderColors = buildPreviewSlotColors(this.presets, previewSlots);
        this.selectedExtruder = 0;
        this.#resetToolRemapState();
        this.customWipeTowerPos = null;
        this.config = { ...this.config, extruderCount: 1, wipeTowerEnabled: false,
          filamentType: resolveFilamentTypeLabelFromMapping(initialMapping, this.presets) };
        this.layerToolOnly = true;
      } else {
        const slotCount = Math.min(Math.max(mf.detectedExtruderCount, 1), 4);
        this.#autoPlaceTower(info, slotCount);
        this.colorMapping = initialMapping;
        this.layerToolOnly = false;
        this.applyMultiColorAssignments(initialMapping);
      }
    } else {
      this.colorMapping = null;
      this.layerToolOnly = false;
      this.selectedExtruder = 0;
      this.#resetToolRemapState();
      this.customWipeTowerPos = null;
      this.config = { ...this.config, extruderCount: 1, wipeTowerEnabled: false,
        filamentType: resolveFilamentTypeForSingleColorLoad(this.presets),
        extruderTemps: [this.#singleColorTemp(0)] };
      this.activeExtruderColors = range(4).map((i) => this.presets.find((p) => p.index === i)?.color ?? '');
    }
    this.#placeInEngine();
  }

  #autoPlaceTower(info, slotCount) {
    const positions = Arrange.calculate(info.sizeX, info.sizeY, this.copyCount, this.config.bedSizeX, this.config.bedSizeY);
    const depth = estimateDepth(info.sizeZ);
    const tower = Arrange.computeWipeTowerPosition(positions, info.sizeX, info.sizeY, this.config.wipeTowerWidth, depth,
      this.config.bedSizeX, this.config.bedSizeY);
    this.config = { ...this.config, extruderCount: slotCount, wipeTowerEnabled: true, wipeTowerX: tower[0], wipeTowerY: tower[1] };
    this.customWipeTowerPos = tower;
  }

  #resetToolRemapState() { this.toolRemapSlots = null; }

  #singleColorTemp(index) {
    const preset = this.presets.find((p) => p.index === index);
    return this.filaments.find((f) => f.id === preset?.filamentProfileId)?.nozzleTemp
      ?? nozzleTempDefaultForMaterial(preset?.materialType ?? 'PLA');
  }

  // ---------------------------------------------------------------------------
  // Colours -> extruders
  // ---------------------------------------------------------------------------

  /** applyMultiColorAssignments(modelColorToExtruder). */
  applyMultiColorAssignments(modelColorToExtruder) {
    this.colorMapping = modelColorToExtruder.slice();
    const usedSlots = [...new Set(modelColorToExtruder)].sort((a, b) => a - b);
    const slotCount = Math.min(Math.max(usedSlots.length, 1), 4);
    const hasPaintData = this.threeMfInfo?.hasPaintData === true;
    const distinctPhysical = new Set(modelColorToExtruder).size;
    const isH2cStyle = hasPaintData && distinctPhysical >= 4 && modelColorToExtruder.length > distinctPhysical;
    if (isH2cStyle) {
      this.toolRemapSlots = null; // B48: H2C slices already produce physical tools
    } else {
      const compact = usedSlots.slice(0, slotCount);
      this.toolRemapSlots = sameList(compact, range(slotCount)) ? null : compact;
    }
    const temps = range(slotCount).map((i) => {
      const slotIndex = usedSlots[i] ?? i;
      const preset = this.presets.find((p) => p.index === slotIndex);
      return this.filaments.find((f) => f.id === preset?.filamentProfileId)?.nozzleTemp
        ?? nozzleTempDefaultForMaterial(preset?.materialType ?? 'PLA');
    });
    const filamentLabel = resolveFilamentTypeLabelFromMapping(modelColorToExtruder, this.presets);
    const mi = this.modelInfo;
    const base = {
      extruderCount: slotCount,
      extruderTemps: temps,
      extruderRetractLength: Array(slotCount).fill(this.config.retractLength),
      extruderRetractSpeed: Array(slotCount).fill(this.config.retractSpeed),
      filamentType: filamentLabel,
    };
    if (slotCount > 1 && mi && mi.sizeX > 0 && this.customWipeTowerPos == null) {
      const objPos = Arrange.calculate(mi.sizeX, mi.sizeY, this.copyCount, this.config.bedSizeX, this.config.bedSizeY);
      const tower = Arrange.computeWipeTowerPosition(objPos, mi.sizeX, mi.sizeY, this.config.wipeTowerWidth, undefined,
        this.config.bedSizeX, this.config.bedSizeY);
      this.config = { ...this.config, ...base, wipeTowerEnabled: true, wipeTowerX: tower[0], wipeTowerY: tower[1] };
      this.customWipeTowerPos = tower;
    } else {
      this.config = { ...this.config, ...base, wipeTowerEnabled: slotCount > 1 };
    }
    this.activeExtruderColors = buildPreviewSlotColors(this.presets, usedSlots);
  }

  /** setSelectedExtruder (single-colour models: E1..E4). */
  setSelectedExtruder(index) {
    this.selectedExtruder = index;
    this.#updateSingleColorExtruder(index);
  }

  #updateSingleColorExtruder(index) {
    const preset = this.presets.find((p) => p.index === index);
    const colors = ['', '', '', ''];
    colors[0] = preset?.color || ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'][index];
    this.activeExtruderColors = colors;
    this.toolRemapSlots = index === 0 ? null : [index];
    this.config = { ...this.config, extruderCount: 1, wipeTowerEnabled: false,
      filamentType: preset?.materialType ?? 'PLA', extruderTemps: [this.#singleColorTemp(index)] };
  }

  /** Per-file-filament material/colour override (Prepare screen, Phase 2.6b). */
  setFilamentOverride(fileIndex, { color = null, materialType = null } = {}) {
    if (color == null && materialType == null) this.filamentOverrides.delete(fileIndex);
    else this.filamentOverrides.set(fileIndex, { color, materialType });
  }

  // ---------------------------------------------------------------------------
  // embedProfile
  // ---------------------------------------------------------------------------

  #embedProfile(fileBytes, info, { plateId = null, canonicalForEmbed = null } = {}) {
    const cfg = this.config;
    const slotCount = Math.max(cfg.extruderCount, 1);
    const usedSlots = this.toolRemapSlots;
    const maxSourceFilamentIndex = info.usedExtruderIndices?.size ? Math.max(...info.usedExtruderIndices) : 0;
    const computedTarget = computeEmbedTargetCount({
      colorMapping: this.colorMapping, hasPaintData: !!info.hasPaintData, toolRemapSlots: usedSlots,
      fallbackExtCount: slotCount, hasMultiExtruderAssignments: !!info.hasMultiExtruderAssignments,
      maxSourceFilamentIndex,
    });
    const canonicalList = canonicalForEmbed ?? this.canonical;
    const canonicalSize = canonicalList ? canonicalList.filaments.filter((f) => f.source !== FilamentSource.PAINT_DERIVED).length : 0;
    const ov = this.overrides;
    const maxSupportSlot = Math.max(
      ov.supportFilament.mode === OverrideMode.OVERRIDE ? ov.supportFilament.value ?? 0 : 0,
      ov.supportInterfaceFilament.mode === OverrideMode.OVERRIDE ? ov.supportInterfaceFilament.value ?? 0 : 0);
    const targetCount = Math.max(computedTarget, canonicalSize, maxSupportSlot);
    const sourceConfig = this.sourceConfig ?? (info.isBambu ? this.embedder.parseSourceConfig(fileBytes) : null);
    const filamentSettings = buildFilamentLibrarySettings(slotCount, usedSlots, this.presets, this.filaments);
    const profileOverrides = buildProfileOverrides({
      cfg, overrides: ov, slotCount: targetCount, usedSlots, hasSourceConfig: sourceConfig != null,
      canonical: canonicalForEmbed, presets: this.presets, filamentOverrides: this.filamentOverrides,
      colorMapping: this.colorMapping, filaments: this.filaments, fallbackCanonical: this.canonical,
    });
    const embeddedConfig = this.embedder.buildConfig({
      info, sourceConfig, filamentSettings, overrides: profileOverrides, targetExtruderCount: targetCount,
    });
    this.lastEmbeddedConfig = embeddedConfig;
    return this.embedder.embed(fileBytes, embeddedConfig, info, null, plateId);
  }

  // ---------------------------------------------------------------------------
  // Prepare-screen editing
  // ---------------------------------------------------------------------------

  objects() { return JSON.parse(this.engine.objectsJson()); }

  /** Footprint of one copy (currentCopyFootprint / effectivePlacementFootprint). */
  copyFootprint() {
    const mi = this.modelInfo;
    if (!mi || mi.sizeX <= 0 || mi.sizeY <= 0) return null;
    const s = this.modelScale;
    const r = this.modelRotation;
    return Arrange.effectivePlacementFootprint(this.rotatedMeshSizeXY ?? null, mi.sizeX, mi.sizeY, mi.sizeZ,
      s.x, s.y, r.x, r.y, r.z);
  }

  /** getPlacementPositions(). */
  placementPositions() {
    if (this.customObjectPositions) return this.customObjectPositions;
    const { bedSizeX, bedSizeY } = this.config;
    const fp = this.copyFootprint();
    if (!fp) return new Float32Array([bedSizeX / 2, bedSizeY / 2]);
    return Arrange.calculate(fp[0], fp[1], this.copyCount, bedSizeX, bedSizeY);
  }

  copyBedWarning() {
    const fp = this.copyFootprint();
    return fp ? Arrange.copyBedWarning(fp[0], fp[1], this.copyCount, this.config.bedSizeX, this.config.bedSizeY) : null;
  }

  /** Applies scale/rotation + placement to the engine (the slice path's order). */
  #placeInEngine() {
    const e = this.engine;
    const s = this.modelScale;
    const r = this.modelRotation;
    if (!this.multiObject) {
      e.setModelScale(s.x, s.y, s.z);
      e.setModelRotation(r.x, r.y, r.z);
      this.#measureRotatedMesh();
    }
    if (this.multiObject && this.customObjectPositions) {
      e.setObjectPositions(JSON.stringify([...this.customObjectPositions]));
    } else if (this.modelInfo?.sizeX > 0) {
      e.setModelInstances(JSON.stringify([...this.placementPositions()]));
    }
  }

  /** The rotated (unscaled) group footprint, the app's setRotatedMeshSize from the cached preview mesh. */
  #measureRotatedMesh() {
    const objs = this.objects();
    if (!objs.length || objs.some((o) => !o.size || !o.min)) { this.rotatedMeshSizeXY = null; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of objs) {
      x0 = Math.min(x0, o.min[0]); y0 = Math.min(y0, o.min[1]);
      x1 = Math.max(x1, o.min[0] + o.size[0]); y1 = Math.max(y1, o.min[1] + o.size[1]);
    }
    const s = this.modelScale;
    // With copies already instanced the group box spans all of them; use one object's box then.
    const single = objs.length === 1 && objs[0].instances <= 1;
    const w = single || objs.every((o) => o.instances <= 1) ? x1 - x0 : objs[0].size[0];
    const h = single || objs.every((o) => o.instances <= 1) ? y1 - y0 : objs[0].size[1];
    this.rotatedMeshSizeXY = [w / s.x, h / s.y];
  }

  setModelScale(x, y, z) {
    if (this.multiObject) {
      for (let i = 0; i < this.engine.objectCount(); i++) this.setObjectScale(i, x, y, z);
      return;
    }
    this.modelScale = { x, y, z };
    this.customObjectPositions = null;
    this.#placeInEngine();
  }

  setModelRotation(x, y, z) {
    if (this.multiObject) return;
    this.modelRotation = { x, y, z };
    this.customObjectPositions = null;
    this.#placeInEngine();
  }

  setCopyCount(n) {
    if (this.multiObject) return;
    this.copyCount = Math.min(Math.max(Math.trunc(n), 1), 16);
    this.customObjectPositions = null;
    this.#placeInEngine();
    this.#refreshTowerForPlacement();
  }

  /** applyPlacementPositions: dragged object/copy lower-left corners and tower position. */
  setPlacement(positions, wipeTowerPos = null) {
    const expected = this.multiObject ? this.engine.objectCount() : this.placementPositions().length / 2;
    if (positions.length / 2 !== expected) return false;
    this.customObjectPositions = Float32Array.from(positions);
    if (wipeTowerPos) this.setWipeTowerPosition(wipeTowerPos[0], wipeTowerPos[1]);
    this.#placeInEngine();
    return true;
  }

  /** Tower drag, clamped like startSlicing (wipeTowerClampBounds with the estimated depth). */
  setWipeTowerPosition(x, y) {
    const [maxX, maxY] = this.wipeTowerClamp();
    const pos = [Math.min(Math.max(x, 0), maxX), Math.min(Math.max(y, 0), maxY)];
    this.customWipeTowerPos = pos;
    this.config = { ...this.config, wipeTowerX: pos[0], wipeTowerY: pos[1] };
  }

  wipeTowerSize() {
    return [resolveWipeTowerWidth(this.config, this.overrides),
      resolveWipeTowerDepth(this.modelInfo?.sizeZ ?? 0, this.overrides)];
  }

  wipeTowerClamp() {
    const [w, d] = this.wipeTowerSize();
    return wipeTowerClampBounds(this.config.bedSizeX, this.config.bedSizeY, w, d);
  }

  /** Re-place the tower next to the current layout (reflowPlacementForActiveTarget). */
  #refreshTowerForPlacement() {
    if (!this.config.wipeTowerEnabled) return;
    const [w, d] = this.wipeTowerSize();
    const { bedSizeX, bedSizeY } = this.config;
    let tower;
    if (this.multiObject) {
      const boxes = this.objects().flatMap((o) => o.size);
      tower = Arrange.computeWipeTowerPositionForObjects(this.customObjectPositions ?? this.#worldMins(), boxes, w, d, bedSizeX, bedSizeY);
    } else {
      const fp = this.copyFootprint();
      if (!fp) return;
      tower = Arrange.computeWipeTowerPosition(this.placementPositions(), fp[0], fp[1], w, d, bedSizeX, bedSizeY);
    }
    this.customWipeTowerPos = tower;
    this.config = { ...this.config, wipeTowerX: tower[0], wipeTowerY: tower[1] };
  }

  #worldMins() { return Float32Array.from(this.objects().flatMap((o) => o.min ?? [0, 0])); }

  /** Enter per-object mode (split / duplicate / add file all do this in the app). */
  #promoteToMultiObject() {
    if (this.multiObject) return;
    // Bake the group transform into each object so per-object poses start from it.
    this.multiObject = true;
    this.customObjectPositions = this.#worldMins();
  }

  splitObject(objIdx) {
    this.#promoteToMultiObject();
    if (!this.engine.splitObject(objIdx)) return false;
    this.splitObjectOps.push(objIdx);
    this.customObjectPositions = this.#worldMins();
    return true;
  }

  duplicateObject(objIdx) {
    this.#promoteToMultiObject();
    const n = this.engine.objectCount();
    if (this.engine.duplicateObject(objIdx) < 0) return false;
    this.duplicateOps.push(objIdx);
    // Place the copy with placeAdditionalObject next to the existing layout.
    const boxes = this.objects().map((o) => o.size);
    const current = Float32Array.from(this.customObjectPositions ?? this.#worldMins()).slice(0, n * 2);
    this.customObjectPositions = Arrange.placeAdditionalObject(current, boxes.flat(), this.config.bedSizeX, this.config.bedSizeY);
    this.#placeInEngine();
    return true;
  }

  /** addModelFile: another file on the bed (multi-object mode). */
  addModel(name, bytes, plateIdx = -1) {
    this.#promoteToMultiObject();
    const n = this.engine.objectCount();
    const path = this.#writeWork(`add${this.additionalFiles.length}_${name}`, bytes);
    if (!this.engine.addModel(path, plateIdx >= 0 ? plateIdx + 1 : 0)) throw new Error(`Could not add ${name}`);
    this.additionalFiles.push({ path, plateIdx });
    const boxes = this.objects().map((o) => o.size).flat();
    const current = Float32Array.from(this.customObjectPositions ?? this.#worldMins()).slice(0, n * 2);
    this.customObjectPositions = Arrange.placeAdditionalObject(current, boxes, this.config.bedSizeX, this.config.bedSizeY);
    this.#placeInEngine();
    this.#refreshTowerForPlacement();
  }

  setObjectRotation(objIdx, x, y, z) {
    this.#promoteToMultiObject();
    if (!this.engine.setObjectRotation(objIdx, x, y, z)) return false;
    const p = this.perObjectPoses.get(objIdx) ?? { rot: [0, 0, 0], scale: [1, 1, 1] };
    this.perObjectPoses.set(objIdx, { ...p, rot: [x, y, z] });
    this.customObjectPositions = this.#worldMins();
    return true;
  }

  setObjectScale(objIdx, x, y, z) {
    this.#promoteToMultiObject();
    if (!this.engine.setObjectScale(objIdx, x, y, z)) return false;
    const p = this.perObjectPoses.get(objIdx) ?? { rot: this.objects()[objIdx]?.rotation ?? [0, 0, 0], scale: [1, 1, 1] };
    this.perObjectPoses.set(objIdx, { ...p, scale: [x, y, z] });
    this.customObjectPositions = this.#worldMins();
    return true;
  }

  /** autoArrangeAll (F92): non-overlapping layout clear of the tower keep-out. */
  autoArrange() {
    if (!this.multiObject) {
      this.customObjectPositions = null;
      this.#placeInEngine();
      this.#refreshTowerForPlacement();
      return { overflowCount: 0 };
    }
    const boxes = this.objects().flatMap((o) => o.size);
    const [w, d] = this.wipeTowerSize();
    const reserved = this.config.wipeTowerEnabled && this.customWipeTowerPos
      ? [this.customWipeTowerPos[0], this.customWipeTowerPos[1], w, d] : null;
    const result = Arrange.autoArrange(boxes, reserved, null, this.config.bedSizeX, this.config.bedSizeY);
    this.customObjectPositions = result.positions;
    this.#placeInEngine();
    return { overflowCount: result.overflowCount };
  }

  setVolumeExtruder(objIdx, volIdx, slot) {
    if (this.engine.setVolumeExtruder(objIdx, volIdx, slot)) this.perVolumeExtruders.set(`${objIdx}:${volIdx}`, slot);
  }

  /** The engine's Prepare-preview mesh of the current layout. */
  previewMesh(maxTriangles) { return this.engine.previewMesh(maxTriangles); }

  // ---------------------------------------------------------------------------
  // Slice
  // ---------------------------------------------------------------------------

  /**
   * startSlicing. Returns { result, gcode (canonical tool space, as the app
   * stores it), info } — use exportGcode() for the printer-ready file.
   */
  async slice(onProgress = () => {}) {
    if (!this.modelInfo) throw new Error('No model loaded');
    const e = this.engine;
    // Always re-embed before slicing so settings reach the embedded profile (B24, 2026-05-25).
    if (this.sourceModelBytes) {
      onProgress(0, 'Embedding profile');
      const srcInfo = this.fileThreeMfInfo ?? this.threeMfInfo ?? this.sourceModelInfo;
      const reembedPlateId = this.currentPlateId > 0 ? this.currentPlateId : null;
      const reembedded = this.#embedProfile(this.sourceModelBytes, srcInfo, { plateId: reembedPlateId });
      e.clearModel();
      const path = this.#writeWork(`embedded_${this.rawName}`, reembedded);
      if (!e.loadModel(path, 0)) throw new Error('Failed to reload model before slicing');
      this.currentModelBytes = reembedded;
      this.modelInfo = JSON.parse(e.modelInfoJson());
      // F66 replay order: added files, splits, per-volume extruders, poses, duplicates.
      for (const f of this.additionalFiles) {
        if (!e.addModel(f.path, f.plateIdx >= 0 ? f.plateIdx + 1 : 0)) throw new Error('Could not reload an added file');
      }
      for (const idx of this.splitObjectOps) e.splitObject(idx);
      for (const [key, slot] of this.perVolumeExtruders) {
        const [o, v] = key.split(':').map(Number);
        e.setVolumeExtruder(o, v, slot);
      }
      for (const [idx, p] of this.perObjectPoses) {
        if (idx < 0 || idx >= e.objectCount()) continue;
        e.setObjectRotation(idx, ...p.rot);
        e.setObjectScale(idx, ...p.scale);
      }
      for (const idx of this.duplicateOps) if (idx < e.objectCount()) e.duplicateObject(idx);
    }
    this.#placeInEngine();

    const mi = this.modelInfo;
    const { bedSizeX, bedSizeY } = this.config;
    const custom = this.customObjectPositions;
    if (mi && (mi.sizeX > bedSizeX || mi.sizeY > bedSizeY) && custom == null && !this.copyFootprintFits()) {
      throw new Error(`Model bounding box (${Math.trunc(mi.sizeX)}×${Math.trunc(mi.sizeY)}mm) exceeds the ` +
        `${bedSizeX}×${bedSizeY}mm bed.\nThis usually means a multi-plate 3MF still contains all plates. ` +
        'Try reloading and reselecting the plate.');
    }
    if (mi && this.copyCount > 1 && custom == null) {
      const fp = this.copyFootprint();
      const maxFit = fp ? Arrange.maxCopies(fp[0], fp[1], bedSizeX, bedSizeY) : this.copyCount;
      if (maxFit < this.copyCount) {
        throw new Error(`Only ${maxFit} copy of this model fits on the ${bedSizeX}×${bedSizeY}mm bed ` +
          `(model footprint ${Math.trunc(mi.sizeX)}×${Math.trunc(mi.sizeY)}mm).\nEither reduce Copies to ${maxFit} or scale the model down.`);
      }
    }

    // resolveInto + tower clamp + effective extruder count (no mixes on the web).
    const ov = this.overrides;
    let cfg = resolveInto(ov, this.config);
    if (cfg.wipeTowerEnabled) {
      const depth = estimateDepth(mi?.sizeZ ?? 0);
      const [maxX, maxY] = wipeTowerClampBounds(cfg.bedSizeX, cfg.bedSizeY, cfg.wipeTowerWidth, depth);
      cfg = { ...cfg, wipeTowerX: Math.min(Math.max(cfg.wipeTowerX, 0), maxX), wipeTowerY: Math.min(Math.max(cfg.wipeTowerY, 0), maxY) };
    }
    const effectiveExtruderCount = Math.max(cfg.extruderCount, cfg.supportFilament, cfg.supportInterfaceFilament, 0);
    const slotTypes = [...this.presets].sort((a, b) => a.index - b.index).map((p) => p.materialType || 'PLA');
    cfg = {
      ...cfg,
      extruderCount: effectiveExtruderCount,
      wipeTowerEnabled: resolvePrimeTower(ov, effectiveExtruderCount, cfg.wipeTowerEnabled),
      filamentTypes: range(effectiveExtruderCount).map((i) => slotTypes[i] ?? (cfg.filamentType || 'PLA')),
      extruderTemps: computeFreshSlotTemps(effectiveExtruderCount, this.toolRemapSlots, this.presets, this.filaments),
    };
    // B106: plain models get the U1 machine start/end G-code (3MFs carry it in the embed).
    const usesMachineGcode = this.sourceModelBytes == null;
    const lib = buildFilamentLibraryArrays(Math.max(cfg.extruderCount, 1), this.toolRemapSlots, this.presets, this.filaments);
    const jni = {
      ...cfg,
      // B100: 0 sentinel unless layer height is an explicit override.
      layerHeight: ov.layerHeight.mode === OverrideMode.OVERRIDE ? cfg.layerHeight : 0,
      machineStartGcode: usesMachineGcode ? this.profiles.printer.machine_start_gcode ?? cfg.machineStartGcode : cfg.machineStartGcode,
      machineEndGcode: usesMachineGcode ? this.profiles.printer.machine_end_gcode ?? cfg.machineEndGcode : cfg.machineEndGcode,
      filamentFlowRatios: lib.flowRatios, filamentMaxVolumetricSpeeds: lib.maxVolumetricSpeeds,
      filamentFanMinSpeeds: lib.fanMinSpeeds, filamentFanMaxSpeeds: lib.fanMaxSpeeds,
      filamentOverhangFanSpeeds: lib.overhangFanSpeeds, filamentAdditionalCoolingFanSpeeds: lib.additionalCoolingFanSpeeds,
      filamentSlowDownLayerTimes: lib.slowDownLayerTimes, filamentSlowDownMinSpeeds: lib.slowDownMinSpeeds,
      filamentCloseFanFirstLayers: lib.closeFanFirstLayers, filamentFullFanSpeedLayers: lib.fullFanSpeedLayers,
      filamentEnablePressureAdvance: lib.enablePressureAdvance, filamentPressureAdvances: lib.pressureAdvances,
      filamentMinimalPurgeOnWipeTower: lib.minimalPurgeOnWipeTower, filamentNozzleTempInitialLayers: lib.nozzleTempInitialLayers,
      filamentBedTempInitialLayers: lib.bedTempInitialLayers, filamentCosts: lib.costs,
    };
    this.lastSliceConfig = jni;
    const native = toNativeSliceConfig(jni);
    const result = JSON.parse(e.slice(JSON.stringify(native), onProgress));
    if (!result.success) throw new Error(result.error || 'Slice failed');
    let gcode = new TextDecoder().decode(e.FS.readFile(result.gcodePath));
    e.FS.unlink(result.gcodePath);

    onProgress(100, 'Post-processing G-code');
    gcode = this.#patchHeaders(gcode);
    const pauses = this.#injectLayerToolPauses(gcode);
    if (pauses != null) gcode = pauses;
    try {
      const withThumbs = await injectThumbnails(gcode, this.rawBytes ?? this.sourceModelBytes ?? this.currentModelBytes,
        this.rawName ?? 'model', { imageCodec: this.thumbnailCodec });
      if (withThumbs != null) gcode = withThumbs;
    } catch (err) {
      this.log(`Thumbnail injection failed (non-fatal): ${err.message}`);
    }
    this.sliceSerial++;
    return { result, gcode, layerToolPauses: pauses != null, sliceConfig: native };
  }

  /**
   * resolveExportMapping: canonical fileIndex -> physical slot for Save/Upload,
   * with the plate-narrowed fileIndex keys when the mapping is plate-narrowed.
   */
  resolveExportMapping() {
    const canonical = this.canonical;
    const confirmed = this.colorMapping;
    const canonicalSize = canonical?.size ?? 0;
    let mappingFileIndices = null;
    if (confirmed?.length && confirmed.length < canonicalSize) {
      const info = this.threeMfInfo;
      const plate = this.currentPlateId >= 0 ? info?.plates?.find((p) => p.plateId === this.currentPlateId) : null;
      const inRange = (i) => i >= 0 && i < canonicalSize;
      const fromPlate = plate ? [...plate.filamentIndices].map((i) => i - 1).filter(inRange) : null;
      if (fromPlate && fromPlate.length === confirmed.length) mappingFileIndices = fromPlate;
      else {
        const used = info ? [...info.usedExtruderIndices].filter((i) => i > 0).sort((a, b) => a - b).map((i) => i - 1).filter(inRange) : null;
        if (used && used.length === confirmed.length) mappingFileIndices = used;
      }
    }
    return resolveExportMappingForToolSpace({
      toolSpace: GcodeToolSpace.CANONICAL, canonicalSize, confirmedMapping: confirmed,
      selectedExtruder: this.selectedExtruder, confirmedMappingFileIndices: mappingFileIndices,
    });
  }

  /** prepareExportableGcode: the printer-ready G-code (tools on the chosen U1 slots). */
  exportGcode(gcode) {
    const mapping = this.resolveExportMapping();
    return mapping?.length ? applyPrintTimeRemap({ gcodeText: gcode, colorMapping: mapping }) : gcode;
  }

  copyFootprintFits() {
    const fp = this.copyFootprint();
    return !!fp && fp[0] <= this.config.bedSizeX && fp[1] <= this.config.bedSizeY;
  }

  /** B63 filament_type + B110 nozzle_temperature header patches. */
  #patchHeaders(gcode) {
    const canonical = this.canonical;
    const ov = this.overrides;
    const supportDriven = Math.max(ov.supportFilament.value ?? 0, ov.supportInterfaceFilament.value ?? 0);
    let types;
    let temps;
    if (canonical && !(canonical.size <= 1 && supportDriven > canonical.size)) {
      const padTo = Math.max(canonical.size, supportDriven);
      const args = { canonical, overrides: this.filamentOverrides, colorMapping: this.colorMapping,
        presets: this.presets, filamentLibrary: this.filaments, padTo };
      types = resolveFilamentTypesForHeaderPatch(args);
      temps = resolveNozzleTempsForHeaderPatch(args);
    } else {
      const usedSlots = this.toolRemapSlots
        ?? (this.colorMapping ? [...new Set(this.colorMapping)].sort((a, b) => a - b) : [this.selectedExtruder]);
      [types, temps] = applyNonCanonicalOverride(
        resolveNonCanonicalHeaderPatchTypes(usedSlots, this.presets),
        resolveNonCanonicalHeaderPatchTemps(usedSlots, this.presets, this.filaments),
        this.filamentOverrides.get(0) ?? null);
    }
    gcode = fixFilamentTypeHeader(gcode, types).gcode;
    return fixNozzleTemperatureHeader(gcode, temps).gcode;
  }

  /** LayerToolPauseInjector.injectFrom3mf for layer-tool (Hueforge-style) files. */
  #injectLayerToolPauses(gcode) {
    if (this.threeMfInfo?.hasLayerToolChanges !== true) return null;
    const metadata = this.currentPlateId > 0 && this.currentModelBytes ? this.currentModelBytes
      : this.sourceModelBytes ?? this.currentModelBytes;
    if (!metadata) return null;
    const plateIdx = Math.max(this.currentPlateId - 1, 0);
    const getPlateData = (i) => this.engine.plateDataJson(i) || null;
    return injectFrom3mf(gcode, metadata, plateIdx, getPlateData, { modelName: `${this.rawName ?? 'model'}`.replace(/(\.3mf)?$/i, '.3mf') });
  }

  // ---------------------------------------------------------------------------
  // Summary for the UI
  // ---------------------------------------------------------------------------

  summary() {
    const info = this.threeMfInfo;
    return {
      model: this.modelInfo,
      name: this.rawName,
      isThreeMf: this.rawName ? isThreeMf(this.rawName) : false,
      isBambu: !!info?.isBambu,
      hasSourceConfig: this.sourceConfig != null,
      plates: (this.multiPlatePlates.length ? this.multiPlatePlates : []).map((p) => ({
        plateId: p.plateId, name: p.name, objectCount: p.objectIds?.length ?? 0, hasPaintData: !!p.hasPaintData,
      })),
      currentPlateId: this.currentPlateId,
      detectedColors: info?.detectedColors ?? [],
      hasPaintData: !!info?.hasPaintData,
      hasLayerToolChanges: !!info?.hasLayerToolChanges,
      layerToolOnly: this.layerToolOnly,
      canonical: this.canonical ? this.canonical.filaments.map((f) => ({ color: f.color, materialType: f.materialType, source: f.source })) : null,
      colorMapping: this.colorMapping,
      selectedExtruder: this.selectedExtruder,
      activeExtruderColors: this.activeExtruderColors,
      extruderCount: this.config.extruderCount,
      wipeTowerEnabled: this.config.wipeTowerEnabled,
      wipeTower: { x: this.config.wipeTowerX, y: this.config.wipeTowerY, size: this.wipeTowerSize(), clamp: this.wipeTowerClamp() },
      fileSettings: this.fileSettings(),
      edit: {
        multiObject: this.multiObject, copyCount: this.copyCount, scale: this.modelScale, rotation: this.modelRotation,
        positions: this.modelInfo ? [...this.placementPositions()] : [], copyBedWarning: this.modelInfo ? this.copyBedWarning() : null,
      },
      objects: this.modelInfo ? this.objects() : [],
    };
  }

  /** The 3MF's own process values the "From file" (USE_FILE) settings will keep. */
  fileSettings() {
    const c = this.sourceConfig;
    if (!c) return null;
    const pick = (k) => {
      const v = c instanceof Map ? c.get(k) : c[k];
      return Array.isArray(v) ? v[0] : v;
    };
    return {
      layer_height: pick('layer_height'), wall_loops: pick('wall_loops'),
      sparse_infill_density: pick('sparse_infill_density'), sparse_infill_pattern: pick('sparse_infill_pattern'),
      enable_support: pick('enable_support'), support_type: pick('support_type'),
      brim_width: pick('brim_width'), brim_type: pick('brim_type'), enable_prime_tower: pick('enable_prime_tower'),
    };
  }
}
