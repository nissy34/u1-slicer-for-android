// Runs the wasm engine off the main thread. Slicing blocks for seconds and the
// engine's pthreads need Atomics.wait, which browsers forbid on the UI thread.
//
// Protocol (postMessage):
//   -> { type: 'load',  name, bytes: ArrayBuffer, plate }   load a model (kept for re-slicing)
//   -> { type: 'slice', config: {...}, toolMap: [slot...] } slice the loaded model; the
//      G-code's per-colour tools T<i> are then rewritten to physical slot toolMap[i]
//      (gcode-tool-remap.js, the app's GcodeToolRemapper)
//   <- { type: 'ready', core }
//   <- { type: 'loaded', model, mesh: { positions, extruders }, fileColours, fileTypes, ms }
//   <- { type: 'progress', pct, stage }
//   <- { type: 'log', line }
//   <- { type: 'done', result, gcode: ArrayBuffer, preview, heapMB, ms }
//   <- { type: 'error', message }
importScripts('u1slicer.js');

// Emscripten starts each engine pthread (TBB worker) as a new Worker running
// *this* script (the current script URL), named 'em-pthread'. Those only need
// the importScripts above — the runtime takes over from there.
if (self.name !== 'em-pthread') {
  importScripts('gcode-preview.js', 'gcode-tool-remap.js');
  // Cap the Prepare-preview mesh sent to the page; painted files otherwise
  // return every triangle (millions) for an exact colour preview.
  const PREVIEW_MAX_TRIANGLES = 400000;
  const log = (line) => postMessage({ type: 'log', line });

  const enginePromise = createU1Slicer({
    // Engine logging (SAPIL_LOG*, Boost.Log) goes to stderr.
    print: log,
    printErr: log,
    locateFile: (path) => new URL(path, self.location.href).href,
  }).then((engine) => {
    engine.FS.mkdirTree('/work');
    postMessage({ type: 'ready', core: engine.coreVersion() });
    return engine;
  });

  let modelPath = null;

  const handlers = {
    async load(engine, { name, bytes, plate }) {
      const t0 = performance.now();
      if (modelPath) { engine.clearModel(); engine.FS.unlink(modelPath); modelPath = null; }
      const path = `/work/${name.replace(/[^\w.+-]/g, '_')}`;
      engine.FS.writeFile(path, new Uint8Array(bytes));
      if (!engine.loadModel(path, plate ?? 0)) throw new Error(`Could not load ${name}`);
      modelPath = path;
      const model = JSON.parse(engine.modelInfoJson());
      const mesh = engine.previewMesh(PREVIEW_MAX_TRIANGLES);
      // Bambu/Orca 3MFs list one colour/type per file filament ("#RRGGBB[AA];…").
      const list = (key) => engine.projectConfigValue(key).split(/[;,]/).map((v) => v.trim()).filter(Boolean);
      const fileColours = list('filament_colour').map((c) => c.slice(0, 7));
      const fileTypes = list('filament_type');
      postMessage({ type: 'loaded', model, mesh, fileColours, fileTypes, ms: performance.now() - t0 },
        [mesh.positions.buffer, mesh.extruders.buffer]);
    },
    async slice(engine, { config, toolMap }) {
      if (!modelPath) throw new Error('Load a model first');
      const t0 = performance.now();
      const result = JSON.parse(engine.slice(JSON.stringify(config ?? {}),
        (pct, stage) => postMessage({ type: 'progress', pct, stage })));
      if (!result.success) throw new Error(result.error || 'Slice failed');
      postMessage({ type: 'progress', pct: 100, stage: 'Mapping colours to extruders' });
      const text = self.remapGcode(new TextDecoder().decode(engine.FS.readFile(result.gcodePath)), toolMap);
      postMessage({ type: 'progress', pct: 100, stage: 'Building preview' });
      const preview = self.parseGcodePreview(text);
      const gcode = new TextEncoder().encode(text).buffer;
      postMessage({
        type: 'done', result, gcode, preview, heapMB: engine.heapBytes() / 2 ** 20,
        ms: performance.now() - t0,
      }, [gcode, preview.positions.buffer, preview.features.buffer, preview.tools.buffer,
        preview.layerEnds.buffer, preview.layerZ.buffer]);
    },
  };

  self.onmessage = async ({ data }) => {
    try {
      const engine = await enginePromise;
      await handlers[data.type](engine, data);
    } catch (e) {
      postMessage({ type: 'error', message: String(e?.message ?? e) });
    }
  };
}
