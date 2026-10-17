// Zip I/O for the 3MF pipeline ports, in place of the java.util.zip ZipFile /
// ZipOutputStream the Kotlin classes use. Works in Node (tests, CLI) and in the
// browser worker; the site serves fflate at vendor/fflate.mjs (site-files.mjs).
//
// A zip is handled as an ordered array of entries, matching how the Kotlin code
// iterates `zip.entries()`:
//   { name, data: Uint8Array (uncompressed), method: 0 STORED | 8 DEFLATED, size }
const fflate = await import(
  typeof process !== 'undefined' && process.versions?.node
    ? 'fflate'
    : new URL('../vendor/fflate.mjs', import.meta.url).href);

export const STORED = 0;
export const DEFLATED = 8;

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();
/** Kotlin `String(bytes)` (UTF-8). */
export const decodeText = (bytes) => utf8Decoder.decode(bytes);
/** Kotlin `str.toByteArray()` (UTF-8). */
export const encodeText = (text) => utf8Encoder.encode(text);

/** Reads every entry of a zip archive, in archive order. Throws on a corrupt archive. */
export function readZip(bytes) {
  const info = new Map();
  const files = fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    filter(f) {
      info.set(f.name, { method: f.compression, size: f.originalSize });
      return true;
    },
  });
  return Object.keys(files).map((name) => ({
    name,
    data: files[name],
    method: info.get(name)?.method ?? DEFLATED,
    size: info.get(name)?.size ?? files[name].length,
  }));
}

/** Entry lookup by name (Kotlin `zip.getEntry(name)`), or null. */
export function getEntry(entries, name) {
  return entries.find((e) => e.name === name) ?? null;
}

/** Text content of an entry, or null if absent. */
export function readEntryText(entries, name) {
  const e = getEntry(entries, name);
  return e ? decodeText(e.data) : null;
}

/**
 * Writes entries to a new archive, in order. `data` may be a string (UTF-8) or
 * Uint8Array; `method` STORED (the default, what 3MF readers expect) or DEFLATED.
 * Later entries with a duplicate name replace earlier ones, keeping the first position.
 */
export function writeZip(entries) {
  const files = {};
  for (const e of entries) {
    const data = typeof e.data === 'string' ? encodeText(e.data) : e.data;
    files[e.name] = [data, { level: e.method === DEFLATED ? 6 : 0 }];
  }
  return fflate.zipSync(files);
}

/** A mutable output archive with the ZipOutputStream-style calls the Kotlin code makes. */
export class ZipWriter {
  constructor() { this.entries = []; }
  /** writeStored / rawCopy of a STORED entry. */
  stored(name, data) { this.entries.push({ name, data, method: STORED }); }
  /** writeDeflated / putNextEntry with the default method. */
  deflated(name, data) { this.entries.push({ name, data, method: DEFLATED }); }
  /** Copies an entry read by readZip with its original compression method. */
  copy(entry) { this.entries.push({ name: entry.name, data: entry.data, method: entry.method }); }
  has(name) { return this.entries.some((e) => e.name === name); }
  toBytes() { return writeZip(this.entries); }
}
