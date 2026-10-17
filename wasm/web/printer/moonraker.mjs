// Moonraker client for the Printer tab: a port of the Android app's
// network/MoonrakerClient.kt + network/PrinterStatus.kt (with the X-Api-Key
// behaviour from branch claude/moonraker-api-auth-7zr7fm), plus a live
// connection over Moonraker's JSON-RPC websocket with a polling fallback.
//
// Pure helpers are exported individually so test/printer-moonraker.test.mjs can
// hold them to the Kotlin MoonrakerClientTest cases. Nothing here starts,
// resumes or cancels a print on its own: those calls exist only as explicit
// methods (startPrint/pausePrint/…) that the UI invokes after a confirm dialog.

export const API_KEY_HEADER = 'X-Api-Key';
export const DEFAULT_PORT = 7125;

/**
 * MoonrakerClient.normalizeUrl: adds http:// and Moonraker's default :7125 when
 * no port is given, strips trailing slashes. Blank → ''.
 */
export function normalizeUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    const u = new URL(url);
    // URL drops default ports (http:80), so read the authority literally.
    const authority = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
    const hasPort = /:\d+$/.test(authority) && !authority.endsWith(']');
    if (!hasPort) {
      const path = u.pathname === '/' ? '' : u.pathname;
      url = `${u.protocol}//${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${DEFAULT_PORT}${path}`;
    }
  } catch { /* keep as-is, like the Kotlin catch */ }
  return url.replace(/\/+$/, '');
}

/** True when targetUrl is on the same host as the Moonraker baseUrl (safe to send the key). */
export function isSameHost(baseUrl, targetUrl) {
  try {
    const a = new URL(baseUrl).hostname;
    const b = new URL(targetUrl).hostname;
    return !!a && a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
}

/** Headers for a request to `url`: the API key only goes to the printer's own host. */
export function authHeaders(baseUrl, apiKey, url = baseUrl) {
  const key = String(apiKey ?? '').trim();
  return key && isSameHost(baseUrl, url) ? { [API_KEY_HEADER]: key } : {};
}

/** Bed clamped to [0, 120], extruders to [0, 300] (MoonrakerClient.buildSetHeaterGcode). */
export function buildSetHeaterGcode(heater, targetC) {
  const max = heater === 'heater_bed' ? 120 : 300;
  const clamped = Math.min(max, Math.max(0, Math.trunc(targetC)));
  return `SET_HEATER_TEMPERATURE HEATER=${heater} TARGET=${clamped}`;
}

export const ledGcode = (on) => `SET_LED LED=cavity_led WHITE=${on ? '1.0' : '0'} RED=0 GREEN=0 BLUE=0`;

/** `led cavity_led` status → true/false (W channel of the first RGBW tuple), or null when unknown. */
export function parseLedState(ledObj) {
  const cd = ledObj?.color_data;
  if (!Array.isArray(cd) || !cd.length) return null;
  const rgbw = cd[0];
  const w = Array.isArray(rgbw) && rgbw.length > 3 ? Number(rgbw[3]) : 0;
  return w > 0;
}

/** paxx12 extended firmware remote screen: nginx on port 80, not Moonraker's port. */
export function remoteScreenUrl(baseUrl) {
  if (!baseUrl) return null;
  try { const u = new URL(baseUrl); return `${u.protocol}//${u.hostname}/screen/`; } catch { return null; }
}

// ---- status ---------------------------------------------------------------------

export const STATUS_OBJECTS = ['print_stats', 'virtual_sdcard', 'heater_bed', 'extruder', 'extruder1', 'extruder2', 'extruder3'];
// Extra objects the web tab subscribes to (LED, RFID slots, display progress).
export const SUBSCRIBE_OBJECTS = [...STATUS_OBJECTS, 'led cavity_led', 'print_task_config', 'display_status'];

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Port of MoonrakerClient.getStatus()'s parsing over a `result.status` object.
 * B33: virtual_sdcard.progress wins over print_stats.progress.
 */
export function parseStatus(status) {
  if (!status || typeof status !== 'object') return makeStatus({ state: 'standby' });
  const ps = status.print_stats, vsd = status.virtual_sdcard, bed = status.heater_bed, ex = status.extruder;
  const extruders = [];
  ['extruder', 'extruder1', 'extruder2', 'extruder3'].forEach((name, i) => {
    const e = status[name];
    if (e) extruders.push({ index: i, temp: num(e.temperature), target: num(e.target), active: num(e.target) > 0 });
  });
  const progress = typeof vsd?.progress === 'number' ? vsd.progress
    : typeof ps?.progress === 'number' ? ps.progress : 0;
  return makeStatus({
    state: ps?.state || 'standby',
    progress,
    filename: ps?.filename ?? '',
    printDuration: num(ps?.print_duration),
    totalDuration: num(ps?.total_duration),
    filamentUsed: num(ps?.filament_used),
    nozzleTemp: num(ex?.temperature), nozzleTarget: num(ex?.target),
    bedTemp: num(bed?.temperature), bedTarget: num(bed?.target),
    extruders,
    currentLayer: ps?.info?.current_layer ?? null,
    totalLayers: ps?.info?.total_layer ?? null,
    message: ps?.message ?? '',
  });
}

/** PrinterStatus data class with its computed properties. */
export function makeStatus(fields) {
  const s = {
    state: 'disconnected', progress: 0, filename: '', printDuration: 0, totalDuration: 0, filamentUsed: 0,
    nozzleTemp: 0, nozzleTarget: 0, bedTemp: 0, bedTarget: 0, extruders: [],
    currentLayer: null, totalLayers: null, message: '', ...fields,
  };
  return Object.assign(s, {
    get isConnected() { return s.state !== 'disconnected'; },
    get isPrinting() { return s.state === 'printing'; },
    get isPaused() { return s.state === 'paused'; },
    get isIdle() { return s.state === 'standby' || s.state === 'complete'; },
    // Kotlin multiplies a Float: 0.58f * 100 = 58, where the double product is 57.99…
    get progressPercent() { return Math.trunc(Math.fround(Math.fround(s.progress) * 100)); },
    get printTimeFormatted() { return formatDuration(s.printDuration); },
  });
}

/** "1h 30m" / "45m" — PrinterStatus.printTimeFormatted. */
export function formatDuration(seconds) {
  const totalMin = Math.trunc(Math.max(0, seconds) / 60);
  const h = Math.trunc(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Remaining time: the file's slicer estimate scaled by progress when known,
 * else extrapolated from elapsed print time. Null when not printing yet.
 */
export function estimateRemainingSeconds(status, estimatedTotal) {
  const p = status.progress;
  if (!(p > 0) || p >= 1) return p >= 1 ? 0 : null;
  if (estimatedTotal > 0) return Math.max(0, estimatedTotal * (1 - p));
  if (status.printDuration > 0) return Math.max(0, status.printDuration / p - status.printDuration);
  return null;
}

// ---- filament slots (RFID) -------------------------------------------------------

/** Bambu-style RGBA hex ("E72F1DFF") → "#RRGGBB"; anything else → #808080. */
export function normalizeRgbaHex(rgba) {
  const c = String(rgba ?? '').replace(/^#+/, '').toUpperCase();
  if (c.length === 8) return `#${c.slice(0, 6)}`;
  if (c.length === 6) return `#${c}`;
  return '#808080';
}

export function normalizeMaterialType(raw) {
  const t = String(raw ?? '').toUpperCase().trim();
  switch (t) {
    case 'PLA+': case 'PLA PLUS': case 'PLAP': return 'PLA';
    case 'PET-G': case 'PETG-': case 'PETG+': return 'PETG';
    case 'ABS+': case 'ABS PLUS': return 'ABS';
    case 'FLEX': case 'TPU95A': case 'TPU87A': return 'TPU';
    case 'HIPS-': case 'HIPS+': return 'HIPS';
    default: return String(raw ?? '').trim() || 'PLA';
  }
}

/** print_task_config (Snapmaker U1 firmware) → FilamentSlot[], or null. */
export function parsePrintTaskConfigSlots(ptc) {
  const colors = ptc?.filament_color_rgba;
  if (!Array.isArray(colors) || !colors.length) return null;
  const at = (arr, i, d) => (Array.isArray(arr) && arr[i] != null ? arr[i] : d);
  return colors.map((rgba, i) => ({
    index: i,
    label: `E${i + 1}`,
    color: normalizeRgbaHex(rgba),
    loaded: Number(at(ptc.filament_exist, i, 0)) !== 0 && at(ptc.filament_exist, i, 0) !== false,
    materialType: normalizeMaterialType(at(ptc.filament_type, i, 'PLA')),
    subType: String(at(ptc.filament_sub_type, i, '')),
    manufacturer: String(at(ptc.filament_vendor, i, '')),
  }));
}

/** AFC lanes ({ "AFC_stepper lane1": {...} }) → FilamentSlot[], or null. */
export function parseAfcSlots(afcNames, afcStatus) {
  const slots = [];
  let idx = 0;
  for (const name of afcNames) {
    const o = afcStatus?.[name];
    if (!o) continue;
    const color = o.color ? `#${String(o.color).toUpperCase().replace(/^#+/, '')}` : '#808080';
    const lane = name.slice(name.lastIndexOf(' ') + 1).replace(/\D/g, '');
    idx++;
    slots.push({
      index: idx - 1, label: lane ? `E${lane}` : `E${idx}`, color,
      loaded: o.load_state === true || o.status === 'Loaded',
      materialType: normalizeMaterialType(o.material ?? 'PLA'), subType: '', manufacturer: '',
    });
  }
  return slots.length ? slots : null;
}

/** Current print preferences as the U1 firmware reports them in print_task_config. */
export function parsePrintPreferences(ptc) {
  if (!ptc) return null;
  const b = (v) => (v == null ? null : v === true || Number(v) === 1);
  return { bedLevel: b(ptc.auto_bed_leveling), flowCalibrate: b(ptc.flow_calibrate), timeLapse: b(ptc.time_lapse_camera) };
}

/**
 * Snapmaker's own app (Orca's bundled print dialog, setPrePrintConfiguration)
 * sends this via /printer/gcode/script before starting a print. The U1's
 * print_task_config module persists it; stock firmware rejects it while a print
 * is running or paused. Values are 0/1; null fields are omitted.
 */
export function buildPrintPreferencesGcode({ bedLevel, flowCalibrate, timeLapse } = {}) {
  const parts = [];
  if (bedLevel != null) parts.push(`BED_LEVEL=${bedLevel ? 1 : 0}`);
  if (flowCalibrate != null) parts.push(`FLOW_CALIBRATE=${flowCalibrate ? 1 : 0}`);
  if (timeLapse != null) parts.push(`TIME_LAPSE_CAMERA=${timeLapse ? 1 : 0}`);
  return parts.length ? `SET_PRINT_PREFERENCES ${parts.join(' ')}` : null;
}

/**
 * Writes a slot's filament on the printer (what the Snapmaker app's filament
 * editor sends): SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=i FILAMENT_TYPE='PLA' …
 * colour as RRGGBBAA. Values are quoted; quotes/newlines are stripped so a
 * name cannot inject a second command.
 */
export function buildFilamentConfigGcode({ index, materialType, subType = '', color, vendor = '' }) {
  const clean = (v) => String(v ?? '').replace(/['"\r\n;]/g, '').trim();
  const hex = String(color ?? '').replace(/^#/, '').toUpperCase();
  const rgba = /^[0-9A-F]{6}$/.test(hex) ? `${hex}FF` : /^[0-9A-F]{8}$/.test(hex) ? hex : 'FFFFFFFF';
  const fields = [
    ['CONFIG_EXTRUDER', Math.trunc(index)],
    ['FILAMENT_TYPE', `'${clean(materialType) || 'PLA'}'`],
    ['FILAMENT_SUBTYPE', `'${clean(subType)}'`],
    ['FILAMENT_COLOR_RGBA', `'${rgba}'`],
    ['SAVE', 1],
    ['VENDOR', `'${clean(vendor)}'`],
  ];
  return `SET_PRINT_FILAMENT_CONFIG ${fields.map(([k, v]) => `${k}=${v}`).join(' ')}`;
}

// ---- webcam ------------------------------------------------------------------------

/** MoonrakerClient.resolveWebcamUrl: relative URLs resolve against the printer host. */
export function resolveWebcamUrl(baseUrl, value, keepPort) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  try {
    const u = new URL(baseUrl);
    const host = keepPort ? u.host : u.hostname;
    return `${u.protocol}//${host}/${value.replace(/^\/+/, '')}`;
  } catch {
    return `${baseUrl}/${value.replace(/^\/+/, '')}`;
  }
}

/**
 * queryWebcamSnapshotCandidates() given the /server/webcams/list response (or
 * null when it failed): [primary, alt-with-port] + monitor.jpg last; legacy
 * mjpeg-streamer path when no webcam is configured.
 */
export function webcamSnapshotCandidates(baseUrl, listResponse) {
  if (!baseUrl) return [];
  const monitor = `${baseUrl}/server/files/camera/monitor.jpg`;
  const cam = listResponse?.result?.webcams?.[0];
  const raw = cam?.snapshot_url || cam?.snapshotUrl || '';
  if (raw) {
    const primary = resolveWebcamUrl(baseUrl, raw, false);
    const alt = resolveWebcamUrl(baseUrl, raw, true);
    const c = [primary, alt].filter((x, i, a) => x && a.indexOf(x) === i);
    if (c.length) return [...c, monitor];
  }
  return [`${baseUrl}/webcam/?action=snapshot`, monitor];
}

/** MJPEG stream URLs (web-only: the app polls snapshots), primary first. */
export function webcamStreamCandidates(baseUrl, listResponse) {
  const cam = listResponse?.result?.webcams?.[0];
  const raw = cam?.stream_url || cam?.streamUrl || '';
  if (!baseUrl || !raw) return [];
  return [resolveWebcamUrl(baseUrl, raw, false), resolveWebcamUrl(baseUrl, raw, true)]
    .filter((x, i, a) => x && a.indexOf(x) === i);
}

export function withCacheBuster(url, now = Date.now()) {
  return `${url}${url.includes('?') ? '&' : '?'}_cb=${now}`;
}

// ---- uploads / notifications (PrinterRepository companion) -------------------------

/** PrinterRepository.buildPrinterUploadFilename: sanitised stem + _<millis>.gcode. */
export function buildUploadFilename(sourceName, nowMillis = Date.now(), extension = '.gcode', fallbackBase = 'print') {
  const s = String(sourceName ?? '');
  const dot = s.lastIndexOf('.');
  const stem = dot >= 0 ? s.slice(0, dot) : s;
  const base = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || fallbackBase;
  return `${base}_${nowMillis}${extension}`;
}

export const OFFLINE_GRACE_FAILURES = 3;

/** B39: "disconnected" only counts after 3 consecutive failed polls. Returns [effectiveState, failures]. */
export function applyGracePeriod(rawState, prevState, consecutiveFailures) {
  if (rawState === 'disconnected') {
    const n = consecutiveFailures + 1;
    return [n >= OFFLINE_GRACE_FAILURES ? rawState : prevState, n];
  }
  return [rawState, 0];
}

/** PrinterRepository.detectTransition → event object or null. */
export function detectTransition(prev, curr, filename, progress) {
  const activePrev = prev === 'printing' || prev === 'paused';
  if (curr === 'printing' && prev !== 'printing') return { type: 'PrintStarted', filename };
  if (curr === 'paused' && prev === 'printing') return { type: 'PrintPaused', filename, progress };
  if (curr === 'complete' && activePrev) return { type: 'PrintComplete', filename };
  if ((curr === 'error' || curr === 'cancelled') && activePrev) return { type: 'PrintFailed', filename };
  if (curr === 'disconnected' && activePrev) return { type: 'PrinterOffline' };
  return null;
}

/** AppEventNotifier.titleFor / bodyFor for the printer events. */
export function eventTitle(e) {
  return ({ PrintStarted: 'Print started', PrintPaused: 'Print paused', PrintComplete: 'Print complete',
    PrintFailed: 'Print stopped', PrinterOffline: 'Monitoring paused', UploadComplete: 'Upload complete' })[e.type] ?? '';
}
export function eventBody(e) {
  switch (e.type) {
    case 'PrintStarted': return e.filename;
    case 'PrintPaused': return `${e.filename} paused at ${e.progress}%`;
    case 'PrintComplete': return `${e.filename} finished`;
    case 'PrintFailed': return `${e.filename} was cancelled or failed`;
    case 'PrinterOffline': return 'Tap to reconnect and see printer status';
    case 'UploadComplete': return `${e.filename} sent to printer`;
    default: return '';
  }
}

/** PrintProgressNotifier: shown only while printing/paused. */
export const progressShouldShow = (s) => s.isPrinting || s.isPaused;
export const progressTitle = (s) => (s.isPaused ? 'Print paused' : `Printing ${s.progressPercent}%`);
export function progressText(s) {
  const name = s.filename || 'Current print';
  return s.isPaused ? `${name} is paused at ${s.progressPercent}%` : `${name} in progress`;
}

/** ui/PrinterScreen.resolveStatusBadge: just after a start, stale states read STARTING…. */
export function resolveStatusBadge(printerState, justSent) {
  const stale = new Set(['cancelled', 'standby', 'complete', 'error']);
  if (printerState === 'printing') return 'PRINTING';
  if (printerState === 'paused') return 'PAUSED';
  if (justSent && stale.has(printerState)) return 'STARTING…';
  if (printerState === 'complete') return 'COMPLETE';
  if (printerState === 'error') return 'ERROR';
  return String(printerState).toUpperCase();
}

// ---- browser constraints -----------------------------------------------------------

/** A reason the browser will refuse to talk to the printer from this page, or null. */
export function mixedContentReason(printerUrl, pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch { return null; }
  if (page.protocol === 'https:' && /^http:/i.test(printerUrl)) {
    return `This page is served over HTTPS (${page.origin}), so the browser blocks plain-HTTP requests and ` +
      `ws:// websockets to ${printerUrl} (mixed content). Open the slicer over HTTP instead — ` +
      '`node wasm/web/serve.mjs --host 0.0.0.0` on your LAN, or hosted on the printer — or put TLS in front of Moonraker.';
  }
  return null;
}

export function corsHint(printerUrl, origin) {
  return `Could not reach ${printerUrl}. Check the address and that the printer is on. If it is, Moonraker is ` +
    `probably refusing this page's origin: add it to moonraker.conf, e.g. [authorization] cors_domains: ${origin}`;
}

export class MoonrakerError extends Error {
  constructor(message, { status = 0, kind = 'http' } = {}) { super(message); this.status = status; this.kind = kind; }
}

/** testConnection's 401/403 wording from the API-key branch. */
export function authErrorMessage(status, apiKey) {
  return String(apiKey ?? '').trim()
    ? `HTTP ${status} — API key rejected, check the Moonraker API key`
    : `HTTP ${status} — authentication required, set the Moonraker API key`;
}

// ---- HTTP client -------------------------------------------------------------------

export class MoonrakerClient {
  /**
   * @param {{url: string, apiKey?: string, fetch?: typeof fetch, pageUrl?: string, origin?: string}} opts
   */
  constructor({ url, apiKey = '', fetch: f = globalThis.fetch?.bind(globalThis), pageUrl, origin } = {}) {
    this.baseUrl = normalizeUrl(url);
    this.apiKey = String(apiKey ?? '').trim();
    this.fetch = f;
    this.pageUrl = pageUrl ?? globalThis.location?.href;
    this.origin = origin ?? globalThis.location?.origin ?? '';
  }

  headers(url = this.baseUrl, extra = {}) { return { ...authHeaders(this.baseUrl, this.apiKey, url), ...extra }; }

  blockedReason() { return this.baseUrl ? mixedContentReason(this.baseUrl, this.pageUrl) : 'No printer address set'; }

  async request(path, { method = 'GET', body, json, timeoutMs = 10_000 } = {}) {
    const blocked = this.blockedReason();
    if (blocked) throw new MoonrakerError(blocked, { kind: 'blocked' });
    const url = this.baseUrl + path;
    const init = { method, headers: this.headers(url), body };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['Content-Type'] = 'application/json';
    }
    const ac = typeof AbortController !== 'undefined' && timeoutMs ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    if (ac) init.signal = ac.signal;
    let r;
    try {
      r = await this.fetch(url, init);
    } catch (e) {
      if (e?.name === 'AbortError') throw new MoonrakerError('Timed out — check printer is on and reachable', { kind: 'timeout' });
      // fetch reports CORS rejections, DNS failures and refused connections alike.
      throw new MoonrakerError(corsHint(this.baseUrl, this.origin), { kind: 'network' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new MoonrakerError(authErrorMessage(r.status, this.apiKey), { status: r.status, kind: 'auth' });
    if (!r.ok) throw new MoonrakerError(data?.error?.message || `HTTP ${r.status} — is Moonraker running on this address?`, { status: r.status });
    return data?.result ?? data;
  }

  async info() {
    const info = await this.request('/server/info');
    let printer = null;
    try { printer = await this.request('/printer/info'); } catch { /* klippy may be down */ }
    return { klippyState: info.klippy_state, moonraker: info.moonraker_version, hostname: printer?.hostname ?? '', software: printer?.software_version ?? '' };
  }

  async query(objects) {
    const qs = objects.map((o) => encodeURIComponent(o)).join('&');
    const res = await this.request(`/printer/objects/query?${qs}`);
    return res?.status ?? {};
  }

  async getStatus() { return parseStatus(await this.query(STATUS_OBJECTS)); }

  async getLedState() {
    try { return parseLedState((await this.query(['led cavity_led']))['led cavity_led']); } catch { return null; }
  }

  /** print_task_config first (U1), AFC fallback; null when neither is present. */
  async queryFilamentSlots() {
    try {
      const st = await this.query(['print_task_config', 'filament_detect']);
      const slots = parsePrintTaskConfigSlots(st.print_task_config);
      if (slots?.length) return slots;
    } catch { /* fall through */ }
    try {
      const list = await this.request('/printer/objects/list');
      const names = (list?.objects ?? []).filter((n) => n.startsWith('AFC_stepper ') || n.startsWith('AFC '));
      if (!names.length) return null;
      return parseAfcSlots(names, await this.query(names));
    } catch { return null; }
  }

  async webcams() {
    let list = null;
    try { list = { result: await this.request('/server/webcams/list') }; } catch { /* legacy fallback */ }
    return { snapshots: webcamSnapshotCandidates(this.baseUrl, list), streams: webcamStreamCandidates(this.baseUrl, list) };
  }

  /** Fetch one snapshot frame as a Blob (CORS fetch; key only for the printer's host). */
  async snapshot(url, timeoutMs = 4000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await this.fetch(withCacheBuster(url), { headers: authHeaders(this.baseUrl, this.apiKey, url), signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new MoonrakerError(`HTTP ${r.status}`, { status: r.status });
      const blob = await r.blob();
      if (!blob.size) throw new MoonrakerError('empty frame');
      return blob;
    } finally { clearTimeout(t); }
  }

  async listFiles() {
    const res = await this.request('/server/files/list?root=gcodes');
    return (Array.isArray(res) ? res : []).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }

  async fileMetadata(filename) {
    return this.request(`/server/files/metadata?filename=${encodeURIComponent(filename)}`);
  }

  /** Uploads to the gcodes root. Never sends print=true — starting is a separate, confirmed call. */
  async upload(blob, filename, { timeoutMs } = {}) {
    const form = new FormData();
    form.append('root', 'gcodes');
    form.append('file', blob, filename);
    const sizeMb = (blob.size ?? 0) / 2 ** 20;
    const res = await this.request('/server/files/upload', {
      method: 'POST', body: form, timeoutMs: timeoutMs ?? Math.max(30, Math.min(300, sizeMb)) * 1000 * 2,
    });
    return res?.item?.path ?? filename;
  }

  sendGcode(script) { return this.request('/printer/gcode/script', { method: 'POST', json: { script } }); }
  setLed(on) { return this.sendGcode(ledGcode(on)); }
  setHeaterTemperature(heater, targetC) { return this.sendGcode(buildSetHeaterGcode(heater, targetC)); }

  // Motion / heating / print-state changes: the UI calls these only after a confirm dialog.
  startPrint(filename) { return this.request(`/printer/print/start?filename=${encodeURIComponent(filename)}`, { method: 'POST' }); }
  pausePrint() { return this.request('/printer/print/pause', { method: 'POST' }); }
  resumePrint() { return this.request('/printer/print/resume', { method: 'POST' }); }
  cancelPrint() { return this.request('/printer/print/cancel', { method: 'POST' }); }

  /** ws(s)://host/websocket, with a oneshot token when an API key is set (browsers can't set WS headers). */
  async websocketUrl() {
    const ws = this.baseUrl.replace(/^http/i, 'ws') + '/websocket';
    if (!this.apiKey) return ws;
    const token = await this.request('/access/oneshot_token');
    return `${ws}?token=${encodeURIComponent(typeof token === 'string' ? token : token?.token ?? '')}`;
  }
}

/** Deep-merge a notify_status_update diff into the accumulated object status. */
export function mergeStatus(target, diff) {
  for (const [obj, fields] of Object.entries(diff ?? {})) {
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      const cur = target[obj] && typeof target[obj] === 'object' ? target[obj] : (target[obj] = {});
      for (const [k, v] of Object.entries(fields)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
          Object.assign(cur[k], v);
        } else {
          cur[k] = v;
        }
      }
    } else {
      target[obj] = fields;
    }
  }
  return target;
}

/**
 * Live status: subscribes over Moonraker's websocket (JSON-RPC
 * printer.objects.subscribe + notify_status_update); falls back to polling
 * /printer/objects/query every 2 s (0.5 s for 30 s after a start, like
 * MoonrakerTransport.hintJobStarting) when the socket can't open or drops.
 * Callbacks: onStatus(rawObjects), onMode('websocket'|'polling'|'offline'), onError(msg).
 */
export class LiveConnection {
  constructor(client, { onStatus, onMode, onError, WebSocketImpl = globalThis.WebSocket, pollMs = 2000 } = {}) {
    Object.assign(this, { client, onStatus, onMode, onError, WebSocketImpl, pollMs });
    this.objects = {};
    this.ws = null;
    this.stopped = false;
    this.pollTimer = null;
    this.rapidUntil = 0;
    this.rpcId = 1;
    this.pending = new Map();
    this.wsFailures = 0;
  }

  async start() {
    this.stopped = false;
    if (this.WebSocketImpl) {
      try { await this.openSocket(); return; } catch (e) { this.onError?.(`Websocket unavailable (${e.message}); polling instead.`); }
    }
    this.startPolling();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }

  get mode() { return this.ws?.readyState === 1 ? 'websocket' : this.pollTimer ? 'polling' : 'offline'; }

  hintJobStarting() { this.rapidUntil = Date.now() + 30_000; if (this.pollTimer) { clearTimeout(this.pollTimer); this.poll(); } }

  rpc(method, params) {
    if (this.ws?.readyState !== 1) return Promise.reject(new Error('websocket not open'));
    const id = this.rpcId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 10_000);
    });
  }

  /** Fire-and-forget notify (camera.start_monitor keepalive, like MoonrakerClient.wakeCamera). */
  notify(method, params) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id: this.rpcId++ }));
  }

  async openSocket() {
    const url = await this.client.websocketUrl();
    await new Promise((resolve, reject) => {
      let ws;
      try { ws = new this.WebSocketImpl(url); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('connect timeout')); }, 8000);
      ws.onopen = async () => {
        clearTimeout(timer);
        this.ws = ws;
        try {
          const res = await this.rpc('printer.objects.subscribe', {
            objects: Object.fromEntries(SUBSCRIBE_OBJECTS.map((o) => [o, null])),
          });
          this.objects = mergeStatus({}, res?.status ?? {});
          this.wsFailures = 0;
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
          this.onMode?.('websocket');
          this.onStatus?.(this.objects);
          resolve();
        } catch (e) { try { ws.close(); } catch { /* ignore */ } reject(e); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.stopped) return;
        // Socket dropped: keep the user informed through polling, try to reconnect later.
        this.onMode?.('polling');
        this.startPolling();
        this.reconnectTimer = setTimeout(() => this.reconnect(), Math.min(30_000, 3000 * 2 ** this.wsFailures++));
      };
    });
  }

  async reconnect() {
    if (this.stopped || this.ws) return;
    try { await this.openSocket(); } catch {
      this.reconnectTimer = setTimeout(() => this.reconnect(), Math.min(30_000, 3000 * 2 ** this.wsFailures++));
    }
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error')); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'notify_status_update') {
      mergeStatus(this.objects, msg.params?.[0]);
      this.onStatus?.(this.objects);
    } else if (msg.method === 'notify_klippy_disconnected' || msg.method === 'notify_klippy_shutdown') {
      this.objects.print_stats = { ...(this.objects.print_stats ?? {}), state: 'error', message: 'Klipper not ready' };
      this.onStatus?.(this.objects);
    } else if (msg.method === 'notify_klippy_ready') {
      // Re-subscribe so the object snapshot is fresh after a firmware restart.
      this.rpc('printer.objects.subscribe', { objects: Object.fromEntries(SUBSCRIBE_OBJECTS.map((o) => [o, null])) })
        .then((res) => { this.objects = mergeStatus({}, res?.status ?? {}); this.onStatus?.(this.objects); })
        .catch(() => {});
    }
  }

  startPolling() {
    if (this.pollTimer || this.stopped) return;
    this.onMode?.('polling');
    this.poll();
  }

  async poll() {
    this.pollTimer = null;
    if (this.stopped || this.ws) return;
    try {
      this.objects = await this.client.query(SUBSCRIBE_OBJECTS);
      this.onStatus?.(this.objects);
    } catch (e) {
      this.onStatus?.(null, e);
    }
    if (this.stopped || this.ws) return;
    this.pollTimer = setTimeout(() => this.poll(), Date.now() < this.rapidUntil ? 500 : this.pollMs);
  }
}
