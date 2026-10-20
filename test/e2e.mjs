// Uses the app in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Skeleton from the junkdrawer skill: the checks at the bottom are the ones every project wants;
// add the ones that prove this app does its job.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });

// A pretend NFC reader that behaves like Chrome's. write() waits for window.__tap(), which plays a sticker touching
// the phone (__tap({ fail: 'NotAllowedError', message }) plays one that refuses it); a new write() cancels one still
// waiting, and an aborted one rejects with the signal's reason (nfc.abortDelay ms later, as Chrome's answer comes
// back from its NFC service). nfc.writeError ([name, message]) makes every write fail at once, as on a phone without
// NFC. scan() starts listening after nfc.scanDelay ms, or fails with nfc.scanError, and
// __read([[recordType, text], ...]) plays a tag for it. nfc.perm is what permissions.query says about NFC, and
// nfc.locks counts the screen wake locks held.
function fakeNfc() {
  const nfc = window.__nfc = { written: [], pending: [], writeError: null, abortDelay: 0, scans: [], scanError: null, scanDelay: 0, perm: 'granted', buzzes: 0, locks: 0 };
  window.NDEFReader = class {
    write(msg, o = {}) {
      return new Promise((resolve, reject) => {
        if (o.signal?.aborted) { reject(o.signal.reason); return; }
        if (nfc.writeError) { reject(new DOMException(nfc.writeError[1], nfc.writeError[0])); return; }
        for (const old of nfc.pending.splice(0)) old.reject(new DOMException('Push is cancelled due to a new push request.', 'AbortError'));
        const w = { msg, resolve, reject };
        nfc.pending.push(w);
        o.signal?.addEventListener('abort', () => {
          const i = nfc.pending.indexOf(w); if (i < 0) return;
          nfc.pending.splice(i, 1);
          const answer = () => reject(o.signal.reason);
          if (nfc.abortDelay) setTimeout(answer, nfc.abortDelay); else answer();
        });
      });
    }
    scan(o = {}) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          if (nfc.scanError) { reject(new DOMException(nfc.scanError[1], nfc.scanError[0])); return; }
          nfc.scans.push(this); resolve();
        }, nfc.scanDelay);
        o.signal?.addEventListener('abort', () => { clearTimeout(t); nfc.scans = nfc.scans.filter(r => r !== this); reject(o.signal.reason); });
      });
    }
  };
  window.__tap = ({ fail, message = 'NDEFWriteOptions#overwrite does not allow overwrite.' } = {}) => {
    const w = nfc.pending.shift();
    if (!w) return false;
    if (fail) w.reject(new DOMException(message, fail));
    else { nfc.written.push(w.msg.records[0].data); w.resolve(); }
    return true;
  };
  window.__read = records => {
    const message = { records: records.map(([recordType, text]) => ({ recordType, data: new TextEncoder().encode(text) })) };
    for (const r of nfc.scans) r.onreading?.({ message });
    return nfc.scans.length;
  };
  navigator.vibrate = () => { nfc.buzzes++; return true; };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
    nfc.locks++; let held = true;
    return { release: async () => { if (held) { held = false; nfc.locks--; } } };
  } } });
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = d => (d?.name === 'nfc' ? Promise.resolve({ state: nfc.perm }) : query(d));
}
await ctx.addInitScript(fakeNfc);
const problems = [];
function watch(p) {
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  p.on('requestfailed', r => problems.push('failed: ' + r.url()));
  p.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });
}
const page = await ctx.newPage();
watch(page);

// A fresh phone for one check: its own storage, the pretend reader, no service worker.
async function phone(options = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...options });
  await c.addInitScript(fakeNfc);
  const p = await c.newPage();
  watch(p);
  await p.goto(base);
  return p;
}
const waitingFor = (p, label) => p.waitForFunction(label => { const s = document.querySelector('#status'); return s.classList.contains('wait') && s.textContent.includes(label); }, label, { timeout: 8000 });
const statusIs = (p, kind) => p.waitForFunction(kind => document.querySelector('#status').classList.contains(kind), kind);

// Other tools on junkdrawer.works share this address's caches. Make one, and an old one of this tool's, before
// the service worker first starts: it should clear out only its own.
const other = await ctx.newPage();
await other.goto(base + 'another-tool/');
await other.evaluate(async () => { await caches.open('name-tag-v3'); await caches.open('tag-along-v0'); });
await other.close();

await page.goto(base);
await page.evaluate(() => document.fonts.ready);


// Starts at #001 and writes the Parts Bin link for it.
assert.equal(await page.textContent('#num'), '#001');
await page.click('#go');
await waitingFor(page, '#001');
assert.ok(await page.evaluate(() => window.__tap()));
await page.waitForFunction(() => document.querySelector('#num').textContent === '#002');
assert.equal((await page.evaluate(() => window.__nfc.written))[0], 'https://parts-bin.junkdrawer.works/#bag/001');
// The loop waits, then asks for the next sticker; a used sticker is refused and the number doesn't move.
await page.waitForFunction(() => /#002/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
await page.evaluate(() => window.__tap({ fail: 'NotAllowedError' }));
await page.waitForFunction(() => document.querySelector('#status').classList.contains('bad'));
assert.equal(await page.textContent('#num'), '#002');
await page.waitForFunction(() => /#002/.test(document.querySelector('#status').textContent) && document.querySelector('#status').classList.contains('wait'), null, { timeout: 5000 });
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => document.querySelector('#num').textContent === '#003');
// Stop, skip one, and the number survives a reload.
await page.click('#go');
await page.click('#skip');
assert.equal(await page.textContent('#num'), '#004');
await page.reload();
assert.equal(await page.textContent('#num'), '#004');
// A different start number from settings.
await page.click('.settings summary');
await page.fill('#next', '50'); await page.dispatchEvent('#next', 'change');
assert.equal(await page.textContent('#num'), '#050');

// Stop then Start during the pause after a sticker, or after a refusal: still one run, and Stop still stops it.
for (const fail of [undefined, 'NetworkError']) {
  const p = await phone();
  await p.click('#go'); await waitingFor(p, '#001');
  await p.evaluate(fail => window.__tap({ fail, message: 'Failed to write due to an IO error: x' }), fail);
  await statusIs(p, fail ? 'bad' : 'ok');
  await p.click('#go'); await p.click('#go');
  await p.waitForTimeout(2500); // longer than either pause
  assert.equal(await p.textContent('#go'), 'Stop', 'Start after Stop was undone by the run before it');
  await waitingFor(p, fail ? '#001' : '#002');
  assert.equal(await p.evaluate(() => window.__nfc.pending.length), 1);
  await p.click('#go');
  assert.equal(await p.evaluate(() => window.__tap()), false, 'a write was still waiting after Stop');
  await p.waitForFunction(() => window.__nfc.locks === 0, null, { timeout: 3000 }).catch(() => assert.fail('the screen was kept awake after Stop'));
  await p.context().close();
}

// Stop then Start in one go (a double tap) while it waits for a sticker. Chrome answers the cancelled write a moment
// later, once the new run has begun, and that answer mustn't end the new run.
{
  const p = await phone();
  await p.evaluate(() => { window.__nfc.abortDelay = 300; });
  await p.click('#go'); await waitingFor(p, '#001');
  await p.evaluate(() => { const go = document.querySelector('#go'); go.click(); go.click(); });
  await p.waitForTimeout(1000); // the cancelled write has had its answer
  assert.equal(await p.textContent('#go'), 'Stop', 'the answer to the cancelled write ended the run after it');
  assert.deepEqual(await p.evaluate(() => [window.__nfc.pending.length, window.__nfc.locks]), [1, 1], 'one write waiting, one wake lock');
  await p.click('#go');
  assert.equal(await p.evaluate(() => window.__tap()), false, 'a write was still waiting after Stop');
  await p.waitForFunction(() => window.__nfc.locks === 0, null, { timeout: 3000 }).catch(() => assert.fail('the screen was kept awake after Stop'));
  await p.context().close();
}

// Skip, − 1, a new Next number or a new link while it waits for a sticker: that sticker gets them.
{
  const p = await phone();
  const tap = async () => { await p.evaluate(() => window.__tap()); await statusIs(p, 'ok'); };
  await p.click('#go'); await waitingFor(p, '#001');
  await p.click('#skip'); await waitingFor(p, '#002'); await tap();
  await waitingFor(p, '#003');
  await p.click('#back'); await waitingFor(p, '#002'); await tap();
  await waitingFor(p, '#003');
  await p.click('.settings summary');
  await p.fill('#next', '50'); await p.dispatchEvent('#next', 'change'); await waitingFor(p, '#050'); await tap();
  await waitingFor(p, '#051');
  await p.fill('#prefix', 'https://example.com/b/'); await p.dispatchEvent('#prefix', 'change');
  await p.waitForFunction(() => window.__nfc.pending[0]?.msg.records[0].data.startsWith('https://example.com/b/'), null, { timeout: 8000 });
  await tap();
  assert.deepEqual((await p.evaluate(() => window.__nfc.written)).map(u => u.replace(/^.*#bag\//, '')), ['002', '002', '050', 'https://example.com/b/051']);
  assert.equal(await p.textContent('#num'), '#052');
  await p.context().close();
}

// Settings: Next number and Digits side by side, and the link box as wide as the panel.
{
  const p = await phone();
  await p.click('.settings summary');
  const [next, digits, prefix, panel] = await Promise.all(['#next', '#digits', '#prefix', '.settings'].map(s => p.locator(s).boundingBox()));
  assert.ok(Math.abs(next.y - digits.y) < 2 && digits.x > next.x + next.width, 'Next number and Digits are not side by side');
  assert.ok(prefix.width > panel.width * 0.85, 'the link box is narrower than the settings panel');
  await p.context().close();
}

// A long number still fits across the phone: six digits, or a three-digit run that has gone past 999.
{
  const p = await phone();
  for (const width of [390, 320]) {
    await p.setViewportSize({ width, height: 800 });
    for (const s of [{ digits: 6, next: 999999 }, { digits: 3, next: 12345 }]) {
      await p.evaluate(s => localStorage.setItem('tagalong.v1', JSON.stringify(s)), s);
      await p.reload(); await p.evaluate(() => document.fonts.ready);
      const fit = await p.evaluate(() => { const r = document.querySelector('#tape').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && r.left >= 0 && r.right <= innerWidth; });
      assert.ok(fit, `the tape for ${await p.textContent('#num')} doesn't fit ${width}px`);
    }
  }
  await p.context().close();
}

// Two tabs: numbers written in one move the other on, even while it waits for a sticker.
{
  const a = await phone();
  const b = await a.context().newPage(); watch(b); await b.goto(base);
  const tap = async p => { await p.evaluate(() => window.__tap()); await statusIs(p, 'ok'); };
  await b.click('#go');
  for (const n of ['#001', '#002', '#003']) { await waitingFor(b, n); await tap(b); }
  await b.click('#go');
  await a.waitForFunction(() => document.querySelector('#num').textContent === '#004', null, { timeout: 5000 }).catch(() => assert.fail('the other tab still shows its old number'));
  await a.click('#go'); await waitingFor(a, '#004');
  await b.click('.settings summary'); await b.fill('#next', '50'); await b.dispatchEvent('#next', 'change');
  await waitingFor(a, '#050'); await tap(a);
  assert.deepEqual(await a.evaluate(() => window.__nfc.written.map(u => u.slice(-3))), ['050']);
  await a.context().close();
}

// The Stop button stays put when a three-line message shows mid-run: it's under the thumb.
{
  const p = await phone();
  await p.click('#go'); await waitingFor(p, '#001');
  const y = () => p.evaluate(() => document.querySelector('#go').getBoundingClientRect().y);
  const before = await y();
  await p.evaluate(() => window.__tap({ fail: 'NotAllowedError' }));
  await statusIs(p, 'bad');
  assert.equal(await y(), before, 'the Stop button moved when "That sticker already has something on it" showed');
  await p.context().close();
}

// Trouble with the phone isn't blamed on a sticker: NFC not allowed yet, or no NFC reader, stops the run and says
// so (in Chrome's words: "NFC permission request denied.", "NFC is not supported."). A tag Chrome can't write
// ("This tag is not supported.") only asks for another one.
{
  const p = await phone();
  await p.evaluate(() => { window.__nfc.perm = 'prompt'; });
  await p.click('#go'); await waitingFor(p, '#001');
  await p.evaluate(() => window.__tap({ fail: 'NotAllowedError', message: 'NFC permission request denied.' }));
  await statusIs(p, 'bad');
  assert.equal(await p.textContent('#status'), 'NFC isn\'t allowed for this site yet. Press Start and allow it when Chrome asks.');
  assert.equal(await p.textContent('#go'), 'Start');
  await p.evaluate(() => { window.__nfc.perm = 'granted'; window.__nfc.writeError = ['NotSupportedError', 'NFC is not supported.']; });
  await p.click('#go'); await statusIs(p, 'bad');
  await p.waitForTimeout(2200);
  assert.equal(await p.textContent('#status'), 'Chrome can\'t find an NFC reader on this phone, so it can\'t write tags.');
  assert.equal(await p.textContent('#go'), 'Start');
  assert.equal(await p.evaluate(() => window.__nfc.buzzes), 0, 'it buzzed with no sticker near');
  await p.evaluate(() => { window.__nfc.writeError = null; });
  await p.click('#go'); await waitingFor(p, '#001');
  await p.evaluate(() => window.__tap({ fail: 'NotSupportedError', message: 'This tag is not supported.' }));
  await statusIs(p, 'bad');
  assert.match(await p.textContent('#status'), /^That tag isn't one Chrome can write/);
  await waitingFor(p, '#001');
  await p.context().close();
}

// Next number: clearing the box, or a number below 0, keeps the number there was rather than making it #000.
{
  const p = await phone();
  await p.click('.settings summary');
  await p.fill('#next', '20'); await p.dispatchEvent('#next', 'change');
  for (const text of ['', '-5']) {
    await p.fill('#next', text); await p.dispatchEvent('#next', 'change');
    assert.deepEqual([await p.textContent('#num'), await p.inputValue('#next')], ['#020', '20'], `Next number "${text}"`);
  }
  await p.reload();
  assert.equal(await p.textContent('#num'), '#020');
  await p.context().close();
}

// The link setting: a bare address gets https://, and something that isn't a link keeps the link it had and says why.
{
  const p = await phone();
  await p.click('.settings summary');
  const setLink = async text => { await p.fill('#prefix', text); await p.dispatchEvent('#prefix', 'change'); return [await p.inputValue('#prefix'), await p.textContent('#prefix-note')]; };
  assert.deepEqual(await setLink('example.com/bags/#bag/'), ['https://example.com/bags/#bag/', '']);
  assert.equal(await p.textContent('#example'), 'https://example.com/bags/#bag/001');
  assert.deepEqual(await setLink('https://example.com/my bags/'), ['https://example.com/bags/#bag/', 'That isn\'t a link, so it wasn\'t saved. Links start with https:// and have no spaces.']);
  assert.deepEqual(await setLink(''), ['https://example.com/bags/#bag/', '']);
  await p.reload();
  assert.equal(await p.textContent('#example'), 'https://example.com/bags/#bag/001');
  await p.context().close();
}

// A phone that saved the old Stockroom link (the default until Parts Bin had its own address) writes Parts Bin's
// from its next number on, a link typed in by hand stays, and "Use the Parts Bin link" puts Parts Bin's back.
{
  const PARTS_BIN = 'https://parts-bin.junkdrawer.works/#bag/', STOCKROOM = 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/';
  const p = await phone();
  const saved = prefix => p.evaluate(s => localStorage.setItem('tagalong.v1', JSON.stringify(s)), { prefix, digits: 3, next: 37, protect: true });
  await saved(STOCKROOM); await p.reload();
  await p.click('.settings summary');
  assert.deepEqual([await p.textContent('#num'), await p.inputValue('#prefix'), await p.textContent('#example')], ['#037', PARTS_BIN, PARTS_BIN + '037']);
  await p.click('#go'); await waitingFor(p, '#037');
  await p.evaluate(() => window.__tap()); await statusIs(p, 'ok');
  await p.click('#go');
  assert.deepEqual(await p.evaluate(() => window.__nfc.written), [PARTS_BIN + '037']);
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('tagalong.v1'))), { prefix: PARTS_BIN, digits: 3, next: 38, protect: true });
  await saved('https://example.com/b/'); await p.reload();
  await p.click('.settings summary');
  assert.equal(await p.inputValue('#prefix'), 'https://example.com/b/');
  assert.equal(await p.textContent('#reset-prefix'), 'Use the Parts Bin link');
  await p.click('#reset-prefix');
  assert.deepEqual([await p.inputValue('#prefix'), await p.textContent('#example')], [PARTS_BIN, PARTS_BIN + '037']);
  await p.context().close();
}

// Check mode has its own words when listening can't start (no stickers, press Check), and a second tap on Check
// while it starts just stops it.
{
  const p = await phone();
  const check = async (error, perm = 'granted') => {
    await p.reload(); await p.click('#tab-check');
    await p.evaluate(([error, perm]) => { window.__nfc.scanError = error; window.__nfc.perm = perm; }, [error, perm]);
    await p.click('#check-go');
    await p.waitForFunction(() => document.querySelector('#check-status').classList.contains('bad'));
    assert.equal(await p.textContent('#check-go'), 'Check');
    return p.textContent('#check-status');
  };
  assert.equal(await check(['NotAllowedError', 'NFC permission request denied.'], 'prompt'), 'NFC isn\'t allowed for this site yet. Press Check and allow it when Chrome asks.');
  assert.equal(await check(['NotSupportedError', 'NFC is not supported.']), 'Chrome can\'t find an NFC reader on this phone, so it can\'t read tags.');
  assert.equal(await check(['NotReadableError', 'NFC setting is disabled.']), 'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → NFC), then press Check.');
  assert.equal(await check(['InvalidStateError', 'A scan() operation is ongoing.']), 'Couldn\'t start listening for tags (A scan() operation is ongoing.). Press Check to try again.');
  await p.reload(); await p.click('#tab-check');
  await p.evaluate(() => { window.__nfc.scanDelay = 1500; });
  await p.click('#check-go');
  assert.equal(await p.textContent('#check-go'), 'Stop');
  await p.click('#check-go');
  await p.waitForTimeout(1800);
  assert.equal(await p.textContent('#check-go'), 'Check');
  assert.equal(await p.getAttribute('#check-status', 'class'), 'status', 'stopping Check on purpose showed an error');
  await p.context().close();
}


// Check says where a tag's number stands against your next number, including when it is your next number. A tag
// written with the old Stockroom link still shows its number, and says which link it holds.
{
  const PARTS_BIN = 'https://parts-bin.junkdrawer.works/#bag/', STOCKROOM = 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/';
  const p = await phone();
  await p.evaluate(() => localStorage.setItem('tagalong.v1', JSON.stringify({ next: 12 })));
  await p.reload(); await p.click('#tab-check'); await p.click('#check-go');
  await p.waitForFunction(() => window.__nfc.scans.length > 0);
  const read = async url => { await p.evaluate(url => window.__read([['url', url]]), url); return p.$$eval('#readout > :is(.big, p)', els => els.map(e => e.textContent)); };
  assert.deepEqual(await read(PARTS_BIN + '011'), ['#011', 'Already written (it\'s before your next number).', PARTS_BIN + '011']);
  assert.deepEqual(await read(PARTS_BIN + '012'), ['#012', 'Written with your link, and it\'s your next number.', PARTS_BIN + '012']);
  assert.deepEqual(await read(PARTS_BIN + '013'), ['#013', 'Written with your link, but ahead of your next number.', PARTS_BIN + '013']);
  assert.deepEqual(await read(STOCKROOM + '012'), ['#012', 'Written with the old Stockroom link, and it\'s your next number.', STOCKROOM + '012']);
  assert.deepEqual(await read(STOCKROOM + '013'), ['#013', 'Written with the old Stockroom link, but ahead of your next number.', STOCKROOM + '013']);
  assert.deepEqual(await read('https://example.com/b/012'), ['https://example.com/b/012', 'Not a link from the settings here.']);
  await p.context().close();
}

// Keyboard focus on the Write and Check a tag tabs shows in full: the tab bar clips anything drawn outside a tab.
{
  const p = await phone();
  for (const id of ['tab-write', 'tab-check']) {
    await p.keyboard.press('Tab');
    const ring = await p.evaluate(() => { const e = document.activeElement, s = getComputedStyle(e); return { id: e.id, inside: e.matches(':focus-visible') && parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth) <= 0 }; });
    assert.deepEqual(ring, { id, inside: true }, `the focus ring on #${id} is cut off`);
  }
  await p.context().close();
}

// The small grey text (the captions, labels, the next tag's link, a skipped number, the footer) and the status line
// in each of its colours stand out at least 4.5:1 from what's behind them, in the light palette and the dark one.
for (const colorScheme of ['light', 'dark']) {
  const p = await phone({ colorScheme });
  await p.click('#skip'); await p.click('.settings summary');
  const faint = await p.evaluate(() => {
    const rgba = c => c.match(/[\d.]+/g).map(Number);
    const lum = c => rgba(c).slice(0, 3).map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const behind = e => { for (; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (rgba(b)[3] !== 0) return b; } return 'rgb(255, 255, 255)'; };
    const ratio = e => { const [a, b] = [lum(getComputedStyle(e).color), lum(behind(e))].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
    const out = [], check = (what, e) => { const r = ratio(e); if (r < 4.5) out.push(`${what} ${r.toFixed(2)}:1`); };
    for (const sel of ['.tape-cap', '.field label', '.example', '.log li.skipped', '.jd-foot a']) for (const e of document.querySelectorAll(sel)) check(sel, e);
    const status = document.querySelector('#status');
    for (const kind of ['', 'wait', 'ok', 'bad']) { status.className = 'status ' + kind; check('#status.' + (kind || 'plain'), status); }
    return out;
  });
  assert.deepEqual(faint, [], `text that's hard to read in the ${colorScheme} palette`);
  await p.context().close();
}

// Screen readers hear the status lines and what Check reads off a tag.
for (const id of ['status', 'check-status', 'readout']) assert.equal(await page.getAttribute('#' + id, 'role'), 'status', `#${id} isn't announced`);

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Works offline once it has been opened. setOffline doesn't reach the service worker's own requests, so the server
// goes away instead, and the reload has to come from the cache.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
assert.equal(await page.evaluate(() => caches.has('name-tag-v3')), true, "the service worker deleted another tool's offline copy");
assert.equal(await page.evaluate(() => caches.has('tag-along-v0')), false, 'the service worker kept an old copy of this one');
await new Promise(done => { server.closeAllConnections(); server.close(done); });
await page.reload();
assert.equal(await page.textContent('#num'), '#050', 'the page did not load offline');

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
console.log('all good');
