// Runs the wasm engine and the app's model pipeline (pipeline/session.mjs) off
// the main thread. Slicing blocks for seconds and the engine's pthreads need
// Atomics.wait, which browsers forbid on the UI thread.
//
// Protocol (postMessage). Every request carries an `id`; the reply echoes it.
//   -> { type: 'load', name, bytes: ArrayBuffer }       load a model (3MF pipeline runs here)
//   -> { type: 'plate', plateId }                       pick a plate of a multi-plate 3MF
//   -> { type: 'settings', presets, slotTemps, overrides, config }   slot materials + settings
//   -> { type: 'mapping', mapping } | { type: 'extruder', index }    colours -> slots
//   -> { type: 'edit', op, args }                       Prepare-screen edits (SlicerSession methods)
//   -> { type: 'slice' }                                slice + post-process
//   <- { type: 'ready', core, engine }
//   <- { type: 'scene', id, summary, mesh?, ms? }       model state (+ preview mesh when geometry changed)
//   <- { type: 'progress', pct, stage }
//   <- { type: 'log', line }
//   <- { type: 'done', id, result, gcode: ArrayBuffer, preview, heapMB, ms, pauses }
//   <- { type: 'error', id, message }
// ?engine=step selects the larger engine build with STEP import (OCCT). The
// query string is part of self.location, so engine pthreads (which re-run
// this script) pick the same engine.
const ENGINE = new URL(self.location.href).searchParams.get('engine') === 'step' ? 'u1slicer-step' : 'u1slicer';
importScripts(`${ENGINE}.js`);

// Emscripten starts each engine pthread (TBB worker) as a new Worker running
// *this* script (the current script URL), named 'em-pthread'. Those only need
// the importScripts above — the runtime takes over from there.
if (self.name !== 'em-pthread') {
  importScripts('gcode-preview.js');
  // Cap the Prepare-preview mesh sent to the page; painted files otherwise
  // return every triangle (millions) for an exact colour preview.
  const PREVIEW_MAX_TRIANGLES = 400000;
  const log = (line) => postMessage({ type: 'log', line });
  const json = (path) => fetch(new URL(path, self.location.href)).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  });

  const sessionPromise = Promise.all([
    createU1Slicer({
      // Engine logging (SAPIL_LOG*, Boost.Log) goes to stderr.
      print: log,
      printErr: log,
      // Both builds look for "u1slicer.wasm"; point the STEP build at its own.
      locateFile: (path) => new URL(path.replace(/^u1slicer\.wasm$/, `${ENGINE}.wasm`), self.location.href).href,
    }),
    import('./pipeline/session.mjs'),
    // The profiles ProfileEmbedder merges (app assets/orca_profiles).
    json('profiles/printer/snapmaker_u1.json'),
    json('profiles/process/standard_0.20mm.json'),
    json('profiles/filament/pla.json'),
  ]).then(([engine, { SlicerSession }, printer, process, filament]) => {
    const session = new SlicerSession({ engine, profiles: { printer, process, filament }, log });
    postMessage({ type: 'ready', core: engine.coreVersion(), engine: ENGINE });
    return session;
  });

  const scene = (id, session, withMesh, extra = {}) => {
    const msg = { type: 'scene', id, summary: session.summary(), ...extra };
    const transfer = [];
    if (withMesh) {
      const m = session.previewMesh(PREVIEW_MAX_TRIANGLES);
      msg.mesh = { positions: m.positions, extruders: m.extruders, objectTriangles: m.objectTriangles, modifierStart: m.modifierStart };
      transfer.push(m.positions.buffer, m.extruders.buffer, m.objectTriangles.buffer);
    }
    postMessage(msg, transfer);
  };

  // Edits the page may call (SlicerSession methods), and whether they change geometry.
  const EDITS = {
    setModelScale: true, setModelRotation: true, setCopyCount: true, setPlacement: true, autoArrange: true,
    splitObject: true, duplicateObject: true, setObjectRotation: true, setObjectScale: true, addModel: true,
    setWipeTowerPosition: false, setFilamentOverride: false, autoOrientAll: true,
  };

  const handlers = {
    load(s, { id, name, bytes }) {
      const t0 = performance.now();
      const summary = s.loadModel(name, new Uint8Array(bytes));
      scene(id, s, !summary.needsPlateSelection, { ms: performance.now() - t0 });
    },
    plate(s, { id, plateId }) {
      const t0 = performance.now();
      s.selectPlate(plateId);
      scene(id, s, true, { ms: performance.now() - t0 });
    },
    settings(s, { id, presets, slotTemps, overrides, config }) {
      if (overrides) s.overrides = overrides;
      if (config) s.config = { ...s.config, ...config };
      if (presets) s.setPresets(presets, slotTemps ?? []);
      scene(id, s, false);
    },
    mapping(s, { id, mapping }) { s.applyMultiColorAssignments(mapping); scene(id, s, false); },
    extruder(s, { id, index }) { s.setSelectedExtruder(index); scene(id, s, false); },
    edit(s, { id, op, args = [] }) {
      if (!(op in EDITS)) throw new Error(`Unknown edit ${op}`);
      if (op === 'autoOrientAll') {
        s.engine.autoOrientAll();
        s.customObjectPositions = null;
      } else if (op === 'addModel') {
        s.addModel(args[0], new Uint8Array(args[1]), args[2] ?? -1);
      } else {
        const r = s[op](...args);
        if (r === false) throw new Error(`${op} was not applied`);
      }
      scene(id, s, EDITS[op]);
    },
    async slice(s, { id }) {
      const t0 = performance.now();
      const out = await s.slice((pct, stage) => postMessage({ type: 'progress', pct, stage }));
      postMessage({ type: 'progress', pct: 100, stage: 'Mapping colours to extruders' });
      const text = s.exportGcode(out.gcode);
      postMessage({ type: 'progress', pct: 100, stage: 'Building preview' });
      const preview = self.parseGcodePreview(text);
      const gcode = new TextEncoder().encode(text).buffer;
      postMessage({
        type: 'done', id, result: out.result, gcode, preview, pauses: out.layerToolPauses,
        heapMB: s.engine.heapBytes() / 2 ** 20, ms: performance.now() - t0, summary: s.summary(),
      }, [gcode, preview.positions.buffer, preview.features.buffer, preview.tools.buffer,
        preview.layerEnds.buffer, preview.layerZ.buffer]);
    },
  };

  // One request at a time, in order (the engine is single-model and not re-entrant).
  let queue = Promise.resolve();
  self.onmessage = ({ data }) => {
    queue = queue.then(async () => {
      try {
        const session = await sessionPromise;
        await handlers[data.type](session, data);
      } catch (e) {
        postMessage({ type: 'error', id: data.id, op: data.type, message: String(e?.message ?? e) });
      }
    });
  };
}
