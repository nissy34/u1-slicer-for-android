// ES-module port of app/src/main/java/com/u1/slicer/gcode/PrintTimeRemap.kt.
// Keep in sync with the Kotlin original; wasm/web/test/print-time-remap.test.mjs
// mirrors PrintTimeRemapTest.kt, CanonicalExportMappingTest.kt and
// SliceJobMappingResolutionTest.kt.
//
// G-code is handled as a string rather than file paths:
//   applyPrintTimeRemap({ gcodeText, colorMapping }) -> remapped text.
//
// GcodeToolRemapper.remapLine is ported locally (remapLine below) instead of
// importing ../gcode-tool-remap.js: that file is a classic importScripts()/CommonJS
// script with no ES exports, so it cannot be imported the same way from Node and
// from a browser module worker. The local copy follows the Kotlin regexes exactly
// (Java `\s`/`.`/`$` semantics, toIntOrNull overflow fallbacks).
//
// No node:* imports — runs in Node 22 and in a browser (module) Web Worker.
import { toIntOrNull } from './kt.mjs';

/** enum class GcodeToolSpace */
export const GcodeToolSpace = Object.freeze({
  CANONICAL: 'CANONICAL',
  PHYSICAL: 'PHYSICAL',
});

export function gcodeToolSpaceFromDb(value) {
  return value === GcodeToolSpace.PHYSICAL ? GcodeToolSpace.PHYSICAL : GcodeToolSpace.CANONICAL;
}

export function gcodeToolSpaceToDb(value) {
  return value;
}

const coerceIn = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Phase 2 — canonical-fileIndex → physical-slot mapping for the export boundary
 * (Send / Save / Share / Jobs share). Returns null for "identity copy, skip remap".
 */
export function resolveCanonicalExportMapping({
  canonicalSize,
  confirmedMapping,
  selectedExtruder,
  confirmedMappingFileIndices = null,
}) {
  if (canonicalSize === 0) {
    // B106: non-canonical single-colour (raw STL) — still apply the user's slot.
    const slot = coerceIn(selectedExtruder, 0, 3);
    return slot !== 0 ? [slot] : null;
  }

  const clamp = (v) => coerceIn(v, 0, 3);

  if (confirmedMapping != null && confirmedMapping.length > 0) {
    if (confirmedMappingFileIndices != null && confirmedMappingFileIndices.length > 0) {
      const byFileIdx = new Map();
      const n = Math.min(confirmedMappingFileIndices.length, confirmedMapping.length); // zip
      for (let k = 0; k < n; k++) {
        const fileIdx = confirmedMappingFileIndices[k];
        const slot = confirmedMapping[k];
        if (fileIdx >= 0 && fileIdx < canonicalSize) {
          byFileIdx.set(fileIdx, clamp(slot));
        }
      }
      return Array.from({ length: canonicalSize }, (_, i) => byFileIdx.get(i) ?? (i % 4));
    }
    return confirmedMapping.length >= canonicalSize
      ? confirmedMapping.slice(0, canonicalSize).map(clamp)
      : Array.from({ length: canonicalSize }, (_, i) =>
        i < confirmedMapping.length ? clamp(confirmedMapping[i]) : (i % 4));
  }

  if (canonicalSize === 1) {
    return [clamp(selectedExtruder)];
  }

  return Array.from({ length: canonicalSize }, (_, i) => i % 4);
}

export function resolveExportMappingForToolSpace({
  toolSpace,
  canonicalSize,
  confirmedMapping,
  selectedExtruder,
  confirmedMappingFileIndices = null,
}) {
  if (toolSpace === GcodeToolSpace.PHYSICAL) return null;
  return resolveCanonicalExportMapping({
    canonicalSize,
    confirmedMapping,
    selectedExtruder,
    confirmedMappingFileIndices,
  });
}

// ---- GcodeToolRemapper.remapLine (local port) ----
// Java regex semantics: `\s` = [ \t\n\x0B\f\r]; `.` excludes \n \r \u0085 \u2028 \u2029;
// non-multiline `$` also matches before a final line terminator.
const JS = '[ \\t\\n\\v\\f\\r]';
const JDOT = '[^\\n\\r\\u0085\\u2028\\u2029]';
const JEND = '(?:$|(?=(?:\\r\\n|[\\n\\r\\u0085\\u2028\\u2029])$))';
const TOOL_LINE_RE = new RegExp(`^T(\\d+)${JS}*(?:;${JDOT}*)?$`);
const MTEMP_T_RE = new RegExp(`(M10[49]\\b${JDOT}*?)\\bT(\\d+)`, 'g');
const SM_PARAM_RE = /((?:EXTRUDER|INDEX)=)(\d+)/g;
const BAMBU_AMS_S_RE = /(\bS)(\d+)(A\b)/g;
const BAMBU_RETRACT_I_RE = new RegExp(`(\\bI)(\\d+)(?=${JS}|${JEND})`, 'g');

const containsMatchIn = (re, line) => { re.lastIndex = 0; return re.test(line); };
const replaceAll = (re, line, fn) => { re.lastIndex = 0; return line.replace(re, fn); };
const lookup = (toolMap, n) => toolMap.get(n) ?? n;

/** Port of GcodeToolRemapper.remapLine(line, toolMap: Map<Int, Int>). */
export function remapLine(line, toolMap) {
  const tMatch = TOOL_LINE_RE.exec(line);
  if (tMatch) {
    const compact = toIntOrNull(tMatch[1]);
    if (compact == null) return line;
    return `T${lookup(toolMap, compact)}`;
  }
  if (containsMatchIn(MTEMP_T_RE, line)) {
    return replaceAll(MTEMP_T_RE, line, (m, prefix, n) => {
      const compact = toIntOrNull(n);
      if (compact == null) return m;
      return `${prefix}T${lookup(toolMap, compact)}`;
    });
  }
  if ((line.startsWith('M620') || line.startsWith('M621')) && containsMatchIn(BAMBU_AMS_S_RE, line)) {
    return replaceAll(BAMBU_AMS_S_RE, line, (m, s, n, a) => {
      const tool = toIntOrNull(n);
      if (tool == null) return m;
      return `${s}${lookup(toolMap, tool)}${a}`;
    });
  }
  if (line.startsWith('M620.11') && containsMatchIn(BAMBU_RETRACT_I_RE, line)) {
    return replaceAll(BAMBU_RETRACT_I_RE, line, (m, i, n) => {
      const tool = toIntOrNull(n);
      if (tool == null) return m;
      return `${i}${lookup(toolMap, tool)}`;
    });
  }
  if (line.startsWith('SM_') && containsMatchIn(SM_PARAM_RE, line)) {
    return replaceAll(SM_PARAM_RE, line, (m, key, n) => {
      const compact = toIntOrNull(n);
      if (compact == null) return m;
      return `${key}${lookup(toolMap, compact)}`;
    });
  }
  return line;
}

// Kotlin String.trimEnd(): strips Char.isWhitespace (Java isWhitespace || isSpaceChar).
const KT_TRAILING_WS = /[\t\n\v\f\r\x1C-\x1F\p{Zs}\u2028\u2029]+$/u;
const ktTrimEnd = (s) => s.replace(KT_TRAILING_WS, '');

// BufferedReader.lineSequence(): terminators \n, \r, \r\n; no trailing empty line.
function readerLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Phase 2.3 — non-destructive print-time T-index rewrite. Returns the remapped
 * G-code; the input string is untouched. Empty mapping = verbatim copy (same
 * string returned). Otherwise every line is trimEnd()-ed, remapped, and
 * terminated with "\n" (CRLF/CR normalised to LF, trailing newline always added).
 */
export function applyPrintTimeRemap({ gcodeText, colorMapping }) {
  if (colorMapping.length === 0) return gcodeText;
  const toolMap = new Map(colorMapping.map((slot, fileIdx) => [fileIdx, slot]));
  let out = '';
  for (const line of readerLines(gcodeText)) {
    out += remapLine(ktTrimEnd(line), toolMap);
    out += '\n';
  }
  return out;
}

/** Internal-memory wrong-nozzle fix — mapping fed to applyPrintTimeRemap for a send action. */
export function sendRemapForAction({
  uploadOnly,
  physicalMapping,
  sourceToolSpace = GcodeToolSpace.CANONICAL,
}) {
  return uploadOnly && sourceToolSpace === GcodeToolSpace.CANONICAL ? [] : physicalMapping;
}
