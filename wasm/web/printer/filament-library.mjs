// Port of the app's bundled filament library (F96): data/FilamentLibrary.kt,
// data/FilamentLibraryMatcher.kt, data/FilamentLibraryImport.kt, the recents /
// slug-list helpers, and aipaint/ColourMatch.deltaE76. The catalogue itself is
// the app's own asset (app/src/main/assets/filament_library.json, OpenPrintTag
// snapshot — see filament_library.NOTICE.txt), served next to the page.
// Mirrored by test/printer-filament-library.test.mjs.

export const DEFAULT_LIMIT = 200;
export const MAX_RECENTS = 10;
/** CIE76 gate — pinned by FilamentLibraryMatcherTest. */
export const MAX_DELTA_E = 10.0;
const SUBTYPE_BONUS = 3.0;

export const displayName = (e) => `${e.brand} ${e.name}`;

/** FilamentLibrary.parse — throws on malformed input. */
export function parseLibrary(json) {
  const root = typeof json === 'string' ? JSON.parse(json) : json;
  if (!root || !Array.isArray(root.entries)) throw new Error('filament library: missing entries');
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const entries = root.entries.map((o) => {
    if (typeof o.s !== 'string' || typeof o.b !== 'string' || typeof o.n !== 'string') throw new Error('filament library: bad entry');
    return {
      slug: o.s, brand: o.b, name: o.n, material: o.m ?? '',
      materialRaw: has(o, 'mr') ? o.mr : null,
      hex: has(o, 'h') ? o.h : null,
      td: has(o, 'td') ? o.td : null,
      ri: has(o, 'ri') ? o.ri : null,
      density: has(o, 'd') ? o.d : null,
      minNozzle: has(o, 'nl') ? o.nl : null,
      maxNozzle: has(o, 'nh') ? o.nh : null,
      minBed: has(o, 'bl') ? o.bl : null,
      maxBed: has(o, 'bh') ? o.bh : null,
    };
  });
  return makeLibrary(entries, { commit: root.commit ?? '?', date: root.date ?? '?', count: root.count ?? entries.length });
}

export function makeLibrary(entries, snapshot) {
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const lower = new Map(entries.map((e) => [e.slug, displayName(e).toLowerCase()]));
  const byName = (a, b) => (lower.get(a.slug) < lower.get(b.slug) ? -1 : lower.get(a.slug) > lower.get(b.slug) ? 1 : 0);
  return {
    entries, snapshot,
    entry: (slug) => bySlug.get(slug) ?? null,
    /** FilamentLibrary.search: favourites → recents → alphabetical on a blank query; all-token match otherwise. */
    search(query, { material = null, favourites = new Set(), recents = [], limit = DEFAULT_LIMIT } = {}) {
      const favs = favourites instanceof Set ? favourites : new Set(favourites);
      const pool = material == null ? entries : entries.filter((e) => e.material.toLowerCase() === String(material).toLowerCase());
      const q = String(query ?? '').trim();
      if (!q) {
        const head = pool.filter((e) => favs.has(e.slug)).sort(byName);
        for (const slug of recents) {
          if (favs.has(slug)) continue;
          const e = pool.find((x) => x.slug === slug);
          if (e && !head.includes(e)) head.push(e);
        }
        const headSlugs = new Set(head.map((e) => e.slug));
        const rest = pool.filter((e) => !headSlugs.has(e.slug)).sort(byName);
        return [...head, ...rest].slice(0, limit);
      }
      const ql = q.toLowerCase();
      const tokens = ql.split(/\s+/).filter(Boolean);
      const matched = [];
      for (const e of pool) {
        const hay = `${e.brand} ${e.name} ${e.material} ${e.materialRaw ?? ''}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) continue;
        const quality = lower.get(e.slug).startsWith(ql) ? 0
          : hay.split(' ').some((w) => w.startsWith(tokens[0])) ? 1 : 2;
        matched.push([e, favs.has(e.slug) ? 0 : 1, quality]);
      }
      matched.sort((a, b) => a[1] - b[1] || a[2] - b[2] || byName(a[0], b[0]));
      return matched.slice(0, limit).map((m) => m[0]);
    },
  };
}

/** Materials present in the catalogue, most common first (for the picker's chips). */
export function topMaterials(library, n = 8) {
  const counts = new Map();
  for (const e of library.entries) if (e.material) counts.set(e.material, (counts.get(e.material) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([m]) => m);
}

// ---- colour ------------------------------------------------------------------------

function parseHex(hex) {
  const v = parseInt(String(hex).replace(/^#/, ''), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
const srgbToLin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
function lab(hex) {
  const [R, G, B] = parseHex(hex);
  const r = srgbToLin(R), g = srgbToLin(G), b = srgbToLin(B);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** ColourMatch.deltaE76. 0 = identical. */
export function deltaE76(a, b) {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// ---- RFID → catalogue match (FilamentLibraryMatcher) -------------------------------

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function subtypeMatches(subType, name) {
  if (!subType || !String(subType).trim()) return false;
  const n = name.toLowerCase();
  return String(subType).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3).some((t) => n.includes(t));
}

/** Conservative: brand AND material must agree and ΔE ≤ 10; never guesses across brands. */
export function matchLibrary(library, { vendor, material, subType, hex }) {
  if (!vendor?.trim?.() || !hex?.trim?.() || !material?.trim?.()) return null;
  const v = norm(vendor);
  if (!v) return null;
  const candidates = library.entries.filter((e) => {
    if (e.hex == null) return false;
    if (e.material.toLowerCase() !== material.toLowerCase()) return false;
    const b = norm(e.brand);
    return b.length > 0 && (b.includes(v) || v.includes(b));
  });
  // Gate on raw ΔE first, then rank survivors with the subtype bonus.
  let best = null;
  for (const e of candidates) {
    const dE = deltaE76(hex, e.hex);
    if (dE > MAX_DELTA_E) continue;
    const rank = dE - (subtypeMatches(subType, e.name) ? SUBTYPE_BONUS : 0);
    if (!best || rank < best.rank) best = { entry: e, deltaE: dE, rank };
  }
  return best ? { entry: best.entry, deltaE: best.deltaE } : null;
}

// ---- favourites / recents ------------------------------------------------------------

export const updateRecents = (current, slug) => [slug, ...current.filter((s) => s !== slug)].slice(0, MAX_RECENTS);
export const encodeSlugList = (slugs) => JSON.stringify(slugs);
export function decodeSlugList(json) {
  if (!json || !String(json).trim()) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

// ---- import (FilamentLibraryImport) ----------------------------------------------------

export const FUTURE_TRANSLUCENCY_NOTE = 'For future translucency features — not used in slicing';

export const hasImportableData = (e) => [e.minNozzle, e.maxNozzle, e.minBed, e.maxBed, e.density, e.td, e.ri].some((v) => v != null);

function rangeText(lo, hi) {
  if (lo != null && hi != null && lo !== hi) return `${lo}–${hi} °C`;
  if (lo != null) return `${lo} °C`;
  if (hi != null) return `${hi} °C`;
  return null;
}

export function buildImportPreview(e) {
  const rows = [];
  const nz = rangeText(e.minNozzle, e.maxNozzle); if (nz) rows.push({ label: 'Nozzle temperature', value: nz });
  const bd = rangeText(e.minBed, e.maxBed); if (bd) rows.push({ label: 'Bed temperature', value: bd });
  if (e.density != null) rows.push({ label: 'Density', value: `${e.density} g/cm³` });
  if (e.td != null) rows.push({ label: 'Transmission distance', value: `${e.td}`, note: FUTURE_TRANSLUCENCY_NOTE });
  if (e.ri != null) rows.push({ label: 'Refractive index', value: `${e.ri}`, note: FUTURE_TRANSLUCENCY_NOTE });
  return rows;
}

const midpoint = (lo, hi) => (lo != null && hi != null ? Math.trunc((lo + hi) / 2) : lo ?? hi ?? null);
export function defaultNozzleFor(material) {
  const m = String(material).toUpperCase();
  return m === 'PETG' ? 235 : m === 'ABS' || m === 'ASA' ? 250 : 220;
}
export function defaultBedFor(material) {
  const m = String(material).toUpperCase();
  return m === 'PETG' ? 70 : m === 'ABS' || m === 'ASA' ? 90 : m === 'TPU' ? 50 : 60;
}

/**
 * libraryEntryToProfile, applied to a web slot: colour, material, name and the
 * midpoint temperatures (material defaults where the catalogue has none).
 */
export function libraryEntryToSlot(e, existing = {}) {
  const base = {
    nozzleTemp: existing.nozzleTemp ?? defaultNozzleFor(e.material),
    bedTemp: existing.bedTemp ?? defaultBedFor(e.material),
    color: existing.color ?? '#FFFFFF',
  };
  return {
    ...existing,
    name: displayName(e),
    vendor: e.brand,
    materialType: e.material || existing.materialType || 'PLA',
    color: e.hex ?? base.color,
    nozzleTemp: midpoint(e.minNozzle, e.maxNozzle) ?? (existing.name ? base.nozzleTemp : defaultNozzleFor(e.material)),
    bedTemp: midpoint(e.minBed, e.maxBed) ?? (existing.name ? base.bedTemp : defaultBedFor(e.material)),
    librarySlug: e.slug,
  };
}
