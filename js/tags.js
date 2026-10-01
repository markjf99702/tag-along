// The parts that don't need a phone: what goes on a tag, and reading a number back off one.

export const STOCKROOM = 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/';

export const DEFAULTS = {
  prefix: STOCKROOM,   // everything before the number
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

// What number a link carries, if it was written with this prefix. Null if it wasn't.
export function numberIn(url, { prefix }) {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  return /^\d{1,6}$/.test(rest) ? Number(rest) : null;
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

// Turns what a phone read off a tag into a few plain lines.
export function describe(message, settings) {
  const recs = message?.records || [];
  if (!recs.length) return { blank: true, lines: ['Blank tag (nothing written yet).'], number: null };
  const lines = []; let number = null;
  for (const r of recs) {
    let text = '';
    try {
      if (r.recordType === 'url' || r.recordType === 'absolute-url' || r.recordType === 'text') {
        text = new TextDecoder(r.encoding || 'utf-8').decode(r.data);
      }
    } catch { text = ''; }
    if (r.recordType === 'url' || r.recordType === 'absolute-url') {
      const n = numberIn(text, settings);
      if (n != null && number == null) number = n;
      lines.push(text);
    } else if (r.recordType === 'text') lines.push('Text: ' + text);
    else lines.push(`A ${r.recordType} record`);
  }
  return { blank: false, lines, number };
}
