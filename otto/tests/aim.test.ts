// A press must land on the element the storyboard named, even if the page changes while the cursor travels.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Demo } from '../scripts/lib/demo.ts';
import { PACES } from '../scripts/lib/pacing.ts';
import { Tts } from '../scripts/lib/tts.ts';
import type { Timeline } from '../scripts/lib/timeline.ts';
import type { PageSession } from '../scripts/lib/session.ts';
import { tempDir, openSession, serve, sleep, startChrome, type TestChrome, type TestServer } from './helpers.ts';

const PAGE = `<!doctype html><body style="margin:0;font:16px sans-serif">
<div id="late" style="height:0;background:#eee"></div>
<button id="target" style="display:block;margin:100px 0 0 200px;width:200px;height:60px">target</button>
<div id="scrim" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>
<script>
  window.pressed = [];
  addEventListener('click', (e) => pressed.push(e.target.id || e.target.tagName));
  window.shiftSoon = (ms) => setTimeout(() => { late.style.height = '160px'; }, ms);
  window.scrimFor = (ms) => { scrim.style.display = 'block'; if (ms) setTimeout(() => { scrim.style.display = 'none'; }, ms); };
</script>`;

let chrome: TestChrome;
let server: TestServer;
let s: PageSession;

function newDemo(mode: 'dry' | 'record' = 'record') {
  const timeline: Timeline = { meta: {} as Timeline['meta'], durationMs: 0, events: [], cuts: [], narration: [], chapters: [] };
  process.env.TTS_PROVIDER = 'none';
  const demo = new Demo({
    mode, session: s, pace: PACES.brisk, lang: 'en', tts: new Tts(tempDir('tts')), capture: null, timeline,
    story: { key: 'T-1', title: 'Test', acceptance: [] } as never, footer: '', log: () => {},
  });
  return { demo, timeline };
}

before(async () => {
  chrome = await startChrome();
  server = await serve({ '/': PAGE });
  s = await openSession(chrome, server.base);
});
after(async () => {
  await s?.close();
  server?.close();
  await chrome?.close();
});

async function freshPage() {
  await s.goto('/');
  await s.overlay('activate', { cursor: { x: 800, y: 700, visible: true }, chip: null, caption: null });
}

test('re-aims when late content moves the target during the cursor move', async () => {
  await freshPage();
  const { demo, timeline } = newDemo();
  await s.eval('shiftSoon(120)');
  await demo.click('#target');
  assert.deepEqual(await s.eval('pressed'), ['target']);
  assert.ok(timeline.events.some((e) => e.type === 'retarget'), 'the move was corrected');
});

test('does not re-aim when nothing moved', async () => {
  await freshPage();
  const { demo, timeline } = newDemo();
  await demo.click('#target');
  assert.deepEqual(await s.eval('pressed'), ['target']);
  assert.ok(!timeline.events.some((e) => e.type === 'retarget'));
});

test('waits for a scrim to go away', async () => {
  await freshPage();
  const { demo } = newDemo();
  await s.eval('scrimFor(1500)');
  await demo.click('#target');
  assert.deepEqual(await s.eval('pressed'), ['target']);
});

test('fails with a clear message if something keeps covering the target', async () => {
  await freshPage();
  const { demo } = newDemo();
  await s.eval('scrimFor(0)');
  await assert.rejects(demo.click('#target'), /covered by <div#scrim>/);
  assert.deepEqual(await s.eval('pressed'), [], 'nothing was pressed');
  await sleep(10);
});

test('a dry run stops at a covered target too', async () => {
  await freshPage();
  const { demo } = newDemo('dry');
  await s.eval('scrimFor(0)');
  await assert.rejects(demo.click('#target'), /covered by <div#scrim>/);
});
