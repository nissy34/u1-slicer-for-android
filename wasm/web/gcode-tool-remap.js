// JS port of app/src/main/java/com/u1/slicer/gcode/GcodeToolRemapper.kt
// (remapLine + whole-file remap; the export-only filament-vector compaction is
// not ported). Keep in sync with the Kotlin original and its unit tests —
// wasm/web/test/gcode-tool-remap.test.mjs mirrors GcodeToolRemapperTest.kt.
//
// Orca emits T0, T1, … one per colour in the file; the user then assigns each
// colour to a physical U1 slot, e.g. [2, 3] rewrites T0 → T2, T1 → T3, plus the
// tool parameter of M104/M109 and Snapmaker SM_* EXTRUDER=/INDEX= arguments.
// Classic script: importScripts() in the worker, require() in Node tests.
(function (root) {
  const TOOL_LINE_RE = /^T(\d+)\s*(?:;.*)?$/;
  const MTEMP_T_RE = /(M10[49]\b.*?)\bT(\d+)/g;
  const SM_PARAM_RE = /((?:EXTRUDER|INDEX)=)(\d+)/g;
  const BAMBU_AMS_S_RE = /(\bS)(\d+)(A\b)/g;
  const BAMBU_RETRACT_I_RE = /(\bI)(\d+)(?=\s|$)/g;

  const lookup = (toolMap, n) => {
    const v = toolMap instanceof Map ? toolMap.get(n) : toolMap[n];
    return v ?? n;
  };
  const sub = (line, re, fmt) => { re.lastIndex = 0; return line.replace(re, fmt); };
  const has = (line, re) => { re.lastIndex = 0; return re.test(line); };

  /** Remap a single G-code line. toolMap: Map|object compact index -> slot. */
  function remapLine(line, toolMap) {
    const t = TOOL_LINE_RE.exec(line);
    if (t) return `T${lookup(toolMap, Number(t[1]))}`;
    if (has(line, MTEMP_T_RE)) {
      return sub(line, MTEMP_T_RE, (_, prefix, n) => `${prefix}T${lookup(toolMap, Number(n))}`);
    }
    if ((line.startsWith('M620') || line.startsWith('M621')) && has(line, BAMBU_AMS_S_RE)) {
      return sub(line, BAMBU_AMS_S_RE, (_, s, n, a) => `${s}${lookup(toolMap, Number(n))}${a}`);
    }
    if (line.startsWith('M620.11') && has(line, BAMBU_RETRACT_I_RE)) {
      return sub(line, BAMBU_RETRACT_I_RE, (_, i, n) => `${i}${lookup(toolMap, Number(n))}`);
    }
    if (line.startsWith('SM_') && has(line, SM_PARAM_RE)) {
      return sub(line, SM_PARAM_RE, (_, key, n) => `${key}${lookup(toolMap, Number(n))}`);
    }
    return line;
  }

  /**
   * Whole-file remap. targetSlots[compact] = physical slot (Kotlin remap(path, targetSlots)).
   * Returns the input unchanged when the mapping is empty or the identity.
   */
  function remapGcode(text, targetSlots) {
    if (!targetSlots?.length || targetSlots.every((s, i) => s === i)) return text;
    const toolMap = new Map(targetSlots.map((slot, compact) => [compact, slot]));
    const lines = text.split('\n');
    // Kotlin writes every line + "\n"; a trailing "" from split stays a trailing newline.
    const trailing = lines.length && lines[lines.length - 1] === '';
    if (trailing) lines.pop();
    const out = lines.map((l) => remapLine(l.trimEnd(), toolMap));
    return out.join('\n') + '\n';
  }

  root.remapLine = remapLine;
  root.remapGcode = remapGcode;
  if (typeof module !== 'undefined') module.exports = { remapLine, remapGcode };
})(typeof self !== 'undefined' ? self : globalThis);
