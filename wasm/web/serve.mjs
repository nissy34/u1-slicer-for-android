#!/usr/bin/env node
// Dev server for the web slicer: serves SITE_FILES (the same set package.mjs
// deploys) with the COOP/COEP headers the engine needs.
//
//   node wasm/web/serve.mjs [port] [--host 0.0.0.0]
//
// Plain HTTP on purpose: with --host 0.0.0.0 you can open it from another
// device on your LAN and still reach a printer over http (an https page can't).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { CONTENT_TYPES, HEADERS, SITE_FILES } from './site-files.mjs';

const args = process.argv.slice(2);
const hostIdx = args.indexOf('--host');
const host = hostIdx >= 0 ? args.splice(hostIdx, 2)[1] : '127.0.0.1';
const port = Number(args[0] ?? 8080);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const src = SITE_FILES[path];
  if (!src) { res.writeHead(404, HEADERS).end('not found'); return; }
  try {
    const body = await readFile(src);
    res.writeHead(200, { ...HEADERS, 'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(500, HEADERS).end(`missing ${src} — build the engine / npm install first`);
  }
}).listen(port, host, () => console.log(`U1 web slicer: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
