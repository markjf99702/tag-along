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
// waiting, and an aborted one rejects with the signal's reason. nfc.perm is what permissions.query says about NFC,
// and nfc.locks counts the screen wake locks held.
function fakeNfc() {
  const nfc = window.__nfc = { written: [], pending: [], perm: 'granted', buzzes: 0, locks: 0 };
  window.NDEFReader = class {
    write(msg, o = {}) {
      return new Promise((resolve, reject) => {
        if (o.signal?.aborted) { reject(o.signal.reason); return; }
        for (const old of nfc.pending.splice(0)) old.reject(new DOMException('Push is cancelled due to a new push request.', 'AbortError'));
        const w = { msg, resolve, reject };
        nfc.pending.push(w);
        o.signal?.addEventListener('abort', () => { const i = nfc.pending.indexOf(w); if (i >= 0) { nfc.pending.splice(i, 1); reject(o.signal.reason); } });
      });
    }
    async scan() {}
  };
  window.__tap = ({ fail, message = 'NDEFWriteOptions#overwrite does not allow overwrite.' } = {}) => {
    const w = nfc.pending.shift();
    if (!w) return false;
    if (fail) w.reject(new DOMException(message, fail));
    else { nfc.written.push(w.msg.records[0].data); w.resolve(); }
    return true;
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


// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Works offline once it has been opened.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
assert.equal(await page.evaluate(() => caches.has('name-tag-v3')), true, "the service worker deleted another tool's offline copy");
assert.equal(await page.evaluate(() => caches.has('tag-along-v0')), false, 'the service worker kept an old copy of this one');
await ctx.setOffline(true);
await page.reload();
assert.ok(await page.title(), 'the page did not load offline');
await ctx.setOffline(false);

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
server.close();
console.log('all good');
