// Minimal Moonraker client for the demo: connection check + G-code upload.
//
// UPLOAD ONLY. Moonraker starts a print only when the upload form carries
// print=true; this module never sends it, and has no start-print call at all.
// (Same rule as the app's "Upload Only": never start a print without the
// user explicitly asking.)
//
// Browser constraints, surfaced as readable errors by explain():
//   * Mixed content — a page served over https:// (e.g. Cloudflare Pages)
//     cannot fetch http://<printer-ip>. Run the page over http (serve.mjs, or
//     from the printer host) or give Moonraker TLS.
//   * CORS — Moonraker must list the page's origin in [authorization]
//     cors_domains, e.g. `cors_domains: https://*.pages.dev  http://localhost:*`.

import { normalizeUrl } from './printer/moonraker.mjs';

// The app's MoonrakerClient.normalizeUrl: http:// and Moonraker's :7125 when no port is given.
export const normalizePrinterUrl = normalizeUrl;

function headers(apiKey) {
  return apiKey ? { 'X-Api-Key': apiKey } : {};
}

/** Returns a reason the browser will refuse this request, or null. */
export function blockedReason(printerUrl, pageUrl = location.href) {
  const page = new URL(pageUrl);
  if (page.protocol === 'https:' && printerUrl.startsWith('http:')) {
    return `This page is served over HTTPS (${page.origin}), so the browser blocks plain-HTTP requests to ` +
      `${printerUrl} (mixed content). Download the G-code instead, or open the slicer over HTTP — ` +
      '`node wasm/web/serve.mjs` on your LAN, or hosted on the printer itself.';
  }
  return null;
}

function explain(err, printerUrl) {
  if (err instanceof TypeError) {
    // fetch() reports CORS rejections, DNS failures and refused connections the same way.
    return `Could not reach ${printerUrl}. Check the address, and that Moonraker's [authorization] ` +
      `cors_domains includes ${location.origin}.`;
  }
  return String(err?.message ?? err);
}

async function call(printerUrl, path, init) {
  const r = await fetch(printerUrl + path, init);
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) {
    throw new Error(`Printer rejected the request (HTTP ${r.status}): check the API key.`);
  }
  if (!r.ok) throw new Error(body?.error?.message || `HTTP ${r.status}`);
  return body.result ?? body;
}

export async function checkPrinter({ url, apiKey }) {
  const printerUrl = normalizePrinterUrl(url);
  const blocked = blockedReason(printerUrl);
  if (blocked) throw new Error(blocked);
  try {
    const info = await call(printerUrl, '/server/info', { headers: headers(apiKey) });
    return { klippyState: info.klippy_state, moonraker: info.moonraker_version };
  } catch (e) {
    throw new Error(explain(e, printerUrl));
  }
}

/** Uploads to the printer's gcodes root. Does NOT start a print. */
export async function uploadGcode({ url, apiKey, filename, blob }) {
  const printerUrl = normalizePrinterUrl(url);
  const blocked = blockedReason(printerUrl);
  if (blocked) throw new Error(blocked);
  const form = new FormData();
  form.append('root', 'gcodes');
  form.append('file', blob, filename);
  // Deliberately no form.append('print', 'true').
  try {
    const res = await call(printerUrl, '/server/files/upload', {
      method: 'POST', body: form, headers: headers(apiKey),
    });
    return res.item?.path ?? filename;
  } catch (e) {
    throw new Error(explain(e, printerUrl));
  }
}
