// The parts that don't need a phone: what goes on a tag, and reading a number back off one.

// Parts Bin's bag link: a tag with it opens that bag in Parts Bin.
export const PARTS_BIN = 'https://parts-bin.junkdrawer.works/#bag/';
// The bag link from before Parts Bin had its own address. Tags written with it carry the same bag numbers, and Parts
// Bin still reads them (and offers to rewrite them).
export const STOCKROOM = 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/';

export const DEFAULTS = {
  prefix: PARTS_BIN,   // everything before the number
  digits: 3,           // 7 -> 007
  next: 1,             // the number the next tag gets
  protect: true,       // refuse to write over a tag that already holds something
};

export function pad(n, digits) {
  return String(Math.max(0, Math.floor(n))).padStart(digits, '0');
}

export function urlFor(n, { prefix, digits }) {
  return prefix + pad(n, digits);
}

// What number a link carries, and which link it was written with: the one in the settings, Parts Bin's, or the old
// Stockroom one (the same bags). Null if it isn't one of those followed by a number.
export function readLink(url, { prefix }) {
  if (typeof url !== 'string') return null;
  for (const link of [prefix, PARTS_BIN, STOCKROOM]) {
    const rest = url.startsWith(link) ? url.slice(link.length) : '';
    if (/^\d{1,6}$/.test(rest)) return { number: Number(rest), link };
  }
  return null;
}
export function numberIn(url, settings) {
  return readLink(url, settings)?.number ?? null;
}

// A link typed into the settings, tidied: an address without https:// gets it, and HTTPS:// is fine too.
// Null if it still isn't a web link.
export function linkFrom(text) {
  let link = String(text ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = 'https://' + link.replace(/^\/+/, '');
  link = link.replace(/^https?:/i, s => s.toLowerCase());
  return /^https?:\/\/\S+$/.test(link) ? link : null;
}

// Settings arrive from localStorage, which anyone can edit: keep them sane.
export function clean(s) {
  const out = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  if (typeof out.prefix !== 'string' || !/^https?:\/\/\S+$/.test(out.prefix)) out.prefix = DEFAULTS.prefix;
  out.digits = Math.min(6, Math.max(1, Math.round(Number(out.digits) || DEFAULTS.digits)));
  out.next = Math.min(999999, Math.max(0, Math.round(Number(out.next))));
  if (!Number.isFinite(out.next)) out.next = DEFAULTS.next;
  out.protect = out.protect !== false;
  return out;
}

// Settings as any version saved them. The old Stockroom link was the default before Parts Bin had its own address,
// and every phone that wrote a sticker saved it: that one moves to Parts Bin's. Any other link stays.
export function fromSaved(s) {
  return clean(s && typeof s === 'object' && s.prefix === STOCKROOM ? { ...s, prefix: PARTS_BIN } : s);
}

// Turns what a phone read off a tag into a few plain lines.
export function describe(message, settings) {
  const recs = message?.records || [];
  // a sticker can come formatted with one empty record: that's blank too
  if (recs.every(r => r.recordType === 'empty')) return { blank: true, lines: ['Blank tag (nothing written yet).'], number: null, link: null };
  const lines = []; let number = null, link = null;
  for (const r of recs) {
    let text = '';
    try {
      if (r.recordType === 'url' || r.recordType === 'absolute-url' || r.recordType === 'text') {
        text = new TextDecoder(r.encoding || 'utf-8').decode(r.data);
      }
    } catch { text = ''; }
    if (r.recordType === 'url' || r.recordType === 'absolute-url') {
      const got = readLink(text, settings);
      if (got && number == null) ({ number, link } = got);
      lines.push(text);
    } else if (r.recordType === 'text') lines.push('Text: ' + text);
    else lines.push(`${/^[aeiou]/i.test(r.recordType) ? 'An' : 'A'} ${r.recordType} record`);
  }
  return { blank: false, lines, number, link };
}
