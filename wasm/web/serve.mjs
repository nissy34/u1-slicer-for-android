#!/usr/bin/env node
// Static server for the WASM spike demo. The engine uses pthreads
// (SharedArrayBuffer), which browsers only enable on cross-origin-isolated
// pages, so every response carries COOP/COEP.
//
//   node wasm/web/serve.mjs [port]      # then open http://localhost:8080/
//
// Serves wasm/web/ and, for u1slicer.{js,wasm}, wasm/build/engine/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [here, join(here, '../build/engine')];
const port = Number(process.argv[2] ?? 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) { res.writeHead(400).end(); return; }
  for (const root of roots) {
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, {
        'Content-Type': types[extname(rel)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return;
    } catch { /* try next root */ }
  }
  res.writeHead(404).end('not found');
}).listen(port, () => console.log(`U1 slicer wasm demo: http://localhost:${port}/`));
