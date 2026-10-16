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
$('extruders').onchange = () => { $('wipe_tower_enabled').checked = Number($('extruders').value) > 1; };
$('printerUrl').value = store.get('u1.printerUrl') ?? '';
$('printerUrl').onchange = () => store.set('u1.printerUrl', $('printerUrl').value);

// The machine start/end G-code is the app's B106 asset, served next to the page.
const printerProfile = fetch('profiles/printer/snapmaker_u1.json').then((r) => r.json()).catch(() => null);

async function buildConfig() {
  const material = $('material').value;
  const n = Number($('extruders').value);
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
    items = [...new Set(preview.tools)].sort().map((t) => [`T${t} / E${t + 1}`, SLOT_COLORS[t % SLOT_COLORS.length]]);
  }
  $('legend').innerHTML = items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
}
$('colorBy').onchange = () => { view.recolorGcode($('colorBy').value); renderLegend('gcode'); };

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
const worker = new Worker('slicer-worker.js');
let engineReady = false, modelLoaded = false, gcodeBlob = null, gcodeName = 'model.gcode';

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case 'ready':
      engineReady = true;
      setStatus('modelStatus', `Engine ready · ${data.core}`);
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
      view.showModel(data.mesh);
      const slots = new Set(data.mesh.extruders);
      if (slots.size > 1 && $('extruders').value === '1') {
        $('extruders').value = String(Math.min(4, Math.max(...slots) + 1));
        $('wipe_tower_enabled').checked = true;
      }
      $('slice').disabled = false;
      setTab('model');
      break;
    }
    case 'progress':
      $('progress').value = data.pct;
      setStatus('sliceStatus', data.stage);
      break;
    case 'done': onSliced(data); break;
    case 'error':
      setStatus(modelLoaded ? 'sliceStatus' : 'modelStatus', data.message, 'error');
      $('slice').disabled = !modelLoaded;
      break;
  }
};

async function loadModel() {
  const f = $('file').files[0];
  if (!f || !engineReady) return;
  modelLoaded = false;
  $('slice').disabled = true;
  $('tabGcode').disabled = true;
  $('resultCard').hidden = $('printerCard').hidden = true;
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
  worker.postMessage({ type: 'slice', config: await buildConfig() });
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
  view.showGcode(p, $('colorBy').value);
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
