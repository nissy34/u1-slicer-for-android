#!/usr/bin/env node
// Builds the deployable static site: wasm/build/site/ (+ wasm/build/site.zip).
//
//   node wasm/web/package.mjs
//
// Deploy the folder (or zip) as-is to any static host that honours a
// Cloudflare-style `_headers` file — Cloudflare Pages (Direct Upload or
// `wrangler pages deploy`), Netlify. Hosts that ignore `_headers` must be
// configured to send the COOP/COEP headers in site-files.mjs themselves.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADERS, SITE_FILES } from './site-files.mjs';

const web = dirname(fileURLToPath(import.meta.url));
const out = process.env.U1SLICER_SITE_DIR ?? join(web, '../build/site');
const CF_MAX_FILE = 25 * 2 ** 20; // Cloudflare Pages per-file limit

rmSync(out, { recursive: true, force: true });
let total = 0;
for (const [pub, src] of Object.entries(SITE_FILES)) {
  const dst = join(out, pub);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const size = statSync(dst).size;
  total += size;
  if (size > CF_MAX_FILE) throw new Error(`${pub} is ${(size / 2 ** 20).toFixed(1)} MB, over Cloudflare Pages' 25 MiB file limit`);
}

const headerLines = Object.entries(HEADERS).map(([k, v]) => `  ${k}: ${v}`).join('\n');
writeFileSync(join(out, '_headers'), `/*
${headerLines}
  X-Content-Type-Options: nosniff

/u1slicer.wasm
  Content-Type: application/wasm
`);

const zip = join(out, '../site.zip');
rmSync(zip, { force: true });
execFileSync('zip', ['-qr9', zip, '.'], { cwd: out });
console.log(`site: ${out} (${(total / 2 ** 20).toFixed(1)} MB, ${Object.keys(SITE_FILES).length + 1} files)`);
console.log(`zip:  ${zip} (${(statSync(zip).size / 2 ** 20).toFixed(1)} MB)`);
