#!/usr/bin/env node
// A fake Moonraker + Snapmaker U1 for testing the Printer tab without a real
// printer. NOTHING here talks to hardware: "printing" is a timer that advances
// a progress number.
//
//   node wasm/web/test/mock-moonraker.mjs [port] [--api-key KEY] [--cors ORIGIN,...] [--no-ws]
//
// Implements the endpoints the tab calls, with Moonraker's CORS behaviour
// (only listed origins get Access-Control-Allow-Origin; '*' = any) and API-key
// auth (X-Api-Key header, or ?token=<oneshot> on the websocket). Every request
// is recorded; tests read GET /__mock/requests, clear it with DELETE, and
// patch printer state with POST /__mock/state.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { summarizeGcode } from '../printer/gcode-summary.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

function initialState() {
  return {
    print_stats: { state: 'standby', filename: '', print_duration: 0, total_duration: 0, filament_used: 0, message: '', info: { current_layer: null, total_layer: null } },
    virtual_sdcard: { progress: 0, is_active: false, file_position: 0 },
    display_status: { progress: 0, message: null },
    heater_bed: { temperature: 24.8, target: 0 },
    extruder: { temperature: 25.1, target: 0 },
    extruder1: { temperature: 25.0, target: 0 },
    extruder2: { temperature: 24.9, target: 0 },
    extruder3: { temperature: 25.2, target: 0 },
    'led cavity_led': { color_data: [[0, 0, 0, 0]] },
    print_task_config: {
      filament_color_rgba: ['3E413FFF', 'E72F1DFF', '00FF00FF', 'FFFFFFFF'],
      filament_type: ['PLA', 'PETG', 'PLA', 'PLA'],
      filament_sub_type: ['Galaxy', 'Basic', '', ''],
      filament_vendor: ['Prusament', 'Snapmaker', '', ''],
      filament_exist: [1, 1, 1, 0],
      auto_bed_leveling: true, flow_calibrate: false, time_lapse_camera: false,
    },
  };
}

/** Tiny solid-colour PNG (the "camera frame"); colour changes every frame. */
function pngFrame(n, w = 64, h = 48) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  const r = (n * 40) % 256, g = 120, b = 255 - ((n * 40) % 256);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- minimal RFC 6455 websocket (text frames only) ----------------------------------------
function wsSend(socket, text) {
  const data = Buffer.from(text);
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  socket.write(Buffer.concat([head, data]));
}
function wsParser(onText, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(need);
      if (op === 0x1) onText(payload.toString());
      else if (op === 0x8) onClose();
    }
  };
}

export async function startMockMoonraker({ port = 0, host = '127.0.0.1', apiKey = '', cors = ['*'], websocket = true, tickMs = 500 } = {}) {
  let state = initialState();
  const files = new Map();
  const requests = [];
  const tokens = new Set();
  const clients = new Set(); // { socket, objects: Set }
  let frame = 0;
  let timer = null;

  const notify = (diff) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: 'notify_status_update', params: [diff, Date.now() / 1000] });
    for (const c of clients) {
      const d = Object.fromEntries(Object.entries(diff).filter(([k]) => c.objects.has(k)));
      if (Object.keys(d).length) wsSend(c.socket, msg.replace(JSON.stringify(diff), JSON.stringify(d)));
    }
  };
  const patch = (diff) => {
    for (const [obj, fields] of Object.entries(diff)) {
      state[obj] = { ...(state[obj] ?? {}), ...fields };
      if (fields.info) state[obj].info = { ...(state[obj].info ?? {}), ...fields.info };
    }
    notify(diff);
  };

  const ps = () => state.print_stats.state;
  const tick = () => {
    if (ps() !== 'printing') return;
    const p = Math.min(1, +(state.virtual_sdcard.progress + 0.02).toFixed(4));
    const total = state.print_stats.info.total_layer || 100;
    const diff = {
      virtual_sdcard: { progress: p, is_active: p < 1 },
      display_status: { progress: p },
      print_stats: { print_duration: state.print_stats.print_duration + 30, total_duration: state.print_stats.total_duration + 30,
        filament_used: +(state.print_stats.filament_used + 25.5).toFixed(2), info: { current_layer: Math.max(1, Math.round(p * total)) } },
    };
    if (p >= 1) Object.assign(diff.print_stats, { state: 'complete' });
    patch(diff);
  };
  const startTimer = () => { clearInterval(timer); timer = setInterval(tick, tickMs); };

  function runGcode(script) {
    for (const line of String(script).split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [cmd, ...rest] = line.split(/\s+/);
      const params = Object.fromEntries(rest.map((p) => p.split('=')).map(([k, ...v]) => [k.toUpperCase(), v.join('=').replace(/^'|'$/g, '')]));
      switch (cmd.toUpperCase()) {
        case 'SET_LED':
          patch({ 'led cavity_led': { color_data: [[0, 0, 0, Number(params.WHITE ?? 0)]] } });
          break;
        case 'SET_HEATER_TEMPERATURE':
          if (state[params.HEATER]) patch({ [params.HEATER]: { target: Number(params.TARGET ?? 0) } });
          break;
        case 'SET_PRINT_PREFERENCES': {
          // Stock U1 firmware refuses preference changes mid-print.
          if (['printing', 'paused'].includes(ps())) throw Object.assign(new Error('Cannot change print preferences while printing'), { status: 400 });
          const b = (k) => (params[k] == null ? undefined : params[k] === '1');
          const ptc = {};
          if (b('BED_LEVEL') !== undefined) ptc.auto_bed_leveling = b('BED_LEVEL');
          if (b('FLOW_CALIBRATE') !== undefined) ptc.flow_calibrate = b('FLOW_CALIBRATE');
          if (b('TIME_LAPSE_CAMERA') !== undefined) ptc.time_lapse_camera = b('TIME_LAPSE_CAMERA');
          patch({ print_task_config: ptc });
          break;
        }
        case 'SET_PRINT_FILAMENT_CONFIG': {
          const i = Number(params.CONFIG_EXTRUDER);
          const ptc = clone(state.print_task_config);
          ptc.filament_type[i] = params.FILAMENT_TYPE;
          ptc.filament_sub_type[i] = params.FILAMENT_SUBTYPE ?? '';
          ptc.filament_color_rgba[i] = params.FILAMENT_COLOR_RGBA;
          ptc.filament_vendor[i] = params.VENDOR ?? '';
          patch({ print_task_config: ptc });
          break;
        }
        default: break; // accepted, ignored
      }
    }
  }

  function startPrint(filename) {
    if (!files.has(filename)) throw Object.assign(new Error(`File ${filename} does not exist`), { status: 404 });
    if (['printing', 'paused'].includes(ps())) throw Object.assign(new Error('Printer is busy'), { status: 400 });
    const meta = files.get(filename).meta;
    patch({
      print_stats: { state: 'printing', filename, print_duration: 0, total_duration: 0, filament_used: 0, info: { current_layer: 1, total_layer: meta.layer_count ?? 100 } },
      virtual_sdcard: { progress: 0, is_active: true },
      extruder: { target: 220 }, heater_bed: { target: 60 },
    });
    startTimer();
  }

  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!cors.includes('*') && !cors.includes(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const send = (status, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      res.writeHead(status, { ...corsHeaders(req), 'Content-Type': isBuf ? 'image/png' : 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(isBuf ? body : JSON.stringify(body));
    };
    const ok = (result) => send(200, { result });
    const err = (status, message) => send(status, { error: { code: status, message } });

    // Test control channel (no CORS/auth: Node-side only).
    if (path.startsWith('/__mock/')) {
      if (path === '/__mock/requests') {
        if (req.method === 'DELETE') requests.length = 0;
        return send(200, requests);
      }
      if (path === '/__mock/state') {
        if (req.method === 'POST') {
          const chunks = []; for await (const c of req) chunks.push(c);
          patch(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
          if (ps() === 'printing') startTimer();
        }
        return send(200, { state, files: [...files.keys()] });
      }
      if (path === '/__mock/disconnect-ws') { for (const c of clients) c.socket.destroy(); return send(200, { ok: true }); }
      return send(404, {});
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(req),
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Content-Type, X-Api-Key',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const rec = { method: req.method, path, query: Object.fromEntries(url.searchParams), apiKey: req.headers['x-api-key'] ?? null, origin: req.headers.origin ?? null, at: Date.now() };
    if (req.headers['content-type']?.includes('application/json')) { try { rec.json = JSON.parse(body.toString()); } catch { /* ignore */ } }
    requests.push(rec);

    if (apiKey && req.headers['x-api-key'] !== apiKey) return err(401, 'Unauthorized');

    try {
      if (path === '/server/info') return ok({ klippy_connected: true, klippy_state: 'ready', moonraker_version: 'v0.9.3-mock', components: ['webcam', 'file_manager'] });
      if (path === '/printer/info') return ok({ state: 'ready', hostname: 'U1-mock', software_version: 'v0.12.0-mock' });
      if (path === '/access/oneshot_token') { const t = randomBytes(8).toString('hex'); tokens.add(t); return ok(t); }
      if (path === '/printer/objects/list') return ok({ objects: Object.keys(state) });
      if (path === '/printer/objects/query') {
        const status = {};
        for (const k of url.searchParams.keys()) if (state[k]) status[k] = clone(state[k]);
        return ok({ eventtime: Date.now() / 1000, status });
      }
      if (path === '/server/webcams/list') {
        return ok({ webcams: [{ name: 'U1 camera', enabled: true, service: 'mjpegstreamer', snapshot_url: '/webcam/?action=snapshot', stream_url: '/webcam/?action=stream' }] });
      }
      if (path === '/server/files/camera/monitor.jpg' || (path === '/webcam/' && url.searchParams.get('action') === 'snapshot')) {
        return send(200, pngFrame(frame++));
      }
      if (path === '/webcam/' && url.searchParams.get('action') === 'stream') {
        const boundary = 'mockframe';
        res.writeHead(200, { ...corsHeaders(req), 'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`, 'Cache-Control': 'no-store' });
        const push = () => {
          const img = pngFrame(frame++);
          res.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${img.length}\r\n\r\n`);
          res.write(img); res.write('\r\n');
        };
        push();
        const t = setInterval(push, 250);
        req.on('close', () => clearInterval(t));
        return undefined;
      }
      if (path === '/server/files/upload' && req.method === 'POST') {
        const form = await new Request('http://mock/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
        const file = form.get('file');
        const name = file.name;
        const text = await file.text();
        const s = summarizeGcode(text);
        rec.upload = { filename: name, root: form.get('root'), print: form.get('print'), size: text.length };
        files.set(name, { text, modified: Date.now() / 1000, size: text.length,
          meta: { estimated_time: s.estimatedSeconds, filament_weight_total: s.totalGrams, layer_count: s.layers, filament_name: s.filaments.map((f) => f.material).join(';') } });
        if (form.get('print') === 'true') startPrint(name); // Moonraker semantics; the tab never sends it
        return send(201, { result: { item: { path: name, root: 'gcodes' }, print_started: form.get('print') === 'true', action: 'create_file' } });
      }
      if (path === '/server/files/list') {
        return ok([...files.entries()].map(([p, f]) => ({ path: p, modified: f.modified, size: f.size, permissions: 'rw' })));
      }
      if (path === '/server/files/metadata') {
        const f = files.get(url.searchParams.get('filename'));
        return f ? ok({ filename: url.searchParams.get('filename'), size: f.size, modified: f.modified, ...f.meta }) : err(404, 'not found');
      }
      if (path.startsWith('/server/files/gcodes/')) {
        const f = files.get(decodeURIComponent(path.slice('/server/files/gcodes/'.length)));
        return f ? send(200, Buffer.from(f.text), { 'Content-Type': 'text/plain' }) : err(404, 'not found');
      }
      if (path === '/printer/print/start' && req.method === 'POST') { startPrint(url.searchParams.get('filename')); return ok('ok'); }
      if (path === '/printer/print/pause' && req.method === 'POST') {
        if (ps() !== 'printing') return err(400, 'Print not in progress');
        patch({ print_stats: { state: 'paused' } }); return ok('ok');
      }
      if (path === '/printer/print/resume' && req.method === 'POST') {
        if (ps() !== 'paused') return err(400, 'Print not paused');
        patch({ print_stats: { state: 'printing' } }); return ok('ok');
      }
      if (path === '/printer/print/cancel' && req.method === 'POST') {
        if (!['printing', 'paused'].includes(ps())) return err(400, 'No active print');
        clearInterval(timer);
        patch({ print_stats: { state: 'cancelled' }, virtual_sdcard: { is_active: false }, extruder: { target: 0 }, heater_bed: { target: 0 } });
        return ok('ok');
      }
      if (path === '/printer/gcode/script' && req.method === 'POST') {
        runGcode(rec.json?.script ?? url.searchParams.get('script') ?? '');
        return ok('ok');
      }
      return err(404, `Not found: ${path}`);
    } catch (e) {
      return err(e.status ?? 500, e.message);
    }
  });

  if (websocket) {
    server.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://mock');
      const rec = { method: 'UPGRADE', path: url.pathname, query: Object.fromEntries(url.searchParams), origin: req.headers.origin ?? null, at: Date.now() };
      requests.push(rec);
      const token = url.searchParams.get('token');
      if (url.pathname !== '/websocket' || (apiKey && !(token && tokens.delete(token)))) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const client = { socket, objects: new Set() };
      clients.add(client);
      const drop = () => { clients.delete(client); socket.destroy(); };
      socket.on('data', wsParser((text) => {
        let msg; try { msg = JSON.parse(text); } catch { return; }
        requests.push({ method: 'WS', path: msg.method, params: msg.params ?? null, at: Date.now() });
        const reply = (result) => wsSend(socket, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        if (msg.method === 'printer.objects.subscribe') {
          client.objects = new Set(Object.keys(msg.params?.objects ?? {}));
          const status = {};
          for (const k of client.objects) if (state[k]) status[k] = clone(state[k]);
          reply({ eventtime: Date.now() / 1000, status });
        } else if (msg.method === 'server.info') {
          reply({ klippy_state: 'ready' });
        } else if (msg.method === 'camera.start_monitor') {
          reply('ok');
        } else {
          wsSend(socket, JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }));
        }
      }, drop));
      socket.on('close', drop);
      socket.on('error', drop);
    });
  }

  await new Promise((ok) => server.listen(port, host, ok));
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    requests,
    files,
    get state() { return state; },
    patch,
    reset() { clearInterval(timer); state = initialState(); files.clear(); requests.length = 0; },
    async close() {
      clearInterval(timer);
      for (const c of clients) c.socket.destroy();
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(ok));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const apiKey = opt('--api-key') ?? '';
  const cors = (opt('--cors') ?? '*').split(',');
  const noWs = args.includes('--no-ws');
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 7125);
  const mock = await startMockMoonraker({ port, host: '0.0.0.0', apiKey, cors, websocket: !noWs });
  console.log(`mock Moonraker: http://localhost:${mock.port}${apiKey ? ` (api key ${apiKey})` : ''} cors=${cors.join(',')}${noWs ? ' (no websocket)' : ''}`);
}
