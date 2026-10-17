// Port of app/src/main/java/com/u1/slicer/model/ModelScaleConverter.kt (F83, GitHub #136).
// Converts between absolute-mm input and the percent-based scale factor.
const f = Math.fround;

/** Minimum permitted mm value for any axis. */
export const MIN_MM = 1;
/** Snapmaker U1 build volume (square, X = Y = Z = 270 mm). */
export const BED_MM = 270;
/** Percent-scale clamp range, kept in sync with the percent slider. */
export const MIN_SCALE = f(0.1);
export const MAX_SCALE = 3;

const coerceIn = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** mm on one axis -> scale factor clamped to MIN_SCALE..MAX_SCALE; null when loadTimeSize <= 0. */
export function mmToScale(mm, loadTimeSize) {
  if (loadTimeSize <= 0) return null;
  const clampedMm = Math.max(f(mm), MIN_MM);
  return coerceIn(f(clampedMm / f(loadTimeSize)), MIN_SCALE, MAX_SCALE);
}

/** Scale factor -> mm size on a given axis. */
export const scaleToMm = (scale, loadTimeSize) => f(f(scale) * f(loadTimeSize));

/** True when the scaled size exceeds the 270 mm bed (soft UI warning). */
export const exceedsBed = (scale, loadTimeSize) => scaleToMm(scale, loadTimeSize) > BED_MM;

export const ModelScaleConverter = { MIN_MM, BED_MM, MIN_SCALE, MAX_SCALE, mmToScale, scaleToMm, exceedsBed };
