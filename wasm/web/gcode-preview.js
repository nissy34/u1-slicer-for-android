// G-code -> 3D preview buffers. Classic script so the worker can importScripts()
// it and parse off the UI thread; also loadable as a plain <script> for tests.
//
// Output (all transferable):
//   positions   Float32Array  x,y,z per vertex, 2 vertices per extrusion segment
//   features    Uint8Array    feature index per segment (see FEATURES)
//   tools       Uint8Array    tool (T#) per segment
//   layerEnds   Uint32Array   segment count at the end of each layer (for draw ranges)
//   layerZ      Float32Array  Z of each layer
//   bounds      [minX, minY, minZ, maxX, maxY, maxZ]
//
// Arcs (G2/G3) are drawn as their chord; Orca's U1 profile emits few of them.
(function (root) {
  const FEATURES = [
    'Other', 'Outer wall', 'Inner wall', 'Overhang wall', 'Sparse infill', 'Internal solid infill',
    'Top surface', 'Bottom surface', 'Bridge', 'Internal Bridge', 'Gap infill', 'Skirt', 'Brim',
    'Support', 'Support interface', 'Support transition', 'Prime tower', 'Ironing', 'Custom',
  ];
  const FEATURE_INDEX = Object.fromEntries(FEATURES.map((f, i) => [f, i]));

  function parseGcodePreview(text) {
    let cap = 1 << 16, n = 0;
    let pos = new Float32Array(cap * 6), feat = new Uint8Array(cap), tool = new Uint8Array(cap);
    const layerEnds = [], layerZ = [];
    let x = 0, y = 0, z = 0, e = 0, relE = false, absXY = true;
    let curFeat = 0, curTool = 0, pendingLayer = false;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const grow = () => {
      cap *= 2;
      const p = new Float32Array(cap * 6); p.set(pos); pos = p;
      const f = new Uint8Array(cap); f.set(feat); feat = f;
      const t = new Uint8Array(cap); t.set(tool); tool = t;
    };

    let start = 0;
    const len = text.length;
    while (start < len) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = len;
      const c0 = text.charCodeAt(start);
      if (c0 === 59 /* ; */) {
        if (text.startsWith(';TYPE:', start)) {
          const name = text.slice(start + 6, end).trim();
          curFeat = FEATURE_INDEX[name] ?? 0;
        } else if (text.startsWith(';LAYER_CHANGE', start)) {
          if (layerZ.length) layerEnds.push(n);
          pendingLayer = true;
        } else if (pendingLayer && text.startsWith(';Z:', start)) {
          layerZ.push(parseFloat(text.slice(start + 3, end)));
          pendingLayer = false;
        }
      } else if (c0 === 71 /* G */) {
        const g = text.charCodeAt(start + 1), g2 = text.charCodeAt(start + 2);
        // G0 / G1 / G2 / G3 followed by a space
        if (g2 === 32 && g >= 48 && g <= 51) {
          const semi = text.indexOf(';', start);
          const line = text.slice(start + 3, semi >= 0 && semi < end ? semi : end);
          let nx = x, ny = y, nz = z, ne = null;
          for (const w of line.split(' ')) {
            if (!w) continue;
            const v = parseFloat(w.slice(1));
            switch (w.charCodeAt(0)) {
              case 88: nx = absXY ? v : x + v; break; // X
              case 89: ny = absXY ? v : y + v; break; // Y
              case 90: nz = absXY ? v : z + v; break; // Z
              case 69: ne = v; break; // E
            }
          }
          let extruding = false;
          if (ne !== null) {
            extruding = relE ? ne > 0 : ne > e;
            if (!relE) e = ne;
          }
          if (extruding && g !== 48 && (nx !== x || ny !== y)) {
            if (n === cap) grow();
            const o = n * 6;
            pos[o] = x; pos[o + 1] = y; pos[o + 2] = nz;
            pos[o + 3] = nx; pos[o + 4] = ny; pos[o + 5] = nz;
            feat[n] = curFeat; tool[n] = curTool; n++;
            if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
            if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (nz < minZ) minZ = nz; if (nz > maxZ) maxZ = nz;
          }
          x = nx; y = ny; z = nz;
        } else if (text.startsWith('G92', start)) {
          const m = /E(-?[\d.]+)/.exec(text.slice(start, end));
          if (m) e = parseFloat(m[1]);
        } else if (text.startsWith('G90', start)) {
          absXY = true;
        } else if (text.startsWith('G91', start)) {
          absXY = false;
        }
      } else if (c0 === 77 /* M */) {
        if (text.startsWith('M83', start)) relE = true;
        else if (text.startsWith('M82', start)) relE = false;
      } else if (c0 === 84 /* T */) {
        const t = parseInt(text.slice(start + 1, end), 10);
        if (!Number.isNaN(t)) curTool = t;
      }
      start = end + 1;
    }
    if (layerZ.length) layerEnds.push(n);
    return {
      positions: pos.slice(0, n * 6),
      features: feat.slice(0, n),
      tools: tool.slice(0, n),
      layerEnds: Uint32Array.from(layerEnds),
      layerZ: Float32Array.from(layerZ),
      segments: n,
      bounds: n ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 270, 270, 0],
    };
  }

  root.GCODE_FEATURES = FEATURES;
  root.parseGcodePreview = parseGcodePreview;
  if (typeof module !== 'undefined') module.exports = { parseGcodePreview, FEATURES };
})(typeof self !== 'undefined' ? self : globalThis);
