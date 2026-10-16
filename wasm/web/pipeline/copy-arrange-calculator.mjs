// Port of app/src/main/java/com/u1/slicer/model/CopyArrangeCalculator.kt.
// Bed placement maths: copy grids, wipe-tower auto-position, rotated footprints
// (B109), multi-object packing (F77) and translation-only auto-arrange (F92).
//
// Kotlin FloatArray -> Float32Array (inputs may be any array-like of numbers);
// Kotlin Pair<Float, Float> -> [a, b]. Float arithmetic is rounded to float32
// (Math.fround) at each Kotlin Float operation so results match the app bit-for-bit.
const f = Math.fround;
const MAX_FLOAT = 3.4028234663852886e38; // Float.MAX_VALUE
const coerceIn = (v, lo, hi) => {
  if (lo > hi) throw new RangeError(`Cannot coerce value to an empty range: maximum ${hi} is less than minimum ${lo}.`);
  return v < lo ? lo : v > hi ? hi : v;
};
const toInt = (x) => (Number.isNaN(x) ? 0 : Math.trunc(x));

/**
 * Grid positions for copies of one object, centered on the bed. Returns flat
 * Float32Array [x0, y0, x1, y1, ...] (min-corner, mm) for setModelInstances().
 * Copies are capped at the bed's grid capacity.
 */
export function calculate(objectSizeX, objectSizeY, copyCount, bedSizeX = 270, bedSizeY = 270, margin = 5) {
  if (!(objectSizeX > 0 && objectSizeY > 0)) throw new Error('Object dimensions must be positive');
  if (!(copyCount >= 1)) throw new Error('Copy count must be at least 1');
  const sx = f(objectSizeX), sy = f(objectSizeY), bx = f(bedSizeX), by = f(bedSizeY), m = f(margin);

  // Single copy: center on the bed (clamped to 0 for oversized models)
  if (copyCount === 1) {
    return Float32Array.of(Math.max(0, f(f(bx - sx) / 2)), Math.max(0, f(f(by - sy) / 2)));
  }

  // Multiple copies: arrange in a centered grid
  const colCount = Math.max(1, toInt(f(f(bx + m) / f(sx + m))));
  const rowCount = Math.max(1, toInt(f(f(by + m) / f(sy + m))));
  const actualCount = Math.min(copyCount, colCount * rowCount);
  const usedRows = Math.min(rowCount, Math.trunc((actualCount + colCount - 1) / colCount));
  const usedCols = actualCount <= colCount ? actualCount : colCount;

  const gridWidth = f(f(usedCols * sx) + f((usedCols - 1) * m));
  const gridHeight = f(f(usedRows * sy) + f((usedRows - 1) * m));
  const offsetX = Math.max(0, f(f(bx - gridWidth) / 2));
  const offsetY = Math.max(0, f(f(by - gridHeight) / 2));

  const positions = new Float32Array(actualCount * 2);
  for (let i = 0; i < actualCount; i++) {
    const col = i % colCount;
    const row = Math.trunc(i / colCount);
    positions[i * 2] = f(offsetX + f(col * f(sx + m)));
    positions[i * 2 + 1] = f(offsetY + f(row * f(sy + m)));
  }
  return positions;
}

/** Grid capacity for the object on the bed (1 for non-positive sizes). */
export function maxCopies(objectSizeX, objectSizeY, bedSizeX = 270, bedSizeY = 270, margin = 5) {
  if (objectSizeX <= 0 || objectSizeY <= 0) return 1;
  const m = f(margin);
  const cols = Math.max(1, toInt(f(f(f(bedSizeX) + m) / f(f(objectSizeX) + m))));
  const rows = Math.max(1, toInt(f(f(f(bedSizeY) + m) / f(f(objectSizeY) + m))));
  return cols * rows;
}

/** Warning text when [count] copies exceed the bed's grid capacity, else null (B65: warn, not block). */
export function copyBedWarning(objectSizeX, objectSizeY, count, bedSizeX = 270, bedSizeY = 270, margin = 5) {
  if (count <= 1) return null;
  const max = maxCopies(objectSizeX, objectSizeY, bedSizeX, bedSizeY, margin);
  return count > max ? `Copies may overlap or exceed bed (max ${max} for this size)` : null;
}

// Eight perimeter candidates. F75 (GitHub #90): back-of-bed first so that on a
// clearance tie the back position wins; a model at the back still loses to the
// front candidates on raw clearance.
function towerCandidates(towerWidth, towerDepth, bedSizeX, bedSizeY) {
  const bedCenter = f(bedSizeX / 2);
  // prime_tower_brim_width (3) + skirt_distance (6) + 1 skirt loop (~0.5) ≈ 9.5 -> 10mm
  const edgeMargin = 10;
  const backY = f(f(bedSizeY - towerDepth) - edgeMargin);
  const rightX = f(f(bedSizeX - towerWidth) - edgeMargin);
  const centerX = f(bedCenter - f(towerWidth / 2));
  const centerY = f(bedCenter - f(towerDepth / 2));
  return [
    [centerX, backY], // top-center (back, default)
    [edgeMargin, backY], // top-left
    [rightX, backY], // top-right
    [edgeMargin, centerY], // left-center
    [rightX, centerY], // right-center
    [centerX, edgeMargin], // bottom-center
    [edgeMargin, edgeMargin], // bottom-left
    [rightX, edgeMargin], // bottom-right
  ];
}

function pickTowerCandidate(candidates, objectBoxes, towerWidth, towerDepth) {
  let best = candidates[0];
  let bestMinDist = -Infinity;
  for (const [cx, cy] of candidates) {
    const tMaxX = f(cx + towerWidth), tMaxY = f(cy + towerDepth);
    let minDist = MAX_FLOAT;
    for (const [oMinX, oMinY, oMaxX, oMaxY] of objectBoxes) {
      // Signed distance: negative = overlapping
      const dx = Math.max(f(oMinX - tMaxX), f(cx - oMaxX), 0);
      const dy = Math.max(f(oMinY - tMaxY), f(cy - oMaxY), 0);
      let dist;
      if (dx === 0 && dy === 0) {
        const overlapX = Math.min(f(tMaxX - oMinX), f(oMaxX - cx));
        const overlapY = Math.min(f(tMaxY - oMinY), f(oMaxY - cy));
        dist = -Math.min(overlapX, overlapY);
      } else {
        dist = f(dx + dy);
      }
      minDist = Math.min(minDist, dist);
    }
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      best = [cx, cy];
    }
  }
  return best;
}

/**
 * Wipe tower position that avoids the model(s): the perimeter candidate with
 * the most clearance from every object box. towerDepth defaults to towerWidth.
 * @returns {[number, number]} [towerX, towerY] mm
 */
export function computeWipeTowerPosition(
  objectPositions, objectSizeX, objectSizeY, towerWidth = 60, towerDepth = towerWidth, bedSizeX = 270, bedSizeY = 270,
) {
  const tw = f(towerWidth), td = f(towerDepth);
  const candidates = towerCandidates(tw, td, f(bedSizeX), f(bedSizeY));
  const objectCount = Math.trunc(objectPositions.length / 2);
  const boxes = [];
  for (let i = 0; i < objectCount; i++) {
    const ox = f(objectPositions[i * 2]), oy = f(objectPositions[i * 2 + 1]);
    boxes.push([ox, oy, f(ox + f(objectSizeX)), f(oy + f(objectSizeY))]);
  }
  return pickTowerCandidate(candidates, boxes, tw, td);
}

/**
 * Per-object overload: each object's footprint comes from [objectBoxes]
 * (flat [sX0,sY0,sZ0,...], getObjectBoundingBoxes format).
 */
export function computeWipeTowerPositionForObjects(
  objectPositions, objectBoxes, towerWidth = 60, towerDepth = towerWidth, bedSizeX = 270, bedSizeY = 270,
) {
  const objectCount = Math.min(Math.trunc(objectPositions.length / 2), Math.trunc(objectBoxes.length / 3));
  if (objectCount === 0) return computeWipeTowerPosition([], 0, 0, towerWidth, towerDepth, bedSizeX, bedSizeY);
  const tw = f(towerWidth), td = f(towerDepth);
  const candidates = towerCandidates(tw, td, f(bedSizeX), f(bedSizeY));
  const boxes = [];
  for (let i = 0; i < objectCount; i++) {
    const ox = f(objectPositions[i * 2]), oy = f(objectPositions[i * 2 + 1]);
    boxes.push([ox, oy, f(ox + f(objectBoxes[i * 3])), f(oy + f(objectBoxes[i * 3 + 1]))]);
  }
  return pickTowerCandidate(candidates, boxes, tw, td);
}

/**
 * B109 single source of truth for the effective XY placement footprint: the live
 * native preview-mesh AABB (pre-scale) when available — it reflects the real rotated
 * geometry the renderer draws — else the box-rotation approximation, times scale.
 * @param {[number, number]|null} rotatedMeshSizeXY
 * @returns {[number, number]}
 */
export function effectivePlacementFootprint(
  rotatedMeshSizeXY, loadTimeSizeX, loadTimeSizeY, loadTimeSizeZ, scaleX, scaleY, rotationXDeg, rotationYDeg, rotationZDeg,
) {
  if (rotatedMeshSizeXY != null) {
    return [f(f(rotatedMeshSizeXY[0]) * f(scaleX)), f(f(rotatedMeshSizeXY[1]) * f(scaleY))];
  }
  const [rotW, rotH] = computeRotatedFootprint(
    loadTimeSizeX, loadTimeSizeY, loadTimeSizeZ, rotationXDeg, rotationYDeg, rotationZDeg);
  return [f(rotW * f(scaleX)), f(rotH * f(scaleY))];
}

/**
 * Axis-aligned XY footprint of a box after ZYX Euler rotation (R = Rz*Ry*Rx,
 * the native setModelRotation convention).
 * @returns {[number, number]} [width, depth]
 */
export function computeRotatedFootprint(sizeX, sizeY, sizeZ, rxDeg, ryDeg, rzDeg) {
  if (rxDeg == 0 && ryDeg == 0 && rzDeg == 0) return [f(sizeX), f(sizeY)];

  const rx = (f(rxDeg) * Math.PI) / 180.0;
  const ry = (f(ryDeg) * Math.PI) / 180.0;
  const rz = (f(rzDeg) * Math.PI) / 180.0;
  const cxR = Math.cos(rx), sxR = Math.sin(rx);
  const cyR = Math.cos(ry), syR = Math.sin(ry);
  const czR = Math.cos(rz), szR = Math.sin(rz);

  const r00 = cyR * czR;
  const r01 = czR * sxR * syR - cxR * szR;
  const r02 = cxR * czR * syR + sxR * szR;
  const r10 = cyR * szR;
  const r11 = cxR * czR + sxR * syR * szR;
  const r12 = cxR * syR * szR - czR * sxR;

  const hw = f(sizeX) / 2.0, hh = f(sizeY) / 2.0, hd = f(sizeZ) / 2.0;
  let minX = Number.MAX_VALUE, maxX = -Number.MAX_VALUE;
  let minY = Number.MAX_VALUE, maxY = -Number.MAX_VALUE;
  for (const bx of [-hw, hw]) {
    for (const by of [-hh, hh]) {
      for (const bz of [-hd, hd]) {
        const nx = r00 * bx + r01 * by + r02 * bz;
        const ny = r10 * bx + r11 * by + r12 * bz;
        if (nx < minX) minX = nx;
        if (nx > maxX) maxX = nx;
        if (ny < minY) minY = ny;
        if (ny > maxY) maxY = ny;
      }
    }
  }
  return [f(maxX - minX), f(maxY - minY)];
}

/**
 * Places a newly added Nth object without disturbing objects 0..N-2: to the right
 * of the rightmost existing object (aligned to its Y), else below all of them.
 * @param currentPositions flat [x0,y0,...] for the N-1 placed objects
 * @param boxes flat [sX0,sY0,sZ0,...] for ALL N objects
 * @returns {Float32Array}
 */
export function placeAdditionalObject(currentPositions, boxes, bedSize = 270, bedSizeY = bedSize, margin = 5) {
  const bs = f(bedSize), bsy = f(bedSizeY), m = f(margin);
  const objectCount = Math.trunc(boxes.length / 3);
  if (objectCount <= 1) {
    if (currentPositions.length >= 2) return Float32Array.from(currentPositions);
    return Float32Array.of(Math.max(0, f(f(bs - f(boxes[0])) / 2)), Math.max(0, f(f(bsy - f(boxes[1])) / 2)));
  }
  const existingCount = Math.trunc(currentPositions.length / 2);
  const newIdx = objectCount - 1;
  const newSizeX = f(boxes[newIdx * 3]);
  const newSizeY = f(boxes[newIdx * 3 + 1]);

  const result = new Float32Array(objectCount * 2);
  // Kotlin copyInto throws if existing positions exceed the new array; same here via set().
  result.set(Array.from(currentPositions).slice(0, Math.min(currentPositions.length, existingCount * 2)), 0);

  // Find rightmost X edge; use that object's Y for alignment
  let maxRight = 0;
  let alignY = m;
  for (let i = 0; i < existingCount; i++) {
    const right = f(result[i * 2] + f(boxes[i * 3]));
    if (right > maxRight) { maxRight = right; alignY = result[i * 2 + 1]; }
  }

  const tryX = f(maxRight + m);
  if (f(tryX + newSizeX) <= bs) {
    result[newIdx * 2] = tryX;
    result[newIdx * 2 + 1] = alignY;
    return result;
  }

  // Doesn't fit to the right — place below all existing objects
  let maxBottom = 0;
  let leftX = m;
  for (let i = 0; i < existingCount; i++) {
    const bottom = f(result[i * 2 + 1] + f(boxes[i * 3 + 1]));
    if (bottom > maxBottom) { maxBottom = bottom; leftX = result[i * 2]; }
  }
  result[newIdx * 2] = coerceIn(leftX, m, Math.max(m, f(f(bs - newSizeX) - m)));
  result[newIdx * 2 + 1] = Math.min(f(maxBottom + m), Math.max(m, f(f(bsy - newSizeY) - m)));
  return result;
}

/**
 * F77 initial row-packing for N distinct objects: left-to-right with [margin]
 * gaps, wrapping rows on overflow. boxes = flat [sX0,sY0,sZ0,...].
 * @returns {Float32Array} flat [x0,y0,...]
 */
export function buildMultiObjectPositions(boxes, bedSize = 270, bedSizeY = bedSize, margin = 5) {
  const bs = f(bedSize), bsy = f(bedSizeY), m = f(margin);
  const count = Math.trunc(boxes.length / 3);
  if (count === 0) return new Float32Array(0);
  const positions = new Float32Array(count * 2);
  let curX = m, curY = m, rowMaxY = 0;
  for (let i = 0; i < count; i++) {
    const sizeX = f(boxes[i * 3]);
    const sizeY = f(boxes[i * 3 + 1]);
    if (i > 0 && f(curX + sizeX) > f(bs - m)) {
      curX = m;
      curY = f(curY + f(rowMaxY + m));
      rowMaxY = 0;
    }
    positions[i * 2] = Math.min(curX, Math.max(m, f(f(bs - sizeX) - m)));
    positions[i * 2 + 1] = Math.min(curY, Math.max(m, f(f(bsy - sizeY) - m)));
    curX = f(curX + f(sizeX + m));
    if (sizeY > rowMaxY) rowMaxY = sizeY;
  }
  return positions;
}

/**
 * F92 translation-only auto-arrange: next-fit shelf packing (largest area first,
 * stable by index), skipping placements that overlap [reservedRect]
 * ([minX,minY,maxX,maxY], already margin-inflated, or null) or leave the bed.
 * Objects that cannot be placed keep their [incoming] position and are counted
 * in overflowCount — never placed off-bed (B135).
 * @returns {{positions: Float32Array, overflowCount: number}} ArrangeResult
 */
export function autoArrange(boxes, reservedRect, incoming, bedSize = 270, bedSizeY = bedSize, margin = 5) {
  const n = Math.trunc(boxes.length / 3);
  if (n === 0) return { positions: new Float32Array(0), overflowCount: 0 };
  const bs = f(bedSize), bsy = f(bedSizeY), m = f(margin);
  const rr = reservedRect == null ? null : Array.from(reservedRect, f);

  const positions = new Float32Array(n * 2);
  // Seed from incoming so overflow objects keep a sane (existing) position.
  for (let i = 0; i < n; i++) {
    positions[i * 2] = i * 2 < incoming.length ? incoming[i * 2] : m;
    positions[i * 2 + 1] = i * 2 + 1 < incoming.length ? incoming[i * 2 + 1] : m;
  }

  const maxEdgeX = f(bs - m);
  const maxEdgeY = f(bsy - m);
  // Generous worst-case bound so the loop can never spin.
  const maxIters = toInt(f(Math.max(bs, bsy) / Math.max(m, 1))) * 3 + 16;
  const area = (i) => f(f(boxes[i * 3]) * f(boxes[i * 3 + 1]));
  const order = [...Array(n).keys()].sort((a, b) => area(b) - area(a) || a - b);

  let curX = m, curY = m, rowMaxY = 0, overflow = 0;
  for (const idx of order) {
    const sx = f(boxes[idx * 3]);
    const sy = f(boxes[idx * 3 + 1]);
    // Physically too large to ever fit on the bed.
    if (sx > f(bs - 2 * m) || sy > f(bsy - 2 * m)) { overflow++; continue; }

    let placed = false;
    let guard = 0;
    while (guard++ < maxIters) {
      if (f(curX + sx) > maxEdgeX) {
        curX = m;
        curY = f(curY + f(rowMaxY + m));
        rowMaxY = 0;
      }
      if (f(curY + sy) > maxEdgeY) break;
      const cMaxX = f(curX + sx);
      const cMaxY = f(curY + sy);
      if (rr != null && curX < rr[2] && cMaxX > rr[0] && curY < rr[3] && cMaxY > rr[1]) {
        // Overlaps the keep-out — skip past it on this shelf and retry.
        curX = f(rr[2] + m);
        continue;
      }
      positions[idx * 2] = curX;
      positions[idx * 2 + 1] = curY;
      curX = f(curX + f(sx + m));
      if (sy > rowMaxY) rowMaxY = sy;
      placed = true;
      break;
    }
    if (!placed) overflow++;
  }
  return { positions, overflowCount: overflow };
}

export const CopyArrangeCalculator = {
  calculate, maxCopies, copyBedWarning, computeWipeTowerPosition, computeWipeTowerPositionForObjects,
  effectivePlacementFootprint, computeRotatedFootprint, placeAdditionalObject, buildMultiObjectPositions, autoArrange,
};
