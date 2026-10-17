// Port of app/src/main/java/com/u1/slicer/bambu/LayerToolCustomGcodeXml.kt.
//
// Parses Bambu/Orca `Metadata/custom_gcode_per_layer.xml` for layer-based tool /
// colour changes. ThreeMfParser uses it for colour detection; LayerToolPauseInjector
// uses the same layer `type` rules for pause insertion — keep them aligned.
import { layerToolSegment } from './three-mf-info.mjs';
import { toFloatOrNull, toIntOrNull } from './kt.mjs';

const TYPE_RE = /\btype="([^"]+)"/;
const EXTRUDER_RE = /\bextruder="([^"]+)"/;
const COLOR_RE = /\bcolor="([^"]+)"/;
const TOP_Z_RE = /\btop_z="([^"]+)"/;
const layerRe = () => /<layer\b([^>]*)>/g;
const isBlank = (s) => s.trim().length === 0;

/**
 * Returns { hasToolChanges: boolean, colors: string[] (distinct, first 7 chars),
 * extruders: Set<number> } over every type-1 / type-2 `<layer>` entry.
 */
export function parseLayerToolCustomGcodeXml(xml) {
  const colors = new Set();
  const extruders = new Set();
  let hasToolChanges = false;

  for (const match of xml.matchAll(layerRe())) {
    const attrs = match[1];
    const type = TYPE_RE.exec(attrs)?.[1] ?? null;
    if (type === '1' || type === '2') {
      hasToolChanges = true;
      const ext = toIntOrNull(EXTRUDER_RE.exec(attrs)?.[1] ?? null);
      if (ext != null) extruders.add(ext);
      const color = COLOR_RE.exec(attrs)?.[1] ?? null;
      if (color != null && !isBlank(color)) colors.add(color.slice(0, 7));
    }
  }
  return { hasToolChanges, colors: [...colors], extruders };
}

/**
 * Per-plate variant. Each `<plate>` block starts with `<plate_info id="N"/>`;
 * subsequent `<layer>` entries belong to that plate.
 * Returns Map<1-based plateId, LayerToolCustomGcodeXmlInfo>.
 */
export function parseLayerToolCustomGcodeXmlPerPlate(xml) {
  const result = new Map();
  const plateInfoIdRe = /<plate_info\b[^>]*\bid="(\d+)"/;
  for (const section of xml.split('<plate>').slice(1)) {
    const end = section.indexOf('</plate>');
    const content = end < 0 ? section : section.slice(0, end);
    const plateId = toIntOrNull(plateInfoIdRe.exec(content)?.[1] ?? null);
    if (plateId == null) continue;
    result.set(plateId, parseLayerToolCustomGcodeXml(content));
  }
  return result;
}

/**
 * Ordered Z→extruder segments ("from this Z and up, use this extruder"), sorted
 * ascending by topZ (stable). extruderBambu is 1-based. Empty when no type-1/2 layers.
 */
export function parseLayerToolSegments(xml) {
  const out = [];
  for (const match of xml.matchAll(layerRe())) {
    const attrs = match[1];
    const type = TYPE_RE.exec(attrs)?.[1] ?? null;
    if (type !== '1' && type !== '2') continue;
    const topZ = toFloatOrNull(TOP_Z_RE.exec(attrs)?.[1] ?? null);
    if (topZ == null) continue;
    const extruder = toIntOrNull(EXTRUDER_RE.exec(attrs)?.[1] ?? null) ?? 1;
    out.push(layerToolSegment(topZ, extruder));
  }
  return out.sort((a, b) => a.topZ - b.topZ);
}
