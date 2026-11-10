// Key events can stop arriving for a while, with text input and the mouse still working. A typed value then ends up
// after the old one ("150350") and a cleared field keeps its text. Here the key events are thrown away on their way
// to Chrome, which looks the same from the toolkit's side.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cdp } from '../scripts/lib/cdp.ts';
import { Demo } from '../scripts/lib/demo.ts';
import { checkFilled, FastDriver, pressKey } from '../scripts/lib/fast-driver.ts';
import { overlaySource } from '../scripts/lib/overlay-source.ts';
import { PACES } from '../scripts/lib/pacing.ts';
import { PageSession } from '../scripts/lib/session.ts';
import type { Timeline } from '../scripts/lib/timeline.ts';
import { Tts } from '../scripts/lib/tts.ts';
import { serve, startChrome, tempDir, type TestChrome, type TestServer } from './helpers.ts';

// A controlled field like React's: the page keeps the value itself and notices edits through input events.
const PAGE = `<!doctype html><body style="margin:40px">
<input id="qty" value="150" style="display:block;width:300px;height:40px">
<input id="num" type="number" value="150" style="display:block;margin-top:20px;width:300px;height:40px">
<textarea id="notes" style="display:block;margin-top:20px;width:300px;height:80px">old note</textarea>
<div id="rich" contenteditable style="margin-top:20px;width:300px;height:40px;border:1px solid">old text</div>
<script>
  window.state = { qty: '150', num: '150', notes: 'old note' };
  for (const id of ['qty', 'num', 'notes']) document.getElementById(id).addEventListener('input', (e) => { state[id] = e.target.value; });
  window.pressed = [];
  addEventListener('keydown', (e) => pressed.push(e.key));
</script>`;

let chrome: TestChrome;
let server: TestServer;
let dropKeys = 0; // how many key events to throw away; Infinity = all of them

const cdp = (): Cdp => ({
  send: (method, params, sid) => {
    if (method === 'Input.dispatchKeyEvent' && dropKeys > 0) { dropKeys--; return Promise.resolve({} as never); }
    return chrome.cdp.send(method, params, sid);
  },
  on: (m, h) => chrome.cdp.on(m, h),
  close: () => {},
});
const open = () => PageSession.open(cdp(), { baseUrl: server.base, viewport: { width: 1600, height: 900, dpr: 1 }, overlaySource: overlaySource(), httpAuth: null, mouseWaitMs: 3000 });

function paced(s: PageSession) {
  const timeline: Timeline = { meta: {} as Timeline['meta'], durationMs: 0, events: [], cuts: [], narration: [], chapters: [] };
  process.env.TTS_PROVIDER = 'none';
  return new Demo({ mode: 'record', session: s, pace: PACES.brisk, lang: 'en', tts: new Tts(tempDir('tts')), capture: null, timeline, story: { key: 'T', title: 'T', acceptance: [] } as never, footer: '', log: () => {} });
}

before(async () => {
  chrome = await startChrome();
  server = await serve({ '/': PAGE });
});
after(async () => {
  server?.close();
  await chrome?.close();
});

for (const mode of ['fast', 'paced'] as const) {
  test(`${mode}: fill replaces and clears with no key events at all`, async () => {
    dropKeys = 0;
    const s = await open();
    await s.goto('/');
    dropKeys = Infinity;
    const ui = mode === 'fast' ? new FastDriver(s) : paced(s);
    await ui.fill('#qty', '350');
    assert.equal(await s.eval('document.querySelector("#qty").value'), '350', 'replaced, not 150350');
    assert.equal(await s.eval('state.qty'), '350', 'the page noticed');
    await ui.fill('#qty', '');
    assert.equal(await s.eval('document.querySelector("#qty").value'), '');
    assert.equal(await s.eval('state.qty'), '', 'the page noticed the clearing');
    await ui.fill('#num', '350');
    assert.equal(await s.eval('document.querySelector("#num").value'), '350', 'number fields too');
    await ui.fill('#notes', 'new note');
    assert.equal(await s.eval('document.querySelector("#notes").value'), 'new note', 'textareas too');
    assert.deepEqual(s.fixedFields, [], 'nothing needed correcting');
    dropKeys = 0;
    await s.close();
  });
}

test('contenteditable text is replaced too', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  await new FastDriver(s).fill('#rich', 'new text');
  assert.equal(await s.eval('document.querySelector("#rich").textContent'), 'new text');
  await s.close();
});

test('text added to the old value is corrected and reported', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  await s.eval(`(() => { const a = document.querySelector('#qty'); a.value = '150350'; })()`);
  await checkFilled(s, '#qty', '350', '150');
  assert.equal(await s.eval('document.querySelector("#qty").value'), '350');
  assert.equal(await s.eval('state.qty'), '350', 'the page noticed');
  assert.deepEqual(s.fixedFields, ['#qty']);
  await s.close();
});

test('text left behind when clearing is corrected and reported', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  await checkFilled(s, '#qty', '', '150');
  assert.equal(await s.eval('document.querySelector("#qty").value'), '');
  assert.deepEqual(s.fixedFields, ['#qty']);
  await s.close();
});

test('a field that formats its value is left alone', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  await s.eval(`document.querySelector('#qty').value = '+000 12 345 6789'`);
  await checkFilled(s, '#qty', '+000123456789', '150');
  assert.equal(await s.eval('document.querySelector("#qty").value'), '+000 12 345 6789');
  assert.deepEqual(s.fixedFields, []);
  await s.close();
});

test('press: a lost key is sent again and arrives once', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  dropKeys = 2; // the key down and up of the first attempt
  await pressKey(s, 'Enter');
  assert.deepEqual(await s.eval('pressed'), ['Enter']);
  assert.equal(s.recoveredKeys.length, 1);
  await s.close();
});

test('press: says so if the key never arrives', async () => {
  dropKeys = 0;
  const s = await open();
  await s.goto('/');
  dropKeys = Infinity;
  await assert.rejects(pressKey(s, 'Enter'), /did not receive the key Enter after 3 attempts/);
  dropKeys = 0;
  await s.close();
});

test('a tab with no key events is used anyway, with a note: fill does not need them', async () => {
  dropKeys = Infinity;
  const s = await open();
  assert.match(s.startupNotes.join(), /Key events are not reaching new tabs/);
  dropKeys = 0;
  await s.close();
});

test('a healthy tab has no note', async () => {
  dropKeys = 0;
  const s = await open();
  assert.deepEqual(s.startupNotes, []);
  await s.close();
});
