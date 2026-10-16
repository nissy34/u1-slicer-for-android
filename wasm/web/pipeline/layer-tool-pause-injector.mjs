// Port of app/src/main/java/com/u1/slicer/gcode/LayerToolPauseInjector.kt.
//
// Bambu "layer tool" colour swaps (custom_gcode_per_layer.xml type 1/2 rows, or the
// native plate's customGcode ColorChange/ToolChange rows) become PAUSE_PRINT + Tn +
// M109 blocks at the first layer whose Z is above the row's top_z — the U1 has no
// AMS, so the user swaps filament manually.
//
// Web differences from the Kotlin API (logic unchanged):
//  - takes the G-code TEXT and the 3MF BYTES instead of a path + File, and returns the
//    new G-code text when something was injected, else null (Kotlin: rewrote the file
//    in place and returned true/false). Output lines are '\n'-terminated like the
//    Kotlin BufferedWriter loop (line endings normalised, trailing '\n' added).
//  - BuildConfig.DEBUG's dual-path divergence check is opt-in via `options.debug`.
import { parseLayerToolSegments } from './layer-tool-custom-gcode-xml.mjs';
import { readZip, readEntryText } from './zip.mjs';
import { toFloatOrNull, toIntOrNull } from './kt.mjs';

const EPSILON = Math.fround(0.0001);
const pauseRegex = /^\s*; ?PAUSE_PRINT\s*$/;
const zCommentRegex = /^\s*;Z:([0-9.]+)\s*$/;
const gcodeParamRegex = () => /\b([A-Za-z])([+-]?\d*\.?\d+)/g;
const toolOnlyRegex = /^T([0-9]+(?:\.[0-9]+)?)\s*$/;
const smTargetTempRegex = /\bTARGET_TEMP=(\d+(?:\.\d+)?)\b/;
const smIndexRegex = /\bINDEX=(\d+(?:\.\d+)?)\b/;
const NATIVE_TOOLCHANGE_MARKER = '; CP TOOLCHANGE START';
const machinePauseRegex = /"machine_pause_gcode"\s*:\s*"([^"]*)"/;

/** PauseTarget: topZ (float32) = first layer strictly above this Z; extruderBambu 1-based (1->T0). */
export const pauseTarget = (topZ, extruderBambu) => ({ topZ: Math.fround(topZ), extruderBambu });

const isBlank = (s) => s.trim().length === 0;
const substringBefore = (s, d) => { const i = s.indexOf(d); return i < 0 ? s : s.substring(0, i); };
const inTempRange = (n) => n != null && n >= 1 && n <= 400;

/** Kotlin readLine()/forEachLine splitting: \n, \r\n or \r; no trailing empty line. */
export function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

const byTopZThenExtruder = (a, b) => (a.topZ - b.topZ) || (a.extruderBambu - b.extruderBambu);
function distinctTargets(targets) {
  const seen = new Set();
  return targets.filter((t) => {
    const k = `${t.topZ}|${t.extruderBambu}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {string} gcodeText the sliced G-code
 * @param {Uint8Array} model3mf bytes of the source 3MF
 * @param {number} plateIdx 0-based plate index for getPlateData, or -1
 * @param {((plateIdx:number) => string|null)|null} getPlateData nativeGetPlateData-style
 *   accessor (JSON with a customGcode array); null when unavailable (always, on the web
 *   until the engine exposes it — the 3MF XML is then the source).
 * @param {{modelName?: string, debug?: boolean}} [options] modelName, when given, must end
 *   in ".3mf" (Kotlin's file-name guard); debug enables the native/XML agreement check.
 * @returns {string|null} new G-code text, or null when nothing was injected.
 */
export function injectFrom3mf(gcodeText, model3mf, plateIdx, getPlateData, options = {}) {
  if (model3mf == null) return null;
  if (options.modelName != null && !options.modelName.toLowerCase().endsWith('.3mf')) return null;

  const xmlTargets = [];
  let nozzleTemps = null;
  let pauseCommand;
  {
    const zip = readZip(model3mf);
    const xml = readEntryText(zip, 'Metadata/custom_gcode_per_layer.xml');
    if (xml != null) xmlTargets.push(...extractPauseTargets(xml));
    const json = readEntryText(zip, 'Metadata/project_settings.config');
    let cmd = null;
    if (json != null) {
      nozzleTemps = parseNozzleTemperatures(json);
      cmd = machinePauseRegex.exec(json)?.[1] ?? null;
    }
    pauseCommand = cmd ?? 'M400 U1';
  }

  // Native path (live g_model customGcode); the XML is the permanent fallback for
  // post-slice / embedded-file cases where native returns null or empty.
  let nativeJson = null;
  if (plateIdx >= 0 && getPlateData != null) {
    try { nativeJson = getPlateData(plateIdx); } catch { nativeJson = null; }
  }
  const nativeTargetsOrNull = nativeJson != null ? extractPauseTargetsFromNativeJson(nativeJson) : null;

  // Debug tripwire: when both paths produced data they must agree (silent G-code corruption guard).
  if (options.debug && nativeTargetsOrNull != null && nativeTargetsOrNull.length > 0) {
    const xmlSorted = distinctTargets(xmlTargets).sort(byTopZThenExtruder);
    const nativeSorted = distinctTargets(nativeTargetsOrNull).sort(byTopZThenExtruder);
    if (xmlSorted.length > 0) {
      const same = xmlSorted.length === nativeSorted.length &&
        xmlSorted.every((t, i) => t.topZ === nativeSorted[i].topZ && t.extruderBambu === nativeSorted[i].extruderBambu);
      if (!same) {
        throw new Error(`LayerToolPauseInjector dual-path divergence: xml=${JSON.stringify(xmlSorted)} ` +
          `native=${JSON.stringify(nativeSorted)} plateIdx=${plateIdx} model=${options.modelName ?? ''}`);
      }
    }
  }

  const pauseTargets = nativeTargetsOrNull != null && nativeTargetsOrNull.length > 0
    ? [...nativeTargetsOrNull] : [...xmlTargets];
  if (pauseTargets.length === 0) return null;

  if (gcodeText == null) return null;
  if (containsNativeToolchangeWorkflow(gcodeText)) return null;
  const gcodeToolTemps = parseToolNozzleTemperaturesFromGcode(gcodeText);
  const gcodeSmTargetTemps = parseSmTargetTempsFromGcode(gcodeText);
  const gcodeLastNozzleTemp = parseLastNozzleTempFromGcode(gcodeText);

  const pendingTargets = distinctTargets(pauseTargets).sort(byTopZThenExtruder);
  if (pendingTargets.length === 0) return null;

  const out = [];
  let injected = false;
  let lastNonBlank = null;
  const hasPauseImmediatelyBefore = () => lastNonBlank != null && pauseRegex.test(lastNonBlank);

  const lines = splitLines(gcodeText);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    if (line.trim() === ';LAYER_CHANGE' && i < lines.length) {
      const next = lines[i++];
      const zm = zCommentRegex.exec(next);
      const z = zm ? toFloatOrNull(zm[1]) : null;
      if (z != null) {
        const zf = Math.fround(z);
        while (pendingTargets.length > 0 && zf > Math.fround(pendingTargets[0].topZ + EPSILON)) {
          const target = pendingTargets.shift();
          if (!hasPauseImmediatelyBefore()) {
            out.push('; PAUSE_PRINT\n', pauseCommand, '\n');
            const toolIndex = target.extruderBambu - 1;
            // Skip T0 (starting tool). B127: every higher index (T1..T6+) is a real swap.
            if (toolIndex >= 1) {
              out.push(`; layer_tool extruder ${target.extruderBambu} → T${toolIndex}\n`, `T${toolIndex}\n`);
              // Prefer 3MF project settings; fall back to explicit temps in the source G-code.
              const setTemp = nozzleTemps?.get(toolIndex) ?? gcodeToolTemps.get(toolIndex) ??
                gcodeSmTargetTemps.get(toolIndex) ?? gcodeLastNozzleTemp;
              if (inTempRange(setTemp)) out.push(`M109 S${setTemp} T${toolIndex}\n`);
            }
            out.push('\n');
            injected = true;
            lastNonBlank = '; PAUSE_PRINT';
          }
        }
      }
      out.push(line, '\n');
      if (!isBlank(line)) lastNonBlank = line.trim();
      out.push(next, '\n');
      if (!isBlank(next)) lastNonBlank = next.trim();
      continue;
    }
    out.push(line, '\n');
    if (!isBlank(line)) lastNonBlank = line.trim();
  }

  return injected ? out.join('') : null;
}

function extractPauseTargets(xml) {
  return parseLayerToolSegments(xml).map((s) => pauseTarget(s.topZ, s.extruderBambu));
}

// org.json opt* coercions
const optNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = toFloatOrNull(v); return n ?? NaN; }
  return NaN;
};
const optString = (v, fallback) => (v === undefined ? fallback : v === null ? 'null' :
  typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const isJsonObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Decode nativeGetPlateData JSON's `customGcode` rows into PauseTargets. Accepts only
 * "ColorChange" and "ToolChange"; printZ narrows to float32; extruder stays 1-based
 * (default 1). Sorted by (topZ, extruder). Empty list on any parse error — never throws.
 * @returns {{topZ:number, extruderBambu:number}[]}
 */
export function extractPauseTargetsFromNativeJson(plateJson) {
  try {
    const obj = JSON.parse(plateJson);
    if (!isJsonObject(obj)) return [];
    const arr = obj.customGcode;
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const row of arr) {
      if (!isJsonObject(row)) continue;
      const type = optString(row.type, '');
      if (type !== 'ColorChange' && type !== 'ToolChange') continue;
      const topZ = 'printZ' in row ? optNumber(row.printZ) : NaN;
      if (Number.isNaN(topZ)) continue;
      let extruder = 1;
      if ('extruder' in row) {
        const n = optNumber(row.extruder);
        if (!Number.isNaN(n)) extruder = Math.trunc(n);
      }
      out.push(pauseTarget(topZ, extruder));
    }
    return out.sort(byTopZThenExtruder);
  } catch {
    return [];
  }
}
export const extractPauseTargetsFromNativeJsonForTest = extractPauseTargetsFromNativeJson;

/** project_settings.config `nozzle_temperature`: array index = T index. Map or null. */
export function parseNozzleTemperatures(projectSettingsJson) {
  try {
    const obj = JSON.parse(projectSettingsJson.trim());
    if (!isJsonObject(obj)) return null;
    const arr = obj.nozzle_temperature;
    if (!Array.isArray(arr)) return null;
    const temps = new Map();
    for (let i = 0; i < arr.length; i++) {
      const s = optString(arr[i], '').trim();
      const n = toIntOrNull(substringBefore(s, '.'));
      if (n == null) continue;
      if (inTempRange(n)) temps.set(i, n);
    }
    return temps.size > 0 ? temps : null;
  } catch {
    return null;
  }
}

/**
 * Fallback: explicit `M104/M109 ... Tn` temps already in the G-code (sanitized 3MFs
 * without project_settings.config). A line without Tn applies to the current tool.
 * @returns {Map<number, number>}
 */
export function parseToolNozzleTemperaturesFromGcode(gcodeText) {
  const temps = new Map();
  let currentTool = null;
  for (const raw of splitLines(gcodeText)) {
    const line = substringBefore(raw, ';').trim();
    const tm = toolOnlyRegex.exec(line);
    if (tm) {
      const tool = toIntOrNull(tm[1]);
      if (tool != null) currentTool = tool;
    }
    if (!line.startsWith('M104') && !line.startsWith('M109')) continue;
    let tool = null;
    let temp = null;
    for (const match of line.matchAll(gcodeParamRegex())) {
      const key = match[1].toUpperCase();
      const value = match[2];
      if (key === 'T') tool = toIntOrNull(substringBefore(value, '.'));
      else if (key === 'S') temp = toIntOrNull(substringBefore(value, '.'));
    }
    const t = tool ?? currentTool;
    const s = temp;
    if (t != null && s != null && inTempRange(s)) {
      temps.set(t, s);
      currentTool = t;
    }
  }
  return temps;
}

/**
 * Target temps from Snapmaker helpers (`SM_PRINT_START_LINE INDEX=1 TARGET_TEMP=220`,
 * `SM_PRINT_FLOW_CALIBRATE ...`); INDEX is the compact 0-based tool index.
 * @returns {Map<number, number>}
 */
export function parseSmTargetTempsFromGcode(gcodeText) {
  const temps = new Map();
  for (const raw of splitLines(gcodeText)) {
    const line = substringBefore(raw, ';').trim();
    if (!line.startsWith('SM_PRINT_START_LINE') && !line.startsWith('SM_PRINT_FLOW_CALIBRATE')) continue;
    const im = smIndexRegex.exec(line);
    const index = im ? toIntOrNull(substringBefore(im[1], '.')) : null;
    const tm = smTargetTempRegex.exec(line);
    const temp = tm ? toIntOrNull(substringBefore(tm[1], '.')) : null;
    if (index != null && temp != null && inTempRange(temp)) temps.set(index, temp);
  }
  return temps;
}

/** Last non-zero nozzle temperature from executable M104/M109 lines, or null. */
export function parseLastNozzleTempFromGcode(gcodeText) {
  let last = null;
  for (const raw of splitLines(gcodeText)) {
    const line = substringBefore(raw, ';').trim();
    if (!line.startsWith('M104') && !line.startsWith('M109')) continue;
    let temp = null;
    for (const m of line.matchAll(gcodeParamRegex())) {
      if (m[1].toUpperCase() === 'S') { temp = toIntOrNull(substringBefore(m[2], '.')); break; }
    }
    if (inTempRange(temp)) last = temp;
  }
  return last;
}

/**
 * Painted/per-part multicolour jobs already contain native Orca toolchange sequences;
 * injecting pauses on top would create bogus extra segments.
 */
export function containsNativeToolchangeWorkflow(gcodeText) {
  return gcodeText.includes(NATIVE_TOOLCHANGE_MARKER);
}

export const LayerToolPauseInjector = {
  injectFrom3mf, extractPauseTargetsFromNativeJson, extractPauseTargetsFromNativeJsonForTest,
};
