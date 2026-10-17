// Port of the top-level computeEmbedTargetCount / buildCompactExtruderRemap in
// app/src/main/java/com/u1/slicer/SlicerViewModel.kt (exercised by MergeThreeMfInfoTest).

/**
 * Compact per-object extruder remap: Map<sourceExtruder (1-based), compactIndex (1-based)>,
 * or null. `colorMapping` is the user's per-colour 0-based slot list.
 */
export function buildCompactExtruderRemap(info, colorMapping) {
  if (colorMapping == null || colorMapping.length === 0) return null;
  if (info.hasLayerToolChanges && !info.hasPaintData) return null;
  // SEMM (paint-based) models: paint-state filament indices are unaffected by the
  // model_settings.config extruder remap; PrintTimeRemap handles canonical→physical
  // at send time, so suppress the XML extruder remap here.
  if (info.hasPaintData) return null;

  const compactSlotOrder = [...new Set(colorMapping)].sort((a, b) => a - b).slice(0, 4);
  if (compactSlotOrder.length === 0) return null;

  let sortedSourceExtruders = [...info.usedExtruderIndices].filter((v) => v > 0).sort((a, b) => a - b);
  if (sortedSourceExtruders.length === 0) {
    sortedSourceExtruders = Array.from({ length: colorMapping.length }, (_, i) => i + 1);
  }
  if (sortedSourceExtruders.length === 0) return null;

  const remap = new Map();
  sortedSourceExtruders.forEach((sourceExtruder, sourceIndex) => {
    const assignedSlot = sourceIndex < colorMapping.length ? colorMapping[sourceIndex] : colorMapping[colorMapping.length - 1];
    const compactIndex = compactSlotOrder.indexOf(assignedSlot);
    if (compactIndex >= 0) remap.set(sourceExtruder, compactIndex + 1);
  });
  return remap.size > 0 ? remap : null;
}

/**
 * Extruder count to embed in the 3MF profile.
 * - H2C SEMM (more model colours than physical extruders): colorMapping.length so
 *   multi_material_segmentation_by_painting() captures every paint state (B48).
 * - Normal SEMM: distinct physical slot count.
 * - B76 hybrid paint + per-object with exactly one collapsed state: colorMapping.length.
 * - B95: never below maxSourceFilamentIndex.
 * - Per-object models with tool remap: distinct toolRemapSlots count; else fallback.
 */
export function computeEmbedTargetCount({
  colorMapping,
  hasPaintData,
  toolRemapSlots,
  fallbackExtCount,
  hasMultiExtruderAssignments = false,
  maxSourceFilamentIndex = 0,
}) {
  if (hasPaintData && colorMapping != null && colorMapping.length > 0) {
    const distinctSlots = Math.max(new Set(colorMapping).size, 1);
    const isH2c = distinctSlots >= 4 && colorMapping.length > distinctSlots;
    const isHybridSingleDedup = hasMultiExtruderAssignments && (colorMapping.length - distinctSlots) === 1;
    const baseSize = (isH2c || isHybridSingleDedup) ? colorMapping.length : distinctSlots;
    return Math.max(baseSize, maxSourceFilamentIndex);
  }
  if (toolRemapSlots != null) return new Set(toolRemapSlots).size;
  return fallbackExtCount;
}
