// The Printer tab: connection, live status, camera, filament slots (RFID sync,
// editor, filament library), print controls and the print-configuration screen
// (plate / printer / filament → tool-head mapping / print preferences → Start).
//
// Mirrors the Android app's PrinterScreen + PrinterViewModel. Safety model:
//   * Every action that heats, moves, starts, pauses, resumes or cancels goes
//     through confirmDialog() first. Nothing is sent on page load except
//     read-only queries (status, webcam list, file list) and the camera
//     keepalive (camera.start_monitor, like the app).
//   * "Upload only" never starts a print (no print=true, no start call).
import '../gcode-tool-remap.js'; // classic script: defines self.remapGcode
import { MATERIALS } from '../app-defaults.mjs';
import {
  LiveConnection, MoonrakerClient, applyGracePeriod, buildFilamentConfigGcode, buildPrintPreferencesGcode, buildUploadFilename,
  detectTransition, estimateRemainingSeconds, eventBody, eventTitle, formatDuration, makeStatus, mixedContentReason,
  normalizeUrl, parseLedState, parsePrintPreferences, parseStatus, progressShouldShow, progressTitle, remoteScreenUrl,
  resolveStatusBadge,
} from './moonraker.mjs';
import {
  buildImportPreview, decodeSlugList, defaultBedFor, defaultNozzleFor, displayName, encodeSlugList, hasImportableData,
  libraryEntryToSlot, parseLibrary, topMaterials, updateRecents,
} from './filament-library.mjs';
import { applySyncPreviewEntries, buildSyncPreviewEntries, parseSlots, serializeSlots, slotLabel } from './slots.mjs';
import {
  buildFilamentCards, buildPrintRemap, extractThumbnail, materialMismatches, sharedHeads, summarizeGcode,
} from './gcode-summary.mjs';

// ---- small utilities -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode, blocked storage */ } },
};
const KEYS = { url: 'u1.printerUrl', key: 'u1.printerApiKey', slots: 'u1.slots', favs: 'u1.libFavourites', recents: 'u1.libRecents', prefs: 'u1.printPrefs', camMode: 'u1.cameraMode' };
const fmtTemp = (t) => `${Math.round(t)}°`;
const fmtGrams = (g) => (g >= 100 ? `${Math.round(g)}g` : `${(Math.round(g * 10) / 10).toString()}g`);
/** Readable text colour on a swatch background. */
function inkFor(hex) {
  const v = parseInt(String(hex ?? '#888888').slice(1, 7), 16);
  const l = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return l > 150 ? '#111' : '#fff';
}

// ---- state -------------------------------------------------------------------------------
const S = {
  client: null, live: null, info: null, connected: false, mode: 'offline',
  objects: {}, status: makeStatus({ state: 'disconnected' }), prevState: 'disconnected', failures: 0,
  justSentUntil: 0, led: null, prefs: null, fileMeta: null, metaFor: null,
  cams: { snapshots: [], streams: [] }, camIdx: 0, camTimer: null, camUrl: null, camFails: 0, keepalive: null,
  slots: parseSlots(store.get(KEYS.slots) ?? '[]'),
  library: null, libraryPromise: null,
  favourites: new Set(decodeSlugList(store.get(KEYS.favs) ?? '')), recents: decodeSlugList(store.get(KEYS.recents) ?? ''),
  sliced: null, files: [], visible: false,
};
const savedPrefs = (() => { try { return JSON.parse(store.get(KEYS.prefs) ?? 'null'); } catch { return null; } })();

// ---- layout: app-level tabs + the Printer view --------------------------------------------
const slicerView = document.querySelector('.layout');
const header = document.querySelector('header');
const nav = document.createElement('nav');
nav.className = 'apptabs';
nav.innerHTML = '<button id="appTabSlicer" aria-pressed="true">Slicer</button><button id="appTabPrinter" aria-pressed="false">Printer</button>';
header.insertBefore(nav, header.querySelector('.sub'));
const view = document.createElement('div');
view.id = 'printerView';
view.hidden = true;
slicerView.after(view);
const toasts = document.createElement('div');
toasts.id = 'toasts';
toasts.setAttribute('aria-live', 'polite');
document.body.append(toasts);

view.innerHTML = `
<div class="pgrid">
  <div class="pcol">
    <section class="card" id="pConnCard">
      <h2>Printer <span class="badge" id="pBadge">DISCONNECTED</span></h2>
      <div class="grid2">
        <label class="span2">Printer address<input id="pUrl" placeholder="192.168.1.50 or u1.local" autocomplete="off" inputmode="url"></label>
        <label class="span2">Moonraker API key (optional)<input id="pKey" type="password" autocomplete="off"></label>
      </div>
      <div class="controls">
        <button id="pConnect">Connect</button>
        <button id="pNotify" class="secondary" hidden>Enable notifications</button>
      </div>
      <p class="status" id="pConnStatus"></p>
      <div class="warnbox" id="pMixed" hidden></div>
      <p class="hint">Talks to Moonraker straight from this tab. The printer must allow this page's origin:
        <code>[authorization] cors_domains: <span id="pOrigin"></span></code> in <code>moonraker.conf</code>.</p>
    </section>

    <section class="card" id="pStatusCard" hidden>
      <h2>Status <span class="badge" id="pMode"><i class="dot"></i><span>offline</span></span></h2>
      <p class="filename" id="pFile">No active print</p>
      <div class="pbar" aria-hidden="true"><i id="pBar"></i></div>
      <div class="kv" id="pKv"></div>
      <div class="temps" id="pTemps"></div>
      <div class="controls">
        <button id="pPause" class="secondary" hidden>Pause</button>
        <button id="pResume" hidden>Resume</button>
        <button id="pCancel" class="danger" hidden>Stop print</button>
        <button id="pLed" class="secondary">Light</button>
        <button id="pCool" class="secondary">Cool down</button>
        <a id="pScreen" class="hint" target="_blank" rel="noopener" hidden>Remote screen ↗</a>
      </div>
      <p class="status" id="pCtlStatus"></p>
    </section>

    <section class="card" id="pCamCard" hidden>
      <h2>Camera</h2>
      <div class="camera" id="pCam" title="Click for full screen"><img id="pCamImg" alt="Printer camera"><div class="camhint" id="pCamHint">Connecting to camera…</div></div>
      <div class="controls">
        <select id="pCamMode" style="width:auto">
          <option value="snapshot">Snapshot refresh</option>
          <option value="stream">Live stream (MJPEG)</option>
        </select>
        <a id="pCamOpen" class="hint" target="_blank" rel="noopener">Open camera in a new tab ↗</a>
      </div>
    </section>
  </div>

  <div class="pcol">
    <section class="card" id="pSlotsCard">
      <h2>Filaments</h2>
      <div class="slots" id="pSlots"></div>
      <div class="controls">
        <button id="pSync" class="secondary">Sync from printer</button>
      </div>
      <p class="hint">Slots are remembered in this browser. Sync reads the printer's RFID tags (<code>print_task_config</code>) and matches them against the bundled OpenPrintTag library.</p>
    </section>

    <section class="card" id="pJobsCard">
      <h2>Print</h2>
      <div id="pSliced" class="file" hidden></div>
      <div class="controls">
        <label class="secondary" style="display:inline-block">
          <span class="hint" style="margin:0">Print a G-code file from this device:</span>
          <input id="pLocalFile" type="file" accept=".gcode,.gco,.g,text/plain">
        </label>
      </div>
      <h2 style="margin-top:14px">On the printer</h2>
      <div class="files" id="pFiles"><p class="hint">Connect to list the printer's G-code files.</p></div>
      <div class="controls"><button id="pRefreshFiles" class="secondary small">Refresh</button></div>
    </section>
  </div>
</div>
<dialog class="sheet" id="pDialog"></dialog>
<dialog class="sheet wide" id="pLib"></dialog>
<dialog class="sheet" id="pConfirm"></dialog>`;

$('pOrigin').textContent = location.origin;
$('pUrl').value = store.get(KEYS.url) ?? '';
$('pKey').value = store.get(KEYS.key) ?? '';
$('pCamMode').value = store.get(KEYS.camMode) ?? 'snapshot';

// Keep the slicer's "Send to printer" card in sync with the same settings.
const slicerUrl = $('printerUrl'), slicerKey = $('apiKey');
if (slicerKey && !slicerKey.value) slicerKey.value = $('pKey').value;
const syncField = (a, b, key) => {
  if (!a) return;
  a.addEventListener('change', () => { store.set(key, a.value); if (b) b.value = a.value; });
};
syncField($('pUrl'), slicerUrl, KEYS.url);
syncField($('pKey'), slicerKey, KEYS.key);
syncField(slicerUrl, $('pUrl'), KEYS.url);
syncField(slicerKey, $('pKey'), KEYS.key);

// ---- app tabs ---------------------------------------------------------------------------------
function showTab(tab) {
  const printer = tab === 'printer';
  S.visible = printer;
  $('appTabSlicer').setAttribute('aria-pressed', String(!printer));
  $('appTabPrinter').setAttribute('aria-pressed', String(printer));
  slicerView.hidden = printer;
  view.hidden = !printer;
  if (location.hash !== (printer ? '#printer' : '') && !(location.hash === '' && !printer)) {
    history.replaceState(null, '', printer ? '#printer' : location.pathname + location.search);
  }
  if (printer && !S.client && $('pUrl').value.trim()) connect();
  updateCamera();
}
$('appTabSlicer').onclick = () => showTab('slicer');
$('appTabPrinter').onclick = () => showTab('printer');
document.addEventListener('visibilitychange', updateCamera);

// ---- toasts + notifications ---------------------------------------------------------------------
function toast(title, body = '', ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${body ? esc(body) : ''}`;
  el.onclick = () => el.remove();
  toasts.append(el);
  while (toasts.children.length > 3) toasts.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}
function notifyEvent(e) {
  const title = eventTitle(e), body = eventBody(e);
  toast(title, body);
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, tag: 'u1-print' });
  } catch { /* unsupported */ }
}
if ('Notification' in window && Notification.permission === 'default') $('pNotify').hidden = false;
$('pNotify').onclick = async () => {
  try { await Notification.requestPermission(); } catch { /* ignore */ }
  $('pNotify').hidden = Notification.permission !== 'default';
};

// ---- confirm dialog -------------------------------------------------------------------------------
/** Resolves true only when the user presses the confirm button. */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, details = '' }) {
  const d = $('pConfirm');
  d.innerHTML = `<form method="dialog">
    <div class="dhead"><h3>${esc(title)}</h3></div>
    <div class="dbody"><div>${body}</div>${details}</div>
    <div class="dfoot"><button value="cancel" class="secondary" id="pConfirmNo">Cancel</button>
      <button value="ok" class="${danger ? 'danger' : ''}" id="pConfirmYes">${esc(confirmLabel)}</button></div></form>`;
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
    $('pConfirmNo').focus();
  });
}

const setStatus = (id, text, kind = '') => { const el = $(id); el.textContent = text; el.className = `status ${kind}`; };

// ---- connection -------------------------------------------------------------------------------------
function showMixedContentNote() {
  const url = normalizeUrl($('pUrl').value);
  const reason = url ? mixedContentReason(url, location.href) : null;
  $('pMixed').hidden = !reason;
  $('pMixed').textContent = reason ?? '';
}
$('pUrl').addEventListener('input', showMixedContentNote);
showMixedContentNote();

async function connect() {
  disconnect(true);
  const url = $('pUrl').value.trim();
  if (!url) { setStatus('pConnStatus', 'Enter the printer address first.', 'error'); return; }
  store.set(KEYS.url, url);
  store.set(KEYS.key, $('pKey').value.trim());
  const client = new MoonrakerClient({ url, apiKey: $('pKey').value });
  S.client = client;
  $('pConnect').textContent = 'Disconnect';
  setStatus('pConnStatus', `Connecting to ${client.baseUrl}…`);
  try {
    S.info = await client.info();
  } catch (e) {
    if (S.client !== client) return;
    S.client = null;
    $('pConnect').textContent = 'Connect';
    setStatus('pConnStatus', e.message, 'error');
    return;
  }
  if (S.client !== client) return;
  S.connected = true;
  setStatus('pConnStatus', `Connected to ${S.info.hostname || client.baseUrl} · Moonraker ${S.info.moonraker} · Klipper ${S.info.klippyState}`, 'ok');
  $('pStatusCard').hidden = $('pCamCard').hidden = false;
  const screen = remoteScreenUrl(client.baseUrl);
  if (screen) { $('pScreen').href = screen; $('pScreen').hidden = false; }
  S.live = new LiveConnection(client, {
    onStatus: (objects, err) => onObjects(objects, err),
    onMode: (m) => { S.mode = m; renderMode(); },
    onError: (msg) => setStatus('pCtlStatus', msg),
  });
  S.live.start();
  client.webcams().then((c) => { if (S.client === client) { S.cams = c; S.camIdx = 0; updateCamera(); } });
  refreshFiles();
}

function disconnect(silent = false) {
  S.live?.stop();
  S.live = null;
  S.client = null;
  S.connected = false;
  S.mode = 'offline';
  stopCamera();
  S.status = makeStatus({ state: 'disconnected' });
  S.prevState = 'disconnected';
  S.failures = 0;
  $('pConnect').textContent = 'Connect';
  $('pStatusCard').hidden = $('pCamCard').hidden = true;
  if (!silent) setStatus('pConnStatus', 'Disconnected.');
  render();
}
$('pConnect').onclick = () => (S.client ? disconnect() : connect());

function renderMode() {
  const m = S.mode;
  $('pMode').querySelector('.dot').className = `dot ${m === 'websocket' ? 'on' : m === 'polling' ? 'warn' : ''}`;
  $('pMode').querySelector('span').textContent = m === 'websocket' ? 'live' : m === 'polling' ? 'polling' : 'offline';
  $('pMode').title = m === 'websocket' ? 'Live updates over Moonraker\'s websocket'
    : m === 'polling' ? 'Websocket unavailable — polling every 2 s' : 'Not connected';
}

// ---- status -------------------------------------------------------------------------------------------
function onObjects(objects, err) {
  const raw = err || !objects ? makeStatus({ state: 'disconnected' }) : parseStatus(objects);
  const [effective, failures] = applyGracePeriod(raw.state, S.prevState, S.failures);
  S.failures = failures;
  // Within the grace period keep showing the last good numbers.
  if (raw.state !== 'disconnected' || effective === 'disconnected') S.status = raw;
  const ev = detectTransition(S.prevState, effective, raw.filename || S.status.filename, raw.progressPercent);
  // Connecting to a printer that is already printing is not news; a start we just sent is.
  if (ev && (S.prevState !== 'disconnected' || S.justSentUntil)) notifyEvent(ev);
  S.prevState = effective;
  if (S.status.isPrinting || S.status.isPaused) S.justSentUntil = 0;
  if (objects && !err) {
    const led = parseLedState(objects['led cavity_led']);
    if (led != null) S.led = led;
    const p = parsePrintPreferences(objects.print_task_config);
    if (p) S.prefs = p;
    S.printerSlots = objects.print_task_config ? objects.print_task_config : null;
  }
  if (S.status.filename && S.metaFor !== S.status.filename && S.client) {
    S.metaFor = S.status.filename;
    S.fileMeta = null;
    S.client.fileMetadata(S.status.filename).then((m) => { S.fileMeta = m; render(); }).catch(() => {});
  }
  render();
}

function render() {
  const s = S.status;
  const justSent = S.justSentUntil > Date.now();
  const badgeText = S.connected ? resolveStatusBadge(s.state, justSent) : 'DISCONNECTED';
  const badge = $('pBadge');
  badge.textContent = badgeText;
  badge.className = `badge ${justSent && badgeText.startsWith('STARTING') ? 'starting' : s.state}`;
  renderMode();
  if (!S.connected) { document.title = 'U1 Web Slicer'; renderSlots(); return; }
  const active = s.isPrinting || s.isPaused;
  $('pFile').textContent = s.filename || (justSent ? 'Starting…' : 'No active print');
  $('pBar').style.width = `${Math.max(0, Math.min(100, s.progress * 100))}%`;
  const remaining = active ? estimateRemainingSeconds(s, S.fileMeta?.estimated_time) : null;
  const layer = s.currentLayer != null && s.totalLayers ? `${s.currentLayer} / ${s.totalLayers}` : '—';
  const kv = [
    [active || s.state === 'complete' ? `${s.progressPercent}%` : '—', 'progress'],
    [layer, 'layer'],
    [s.printDuration ? s.printTimeFormatted : '—', 'elapsed'],
    [remaining != null ? formatDuration(remaining) : '—', 'remaining'],
    [s.filamentUsed ? `${(s.filamentUsed / 1000).toFixed(2)} m` : '—', 'filament used'],
    [S.fileMeta?.filament_weight_total ? fmtGrams(S.fileMeta.filament_weight_total) : '—', 'job filament'],
  ];
  $('pKv').innerHTML = kv.map(([v, k]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  const temps = s.extruders.map((e) => [`E${e.index + 1}`, e.temp, e.target, S.slots[e.index]?.color]);
  temps.push(['Bed', s.bedTemp, s.bedTarget, null]);
  $('pTemps').innerHTML = temps.map(([n, t, tg, col]) => `<div class="temp${tg > 0 ? ' hot' : ''}">
    <span>${col ? `<i class="dot" style="background:${esc(col)}"></i> ` : ''}${esc(n)}</span><b>${fmtTemp(t)}</b> / ${tg > 0 ? fmtTemp(tg) : 'off'}</div>`).join('');
  $('pPause').hidden = !s.isPrinting;
  $('pResume').hidden = !s.isPaused;
  $('pCancel').hidden = !active;
  $('pLed').textContent = S.led == null ? 'Light' : S.led ? 'Light: on' : 'Light: off';
  $('pLed').setAttribute('aria-pressed', String(!!S.led));
  document.title = progressShouldShow(s) ? `${progressTitle(s)} · U1 Web Slicer` : 'U1 Web Slicer';
  renderSlots();
}

// ---- controls (all confirmed) ------------------------------------------------------------------------
async function control(fn, okText) {
  if (!S.client) return;
  try {
    await fn(S.client);
    setStatus('pCtlStatus', okText, 'ok');
  } catch (e) { setStatus('pCtlStatus', e.message, 'error'); }
}
$('pPause').onclick = async () => {
  if (await confirmDialog({ title: 'Pause print?', body: `Pause <b>${esc(S.status.filename)}</b>? The printer parks the head and holds temperatures.`, confirmLabel: 'Pause' })) {
    control((c) => c.pausePrint(), 'Pause requested.');
  }
};
$('pResume').onclick = async () => {
  if (await confirmDialog({ title: 'Resume print?', body: `Resume <b>${esc(S.status.filename)}</b>? The head will move back and continue printing.`, confirmLabel: 'Resume' })) {
    control((c) => c.resumePrint(), 'Resume requested.');
  }
};
$('pCancel').onclick = async () => {
  if (await confirmDialog({ title: 'Stop this print?', body: `Cancel <b>${esc(S.status.filename)}</b> at ${S.status.progressPercent}%? This cannot be undone.`, confirmLabel: 'Stop print', danger: true })) {
    control((c) => c.cancelPrint(), 'Cancel requested.');
  }
};
$('pLed').onclick = async () => {
  const on = !S.led;
  await control((c) => c.setLed(on), `Light ${on ? 'on' : 'off'}.`);
  S.led = on;
  render();
};
$('pCool').onclick = async () => {
  if (await confirmDialog({ title: 'Turn off all heaters?', body: 'Sends <code>TURN_OFF_HEATERS</code>: the bed and every nozzle stop heating. During a print this will ruin it.', confirmLabel: 'Cool down', danger: S.status.isPrinting })) {
    control((c) => c.sendGcode('TURN_OFF_HEATERS'), 'Heaters off.');
  }
};

// ---- camera --------------------------------------------------------------------------------------------
function stopCamera() {
  S.camLoop = null;
  clearTimeout(S.camTimer);
  S.camTimer = null;
  clearInterval(S.keepalive);
  S.keepalive = null;
  const img = $('pCamImg');
  img.onerror = img.onload = null;
  img.removeAttribute('src');
  if (S.camUrl) URL.revokeObjectURL(S.camUrl);
  S.camUrl = null;
}

function updateCamera() {
  const want = S.visible && S.connected && !document.hidden;
  stopCamera();
  if (!want) return;
  const hint = $('pCamHint');
  const { snapshots, streams } = S.cams;
  $('pCamOpen').href = streams[0] ?? snapshots[0] ?? '#';
  // Keep the U1's monitor.jpg fresh (MoonrakerClient.wakeCamera, every 2 s like the app).
  S.keepalive = setInterval(() => S.live?.notify('camera.start_monitor', { domain: 'lan', interval: 0 }), 2000);
  S.live?.notify('camera.start_monitor', { domain: 'lan', interval: 0 });
  const mode = $('pCamMode').value;
  if (mode === 'stream' && streams.length) {
    hint.textContent = 'Connecting to stream…';
    hint.hidden = false;
    const img = $('pCamImg');
    // Cross-origin isolated page (COEP): the stream must be CORS-enabled.
    img.crossOrigin = 'anonymous';
    let i = 0;
    img.onload = () => { hint.hidden = true; };
    img.onerror = () => {
      if (++i < streams.length) { img.src = streams[i]; return; }
      hint.textContent = 'The MJPEG stream did not load here (it needs CORS headers on the webcam server). Showing snapshots instead.';
      hint.hidden = false;
      img.onerror = null;
      startSnapshots();
    };
    img.src = streams[0];
    return;
  }
  if (!snapshots.length) { hint.textContent = 'No camera found.'; hint.hidden = false; return; }
  hint.textContent = 'Connecting to camera…';
  hint.hidden = false;
  startSnapshots();
}

function startSnapshots() {
  const loop = {};
  S.camLoop = loop;
  pollSnapshot(loop);
}

/** The app's loop: refresh every 500 ms, walk the candidate list on failure. */
async function pollSnapshot(loop) {
  S.camTimer = null;
  const { snapshots } = S.cams;
  const client = S.client;
  if (S.camLoop !== loop || !client || !snapshots.length) return;
  const url = snapshots[Math.min(S.camIdx, snapshots.length - 1)];
  try {
    const blob = await client.snapshot(url);
    if (S.camLoop !== loop) return;
    const img = $('pCamImg');
    img.removeAttribute('crossorigin');
    const next = URL.createObjectURL(blob);
    img.src = next;
    if (S.camUrl) URL.revokeObjectURL(S.camUrl);
    S.camUrl = next;
    S.camFails = 0;
    $('pCamHint').hidden = true;
    $('pCamOpen').href = url;
  } catch {
    S.camFails++;
    if (S.camIdx < snapshots.length - 1) S.camIdx++;
    else if (S.camFails > snapshots.length) {
      $('pCamHint').hidden = false;
      $('pCamHint').textContent = 'No camera image. Snapshots are fetched with CORS, so the webcam server must allow this page\'s origin — or open the camera in a new tab.';
      S.camIdx = 0;
    }
  }
  if (S.camLoop === loop) S.camTimer = setTimeout(() => pollSnapshot(loop), S.camFails > snapshots.length ? 5000 : 500);
}
$('pCamMode').onchange = () => { store.set(KEYS.camMode, $('pCamMode').value); S.camIdx = 0; S.camFails = 0; updateCamera(); };
$('pCam').onclick = () => { const el = $('pCam'); if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.(); };

// ---- filament slots ---------------------------------------------------------------------------------------
function saveSlots() {
  store.set(KEYS.slots, serializeSlots(S.slots));
  window.dispatchEvent(new CustomEvent('u1:slots', { detail: S.slots.map((s) => ({ ...s })) }));
}

function renderSlots() {
  const ptc = S.printerSlots;
  $('pSlots').innerHTML = S.slots.map((s) => {
    const loaded = ptc?.filament_exist ? Number(ptc.filament_exist[s.index]) !== 0 && ptc.filament_exist[s.index] !== false : null;
    return `<div class="slot" data-slot="${s.index}">
      <span class="sw" style="background:${esc(s.color)};color:${inkFor(s.color)}">${slotLabel(s)}</span>
      <span class="meta"><b>${esc(s.materialType)}${s.name ? ` · ${esc(s.name)}` : ''}</b>
        <span>${esc(s.color)} · nozzle ${s.nozzleTemp}° · bed ${s.bedTemp}°${loaded === false ? ' · <em>empty on printer</em>' : ''}</span></span>
      <button class="secondary small" data-edit="${s.index}">Edit</button></div>`;
  }).join('');
  for (const b of $('pSlots').querySelectorAll('[data-edit]')) b.onclick = () => editSlot(Number(b.dataset.edit));
}

function loadLibrary() {
  S.libraryPromise ??= fetch('filament_library.json').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }).then((t) => (S.library = parseLibrary(t))).catch((e) => { S.libraryPromise = null; throw e; });
  return S.libraryPromise;
}

function editSlot(index, initial = null) {
  const draft = { ...(initial ?? S.slots[index]) };
  const d = $('pDialog');
  d.className = 'sheet';
  const materials = [...new Set([...MATERIALS, 'PLA-CF', 'PETG-CF', 'PC', 'HIPS', draft.materialType])];
  d.innerHTML = `<form method="dialog" id="pSlotForm">
    <div class="dhead"><h3>Edit E${index + 1}</h3><button value="cancel" class="x" aria-label="Close">×</button></div>
    <div class="dbody">
      <div class="grid2">
        <label>Material<select id="sMat">${materials.map((m) => `<option ${m === draft.materialType ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
        <label>Colour<input id="sCol" type="color" value="${esc(draft.color.toLowerCase())}"></label>
        <label class="span2">Name<input id="sName" value="${esc(draft.name)}" placeholder="e.g. Prusament PLA Galaxy Black"></label>
        <label>Nozzle (°C)<input id="sNoz" type="number" min="0" max="300" value="${draft.nozzleTemp}"></label>
        <label>Bed (°C)<input id="sBed" type="number" min="0" max="120" value="${draft.bedTemp}"></label>
      </div>
      <button type="button" class="secondary" id="sLib">Pick from filament library…</button>
      <label class="check"><input type="checkbox" id="sWrite" ${S.connected ? '' : 'disabled'}> Also write material and colour to the printer's slot (<code>SET_PRINT_FILAMENT_CONFIG</code>)</label>
      <p class="hint">Temperatures here are this slot's defaults; slicing uses the Slicer tab's settings.</p>
    </div>
    <div class="dfoot"><button value="cancel" class="secondary">Cancel</button><button value="save" id="sSave">Save</button></div></form>`;
  const read = () => {
    if ((draft.name || '') !== $('sName').value.trim() || draft.color !== $('sCol').value.toUpperCase()) draft.librarySlug = null;
    draft.materialType = $('sMat').value;
    draft.color = $('sCol').value.toUpperCase();
    draft.name = $('sName').value.trim();
    draft.nozzleTemp = Math.max(0, Math.min(300, Number($('sNoz').value) || 0));
    draft.bedTemp = Math.max(0, Math.min(120, Number($('sBed').value) || 0));
  };
  $('sMat').onchange = () => {
    $('sNoz').value = defaultNozzleFor($('sMat').value);
    $('sBed').value = defaultBedFor($('sMat').value);
    draft.librarySlug = null;
  };
  let picking = false;
  $('sLib').onclick = () => {
    read();
    picking = true;
    d.close('library');
    openLibrary(draft.materialType, (entry) => {
      S.recents = updateRecents(S.recents, entry.slug);
      store.set(KEYS.recents, encodeSlugList(S.recents));
      editSlot(index, libraryEntryToSlot(entry, draft));
    }, () => editSlot(index, draft));
  };
  d.addEventListener('close', async () => {
    if (picking || d.returnValue !== 'save') return;
    read();
    S.slots[index] = { ...draft, index };
    saveSlots();
    renderSlots();
    if ($('sWrite').checked && S.client) {
      try {
        await S.client.sendGcode(buildFilamentConfigGcode({ index, materialType: draft.materialType, subType: draft.subType, color: draft.color, vendor: draft.vendor }));
        toast(`E${index + 1} updated on the printer`);
      } catch (e) { toast('Printer did not accept the slot change', e.message, 8000); }
    }
  }, { once: true });
  d.returnValue = '';
  if (!d.open) d.showModal();
}

/** Filament library picker (FilamentLibraryPicker): search, material chips, favourites/recents, import preview. */
function openLibrary(material, onPick, onCancel) {
  const d = $('pLib');
  d.innerHTML = `<form method="dialog">
    <div class="dhead"><h3>Filament library</h3><button value="cancel" class="x" aria-label="Close">×</button></div>
    <div class="dbody libsearch">
      <input id="lQ" type="search" placeholder="Search brand, name or material" autocomplete="off">
      <div class="libchips" id="lChips"></div>
      <div class="liblist" id="lList"><p class="hint">Loading library…</p></div>
      <div id="lDetail"></div>
      <p class="hint" id="lSnap"></p>
    </div>
    <div class="dfoot"><button value="cancel" class="secondary">Cancel</button></div></form>`;
  let mat = null, selected = null;
  d.addEventListener('close', () => { if (d.returnValue === 'use' && selected) onPick(selected); else onCancel?.(); }, { once: true });
  d.returnValue = '';
  d.showModal();
  const draw = () => {
    const lib = S.library;
    const res = lib.search($('lQ').value, { material: mat, favourites: S.favourites, recents: S.recents, limit: 200 });
    $('lList').innerHTML = res.length ? res.map((e) => `<div class="libitem" data-slug="${esc(e.slug)}" role="button" tabindex="0">
        <span class="sw ${e.hex ? '' : 'none'}" style="${e.hex ? `background:${esc(e.hex)}` : ''}"></span>
        <span>${esc(displayName(e))}<br><small>${esc(e.material)}${e.materialRaw ? ` (${esc(e.materialRaw)})` : ''}</small></span>
        <button type="button" class="star" data-star="${esc(e.slug)}" aria-pressed="${S.favourites.has(e.slug)}" aria-label="Favourite">★</button>
        <button type="button" class="small" data-use="${esc(e.slug)}">Use</button></div>`).join('')
      : '<p class="hint">No filaments match.</p>';
    for (const el of $('lList').querySelectorAll('[data-star]')) {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const slug = el.dataset.star;
        if (S.favourites.has(slug)) S.favourites.delete(slug); else S.favourites.add(slug);
        store.set(KEYS.favs, encodeSlugList([...S.favourites]));
        el.setAttribute('aria-pressed', String(S.favourites.has(slug)));
      };
    }
    for (const el of $('lList').querySelectorAll('[data-use]')) {
      el.onclick = (ev) => { ev.stopPropagation(); selected = lib.entry(el.dataset.use); d.close('use'); };
    }
    for (const el of $('lList').querySelectorAll('.libitem')) {
      el.onclick = () => showDetail(lib.entry(el.dataset.slug));
      el.onkeydown = (ev) => { if (ev.key === 'Enter') showDetail(lib.entry(el.dataset.slug)); };
    }
  };
  const showDetail = (e) => {
    const rows = hasImportableData(e) ? buildImportPreview(e) : [];
    $('lDetail').innerHTML = `<div class="warnbox info"><b>${esc(displayName(e))}</b> · ${esc(e.material)}${e.hex ? ` · ${esc(e.hex)}` : ''}
      <div class="preview-rows">${rows.length ? rows.map((r) => `<div>${esc(r.label)}: <b>${esc(r.value)}</b>${r.note ? ` <small>(${esc(r.note)})</small>` : ''}</div>`).join('') : '<small>Colour and material only.</small>'}</div>
      <div class="controls"><button type="button" id="lUse">Use this filament</button></div></div>`;
    $('lUse').onclick = () => { selected = e; d.close('use'); };
  };
  loadLibrary().then((lib) => {
    const mats = topMaterials(lib, 10);
    if (material && mats.includes(material)) mat = material;
    $('lChips').innerHTML = [null, ...mats].map((m) => `<button type="button" data-mat="${esc(m ?? '')}" aria-pressed="${m === mat}">${esc(m ?? 'All')}</button>`).join('');
    for (const b of $('lChips').querySelectorAll('button')) {
      b.onclick = () => {
        mat = b.dataset.mat || null;
        for (const x of $('lChips').querySelectorAll('button')) x.setAttribute('aria-pressed', String((x.dataset.mat || null) === mat));
        draw();
      };
    }
    $('lSnap').textContent = `OpenPrintTag snapshot ${lib.snapshot.commit} · ${lib.snapshot.date} · ${lib.snapshot.count.toLocaleString()} filaments (CC BY-SA, see filament_library.NOTICE.txt)`;
    $('lQ').oninput = draw;
    draw();
    $('lQ').focus();
  }).catch((e) => {
    $('lList').innerHTML = `<p class="status error">Could not load the library: ${esc(e.message)}</p><button type="button" class="secondary small" id="lRetry">Retry</button>`;
    $('lRetry').onclick = () => { d.close(); openLibrary(material, onPick, onCancel); };
  });
}

/** RFID sync (SyncFilamentsDialog): preview current → printer values, then apply. */
$('pSync').onclick = async () => {
  if (!S.client) { toast('Connect to the printer first'); return; }
  const d = $('pDialog');
  d.className = 'sheet';
  d.innerHTML = '<form method="dialog"><div class="dhead"><h3>Sync filaments</h3><button value="cancel" class="x" aria-label="Close">×</button></div><div class="dbody"><p class="hint">Reading the printer\'s filament slots…</p></div></form>';
  d.returnValue = '';
  d.showModal();
  let printerSlots;
  try { printerSlots = await S.client.queryFilamentSlots(); } catch { printerSlots = null; }
  if (!printerSlots?.length) {
    d.querySelector('.dbody').innerHTML = '<p class="status error">No filament data available from printer</p>';
    return;
  }
  const lib = await loadLibrary().catch(() => null);
  const entries = buildSyncPreviewEntries(S.slots, printerSlots, lib);
  const sw = (c) => (c ? `<i class="sw" style="background:${esc(c)}"></i>` : '');
  d.innerHTML = `<form method="dialog">
    <div class="dhead"><h3>Sync filaments</h3><button value="cancel" class="x" aria-label="Close">×</button></div>
    <div class="dbody">
      <div>${entries.map((e) => `<div class="sync-row"><b>${esc(e.label)}</b><div>
        <div class="pair">${sw(e.currentColor)} ${esc(e.currentType)} → ${e.newType == null ? '<em>no data</em>' : `${sw(e.newColor)} ${esc(e.newType)}`}${e.loaded === false ? ' <small>(empty)</small>' : ''}</div>
        ${e.matchedName ? `<small>Matched: ${esc(e.matchedName)}</small>` : e.vendor ? `<small>${esc(e.vendor)}${e.subType ? ` ${esc(e.subType)}` : ''}</small>` : ''}</div></div>`).join('')}</div>
      <label class="check"><input type="checkbox" id="syC" checked> Apply colours</label>
      <label class="check"><input type="checkbox" id="syT" checked> Apply material types</label>
      ${lib ? '' : '<p class="hint">Filament library unavailable — raw RFID values only.</p>'}
    </div>
    <div class="dfoot"><button value="cancel" class="secondary">Cancel</button><button value="apply" id="syApply">Apply</button></div></form>`;
  d.addEventListener('close', () => {
    if (d.returnValue !== 'apply') return;
    const applyColors = $('syC').checked, applyTypes = $('syT').checked;
    S.slots = applySyncPreviewEntries(S.slots, entries, { applyColors, applyTypes });
    if (applyColors || applyTypes) {
      for (const slug of entries.map((e) => e.matchedSlug).filter(Boolean)) S.recents = updateRecents(S.recents, slug);
      store.set(KEYS.recents, encodeSlugList(S.recents));
    }
    saveSlots();
    renderSlots();
    toast('Filaments synced from the printer');
  }, { once: true });
};

// ---- files ------------------------------------------------------------------------------------------------
async function refreshFiles() {
  if (!S.client) return;
  try {
    S.files = await S.client.listFiles();
    $('pFiles').innerHTML = S.files.length ? S.files.slice(0, 50).map((f, i) => `<div class="file"><span title="${esc(f.path)}">${esc(f.path)}</span>
      <button class="secondary small" data-remote="${i}">Print…</button></div>`).join('') : '<p class="hint">No G-code files on the printer.</p>';
    for (const b of $('pFiles').querySelectorAll('[data-remote]')) b.onclick = () => openPrintConfig({ remote: S.files[Number(b.dataset.remote)].path });
  } catch (e) {
    $('pFiles').innerHTML = `<p class="status error">${esc(e.message)}</p>`;
  }
}
$('pRefreshFiles').onclick = refreshFiles;
$('pLocalFile').onchange = () => {
  const f = $('pLocalFile').files[0];
  if (f) openPrintConfig({ blob: f, name: f.name });
  $('pLocalFile').value = '';
};

function renderSliced() {
  const el = $('pSliced');
  if (!S.sliced) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>Sliced: <b>${esc(S.sliced.name)}</b></span><button class="small" id="pPrintSliced">Print…</button>`;
  $('pPrintSliced').onclick = () => openPrintConfig({ blob: S.sliced.blob, name: S.sliced.name, toolMap: S.sliced.toolMap, modelName: S.sliced.modelName });
}
window.addEventListener('u1:sliced', (ev) => {
  S.sliced = ev.detail;
  renderSliced();
  // A "Print…" shortcut on the slicer's Send-to-printer card.
  const row = $('upload')?.parentElement;
  if (row && !$('printSliced')) {
    const b = document.createElement('button');
    b.id = 'printSliced';
    b.textContent = 'Print…';
    b.title = 'Configure filaments and print preferences, then start on the printer';
    b.onclick = () => { showTab('printer'); $('pPrintSliced')?.click(); };
    row.prepend(b);
  }
});

// ---- print configuration (plate → printer → filaments → preferences → start) --------------------------------
async function openPrintConfig(src) {
  const d = $('pDialog');
  d.className = 'sheet wide';
  d.innerHTML = '<form method="dialog"><div class="dhead"><h3>Print</h3><button value="cancel" class="x" aria-label="Close">×</button></div><div class="dbody"><p class="hint">Reading G-code…</p></div></form>';
  d.returnValue = '';
  if (!d.open) d.showModal();

  let summary = null, thumb = null, text = null, meta = null;
  const name = src.remote ?? src.name;
  if (src.blob) {
    text = await src.blob.text();
    summary = summarizeGcode(text);
    thumb = extractThumbnail(text);
  } else if (S.client) {
    meta = await S.client.fileMetadata(src.remote).catch(() => null);
    const big = (meta?.thumbnails ?? []).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (big?.relative_path) thumb = `${S.client.baseUrl}/server/files/gcodes/${encodeURI(big.relative_path)}`;
  }
  const cards = summary ? buildFilamentCards(summary, src.toolMap ?? null) : [];
  const heads = cards.map((c) => Math.min(3, Math.max(0, c.tool)));
  const prefs = { ...(savedPrefs ?? {}), ...Object.fromEntries(Object.entries(S.prefs ?? {}).filter(([, v]) => v != null)) };
  prefs.bedLevel ??= true; prefs.flowCalibrate ??= false; prefs.timeLapse ??= false;

  const secs = summary?.estimatedSeconds ?? meta?.estimated_time ?? null;
  const grams = summary?.totalGrams ?? meta?.filament_weight_total ?? null;
  const nozzle = summary?.nozzleDiameter ?? meta?.nozzle_diameter ?? null;
  const chips = cards.length ? cards.map((c) => `<span class="chip" style="background:${esc(c.color ?? '#9aa3b2')};color:${inkFor(c.color)}">${esc(c.material)} | ${fmtGrams(c.grams)}</span>`).join('')
    : meta?.filament_name ? `<span class="chip">${esc(meta.filament_name)}</span>` : '';
  const online = S.connected && S.status.isConnected;
  const busy = S.status.isPrinting || S.status.isPaused;
  const slotOpt = (h) => S.slots.map((s) => `<option value="${s.index}" ${s.index === h ? 'selected' : ''}>Head ${s.index + 1} · ${esc(s.materialType)}</option>`).join('');
  const toggle = (id, label, sub, on) => `<div class="pref"><span>${label}<small>${sub}</small></span><span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${esc(label)}"><i></i></span></div>`;

  d.innerHTML = `<form method="dialog" id="pcForm">
    <div class="dhead"><h3>Print</h3><button value="cancel" class="x" aria-label="Close">×</button></div>
    <div class="dbody">
      <div class="sec"><h4>Select a Plate to Print</h4>
        <div class="plate"><div class="thumb">${thumb ? `<img alt="" src="${esc(thumb)}">` : 'no preview'}</div>
          <div><b style="overflow-wrap:anywhere">${esc(name)}</b>
            <div class="facts"><span>⏱ <b>${secs != null ? esc(formatDuration(secs)) : '—'}</b></span><span>⚖ <b>${grams != null ? fmtGrams(grams) : '—'}</b></span><span>Nozzle <b>${nozzle ? `${nozzle} mm` : '—'}</b></span>${summary?.layers ? `<span>Layers <b>${summary.layers}</b></span>` : ''}</div>
            <div class="chips">${chips}</div></div></div></div>
      <div class="sec"><h4>Confirm Printer</h4>
        <div class="printer-row"><i class="dot ${online ? 'on' : ''}"></i><b>${esc(S.info?.hostname || (S.client?.baseUrl ?? 'No printer connected'))}</b>
          <span class="hint" style="margin:0">${online ? (busy ? 'busy — ' + esc(S.status.state) : 'online') : 'offline'}</span></div></div>
      ${src.remote ? `<div class="warnbox info">This file is already on the printer and prints exactly as uploaded (its own tool assignment). To re-map filaments, print it from the slicer or this device instead.</div>` : `
      <div class="sec"><h4>Configure Filaments</h4>
        <div class="fil-cards" id="pcFils">${cards.map((c, k) => `<div class="fil"><div class="top"><span class="sw" style="background:${esc(c.color ?? '#9aa3b2')}"></span>
          <span><b>${esc(c.material)}</b> <span>${fmtGrams(c.grams)} · T${c.tool}</span></span></div>
          <select data-card="${k}" aria-label="Tool head for filament ${k + 1}">${slotOpt(heads[k])}</select><span class="warn" id="pcWarn${k}"></span></div>`).join('') || '<p class="hint">No tool changes found in this G-code.</p>'}</div>
        <p class="hint" id="pcShared"></p></div>`}
      <div class="sec"><h4>Print Preferences</h4>
        ${toggle('pfFlow', 'Extrusion Flow Calibration', 'SM_PRINT_FLOW_CALIBRATE in the start G-code runs only when enabled', prefs.flowCalibrate)}
        ${toggle('pfLevel', 'Auto Leveling', 'Bed mesh before printing (BED_MESH_CALIBRATE)', prefs.bedLevel)}
        ${toggle('pfLapse', 'Time-lapse Camera', 'Records frames at each layer change', prefs.timeLapse)}
        <p class="hint">Sent as <code id="pcPrefG"></code> right before the print starts — the same command the Snapmaker app sends.${S.prefs ? '' : ' (The printer did not report its current preferences.)'}</p></div>
      <p class="status" id="pcStatus"></p>
    </div>
    <div class="dfoot">
      ${src.remote ? '' : '<button type="button" class="secondary" id="pcUpload">Upload only</button>'}
      <button type="button" id="pcStart" ${online && !busy ? '' : 'disabled'}>Start Print</button>
    </div></form>`;

  const readPrefs = () => ({ flowCalibrate: $('pfFlow').checked, bedLevel: $('pfLevel').checked, timeLapse: $('pfLapse').checked });
  const updateNotes = () => {
    $('pcPrefG').textContent = buildPrintPreferencesGcode(readPrefs());
    if (!cards.length) return;
    const mism = materialMismatches(cards, heads, S.slots);
    mism.forEach((m, k) => { const el = $(`pcWarn${k}`); if (el) el.textContent = m ?? ''; });
    const shared = sharedHeads(heads);
    $('pcShared').textContent = shared.length ? `Tool head ${shared.map((h) => h + 1).join(', ')} prints more than one filament — they come out in the same colour.` : '';
  };
  for (const sel of d.querySelectorAll('select[data-card]')) sel.onchange = () => { heads[Number(sel.dataset.card)] = Number(sel.value); updateNotes(); };
  for (const id of ['pfFlow', 'pfLevel', 'pfLapse']) $(id).onchange = () => { store.set(KEYS.prefs, JSON.stringify(readPrefs())); updateNotes(); };
  updateNotes();

  const uploadName = buildUploadFilename(src.modelName || name);
  const prepare = () => {
    const target = buildPrintRemap(cards, heads);
    return target.length ? new Blob([self.remapGcode(text, target)], { type: 'text/plain' }) : src.blob;
  };

  $('pcUpload')?.addEventListener('click', async () => {
    if (!S.client) { setStatus('pcStatus', 'Connect to the printer first.', 'error'); return; }
    setStatus('pcStatus', `Uploading ${uploadName}…`);
    try {
      const path = await S.client.upload(src.blob, uploadName);
      setStatus('pcStatus', `Uploaded as ${path}. Not started — start it from the printer or the list.`, 'ok');
      notifyEvent({ type: 'UploadComplete', filename: path });
      refreshFiles();
    } catch (e) { setStatus('pcStatus', e.message, 'error'); }
  });

  $('pcStart').onclick = async () => {
    if (!S.client || busy) return;
    const p = readPrefs();
    const mapping = cards.map((c, k) => `T${c.tool} → head ${heads[k] + 1}`).join(', ');
    const ok = await confirmDialog({
      title: 'Start this print?',
      body: `<b>${esc(name)}</b> will ${src.remote ? '' : 'upload and '}start on <b>${esc(S.info?.hostname || S.client.baseUrl)}</b>. ` +
        'The printer will heat the bed and nozzles and move the tool heads. Make sure the build plate is clear.',
      details: `<div class="hint">${mapping ? `Filaments: ${esc(mapping)}<br>` : ''}Flow calibration: ${p.flowCalibrate ? 'on' : 'off'} · Auto leveling: ${p.bedLevel ? 'on' : 'off'} · Time-lapse: ${p.timeLapse ? 'on' : 'off'}</div>`,
      confirmLabel: 'Start print', danger: true,
    });
    if (!ok) return;
    const client = S.client;
    $('pcStart').disabled = true;
    try {
      let filename = src.remote;
      if (!filename) {
        setStatus('pcStatus', 'Preparing G-code…');
        const body = prepare();
        setStatus('pcStatus', `Uploading ${uploadName}…`);
        filename = await client.upload(body, uploadName);
      }
      setStatus('pcStatus', 'Setting print preferences…');
      await client.sendGcode(buildPrintPreferencesGcode(p));
      setStatus('pcStatus', 'Starting print…');
      // Armed before the call: the websocket can report "printing" before the HTTP reply lands.
      S.justSentUntil = Date.now() + 90_000;
      try { await client.startPrint(filename); } catch (e) { S.justSentUntil = 0; throw e; }
      S.live?.hintJobStarting();
      render();
      d.close('started');
      setStatus('pCtlStatus', `Started ${filename}.`, 'ok');
      refreshFiles();
    } catch (e) {
      setStatus('pcStatus', `${e.message}${src.remote ? '' : ' — the print was not started.'}`, 'error');
      $('pcStart').disabled = false;
    }
  };
}

// ---- boot -----------------------------------------------------------------------------------------------
renderSlots();
render();
if (location.hash === '#printer') showTab('printer');
