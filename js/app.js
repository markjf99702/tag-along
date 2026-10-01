import { DEFAULTS, STOCKROOM, pad, urlFor, clean, describe } from './tags.js';

const KEY = 'tagalong.v1';
const $ = id => document.getElementById(id);

let settings = load();
const session = []; // {n, skipped}
let writing = null;  // AbortController while the write loop runs
let checking = null; // AbortController while Check mode is listening
let wake = null;

// ---------------------------------------------------------------- storage
function load() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return clean(null); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private window: still works this visit */ }
}

// ---------------------------------------------------------------- support
const hasNfc = 'NDEFReader' in window;
const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
function supportProblem() {
  if (framed) return 'This copy is running inside another page, where phones don\'t allow NFC. Open junkdrawer.works/tag-along in Chrome on an Android phone.';
  if (!hasNfc) return 'Writing tags needs Chrome on an Android phone with NFC turned on. This browser can\'t reach the NFC reader, but you can still change the settings here.';
  return '';
}

// ---------------------------------------------------------------- render
function render() {
  $('num').textContent = '#' + pad(settings.next, settings.digits);
  $('next').value = settings.next;
  $('digits').value = String(settings.digits);
  $('prefix').value = settings.prefix;
  $('protect').checked = settings.protect;
  $('example').textContent = urlFor(settings.next, settings);
  $('back').disabled = settings.next <= 0;
  const go = $('go');
  go.textContent = writing ? 'Stop' : 'Start';
  go.classList.toggle('stop', !!writing);
  $('log-wrap').hidden = session.length === 0;
  $('log').innerHTML = '';
  for (const e of session.slice().reverse()) {
    const li = document.createElement('li');
    li.textContent = '#' + pad(e.n, settings.digits);
    if (e.skipped) { li.className = 'skipped'; li.title = 'skipped'; }
    $('log').append(li);
  }
}
function status(el, text, kind = '') {
  const s = $(el); s.textContent = text; s.className = 'status' + (kind ? ' ' + kind : '');
}
function flash(cls) {
  const t = $('tape'); t.classList.remove('done', 'err'); void t.offsetWidth; t.classList.add(cls);
  setTimeout(() => t.classList.remove(cls), 600);
}
const buzz = p => { try { navigator.vibrate?.(p); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- writing
async function startWriting() {
  if (supportProblem()) return;
  stopChecking();
  writing = new AbortController();
  const { signal } = writing;
  render();
  try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  const ndef = new NDEFReader();
  let justWrote = 0;
  while (!signal.aborted) {
    const n = settings.next;
    status('status', `Hold a blank sticker to the back of the phone for #${pad(n, settings.digits)}.`, 'wait');
    try {
      await ndef.write({ records: [{ recordType: 'url', data: urlFor(n, settings) }] },
        { overwrite: !settings.protect, signal });
      session.push({ n });
      settings.next = n + 1; save();
      justWrote = Date.now();
      buzz(70); flash('done'); render();
      status('status', `#${pad(n, settings.digits)} written. Mark the bag, then take the sticker away from the phone.`, 'ok');
      await sleep(1600); // time to pull the tag away before the next write starts
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') break;
      const msg = await explain(e, Date.now() - justWrote < 4000);
      if (msg.fatal) { status('status', msg.text, 'bad'); break; }
      buzz([40, 60, 40]); flash('err');
      status('status', msg.text, 'bad');
      await sleep(1800);
    }
  }
  stopWriting(false);
}

async function explain(e, rightAfterWrite) {
  let perm = '';
  try { perm = (await navigator.permissions.query({ name: 'nfc' })).state; } catch {}
  if (perm === 'denied') return { fatal: true, text: 'NFC is blocked for this site. Allow it in Chrome: the icon left of the address → Permissions → NFC.' };
  if (e.name === 'NotAllowedError' && /activation|gesture/i.test(e.message)) return { fatal: true, text: 'Chrome wants a fresh tap before writing. Press Start again.' };
  if (e.name === 'NotAllowedError' && settings.protect) {
    return rightAfterWrite
      ? { text: 'That\'s the sticker just written. Take it away from the phone, then hold the next one.' }
      : { text: 'That sticker already has something on it, so it was left alone. Use a blank one, or check what it holds first.' };
  }
  if (e.name === 'NotSupportedError') return { text: 'That tag isn\'t one Chrome can write (NTAG213/215/216 stickers work). Try another.' };
  if (e.name === 'NotReadableError') return { fatal: true, text: 'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → NFC), then press Start.' };
  return { text: 'Couldn\'t finish writing (' + (e.message || e.name) + '). Hold the sticker flat against the phone and keep it still for a second.' };
}

function stopWriting(abort = true) {
  if (abort) writing?.abort();
  writing = null;
  try { wake?.release(); } catch {} wake = null;
  if (!$('status').classList.contains('bad')) status('status', session.length ? `Stopped. Next up is #${pad(settings.next, settings.digits)}.` : 'Press Start, then hold a blank sticker to the back of the phone.');
  render();
}

// ---------------------------------------------------------------- checking
async function startChecking() {
  if (supportProblem()) return;
  stopWriting();
  checking = new AbortController();
  const ndef = new NDEFReader();
  try {
    await ndef.scan({ signal: checking.signal });
  } catch (e) {
    checking = null;
    status('check-status', (await explain(e, false)).text, 'bad');
    renderCheck(); return;
  }
  status('check-status', 'Listening. Hold a tag to the back of the phone.', 'wait');
  renderCheck();
  ndef.onreading = ev => {
    const d = describe(ev.message, settings);
    buzz(40);
    const out = $('readout'); out.hidden = false; out.innerHTML = '';
    if (d.number != null) {
      const big = document.createElement('div'); big.className = 'big'; big.textContent = '#' + pad(d.number, settings.digits); out.append(big);
      const p = document.createElement('p');
      p.textContent = d.number < settings.next ? 'Already written (it\'s before your next number).' : 'Written with your link, but ahead of your next number.';
      out.append(p);
    }
    for (const line of d.lines) { const p = document.createElement('p'); const c = document.createElement('code'); c.textContent = line; p.append(c); out.append(p); }
    if (d.number == null && !d.blank) { const p = document.createElement('p'); p.textContent = 'Not a link from the settings here.'; out.append(p); }
    status('check-status', 'Read it. Hold another tag to check it too.', 'ok');
  };
  ndef.onreadingerror = () => status('check-status', 'Couldn\'t read that one. Hold it flat and still.', 'bad');
}
function stopChecking() { checking?.abort(); checking = null; renderCheck(); }
function renderCheck() {
  const b = $('check-go'); b.textContent = checking ? 'Stop' : 'Check'; b.classList.toggle('stop', !!checking);
  if (!checking && !$('check-status').classList.contains('bad') && !$('check-status').classList.contains('ok')) status('check-status', 'Press Check, then hold a tag to the back of the phone to see what\'s on it.');
}

// ---------------------------------------------------------------- wiring
function setMode(mode) {
  const w = mode === 'write';
  $('tab-write').setAttribute('aria-selected', w); $('tab-check').setAttribute('aria-selected', !w);
  $('write').hidden = !w; $('check').hidden = w;
  if (w) stopChecking(); else stopWriting();
}
$('tab-write').onclick = () => setMode('write');
$('tab-check').onclick = () => setMode('check');

$('go').onclick = () => (writing ? stopWriting() : startWriting());
$('check-go').onclick = () => (checking ? stopChecking() : startChecking());
$('skip').onclick = () => { session.push({ n: settings.next, skipped: true }); settings.next += 1; save(); render(); };
$('back').onclick = () => { settings.next = Math.max(0, settings.next - 1); save(); render(); };
$('next').onchange = e => { settings = clean({ ...settings, next: e.target.value }); save(); render(); };
$('digits').onchange = e => { settings = clean({ ...settings, digits: e.target.value }); save(); render(); };
$('prefix').onchange = e => { settings = clean({ ...settings, prefix: e.target.value.trim() }); save(); render(); };
$('reset-prefix').onclick = () => { settings = clean({ ...settings, prefix: STOCKROOM }); save(); render(); };
$('protect').onchange = e => { settings = clean({ ...settings, protect: e.target.checked }); save(); render(); };
document.addEventListener('visibilitychange', () => {
  // Chrome stops NFC in a background tab; say so rather than look stuck
  if (document.hidden && writing) stopWriting();
});

const problem = supportProblem();
if (problem) { $('unsupported').textContent = problem; $('unsupported').hidden = false; $('go').disabled = true; $('check-go').disabled = true; }
render();

if ('serviceWorker' in navigator && !framed && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

export { DEFAULTS };
