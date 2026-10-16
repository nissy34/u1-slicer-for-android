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

const port = 8000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [join(here, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.once('data', ok));

const browser = await playwright.chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  page.on('pageerror', (e) => { console.error('pageerror:', e.message, String(e.stack ?? '').slice(0, 400)); failed = true; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text().slice(0, 400)); });
  await page.goto(`http://localhost:${port}/`);
  console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
  await page.waitForFunction(() => document.getElementById('slice').textContent === 'Slice', null, { timeout: 60_000 });
  console.log('status:', await page.textContent('#status'));
  await page.setInputFiles('#file', resolve(model));
  const t0 = Date.now();
  await page.click('#slice');
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s.className === 'error' || s.textContent.startsWith('Sliced in');
  }, null, { timeout: 600_000 });
  const status = await page.textContent('#status');
  console.log('status:', status, `(wall ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('stats:', (await page.textContent('#stats')).replace(/\s+/g, ' ').trim());
  if (!status.startsWith('Sliced in')) failed = true;
  const log = await page.textContent('#log');
  const suspicious = log.split('\n').filter((l) => /abort|exception|uncaught|failed|RuntimeError/i.test(l));
  if (suspicious.length) console.log('engine log (suspicious lines):\n  ' + suspicious.slice(0, 20).join('\n  '));
  if (shot) await page.screenshot({ path: shot, fullPage: true });
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
