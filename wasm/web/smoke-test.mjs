#!/usr/bin/env node
// Headless-browser smoke test for the demo page: serves wasm/web with COOP/COEP,
// loads a model through the file input, slices, and checks the result shows up.
//
//   node wasm/web/smoke-test.mjs <model.stl> [screenshot.png]
//
// Needs the `playwright` package (global install is fine) and a Chromium.
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [model, shot] = process.argv.slice(2);
if (!model) { console.error('usage: smoke-test.mjs <model> [screenshot.png]'); process.exit(2); }

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

// SMOKE_URL=http://host:port/ tests an already-running deployment (e.g.
// `wrangler pages dev wasm/build/site`) instead of starting serve.mjs.
let baseUrl = process.env.SMOKE_URL, server = null;
if (!baseUrl) {
  const port = 8000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, [join(here, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => server.stdout.once('data', ok));
  baseUrl = `http://localhost:${port}/`;
}

// SwiftShader WebGL so the 3D view renders headless.
const browser = await playwright.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { console.error('pageerror:', e.message, String(e.stack ?? '').slice(0, 400)); failed = true; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text().slice(0, 400)); });
  await page.goto(baseUrl);
  console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
  await page.waitForFunction(() => document.getElementById('modelStatus').textContent.startsWith('Engine ready'), null, { timeout: 60_000 });
  console.log('engine:', await page.textContent('#modelStatus'));
  await page.setInputFiles('#file', resolve(model));
  await page.waitForFunction(() => {
    const s = document.getElementById('modelStatus');
    return s.classList.contains('ok') || s.classList.contains('error');
  }, null, { timeout: 300_000 });
  // Multi-plate 3MFs: pick SMOKE_PLATE (default: the first plate).
  if (await page.isVisible('#plateWrap')) {
    const plates = await page.$$eval('#plate option', (os) => os.map((o) => o.value).filter(Boolean));
    console.log('plates:', plates.join(' '));
    await page.evaluate(() => { const s = document.getElementById('modelStatus'); s.className = 'status'; });
    await page.selectOption('#plate', process.env.SMOKE_PLATE ?? plates[0]);
    await page.waitForFunction(() => {
      const s = document.getElementById('modelStatus');
      return s.classList.contains('error') || (s.classList.contains('ok') && s.textContent.includes('triangles'));
    }, null, { timeout: 300_000 });
  }
  console.log('model:', await page.textContent('#modelStatus'));
  if (!(await page.textContent('#modelStatus')).includes('triangles')) failed = true;
  console.log('colours:', await page.textContent('#coloursTitle'), '|',
    (await page.$$eval('#colourRows select[data-i], #singleSlot', (els) => els.map((e) => `E${Number(e.value) + 1}`))).join(' '));
  console.log('objects:', await page.$$eval('#arrangeCard', (els) => (els[0]?.hidden ? 'arrange hidden' : 'arrange shown')));
  // SMOKE_SLOT=N assigns every colour to extruder N (1-4) before slicing.
  if (process.env.SMOKE_SLOT) {
    // The rows re-render after each change, so look each select up afresh and wait for it to stick.
    const slot = String(Number(process.env.SMOKE_SLOT) - 1);
    const n = await page.locator('#colourRows select[data-i]').count();
    const sels = n ? Array.from({ length: n }, (_, i) => `#colourRows select[data-i="${i}"]`) : ['#singleSlot'];
    for (const sel of sels) {
      await page.selectOption(sel, slot);
      await page.waitForFunction(([q, v]) => document.querySelector(q)?.value === v, [sel, slot]);
    }
  }
  const t0 = Date.now();
  await page.click('#slice');
  await page.waitForFunction(() => {
    const s = document.getElementById('sliceStatus');
    return s.classList.contains('error') || s.textContent.startsWith('Sliced in');
  }, null, { timeout: 900_000 });
  const status = await page.textContent('#sliceStatus');
  console.log('slice:', status, `(wall ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('stats:', (await page.textContent('#stats')).replace(/\s+/g, ' ').trim());
  console.log('legend:', (await page.textContent('#legend')).replace(/\s+/g, ' ').trim());
  if (!status.startsWith('Sliced in')) failed = true;
  const log = await page.textContent('#log');
  const suspicious = log.split('\n').filter((l) => /abort|exception|uncaught|failed|RuntimeError/i.test(l));
  if (suspicious.length) console.log('engine log (suspicious lines):\n  ' + suspicious.slice(0, 20).join('\n  '));
  if (process.env.SMOKE_GCODE) {
    // Save the page's (remapped) G-code via the Download button.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    await dl.saveAs(process.env.SMOKE_GCODE);
  }
  if (shot) await page.screenshot({ path: shot, fullPage: true });
} finally {
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
