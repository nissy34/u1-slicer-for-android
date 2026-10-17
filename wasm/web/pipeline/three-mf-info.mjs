// Port of app/src/main/java/com/u1/slicer/bambu/ThreeMfInfo.kt.
//
// Kotlin data classes become plain objects built by factories that apply the
// same defaults. Collections keep Kotlin's semantics with insertion order:
//   List -> Array, Set -> Set, Map -> Map (object/part ids are numeric strings,
//   so plain objects would reorder them), FloatArray -> Array of float32 values.
//
// The Kotlin computed properties (`hasMultiExtruderAssignments`, `needsPreserve`,
// `translationX/Y/Z`) are non-enumerable getters, so they always reflect the
// current fields and are NOT copied by object spread. Kotlin `copy(...)` is
// `copyThreeMfInfo(info, {...changes})` / `copyThreeMfPlate(plate, {...})`
// (equivalently `threeMfInfo({...info, ...changes})`).

export const IDENTITY_TRANSFORM = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/** ThreeMfPlate(plateId, name, objectIds, ...defaults). */
export function threeMfPlate({
  plateId,
  name,
  objectIds,
  filamentIndices = new Set(),
  // Unique non-zero AMS slot values from `filament_maps` (physical extruder slots
  // active on this plate). Contrast with filamentIndices: 1-indexed FILE-FILAMENT
  // POSITIONS of non-zero entries (B120).
  filamentMapSlots = new Set(),
  printable = true,
  transform = [...IDENTITY_TRANSFORM],
  thumbnailBytes = null,
  /** Per-plate layer-tool change display colours. */
  layerToolColors = [],
  /** Per-plate layer-tool change extruder indices (1-based). */
  layerToolExtruders = new Set(),
  hasLayerToolChanges = false,
  /** True when this plate's objects carry paint data (sub-plan #2c). */
  hasPaintData = false,
  /** Per-plate paint extruder states (1-based) — deprecated in Kotlin, still read by embed-prep. */
  paintExtruderStates = new Set(),
}) {
  const plate = {
    plateId, name, objectIds, filamentIndices, filamentMapSlots, printable, transform,
    thumbnailBytes, layerToolColors, layerToolExtruders, hasLayerToolChanges, hasPaintData,
    paintExtruderStates,
  };
  Object.defineProperties(plate, {
    translationX: { get() { return this.transform[9]; }, enumerable: false },
    translationY: { get() { return this.transform[10]; }, enumerable: false },
    translationZ: { get() { return this.transform[11]; }, enumerable: false },
  });
  return plate;
}

export const copyThreeMfPlate = (plate, changes = {}) => threeMfPlate({ ...plate, ...changes });

/** ThreeMfObject(objectId, name, vertices = 0, triangles = 0). */
export function threeMfObject(objectId, name, vertices = 0, triangles = 0) {
  return { objectId, name, vertices, triangles };
}

/** LayerToolSegment(topZ: Float, extruderBambu: Int — 1-based: 1→T0, 2→T1). */
export function layerToolSegment(topZ, extruderBambu) {
  return { topZ: Math.fround(topZ), extruderBambu };
}

/** ThreeMfInfo(objects, plates, isBambu, isMultiPlate, ...defaults). */
export function threeMfInfo({
  objects,
  plates,
  isBambu,
  isMultiPlate,
  hasPaintData = false,
  hasPaintSupports = false,
  hasLayerToolChanges = false,
  detectedColors = [],
  detectedExtruderCount = 1,
  /** True when the original Bambu 3MF has Metadata/plate_N.json files (newer multi-plate format). */
  hasPlateJsons = false,
  /** 1-based extruder indices assigned to objects/volumes (may include layer-tool enrichment). */
  usedExtruderIndices = new Set(),
  /** §4 Step 8 — spatial per-volume extruder set (drives hasMultiExtruderAssignments). */
  volumeExtruders = new Set(),
  /** objectId -> 1-based extruder index. */
  objectExtruderMap = new Map(),
  /** objectId -> Set of 1-based extruders used by the object's parts (deprecated in Kotlin). */
  objectPartExtruders = new Map(),
  /** partId -> parent objectId (deprecated in Kotlin). */
  compoundPartParents = new Map(),
  /** Array of layerToolSegment, or null. */
  layerToolSegments = null,
  /** M3-B full-spectrum marker: physical filament count, or null. */
  fullSpectrumPhysicalCount = null,
}) {
  const info = {
    objects, plates, isBambu, isMultiPlate, hasPaintData, hasPaintSupports, hasLayerToolChanges,
    detectedColors, detectedExtruderCount, hasPlateJsons, usedExtruderIndices, volumeExtruders,
    objectExtruderMap, objectPartExtruders, compoundPartParents, layerToolSegments,
    fullSpectrumPhysicalCount,
  };
  Object.defineProperties(info, {
    /** Per-spatial-volume extruder diversity: volumeExtruders.size > 1. */
    hasMultiExtruderAssignments: {
      get() { return this.volumeExtruders.size > 1; }, enumerable: false,
    },
    /** Whether the original Bambu structure must be preserved (not rebuilt with trimesh). */
    needsPreserve: {
      get() {
        return this.isBambu && (this.hasMultiExtruderAssignments || this.hasLayerToolChanges || this.isMultiPlate);
      },
      enumerable: false,
    },
  });
  return info;
}

export const copyThreeMfInfo = (info, changes = {}) => threeMfInfo({ ...info, ...changes });

/** Kotlin `ThreeMfInfo(emptyList(), emptyList(), isBambu, isMultiPlate)`. */
export const emptyThreeMfInfo = (isBambu = false, isMultiPlate = false) =>
  threeMfInfo({ objects: [], plates: [], isBambu, isMultiPlate });
