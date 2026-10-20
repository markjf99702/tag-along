// README screenshots and the link preview:  node tools/screenshots.mjs
// Uses a pretend NFC reader so the pictures show the app mid-run.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try { const body = await readFile(join(root, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const fake = () => {
  let pending = null;
  window.__tap = () => { const p = pending; pending = null; p?.resolve(); };
  window.NDEFReader = class {
    async write() { return new Promise(r => { pending = { resolve: r }; }); }
    async scan() { setTimeout(() => this.onreading?.({ message: { records: [{ recordType: 'url', data: new TextEncoder().encode('https://parts-bin.junkdrawer.works/#bag/012') }] } }), 50); }
  };
  navigator.vibrate = () => true;
  localStorage.setItem('tagalong.v1', JSON.stringify({ next: 12 }));
};

const browser = await pw.chromium.launch();
for (const scheme of ['light']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.addInitScript(fake);
  const page = await ctx.newPage();
  await page.goto(base); await page.evaluate(() => document.fonts.ready);
  await page.click('#go');
  for (let i = 0; i < 4; i++) { await page.waitForFunction(() => document.querySelector('#status').classList.contains('wait')); await page.evaluate(() => window.__tap()); await page.waitForTimeout(1700); }
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('wait'));
  await page.evaluate(() => window.__tap()); await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, 'docs/phone-write.png') });
  await page.click('#go');
  await page.click('#tab-check'); await page.click('#check-go'); await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'docs/phone-check.png') });
  await ctx.close();
}

// Link preview: a card with the name, one line, and the tape from the app.
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 } });
const page = await ctx.newPage();
const font = async f => 'data:font/woff2;base64,' + (await readFile(join(root, 'fonts', f))).toString('base64');
await page.setContent(`<style>
@font-face{font-family:BC;font-weight:700;src:url(${await font('barlow-condensed-700.woff2')})}
@font-face{font-family:B;font-weight:400;src:url(${await font('barlow-400.woff2')})}
body{margin:0;width:1200px;height:630px;background:#1D1E1B;color:#F1EFE8;display:grid;grid-template-columns:1fr 1fr;align-items:center;font-family:B}
.l{padding-left:80px}
h1{font:700 120px/0.9 BC;text-transform:uppercase;margin:0}
p{font-size:34px;color:#B9BCB1;margin:22px 0 0;max-width:13em}
.stack{display:flex;flex-direction:column;gap:22px;align-items:center}
.tape{background:#F3C22F;color:#1D1E1B;font:700 150px/1 BC;padding:14px 60px 6px;clip-path:polygon(0 0,100% 0,96% 50%,100% 100%,0 100%,4% 50%);text-shadow:0 -1px 0 rgba(255,255,255,.45),0 3px 0 rgba(0,0,0,.18)}
.tape.s{font-size:80px;padding:8px 40px 2px;opacity:.55;transform:rotate(-3deg)}
.tape.s2{font-size:80px;padding:8px 40px 2px;opacity:.3;transform:rotate(2deg)}
</style><div class="l"><h1>Tag<br>Along</h1><p>Numbered NFC stickers from your phone, one tap each.</p></div>
<div class="stack"><div class="tape s2">#014</div><div class="tape s">#015</div><div class="tape">#016</div></div>`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(root, 'og.png') });
await browser.close(); server.close();
console.log('screenshots written');
