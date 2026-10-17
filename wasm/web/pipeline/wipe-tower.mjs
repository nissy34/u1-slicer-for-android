// Ports of app/src/main/java/com/u1/slicer/data/WipeTowerDepthEstimator.kt and the
// wipe-tower helpers in SlicerViewModel.kt (resolveWipeTowerDepth,
// resolveWipeTowerWidth, wipeTowerClampBounds). All values are Kotlin Floats.
const f = Math.fround;

/**
 * Estimates wipe tower depth for the Prepare preview before slicing. Mirrors
 * PartPlate::estimate_wipe_tower_size(): WipeTower::min_depth_per_height lookup
 * {100mm -> 20mm, 250mm -> 40mm}, linearly interpolated; primeVolume wins if larger.
 */
export function estimateDepth(modelHeightMm, primeVolumeMm = 0) {
  const h = f(modelHeightMm);
  let heightBased;
  if (h <= 100) heightBased = 20;
  else if (h >= 250) heightBased = 40;
  else heightBased = f(20 + f(f(f(h - 100) / 150) * 20));
  return Math.max(heightBased, f(primeVolumeMm));
}

export const WipeTowerDepthEstimator = { estimateDepth };

/**
 * Effective wipe tower depth: the active primeVolume override (mm) if set,
 * otherwise the height-based estimate.
 * @param {number} modelHeightMm
 * @param {{primeVolume?: {mode: string, value: number|null}}} overrides SlicingOverrides shape
 */
export function resolveWipeTowerDepth(modelHeightMm, overrides) {
  const ov = overrides?.primeVolume ?? { mode: 'USE_FILE', value: null };
  const primeVolumeMm = ov.mode === 'OVERRIDE' && ov.value != null ? f(ov.value) : 0;
  return estimateDepth(modelHeightMm, primeVolumeMm);
}

/**
 * Effective wipe tower width: the active primeTowerWidth override if set,
 * otherwise config.wipeTowerWidth (SliceConfig default 60).
 * @param {{wipeTowerWidth?: number}} config
 * @param {{primeTowerWidth?: {mode: string, value: number|null}}} overrides
 */
export function resolveWipeTowerWidth(config, overrides) {
  const ov = overrides?.primeTowerWidth ?? { mode: 'USE_FILE', value: null };
  return ov.mode === 'OVERRIDE' && ov.value != null ? f(ov.value) : f(config?.wipeTowerWidth ?? 60);
}

/**
 * (maxX, maxY) for wipe tower position clamping. X uses towerWidth, Y uses
 * towerDepth (estimated from model height) — the pre-slice clamp used width
 * for both axes before (40mm discrepancy with the UI drag clamp).
 * @returns {[number, number]}
 */
export function wipeTowerClampBounds(bedSizeX, bedSizeY, towerWidth, towerDepth) {
  const maxX = Math.max(f(bedSizeX - towerWidth), 0);
  const maxY = Math.max(f(bedSizeY - towerDepth), 0);
  return [maxX, maxY];
}
