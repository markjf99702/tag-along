import { DEFAULTS, STOCKROOM, pad, urlFor, clean, describe, linkFrom } from './tags.js';

const KEY = 'tagalong.v1';
const $ = id => document.getElementById(id);

let settings = load();
const session = []; // {n, skipped}
let writing = null;  // AbortController while the write loop runs
let waiting = null;  // AbortController for the write waiting for a sticker; changed() calls it back
let checking = null; // AbortController while Check mode is listening

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
  const label = '#' + pad(settings.next, settings.digits);
  $('num').textContent = label;
  $('num').style.setProperty('--n', label.length); // the CSS shrinks a long number to fit
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
// A pause that Stop cuts short.
function pause(ms, signal) {
  return new Promise(done => {
    const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); done(); };
    const timer = setTimeout(end, ms);
    signal.addEventListener('abort', end);
  });
}

// ---------------------------------------------------------------- writing
async function startWriting() {
  if (supportProblem()) return;
  stopChecking();
  const run = writing = new AbortController();
  const { signal } = run;
  render();
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const ndef = new NDEFReader();
  let justWrote = 0;
  while (!signal.aborted) {
    const n = settings.next;
    status('status', `Hold a blank sticker to the back of the phone for #${pad(n, settings.digits)}.`, 'wait');
    try {
      if (!await writeTag(ndef, n, signal)) continue; // the number or the link changed while it waited: ask again
      session.push({ n });
      settings.next = n + 1; save();
      justWrote = Date.now();
      buzz(70); flash('done'); render();
      status('status', `#${pad(n, settings.digits)} written. Mark the bag, then take the sticker away from the phone.`, 'ok');
      await pause(1600, signal); // time to pull the tag away before the next write starts
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') break;
      const msg = await explain(e, { rightAfterWrite: Date.now() - justWrote < 4000 });
      if (signal.aborted) break;
      if (msg.fatal) { status('status', msg.text, 'bad'); break; }
      buzz([40, 60, 40]); flash('err');
      status('status', msg.text, 'bad');
      await pause(1800, signal);
    }
  }
  try { wake?.release(); } catch {}
  // Stop then Start straight away can leave this run winding down after the new one began: leave that one be.
  if (writing === run) stopWriting(false);
}

// Writes number n. Stop ends it; a new number or link calls it back first (changed()), and then it returns false.
async function writeTag(ndef, n, signal) {
  const attempt = waiting = new AbortController();
  const stop = () => attempt.abort();
  signal.addEventListener('abort', stop);
  try {
    await ndef.write({ records: [{ recordType: 'url', data: urlFor(n, settings) }] },
      { overwrite: !settings.protect, signal: attempt.signal });
    return true;
  } catch (e) {
    if (attempt.signal.aborted && !signal.aborted) return false;
    throw e;
  } finally {
    signal.removeEventListener('abort', stop);
    if (waiting === attempt) waiting = null;
  }
}

// What went wrong, in a line for the status. Check mode (checking) never involves a sticker: its scan() only fails
// for the phone's reasons.
async function explain(e, { rightAfterWrite = false, checking = false } = {}) {
  const press = checking ? 'Check' : 'Start';
  let perm = '';
  try { perm = (await navigator.permissions.query({ name: 'nfc' })).state; } catch {}
  if (perm === 'denied') return { fatal: true, text: 'NFC is blocked for this site. Allow it in Chrome: the icon left of the address → Permissions → NFC.' };
  if (e.name === 'NotAllowedError' && /activation|gesture/i.test(e.message)) return { fatal: true, text: `Chrome wants a fresh tap before ${checking ? 'checking' : 'writing'}. Press ${press} again.` };
  // The phone, not the sticker. Chrome says "NFC permission request denied." when NFC hasn't been allowed (its
  // question was closed), and "NFC is not supported." when there's no NFC reader ("This tag is not supported." is a tag).
  if (e.name === 'NotAllowedError' && (checking || /permission/i.test(e.message))) return { fatal: true, text: `NFC isn't allowed for this site yet. Press ${press} and allow it when Chrome asks.` };
  if (e.name === 'NotSupportedError' && (checking || /NFC is not supported|unavailable/i.test(e.message))) return { fatal: true, text: `Chrome can't find an NFC reader on this phone, so it can't ${checking ? 'read' : 'write'} tags.` };
  if (e.name === 'NotReadableError') return { fatal: true, text: `NFC looks switched off. Turn it on in the phone's settings (Connected devices → NFC), then press ${press}.` };
  if (checking) return { fatal: true, text: `Couldn't start listening for tags (${e.message || e.name}). Press Check to try again.` };
  if (e.name === 'NotAllowedError' && settings.protect) {
    return rightAfterWrite
      ? { text: 'That\'s the sticker just written. Take it away from the phone, then hold the next one.' }
      : { text: 'That sticker already has something on it, so it was left alone. Use a blank one, or check what it holds first.' };
  }
  if (e.name === 'NotSupportedError') return { text: 'That tag isn\'t one Chrome can write (NTAG213/215/216 stickers work). Try another.' };
  return { text: 'Couldn\'t finish writing (' + (e.message || e.name) + '). Hold the sticker flat against the phone and keep it still for a second.' };
}

function stopWriting(abort = true) {
  if (abort) writing?.abort();
  writing = null;
  if (!$('status').classList.contains('bad')) status('status', session.length ? `Stopped. Next up is #${pad(settings.next, settings.digits)}.` : 'Press Start, then hold a blank sticker to the back of the phone.');
  render();
}

// ---------------------------------------------------------------- checking
async function startChecking() {
  if (supportProblem()) return;
  stopWriting();
  const ctl = checking = new AbortController();
  renderCheck(); // the button reads Stop while Chrome starts listening, so a second tap stops it
  const ndef = new NDEFReader();
  try {
    await ndef.scan({ signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) return; // stopped on purpose
    if (checking === ctl) checking = null;
    status('check-status', (await explain(e, { checking: true })).text, 'bad');
    renderCheck(); return;
  }
  if (ctl.signal.aborted) return;
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
// Keeps and shows new settings. A sticker being waited for gets them too: its write starts again with them.
function changed() { save(); render(); waiting?.abort(); }
$('skip').onclick = () => { session.push({ n: settings.next, skipped: true }); settings.next += 1; changed(); };
$('back').onclick = () => { settings.next = Math.max(0, settings.next - 1); changed(); };
$('next').onchange = e => { settings = clean({ ...settings, next: e.target.value }); changed(); };
$('digits').onchange = e => { settings = clean({ ...settings, digits: e.target.value }); changed(); };
$('prefix').onchange = e => {
  // Something that isn't a link keeps the link there was, and says why; an emptied box just gets it back.
  const text = e.target.value.trim(), link = text && linkFrom(text);
  $('prefix-note').textContent = text && !link ? 'That isn\'t a link, so it wasn\'t saved. Links start with https:// and have no spaces.' : '';
  if (link) { settings = clean({ ...settings, prefix: link }); changed(); } else render();
};
$('reset-prefix').onclick = () => { $('prefix-note').textContent = ''; settings = clean({ ...settings, prefix: STOCKROOM }); changed(); };
$('protect').onchange = e => { settings = clean({ ...settings, protect: e.target.checked }); changed(); };
// Another tab wrote stickers or changed a setting: show the same here, so this tab doesn't write those numbers again.
addEventListener('storage', e => { if (e.key === KEY || e.key === null) { settings = load(); render(); waiting?.abort(); } });
document.addEventListener('visibilitychange', () => {
  // Chrome stops NFC in a background tab; say so rather than look stuck
  if (document.hidden && writing) stopWriting();
});

const problem = supportProblem();
if (problem) { $('unsupported').textContent = problem; $('unsupported').hidden = false; $('go').disabled = true; $('check-go').disabled = true; }
render();

if ('serviceWorker' in navigator && !framed && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

export { DEFAULTS };
