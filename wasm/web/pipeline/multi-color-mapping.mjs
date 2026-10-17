// Port of the colour -> extruder auto-mapping in app/src/main/java/com/u1/slicer/ui/MultiColorDialog.kt
// (colorDistance, findClosestExtruder, ensureMultiSlotMapping), used at load
// time to map file colours onto the closest-coloured U1 slot.

/** android.graphics.Color.parseColor for #RRGGBB / #AARRGGBB, as [r, g, b] or null. */
function parseColor(h) {
  const s = h.startsWith('#') ? h : `#${h}`;
  if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return null;
  const rgb = s.length === 9 ? s.slice(3) : s.slice(1);
  return [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16));
}

/** Euclidean RGB distance, 0..441; Number.MAX_VALUE when either colour is unparseable. */
export function colorDistance(hex1, hex2) {
  const a = parseColor(hex1 ?? '');
  const b = parseColor(hex2 ?? '');
  if (!a || !b) return Number.MAX_VALUE;
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** The preset whose colour is closest (first wins on ties, like minByOrNull), or null. */
export function findClosestExtruder(color, presets) {
  let best = null;
  let bestD = Infinity;
  for (const p of presets) {
    const d = colorDistance(color, p.color);
    if (best === null || d < bestD) { best = p; bestD = d; }
  }
  return best;
}

const distinctCount = (xs) => new Set(xs).size;

/**
 * Keeps the initial mapping multi-slot when the file is multi-colour (see the
 * Kotlin KDoc: collapsed closest-colour matches would slice single-extruder;
 * F1 calendar: >4 colours redistribute duplicates only).
 */
export function ensureMultiSlotMapping(rawMapping, colorCount) {
  if (colorCount <= 1) return rawMapping;
  if (colorCount <= 4 && distinctCount(rawMapping) < colorCount) return Array.from({ length: colorCount }, (_, i) => i);
  if (colorCount > 4 && [...new Set(rawMapping)].filter((s) => s >= 0 && s <= 3).length < 4) {
    return redistributeDuplicateSlots(rawMapping);
  }
  if (distinctCount(rawMapping) < 2) return Array.from({ length: colorCount }, (_, i) => i % 2);
  return rawMapping;
}

function redistributeDuplicateSlots(rawMapping) {
  const result = rawMapping.slice();
  const seen = new Set();
  const unused = [0, 1, 2, 3].filter((slot) => !rawMapping.includes(slot));
  for (let i = 0; i < result.length; i++) {
    const slot = result[i];
    if (slot >= 0 && slot <= 3 && !seen.has(slot)) {
      seen.add(slot);
    } else {
      if (!unused.length) continue;
      const replacement = unused.shift();
      result[i] = replacement;
      seen.add(replacement);
    }
  }
  return result;
}
