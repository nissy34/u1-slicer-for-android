import { MATERIALS, PLATES, appSliceDefaults, bedTempFor, nozzleTempFor } from './app-defaults.mjs';
import { FEATURE_COLORS, Preview3D, SLOT_COLORS } from './preview3d.mjs';
import { checkPrinter, uploadGcode } from './printer.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};
const setStatus = (id, text, kind = '') => { const el = $(id); el.textContent = text; el.className = `status ${kind}`; };

// ---- settings ------------------------------------------------------------------
for (const m of MATERIALS) $('material').add(new Option(m));
for (const [k, v] of Object.entries(PLATES)) $('plateType').add(new Option(v, k));
$('plateType').value = store.get('u1.plateType') ?? 'TEXTURED_PEI';
const applyTemps = () => {
  $('nozzle_temp').value = nozzleTempFor($('material').value);
  $('bed_temp').value = bedTempFor($('plateType').value, $('material').value);
};
$('material').onchange = applyTemps;
$('plateType').onchange = () => { store.set('u1.plateType', $('plateType').value); applyTemps(); };
applyTemps();
$('printerUrl').value = store.get('u1.printerUrl') ?? '';
$('printerUrl').onchange = () => store.set('u1.printerUrl', $('printerUrl').value);

// The machine start/end G-code is the app's B106 asset, served next to the page.
const printerProfile = fetch('profiles/printer/snapmaker_u1.json').then((r) => r.json()).catch(() => null);

// ---- colours -> extruder slots -----------------------------------------------------
// One entry per colour in the file (file filament / paint state). The engine
// slices with one tool per colour; the worker then rewrites T<i> to the chosen
// physical U1 slot (the app's canonical colorMapping + GcodeToolRemapper flow).
let fileColours = [];   // '#RRGGBB' per file colour
let mapping = [0];      // file colour index -> slot 0..3

const SLOTS = 4;
const colourOf = (i) => fileColours[i] ?? SLOT_COLORS[i % SLOT_COLORS.length];
/** Preview colour for each physical slot: the first file colour mapped onto it. */
const slotColours = () => Array.from({ length: SLOTS }, (_, s) => {
  const i = mapping.indexOf(s);
  return i >= 0 ? colourOf(i) : SLOT_COLORS[s];
});

function renderColours() {
  const multi = mapping.length > 1;
  $('coloursTitle').textContent = multi ? `Colours → extruders (${mapping.length})` : 'Extruder';
  $('colourRows').innerHTML = mapping.map((slot, i) => `
    <div class="colour-row">
      <span class="swatch" style="background:${colourOf(i)}"></span>
      <span>${multi ? `Colour ${i + 1}` : 'Model'} <span class="note">${fileColours[i] ?? ''}</span></span>
      <select data-i="${i}">${Array.from({ length: SLOTS }, (_, s) =>
        `<option value="${s}" ${s === slot ? 'selected' : ''}>E${s + 1}</option>`).join('')}</select>
    </div>`).join('');
  for (const sel of $('colourRows').querySelectorAll('select')) {
    sel.onchange = () => { mapping[Number(sel.dataset.i)] = Number(sel.value); onMappingChanged(); };
  }
  const distinct = new Set(mapping).size;
  $('coloursNote').textContent = mapping.length > SLOTS
    ? `This file has ${mapping.length} colours but the U1 has ${SLOTS} extruders; colours sharing an extruder print in the same filament.`
    : multi && distinct < mapping.length ? 'Colours sharing an extruder print in the same filament.' : '';
  $('coloursCard').hidden = false;
}

function onMappingChanged() {
  $('wipe_tower_enabled').checked = new Set(mapping).size > 1;
  renderColours();
}

async function buildConfig() {
  const material = $('material').value;
  const n = mapping.length;
  const num = (id) => Number($(id).value);
  const cfg = appSliceDefaults(await printerProfile, { material, plate: $('plateType').value });
  Object.assign(cfg, {
    layer_height: num('layer_height'),
    perimeters: num('perimeters'),
    fill_density: num('fill_density') / 100,
    fill_pattern: $('fill_pattern').value,
    nozzle_temp: num('nozzle_temp'),
    bed_temp: num('bed_temp'),
    support_enabled: !!$('support').value,
    support_type: $('support').value || 'normal',
    brim_width: num('brim_width'),
    extruder_count: n,
    wipe_tower_enabled: $('wipe_tower_enabled').checked,
  });
  if (n > 1) {
    // One entry per file colour (the engine's tool space, before remapping).
    cfg.filament_types = Array(n).fill(material);
    cfg.extruder_temps = Array(n).fill(cfg.nozzle_temp);
  }
  return cfg;
}

// ---- 3D view ---------------------------------------------------------------------
const view = new Preview3D($('viewport'));
const applyTheme = () => {
  const css = getComputedStyle(document.documentElement);
  view.setTheme({ background: css.getPropertyValue('--viewport').trim(), grid: css.getPropertyValue('--grid').trim() });
};
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function setTab(tab) {
  $('tabModel').setAttribute('aria-pressed', String(tab === 'model'));
  $('tabGcode').setAttribute('aria-pressed', String(tab === 'gcode'));
  $('layerRow').hidden = $('colorByWrap').hidden = tab !== 'gcode';
  view.setMode(tab);
  renderLegend(tab);
}
$('tabModel').onclick = () => setTab('model');
$('tabGcode').onclick = () => setTab('gcode');

function renderLegend(tab) {
  let items = [];
  if (tab === 'gcode' && $('colorBy').value === 'feature' && preview) {
    const present = new Set(preview.features);
    items = self.GCODE_FEATURES.filter((_, i) => present.has(i)).map((f) => [f, FEATURE_COLORS[f]]);
  } else if (tab === 'gcode' && preview) {
    const sc = slotColours();
    items = [...new Set(preview.tools)].sort().map((t) => [`E${t + 1}`, sc[t] ?? SLOT_COLORS[t % SLOT_COLORS.length]]);
  }
  $('legend').innerHTML = items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
}
$('colorBy').onchange = () => { view.recolorGcode($('colorBy').value, slotColours()); renderLegend('gcode'); };

let preview = null;
$('layer').oninput = () => {
  const i = Number($('layer').value);
  view.setLayer(i);
  $('layerLabel').textContent = `${i + 1} / ${preview.layerZ.length} · ${preview.layerZ[i]?.toFixed(2)} mm`;
};

// Needed for GCODE_FEATURES in the legend (the worker has its own copy).
await new Promise((ok) => {
  const s = document.createElement('script');
  s.src = 'gcode-preview.js';
  s.onload = ok;
  document.head.append(s);
});

// ---- engine worker ----------------------------------------------------------------
if (!crossOriginIsolated) {
  setStatus('modelStatus', 'This page must be served cross-origin isolated (COOP/COEP headers) — the engine ' +
    'uses SharedArrayBuffer threads. Use wasm/web/serve.mjs or the Cloudflare _headers file.', 'error');
}
let engineReady = false, modelLoaded = false, gcodeBlob = null, gcodeName = 'model.gcode';
let worker = null, workerEngine = null;
const isStep = (name) => /\.(step|stp)$/i.test(name);

// Two engine builds: the default one, and a larger one (~7 MB gzipped) with
// STEP import, only fetched when a STEP file is opened.
function startWorker(engine) {
  worker?.terminate();
  engineReady = false;
  modelLoaded = false;
  workerEngine = engine;
  worker = new Worker(engine === 'step' ? 'slicer-worker.js?engine=step' : 'slicer-worker.js');
  worker.onmessage = onWorkerMessage;
}

const stepAvailable = fetch('u1slicer-step.wasm', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
stepAvailable.then((ok) => {
  if (ok) {
    $('file').accept += ',.step,.stp';
    $('file').parentElement.firstChild.textContent = 'STL, 3MF, OBJ or STEP';
  }
});

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'ready':
      engineReady = true;
      setStatus('modelStatus', `Engine ready · ${data.core}${data.engine === 'u1slicer-step' ? ' · STEP import' : ''}`);
      if ($('file').files.length) loadModel();
      break;
    case 'log':
      $('log').textContent += data.line + '\n';
      break;
    case 'loaded': {
      modelLoaded = true;
      const m = data.model;
      setStatus('modelStatus', `${m.filename}: ${m.sizeX.toFixed(1)} × ${m.sizeY.toFixed(1)} × ${m.sizeZ.toFixed(1)} mm · ` +
        `${m.triangleCount.toLocaleString()} triangles · ${m.volumeCount} part(s) · loaded in ${(data.ms / 1000).toFixed(1)} s`, 'ok');
      $('viewportHint').hidden = true;
      fileColours = data.fileColours;
      let maxState = 0;
      for (const e of data.mesh.extruders) if (e > maxState) maxState = e;
      // The file's filament list is authoritative. The preview mesh's indices are
      // paint states for painted files but per-part indices otherwise (the app
      // resolves part -> filament in Kotlin), so they only count colours when the
      // file has no filament list (e.g. PrusaSlicer-painted 3MFs).
      const count = fileColours.length || maxState + 1;
      const meshIsColours = maxState < count;
      // App default: identity for up to 4 colours, folded i % 4 beyond that.
      mapping = Array.from({ length: count }, (_, i) => i % SLOTS);
      onMappingChanged();
      view.showModel(data.mesh, meshIsColours
        ? Array.from({ length: count }, (_, i) => colourOf(i))
        : ['#b8bec9']);
      $('coloursNote').textContent ||= meshIsColours ? ''
        : 'Model view shows parts in one colour; the G-code view shows each extruder.';
      $('slice').disabled = false;
      setTab('model');
      break;
    }
    case 'progress':
      $('progress').value = data.pct;
      setStatus('sliceStatus', data.stage);
      break;
    case 'done': onSliced(data); break;
    case 'error': {
      // The wasm32 heap tops out at 4 GB; whole multi-plate projects can hit it.
      const oom = /bad_alloc|out of memory|Cannot enlarge memory/i.test(data.message);
      const msg = oom ? `${data.message} — out of memory in the browser engine (4 GB limit). ` +
        'Pick a single 3MF plate (plate number above) or scale the model down.' : data.message;
      setStatus(modelLoaded ? 'sliceStatus' : 'modelStatus', msg, 'error');
      $('slice').disabled = !modelLoaded;
      break;
    }
  }
}
startWorker('default');

async function loadModel() {
  const f = $('file').files[0];
  if (!f) return;
  if (isStep(f.name) && workerEngine !== 'step') {
    if (!(await stepAvailable)) {
      setStatus('modelStatus', 'STEP import is not included in this build of the site.', 'error');
      return;
    }
    setStatus('modelStatus', 'Loading the STEP-capable engine (about 7 MB)…');
    startWorker('step'); // its 'ready' message calls loadModel() again
    return;
  }
  if (!engineReady) return;
  modelLoaded = false;
  $('slice').disabled = true;
  $('tabGcode').disabled = true;
  $('resultCard').hidden = $('printerCard').hidden = $('coloursCard').hidden = true;
  setStatus('modelStatus', `Loading ${f.name}…`);
  gcodeName = f.name.replace(/\.[^.]+$/, '') + '.gcode';
  const bytes = await f.arrayBuffer();
  worker.postMessage({ type: 'load', name: f.name, bytes, plate: Number($('plate').value) }, [bytes]);
}
$('file').onchange = loadModel;
$('plate').onchange = loadModel;

$('slice').onclick = async () => {
  $('slice').disabled = true;
  $('progress').value = 0;
  setStatus('sliceStatus', 'Slicing…');
  worker.postMessage({ type: 'slice', config: await buildConfig(), toolMap: mapping.slice() });
};

function onSliced({ result, gcode, preview: p, heapMB, ms }) {
  preview = p;
  gcodeBlob = new Blob([gcode], { type: 'text/plain' });
  $('slice').disabled = false;
  $('progress').value = 100;
  setStatus('sliceStatus', `Sliced in ${(ms / 1000).toFixed(1)} s · engine memory ${Math.round(heapMB)} MB`, 'ok');
  const t = Math.round(result.estimatedTimeSeconds);
  const stats = [
    [`${Math.floor(t / 3600)}h ${Math.floor(t / 60) % 60}m`, 'print time'],
    [`${result.estimatedFilamentGrams.toFixed(1)} g`, 'filament'],
    [`${(result.estimatedFilamentMm / 1000).toFixed(2)} m`, 'length'],
    [result.totalLayers, 'layers'],
    [`${new Set(p.tools).size}`, 'extruders'],
    [`${(gcode.byteLength / 2 ** 20).toFixed(1)} MB`, 'G-code'],
  ];
  $('stats').innerHTML = stats.map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  $('resultCard').hidden = $('printerCard').hidden = false;
  $('tabGcode').disabled = false;
  // Multi-colour prints are easier to read coloured by extruder.
  $('colorBy').value = new Set(p.tools).size > 1 ? 'tool' : 'feature';
  view.showGcode(p, $('colorBy').value, slotColours());
  $('layer').max = Math.max(0, p.layerZ.length - 1);
  $('layer').value = $('layer').max;
  $('layer').oninput();
  setTab('gcode');
}

$('download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(gcodeBlob);
  a.download = gcodeName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('testPrinter').onclick = async () => {
  setStatus('printerStatus', 'Connecting…');
  try {
    const s = await checkPrinter({ url: $('printerUrl').value, apiKey: $('apiKey').value });
    setStatus('printerStatus', `Connected · Moonraker ${s.moonraker} · Klipper ${s.klippyState}`, 'ok');
  } catch (e) { setStatus('printerStatus', e.message, 'error'); }
};

$('upload').onclick = async () => {
  $('upload').disabled = true;
  setStatus('printerStatus', `Uploading ${gcodeName}…`);
  try {
    const path = await uploadGcode({ url: $('printerUrl').value, apiKey: $('apiKey').value, filename: gcodeName, blob: gcodeBlob });
    setStatus('printerStatus', `Uploaded as ${path}. Not started — start it from the printer when ready.`, 'ok');
  } catch (e) { setStatus('printerStatus', e.message, 'error'); }
  $('upload').disabled = false;
};
