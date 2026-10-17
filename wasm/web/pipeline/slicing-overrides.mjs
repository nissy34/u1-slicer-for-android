// Port of app/src/main/java/com/u1/slicer/data/SlicingOverrides.kt (plus the
// pure `formatFileValue` helper from ui/SlicingOverridesUI.kt).
//
// Shapes:
//   OverrideValue    -> { mode: 'USE_FILE'|'ORCA_DEFAULT'|'OVERRIDE', value: T|null }
//   SlicingOverrides -> plain object with one OverrideValue per field (see
//                       OVERRIDE_FIELDS) plus `flowCalibration: boolean`.
// Kotlin member functions become named exports taking the overrides object
// first (e.g. `ov.resolveInto(base)` -> `resolveInto(ov, base)`).
import { ktFloat, ktToInt } from './kt.mjs';

/** Per-setting override mode (Kotlin `enum class OverrideMode`). */
export const OverrideMode = Object.freeze({
  USE_FILE: 'USE_FILE',
  ORCA_DEFAULT: 'ORCA_DEFAULT',
  OVERRIDE: 'OVERRIDE',
});
const MODES = new Set(Object.values(OverrideMode));

/** Kotlin `OverrideValue(mode = USE_FILE, value = null)`. */
export function overrideValue(mode = OverrideMode.USE_FILE, value = null) {
  return { mode, value: value ?? null };
}

/**
 * Every OverrideValue field of SlicingOverrides, in Kotlin declaration order
 * (which is also the toJson key order), with its Kotlin value type.
 */
export const OVERRIDE_FIELDS = Object.freeze([
  ['layerHeight', 'float'],
  ['infillDensity', 'float'],
  ['wallCount', 'int'],
  ['infillPattern', 'string'],
  // Shell / surface (F31)
  ['topShellLayers', 'int'],
  ['bottomShellLayers', 'int'],
  ['topSurfacePattern', 'string'],
  ['bottomSurfacePattern', 'string'],
  ['sparseInfillSpeed', 'int'],
  // F41: Reduce infill retraction - default off for Snapmaker U1
  ['reduceInfillRetraction', 'boolean'],
  // F42: Wall generator and seam position
  ['wallGenerator', 'string'],
  ['seamPosition', 'string'],
  ['supports', 'boolean'],
  ['supportType', 'string'],
  ['supportAngle', 'int'],
  ['supportBuildPlateOnly', 'boolean'],
  ['supportPattern', 'string'],
  ['supportPatternSpacing', 'float'],
  ['supportInterfaceTopLayers', 'int'],
  ['supportInterfaceBottomLayers', 'int'],
  ['supportFilament', 'int'],
  ['supportInterfaceFilament', 'int'],
  // Extended support settings (F30)
  ['supportXyDistance', 'float'],
  ['supportInterfacePattern', 'string'],
  ['supportInterfaceSpacing', 'float'],
  ['supportSpeed', 'int'],
  // Tree support parameters (shown only when support type is tree)
  ['treeSupportBranchAngle', 'int'],
  ['treeSupportBranchDistance', 'float'],
  ['treeSupportBranchDiameter', 'float'],
  ['brimWidth', 'float'],
  ['skirtLoops', 'int'],
  ['bedTemp', 'int'],
  ['primeTower', 'boolean'],
  // Prime tower detail overrides (go through ProfileEmbedder JSON, not JNI)
  ['primeVolume', 'int'],
  ['primeTowerBrimWidth', 'float'],
  ['primeTowerBrimChamfer', 'boolean'],
  ['primeTowerChamferMaxWidth', 'float'],
  ['primeTowerWidth', 'float'],
  ['wipeTowerRotationAngle', 'float'],
].map((e) => Object.freeze(e)));
const FIELD_TYPE = new Map(OVERRIDE_FIELDS);

/**
 * Kotlin `SlicingOverrides(...)` constructor: every field defaults to
 * OverrideValue() (USE_FILE, null); flowCalibration defaults to true.
 */
export function slicingOverrides(init = {}) {
  const ov = {};
  for (const [name] of OVERRIDE_FIELDS) {
    const v = init[name];
    ov[name] = v ? overrideValue(v.mode, v.value) : overrideValue();
  }
  ov.flowCalibration = init.flowCalibration ?? true;
  return ov;
}

const fieldOf = (ov, name) => ov?.[name] ?? { mode: OverrideMode.USE_FILE, value: null };

/** OrcaSlicer factory defaults for ORCA_DEFAULT mode. */
export const ORCA_DEFAULTS = Object.freeze({
  layerHeight: 0.2,
  infillDensity: 0.15,
  wallCount: 2,
  infillPattern: 'gyroid',
  topShellLayers: 5,
  bottomShellLayers: 4,
  topSurfacePattern: 'monotonic',
  bottomSurfacePattern: 'monotonic',
  sparseInfillSpeed: 0,
  reduceInfillRetraction: false,
  wallGenerator: 'arachne',
  seamPosition: 'aligned',
  supports: false,
  supportType: 'normal(auto)',
  supportAngle: 30,
  supportBuildPlateOnly: false,
  supportPattern: 'default',
  supportPatternSpacing: 2.5,
  supportInterfaceTopLayers: 3,
  supportInterfaceBottomLayers: 0,
  supportFilament: 0,
  supportInterfaceFilament: 0,
  supportXyDistance: 0.35,
  supportInterfacePattern: 'auto',
  supportInterfaceSpacing: 0.5,
  supportSpeed: 0,
  treeSupportBranchAngle: 40,
  treeSupportBranchDistance: 5.0,
  treeSupportBranchDiameter: 5.0,
  brimWidth: 0,
  skirtLoops: 0,
  bedTemp: 60,
  primeTower: false,
  primeVolume: 45,
  primeTowerBrimWidth: 3,
  primeTowerBrimChamfer: true,
  primeTowerChamferMaxWidth: 5,
  primeTowerWidth: 35,
  wipeTowerRotationAngle: 0,
});

/**
 * Shared USE_FILE / ORCA_DEFAULT / OVERRIDE resolution (the local `res` /
 * `resolve` helpers in SlicingOverrides.resolveInto and buildProfileOverridesImpl).
 */
export function resolveOverride(ov, baseVal, defaultKey) {
  switch (ov?.mode) {
    case OverrideMode.ORCA_DEFAULT:
      return ORCA_DEFAULTS[defaultKey] ?? baseVal;
    case OverrideMode.OVERRIDE:
      return ov.value ?? baseVal;
    default:
      return baseVal;
  }
}

// F86: per-section and total override counts. Only OVERRIDE counts as a
// user-set override; flowCalibration (plain Boolean toggle) is excluded.
const countOverrides = (ov, names) =>
  names.filter((n) => fieldOf(ov, n).mode === OverrideMode.OVERRIDE).length;

export const layerAndInfillOverrideCount = (ov) => countOverrides(ov, [
  'layerHeight', 'infillDensity', 'wallCount', 'wallGenerator', 'seamPosition',
  'infillPattern', 'sparseInfillSpeed', 'topShellLayers', 'bottomShellLayers',
  'topSurfacePattern', 'bottomSurfacePattern', 'reduceInfillRetraction',
]);

export const supportOverrideCount = (ov) => countOverrides(ov, [
  'supports', 'supportType', 'supportAngle', 'supportBuildPlateOnly', 'supportPattern',
  'supportPatternSpacing', 'supportInterfaceTopLayers', 'supportInterfaceBottomLayers',
  'supportFilament', 'supportInterfaceFilament', 'supportXyDistance',
  'supportInterfacePattern', 'supportInterfaceSpacing', 'supportSpeed',
  'treeSupportBranchAngle', 'treeSupportBranchDistance', 'treeSupportBranchDiameter',
]);

export const primeTowerOverrideCount = (ov) => countOverrides(ov, [
  'primeTower', 'primeVolume', 'primeTowerBrimWidth', 'primeTowerBrimChamfer',
  'primeTowerChamferMaxWidth', 'primeTowerWidth', 'wipeTowerRotationAngle',
]);

export const temperatureOverrideCount = (ov) =>
  (fieldOf(ov, 'bedTemp').mode === OverrideMode.OVERRIDE ? 1 : 0);

export const otherOverrideCount = (ov) => countOverrides(ov, ['brimWidth', 'skirtLoops']);

export const totalOverrideCount = (ov) =>
  layerAndInfillOverrideCount(ov) + supportOverrideCount(ov) +
  primeTowerOverrideCount(ov) + temperatureOverrideCount(ov) + otherOverrideCount(ov);

/**
 * Resolve the prime tower setting for the embedded profile JSON. Mirrors the
 * resolveInto guard: for multi-extruder jobs, ORCA_DEFAULT and USE_FILE must
 * NOT disable the wipe tower — only an explicit OVERRIDE false is honoured.
 */
export function resolvePrimeTower(ov, slotCount, cfgWipeTower) {
  const pt = fieldOf(ov, 'primeTower');
  if (slotCount > 1 && pt.mode !== OverrideMode.OVERRIDE) return true;
  switch (pt.mode) {
    case OverrideMode.ORCA_DEFAULT: return ORCA_DEFAULTS.primeTower ?? cfgWipeTower;
    case OverrideMode.OVERRIDE: return pt.value ?? cfgWipeTower;
    default: return cfgWipeTower;
  }
}

/**
 * Resolve all override modes into `base` (a SliceConfig), returning a new
 * SliceConfig (base is not modified). Prime-tower detail overrides
 * (primeVolume etc.) go through the embedded-profile path, not here.
 */
export function resolveInto(ov, base) {
  const res = (name, baseVal, key = name) => resolveOverride(fieldOf(ov, name), baseVal, key);
  const pt = fieldOf(ov, 'primeTower');
  return {
    ...base,
    layerHeight: res('layerHeight', base.layerHeight),
    fillDensity: res('infillDensity', base.fillDensity),
    perimeters: res('wallCount', base.perimeters),
    fillPattern: res('infillPattern', base.fillPattern),
    topSolidLayers: res('topShellLayers', base.topSolidLayers),
    bottomSolidLayers: res('bottomShellLayers', base.bottomSolidLayers),
    supportEnabled: res('supports', base.supportEnabled),
    supportType: res('supportType', base.supportType),
    // Kotlin: res(supportAngle, base.supportAngle.toInt(), ...).toFloat()
    supportAngle: res('supportAngle', ktToInt(Math.fround(base.supportAngle))),
    supportFilament: res('supportFilament', base.supportFilament),
    supportInterfaceFilament: res('supportInterfaceFilament', base.supportInterfaceFilament),
    brimWidth: res('brimWidth', base.brimWidth),
    skirtLoops: res('skirtLoops', base.skirtLoops),
    bedTemp: res('bedTemp', base.bedTemp),
    // Multi-extruder slicing requires a wipe tower to produce T1 tool changes.
    // Only bypass if the user has explicitly set OVERRIDE mode to false.
    wipeTowerEnabled: base.extruderCount > 1 && pt.mode !== OverrideMode.OVERRIDE
      ? true
      : res('primeTower', base.wipeTowerEnabled),
    wipeTowerWidth: res('primeTowerWidth', base.wipeTowerWidth),
  };
}

// Android org.json number serialisation: integral values print without ".0",
// floats print as Kotlin Float.toString.
function jsonNumber(type, v) {
  if (type === 'float') {
    const f = Math.fround(v);
    return Number.isInteger(f) ? f : Number(ktFloat(f));
  }
  return v;
}

/** Kotlin `SlicingOverrides.toJson()`: identical key order and shape. */
export function toJson(ov) {
  const obj = {};
  for (const [name, type] of OVERRIDE_FIELDS) {
    const f = fieldOf(ov, name);
    const o = { mode: f.mode };
    if (f.value != null) o.value = typeof f.value === 'number' ? jsonNumber(type, f.value) : f.value;
    obj[name] = o;
  }
  obj.flowCalibration = ov?.flowCalibration ?? true;
  return JSON.stringify(obj);
}

class ParseError extends Error {}
function parseValue(type, raw) {
  switch (type) {
    case 'float':
      if (typeof raw !== 'number') throw new ParseError();
      return raw;
    case 'int':
      if (typeof raw !== 'number') throw new ParseError();
      // Kotlin Number.toInt(): truncation with Int saturation.
      return Math.max(-2147483648, Math.min(2147483647, ktToInt(raw)));
    case 'boolean':
      if (typeof raw !== 'boolean') throw new ParseError();
      return raw;
    default:
      return raw === null ? 'null' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  }
}

/** Kotlin `SlicingOverrides.fromJson(json)`: any parse failure yields defaults. */
export function fromJson(json) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return slicingOverrides();
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return slicingOverrides();
  const init = {};
  for (const [name, type] of OVERRIDE_FIELDS) {
    const o = obj[name];
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue; // optJSONObject -> OverrideValue()
    const mode = typeof o.mode === 'string' && MODES.has(o.mode) ? o.mode : OverrideMode.USE_FILE;
    let value = null;
    if (Object.hasOwn(o, 'value')) {
      try { value = parseValue(type, o.value); } catch { value = null; }
    }
    init[name] = overrideValue(mode, value);
  }
  // optBoolean("flowCalibration", true): booleans, or "true"/"false" strings.
  const fc = obj.flowCalibration;
  init.flowCalibration = typeof fc === 'boolean' ? fc
    : typeof fc === 'string' && /^(true|false)$/i.test(fc) ? fc.toLowerCase() === 'true'
      : true;
  return slicingOverrides(init);
}

/** Kotlin companion-object parity: `SlicingOverrides.ORCA_DEFAULTS`, `SlicingOverrides.fromJson`. */
export const SlicingOverrides = Object.freeze({ ORCA_DEFAULTS, fromJson });

/** Kotlin value type ('float'|'int'|'string'|'boolean') of an OverrideValue field. */
export const overrideFieldType = (name) => FIELD_TYPE.get(name);

/**
 * ui/SlicingOverridesUI.kt `formatFileValue(value: Any)`: human-readable label
 * for a value read from the file's config. JS numbers carry no Float/Int
 * distinction, so numbers format as `String(n)` (Kotlin prints `30f` as "30.0").
 */
export function formatFileValue(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') {
    if (value === '1') return 'on';
    if (value === '0') return 'off';
    if (value.endsWith('%')) return value;
    const cap = (s) => (s.length ? s[0].toUpperCase() + s.slice(1) : s);
    if (value.includes('(')) return cap(value.slice(0, value.indexOf('(')).trim());
    return value.split('_').map(cap).join(' ');
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? formatFileValue(value[0]) : `[${value.join(', ')}]`;
  return String(value);
}
