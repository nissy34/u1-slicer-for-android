// Shared setup for the engine-level integration tests (npm run test:engine):
// they need the built wasm engine (wasm/build/engine) and run the full
// pipeline session the web page uses, mirroring the app's instrumented tests.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlicerSession } from '../pipeline/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
export const ASSETS = join(REPO, 'app/src/androidTest/assets');
const ENGINE_JS = process.env.U1SLICER_WASM_JS ?? join(REPO, 'wasm/build/engine/u1slicer.js');
export const engineAvailable = existsSync(ENGINE_JS);

const profile = (p) => JSON.parse(readFileSync(join(REPO, 'app/src/main/assets/orca_profiles', p), 'utf8'));
export const PROFILES = {
  printer: profile('printer/snapmaker_u1.json'),
  process: profile('process/standard_0.20mm.json'),
  filament: profile('filament/pla.json'),
};

let enginePromise = null;
/** One engine per test file (each node:test file runs in its own process). */
export function engine() {
  enginePromise ??= createRequire(import.meta.url)(ENGINE_JS)({ print: () => {}, printErr: () => {} });
  return enginePromise;
}

export async function session() {
  return new SlicerSession({ engine: await engine(), profiles: PROFILES });
}

export const asset = (name) => readFileSync(join(ASSETS, name));

/** Load a fixture the way the page does (plate picked when the file has several). */
export async function loadFixture(name, plateId = null) {
  const s = await session();
  let summary = s.loadModel(name, asset(name));
  if (plateId != null || summary.needsPlateSelection) summary = s.selectPlate(plateId ?? summary.plates[0].plateId);
  return { s, summary };
}

/** Standalone tool-change lines T<n>, like the app tests' `gcode.lines().count { it.trim() == "T$t" }`. */
export function toolCounts(gcode, max = 16) {
  const counts = Array(max).fill(0);
  for (const line of gcode.split('\n')) {
    const m = /^T(\d+)$/.exec(line.trim());
    if (m && Number(m[1]) < max) counts[Number(m[1])]++;
  }
  return counts;
}

/** BambuFixtureHarnessTest.parseGcodeStats: extents of positive G0/G1 X/Y. */
export function gcodeExtents(gcode) {
  const xRe = /G[01]\s+(?:[^\s;]+\s+)*X(-?[\d.]+)/;
  const yRe = /G[01]\s+(?:[^\s;]+\s+)*Y(-?[\d.]+)/;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const line of gcode.split('\n')) {
    const x = Number(xRe.exec(line)?.[1]);
    if (x > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    const y = Number(yRe.exec(line)?.[1]);
    if (y > 0) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return { minX, maxX, minY, maxY, width: Number.isFinite(minX) ? maxX - minX : 0, height: Number.isFinite(minY) ? maxY - minY : 0 };
}

export const headerValue = (gcode, key) => new RegExp(`^; ${key} = (.*)$`, 'm').exec(gcode)?.[1] ?? null;
