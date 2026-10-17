// Port of app/src/main/java/com/u1/slicer/gcode/ExcludeObjectParser.kt (F72).
// Parses Klipper EXCLUDE_OBJECT_DEFINE lines (NAME / CENTER / POLYGON) for the
// bed-object display. Takes the G-code TEXT instead of a file path.
import { toFloatOrNull } from './kt.mjs';

/**
 * @param {string} gcodeText
 * @returns {{name:string, center:[number,number], polygon:[number,number][]}[]}
 *   ExcludeObjectInfo: center/polygon in mm bed coordinates (float32 values);
 *   polygon is empty when the line has none or it is malformed.
 */
export function parseExcludeObjects(gcodeText) {
  const result = [];
  const nameRegex = /NAME=(\S+)/;
  const centerRegex = /CENTER=([\d.]+),([\d.]+)/;

  for (const line of String(gcodeText).split(/\r\n|\r|\n/)) {
    if (!line.startsWith('EXCLUDE_OBJECT_DEFINE ')) continue;

    const nameMatch = nameRegex.exec(line);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const centerMatch = centerRegex.exec(line);
    if (!centerMatch) continue;
    const cx = toFloatOrNull(centerMatch[1]);
    if (cx == null) continue;
    const cy = toFloatOrNull(centerMatch[2]);
    if (cy == null) continue;

    const polygon = [];
    const polyIdx = line.indexOf('POLYGON=');
    if (polyIdx >= 0) {
      try {
        const arr = parseLeadingJsonArray(line.substring(polyIdx + 8));
        for (const pt of arr) {
          if (!Array.isArray(pt)) throw new Error('not an array');
          polygon.push([Math.fround(toNum(pt[0])), Math.fround(toNum(pt[1]))]);
        }
      } catch {
        // malformed polygon — fall back to center-only (polygon kept as parsed so far,
        // same as the Kotlin loop which adds points before hitting a bad one)
      }
    }

    result.push({ name, center: [Math.fround(cx), Math.fround(cy)], polygon });
  }
  return result;
}

// org.json `JSONArray(String)` reads the first value and ignores trailing text.
function parseLeadingJsonArray(s) {
  const t = s.trimStart();
  if (!t.startsWith('[')) throw new Error('not a JSON array');
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return JSON.parse(t.substring(0, i + 1));
  }
  throw new Error('unterminated JSON array');
}

// JSONArray.getDouble: numbers or numeric strings, else throws.
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw new Error('not a number');
}
