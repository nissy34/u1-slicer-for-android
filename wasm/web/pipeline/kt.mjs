// Kotlin number formatting, so ported code emits exactly the strings the app
// writes into configs and G-code (tests compare them verbatim).

/** Kotlin `Float.toString()`: shortest decimal that round-trips to the same float32, ".0" on integers. */
export function ktFloat(x) {
  const f = Math.fround(x);
  if (!Number.isFinite(f)) return f > 0 ? 'Infinity' : f < 0 ? '-Infinity' : 'NaN';
  if (f === 0) return Object.is(f, -0) ? '-0.0' : '0.0';
  let s;
  for (let p = 1; p <= 9; p++) {
    s = f.toPrecision(p);
    if (Math.fround(Number(s)) === f) break;
  }
  return javaStyle(Number(s), s);
}

/** Kotlin `Double.toString()`. */
export function ktDouble(x) {
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : x < 0 ? '-Infinity' : 'NaN';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  return javaStyle(x, String(x));
}

// Java prints plain decimals for 1e-3 <= |x| < 1e7 and "1.0E7"-style otherwise.
function javaStyle(n, shortest) {
  const abs = Math.abs(n);
  if (abs >= 1e-3 && abs < 1e7) {
    let s = shortest.includes('e') ? n.toFixed(Math.max(0, -Math.floor(Math.log10(abs)) + 8)).replace(/0+$/, '') : String(n);
    if (!s.includes('.')) s += '.0';
    if (s.endsWith('.')) s += '0';
    return s;
  }
  const [mant, exp] = n.toExponential().split('e');
  return `${mant.includes('.') ? mant : `${mant}.0`}E${Number(exp)}`;
}

/** Kotlin `"%.Nf".format(x)` (root locale). */
export const fmtFixed = (x, digits) => Number(x).toFixed(digits);

/** Kotlin `Float.toInt()` / `Double.toInt()`: truncation toward zero, NaN -> 0. */
export const ktToInt = (x) => (Number.isNaN(x) ? 0 : Math.trunc(x));

/** Kotlin `String.toIntOrNull()`: strict integer syntax. */
export function toIntOrNull(s) {
  if (s == null) return null;
  const t = String(s);
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Kotlin `String.toFloatOrNull()` / `toDoubleOrNull()`: Java float syntax, no surrounding garbage. */
export function toFloatOrNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/^[+-]?(NaN|Infinity|((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)[fFdD]?)$/.test(t)) return null;
  return Number(t.replace(/[fFdD]$/, ''));
}
