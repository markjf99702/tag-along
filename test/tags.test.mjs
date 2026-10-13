import test from 'node:test';
import assert from 'node:assert/strict';
import { STOCKROOM, pad, urlFor, numberIn, clean, describe, linkFrom } from '../js/tags.js';

test('pads to the digit count', () => {
  assert.equal(pad(7, 3), '007');
  assert.equal(pad(1234, 3), '1234');
});
test('builds the Stockroom link', () => {
  assert.equal(urlFor(7, clean({})), STOCKROOM + '007');
  assert.equal(STOCKROOM, 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/');
});
test('reads the number back', () => {
  const s = clean({});
  assert.equal(numberIn(STOCKROOM + '042', s), 42);
  assert.equal(numberIn('https://example.com/042', s), null);
  assert.equal(numberIn(STOCKROOM + 'abc', s), null);
});
test('cleans bad settings', () => {
  const s = clean({ prefix: 'javascript:alert(1)', digits: 99, next: -5, protect: 'x' });
  assert.equal(s.prefix, STOCKROOM); assert.equal(s.digits, 6); assert.equal(s.next, 0); assert.equal(s.protect, true);
  assert.equal(clean({ next: 'abc' }).next, 1);
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
  const d = describe({ records: [{ recordType: 'url', data: enc(STOCKROOM + '009') }] }, s);
  assert.equal(d.number, 9);
});
