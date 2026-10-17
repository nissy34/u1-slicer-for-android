// Mirrors app/src/test/java/com/u1/slicer/network/MoonrakerClientTest.kt (incl. the
// X-Api-Key cases from branch claude/moonraker-api-auth-7zr7fm),
// printer/PrinterRepositoryTest.kt, printer/PrinterRepositoryNotificationTest.kt,
// printer/PrintProgressNotifierTest.kt, AppEventNotifierTest.kt (printer events)
// and ui/PrinterStatusBadgeTest.kt. HTTP cases run against a fake fetch.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_KEY_HEADER, MoonrakerClient, applyGracePeriod, authHeaders, buildFilamentConfigGcode, buildPrintPreferencesGcode,
  buildSetHeaterGcode, buildUploadFilename, detectTransition, estimateRemainingSeconds, eventBody, eventTitle,
  formatDuration, isSameHost, ledGcode, makeStatus, mergeStatus, mixedContentReason, normalizeMaterialType,
  normalizeRgbaHex, normalizeUrl, parseAfcSlots, parseLedState, parsePrintPreferences, parsePrintTaskConfigSlots,
  parseStatus, progressShouldShow, progressText, progressTitle, remoteScreenUrl, resolveStatusBadge,
  webcamSnapshotCandidates, webcamStreamCandidates,
} from '../printer/moonraker.mjs';

// ---- URL normalisation -------------------------------------------------------------
test('normalizeUrl adds http scheme to bare IP', () => assert.equal(normalizeUrl('192.168.0.151'), 'http://192.168.0.151:7125'));
test('normalizeUrl adds default port when missing', () => assert.equal(normalizeUrl('http://192.168.0.151'), 'http://192.168.0.151:7125'));
test('normalizeUrl preserves explicit port', () => assert.equal(normalizeUrl('http://192.168.0.151:8080'), 'http://192.168.0.151:8080'));
test('normalizeUrl preserves explicit port 7125', () => assert.equal(normalizeUrl('http://192.168.0.151:7125'), 'http://192.168.0.151:7125'));
test('normalizeUrl handles IP with port but no scheme', () => assert.equal(normalizeUrl('192.168.0.151:7125'), 'http://192.168.0.151:7125'));
test('normalizeUrl preserves https scheme', () => assert.equal(normalizeUrl('https://printer.local'), 'https://printer.local:7125'));
test('normalizeUrl strips trailing slash', () => assert.equal(normalizeUrl('http://192.168.0.151:7125/'), 'http://192.168.0.151:7125'));
test('normalizeUrl returns empty string for blank input', () => {
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('   '), '');
});
test('baseUrl setter uses normalizeUrl', () => assert.equal(new MoonrakerClient({ url: 'printer.local' }).baseUrl, 'http://printer.local:7125'));
test('url helper constructs full path', () => assert.equal(`${normalizeUrl('192.168.1.100')}/server/info`, 'http://192.168.1.100:7125/server/info'));
test('normalizeUrl keeps an explicit :80 (Moonraker behind nginx)', () => assert.equal(normalizeUrl('http://u1.local:80'), 'http://u1.local:80'));

// ---- FilamentSlot / PrinterStatus ------------------------------------------------------
test('PrinterStatus defaults', () => {
  const s = makeStatus({ state: 'standby', progress: 0 });
  assert.equal(s.state, 'standby');
  assert.equal(s.progress, 0);
  assert.equal(s.filename, '');
  assert.equal(s.printDuration, 0);
  assert.equal(s.nozzleTemp, 0);
  assert.equal(s.bedTemp, 0);
  assert.deepEqual(s.extruders, []);
});
test('PrinterStatus isConnected', () => {
  assert.ok(makeStatus({ state: 'standby' }).isConnected);
  assert.ok(makeStatus({ state: 'printing', progress: 0.5 }).isConnected);
  assert.ok(!makeStatus({ state: 'disconnected' }).isConnected);
});
test('PrinterStatus isPrinting', () => {
  assert.ok(makeStatus({ state: 'printing' }).isPrinting);
  assert.ok(!makeStatus({ state: 'paused' }).isPrinting);
  assert.ok(!makeStatus({ state: 'standby' }).isPrinting);
});
test('PrinterStatus isPaused', () => {
  assert.ok(makeStatus({ state: 'paused' }).isPaused);
  assert.ok(!makeStatus({ state: 'printing' }).isPaused);
});
test('PrinterStatus isIdle', () => {
  assert.ok(makeStatus({ state: 'standby' }).isIdle);
  assert.ok(makeStatus({ state: 'complete', progress: 1 }).isIdle);
  assert.ok(!makeStatus({ state: 'printing' }).isIdle);
});
test('PrinterStatus progressPercent', () => {
  assert.equal(makeStatus({ state: 'standby', progress: 0 }).progressPercent, 0);
  assert.equal(makeStatus({ state: 'printing', progress: 0.5 }).progressPercent, 50);
  assert.equal(makeStatus({ state: 'complete', progress: 1 }).progressPercent, 100);
});
test('PrinterStatus printTimeFormatted', () => {
  assert.equal(makeStatus({ state: 'printing', printDuration: 5400 }).printTimeFormatted, '1h 30m');
  assert.equal(makeStatus({ state: 'printing', printDuration: 2700 }).printTimeFormatted, '45m');
  assert.equal(makeStatus({ state: 'standby', printDuration: 0 }).printTimeFormatted, '0m');
  assert.equal(formatDuration(-5), '0m');
});

test('parseStatus reads temps, extruders 1-3 and active flags', () => {
  const s = parseStatus({
    print_stats: { state: 'printing', filename: 'benchy.gcode', print_duration: 1800, filament_used: 2500, info: { current_layer: 12, total_layer: 240 } },
    virtual_sdcard: { progress: 0.45 },
    heater_bed: { temperature: 59, target: 60 },
    extruder: { temperature: 210, target: 210 },
    extruder1: { temperature: 25, target: 0 },
  });
  assert.equal(s.state, 'printing');
  assert.equal(s.filename, 'benchy.gcode');
  assert.equal(s.nozzleTarget, 210);
  assert.equal(s.bedTemp, 59);
  assert.equal(s.extruders.length, 2);
  assert.ok(s.extruders[0].active);
  assert.ok(!s.extruders[1].active);
  assert.equal(s.currentLayer, 12);
  assert.equal(s.totalLayers, 240);
});

// ---- B33 progress -------------------------------------------------------------------------
test('virtual_sdcard progress is preferred over print_stats progress', () => {
  const s = parseStatus({ print_stats: { state: 'printing', progress: 0.0 }, virtual_sdcard: { progress: 0.45 } });
  assert.equal(s.progress, 0.45);
});
test('falls back to print_stats progress when virtual_sdcard absent', () => {
  assert.equal(parseStatus({ print_stats: { state: 'printing', progress: 0.3 } }).progress, 0.3);
});
test('progress is zero when both virtual_sdcard and print_stats absent', () => {
  assert.equal(parseStatus({ heater_bed: { temperature: 25, target: 0 } }).progress, 0);
});
test('missing status object reads as standby', () => assert.equal(parseStatus(null).state, 'standby'));

test('remaining time scales the slicer estimate by progress, else extrapolates elapsed', () => {
  const s = makeStatus({ state: 'printing', progress: 0.25, printDuration: 600 });
  assert.equal(estimateRemainingSeconds(s, 4000), 3000);
  assert.equal(estimateRemainingSeconds(s, 0), 1800);
  assert.equal(estimateRemainingSeconds(makeStatus({ state: 'printing', progress: 0 }), 4000), null);
});

// ---- LED -------------------------------------------------------------------------------
test('LED color_data parsing - light on when W channel is positive', () =>
  assert.equal(parseLedState({ color_data: [[0, 0, 0, 1.0]] }), true));
test('LED color_data parsing - light off when W channel is zero', () =>
  assert.equal(parseLedState({ color_data: [[0, 0, 0, 0]] }), false));
test('LED state unknown without color_data', () => assert.equal(parseLedState(undefined), null));
test('LED gcode script format', () => {
  assert.equal(ledGcode(true), 'SET_LED LED=cavity_led WHITE=1.0 RED=0 GREEN=0 BLUE=0');
  assert.equal(ledGcode(false), 'SET_LED LED=cavity_led WHITE=0 RED=0 GREEN=0 BLUE=0');
});

// ---- F34 remote screen -------------------------------------------------------------------
test('remoteScreenUrl builds screen URL from standard Moonraker base URL', () => assert.equal(remoteScreenUrl(normalizeUrl('192.168.0.151')), 'http://192.168.0.151/screen/'));
test('remoteScreenUrl uses host without port for screen endpoint', () => assert.equal(remoteScreenUrl(normalizeUrl('printer.local')), 'http://printer.local/screen/'));
test('remoteScreenUrl preserves https scheme', () => assert.equal(remoteScreenUrl(normalizeUrl('https://printer.local')), 'https://printer.local/screen/'));
test('remoteScreenUrl returns null for blank base URL', () => assert.equal(remoteScreenUrl(''), null));

// ---- F50 heaters -----------------------------------------------------------------------
test('setHeaterTemperature builds correct gcode string', () => {
  assert.equal(buildSetHeaterGcode('heater_bed', 60), 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60');
  assert.equal(buildSetHeaterGcode('extruder', 200), 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200');
  assert.equal(buildSetHeaterGcode('extruder1', 215), 'SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=215');
});
test('setHeaterTemperature clamps to safe range', () => {
  assert.equal(buildSetHeaterGcode('heater_bed', -10), 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=0');
  assert.equal(buildSetHeaterGcode('heater_bed', 999), 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=120');
  assert.equal(buildSetHeaterGcode('extruder', -5), 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=0');
  assert.equal(buildSetHeaterGcode('extruder', 999), 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=300');
});

// ---- filament slots ----------------------------------------------------------------------
test('print_task_config slots: RGBA → hex, exist flags, material normalisation, vendor/subtype', () => {
  const slots = parsePrintTaskConfigSlots({
    filament_color_rgba: ['E72F1DFF', '00FF00', 'bad', '#0000ffff'],
    filament_type: ['PLA+', 'PET-G', 'TPU95A', ''],
    filament_sub_type: ['Basic', '', '', ''],
    filament_vendor: ['Snapmaker', 'Prusament', '', ''],
    filament_exist: [1, 0, true, 1],
  });
  assert.deepEqual(slots.map((s) => s.color), ['#E72F1D', '#00FF00', '#808080', '#0000FF']);
  assert.deepEqual(slots.map((s) => s.materialType), ['PLA', 'PETG', 'TPU', 'PLA']);
  assert.deepEqual(slots.map((s) => s.loaded), [true, false, true, true]);
  assert.deepEqual(slots.map((s) => s.label), ['E1', 'E2', 'E3', 'E4']);
  assert.equal(slots[0].subType, 'Basic');
  assert.equal(slots[1].manufacturer, 'Prusament');
});
test('print_task_config without colours yields null (AFC fallback)', () => assert.equal(parsePrintTaskConfigSlots({ filament_type: ['PLA'] }), null));
test('AFC lanes parse colour, load state and lane number', () => {
  const slots = parseAfcSlots(['AFC_stepper lane1', 'AFC_stepper lane2'], {
    'AFC_stepper lane1': { color: 'ff0000', material: 'PLA+', load_state: true },
    'AFC_stepper lane2': { material: 'PETG', status: 'Loaded' },
  });
  assert.deepEqual(slots.map((s) => [s.label, s.color, s.loaded, s.materialType]),
    [['E1', '#FF0000', true, 'PLA'], ['E2', '#808080', true, 'PETG']]);
});
test('normalizeRgbaHex and normalizeMaterialType', () => {
  assert.equal(normalizeRgbaHex('E72F1DFF'), '#E72F1D');
  assert.equal(normalizeRgbaHex(''), '#808080');
  assert.equal(normalizeMaterialType(' abs plus '), 'ABS');
  assert.equal(normalizeMaterialType('HIPS+'), 'HIPS');
  assert.equal(normalizeMaterialType(''), 'PLA');
  assert.equal(normalizeMaterialType('PA-CF'), 'PA-CF');
});

// ---- print preferences / filament config (Snapmaker app's pre-print G-code) ----------------
test('SET_PRINT_PREFERENCES uses 0/1 and the firmware key names', () => {
  assert.equal(buildPrintPreferencesGcode({ bedLevel: true, flowCalibrate: false, timeLapse: true }),
    'SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=1');
  assert.equal(buildPrintPreferencesGcode({ flowCalibrate: true }), 'SET_PRINT_PREFERENCES FLOW_CALIBRATE=1');
  assert.equal(buildPrintPreferencesGcode({}), null);
});
test('print preferences read from print_task_config', () => {
  assert.deepEqual(parsePrintPreferences({ auto_bed_leveling: true, flow_calibrate: 0, time_lapse_camera: 1 }),
    { bedLevel: true, flowCalibrate: false, timeLapse: true });
  assert.deepEqual(parsePrintPreferences({}), { bedLevel: null, flowCalibrate: null, timeLapse: null });
});
test('SET_PRINT_FILAMENT_CONFIG quotes values, RGBA colour, strips injection characters', () => {
  assert.equal(buildFilamentConfigGcode({ index: 2, materialType: 'PETG', subType: 'HF', color: '#00ff00', vendor: "Bob's\nM112" }),
    "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 FILAMENT_TYPE='PETG' FILAMENT_SUBTYPE='HF' FILAMENT_COLOR_RGBA='00FF00FF' SAVE=1 VENDOR='BobsM112'");
});

// ---- webcam candidates ---------------------------------------------------------------------
test('webcam candidates with empty webcam list appends monitor jpg as last candidate', () => {
  const c = webcamSnapshotCandidates('http://p:7125', { result: { webcams: [] } });
  assert.ok(c.length >= 2);
  assert.ok(c.at(-1).endsWith('/server/files/camera/monitor.jpg'));
  assert.equal(c[0], 'http://p:7125/webcam/?action=snapshot');
});
test('webcam candidates with configured webcam appends monitor jpg after existing candidates', () => {
  const list = { result: { webcams: [{ name: 'Camera', enabled: true, snapshot_url: '/webcam/?action=snapshot', stream_url: '/webcam/?action=stream' }] } };
  const c = webcamSnapshotCandidates('http://p:7125', list);
  assert.deepEqual(c, ['http://p/webcam/?action=snapshot', 'http://p:7125/webcam/?action=snapshot', 'http://p:7125/server/files/camera/monitor.jpg']);
  assert.ok(!c[0].includes('monitor.jpg'));
  assert.deepEqual(webcamStreamCandidates('http://p:7125', list), ['http://p/webcam/?action=stream', 'http://p:7125/webcam/?action=stream']);
});
test('webcam candidates keep absolute urls and fall back to legacy when list failed', () => {
  assert.deepEqual(webcamSnapshotCandidates('http://p:7125', { result: { webcams: [{ snapshotUrl: 'http://cam/x.jpg' }] } }),
    ['http://cam/x.jpg', 'http://p:7125/server/files/camera/monitor.jpg']);
  assert.equal(webcamSnapshotCandidates('http://p:7125', null).length, 2);
  assert.deepEqual(webcamSnapshotCandidates('', null), []);
});

// ---- API key -------------------------------------------------------------------------------
test('isSameHost is case-insensitive and false for unparseable urls', () => {
  assert.ok(isSameHost('http://Printer.local:7125', 'http://printer.LOCAL/x'));
  assert.ok(!isSameHost('', 'http://printer.local/x'));
  assert.ok(!isSameHost('http://printer.local', 'not a url'));
});
test('snapshot auth header attaches key only for same-host snapshot urls', () => {
  const base = 'http://192.168.1.50:7125';
  assert.equal(authHeaders(base, 'k1', 'http://192.168.1.50:7125/server/files/camera/monitor.jpg')[API_KEY_HEADER], 'k1');
  assert.equal(authHeaders(base, 'k1', 'http://192.168.1.50/webcam/?action=snapshot')[API_KEY_HEADER], 'k1');
  assert.equal(authHeaders(base, 'k1', 'http://camera.example.com/snapshot.jpg')[API_KEY_HEADER], undefined);
  assert.equal(authHeaders(base, ' ', 'http://192.168.1.50:7125/server/files/camera/monitor.jpg')[API_KEY_HEADER], undefined);
});

function fakeFetch(responses) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {}, blob: async () => new Blob(['x']) };
  };
  f.calls = calls;
  return f;
}
const client = (f, apiKey = '') => new MoonrakerClient({ url: 'http://p:7125', apiKey, fetch: f, pageUrl: 'http://localhost:8080/', origin: 'http://localhost:8080' });

test('requests carry X-Api-Key header when apiKey is set', async () => {
  const f = fakeFetch([{ status: 200 }]);
  await new MoonrakerClient({ url: 'http://p:7125', apiKey: '  secret-key  ', fetch: f, pageUrl: 'http://x/' }).sendGcode('G28');
  assert.equal(f.calls[0].headers[API_KEY_HEADER], 'secret-key');
});
test('requests omit X-Api-Key header when apiKey is blank', async () => {
  const f = fakeFetch([{ status: 200 }]);
  await client(f).sendGcode('G28');
  assert.equal(f.calls[0].headers[API_KEY_HEADER], undefined);
});
test('api key header applies to connection test and upload requests', async () => {
  const f = fakeFetch([{ status: 200, body: { result: {} } }, { status: 200, body: { result: {} } }, { status: 201, body: { result: { item: { path: 'a.gcode' } } } }]);
  const c = client(f, 'k1');
  await c.info();
  await c.upload(new Blob(['G28\n']), 'a.gcode');
  assert.ok(f.calls.every((x) => x.headers[API_KEY_HEADER] === 'k1'));
  assert.ok(f.calls[2].url.endsWith('/server/files/upload'));
  assert.ok(!f.calls[2].body.has('print'), 'upload never carries print=true');
});
test('sendGcode succeeds on 200 and throws on non-2xx', async () => {
  await client(fakeFetch([{ status: 200 }])).sendGcode('G28');
  await assert.rejects(client(fakeFetch([{ status: 500 }])).sendGcode('G28'), /HTTP 500/);
});
test('testConnection reports missing api key on 401', async () => {
  await assert.rejects(client(fakeFetch([{ status: 401 }])).info(), /authentication required/i);
});
test('testConnection reports rejected api key on 401 when key is set', async () => {
  await assert.rejects(client(fakeFetch([{ status: 401 }]), 'wrong').info(), /API key rejected/);
});
test('network failure explains CORS', async () => {
  const c = new MoonrakerClient({ url: 'p', fetch: async () => { throw new TypeError('Failed to fetch'); }, pageUrl: 'http://localhost/', origin: 'http://localhost:8080' });
  await assert.rejects(c.info(), /cors_domains: http:\/\/localhost:8080/);
});
test('https page refuses a plain-http printer before any request (mixed content)', async () => {
  const f = fakeFetch([]);
  const c = new MoonrakerClient({ url: '192.168.1.5', fetch: f, pageUrl: 'https://u1.pages.dev/' });
  await assert.rejects(c.info(), /mixed content/);
  assert.equal(f.calls.length, 0);
  assert.equal(mixedContentReason('https://p:7125', 'https://u1.pages.dev/'), null);
});
test('print control endpoints and filename encoding', async () => {
  const f = fakeFetch([]);
  const c = client(f);
  await c.startPrint('My file #1.gcode');
  await c.pausePrint(); await c.resumePrint(); await c.cancelPrint();
  assert.deepEqual(f.calls.map((x) => [x.method, x.url.replace('http://p:7125', '')]), [
    ['POST', '/printer/print/start?filename=My%20file%20%231.gcode'], ['POST', '/printer/print/pause'],
    ['POST', '/printer/print/resume'], ['POST', '/printer/print/cancel']]);
});
test('websocket url uses a oneshot token when an api key is set', async () => {
  assert.equal(await client(fakeFetch([])).websocketUrl(), 'ws://p:7125/websocket');
  const f = fakeFetch([{ status: 200, body: { result: 'tok123' } }]);
  assert.equal(await client(f, 'k').websocketUrl(), 'ws://p:7125/websocket?token=tok123');
  assert.ok(f.calls[0].url.endsWith('/access/oneshot_token'));
});
test('mergeStatus applies notify_status_update diffs', () => {
  const s = mergeStatus({}, { print_stats: { state: 'standby', info: { current_layer: 1, total_layer: 9 } } });
  mergeStatus(s, { print_stats: { state: 'printing', info: { current_layer: 2 } }, extruder: { temperature: 200 } });
  assert.deepEqual(s, { print_stats: { state: 'printing', info: { current_layer: 2, total_layer: 9 } }, extruder: { temperature: 200 } });
});

// ---- PrinterRepository companion ---------------------------------------------------------------
test('buildPrinterUploadFilename appends unique suffix', () => assert.equal(buildUploadFilename('output.gcode', 1234567890), 'output_1234567890.gcode'));
test('buildPrinterUploadFilename sanitizes and falls back', () => {
  const n = buildUploadFilename('My Slip/Slide #1.gcode', 99);
  assert.ok(n.startsWith('My_Slip_Slide_1_'));
  assert.ok(n.endsWith('_99.gcode'));
  assert.equal(buildUploadFilename('   ', 99), 'print_99.gcode');
});
test('buildPrinterUploadFilename preserves model name from issue examples', () => {
  assert.equal(buildUploadFilename('Jumping_frog.3mf', 1), 'Jumping_frog_1.gcode');
  assert.equal(buildUploadFilename('Dragon Scale infinity.3mf', 2), 'Dragon_Scale_infinity_2.gcode');
  assert.equal(buildUploadFilename('3DBenchy.stl', 3), '3DBenchy_3.gcode');
});

const ev = (p, c) => detectTransition(p, c, 'job.gcode', 50)?.type ?? null;
test('idle to printing is PrintStarted', () => assert.equal(ev('standby', 'printing'), 'PrintStarted'));
test('printing to paused is PrintPaused', () => assert.equal(ev('printing', 'paused'), 'PrintPaused'));
test('printing to complete is PrintComplete', () => assert.equal(ev('printing', 'complete'), 'PrintComplete'));
test('printing to error is PrintFailed', () => assert.equal(ev('printing', 'error'), 'PrintFailed'));
test('printing to cancelled is PrintFailed', () => assert.equal(ev('printing', 'cancelled'), 'PrintFailed'));
test('printing to disconnected is PrinterOffline', () => assert.equal(ev('printing', 'disconnected'), 'PrinterOffline'));
test('paused to disconnected is PrinterOffline', () => assert.equal(ev('paused', 'disconnected'), 'PrinterOffline'));
test('idle to idle is null', () => assert.equal(ev('idle', 'idle'), null));
test('disconnected to printing is PrintStarted', () => assert.equal(ev('disconnected', 'printing'), 'PrintStarted'));

test('single disconnected failure does not fire PrinterOffline', () => {
  const [eff] = applyGracePeriod('disconnected', 'printing', 0);
  assert.equal(detectTransition('printing', eff, 'job.gcode', 50), null);
});
test('two consecutive failures do not fire PrinterOffline', () => {
  let prev = 'printing', f = 0;
  for (let i = 0; i < 2; i++) {
    const [eff, n] = applyGracePeriod('disconnected', prev, f);
    f = n;
    assert.equal(detectTransition(prev, eff, 'job.gcode', 50), null);
    prev = eff;
  }
});
test('three consecutive failures fire PrinterOffline', () => {
  let prev = 'printing', f = 0, last = null;
  for (let i = 0; i < 3; i++) {
    const [eff, n] = applyGracePeriod('disconnected', prev, f);
    f = n;
    last = detectTransition(prev, eff, 'job.gcode', 50);
    prev = eff;
  }
  assert.equal(last?.type, 'PrinterOffline');
});
test('success after two failures resets counter and next single failure does not fire', () => {
  let prev = 'printing', f = 0;
  for (let i = 0; i < 2; i++) { const [eff, n] = applyGracePeriod('disconnected', prev, f); f = n; prev = eff; }
  const [rec, reset] = applyGracePeriod('printing', prev, f);
  assert.equal(reset, 0);
  const [eff] = applyGracePeriod('disconnected', rec, reset);
  assert.equal(detectTransition(rec, eff, 'job.gcode', 50), null);
});

test('printer event titles and bodies (AppEventNotifier)', () => {
  assert.equal(eventTitle({ type: 'PrintStarted' }), 'Print started');
  assert.equal(eventBody({ type: 'PrintStarted', filename: 'print.gcode' }), 'print.gcode');
  assert.equal(eventTitle({ type: 'PrintPaused' }), 'Print paused');
  assert.equal(eventBody({ type: 'PrintPaused', filename: 'print.gcode', progress: 42 }), 'print.gcode paused at 42%');
  assert.equal(eventTitle({ type: 'PrintComplete' }), 'Print complete');
  assert.equal(eventBody({ type: 'PrintComplete', filename: 'print.gcode' }), 'print.gcode finished');
  assert.equal(eventTitle({ type: 'PrintFailed' }), 'Print stopped');
  assert.equal(eventBody({ type: 'PrintFailed', filename: 'print.gcode' }), 'print.gcode was cancelled or failed');
  assert.equal(eventTitle({ type: 'PrinterOffline' }), 'Monitoring paused');
  assert.equal(eventBody({ type: 'PrinterOffline' }), 'Tap to reconnect and see printer status');
  assert.equal(eventTitle({ type: 'UploadComplete' }), 'Upload complete');
  assert.equal(eventBody({ type: 'UploadComplete', filename: 'print.gcode' }), 'print.gcode sent to printer');
});

test('progress notification shown only for active print states', () => {
  assert.ok(progressShouldShow(makeStatus({ state: 'printing', progress: 0.42 })));
  assert.ok(progressShouldShow(makeStatus({ state: 'paused', progress: 0.42 })));
  assert.ok(!progressShouldShow(makeStatus({ state: 'standby', progress: 0.42 })));
  assert.ok(!progressShouldShow(makeStatus({ state: 'disconnected' })));
});
test('progress title shows percent; text includes paused progress and filename', () => {
  assert.equal(progressTitle(makeStatus({ state: 'printing', progress: 0.42, filename: 'cube.gcode' })), 'Printing 42%');
  assert.equal(progressText(makeStatus({ state: 'paused', progress: 0.58, filename: 'benchy.gcode' })), 'benchy.gcode is paused at 58%');
});

// ---- PrinterStatusBadgeTest ---------------------------------------------------------------------
for (const [state, badge] of [['printing', 'PRINTING'], ['paused', 'PAUSED'], ['complete', 'COMPLETE'], ['error', 'ERROR'],
  ['standby', 'STANDBY'], ['cancelled', 'CANCELLED'], ['disconnected', 'DISCONNECTED']]) {
  test(`${state} state shows ${badge}`, () => assert.equal(resolveStatusBadge(state, false), badge));
}
for (const state of ['cancelled', 'standby', 'complete', 'error']) {
  test(`justSent with ${state} shows STARTING`, () => assert.equal(resolveStatusBadge(state, true), 'STARTING…'));
}
test('justSent with printing still shows PRINTING', () => assert.equal(resolveStatusBadge('printing', true), 'PRINTING'));
test('justSent with paused still shows PAUSED', () => assert.equal(resolveStatusBadge('paused', true), 'PAUSED'));
test('justSent with disconnected shows DISCONNECTED not STARTING', () => assert.equal(resolveStatusBadge('disconnected', true), 'DISCONNECTED'));
