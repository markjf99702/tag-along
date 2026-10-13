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

// A pretend NFC reader: each write() waits for window.__tap(), which plays a sticker touching the phone.
await ctx.addInitScript(() => {
  window.__written = [];
  let pending = null;
  window.__tap = (opts = {}) => { const p = pending; pending = null; if (!p) return false; if (opts.fail) p.reject(Object.assign(new Error('Tag already has data'), { name: 'NotAllowedError' })); else { window.__written.push(p.msg.records[0].data); p.resolve(); } return true; };
  window.NDEFReader = class { async write(msg, o = {}) { return new Promise((resolve, reject) => { pending = { msg, resolve, reject }; o.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))); }); } async scan() {} };
  navigator.vibrate = () => true;
});
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

await page.goto(base);
await page.evaluate(() => document.fonts.ready);


// Starts at #001 and writes the Stockroom link for it.
assert.equal(await page.textContent('#num'), '#001');
await page.click('#go');
await page.waitForFunction(() => window.__tap && document.querySelector('#status').classList.contains('wait'));
assert.ok(await page.evaluate(() => window.__tap()));
await page.waitForFunction(() => document.querySelector('#num').textContent === '#002');
assert.equal((await page.evaluate(() => window.__written))[0], 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/001');
// The loop waits, then asks for the next sticker; a used sticker is refused and the number doesn't move.
await page.waitForFunction(() => /#002/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
await page.evaluate(() => window.__tap({ fail: true }));
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


// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Works offline once it has been opened.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
await ctx.setOffline(true);
await page.reload();
assert.ok(await page.title(), 'the page did not load offline');
await ctx.setOffline(false);

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
server.close();
console.log('all good');
