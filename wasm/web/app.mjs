import { MATERIALS, PLATES, bedTempFor } from './app-defaults.mjs';
import { defaultExtruderPresets, extruderPreset, nozzleTempDefaultForMaterial } from './pipeline/extruder-preset.mjs';
import { fromJson, ORCA_DEFAULTS, OverrideMode, slicingOverrides, toJson, totalOverrideCount } from './pipeline/slicing-overrides.mjs';
import { formatFileValue } from './pipeline/slicing-overrides.mjs';
import { buildSupportFilamentOptions, parseRowInput, rowInputValue, SETTINGS_SECTIONS } from './settings-schema.mjs';
import { BED, FEATURE_COLORS, Preview3D, SLOT_COLORS } from './preview3d.mjs';
import { checkPrinter, uploadGcode } from './printer.mjs';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};
const setStatus = (id, text, kind = '') => { const el = $(id); el.textContent = text; el.className = `status ${kind}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SLOTS = 4;

// ---- persisted settings: slot presets, build plate, overrides (the app's DataStore) -----------
function loadJson(key, fallback) {
  try { const v = JSON.parse(store.get(key)); return v ?? fallback; } catch { return fallback; }
}
let presets = loadJson('u1.presets', null)?.map((p) => extruderPreset(p)) ?? defaultExtruderPresets();
let slotTemps = loadJson('u1.slotTemps', [null, null, null, null]);
let overrides = (() => { const j = store.get('u1.overrides'); return j ? fromJson(j) : slicingOverrides(); })();
const savePresets = () => { store.set('u1.presets', JSON.stringify(presets)); store.set('u1.slotTemps', JSON.stringify(slotTemps)); };
const saveOverrides = () => store.set('u1.overrides', toJson(overrides));

for (const [k, v] of Object.entries(PLATES)) $('plateType').add(new Option(v, k));
$('plateType').value = store.get('u1.plateType') ?? 'TEXTURED_PEI';
$('printerUrl').value = store.get('u1.printerUrl') ?? '';
$('printerUrl').onchange = () => store.set('u1.printerUrl', $('printerUrl').value);

// ---- engine worker: request/response by id --------------------------------------------------
if (!crossOriginIsolated) {
  setStatus('modelStatus', 'This page must be served cross-origin isolated (COOP/COEP headers) — the engine ' +
    'uses SharedArrayBuffer threads. Use wasm/web/serve.mjs or the Cloudflare _headers file.', 'error');
}
let worker = null, workerEngine = null, engineReady = false;
let nextId = 1;
const pending = new Map();
let summary = null;        // SlicerSession.summary() of the loaded model
let lastMesh = null;
let selected = null;       // selected object index (per-object mode)
let gcodeBlob = null, gcodeName = 'model.gcode', preview = null, busy = false;

function call(type, payload = {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfer);
  });
}

const isStep = (name) => /\.(step|stp)$/i.test(name);
function startWorker(engine) {
  worker?.terminate();
  for (const p of pending.values()) p.reject(new Error('Engine restarted'));
  pending.clear();
  engineReady = false;
  workerEngine = engine;
  worker = new Worker(engine === 'step' ? 'slicer-worker.js?engine=step' : 'slicer-worker.js');
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'ready':
        engineReady = true;
        setStatus('modelStatus', `Engine ready · ${data.core}${data.engine === 'u1slicer-step' ? ' · STEP import' : ''}`);
        pushSettings();
        if ($('file').files.length) loadModel();
        break;
      case 'log': $('log').textContent += data.line + '\n'; break;
      case 'progress':
        $('progress').value = data.pct;
        setStatus('sliceStatus', data.stage);
        break;
      default: {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.type === 'error') p.reject(new Error(data.message)); else p.resolve(data);
      }
    }
  };
}
const stepAvailable = fetch('u1slicer-step.wasm', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
stepAvailable.then((ok) => {
  if (ok) {
    for (const id of ['file', 'addFile']) $(id).accept += ',.step,.stp';
    $('file').parentElement.firstChild.textContent = 'STL, 3MF, OBJ or STEP';
  }
});
startWorker('default');

// The wasm32 heap tops out at 4 GB; whole multi-plate projects can hit it.
function errorText(e) {
  console.error(e);
  const m = String(e?.message ?? e);
  return /bad_alloc|out of memory|Cannot enlarge memory/i.test(m)
    ? `${m} — out of memory in the browser engine (4 GB limit). Pick a single 3MF plate or scale the model down.` : m;
}

// ---- filament slots (ExtruderPreset ×4 + per-slot nozzle temperature) ----------------------
function renderSlots() {
  $('slotRows').innerHTML = presets.map((p, i) => `
    <div class="slot-row">
      <b>E${i + 1}</b>
      <input type="color" data-k="color" data-i="${i}" value="${esc(p.color)}" aria-label="E${i + 1} colour">
      <select data-k="material" data-i="${i}" aria-label="E${i + 1} material">${MATERIALS.map((m) =>
        `<option ${m === p.materialType ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <input type="number" data-k="temp" data-i="${i}" min="150" max="350" placeholder="${nozzleTempDefaultForMaterial(p.materialType)}"
        value="${slotTemps[i] ?? ''}" aria-label="E${i + 1} nozzle °C" title="Nozzle °C (blank = material default)">
    </div>`).join('');
  for (const el of $('slotRows').querySelectorAll('[data-k]')) {
    el.onchange = () => {
      const i = Number(el.dataset.i);
      if (el.dataset.k === 'color') presets[i] = { ...presets[i], color: el.value.toUpperCase() };
      if (el.dataset.k === 'material') { presets[i] = { ...presets[i], materialType: el.value }; slotTemps[i] = null; }
      if (el.dataset.k === 'temp') slotTemps[i] = el.value === '' ? null : Number(el.value);
      savePresets();
      renderSlots();
      pushSettings();
    };
  }
}
renderSlots();
$('plateType').onchange = () => { store.set('u1.plateType', $('plateType').value); pushSettings(); };

/** The app's setPlateType: bed temp from the plate and the current filament label. */
function plateBedTemp() {
  return bedTempFor($('plateType').value, summary?.filamentType ?? presets[summary?.selectedExtruder ?? 0]?.materialType ?? 'PLA');
}

async function pushSettings() {
  if (!engineReady) return;
  const config = { bedTemp: plateBedTemp() };
  $('bed_temp').value = overrides.bedTemp.mode === OverrideMode.OVERRIDE ? overrides.bedTemp.value ?? config.bedTemp : config.bedTemp;
  try {
    const r = await call('settings', { presets, slotTemps, overrides, config });
    if (summary) { summary = r.summary; renderColours(); recolorModel(); }
  } catch (e) { setStatus('sliceStatus', errorText(e), 'error'); }
}

// ---- colours -> extruder slots (applyMultiColorAssignments / setSelectedExtruder) ----------
const slotColour = (s) => presets[s]?.color ?? SLOT_COLORS[s % SLOT_COLORS.length];
const slotOptions = (selectedSlot) => Array.from({ length: SLOTS }, (_, s) =>
  `<option value="${s}" ${s === selectedSlot ? 'selected' : ''}>E${s + 1} · ${esc(presets[s].materialType)}</option>`).join('');

function renderColours() {
  if (!summary?.model) { $('coloursCard').hidden = true; return; }
  const mapping = summary.colorMapping;
  const multi = !!mapping;
  const colours = summary.detectedColors;
  $('coloursTitle').textContent = multi ? `Colours → extruders (${mapping.length})` : 'Extruder';
  $('colourRows').innerHTML = multi
    ? mapping.map((slot, i) => `
      <div class="colour-row">
        <span class="swatch" style="background:${esc(colours[i] ?? '#888')}"></span>
        <span>Colour ${i + 1} <span class="note">${esc(colours[i] ?? '')}${summary.canonical?.[i]?.materialType ? ` · ${esc(summary.canonical[i].materialType)}` : ''}</span></span>
        <select data-i="${i}">${slotOptions(slot)}</select>
      </div>${materialRow(i)}`).join('')
    : `<div class="colour-row"><span class="swatch" style="background:${esc(slotColour(summary.selectedExtruder))}"></span>
        <span>Model</span><select id="singleSlot">${slotOptions(summary.selectedExtruder)}</select></div>${materialRow(0)}`;
  for (const sel of $('colourRows').querySelectorAll('select[data-i]')) {
    sel.onchange = async () => {
      const m = summary.colorMapping.slice();
      m[Number(sel.dataset.i)] = Number(sel.value);
      summary = (await call('mapping', { mapping: m })).summary;
      renderColours(); recolorModel(); pushSettings();
    };
  }
  for (const sel of $('colourRows').querySelectorAll('select[data-mat]')) {
    sel.onchange = async () => {
      const i = Number(sel.dataset.mat);
      const r = await call('edit', { op: 'setFilamentOverride', args: [i, { materialType: sel.value || null }] });
      summary = r.summary;
      renderColours();
    };
  }
  if ($('singleSlot')) {
    $('singleSlot').onchange = async () => {
      summary = (await call('extruder', { index: Number($('singleSlot').value) })).summary;
      renderColours(); recolorModel(); pushSettings();
    };
  }
  const distinct = multi ? new Set(mapping).size : 1;
  $('coloursNote').textContent = summary.layerToolOnly
    ? 'Layer colour changes: sliced with one filament and a pause (PAUSE_PRINT) at each colour change.'
    : multi && mapping.length > SLOTS
      ? `This file has ${mapping.length} colours but the U1 has ${SLOTS} extruders; colours sharing an extruder print in the same filament.`
      : multi && distinct < mapping.length ? 'Colours sharing an extruder print in the same filament.' : '';
  $('coloursCard').hidden = false;
}

/**
 * Per-file-filament material override (the app's Prepare filament override,
 * Phase 2.6b/B117/B128): a 3MF's declared material wins over the slot preset
 * unless overridden here.
 */
function materialRow(i) {
  if (!summary.isThreeMf) return '';
  const declared = summary.canonical?.[i]?.materialType;
  const current = summary.filamentOverrides?.[i]?.materialType ?? '';
  return `<div class="colour-row"><span></span><span class="note">Material${declared ? ` (file: ${esc(declared)})` : ''}</span>
    <select data-mat="${i}" aria-label="Colour ${i + 1} material"><option value="">${declared ? 'From file' : 'From slot'}</option>${MATERIALS.map((m) =>
      `<option ${m === current ? 'selected' : ''}>${m}</option>`).join('')}</select></div>`;
}

/** Palette for the model mesh's per-triangle indices (the app's Prepare recolour). */
function meshPalette() {
  if (!summary) return SLOT_COLORS;
  if (summary.colorMapping) return summary.colorMapping.map((slot) => slotColour(slot));
  return [slotColour(summary.selectedExtruder)];
}

// ---- settings: SlicingOverrides accordion -------------------------------------------------
function renderSettings() {
  const fileCfg = summary?.fileConfig ?? null;
  const html = SETTINGS_SECTIONS.map((sec) => {
    const rows = sec.rows.filter((r) => !r.when || r.when(overrides));
    const count = sec.rows.filter((r) => overrides[r.field]?.mode === OverrideMode.OVERRIDE).length;
    return `<details class="section" data-sec="${sec.key}" ${openSections.has(sec.key) ? 'open' : ''}>
      <summary>${sec.title}${count ? `<span class="count">${count} modified</span>` : ''}</summary>
      ${rows.map((r) => rowHtml(r, fileCfg)).join('')}</details>`;
  }).join('');
  $('settingsSections').innerHTML = html;
  for (const d of $('settingsSections').querySelectorAll('details')) {
    d.ontoggle = () => { if (d.open) openSections.add(d.dataset.sec); else openSections.delete(d.dataset.sec); };
  }
  for (const b of $('settingsSections').querySelectorAll('.seg button')) {
    b.onclick = () => {
      const f = b.dataset.f;
      const row = ROWS.get(f);
      const mode = b.dataset.mode;
      overrides = { ...overrides, [f]: { mode, value: mode === OverrideMode.OVERRIDE ? overrides[f].value ?? defaultValue(row) : overrides[f].value } };
      onOverridesChanged();
    };
  }
  for (const el of $('settingsSections').querySelectorAll('[data-val]')) {
    el.onchange = () => {
      const row = ROWS.get(el.dataset.val);
      const v = parseRowInput(row, row.type === 'bool' ? el.checked : el.value);
      if (v == null) return;
      overrides = { ...overrides, [row.field]: { mode: OverrideMode.OVERRIDE, value: v } };
      onOverridesChanged();
    };
  }
  const total = totalOverrideCount(overrides);
  $('resetOverrides').hidden = !total;
  $('resetOverrides').textContent = `Reset all overrides (${total})`;
}
const openSections = new Set(['layer']);
const ROWS = new Map(SETTINGS_SECTIONS.flatMap((s) => s.rows.map((r) => [r.field, r])));
const defaultValue = (row) => ORCA_DEFAULTS[row.field] ?? (row.type === 'bool' ? false : null);

function rowHtml(row, fileCfg) {
  const ov = overrides[row.field];
  const fileValue = fileCfg && row.fileKey && fileCfg[row.fileKey] != null ? formatFileValue(fileCfg[row.fileKey]) : null;
  const modes = [[OverrideMode.USE_FILE, 'File'], [OverrideMode.ORCA_DEFAULT, 'Orca'], [OverrideMode.OVERRIDE, 'Override']];
  let input = '';
  if (ov.mode === OverrideMode.OVERRIDE) {
    const v = rowInputValue(row, overrides, ORCA_DEFAULTS);
    if (row.type === 'bool') {
      input = `<label class="check"><input type="checkbox" data-val="${row.field}" ${v ? 'checked' : ''}> On</label>`;
    } else if (row.type === 'enum') {
      const opts = row.options === 'filaments'
        ? [{ configValue: 0, label: 'Default' }, ...buildSupportFilamentOptions({ extruderPresets: presets,
          colorMapping: summary?.colorMapping ?? null, filamentCount: summary?.canonical?.length ?? null })].map((o) => [o.configValue, o.label])
        : row.options;
      input = `<select data-val="${row.field}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else {
      input = `<input type="number" data-val="${row.field}" value="${v ?? ''}" min="${row.min ?? ''}" max="${row.max ?? ''}" step="${row.step ?? 1}" aria-label="${esc(row.label)}">`;
    }
  }
  return `<div class="ov-row ${row.sub ? 'sub' : ''}">
    <span>${ov.mode === OverrideMode.OVERRIDE ? '<i class="dot"></i>' : ''}${esc(row.label)}${ov.mode === OverrideMode.ORCA_DEFAULT ? ` <span class="note">${esc(row.hint)}</span>` : ''}</span>
    <span class="seg">${modes.map(([m, l]) => `<button type="button" data-f="${row.field}" data-mode="${m}" aria-pressed="${ov.mode === m}">${l}</button>`).join('')}</span>
    ${fileValue != null ? `<span class="file">File: ${esc(fileValue)}</span>` : ''}
    ${input ? `<span class="val">${input}</span>` : ''}
  </div>`;
}

function onOverridesChanged() {
  saveOverrides();
  renderSettings();
  pushSettings();
  if (summary) refreshArrange();
}
$('resetOverrides').onclick = () => { overrides = slicingOverrides({ flowCalibration: overrides.flowCalibration }); onOverridesChanged(); };
renderSettings();

// ---- 3D view ---------------------------------------------------------------------------------
const view = new Preview3D($('viewport'));
const applyTheme = () => {
  const css = getComputedStyle(document.documentElement);
  view.setTheme({ background: css.getPropertyValue('--viewport').trim(), grid: css.getPropertyValue('--grid').trim() });
};
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function towerBox() {
  if (!summary?.wipeTowerEnabled) return null;
  const t = summary.wipeTower;
  return { x: t.x, y: t.y, w: t.size[0], d: t.size[1], h: Math.min(summary.model?.sizeZ ?? 10, 60) };
}
function showModel(reframe) {
  if (!lastMesh) return;
  view.showModel(lastMesh, meshPalette(), { tower: towerBox(), reframe });
  view.setSelected(selected);
}
function recolorModel() { showModel(false); }

/** Bed-space boxes of what a drag moves, to clamp it on the bed. */
function dragLimits(kind, objIndex) {
  const objs = summary.objects;
  if (kind === 'tower') {
    const t = summary.wipeTower;
    return [-t.x, t.clamp[0] - t.x, -t.y, t.clamp[1] - t.y];
  }
  const boxes = (kind === 'group' ? objs : [objs[objIndex]]).filter((o) => o?.min && o?.size);
  if (!boxes.length) return [0, 0, 0, 0];
  // In group mode copies are instances of the objects; use the placement positions instead.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (kind === 'group' && summary.edit.positions.length >= 2) {
    const p = summary.edit.positions;
    const w = summary.edit.footprint?.[0] ?? boxes[0].size[0];
    const h = summary.edit.footprint?.[1] ?? boxes[0].size[1];
    for (let i = 0; i + 1 < p.length; i += 2) { x0 = Math.min(x0, p[i]); y0 = Math.min(y0, p[i + 1]); x1 = Math.max(x1, p[i] + w); y1 = Math.max(y1, p[i + 1] + h); }
  } else {
    for (const o of boxes) { x0 = Math.min(x0, o.min[0]); y0 = Math.min(y0, o.min[1]); x1 = Math.max(x1, o.min[0] + o.size[0]); y1 = Math.max(y1, o.min[1] + o.size[1]); }
  }
  return [-x0, BED - x1, -y0, BED - y1];
}

view.enableDrag({
  canDrag: (hit) => (busy || !summary ? null : hit.tower ? 'tower' : summary.edit.multiObject ? 'object' : 'group'),
  bounds: dragLimits,
  onPick: (objIndex) => { if (summary?.edit.multiObject) { selected = objIndex; view.setSelected(selected); renderObjectPanel(); } },
  onDrop: async ({ kind, objIndex, dx, dy }) => {
    if (kind === 'tower') {
      const t = summary.wipeTower;
      return edit('setWipeTowerPosition', [t.x + dx, t.y + dy]);
    }
    const pos = summary.edit.positions.slice();
    for (let i = 0; i + 1 < pos.length; i += 2) {
      if (kind === 'group' || i / 2 === objIndex) { pos[i] += dx; pos[i + 1] += dy; }
    }
    return edit('setPlacement', [pos]);
  },
});

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
    items = [...new Set(preview.tools)].sort().map((t) => [`E${t + 1} · ${presets[t]?.materialType ?? ''}`, slotColour(t)]);
  }
  $('legend').innerHTML = items.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('');
}
const gcodeSlotColours = () => Array.from({ length: 16 }, (_, t) => slotColour(t % SLOTS));
$('colorBy').onchange = () => { view.recolorGcode($('colorBy').value, gcodeSlotColours()); renderLegend('gcode'); };
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

// ---- model load / plate selection --------------------------------------------------------
function onScene(r, { reframe = false } = {}) {
  summary = r.summary;
  if (r.mesh) { lastMesh = r.mesh; showModel(reframe); }
  else showModel(false);
  if (selected != null && selected >= (summary.objects?.length ?? 0)) selected = null;
  renderColours();
  renderSettings();
  refreshArrange();
  $('tabGcode').disabled = true;
  $('resultCard').hidden = $('printerCard').hidden = true;
  setTab('model');
}

function modelStatusText(s, ms) {
  const m = s.model;
  const parts = [`${s.name}: ${m.sizeX.toFixed(1)} × ${m.sizeY.toFixed(1)} × ${m.sizeZ.toFixed(1)} mm`,
    `${m.triangleCount.toLocaleString()} triangles`, `${m.volumeCount} part(s)`];
  if (s.isBambu) parts.push(`Bambu/Orca project${s.currentPlateId > 0 ? `, plate ${s.currentPlateId}` : ''}`);
  if (s.hasPaintData) parts.push('painted');
  if (ms != null) parts.push(`loaded in ${(ms / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

async function loadModel() {
  const f = $('file').files[0];
  if (!f) return;
  if (isStep(f.name) && workerEngine !== 'step') {
    if (!(await stepAvailable)) { setStatus('modelStatus', 'STEP import is not included in this build of the site.', 'error'); return; }
    setStatus('modelStatus', 'Loading the STEP-capable engine (about 7 MB)…');
    startWorker('step'); // its 'ready' message calls loadModel() again
    return;
  }
  if (!engineReady) return;
  busy = true;
  summary = null;
  selected = null;
  $('slice').disabled = true;
  $('tabGcode').disabled = true;
  $('resultCard').hidden = $('printerCard').hidden = $('coloursCard').hidden = $('arrangeCard').hidden = true;
  $('plateWrap').hidden = true;
  setStatus('modelStatus', `Loading ${f.name}…`);
  gcodeName = f.name.replace(/\.[^.]+$/, '') + '.gcode';
  try {
    const bytes = await f.arrayBuffer();
    const r = await call('load', { name: f.name, bytes }, [bytes]);
    if (r.summary.needsPlateSelection) {
      summary = r.summary;
      $('plate').innerHTML = '<option value="">Choose a plate…</option>' + summary.plates.map((p) =>
        `<option value="${p.plateId}">Plate ${p.plateId}${p.name ? ` · ${esc(p.name)}` : ''} (${p.objectCount} object${p.objectCount === 1 ? '' : 's'})</option>`).join('');
      $('plateWrap').hidden = false;
      setStatus('modelStatus', `${f.name} has ${summary.plates.length} plates — choose one to slice.`, 'ok');
      return;
    }
    onScene(r, { reframe: true });
    setStatus('modelStatus', modelStatusText(r.summary, r.ms), 'ok');
    $('viewportHint').hidden = true;
    $('slice').disabled = false;
    pushSettings();
  } catch (e) {
    setStatus('modelStatus', errorText(e), 'error');
  } finally { busy = false; }
}
$('file').onchange = loadModel;

$('plate').onchange = async () => {
  const plateId = Number($('plate').value);
  if (!plateId) return;
  busy = true;
  $('slice').disabled = true;
  setStatus('modelStatus', `Loading plate ${plateId}…`);
  try {
    const r = await call('plate', { plateId });
    onScene(r, { reframe: true });
    setStatus('modelStatus', modelStatusText(r.summary, r.ms), 'ok');
    $('viewportHint').hidden = true;
    $('slice').disabled = false;
    pushSettings();
  } catch (e) { setStatus('modelStatus', errorText(e), 'error'); } finally { busy = false; }
};

// ---- arrange: scale / rotate / copies / objects / tower ----------------------------------------
async function edit(op, args = [], transfer = []) {
  busy = true;
  try {
    onScene(await call('edit', { op, args }, transfer));
  } catch (e) {
    setStatus('sliceStatus', errorText(e), 'error');
    showModel(false);
  } finally { busy = false; }
}

function refreshArrange() {
  if (!summary?.model) { $('arrangeCard').hidden = true; return; }
  const e = summary.edit;
  $('arrangeCard').hidden = false;
  $('copies').value = e.copyCount;
  $('scale').value = Math.round(e.scale.x * 100);
  $('rotX').value = e.rotation.x; $('rotY').value = e.rotation.y; $('rotZ').value = e.rotation.z;
  for (const id of ['copies', 'scale', 'rotX', 'rotY', 'rotZ']) $(id).disabled = e.multiObject;
  $('autoArrange').disabled = !e.multiObject; // autoArrangeAll needs several objects on the bed
  $('split').disabled = e.multiObject ? !(summary.objects[selected ?? 0]?.splittable) : !summary.objects.some((o) => o.splittable);
  $('towerPanel').hidden = !summary.wipeTowerEnabled;
  $('towerX').value = summary.wipeTower.x.toFixed(1);
  $('towerY').value = summary.wipeTower.y.toFixed(1);
  const warn = e.copyBedWarning;
  $('arrangeNote').textContent = warn ?? (e.multiObject
    ? 'Click an object to select it; drag objects or the grey prime-tower box to move them.'
    : 'Drag the model or the grey prime-tower box on the bed to move them.');
  $('arrangeNote').className = `note${warn ? ' status error' : ''}`;
  renderObjectPanel();
}

function renderObjectPanel() {
  const e = summary?.edit;
  $('objectPanel').hidden = !e?.multiObject;
  if (!e?.multiObject) return;
  $('objectSelect').innerHTML = summary.objects.map((o, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${i + 1}. ${esc(o.name || 'Object')}</option>`).join('');
  if (selected == null) selected = 0;
  $('objectSelect').value = String(selected);
  const o = summary.objects[selected];
  const pos = e.positions;
  $('objX').value = pos[selected * 2]?.toFixed(1) ?? '';
  $('objY').value = pos[selected * 2 + 1]?.toFixed(1) ?? '';
  $('objRotZ').value = Math.round(o?.rotation?.[2] ?? 0);
  $('objScale').value = Math.round((o?.scale?.[0] ?? 1) * 100);
  view.setSelected(selected);
}

const num = (id) => Number(String($(id).value).replace(',', '.'));
$('copies').onchange = () => edit('setCopyCount', [num('copies')]);
$('scale').onchange = () => { const s = num('scale') / 100; if (s > 0) edit('setModelScale', [s, s, s]); };
for (const id of ['rotX', 'rotY', 'rotZ']) $(id).onchange = () => edit('setModelRotation', [num('rotX'), num('rotY'), num('rotZ')]);
$('autoArrange').onclick = () => edit('autoArrange');
$('autoOrient').onclick = () => edit('autoOrientAll');
$('split').onclick = () => edit('splitObject', [selected ?? 0]);
$('duplicate').onclick = () => edit('duplicateObject', [selected ?? 0]);
$('objectSelect').onchange = () => { selected = Number($('objectSelect').value); renderObjectPanel(); };
for (const id of ['objX', 'objY']) {
  $(id).onchange = () => {
    const pos = summary.edit.positions.slice();
    pos[selected * 2] = num('objX');
    pos[selected * 2 + 1] = num('objY');
    edit('setPlacement', [pos]);
  };
}
$('objRotZ').onchange = () => { const r = summary.objects[selected].rotation; edit('setObjectRotation', [selected, r[0], r[1], num('objRotZ')]); };
$('objScale').onchange = () => { const s = num('objScale') / 100; if (s > 0) edit('setObjectScale', [selected, s, s, s]); };
for (const id of ['towerX', 'towerY']) $(id).onchange = () => edit('setWipeTowerPosition', [num('towerX'), num('towerY')]);
$('addFile').onchange = async () => {
  const f = $('addFile').files[0];
  if (!f || !summary) return;
  const bytes = await f.arrayBuffer();
  await edit('addModel', [f.name, bytes], [bytes]);
  $('addFile').value = '';
};

// ---- slice ------------------------------------------------------------------------------------
$('slice').onclick = async () => {
  $('slice').disabled = true;
  busy = true;
  $('progress').value = 0;
  setStatus('sliceStatus', 'Slicing…');
  try {
    onSliced(await call('slice'));
  } catch (e) {
    setStatus('sliceStatus', errorText(e), 'error');
  } finally {
    $('slice').disabled = !summary?.model;
    busy = false;
  }
};

function onSliced({ result, gcode, preview: p, heapMB, ms, pauses }) {
  preview = p;
  gcodeBlob = new Blob([gcode], { type: 'text/plain' });
  $('progress').value = 100;
  setStatus('sliceStatus', `Sliced in ${(ms / 1000).toFixed(1)} s · engine memory ${Math.round(heapMB)} MB` +
    (pauses ? ' · colour-change pauses inserted' : ''), 'ok');
  const t = Math.round(result.estimatedTimeSeconds);
  const stats = [
    [`${Math.floor(t / 3600)}h ${Math.floor(t / 60) % 60}m`, 'print time'],
    [`${result.estimatedFilamentGrams.toFixed(1)} g`, 'filament'],
    [`${(result.estimatedFilamentMm / 1000).toFixed(2)} m`, 'length'],
    [result.totalLayers, 'layers'],
    [[...new Set(p.tools)].sort().map((t) => `E${t + 1}`).join(' '), 'extruders'],
    [`${(gcode.byteLength / 2 ** 20).toFixed(1)} MB`, 'G-code'],
  ];
  $('stats').innerHTML = stats.map(([v, k]) => `<div class="stat"><b>${esc(v)}</b><span>${k}</span></div>`).join('');
  $('resultCard').hidden = $('printerCard').hidden = false;
  $('tabGcode').disabled = false;
  // Multi-colour prints are easier to read coloured by extruder.
  $('colorBy').value = new Set(p.tools).size > 1 ? 'tool' : 'feature';
  view.showGcode(p, $('colorBy').value, gcodeSlotColours());
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

// Upload only — the page never starts a print (printer.mjs sends no print=true).
$('upload').onclick = async () => {
  $('upload').disabled = true;
  setStatus('printerStatus', `Uploading ${gcodeName}…`);
  try {
    const path = await uploadGcode({ url: $('printerUrl').value, apiKey: $('apiKey').value, filename: gcodeName, blob: gcodeBlob });
    setStatus('printerStatus', `Uploaded as ${path}. Not started — start it from the printer when ready.`, 'ok');
  } catch (e) { setStatus('printerStatus', e.message, 'error'); }
  $('upload').disabled = false;
};
