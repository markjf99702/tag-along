import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS_BIN, STOCKROOM, pad, urlFor, numberIn, clean, fromSaved, describe, linkFrom } from '../js/tags.js';

test('pads to the digit count', () => {
  assert.equal(pad(7, 3), '007');
  assert.equal(pad(1234, 3), '1234');
});
test('builds the Parts Bin link', () => {
  assert.equal(urlFor(7, clean({})), PARTS_BIN + '007');
  assert.equal(PARTS_BIN, 'https://parts-bin.junkdrawer.works/#bag/');
  assert.equal(STOCKROOM, 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/');
});
test('reads the number back', () => {
  const s = clean({});
  assert.equal(numberIn(PARTS_BIN + '042', s), 42);
  assert.equal(numberIn('https://example.com/042', s), null);
  assert.equal(numberIn(PARTS_BIN + 'abc', s), null);
  assert.equal(numberIn(STOCKROOM + 'abc', s), null);
});
test('reads the number on a Parts Bin or old Stockroom tag whatever the link setting', () => {
  for (const prefix of [PARTS_BIN, 'https://example.com/b/', 'https://parts-bin.junkdrawer.works/']) {
    const s = clean({ prefix });
    assert.equal(numberIn(PARTS_BIN + '042', s), 42, prefix);
    assert.equal(numberIn(STOCKROOM + '042', s), 42, prefix);
  }
  assert.equal(numberIn('https://example.com/b/042', clean({ prefix: 'https://example.com/b/' })), 42);
  assert.equal(numberIn('https://example.com/b/042', clean({})), null);
});
test('cleans bad settings', () => {
  const s = clean({ prefix: 'javascript:alert(1)', digits: 99, next: -5, protect: 'x' });
  assert.equal(s.prefix, PARTS_BIN); assert.equal(s.digits, 6); assert.equal(s.next, 0); assert.equal(s.protect, true);
  assert.equal(clean({ next: 'abc' }).next, 1);
});
test('moves saved settings with the old Stockroom link to Parts Bin, and keeps any other link', () => {
  // what every phone that wrote a sticker saved
  assert.deepEqual(fromSaved({ prefix: STOCKROOM, digits: 4, next: 37, protect: false }), { prefix: PARTS_BIN, digits: 4, next: 37, protect: false });
  for (const prefix of ['https://example.com/b/', STOCKROOM + 'x/', PARTS_BIN]) assert.equal(fromSaved({ prefix, next: 5 }).prefix, prefix);
  for (const saved of [null, 'junk', 7, {}]) assert.deepEqual(fromSaved(saved), clean(null));
});
test('tidies a link typed into the settings', () => {
  assert.equal(linkFrom('parts-bin.junkdrawer.works/#bag/'), 'https://parts-bin.junkdrawer.works/#bag/');
  assert.equal(linkFrom('  HTTPS://Parts-Bin.junkdrawer.works/#bag/ '), 'https://Parts-Bin.junkdrawer.works/#bag/');
  assert.equal(linkFrom('http://example.com/b/'), 'http://example.com/b/');
  assert.equal(linkFrom('//example.com/b/'), 'https://example.com/b/');
  for (const bad of ['', '   ', 'https://example.com/my bags/', 'javascript:alert(1)', 'ftp://example.com/', 'https://']) assert.equal(linkFrom(bad), null, bad);
});
test('describes what a tag holds', () => {
  const enc = t => new TextEncoder().encode(t);
  const s = clean({});
  assert.equal(describe({ records: [] }, s).blank, true);
  const d = describe({ records: [{ recordType: 'url', data: enc(PARTS_BIN + '009') }] }, s);
  assert.deepEqual([d.number, d.link], [9, PARTS_BIN]);
  const old = describe({ records: [{ recordType: 'url', data: enc(STOCKROOM + '010') }] }, s);
  assert.deepEqual([old.number, old.link, old.lines], [10, STOCKROOM, [STOCKROOM + '010']]);
  const other = describe({ records: [{ recordType: 'url', data: enc('https://example.com/010') }] }, s);
  assert.deepEqual([other.blank, other.number, other.link], [false, null, null]);
});
test('calls a tag holding only an empty record blank, and words other records properly', () => {
  const s = clean({});
  assert.deepEqual(describe({ records: [{ recordType: 'empty', data: new Uint8Array() }] }, s), describe({ records: [] }, s));
  assert.deepEqual(describe({ records: [{ recordType: 'unknown', data: new Uint8Array([1]) }] }, s).lines, ['An unknown record']);
  assert.deepEqual(describe({ records: [{ recordType: 'mime', data: new Uint8Array([1]) }] }, s).lines, ['A mime record']);
});
