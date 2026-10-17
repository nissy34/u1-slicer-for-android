// Port of the ThreeMfInfo merge helpers in SlicerViewModel.kt's companion object:
// mergeThreeMfInfo, mergeThreeMfInfoForPlate, buildSelectedPlateInfo,
// isH2cSourceConfig, buildPreviewSlotColors, plus the small file-choice helpers
// MergeThreeMfInfoTest covers (shouldDeferPaintDetectionForImport,
// resolvePreviewModelFile, resolvePlateSelectionSourceFile).
// computeEmbedTargetCount / buildCompactExtruderRemap live in embed-target.mjs.
import { copyThreeMfInfo } from './three-mf-info.mjs';

const sortNum = (arr) => [...arr].sort((a, b) => a - b);
const sortedSet = (iter) => new Set(sortNum(iter));
/** First element with the largest `.size` (Kotlin maxByOrNull keeps the first max). */
function maxBySize(sets) {
  let best = null;
  for (const s of sets) if (best == null || s.size > best.size) best = s;
  return best ?? new Set();
}

/** ExtruderPreset.DEFAULT_COLORS from app/src/main/java/com/u1/slicer/data/ExtruderPreset.kt. */
export const EXTRUDER_PRESET_DEFAULT_COLORS = Object.freeze(['#FF0000', '#00FF00', '#0000FF', '#FFFFFF']);

/** Only archives flagged by inspectArchiveSizing defer paint detection. */
export const shouldDeferPaintDetectionForImport = (archiveSizingRisk) => archiveSizingRisk != null;

/**
 * Merges a sanitized ThreeMfInfo (processedInfo) with the original parse (origInfo).
 * BambuSanitizer.process() strips colour metadata, so structural fields come from
 * processedInfo and colour/extruder metadata from origInfo.
 */
export function mergeThreeMfInfo(processedInfo, origInfo) {
  return copyThreeMfInfo(processedInfo, {
    isBambu: origInfo.isBambu,
    plates: origInfo.plates,
    hasPlateJsons: origInfo.hasPlateJsons,
    detectedColors: origInfo.detectedColors,
    detectedExtruderCount: origInfo.detectedExtruderCount,
    usedExtruderIndices: origInfo.usedExtruderIndices,
    volumeExtruders: origInfo.volumeExtruders, // §4 Step 8
    hasPaintData: origInfo.hasPaintData,
    hasLayerToolChanges: origInfo.hasLayerToolChanges,
    // Prefer the processed map: the sanitizer can inline compound-object parts into
    // concrete mesh object ids, which per-part preview colouring needs (calicube).
    objectExtruderMap: processedInfo.objectExtruderMap.size > 0 ? processedInfo.objectExtruderMap : origInfo.objectExtruderMap,
    layerToolSegments: origInfo.layerToolSegments,
    hasPaintSupports: origInfo.hasPaintSupports,
    // M3-B: the sanitized file may have project_settings.config rewritten/stripped.
    fullSpectrumPhysicalCount: origInfo.fullSpectrumPhysicalCount,
  });
}

/**
 * Merges a single-plate info (plateInfo, no colour metadata) with the pre-select
 * merged info (sourceInfo, full colour/extruder metadata). Takes the plate's
 * structural fields and restores colour/extruder metadata from sourceInfo.
 */
export function mergeThreeMfInfoForPlate(plateInfo, sourceInfo, selectedPlateId = null) {
  const sourcePlate = selectedPlateId != null
    ? (sourceInfo.plates.find((p) => p.plateId === selectedPlateId) ?? null) : null;
  const sourcePlateFilamentIndices = selectedPlateId != null
    ? new Set([...(sourceInfo.plates.find((p) => p.plateId === selectedPlateId)?.filamentMapSlots ?? [])].filter((v) => v > 0))
    : new Set();
  const sourcePlateObjectExtruders = sourcePlate
    ? new Set(sourcePlate.objectIds.map((id) => sourceInfo.objectExtruderMap.get(id)).filter((v) => v != null && v > 0))
    : new Set();
  const plateFilamentIndices = new Set(plateInfo.plates.flatMap((p) => [...p.filamentMapSlots]).filter((v) => v > 0));
  const mergedUsedExtruderIndices = sourceInfo.hasLayerToolChanges
    ? new Set([
      ...sortNum(sourcePlateObjectExtruders),
      ...sortNum(sourcePlateFilamentIndices),
      ...sortNum(plateFilamentIndices),
      ...sortNum([...plateInfo.usedExtruderIndices].filter((v) => v > 0)),
    ])
    : plateInfo.usedExtruderIndices;
  // Layer-change models use per-layer tool colours, so filtering to plate filament
  // indices would collapse the preview to one colour. Plate-level hasPaintData (not
  // file-level) so unpainted plates in a painted file still get layerToolOnly (B81).
  // Sub-plan #2c: prefer the source plate's parse-time flag.
  const plateHasPaintData = sourcePlate?.hasPaintData ?? plateInfo.hasPaintData;
  const layerToolOnly = sourceInfo.hasLayerToolChanges && !plateHasPaintData && !sourceInfo.hasMultiExtruderAssignments;
  let filteredColors;
  if (layerToolOnly) {
    const selectedLayerToolColors = new Set();
    let selectedExtruders;
    if (sourcePlateObjectExtruders.size > 0) {
      const plateLtColors = sourcePlate?.layerToolColors ?? [];
      const plateLtExtruders = sourcePlate?.layerToolExtruders ?? new Set();
      if (plateLtColors.length > 0) {
        // B82: a layer-tool secondary is real only when its colour is in the file
        // palette (flippy plate 1's #2323F7 is not → single colour).
        const hasRealSecondaries = plateLtColors.some((color) =>
          sourceInfo.detectedColors.some((c) => c.toLowerCase() === color.toLowerCase()));
        selectedExtruders = hasRealSecondaries
          ? sortNum([...sourcePlateObjectExtruders, ...plateLtExtruders].filter((v) => v > 0))
          : sortNum([...sourcePlateObjectExtruders].filter((v) => v > 0));
      } else if ([...plateInfo.usedExtruderIndices].some((v) => sourcePlateObjectExtruders.has(v))) {
        // B80 fallback: extracted plate over-reports transient tool-change extruders
        // alongside the base slot → trust the object map only.
        selectedExtruders = sortNum([...sourcePlateObjectExtruders].filter((v) => v > 0));
      } else {
        selectedExtruders = sortNum([...sourcePlateObjectExtruders, ...[...plateInfo.usedExtruderIndices].filter((v) => v > 0)]);
      }
    } else {
      selectedExtruders = sortNum([...mergedUsedExtruderIndices].filter((v) => v > 0));
    }
    for (const extruderIndex of selectedExtruders) {
      const c = sourceInfo.detectedColors[extruderIndex - 1];
      if (c !== undefined) selectedLayerToolColors.add(c);
    }
    filteredColors = selectedLayerToolColors.size > 0 ? [...selectedLayerToolColors]
      : (plateInfo.detectedColors.length > 0 ? plateInfo.detectedColors : sourceInfo.detectedColors);
  } else {
    // Filter colours to the extruder indices used on this plate (1-based → 0-indexed),
    // preferring the selected source plate (extraction can over-report transients).
    let usedIndices;
    if (sourceInfo.hasMultiExtruderAssignments) {
      if (sourceInfo.hasLayerToolChanges) {
        if (sourcePlateFilamentIndices.size > 0) usedIndices = sourcePlateFilamentIndices;
        else if (sourcePlateObjectExtruders.size > 0) usedIndices = sourcePlateObjectExtruders;
        else if (plateFilamentIndices.size > 0) usedIndices = plateFilamentIndices;
        else usedIndices = plateInfo.usedExtruderIndices;
      } else {
        // Pure per-object models: keep the richest extracted set.
        usedIndices = maxBySize([sourcePlateFilamentIndices, sourcePlateObjectExtruders, plateFilamentIndices, plateInfo.usedExtruderIndices]);
      }
    } else {
      usedIndices = maxBySize([sourcePlateFilamentIndices, plateFilamentIndices, plateInfo.usedExtruderIndices]);
    }
    let effectiveUsedIndices;
    if (sourceInfo.hasMultiExtruderAssignments && sourceInfo.hasLayerToolChanges &&
        usedIndices.size <= 1 && plateInfo.usedExtruderIndices.size > 1) {
      // Under-reported single base slot on a plate that uses one more layer-tool
      // slot: expand to a stable dual-slot set.
      const firstUsed = usedIndices.size > 0 ? usedIndices.values().next().value : undefined;
      const seed = firstUsed ?? (plateInfo.usedExtruderIndices.size > 0 ? Math.min(...plateInfo.usedExtruderIndices) : 1);
      const next = sortNum([...plateInfo.usedExtruderIndices].filter((v) => v > 0 && v !== seed))[0];
      effectiveUsedIndices = new Set([seed]);
      if (next !== undefined) effectiveUsedIndices.add(next);
    } else {
      effectiveUsedIndices = usedIndices;
    }
    if (effectiveUsedIndices.size > 0 && sourceInfo.detectedColors.length > 1) {
      filteredColors = sortNum(effectiveUsedIndices)
        .map((idx) => sourceInfo.detectedColors[idx - 1])
        .filter((c) => c !== undefined);
    } else {
      filteredColors = sourceInfo.detectedColors;
    }
  }
  // Hueforge plate: single object/filament, layer-tool changes, no paint, and no
  // per-object extruder diversity in the source file.
  const sourceObjectExtruderDiversity = new Set(sourceInfo.objectExtruderMap.values()).size;
  const isHueforgePlate = selectedPlateId != null &&
    sourceInfo.hasLayerToolChanges && !plateHasPaintData &&
    sourcePlateObjectExtruders.size <= 1 && sourcePlateFilamentIndices.size <= 1 &&
    sourceObjectExtruderDiversity <= 1;
  // §4 Step 8: express the old hasMultiExtruderAssignments override through
  // volumeExtruders ({1,2} forces true, {1} forces false, else inherit).
  let mergedVolumeExtruders;
  if (sourcePlateObjectExtruders.size > 1) mergedVolumeExtruders = new Set([1, 2]);
  else if (isHueforgePlate) mergedVolumeExtruders = new Set([1]);
  else mergedVolumeExtruders = sourceInfo.volumeExtruders;

  let detectedExtruderCount;
  if (layerToolOnly) {
    detectedExtruderCount = Math.max(plateInfo.detectedExtruderCount, filteredColors.length, mergedUsedExtruderIndices.size);
  } else if (isHueforgePlate) {
    detectedExtruderCount = Math.max(filteredColors.length, 2);
  } else if (filteredColors.length > 0) {
    detectedExtruderCount = filteredColors.length;
  } else {
    detectedExtruderCount = sourceInfo.detectedExtruderCount;
  }
  return copyThreeMfInfo(plateInfo, {
    isBambu: sourceInfo.isBambu,
    detectedColors: filteredColors,
    detectedExtruderCount,
    usedExtruderIndices: mergedUsedExtruderIndices,
    volumeExtruders: mergedVolumeExtruders,
    hasPaintData: plateHasPaintData,
    hasLayerToolChanges: sourceInfo.hasLayerToolChanges,
    objectExtruderMap: plateInfo.objectExtruderMap.size > 0 ? plateInfo.objectExtruderMap : sourceInfo.objectExtruderMap,
    layerToolSegments: sourceInfo.layerToolSegments,
    hasPaintSupports: sourceInfo.hasPaintSupports,
  });
}

/**
 * Picks the file the preview should read. Only genuine H2C source projects use the
 * raw input (project_settings.config-driven path). File arguments are opaque values.
 */
export function resolvePreviewModelFile({ rawInputFile, sourceModelFile, currentModelFile, info, originalSourceConfig }) {
  if (rawInputFile != null && info?.isBambu === true && !info.isMultiPlate && isH2cSourceConfig(originalSourceConfig)) {
    return rawInputFile;
  }
  if (sourceModelFile != null) return sourceModelFile;
  return currentModelFile ?? null;
}

export const resolvePlateSelectionSourceFile = ({ sourceModelFile, currentModelFile }) =>
  sourceModelFile ?? currentModelFile ?? null;

/**
 * True for H2C source projects: `filament_settings_id` containing "@BBL H2C" or
 * `change_filament_gcode` containing "H2C filament_change". Generic machine
 * compatibility strings are deliberately not scanned. `config`: Map or plain object.
 */
export function isH2cSourceConfig(config) {
  if (config == null) return false;
  const get = (k) => (config instanceof Map ? config.get(k) : config[k]);
  const size = config instanceof Map ? config.size : Object.keys(config).length;
  if (size === 0) return false;
  const anyString = (value, predicate) => {
    if (value == null) return false;
    if (typeof value === 'string') return predicate(value);
    if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
      for (const v of value) if (anyString(v, predicate)) return true;
      return false;
    }
    return false;
  };
  return anyString(get('filament_settings_id'), (s) => s.includes('@BBL H2C')) ||
    anyString(get('change_filament_gcode'), (s) => s.includes('H2C filament_change'));
}

/**
 * 4-entry slot colour list: used slots take the preset colour (or the slot default
 * when blank/missing), unused slots are "". `extruderPresets`: [{index, color}].
 */
export function buildPreviewSlotColors(extruderPresets, usedSlots) {
  const fullColors = ['', '', '', ''];
  for (const slotIndex of usedSlots) {
    if (!(slotIndex >= 0 && slotIndex <= 3)) continue;
    const presetColor = extruderPresets.find((p) => p.index === slotIndex)?.color;
    fullColors[slotIndex] = (presetColor != null && presetColor.trim().length > 0)
      ? presetColor : EXTRUDER_PRESET_DEFAULT_COLORS[slotIndex];
  }
  return fullColors;
}

/**
 * Sub-plan #2c: single-plate view of `sourceInfo` (plates narrowed to the selected
 * plate; usedExtruderIndices / hasPaintData / objectExtruderMap plate-scoped).
 * Returns `sourceInfo` unchanged when the plate is not found. (Deprecated in the
 * app for UI state; still used for embed-time plate scoping.)
 */
export function buildSelectedPlateInfo(sourceInfo, selectedPlateId) {
  const sourcePlate = sourceInfo.plates.find((p) => p.plateId === selectedPlateId);
  if (!sourcePlate) return sourceInfo;
  // Dragon Scale plate 3: prefer per-part extruders over the object-level default.
  const plateObjectExtruders = new Set(sourcePlate.objectIds.flatMap((objectId) => {
    const perPart = sourceInfo.objectPartExtruders.get(objectId);
    if (perPart != null && perPart.size > 0) return [...perPart];
    const v = sourceInfo.objectExtruderMap.get(objectId);
    return v != null ? [v] : [];
  }).filter((v) => v > 0));
  // Sub-plan #2d: painted plates union paint extruder states (slip slide plate 3);
  // unpainted plates keep layer-tool extruders.
  let plateUsedExtruders;
  if (sourcePlate.hasPaintData) {
    plateUsedExtruders = sortedSet([
      ...plateObjectExtruders,
      ...[...sourcePlate.paintExtruderStates].filter((v) => v > 0),
      ...[...sourcePlate.filamentMapSlots].filter((v) => v > 0),
      ...[...sourcePlate.layerToolExtruders].filter((v) => v > 0),
    ]);
    if (plateUsedExtruders.size === 0) plateUsedExtruders = sourceInfo.usedExtruderIndices;
  } else {
    plateUsedExtruders = sortedSet([
      ...plateObjectExtruders,
      ...[...sourcePlate.filamentMapSlots].filter((v) => v > 0),
      ...[...sourcePlate.layerToolExtruders].filter((v) => v > 0),
    ]);
  }
  // Narrow objectExtruderMap to the plate (other plates leaked into the palette
  // order otherwise); keep compound parts whose parent object is on the plate.
  const plateObjectIdSet = new Set(sourcePlate.objectIds);
  const plateScopedObjectExtruderMap = new Map();
  for (const [key, v] of sourceInfo.objectExtruderMap) {
    const parent = sourceInfo.compoundPartParents.get(key);
    if (plateObjectIdSet.has(key) || (parent != null && plateObjectIdSet.has(parent))) {
      plateScopedObjectExtruderMap.set(key, v);
    }
  }
  return copyThreeMfInfo(sourceInfo, {
    plates: [sourcePlate],
    usedExtruderIndices: plateUsedExtruders,
    hasPaintData: sourcePlate.hasPaintData,
    hasLayerToolChanges: sourcePlate.hasLayerToolChanges || sourceInfo.hasLayerToolChanges,
    objectExtruderMap: plateScopedObjectExtruderMap,
  });
}
