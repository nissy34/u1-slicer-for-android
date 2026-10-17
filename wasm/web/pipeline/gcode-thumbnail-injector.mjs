// Port of app/src/main/java/com/u1/slicer/gcode/GcodeThumbnailInjector.kt.
//
// Extracts a preview image from a 3MF and injects base64 PNG thumbnail blocks
// into G-code (Moonraker/Klipper serves them via /server/files/thumbnails):
//   ; thumbnail begin WxH LEN
//   ; <base64, 76-char lines>
//   ; thumbnail end
//   ;
// Sizes 48x48 and 300x300. Inserted after the "; HEADER_BLOCK_END" line, else prepended.
//
// The Android version decodes/scales with android.graphics. Here image work goes
// through a pluggable async `imageCodec`:
//   { decode(bytes: Uint8Array, name: string): Promise<image|null>   // image.width/.height > 0
//     thumbnailPng(image, w, h): Promise<Uint8Array> }               // w x h RGB PNG on white
// Built in: `canvasImageCodec` (OffscreenCanvas + createImageBitmap; browsers/workers)
// and `pureJsImageCodec` (Node + fallback: PNG only, decoded with fflate).
// `defaultImageCodec()` picks the canvas codec when available, else pure JS.
//
// Both built-in codecs finish with the same encoder, which mirrors Android: the
// scaled image is drawn over WHITE into an RGB_565 bitmap and saved as an RGB PNG
// (no alpha — some Klipper/Moonraker firmware mishandles RGBA thumbnails).
// Pixel-level differences vs Android (block structure and WxH are identical):
//  - Scaling: pure JS uses bilinear sampling on premultiplied RGBA with Skia's
//    pixel-centre mapping (what createScaledBitmap(filter=true) does); the canvas codec
//    uses the browser's drawImage smoothing ('low' quality), which may differ slightly.
//  - RGB_565 quantisation is reproduced (round to 5/6/5 bits, expanded back to 8 bits);
//    Skia's exact rounding/dither may differ by ±1 level.
//  - PNG bytes (and so LEN and the base64) differ: different zlib encoder / row filters.
//  - Pure JS cannot decode JPEG previews; inject() then returns null (Android decodes them).
//    If a PNG cannot be decoded but already has the exact target size, its bytes are
//    embedded unchanged.
import { readZip } from './zip.mjs';
import { toIntOrNull } from './kt.mjs';

const fflate = await import(
  typeof process !== 'undefined' && process.versions?.node
    ? 'fflate'
    : new URL('../vendor/fflate.mjs', import.meta.url).href);

// Keywords to score preview images in the 3MF
const SCORE_KEYWORDS = ['thumbnail', 'preview', 'cover', 'top', 'plate', 'pick'];
const PLATE_HINT_REGEX = /plate[_-]?(\d+)/i;
export const THUMBNAIL_SIZES = [[48, 48], [300, 300]];

const endsWithIgnoreCase = (s, suffix) => s.toLowerCase().endsWith(suffix.toLowerCase());

/**
 * Extract a preview from a 3MF and inject thumbnail blocks into the G-code.
 * @param {string} gcodeText
 * @param {Uint8Array|null} sourceBytes the 3MF
 * @param {string} sourceName its file name (must end in .3mf; also gives the plate hint)
 * @param {{imageCodec?: object}} [options]
 * @returns {Promise<string|null>} new G-code text, or null when nothing was injected
 */
export async function inject(gcodeText, sourceBytes, sourceName, options = {}) {
  if (sourceBytes == null || !endsWithIgnoreCase(String(sourceName ?? ''), '.3mf')) return null;
  const codec = options.imageCodec ?? defaultImageCodec();
  const image = await extractPreviewImage(sourceBytes, inferPlateHint(baseName(sourceName)), codec);
  if (image == null) return null;
  const blocks = await buildThumbnailBlocks(image, codec);
  if (blocks.length === 0) return null;
  return injectIntoGcode(gcodeText, blocks);
}

/**
 * Inject thumbnail blocks from an existing image (e.g. a viewer screenshot for STL).
 * With the pure-JS codec, `image` is {width, height, data: RGBA Uint8Array|Uint8ClampedArray}
 * (ImageData-like, non-premultiplied); the canvas codec also takes an ImageBitmap.
 */
export async function injectFromBitmap(gcodeText, image, options = {}) {
  const codec = options.imageCodec ?? defaultImageCodec();
  const blocks = await buildThumbnailBlocks(image, codec);
  if (blocks.length === 0) return null;
  return injectIntoGcode(gcodeText, blocks);
}

const baseName = (p) => String(p).split(/[\\/]/).pop();

/** Best preview image in the 3MF, decoded by the codec; null on any failure. */
export async function extractPreviewImage(threeMfBytes, plateHint = null, imageCodec = defaultImageCodec()) {
  try {
    const entries = readZip(threeMfBytes);
    const candidates = entries
      .filter((e) => !e.name.endsWith('/'))
      .filter((e) => endsWithIgnoreCase(e.name, '.png') || endsWithIgnoreCase(e.name, '.jpg') || endsWithIgnoreCase(e.name, '.jpeg'));
    if (candidates.length === 0) return null;
    const best = pickBestPreviewEntry(candidates, plateHint);
    return (await imageCodec.decode(best.data, best.name)) ?? null;
  } catch {
    return null;
  }
}

/** Highest score wins; ties keep archive order. Candidates are {name, ...} entries. */
export function pickBestPreviewEntry(candidates, plateHint = null) {
  return candidates
    .map((entry, index) => ({ entry, index, score: scorePreviewEntry(entry.name, plateHint) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))[0].entry;
}

export function scorePreviewEntry(entryName, plateHint = null) {
  const name = entryName.toLowerCase();
  let score = SCORE_KEYWORDS.reduce((acc, kw) => acc + (name.includes(kw) ? 1 : 0), 0);
  if (plateHint != null) {
    const exactHints = [
      [`plate_no_light_${plateHint}.png`, 120], [`plate_no_light_${plateHint}.jpg`, 120], [`plate_no_light_${plateHint}.jpeg`, 120],
      [`plate_${plateHint}.png`, 110], [`plate_${plateHint}.jpg`, 110], [`plate_${plateHint}.jpeg`, 110],
      [`top_${plateHint}.png`, 100], [`top_${plateHint}.jpg`, 100], [`top_${plateHint}.jpeg`, 100],
      [`pick_${plateHint}.png`, 90], [`pick_${plateHint}.jpg`, 90], [`pick_${plateHint}.jpeg`, 90],
    ];
    for (const [suffix, bonus] of exactHints) {
      if (name.endsWith(suffix)) { score += bonus; break; }
    }
  }
  return score;
}

export function inferPlateHint(sourceName) {
  const m = PLATE_HINT_REGEX.exec(sourceName);
  return m ? toIntOrNull(m[1]) : null;
}

/** Thumbnail comment blocks for all target sizes. */
export async function buildThumbnailBlocks(image, imageCodec = defaultImageCodec()) {
  let sb = '';
  for (const [w, h] of THUMBNAIL_SIZES) {
    const pngBytes = await imageCodec.thumbnailPng(image, w, h);
    const b64 = base64Encode(pngBytes);
    sb += `; thumbnail begin ${w}x${h} ${b64.length}\n`;
    // 76-char lines: vanilla Klipper/Moonraker format, supported by all Moonraker versions.
    for (let i = 0; i < b64.length; i += 76) sb += `; ${b64.substring(i, Math.min(i + 76, b64.length))}\n`;
    sb += '; thumbnail end\n';
    sb += ';\n';
  }
  return sb;
}

/**
 * Insert blocks after the first line containing "; HEADER_BLOCK_END", else prepend.
 * Lines are re-terminated with '\n' (Kotlin readLine/newLine loop).
 */
export function injectIntoGcode(gcodeText, blocks) {
  const lines = splitLines(gcodeText);
  const out = [];
  let injected = false;
  for (const line of lines) {
    out.push(line, '\n');
    if (!injected && line.includes('; HEADER_BLOCK_END')) {
      out.push(blocks);
      injected = true;
    }
  }
  return injected ? out.join('') : blocks + out.join('');
}

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

// ---------------------------------------------------------------- codecs

/** Canvas codec when OffscreenCanvas + createImageBitmap exist, else the pure-JS codec. */
export function defaultImageCodec() {
  return canvasImageCodec ?? pureJsImageCodec;
}

/** Browser / worker codec (null where OffscreenCanvas is unavailable, e.g. Node). */
export const canvasImageCodec =
  typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function'
    ? {
      async decode(bytes, name = '') {
        const type = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
        try {
          const bmp = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: 'premultiply' });
          return bmp.width > 0 && bmp.height > 0 ? bmp : null;
        } catch {
          return null;
        }
      },
      async thumbnailPng(image, w, h) {
        let src = image;
        if (!(typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)) {
          // ImageData-like {width, height, data}
          const c = new OffscreenCanvas(image.width, image.height);
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
          src = c;
        }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low'; // bilinear, like createScaledBitmap(filter = true)
        ctx.drawImage(src, 0, 0, w, h);
        return encodeRgbPng(ctx.getImageData(0, 0, w, h).data, w, h);
      },
    }
    : null;

/** Pure-JS codec: PNG decode via fflate, bilinear scale, white background, RGB PNG. */
export const pureJsImageCodec = {
  async decode(bytes, name = '') {
    if (!isPng(bytes)) return null; // JPEG: no pure-JS decoder
    const header = readPngHeader(bytes);
    if (header == null || header.width <= 0 || header.height <= 0) return null;
    let decoded = null;
    try { decoded = decodePng(bytes); } catch { decoded = null; }
    if (decoded == null) return { width: header.width, height: header.height, data: null, png: bytes };
    return decoded;
  },
  async thumbnailPng(image, w, h) {
    if (image.data == null) {
      // Undecodable PNG: embed as-is only when it already has the target size.
      if (image.png != null && image.width === w && image.height === h) return image.png;
      throw new Error('cannot scale an undecodable image without an image codec');
    }
    return encodeRgbPng(scaleOntoWhite(image, w, h), w, h);
  },
};

/**
 * Bilinear resample of a non-premultiplied RGBA image to w x h (Skia pixel-centre
 * mapping, clamped edges, premultiplied interpolation), then src-over onto white.
 * @returns {Uint8ClampedArray} RGBA (alpha 255)
 */
export function scaleOntoWhite(image, w, h) {
  const { width: sw, height: sh, data } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = sw / w, sy = sh / h;
  const px = (x, y, c) => data[(y * sw + x) * 4 + c];
  for (let dy = 0; dy < h; dy++) {
    let fy = (dy + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    if (fy > sh - 1) fy = sh - 1;
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let dx = 0; dx < w; dx++) {
      let fx = (dx + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      if (fx > sw - 1) fx = sw - 1;
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), tx = fx - x0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const a00 = px(x0, y0, 3) / 255, a10 = px(x1, y0, 3) / 255, a01 = px(x0, y1, 3) / 255, a11 = px(x1, y1, 3) / 255;
      const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      const o = (dy * w + dx) * 4;
      for (let c = 0; c < 3; c++) {
        const premul = px(x0, y0, c) * a00 * w00 + px(x1, y0, c) * a10 * w10 +
          px(x0, y1, c) * a01 * w01 + px(x1, y1, c) * a11 * w11;
        out[o + c] = Math.round(premul + 255 * (1 - a));
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG encode

/**
 * Encode RGBA pixels (alpha ignored — already composited) as an 8-bit RGB PNG,
 * quantised through RGB_565 like the Android Bitmap.Config.RGB_565 target.
 */
export function encodeRgbPng(rgba, w, h) {
  const q5 = (v) => Math.round((Math.round((v * 31) / 255) * 255) / 31);
  const q6 = (v) => Math.round((Math.round((v * 63) / 255) * 255) / 63);
  const stride = w * 3;
  const rows = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      row[x * 3] = q5(rgba[i]);
      row[x * 3 + 1] = q6(rgba[i + 1]);
      row[x * 3 + 2] = q5(rgba[i + 2]);
    }
    rows.push(filterRow(row, prev, 3));
    prev = row;
  }
  const raw = new Uint8Array(rows.reduce((n, r) => n + r.length, 0));
  let off = 0;
  for (const r of rows) { raw.set(r, off); off += r.length; }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', fflate.zlibSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// libpng-style adaptive filter choice (minimum sum of absolute differences).
function filterRow(row, prev, bpp) {
  let best = null;
  let bestSum = Infinity;
  for (let type = 0; type <= 4; type++) {
    const out = new Uint8Array(row.length + 1);
    out[0] = type;
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = row[i]; break;
        case 1: v = row[i] - a; break;
        case 2: v = row[i] - b; break;
        case 3: v = row[i] - ((a + b) >> 1); break;
        default: v = row[i] - paeth(a, b, c); break;
      }
      v &= 0xff;
      out[i + 1] = v;
      sum += v < 128 ? v : 256 - v;
    }
    if (sum < bestSum) { bestSum = sum; best = out; }
  }
  return best;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------------------------------------------------------------- PNG decode

const isPng = (b) => b != null && b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);

function readPngHeader(bytes) {
  if (!isPng(bytes) || bytes.length < 33) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Decode a PNG (all colour types and bit depths, Adam7 included) to
 * {width, height, data: Uint8ClampedArray non-premultiplied RGBA}.
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (width <= 0 || height <= 0) throw new Error('bad PNG header');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (channels == null) throw new Error(`unsupported PNG colour type ${ctype}`);
  const raw = fflate.unzlibSync(concatBytes(idat));
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const out = new Uint8ClampedArray(width * height * 4);

  let pos = 0;
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  for (const [x0, y0, dxs, dys] of passes) {
    const pw = Math.ceil((width - x0) / dxs);
    const ph = Math.ceil((height - y0) / dys);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const ft = raw[pos++];
      const row = raw.slice(pos, pos + stride);
      pos += stride;
      unfilter(ft, row, prev, bpp);
      for (let x = 0; x < pw; x++) {
        writePixel(out, ((y0 + y * dys) * width + (x0 + x * dxs)) * 4, row, x, ctype, depth, channels, palette, trns);
      }
      prev = row;
    }
  }
  return { width, height, data: out };
}

function unfilter(type, row, prev, bpp) {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0: break;
      case 1: row[i] = (row[i] + a) & 0xff; break;
      case 2: row[i] = (row[i] + b) & 0xff; break;
      case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
      case 4: row[i] = (row[i] + paeth(a, b, c)) & 0xff; break;
      default: throw new Error(`bad PNG filter ${type}`);
    }
  }
}

function sample(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

function writePixel(out, o, row, x, ctype, depth, channels, palette, trns) {
  const max = (1 << depth) - 1;
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  const s = (c) => sample(row, x * channels + c, depth);
  if (ctype === 3) {
    const i = s(0);
    out[o] = palette?.[i * 3] ?? 0;
    out[o + 1] = palette?.[i * 3 + 1] ?? 0;
    out[o + 2] = palette?.[i * 3 + 2] ?? 0;
    out[o + 3] = trns != null && i < trns.length ? trns[i] : 255;
  } else if (ctype === 0 || ctype === 4) {
    const g = s(0);
    out[o] = out[o + 1] = out[o + 2] = to8(g);
    if (ctype === 4) out[o + 3] = to8(s(1));
    else out[o + 3] = trns != null && trns.length >= 2 && g === ((trns[0] << 8) | trns[1]) ? 0 : 255;
  } else {
    const r = s(0), g = s(1), b = s(2);
    out[o] = to8(r);
    out[o + 1] = to8(g);
    out[o + 2] = to8(b);
    if (ctype === 6) out[o + 3] = to8(s(3));
    else {
      const key = (i) => (trns[i * 2] << 8) | trns[i * 2 + 1];
      out[o + 3] = trns != null && trns.length >= 6 && r === key(0) && g === key(1) && b === key(2) ? 0 : 255;
    }
  }
}

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Standard base64 with padding, no line wraps (Android Base64.NO_WRAP). */
export function base64Encode(bytes) {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    s += `${B64[n >> 18]}${B64[(n >> 12) & 63]}==`;
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += `${B64[n >> 18]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return s;
}

export const GcodeThumbnailInjector = {
  inject, injectFromBitmap, extractPreviewImage, pickBestPreviewEntry, scorePreviewEntry, inferPlateHint,
  buildThumbnailBlocks, injectIntoGcode,
};
