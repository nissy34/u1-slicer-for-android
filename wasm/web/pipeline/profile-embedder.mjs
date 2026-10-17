// Port of app/src/main/java/com/u1/slicer/bambu/ProfileEmbedder.kt.
//
// Embeds Snapmaker U1 OrcaSlicer profiles into 3MF files before slicing:
//  1. Base Snapmaker profiles (printer + process + filament)
//  2. Merge with user overrides
//  3. Sanitize (clamp, normalize arrays, fix nil)
//  4. Inject as Metadata/project_settings.config
//  5. Strip incompatible Bambu metadata
//
// Instead of an Android Context, the constructor takes the three parsed profile
// JSON objects (app/src/main/assets/orca_profiles/{printer/snapmaker_u1.json,
// process/standard_0.20mm.json, filament/pla.json}).
//
// Config maps are plain insertion-ordered objects (Kotlin LinkedHashMap): list
// values are string arrays, scalars strings. Input maps (sourceConfig, overrides,
// ...) may be plain objects or Maps. Values should be strings / string arrays;
// numbers are stringified with String(), so pre-format Kotlin Float values (e.g.
// ktFloat) when exact Kotlin text matters.
import { readZip, getEntry, decodeText, encodeText, STORED } from './zip.mjs';
import { ktDouble, fmtFixed, toIntOrNull, toFloatOrNull } from './kt.mjs';
import {
  filterModelToPlate, stripUnreferencedResources, stripAssembleSection, stripUnreferencedConfigObjects,
  sanitizeModelSettings, filterCustomGcodePerLayer, stripNonPrintableBuildItems, StrictZipWriter,
} from './bambu-sanitizer.mjs';

// Keys that are NOT per-filament arrays
const NON_FILAMENT_KEYS = new Set(['compatible_printers', 'compatible_prints']);

// Keys with special list semantics
const SPECIAL_LIST_KEYS = new Set([
  'flush_volumes_matrix', 'flush_volumes_vector',
  'different_settings_to_system', 'inherits_group',
  'upward_compatible_machine', 'printable_area',
  'bed_exclude_area', 'thumbnails', 'head_wrap_detect_zone',
  'extruder_offset', 'wipe_tower_x', 'wipe_tower_y',
]);

// F91: keys overlaid from the bundled pla.json onto the Bambu preserve path (before
// user library settings) so native never sees Bambu's wrong-for-U1 cooling/flow
// values. Library settings still win (applied after).
const U1_FILAMENT_SAFETY_OVERLAY = [
  'filament_max_volumetric_speed', 'fan_min_speed', 'fan_max_speed', 'overhang_fan_speed',
  'slow_down_layer_time', 'slow_down_min_speed', 'close_fan_the_first_x_layers',
  'full_fan_speed_layer', 'additional_cooling_fan_speed',
];

// Files to strip from Bambu 3MF. Slic3r_PE_model.config is NOT dropped: embed()
// converts it to model_settings.config with the extruder remap applied.
const DROP_FILES = new Set([
  'Metadata/project_settings.config',
  'Metadata/slice_info.config',
  'Metadata/cut_information.xml',
  'Metadata/filament_sequence.json',
  'Metadata/Slic3r_PE.config',
]);

const DROP_PREFIXES = ['Metadata/plate', 'Metadata/top', 'Metadata/pick'];

// Parameters to clamp
const CLAMP_INT_RULES = new Map([
  ['raft_first_layer_expansion', 0],
  ['tree_support_wall_count', 0],
  ['prime_volume', 0],
  ['prime_tower_brim_width', 0],
  ['prime_tower_brim_chamfer', 0],
  ['prime_tower_brim_chamfer_max_width', 0],
  ['solid_infill_filament', 1],
  ['sparse_infill_filament', 1],
  ['wall_filament', 1],
]);

// Default values for per-filament array padding
const LIST_DEFAULTS = {
  filament_type: 'PLA',
  filament_colour: '#FFFFFF',
  extruder_colour: '#FFFFFF',
  default_filament_profile: 'Snapmaker PLA',
  filament_settings_id: 'Snapmaker PLA',
  nozzle_temperature: '210',
  nozzle_temperature_initial_layer: '210',
  bed_temperature: '60',
  bed_temperature_initial_layer: '60',
  cool_plate_temp: '60',
  cool_plate_temp_initial_layer: '60',
  textured_plate_temp: '60',
  textured_plate_temp_initial_layer: '60',
};

// ---- helpers ----

const isNotBlank = (s) => s.trim().length > 0;
const entriesOf = (m) => (m == null ? [] : m instanceof Map ? [...m.entries()] : Object.entries(m));
const getOf = (m, k) => (m == null ? undefined : m instanceof Map ? m.get(k) : m[k]);

/** Kotlin `Any.toString()` for config values (List -> "[a, b]"). */
export function anyToString(v) {
  if (Array.isArray(v)) return `[${v.map(anyToString).join(', ')}]`;
  if (v instanceof Map) return `{${[...v.entries()].map(([k, x]) => `${k}=${anyToString(x)}`).join(', ')}}`;
  return String(v);
}

/** Android org.json string escaping: same as JSON.stringify plus '/' -> '\/'. */
const androidJson = (value, indent) => JSON.stringify(value, null, indent).replace(/\//g, '\\/');

/** org.json value.toString() for an element parsed by JSONObject. */
function jsonValueToString(v) {
  if (v === null) return 'null'; // JSONObject.NULL
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : ktDouble(v);
  if (typeof v === 'boolean') return String(v);
  return androidJson(v); // nested JSONObject/JSONArray.toString(): compact
}

/**
 * Kotlin jsonToMap: arrays -> string arrays (element.toString()), scalars -> strings.
 * Note: JSON numbers lose their source spelling ("1.0" parses to 1 -> "1"; Android
 * would print "1.0"). The bundled profiles and Bambu configs use strings only.
 */
export function jsonToMap(json) {
  const map = {};
  for (const [key, value] of Object.entries(json)) {
    map[key] = Array.isArray(value) ? value.map(jsonValueToString) : jsonValueToString(value);
  }
  return map;
}

/**
 * Convert BambuSanitizer's Slic3r_PE_model.config into OrcaSlicer model_settings.config,
 * optionally remapping 1-based extruder indices (per-volume assignments preserved).
 * @param {Uint8Array|string} slic3rConfigBytes
 * @param {Map<number,number>|Object|null} extruderRemap
 * @returns {string}
 */
export function convertToModelSettings(slic3rConfigBytes, extruderRemap) {
  const text = typeof slic3rConfigBytes === 'string' ? slic3rConfigBytes : decodeText(slic3rConfigBytes);
  let sb = '<?xml version="1.0" encoding="utf-8"?>\n<config>\n';
  const extruderRe = /key="extruder"\s+value="(\d+)"|value="(\d+)"\s+key="extruder"/;
  const firstGroup = (m) => (m == null ? null : [m[1], m[2]].find((g) => g != null && g.length > 0) ?? null);
  const remap = (raw) => {
    const v = extruderRemap == null ? undefined : getOf(extruderRemap, raw);
    return v ?? raw;
  };
  for (const objMatch of text.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const objectId = objMatch[1];
    const body = objMatch[2];
    const objExt = firstGroup(extruderRe.exec(body));
    const rawObjExt = (objExt != null ? toIntOrNull(objExt) : null) ?? 1;
    sb += `  <object id="${objectId}">\n`;
    sb += `    <metadata type="object" key="extruder" value="${remap(rawObjExt)}"/>\n`;
    for (const volMatch of body.matchAll(/<volume\s+firstid="(\d+)"\s+lastid="(\d+)"[^>]*>([\s\S]*?)<\/volume>/g)) {
      const volExt = firstGroup(extruderRe.exec(volMatch[3]));
      const rawVolExt = (volExt != null ? toIntOrNull(volExt) : null) ?? rawObjExt;
      sb += `    <volume firstid="${volMatch[1]}" lastid="${volMatch[2]}">\n`;
      sb += `      <metadata type="volume" key="extruder" value="${remap(rawVolExt)}"/>\n`;
      sb += '    </volume>\n';
    }
    sb += '  </object>\n';
  }
  sb += '</config>\n';
  return sb;
}

/**
 * Apply an extruder remap to an existing model_settings.config
 * (`key="extruder" value="N"` in either attribute order).
 */
export function remapModelSettingsExtruders(content, extruderRemap) {
  const text = typeof content === 'string' ? content : decodeText(content);
  const out = text.replace(/(key="extruder"[^>]*?value="|value="(?=[^"]*"[^>]*key="extruder"))(\d+)/g, (m, g1, g2) => {
    const raw = toIntOrNull(g2);
    if (raw == null) return m;
    const remapped = getOf(extruderRemap, raw);
    if (remapped == null) return m;
    return g1 + remapped;
  });
  return typeof content === 'string' ? out : encodeText(out);
}

/**
 * Strip Bambu XML extensions from a .model so the BBS reader accepts it
 * (requiredextensions="p" makes it reject the file). Keeps p:path / xmlns:p.
 * PrusaSlicer slic3rpe:mmu_segmentation is renamed to paint_color when paint data
 * is present. printable="0" build items are stripped.
 */
function cleanModelXmlForOrcaSlicer(content, hasPaintData) {
  let text = typeof content === 'string' ? content : decodeText(content);
  if (hasPaintData && text.includes('slic3rpe:mmu_segmentation')) {
    text = text.split('slic3rpe:mmu_segmentation=').join('paint_color=');
    text = text.replace(/\s+xmlns:slic3rpe="[^"]*"/g, '');
  }
  text = text.replace(/\s+requiredextensions="[^"]*"/g, '');
  text = text.replace(/\s+p:UUID="[^"]*"/g, '');
  text = text.replace(/\s+xmlns:BambuStudio="[^"]*"/g, '');
  text = text.replace(/[ \t]*<metadata name="[^"]*"(?:>[^<]*<\/metadata>|[^/]*\/>) *\r?\n?/g, '');
  text = text.split('type="other"').join('type="model"');
  text = stripNonPrintableBuildItems(text);
  return encodeText(text);
}

const P_UUID_RE = /\s+p:UUID="[^"]*"/g;
const REQ_EXT_RE = /\s+requiredextensions="[^"]*"/g;
const BAMBU_NS_RE = /\s+xmlns:BambuStudio="[^"]*"/g;
const SLIC3R_NS_RE = /\s+xmlns:slic3rpe="[^"]*"/g;
const METADATA_RE = /[ \t]*<metadata name="[^"]*"(?:>[^<]*<\/metadata>|[^/]*\/>) *\r?\n?/g;

/**
 * Streaming clean of a large .model entry, byte-line by byte-line ('\n'-terminated
 * lines, terminator kept). Geometry lines (first non-space byte '<' followed by
 * 'v', 't' or '/') and lines with nothing to clean are copied verbatim; other
 * lines are cleaned and written with a trailing '\n' (dropped if blank).
 * Returns the cleaned bytes (written STORED by the caller).
 */
export function streamCleanBytes(data, hasPaintData) {
  const chunks = [];
  let runStart = -1; // start of a pending verbatim byte run
  let runEnd = -1;
  const flushRun = () => {
    if (runStart >= 0) { chunks.push(data.subarray(runStart, runEnd)); runStart = -1; }
  };
  const verbatim = (s, e) => {
    if (runStart >= 0 && runEnd === s) runEnd = e;
    else { flushRun(); runStart = s; runEnd = e; }
  };
  const n = data.length;
  let pos = 0;
  while (pos < n) {
    const nl = data.indexOf(10, pos);
    const end = nl < 0 ? n : nl + 1;
    let first = pos;
    // Kotlin compares signed bytes (`<= 32`), so UTF-8 bytes >= 0x80 also count as space.
    while (first < end && (data[first] <= 32 || data[first] >= 128)) first++;
    if (first + 1 < end && data[first] === 60 /* < */) {
      const c = data[first + 1];
      if (c === 118 /* v */ || c === 116 /* t */ || c === 47 /* / */) { verbatim(pos, end); pos = end; continue; }
    }
    const lineStr = decodeText(data.subarray(pos, end));
    const hasMmu = hasPaintData && lineStr.includes('slic3rpe:mmu_segmentation');
    if (!lineStr.includes('p:UUID') && !lineStr.includes('requiredextensions') &&
      !lineStr.includes('xmlns:BambuStudio') && !lineStr.includes('<metadata') &&
      !lineStr.includes('type="other"') && !lineStr.includes('xmlns:slic3rpe') && !hasMmu) {
      verbatim(pos, end);
      pos = end;
      continue;
    }
    let cleaned = lineStr;
    if (hasMmu) cleaned = cleaned.split('slic3rpe:mmu_segmentation=').join('paint_color=');
    cleaned = cleaned.replace(P_UUID_RE, '');
    cleaned = cleaned.replace(REQ_EXT_RE, '');
    cleaned = cleaned.replace(BAMBU_NS_RE, '');
    cleaned = cleaned.replace(SLIC3R_NS_RE, '');
    cleaned = cleaned.replace(METADATA_RE, '');
    cleaned = cleaned.split('type="other"').join('type="model"');
    if (isNotBlank(cleaned)) {
      flushRun();
      chunks.push(encodeText(cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`));
    }
    pos = end;
  }
  flushRun();
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export class ProfileEmbedder {
  /**
   * @param {{printer: Object, process: Object, filament: Object, log?: (msg: string) => void}} profiles
   *   parsed JSON of orca_profiles/printer/snapmaker_u1.json, process/standard_0.20mm.json,
   *   filament/pla.json.
   */
  constructor({ printer, process, filament, log } = {}) {
    this.rawProfiles = { printer, process, filament };
    this.printerProfile = null;
    this.processProfile = null;
    this.filamentProfile = null;
    this.log = log ?? (() => {});
  }

  /** Converts the profiles once; the cached lists are shared like Kotlin's cache. */
  loadProfiles() {
    if (this.printerProfile != null) return;
    this.printerProfile = jsonToMap(this.rawProfiles.printer);
    this.processProfile = jsonToMap(this.rawProfiles.process);
    this.filamentProfile = jsonToMap(this.rawProfiles.filament);
  }

  static convertToModelSettings(slic3rConfigBytes, extruderRemap) {
    return convertToModelSettings(slic3rConfigBytes, extruderRemap);
  }

  convertToModelSettings(slic3rConfigBytes, extruderRemap) {
    return convertToModelSettings(slic3rConfigBytes, extruderRemap);
  }

  /**
   * Build the complete slicer config by merging profiles with user settings.
   * @param {{info: Object, sourceConfig?: Object|Map|null, filamentSettings?: Object|Map,
   *          overrides?: Object|Map, targetExtruderCount?: number, processProfileKeys?: Object|Map}} args
   * @returns {Object} ordered config map
   */
  buildConfig({
    info, sourceConfig = null, filamentSettings = {}, overrides = {}, targetExtruderCount = 1,
    // F87: user-imported process profile keys, layered after the bundled process
    // profile / preserved source config but before filamentSettings and overrides.
    processProfileKeys = {},
  }) {
    this.loadProfiles();
    let config;

    const srcSupport = getOf(sourceConfig, 'enable_support');
    const sourceHasSupports = srcSupport != null && anyToString(srcSupport) === '1';
    const needsPreserve = !!info.isBambu && (
      (info.detectedExtruderCount ?? 1) > 1 ||
      !!info.hasLayerToolChanges ||
      (!!info.hasPaintData && targetExtruderCount > 1) ||
      !!info.isMultiPlate ||
      !!info.hasPaintSupports || // B57: single-colour support painting needs the embedded config
      sourceHasSupports // B61: supports enabled — don't let processProfile stomp them
    );

    if (needsPreserve && sourceConfig != null) {
      // Preserve path. Copy list values so normalizePerFilamentArrays() can't
      // mutate the cached sourceConfig (B67 root cause).
      config = {};
      for (const [k, v] of entriesOf(sourceConfig)) config[k] = Array.isArray(v) ? [...v] : v;
      Object.assign(config, this.printerProfile);
      // F91: U1-safe cooling/flow floor from pla.json; library filament still wins.
      for (const key of U1_FILAMENT_SAFETY_OVERLAY) {
        const value = this.filamentProfile[key];
        if (value != null) config[key] = Array.isArray(value) ? [...value] : value;
      }
      if (info.hasLayerToolChanges) {
        const mpg = getOf(sourceConfig, 'machine_pause_gcode');
        if (mpg != null) config.machine_pause_gcode = mpg;
      }
    } else {
      // Standard path: full Snapmaker profile stack (lists shared with the cache,
      // as in Kotlin's putAll)
      config = {};
      Object.assign(config, this.printerProfile);
      Object.assign(config, this.processProfile);
      Object.assign(config, this.filamentProfile);
    }

    for (const [key, value] of entriesOf(processProfileKeys)) config[key] = value;
    for (const [key, value] of entriesOf(filamentSettings)) config[key] = value;
    for (const [key, value] of entriesOf(overrides)) config[key] = value;

    this.sanitizeConfig(config, targetExtruderCount);

    config.layer_gcode = 'G92 E0';
    config.enable_arc_fitting = '1';
    delete config.inherits;
    delete config.inherits_group;

    // Hueforge-style models encode layer colour swaps in machine_pause_gcode;
    // keep it only when the source has layer tool changes.
    delete config.time_lapse_gcode;
    if (!info.hasLayerToolChanges) delete config.machine_pause_gcode;
    if (info.hasLayerToolChanges) {
      // U1 handles these as manual pause-driven swaps, not AMS tool changes.
      config.single_extruder_multi_material = '0';
      delete config.single_extruder_multi_material_priming;
      delete config.manual_filament_change;
      delete config.change_filament_gcode;
    }
    const fsg = config.filament_start_gcode;
    if (Array.isArray(fsg) && fsg.some((it) => anyToString(it).includes('M142') || anyToString(it).includes('air_filtration'))) {
      delete config.filament_start_gcode;
    }

    config.printer_settings_id = 'Snapmaker U1 (0.4 nozzle) - multiplate';
    config.print_settings_id = '0.20mm Standard @Snapmaker U1';
    config.print_compatible_printers = ['Snapmaker U1 (0.4 nozzle) - multiplate'];

    // Phase 2 B.3: explicit marker for native is_snapmaker_profile detection (the
    // PRINT_START heuristic false-positives on any Klipper printer's files).
    config.snapmaker_authored_profile = '1';

    // U1 has independent extruders (not SEMM/MMU): force SEMM=0 to prevent 94mm
    // retraction sequences; paint segmentation still runs.
    if (info.hasPaintData) config.single_extruder_multi_material = '0';

    // Without extruder_count Orca defaults to 1 and ignores per-volume assignments.
    config.extruder_count = String(targetExtruderCount);
    return config;
  }

  /** Clamp values, fix nil, normalize per-filament arrays, clamp wipe tower position. */
  sanitizeConfig(config, targetExtruderCount) {
    for (const [key, minimum] of CLAMP_INT_RULES) clampIntField(config, key, minimum);
    sanitizeNilValues(config);
    // Always normalise, even for one extruder.
    normalizePerFilamentArrays(config, Math.max(1, targetExtruderCount));
    sanitizeWipeTowerPosition(config);
  }

  /**
   * Serialize config to OrcaSlicer JSON (bbs_3mf.cpp load_from_json). Output matches
   * Android org.json JSONObject.toString(2), including its '\/' escaping of '/'.
   */
  serializeConfig(config) {
    const json = {};
    for (const [key, value] of entriesOf(config)) {
      json[key] = Array.isArray(value) ? value.map(anyToString) : anyToString(value);
    }
    return androidJson(json, 2);
  }

  /**
   * Parse Metadata/project_settings.config (JSON) from a 3MF.
   * @param {Uint8Array|Array} zip archive bytes or readZip() entries
   * @returns {Object|null} null when absent or not a JSON object
   */
  parseSourceConfig(zip) {
    const entries = zip instanceof Uint8Array ? readZip(zip) : zip;
    const entry = getEntry(entries, 'Metadata/project_settings.config');
    if (!entry) return null;
    try {
      const parsed = JSON.parse(decodeText(entry.data));
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return jsonToMap(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Embed config into a 3MF, stripping incompatible metadata.
   * @param {Uint8Array} inputBytes source 3MF
   * @param {Object|Map} config merged config to inject
   * @param {Object} info 3MF analysis info (hasPaintData, hasLayerToolChanges, plates, hasPlateJsons)
   * @param {Map<number,number>|Object|null} [extruderRemap] 1-based remap for model_settings.config
   * @param {number|null} [plateId] 1-based plate to scope the model/configs to
   * @returns {Uint8Array} embedded 3MF
   */
  embed(inputBytes, config, info, extruderRemap = null, plateId = null) {
    const configIni = this.serializeConfig(config);
    const entries = readZip(inputBytes);
    const destZip = new StrictZipWriter();
    const hasPaintData = !!info.hasPaintData;
    let wroteModelSettings = false;
    // Sub-plan #2d: object ids kept by the plate filter, used to narrow the configs.
    let plateReferencedObjectIds = null;

    for (const entry of entries) {
      const name = entry.name;
      if (DROP_FILES.has(name)) continue;
      if (DROP_PREFIXES.some((p) => name.startsWith(p))) continue;

      if (name.endsWith('.model')) {
        if (name === '3D/3dmodel.model' && entry.size > 50_000_000) {
          // Giant main model: stream-clean to avoid buffering hundreds of MB.
          destZip.stored(name, streamCleanBytes(entry.data, hasPaintData));
        } else if (name !== '3D/3dmodel.model' && entry.method === STORED && !hasPaintData) {
          // Component already STORED by BambuSanitizer — raw copy. Must not skip when
          // hasPaintData (mmu_segmentation -> paint_color rename needed).
          rawCopyEntry(destZip, entry);
        } else if (name !== '3D/3dmodel.model' && entry.size > 20_000_000) {
          // Large component (shoe-class ~33MB): stream-clean.
          destZip.stored(name, streamCleanBytes(entry.data, hasPaintData));
        } else {
          const cleaned = cleanModelXmlForOrcaSlicer(entry.data, hasPaintData);
          let finalBytes = cleaned;
          if (plateId != null && name === '3D/3dmodel.model') {
            // Sub-plan #2c: belt-and-braces plate filter of <build>.
            const plate = (info.plates ?? []).find((p) => p.plateId === plateId);
            const plateObjectIds = plate?.objectIds != null ? new Set(plate.objectIds) : null;
            const filtered = filterModelToPlate(decodeText(cleaned), plateId, !!info.hasPlateJsons, plateObjectIds);
            const itemCount = [...filtered.matchAll(/<item\b/g)].length;
            if (itemCount >= 1) {
              // Sub-plan #2d: strip orphan <object> blocks (BFS over component refs).
              const [stripped, refIds] = stripUnreferencedResources(filtered);
              if (refIds != null) plateReferencedObjectIds = refIds;
              finalBytes = encodeText(stripped);
            }
            // else: empty build — fall back to unfiltered; native plate_id handles scope.
          }
          destZip.deflated(name, finalBytes);
        }
      } else if (name === 'Metadata/Slic3r_PE_model.config') {
        let modelSettings = convertToModelSettings(entry.data, extruderRemap);
        if (plateId != null) {
          modelSettings = stripAssembleSection(modelSettings);
          if (plateReferencedObjectIds != null) {
            modelSettings = stripUnreferencedConfigObjects(modelSettings, plateReferencedObjectIds);
          }
        }
        destZip.deflated('Metadata/model_settings.config', encodeText(modelSettings));
        wroteModelSettings = true;
      } else if (name === 'Metadata/model_settings.config') {
        // Skip when already converted from Slic3r_PE_model.config.
        if (!wroteModelSettings) {
          let sanitized = sanitizeModelSettings(entry.data);
          if (extruderRemap != null) sanitized = remapModelSettingsExtruders(sanitized, extruderRemap);
          if (plateId != null) {
            let stripped = stripAssembleSection(decodeText(sanitized));
            if (plateReferencedObjectIds != null) {
              stripped = stripUnreferencedConfigObjects(stripped, plateReferencedObjectIds);
            }
            sanitized = encodeText(stripped);
          }
          destZip.deflated(name, sanitized);
          wroteModelSettings = true;
        }
      } else if (name === 'Metadata/custom_gcode_per_layer.xml' && info.hasLayerToolChanges) {
        // Kept out of the native slice (slow path) unless a plate is selected (sub-plan
        // #2b): then it is filtered to that plate for the pause injector's XML fallback.
        if (plateId != null) {
          const filtered = filterCustomGcodePerLayer(decodeText(entry.data), plateId);
          if (isNotBlank(filtered)) destZip.deflated(name, encodeText(filtered));
        }
      } else {
        rawCopyEntry(destZip, entry);
      }
    }

    // Inject our config as project_settings.config (ZipOutputStream default: DEFLATED)
    destZip.deflated('Metadata/project_settings.config', encodeText(configIni));
    return destZip.toBytes();
  }
}

/** STORED entries are copied STORED; DEFLATED ones are re-deflated. */
function rawCopyEntry(destZip, entry) {
  if (entry.method === STORED) destZip.stored(entry.name, entry.data);
  else destZip.deflated(entry.name, entry.data);
}

function clampIntField(config, key, minimum) {
  const raw = config[key];
  if (raw == null) return;
  let str;
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw[0] == null) return;
    str = anyToString(raw[0]);
  } else str = anyToString(raw);
  const value = toIntOrNull(str.trim());
  if (value == null) return;
  if (value < minimum) config[key] = String(minimum);
}

function sanitizeNilValues(config) {
  const toRemove = [];
  for (const [key, list] of Object.entries(config)) {
    if (!Array.isArray(list)) continue;
    if (!list.some((it) => it === 'nil')) continue;
    const def = list.find((it) => it !== 'nil');
    if (def === undefined) { toRemove.push(key); continue; }
    for (let i = 0; i < list.length; i++) if (list[i] === 'nil') list[i] = def;
  }
  for (const k of toRemove) delete config[k];
}

/**
 * Phase 2 §4 Step 3 — pad-only: arrays larger than targetCount are the file's true
 * filament list (H2C benchy: 7 on a 4-slot printer) and are left alone.
 */
function normalizePerFilamentArrays(config, targetCount) {
  for (const [key, list] of Object.entries(config)) {
    if (NON_FILAMENT_KEYS.has(key) || SPECIAL_LIST_KEYS.has(key)) continue;
    if (!Array.isArray(list) || list.length === 0) continue;
    if (list.length < targetCount) {
      const pad = LIST_DEFAULTS[key] ?? anyToString(list[list.length - 1]);
      while (list.length < targetCount) list.push(pad);
    }
  }
  normalizeMatrix(config, 'flush_volumes_matrix', targetCount * targetCount); // NxN
  normalizeMatrix(config, 'flush_volumes_vector', targetCount * 2); // 2xN
}

function normalizeMatrix(config, key, targetSize) {
  const list = config[key];
  if (Array.isArray(list)) {
    const pad = list.length > 0 ? list[list.length - 1] : '0';
    while (list.length < targetSize) list.push(pad);
    if (list.length > targetSize) list.length = targetSize;
  }
}

const toF = (s) => {
  const v = toFloatOrNull(s);
  return v == null ? null : Math.fround(v);
};
const coerceIn = (v, min, max) => (v < min ? min : v > max ? max : v);

function sanitizeWipeTowerPosition(config, bedSize = 270) {
  const f = Math.fround;
  const towerWidth = getNumeric(config, 'prime_tower_width', 35);
  const towerBrim = Math.max(0, getNumeric(config, 'prime_tower_brim_width', 3));
  const halfSpan = Math.max(12, f(f(f(towerWidth / 2) + towerBrim) + 6));
  const minPos = halfSpan;
  const maxPos = Math.max(minPos, f(bedSize - halfSpan));
  clampScalarPosition(config, 'wipe_tower_x', minPos, maxPos);
  clampScalarPosition(config, 'wipe_tower_y', minPos, maxPos);
}

/** Per-extruder lists (from buildProfileOverrides) are clamped element-wise in place. */
function clampScalarPosition(config, key, min, max) {
  const raw = config[key];
  if (raw == null) return;
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const v = toF(anyToString(raw[i]));
      if (v == null) continue;
      if (v < min || v > max) raw[i] = fmtFixed(coerceIn(v, min, max), 3);
    }
    return;
  }
  const value = toF(anyToString(raw));
  if (value == null) return;
  if (value < min || value > max) config[key] = fmtFixed(coerceIn(value, min, max), 3);
}

function getNumeric(config, key, def) {
  const raw = config[key];
  if (raw == null) return def;
  if (Array.isArray(raw)) return (raw.length > 0 && raw[0] != null ? toF(anyToString(raw[0])) : null) ?? def;
  return toF(anyToString(raw)) ?? def;
}

export const _internal = {
  cleanModelXmlForOrcaSlicer, clampIntField, sanitizeNilValues, normalizePerFilamentArrays,
  sanitizeWipeTowerPosition, clampScalarPosition, U1_FILAMENT_SAFETY_OVERLAY, LIST_DEFAULTS,
};
