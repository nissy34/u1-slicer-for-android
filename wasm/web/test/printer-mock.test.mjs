// The Printer tab's Moonraker client against the mock Moonraker (test/mock-moonraker.mjs):
// auth, upload-only semantics, print controls, preferences, RFID slots, webcams and
// the websocket subscription with its polling fallback. No real printer involved.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { LiveConnection, MoonrakerClient, parseStatus } from '../printer/moonraker.mjs';
import { startMockMoonraker } from './mock-moonraker.mjs';

let mock, keyed;
before(async () => {
  mock = await startMockMoonraker({ tickMs: 50 });
  keyed = await startMockMoonraker({ apiKey: 'sekret', tickMs: 50 });
});
after(async () => { await mock.close(); await keyed.close(); });

const c = (m = mock, apiKey = '') => new MoonrakerClient({ url: m.url, apiKey, pageUrl: 'http://localhost:8080/', origin: 'http://localhost:8080' });
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('info + status over HTTP', async () => {
  const info = await c().info();
  assert.equal(info.klippyState, 'ready');
  assert.equal(info.hostname, 'U1-mock');
  const s = await c().getStatus();
  assert.equal(s.state, 'standby');
  assert.equal(s.extruders.length, 4);
});

test('API key: missing → auth message, wrong → rejected, right → ok and header sent', async () => {
  await assert.rejects(c(keyed).info(), /authentication required/);
  await assert.rejects(c(keyed, 'nope').info(), /API key rejected/);
  keyed.requests.length = 0;
  await c(keyed, 'sekret').info();
  assert.ok(keyed.requests.every((r) => r.apiKey === 'sekret'));
});

test('upload only stores the file and never starts a print', async () => {
  mock.reset();
  const path = await c().upload(new Blob(['; estimated printing time (normal mode) = 1m 0s\nT0\nG1 X1\n']), 'cube_1.gcode');
  assert.equal(path, 'cube_1.gcode');
  const up = mock.requests.find((r) => r.path === '/server/files/upload');
  assert.equal(up.upload.print, null);
  assert.equal(up.upload.root, 'gcodes');
  assert.equal(mock.state.print_stats.state, 'standby');
  assert.ok(!mock.requests.some((r) => r.path === '/printer/print/start'));
  const files = await c().listFiles();
  assert.deepEqual(files.map((f) => f.path), ['cube_1.gcode']);
  assert.equal((await c().fileMetadata('cube_1.gcode')).estimated_time, 60);
});

test('start / pause / resume / cancel drive the mock state machine', async () => {
  mock.reset();
  await c().upload(new Blob(['T0\n']), 'job.gcode');
  await c().startPrint('job.gcode');
  assert.equal(mock.state.print_stats.state, 'printing');
  await waitFor(() => mock.state.virtual_sdcard.progress > 0);
  await c().pausePrint();
  assert.equal(mock.state.print_stats.state, 'paused');
  await c().resumePrint();
  assert.equal(mock.state.print_stats.state, 'printing');
  await c().cancelPrint();
  assert.equal(mock.state.print_stats.state, 'cancelled');
  await assert.rejects(c().pausePrint(), /Print not in progress/);
});

test('print preferences and filament config via gcode/script; preferences refused mid-print', async () => {
  mock.reset();
  await c().sendGcode('SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=1');
  assert.deepEqual([mock.state.print_task_config.auto_bed_leveling, mock.state.print_task_config.flow_calibrate, mock.state.print_task_config.time_lapse_camera], [false, true, true]);
  await c().sendGcode("SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=3 FILAMENT_TYPE='TPU' FILAMENT_SUBTYPE='' FILAMENT_COLOR_RGBA='112233FF' SAVE=1 VENDOR='Acme'");
  const slots = await c().queryFilamentSlots();
  assert.deepEqual([slots[3].materialType, slots[3].color, slots[3].manufacturer], ['TPU', '#112233', 'Acme']);
  mock.patch({ print_stats: { state: 'printing' } });
  await assert.rejects(c().sendGcode('SET_PRINT_PREFERENCES BED_LEVEL=1'), /while printing/);
});

test('LED on/off round trip', async () => {
  mock.reset();
  await c().setLed(true);
  assert.equal(await c().getLedState(), true);
  await c().setLed(false);
  assert.equal(await c().getLedState(), false);
});

test('webcam discovery and snapshot fetch', async () => {
  const cams = await c().webcams();
  assert.ok(cams.snapshots[0].includes('/webcam/?action=snapshot'));
  assert.ok(cams.snapshots.at(-1).endsWith('/server/files/camera/monitor.jpg'));
  // The primary candidate strips the port (nginx on :80), which the mock doesn't serve;
  // the alt keeps it — the tab walks the list exactly like the app.
  const blob = await c().snapshot(cams.snapshots[1]);
  assert.ok(blob.size > 50);
});

test('websocket subscription delivers live updates; api key goes via oneshot token', async () => {
  for (const [m, key] of [[mock, ''], [keyed, 'sekret']]) {
    m.reset();
    const seen = [];
    const modes = [];
    const live = new LiveConnection(c(m, key), { onStatus: (o) => o && seen.push(parseStatus(o).state), onMode: (x) => modes.push(x) });
    await live.start();
    assert.equal(live.mode, 'websocket');
    m.patch({ print_stats: { state: 'printing' } });
    await waitFor(() => seen.includes('printing'));
    assert.ok(m.requests.some((r) => r.method === 'WS' && r.path === 'printer.objects.subscribe'));
    if (key) assert.ok(m.requests.some((r) => r.method === 'UPGRADE' && r.query.token));
    live.notify('camera.start_monitor', { domain: 'lan', interval: 0 });
    await waitFor(() => m.requests.some((r) => r.method === 'WS' && r.path === 'camera.start_monitor'));
    live.stop();
  }
});

test('falls back to polling without a websocket, and when the socket drops', async () => {
  const noWs = await startMockMoonraker({ websocket: false });
  try {
    const seen = [];
    const live = new LiveConnection(c(noWs), { onStatus: (o) => o && seen.push(o), pollMs: 50 });
    await live.start();
    await waitFor(() => seen.length >= 2);
    assert.equal(live.mode, 'polling');
    live.stop();
  } finally { await noWs.close(); }

  mock.reset();
  const modes = [];
  const live = new LiveConnection(c(), { onStatus: () => {}, onMode: (x) => modes.push(x), pollMs: 50 });
  await live.start();
  await fetch(`${mock.url}/__mock/disconnect-ws`);
  await waitFor(() => modes.includes('polling'));
  await waitFor(() => live.mode === 'websocket', 6000); // reconnects
  live.stop();
});
