// Small app functions the instrumented tests call that have no pipeline/ port
// (they live in MainActivity.kt / test classes), ported verbatim, plus shared
// test plumbing for the engine tests.
import { process as sanitize } from '../pipeline/bambu-sanitizer.mjs';
import { ProfileEmbedder } from '../pipeline/profile-embedder.mjs';
import { parse } from '../pipeline/three-mf-parser.mjs';
import { readZip, getEntry, decodeText } from '../pipeline/zip.mjs';
import { PROFILES } from './engine-helpers.mjs';

/** MainActivity.kt computePlateFileIndices(info, plateId, canonicalSize, perExtruderFilamentMm). */
export function computePlateFileIndices({ info, plateId, canonicalSize, perExtruderFilamentMm = null }) {
  if (canonicalSize <= 0) return null;
  if (perExtruderFilamentMm != null) {
    const nonZero = perExtruderFilamentMm.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    if (nonZero.some((i) => i >= canonicalSize)) return null;
    if (nonZero.length) return nonZero;
  }
  if (info == null) return null;
  const detectedSize = info.detectedColors.length;
  if (info.hasPaintData && detectedSize >= 1 && detectedSize <= canonicalSize) return [...Array(detectedSize).keys()];
  const plate = plateId >= 0 ? info.plates.find((p) => p.plateId === plateId) ?? null : null;
  const inRange = (i) => i >= 0 && i < canonicalSize;
  if (plate != null && plate.filamentIndices.size > 0) {
    const z = [...new Set([...plate.filamentIndices].map((i) => i - 1).filter(inRange))].sort((a, b) => a - b);
    if (z.length) return z;
  }
  const fromUsed = [...new Set([...info.usedExtruderIndices].filter((i) => i > 0).map((i) => i - 1).filter(inRange))]
    .sort((a, b) => a - b);
  if (fromUsed.length) return fromUsed;
  if (detectedSize >= 1 && detectedSize <= canonicalSize) return [...Array(detectedSize).keys()];
  return null;
}

/** Kotlin BambuSanitizer.process(file, outDir) with isBambu = null (detect via ThreeMfParser). */
export function processAuto(bytes, name, isBambu = null) {
  return sanitize(bytes, { isBambu: isBambu ?? !!parse(bytes, { name }).isBambu });
}

export const newEmbedder = () => new ProfileEmbedder({ ...PROFILES });

/** Text of one ZIP entry, or null. */
export function zipEntryText(bytes, name) {
  const e = getEntry(readZip(bytes), name);
  return e ? decodeText(e.data) : null;
}

/** Kotlin File.readText() of a (STORED-entry) 3MF archive. */
export const fileText = (bytes) => new TextDecoder('utf-8').decode(bytes);

/** Kotlin String.substringAfter(d).substringBefore(e) (missing delimiters keep the whole string). */
export function between(s, after, before) {
  const i = s.indexOf(after);
  const rest = i < 0 ? s : s.slice(i + after.length);
  const j = rest.indexOf(before);
  return j < 0 ? rest : rest.slice(0, j);
}

/** Memoize an async producer (one engine slice reused by several tests asserting on the same output). */
export function once(fn) {
  let p = null;
  return () => (p ??= fn());
}
