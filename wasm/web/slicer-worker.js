// Runs the wasm engine off the main thread. Slicing blocks for seconds and the
// engine's pthreads need Atomics.wait, which browsers forbid on the UI thread.
//
// Protocol (postMessage):
//   -> { type: 'slice', name, bytes: ArrayBuffer, config: {...}, plate }
//   <- { type: 'ready', core }
//   <- { type: 'progress', pct, stage }
//   <- { type: 'log', line }
//   <- { type: 'done', result, model, gcode: ArrayBuffer, ms }
//   <- { type: 'error', message }
importScripts('u1slicer.js');

// Emscripten starts each engine pthread (TBB worker) as a new Worker running
// *this* script (the current script URL), named 'em-pthread'. Those only need
// the importScripts above — the runtime takes over from there.
if (self.name !== 'em-pthread') {
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

  self.onmessage = async ({ data }) => {
    if (data.type !== 'slice') return;
    try {
      const engine = await enginePromise;
      const t0 = performance.now();
      const path = `/work/${data.name.replace(/[^\w.+-]/g, '_')}`;
      engine.FS.writeFile(path, new Uint8Array(data.bytes));
      engine.clearModel();
      if (!engine.loadModel(path, data.plate ?? 0)) throw new Error(`could not load ${data.name}`);
      const model = JSON.parse(engine.modelInfoJson());
      const result = JSON.parse(engine.slice(JSON.stringify(data.config ?? {}),
        (pct, stage) => postMessage({ type: 'progress', pct, stage })));
      engine.FS.unlink(path);
      if (!result.success) throw new Error(result.error || 'slice failed');
      const gcode = engine.FS.readFile(result.gcodePath).buffer;
      postMessage({ type: 'done', result, model, gcode, ms: performance.now() - t0 }, [gcode]);
    } catch (e) {
      postMessage({ type: 'error', message: String(e?.message ?? e) });
    }
  };
}
