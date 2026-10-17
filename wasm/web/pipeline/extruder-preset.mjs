// Port of app/src/main/java/com/u1/slicer/data/ExtruderPreset.kt.
// ExtruderPreset -> { index, color, materialType, filamentProfileId, displayLabel }.

/** Default colours: Red, Green, Blue, White — distinct for multi-colour testing. */
export const DEFAULT_COLORS = Object.freeze(['#FF0000', '#00FF00', '#0000FF', '#FFFFFF']);

/**
 * Kotlin `ExtruderPreset(index, color = DEFAULT_COLORS[0], materialType = "PLA",
 * filamentProfileId = null, displayLabel = null)`. `index` is 0-based (E1=0).
 */
export function extruderPreset({
  index,
  color = DEFAULT_COLORS[0],
  materialType = 'PLA',
  filamentProfileId = null,
  displayLabel = null,
} = {}) {
  return { index, color, materialType, filamentProfileId, displayLabel };
}

/** Kotlin `ExtruderPreset.label`: displayLabel or "E<index+1>". */
export const extruderPresetLabel = (p) => p.displayLabel ?? `E${p.index + 1}`;

/** The app's 4 default U1 slot presets (E1..E4 red/green/blue/white PLA). */
export function defaultExtruderPresets() {
  return [0, 1, 2, 3].map((i) => extruderPreset({ index: i, color: DEFAULT_COLORS[i] }));
}

/** DataStore JSON for presets (displayLabel is not persisted, as in Kotlin). */
export function serializeExtruderPresets(presets) {
  return JSON.stringify(presets.map((p) => {
    const o = { index: p.index, color: p.color, materialType: p.materialType };
    if (p.filamentProfileId != null) o.filamentProfileId = p.filamentProfileId;
    return o;
  }));
}

/**
 * Parses persisted presets; blank or malformed JSON -> defaults. Missing slots
 * 0..3 are filled with `ExtruderPreset(i)` (note: colour DEFAULT_COLORS[0], as
 * in Kotlin), then sorted by index and capped at 4.
 */
export function parseExtruderPresets(json) {
  if (json == null || String(json).trim() === '') return defaultExtruderPresets();
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) throw new Error('not an array');
    const list = arr.map((obj) => {
      if (obj === null || typeof obj !== 'object' || typeof obj.index !== 'number') throw new Error('bad preset');
      const optString = (k, d) => (obj[k] === undefined || obj[k] === null ? d : String(obj[k]));
      let filamentProfileId = null;
      if (Object.hasOwn(obj, 'filamentProfileId')) {
        if (typeof obj.filamentProfileId !== 'number') throw new Error('bad id');
        filamentProfileId = Math.trunc(obj.filamentProfileId);
      }
      return extruderPreset({
        index: Math.trunc(obj.index),
        color: optString('color', '#FFFFFF'),
        materialType: optString('materialType', 'PLA'),
        filamentProfileId,
      });
    });
    const indices = new Set(list.map((p) => p.index));
    const full = [...list];
    for (let i = 0; i <= 3; i++) if (!indices.has(i)) full.push(extruderPreset({ index: i }));
    return full.map((p, i) => [p, i]).sort((a, b) => a[0].index - b[0].index || a[1] - b[1]).map(([p]) => p).slice(0, 4);
  } catch {
    return defaultExtruderPresets();
  }
}

/**
 * SlicerViewModel.kt `nozzleTempDefaultForMaterial`: sensible nozzle temp for a
 * material (case-insensitive), 220 (PLA) for anything unknown. Lives here so
 * canonical-filament-list.mjs and profile-overrides.mjs can share it without
 * an import cycle; profile-overrides.mjs re-exports it.
 */
export function nozzleTempDefaultForMaterial(material) {
  switch (String(material).toUpperCase()) {
    case 'PETG': return 235;
    case 'ABS': return 270;
    case 'ASA': return 260;
    case 'PA': return 260;
    case 'TPU': return 225;
    case 'PVA': return 210;
    default: return 220;
  }
}
