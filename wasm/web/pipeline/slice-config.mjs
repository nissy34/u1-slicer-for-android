// Port of app/src/main/java/com/u1/slicer/data/SliceConfig.kt plus the JNI
// field mapping in app/src/main/cpp/src/sapil_config.cpp (configFromJava).
//
// `sliceConfig(init)` is the Kotlin data-class constructor with its defaults
// (camelCase fields; IntArray/FloatArray/Array<String> become plain arrays).
// Copy with `{ ...cfg, field: value }`.
// `toNativeSliceConfig(cfg)` produces the snake_case JSON object consumed by
// wasm/src/slice_config_json.hpp (config_from_json), exactly the field set
// configFromJava reads from the Kotlin object.

/** Kotlin SliceConfig defaults (Snapmaker U1). Note these differ from the C++ struct defaults. */
export const SLICE_CONFIG_DEFAULTS = Object.freeze({
  // Print settings
  layerHeight: 0.2,
  firstLayerHeight: 0.3,
  perimeters: 2,
  topSolidLayers: 5,
  bottomSolidLayers: 4,
  fillDensity: 0.15,
  fillPattern: 'gyroid',
  // Speed (mm/s) — U1 defaults matching standard_0.20mm.json process profile.
  // printSpeed sets outer_wall_speed (inner wall, infill, travel use profile values).
  printSpeed: 200,
  travelSpeed: 500,
  firstLayerSpeed: 50,
  // Temperature
  nozzleTemp: 210,
  bedTemp: 60,
  // Retraction
  retractLength: 0.8,
  retractSpeed: 45,
  // Support
  supportEnabled: false,
  supportType: 'normal',
  supportAngle: 45,
  supportFilament: 0,
  supportInterfaceFilament: 0,
  // Skirt/Brim
  skirtLoops: 0,
  skirtDistance: 6,
  brimWidth: 0,
  // Printer bed (Snapmaker U1: 270x270x270mm)
  bedSizeX: 270,
  bedSizeY: 270,
  maxPrintHeight: 270,
  // Nozzle
  nozzleDiameter: 0.4,
  // Filament
  filamentDiameter: 1.75,
  filamentType: 'PLA',
  filamentTypes: Object.freeze([]),
  // Multi-extruder (up to 4 for Snapmaker U1)
  extruderCount: 1,
  extruderTemps: Object.freeze([]),
  extruderRetractLength: Object.freeze([]),
  extruderRetractSpeed: Object.freeze([]),
  // Wipe tower (for multi-extruder)
  wipeTowerEnabled: false,
  wipeTowerX: 170,
  wipeTowerY: 140,
  wipeTowerWidth: 60,
  // B106: machine G-code templates for STL files (no embedded Snapmaker profile).
  // Empty string = use OrcaSlicer's built-in default.
  machineStartGcode: '',
  machineEndGcode: '',
  machineChangeFilamentGcode: '',
  // Explicit native machine policy.
  machineTarget: 'SNAPMAKER_U1',
  // Pipe-delimited Orca keys changed explicitly by the user (Bambu native slicing).
  bambuExplicitOverrides: '',
  // F91: per-extruder filament tuning from the user's filament library. Empty =
  // "not set — let the embed value / applyConfigToPrusa fallback stand".
  filamentFlowRatios: Object.freeze([]),
  filamentMaxVolumetricSpeeds: Object.freeze([]),
  filamentFanMinSpeeds: Object.freeze([]),
  filamentFanMaxSpeeds: Object.freeze([]),
  filamentOverhangFanSpeeds: Object.freeze([]),
  filamentAdditionalCoolingFanSpeeds: Object.freeze([]),
  filamentSlowDownLayerTimes: Object.freeze([]),
  filamentSlowDownMinSpeeds: Object.freeze([]),
  filamentCloseFanFirstLayers: Object.freeze([]),
  filamentFullFanSpeedLayers: Object.freeze([]),
  filamentEnablePressureAdvance: Object.freeze([]), // 0 = unset / off, 1 = on
  filamentPressureAdvances: Object.freeze([]),
  filamentMinimalPurgeOnWipeTower: Object.freeze([]),
  filamentNozzleTempInitialLayers: Object.freeze([]),
  filamentBedTempInitialLayers: Object.freeze([]),
  filamentCosts: Object.freeze([]),
  // Full-spectrum mixed-filament recipe (serialized MixedFilamentManager output)
  mixedFilamentDefinitions: '',
});

/** Kotlin `SliceConfig(...)`: defaults for every field not given in `init`. Arrays are copied. */
export function sliceConfig(init = {}) {
  const cfg = {};
  for (const [k, def] of Object.entries(SLICE_CONFIG_DEFAULTS)) {
    const v = init[k] !== undefined ? init[k] : def;
    cfg[k] = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : v;
  }
  return cfg;
}

// [kotlinField, c++Field, jniType] in configFromJava order.
export const NATIVE_FIELD_MAP = Object.freeze([
  ['layerHeight', 'layer_height', 'F'],
  ['firstLayerHeight', 'first_layer_height', 'F'],
  ['perimeters', 'perimeters', 'I'],
  ['topSolidLayers', 'top_solid_layers', 'I'],
  ['bottomSolidLayers', 'bottom_solid_layers', 'I'],
  ['fillDensity', 'fill_density', 'F'],
  ['fillPattern', 'fill_pattern', 'S'],
  ['printSpeed', 'print_speed', 'F'],
  ['travelSpeed', 'travel_speed', 'F'],
  ['firstLayerSpeed', 'first_layer_speed', 'F'],
  ['nozzleTemp', 'nozzle_temp', 'I'],
  ['bedTemp', 'bed_temp', 'I'],
  ['retractLength', 'retract_length', 'F'],
  ['retractSpeed', 'retract_speed', 'F'],
  ['supportEnabled', 'support_enabled', 'Z'],
  ['supportType', 'support_type', 'S'],
  ['supportAngle', 'support_angle', 'F'],
  ['supportFilament', 'support_filament', 'I'],
  ['supportInterfaceFilament', 'support_interface_filament', 'I'],
  ['skirtLoops', 'skirt_loops', 'I'],
  ['skirtDistance', 'skirt_distance', 'F'],
  ['brimWidth', 'brim_width', 'F'],
  ['bedSizeX', 'bed_size_x', 'F'],
  ['bedSizeY', 'bed_size_y', 'F'],
  ['maxPrintHeight', 'max_print_height', 'F'],
  ['nozzleDiameter', 'nozzle_diameter', 'F'],
  ['filamentDiameter', 'filament_diameter', 'F'],
  ['filamentType', 'filament_type', 'S'],
  ['filamentTypes', 'filament_types', '[S'],
  ['extruderCount', 'extruder_count', 'I'],
  ['extruderTemps', 'extruder_temps', '[I'],
  ['extruderRetractLength', 'extruder_retract_length', '[F'],
  ['extruderRetractSpeed', 'extruder_retract_speed', '[F'],
  ['wipeTowerEnabled', 'wipe_tower_enabled', 'Z'],
  ['wipeTowerX', 'wipe_tower_x', 'F'],
  ['wipeTowerY', 'wipe_tower_y', 'F'],
  ['wipeTowerWidth', 'wipe_tower_width', 'F'],
  ['machineStartGcode', 'machine_start_gcode', 'S'],
  ['machineEndGcode', 'machine_end_gcode', 'S'],
  ['machineChangeFilamentGcode', 'machine_change_filament_gcode', 'S'],
  ['machineTarget', 'machine_target', 'S'],
  ['bambuExplicitOverrides', 'bambu_explicit_overrides', 'S'],
  ['filamentFlowRatios', 'filament_flow_ratios', '[F'],
  ['filamentMaxVolumetricSpeeds', 'filament_max_volumetric_speeds', '[F'],
  ['filamentFanMinSpeeds', 'filament_fan_min_speeds', '[I'],
  ['filamentFanMaxSpeeds', 'filament_fan_max_speeds', '[I'],
  ['filamentOverhangFanSpeeds', 'filament_overhang_fan_speeds', '[I'],
  ['filamentAdditionalCoolingFanSpeeds', 'filament_additional_cooling_fan_speeds', '[I'],
  ['filamentSlowDownLayerTimes', 'filament_slow_down_layer_times', '[F'],
  ['filamentSlowDownMinSpeeds', 'filament_slow_down_min_speeds', '[F'],
  ['filamentCloseFanFirstLayers', 'filament_close_fan_first_layers', '[I'],
  ['filamentFullFanSpeedLayers', 'filament_full_fan_speed_layers', '[I'],
  ['filamentEnablePressureAdvance', 'filament_enable_pressure_advance', '[I'],
  ['filamentPressureAdvances', 'filament_pressure_advances', '[F'],
  ['filamentMinimalPurgeOnWipeTower', 'filament_minimal_purge_on_wipe_tower', '[F'],
  ['filamentNozzleTempInitialLayers', 'filament_nozzle_temp_initial_layers', '[I'],
  ['filamentBedTempInitialLayers', 'filament_bed_temp_initial_layers', '[I'],
  ['filamentCosts', 'filament_costs', '[F'],
  ['mixedFilamentDefinitions', 'mixed_filament_definitions', 'S'],
].map((e) => Object.freeze(e)));

const toJniInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(-2147483648, Math.min(2147483647, n)) : 0;
};
const toJniFloat = (v) => {
  const n = Math.fround(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const CONVERT = {
  F: toJniFloat,
  I: toJniInt,
  Z: (v) => !!v,
  S: (v) => (v == null ? '' : String(v)), // JNI getString: null -> ""
  '[F': (v) => (v ? Array.from(v, toJniFloat) : []),
  '[I': (v) => (v ? Array.from(v, toJniInt) : []),
  '[S': (v) => (v ? Array.from(v, (s) => (s == null ? '' : String(s))) : []),
};

/**
 * Kotlin SliceConfig -> sapil::SliceConfig JSON (snake_case keys), mirroring
 * configFromJava: every field is sent (a field missing on `cfg` takes the
 * Kotlin default, as the JNI object always carries one). Floats are rounded to
 * float32 like the JNI Float fields.
 */
export function toNativeSliceConfig(cfg) {
  const full = sliceConfig(cfg ?? {});
  const out = {};
  for (const [k, cpp, t] of NATIVE_FIELD_MAP) out[cpp] = CONVERT[t](full[k]);
  return out;
}
