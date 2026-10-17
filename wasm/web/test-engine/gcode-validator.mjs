// Port of the parts of app/src/main/java/com/u1/slicer/gcode/GcodeValidator.kt
// the instrumented tests use (pure string checks on G-code text), plus the small
// G-code helpers those test classes define privately (hasExactGcodeLine,
// filamentUsedMm). Kept line-for-line with the Kotlin so the engine tests make
// the same assertions as the app.

const lines = (gcode) => gcode.split('\n');

/** extractToolChanges: bare tool-change lines "T<n>" (trimmed). */
export function extractToolChanges(gcode) {
  const result = new Set();
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (/^T\d+\s*$/.test(t)) result.add(t.trimEnd());
  }
  return result;
}

/** extractNozzleTemps: non-zero S of executable M104/M109. */
export function extractNozzleTemps(gcode) {
  const out = [];
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (t.startsWith(';')) continue;
    if (!t.startsWith('M104') && !t.startsWith('M109')) continue;
    const m = /S(\d+)/.exec(t);
    if (!m) continue;
    const temp = Number.parseInt(m[1], 10);
    if (temp > 0) out.push(temp);
  }
  return out;
}

export const hasNonZeroNozzleTemps = (gcode) => extractNozzleTemps(gcode).length > 0;

/** extractLayerCount: ";LAYER_CHANGE" or ";Z:" lines. */
export function extractLayerCount(gcode) {
  let n = 0;
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (t === ';LAYER_CHANGE' || t.startsWith(';Z:')) n++;
  }
  return n;
}

/** parsePrimeTowerFootprint (bridge slicing.spec.ts port). */
export function parsePrimeTowerFootprint(gcode) {
  let x = NaN, y = NaN, inPrimeTower = false, relativeE = false, absE = NaN;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (const raw of lines(gcode)) {
    const line = raw.trim();
    if (line === 'M83') { relativeE = true; continue; }
    if (line === 'M82') { relativeE = false; continue; }
    if (line.startsWith('G92 ')) {
      const m = /E(-?\d+(?:\.\d+)?)/.exec(line);
      if (m) absE = Number(m[1]);
      continue;
    }
    if (line.startsWith('; FEATURE: ') || line.startsWith(';TYPE:')) {
      const l = line.toLowerCase();
      inPrimeTower = l.includes('prime') && l.includes('tower');
      continue;
    }
    if (!inPrimeTower || !line.startsWith('G1')) continue;
    const mx = /\bX(-?\d+(?:\.\d+)?)/.exec(line); if (mx) x = Number(mx[1]);
    const my = /\bY(-?\d+(?:\.\d+)?)/.exec(line); if (my) y = Number(my[1]);
    const me = /\bE(-?\d+(?:\.\d+)?)/.exec(line);
    if (!me) continue;
    const en = Number(me[1]);
    let isExtrusion;
    if (relativeE) isExtrusion = en > 1e-6;
    else {
      if (Number.isNaN(absE)) { absE = en; continue; }
      isExtrusion = en > absE + 1e-6;
      absE = en;
    }
    if (!isExtrusion || Number.isNaN(x) || Number.isNaN(y)) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    count++;
  }
  if (count === 0) return null;
  return { minX, maxX, minY, maxY, moveCount: count, width: maxX - minX, depth: maxY - minY };
}

export function extractToolchangeRetractLength(gcode) {
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (t.startsWith('; retract_length_toolchange = ')) {
      const csv = t.slice(t.indexOf('= ') + 2).trim();
      return csv.split(',').map((s) => s.trim()).filter((s) => s !== '' && !Number.isNaN(Number(s))).map(Number);
    }
  }
  return null;
}

export function maxRetractionMm(gcode) {
  let max = 0;
  const re = /^G1\s.*E(-\d+(?:\.\d+)?)/;
  for (const line of lines(gcode)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const mag = -Number(m[1]);
    if (mag > max) max = mag;
  }
  return max;
}

export function hasToolChanges(gcode, ...tools) {
  const actual = extractToolChanges(gcode);
  return tools.every((t) => actual.has(t));
}

export function lacksToolChanges(gcode, ...tools) {
  const actual = extractToolChanges(gcode);
  return !tools.some((t) => actual.has(t));
}

export const hasBowdenUnloadSequence = (gcode) => lines(gcode).some((l) => l.trim() === '; Retract(unload)');

export function extractConfigComment(gcode, key) {
  const prefix = `; ${key} = `;
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim();
  }
  return null;
}

export function extractEstimatedTime(gcode) {
  for (const line of lines(gcode)) {
    const t = line.trim();
    if (t.startsWith('; estimated printing time') || t.startsWith('; model printing time')) return t;
  }
  return null;
}

/** checkBedBounds: G0/G1 X/Y within the bed ± 0.5 mm. */
export function checkBedBounds(gcode, bedMinX = 0, bedMaxX = 270, bedMinY = 0, bedMaxY = 270) {
  let curX = NaN, curY = NaN;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const violations = [];
  for (const raw of lines(gcode)) {
    const line = raw.trim();
    if (line.startsWith(';')) continue;
    if (!line.startsWith('G0') && !line.startsWith('G1')) continue;
    const mx = /X(-?\d+(?:\.\d+)?)/.exec(line); if (mx) curX = Number(mx[1]);
    const my = /Y(-?\d+(?:\.\d+)?)/.exec(line); if (my) curY = Number(my[1]);
    if (!Number.isNaN(curX)) { minX = Math.min(minX, curX); maxX = Math.max(maxX, curX); }
    if (!Number.isNaN(curY)) { minY = Math.min(minY, curY); maxY = Math.max(maxY, curY); }
    const xOob = !Number.isNaN(curX) && (curX < bedMinX - 0.5 || curX > bedMaxX + 0.5);
    const yOob = !Number.isNaN(curY) && (curY < bedMinY - 0.5 || curY > bedMaxY + 0.5);
    if ((xOob || yOob) && violations.length < 5) violations.push(line);
  }
  const withinBounds = violations.length === 0 &&
    (!Number.isFinite(minX) || (minX >= bedMinX - 0.5 && maxX <= bedMaxX + 0.5)) &&
    (!Number.isFinite(minY) || (minY >= bedMinY - 0.5 && maxY <= bedMaxY + 0.5));
  const fin = (v) => (Number.isFinite(v) ? v : 0);
  return { withinBounds, minX: fin(minX), maxX: fin(maxX), minY: fin(minY), maxY: fin(maxY), violatingLines: violations };
}

// ---- helpers the Kotlin test classes define privately ----

export const hasExactGcodeLine = (gcode, expected) => lines(gcode).some((l) => l.trim() === expected);

/** "; filament used [mm] = a,b,c" -> [a, b, c] (Kotlin filamentUsedMm). */
export function filamentUsedMm(gcode) {
  const line = lines(gcode).find((l) => l.trimStart().startsWith('; filament used [mm] = '));
  if (line == null) return [];
  return line.slice(line.indexOf('=') + 1).split(',').map((s) => s.trim())
    .filter((s) => s !== '' && !Number.isNaN(Number(s))).map(Number);
}

/** Kotlin `gcode.lines().count { it.trim() == "T$t" }` for t in 0..n-1. */
export function exactToolCounts(gcode, n = 4) {
  const counts = Array(n).fill(0);
  for (const line of lines(gcode)) {
    const m = /^T(\d+)$/.exec(line.trim());
    if (m && Number(m[1]) < n) counts[Number(m[1])]++;
  }
  return counts;
}

/** Kotlin `gcode.lines().count { it.trimStart().startsWith(prefix) }`. */
export const countLinesStartingWith = (gcode, prefix) => lines(gcode).filter((l) => l.trimStart().startsWith(prefix)).length;
export const countLinesContaining = (gcode, s) => lines(gcode).filter((l) => l.includes(s)).length;
