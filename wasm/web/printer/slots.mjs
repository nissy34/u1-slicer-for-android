// The U1's four filament slots as the web tab keeps them (per viewer), plus the
// RFID sync preview — a port of printer/SyncPreview.kt (buildSyncPreviewEntries
// / applySyncPreviewEntries) and data/ExtruderPreset.kt. The U1 keeps its fixed
// four logical slots, so the Bambu all-routes branch is not ported.
import { defaultBedFor, defaultNozzleFor, displayName, matchLibrary } from './filament-library.mjs';

export const SLOT_COUNT = 4;
/** ExtruderPreset.DEFAULT_COLORS: red, green, blue, white. */
export const DEFAULT_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'];

export function defaultSlot(i) {
  return { index: i, color: DEFAULT_COLORS[i] ?? '#FFFFFF', materialType: 'PLA', name: '', vendor: '', subType: '', nozzleTemp: defaultNozzleFor('PLA'), bedTemp: defaultBedFor('PLA'), librarySlug: null };
}
export const defaultSlots = () => Array.from({ length: SLOT_COUNT }, (_, i) => defaultSlot(i));
export const slotLabel = (s) => `E${s.index + 1}`;

/** parseExtruderPresets: tolerant decode; fills missing slots with defaults, 4 max. */
export function parseSlots(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return defaultSlots(); }
  if (!Array.isArray(arr)) return defaultSlots();
  const out = defaultSlots();
  for (const o of arr) {
    const i = Number(o?.index);
    if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) continue;
    const hex = /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toUpperCase() : out[i].color;
    out[i] = {
      ...out[i],
      color: hex,
      materialType: typeof o.materialType === 'string' && o.materialType ? o.materialType : 'PLA',
      name: typeof o.name === 'string' ? o.name : '',
      vendor: typeof o.vendor === 'string' ? o.vendor : '',
      subType: typeof o.subType === 'string' ? o.subType : '',
      nozzleTemp: Number.isFinite(o.nozzleTemp) ? o.nozzleTemp : defaultNozzleFor(o.materialType ?? 'PLA'),
      bedTemp: Number.isFinite(o.bedTemp) ? o.bedTemp : defaultBedFor(o.materialType ?? 'PLA'),
      librarySlug: typeof o.librarySlug === 'string' ? o.librarySlug : null,
    };
  }
  return out;
}
export const serializeSlots = (slots) => JSON.stringify(slots);

/**
 * buildSyncPreviewEntries: one entry per U1 slot; loaded printer slots are run
 * through the library matcher, and a confident match replaces the raw RFID
 * colour/type and carries its name. No match / no library → raw values.
 */
export function buildSyncPreviewEntries(slots, printerSlots, library) {
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    const cur = slots.find((s) => s.index === i) ?? defaultSlot(i);
    const ps = printerSlots.find((s) => s.index === i) ?? null;
    const m = library && ps?.loaded
      ? matchLibrary(library, { vendor: ps.manufacturer, material: ps.materialType, subType: ps.subType, hex: ps.color })
      : null;
    return {
      slotIndex: i,
      label: ps?.label ?? `E${i + 1}`,
      currentColor: cur.color,
      newColor: m?.entry.hex ?? ps?.color ?? null,
      currentType: cur.materialType,
      newType: m?.entry.material ?? ps?.materialType ?? null,
      loaded: ps?.loaded ?? null,
      vendor: ps?.manufacturer ?? '',
      subType: ps?.subType ?? '',
      matchedSlug: m?.entry.slug ?? null,
      matchedName: m ? displayName(m.entry) : null,
    };
  });
}

/** applySyncPreviewEntries; a type change also resets temps to the material defaults. */
export function applySyncPreviewEntries(slots, entries, { applyColors, applyTypes }) {
  const cur = new Map(slots.map((s) => [s.index, { ...s }]));
  for (const e of entries) {
    const base = cur.get(e.slotIndex);
    if (!base) continue;
    const typing = applyTypes && e.newType != null;
    const next = {
      ...base,
      color: applyColors && e.newColor != null ? e.newColor : base.color,
      materialType: typing ? e.newType : base.materialType,
    };
    if (typing && e.newType !== base.materialType) {
      next.nozzleTemp = defaultNozzleFor(e.newType);
      next.bedTemp = defaultBedFor(e.newType);
    }
    if (applyColors || applyTypes) {
      next.name = e.matchedName ?? (e.vendor ? `${e.vendor} ${e.newType ?? ''}`.trim() : base.name);
      next.vendor = e.vendor || base.vendor;
      next.subType = e.subType || base.subType;
      next.librarySlug = e.matchedSlug ?? (typing ? null : base.librarySlug);
    }
    cur.set(e.slotIndex, next);
  }
  return [...cur.values()].sort((a, b) => a.index - b.index);
}
