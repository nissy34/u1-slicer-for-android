// Ports of the canonical filament list data model and its pure builders:
//   app/src/main/java/com/u1/slicer/data/CanonicalFilamentList.kt
//   app/src/main/java/com/u1/slicer/data/PerFilamentResolver.kt
//   app/src/main/java/com/u1/slicer/bambu/BambuCanonicalList.kt   (pure helpers + bambuFileColourList)
//   app/src/main/java/com/u1/slicer/bambu/PrusaSlicerCanonicalList.kt (pure helpers)
// The zip-walking entry points that need the paint decoder / 3MF parser
// (bambuCanonicalList, prusaSlicerCanonicalList, canonicalListAtLoad) live in
// canonical-list-at-load.mjs.
//
// Shapes:
//   FilamentEntry          -> { fileIndex, color, materialType: string|null, source }
//   CanonicalFilamentList  -> { filaments: FilamentEntry[], paintStateMap: Map<number,number>,
//                               layerToolMode } with non-enumerable getters
//                               size / isMultiColour / isLayerTool.
//   per-filament overrides -> Map (or plain object) fileIndex -> [color|null, material|null]
//                               (Kotlin Pair); { color, materialType } objects are accepted too.
import { getEntry, readZip, decodeText } from './zip.mjs';
import { toIntOrNull } from './kt.mjs';
import { nozzleTempDefaultForMaterial } from './extruder-preset.mjs';

/** Where a FilamentEntry came from at load time (Kotlin `enum class FilamentSource`). */
export const FilamentSource = Object.freeze({
  FILE_COLOUR: 'FILE_COLOUR',
  PAINT_DERIVED: 'PAINT_DERIVED',
  OBJECT_DEFAULT: 'OBJECT_DEFAULT',
  LAYER_TOOL: 'LAYER_TOOL',
  STL_DEFAULT: 'STL_DEFAULT',
  SUPPORT_FILAMENT: 'SUPPORT_FILAMENT',
  PHYSICAL_SLOT: 'PHYSICAL_SLOT',
});

/** How a layer-tool / Hueforge file is sliced (Kotlin `enum class LayerToolMode`). */
export const LayerToolMode = Object.freeze({
  MULTI_FILAMENT: 'MULTI_FILAMENT',
  SINGLE_PAUSE: 'SINGLE_PAUSE',
});

/** Kotlin `FilamentEntry(fileIndex, color, materialType, source)`. fileIndex is the G-code `T<n>` identity. */
export function filamentEntry(fileIndex, color, materialType, source) {
  return { fileIndex, color, materialType: materialType ?? null, source };
}

const toMap = (m) => (m instanceof Map ? new Map(m)
  : new Map(Object.entries(m ?? {}).map(([k, v]) => [Number(k), v])));

/**
 * Kotlin `CanonicalFilamentList(filaments, paintStateMap = emptyMap(),
 * layerToolMode = MULTI_FILAMENT)`.
 */
export function canonicalFilamentList({ filaments, paintStateMap = new Map(), layerToolMode = LayerToolMode.MULTI_FILAMENT }) {
  const list = { filaments: [...filaments], paintStateMap: toMap(paintStateMap), layerToolMode };
  Object.defineProperties(list, {
    /** Number of filaments declared by the file. Matches G-code `T0..T(size-1)`. */
    size: { get() { return this.filaments.length; } },
    isMultiColour: { get() { return this.filaments.length > 1; } },
    isLayerTool: { get() { return this.filaments.some((e) => e.source === FilamentSource.LAYER_TOOL); } },
  });
  return list;
}

/** Kotlin `canonical.copy(...)`. */
export const copyCanonicalFilamentList = (list, patch = {}) => canonicalFilamentList({
  filaments: patch.filaments ?? list.filaments,
  paintStateMap: patch.paintStateMap ?? list.paintStateMap,
  layerToolMode: patch.layerToolMode ?? list.layerToolMode,
});

const overrideAt = (overrides, i) => (overrides instanceof Map ? overrides.get(i) : overrides?.[i]);
/** (color, material) of a per-filament override, or null when absent. */
function overridePair(overrides, i) {
  const v = overrideAt(overrides, i);
  if (v == null) return null;
  if (Array.isArray(v)) return [v[0] ?? null, v[1] ?? null];
  return [v.color ?? v.first ?? null, v.materialType ?? v.second ?? null];
}
const overridesEmpty = (o) => (o instanceof Map ? o.size === 0 : Object.keys(o ?? {}).length === 0);

/**
 * Phase 2.6/2.8 — applies per-file-index user overrides (colour and/or
 * material) to a canonical list. Entries without an override are unchanged.
 */
export function applyOverridesToCanonical(canonical, overrides) {
  if (overridesEmpty(overrides)) return canonical;
  const updated = canonical.filaments.map((entry) => {
    const ov = overridePair(overrides, entry.fileIndex);
    if (!ov) return entry;
    const [overrideColor, overrideMaterial] = ov;
    if (overrideColor == null && overrideMaterial == null) return entry;
    return { ...entry, color: overrideColor ?? entry.color, materialType: overrideMaterial ?? entry.materialType };
  });
  return copyCanonicalFilamentList(canonical, { filaments: updated });
}

/** Phase 2.1 — single STL_DEFAULT entry keyed to the user's selected preset (re-call, don't cache). */
export function stlCanonicalList(presetColor, presetMaterialType) {
  return canonicalFilamentList({
    filaments: [filamentEntry(0, presetColor, presetMaterialType, FilamentSource.STL_DEFAULT)],
  });
}

/**
 * Phase 2.7 / B128 — per-canonical-filament filament_type and nozzle_temperature.
 * Material resolution per fileIndex i:
 *   1. user override material;
 *   2. the file's declared material, ONLY for a genuinely declared spool
 *      (FILE_COLOUR, multi-colour non-paint file, injective slot mapping);
 *   3. the mapped slot preset's material (blank treated as null — DC15);
 *   4. the file material, then "PLA".
 * Temp: the slot's linked profile temp only when there is no override and the
 * resolved material equals the slot preset's material; else the material default.
 * Cascade-free: an override at fileIndex N affects only index N.
 *
 * @returns {[string[], number[]]} (types, temps) — Kotlin Pair
 */
export function resolvePerFilamentTypeAndTemp({ canonical, overrides, colorMapping, presets, filamentLibrary }) {
  const types = [];
  const temps = [];
  const n = canonical.filaments.length;
  const slotOf = (i) => colorMapping?.[i] ?? 0;

  const slotUsage = new Map();
  for (let i = 0; i < n; i++) slotUsage.set(slotOf(i), (slotUsage.get(slotOf(i)) ?? 0) + 1);
  const declaredContext = n > 1 && canonical.paintStateMap.size === 0;

  for (let i = 0; i < n; i++) {
    const overrideMaterial = overridePair(overrides, i)?.[1] ?? null;
    const slot = slotOf(i);
    const slotPreset = presets.find((p) => p.index === slot);
    const entry = canonical.filaments[i];
    const fileMaterial = entry.materialType ?? null;
    const fileMaterialWins = declaredContext &&
      entry.source === FilamentSource.FILE_COLOUR &&
      fileMaterial != null &&
      (slotUsage.get(slot) ?? 0) === 1;

    // DC15: blank slot material falls through like null.
    const slotMaterial = slotPreset?.materialType && slotPreset.materialType.trim() !== '' ? slotPreset.materialType : null;
    let material;
    if (overrideMaterial != null) material = overrideMaterial;
    else if (fileMaterialWins) material = fileMaterial;
    else material = slotMaterial ?? fileMaterial ?? 'PLA';
    types.push(material);

    const profileTempApplies = overrideMaterial == null && slotPreset?.materialType === material;
    let profileTemp = null;
    if (profileTempApplies && slotPreset?.filamentProfileId != null) {
      profileTemp = filamentLibrary.find((f) => f.id === slotPreset.filamentProfileId)?.nozzleTemp ?? null;
    }
    temps.push(profileTemp ?? nozzleTempDefaultForMaterial(material));
  }
  return [types, temps];
}

// ─── Bambu / OrcaSlicer project_settings.config ───────────────────────────

export const PROJECT_SETTINGS_PATH = 'Metadata/project_settings.config';
export const LAYER_TOOL_PATH = 'Metadata/custom_gcode_per_layer.xml';

// Android org.json value coercions used by the Kotlin code.
function jsonToString(v) {
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const optString = (arr, i, fallback) => (i < 0 || i >= arr.length || arr[i] === undefined ? fallback : jsonToString(arr[i]));

function parseJsonObject(text) {
  try {
    const obj = JSON.parse(String(text).trim());
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * M3-B `full_spectrum_physical_count` marker from a project_settings.config JSON
 * string (string or numeric form). Positive int or null.
 */
export function readFullSpectrumPhysicalCount(jsonText) {
  const json = parseJsonObject(jsonText);
  if (!json || !Object.hasOwn(json, 'full_spectrum_physical_count')) return null;
  const v = json.full_spectrum_physical_count;
  let n = toIntOrNull((v === undefined ? '' : jsonToString(v)).trim());
  if (n == null) {
    // optInt(key, 0): numbers truncate, numeric strings parse as double, else 0.
    if (typeof v === 'number') n = Math.trunc(v);
    else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))) n = Math.trunc(Number(v.trim()));
    else n = 0;
  }
  return n > 0 ? n : null;
}

/** Builds the FILE_COLOUR canonical list from a project_settings.config JSON string, or null. */
export function buildFromProjectSettings(jsonText) {
  const json = parseJsonObject(jsonText);
  if (!json) return null;
  const colours = json.filament_colour;
  if (!Array.isArray(colours) || colours.length === 0) return null;
  const types = Array.isArray(json.filament_type) ? json.filament_type : null;

  const entries = colours.map((_, i) => {
    const rawColour = optString(colours, i, '');
    const cleaned = (/#[0-9A-Fa-f]{6,8}/.exec(rawColour)?.[0] ?? rawColour).slice(0, 7);
    let materialType = null;
    if (types && i < types.length) {
      const v = optString(types, i, '');
      materialType = v.trim() !== '' ? v : null;
    }
    return filamentEntry(i, cleaned, materialType, FilamentSource.FILE_COLOUR);
  });
  return canonicalFilamentList({ filaments: entries });
}

/**
 * @deprecated use bambuCanonicalList (canonical-list-at-load.mjs), which also
 * folds in paint segmentation. FILE_COLOUR-only list from a 3MF's bytes, or null.
 */
export function bambuFileColourList(bytes) {
  try {
    const entries = readZip(bytes);
    const entry = getEntry(entries, PROJECT_SETTINGS_PATH);
    if (!entry) return null;
    return buildFromProjectSettings(decodeText(entry.data));
  } catch {
    return null;
  }
}

/**
 * Every non-blank `paint_color` / `mmu_segmentation` / `slic3rpe:mmu_segmentation`
 * value on one XML line. (Like the Kotlin, a paint_color match is searched for
 * before mmu_segmentation at each step.)
 */
export function extractPaintSpecs(line) {
  const list = [];
  let startIdx = 0;
  for (;;) {
    let idx = line.indexOf('paint_color="', startIdx);
    if (idx === -1) idx = line.indexOf('mmu_segmentation="', startIdx);
    if (idx === -1) break;
    const quoteStart = line.indexOf('"', idx) + 1;
    const quoteEnd = line.indexOf('"', quoteStart);
    if (quoteEnd === -1) break;
    const spec = line.substring(quoteStart, quoteEnd);
    if (spec.trim() !== '') list.push(spec);
    startIdx = quoteEnd + 1;
  }
  return list;
}

/** Extruder (1-based) -> first colour seen, over type 1/2 `<layer>` entries. Map in first-seen order. */
export function parseLayerToolColourPairs(xml) {
  const typeRe = /\btype="([^"]+)"/;
  const extruderRe = /\bextruder="([^"]+)"/;
  const colorRe = /\bcolor="([^"]+)"/;
  const pairs = new Map();
  for (const match of xml.matchAll(/<layer\b([^>]*)>/g)) {
    const attrs = match[1];
    const type = typeRe.exec(attrs)?.[1];
    if (type !== '1' && type !== '2') continue;
    const extruder = toIntOrNull(extruderRe.exec(attrs)?.[1] ?? null);
    if (extruder == null) continue;
    const c = colorRe.exec(attrs)?.[1];
    if (c == null || c.trim() === '') continue;
    if (!pairs.has(extruder)) pairs.set(extruder, c.slice(0, 7));
  }
  return pairs;
}

/**
 * Extends `base` with LAYER_TOOL entries so every 1-based extruder referenced
 * by `info.extruders` has an entry at fileIndex extruder-1. Colours come from
 * `colourPairs` (Map or object), else grey. Existing entries are untouched.
 */
export function mergeLayerToolData(base, info, colourPairs = new Map()) {
  const extruders = [...(info.extruders ?? [])];
  if (extruders.length === 0) return base;
  const maxExtruder = Math.max(...extruders);
  if (maxExtruder <= base.size) return base;
  const pairs = toMap(colourPairs);
  const expanded = [...base.filaments];
  while (expanded.length < maxExtruder) {
    const nextIndex = expanded.length;
    expanded.push(filamentEntry(nextIndex, pairs.get(nextIndex + 1) ?? '#808080', null, FilamentSource.LAYER_TOOL));
  }
  return copyCanonicalFilamentList(base, { filaments: expanded });
}

/**
 * Adds PAINT_DERIVED grey placeholders for paint states addressing beyond the
 * base list (B95 high-index shape) and builds paintStateMap (state N ->
 * fileIndex N-1). Note: like the Kotlin, the result has the default layerToolMode.
 */
export function mergePaintStates(base, paintStates) {
  const states = [...paintStates];
  if (states.length === 0) return base;
  const targetSize = Math.max(base.size, Math.max(...states));
  const expanded = [...base.filaments];
  while (expanded.length < targetSize) {
    expanded.push(filamentEntry(expanded.length, '#808080', null, FilamentSource.PAINT_DERIVED));
  }
  return canonicalFilamentList({ filaments: expanded, paintStateMap: new Map(states.map((s) => [s, s - 1])) });
}

// ─── PrusaSlicer Slic3r_PE.config ─────────────────────────────────────────

export const PRUSA_CONFIG_PATH = 'Metadata/Slic3r_PE.config';

/** `; key = value` / `key = value` lines -> Map (later keys win). */
export function parsePrusaIni(iniText) {
  const out = new Map();
  for (const raw of iniText.split(/\r\n|\r|\n/)) {
    const stripped = raw.replace(/^[; \t]+/, '').trimEnd();
    if (stripped === '') continue;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.substring(0, eq).trim();
    const value = stripped.substring(eq + 1).trim();
    if (key !== '') out.set(key, value);
  }
  return out;
}

/** Canonical list from Slic3r_PE.config (extruder_colour preferred over filament_colour), or null. */
export function buildFromPrusaConfig(iniText) {
  const kv = parsePrusaIni(iniText);
  const rawColours = kv.get('extruder_colour') ?? kv.get('filament_colour');
  if (rawColours == null) return null;
  const parts = rawColours.split(';')
    .map((p) => /#[0-9A-Fa-f]{6,8}/.exec(p.trim())?.[0]?.slice(0, 7))
    .filter((c) => c != null);
  if (parts.length === 0) return null;
  // PrusaSlicer uses semicolons for filament_type; some forks use commas.
  const types = kv.get('filament_type')?.split(/[;,]/).map((t) => t.trim()) ?? null;
  const entries = parts.map((colour, i) => {
    const t = types?.[i];
    return filamentEntry(i, colour, t != null && t.trim() !== '' ? t : null, FilamentSource.FILE_COLOUR);
  });
  return canonicalFilamentList({ filaments: entries });
}
