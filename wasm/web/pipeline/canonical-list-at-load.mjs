// Zip-reading entry points of the canonical filament list:
//   bambu/BambuCanonicalList.kt        bambuCanonicalList(file)
//   bambu/PrusaSlicerCanonicalList.kt  prusaSlicerCanonicalList(file)
//   data/CanonicalListAtLoad.kt        canonicalListAtLoad(file)
// Files are passed as 3MF bytes (Uint8Array) instead of java.io.File.
import { getEntry, readZip, decodeText } from './zip.mjs';
import { decodeStates } from './paint-color-decoder.mjs';
import { parseLayerToolCustomGcodeXml } from './layer-tool-custom-gcode-xml.mjs';
import {
  LAYER_TOOL_PATH, PRUSA_CONFIG_PATH, PROJECT_SETTINGS_PATH,
  buildFromProjectSettings, buildFromPrusaConfig, extractPaintSpecs, mergeLayerToolData,
  mergePaintStates, parseLayerToolColourPairs, readFullSpectrumPhysicalCount,
} from './canonical-filament-list.mjs';

const MODEL_ENTRY_RE = /^.*\.model$/;
const isModelEntry = (e) => !e.name.endsWith('/') && MODEL_ENTRY_RE.test(e.name);
const latin1 = new TextDecoder('latin1');

/**
 * Every non-blank `paint_color="…"` / `mmu_segmentation="…"` value in a .model
 * entry, in file order — the ThreeMfParser.streamCollectPaintSpecs scan
 * (earliest match of either needle; a value with no closing quote is dropped).
 */
export function collectPaintSpecs(bytes, onSpec) {
  const text = typeof bytes === 'string' ? bytes : latin1.decode(bytes);
  const n1 = 'paint_color="';
  const n2 = 'mmu_segmentation="';
  let pos = 0;
  // Next occurrence of each needle, re-searched only once passed: re-scanning
  // for an absent needle on every match made this quadratic on 40 MB models.
  let a = -2;
  let b = -2;
  for (;;) {
    if (a !== -1 && a < pos) a = text.indexOf(n1, pos);
    if (b !== -1 && b < pos) b = text.indexOf(n2, pos);
    let matchIdx;
    let matchLen;
    if (a === -1 && b === -1) break;
    if (b === -1 || (a !== -1 && a <= b)) { matchIdx = a; matchLen = n1.length; } else { matchIdx = b; matchLen = n2.length; }
    const vStart = matchIdx + matchLen;
    const vEnd = text.indexOf('"', vStart);
    if (vEnd === -1) break;
    const spec = text.substring(vStart, vEnd);
    if (spec.trim() !== '') onSpec(spec);
    pos = vEnd + 1;
  }
}

/**
 * Full Bambu / OrcaSlicer canonical list: FILE_COLOUR entries from
 * project_settings.config + PAINT_DERIVED entries / paintStateMap from paint
 * attributes + LAYER_TOOL entries from custom_gcode_per_layer.xml. Null for
 * invalid / non-Bambu 3MFs.
 */
export function bambuCanonicalList(bytes) {
  try {
    const entries = readZip(bytes);
    const settingsEntry = getEntry(entries, PROJECT_SETTINGS_PATH);
    if (!settingsEntry) return null;
    const settingsText = decodeText(settingsEntry.data);
    const base = buildFromProjectSettings(settingsText);
    if (!base) return null;

    // M3-B: paint states beyond the physical count are virtual mix filaments and
    // must not inflate the canonical list.
    const fullSpectrumPhysicalCount = readFullSpectrumPhysicalCount(settingsText);

    const paintStates = new Set();
    for (const e of entries.filter(isModelEntry)) {
      collectPaintSpecs(e.data, (spec) => { for (const s of decodeStates(spec)) paintStates.add(s); });
    }
    const physicalPaintStates = fullSpectrumPhysicalCount != null
      ? new Set([...paintStates].filter((s) => s <= fullSpectrumPhysicalCount))
      : paintStates;
    const withPaint = mergePaintStates(base, physicalPaintStates);

    const layerToolEntry = getEntry(entries, LAYER_TOOL_PATH);
    if (layerToolEntry) {
      const xml = decodeText(layerToolEntry.data);
      const info = parseLayerToolCustomGcodeXml(xml);
      if (info.hasToolChanges && info.extruders.size > 0) {
        return mergeLayerToolData(withPaint, info, parseLayerToolColourPairs(xml));
      }
    }
    return withPaint;
  } catch {
    return null;
  }
}

/** PrusaSlicer 3MF canonical list (Slic3r_PE.config + paint segmentation), or null. */
export function prusaSlicerCanonicalList(bytes) {
  try {
    const entries = readZip(bytes);
    const configEntry = getEntry(entries, PRUSA_CONFIG_PATH);
    if (!configEntry) return null;
    const base = buildFromPrusaConfig(decodeText(configEntry.data));
    if (!base) return null;
    const paintStates = new Set();
    for (const e of entries.filter(isModelEntry)) {
      for (const line of decodeText(e.data).split(/\r\n|\r|\n/)) {
        for (const spec of extractPaintSpecs(line)) for (const s of decodeStates(spec)) paintStates.add(s);
      }
    }
    return mergePaintStates(base, paintStates);
  } catch {
    return null;
  }
}

/**
 * Dispatcher: Bambu/Orca 3MF, then PrusaSlicer 3MF; null otherwise (callers
 * wrap STL with `?? stlCanonicalList(presetColor, presetMaterialType)`).
 * @param {Uint8Array} bytes
 * @param {string} fileName used only for the `.3mf` extension check
 */
export function canonicalListAtLoad(bytes, fileName) {
  if (!bytes) return null;
  if (String(fileName).toLowerCase().endsWith('.3mf')) {
    return bambuCanonicalList(bytes) ?? prusaSlicerCanonicalList(bytes);
  }
  return null;
}
