// Port of app/src/main/java/com/u1/slicer/bambu/NativePlateState.kt plus the
// plate-selection helpers SlicerViewModel.readPlateStateFromNative and
// buildThreeMfInfoFromNative (Phase 1 "native-first" plate state: after a
// plate's embedded 3MF is loaded, the per-plate ThreeMfInfo is derived from
// what the engine actually loaded, narrowed through the canonical filament list).
import { copyThreeMfInfo } from './three-mf-info.mjs';

const sortedSet = (iterable) => new Set([...iterable].sort((a, b) => a - b));

/** NativePlateState.parseVolumeMapJson: { usedExtruders: Set, hasPaintData, objects }. */
export function parseVolumeMapJson(json) {
  const empty = { usedExtruders: new Set(), hasPaintData: false, objects: [] };
  if (json == null || !String(json).trim()) return empty;
  const arr = JSON.parse(json);
  const objects = [];
  const allExtruders = new Set();
  let hasPaint = false;
  const optInt = (o, k, d) => (Number.isFinite(Number(o?.[k])) && o?.[k] !== null && o?.[k] !== '' ? Math.trunc(Number(o[k])) : d);
  const optBool = (o, k) => o?.[k] === true || o?.[k] === 'true';
  arr.forEach((objJson, i) => {
    if (!objJson || typeof objJson !== 'object') return;
    const objExt = optInt(objJson, 'objectExtruder', 0);
    if (!Array.isArray(objJson.volumes)) return;
    const volumes = [];
    objJson.volumes.forEach((vj, j) => {
      if (!vj || typeof vj !== 'object') return;
      const volExt = optInt(vj, 'extruder', -1);
      const mmPainted = optBool(vj, 'isMmPainted');
      volumes.push({ volumeIndex: optInt(vj, 'volumeIndex', j), extruder: volExt, isMmPainted: mmPainted,
        isSeamPainted: optBool(vj, 'isSeamPainted') });
      const effective = volExt > 0 ? volExt : objExt;
      if (effective > 0) allExtruders.add(effective);
      if (mmPainted) hasPaint = true;
    });
    objects.push({ objectIndex: optInt(objJson, 'objectIndex', i), objectExtruder: objExt, volumes });
  });
  return { usedExtruders: sortedSet(allExtruders), hasPaintData: hasPaint, objects };
}

/** NativePlateState.buildObjectExtruderMap: objectIndex (string) -> max volume extruder. */
export function buildObjectExtruderMap(state) {
  const map = new Map();
  for (const obj of state.objects) {
    const exts = obj.volumes.map((v) => (v.extruder > 0 ? v.extruder : obj.objectExtruder)).filter((e) => e > 0);
    map.set(String(obj.objectIndex), exts.length ? Math.max(...exts) : obj.objectExtruder);
  }
  return map;
}

/**
 * SlicerViewModel.readPlateStateFromNative, against the wasm engine
 * (allVolumeExtrudersJson / paintStateCountsJson = the app's JNI accessors).
 */
export function readPlateStateFromNative(engine) {
  const parsed = parseVolumeMapJson(engine.allVolumeExtrudersJson());
  const paintExtruders = new Set();
  for (const obj of parsed.objects) {
    for (const vol of obj.volumes) {
      if (!vol.isMmPainted && parsed.hasPaintData) continue;
      const raw = engine.paintStateCountsJson(obj.objectIndex, vol.volumeIndex, 0);
      if (!raw) continue;
      const counts = JSON.parse(raw);
      for (let k = 0; k + 1 < counts.length; k += 2) {
        if (counts[k] > 0 && counts[k + 1] > 0) paintExtruders.add(counts[k]);
      }
    }
  }
  if (!paintExtruders.size) return parsed;
  return { ...parsed, usedExtruders: sortedSet([...parsed.usedExtruders, ...paintExtruders]), hasPaintData: true };
}

/** SlicerViewModel.buildThreeMfInfoFromNative (Phase 2 §4 canonical-driven plate narrowing). */
export function buildThreeMfInfoFromNative(fileInfo, nativeState, plateId, canonical) {
  const usedExtruders = nativeState.usedExtruders;
  const objExtruderMap = buildObjectExtruderMap(nativeState);
  const sourcePlate = fileInfo.plates.find((p) => p.plateId === plateId) ?? null;
  const plateHasPaintData = nativeState.hasPaintData;
  const plateHasLayerToolChanges = sourcePlate?.hasLayerToolChanges ?? fileInfo.hasLayerToolChanges;

  const sourcePlateObjectExtruders = new Set(sourcePlate
    ? sourcePlate.objectIds.flatMap((objectId) => {
      const perPart = [...(fileInfo.objectPartExtruders.get(objectId) ?? [])];
      if (perPart.length) return perPart;
      const e = fileInfo.objectExtruderMap.get(objectId);
      return e != null ? [e] : [];
    }).filter((e) => e > 0)
    : []);
  const pos = (s) => [...(s ?? [])].filter((e) => e > 0);

  let enriched;
  if (fileInfo.hasLayerToolChanges && sourcePlate) {
    if (usedExtruders.size) {
      enriched = plateHasPaintData
        ? sortedSet([...usedExtruders, ...pos(sourcePlate.paintExtruderStates), ...pos(sourcePlate.filamentMapSlots),
          ...sourcePlateObjectExtruders])
        : sortedSet(usedExtruders);
    } else {
      enriched = sortedSet([...pos(sourcePlate.layerToolExtruders), ...pos(sourcePlate.filamentMapSlots),
        ...sourcePlateObjectExtruders]);
    }
  } else if (sourcePlateObjectExtruders.size) {
    enriched = sortedSet([...usedExtruders, ...sourcePlateObjectExtruders, ...pos(sourcePlate?.filamentMapSlots)]);
  } else {
    enriched = sortedSet([...usedExtruders, ...pos(sourcePlate?.filamentMapSlots)]);
  }

  let narrowedColors;
  if (canonical && canonical.size > 0) {
    const usedFileIndices = sortedSet([...enriched].map((ext) => canonical.paintStateMap.get(ext) ?? ext - 1)
      .filter((idx) => idx >= 0 && idx < canonical.size));
    narrowedColors = [...usedFileIndices].map((i) => canonical.filaments[i].color);
  } else if (enriched.size && fileInfo.detectedColors.length > 1) {
    const c = [...enriched].map((idx) => fileInfo.detectedColors[idx - 1]).filter((x) => x != null);
    narrowedColors = c.length ? c : fileInfo.detectedColors;
  } else {
    narrowedColors = fileInfo.detectedColors;
  }
  const paletteColors = narrowedColors.length ? narrowedColors : fileInfo.detectedColors;
  const paletteCount = Math.max(1, Math.max(paletteColors.length, fileInfo.detectedExtruderCount));
  const volumeExtrudersForPlate = new Set([...usedExtruders, ...objExtruderMap.values()].filter((e) => e > 0));
  return copyThreeMfInfo(fileInfo, {
    plates: sourcePlate ? [sourcePlate] : [],
    detectedColors: paletteColors,
    usedExtruderIndices: enriched,
    volumeExtruders: volumeExtrudersForPlate,
    detectedExtruderCount: paletteCount,
    hasPaintData: plateHasPaintData,
    objectExtruderMap: objExtruderMap,
    hasLayerToolChanges: plateHasLayerToolChanges,
    hasPaintSupports: fileInfo.hasPaintSupports,
  });
}

/** BambuPlateStateEnrichment.foldToPhysicalSlot: paint states > 4 fold onto the 4 U1 slots. */
export const foldToPhysicalSlot = (state) => (state > 4 ? ((state - 1) % 4) + 1 : state);

/**
 * BambuPlateStateEnrichment.enrich: the plate's used extruders folded to physical
 * slots, from native volumes + source per-part extruders + paint + layer tools + filament_maps.
 */
export function enrichPlateState(state, sourcePlate, fileInfo, engine) {
  const perPart = new Set((sourcePlate?.objectIds ?? []).flatMap((id) => {
    const parts = [...(fileInfo.objectPartExtruders.get(id) ?? [])];
    if (parts.length) return parts;
    const e = fileInfo.objectExtruderMap.get(id);
    return e != null ? [e] : [];
  }).filter((e) => e > 0));
  const paint = new Set();
  for (const obj of state.objects) {
    for (const vol of obj.volumes) {
      const raw = engine.paintStateCountsJson(obj.objectIndex, vol.volumeIndex, 0);
      if (!raw) continue;
      const counts = JSON.parse(raw);
      for (let k = 0; k + 1 < counts.length; k += 2) if (counts[k] > 0 && counts[k + 1] > 0) paint.add(counts[k]);
    }
  }
  const pos = (s) => [...(s ?? [])].filter((e) => e > 0);
  return sortedSet([...state.usedExtruders, ...perPart, ...paint, ...pos(sourcePlate?.layerToolExtruders),
    ...pos(sourcePlate?.filamentMapSlots)].map(foldToPhysicalSlot).filter((e) => e > 0));
}
