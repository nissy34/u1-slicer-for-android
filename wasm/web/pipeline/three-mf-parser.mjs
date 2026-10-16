// Port of app/src/main/java/com/u1/slicer/bambu/ThreeMfParser.kt.
//
// Parses 3MF files (ZIP archives) to extract object info, plate structure, Bambu
// metadata and multi-colour information. Entry points take the archive as bytes
// (Uint8Array) instead of a java.io.File; they also accept the entry array that
// zip.mjs readZip() returns, so callers that already unzipped don't pay twice.
//
// Where the Kotlin code takes `zip: ZipFile` / `modelEntry: ZipEntry?` (the
// internal helpers computeVisualColorCountByPlate / computePaintPresenceByPlate)
// the JS takes `entries` (readZip result) and `modelEntry` (one of those entries,
// or null). Component scanners receive `(path, data: Uint8Array)` instead of
// `(path, InputStream)`.
import { readZip, getEntry, decodeText } from './zip.mjs';
import { XmlPullParser } from './xml-pull.mjs';
import { toFloatOrNull, toIntOrNull } from './kt.mjs';
import { decodeStates } from './paint-color-decoder.mjs';
import {
  threeMfInfo, threeMfPlate, threeMfObject, emptyThreeMfInfo, IDENTITY_TRANSFORM,
} from './three-mf-info.mjs';
import {
  parseLayerToolCustomGcodeXml, parseLayerToolCustomGcodeXmlPerPlate, parseLayerToolSegments,
} from './layer-tool-custom-gcode-xml.mjs';

const MAX_SAFE_SINGLE_COMPONENT_BYTES = 256 * 1024 * 1024;
const MAX_SAFE_TOTAL_COMPONENT_BYTES = 384 * 1024 * 1024;

/**
 * Complex SEMM encoding is detected when unique spec strings greatly exceed
 * distinct paint states. Simple encoding tops out at 16 specs (one per state
 * 0..F), so past the cap the model is definitively complex-encoded and we stop
 * growing the set (B91 — Skywing spent >3 min here).
 */
const SPEC_CAP_FOR_COMPLEX_DETECTION = 32;

// Bambu detection markers
const BAMBU_MARKERS = new Set([
  'Metadata/model_settings.config',
  'Metadata/slice_info.config',
  'Metadata/filament_sequence.json',
  'Metadata/project_settings.config',
  'Metadata/custom_gcode_per_layer.xml',
]);

let logHook = null;
/** Optional logging hook `(level, message) => void` (replaces android.util.Log). */
export function setLogHook(fn) { logHook = fn; }
const log = (level, msg) => { if (logHook) logHook(level, `ThreeMfParser: ${msg}`); };

// ── small Kotlin-ish helpers ───────────────────────────────────────────────

const sortedNumbers = (iter) => [...iter].sort((a, b) => a - b);
const sortedSet = (iter) => new Set(sortedNumbers(iter));
const isBlank = (s) => s == null || s.trim().length === 0;
const endsWithIgnoreCase = (s, suffix) => s.toLowerCase().endsWith(suffix.toLowerCase());

/** Accepts archive bytes or a readZip() entry array. */
function toEntries(input) {
  if (Array.isArray(input)) return input;
  return readZip(input);
}

const encodeAscii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Index of `needle` in `hay` at or after `from`, or -1. */
function indexOfBytes(hay, needle, from = 0) {
  const first = needle[0];
  const n = needle.length;
  const last = hay.length - n;
  let i = hay.indexOf(first, from);
  while (i !== -1 && i <= last) {
    let j = 1;
    while (j < n && hay[i + j] === needle[j]) j++;
    if (j === n) return i;
    i = hay.indexOf(first, i + 1);
  }
  return -1;
}

/** Kotlin `String(bytes, US_ASCII)`: non-ASCII bytes become U+FFFD. */
function asciiString(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    s += b < 128 ? String.fromCharCode(b) : '�';
  }
  return s;
}

// ── archive sizing ─────────────────────────────────────────────────────────

/**
 * Lists `[name, uncompressedSize]` from the zip central directory without
 * inflating anything (Kotlin `zip.entries().map { it.name to it.size }`).
 */
function listZipEntrySizes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  // Zip64 end of central directory locator.
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 &&
      dv.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(dv.getBigUint64(eocd - 12, true));
    count = Number(dv.getBigUint64(z64 + 32, true));
    cdOffset = Number(dv.getBigUint64(z64 + 48, true));
  }
  const out = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (size === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = dv.getUint16(e, true);
        const len = dv.getUint16(e + 2, true);
        if (id === 0x0001) { size = Number(dv.getBigUint64(e + 4, true)); break; }
        e += 4 + len;
      }
    }
    out.push([name, size]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Returns an ArchiveSizingRisk `{ largestComponentEntry, largestComponentBytes,
 * totalComponentBytes }` when component .model entries exceed the safe budget,
 * else null. `input` = archive bytes or readZip() entries; `name` (optional)
 * mirrors the Kotlin `.3mf` file-name check.
 */
export function inspectArchiveSizing(input, { name } = {}) {
  if (input == null || (name != null && !endsWithIgnoreCase(name, '.3mf'))) return null;
  try {
    const sizes = Array.isArray(input)
      ? input.map((e) => [e.name, e.size ?? e.data.length])
      : listZipEntrySizes(input);
    return assessArchiveSizing(sizes);
  } catch {
    return null;
  }
}

/** `entries`: array of `[name, sizeBytes]`. */
export function assessArchiveSizing(entries) {
  const componentEntries = entries.filter(([name, size]) =>
    endsWithIgnoreCase(name, '.model') && name !== '3D/3dmodel.model' && size > 0);
  if (componentEntries.length === 0) return null;

  let largest = componentEntries[0];
  for (const e of componentEntries) if (e[1] > largest[1]) largest = e;
  const total = componentEntries.reduce((s, e) => s + e[1], 0);
  if (largest[1] <= MAX_SAFE_SINGLE_COMPONENT_BYTES && total <= MAX_SAFE_TOTAL_COMPONENT_BYTES) {
    return null;
  }
  return {
    largestComponentEntry: largest[0],
    largestComponentBytes: largest[1],
    totalComponentBytes: total,
  };
}

// ── parse ──────────────────────────────────────────────────────────────────

/**
 * Full parse. `input` = .3mf bytes (Uint8Array) or readZip() entries.
 * Options: `skipPaintDetection` (default false); `name` — when given and not
 * ending in `.3mf` the result is the empty non-Bambu info (Kotlin File check).
 * Never throws: on failure returns the empty non-Bambu ThreeMfInfo.
 */
export function parse(input, { skipPaintDetection = false, name } = {}) {
  if (input == null || (name != null && !endsWithIgnoreCase(name, '.3mf'))) {
    return emptyThreeMfInfo(false, false);
  }

  try {
    const entries = toEntries(input);
    const entryNames = new Set(entries.map((e) => e.name));
    const isBambu = [...entryNames].some((n) => BAMBU_MARKERS.has(n));

    const modelEntry = getEntry(entries, '3D/3dmodel.model');
    if (!modelEntry) return emptyThreeMfInfo(isBambu, false);

    const mainModelMetadata = parseMainModelMetadata(modelEntry.data);
    const objects = mainModelMetadata.objects;
    const buildItems = mainModelMetadata.buildItems;

    // Multi-plate detection, two complementary signals:
    // 1. Plate JSON count (new Bambu format): plate_N.json per plate, > 1 → multi-plate.
    // 2. Virtual-plate item positions (old format, e.g. Dragon Scale / Shashibo):
    //    printable items laid out ~420 mm X / ~384 mm Y apart; any printable item
    //    with TX > 270 or TY outside [0, 270] is off the U1 bed → another plate.
    // Build item count alone is wrong: Benchy has a printable="0" reference item.
    const plateJsonRe = /^Metadata\/plate_\d+\.json$/;
    const plateJsonCount = [...entryNames].filter((n) => plateJsonRe.test(n)).length;
    const hasVirtualPlateItems = buildItems.some((item) => {
      if (!item.printable) return false;
      const tx = item.transform.length > 9 ? item.transform[9] : 0;
      const ty = item.transform.length > 10 ? item.transform[10] : 0;
      return tx > 270 || ty < 0 || ty > 270;
    });
    const isMultiPlate = plateJsonCount > 1 || hasVirtualPlateItems;
    const componentModels = !skipPaintDetection
      ? entries.filter((e) => e.name.endsWith('.model') && e.name !== '3D/3dmodel.model')
      : [];

    // Bambu model_settings.config: plate names, extruder assignments, plate→object maps.
    const plateNames = new Map();
    const objectNames = new Map();
    const extruderAssignments = new Map();
    const plateObjectMap = new Map();
    const plateFilamentMap = new Map();
    const plateFilamentSlotsMap = new Map();

    const allExtruderValuesMain = new Set();
    const objectPartExtrudersMain = new Map();
    const compoundPartParentsMain = new Map();
    if (isBambu) {
      const msEntry = getEntry(entries, 'Metadata/model_settings.config');
      if (msEntry) {
        parseModelSettingsConfig(msEntry.data, {
          plateNames, objectNames, extruderAssignments, plateObjectMap, plateFilamentMap,
          plateFilamentSlotsMap,
          allExtruderValues: allExtruderValuesMain,
          objectPartExtruders: objectPartExtrudersMain,
          compoundPartParents: compoundPartParentsMain,
        });
        if (plateObjectMap.size > 0) log('i', `Plate→object mapping: ${plateObjectMap.size} plates`);
      }
    }

    // B57: support painting — single-colour Bambu files with paint_supports need the
    // ProfileEmbedder preserve path so embedded enable_support etc. survive.
    const hasPaintSupports = skipPaintDetection ? false
      : (streamDetectPaintSupports(modelEntry.data) ||
        entries.some((e) => e.name.endsWith('.model') && e.name !== '3D/3dmodel.model' &&
          streamDetectPaintSupports(e.data)));

    // Paint detection through the per-plate visual summary when possible. Single-plate
    // files keep the detailed paint-state decode; multi-plate files use a cheaper
    // presence-only pass (native plate selection replaces it later anyway).
    const componentPathsByObject = (!skipPaintDetection && isBambu && plateObjectMap.size > 0)
      ? mainModelMetadata.componentPathsByObject
      : new Map();
    let visualByPlateCache;
    let paintSummary;
    let hasPaintData;
    if (skipPaintDetection) {
      visualByPlateCache = new Map();
      paintSummary = { hasPaintData: false, paintStateCount: 0 };
      hasPaintData = false;
    } else if (isMultiPlate && componentPathsByObject.size > 0) {
      const paintPresenceByPlate = computePaintPresenceByPlate({
        entries, modelEntry, plateObjectMap, componentPathsByObject,
      });
      hasPaintData = [...paintPresenceByPlate.values()].some(Boolean);
      visualByPlateCache = new Map();
      for (const [plateId, hasPaint] of paintPresenceByPlate) {
        const objectExtruders = new Set(
          (plateObjectMap.get(plateId) ?? []).map((id) => extruderAssignments.get(id)).filter((v) => v != null));
        visualByPlateCache.set(plateId, plateVisualInfo({
          count: hasPaint ? Math.max(1, objectExtruders.size + 1) : objectExtruders.size,
          hasPaint,
          objectExtruders,
          paintExtruderStates: new Set(),
        }));
      }
      paintSummary = summarizePaintDetection(isMultiPlate, visualByPlateCache);
    } else {
      const visual = (isBambu && plateObjectMap.size > 0)
        ? computeVisualColorCountByPlate({
          entries, modelEntry, plateObjectMap, componentPathsByObject, extruderAssignments,
        })
        : new Map();
      visualByPlateCache = visual;
      paintSummary = visual.size > 0 ? summarizePaintDetection(isMultiPlate, visual) : null;
      if (paintSummary != null) {
        hasPaintData = paintSummary.hasPaintData;
      } else {
        // Single-plate / degenerate files: a quick byte scan answers the boolean.
        const mainHasPaint = streamDetectPaintData(modelEntry.data);
        const componentHasPaint = componentModels.some((e) => streamDetectPaintData(e.data));
        hasPaintData = mainHasPaint || componentHasPaint;
      }
    }

    // Layer tool changes + per-layer colours from custom_gcode_per_layer.xml
    // (Hueforge-style files use this instead of object-level segmentation).
    let layerToolXml = null;
    if (isBambu) {
      const e = getEntry(entries, 'Metadata/custom_gcode_per_layer.xml');
      if (e) layerToolXml = decodeText(e.data);
    }
    const layerToolInfo = layerToolXml != null ? parseLayerToolCustomGcodeXml(layerToolXml) : null;
    const hasLayerToolChanges = layerToolInfo?.hasToolChanges === true;
    let layerToolSegments = null;
    if (hasLayerToolChanges && layerToolXml != null) {
      const segs = parseLayerToolSegments(layerToolXml);
      layerToolSegments = segs.length > 0 ? segs : null;
    }
    const perPlateLayerToolInfo = layerToolXml != null
      ? parseLayerToolCustomGcodeXmlPerPlate(layerToolXml) : new Map();

    // Colours, priority order.
    const detectedColors = [];

    // 1. Bambu filament_sequence.json
    const filamentSeqEntry = getEntry(entries, 'Metadata/filament_sequence.json');
    if (filamentSeqEntry) detectColorsFromFilamentSequence(filamentSeqEntry.data, detectedColors);
    // 2. Bambu project_settings.config — JSON
    if (detectedColors.length === 0) {
      const projEntry = getEntry(entries, 'Metadata/project_settings.config');
      if (projEntry) detectColorsFromJsonSettings(projEntry.data, detectedColors);
    }

    // M3-B full-spectrum marker (Smart Paint stamps full_spectrum_physical_count).
    let fullSpectrumPhysicalCount = null;
    {
      const projEntry = getEntry(entries, 'Metadata/project_settings.config');
      if (projEntry) {
        try { fullSpectrumPhysicalCount = readFullSpectrumPhysicalCount(decodeText(projEntry.data)); } catch { /* null */ }
      }
    }
    // 3. PrusaSlicer Slic3r_PE.config — semicolon-delimited INI (+ per-object
    //    assignments in Slic3r_PE_model.config).
    if (detectedColors.length === 0) {
      const slic3rEntry = getEntry(entries, 'Metadata/Slic3r_PE.config');
      if (slic3rEntry) {
        const slic3rColors = [];
        detectColorsFromSlic3rConfig(slic3rEntry.data, slic3rColors);
        if (slic3rColors.length > 1) {
          // Only add if file has per-object assignments or paint data
          const modelCfgEntry = getEntry(entries, 'Metadata/Slic3r_PE_model.config');
          const hasAssignment = modelCfgEntry != null && detectSlic3rModelAssignments(modelCfgEntry.data);
          if (hasAssignment || hasPaintData) detectedColors.push(...slic3rColors);
        } else {
          detectedColors.push(...slic3rColors);
        }
      }
    }
    // 4. OrcaSlicer / generic config.ini — INI
    if (detectedColors.length === 0) {
      const configEntry = getEntry(entries, 'config.ini') ?? getEntry(entries, 'Metadata/config.ini');
      if (configEntry) detectColorsFromIniConfig(configEntry.data, detectedColors);
    }

    // Hueforge-style per-layer tool changes can carry the real preview colours even
    // when the object geometry itself is single-colour.
    const layerToolColors = layerToolInfo?.colors ?? [];
    if (layerToolColors.length > 0 && detectedColors.length <= 1) {
      detectedColors.length = 0;
      detectedColors.push(...layerToolColors);
    }
    let paintStateCount;
    if (skipPaintDetection) paintStateCount = 0;
    else if (paintSummary != null) paintStateCount = paintSummary.paintStateCount;
    else if (hasPaintData) paintStateCount = Math.max(1, detectedColors.length);
    else paintStateCount = 0;
    if (detectedColors.length > 0 && paintStateCount > 0) {
      // The detected physical palette bounds the file-level paint-state count.
      paintStateCount = Math.min(paintStateCount, detectedColors.length);
    }
    // Sub-plan #2c/#2d: per-plate paint state (+ paint extruder states). Gated on
    // file-level hasPaintData — non-painted files skip the per-plate scan (B93).
    let visualByPlate;
    if (visualByPlateCache.size > 0) {
      visualByPlate = visualByPlateCache;
    } else if (hasPaintData && plateObjectMap.size === 1) {
      const plateId = plateObjectMap.keys().next().value;
      const objectExtruders = new Set(
        (plateObjectMap.get(plateId) ?? []).map((id) => extruderAssignments.get(id)).filter((v) => v != null));
      visualByPlate = new Map([[plateId, plateVisualInfo({
        count: Math.max(1, paintStateCount),
        hasPaint: true,
        objectExtruders,
        paintExtruderStates: new Set(),
      })]]);
    } else {
      visualByPlate = new Map();
    }

    const thumbnailFor = (plateId) => getEntry(entries, `Metadata/plate_${plateId}.png`)?.data ?? null;

    // Plates: model_settings.config plate→object mappings when available, else
    // 1 build item = 1 plate (non-Bambu / old format).
    let plates;
    if (plateObjectMap.size > 0) {
      plates = sortedNumbers(plateObjectMap.keys()).map((plateId) => {
        const objIds = plateObjectMap.get(plateId) ?? [];
        const firstItem = buildItems.find((it) => objIds.includes(it.objectId)) ?? null;
        const plateName = resolvePlateName(plateId, firstItem?.objectId ?? '', plateNames, objectNames, objects);
        const plateLtInfo = perPlateLayerToolInfo.get(plateId) ?? null;
        const visual = visualByPlate.get(plateId);
        return threeMfPlate({
          plateId,
          name: plateName,
          objectIds: objIds,
          filamentIndices: plateFilamentMap.get(plateId) ?? new Set(),
          filamentMapSlots: plateFilamentSlotsMap.get(plateId) ?? new Set(),
          printable: firstItem?.printable ?? true,
          transform: firstItem?.transform ?? [...IDENTITY_TRANSFORM],
          thumbnailBytes: thumbnailFor(plateId),
          layerToolColors: plateLtInfo?.colors ?? [],
          layerToolExtruders: plateLtInfo?.extruders ?? new Set(),
          hasLayerToolChanges: plateLtInfo?.hasToolChanges === true,
          hasPaintData: visual?.hasPaint === true,
          paintExtruderStates: visual?.paintExtruderStates ?? new Set(),
        });
      });
    } else {
      plates = buildItems.map((item, idx) => {
        const plateId = idx + 1;
        return threeMfPlate({
          plateId,
          name: resolvePlateName(plateId, item.objectId, plateNames, objectNames, objects),
          objectIds: [item.objectId],
          filamentIndices: plateFilamentMap.get(plateId) ?? new Set(),
          filamentMapSlots: plateFilamentSlotsMap.get(plateId) ?? new Set(),
          printable: item.printable,
          transform: item.transform,
          thumbnailBytes: thumbnailFor(plateId),
        });
      });
    }

    // Unique extruders from ALL per-part values (B16: max-per-object missed
    // multi-part colour indices).
    const uniqueExtruders = allExtruderValuesMain.size > 0
      ? allExtruderValuesMain : new Set(extruderAssignments.values());
    const layerToolExtruderCount = layerToolInfo?.extruders?.size ?? 0;
    const maxAssigned = extruderAssignments.size > 0 ? Math.max(...extruderAssignments.values()) : 0;
    const extruderCount = Math.max(
      1, maxAssigned, detectedColors.length, layerToolExtruderCount,
      paintStateCount, // B44: distinct paint states from model triangles
    );

    // 5. Placeholder colours when multi-extruder but no/insufficient colours.
    const palette = ['#CC3333', '#3399CC', '#33AA55', '#DDAA22'];
    if (detectedColors.length === 0 && extruderCount > 1) {
      for (let i = 0; i < extruderCount; i++) detectedColors.push(palette[i % palette.length]);
    } else if (detectedColors.length < extruderCount) {
      // B44: paint specs revealed more extruders than config listed colours — pad
      while (detectedColors.length < extruderCount) detectedColors.push(palette[detectedColors.length % palette.length]);
    }

    const objectPartExtruders = new Map();
    for (const [k, v] of objectPartExtrudersMain) objectPartExtruders.set(k, new Set(v));

    return threeMfInfo({
      objects,
      plates,
      isBambu,
      isMultiPlate,
      hasPaintData,
      hasPaintSupports,
      hasLayerToolChanges,
      detectedColors,
      detectedExtruderCount: extruderCount,
      hasPlateJsons: plateJsonCount > 1,
      usedExtruderIndices: uniqueExtruders,
      volumeExtruders: uniqueExtruders, // §4 Step 8
      objectExtruderMap: new Map(extruderAssignments),
      objectPartExtruders,
      compoundPartParents: new Map(compoundPartParentsMain),
      layerToolSegments,
      fullSpectrumPhysicalCount,
    });
  } catch (e) {
    log('e', `Failed to parse 3MF: ${e?.message}`);
    return emptyThreeMfInfo(false, false);
  }
}

/**
 * Lightweight parse for plate selection — reads model_settings.config (or
 * Slic3r_PE_model.config) for usedExtruderIndices plus the per-plate visual pass.
 * Returns a minimal ThreeMfInfo suitable for mergeThreeMfInfoForPlate().
 */
export function parseForPlateSelection(input) {
  try {
    const entries = toEntries(input);
    const entryNames = new Set(entries.map((e) => e.name));
    const isBambu = [...entryNames].some((n) => BAMBU_MARKERS.has(n));
    const modelEntry = getEntry(entries, '3D/3dmodel.model');

    const plateNames = new Map();
    const objectNames = new Map();
    const extruderAssignments = new Map();
    const plateObjectMap = new Map();
    const plateFilamentMap = new Map();
    const plateFilamentSlotsMapLite = new Map();

    // model_settings.config first, then Slic3r_PE_model.config (restructurePlateFile
    // writes the latter for compound objects).
    const msEntry = getEntry(entries, 'Metadata/model_settings.config') ??
      getEntry(entries, 'Metadata/Slic3r_PE_model.config');
    const allExtruderValues = new Set();
    const objectPartExtrudersLite = new Map();
    const compoundPartParentsLite = new Map();
    if (msEntry) {
      parseModelSettingsConfig(msEntry.data, {
        plateNames, objectNames, extruderAssignments, plateObjectMap, plateFilamentMap,
        plateFilamentSlotsMap: plateFilamentSlotsMapLite,
        allExtruderValues,
        objectPartExtruders: objectPartExtrudersLite,
        compoundPartParents: compoundPartParentsLite,
      });
    }

    const uniqueExtruders = allExtruderValues.size > 0
      ? allExtruderValues : new Set(extruderAssignments.values());
    const componentPathsByObject = modelEntry
      ? parseMainModelMetadata(modelEntry.data).componentPathsByObject : new Map();
    const visualColorCountByPlate = computeVisualColorCountByPlate({
      entries, modelEntry, plateObjectMap, componentPathsByObject, extruderAssignments,
    });
    const lightweightPlates = sortedNumbers(plateFilamentMap.keys()).map((plateId) => threeMfPlate({
      plateId,
      name: plateNames.get(plateId) ?? `Plate ${plateId}`,
      objectIds: [...(plateObjectMap.get(plateId) ?? [])],
      filamentIndices: plateFilamentMap.get(plateId) ?? new Set(),
      filamentMapSlots: plateFilamentSlotsMapLite.get(plateId) ?? new Set(),
      // Sub-plan #2c: per-plate paint state for mergeThreeMfInfoForPlate.
      hasPaintData: visualColorCountByPlate.get(plateId)?.hasPaint === true,
    }));
    const visuals = [...visualColorCountByPlate.values()];
    const hasPaintDataForPlate = visuals.some((v) => v.hasPaint);
    let effectiveExtruders = uniqueExtruders;
    if (visuals.length > 0) {
      let maxPlate = visuals[0];
      for (const v of visuals) if (v.count > maxPlate.count) maxPlate = v;
      const visualCount = maxPlate.count;
      if (visualCount > uniqueExtruders.size) {
        // B90: when the plate's object extruders include indices strictly above
        // visualCount (Buzz plate 9: extruder=10, visualCount=2), the synthetic
        // 1..visualCount range would substitute unrelated low filaments. Use the
        // union of object extruders and paint states instead. slip-slide plate 3
        // (object extruder 1 ≤ visualCount 4) keeps the synthetic range (B84).
        const maxObjectExtruder = maxPlate.objectExtruders.size > 0 ? Math.max(...maxPlate.objectExtruders) : 0;
        if (maxObjectExtruder > visualCount) {
          effectiveExtruders = sortedSet(
            [...maxPlate.objectExtruders, ...maxPlate.paintExtruderStates].filter((v) => v > 0));
        } else {
          effectiveExtruders = new Set(Array.from({ length: visualCount }, (_, i) => i + 1));
        }
      }
    }
    const projectColors = [];
    const projEntry = getEntry(entries, 'Metadata/project_settings.config');
    if (projEntry) detectColorsFromJsonSettings(projEntry.data, projectColors);
    const ltEntry = getEntry(entries, 'Metadata/custom_gcode_per_layer.xml');
    const layerToolInfo = ltEntry ? parseLayerToolCustomGcodeXml(decodeText(ltEntry.data)) : null;
    const layerToolExtruders = layerToolInfo?.extruders ?? new Set();
    const filteredColors = new Set();
    const filteredExtruders = sortedSet([...effectiveExtruders, ...layerToolExtruders].filter((v) => v > 0));
    if (projectColors.length > 0 && filteredExtruders.size > 0) {
      for (const extruderIndex of filteredExtruders) {
        const c = projectColors[extruderIndex - 1];
        if (c !== undefined) filteredColors.add(c);
      }
    }
    for (const c of layerToolInfo?.colors ?? []) filteredColors.add(c);
    const detectedColors = [...filteredColors];
    let detectedExtruderCount;
    if (filteredExtruders.size > 0) detectedExtruderCount = Math.max(filteredExtruders.size, detectedColors.length);
    else if (detectedColors.length > 0) detectedExtruderCount = detectedColors.length;
    else detectedExtruderCount = 1;

    const objectPartExtruders = new Map();
    for (const [k, v] of objectPartExtrudersLite) objectPartExtruders.set(k, new Set(v));
    return threeMfInfo({
      objects: [],
      plates: lightweightPlates,
      isBambu,
      isMultiPlate: false,
      hasLayerToolChanges: layerToolInfo?.hasToolChanges === true,
      hasPaintData: hasPaintDataForPlate,
      detectedColors,
      detectedExtruderCount,
      usedExtruderIndices: filteredExtruders.size > 0 ? filteredExtruders : effectiveExtruders,
      objectExtruderMap: new Map(extruderAssignments),
      objectPartExtruders,
      compoundPartParents: new Map(compoundPartParentsLite),
    });
  } catch (e) {
    log('e', `Failed to parseForPlateSelection: ${e?.message}`);
    return emptyThreeMfInfo(false, false);
  }
}

// ── main model ─────────────────────────────────────────────────────────────

/**
 * Single pass over 3D/3dmodel.model bytes. Returns `{ objects: ThreeMfObject[],
 * buildItems: [{objectId, printable, transform}], componentPathsByObject:
 * Map<objectId, string[]> }` (MainModelMetadata).
 */
export function parseMainModelMetadata(bytes) {
  const objects = [];
  const items = [];
  const componentPaths = new Map();
  const parser = new XmlPullParser(typeof bytes === 'string' ? bytes : decodeText(bytes));

  let inResources = false;
  let inBuild = false;
  let currentObjectId = null;
  let currentObjectName = null;
  let hasMesh = false;

  while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
    const ev = parser.getEventType();
    if (ev === XmlPullParser.START_TAG) {
      const localName = parser.getName();
      if (localName === 'resources') inResources = true;
      else if (localName === 'build') inBuild = true;
      else if (localName === 'object' && inResources) {
        currentObjectId = parser.getAttributeValue(null, 'id');
        currentObjectName = parser.getAttributeValue(null, 'name');
        hasMesh = false;
      } else if (localName === 'mesh') hasMesh = true;
      else if (localName === 'component') {
        const objectId = currentObjectId;
        const path = parser.getAttributeValue(null, 'p:path') ?? parser.getAttributeValue(null, 'path');
        if (objectId != null && !isBlank(path)) {
          if (!componentPaths.has(objectId)) componentPaths.set(objectId, []);
          componentPaths.get(objectId).push(path.replace(/^\/+/, ''));
        }
      } else if (localName === 'item' && inBuild) {
        const objectId = parser.getAttributeValue(null, 'objectid') ?? '';
        const printable = parser.getAttributeValue(null, 'printable') !== '0';
        const transformStr = parser.getAttributeValue(null, 'transform') ?? '';
        items.push({ objectId, printable, transform: parseTransform(transformStr) });
      } else if (localName === 'vertices' || localName === 'triangles') {
        // Fast-forward over the (millions of) children.
        skipToEndTag(parser, localName);
      }
    } else if (ev === XmlPullParser.END_TAG) {
      const localName = parser.getName();
      if (localName === 'object' && currentObjectId != null) {
        if (hasMesh) {
          objects.push(threeMfObject(currentObjectId, currentObjectName ?? `Object_${currentObjectId}`, 0, 0));
        }
        currentObjectId = null;
        currentObjectName = null;
      }
      if (localName === 'resources') inResources = false;
      if (localName === 'build') inBuild = false;
    }
    parser.next();
  }
  return { objects, buildItems: items, componentPathsByObject: componentPaths };
}

/**
 * Leaves the parser on the END_TAG matching the current START_TAG (the Kotlin
 * depth-counting loop). Jumps straight to the closing tag text when possible —
 * vertex/triangle lists have no nested element of the same name.
 */
function skipToEndTag(parser, name) {
  if (!parser.pendingEnd && typeof parser.pos === 'number' && typeof parser.text === 'string') {
    const idx = parser.text.indexOf(`</${name}`, parser.pos);
    if (idx >= 0) parser.pos = idx;
  }
  let depth = 1;
  while (depth > 0 && parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
    const ev = parser.next();
    if (ev === XmlPullParser.START_TAG) depth++;
    else if (ev === XmlPullParser.END_TAG) depth--;
  }
}

// ── byte scans ─────────────────────────────────────────────────────────────

const NEEDLE_PAINT_COLOR = encodeAscii('paint_color');
const NEEDLE_MMU_SEGMENTATION = encodeAscii('mmu_segmentation');
const NEEDLE_PAINT_SUPPORTS = encodeAscii('paint_supports');
const NEEDLE_PAINT_COLOR_ATTR = encodeAscii('paint_color="');
const NEEDLE_MMU_SEGMENTATION_ATTR = encodeAscii('mmu_segmentation="');

/** True when the bytes contain "paint_color" or "mmu_segmentation". */
export function streamDetectPaintData(bytes) {
  return indexOfBytes(bytes, NEEDLE_PAINT_COLOR) >= 0 || indexOfBytes(bytes, NEEDLE_MMU_SEGMENTATION) >= 0;
}

/**
 * B57: true when the bytes contain "paint_supports" (support painting; not caught
 * by streamDetectPaintData).
 */
export function streamDetectPaintSupports(bytes) {
  return indexOfBytes(bytes, NEEDLE_PAINT_SUPPORTS) >= 0;
}

/** Thrown by an onSpec callback to stop streamCollectPaintSpecs early (B91). */
export const EarlyExit = Object.freeze({ earlyExit: true });

/**
 * Calls `onSpec(spec)` for each non-blank `paint_color="…"` / `mmu_segmentation="…"`
 * value (including `slic3rpe:mmu_segmentation`), in file order. The callback may
 * `throw EarlyExit` to stop (Skywing has 162K paint_color attributes — B91).
 *
 * Deviation: Kotlin streams through a 64 KB buffer and can drop a spec longer than
 * ~2 KB straddling a buffer boundary; this scans the whole buffer.
 */
export function streamCollectPaintSpecs(bytes, onSpec) {
  try {
    let pos = 0;
    let next1 = -2;
    let next2 = -2;
    for (;;) {
      if (next1 !== -1 && next1 < pos) next1 = indexOfBytes(bytes, NEEDLE_PAINT_COLOR_ATTR, pos);
      if (next2 !== -1 && next2 < pos) next2 = indexOfBytes(bytes, NEEDLE_MMU_SEGMENTATION_ATTR, pos);
      let matchIdx;
      let matchLen;
      if (next1 >= 0 && (next2 < 0 || next1 < next2)) { matchIdx = next1; matchLen = NEEDLE_PAINT_COLOR_ATTR.length; }
      else if (next2 >= 0) { matchIdx = next2; matchLen = NEEDLE_MMU_SEGMENTATION_ATTR.length; }
      else break;
      const vStart = matchIdx + matchLen;
      const vEnd = bytes.indexOf(0x22 /* " */, vStart);
      if (vEnd < 0) break;
      const spec = asciiString(bytes, vStart, vEnd);
      if (!isBlank(spec)) onSpec(spec);
      pos = vEnd + 1;
    }
  } catch (e) {
    if (e !== EarlyExit) throw e;
  }
}

/**
 * Decodes the first character of a paint spec to a 0-based paint-state index
 * (0 = unpainted, 1..35 for 1-9/A-Z). Null outside 0-9/A-Z. (Legacy heuristic —
 * see paint-color-decoder.mjs for the real decode.)
 */
export function paintCharToState(c) {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  return null;
}

// ── per-plate visual colour metadata ───────────────────────────────────────

/**
 * PlateVisualInfo: `count` distinct colour regions on the plate, `hasPaint`,
 * `objectExtruders` (Set of 1-based filament indices assigned to the plate's
 * objects), `paintExtruderStates` (Set of non-zero decoded paint states).
 */
export const plateVisualInfo = ({ count, hasPaint, objectExtruders, paintExtruderStates }) =>
  ({ count, hasPaint, objectExtruders, paintExtruderStates });

/** ComponentPaintInfo: `paintSpecs`, `allPaintStates` (incl. 0), `paintExtruderStates` — all Sets. */
export const componentPaintInfo = ({ paintSpecs, allPaintStates, paintExtruderStates }) =>
  ({ paintSpecs, allPaintStates, paintExtruderStates });

/** Returns PaintDetectionSummary `{ hasPaintData, paintStateCount }`. */
export function summarizePaintDetection(isMultiPlate, visualByPlate) {
  const values = [...visualByPlate.values()];
  const hasPaintData = values.some((v) => v.hasPaint);
  const paintStateCount = isMultiPlate ? 0
    : (values.length > 0 ? Math.max(...values.map((v) => v.count)) : 0);
  return { hasPaintData, paintStateCount };
}

function fallbackPlateObjectMapFor(plateObjectMap, modelEntry) {
  if (plateObjectMap.size > 0 || modelEntry == null) return plateObjectMap;
  const m = new Map();
  parseMainModelMetadata(modelEntry.data).buildItems.forEach((item, index) => m.set(index + 1, [item.objectId]));
  return m;
}

function uniqueComponentPathsFor(plateObjectMap, componentPathsByObject) {
  const set = new Set();
  for (const objectIds of plateObjectMap.values()) {
    for (const objectId of objectIds) for (const p of componentPathsByObject.get(objectId) ?? []) set.add(p);
  }
  return set;
}

/**
 * Cheap per-plate paint-presence scan (multi-plate import fast path): only
 * answers "does this plate reference any painted component?". Each unique
 * component path is scanned once. Returns Map<plateId, boolean>.
 * `componentScanner(path, data) => boolean` defaults to streamDetectPaintData.
 */
export function computePaintPresenceByPlate({
  entries,
  modelEntry = null,
  plateObjectMap,
  componentPathsByObject,
  componentScanner = (_path, data) => streamDetectPaintData(data),
}) {
  const fallback = fallbackPlateObjectMapFor(plateObjectMap, modelEntry);
  const cache = new Map();
  for (const path of uniqueComponentPathsFor(fallback, componentPathsByObject)) {
    const entry = getEntry(entries, path);
    if (!entry) continue;
    cache.set(path, componentScanner(path, entry.data));
  }
  const out = new Map();
  for (const [plateId, objectIds] of fallback) {
    out.set(plateId, objectIds.some((objectId) =>
      (componentPathsByObject.get(objectId) ?? []).some((path) => cache.get(path) === true)));
  }
  return out;
}

/**
 * Scans one component .model once: paint specs (capped) and decoded paint states,
 * with the simple/complex-encoding early exit. Returns ComponentPaintInfo.
 */
export function scanComponentForPaintInfo(bytes) {
  const specs = new Set();
  const allStates = new Set();
  const paintStates = new Set();
  const cap = SPEC_CAP_FOR_COMPLEX_DETECTION;
  streamCollectPaintSpecs(bytes, (spec) => {
    if (specs.size < cap) specs.add(spec);
    const decoded = decodeStates(spec);
    if (decoded.size === 0) {
      if (spec.length > 0) allStates.add(0);
    } else {
      for (const s of decoded) { allStates.add(s); paintStates.add(s); }
    }
    if (specs.size >= cap && allStates.size >= 2) throw EarlyExit;
  });
  return componentPaintInfo({ paintSpecs: specs, allPaintStates: allStates, paintExtruderStates: paintStates });
}

/**
 * Per-plate visual colour pass. Phase 1 scans each UNIQUE component file once
 * (Buzz Lightyear shares components across plates — ~9× less I/O); phase 2
 * aggregates per plate. Returns Map<plateId, PlateVisualInfo>.
 * `componentScanner(path, data) => ComponentPaintInfo` is the test seam.
 */
export function computeVisualColorCountByPlate({
  entries,
  modelEntry = null,
  plateObjectMap,
  componentPathsByObject,
  extruderAssignments,
  componentScanner = (_path, data) => scanComponentForPaintInfo(data),
}) {
  const fallback = fallbackPlateObjectMapFor(plateObjectMap, modelEntry);

  const componentPaintCache = new Map();
  for (const path of uniqueComponentPathsFor(fallback, componentPathsByObject)) {
    const entry = getEntry(entries, path);
    if (!entry) continue;
    componentPaintCache.set(path, componentScanner(path, entry.data));
  }

  const out = new Map();
  for (const [plateId, objectIds] of fallback) {
    const objectExtruderSet = new Set(objectIds.map((id) => extruderAssignments.get(id)).filter((v) => v != null));
    // paintSpecs: distinct spec strings (simple vs complex encoding).
    // paintExtruderStates: non-zero states (hasPaint; visual count for complex
    //   SEMM encodings — painted flippy: 708 specs for 2 states, B81).
    // allPaintStates: incl. 0 — equals paintSpecs.size on simple encodings
    //   (slip-slide: "0C","1C","8").
    const paintSpecs = new Set();
    const paintExtruderStates = new Set();
    const allPaintStates = new Set();
    for (const objectId of objectIds) {
      for (const path of componentPathsByObject.get(objectId) ?? []) {
        const info = componentPaintCache.get(path);
        if (!info) continue;
        for (const s of info.paintSpecs) paintSpecs.add(s);
        for (const s of info.allPaintStates) allPaintStates.add(s);
        for (const s of info.paintExtruderStates) paintExtruderStates.add(s);
      }
    }
    // Simple encoding: state 0 counts as a region when there's one object extruder
    // (slip-slide: 1 object + 3 paint states → 4). Multi-object painted plates take
    // the max instead (colored Benchy: 4 object colours + 4 paint states → 4).
    // Complex encoding: non-zero state count (painted flippy → 1+1 = 2, B81).
    const paintVisualCount = paintSpecs.size === allPaintStates.size ? paintSpecs.size : paintExtruderStates.size;
    const visualColorCount = objectExtruderSet.size <= 1
      ? objectExtruderSet.size + paintVisualCount
      : Math.max(objectExtruderSet.size, paintVisualCount);
    out.set(plateId, plateVisualInfo({
      count: visualColorCount,
      hasPaint: paintExtruderStates.size > 0,
      objectExtruders: objectExtruderSet,
      paintExtruderStates,
    }));
  }
  return out;
}

// ── colour sources ─────────────────────────────────────────────────────────

function detectColorsFromFilamentSequence(bytes, colors) {
  try {
    const json = decodeText(bytes);
    for (const m of json.matchAll(/"color"\s*:\s*"(#[0-9A-Fa-f]{6})"/g)) {
      if (!colors.includes(m[1])) colors.push(m[1]);
    }
  } catch (e) {
    log('w', `Failed to parse filament_sequence.json: ${e?.message}`);
  }
}

/** org.json `optString` on an array element. */
const optString = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Bambu project_settings.config is JSON: filament_colour (per-filament) first,
 * then extruder_colour (per-slot).
 */
function detectColorsFromJsonSettings(bytes, colors) {
  let json;
  try { json = JSON.parse(decodeText(bytes).trim()); } catch { return; }
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return;
  const addFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const m = /#[0-9A-Fa-f]{6,8}/.exec(optString(item));
      if (m) {
        const c = m[0].slice(0, 7);
        if (!colors.includes(c)) colors.push(c);
      }
    }
  };
  addFromArray(json.filament_colour);
  if (colors.length === 0) addFromArray(json.extruder_colour);
}

/**
 * Port of BambuCanonicalList.readFullSpectrumPhysicalCount: the positive
 * `full_spectrum_physical_count` from project_settings.config JSON, else null.
 */
export function readFullSpectrumPhysicalCount(jsonText) {
  let json;
  try { json = JSON.parse(jsonText.trim()); } catch { return null; }
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return null;
  if (!Object.prototype.hasOwnProperty.call(json, 'full_spectrum_physical_count')) return null;
  const v = json.full_spectrum_physical_count;
  let n = toIntOrNull(optString(v).trim());
  if (n == null) {
    // org.json optInt: numbers (or numeric strings) truncated, else 0.
    const d = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v.trim()) : NaN);
    n = Number.isFinite(d) ? Math.trunc(d) : 0;
  }
  return n > 0 ? n : null;
}

/** Kotlin `String.lines()`. */
const ktLines = (s) => s.split(/\r\n|\n|\r/);

/** PrusaSlicer Slic3r_PE.config — `; extruder_colour = #CC0000;#33AAFF`. */
function detectColorsFromSlic3rConfig(bytes, colors) {
  try {
    const content = decodeText(bytes);
    for (const line of ktLines(content)) {
      const stripped = line.replace(/^[; ]+/, '');
      if (stripped.startsWith('extruder_colour') || stripped.startsWith('filament_colour')) {
        const eq = stripped.indexOf('=');
        const value = (eq < 0 ? stripped : stripped.slice(eq + 1)).trim();
        for (const part of value.split(';')) {
          const m = /#[0-9A-Fa-f]{6,8}/.exec(part.trim());
          if (m) {
            const c = m[0].slice(0, 7);
            if (!colors.includes(c)) colors.push(c);
          }
        }
        break;
      }
    }
  } catch (e) {
    log('w', `Failed to parse Slic3r_PE.config: ${e?.message}`);
  }
}

/** True if Slic3r_PE_model.config assigns objects to more than one extruder. */
function detectSlic3rModelAssignments(bytes) {
  try {
    const parser = new XmlPullParser(decodeText(bytes));
    const assigned = new Set();
    while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
      if (parser.getEventType() === XmlPullParser.START_TAG && parser.getName() === 'metadata') {
        const key = parser.getAttributeValue(null, 'key') ?? '';
        const type = parser.getAttributeValue(null, 'type') ?? '';
        const value = parser.getAttributeValue(null, 'value') ?? '';
        if (key === 'extruder' && type === 'object' && !isBlank(value)) assigned.add(value);
      }
      parser.next();
    }
    return assigned.size > 1;
  } catch {
    return false;
  }
}

/** Generic INI (OrcaSlicer config.ini): `filament_colour|extruder_colour = #hex;#hex`. */
function detectColorsFromIniConfig(bytes, colors) {
  try {
    const content = decodeText(bytes);
    for (const match of content.matchAll(/(?:filament_colour|extruder_colour)\s*=\s*(.+)/g)) {
      const valStr = match[1].trim();
      for (const cm of valStr.matchAll(/#[0-9A-Fa-f]{6,8}/g)) {
        const c = cm[0].slice(0, 7);
        if (!colors.includes(c)) colors.push(c);
      }
    }
  } catch (e) {
    log('w', `Failed to parse ini config: ${e?.message}`);
  }
}

// ── model_settings.config ──────────────────────────────────────────────────

/**
 * Parses Bambu model_settings.config into the given output collections
 * (all optional): plateNames Map<int,string>, objectNames Map<string,string>,
 * extruderAssignments Map<string,int>, plateObjectMap Map<int,string[]>,
 * plateFilamentMap Map<int,Set>, plateFilamentSlotsMap Map<int,Set>,
 * allExtruderValues Set, objectPartExtruders Map<string,Set>,
 * compoundPartParents Map<string,string>. Returns the collections object.
 */
export function parseModelSettingsConfig(bytes, out = {}) {
  const {
    plateNames = new Map(), objectNames = new Map(), extruderAssignments = new Map(),
    plateObjectMap = new Map(), plateFilamentMap = new Map(), plateFilamentSlotsMap = new Map(),
    allExtruderValues = null, objectPartExtruders = null, compoundPartParents = null,
  } = out;
  try {
    const parser = new XmlPullParser(typeof bytes === 'string' ? bytes : decodeText(bytes));
    let currentPlateId = null;
    let currentObjectId = null;
    let currentPartId = null;
    let inPlate = false;
    let inModelInstance = false;

    while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
      const ev = parser.getEventType();
      if (ev === XmlPullParser.START_TAG) {
        switch (parser.getName()) {
          case 'plate':
            inPlate = true;
            // Some formats carry plater_id as an attribute; most use nested <metadata>.
            currentPlateId = parser.getAttributeValue(null, 'plater_id') ?? parser.getAttributeValue(null, 'id');
            break;
          case 'model_instance':
            inModelInstance = true;
            break;
          case 'object':
            currentObjectId = parser.getAttributeValue(null, 'id');
            break;
          case 'part': {
            // <part id="N"> inside <object>: compound object component; the part id
            // matches the inlined mesh object id in restructured files.
            currentPartId = parser.getAttributeValue(null, 'id');
            // Sub-plan #2c: part→parent so plate-scoped filters keep parts.
            if (currentPartId != null && currentObjectId != null) compoundPartParents?.set(currentPartId, currentObjectId);
            break;
          }
          case 'metadata': {
            const key = parser.getAttributeValue(null, 'key') ?? '';
            const value = parser.getAttributeValue(null, 'value') ?? '';
            if (key === 'plater_id' && inPlate) {
              currentPlateId = value;
            } else if (key === 'plater_name' && currentPlateId != null) {
              const id = toIntOrNull(currentPlateId);
              if (id != null && !isBlank(value)) plateNames.set(id, value);
            } else if (key === 'filament_maps' && currentPlateId != null) {
              const id = toIntOrNull(currentPlateId);
              if (id != null) {
                // filament_maps = AMS-slot assignment per file-filament position ("1 1").
                // plateFilamentMap: 1-indexed POSITIONS of non-zero entries ("1 1" → {1,2})
                //   for computePlateFileIndices (B120: values instead of positions broke
                //   when filaments shared a slot).
                // plateFilamentSlotsMap: unique non-zero slot VALUES ("1 1" → {1}).
                const tokens = value.trim().split(/\s+/);
                const filamentIndices = new Set();
                tokens.forEach((token, idx) => { if ((toIntOrNull(token) ?? 0) > 0) filamentIndices.add(idx + 1); });
                const filamentSlots = new Set(tokens.map((t) => toIntOrNull(t)).filter((v) => v != null && v > 0));
                if (filamentIndices.size > 0) plateFilamentMap.set(id, filamentIndices);
                if (filamentSlots.size > 0) plateFilamentSlotsMap.set(id, filamentSlots);
              }
            } else if (key === 'object_id' && inModelInstance && currentPlateId != null) {
              const plateId = toIntOrNull(currentPlateId);
              if (plateId != null) {
                if (!plateObjectMap.has(plateId)) plateObjectMap.set(plateId, []);
                plateObjectMap.get(plateId).push(value);
              }
            } else if (key === 'name' && currentObjectId != null && currentPartId == null) {
              objectNames.set(currentObjectId, value);
            } else if (key === 'extruder' && currentObjectId != null) {
              const ext = toIntOrNull(value);
              if (ext != null) {
                if (currentPartId != null) {
                  // Per-part extruder: part id → extruder.
                  extruderAssignments.set(currentPartId, ext);
                } else {
                  // Object-level extruder: max for the object entry.
                  const current = extruderAssignments.get(currentObjectId) ?? 0;
                  if (ext > current) extruderAssignments.set(currentObjectId, ext);
                }
                allExtruderValues?.add(ext);
                // Sub-plan #2c: ALL extruders used by this object incl. per-part
                // (Dragon Scale plate 3: one object, three parts on different extruders).
                if (objectPartExtruders) {
                  if (!objectPartExtruders.has(currentObjectId)) objectPartExtruders.set(currentObjectId, new Set());
                  objectPartExtruders.get(currentObjectId).add(ext);
                }
              }
            }
            break;
          }
          default:
        }
      } else if (ev === XmlPullParser.END_TAG) {
        switch (parser.getName()) {
          case 'plate': currentPlateId = null; inPlate = false; break;
          case 'model_instance': inModelInstance = false; break;
          case 'object': currentObjectId = null; break;
          case 'part': currentPartId = null; break;
          default:
        }
      }
      parser.next();
    }
  } catch (e) {
    log('w', `Failed to parse model_settings.config: ${e?.message}`);
  }
  return {
    plateNames, objectNames, extruderAssignments, plateObjectMap, plateFilamentMap,
    plateFilamentSlotsMap, allExtruderValues, objectPartExtruders, compoundPartParents,
  };
}

/**
 * Plate name priority: Bambu plate name → Bambu object name → model object name
 * (unless the synthetic "Object_N") → "Plate N".
 */
function resolvePlateName(plateId, objectId, plateNames, objectNames, objects) {
  const pn = plateNames.get(plateId);
  if (pn != null && !isBlank(pn)) return pn;
  const on = objectNames.get(objectId);
  if (on != null && !isBlank(on)) return on;
  const obj = objects.find((o) => o.objectId === objectId);
  if (obj && !isBlank(obj.name) && !obj.name.startsWith('Object_')) return obj.name;
  return `Plate ${plateId}`;
}

/**
 * 3MF transform string → 12 float32 values (m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz).
 * Accepts 12 or 16 numbers; identity otherwise.
 */
export function parseTransform(transformStr) {
  if (isBlank(transformStr)) return [...IDENTITY_TRANSFORM];
  const values = transformStr.trim().split(/\s+/).map(toFloatOrNull).filter((v) => v != null).map(Math.fround);
  if (values.length === 12) return values;
  if (values.length === 16) {
    return [values[0], values[1], values[2], values[4], values[5], values[6],
      values[8], values[9], values[10], values[12], values[13], values[14]];
  }
  return [...IDENTITY_TRANSFORM];
}

/** Namespace mirroring the Kotlin `object ThreeMfParser`. */
export const ThreeMfParser = {
  inspectArchiveSizing,
  assessArchiveSizing,
  parse,
  parseForPlateSelection,
  parseMainModelMetadata,
  streamDetectPaintData,
  streamDetectPaintSupports,
  streamCollectPaintSpecs,
  paintCharToState,
  summarizePaintDetection,
  computePaintPresenceByPlate,
  scanComponentForPaintInfo,
  computeVisualColorCountByPlate,
  parseModelSettingsConfig,
  parseTransform,
  plateVisualInfo,
  componentPaintInfo,
  EarlyExit,
};
