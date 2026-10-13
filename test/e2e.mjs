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
// waiting, and an aborted one rejects with the signal's reason. nfc.writeError ([name, message]) makes every write
// fail at once, as on a phone without NFC. scan() starts listening after nfc.scanDelay ms, or fails with
// nfc.scanError, and __read([[recordType, text], ...]) plays a tag for it. nfc.perm is what permissions.query says
// about NFC, and nfc.locks counts the screen wake locks held.
function fakeNfc() {
  const nfc = window.__nfc = { written: [], pending: [], writeError: null, scans: [], scanError: null, scanDelay: 0, perm: 'granted', buzzes: 0, locks: 0 };
  window.NDEFReader = class {
    write(msg, o = {}) {
      return new Promise((resolve, reject) => {
        if (o.signal?.aborted) { reject(o.signal.reason); return; }
        if (nfc.writeError) { reject(new DOMException(nfc.writeError[1], nfc.writeError[0])); return; }
        for (const old of nfc.pending.splice(0)) old.reject(new DOMException('Push is cancelled due to a new push request.', 'AbortError'));
        const w = { msg, resolve, reject };
        nfc.pending.push(w);
        o.signal?.addEventListener('abort', () => { const i = nfc.pending.indexOf(w); if (i >= 0) { nfc.pending.splice(i, 1); reject(o.signal.reason); } });
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
async function phone() {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
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


// Starts at #001 and writes the Stockroom link for it.
assert.equal(await page.textContent('#num'), '#001');
await page.click('#go');
await waitingFor(page, '#001');
assert.ok(await page.evaluate(() => window.__tap()));
await page.waitForFunction(() => document.querySelector('#num').textContent === '#002');
assert.equal((await page.evaluate(() => window.__nfc.written))[0], 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/001');
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

// The link setting: a bare address gets https://, and something that isn't a link keeps the link it had and says why.
{
  const p = await phone();
  await p.click('.settings summary');
  const setLink = async text => { await p.fill('#prefix', text); await p.dispatchEvent('#prefix', 'change'); return [await p.inputValue('#prefix'), await p.textContent('#prefix-note')]; };
  assert.deepEqual(await setLink('parts-bin.junkdrawer.works/#bag/'), ['https://parts-bin.junkdrawer.works/#bag/', '']);
  assert.equal(await p.textContent('#example'), 'https://parts-bin.junkdrawer.works/#bag/001');
  assert.deepEqual(await setLink('https://example.com/my bags/'), ['https://parts-bin.junkdrawer.works/#bag/', 'That isn\'t a link, so it wasn\'t saved. Links start with https:// and have no spaces.']);
  assert.deepEqual(await setLink(''), ['https://parts-bin.junkdrawer.works/#bag/', '']);
  await p.reload();
  assert.equal(await p.textContent('#example'), 'https://parts-bin.junkdrawer.works/#bag/001');
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
