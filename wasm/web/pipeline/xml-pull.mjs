// Minimal stand-in for org.xmlpull.v1.XmlPullParser (non-namespace-aware, as the
// Kotlin code creates it via XmlPullParserFactory defaults), so the 3MF ports can
// keep the Kotlin parsing loops nearly line for line. Browser workers have no
// DOMParser, and 3MF model XML can be hundreds of MB, so this is a streaming
// tokenizer over a string rather than a DOM.
//
//   const p = new XmlPullParser(text);
//   for (let ev = p.getEventType(); ev !== XmlPullParser.END_DOCUMENT; ev = p.next()) {
//     if (ev === XmlPullParser.START_TAG && p.getName() === 'object') p.getAttributeValue(null, 'id');
//   }
//
// Self-closing tags produce START_TAG followed by END_TAG, like XmlPullParser.
// Element and attribute names are returned with their prefix ("p:path").

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export class XmlPullParser {
  static START_DOCUMENT = 0;
  static END_DOCUMENT = 1;
  static START_TAG = 2;
  static END_TAG = 3;
  static TEXT = 4;

  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.event = XmlPullParser.START_DOCUMENT;
    this.name = null;
    this.attrs = null;
    this.rawAttrs = '';
    this.textValue = null;
    this.depth = 0;
    this.pendingEnd = false;
  }

  getEventType() { return this.event; }
  getName() { return this.name; }
  getText() { return this.textValue; }
  getDepth() { return this.depth; }
  getAttributeCount() { return this.#attributes().length; }
  getAttributeName(i) { return this.#attributes()[i]?.[0] ?? null; }
  getAttributeValue(nsOrIndex, name) {
    if (name === undefined) return this.#attributes()[nsOrIndex]?.[1] ?? null;
    for (const [k, v] of this.#attributes()) if (k === name) return v;
    return null;
  }

  #attributes() {
    if (this.attrs) return this.attrs;
    const out = [];
    ATTR_RE.lastIndex = 0;
    for (let m; (m = ATTR_RE.exec(this.rawAttrs));) out.push([m[1], decodeEntities(m[3] ?? m[4] ?? '')]);
    this.attrs = out;
    return out;
  }

  /** Advances to the next START_TAG / END_TAG / TEXT / END_DOCUMENT event. */
  next() {
    const t = this.text;
    if (this.pendingEnd) {
      this.pendingEnd = false;
      this.event = XmlPullParser.END_TAG;
      this.attrs = [];
      this.rawAttrs = '';
      return this.event;
    }
    if (this.event === XmlPullParser.END_TAG) this.depth--;
    for (;;) {
      if (this.pos >= t.length) {
        this.event = XmlPullParser.END_DOCUMENT;
        this.name = null;
        return this.event;
      }
      if (t.charCodeAt(this.pos) !== 60 /* < */) {
        let end = t.indexOf('<', this.pos);
        if (end < 0) end = t.length;
        const raw = t.slice(this.pos, end);
        this.pos = end;
        this.event = XmlPullParser.TEXT;
        this.name = null;
        this.textValue = decodeEntities(raw);
        return this.event;
      }
      if (t.startsWith('<!--', this.pos)) {
        const end = t.indexOf('-->', this.pos + 4);
        this.pos = end < 0 ? t.length : end + 3;
        continue;
      }
      if (t.startsWith('<![CDATA[', this.pos)) {
        const end = t.indexOf(']]>', this.pos + 9);
        const stop = end < 0 ? t.length : end;
        this.textValue = t.slice(this.pos + 9, stop);
        this.pos = end < 0 ? t.length : end + 3;
        this.event = XmlPullParser.TEXT;
        this.name = null;
        return this.event;
      }
      if (t.startsWith('<?', this.pos) || t.startsWith('<!', this.pos)) {
        const end = t.indexOf('>', this.pos + 2);
        this.pos = end < 0 ? t.length : end + 1;
        continue;
      }
      const end = this.#tagEnd(this.pos + 1);
      const inner = t.slice(this.pos + 1, end);
      this.pos = end + 1;
      this.attrs = null;
      this.textValue = null;
      if (inner[0] === '/') {
        this.event = XmlPullParser.END_TAG;
        this.name = inner.slice(1).trim();
        this.rawAttrs = '';
        this.attrs = [];
        return this.event;
      }
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const ws = body.search(/\s/);
      this.name = ws < 0 ? body : body.slice(0, ws);
      this.rawAttrs = ws < 0 ? '' : body.slice(ws);
      this.event = XmlPullParser.START_TAG;
      this.depth++;
      this.pendingEnd = selfClosing;
      return this.event;
    }
  }

  /** Index of the '>' closing the tag that starts at `from`, skipping quoted attribute values. */
  #tagEnd(from) {
    const t = this.text;
    let quote = 0;
    for (let i = from; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (quote) { if (c === quote) quote = 0; } else if (c === 34 || c === 39) quote = c;
      else if (c === 62 /* > */) return i;
    }
    return t.length;
  }

  /** XmlPullParser.nextText(): text of the current element, positioned on its END_TAG. */
  nextText() {
    let out = '';
    let ev = this.next();
    while (ev === XmlPullParser.TEXT) { out += this.textValue; ev = this.next(); }
    return out;
  }
}
