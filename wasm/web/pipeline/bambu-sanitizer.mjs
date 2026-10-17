// Port of app/src/main/java/com/u1/slicer/bambu/BambuSanitizer.kt.
//
// Sanitizes Bambu Studio 3MF files for compatibility with the Orca engine:
//  1. Strip incompatible Bambu metadata files
//  2. Clamp Bambu "-1" auto values to safe minimums
//  3. Replace 'nil' strings with first non-nil value in arrays
//  4. Rename PrusaSlicer mmu_segmentation (Bambu paint_color= preserved)
//  5. Recenter packed multi-plate transforms
//  6. Clear stale plater_name values
//
// Files are Uint8Array bytes instead of java.io.File: process / extractPlate /
// restructurePlateFile return new archive bytes (or the input bytes unchanged
// where Kotlin returns the input File). The ">64MB main model" streaming path is
// line-by-line processing of the decoded text with the same per-line semantics as
// the Kotlin BufferedReader loop.
import { readZip, getEntry, decodeText, encodeText, ZipWriter } from './zip.mjs';
import { XmlPullParser } from './xml-pull.mjs';
import { fmtFixed, toIntOrNull, toFloatOrNull } from './kt.mjs';

const MAX_IN_MEMORY_MAIN_MODEL_BYTES = 64 * 1024 * 1024;

// Files to drop entirely
const DROP_FILES = new Set([
  'Metadata/slice_info.config',
  'Metadata/cut_information.xml',
  'Metadata/filament_sequence.json',
  // Preserve layer-change metadata so Hueforge-style previews can infer colors.
  'Metadata/Slic3r_PE.config',
  'Metadata/Slic3r_PE_model.config',
]);

// Preview image prefixes to drop
const DROP_PREFIXES = ['Metadata/plate', 'Metadata/top', 'Metadata/pick'];

// Parameters to clamp to minimum value
const CLAMP_RULES = new Map([
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

// Keys that are NOT per-filament arrays (excluded from normalization)
const NON_FILAMENT_KEYS = new Set(['compatible_printers', 'compatible_prints']);

// Keys with special list semantics (excluded from normalize, but padded)
const SPECIAL_LIST_KEYS = new Set([
  'flush_volumes_matrix', 'flush_volumes_vector', 'different_settings_to_system',
  'inherits_group', 'upward_compatible_machine', 'printable_area', 'bed_exclude_area',
  'thumbnails', 'head_wrap_detect_zone', 'extruder_offset', 'wipe_tower_x', 'wipe_tower_y',
]);

/** Exposed for spec tests (Kotlin keeps these private). */
export const SANITIZER_CONSTANTS = { MAX_IN_MEMORY_MAIN_MODEL_BYTES, DROP_FILES, DROP_PREFIXES, CLAMP_RULES };

// ---- small Kotlin-semantics helpers ----

const IDENTITY = () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** Kotlin `String.toFloatOrNull()` as a float32 value. */
const toF = (s) => {
  const v = toFloatOrNull(s);
  return v == null ? null : Math.fround(v);
};
/** Kotlin `String.isNotBlank()`. */
const isNotBlank = (s) => s.trim().length > 0;
/** Kotlin `String.replace(String, String)`: literal, all occurrences. */
const replaceLit = (s, from, to) => s.split(from).join(to);
/** Kotlin `str.trim().split(Regex("\\s+"))`. */
const splitWs = (s) => s.trim().split(/\s+/);
/** Kotlin `String.lines()`. */
const ktLines = (s) => s.split(/\r\n|\n|\r/);

/**
 * Calls fn(line) for each line of `text`, like BufferedReader.forEachLine:
 * terminators \n, \r and \r\n; no trailing empty line after a final terminator.
 */
function forEachLine(text, fn) {
  const n = text.length;
  let pos = 0;
  let nextN = -2;
  let nextR = -2;
  while (pos < n) {
    if (nextN !== -1 && nextN < pos) nextN = text.indexOf('\n', pos);
    if (nextR !== -1 && nextR < pos) nextR = text.indexOf('\r', pos);
    let end;
    if (nextN === -1 && nextR === -1) end = n;
    else if (nextN === -1) end = nextR;
    else if (nextR === -1) end = nextN;
    else end = Math.min(nextN, nextR);
    fn(text.slice(pos, end));
    if (end >= n) break;
    pos = text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
  }
}

/** ZipWriter that rejects duplicate entry names, like java.util.zip.ZipOutputStream. */
class StrictZipWriter extends ZipWriter {
  #check(name) {
    if (this.has(name)) throw new Error(`duplicate entry: ${name}`);
  }
  stored(name, data) { this.#check(name); super.stored(name, data); }
  deflated(name, data) { this.#check(name); super.deflated(name, data); }
  copy(entry) { this.#check(entry.name); super.copy(entry); }
}
export { StrictZipWriter };

const asBytes = (data) => (typeof data === 'string' ? encodeText(data) : data);

/** writeStored: STORED entry (3MF readers reject DEFLATED). */
function writeStored(zip, name, data) { zip.stored(name, asBytes(data)); }
/** rawCopyZipEntry: copies the entry content, always written STORED. */
function rawCopyZipEntry(zip, entry) { zip.stored(entry.name, entry.data); }

// ---- data model ----
// PartInfo: { faceCount, extruder, meshObjectId = '', subtype = 'normal_part' }
// ObjectParts: { defaultExtruder = 1, parts: PartInfo[] }
const partInfo = (faceCount, extruder, meshObjectId = '', subtype = 'normal_part') =>
  ({ faceCount, extruder, meshObjectId, subtype });
const objectPartsOf = (defaultExtruder = 1, parts = []) => ({ defaultExtruder, parts });
const distinctCount = (arr) => new Set(arr).size;

/**
 * Process a 3MF: if Bambu, sanitize and return the new archive bytes; otherwise
 * return the input bytes unchanged. On failure the input bytes are returned too
 * (Kotlin returns inputFile).
 *
 * `isBambu` is REQUIRED here: Kotlin falls back to ThreeMfParser.parse(inputFile)
 * when it is null; pass `parse(bytes).isBambu` from the parser port instead.
 *
 * @param {Uint8Array} inputBytes
 * @param {{isBambu: boolean, log?: (msg: string) => void}} opts
 * @returns {Uint8Array}
 */
export function process(inputBytes, { isBambu, log } = {}) {
  if (typeof isBambu !== 'boolean') {
    throw new TypeError('BambuSanitizer.process: isBambu is required (use the ThreeMfParser port)');
  }
  const L = log ?? (() => {});
  if (!isBambu) return inputBytes;

  try {
    const entries = readZip(inputBytes);
    const destZip = new StrictZipWriter();
    let projectSettingsContent = null;
    // objectId -> ordered list of (faceCount, extruder) per part
    const bambuObjectParts = new Map();
    let mainModelEntry = null;
    const componentFileNames = [];
    let modelSettingsContent = null;
    let deferredRestructuring = false;
    // True when the main 3dmodel.model was too large to buffer and took the
    // streaming path — which skips compound restructuring, so
    // attachCompoundComponentIds never runs.
    let usedStreamingMainModel = false;
    let isMultiPlate = false;
    let modelRelsContent = null;

    for (const entry of entries) {
      const name = entry.name;
      if (DROP_FILES.has(name)) continue;
      if (DROP_PREFIXES.some((p) => name.startsWith(p))) continue;
      // Model rels: keep/drop decided after restructuring
      if (name.endsWith('.rels') && name.includes('3dmodel.model')) {
        modelRelsContent = entry.data;
        continue;
      }
      if (name.startsWith('Auxiliaries/')) continue;

      if (name === 'Metadata/project_settings.config') {
        projectSettingsContent = entry.data;
      } else if (name === 'Metadata/model_settings.config') {
        parseModelSettingsExtruders(entry.data, bambuObjectParts, L);
        modelSettingsContent = entry.data;
      } else if (name.endsWith('.model')) {
        if (name === '3D/3dmodel.model') mainModelEntry = entry;
        else componentFileNames.push(name);
      } else if (name === '_rels/.rels') {
        const cleanRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
        writeStored(destZip, name, cleanRels);
      } else if (name === '[Content_Types].xml') {
        const cleanTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
        writeStored(destZip, name, cleanTypes);
      } else if (name === 'Metadata/custom_gcode_per_layer.xml') {
        // Keep layer-change metadata for Hueforge-style previews.
        rawCopyZipEntry(destZip, entry);
      } else if (name.startsWith('Metadata/')) {
        // Drop unknown Metadata files (brim_ear_points.txt, filament_settings ...)
      } else {
        rawCopyZipEntry(destZip, entry);
      }
    }

    if (mainModelEntry != null) {
      const mainModelSize = mainModelEntry.size;
      if (mainModelSize > MAX_IN_MEMORY_MAIN_MODEL_BYTES) {
        L(`Main model is too large to buffer (${Math.trunc(mainModelSize / 1_000_000)}MB), using streaming sanitize path`);
        copyMainModelEntry(destZip, mainModelEntry);
        usedStreamingMainModel = true;
      } else {
        const mainModelContent = mainModelEntry.data;
        const mainModelText = decodeText(mainModelContent);
        // Only extruders 1..4 count — BambuStudio uses 5+ for paint colour markers
        // with no physical U1 slot; including them falsely triggers restructuring.
        const hasMultiColorComponents = [...bambuObjectParts.values()].some((o) =>
          distinctCount(o.parts.filter((p) => p.extruder >= 1 && p.extruder <= 4).map((p) => p.extruder)) > 1);
        const totalComponentSize = hasMultiColorComponents
          ? componentFileNames.reduce((s, n) => s + (getEntry(entries, n)?.size ?? 0), 0)
          : 0;
        // Multi-plate: restructuring would inline all plates' meshes into an oversized
        // XML the BBS reader can't handle; defer to per-plate restructuring.
        isMultiPlate = detectMultiPlateFromBuild(mainModelText, L);
        if (isMultiPlate && hasMultiColorComponents) deferredRestructuring = true;
        const safeToInline = !isMultiPlate && totalComponentSize <= 50_000_000;
        const hasModifierVolumes = [...bambuObjectParts.values()].some((o) =>
          o.parts.some((p) => p.subtype !== 'normal_part'));
        const needsComponentParsing = hasMultiColorComponents || hasModifierVolumes;
        const buildTransforms = new Map();
        const objectComponents = new Map();
        if (needsComponentParsing) parseMainModelStructure(mainModelText, objectComponents, buildTransforms, L);
        if (hasMultiColorComponents && !safeToInline) attachCompoundComponentIds(bambuObjectParts, objectComponents);
        // Modifier volumes also need component IDs for OrcaSlicer-format config
        if (hasModifierVolumes && !hasMultiColorComponents) attachCompoundComponentIds(bambuObjectParts, objectComponents);

        const componentFiles = new Map();
        if (hasMultiColorComponents && safeToInline) {
          for (const n of componentFileNames) componentFiles.set(n, getEntry(entries, n)?.data ?? new Uint8Array(0));
        }

        let finalModelBytes;
        let newParentParts;
        if (hasMultiColorComponents && safeToInline) {
          [finalModelBytes, newParentParts] = restructureForMultiColor(
            mainModelContent, bambuObjectParts, componentFiles, objectComponents, buildTransforms, L);
        } else {
          finalModelBytes = convertMmuSegmentation(mainModelContent);
          newParentParts = new Map();
        }

        // Restructured: strip everything incl. p:path; otherwise keep component refs.
        const cleanedModel = hasMultiColorComponents && newParentParts.size > 0
          ? cleanModelXml(finalModelBytes)
          : cleanModelXmlPreserveComponentRefs(finalModelBytes);
        const cleanedModelFinal = stripNonPrintableBuildItems(cleanedModel);
        writeStored(destZip, '3D/3dmodel.model', cleanedModelFinal);

        const wasRestructured = newParentParts.size > 0;
        if (!wasRestructured) {
          for (const path of componentFileNames) {
            const srcEntry = getEntry(entries, path);
            if (!srcEntry) continue;
            rawCopyZipEntry(destZip, srcEntry);
          }
          if (modelRelsContent != null) writeStored(destZip, '3D/_rels/3dmodel.model.rels', modelRelsContent);
        }

        if (newParentParts.size > 0) {
          bambuObjectParts.clear();
          for (const [parentId, parts] of newParentParts) {
            bambuObjectParts.set(parentId, { ...parts, parts: [...parts.parts] });
          }
        }
      }
    }

    // Single-plate files keep a sanitized project_settings.config so the palette
    // survives parse() without Bambu-specific extras.
    if (projectSettingsContent != null && !isMultiPlate) {
      const sanitizedProjectSettings = sanitizeProjectSettings(decodeText(projectSettingsContent));
      writeStored(destZip, 'Metadata/project_settings.config', sanitizedProjectSettings);
    }

    const needsModelConfig = [...bambuObjectParts.values()].some((o) =>
      o.parts.some((p) => p.extruder > 1 || p.subtype !== 'normal_part'));
    if (deferredRestructuring && modelSettingsContent != null) {
      // Multi-plate deferred restructuring: keep model_settings.config so
      // restructurePlateFile() can restructure each plate later.
      writeStored(destZip, 'Metadata/model_settings.config', modelSettingsContent);
    } else if (needsModelConfig) {
      const isCompound = [...bambuObjectParts.values()].some((o) => o.parts.some((p) => p.meshObjectId.length > 0));
      // B137: when the main model was streamed, attachCompoundComponentIds never
      // ran, so isCompound is false. The source model_settings.config already uses
      // Bambu's compound <part> format (ids 1:1 with component objectids), which is
      // what the native reader needs for per-part subtype (negative_part /
      // modifier_part). Preserve it (extruder="0" -> "1", B77) rather than emit
      // firstid/lastid ranges that silently drop subtype.
      const srcModelSettingsStr = modelSettingsContent != null ? decodeText(modelSettingsContent) : null;
      const streamedCompoundSource = usedStreamingMainModel && srcModelSettingsStr != null &&
        srcModelSettingsStr.includes('<part ');
      if (isCompound) {
        writeStored(destZip, 'Metadata/model_settings.config', buildOrcaModelConfig(bambuObjectParts));
      } else if (streamedCompoundSource) {
        const normalized = replaceLit(srcModelSettingsStr, 'key="extruder" value="0"', 'key="extruder" value="1"');
        writeStored(destZip, 'Metadata/model_settings.config', normalized);
      } else {
        writeStored(destZip, 'Metadata/Slic3r_PE_model.config', buildSlic3rModelConfig(bambuObjectParts));
      }
    } else if (modelSettingsContent != null && shouldPreservePerObjectMetadata(modelSettingsContent)) {
      // B77: keep per-object overrides (enable_support, support_type, ...). Bambu
      // uses extruder 0 for "default", which OrcaSlicer's BBS reader rejects.
      const normalized = replaceLit(decodeText(modelSettingsContent),
        'key="extruder" value="0"', 'key="extruder" value="1"');
      writeStored(destZip, 'Metadata/model_settings.config', normalized);
    }
    return destZip.toBytes();
  } catch (e) {
    L(`Sanitization failed: ${e?.message}`);
    return inputBytes;
  }
}

/**
 * For large compound files that keep component refs, keep the referenced component
 * object IDs so Orca-style <part id="..."> assignments can be emitted.
 */
function attachCompoundComponentIds(objectParts, objectComponents) {
  for (const [objectId, objectInfo] of objectParts) {
    const components = objectComponents.get(objectId);
    if (!components) continue;
    if (components.length !== objectInfo.parts.length) continue;
    if (components.some((c) => c.objectId.trim().length === 0)) continue;
    objectParts.set(objectId, {
      ...objectInfo,
      parts: objectInfo.parts.map((part, i) => ({ ...part, meshObjectId: components[i].objectId })),
    });
  }
}

/**
 * Parse Bambu model_settings.config for per-object / per-part extruder assignments
 * (object-level default + per-<part> override), with face counts and subtypes.
 */
function parseModelSettingsExtruders(content, objectParts, L = () => {}) {
  try {
    const parser = new XmlPullParser(typeof content === 'string' ? content : decodeText(content));
    let currentObjectId = null;
    let objectDefaultExtruder = 1;
    let inPart = false;
    let partExtruder = 1;
    let partFaceCount = 0;
    let partSubtype = 'normal_part';
    while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
      const ev = parser.getEventType();
      if (ev === XmlPullParser.START_TAG) {
        switch (parser.getName()) {
          case 'object':
            currentObjectId = parser.getAttributeValue(null, 'id');
            objectDefaultExtruder = 1;
            if (currentObjectId != null && !objectParts.has(currentObjectId)) objectParts.set(currentObjectId, objectPartsOf());
            break;
          case 'part':
            inPart = true;
            partExtruder = objectDefaultExtruder;
            partFaceCount = 0;
            partSubtype = parser.getAttributeValue(null, 'subtype') ?? 'normal_part';
            break;
          case 'metadata': {
            const key = parser.getAttributeValue(null, 'key') ?? '';
            const value = parser.getAttributeValue(null, 'value') ?? '';
            if (key === 'extruder' && isNotBlank(value)) {
              const ext = toIntOrNull(value) ?? 1;
              if (inPart) {
                partExtruder = ext;
              } else if (currentObjectId != null) {
                objectDefaultExtruder = ext;
                const o = objectParts.get(currentObjectId);
                if (o) o.defaultExtruder = ext;
              }
            }
            break;
          }
          case 'mesh_stat':
            if (inPart) partFaceCount = toIntOrNull(parser.getAttributeValue(null, 'face_count')) ?? 0;
            break;
          default:
        }
      } else if (ev === XmlPullParser.END_TAG) {
        switch (parser.getName()) {
          case 'part':
            if (inPart && currentObjectId != null) {
              objectParts.get(currentObjectId)?.parts.push(partInfo(partFaceCount, partExtruder, '', partSubtype));
            }
            inPart = false;
            break;
          case 'object': {
            // No parts: represent the whole object as one entry
            const parts = currentObjectId != null ? objectParts.get(currentObjectId) : undefined;
            if (parts && parts.parts.length === 0) parts.parts.push(partInfo(0, objectDefaultExtruder));
            currentObjectId = null;
            break;
          }
          default:
        }
      }
      parser.next();
    }
  } catch (e) {
    L(`Failed to parse model_settings extruders: ${e?.message}`);
  }
}

const sortedByIntKey = (objectParts) =>
  [...objectParts.entries()].sort((a, b) => (toIntOrNull(a[0]) ?? 0) - (toIntOrNull(b[0]) ?? 0));

/**
 * Build PrusaSlicer Slic3r_PE_model.config: one volume per part (face-count ranges)
 * for multi-colour objects with known face counts, else one whole-object volume.
 */
function buildSlic3rModelConfig(objectParts) {
  let sb = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  for (const [objectId, objectInfo] of sortedByIntKey(objectParts)) {
    const parts = objectInfo.parts;
    if (parts.length === 0) continue;
    const overallExtruder = objectInfo.defaultExtruder;
    sb += `  <object id="${objectId}">\n`;
    sb += `    <metadata type="object" key="extruder" value="${overallExtruder}"/>\n`;
    const isMultiColor = distinctCount(parts.map((p) => p.extruder)) > 1;
    const hasFaceCounts = parts.every((p) => p.faceCount > 0);
    if (isMultiColor && hasFaceCounts) {
      let firstId = 0;
      for (const part of parts) {
        const lastId = firstId + part.faceCount - 1;
        sb += `    <volume firstid="${firstId}" lastid="${lastId}">\n`;
        sb += `      <metadata type="volume" key="extruder" value="${part.extruder}"/>\n`;
        sb += '    </volume>\n';
        firstId += part.faceCount;
      }
    } else {
      const faceCount = parts.reduce((s, p) => s + p.faceCount, 0);
      const lastId = Math.max(0, faceCount - 1);
      sb += `    <volume firstid="0" lastid="${lastId}">\n`;
      sb += `      <metadata type="volume" key="extruder" value="${overallExtruder}"/>\n`;
      sb += '    </volume>\n';
    }
    sb += '  </object>\n';
  }
  sb += '</config>\n';
  return sb;
}

/**
 * Build OrcaSlicer-format model_settings.config for compound objects: <part> entries
 * matched 1:1 to the compound object's <component> elements.
 */
function buildOrcaModelConfig(objectParts) {
  let sb = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  for (const [objectId, objectInfo] of sortedByIntKey(objectParts)) {
    const parts = objectInfo.parts;
    if (parts.length === 0) continue;
    sb += `  <object id="${objectId}">\n`;
    sb += '    <metadata key="name" value=""/>\n';
    sb += `    <metadata key="extruder" value="${objectInfo.defaultExtruder}"/>\n`;
    for (const part of parts) {
      if (part.meshObjectId.length > 0) {
        sb += `    <part id="${part.meshObjectId}" subtype="${part.subtype}">\n`;
        sb += '      <metadata key="name" value=""/>\n';
        sb += `      <metadata key="extruder" value="${part.extruder}"/>\n`;
        sb += '    </part>\n';
      }
    }
    sb += '  </object>\n';
  }
  sb += '</config>\n';
  return sb;
}

// ---- Multi-color restructuring ----
// ComponentRef: { path, objectId, transform: number[12] }

const fmtTransform = (t) => t.map((v) => fmtFixed(Math.fround(v), 9)).join(' ');

/**
 * Restructure compound multi-colour objects into one parent object whose
 * <components> reference inlined mesh objects (B8: the assembly stays ONE object).
 * Returns [new model bytes, Map parentObjectId -> ObjectParts].
 */
function restructureForMultiColor(modelContent, objectParts, componentFiles = new Map(),
  objectComponents = null, buildTransforms = null, L = () => {}) {
  const splitTargets = [...objectParts.entries()].filter(([, o]) => distinctCount(o.parts.map((p) => p.extruder)) > 1);
  const modelStr = typeof modelContent === 'string' ? modelContent : decodeText(modelContent);
  if (splitTargets.length === 0) return [encodeText(convertMmuSegmentationText(modelStr)), new Map()];

  const parsedComponents = new Map();
  const parsedTransforms = new Map();
  if (objectComponents == null || buildTransforms == null) {
    parseMainModelStructure(modelStr, parsedComponents, parsedTransforms, L);
  }
  const finalComponents = objectComponents ?? parsedComponents;
  const finalTransforms = buildTransforms ?? parsedTransforms;
  const newParentParts = new Map();
  let result = modelStr;
  // Small sequential IDs — OrcaSlicer's model config breaks with large IDs
  let nextId = 1;

  for (const [objectId, objectInfo] of splitTargets) {
    const parts = objectInfo.parts;
    const components = finalComponents.get(objectId);
    const buildTransform = finalTransforms.get(objectId);
    if (components == null || buildTransform == null) continue;
    if (components.length !== parts.length) continue;

    let meshObjectDefs = '';
    let componentRefs = '';
    const partInfos = [];
    components.forEach((component, idx) => {
      const meshId = String(nextId++);
      const extruder = parts[idx].extruder;
      const subtype = parts[idx].subtype;
      const objType = subtype === 'normal_part' ? 'model' : 'other';
      const compBytes = componentFiles.get(component.path.replace(/^\/+/, ''));
      const meshXml = compBytes != null ? extractMeshXml(compBytes, component.objectId) : null;
      if (meshXml != null) {
        meshObjectDefs += `  <object id="${meshId}" type="${objType}">\n    ${meshXml}\n  </object>\n`;
        const faceCount = countTriangles(meshXml);
        componentRefs += `      <component objectid="${meshId}" transform="${fmtTransform(component.transform)}"/>\n`;
        partInfos.push(partInfo(faceCount, extruder, meshId, subtype));
      } else {
        // Fallback: p:path component reference (preserves original structure)
        componentRefs += `      <component p:path="${component.path}" objectid="${component.objectId}" transform="${fmtTransform(component.transform)}"/>\n`;
        partInfos.push(partInfo(parts[idx].faceCount, extruder, '', subtype));
      }
    });

    const parentId = String(nextId++);
    const parentObjectDef = `  <object id="${parentId}" type="model">\n    <components>\n${componentRefs}    </components>\n  </object>\n`;
    const buildItem = `    <item objectid="${parentId}" transform="${fmtTransform(buildTransform)}"/>\n`;

    result = removeObjectBlock(result, objectId);
    result = removeBuildItem(result, objectId);
    result = replaceLit(result, '</resources>', `${meshObjectDefs}${parentObjectDef}</resources>`);
    result = replaceLit(result, '</build>', `${buildItem}</build>`);
    newParentParts.set(parentId, objectPartsOf(objectInfo.defaultExtruder, partInfos));
  }
  return [encodeText(convertMmuSegmentationText(result)), newParentParts];
}

/** Count <triangle> elements in a mesh XML string. */
function countTriangles(meshXml) {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = meshXml.indexOf('<triangle', idx);
    if (idx < 0) break;
    count++;
    idx += 9;
  }
  return count;
}

/** Extract the <mesh>...</mesh> block for objectId from a component model file. */
function extractMeshXml(componentContent, objectId) {
  const text = typeof componentContent === 'string' ? componentContent : decodeText(componentContent);
  const objStart = text.indexOf(`<object id="${objectId}"`);
  if (objStart < 0) return null;
  const meshStart = text.indexOf('<mesh', objStart);
  if (meshStart < 0) return null;
  const meshEnd = text.indexOf('</mesh>', meshStart);
  if (meshEnd < 0) return null;
  return text.substring(meshStart, meshEnd + '</mesh>'.length).trim();
}

/** Parse component refs and build item transforms from 3D/3dmodel.model. */
function parseMainModelStructure(content, objectComponents, buildTransforms, L = () => {}) {
  try {
    const parser = new XmlPullParser(typeof content === 'string' ? content : decodeText(content));
    let currentObjectId = null;
    let currentComponents = null;
    let inComponents = false;
    let inBuild = false;
    while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
      const ev = parser.getEventType();
      if (ev === XmlPullParser.START_TAG) {
        switch (parser.getName()) {
          case 'object':
            currentObjectId = parser.getAttributeValue(null, 'id');
            currentComponents = [];
            break;
          case 'components': inComponents = true; break;
          case 'component':
            if (inComponents && currentObjectId != null) {
              const path = parser.getAttributeValue(null, 'p:path') ?? parser.getAttributeValue(null, 'path') ?? '';
              const refId = parser.getAttributeValue(null, 'objectid') ?? '';
              const tStr = parser.getAttributeValue(null, 'transform') ?? '';
              currentComponents?.push({ path, objectId: refId, transform: parseTransformStr(tStr) });
            }
            break;
          case 'build': inBuild = true; break;
          case 'item':
            if (inBuild) {
              const oid = parser.getAttributeValue(null, 'objectid') ?? '';
              buildTransforms.set(oid, parseTransformStr(parser.getAttributeValue(null, 'transform') ?? ''));
            }
            break;
          default:
        }
      } else if (ev === XmlPullParser.END_TAG) {
        switch (parser.getName()) {
          case 'components': inComponents = false; break;
          case 'object':
            if (currentObjectId != null && currentComponents != null && currentComponents.length > 0) {
              objectComponents.set(currentObjectId, currentComponents);
            }
            currentObjectId = null;
            currentComponents = null;
            break;
          case 'build': inBuild = false; break;
          default:
        }
      }
      parser.next();
    }
  } catch (e) {
    L(`Failed to parse main model structure: ${e?.message}`);
  }
}

/** Highest object id integer in a model XML string (unused in Kotlin too). */
export function findMaxObjectId(modelStr) {
  let max = null;
  for (const m of modelStr.matchAll(/<(?:object|item)[^>]+(?:id|objectid)="(\d+)"/g)) {
    const v = toIntOrNull(m[1]);
    if (v != null && (max == null || v > max)) max = v;
  }
  return max ?? 10;
}

/** Remove the <object id="N">...</object> block (nesting-aware). */
function removeObjectBlock(modelStr, objectId) {
  const start = modelStr.indexOf(`<object id="${objectId}"`);
  if (start < 0) return modelStr;
  let depth = 0;
  for (let i = start; i < modelStr.length; i++) {
    if (modelStr.startsWith('<object', i) && i + 7 < modelStr.length &&
      (modelStr[i + 7] === ' ' || modelStr[i + 7] === '>')) depth++;
    if (modelStr.startsWith('</object>', i)) {
      depth--;
      if (depth === 0) return modelStr.substring(0, start) + modelStr.substring(i + '</object>'.length);
    }
  }
  return modelStr;
}

/** Remove the <item objectid="N" .../> build item. */
function removeBuildItem(modelStr, objectId) {
  return modelStr.replace(new RegExp(`[ \\t]*<item[^>]*objectid="${objectId}"[^>]*/>\\r?\\n?`, 'g'), '');
}

/** Combine two 3MF affine transforms: assembly * component (unused in Kotlin too). */
export function combineTransforms(assembly, component) {
  const f = Math.fround;
  const a = assembly.length === 12 ? assembly : IDENTITY();
  const c = component.length === 12 ? component : IDENTITY();
  const r = new Array(9);
  for (let row = 0; row <= 2; row++) {
    for (let col = 0; col <= 2; col++) {
      r[row * 3 + col] = f(f(f(f(a[row * 3] * c[col]) + f(a[row * 3 + 1] * c[3 + col])) + f(a[row * 3 + 2] * c[6 + col])));
    }
  }
  const tx = f(f(f(f(a[0] * c[9]) + f(a[1] * c[10])) + f(a[2] * c[11])) + a[9]);
  const ty = f(f(f(f(a[3] * c[9]) + f(a[4] * c[10])) + f(a[5] * c[11])) + a[10]);
  const tz = f(f(f(f(a[6] * c[9]) + f(a[7] * c[10])) + f(a[8] * c[11])) + a[11]);
  return [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], tx, ty, tz];
}

/** Parse a 3MF transform string into 12 floats, or identity if blank/invalid. */
function parseTransformStr(str) {
  if (str.trim().length === 0) return IDENTITY();
  const v = splitWs(str).map(toF).filter((x) => x != null);
  return v.length === 12 ? v : IDENTITY();
}

/**
 * Sanitize project_settings.config. JSON (newer Bambu) passes through unchanged;
 * INI gets the full sanitization pass.
 */
function sanitizeProjectSettings(content) {
  if (content.trimStart().startsWith('{')) return content;
  const config = parseIniConfig(content);
  for (const [key, minVal] of CLAMP_RULES) clampParameter(config, key, minVal);
  sanitizeNilValues(config);
  const extruderCount = detectExtruderCount(config);
  if (extruderCount > 1) normalizePerFilamentArrays(config, extruderCount);
  stripBambuGcode(config);
  sanitizeWipeTowerPosition(config);
  return serializeIniConfig(config);
}

// B77: keys that meaningfully change slice output when set per-object. Kept narrow:
// passing model_settings.config through re-introduces stale object ids (e.g.
// colored_3DBenchy (1).3mf has ironing_type on a stripped printable="0" object).
const PER_OBJECT_OVERRIDE_KEYS = [
  'enable_support', 'support_type', 'support_threshold_angle',
  'support_on_build_plate_only', 'support_remove_small_overhang',
  'support_filament', 'support_interface_filament', 'support_angle',
  'layer_height', 'first_layer_height', 'adaptive_layer_height',
  'wall_loops', 'sparse_infill_density', 'sparse_infill_pattern',
  'top_shell_layers', 'bottom_shell_layers',
];

/** B77: true when the source model_settings.config carries a per-object override worth preserving. */
export function shouldPreservePerObjectMetadata(content) {
  const text = typeof content === 'string' ? content : decodeText(content);
  return PER_OBJECT_OVERRIDE_KEYS.some((key) => text.includes(`key="${key}"`));
}

/**
 * Sanitize model_settings.config XML: clear stale plater_name values and clamp
 * packed (>370mm) assemble_item transforms to bed centre. Bytes in, bytes out
 * (a string input returns a string).
 */
export function sanitizeModelSettings(content) {
  let text = typeof content === 'string' ? content : decodeText(content);
  // Clear plater_name to prevent OrcaSlicer/PrusaSlicer segfaults
  text = text.replace(/(key="plater_name"\s+value=")([^"]*)"/g, '$1"');
  const bedCenter = Math.fround(135); // 270mm / 2
  const packedThreshold = Math.fround(bedCenter * 2 + 100); // 370mm
  text = text.replace(/(<assemble_item[^>]*\btransform=")([\d\s.eE+-]+)(")/g, (match, prefix, transformStr, suffix) => {
    const vals = splitWs(transformStr).map(toF).filter((x) => x != null);
    if (vals.length >= 12) {
      const tx = vals[9];
      const ty = vals[10];
      if (Math.abs(tx) > packedThreshold || Math.abs(ty) > packedThreshold) {
        const newVals = [...vals];
        newVals[9] = bedCenter;
        newVals[10] = bedCenter;
        newVals[11] = 0;
        return prefix + newVals.map((v) => fmtFixed(v, 6)).join(' ') + suffix;
      }
    }
    return match;
  });
  return typeof content === 'string' ? text : encodeText(text);
}

/**
 * Rename PrusaSlicer slic3rpe:mmu_segmentation -> paint_color (same RLE hex
 * encoding) so Orca's multi_material_segmentation_by_painting() processes it.
 * Bytes in, bytes out; the input bytes are returned untouched when absent.
 */
function convertMmuSegmentation(content) {
  if (typeof content === 'string') return convertMmuSegmentationText(content);
  const needle = encodeText('slic3rpe:mmu_segmentation');
  if (content.length < needle.length) return content;
  let found = false;
  outer: for (let i = 0; i <= content.length - needle.length; i++) {
    if (content[i] === needle[0]) {
      for (let j = 1; j < needle.length; j++) if (content[i + j] !== needle[j]) continue outer;
      found = true;
      break;
    }
  }
  if (!found) return content;
  return encodeText(convertMmuSegmentationText(decodeText(content)));
}

function convertMmuSegmentationText(text) {
  if (!text.includes('slic3rpe:mmu_segmentation')) return text;
  let newText = replaceLit(text, 'slic3rpe:mmu_segmentation=', 'paint_color=');
  newText = newText.replace(/\s+xmlns:slic3rpe="[^"]*"/g, '');
  return newText;
}

// ---- Multi-plate detection ----

/**
 * True if the model's <build> items (from the 2nd one) carry virtual-position
 * transforms (TX>270, TY<-10 or TY>270) or p:object_id plate markers.
 */
function detectMultiPlateFromBuild(modelContent, L = () => {}) {
  try {
    const parser = new XmlPullParser(typeof modelContent === 'string' ? modelContent : decodeText(modelContent));
    let inBuild = false;
    let buildItemCount = 0;
    while (parser.getEventType() !== XmlPullParser.END_DOCUMENT) {
      const ev = parser.getEventType();
      if (ev === XmlPullParser.START_TAG) {
        const name = parser.getName();
        if (name === 'build') inBuild = true;
        else if (name === 'item' && inBuild) {
          buildItemCount++;
          if (buildItemCount > 1) {
            const pObj = parser.getAttributeValue(null, 'p:object_id');
            if (pObj != null && isNotBlank(pObj)) return true;
            const tAttr = parser.getAttributeValue(null, 'transform');
            const parts = tAttr != null ? splitWs(tAttr) : [];
            const tx = (parts[9] != null ? toF(parts[9]) : null) ?? 0;
            const ty = (parts[10] != null ? toF(parts[10]) : null) ?? 0;
            if (tx > 270 || ty < -10 || ty > 270) return true;
          }
        }
      } else if (ev === XmlPullParser.END_TAG) {
        if (parser.getName() === 'build') inBuild = false;
      }
      parser.next();
    }
    return false;
  } catch (e) {
    L(`Failed to detect multi-plate build layout: ${e?.message}`);
    return false;
  }
}

// ---- Model XML cleanup ----

const METADATA_RE_SRC = '[ \\t]*<metadata name="[^"]*"(?:>[^<]*</metadata>|[^/]*/>) *\\r?\\n?';

function cleanModelXml(content) {
  let text = typeof content === 'string' ? content : decodeText(content);
  text = text.replace(/\s+requiredextensions="[^"]*"/g, '');
  text = text.replace(/\s+xmlns:p="[^"]*"/g, '');
  text = text.replace(/\s+p:UUID="[^"]*"/g, '');
  text = text.replace(/\s+p:path="[^"]*"/g, '');
  text = text.replace(/\s+xmlns:BambuStudio="[^"]*"/g, '');
  text = text.replace(new RegExp(METADATA_RE_SRC, 'g'), '');
  text = replaceLit(text, 'type="other"', 'type="model"');
  if (text.includes('slic3rpe:mmu_segmentation')) {
    text = replaceLit(text, 'slic3rpe:mmu_segmentation=', 'paint_color=');
    text = text.replace(/\s+xmlns:slic3rpe="[^"]*"/g, '');
  }
  return encodeText(text);
}

function cleanModelXmlPreserveComponentRefs(content) {
  let text = typeof content === 'string' ? content : decodeText(content);
  text = text.replace(/\s+requiredextensions="[^"]*"/g, '');
  text = text.replace(/\s+p:UUID="[^"]*"/g, '');
  text = text.replace(/\s+xmlns:BambuStudio="[^"]*"/g, '');
  text = text.replace(new RegExp(METADATA_RE_SRC, 'g'), '');
  text = replaceLit(text, 'type="other"', 'type="model"');
  return encodeText(text);
}

// ---- INI config helpers (public accessors for ProfileEmbedder) ----

export const parseIniConfigPublic = (content) => parseIniConfig(content);
export const sanitizeModelSettingsPublic = (content) => sanitizeModelSettings(content);

/**
 * Parse a Bambu/OrcaSlicer INI project_settings.config into an ordered object:
 * semicolon-separated values become string arrays, everything else a string.
 */
function parseIniConfig(content) {
  const config = {};
  for (const line of ktLines(content)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    config[key] = value.includes(';') ? value.split(';').map((s) => s.trim()) : value;
  }
  return config;
}

function serializeIniConfig(config) {
  let sb = '';
  for (const [key, value] of Object.entries(config)) {
    sb += Array.isArray(value) ? `${key} = ${value.join(';')}\n` : `${key} = ${value}\n`;
  }
  return sb;
}

function clampParameter(config, key, minimum) {
  const raw = config[key];
  if (raw == null) return;
  let str;
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw[0] == null) return;
    str = String(raw[0]);
  } else str = String(raw);
  const numeric = toF(str.trim());
  if (numeric == null) return;
  if (numeric < minimum) {
    // Kotlin writes whole-number minimums as Int strings ("0", "1"); all rules are whole.
    config[key] = String(minimum);
  }
}

/** Replace 'nil' list elements with the first non-nil one; drop all-nil keys. */
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

/** Pad short per-filament arrays with the last element; truncate long ones. */
function normalizePerFilamentArrays(config, targetCount) {
  for (const [key, list] of Object.entries(config)) {
    if (NON_FILAMENT_KEYS.has(key) || SPECIAL_LIST_KEYS.has(key)) continue;
    if (!Array.isArray(list) || list.length === 0) continue;
    if (list.length < targetCount) {
      const last = list[list.length - 1];
      while (list.length < targetCount) list.push(last);
    } else if (list.length > targetCount) {
      list.length = targetCount;
    }
  }
  normalizeFlushMatrix(config, targetCount);
}

function normalizeFlushMatrix(config, targetCount) {
  const list = config.flush_volumes_matrix;
  if (Array.isArray(list)) {
    const needed = targetCount * targetCount;
    const last = list.length > 0 ? list[list.length - 1] : '0';
    while (list.length < needed) list.push(last);
    if (list.length > needed) list.length = needed;
  }
}

function detectExtruderCount(config) {
  const colors = config.filament_colour;
  if (Array.isArray(colors) && colors.length > 1) return colors.length;
  const extColors = config.extruder_colour;
  if (Array.isArray(extColors) && extColors.length > 1) return extColors.length;
  return 1;
}

function stripBambuGcode(config) {
  delete config.time_lapse_gcode;
  delete config.machine_pause_gcode;
  const fsg = config.filament_start_gcode;
  if (Array.isArray(fsg) && fsg.some((it) => String(it).includes('M142') || String(it).includes('air_filtration'))) {
    delete config.filament_start_gcode;
  }
}

/** Clamp wipe tower position to stay within the 270mm bed. */
function sanitizeWipeTowerPosition(config, bedSize = 270, extraMargin = 6) {
  const f = Math.fround;
  const towerWidth = getNumeric(config, 'prime_tower_width', 35);
  const towerBrim = Math.max(0, getNumeric(config, 'prime_tower_brim_width', 3));
  const halfSpan = Math.max(12, f(f(f(towerWidth / 2) + towerBrim) + extraMargin));
  const minPos = halfSpan;
  const maxPos = Math.max(minPos, f(bedSize - halfSpan));
  clampScalarPosition(config, 'wipe_tower_x', minPos, maxPos);
  clampScalarPosition(config, 'wipe_tower_y', minPos, maxPos);
}

const coerceIn = (v, min, max) => (v < min ? min : v > max ? max : v);

/**
 * b39: list values (per-extruder wipe_tower_x/y) are clamped element-wise and the
 * list is replaced by a new one; scalars become "%.3f" strings when clamped.
 */
export function clampScalarPosition(config, key, min, max) {
  const raw = config[key];
  if (raw == null) return;
  if (Array.isArray(raw)) {
    config[key] = raw.map((element) => {
      const v = element == null ? null : toF(String(element));
      if (v == null) return element;
      return v < min || v > max ? fmtFixed(coerceIn(v, min, max), 3) : element;
    });
    return;
  }
  const value = toF(String(raw));
  if (value == null) return;
  if (value < min || value > max) config[key] = fmtFixed(coerceIn(value, min, max), 3);
}

function getNumeric(config, key, def) {
  const raw = config[key];
  if (raw == null) return def;
  if (Array.isArray(raw)) return (raw.length > 0 && raw[0] != null ? toF(String(raw[0])) : null) ?? def;
  return toF(String(raw)) ?? def;
}

// ---- Streaming entry cleaners ----

const P_UUID_RE = /\s+p:UUID="[^"]*"/g;
const REQ_EXT_RE = /\s+requiredextensions="[^"]*"/g;
const BAMBU_NS_RE = /\s+xmlns:BambuStudio="[^"]*"/g;
const SLIC3RPE_NS_RE = /\s+xmlns:slic3rpe="[^"]*"/g;
const METADATA_RE = new RegExp(METADATA_RE_SRC, 'g');

const needsSlowClean = (line) => line.includes('p:UUID') || line.includes('requiredextensions') ||
  line.includes('xmlns:BambuStudio') || line.includes('xmlns:slic3rpe') ||
  line.includes('<metadata') || line.includes('mmu_segmentation') || line.includes('type="other"');

function slowCleanLine(line) {
  let cleaned = line.replace(P_UUID_RE, '');
  cleaned = cleaned.replace(REQ_EXT_RE, '');
  cleaned = cleaned.replace(BAMBU_NS_RE, '');
  cleaned = cleaned.replace(SLIC3RPE_NS_RE, '');
  cleaned = cleaned.replace(METADATA_RE, '');
  // Rename (not delete) PrusaSlicer SEMM paint — parity with convertMmuSegmentation.
  cleaned = replaceLit(cleaned, 'slic3rpe:mmu_segmentation=', 'paint_color=');
  cleaned = replaceLit(cleaned, 'type="other"', 'type="model"');
  return cleaned;
}

/**
 * Line-by-line clean of a component .model entry (unused by process() in Kotlin
 * too, which raw-copies components). Returns the cleaned bytes.
 */
export function copyZipEntry(entry) {
  const out = [];
  forEachLine(decodeText(entry.data), (line) => {
    if (!needsSlowClean(line)) {
      if (isNotBlank(line)) out.push(line, '\n');
      return;
    }
    const cleaned = slowCleanLine(line);
    if (isNotBlank(cleaned)) out.push(cleaned, '\n');
  });
  return encodeText(out.join(''));
}

/**
 * Streaming clean of a >64MB main 3D/3dmodel.model: same line cleanup as
 * copyZipEntry, keeps p:path, and drops lines containing printable="0".
 * Output lines are '\n'-terminated; blank lines are dropped (BufferedReader loop).
 */
function copyMainModelEntry(destZip, srcEntry) {
  const out = [];
  forEachLine(decodeText(srcEntry.data), (line) => {
    if (!needsSlowClean(line)) {
      if (isNotBlank(line)) {
        if (line.includes('printable="0"')) return;
        out.push(line, '\n');
      }
      return;
    }
    const cleaned = slowCleanLine(line);
    if (cleaned.includes('printable="0"')) return;
    if (isNotBlank(cleaned)) out.push(cleaned, '\n');
  });
  writeStored(destZip, srcEntry.name, encodeText(out.join('')));
}

/**
 * @deprecated Retired from production in sub-plan #2d — ProfileEmbedder.embed(plateId)
 * performs the equivalent strip pipeline in one pass. Kept for disk-artefact tests.
 *
 * Extract one plate: filter <build> to the plate's items, strip unreferenced
 * resources and config objects, filter custom_gcode_per_layer.xml.
 *
 * @param {Uint8Array} inputBytes
 * @param {number} targetPlateId 1-based
 * @param {{hasPlateJsons?: boolean|null, plateObjectIds?: Iterable<string>|null,
 *          objectExtruderMap?: Map<string,number>|Object|null}} [opts]
 * @returns {Uint8Array}
 */
export function extractPlate(inputBytes, targetPlateId,
  { hasPlateJsons = null, plateObjectIds = null, objectExtruderMap = null } = {}) {
  const entries = readZip(inputBytes);
  const actualHasPlateJsons = hasPlateJsons ?? entries.some((e) => /^Metadata\/plate_\d+\.json$/.test(e.name));

  let effectivePlateObjectIds;
  if (plateObjectIds != null) {
    effectivePlateObjectIds = new Set(plateObjectIds);
  } else {
    const map = new Map();
    const msEntry = getEntry(entries, 'Metadata/model_settings.config');
    if (msEntry) parseModelSettingsPlateObjects(msEntry.data, map);
    const ids = map.get(targetPlateId);
    effectivePlateObjectIds = ids ? new Set(ids) : null;
  }

  let referencedObjectIds = null;
  let wroteModelSettings = false;
  const destZip = new StrictZipWriter();
  for (const entry of entries) {
    const content = entry.data;
    if (entry.name === '3D/3dmodel.model') {
      const filtered = filterModelToPlate(decodeText(content), targetPlateId, actualHasPlateJsons, effectivePlateObjectIds);
      const [stripped, refIds] = stripUnreferencedResources(filtered);
      referencedObjectIds = refIds;
      writeStored(destZip, entry.name, stripped);
    } else if (entry.name.endsWith('.model') && entry.name !== '3D/3dmodel.model') {
      writeStored(destZip, entry.name, content);
    } else if (entry.name === 'Metadata/model_settings.config') {
      wroteModelSettings = true;
      let stripped = stripAssembleSection(decodeText(content));
      if (referencedObjectIds != null) stripped = stripUnreferencedConfigObjects(stripped, referencedObjectIds);
      writeStored(destZip, entry.name, stripped);
    } else if (entry.name === 'Metadata/Slic3r_PE_model.config') {
      let text = decodeText(content);
      if (referencedObjectIds != null) text = stripUnreferencedConfigObjects(text, referencedObjectIds);
      writeStored(destZip, entry.name, text);
    } else if (entry.name === 'Metadata/custom_gcode_per_layer.xml') {
      const filtered = filterCustomGcodePerLayer(decodeText(content), targetPlateId);
      if (isNotBlank(filtered)) writeStored(destZip, entry.name, filtered);
    } else {
      writeStored(destZip, entry.name, content);
    }
  }

  if (!wroteModelSettings && objectExtruderMap != null) {
    const pairs = objectExtruderMap instanceof Map ? [...objectExtruderMap.entries()] : Object.entries(objectExtruderMap);
    // toSortedMap(compareBy { it.toIntOrNull() ?: Int.MAX_VALUE }): keys that compare
    // equal collapse into one entry (first key kept, last value wins), like a TreeMap.
    const rank = (k) => toIntOrNull(k) ?? 2147483647;
    const sorted = [];
    for (const [k, v] of pairs) {
      if (referencedObjectIds != null && !referencedObjectIds.has(k)) continue;
      if (!(v > 0)) continue;
      const existing = sorted.find((e) => rank(e[0]) === rank(k));
      if (existing) existing[1] = v;
      else sorted.push([k, v]);
    }
    sorted.sort((a, b) => rank(a[0]) - rank(b[0]));
    if (sorted.length > 0) writeStored(destZip, 'Metadata/model_settings.config', buildSyntheticModelConfig(sorted));
  }
  return destZip.toBytes();
}

/**
 * Keep only the target plate's <plate> block (plate_info id renumbered to 1).
 * Fail-closed (sub-plan #2c P2): returns "" when the plate is absent.
 */
export function filterCustomGcodePerLayer(xml, targetPlateId) {
  const header = '<?xml version="1.0" encoding="utf-8"?>';
  const plateInfoIdSrc = '<plate_info\\b[^>]*\\bid="(\\d+)"';
  const plateInfoIdRegex = new RegExp(plateInfoIdSrc);
  let selectedBlock = null;
  for (const m of xml.matchAll(/<plate>[\s\S]*?<\/plate>/g)) {
    const id = plateInfoIdRegex.exec(m[0])?.[1];
    if (id != null && toIntOrNull(id) === targetPlateId) { selectedBlock = m[0]; break; }
  }
  if (selectedBlock == null) return '';
  const renumberedBlock = selectedBlock.replace(new RegExp(plateInfoIdSrc, 'g'),
    (match) => match.replace(/id="\d+"/g, 'id="1"'));
  return `${header}\n<custom_gcodes_per_layer>\n${renumberedBlock}\n</custom_gcodes_per_layer>\n`;
}

function buildSyntheticModelConfig(pairs) {
  let sb = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  for (const [objectId, extruder] of pairs) {
    sb += `  <object id="${objectId}">\n    <metadata key="extruder" value="${extruder}"/>\n  </object>\n`;
  }
  return `${sb}</config>\n`;
}

/**
 * @deprecated Retired from production in sub-plan #2d (the native BBS importer does
 * per-volume extruder assignment from model_settings.config). Kept for tests.
 *
 * Inline a plate file's compound multi-colour meshes. Returns the input bytes when
 * no restructuring applies.
 * @param {Uint8Array} plateBytes
 * @returns {Uint8Array}
 */
export function restructurePlateFile(plateBytes) {
  const entries = readZip(plateBytes);
  const bambuObjectParts = new Map();
  const modelSettingsEntry = getEntry(entries, 'Metadata/model_settings.config');
  if (modelSettingsEntry) parseModelSettingsExtruders(modelSettingsEntry.data, bambuObjectParts);

  const hasMultiColorComponents = [...bambuObjectParts.values()].some((o) =>
    distinctCount(o.parts.filter((p) => p.extruder >= 1 && p.extruder <= 4).map((p) => p.extruder)) > 1);
  if (!hasMultiColorComponents) return plateBytes;

  const mainModelEntry = getEntry(entries, '3D/3dmodel.model');
  if (!mainModelEntry) return plateBytes;
  // Clean BEFORE restructuring (small wrapper XML); keep p:path, which
  // restructureForMultiColor needs to locate component meshes.
  const mainModelContent = cleanModelXmlPreserveComponentRefs(mainModelEntry.data);

  const componentFileNames = entries
    .filter((e) => e.name.endsWith('.model') && e.name !== '3D/3dmodel.model')
    .map((e) => e.name);
  const componentFiles = new Map(componentFileNames.map((n) => [n, getEntry(entries, n)?.data ?? new Uint8Array(0)]));

  const [restructuredModel, newParentParts] = restructureForMultiColor(mainModelContent, bambuObjectParts, componentFiles);
  if (newParentParts.size === 0) return plateBytes;

  bambuObjectParts.clear();
  for (const [parentId, parts] of newParentParts) bambuObjectParts.set(parentId, { ...parts, parts: [...parts.parts] });

  const cleanedModelFinal = stripNonPrintableBuildItems(restructuredModel);
  const destZip = new StrictZipWriter();
  writeStored(destZip, '3D/3dmodel.model', cleanedModelFinal);
  writeStored(destZip, 'Metadata/model_settings.config', buildOrcaModelConfig(bambuObjectParts));
  for (const entry of entries) {
    const n = entry.name;
    if (n === '3D/3dmodel.model') continue;
    if (n.endsWith('.model')) continue;
    if (n.endsWith('.rels') && n.includes('3dmodel.model')) continue;
    if (n === 'Metadata/model_settings.config') continue;
    if (n === 'Metadata/Slic3r_PE_model.config') continue;
    rawCopyZipEntry(destZip, entry);
  }
  return destZip.toBytes();
}

/**
 * Strip <resources> <object> blocks not (transitively, via component refs)
 * referenced by any <build> item. Returns [xml, Set of referenced ids | null]
 * (null when nothing needed stripping).
 */
export function stripUnreferencedResources(xml) {
  const buildMatch = /<build\b[^>]*>(.*?)<\/build>/s.exec(xml);
  if (!buildMatch) return [xml, null];
  const buildItemIds = new Set([...buildMatch[1].matchAll(/objectid="(\d+)"/g)].map((m) => m[1]));
  if (buildItemIds.size === 0) return [xml, null];

  const allReferencedIds = new Set(buildItemIds);
  const objectBlocks = [...xml.matchAll(/<object\s+id="(\d+)"[^>]*>[\s\S]*?<\/object>/g)];
  const queue = [...buildItemIds];
  while (queue.length > 0) {
    const id = queue.shift();
    const block = objectBlocks.find((b) => b[1] === id);
    if (!block) continue;
    for (const ref of [...block[0].matchAll(/<component[^>]*\bobjectid="(\d+)"[^>]*>/g)].map((m) => m[1])) {
      if (!allReferencedIds.has(ref)) { allReferencedIds.add(ref); queue.push(ref); }
    }
  }
  const unreferenced = new Set(objectBlocks.map((b) => b[1]).filter((id) => !allReferencedIds.has(id)));
  if (unreferenced.size === 0) return [xml, null];

  let result = xml;
  for (const block of objectBlocks) {
    if (unreferenced.has(block[1])) result = replaceLit(result, block[0], '');
  }
  result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
  return [result, allReferencedIds];
}

/** Strip config <object> entries whose id is not in referencedIds (Set or iterable). */
export function stripUnreferencedConfigObjects(xml, referencedIds) {
  const ids = referencedIds instanceof Set ? referencedIds : new Set(referencedIds);
  return xml.replace(/[ \t]*<object\s+id="(\d+)"[^>]*>[\s\S]*?<\/object>[ \t]*\r?\n?/g,
    (match, id) => (ids.has(id) ? match : ''));
}

/**
 * Remove the <assemble>...</assemble> block: assemble_items for objects absent
 * from <build> make OrcaSlicer's _handle_start_assemble_item fail the load.
 */
export function stripAssembleSection(xml) {
  return xml.replace(/[ \t]*<assemble>.*?<\/assemble>[ \t]*\r?\n?/gs, '');
}

/**
 * Remove printable="0" build items (scene references that must not be sliced).
 * Only <build> is rewritten. String in -> string out; bytes in -> bytes out.
 */
export function stripNonPrintableBuildItems(xml) {
  if (typeof xml === 'string') return stripNonPrintableBuildItemsImpl(xml);
  return encodeText(stripNonPrintableBuildItemsImpl(decodeText(xml)));
}

function stripNonPrintableBuildItemsImpl(xml) {
  return xml.replace(/(<build\b[^>]*>)(.*?)(<\/build>)/gs, (whole, open, body, close) => {
    const allItems = [...body.matchAll(/<item\b[^>]*(?:\/>|>.*?<\/item>)/gs)].map((m) => m[0]);
    const printable = allItems.filter((it) => !it.includes('printable="0"'));
    if (printable.length === allItems.length) return whole;
    // Guard: an empty <build> makes OrcaSlicer silently load nothing.
    if (printable.length === 0) return whole;
    const newBody = `\n${printable.map((it) => `  ${it}`).join('\n')}\n  `;
    return `${open}${newBody}${close}`;
  });
}

/**
 * Rewrite <build> to contain only targetPlateId's items (<resources> untouched).
 * Priority 1: plateObjectIds from model_settings.config; 2: p:object_id (0-based);
 * 3: position-based (N-th item, re-centred) when items sit at virtual positions.
 * `hasPlateJsons` = newer format (each plate independently loadable).
 */
export function filterModelToPlate(xml, targetPlateId, hasPlateJsons = true, plateObjectIds = null) {
  const targetPlateIndex = targetPlateId - 1; // p:object_id is 0-based
  const ids = plateObjectIds == null ? null : plateObjectIds instanceof Set ? plateObjectIds : new Set(plateObjectIds);
  const objectIdRegex = /objectid="(\d+)"/;
  const plateIdRegex = /p:object_id="(\d+)"/;

  return xml.replace(/(<build\b[^>]*>)(.*?)(<\/build>)/gs, (whole, open, body, close) => {
    const allItems = [...body.matchAll(/<item\b[^>]*(?:\/>|>.*?<\/item>)/gs)].map((m) => m[0]);

    if (ids != null && ids.size > 0) {
      const targetItems = allItems.filter((item) => ids.has(objectIdRegex.exec(item)?.[1] ?? ''));
      if (targetItems.length === 0) return whole;
      // Group re-centre preserves the plate's layout.
      const recentered = recenterGroupIfVirtual(targetItems);
      return `${open}\n${recentered.map((it) => `    ${it}`).join('\n')}\n  ${close}`;
    }

    if (allItems.some((it) => plateIdRegex.test(it))) {
      const targetItems = allItems.filter((item) => {
        const p = plateIdRegex.exec(item)?.[1];
        return ((p != null ? toIntOrNull(p) : null) ?? 0) === targetPlateIndex;
      });
      if (targetItems.length === 0) return whole;
      const recentered = recenterGroupIfVirtual(targetItems);
      return `${open}\n${recentered.map((it) => `    ${it}`).join('\n')}\n  ${close}`;
    }

    const hasVirtualPositions = allItems.some((item) => {
      const [tx, ty] = itemTxTy(item);
      return tx > 270 || ty < -10 || ty > 270;
    });
    if (allItems.length <= 1 || (!hasPlateJsons && !hasVirtualPositions)) return whole;
    if (hasVirtualPositions) {
      const idx = coerceIn(targetPlateIndex, 0, allItems.length - 1);
      const selected = recenterItemXY(allItems[idx]);
      return `${open}\n    ${selected}\n  ${close}`;
    }
    return whole;
  });
}

/** [tx, ty] float32 from an item's transform attribute (0 when absent/invalid). */
function itemTxTy(item) {
  const t = /transform="([^"]+)"/.exec(item)?.[1];
  const parts = t != null ? splitWs(t) : [];
  return [(parts[9] != null ? toF(parts[9]) : null) ?? 0, (parts[10] != null ? toF(parts[10]) : null) ?? 0];
}

/** plate id -> object ids from model_settings.config <plate> blocks. */
function parseModelSettingsPlateObjects(configBytes, plateObjectMap) {
  try {
    const config = typeof configBytes === 'string' ? configBytes : decodeText(configBytes);
    const platerIdRegex = /<metadata\s+key="plater_id"\s+value="(\d+)"/;
    const objIdRegex = /<metadata\s+key="object_id"\s+value="(\d+)"/;
    for (const plate of config.matchAll(/<plate\b[^>]*>.*?<\/plate>/gs)) {
      const pid = platerIdRegex.exec(plate[0])?.[1];
      const plateId = pid != null ? toIntOrNull(pid) : null;
      if (plateId == null) continue;
      const objIds = [...plate[0].matchAll(/<model_instance>.*?<\/model_instance>/gs)]
        .map((inst) => objIdRegex.exec(inst[0])?.[1])
        .filter((x) => x != null);
      if (objIds.length > 0) plateObjectMap.set(plateId, objIds);
    }
  } catch {
    // Kotlin logs and continues
  }
}

/**
 * When any item sits at a virtual position (outside the 270 mm bed), shift ALL
 * items by one XY offset so the group's bbox centre lands at (135, 135).
 */
function recenterGroupIfVirtual(items) {
  if (items.length === 0) return items;
  const f = Math.fround;
  const positions = items.map(itemTxTy);
  if (!positions.some(([tx, ty]) => tx > 270 || ty < -10 || ty > 270)) return items;
  const xs = positions.map((p) => p[0]);
  const ys = positions.map((p) => p[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const offsetX = f(135 - f(f(minX + maxX) / 2));
  const offsetY = f(135 - f(f(minY + maxY) / 2));
  return items.map((item) => item.replace(/transform="([^"]+)"/g, (match, t) => {
    const parts = splitWs(t);
    if (parts.length >= 12) {
      const tx = toF(parts[9]) ?? 0;
      const ty = toF(parts[10]) ?? 0;
      const newParts = [...parts];
      newParts[9] = formatCoord(f(tx + offsetX));
      newParts[10] = formatCoord(f(ty + offsetY));
      return `transform="${newParts.join(' ')}"`;
    }
    return match;
  }));
}

/** "%.4f" with trailing zeros and dot trimmed. */
function formatCoord(v) {
  return fmtFixed(v, 4).replace(/0+$/, '').replace(/\.+$/, '') || '0';
}

/** Reset an item's transform XY to bed centre (135, 135), keeping rotation and Z. */
function recenterItemXY(item) {
  return item.replace(/transform="([^"]+)"/g, (match, t) => {
    const parts = splitWs(t);
    if (parts.length >= 12) {
      const newParts = [...parts];
      newParts[9] = '135';
      newParts[10] = '135';
      return `transform="${newParts.join(' ')}"`;
    }
    return match;
  });
}

// Internals exposed for tests (Kotlin private / internal helpers).
export const _internal = {
  parseModelSettingsExtruders, buildSlic3rModelConfig, buildOrcaModelConfig, restructureForMultiColor,
  countTriangles, extractMeshXml, parseMainModelStructure, removeObjectBlock, removeBuildItem,
  parseTransformStr, sanitizeProjectSettings, convertMmuSegmentation, detectMultiPlateFromBuild,
  cleanModelXml, cleanModelXmlPreserveComponentRefs, parseIniConfig, serializeIniConfig, clampParameter,
  sanitizeNilValues, normalizePerFilamentArrays, detectExtruderCount, stripBambuGcode,
  sanitizeWipeTowerPosition, getNumeric, parseModelSettingsPlateObjects, recenterGroupIfVirtual,
  formatCoord, recenterItemXY, forEachLine,
};

export const BambuSanitizer = {
  process, extractPlate, restructurePlateFile, filterCustomGcodePerLayer, shouldPreservePerObjectMetadata,
  sanitizeModelSettings, sanitizeModelSettingsPublic, parseIniConfigPublic, stripUnreferencedResources,
  stripUnreferencedConfigObjects, stripAssembleSection, stripNonPrintableBuildItems, filterModelToPlate,
  clampScalarPosition, findMaxObjectId, combineTransforms, copyZipEntry,
};
