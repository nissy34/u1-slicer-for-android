// Ports of the top-level slice-config helpers in
// app/src/main/java/com/u1/slicer/SlicerViewModel.kt (buildProfileOverridesImpl,
// computeTogglePrimeTower, nozzleTempDefaultForMaterial, computeFreshSlotTemps,
// buildFilamentLibraryArrays/Settings, filament_type / nozzle_temperature
// header resolution + patching) and the private
// SlicerViewModel.buildProfileOverrides as the pure `buildProfileOverrides`.
//
// Values that Kotlin formats with Float.toString() use ktFloat, so emitted
// strings match the app exactly ("0.0", "20.0", "0.35").
// The returned overrides map is a plain object in Kotlin insertion order;
// list values are arrays of strings.
import { ktFloat, ktToInt } from './kt.mjs';
import {
  OverrideMode, ORCA_DEFAULTS, overrideValue, resolveOverride, resolvePrimeTower,
} from './slicing-overrides.mjs';
import { applyOverridesToCanonical, resolvePerFilamentTypeAndTemp } from './canonical-filament-list.mjs';
import { nozzleTempDefaultForMaterial } from './extruder-preset.mjs';

export { nozzleTempDefaultForMaterial };
// resolveWipeTowerDepth / resolveWipeTowerWidth / wipeTowerClampBounds are
// ported in wipe-tower.mjs; re-exported here for convenience.
export { resolveWipeTowerDepth, resolveWipeTowerWidth, wipeTowerClampBounds } from './wipe-tower.mjs';

const f32 = Math.fround;
const intStr = (v) => String(ktToInt(Number(v)));
const fieldOf = (ov, name) => ov?.[name] ?? { mode: OverrideMode.USE_FILE, value: null };

/**
 * Build the profile overrides map for embedding into a 3MF.
 *
 * When `hasSourceConfig` (Bambu 3MF with its own config) and the supports
 * override is USE_FILE, support keys are omitted so the file's own
 * enable_support / support_threshold_angle survive ProfileEmbedder's preserve path.
 *
 * `slotCount` = physical slots used (capped at 4); `filamentCount` = file
 * filament-list size (uncapped). Per-filament arrays are sized to
 * filamentCount, per-slot arrays (wipe_tower_x/y) to slotCount.
 *
 * @param {object} cfg SliceConfig
 * @param {object} ov SlicingOverrides
 * @param {{slotCount:number, filamentCount?:number, hasSourceConfig?:boolean,
 *   filamentTypes?:string[]|null, nozzleTemps?:number[]|null, filamentColours?:string[]|null}} opts
 * @returns {Record<string, string|string[]>}
 */
export function buildProfileOverridesImpl(cfg, ov, opts) {
  const o = typeof opts === 'number' ? { slotCount: opts } : opts;
  const {
    slotCount,
    filamentCount = slotCount,
    hasSourceConfig = false,
    filamentTypes = null,
    nozzleTemps = null,
    filamentColours = null,
  } = o;
  const extruderTemps = cfg.extruderTemps ?? [];

  // Fresh slice-time nozzleTemps win over the stale load-time cfg.extruderTemps.
  let temps;
  if (nozzleTemps != null) temps = nozzleTemps.map(intStr);
  else if (extruderTemps.length >= filamentCount) temps = Array.from(extruderTemps).slice(0, filamentCount).map(intStr);
  else temps = Array.from({ length: filamentCount }, () => intStr(cfg.nozzleTemp));

  const resolve = (name, cfgValue) => resolveOverride(fieldOf(ov, name), cfgValue, name);
  const OV = (name) => fieldOf(ov, name).mode === OverrideMode.OVERRIDE;

  const layerHeight = resolve('layerHeight', cfg.layerHeight);
  const infillDensity = resolve('infillDensity', cfg.fillDensity);
  const wallCount = resolve('wallCount', cfg.perimeters);
  const infillPattern = resolve('infillPattern', cfg.fillPattern);
  const topShellLayers = resolve('topShellLayers', cfg.topSolidLayers);
  const bottomShellLayers = resolve('bottomShellLayers', cfg.bottomSolidLayers);
  const topSurfacePattern = resolve('topSurfacePattern', 'monotonic');
  const bottomSurfacePattern = resolve('bottomSurfacePattern', 'monotonic');
  const sparseInfillSpeed = resolve('sparseInfillSpeed', 0);
  const reduceInfillRetraction = resolve('reduceInfillRetraction', false);
  const wallGenerator = resolve('wallGenerator', 'arachne');
  const seamPosition = resolve('seamPosition', 'aligned');
  const supportEnabled = resolve('supports', cfg.supportEnabled);
  const supportType = resolve('supportType', cfg.supportType);
  const supportAngle = resolve('supportAngle', ktToInt(f32(cfg.supportAngle)));
  const supportBuildPlateOnly = resolve('supportBuildPlateOnly', false);
  const supportPattern = resolve('supportPattern', 'default');
  const supportPatternSpacing = resolve('supportPatternSpacing', 2.5);
  const supportInterfaceTopLayers = resolve('supportInterfaceTopLayers', 3);
  const supportInterfaceBottomLayers = resolve('supportInterfaceBottomLayers', 0);
  const supportFilament = resolve('supportFilament', 0);
  const supportInterfaceFilament = resolve('supportInterfaceFilament', 0);
  const effectiveFilamentCount = Math.max(filamentCount, supportFilament, supportInterfaceFilament);
  while (temps.length < effectiveFilamentCount) {
    const t = nozzleTemps?.[temps.length];
    temps.push(t != null ? intStr(t) : intStr(cfg.nozzleTemp));
  }
  const supportXyDistance = resolve('supportXyDistance', 0.35);
  const supportInterfacePattern = resolve('supportInterfacePattern', 'auto');
  const supportInterfaceSpacing = resolve('supportInterfaceSpacing', 0.5);
  const supportSpeed = resolve('supportSpeed', 0);
  const treeSupportBranchAngle = resolve('treeSupportBranchAngle', 40);
  const treeSupportBranchDistance = resolve('treeSupportBranchDistance', 5.0);
  const treeSupportBranchDiameter = resolve('treeSupportBranchDiameter', 5.0);
  const brimWidth = resolve('brimWidth', cfg.brimWidth);
  const skirtLoops = resolve('skirtLoops', cfg.skirtLoops);
  const bedTemp = resolve('bedTemp', cfg.bedTemp);
  const primeTower = resolvePrimeTower(ov, slotCount, cfg.wipeTowerEnabled);

  const primeVolume = resolve('primeVolume', 45);
  const primeTowerBrimWidth = resolve('primeTowerBrimWidth', 3);
  const primeTowerBrimChamfer = resolve('primeTowerBrimChamfer', true);
  const primeTowerChamferMaxWidth = resolve('primeTowerChamferMaxWidth', 5);
  const primeTowerWidth = resolve('primeTowerWidth', cfg.wipeTowerWidth);
  const wipeTowerRotationAngle = resolve('wipeTowerRotationAngle', 0);

  // layer_height is omitted for USE_FILE (see below) so the source 3MF / process
  // profile value survives; applyConfigToPrusa gets a 0.0 sentinel at slice time.
  const result = {
    initial_layer_print_height: ktFloat(cfg.firstLayerHeight),
    wall_loops: intStr(wallCount),
    top_shell_layers: intStr(topShellLayers),
    bottom_shell_layers: intStr(bottomShellLayers),
    top_surface_pattern: topSurfacePattern,
    bottom_surface_pattern: bottomSurfacePattern,
    // Kotlin: "${(infillDensity * 100).toInt()}%" in Float arithmetic.
    sparse_infill_density: `${ktToInt(f32(f32(infillDensity) * 100))}%`,
    sparse_infill_pattern: infillPattern,
    reduce_infill_retraction: reduceInfillRetraction ? '1' : '0',
    wall_generator: wallGenerator,
    seam_position: seamPosition,
    travel_speed: ktFloat(cfg.travelSpeed),
    nozzle_temperature: temps,
    nozzle_temperature_initial_layer: [...temps],
    bed_temperature: [intStr(bedTemp)],
    bed_temperature_initial_layer: [intStr(bedTemp)],
    brim_width: ktFloat(brimWidth),
    // brim_type must be explicit — auto_brim from Bambu source files leaks
    // through profile_keys[] and adds brims even when brim_width=0 (B31).
    brim_type: f32(brimWidth) > 0 ? 'manual_brim' : 'no_brim',
    skirt_loops: intStr(skirtLoops),
    // OrcaSlicer defaults skirt_height=1; 0 prevents skirts when no loops.
    skirt_height: skirtLoops > 0 ? '1' : '0',
    enable_prime_tower: primeTower ? '1' : '0',
    prime_tower_width: ktFloat(primeTowerWidth),
    wipe_tower_x: Array.from({ length: slotCount }, () => ktFloat(cfg.wipeTowerX)),
    wipe_tower_y: Array.from({ length: slotCount }, () => ktFloat(cfg.wipeTowerY)),
    prime_volume: intStr(primeVolume),
    prime_tower_brim_width: ktFloat(primeTowerBrimWidth),
    prime_tower_brim_chamfer: primeTowerBrimChamfer ? '1' : '0',
    prime_tower_brim_chamfer_max_width: ktFloat(primeTowerChamferMaxWidth),
    wipe_tower_rotation_angle: ktFloat(wipeTowerRotationAngle),
    // B63: filament_type per file filament, sized to filamentCount (H2C: 7 > 4 slots).
    filament_type: Array.from({ length: effectiveFilamentCount }, (_, i) => filamentTypes?.[i] ?? 'PLA'),
  };

  // Phase 2 §4 Step 7 — per-filament colour overrides, only for canonical files.
  if (filamentColours != null) {
    result.filament_colour = Array.from({ length: effectiveFilamentCount }, (_, i) => filamentColours[i] ?? '#FFFFFF');
  }

  // sparse_infill_speed: 0 = auto; only emit a positive override.
  if (sparseInfillSpeed > 0) result.sparse_infill_speed = intStr(sparseInfillSpeed);

  // B100: layer_height only for ORCA_DEFAULT / OVERRIDE.
  if (fieldOf(ov, 'layerHeight').mode !== OverrideMode.USE_FILE) result.layer_height = ktFloat(layerHeight);

  // B10: omit enable_support for USE_FILE + source config (file value survives the
  // preserve path); STL/non-Bambu always emit. Sub-settings also emit when their
  // own mode is OVERRIDE (B125 siblings).
  const supportBlockActive = fieldOf(ov, 'supports').mode !== OverrideMode.USE_FILE || !hasSourceConfig;
  if (supportBlockActive) result.enable_support = supportEnabled ? '1' : '0';
  if (supportBlockActive || OV('supportAngle')) result.support_threshold_angle = intStr(supportAngle);
  if (supportBlockActive || OV('supportType')) result.support_type = supportType;
  if (supportBlockActive || OV('supportBuildPlateOnly')) result.support_on_build_plate_only = supportBuildPlateOnly ? '1' : '0';
  if (supportBlockActive || OV('supportPattern')) result.support_base_pattern = supportPattern;
  if (supportBlockActive || OV('supportPatternSpacing')) result.support_base_pattern_spacing = ktFloat(supportPatternSpacing);
  if (supportBlockActive || OV('supportInterfaceTopLayers')) result.support_interface_top_layers = intStr(supportInterfaceTopLayers);
  if (supportBlockActive || OV('supportInterfaceBottomLayers')) result.support_interface_bottom_layers = intStr(supportInterfaceBottomLayers);
  if (supportBlockActive || OV('supportXyDistance')) result.support_object_xy_distance = ktFloat(supportXyDistance);
  if (supportBlockActive || OV('supportInterfacePattern')) result.support_interface_pattern = supportInterfacePattern;
  if (supportBlockActive || OV('supportInterfaceSpacing')) result.support_interface_spacing = ktFloat(supportInterfaceSpacing);
  // support_speed 0 = auto; only emit positive values
  if ((supportBlockActive || OV('supportSpeed')) && supportSpeed > 0) result.support_speed = intStr(supportSpeed);
  // Tree support parameters — only relevant when support type is tree
  const isTree = String(supportType).startsWith('tree') && (supportBlockActive || OV('supportType'));
  if (isTree) {
    if (supportBlockActive || OV('treeSupportBranchAngle')) result.tree_support_branch_angle = intStr(treeSupportBranchAngle);
    if (supportBlockActive || OV('treeSupportBranchDistance')) result.tree_support_branch_distance = ktFloat(treeSupportBranchDistance);
    if (supportBlockActive || OV('treeSupportBranchDiameter')) result.tree_support_branch_diameter = ktFloat(treeSupportBranchDiameter);
  }

  // B125: an explicit support filament choice is emitted even when the support
  // block itself is gated off by USE_FILE + source config.
  if (supportFilament > 0 && (OV('supportFilament') || supportBlockActive)) {
    result.support_filament = intStr(supportFilament);
  }
  if (supportInterfaceFilament > 0 && (OV('supportInterfaceFilament') || supportBlockActive)) {
    result.support_interface_filament = intStr(supportInterfaceFilament);
  }

  // Full-spectrum: only when set, so an embedded 3MF recipe survives otherwise.
  if (cfg.mixedFilamentDefinitions) result.mixed_filament_definitions = cfg.mixedFilamentDefinitions;

  return result;
}

/**
 * B53: the Prepare prime-tower switch always sets OVERRIDE (bypassing the
 * multi-extruder guard) with the inverse of the current effective state.
 */
export function computeTogglePrimeTower(current, cfgWipeTower) {
  const effective = current?.value ?? cfgWipeTower;
  return overrideValue(OverrideMode.OVERRIDE, !effective);
}

const presetFor = (presets, slot) => presets.find((p) => p.index === slot);
const profileFor = (filaments, id) => (id == null ? undefined : filaments.find((f) => f.id === id));

/**
 * Fresh per-slot nozzle temps at slice time. `usedSlots` maps compact index ->
 * physical slot (null = identity). Linked filament profile temp > material default.
 * @returns {number[]}
 */
export function computeFreshSlotTemps(slotCount, usedSlots, presets, filaments) {
  const slots = usedSlots ?? Array.from({ length: slotCount }, (_, i) => i);
  return Array.from({ length: Math.max(0, slotCount) }, (_, i) => {
    const slotIndex = i < slots.length ? slots[i] : i;
    const preset = presetFor(presets, slotIndex);
    return profileFor(filaments, preset?.filamentProfileId)?.nozzleTemp
      ?? nozzleTempDefaultForMaterial(preset?.materialType ?? 'PLA');
  });
}

/** Back-compat alias (the tests name it ComputeFreshExtruderTemps). */
export const computeFreshExtruderTemps = computeFreshSlotTemps;

// ─── F91 filament library per-slot tuning ─────────────────────────────────

const FILAMENT_LIBRARY_FIELDS = [
  // [arraysKey, profileField, kind, settingsKey]
  ['flowRatios', 'flowRatio', 'float', 'filament_flow_ratio'],
  ['maxVolumetricSpeeds', 'maxVolumetricSpeed', 'float', 'filament_max_volumetric_speed'],
  ['fanMinSpeeds', 'fanMinSpeed', 'int', 'fan_min_speed'],
  ['fanMaxSpeeds', 'fanMaxSpeed', 'int', 'fan_max_speed'],
  ['overhangFanSpeeds', 'overhangFanSpeed', 'int', 'overhang_fan_speed'],
  ['additionalCoolingFanSpeeds', 'additionalCoolingFanSpeed', 'int', 'additional_cooling_fan_speed'],
  ['slowDownLayerTimes', 'slowDownLayerTime', 'float', 'slow_down_layer_time'],
  ['slowDownMinSpeeds', 'slowDownMinSpeed', 'float', 'slow_down_min_speed'],
  ['closeFanFirstLayers', 'closeFanFirstLayers', 'int', 'close_fan_the_first_x_layers'],
  ['fullFanSpeedLayers', 'fullFanSpeedLayer', 'int', 'full_fan_speed_layer'],
  ['enablePressureAdvance', 'enablePressureAdvance', 'bool', 'enable_pressure_advance'],
  ['pressureAdvances', 'pressureAdvance', 'float', 'pressure_advance'],
  ['minimalPurgeOnWipeTower', 'filamentMinimalPurgeOnWipeTower', 'float', 'filament_minimal_purge_on_wipe_tower'],
  ['nozzleTempInitialLayers', 'nozzleTempInitialLayer', 'int', 'nozzle_temperature_initial_layer'],
  ['bedTempInitialLayers', 'bedTempInitialLayer', 'int', 'hot_plate_temp_initial_layer'],
  ['costs', 'filamentCost', 'float', 'filament_cost'],
];
// buildFilamentLibrarySettings emission order (Kotlin emit* call order).
const SETTINGS_ORDER = [
  'nozzle_temperature_initial_layer', 'hot_plate_temp_initial_layer', 'filament_flow_ratio',
  'filament_max_volumetric_speed', 'filament_cost', 'fan_min_speed', 'fan_max_speed',
  'overhang_fan_speed', 'additional_cooling_fan_speed', 'slow_down_layer_time',
  'slow_down_min_speed', 'close_fan_the_first_x_layers', 'full_fan_speed_layer',
  'enable_pressure_advance', 'pressure_advance', 'filament_minimal_purge_on_wipe_tower',
];

function profilesPerSlot(slotCount, usedSlots, presets, filaments) {
  const slots = usedSlots ?? Array.from({ length: slotCount }, (_, i) => i);
  return Array.from({ length: slotCount }, (_, i) => {
    const slotIndex = i < slots.length ? slots[i] : i;
    return profileFor(filaments, presetFor(presets, slotIndex)?.filamentProfileId) ?? null;
  });
}

function forwardBackFill(values, empty) {
  const out = [...values];
  let last = null;
  for (let i = 0; i < out.length; i++) { if (out[i] != null) last = out[i]; else if (last != null) out[i] = last; }
  last = null;
  for (let i = out.length - 1; i >= 0; i--) { if (out[i] != null) last = out[i]; else if (last != null) out[i] = last; }
  return out.map((v) => v ?? empty);
}

/**
 * F91: typed per-slot arrays from the filament library for SliceConfig
 * (filamentFlowRatios etc.). A field no slot sets -> []. Forward/back-filled.
 */
export function buildFilamentLibraryArrays(slotCount, usedSlots, presets, filaments) {
  const out = Object.fromEntries(FILAMENT_LIBRARY_FIELDS.map(([k]) => [k, []]));
  if (slotCount <= 0) return out;
  const per = profilesPerSlot(slotCount, usedSlots, presets, filaments);
  for (const [key, field, kind] of FILAMENT_LIBRARY_FIELDS) {
    const raw = per.map((p) => {
      const v = p?.[field];
      if (v == null) return null;
      if (kind === 'bool') return v ? 1 : 0;
      return kind === 'float' ? f32(v) : ktToInt(v);
    });
    if (raw.every((v) => v == null)) continue;
    out[key] = forwardBackFill(raw, 0);
  }
  return out;
}

/** SliceConfig field for each buildFilamentLibraryArrays key. */
export const FILAMENT_LIBRARY_SLICE_CONFIG_FIELDS = Object.freeze({
  flowRatios: 'filamentFlowRatios',
  maxVolumetricSpeeds: 'filamentMaxVolumetricSpeeds',
  fanMinSpeeds: 'filamentFanMinSpeeds',
  fanMaxSpeeds: 'filamentFanMaxSpeeds',
  overhangFanSpeeds: 'filamentOverhangFanSpeeds',
  additionalCoolingFanSpeeds: 'filamentAdditionalCoolingFanSpeeds',
  slowDownLayerTimes: 'filamentSlowDownLayerTimes',
  slowDownMinSpeeds: 'filamentSlowDownMinSpeeds',
  closeFanFirstLayers: 'filamentCloseFanFirstLayers',
  fullFanSpeedLayers: 'filamentFullFanSpeedLayers',
  enablePressureAdvance: 'filamentEnablePressureAdvance',
  pressureAdvances: 'filamentPressureAdvances',
  minimalPurgeOnWipeTower: 'filamentMinimalPurgeOnWipeTower',
  nozzleTempInitialLayers: 'filamentNozzleTempInitialLayers',
  bedTempInitialLayers: 'filamentBedTempInitialLayers',
  costs: 'filamentCosts',
});

/**
 * F91: `filamentSettings` map of per-slot string arrays (embed pipeline). A key
 * is emitted only when at least one slot's linked profile sets the field.
 */
export function buildFilamentLibrarySettings(slotCount, usedSlots, presets, filaments) {
  const result = {};
  if (slotCount <= 0) return result;
  const per = profilesPerSlot(slotCount, usedSlots, presets, filaments);
  const byKey = new Map(FILAMENT_LIBRARY_FIELDS.map((e) => [e[3], e]));
  for (const key of SETTINGS_ORDER) {
    const [, field, kind] = byKey.get(key);
    const raw = per.map((p) => {
      const v = p?.[field];
      if (v == null) return null;
      if (kind === 'bool') return v ? '1' : '0';
      return kind === 'float' ? ktFloat(v) : intStr(v);
    });
    if (raw.every((v) => v == null)) continue;
    result[key] = forwardBackFill(raw, '');
  }
  return result;
}

// ─── filament_type label (B59) ────────────────────────────────────────────

/** Single material across used slots -> that material; differing -> "Mixed"; empty -> "PLA". */
export function resolveFilamentTypeLabel(usedSlots, presets) {
  if (usedSlots.length === 0) return 'PLA';
  const distinct = [...new Set(usedSlots.map((s) => presetFor(presets, s)?.materialType ?? 'PLA'))];
  return distinct.length === 1 ? distinct[0] : 'Mixed';
}

/** Single-colour initial load always prints on E1 (slot 0). */
export const resolveFilamentTypeForSingleColorLoad = (presets) => resolveFilamentTypeLabel([0], presets);

/** usedSlots = colorMapping.distinct().sorted(), then resolveFilamentTypeLabel. */
export function resolveFilamentTypeLabelFromMapping(colorMapping, presets) {
  const usedSlots = [...new Set(colorMapping)].sort((a, b) => a - b);
  return resolveFilamentTypeLabel(usedSlots, presets);
}

// ─── G-code header patch helpers (B63 / B102 / B105 / B110 / B117) ────────

const presetMaterialOrPla = (p) => (p?.materialType && p.materialType.trim() !== '' ? p.materialType : 'PLA');
function presetTemp(preset, filamentLibrary) {
  const profileTemp = profileFor(filamentLibrary, preset?.filamentProfileId)?.nozzleTemp;
  return profileTemp ?? nozzleTempDefaultForMaterial(presetMaterialOrPla(preset));
}

// Shared B102 physical-slot indexing + Jon's-bug overflow padding.
function physicalSlotIndexed(resolved, colorMapping, padTo, initial) {
  const maxPhysicalSlot = Math.max(...colorMapping);
  const physicalSize = Math.max(maxPhysicalSlot + 1, padTo);
  const result = Array.from({ length: physicalSize }, (_, idx) => initial(idx));
  // Forward order so lower canonical indices (carrying overrides) win on folds.
  const seen = new Set();
  colorMapping.forEach((physicalSlot, canonicalIdx) => {
    if (physicalSlot >= 0 && physicalSlot < result.length && canonicalIdx < resolved.length && !seen.has(physicalSlot)) {
      result[physicalSlot] = resolved[canonicalIdx];
      seen.add(physicalSlot);
    }
  });
  // Jon's bug (Discord 1509878155790258287): positions past the physical range
  // are canonical-overflow padding — inherit the resolved value for that index.
  for (let i = maxPhysicalSlot + 1; i < physicalSize; i++) if (i < resolved.length) result[i] = resolved[i];
  return result;
}

/**
 * filament_type header list. With a colorMapping the result is physical-slot
 * indexed (B102), length max(maxSlot+1, padTo); otherwise canonical-indexed and
 * padded to padTo with preset types.
 */
export function resolveFilamentTypesForHeaderPatch({ canonical, overrides, colorMapping, presets, filamentLibrary, padTo = canonical.size }) {
  const resolved = resolvePerFilamentTypeAndTemp({ canonical, overrides, colorMapping, presets, filamentLibrary })[0];
  if (colorMapping != null && colorMapping.length > 0) {
    const bySlot = new Map(presets.map((p) => [p.index, p]));
    return physicalSlotIndexed(resolved, colorMapping, padTo, (idx) => presetMaterialOrPla(bySlot.get(idx)));
  }
  if (resolved.length >= padTo) return resolved;
  const slotTypes = [...presets].sort((a, b) => a.index - b.index).map((p) => p.materialType);
  const pad = [];
  for (let idx = resolved.length; idx < padTo; idx++) pad.push(slotTypes[idx] ?? 'PLA');
  return [...resolved, ...pad];
}

/** nozzle_temperature companion of resolveFilamentTypesForHeaderPatch (B110): same indexing. */
export function resolveNozzleTempsForHeaderPatch({ canonical, overrides, colorMapping, presets, filamentLibrary, padTo = canonical.size }) {
  const resolved = resolvePerFilamentTypeAndTemp({ canonical, overrides, colorMapping, presets, filamentLibrary })[1];
  const bySlot = new Map(presets.map((p) => [p.index, p]));
  if (colorMapping != null && colorMapping.length > 0) {
    return physicalSlotIndexed(resolved, colorMapping, padTo, (idx) => presetTemp(bySlot.get(idx), filamentLibrary));
  }
  if (resolved.length >= padTo) return resolved;
  const pad = [];
  for (let idx = resolved.length; idx < padTo; idx++) pad.push(presetTemp(bySlot.get(idx), filamentLibrary));
  return [...resolved, ...pad];
}

/** B105: non-canonical files — one type per physically used slot. */
export const resolveNonCanonicalHeaderPatchTypes = (usedSlots, presets) =>
  usedSlots.map((slot) => presetFor(presets, slot)?.materialType ?? 'PLA');

/** B110: non-canonical temps — linked profile temp or the slot material's default. */
export const resolveNonCanonicalHeaderPatchTemps = (usedSlots, presets, filamentLibrary) =>
  usedSlots.map((slot) => {
    const preset = presetFor(presets, slot);
    return profileFor(filamentLibrary, preset?.filamentProfileId)?.nozzleTemp
      ?? nozzleTempDefaultForMaterial(preset?.materialType ?? 'PLA');
  });

/**
 * B117: apply a Prepare `FilamentOverride` ({color?, materialType?}) at
 * fileIndex 0 to non-canonical slot type/temp lists (first entry only).
 * @returns {[string[], number[]]}
 */
export function applyNonCanonicalOverride(slotTypes, slotTemps, override) {
  const newType = override?.materialType ?? null;
  if (newType == null || slotTypes.length === 0) return [slotTypes, slotTemps];
  const types = [newType, ...slotTypes.slice(1)];
  const temps = slotTemps.length > 0 ? [nozzleTempDefaultForMaterial(newType), ...slotTemps.slice(1)] : slotTemps;
  return [types, temps];
}

// Kotlin reads with BufferedReader.lineSequence() and writes each line + "\n".
function rewriteLines(gcode, rewrite) {
  const lines = gcode.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /[\r\n]$/.test(gcode)) lines.pop();
  if (gcode === '') lines.length = 0;
  const out = lines.map(rewrite);
  return out.length ? `${out.join('\n')}\n` : '';
}

/**
 * B63: replace the first `; filament_type = ...` header line with `types`
 * joined by ";". G-code text in/out (the Kotlin rewrites a file in place).
 * @returns {{changed: boolean, gcode: string}} `gcode` is the input unchanged when not changed
 */
export function fixFilamentTypeHeader(gcode, filamentTypes) {
  if (!filamentTypes || filamentTypes.length === 0 || gcode == null) return { changed: false, gcode };
  const replacement = filamentTypes.join(';');
  let found = false;
  const text = rewriteLines(gcode, (line) => {
    if (!found && line.startsWith('; filament_type = ')) {
      found = true;
      return `; filament_type = ${replacement}`;
    }
    return line;
  });
  return found ? { changed: true, gcode: text } : { changed: false, gcode };
}

/**
 * B110: replace the first `; nozzle_temperature = ` and
 * `; nozzle_temperature_initial_layer = ` header lines with `temps` joined by ",".
 * @returns {{changed: boolean, gcode: string}}
 */
export function fixNozzleTemperatureHeader(gcode, temps) {
  if (!temps || temps.length === 0 || gcode == null) return { changed: false, gcode };
  const replacement = temps.join(',');
  let foundMain = false;
  let foundInitial = false;
  const text = rewriteLines(gcode, (line) => {
    if (!foundMain && line.startsWith('; nozzle_temperature = ')) {
      foundMain = true;
      return `; nozzle_temperature = ${replacement}`;
    }
    if (!foundInitial && line.startsWith('; nozzle_temperature_initial_layer = ')) {
      foundInitial = true;
      return `; nozzle_temperature_initial_layer = ${replacement}`;
    }
    return line;
  });
  return foundMain || foundInitial ? { changed: true, gcode: text } : { changed: false, gcode };
}

// ─── SlicerViewModel.buildProfileOverrides (private) as a pure function ───

const filamentOverrideAt = (m, i) => (m instanceof Map ? m.get(i) : m?.[i]) ?? null;
function overridePairs(filamentOverrides) {
  const entries = filamentOverrides instanceof Map ? [...filamentOverrides]
    : Object.entries(filamentOverrides ?? {}).map(([k, v]) => [Number(k), v]);
  return new Map(entries.map(([k, v]) => [k, [v?.color ?? null, v?.materialType ?? null]]));
}

/**
 * The ViewModel's `buildProfileOverrides(cfg, slotCount, usedSlots,
 * hasSourceConfig, canonical)`, with the ViewModel state it reads passed in:
 *   overrides         — slicingOverrides.value
 *   presets           — extruderPresets.value
 *   filaments         — filament library (filaments.value)
 *   filamentOverrides — _filamentOverrides.value: Map/object fileIndex -> {color?, materialType?}
 *   colorMapping      — _colorMapping.value
 *   fallbackCanonical — getCanonicalFilamentList(), used for per-filament
 *                       types/temps when `canonical` is null (colours still
 *                       come only from `canonical`, as in Kotlin).
 */
export function buildProfileOverrides({
  cfg, overrides, slotCount, usedSlots = null, hasSourceConfig = false, canonical = null,
  presets, filamentOverrides = new Map(), colorMapping = null, filaments = [], fallbackCanonical = null,
}) {
  // B105: non-canonical files with a known slot set use only those slots.
  const slotTypes = usedSlots != null
    ? usedSlots.map((slot) => presetFor(presets, slot)?.materialType ?? 'PLA')
    : [...presets].sort((a, b) => a.index - b.index).map((p) => p.materialType);
  const allSlotTemps = computeFreshSlotTemps(Math.max(presets.length, slotCount), null, presets, filaments);
  const slotTemps = computeFreshSlotTemps(slotCount, usedSlots, presets, filaments);

  const canonicalList = canonical ?? fallbackCanonical;
  const pairs = overridePairs(filamentOverrides);
  const perFilamentArrays = canonicalList
    ? resolvePerFilamentTypeAndTemp({ canonical: canonicalList, overrides: pairs, colorMapping, presets, filamentLibrary: filaments })
    : null;

  // B117: non-canonical files apply the fileIndex 0 material override to slot 0.
  const [nonCanonicalTypes, nonCanonicalTemps] = applyNonCanonicalOverride(
    slotTypes, slotTemps, canonicalList == null ? filamentOverrideAt(filamentOverrides, 0) : null);

  const resolvedTypes = perFilamentArrays?.[0] ?? nonCanonicalTypes;
  const resolvedTemps = perFilamentArrays?.[1] ?? nonCanonicalTemps;
  // B99: pad support slots beyond the canonical list from the physical presets.
  const finalTypes = perFilamentArrays != null && resolvedTypes.length < slotTypes.length
    ? [...resolvedTypes, ...slotTypes.slice(resolvedTypes.length)]
    : resolvedTypes;
  const finalTemps = perFilamentArrays != null && resolvedTemps.length < allSlotTemps.length
    ? [...resolvedTemps, ...allSlotTemps.slice(resolvedTemps.length)]
    : resolvedTemps;
  const filamentCount = Math.max(finalTypes.length, slotCount);

  const finalColours = canonical
    ? applyOverridesToCanonical(canonical, pairs).filaments.map((e) => e.color)
    : null;

  return buildProfileOverridesImpl(cfg, overrides, {
    slotCount,
    filamentCount,
    hasSourceConfig,
    filamentTypes: finalTypes,
    nozzleTemps: finalTemps,
    filamentColours: finalColours,
  });
}

export { ORCA_DEFAULTS };
